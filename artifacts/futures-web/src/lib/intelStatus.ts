/**
 * 6I-1 §15 — Market Intelligence read-only 조회 헬퍼.
 * 조회 실패 = Unavailable (가짜 0/NORMAL 렌더 금지).
 */
import { apiUrl } from '@/lib/apiUrl';

export interface IntelRegimeRow {
  market: string;
  regime: string;
  strength: number;
  dataQuality: string;
  basis: string;
  tradeAllowed: boolean;
}

export interface IntelStatus {
  available: boolean;
  reason?: string;
  cycleId?: string;
  at?: string;
  universeCount?: number;
  shortlistCount?: number;
  shortlistSymbols?: string[];
  degraded?: boolean;
  degradedReason?: string | null;
  dataQuality?: string;
  decision?: string;
  blockedReason?: string | null;
  noTradeReasons?: string[];
  regimes?: IntelRegimeRow[];
  cycleCount?: number;
  noTradeCycles?: number;
  lastError?: string | null;
}

export interface OpportunityRow {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  regime: string;
  dataQuality: string;
  rawSignalScore: number;
  winProbability: number | null;
  calibrationStatus: string;
  expectedNetValueUsd: number | null;
  expectedRMultiple: number | null;
  uncalibratedRankingScore: number | null;
  rank: number | null;
  selected: boolean;
  decision: string;
  rejectionReasons: string[];
}

export interface OpportunitiesLatest {
  available: boolean;
  reason?: string;
  cycleId?: string;
  decision?: string;
  noTradeReasons?: string[];
  candidates: OpportunityRow[];
}

export type ShadowMetricsResponse =
  | { status: 'INSUFFICIENT_SAMPLE'; sampleCount: number; required: number; autoPromotionAllowed: false }
  | ({ status: 'OK'; sampleCount: number; autoPromotionAllowed: false } & Record<string, unknown>);

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchIntelStatus = () => getJson<IntelStatus>('market-intelligence/status');
export const fetchOpportunitiesLatest = () => getJson<OpportunitiesLatest>('opportunities/latest');
export const fetchShadowMetrics = () => getJson<ShadowMetricsResponse>('shadow/metrics');

/** §7·§15 — 보정 확률 표시 규칙: null=미보정 문구, 절대 %로 위장 금지 */
export function formatWinProbability(p: number | null, calibrationStatus: string): string {
  if (p === null || calibrationStatus !== 'CALIBRATED') return '미보정 (표본 부족)';
  return `${(p * 100).toFixed(1)}%`;
}

/** 순기대값 표시 — null=산출 불가 (0으로 위장 금지) */
export function formatExpectedNetValue(v: number | null): string {
  if (v === null) return '산출 불가';
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

/** §15 필수 고지 문구 */
export const INTEL_NOTICE_MONITORING = '24시간 감시 중 — 거래 기회가 없으면 NO_TRADE가 정상입니다';
export const INTEL_NOTICE_NO_GUARANTEE = '예상값은 수익 보장이 아닙니다';
export const INTEL_NOTICE_SHADOW = '현재 전략은 PAPER/SHADOW 검증 중이며 자동 LIVE 승격되지 않습니다';
