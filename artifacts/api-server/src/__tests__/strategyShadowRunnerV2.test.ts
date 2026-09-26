import { describe, expect, it } from 'vitest';
import type { CandleFrameInput, StrategyTimeframe } from '../intel/candleFoundationV2';
import {
  DEFAULT_STRATEGY_SHADOW_RUNNER_CONFIG,
  runStrategyShadowSymbol,
  STRATEGY_SHADOW_RUNNER_VERSION,
  validateStrategyShadowRunnerConfig,
  type StrategyShadowRunnerInput,
} from '../intel/strategyShadowRunnerV2';
import { DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS } from '../intel/strategyShadowAdapterV2';
import type { Candle } from '../intel/types';

const BOUNDARY = 1_800_000_000_000;
const NOW = BOUNDARY + 10_000;
const STEPS: Record<StrategyTimeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

function candles(timeframe: StrategyTimeframe, count = 240): Candle[] {
  const step = STEPS[timeframe];
  const lastOpen = BOUNDARY - step;
  const firstOpen = lastOpen - (count - 1) * step;
  return Array.from({ length: count }, (_, index) => {
    const center = 100 + index * 0.08 + Math.sin(index / 3) * 0.35;
    const open = center - 0.04;
    const close = center + 0.04;
    return { t: firstOpen + index * step, o: open, h: center + 0.22,
      l: center - 0.22, c: close, v: 100 + index % 7 };
  });
}

function frame(symbol: string, timeframe: StrategyTimeframe): CandleFrameInput {
  return { symbol, timeframe, source: 'gmx-official-api', fetchedAtMs: NOW,
    candles: candles(timeframe) };
}

function input(overrides: Partial<StrategyShadowRunnerInput> = {}): StrategyShadowRunnerInput {
  return {
    symbol: 'BTC',
    evaluatedAt: NOW,
    frames: { '15m': frame('BTC', '15m'), '1h': frame('BTC', '1h'), '4h': frame('BTC', '4h') },
    expectedCostsBps: 10,
    previousRegime: null,
    lifecycleRecords: [],
    historyEvents: [],
    existingAi: { decisionId: 'existing-1', action: 'NO_TRADE', confidence: 0,
      reasons: ['legacy AI no trade'], sourceCandleCloseTime: BOUNDARY },
    ...overrides,
  };
}

describe('Strategy SHADOW MTF runner', () => {
  it('strict versioned config를 검증한다', () => {
    expect(validateStrategyShadowRunnerConfig(DEFAULT_STRATEGY_SHADOW_RUNNER_CONFIG)).toEqual([]);
    expect(validateStrategyShadowRunnerConfig({ ...DEFAULT_STRATEGY_SHADOW_RUNNER_CONFIG,
      unknown: true })).toContain('알 수 없는 runner config 필드: unknown');
  });

  it('완료된 동일 종목 MTF evidence를 실행 권한 없는 record로 평가한다', () => {
    const result = runStrategyShadowSymbol(input());
    expect(result.schemaVersion).toBe(STRATEGY_SHADOW_RUNNER_VERSION);
    expect(result.status).toBe('EVALUATED');
    expect(result.sourceCandleCloseTime).toBe(BOUNDARY);
    expect(result.record).not.toBeNull();
    expect(result).toMatchObject({ executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
      riskAuthority: 'NOT_EVALUATED' });
    expect(result.record).toMatchObject({ mode: 'SHADOW_ONLY', executionAuthorized: false,
      paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED' });
  });

  it('필수 timeframe 누락 시 record를 만들지 않는다', () => {
    const value = input();
    delete value.frames['4h'];
    const result = runStrategyShadowSymbol(value);
    expect(result).toMatchObject({ status: 'NOT_EVALUATED', record: null,
      executionAuthorized: false });
  });

  it('검증되지 않은 source는 fail-closed 처리한다', () => {
    const value = input();
    value.frames['1h'] = { ...value.frames['1h']!, source: 'untrusted' };
    const result = runStrategyShadowSymbol(value);
    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.record).toBeNull();
  });

  it('음수 비용 evidence를 입력 오류로 차단한다', () => {
    const result = runStrategyShadowSymbol(input({ expectedCostsBps: -1 }));
    expect(result).toMatchObject({ schemaVersion: 'INVALID', status: 'NOT_EVALUATED',
      record: null });
  });

  it('비용 evidence가 없으면 평가 record는 가능하지만 actionable signal은 만들지 않는다', () => {
    const result = runStrategyShadowSymbol(input({ expectedCostsBps: null }));
    expect(result.status).toBe('EVALUATED');
    expect(result.record).not.toBeNull();
    expect(['NO_TRADE', 'REJECTED', 'DISABLED']).toContain(result.record!.action);
  });

  it('PAPER execution feature flag는 SHADOW record에서 거부한다', () => {
    const result = runStrategyShadowSymbol(input({
      featureFlags: { ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, paperExecutionEnabled: true },
    }));
    expect(result.record).toMatchObject({ action: 'REJECTED', executionAuthorized: false,
      paperPositionMutationAllowed: false });
  });

  it('이전 Regime의 종목이 다르면 state를 재사용하지 않는다', () => {
    const result = runStrategyShadowSymbol(input({ previousRegime: {
      symbol: 'ETH', regime: 'TREND_UP', confidence: 80,
      sinceCandleCloseTime: BOUNDARY - STEPS['15m'], heldCandles: 2,
      pendingRegime: null, pendingCount: 0,
    } }));
    expect(result).toMatchObject({ status: 'NOT_EVALUATED', record: null });
  });
});
