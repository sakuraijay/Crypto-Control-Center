import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductionFetchersHandle } from '../intel/dataSource';
import type { Timeframe } from '../intel/types';
import {
  __resetIntelServiceForTests,
  __setIntelHandleForTests,
  getIntelServiceState,
  runIntelServiceCycle,
  runStrategyShadowWorkerReadOnly,
} from '../intel/intelService';

const BOUNDARY = 1_800_000_000_000;
const NOW = BOUNDARY + 10_000;
const STEPS: Partial<Record<Timeframe, number>> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

function candles(timeframe: Timeframe, count: number) {
  const step = STEPS[timeframe];
  if (!step) throw new Error(`unsupported test timeframe: ${timeframe}`);
  const lastOpen = BOUNDARY - step;
  const firstOpen = lastOpen - (count - 1) * step;
  return Array.from({ length: count }, (_, index) => {
    const center = 100 + index * 0.08 + Math.sin(index / 3) * 0.35;
    return {
      t: firstOpen + index * step,
      o: center - 0.04,
      h: center + 0.22,
      l: center - 0.22,
      c: center + 0.04,
      v: 100 + index % 7,
    };
  });
}

function existingAi(decisionId = 'worker-decision-1') {
  return {
    decisionId,
    action: 'NO_TRADE' as const,
    confidence: 0,
    primarySymbol: 'BTC',
    createdAt: new Date(NOW).toISOString(),
  };
}

function handle(fetchCandles: ProductionFetchersHandle['fetchers']['fetchCandles']) {
  return {
    fetchers: {
      fetchMarketRows: vi.fn(),
      fetchCandles,
      fetchPrice: vi.fn(),
      fetch24hChange: vi.fn(),
      fetchFundingBorrowing: vi.fn(),
    },
    stats: {},
    beginCycle: vi.fn(),
    noteRateLimited: vi.fn(),
  } as unknown as ProductionFetchersHandle;
}

describe('Intel service Strategy SHADOW Worker read-only bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetIntelServiceForTests();
  });

  afterEach(() => {
    __resetIntelServiceForTests();
    vi.useRealTimers();
  });

  it('fresh MTF frames를 실행 권한 없는 실제 SHADOW record로 평가한다', async () => {
    const fetchCandles = vi.fn(async (_symbol: string, timeframe: Timeframe, count: number) =>
      candles(timeframe, count));
    const injected = handle(fetchCandles);
    __setIntelHandleForTests(injected);

    const envelope = await runStrategyShadowWorkerReadOnly({
      cycleNumber: 1,
      evaluatedAt: NOW,
      expectedSymbols: ['BTC'],
      existingAi: existingAi(),
    });

    expect(envelope).toMatchObject({
      mode: 'SHADOW_ONLY',
      status: 'EVALUATED',
      executionAuthorized: false,
      approvalCreationAllowed: false,
      paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
      riskAuthority: 'NOT_EVALUATED',
    });
    expect(envelope.records).toHaveLength(1);
    expect(envelope.evaluatedSymbols).toEqual(['BTC']);
    expect(fetchCandles).toHaveBeenCalledTimes(3);
    expect(injected.beginCycle).toHaveBeenCalledTimes(1);
    expect(getIntelServiceState().shadowReadInFlight).toBe(false);
  });

  it('동일 cycle 동시 요청은 한 external read에 합류하고 예산을 한 번만 reset한다', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchCandles = vi.fn(async (_symbol: string, timeframe: Timeframe, count: number) => {
      await gate;
      return candles(timeframe, count);
    });
    const injected = handle(fetchCandles);
    __setIntelHandleForTests(injected);

    const first = runStrategyShadowWorkerReadOnly({
      cycleNumber: 2, evaluatedAt: NOW, expectedSymbols: ['BTC'], existingAi: existingAi('first'),
    });
    const second = runStrategyShadowWorkerReadOnly({
      cycleNumber: 2, evaluatedAt: NOW, expectedSymbols: ['BTC'], existingAi: existingAi('second'),
    });
    await Promise.resolve();
    expect(getIntelServiceState().shadowReadInFlight).toBe(true);

    await runIntelServiceCycle({ cycleNum: 2, gates: { nowMs: NOW } as never });
    expect(getIntelServiceState().skippedInFlight).toBe(1);
    release();

    const [firstEnvelope, secondEnvelope] = await Promise.all([first, second]);
    expect(firstEnvelope.records).toHaveLength(1);
    expect(secondEnvelope.records).toHaveLength(1);
    expect(fetchCandles).toHaveBeenCalledTimes(3);
    expect(injected.beginCycle).toHaveBeenCalledTimes(1);
    expect(getIntelServiceState().shadowReadInFlight).toBe(false);
  });

  it('candle evidence 누락을 record로 위장하지 않고 NOT_EVALUATED로 유지한다', async () => {
    const injected = handle(vi.fn(async () => null));
    __setIntelHandleForTests(injected);

    const envelope = await runStrategyShadowWorkerReadOnly({
      cycleNumber: 3,
      evaluatedAt: NOW,
      expectedSymbols: ['BTC', 'ETH'],
      existingAi: existingAi(),
    });

    expect(envelope.status).toBe('NOT_EVALUATED');
    expect(envelope.records).toEqual([]);
    expect(envelope.missingSymbols).toEqual(['BTC', 'ETH']);
    expect(envelope.executionAuthorized).toBe(false);
    expect(injected.beginCycle).toHaveBeenCalledTimes(1);
  });
});
