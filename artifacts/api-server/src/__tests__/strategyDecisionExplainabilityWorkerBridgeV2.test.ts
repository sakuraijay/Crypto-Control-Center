import { describe, expect, it } from 'vitest';
import {
  buildStrategyDecisionExplainabilityWorkerAdvisory,
  STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION,
} from '../intel/strategyDecisionExplainabilityWorkerBridgeV2';
import type { StrategyRiskWorkerAdvisory } from '../intel/strategyRiskWorkerBridgeV2';
import type { StrategyRiskAdapterDecision } from '../intel/strategyRiskAdapterV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { StrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';

const record = (symbol = 'BTC'): StrategyShadowRecord => ({
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: `${symbol}:SHADOW:1`,
  mode: 'SHADOW_ONLY', symbol, evaluatedAt: 2, sourceCandleCloseTime: 1,
  regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY',
  strategyId: 'TREND_PULLBACK', signalId: `${symbol}-signal`, direction: 'LONG',
  confidence: 75, selectedScore: 80, entryPrice: 100, structuralStop: 98,
  expectedNetEdgeBps: 200, expectedNetRR: 2, lifecycleEligible: true,
  existingAi: null, reasons: [], warnings: [], executionAuthorized: false,
  paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED',
});
const decision = (value: StrategyShadowRecord, action: 'ALLOW' | 'REJECT'):
StrategyRiskAdapterDecision => ({
  schemaVersion: 'strategy-risk-adapter/v1',
  decisionId: `${value.shadowRecordId}:RISK_ADAPTER`, signalId: value.signalId,
  symbol: value.symbol, action, direction: action === 'REJECT' ? 'NONE' : value.direction,
  sizeFactor: action === 'REJECT' ? 0 : 1, maxLeverage: action === 'REJECT' ? 0 : 2,
  riskState: action === 'REJECT' ? 'HARD_STOPPED' : 'NORMAL', reasons: [], warnings: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const shadow = (records = [record()]): StrategyShadowWorkerEnvelope => ({
  schemaVersion: 'strategy-shadow-worker-envelope/v1', envelopeId: 'cycle:1:SHADOW',
  status: 'EVALUATED', mode: 'SHADOW_ONLY', cycleNumber: 1, generatedAt: 2,
  expectedSymbols: records.map(value => value.symbol),
  evaluatedSymbols: records.map(value => value.symbol), missingSymbols: [], records,
  summary: {
    long: records.length, short: 0, noTrade: 0, rejected: 0, disabled: 0,
    directionConflicts: 0,
  },
  reasons: [], warnings: [], existingAi: {
    decisionId: 'decision-1', action: 'NO_TRADE', confidence: 0,
    primarySymbol: null, createdAt: new Date(2).toISOString(),
  },
  lifecycleSnapshot: null, riskAuthority: 'NOT_EVALUATED',
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const risk = (envelope: StrategyShadowWorkerEnvelope, actions: ('ALLOW' | 'REJECT')[] = ['ALLOW']):
StrategyRiskWorkerAdvisory => ({
  schemaVersion: 'strategy-risk-worker-bridge/v1',
  advisoryId: `${envelope.envelopeId}:RISK_ADVISORY`, status: 'EVALUATED', cycleNumber: 1,
  riskState: actions.every(value => value === 'REJECT') ? 'HARD_STOPPED' : 'NORMAL',
  decisions: envelope.records.map((value, index) => decision(value, actions[index] ?? 'ALLOW')),
  summary: {
    allow: actions.filter(value => value === 'ALLOW').length, reduce: 0,
    reject: actions.filter(value => value === 'REJECT').length,
  },
  reasons: [], authority: 'ADVISORY_ONLY', executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false,
});

describe('Strategy decision explainability aiWorker bridge', () => {
  it('ALLOW는 downstream을 추정하지 않고 NOT_EVALUATED로 직렬화한다', () => {
    const s = shadow();
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: risk(s) }))
      .toMatchObject({
        schemaVersion: STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION,
        status: 'NOT_EVALUATED', summary: { notEvaluated: 1 },
        envelopes: [{ status: 'NOT_EVALUATED', stages: { sizing: null, confidence: null, gmxNetEdge: null } }],
        authority: 'ADVISORY_ONLY', externalReadStarted: false,
        independentPersistenceAllowed: false, executionAuthorized: false,
      });
  });

  it('HARD_STOP Risk REJECT를 terminal EVALUATED aggregate로 보존한다', () => {
    const s = shadow();
    const result = buildStrategyDecisionExplainabilityWorkerAdvisory({
      shadowEnvelope: s, riskAdvisory: risk(s, ['REJECT']),
    });
    expect(result).toMatchObject({ status: 'EVALUATED', summary: { rejected: 1 } });
    expect(result.envelopes[0]).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
  });

  it('terminal과 미평가가 섞이면 PARTIAL을 유지한다', () => {
    const s = shadow([record('BTC'), record('ETH')]);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({
      shadowEnvelope: s, riskAdvisory: risk(s, ['REJECT', 'ALLOW']),
    })).toMatchObject({ status: 'PARTIAL', summary: { rejected: 1, notEvaluated: 1 } });
  });

  it('SHADOW 또는 Risk 미평가는 빈 NOT_EVALUATED이며 downstream을 시작하지 않는다', () => {
    const s = shadow(); const r = risk(s); r.status = 'NOT_EVALUATED';
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: r }))
      .toMatchObject({ status: 'NOT_EVALUATED', envelopes: [], externalReadStarted: false });
  });

  it('cycle·identity·권한 불일치를 INVALID/BLOCKED로 fail-closed 처리한다', () => {
    const s = shadow(); const wrongCycle = risk(s); wrongCycle.cycleNumber = 2;
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: wrongCycle }))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
    const wrongIdentity = risk(s); wrongIdentity.decisions[0] = {
      ...wrongIdentity.decisions[0], signalId: 'other',
    };
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: wrongIdentity }))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
    const unsafe = risk(s); unsafe.executionAuthorized = true as never;
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: unsafe }))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
  });

  it('입력을 변경하지 않고 동일한 결과를 생성한다', () => {
    const s = shadow(); const r = risk(s); const before = JSON.stringify({ s, r });
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: r }))
      .toEqual(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: r }));
    expect(JSON.stringify({ s, r })).toBe(before);
  });
});
