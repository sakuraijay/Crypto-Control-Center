import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../intel/types';
import {
  STRATEGY_SHADOW_MTF_COORDINATOR_VERSION,
  StrategyShadowMtfFrameCoordinator,
} from '../intel/strategyShadowMtfFrameCoordinatorV2';

const NOW = Date.parse('2026-08-23T01:00:00.000Z');

function candles(count = 240): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    t: NOW - (count - index) * 900_000,
    o: 100 + index,
    h: 101 + index,
    l: 99 + index,
    c: 100.5 + index,
    v: null,
  }));
}

describe('Strategy SHADOW MTF frame coordinator', () => {
  it('reads all required frames through the injected shared fetcher', async () => {
    const fetchCandles = vi.fn(async () => candles());
    const coordinator = new StrategyShadowMtfFrameCoordinator({ fetchCandles, nowMs: () => NOW });
    const result = await coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC', 'ETH'], requestedAtMs: NOW });

    expect(result.schemaVersion).toBe(STRATEGY_SHADOW_MTF_COORDINATOR_VERSION);
    expect(result.status).toBe('COMPLETE');
    expect(fetchCandles).toHaveBeenCalledTimes(6);
    expect(fetchCandles).toHaveBeenCalledWith('BTC', '15m', 240);
    expect(fetchCandles).toHaveBeenCalledWith('ETH', '4h', 240);
    expect(result.framesBySymbol.BTC?.['15m']).toBeDefined();
    expect(result.framesBySymbol.BTC?.['1h']).toBeDefined();
    expect(result.framesBySymbol.BTC?.['4h']).toBeDefined();
  });

  it('joins the same active cycle instead of duplicating external reads', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchCandles = vi.fn(async () => { await gate; return candles(); });
    const coordinator = new StrategyShadowMtfFrameCoordinator({ fetchCandles, nowMs: () => NOW, concurrency: 8 });
    const first = coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC'], requestedAtMs: NOW });
    const joined = coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC'], requestedAtMs: NOW });
    release();

    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    expect(firstResult.joinedInFlight).toBe(false);
    expect(joinedResult.joinedInFlight).toBe(true);
    expect(fetchCandles).toHaveBeenCalledTimes(3);
  });

  it('does not queue a different cycle while one is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchCandles = vi.fn(async () => { await gate; return candles(); });
    const coordinator = new StrategyShadowMtfFrameCoordinator({ fetchCandles, nowMs: () => NOW });
    const active = coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC'], requestedAtMs: NOW });
    const blocked = await coordinator.read({ cycleKey: 'cycle-2', symbols: ['ETH'], requestedAtMs: NOW });

    expect(blocked.status).toBe('BUSY_DIFFERENT_CYCLE');
    expect(blocked.queued).toBe(false);
    expect(blocked.missingSymbols[0].reasons[0]).toContain('미제출/큐 생성 없음');
    release();
    await active;
    expect(fetchCandles).toHaveBeenCalledTimes(3);
  });

  it('does not join a different symbol set that reuses an active cycle key', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchCandles = vi.fn(async () => { await gate; return candles(); });
    const coordinator = new StrategyShadowMtfFrameCoordinator({ fetchCandles, nowMs: () => NOW });
    const active = coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC'], requestedAtMs: NOW });
    const blocked = await coordinator.read({ cycleKey: 'cycle-1', symbols: ['ETH'], requestedAtMs: NOW });

    expect(blocked.status).toBe('BUSY_DIFFERENT_CYCLE');
    expect(blocked.queued).toBe(false);
    release();
    await active;
    expect(fetchCandles).toHaveBeenCalledTimes(3);
  });

  it('keeps only the affected symbol missing on a partial read', async () => {
    const fetchCandles = vi.fn(async (symbol: string) => symbol === 'ETH' ? null : candles());
    const coordinator = new StrategyShadowMtfFrameCoordinator({ fetchCandles, nowMs: () => NOW });
    const result = await coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC', 'ETH'], requestedAtMs: NOW });

    expect(result.status).toBe('PARTIAL');
    expect(result.missingSymbols.map(value => value.symbol)).toEqual(['ETH']);
    expect(Object.keys(result.framesBySymbol.BTC ?? {})).toHaveLength(3);
    expect(Object.keys(result.framesBySymbol.ETH ?? {})).toHaveLength(0);
  });

  it('converts fetch failures to missing evidence without throwing', async () => {
    const coordinator = new StrategyShadowMtfFrameCoordinator({
      fetchCandles: async (_symbol, timeframe) => {
        if (timeframe === '1h') throw new Error('sensitive upstream detail');
        return candles();
      },
      nowMs: () => NOW,
    });
    const result = await coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC'], requestedAtMs: NOW });

    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.missingSymbols[0].missingTimeframes).toEqual(['1h']);
    expect(result.missingSymbols[0].reasons[0]).toBe('1h read 실패: Error');
    expect(result.missingSymbols[0].reasons[0]).not.toContain('sensitive');
  });

  it('fails closed on duplicate normalized symbols', async () => {
    const fetchCandles = vi.fn(async () => candles());
    const coordinator = new StrategyShadowMtfFrameCoordinator({ fetchCandles, nowMs: () => NOW });
    const result = await coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC', 'btc'], requestedAtMs: NOW });

    expect(result.schemaVersion).toBe('INVALID');
    expect(result.status).toBe('NOT_EVALUATED');
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('never grants execution or mutation authority', async () => {
    const coordinator = new StrategyShadowMtfFrameCoordinator({
      fetchCandles: async () => candles(),
      nowMs: () => NOW,
    });
    const result = await coordinator.read({ cycleKey: 'cycle-1', symbols: ['BTC'], requestedAtMs: NOW });

    expect(result.executionAuthorized).toBe(false);
    expect(result.approvalCreationAllowed).toBe(false);
    expect(result.paperPositionMutationAllowed).toBe(false);
    expect(result.livePositionMutationAllowed).toBe(false);
    expect(result.riskAuthority).toBe('NOT_EVALUATED');
  });
});
