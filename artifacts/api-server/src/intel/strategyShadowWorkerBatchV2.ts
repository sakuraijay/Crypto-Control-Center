/**
 * Pure batch bridge between read-only worker evidence and the per-symbol
 * Strategy SHADOW runner. It performs no I/O and grants no execution authority.
 */
import type { CandleFrameInput, StrategyTimeframe } from './candleFoundationV2';
import type { CostSnapshot } from '../lib/costSnapshot';
import { COST_SNAPSHOT_TTL_MS, validateCostSnapshot } from '../lib/costSnapshot';
import type { RegimeState } from './regimeEngineV2';
import type { SignalHistoryEvent, SignalLifecycleRecord } from './signalLifecycleV2';
import { buildSignalLifecycleSnapshot } from './signalLifecycleSnapshotV2';
import type { ExistingAiDecisionSnapshot, StrategyShadowRecord } from './strategyShadowAdapterV2';
import {
  runStrategyShadowSymbol,
  type StrategyShadowRunnerInput,
  type StrategyShadowRunnerResult,
} from './strategyShadowRunnerV2';
import {
  buildStrategyShadowWorkerEnvelope,
  type ExistingWorkerAiSummary,
  type StrategyShadowWorkerEnvelope,
} from './strategyShadowWorkerEnvelopeV2';

export const STRATEGY_SHADOW_WORKER_BATCH_VERSION = 'strategy-shadow-worker-batch/v1' as const;

export interface StrategyShadowCostPair {
  market: string;
  notionalUsd: number;
  long: CostSnapshot | null;
  short: CostSnapshot | null;
}

export interface StrategyShadowCostBpsResult {
  expectedCostsBps: number | null;
  reasons: string[];
}

export const STRATEGY_SHADOW_COST_MAX_AGE_MS = COST_SNAPSHOT_TTL_MS;

export interface StrategyShadowWorkerBatchInput {
  cycleNumber: number;
  evaluatedAt: number;
  expectedSymbols: string[];
  framesBySymbol: Readonly<Record<string, Partial<Record<StrategyTimeframe, CandleFrameInput>>>>;
  costsBySymbol: Readonly<Record<string, StrategyShadowCostPair | null>>;
  previousRegimes: Readonly<Record<string, RegimeState | null>>;
  lifecycleRecords: SignalLifecycleRecord[];
  historyEvents: SignalHistoryEvent[];
  existingAi: ExistingWorkerAiSummary;
}

export interface StrategyShadowNotEvaluatedSymbol {
  symbol: string;
  reasons: string[];
  warnings: string[];
}

export interface StrategyShadowWorkerBatchResult {
  schemaVersion: typeof STRATEGY_SHADOW_WORKER_BATCH_VERSION | 'INVALID';
  envelope: StrategyShadowWorkerEnvelope;
  notEvaluatedSymbols: StrategyShadowNotEvaluatedSymbol[];
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
  riskAuthority: 'NOT_EVALUATED';
}

export interface StrategyShadowWorkerBatchDeps {
  runSymbol(input: StrategyShadowRunnerInput): StrategyShadowRunnerResult;
}

const DEFAULT_DEPS: StrategyShadowWorkerBatchDeps = Object.freeze({
  runSymbol: runStrategyShadowSymbol,
});

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

function validateShadowCostFreshness(snapshot: CostSnapshot, nowMs: number): string | null {
  if (typeof snapshot.apiTimestamp !== 'string' || snapshot.apiTimestamp.length === 0) {
    return 'upstream 비용 관측 시각 누락';
  }
  const observed = Date.parse(snapshot.apiTimestamp);
  const fetched = Date.parse(snapshot.fetchedAt);
  const expires = Date.parse(snapshot.expiresAt);
  if (!finite(observed) || !finite(fetched) || !finite(expires)
    || observed <= 0 || fetched <= 0 || expires <= 0) {
    return '비용 관측 시각 INVALID';
  }
  if (observed !== fetched) return 'apiTimestamp/fetchedAt 불일치';
  if (nowMs - observed > STRATEGY_SHADOW_COST_MAX_AGE_MS) {
    return `SHADOW 비용 age 초과: ${nowMs - observed}ms > ${STRATEGY_SHADOW_COST_MAX_AGE_MS}ms`;
  }
  const ttlMs = expires - fetched;
  if (ttlMs <= 0 || ttlMs > COST_SNAPSHOT_TTL_MS) {
    return `SHADOW 비용 TTL 비정상: ${ttlMs}ms`;
  }
  return null;
}

/**
 * Converts direction-bound, fresh cost evidence into one conservative scalar.
 * Both LONG and SHORT must validate; the more expensive side wins.
 */
export function deriveConservativeShadowCostBps(
  pair: StrategyShadowCostPair | null | undefined,
  nowMs: number,
): StrategyShadowCostBpsResult {
  if (!pair || !finite(nowMs) || nowMs <= 0 || !pair.market.trim()
    || !finite(pair.notionalUsd) || pair.notionalUsd <= 0) {
    return { expectedCostsBps: null, reasons: ['비용 pair 입력 누락 또는 INVALID'] };
  }
  if (!pair.long || !pair.short) {
    return { expectedCostsBps: null, reasons: ['LONG/SHORT 양방향 비용 증거 미완성'] };
  }
  const long = validateCostSnapshot(pair.long, {
    market: pair.market,
    isLong: true,
    orderType: 'MarketIncrease',
    notionalUsd: pair.notionalUsd,
  }, nowMs);
  const short = validateCostSnapshot(pair.short, {
    market: pair.market,
    isLong: false,
    orderType: 'MarketIncrease',
    notionalUsd: pair.notionalUsd,
  }, nowMs);
  if (!long.ok || !short.ok) {
    return {
      expectedCostsBps: null,
      reasons: [
        ...(!long.ok ? [`LONG 비용 INVALID: ${long.reason}`] : []),
        ...(!short.ok ? [`SHORT 비용 INVALID: ${short.reason}`] : []),
      ],
    };
  }
  const longFreshness = validateShadowCostFreshness(pair.long, nowMs);
  const shortFreshness = validateShadowCostFreshness(pair.short, nowMs);
  if (longFreshness || shortFreshness) {
    return {
      expectedCostsBps: null,
      reasons: [
        ...(longFreshness ? [`LONG 비용 INVALID: ${longFreshness}`] : []),
        ...(shortFreshness ? [`SHORT 비용 INVALID: ${shortFreshness}`] : []),
      ],
    };
  }
  const bps = Math.max(long.effectiveRoundTripCostUsd, short.effectiveRoundTripCostUsd)
    / pair.notionalUsd * 10_000;
  if (!finite(bps) || bps < 0) return { expectedCostsBps: null, reasons: ['비용 bps 변환 INVALID'] };
  return { expectedCostsBps: Number(bps.toPrecision(12)), reasons: [] };
}

function adapterExistingAi(existingAi: ExistingWorkerAiSummary): ExistingAiDecisionSnapshot {
  return {
    decisionId: existingAi.decisionId,
    action: existingAi.action,
    confidence: existingAi.confidence,
    reasons: ['기존 AI worker 결정과 SHADOW 비교'],
    sourceCandleCloseTime: null,
  };
}

/**
 * Evaluates symbols independently. Missing evidence never becomes a placeholder
 * NO_TRADE record: only EVALUATED results with a real record enter the envelope.
 */
export function buildStrategyShadowWorkerBatch(
  input: StrategyShadowWorkerBatchInput,
  deps: StrategyShadowWorkerBatchDeps = DEFAULT_DEPS,
): StrategyShadowWorkerBatchResult {
  const rawSymbols: unknown[] = Array.isArray(input.expectedSymbols) ? input.expectedSymbols : [];
  const symbols = [...new Set(rawSymbols
    .filter((symbol): symbol is string => typeof symbol === 'string' && symbol.trim().length > 0)
    .map(normalizeSymbol))].sort();
  const normalizedCosts: Record<string, StrategyShadowCostPair | null> = {};
  const costInputIssues: string[] = [];
  if (typeof input.costsBySymbol !== 'object' || input.costsBySymbol === null
    || Array.isArray(input.costsBySymbol)) {
    costInputIssues.push('costsBySymbol 객체 필요');
  } else {
    for (const [rawSymbol, pair] of Object.entries(input.costsBySymbol)) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) {
        costInputIssues.push('비어 있는 cost symbol key');
      } else if (!symbols.includes(symbol)) {
        costInputIssues.push(`예상 외 cost symbol: ${symbol}`);
      } else if (Object.prototype.hasOwnProperty.call(normalizedCosts, symbol)) {
        costInputIssues.push(`중복 canonical cost symbol: ${symbol}`);
      } else {
        normalizedCosts[symbol] = pair;
      }
    }
  }
  const invalid = !Number.isInteger(input.cycleNumber) || input.cycleNumber <= 0
    || !finite(input.evaluatedAt) || input.evaluatedAt <= 0
    || symbols.length === 0
    || symbols.length !== rawSymbols.length
    || !Array.isArray(input.lifecycleRecords)
    || !Array.isArray(input.historyEvents)
    || costInputIssues.length > 0;
  const lifecycleSnapshot = invalid ? null : buildSignalLifecycleSnapshot(
    input.lifecycleRecords, input.historyEvents, input.evaluatedAt);

  if (invalid || lifecycleSnapshot === null) {
    return {
      schemaVersion: 'INVALID',
      envelope: buildStrategyShadowWorkerEnvelope({
        cycleNumber: input.cycleNumber,
        generatedAt: input.evaluatedAt,
        expectedSymbols: symbols,
        records: [],
        existingAi: input.existingAi,
        notEvaluatedReason: lifecycleSnapshot === null && !invalid
          ? 'SHADOW lifecycle 상태 INVALID — fail-closed'
          : 'SHADOW batch 입력 INVALID — fail-closed',
      }),
      notEvaluatedSymbols: symbols.map(symbol => ({
        symbol,
        reasons: [lifecycleSnapshot === null && !invalid
          ? 'SHADOW lifecycle 상태 INVALID — fail-closed'
          : 'SHADOW batch 입력 INVALID — fail-closed'],
        warnings: [],
      })),
      executionAuthorized: false,
      approvalCreationAllowed: false,
      paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
      riskAuthority: 'NOT_EVALUATED',
    };
  }

  const records: StrategyShadowRecord[] = [];
  const notEvaluatedSymbols: StrategyShadowNotEvaluatedSymbol[] = [];
  const existingAi = adapterExistingAi(input.existingAi);

  for (const symbol of symbols) {
    const cost = deriveConservativeShadowCostBps(normalizedCosts[symbol], input.evaluatedAt);
    if (cost.expectedCostsBps === null) {
      notEvaluatedSymbols.push({
        symbol,
        reasons: cost.reasons.length > 0
          ? cost.reasons
          : ['양방향 fresh cost SHADOW 근거 미충족 — record 생성 금지'],
        warnings: [],
      });
      continue;
    }
    const result = deps.runSymbol({
      symbol,
      evaluatedAt: input.evaluatedAt,
      frames: input.framesBySymbol[symbol] ?? {},
      expectedCostsBps: cost.expectedCostsBps,
      previousRegime: input.previousRegimes[symbol] ?? null,
      lifecycleRecords: input.lifecycleRecords.filter(record => normalizeSymbol(record.symbol) === symbol),
      historyEvents: input.historyEvents.filter(event => normalizeSymbol(event.symbol) === symbol),
      existingAi,
    });
    if (result.status === 'EVALUATED' && result.record !== null) {
      records.push(result.record);
    } else {
      notEvaluatedSymbols.push({
        symbol,
        reasons: [...result.reasons],
        warnings: [...result.warnings],
      });
    }
  }

  const envelope = buildStrategyShadowWorkerEnvelope({
    cycleNumber: input.cycleNumber,
    generatedAt: input.evaluatedAt,
    expectedSymbols: symbols,
    records,
    lifecycleSnapshot,
    existingAi: input.existingAi,
    notEvaluatedReason: records.length === 0
      ? '모든 종목의 fresh MTF/cost SHADOW 근거 미충족 — 가짜 record 생성 금지'
      : undefined,
  });
  return {
    schemaVersion: STRATEGY_SHADOW_WORKER_BATCH_VERSION,
    envelope,
    notEvaluatedSymbols,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}
