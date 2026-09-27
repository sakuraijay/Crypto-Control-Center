/**
 * manilaTime — Asia/Manila 거래일/거래주 기준점 (6H-1 §11).
 *
 * Manila는 UTC+8 고정 (DST 없음 — 테스트로 고정하되 로컬 시스템 timezone에
 * 의존하지 않고 항상 고정 오프셋으로 계산한다).
 *
 *  - Daily  기간 시작: 매일 00:00 Asia/Manila = 전날 16:00 UTC
 *  - Weekly 기간 시작: 월요일 00:00 Asia/Manila
 *
 * 반환 값은 UTC ISO 문자열 — 저장/비교의 canonical 표현.
 */

/** Manila 고정 오프셋 (UTC+8, DST 없음) */
export const MANILA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

export const MANILA_TIMEZONE = 'Asia/Manila';

/** 현재 Manila 거래일 시작 (Manila 00:00) — UTC ISO */
export function manilaDayStartIso(now: Date): string {
  const shifted = new Date(now.getTime() + MANILA_UTC_OFFSET_MS);
  const dayStartShifted = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  );
  return new Date(dayStartShifted - MANILA_UTC_OFFSET_MS).toISOString();
}

/** 현재 Manila 거래주 시작 (월요일 00:00 Manila) — UTC ISO */
export function manilaWeekStartIso(now: Date): string {
  const shifted = new Date(now.getTime() + MANILA_UTC_OFFSET_MS);
  const dow = shifted.getUTCDay();          // 0=Sun … 6=Sat (Manila 기준 요일)
  const sinceMonday = (dow + 6) % 7;        // Mon→0, Sun→6
  const dayStartShifted = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - sinceMonday,
  );
  return new Date(dayStartShifted - MANILA_UTC_OFFSET_MS).toISOString();
}

/** 다음 Manila 거래일 시작까지 남은 ms (UI 카운트다운용) */
export function msUntilNextManilaDay(now: Date): number {
  const currentStart = new Date(manilaDayStartIso(now)).getTime();
  const nextStart = currentStart + 24 * 60 * 60 * 1000;
  return Math.max(0, nextStart - now.getTime());
}

/** timestamp(ms)가 현재 Manila 거래일에 속하는지 */
export function isInCurrentManilaDay(timestampMs: number, now: Date): boolean {
  return timestampMs >= new Date(manilaDayStartIso(now)).getTime()
    && timestampMs <= now.getTime();
}

/** timestamp(ms)가 현재 Manila 거래주에 속하는지 */
export function isInCurrentManilaWeek(timestampMs: number, now: Date): boolean {
  return timestampMs >= new Date(manilaWeekStartIso(now)).getTime()
    && timestampMs <= now.getTime();
}
