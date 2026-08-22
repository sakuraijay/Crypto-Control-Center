/** Pure, serializable worker envelope for Strategy Ensemble SHADOW explainability. */
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';

export const STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION = 'strategy-shadow-worker-envelope/v1' as const;

export type ExistingWorkerAiAction = 'LONG' | 'SHORT' | 'NO_TRADE';

export interface ExistingWorkerAiSummary {
  decisionId: string;
  action: ExistingWorkerAiAction;
  confidence: number;
  primarySymbol: string | null;
  createdAt: string;
}

export type StrategyShadowWorkerStatus = 'NOT_EVALUATED' | 'PARTIAL' | 'EVALUATED' | 'BLOCKED';

export interface StrategyShadowWorkerEnvelope {
  schemaVersion: typeof STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION | 'INVALID';
  envelopeId: string;
  mode: 'SHADOW_ONLY';
  status: StrategyShadowWorkerStatus;
  cycleNumber: number;
  generatedAt: number;
  expectedSymbols: string[];
  evaluatedSymbols: string[];
  missingSymbols: string[];
  records: StrategyShadowRecord[];
  summary: {
    long: number;
    short: number;
    noTrade: number;
    rejected: number;
    disabled: number;
    directionConflicts: number;
  };
  existingAi: ExistingWorkerAiSummary;
  reasons: string[];
  warnings: string[];
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
  riskAuthority: 'NOT_EVALUATED';
}

export interface StrategyShadowWorkerEnvelopeInput {
  cycleNumber: number;
  generatedAt: number;
  expectedSymbols: string[];
  records: StrategyShadowRecord[];
  existingAi: ExistingWorkerAiSummary;
  notEvaluatedReason?: string;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

function safeEnvelope(
  input: StrategyShadowWorkerEnvelopeInput,
  status: StrategyShadowWorkerStatus,
  version: StrategyShadowWorkerEnvelope['schemaVersion'],
  expectedSymbols: string[],
  records: StrategyShadowRecord[],
  reasons: string[],
  warnings: string[] = [],
): StrategyShadowWorkerEnvelope {
  const evaluatedSymbols = [...new Set(records.map(record => normalizeSymbol(record.symbol)))].sort();
  const evaluated = new Set(evaluatedSymbols);
  const summary = {
    long: records.filter(record => record.action === 'LONG').length,
    short: records.filter(record => record.action === 'SHORT').length,
    noTrade: records.filter(record => record.action === 'NO_TRADE').length,
    rejected: records.filter(record => record.action === 'REJECTED').length,
    disabled: records.filter(record => record.action === 'DISABLED').length,
    directionConflicts: records.filter(record => record.comparison === 'DIRECTION_CONFLICT').length,
  };
  return {
    schemaVersion: version,
    envelopeId: `${input.existingAi.decisionId}:STRATEGY_SHADOW`,
    mode: 'SHADOW_ONLY',
    status,
    cycleNumber: input.cycleNumber,
    generatedAt: input.generatedAt,
    expectedSymbols,
    evaluatedSymbols,
    missingSymbols: expectedSymbols.filter(symbol => !evaluated.has(symbol)),
    records,
    summary,
    existingAi: input.existingAi,
    reasons,
    warnings,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}

/**
 * Packages already-computed advisory records for the worker decision log.
 * This function never invents a record: zero records are explicitly NOT_EVALUATED.
 */
export function buildStrategyShadowWorkerEnvelope(
  input: StrategyShadowWorkerEnvelopeInput,
): StrategyShadowWorkerEnvelope {
  const rawExpectedSymbols: unknown[] = Array.isArray(input.expectedSymbols) ? input.expectedSymbols : [];
  const expectedSymbols = [...new Set(rawExpectedSymbols
    .filter((symbol): symbol is string => typeof symbol === 'string')
    .map(normalizeSymbol))].sort();
  const issues: string[] = [];
  if (!Number.isInteger(input.cycleNumber) || input.cycleNumber <= 0) issues.push('cycle number INVALID');
  if (!finite(input.generatedAt) || input.generatedAt <= 0) issues.push('generatedAt INVALID');
  if (!Array.isArray(input.expectedSymbols)
    || rawExpectedSymbols.some(symbol => typeof symbol !== 'string' || !symbol.trim())) {
    issues.push('expected symbols INVALID');
  }
  if (!input.existingAi.decisionId.trim()) issues.push('existing AI decision ID INVALID');
  if (!['LONG', 'SHORT', 'NO_TRADE'].includes(input.existingAi.action)) issues.push('existing AI action INVALID');
  if (!finite(input.existingAi.confidence) || input.existingAi.confidence < 0 || input.existingAi.confidence > 100) {
    issues.push('existing AI confidence INVALID');
  }
  const createdAtMs = Date.parse(input.existingAi.createdAt);
  if (!finite(createdAtMs) || createdAtMs > input.generatedAt) issues.push('existing AI createdAt INVALID');
  if (input.existingAi.primarySymbol !== null
    && (typeof input.existingAi.primarySymbol !== 'string'
      || !input.existingAi.primarySymbol.trim()
      || !expectedSymbols.includes(normalizeSymbol(input.existingAi.primarySymbol)))) {
    issues.push('existing AI primary symbol INVALID');
  }
  if (!Array.isArray(input.records)) issues.push('shadow records 배열 필요');
  if (issues.length > 0) {
    return safeEnvelope(input, 'BLOCKED', 'INVALID', expectedSymbols, [],
      ['worker Shadow 입력 INVALID — fail-closed'], issues);
  }

  const recordIds = new Set<string>();
  for (const record of input.records) {
    if (record.schemaVersion !== 'strategy-shadow-adapter/v1'
      || record.mode !== 'SHADOW_ONLY'
      || record.executionAuthorized !== false
      || record.paperPositionMutationAllowed !== false
      || record.riskAuthority !== 'NOT_EVALUATED'
      || record.evaluatedAt > input.generatedAt
      || !expectedSymbols.includes(normalizeSymbol(record.symbol))) {
      issues.push(`unsafe 또는 불일치 Shadow record: ${record.shadowRecordId}`);
      continue;
    }
    if (recordIds.has(record.shadowRecordId)) issues.push(`중복 Shadow record ID: ${record.shadowRecordId}`);
    recordIds.add(record.shadowRecordId);
  }
  if (issues.length > 0) {
    return safeEnvelope(input, 'BLOCKED', STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION,
      expectedSymbols, [], ['Shadow record 검증 실패 — 기록 채택 차단'], issues);
  }

  if (input.records.length === 0) {
    const reason = input.notEvaluatedReason?.trim();
    if (!reason) {
      return safeEnvelope(input, 'BLOCKED', STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION,
        expectedSymbols, [], ['0건 Shadow record의 NOT_EVALUATED 사유 누락 — fail-closed']);
    }
    return safeEnvelope(input, 'NOT_EVALUATED', STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION,
      expectedSymbols, [], [reason, '가짜 Ensemble 신호를 생성하지 않음']);
  }

  const covered = new Set(input.records.map(record => normalizeSymbol(record.symbol)));
  const status: StrategyShadowWorkerStatus = expectedSymbols.every(symbol => covered.has(symbol))
    ? 'EVALUATED' : 'PARTIAL';
  return safeEnvelope(input, status, STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION,
    expectedSymbols, input.records, [status === 'EVALUATED'
      ? '모든 기대 종목의 Shadow explainability 확보'
      : '일부 종목만 Shadow explainability 확보 — 누락 종목 실행 근거로 사용 금지']);
}
