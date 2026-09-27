export const STRATEGY_RISK_ADVISORY_VIEW_VERSION = 'strategy-risk-worker-bridge/v1' as const;

export type StrategyRiskAdvisoryStatus = 'NOT_EVALUATED' | 'PARTIAL' | 'EVALUATED' | 'BLOCKED';
export type StrategyRiskAdvisoryAction = 'ALLOW' | 'REDUCE' | 'REJECT';

export interface StrategyRiskAdvisoryDecisionView {
  schemaVersion: 'strategy-risk-adapter/v1' | 'INVALID';
  decisionId: string;
  signalId: string | null;
  symbol: string;
  action: StrategyRiskAdvisoryAction;
  direction: 'LONG' | 'SHORT' | 'NONE';
  sizeFactor: number;
  maxLeverage: number;
  riskState: string | null;
  reasons: string[];
  warnings: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

export interface StrategyRiskAdvisoryView {
  schemaVersion: typeof STRATEGY_RISK_ADVISORY_VIEW_VERSION | 'INVALID';
  advisoryId: string;
  status: StrategyRiskAdvisoryStatus;
  cycleNumber: number;
  riskState: string | null;
  decisions: StrategyRiskAdvisoryDecisionView[];
  summary: { allow: number; reduce: number; reject: number };
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const STATUS = new Set<StrategyRiskAdvisoryStatus>(['NOT_EVALUATED', 'PARTIAL', 'EVALUATED', 'BLOCKED']);
const ACTION = new Set<StrategyRiskAdvisoryAction>(['ALLOW', 'REDUCE', 'REJECT']);
const DIRECTION = new Set(['LONG', 'SHORT', 'NONE']);
const RISK_STATE = new Set([
  'NORMAL', 'DEFENSIVE', 'PROFIT_PROTECTED', 'PROFIT_TARGET_LOCKED',
  'PROFIT_CAP_LOCKED', 'DAILY_LOSS_LOCKED', 'WEEKLY_LOSS_LOCKED',
  'CONSECUTIVE_LOSS_LOCKED', 'HARD_STOPPED', 'UNRESOLVED',
]);

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value as string[] : null;

const safeAuthority = (value: Record<string, unknown>): boolean =>
  value.authority === 'ADVISORY_ONLY'
  && value.executionAuthorized === false
  && value.approvalCreationAllowed === false
  && value.paperPositionMutationAllowed === false
  && value.livePositionMutationAllowed === false;

const parseRiskState = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && RISK_STATE.has(value) ? value : undefined;

function parseDecision(value: unknown): StrategyRiskAdvisoryDecisionView | null {
  const decision = objectRecord(value);
  if (!decision || !safeAuthority(decision)
    || (decision.schemaVersion !== 'strategy-risk-adapter/v1' && decision.schemaVersion !== 'INVALID')
    || typeof decision.decisionId !== 'string' || !decision.decisionId.trim()
    || (decision.signalId !== null && (typeof decision.signalId !== 'string' || !decision.signalId.trim()))
    || typeof decision.symbol !== 'string' || !decision.symbol.trim()
    || typeof decision.action !== 'string' || !ACTION.has(decision.action as StrategyRiskAdvisoryAction)
    || typeof decision.direction !== 'string' || !DIRECTION.has(decision.direction)
    || typeof decision.sizeFactor !== 'number' || !Number.isFinite(decision.sizeFactor)
    || decision.sizeFactor < 0 || decision.sizeFactor > 1
    || typeof decision.maxLeverage !== 'number' || !Number.isFinite(decision.maxLeverage)
    || decision.maxLeverage < 0 || decision.maxLeverage > 3) return null;

  const riskState = parseRiskState(decision.riskState);
  const reasons = stringArray(decision.reasons);
  const warnings = stringArray(decision.warnings);
  if (riskState === undefined || reasons === null || warnings === null) return null;

  return {
    schemaVersion: decision.schemaVersion,
    decisionId: decision.decisionId.trim(),
    signalId: decision.signalId as string | null,
    symbol: decision.symbol.trim().toUpperCase(),
    action: decision.action as StrategyRiskAdvisoryAction,
    direction: decision.direction as 'LONG' | 'SHORT' | 'NONE',
    sizeFactor: decision.sizeFactor,
    maxLeverage: decision.maxLeverage,
    riskState,
    reasons: [...reasons], warnings: [...warnings],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

/** Converts persisted advisory evidence into a display-only view. */
export function parseStrategyRiskAdvisoryView(value: unknown): StrategyRiskAdvisoryView | null {
  if (value === undefined || value === null) return null;
  const advisory = objectRecord(value);
  if (!advisory || !safeAuthority(advisory)
    || (advisory.schemaVersion !== STRATEGY_RISK_ADVISORY_VIEW_VERSION && advisory.schemaVersion !== 'INVALID')
    || typeof advisory.advisoryId !== 'string' || !advisory.advisoryId.trim()
    || typeof advisory.status !== 'string' || !STATUS.has(advisory.status as StrategyRiskAdvisoryStatus)
    || typeof advisory.cycleNumber !== 'number' || !Number.isInteger(advisory.cycleNumber) || advisory.cycleNumber <= 0
    || (advisory.schemaVersion === 'INVALID' && advisory.status !== 'BLOCKED')) return null;

  const riskState = parseRiskState(advisory.riskState);
  const reasons = stringArray(advisory.reasons);
  const summary = objectRecord(advisory.summary);
  const decisions = Array.isArray(advisory.decisions) ? advisory.decisions.map(parseDecision) : null;
  if (riskState === undefined || reasons === null || !summary || !decisions
    || decisions.some(decision => decision === null)
    || !Number.isInteger(summary.allow) || !Number.isInteger(summary.reduce) || !Number.isInteger(summary.reject)
    || (summary.allow as number) < 0 || (summary.reduce as number) < 0 || (summary.reject as number) < 0) return null;

  const parsed = decisions as StrategyRiskAdvisoryDecisionView[];
  const expectedSummary = {
    allow: parsed.filter(decision => decision.action === 'ALLOW').length,
    reduce: parsed.filter(decision => decision.action === 'REDUCE').length,
    reject: parsed.filter(decision => decision.action === 'REJECT').length,
  };
  if (summary.allow !== expectedSummary.allow
    || summary.reduce !== expectedSummary.reduce
    || summary.reject !== expectedSummary.reject) return null;

  return {
    schemaVersion: advisory.schemaVersion as typeof STRATEGY_RISK_ADVISORY_VIEW_VERSION | 'INVALID',
    advisoryId: advisory.advisoryId.trim(),
    status: advisory.status as StrategyRiskAdvisoryStatus,
    cycleNumber: advisory.cycleNumber,
    riskState,
    decisions: parsed,
    summary: expectedSummary,
    reasons: [...reasons],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}
