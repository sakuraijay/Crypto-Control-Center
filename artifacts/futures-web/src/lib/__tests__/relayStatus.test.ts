/**
 * relayStatus 헬퍼 테스트 — 3단계 UI 계약.
 * 핵심: DRY_RUN_VALIDATED·TASK_ACCEPTED를 성공(ok)으로 표시하지 않는다.
 */

import { describe, it, expect } from 'vitest';
import { mapRelayModeToView, mapRelayTaskStatusToView, formatWeiToEth } from '../relayStatus';

describe('mapRelayModeToView', () => {
  it('DRY_RUN은 경고 톤(성공 아님)', () => {
    expect(mapRelayModeToView('DRY_RUN').tone).toBe('warn');
  });
  it('DISABLED는 muted', () => {
    expect(mapRelayModeToView('DISABLED').tone).toBe('muted');
  });
  it('LIVE는 오류로 표시(이번 단계에서 존재 불가)', () => {
    const v = mapRelayModeToView('LIVE');
    expect(v.tone).toBe('error');
  });
});

describe('mapRelayTaskStatusToView — 성공 표시 계약', () => {
  it('CONFIRMED만 ok 톤', () => {
    const okStatuses = Object.entries({
      PREPARED: 0, DRY_RUN_VALIDATED: 0, SUBMITTING: 0, TASK_ACCEPTED: 0,
      TX_SUBMITTED: 0, ORDER_CREATED: 0, CONFIRMED: 1, CANCELLED: 0,
      FAILED_PRE_BROADCAST: 0, UNRESOLVED: 0,
    }).filter(([s]) => mapRelayTaskStatusToView(s).tone === 'ok').map(([s]) => s);
    expect(okStatuses).toEqual(['CONFIRMED']);
  });
  it('DRY_RUN_VALIDATED·TASK_ACCEPTED 라벨은 성공이 아님을 명시', () => {
    expect(mapRelayTaskStatusToView('DRY_RUN_VALIDATED').label).toContain('제출 아님');
    expect(mapRelayTaskStatusToView('TASK_ACCEPTED').label).toContain('성공 아님');
  });
  it('UNRESOLVED는 수동 확인 필요 표시', () => {
    expect(mapRelayTaskStatusToView('UNRESOLVED').label).toContain('수동');
  });
  it('알 수 없는 상태는 muted fall-through', () => {
    expect(mapRelayTaskStatusToView('WHATEVER').tone).toBe('muted');
  });
});

describe('formatWeiToEth', () => {
  it('wei → ETH 문자열', () => {
    expect(formatWeiToEth('1000000000000000000')).toBe('1.000000 ETH');
    expect(formatWeiToEth('78000000000000')).toBe('0.000078 ETH');
  });
  it('null·잘못된 값은 —', () => {
    expect(formatWeiToEth(null)).toBe('—');
    expect(formatWeiToEth('abc')).toBe('—');
  });
});
