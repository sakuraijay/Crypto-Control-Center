import { createHash } from 'node:crypto';
import type { DbTrade } from '@workspace/db';
import type { VirtualPaper400SessionV1 } from './virtualPaper400Ledger';
import { parseVirtualTradePlan } from './virtualPaperTradingMode';

export const PAPER_LEARNING_CONTRACT = Object.freeze({
  version: 'paper-learning/v1', status: 'COLLECTING_CANDIDATES',
  dataSource: 'PAPER_GMX_ESTIMATE', trainedModelAvailable: false,
  liveEligible: false, automaticPromotion: false,
  requiredValidation: ['CHRONOLOGICAL_PURGED_SPLIT', 'WALK_FORWARD_OUT_OF_SAMPLE',
    'FEES_SLIPPAGE_FUNDING_STRESS', 'DRAWDOWN_AND_EXPECTANCY', 'SEPARATE_REAL_MONEY_APPROVAL'],
});
export const PAPER_DAILY_MOMENTUM_STRATEGY_VERSION = 'paper-daily-momentum-experiment/v1' as const;
export interface PaperLearningLedgerReconciliation {
  readonly status: 'PASS';
  readonly validator: 'evaluateVirtualPaper400Account';
  readonly settlementRowCount: number;
}
const numeric = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || (typeof v !== 'number' && typeof v !== 'string')) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
/** Caller first validates the complete immutable ledger. Features are entry-time evidence;
 * labels are final, cost-inclusive position outcomes. Partial closes never become independent samples.
 * No model fitting, parameter mutation, signer or live execution dependency exists here. */
export function buildPaperLearningDataset(
  session: VirtualPaper400SessionV1,
  rows: readonly DbTrade[],
  audits: Map<string, unknown>,
  reconciliation: PaperLearningLedgerReconciliation,
) {
  const excluded: { openTradeId: string; reason: string }[] = [];
  const samples: Array<Record<string, any> & {
    sampleId: string; positionId: string; featureAt: string; openedAt: string; labelAvailableAt: string;
    labels: Record<string, any> & {
      grossPnlUsd: number; netPnlUsd: number; estimatedCostsUsd: number; settlementIds: string[];
    };
  }> = [];
  const opens = rows.filter(r => r.strategy === session.strategyTag && r.action === 'OPEN')
    .sort((a,b) => +new Date(a.timestamp)-+new Date(b.timestamp) || a.id.localeCompare(b.id));
  for (const open of opens) {
    const reject = (reason: string) => excluded.push({openTradeId:open.id,reason});
    const settled = rows.filter(r => r.strategy === session.strategyTag && r.action === 'CLOSE' && r.closesTradeId === open.id);
    const full = settled.filter(r => r.closeKind === 'FULL');
    if (open.closeTime === 0 || full.length !== 1) { reject('POSITION_NOT_FULLY_SETTLED'); continue; }
    const audit = audits.get(open.openDecisionId ?? '') as Record<string, any> | undefined;
    const c = audit?.candidate;
    const plan = parseVirtualTradePlan(audit?.tradePlan);
    const openedAt = +new Date(open.timestamp), closedAt = +new Date(full[0].timestamp);
    if (!audit || audit.sessionId !== session.sessionId || audit.mode !== 'VIRTUAL_PAPER_400'
      || !plan || !c || c.source !== 'gmx-official-api' || c.purpose !== 'AGGRESSIVE_PAPER_EXPERIMENT'
      || c.symbol !== open.symbol || c.side !== open.side || plan.openedAtMs !== openedAt
      || ![c.closedAt,c.evaluatedAt,c.referencePrice,c.momentum,c.stopFraction].every(v => typeof v === 'number' && Number.isFinite(v))
      || c.closedAt > c.evaluatedAt || c.evaluatedAt > openedAt || c.closedAt > openedAt
      || openedAt-c.closedAt>960_000 || openedAt-c.evaluatedAt>60_000
      || c.referencePrice<=0 || c.stopFraction<.002 || c.stopFraction>.008) {
      reject('ENTRY_FEATURE_EVIDENCE_INVALID_OR_UNAVAILABLE'); continue;
    }
    if (!Number.isFinite(closedAt) || closedAt < openedAt || settled.some(r =>
      r.settlementStatus !== 'PAPER_ESTIMATED' || r.costSource !== 'PAPER_GMX_ESTIMATE'
      || [r.netPnlEstimatedUsd,r.pnl,r.estEntryCostUsd,r.estExitCostUsd,r.estHoldingCostUsd].some(v => numeric(v) === null))) {
      reject('SETTLEMENT_LABEL_UNAVAILABLE'); continue;
    }
    const sum = (key: keyof DbTrade) => settled.reduce((n,r) => n + numeric(r[key])!,0);
    samples.push({sampleId:open.id,positionId:open.id,sessionId:session.sessionId,decisionId:open.openDecisionId,
      policyVersion:audit.policy?.version ?? null,planVersion:plan.version,
      strategy:'PAPER_DAILY_MOMENTUM_EXPERIMENT',strategyVersion:PAPER_DAILY_MOMENTUM_STRATEGY_VERSION,
      symbol:open.symbol,side:open.side,
      featureAt:new Date(c.evaluatedAt).toISOString(),openedAt:new Date(openedAt).toISOString(),labelAvailableAt:new Date(closedAt).toISOString(),
      features:{candleClosedAt:c.closedAt,momentum:c.momentum,stopFraction:c.stopFraction,referencePrice:c.referencePrice,
        leverage:plan.leverage,notionalUsd:plan.notionalUsd,plannedRiskUsd:plan.plannedRiskUsd,maxHoldHours:plan.maxHoldHours,
        estimatedRoundTripCostUsd:plan.estimatedRoundTripCostUsd},
      labels:{netPnlUsd:sum('netPnlEstimatedUsd'),grossPnlUsd:sum('pnl'),
        estimatedCostsUsd:sum('estEntryCostUsd')+sum('estExitCostUsd')+sum('estHoldingCostUsd'),
        netR:sum('netPnlEstimatedUsd')/plan.plannedRiskUsd,closeReason:full[0].closeReason,
        holdingMs:closedAt-openedAt,settlementIds:settled.map(r=>r.id).sort()},
      costBasis:'SIMULATED / ESTIMATED',liveEligible:false});
  }
  const period = (key: 'featureAt' | 'openedAt' | 'labelAvailableAt') => {
    const values = samples.map(sample => sample[key]).sort();
    return { first: values[0] ?? null, last: values.at(-1) ?? null };
  };
  const sampleExcludedTotal = samples.length + excluded.length;
  const datasetSha256=createHash('sha256').update(JSON.stringify(samples)).digest('hex');
  return {...PAPER_LEARNING_CONTRACT,sessionId:session.sessionId,datasetSha256,sampleCount:samples.length,
    excludedCount:excluded.length,reviewedOpenCandidateCount:opens.length,
    settlementRowCount:reconciliation.settlementRowCount,
    sampleExcludedTotal,exclusionRate:sampleExcludedTotal === 0 ? 0 : excluded.length / sampleExcludedTotal,
    eligiblePeriods:{featureAt:period('featureAt'),openedAt:period('openedAt'),labelAvailableAt:period('labelAvailableAt')},
    ledgerReconciliation:{status:reconciliation.status,validator:reconciliation.validator,
      scope:{sessionId:session.sessionId,strategyTag:session.strategyTag,tradeRowCount:rows.length,
        reviewedOpenCandidateCount:opens.length,settlementRowCount:reconciliation.settlementRowCount}},
    samples,excluded,
    splitRule:'Sort by openedAt; purge training rows whose labelAvailableAt overlaps validation/test start. Never randomly split overlapping positions.'};
}
