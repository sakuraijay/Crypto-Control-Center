import { describe, expect, it } from 'vitest';
import { initialRiskEngineState } from '../lib/riskEngineState';
import {
  buildActivePaperEpoch,
  buildPaperEpochBinding,
  parseActivePaperEpoch,
  verifyActivePaperEpochSnapshot,
} from '../lib/paperEpochState';

describe('active PAPER epoch canonical state', () => {
  const startedAt = new Date('2026-09-03T19:00:00.000Z');
  const nowMs = startedAt.getTime() + 60_000;

  it('accepts only the exact canonical pointer schema', () => {
    const active = buildActivePaperEpoch('canonical-1', startedAt);
    expect(parseActivePaperEpoch(JSON.stringify(active), nowMs)).toEqual({
      ok: true,
      value: active,
    });

    expect(parseActivePaperEpoch(JSON.stringify({ ...active, extra: true }), nowMs)).toMatchObject({
      ok: false,
      reason: 'ACTIVE_EPOCH_KEYS_INVALID',
    });
    expect(parseActivePaperEpoch(JSON.stringify({
      ...active,
      relaySubmissionEnabled: true,
    }), nowMs)).toMatchObject({
      ok: false,
      reason: 'ACTIVE_EPOCH_VALUES_INVALID',
    });
    expect(parseActivePaperEpoch(JSON.stringify({
      ...active,
      startedAt: '2026-09-03T19:00:00Z',
    }), nowMs)).toMatchObject({
      ok: false,
      reason: 'ACTIVE_EPOCH_VALUES_INVALID',
    });
  });

  it('rejects a future activation timestamp', () => {
    const future = buildActivePaperEpoch(
      'future-1',
      new Date(nowMs + 1),
    );
    expect(parseActivePaperEpoch(JSON.stringify(future), nowMs)).toMatchObject({
      ok: false,
      reason: 'ACTIVE_EPOCH_VALUES_INVALID',
    });
  });

  it('binds the pointer, audit, limits, baselines and risk state by hash', () => {
    const active = buildActivePaperEpoch('binding-1', startedAt);
    const limits = { tradingCapital: 1000, reserveCashPct: 20 };
    const daily = {
      periodStart: '2026-09-03T00:00:00.000Z',
      equity: 1000,
      recordedAt: startedAt.toISOString(),
    };
    const weekly = {
      periodStart: '2026-08-31T00:00:00.000Z',
      equity: 1000,
      recordedAt: startedAt.toISOString(),
    };
    const risk = initialRiskEngineState(startedAt, 1000);
    const audit = {
      schemaVersion: 1,
      idempotencyKey: active.idempotencyKey,
      epochId: active.epochId,
      appliedAt: startedAt.toISOString(),
      appliedAtMs: startedAt.getTime(),
      before: {
        activeEpoch: null,
        equityHwm: null,
        daily: null,
        weekly: null,
        risk: null,
        limits: { tradingCapital: 24.5, reserveCashPct: 20 },
      },
      after: {
        activeEpoch: active,
        limits,
        equityHwm: 1000,
        daily,
        weekly,
        risk,
      },
      zeroStateCounts: {
        open: 0,
        approvals: 0,
        intents: 0,
        protections: 0,
        unsettled: 0,
        relay: 0,
      },
      binding: buildPaperEpochBinding(active, limits, daily, weekly, risk),
    };
    const base = {
      activeRaw: JSON.stringify(active),
      auditRaw: JSON.stringify(audit),
      equityHwmRaw: '1000',
      limits,
      dailyRaw: JSON.stringify(daily),
      weeklyRaw: JSON.stringify(weekly),
      riskRaw: JSON.stringify(risk),
      nowMs,
    };

    expect(verifyActivePaperEpochSnapshot(base)).toMatchObject({
      ok: true,
      value: {
        activeEpoch: { epochId: active.epochId },
        audit: { idempotencyKey: active.idempotencyKey },
      },
    });
    expect(verifyActivePaperEpochSnapshot({
      ...base,
      equityHwmRaw: '1025',
      limits: { ...limits, reserveCashPct: 21 },
      dailyRaw: JSON.stringify({ ...daily, equity: 1025 }),
      riskRaw: JSON.stringify({
        ...risk,
        riskOperatingState: 'DAILY_LOCKED',
        startOfDayEquityUsd: 1025,
        lastUpdatedAt: new Date(nowMs).toISOString(),
      }),
    })).toMatchObject({
      ok: true,
    });
    expect(verifyActivePaperEpochSnapshot({
      ...base,
      auditRaw: JSON.stringify({
        ...audit,
        after: {
          ...audit.after,
          limits: { ...limits, reserveCashPct: 21 },
        },
      }),
    })).toMatchObject({
      ok: false,
      reason: 'ACTIVE_EPOCH_IMMUTABLE_AUDIT_INVALID',
    });
    expect(verifyActivePaperEpochSnapshot({
      ...base,
      auditRaw: null,
    })).toMatchObject({
      ok: false,
      reason: 'ACTIVE_EPOCH_AUDIT_MISSING',
    });
  });
});