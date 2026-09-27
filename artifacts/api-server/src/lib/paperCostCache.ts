/**
 * paperCostCache — 최신 검증된 PAPER_GMX_ESTIMATE 스냅샷의 심볼별 캐시 (6H-2A §3).
 *
 * Worker가 사이징 시 확보한 스냅샷을 저장하고, 브라우저가 PAPER 거래를 POST할 때
 * data.ts가 진입/청산 추정비용과 rate를 거래 행에 결속하는 데 사용한다.
 *
 * 원칙:
 *  - stale 스냅샷은 결속 금지 (fallback 아님 — 없으면 비용 필드 null = 비용 불명)
 *  - 비용 불명 거래의 "이익"은 목표 산정에 반영되지 않는다 (aiWorker가 강제)
 */
import type { CostSnapshot } from './costSnapshot';

/** 거래 결속용 최대 허용 나이 — 사이클(60s)·전송 지연 감안 10분 */
export const PAPER_COST_BINDING_MAX_AGE_MS = 10 * 60_000;

interface CacheEntry { snapshot: CostSnapshot; storedAtMs: number }

const cache = new Map<string, CacheEntry>();

export function storePaperCostSnapshot(symbol: string, snapshot: CostSnapshot, nowMs = Date.now()): void {
  if (snapshot.source !== 'PAPER_GMX_ESTIMATE') return; // LIVE 스냅샷 혼입 금지
  cache.set(symbol.toUpperCase(), { snapshot, storedAtMs: nowMs });
}

export interface PaperTradeCostBinding {
  costSource: 'PAPER_GMX_ESTIMATE';
  /** 진입 비용 = position fee + 실행비 1/2 + 불리한 entry impact */
  estEntryCostUsd: number;
  /** 청산 비용 = exit fee + 실행비 1/2 + 불리한 exit impact */
  estExitCostUsd: number;
  fundingRatePerHourFraction: number | null;
  borrowingRatePerHourFraction: number | null;
  costFetchedAt: string;
}

/** 거래 삽입 시점의 비용 결속 — 신선한 스냅샷이 없으면 null (0 대체 금지) */
export function getPaperCostBinding(symbol: string, nowMs = Date.now()): PaperTradeCostBinding | null {
  const e = cache.get(symbol.toUpperCase());
  if (!e) return null;
  if (nowMs - e.storedAtMs > PAPER_COST_BINDING_MAX_AGE_MS) return null;
  const s = e.snapshot;
  return {
    costSource: 'PAPER_GMX_ESTIMATE',
    estEntryCostUsd: s.positionFeeUsd + s.executionFeeUsd / 2 + Math.max(s.estimatedPriceImpactUsd, 0),
    estExitCostUsd: s.estimatedExitFeeUsd + s.executionFeeUsd / 2 + Math.max(s.estimatedExitPriceImpactUsd, 0),
    fundingRatePerHourFraction: s.fundingRatePerHourFraction,
    borrowingRatePerHourFraction: s.borrowingRatePerHourFraction,
    costFetchedAt: s.fetchedAt,
  };
}

export function __clearPaperCostCacheForTests(): void {
  cache.clear();
}
