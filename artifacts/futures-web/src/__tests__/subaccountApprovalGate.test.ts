/**
 * 6E-2 §2·§5·§9 — 인증 오류 구분 매핑 + Prepare fail-closed 게이팅 테스트.
 *  - 401/403은 절대 NOT_CONFIGURED로 변환되지 않는다.
 *  - PIN만으로는 Prepare가 활성화되지 않는다 (모든 조건 충족 전 차단).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mapAuthFetchToDisplayState, mapAuthStateToView, canPrepareApproval,
  fetchSubaccountAuthDetailed,
  type SubaccountAuthResponse, type AuthFetchResult,
} from '../lib/subaccountApproval';

const okAuth: SubaccountAuthResponse = {
  ok: true,
  state: 'OWNER_SIGNATURE_REQUIRED',
  displayState: 'OWNER_SIGNATURE_REQUIRED',
  chainId: 42161,
  mainAccount: '0x46c2000000000000000000000000000000950e00',
  signerAddress: '0x1111111111111111111111111111111111111111',
  relayRouter: '0x2222222222222222222222222222222222222222',
  relayConfigured: true,
  configReasons: [],
  onchain: null,
  onchainError: null,
  readySession: null,
  liveEligible: false,
  liveBlockedReason: 'LIVE locked',
};

const goodGuard = { ok: true } as const;

describe('mapAuthFetchToDisplayState (§2)', () => {
  it('401 → OPERATOR_AUTH_REQUIRED (NOT_CONFIGURED 아님)', () => {
    expect(mapAuthFetchToDisplayState({ kind: 'http', status: 401 })).toBe('OPERATOR_AUTH_REQUIRED');
  });
  it('403 → OPERATOR_AUTH_REQUIRED', () => {
    expect(mapAuthFetchToDisplayState({ kind: 'http', status: 403 })).toBe('OPERATOR_AUTH_REQUIRED');
  });
  it('503 → NOT_CONFIGURED (env 미설정)', () => {
    expect(mapAuthFetchToDisplayState({ kind: 'http', status: 503 })).toBe('NOT_CONFIGURED');
  });
  it('기타 HTTP 오류 → ERROR', () => {
    expect(mapAuthFetchToDisplayState({ kind: 'http', status: 500 })).toBe('ERROR');
  });
  it('네트워크 오류 → UNVERIFIED', () => {
    expect(mapAuthFetchToDisplayState({ kind: 'network' })).toBe('UNVERIFIED');
  });
  it('성공 → null (매핑 없음)', () => {
    expect(mapAuthFetchToDisplayState({ kind: 'ok', data: okAuth } as AuthFetchResult)).toBeNull();
  });
});

describe('신규 상태 라벨 (§2)', () => {
  it('OPERATOR_AUTH_REQUIRED는 인증 오류로 표시되고 env 미설정 문구가 아니다', () => {
    const v = mapAuthStateToView('OPERATOR_AUTH_REQUIRED');
    expect(v.tone).toBe('error');
    expect(v.description).toContain('환경변수 미설정이 아닙니다');
  });
  it('NOT_AUTHORIZED / SIGNER_NOT_INITIALIZED 라벨 존재', () => {
    expect(mapAuthStateToView('NOT_AUTHORIZED').label).not.toBe('NOT_AUTHORIZED');
    expect(mapAuthStateToView('SIGNER_NOT_INITIALIZED').label).not.toBe('SIGNER_NOT_INITIALIZED');
  });
});

describe('canPrepareApproval (§5·§9 — PIN만으로 실행 불가)', () => {
  it('모든 조건 충족 → ok', () => {
    expect(canPrepareApproval({ guard: goodGuard, auth: okAuth, fetchErrorState: null }).ok).toBe(true);
  });
  it('auth=null (상태 미확인) → 차단 — PIN이 있어도 Prepare 불가', () => {
    const r = canPrepareApproval({ guard: goodGuard, auth: null, fetchErrorState: null });
    expect(r.ok).toBe(false);
  });
  it('fetch 인증 오류 → 차단', () => {
    const r = canPrepareApproval({ guard: goodGuard, auth: null, fetchErrorState: 'OPERATOR_AUTH_REQUIRED' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('OPERATOR_AUTH_REQUIRED');
  });
  it('지갑 가드 실패 → 차단', () => {
    const r = canPrepareApproval({ guard: { ok: false, reason: '지갑 미연결' }, auth: okAuth, fetchErrorState: null });
    expect(r.ok).toBe(false);
  });
  it('relay 미구성 → 차단', () => {
    const r = canPrepareApproval({
      guard: goodGuard, fetchErrorState: null,
      auth: { ...okAuth, relayConfigured: false, configReasons: ['GMX_RELAY 미설정'] },
    });
    expect(r.ok).toBe(false);
  });
  it('main wallet 미설정 → 차단', () => {
    const r = canPrepareApproval({ guard: goodGuard, auth: { ...okAuth, mainAccount: null }, fetchErrorState: null });
    expect(r.ok).toBe(false);
  });
  it('signer 미초기화 → 차단', () => {
    const r = canPrepareApproval({ guard: goodGuard, auth: { ...okAuth, signerAddress: null }, fetchErrorState: null });
    expect(r.ok).toBe(false);
  });
  it('chainId ≠ 42161 → 차단', () => {
    const r = canPrepareApproval({ guard: goodGuard, auth: { ...okAuth, chainId: 1 }, fetchErrorState: null });
    expect(r.ok).toBe(false);
  });
  it('ERROR/UNVERIFIED/REVOKED 상태 → 차단', () => {
    for (const state of ['ERROR', 'UNVERIFIED', 'REVOKED', 'NOT_CONFIGURED', 'SIGNER_DISABLED']) {
      const r = canPrepareApproval({ guard: goodGuard, auth: { ...okAuth, state }, fetchErrorState: null });
      expect(r.ok, state).toBe(false);
    }
  });
});

describe('fetchSubaccountAuthDetailed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('401 응답은 http/401로 구분된다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const r = await fetchSubaccountAuthDetailed('/api/');
    expect(r).toEqual({ kind: 'http', status: 401 });
  });

  it('네트워크 오류 → network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const r = await fetchSubaccountAuthDetailed('/api/');
    expect(r).toEqual({ kind: 'network' });
  });

  it('성공 → ok + payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okAuth }));
    const r = await fetchSubaccountAuthDetailed('/api/');
    expect(r.kind).toBe('ok');
  });
});
