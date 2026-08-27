/**
 * Immutable-input BTC research report builder. It never discovers or downloads
 * data. Absence of repository evidence is represented as UNAVAILABLE.
 */
import type { Candle } from './types';
import type { OfflineHistoricalCostEvidence, OfflineWalkForwardConfig } from './offlineWalkForwardBacktestV2';
import { runOfflineWalkForwardBacktest, DEFAULT_OFFLINE_WALK_FORWARD_CONFIG } from './offlineWalkForwardBacktestV2';
import type { OfflineRiskEvidence } from './offlineDecisionReplayV2';
import { replayOfflineDecision } from './offlineDecisionReplayV2';
import { createHash } from 'node:crypto';

export const OFFLINE_BTC_DATASET_SCHEMA_VERSION = 'offline-btc-dataset/v1' as const;
export type OfflineBtcTimeframe = '15m' | '1h' | '4h';

export interface OfflineEvidenceProvenance {
  datasetId: string;
  source: string;
  license: string | null;
  immutable: true;
  checksumAlgorithm: 'SHA-256';
  checksums: Record<OfflineBtcTimeframe | 'costs' | 'risk', string | null>;
  /** SHA-256 of the byte-for-byte committed Binance response artifacts. */
  artifactChecksums?: Partial<Record<OfflineBtcTimeframe | 'funding', string>>;
  /** Only observed point-in-time cost/risk evidence may produce an OK report. */
  costEvidenceKind?: 'OBSERVED' | 'MODELED' | 'ASSUMED';
  riskEvidenceKind?: 'OBSERVED' | 'MODELED' | 'ASSUMED';
  period: { fromMs: number | null; toMs: number | null };
  retrievedAtMs?: number;
  methodology?: string;
}

export interface OfflineBtcDataset {
  schemaVersion: typeof OFFLINE_BTC_DATASET_SCHEMA_VERSION;
  provenance: OfflineEvidenceProvenance;
  candles: Record<OfflineBtcTimeframe, readonly Candle[]>;
  costs: readonly OfflineHistoricalCostEvidence[];
  risks: readonly OfflineRiskEvidence[];
}

export interface OfflineBtcReport {
  status: 'OK' | 'UNAVAILABLE';
  generatedAtMs: number;
  provenance: OfflineEvidenceProvenance;
  evidence: {
    candleCounts: Record<OfflineBtcTimeframe, number>;
    costCount: number;
    riskCount: number;
  };
  issues: string[];
  walkForward: ReturnType<typeof runOfflineWalkForwardBacktest> | null;
  autoPromotionAllowed: false;
  liveExecutionAuthorized: false;
}

export interface OfflineBtcReportBuildInput {
  generatedAtMs: number;
  dataset: OfflineBtcDataset | null;
  config?: OfflineWalkForwardConfig;
  fromMs?: number;
  toMs?: number;
  maxFolds?: number;
}

const EMPTY_PROVENANCE: OfflineEvidenceProvenance = Object.freeze({
  datasetId: 'btc-historical-evidence-unavailable',
  source: 'repository immutable evidence inventory',
  license: null,
  immutable: true,
  checksumAlgorithm: 'SHA-256',
  checksums: { '15m': null, '1h': null, '4h': null, costs: null, risk: null },
  period: { fromMs: null, toMs: null },
});

const STEPS: Record<OfflineBtcTimeframe, number> = {
  '15m': 15 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '4h': 4 * 60 * 60 * 1_000,
};
const checksum = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function candleIssues(timeframe: OfflineBtcTimeframe, candles: readonly Candle[], generatedAtMs: number): string[] {
  const issues: string[] = [];
  const step = STEPS[timeframe];
  let previous = -Infinity;
  for (const candle of candles) {
    if (!Number.isFinite(candle.t) || candle.t % step !== 0) issues.push(`${timeframe} 정렬 오류`);
    if (previous !== -Infinity && candle.t !== previous + step) issues.push(`${timeframe} 중복/역순/gap`);
    if (candle.t + step > generatedAtMs) issues.push(`${timeframe} 미마감 candle`);
    if (![candle.o, candle.h, candle.l, candle.c, candle.v].every(
      value => typeof value === 'number' && Number.isFinite(value),
    )) issues.push(`${timeframe} OHLCV 누락`);
    previous = candle.t;
  }
  return issues;
}

/** Honest fixture used until authentic immutable candles and point-in-time costs are committed. */
export function buildUnavailableOfflineBtcReport(generatedAtMs: number): OfflineBtcReport {
  return {
    status: 'UNAVAILABLE',
    generatedAtMs,
    provenance: EMPTY_PROVENANCE,
    evidence: { candleCounts: { '15m': 0, '1h': 0, '4h': 0 }, costCount: 0, riskCount: 0 },
    issues: [
      '저장소에 검증 가능한 immutable BTC 15m/1h/4h OHLCV evidence가 없음',
      '시점별 fee/slippage/funding/borrowing/impact evidence가 없음',
      '시점별 risk-policy 재생 evidence가 없음',
      '합성 또는 현재값 대체 없이 보고서를 UNAVAILABLE 처리함',
    ],
    walkForward: null,
    autoPromotionAllowed: false,
    liveExecutionAuthorized: false,
  };
}

export function buildOfflineBtcReport(input: OfflineBtcReportBuildInput): OfflineBtcReport {
  if (input.dataset === null) return buildUnavailableOfflineBtcReport(input.generatedAtMs);
  const selected15m = input.dataset.candles['15m'].filter(candle =>
    (input.fromMs === undefined || candle.t >= input.fromMs)
    && (input.toMs === undefined || candle.t + STEPS['15m'] <= input.toMs));
  const dataset: OfflineBtcDataset = (input.fromMs === undefined && input.toMs === undefined)
    ? input.dataset
    : {
      ...input.dataset,
      provenance: {
        ...input.dataset.provenance,
        checksums: {
          ...input.dataset.provenance.checksums,
          '15m': checksum(selected15m),
          costs: checksum(input.dataset.costs.filter(row => selected15m.some(candle => candle.t + STEPS['15m'] === row.observedAtMs))),
          risk: checksum(input.dataset.risks.filter(row => selected15m.some(candle => candle.t + STEPS['15m'] === row.observedAtMs))),
        },
        period: { fromMs: selected15m[0]?.t ?? null, toMs: selected15m.at(-1) ? selected15m.at(-1)!.t + STEPS['15m'] : null },
      },
      candles: { ...input.dataset.candles, '15m': selected15m },
      costs: input.dataset.costs.filter(row => selected15m.some(candle => candle.t + STEPS['15m'] === row.observedAtMs)),
      risks: input.dataset.risks.filter(row => selected15m.some(candle => candle.t + STEPS['15m'] === row.observedAtMs)),
    };
  const evidence = {
    candleCounts: {
      '15m': dataset.candles['15m'].length,
      '1h': dataset.candles['1h'].length,
      '4h': dataset.candles['4h'].length,
    },
    costCount: dataset.costs.length,
    riskCount: dataset.risks.length,
  };
  const issues: string[] = [];
  if (dataset.schemaVersion !== OFFLINE_BTC_DATASET_SCHEMA_VERSION) issues.push('dataset schema version 오류');
  if (!dataset.provenance.datasetId.trim() || !dataset.provenance.source.trim()) issues.push('provenance 누락');
  if (dataset.provenance.costEvidenceKind !== 'OBSERVED') {
    issues.push(`cost evidence is ${dataset.provenance.costEvidenceKind ?? 'UNSPECIFIED'}, not OBSERVED`);
  }
  if (dataset.provenance.riskEvidenceKind !== 'OBSERVED') {
    issues.push(`risk evidence is ${dataset.provenance.riskEvidenceKind ?? 'UNSPECIFIED'}, not OBSERVED`);
  }
  for (const key of ['15m', '1h', '4h', 'costs', 'risk'] as const) {
    if (!/^[a-f0-9]{64}$/i.test(dataset.provenance.checksums[key] ?? '')) issues.push(`${key} SHA-256 checksum 누락`);
  }
  for (const timeframe of ['15m', '1h', '4h'] as const) {
    issues.push(...candleIssues(timeframe, dataset.candles[timeframe], input.generatedAtMs));
    if (dataset.provenance.checksums[timeframe] !== checksum(dataset.candles[timeframe])) {
      issues.push(`${timeframe} checksum 불일치`);
    }
  }
  if (dataset.provenance.checksums.costs !== checksum(dataset.costs)) issues.push('costs checksum 불일치');
  if (dataset.provenance.checksums.risk !== checksum(dataset.risks)) issues.push('risk checksum 불일치');
  if (Object.values(evidence.candleCounts).some(count => count === 0)) issues.push('3 timeframe OHLCV 누락');
  for (const timeframe of ['15m', '1h', '4h'] as const) {
    if (evidence.candleCounts[timeframe] < 60) issues.push(`${timeframe} feature lookback 부족`);
  }
  if (evidence.costCount === 0) issues.push('historical cost/funding evidence 누락');
  if (evidence.riskCount === 0) issues.push('historical risk evidence 누락');
  for (const row of dataset.costs) {
    if (![row.observedAtMs, row.feeBpsPerSide, row.entrySlippageBps, row.exitSlippageBps,
      row.fundingBpsPerHour, row.borrowingBpsPerHour, row.impactBps].every(Number.isFinite)
      || row.feeBpsPerSide < 0 || row.entrySlippageBps < 0 || row.exitSlippageBps < 0
       || row.fundingBpsPerHour < 0 || row.borrowingBpsPerHour < 0 || row.impactBps < 0
       || !Number.isFinite(row.validFromMs) || !Number.isFinite(row.validUntilMs)
       || row.validFromMs! > row.observedAtMs || row.validUntilMs! <= row.validFromMs!) {
      issues.push(`historical cost/funding evidence INVALID: ${String(row.observedAtMs)}`);
      break;
    }
  }
  const first = dataset.candles['15m'][0]?.t ?? null;
  const last = dataset.candles['15m'].at(-1);
  const lastClose = last ? last.t + STEPS['15m'] : null;
  if (dataset.provenance.period.fromMs !== first || dataset.provenance.period.toMs !== lastClose) {
    issues.push('provenance 기간과 15m evidence 기간 불일치');
  }
  if (issues.length > 0) {
    return {
      status: 'UNAVAILABLE', generatedAtMs: input.generatedAtMs,
      provenance: dataset.provenance, evidence, issues, walkForward: null,
      autoPromotionAllowed: false, liveExecutionAuthorized: false,
    };
  }
  const latestAt = <T extends { observedAtMs: number }>(rows: readonly T[], at: number): T | null => {
    let latest: T | null = null;
    for (const row of rows) {
      if (row.observedAtMs <= at && (latest === null || row.observedAtMs > latest.observedAtMs)) latest = row;
    }
    return latest;
  };
  const closedLookback = (
    rows: readonly Candle[],
    timeframe: OfflineBtcTimeframe,
    closeTime: number,
  ): Candle[] => {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].t + STEPS[timeframe] <= closeTime) low = middle + 1;
      else high = middle;
    }
    return rows.slice(Math.max(0, low - 240), low);
  };
  const firstReplayClose = dataset.candles['4h'][59].t + STEPS['4h'];
  // Always replay from the complete immutable series.  A ranged response only
  // filters the already warmed-up decisions, so hysteresis at a timestamp is
  // independent of the caller's requested start date.
  const replayDataset = input.dataset;
  const selectedCloseTimes = new Set(dataset.candles['15m'].map(candle => candle.t + STEPS['15m']));
  let previousRegime: import('./regimeEngineV2').RegimeState | null = null;
  const decisions = replayDataset.candles['15m']
    .filter(candle => candle.t + STEPS['15m'] >= firstReplayClose)
    .map(candle => {
    const closeTime = candle.t + STEPS['15m'];
    const frames = Object.fromEntries((['15m', '1h', '4h'] as const).map(timeframe => [
      timeframe,
      {
        symbol: 'BTC',
        timeframe,
         source: replayDataset.provenance.source,
        fetchedAtMs: closeTime + 2_000,
         candles: closedLookback(replayDataset.candles[timeframe], timeframe, closeTime),
      },
    ])) as Parameters<typeof replayOfflineDecision>[0]['frames'];
     const decision = replayOfflineDecision({
      evaluatedAtMs: closeTime + 2_000,
      frames,
       costEvidence: latestAt(replayDataset.costs, closeTime),
       riskEvidence: latestAt(replayDataset.risks, closeTime),
       previousRegime,
      profile: 'conservative',
     });
     previousRegime = decision.regimeState ?? previousRegime;
     return {
       ...decision,
       costCoverage: replayDataset.costs.filter(row => row.validUntilMs! > closeTime
         && row.validFromMs! < closeTime + (16 * STEPS['15m'])),
     };
     }).filter(decision => selectedCloseTimes.has(decision.sourceCandleCloseTime));
  const walkForward = runOfflineWalkForwardBacktest({
    symbol: 'BTC',
    source: `${dataset.provenance.datasetId}@${dataset.provenance.checksums['15m']}`,
    generatedAtMs: input.generatedAtMs,
    candles15m: dataset.candles['15m'],
    decisions,
    config: input.config ?? DEFAULT_OFFLINE_WALK_FORWARD_CONFIG,
    maxFolds: input.maxFolds,
  });
  return {
    status: walkForward.status,
    generatedAtMs: input.generatedAtMs,
    provenance: dataset.provenance,
    evidence,
    issues: walkForward.issues,
    walkForward,
    autoPromotionAllowed: false,
    liveExecutionAuthorized: false,
  };
}

export const OFFLINE_BTC_DEFAULT_CONFIG = DEFAULT_OFFLINE_WALK_FORWARD_CONFIG;