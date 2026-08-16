/**
 * equityBaselines — 기간 시작 equity 기준점 기반 Daily/Weekly PnL.
 *
 * 문제: 기존 "Daily PnL = 오늘 실현 + 열린 포지션 전체 미실현" 공식은
 * 전날부터 보유한 포지션의 기존 미실현 수익을 오늘 수익으로 중복 계산한다.
 *
 * 해결: 기간 PnL = 현재 equity − 기간 시작 시점 equity.
 *   - Daily  기준점: 매일 00:00 UTC
 *   - Weekly 기준점: 월요일 00:00 UTC (서버 기존 관례와 동일)
 *
 * 기준점은 worker_state key-value 테이블에 JSON으로 영속화되어
 * 서버 재시작 후에도 유지된다. 기준점이 없으면 PnL은 null(N/A) —
 * 가짜 0이나 전체 미실현 대체 금지.
 *
 * 주의: 기간이 바뀐 뒤 첫 관측 시점에 기준점이 갱신되므로, 그 사이클의
 * 기준 equity는 "기간 시작 이후 첫 관측 equity"다 (사이클 주기 60s 이내 오차).
 */

export interface EquityBaseline {
  /** 기간 시작 시각 (ISO, UTC) — 이 값이 현재 기간과 다르면 롤오버 */
  periodStart: string;
  /** 기간 시작(첫 관측) 시점의 equity (USD) */
  equity: number;
  /** 기준점이 실제 기록된 시각 (ISO) — 지연 관측 판단용 */
  recordedAt: string;
}

export const BASELINE_DAILY_KEY  = 'equityBaselineDaily';
export const BASELINE_WEEKLY_KEY = 'equityBaselineWeekly';

/** 오늘 00:00 UTC (ISO) */
export function dailyPeriodStartUtc(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

/** 이번 주 월요일 00:00 UTC (ISO) — 서버 weekly 관례와 동일 */
export function weeklyPeriodStartUtc(now: Date): string {
  const day = now.getUTCDay();            // 0=Sun … 6=Sat
  const sinceMonday = (day + 6) % 7;      // Mon→0, Sun→6
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday));
  return d.toISOString();
}

/** worker_state에 저장된 JSON 문자열을 파싱. 손상 시 null (fail-closed → 재수립) */
export function parseBaseline(raw: string | null | undefined): EquityBaseline | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EquityBaseline>;
    if (typeof v.periodStart !== 'string' || typeof v.equity !== 'number' || !isFinite(v.equity)) return null;
    return { periodStart: v.periodStart, equity: v.equity, recordedAt: typeof v.recordedAt === 'string' ? v.recordedAt : v.periodStart };
  } catch {
    return null;
  }
}

export interface RollResult {
  baseline: EquityBaseline;
  /** true면 새 기간으로 롤오버되어 저장이 필요함 */
  changed: boolean;
}

/**
 * 기준점 롤오버: 저장된 기준점이 현재 기간과 일치하면 그대로 사용,
 * 없거나 기간이 다르면 현재 equity로 새 기준점을 만든다.
 */
export function rollBaseline(
  existing: EquityBaseline | null,
  periodStart: string,
  currentEquity: number,
  now: Date,
): RollResult {
  if (existing && existing.periodStart === periodStart) {
    return { baseline: existing, changed: false };
  }
  return {
    baseline: { periodStart, equity: currentEquity, recordedAt: now.toISOString() },
    changed: true,
  };
}

/**
 * 기간 PnL = 현재 equity − 기준점 equity. 기준점 없으면 null (N/A — 가짜 0 금지).
 */
export function computePeriodPnl(currentEquity: number, baseline: EquityBaseline | null): number | null {
  if (baseline === null || !isFinite(currentEquity)) return null;
  return currentEquity - baseline.equity;
}
