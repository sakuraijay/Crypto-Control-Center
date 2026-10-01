import { describe, expect, it } from 'vitest';
import {
  continuousPaperComparisonHeadKey,
  continuousPaperComparisonPageKey,
  recordContinuousPaperComparison,
  summarizeContinuousPaperComparison,
  type ContinuousPaperPair,
} from '../workers/virtualPaperContinuousComparison';

const sessionId = 'paper-session';
const at = Date.parse('2026-10-01T12:00:00.000Z');

function pair(symbol: string, closedAt: number, observedAt: number): ContinuousPaperPair {
  const long = {
    entry: 100, stop: 99.5, target: 101, notional: 100, maxHoldHours: 1,
    expiresAt: observedAt + 3_600_000,
  };
  return {
    id: `${symbol}:${closedAt}`,
    symbol,
    closedAt,
    observedAt,
    legacy: {
      policyVersion: 'virtual400-daily/v7',
      accepted: false,
      reason: 'V7_NET_RR_BELOW_1_5',
      side: 'LONG',
      plan: null,
      cost: { estimatedRoundTripUsd: 1.2, source: 'PAPER_GMX_ESTIMATE', observedAt },
      conditions: [{ name: 'netRewardRisk', value: 1.46, operator: '>=', threshold: 1.5, passed: false }],
    },
    adaptive: {
      policyVersion: 'virtual400-daily/v8',
      accepted: true,
      reason: 'ADAPTIVE_SIGNAL_SCORE_ACCEPTED',
      side: 'LONG',
      plan: long,
      cost: { estimatedRoundTripUsd: 1.2, source: 'PAPER_GMX_ESTIMATE', observedAt },
      conditions: [{ name: 'score', value: 67, operator: '>=', threshold: 45, passed: true }],
    },
  };
}

function store(options: { failHeadWrite?: boolean } = {}) {
  const values = new Map<string, string>();
  let failHeadWrite = options.failHeadWrite ?? false;
  return {
    values,
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      if (failHeadWrite && key.includes('_head:')) {
        failHeadWrite = false;
        throw new Error('CHECKPOINT_WRITE_FAILED');
      }
      values.set(key, value);
    },
  };
}

describe('continuous matched PAPER comparison evidence', () => {
  it('records old and new decisions for the same candle, with honest missing-outcome and cost reporting', async () => {
    const repository = store();
    const current = pair('BTC', at - 900_000, at);
    const result = await recordContinuousPaperComparison(repository, sessionId, current, at);
    expect(result).toEqual({ recorded: true, candidates: 1 });
    expect(await recordContinuousPaperComparison(repository, sessionId, current, at)).toEqual({
      recorded: false, candidates: 1,
    });

    const report = await summarizeContinuousPaperComparison(repository, sessionId, at);
    expect(report.accepted).toEqual({ legacyV7: 0, adaptiveV8: 1 });
    expect(report.costEvidenceAvailable).toEqual({ legacyV7: 1, adaptiveV8: 1 });
    expect(report.outcomes).toEqual({
      status: 'NOT_EVALUATED_NO_CLOSED_CANDLE_REPLAY',
      matured: 0,
      pendingTimeWindow: 1,
      outcomeUnknown: 1,
      opportunityArms: 2,
      netPnlUsd: null,
      expectancyUsd: null,
      winRate: null,
    });
    expect(report.automaticPromotion).toBe(false);
    expect(report.outOfSampleStrategyValidated).toBe(false);
  });

  it('recovers a page written before a failed head checkpoint without duplicating the candle', async () => {
    const repository = store({ failHeadWrite: true });
    const current = pair('ETH', at - 900_000, at);
    await expect(recordContinuousPaperComparison(repository, sessionId, current, at))
      .rejects.toThrow('CHECKPOINT_WRITE_FAILED');
    expect(repository.values.has(continuousPaperComparisonPageKey(sessionId, '2026-10-01'))).toBe(true);
    expect(repository.values.has(continuousPaperComparisonHeadKey(sessionId))).toBe(false);

    const recovered = await recordContinuousPaperComparison(repository, sessionId, current, at + 1);
    expect(recovered).toEqual({ recorded: false, candidates: 1 });
    expect((await summarizeContinuousPaperComparison(repository, sessionId, at + 1)).candidates).toBe(1);
  });

  it('accepts an out-of-order same-day candidate on replay and still deduplicates by closed candle', async () => {
    const repository = store();
    const laterCandle = pair('BTC', at - 900_000, at);
    const earlierCandleFromRotation = pair('ETH', at - 1_800_000, at);
    expect(await recordContinuousPaperComparison(repository, sessionId, laterCandle, at))
      .toEqual({ recorded: true, candidates: 1 });
    expect(await recordContinuousPaperComparison(repository, sessionId, earlierCandleFromRotation, at))
      .toEqual({ recorded: true, candidates: 2 });
    expect(await recordContinuousPaperComparison(repository, sessionId, laterCandle, at))
      .toEqual({ recorded: false, candidates: 2 });
    expect((await summarizeContinuousPaperComparison(repository, sessionId, at)).candidates).toBe(2);
  });

  it('separates open holding-time windows from expired-but-unevaluated unknown outcomes', async () => {
    const repository = store();
    const open = pair('BTC', at - 900_000, at);
    const expired = pair('ETH', at - 1_800_000, at);
    expired.adaptive.plan!.expiresAt = at - 1;
    await recordContinuousPaperComparison(repository, sessionId, open, at);
    await recordContinuousPaperComparison(repository, sessionId, expired, at);

    const report = await summarizeContinuousPaperComparison(repository, sessionId, at);
    expect(report.pendingTimeWindow).toBe(1);
    expect(report.outcomeUnknown).toBe(3);
    expect(report.outcomes.matured).toBe(0);
    expect(report.outcomes.netPnlUsd).toBeNull();
  });

  it('keeps samples in distinct daily pages, deduplicates within a page, and has no aggregate 2,000 cap', async () => {
    const repository = store();
    const start = Date.parse('2026-10-01T00:15:00.000Z');
    for (let index = 0; index < 2001; index += 1) {
      const observedAt = start + index * 60_000;
      const closedAt = observedAt - 900_000;
      const current = pair('BTC', closedAt, observedAt);
      await recordContinuousPaperComparison(repository, sessionId, current, observedAt);
    }

    const report = await summarizeContinuousPaperComparison(repository, sessionId, start + 2001 * 60_000);
    expect(report.candidates).toBe(2001);
    expect(report.pages).toBe(2);
    expect(repository.values.has(continuousPaperComparisonPageKey(sessionId, '2026-10-01'))).toBe(true);
    expect(repository.values.has(continuousPaperComparisonPageKey(sessionId, '2026-10-02'))).toBe(true);
  });

  it('deduplicates the same closed candle when a later poll falls on the next UTC date', async () => {
    const repository = store();
    const closedAt = Date.parse('2026-10-01T23:45:00.000Z');
    const beforeMidnight = pair('XRP', closedAt, Date.parse('2026-10-01T23:59:00.000Z'));
    const afterMidnight = pair('XRP', closedAt, Date.parse('2026-10-02T00:01:00.000Z'));
    expect(await recordContinuousPaperComparison(repository, sessionId, beforeMidnight, beforeMidnight.observedAt))
      .toEqual({ recorded: true, candidates: 1 });
    expect(await recordContinuousPaperComparison(repository, sessionId, afterMidnight, afterMidnight.observedAt))
      .toEqual({ recorded: false, candidates: 1 });
    expect(repository.values.has(continuousPaperComparisonPageKey(sessionId, '2026-10-02'))).toBe(false);
  });

  it('treats missing cost evidence as unavailable, never as a zero-cost observation', async () => {
    const repository = store();
    const current = pair('SOL', at - 900_000, at);
    current.legacy.cost = null;
    current.adaptive.cost = null;
    current.adaptive.accepted = false;
    current.adaptive.plan = null;
    current.adaptive.reason = 'COST_EVIDENCE_UNAVAILABLE';
    await recordContinuousPaperComparison(repository, sessionId, current, at);

    const report = await summarizeContinuousPaperComparison(repository, sessionId, at);
    expect(report.costEvidenceAvailable).toEqual({ legacyV7: 0, adaptiveV8: 0 });
    expect(report.costEvidenceUnavailable).toEqual({ legacyV7: 1, adaptiveV8: 1 });
    const page = JSON.parse(repository.values.get(continuousPaperComparisonPageKey(sessionId, '2026-10-01'))!);
    expect(page.samples[0].legacy.cost).toBeNull();
    expect(page.samples[0].adaptive.cost).toBeNull();
  });

  it('rejects invalid policy versions and an accepted arm without a fully costed plan', async () => {
    const repository = store();
    const wrongVersion = pair('DOGE', at - 900_000, at);
    wrongVersion.adaptive.policyVersion = 'virtual400-daily/v7' as 'virtual400-daily/v8';
    await expect(recordContinuousPaperComparison(repository, sessionId, wrongVersion, at))
      .rejects.toThrow('PAPER_CONTINUOUS_COMPARISON_PAIR_INVALID');

    const acceptedWithoutCost = pair('DOGE', at - 900_000, at);
    acceptedWithoutCost.adaptive.cost = null;
    await expect(recordContinuousPaperComparison(repository, sessionId, acceptedWithoutCost, at))
      .rejects.toThrow('PAPER_CONTINUOUS_COMPARISON_PAIR_INVALID');

    const nonPaperCost = pair('DOGE', at - 900_000, at);
    nonPaperCost.adaptive.cost!.source = 'UNVERIFIED_PROVIDER';
    await expect(recordContinuousPaperComparison(repository, sessionId, nonPaperCost, at))
      .rejects.toThrow('PAPER_CONTINUOUS_COMPARISON_PAIR_INVALID');
  });
});