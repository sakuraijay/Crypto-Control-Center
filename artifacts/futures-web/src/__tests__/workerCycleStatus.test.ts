/**
 * workerCycleStatus — READ-ONLY 연결 검증 AI Worker 판정 (#설정 화면).
 * workerRunning(사이클 순간 lock)이 아니라 schedulerHeartbeatAt 최근성 5분 + cycleCount 기준.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyWorkerCycleStatus, WORKER_ACTIVE_WINDOW_MS, WORKER_CYCLE_STATUS_LABEL,
} from '../lib/workerCycleStatus';

const NOW = Date.parse('2026-08-18T22:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('classifyWorkerCycleStatus', () => {
  it('최근 5분 내 사이클 + cycleCount>0 → active (workerRunning=false여도)', () => {
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(51_000), cycleCount: 14, nowMs: NOW })).toBe('active');
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(WORKER_ACTIVE_WINDOW_MS), cycleCount: 1, nowMs: NOW })).toBe('active');
  });

  it('5분 초과 경과 → stale', () => {
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(WORKER_ACTIVE_WINDOW_MS + 1_000), cycleCount: 99, nowMs: NOW })).toBe('stale');
  });

  it('사이클 기록 없음/파싱 불가 → unknown (가짜 중단됨 판정 금지)', () => {
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: null, cycleCount: 0, nowMs: NOW })).toBe('unknown');
    expect(classifyWorkerCycleStatus({ nowMs: NOW })).toBe('unknown');
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: 'not-a-date', cycleCount: 3, nowMs: NOW })).toBe('unknown');
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: '', cycleCount: 3, nowMs: NOW })).toBe('unknown');
  });

  it('최근이지만 cycleCount=0 → stale (사이클 완료 실적 없음)', () => {
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(1_000), cycleCount: 0, nowMs: NOW })).toBe('stale');
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(1_000), nowMs: NOW })).toBe('stale');
  });

  it('미래 타임스탬프(시계 오차 60s 초과) → unknown (false liveness 금지)', () => {
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(-120_000), cycleCount: 5, nowMs: NOW })).toBe('unknown');
    // 60s 이내 오차는 허용
    expect(classifyWorkerCycleStatus({ schedulerHeartbeatAt: iso(-30_000), cycleCount: 5, nowMs: NOW })).toBe('active');
  });

  it('새 decision이 오래됐어도 fresh heartbeat면 duplicate-skip scheduler는 active다', () => {
    expect(classifyWorkerCycleStatus({
      schedulerHeartbeatAt: iso(15_000),
      cycleCount: 120,
      nowMs: NOW,
    })).toBe('active');
  });

  it('라벨에 중단됨 오표시 없음', () => {
    expect(Object.values(WORKER_CYCLE_STATUS_LABEL).join(' ')).not.toContain('중단됨');
  });
});
