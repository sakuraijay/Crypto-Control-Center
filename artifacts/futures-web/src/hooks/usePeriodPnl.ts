/**
 * usePeriodPnl — 서버 equity 기준점 기반 Daily/Weekly PnL 폴링 훅
 *
 * 서버(AI Worker)는 매 사이클마다
 *   Daily PnL  = 현재 equity − 오늘 00:00 UTC 기준점 equity
 *   Weekly PnL = 현재 equity − 월요일 00:00 UTC 기준점 equity
 * 를 계산하고, 기준점을 worker_state에 영속화한다 (재시작 유지).
 *
 * 표시 규칙 (mock/가짜 0 금지):
 *   - API 오류/오프라인       → status 'unavailable' → "Unavailable"
 *   - 기준점 미수립(null PnL)  → status 'na'          → "N/A"
 *   - 정상                    → status 'ok'
 */
import { useState, useEffect, useCallback } from 'react';

export interface PeriodPnlBaseline {
  periodStart: string;
  equity: number;
  recordedAt: string;
}

export interface PeriodPnlData {
  dailyPnlUsd: number | null;
  weeklyPnlUsd: number | null;
  dailyBaseline: PeriodPnlBaseline | null;
  weeklyBaseline: PeriodPnlBaseline | null;
  dailyRealizedPnlUsd: number | null;
  weeklyRealizedPnlUsd: number | null;
  currentEquityUsd: number | null;
}

export type PeriodPnlStatus = 'loading' | 'ok' | 'na' | 'unavailable';

export interface PeriodPnlState {
  status: PeriodPnlStatus;
  data: PeriodPnlData | null;
}

/** 서버 응답 → 표시 상태 도출 (순수 함수 — 테스트 대상) */
export function derivePeriodPnlStatus(
  fetchOk: boolean,
  data: PeriodPnlData | null,
): PeriodPnlStatus {
  if (!fetchOk || data === null) return 'unavailable';
  // 기준점 미수립(워커 미가동·첫 사이클 전·DB 실패) → N/A. 가짜 0 표시 금지.
  if (data.dailyPnlUsd === null && data.weeklyPnlUsd === null) return 'na';
  return 'ok';
}

/** PnL 값 포맷 — null이면 상태에 따라 N/A/Unavailable */
export function formatPeriodPnl(value: number | null, status: PeriodPnlStatus): string {
  if (status === 'loading') return '…';
  if (status === 'unavailable') return 'Unavailable';
  if (value === null) return 'N/A';
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

const POLL_MS = 30_000;

export function usePeriodPnl(): PeriodPnlState {
  const [state, setState] = useState<PeriodPnlState>({ status: 'loading', data: null });

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/executor/status', { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) { setState(s => ({ status: 'unavailable', data: s.data })); return; }
      const body = await res.json() as Record<string, unknown>;
      // 필드 부재(구버전 서버) → unavailable (0으로 추정 금지)
      if (!('dailyPnlUsd' in body) || !('weeklyPnlUsd' in body)) {
        setState({ status: 'unavailable', data: null });
        return;
      }
      const data: PeriodPnlData = {
        dailyPnlUsd:          (body.dailyPnlUsd          as number | null) ?? null,
        weeklyPnlUsd:         (body.weeklyPnlUsd         as number | null) ?? null,
        dailyBaseline:        (body.dailyBaseline        as PeriodPnlBaseline | null) ?? null,
        weeklyBaseline:       (body.weeklyBaseline       as PeriodPnlBaseline | null) ?? null,
        dailyRealizedPnlUsd:  (body.dailyRealizedPnlUsd  as number | null) ?? null,
        weeklyRealizedPnlUsd: (body.weeklyRealizedPnlUsd as number | null) ?? null,
        currentEquityUsd:     (body.currentEquityUsd     as number | null) ?? null,
      };
      setState({ status: derivePeriodPnlStatus(true, data), data });
    } catch {
      setState(s => ({ status: 'unavailable', data: s.data }));
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  return state;
}
