/**
 * riskEngineState — Manila 기준 RiskEngine 영속 상태 (6H-1 §11).
 *
 * worker_state key-value 테이블에 JSON으로 영속화 (기존 HWM/기준점과 동일 패턴,
 * 추가 migration 불필요 — worker_state는 migration 0007부터 존재).
 *
 * 원칙:
 *  - DB 저장 실패 시 메모리 상태만으로 거래 계속 금지 → 호출측 진입 차단
 *  - 재시작 후 모든 잠금·카운터·기준점 복구
 *  - 일일 reset은 daily 필드만; weekly lock은 Manila 월요일에만;
 *    hardStop·UNRESOLVED는 날짜 변경으로 해제 금지
 */

import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { manilaDayStartIso, manilaWeekStartIso } from './manilaTime';
import {
  EMPTY_LOCKS, resetDailyLocks, resetWeeklyLocks,
  type PersistedLocks, type RiskOperatingState,
} from './riskStateMachine';

export const RISK_ENGINE_STATE_KEY = 'riskEngineStateV1';

export interface PersistedRiskEngineState {
  /** Manila 거래일 시작 (UTC ISO) */
  dayPeriodStart: string;
  /** Manila 거래주 시작 (UTC ISO) */
  weekPeriodStart: string;
  startOfDayEquityUsd: number;
  startOfWeekEquityUsd: number;
  dailyRealizedNetPnlUsd: number;
  dailyLossAwareNetPnlUsd: number;
  weeklyRealizedNetPnlUsd: number;
  dailyEntryCount: number;
  consecutiveLossCount: number;
  riskOperatingState: RiskOperatingState;
  locks: PersistedLocks;
  lastUpdatedAt: string;
}

export function initialRiskEngineState(now: Date, equityUsd: number): PersistedRiskEngineState {
  return {
    dayPeriodStart: manilaDayStartIso(now),
    weekPeriodStart: manilaWeekStartIso(now),
    startOfDayEquityUsd: equityUsd,
    startOfWeekEquityUsd: equityUsd,
    dailyRealizedNetPnlUsd: 0,
    dailyLossAwareNetPnlUsd: 0,
    weeklyRealizedNetPnlUsd: 0,
    dailyEntryCount: 0,
    consecutiveLossCount: 0,
    riskOperatingState: 'NORMAL',
    locks: { ...EMPTY_LOCKS },
    lastUpdatedAt: now.toISOString(),
  };
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 저장 JSON 파싱 — 손상/결측 시 null (fail-closed, 호출측이 재수립·진입 차단 결정) */
export function parseRiskEngineState(raw: string | null | undefined): PersistedRiskEngineState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PersistedRiskEngineState>;
    if (typeof v.dayPeriodStart !== 'string' || typeof v.weekPeriodStart !== 'string') return null;
    if (!isFiniteNum(v.startOfDayEquityUsd) || !isFiniteNum(v.startOfWeekEquityUsd)) return null;
    if (!isFiniteNum(v.dailyEntryCount) || !isFiniteNum(v.consecutiveLossCount)) return null;
    if (typeof v.riskOperatingState !== 'string') return null;
    const locks = v.locks && typeof v.locks === 'object' ? { ...EMPTY_LOCKS, ...v.locks } : { ...EMPTY_LOCKS };
    return {
      dayPeriodStart: v.dayPeriodStart,
      weekPeriodStart: v.weekPeriodStart,
      startOfDayEquityUsd: v.startOfDayEquityUsd,
      startOfWeekEquityUsd: v.startOfWeekEquityUsd,
      dailyRealizedNetPnlUsd: isFiniteNum(v.dailyRealizedNetPnlUsd) ? v.dailyRealizedNetPnlUsd : 0,
      dailyLossAwareNetPnlUsd: isFiniteNum(v.dailyLossAwareNetPnlUsd) ? v.dailyLossAwareNetPnlUsd : 0,
      weeklyRealizedNetPnlUsd: isFiniteNum(v.weeklyRealizedNetPnlUsd) ? v.weeklyRealizedNetPnlUsd : 0,
      dailyEntryCount: v.dailyEntryCount,
      consecutiveLossCount: v.consecutiveLossCount,
      riskOperatingState: v.riskOperatingState as RiskOperatingState,
      locks,
      lastUpdatedAt: typeof v.lastUpdatedAt === 'string' ? v.lastUpdatedAt : v.dayPeriodStart,
    };
  } catch {
    return null;
  }
}

export interface PeriodRollResult {
  state: PersistedRiskEngineState;
  rolledDay: boolean;
  rolledWeek: boolean;
}

/**
 * Manila 기간 롤오버.
 *  - 새 거래일: daily PnL·카운터·daily 잠금 reset, startOfDayEquity = 현재 equity
 *  - 새 거래주: weekly PnL·weekly 잠금 reset, startOfWeekEquity = 현재 equity
 *  - hardStop·UNRESOLVED는 어느 롤오버로도 해제되지 않음
 */
export function rollRiskPeriods(
  state: PersistedRiskEngineState,
  now: Date,
  currentEquityUsd: number,
): PeriodRollResult {
  const dayStart = manilaDayStartIso(now);
  const weekStart = manilaWeekStartIso(now);
  let next = state;
  let rolledDay = false;
  let rolledWeek = false;

  if (state.weekPeriodStart !== weekStart) {
    rolledWeek = true;
    next = {
      ...next,
      weekPeriodStart: weekStart,
      startOfWeekEquityUsd: currentEquityUsd,
      weeklyRealizedNetPnlUsd: 0,
      locks: resetWeeklyLocks(next.locks),
    };
  }
  if (state.dayPeriodStart !== dayStart) {
    rolledDay = true;
    next = {
      ...next,
      dayPeriodStart: dayStart,
      startOfDayEquityUsd: currentEquityUsd,
      dailyRealizedNetPnlUsd: 0,
      dailyLossAwareNetPnlUsd: 0,
      dailyEntryCount: 0,
      consecutiveLossCount: 0,
      locks: resetDailyLocks(next.locks),
    };
  }
  if (rolledDay || rolledWeek) {
    next = { ...next, lastUpdatedAt: now.toISOString() };
  }
  return { state: next, rolledDay, rolledWeek };
}

// ── DB persistence (worker_state) ─────────────────────────────────────────────

/** DB에서 로드 — 실패 시 { ok:false } (호출측 진입 차단) */
export async function loadRiskEngineState(): Promise<
  { ok: true; state: PersistedRiskEngineState | null } | { ok: false; reason: string }
> {
  try {
    const rows = await db.select().from(workerStateTable)
      .where(eq(workerStateTable.key, RISK_ENGINE_STATE_KEY)).limit(1);
    return { ok: true, state: parseRiskEngineState(rows[0]?.value ?? null) };
  } catch (err) {
    return { ok: false, reason: `RiskEngine 상태 로드 실패: ${(err as Error).message}` };
  }
}

/** DB 저장 — 실패 시 { ok:false } — 호출측은 다음 진입을 차단해야 한다 */
export async function saveRiskEngineState(state: PersistedRiskEngineState): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    const value = JSON.stringify(state);
    await db.insert(workerStateTable)
      .values({ key: RISK_ENGINE_STATE_KEY, value })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value } });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `RiskEngine 상태 저장 실패: ${(err as Error).message}` };
  }
}
