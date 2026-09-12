export const STRATEGY_SHADOW_VIEW_VERSION = 'strategy-shadow-worker-envelope/v1' as const;

export type StrategyShadowViewStatus = 'NOT_EVALUATED' | 'PARTIAL' | 'EVALUATED' | 'BLOCKED';

export interface StrategyShadowViewRecord {
  symbol: string;
  regime: string;
  action: string;
  comparison: string;
  strategyId: string | null;
  signalId: string | null;
  confidence: number | null;
  selectedScore: number | null;
  expectedNetEdgeBps: number | null;
  expectedNetRR: number | null;
  lifecycleEligible: boolean | null;
  reasons: string[];
  warnings: string[];
}

export interface StrategyShadowView {
  schemaVersion: typeof STRATEGY_SHADOW_VIEW_VERSION;
  mode: 'SHADOW_ONLY';
  status: StrategyShadowViewStatus;
  cycleNumber: number;
  expectedSymbols: string[];
  evaluatedSymbols: string[];
  missingSymbols: string[];
  records: StrategyShadowViewRecord[];
  reasons: string[];
  warnings: string[];
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
  riskAuthority: 'NOT_EVALUATED';
}

const STATUS = new Set<StrategyShadowViewStatus>(['NOT_EVALUATED', 'PARTIAL', 'EVALUATED', 'BLOCKED']);
const ACTION = new Set(['LONG', 'SHORT', 'NO_TRADE', 'REJECTED', 'DISABLED']);
const COMPARISON = new Set([
  'AGREE_DIRECTION', 'AGREE_NO_TRADE', 'ENSEMBLE_ONLY', 'EXISTING_AI_ONLY',
  'DIRECTION_CONFLICT', 'UNAVAILABLE',
]);

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value as string[] : null;

const nullableFinite = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;

function parseRecord(value: unknown): StrategyShadowViewRecord | null {
  const record = objectRecord(value);
  if (!record || typeof record.symbol !== 'string' || !record.symbol.trim()
    || typeof record.regime !== 'string' || !record.regime.trim()
    || typeof record.action !== 'string' || !ACTION.has(record.action)
    || typeof record.comparison !== 'string' || !COMPARISON.has(record.comparison)) return null;

  const strategyId = nullableString(record.strategyId);
  const signalId = nullableString(record.signalId);
  const confidence = nullableFinite(record.confidence);
  const selectedScore = nullableFinite(record.selectedScore);
  const expectedNetEdgeBps = nullableFinite(record.expectedNetEdgeBps);
  const expectedNetRR = nullableFinite(record.expectedNetRR);
  const reasons = stringArray(record.reasons);
  const warnings = stringArray(record.warnings);
  const lifecycleEligible = record.lifecycleEligible === null
    ? null : typeof record.lifecycleEligible === 'boolean' ? record.lifecycleEligible : undefined;
  if (strategyId === undefined || signalId === undefined || confidence === undefined
    || selectedScore === undefined || expectedNetEdgeBps === undefined || expectedNetRR === undefined
    || lifecycleEligible === undefined || reasons === null || warnings === null) return null;

  return {
    symbol: record.symbol.trim().toUpperCase(), regime: record.regime, action: record.action,
    comparison: record.comparison, strategyId, signalId, confidence, selectedScore,
    expectedNetEdgeBps, expectedNetRR, lifecycleEligible, reasons, warnings,
  };
}

/**
 * Converts persisted fullJson evidence into a display-only view. Unsafe authority
 * literals or malformed records are rejected instead of being rendered as valid.
 */
export function parseStrategyShadowView(value: unknown): StrategyShadowView | null {
  if (value === undefined || value === null) return null;
  const envelope = objectRecord(value);
  if (!envelope
    || envelope.schemaVersion !== STRATEGY_SHADOW_VIEW_VERSION
    || envelope.mode !== 'SHADOW_ONLY'
    || typeof envelope.status !== 'string' || !STATUS.has(envelope.status as StrategyShadowViewStatus)
    || typeof envelope.cycleNumber !== 'number' || !Number.isInteger(envelope.cycleNumber) || envelope.cycleNumber <= 0
    || envelope.executionAuthorized !== false
    || envelope.approvalCreationAllowed !== false
    || envelope.paperPositionMutationAllowed !== false
    || envelope.livePositionMutationAllowed !== false
    || envelope.riskAuthority !== 'NOT_EVALUATED') return null;

  const expectedSymbols = stringArray(envelope.expectedSymbols);
  const evaluatedSymbols = stringArray(envelope.evaluatedSymbols);
  const missingSymbols = stringArray(envelope.missingSymbols);
  const reasons = stringArray(envelope.reasons);
  const warnings = stringArray(envelope.warnings);
  const records = Array.isArray(envelope.records) ? envelope.records.map(parseRecord) : null;
  if (!expectedSymbols || !evaluatedSymbols || !missingSymbols || !reasons || !warnings
    || !records || records.some(record => record === null)) return null;

  return {
    schemaVersion: STRATEGY_SHADOW_VIEW_VERSION,
    mode: 'SHADOW_ONLY',
    status: envelope.status as StrategyShadowViewStatus,
    cycleNumber: envelope.cycleNumber as number,
    expectedSymbols: [...expectedSymbols],
    evaluatedSymbols: [...evaluatedSymbols],
    missingSymbols: [...missingSymbols],
    records: records as StrategyShadowViewRecord[],
    reasons: [...reasons], warnings: [...warnings],
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}
