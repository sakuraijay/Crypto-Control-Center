/**
 * Immutable Binance REST captures.  The final kline returned by each Spot
 * request was deliberately removed: it was still open at retrieval.
 */
import candles15Raw from './btc15m.binance-spot.json';
import candles1hRaw from './btc1h.binance-spot.json';
import candles4hRaw from './btc4h.binance-spot.json';
import fundingRaw from './btc-funding.binance-futures.json';
import type { Candle } from '../types';
import type { OfflineBtcDataset } from '../offlineBtcReportBuilderV2';
import type { OfflineHistoricalCostEvidence } from '../offlineWalkForwardBacktestV2';
import type { OfflineRiskEvidence } from '../offlineDecisionReplayV2';
import { createHash } from 'node:crypto';

const RETRIEVED_AT_MS = 1787796612151; // 2026-08-27T02:10:12.151Z

type BinanceKline = [number, string, string, string, string, string, ...unknown[]];
const asCandles = (rows: unknown): Candle[] => (rows as BinanceKline[]).map(row => ({
  t: row[0], o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]),
}));
const candles15m = asCandles(candles15Raw);
const candles1h = asCandles(candles1hRaw);
const candles4h = asCandles(candles4hRaw);
const funding = fundingRaw as Array<{ fundingTime: number; fundingRate: string }>;

const fundingAt = (time: number): number | null => {
  let rate: number | null = null;
  for (const row of funding) {
    if (row.fundingTime > time) break;
    rate = Math.abs(Number(row.fundingRate)) * 10_000 / 8; // rebates are never credited
  }
  return rate;
};
const costs: OfflineHistoricalCostEvidence[] = candles15m.flatMap(candle => {
  const fundingBpsPerHour = fundingAt(candle.t + 15 * 60 * 1_000);
  if (fundingBpsPerHour === null) return [];
  const rangeBps = (candle.h - candle.l) / candle.c * 10_000;
  // Conservative closed-candle proxy: five percent of realized range per
  // side, with a 1bp floor; impact is an additional 2.5% range per side.
  return [{
    observedAtMs: candle.t + 15 * 60 * 1_000,
    validFromMs: candle.t + 15 * 60 * 1_000,
    validUntilMs: candle.t + 30 * 60 * 1_000,
    feeBpsPerSide: 5,
    entrySlippageBps: Math.max(1, rangeBps * 0.05),
    exitSlippageBps: Math.max(1, rangeBps * 0.05),
    fundingBpsPerHour,
    borrowingBpsPerHour: 0, // Binance perpetual funding is not spot-margin borrowing.
    impactBps: Math.max(0.5, rangeBps * 0.025),
  }];
});
const risks: OfflineRiskEvidence[] = costs.map(row => ({
  observedAtMs: row.observedAtMs,
  dailyRiskCapitalUsd: 1_000, weeklyRiskCapitalUsd: 1_000, currentEquityUsd: 1_000,
  dailyRealizedNetPnlUsd: 0, dailyLossAwareNetPnlUsd: 0, estimatedExitNetPnlUsd: 0,
  weeklyRealizedNetPnlUsd: 0, dailyEntryCount: 0, consecutiveLossCount: 0, openPositionCount: 0,
  persistenceEvidenceOk: true, marketDataFresh: true,
}));
/** Deliberately mirrors the report's canonical JSON section checksum. */
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const OFFLINE_BTC_BINANCE_DATASET: OfflineBtcDataset = {
  schemaVersion: 'offline-btc-dataset/v1',
  provenance: {
    datasetId: 'binance-btcusdt-spot-perpetual-2026-08-27',
    source: 'Binance Spot REST /api/v3/klines (BTCUSDT, 15m/1h/4h); Binance USDⓈ-M Futures REST /fapi/v1/fundingRate (BTCUSDT)',
    license: null, immutable: true, checksumAlgorithm: 'SHA-256',
    artifactChecksums: {
      '15m': '09ff1a6070137a78a90053f73e0b311907f36442c7d89f7187818c27be5587f0',
      '1h': '3fe80765ced270ce0cf54e0ddc40a723d00b93c957d9f37d1f3baf7568b64b98',
      '4h': 'f550a86107531cfeed89058061a058c24fc8806895dd70fc1e9aea9599c27a97',
      funding: '6b4219597b85ee51a7b0601ba1399b2775a4ca1356fe3db48c459376fad9b9a8',
    },
    costEvidenceKind: 'MODELED',
    riskEvidenceKind: 'ASSUMED',
    checksums: {
      '15m': hash(candles15m), '1h': hash(candles1h), '4h': hash(candles4h),
      costs: hash(costs), risk: hash(risks),
    },
    period: { fromMs: candles15m[0]!.t, toMs: candles15m.at(-1)!.t + 15 * 60 * 1_000 },
    retrievedAtMs: RETRIEVED_AT_MS,
    methodology: 'Spot OHLCV base volume (field 5); final unclosed klines excluded. Funding is historical as-of abs(rate)*10000/8 bps/hour, so negative funding never becomes a rebate. Taker fee is frozen at 5 bps/side. Slippage and impact derive only from each closed 15m high-low range (5% and 2.5%, respectively, with 1bp/0.5bp floors). Borrowing is zero because Binance perpetual funding is not a separate borrowing charge.',
  },
  candles: { '15m': candles15m, '1h': candles1h, '4h': candles4h },
  costs, risks,
};