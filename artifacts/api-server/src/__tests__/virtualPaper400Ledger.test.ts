import { describe, expect, it } from 'vitest';
import {
  buildVirtualPaper400Session,
  deriveVirtualPaper400Ledger,
  parseVirtualPaper400Session,
  type VirtualPaper400SessionV1,
  virtualPaper400StrategyTag,
} from '../workers/virtualPaper400Ledger';

const START = new Date('2026-09-20T00:00:00.000Z');

function settlement(
  session: VirtualPaper400SessionV1,
  overrides: Partial<Parameters<typeof deriveVirtualPaper400Ledger>[1][number]> = {},
) {
  return {
    id: 'close-1',
    action: 'CLOSE',
    strategy: session.strategyTag,
    settlementStatus: 'PAPER_ESTIMATED',
    costSource: 'PAPER_GMX_ESTIMATE',
    pnl: '10.00',
    netPnlEstimatedUsd: '9.75',
    estEntryCostUsd: '0.10',
    estExitCostUsd: '0.10',
    estHoldingCostUsd: '0.05',
    ...overrides,
  };
}

describe('virtual PAPER 400 ledger core', () => {
  it('creates an immutable virtual-only 400 USDC session identity', () => {
    const session = buildVirtualPaper400Session('alpha-virtual-400', START);
    expect(session).toEqual({
      schemaVersion: 1,
      mode: 'VIRTUAL_PAPER_400',
      sessionId: 'alpha-virtual-400',
      startedAt: '2026-09-20T00:00:00.000Z',
      startedAtMs: START.getTime(),
      initialEquityUsd: 400,
      strategyTag: 'SERVER_WORKER_AI_VIRTUAL_400_V1:alpha-virtual-400',
      realFundsUsed: false,
    });
    expect(parseVirtualPaper400Session(JSON.stringify(session))).toEqual({ ok: true, value: session });
  });

  it('rejects a legacy/other-capital session instead of silently treating it as virtual 400', () => {
    const session = buildVirtualPaper400Session('alpha-virtual-400', START);
    expect(parseVirtualPaper400Session({ ...session, initialEquityUsd: 1000 })).toEqual({
      ok: false,
      reason: 'VIRTUAL_SESSION_VALUES_INVALID',
    });
  });

  it('binds the strategy namespace to the exact virtual session identity', () => {
    const session = buildVirtualPaper400Session('alpha-virtual-400', START);
    expect(session.strategyTag).toBe(virtualPaper400StrategyTag(session.sessionId));
    expect(parseVirtualPaper400Session({
      ...session,
      strategyTag: virtualPaper400StrategyTag('another-session'),
    })).toEqual({ ok: false, reason: 'VIRTUAL_SESSION_VALUES_INVALID' });
  });

  it('derives realized equity from isolated virtual settlements including modeled costs', () => {
    const session = buildVirtualPaper400Session('alpha-virtual-400', START);
    const result = deriveVirtualPaper400Ledger(session, [
      settlement(session),
      settlement(session, {
        id: 'close-2',
        pnl: '-20.00',
        netPnlEstimatedUsd: '-20.25',
      }),
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: 'alpha-virtual-400',
        initialEquityUsd: 400,
        realizedGrossPnlUsd: -10,
        modeledTradingCostUsd: 0.5,
        realizedNetPnlUsd: -10.5,
        realizedEquityUsd: 389.5,
        settlementCount: 2,
      },
    });
  });

  it('preserves a real modeled loss instead of clamping bad outcomes to zero', () => {
    const session = buildVirtualPaper400Session('loss-case', START);
    const result = deriveVirtualPaper400Ledger(session, [settlement(session, {
      pnl: '-500',
      netPnlEstimatedUsd: '-500',
      estEntryCostUsd: '0',
      estExitCostUsd: '0',
      estHoldingCostUsd: '0',
    })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.realizedEquityUsd).toBe(-100);
  });

  it('fails closed when Standard PAPER rows are mixed into the virtual 400 ledger', () => {
    const session = buildVirtualPaper400Session('scope-case', START);
    expect(deriveVirtualPaper400Ledger(session, [settlement(session, { strategy: 'SERVER_WORKER_AI' })])).toEqual({
      ok: false,
      reason: 'VIRTUAL_SETTLEMENT_SCOPE_MISMATCH',
    });
  });

  it('fails closed when another virtual session row is mixed into this session ledger', () => {
    const session = buildVirtualPaper400Session('scope-case', START);
    expect(deriveVirtualPaper400Ledger(session, [settlement(session, {
      strategy: virtualPaper400StrategyTag('another-session'),
    })])).toEqual({
      ok: false,
      reason: 'VIRTUAL_SETTLEMENT_SCOPE_MISMATCH',
    });
  });

  it('fails closed when net PnL is missing instead of substituting zero', () => {
    const session = buildVirtualPaper400Session('missing-net', START);
    expect(deriveVirtualPaper400Ledger(session, [settlement(session, { netPnlEstimatedUsd: null })])).toEqual({
      ok: false,
      reason: 'VIRTUAL_SETTLEMENT_NUMERIC_INVALID',
    });
  });

  it('rejects duplicate settlement rows so restart/replay cannot double count PnL', () => {
    const session = buildVirtualPaper400Session('duplicate-case', START);
    expect(deriveVirtualPaper400Ledger(session, [settlement(session), settlement(session)])).toEqual({
      ok: false,
      reason: 'VIRTUAL_SETTLEMENT_DUPLICATE',
    });
  });

  it('rejects a settlement whose recorded net does not match gross minus modeled costs', () => {
    const session = buildVirtualPaper400Session('mismatch-case', START);
    expect(deriveVirtualPaper400Ledger(session, [settlement(session, { netPnlEstimatedUsd: '10.00' })])).toEqual({
      ok: false,
      reason: 'VIRTUAL_SETTLEMENT_NET_MISMATCH',
    });
  });
});
