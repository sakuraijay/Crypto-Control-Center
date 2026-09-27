import { describe, expect, it } from 'vitest';
import { parseStrategyRiskAdvisoryView } from '../ai/strategyRiskAdvisoryView';

const validDecision = {
  schemaVersion: 'strategy-risk-adapter/v1', decisionId: 'BTC:1:RISK_ADAPTER',
  signalId: 'BTC:1', symbol: 'BTC', action: 'REJECT', direction: 'NONE',
  sizeFactor: 0, maxLeverage: 0, riskState: 'HARD_STOPPED',
  reasons: ['기존 Risk Engine veto가 최종 권한'], warnings: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false,
};

const validAdvisory = {
  schemaVersion: 'strategy-risk-worker-bridge/v1', advisoryId: 'cycle:5:RISK_ADVISORY',
  status: 'EVALUATED', cycleNumber: 5, riskState: 'HARD_STOPPED',
  decisions: [validDecision], summary: { allow: 0, reduce: 0, reject: 1 },
  reasons: ['read-only advisory projection'], authority: 'ADVISORY_ONLY',
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
};

describe('parseStrategyRiskAdvisoryView', () => {
  it('accepts safe read-only Risk advisory evidence', () => {
    const view = parseStrategyRiskAdvisoryView(validAdvisory);
    expect(view?.summary).toEqual({ allow: 0, reduce: 0, reject: 1 });
    expect(view?.decisions[0]).toMatchObject({ symbol: 'BTC', action: 'REJECT', riskState: 'HARD_STOPPED' });
  });

  it('rejects any envelope or decision with execution authority', () => {
    expect(parseStrategyRiskAdvisoryView({ ...validAdvisory, executionAuthorized: true })).toBeNull();
    expect(parseStrategyRiskAdvisoryView({
      ...validAdvisory,
      decisions: [{ ...validDecision, paperPositionMutationAllowed: true }],
    })).toBeNull();
  });

  it('rejects a summary that does not match the decisions', () => {
    expect(parseStrategyRiskAdvisoryView({
      ...validAdvisory, summary: { allow: 1, reduce: 0, reject: 0 },
    })).toBeNull();
  });

  it('rejects unsafe leverage, malformed risk state and absent evidence', () => {
    expect(parseStrategyRiskAdvisoryView({
      ...validAdvisory, decisions: [{ ...validDecision, maxLeverage: 4 }],
    })).toBeNull();
    expect(parseStrategyRiskAdvisoryView({ ...validAdvisory, riskState: 'UNKNOWN' })).toBeNull();
    expect(parseStrategyRiskAdvisoryView(undefined)).toBeNull();
  });
});
