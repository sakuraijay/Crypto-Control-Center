/**
 * 6E-2 §6·§9 — LIVE TEST 토글은 서버 /api/executor/status가 authoritative.
 * localStorage(로컬 limits) 값이 서버 상태를 절대 덮어쓰지 않는다.
 */
import { describe, it, expect } from 'vitest';
import { deriveLiveTestDisplay } from '../lib/liveTestDisplay';

describe('deriveLiveTestDisplay', () => {
  it('서버 liveTestMode=false → 로컬 true여도 토글 OFF (구형 설정 미적용 표시)', () => {
    const d = deriveLiveTestDisplay({ serverLiveTestMode: false, serverStatusKnown: true, localLiveTestMode: true });
    expect(d.checked).toBe(false);
    expect(d.localPendingNotApplied).toBe(true);
    expect(d.hint).toContain('서버');
  });

  it('서버 liveTestMode=true → 토글 ON', () => {
    const d = deriveLiveTestDisplay({ serverLiveTestMode: true, serverStatusKnown: true, localLiveTestMode: true });
    expect(d.checked).toBe(true);
    expect(d.localPendingNotApplied).toBe(false);
    expect(d.hint).toBeNull();
  });

  it('서버 상태 미확인 → OFF + 토글 비활성 (fail-closed, localStorage 복원 금지)', () => {
    const d = deriveLiveTestDisplay({ serverLiveTestMode: undefined, serverStatusKnown: false, localLiveTestMode: true });
    expect(d.checked).toBe(false);
    expect(d.toggleDisabled).toBe(true);
  });

  it('서버 필드 누락(undefined)이라도 known이면 OFF로 표시 (PAPER 동시 활성 표시 금지)', () => {
    const d = deriveLiveTestDisplay({ serverLiveTestMode: undefined, serverStatusKnown: true, localLiveTestMode: false });
    expect(d.checked).toBe(false);
    expect(d.localPendingNotApplied).toBe(false);
  });

  it('로컬 false·서버 false → 힌트 없음', () => {
    const d = deriveLiveTestDisplay({ serverLiveTestMode: false, serverStatusKnown: true, localLiveTestMode: false });
    expect(d.hint).toBeNull();
    expect(d.checked).toBe(false);
  });
});
