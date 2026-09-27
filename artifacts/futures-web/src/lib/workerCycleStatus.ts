/**
 * workerCycleStatus — READ-ONLY 연결 검증용 AI Worker 상태 분류.
 *
 * `workerRunning`은 liveness가 아니라 "사이클 실행 중" 순간 lock 지표라
 * (사이클 사이 유휴 시간엔 항상 false) 판정 기준으로 쓰면 안 된다.
 * 대신 schedulerHeartbeatAt 최근성(5분)과 cycleCount로 판정한다.
 */

export const WORKER_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
/** 허용 시계 오차 — 이보다 미래인 schedulerHeartbeatAt은 신뢰 불가(unknown) */
export const WORKER_CLOCK_SKEW_MS = 60 * 1000;

export type WorkerCycleStatus = 'active' | 'stale' | 'unknown';

export function classifyWorkerCycleStatus(input: {
  schedulerHeartbeatAt?: string | null;
  cycleCount?: number;
  nowMs?: number;
}): WorkerCycleStatus {
  const { schedulerHeartbeatAt, cycleCount } = input;
  if (schedulerHeartbeatAt === undefined || schedulerHeartbeatAt === null || schedulerHeartbeatAt === '') return 'unknown';
  const t = Date.parse(schedulerHeartbeatAt);
  if (!Number.isFinite(t)) return 'unknown';
  const now = input.nowMs ?? Date.now();
  // 미래 타임스탬프는 신뢰하지 않는다 (시계 오차 60s 허용) — false liveness 방지
  const elapsed = now - t;
  if (elapsed < -WORKER_CLOCK_SKEW_MS) return 'unknown';
  const recent = elapsed <= WORKER_ACTIVE_WINDOW_MS;
  const hasCycles = typeof cycleCount === 'number' && Number.isFinite(cycleCount) && cycleCount > 0;
  if (recent && hasCycles) return 'active';
  return 'stale';
}

export const WORKER_CYCLE_STATUS_LABEL: Record<WorkerCycleStatus, string> = {
  active: '동작 중 (최근 5분 내 사이클)',
  stale: '지연 — 최근 5분 내 사이클 없음',
  unknown: '확인 불가 (사이클 기록 없음)',
};
