/**
 * subaccountApproval 웹 헬퍼 테스트 — 순수 함수 (네트워크·서명 없음).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canRequestOwnerSignature, mapAuthStateToView, mapSignError, formatUnixSeconds,
  fetchSubaccountAuth, postPrepareApproval, postApprovalSignature,
  APPROVAL_GRANTS, APPROVAL_DENIALS, ARBITRUM_ONE_CHAIN_ID,
} from '../subaccountApproval';

const OWNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

describe('canRequestOwnerSignature — fail-closed 가드', () => {
  const base = { walletStatus: 'connected', isArbitrum: true, walletAddress: OWNER, mainAccount: OWNER };

  it('정상 → ok', () => {
    expect(canRequestOwnerSignature(base)).toEqual({ ok: true });
    // 대소문자 차이는 허용
    expect(canRequestOwnerSignature({ ...base, walletAddress: OWNER.toLowerCase() }).ok).toBe(true);
  });

  it('지갑 미연결 → 거부', () => {
    const r = canRequestOwnerSignature({ ...base, walletStatus: 'disconnected' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('연결');
  });

  it('잘못된 체인 → 거부 (42161 강제)', () => {
    const r = canRequestOwnerSignature({ ...base, isArbitrum: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(String(ARBITRUM_ONE_CHAIN_ID));
  });

  it('계정 불일치 → 거부', () => {
    const r = canRequestOwnerSignature({ ...base, walletAddress: '0x' + '22'.repeat(20) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('main wallet');
  });

  it('main wallet 미설정 → 거부', () => {
    expect(canRequestOwnerSignature({ ...base, mainAccount: null }).ok).toBe(false);
  });
});

describe('mapAuthStateToView', () => {
  it('READY vs AUTHORIZED 구분', () => {
    const ready = mapAuthStateToView('OWNER_SIGNATURE_READY');
    const authorized = mapAuthStateToView('AUTHORIZED');
    expect(ready.tone).toBe('warn');
    expect(ready.description).toContain('LIVE');   // READY여도 LIVE 차단 명시
    expect(authorized.tone).toBe('ok');
  });

  it('알 수 없는 상태 → 차단 취급 (muted)', () => {
    const v = mapAuthStateToView('SOMETHING_NEW');
    expect(v.tone).toBe('muted');
    expect(v.description).toContain('차단');
  });

  it('오류·해지 상태는 error 톤', () => {
    for (const s of ['ERROR', 'EXPIRED', 'REVOKED', 'ACTION_LIMIT_REACHED']) {
      expect(mapAuthStateToView(s).tone).toBe('error');
    }
  });
});

describe('mapSignError — 취소는 오류가 아님', () => {
  it('code 4001 → cancelled', () => {
    expect(mapSignError({ code: 4001, message: 'User rejected the request.' }).cancelled).toBe(true);
    expect(mapSignError({ message: 'MetaMask Tx Signature: User denied' }).cancelled).toBe(true);
  });
  it('기타 오류 → cancelled=false + 메시지', () => {
    const r = mapSignError(new Error('boom'));
    expect(r.cancelled).toBe(false);
    expect(r.message).toContain('boom');
    expect(mapSignError(null).cancelled).toBe(false);
  });
});

describe('formatUnixSeconds', () => {
  it('빈 값·0·비수치 → —', () => {
    expect(formatUnixSeconds(null)).toBe('—');
    expect(formatUnixSeconds('0')).toBe('—');
    expect(formatUnixSeconds('abc')).toBe('—');
  });
  it('정상 값 → 로컬 시각 문자열', () => {
    expect(formatUnixSeconds('1800000000')).not.toBe('—');
  });
});

describe('권한 요약 고정 문구', () => {
  it('허용/불가 항목 존재, 출금 불가 명시', () => {
    expect(APPROVAL_GRANTS.length).toBeGreaterThan(0);
    expect(APPROVAL_DENIALS.join(' ')).toContain('출금');
  });
});

describe('API 래퍼 — 오류 시 fail-closed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetchSubaccountAuth: 네트워크 오류/HTTP 오류/ok:false → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await fetchSubaccountAuth('/api/')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchSubaccountAuth('/api/')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false }) }));
    expect(await fetchSubaccountAuth('/api/')).toBeNull();
  });

  it('fetchSubaccountAuth: 정상 응답 통과', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, state: 'UNVERIFIED', displayState: 'UNVERIFIED' }),
    }));
    const r = await fetchSubaccountAuth('/api/');
    expect(r?.state).toBe('UNVERIFIED');
  });

  it('postPrepareApproval: PIN 헤더·JSON 전송, 오류 메시지 전달', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error: '운영자 인증 실패' }) });
    vi.stubGlobal('fetch', fetchMock);
    const r = await postPrepareApproval({ apiBase: '/api/', pin: 'secret-pin', walletAddress: OWNER });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('인증');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-operator-pin']).toBe('secret-pin');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('postApprovalSignature: 성공 시 status 전달, 예외 → ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 'OWNER_SIGNATURE_READY' }) }));
    const r = await postApprovalSignature({ apiBase: '/api/', pin: 'p'.repeat(8), sessionId: 's1', signature: '0x' + 'ab'.repeat(65) });
    expect(r).toMatchObject({ ok: true, status: 'OWNER_SIGNATURE_READY' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const r2 = await postApprovalSignature({ apiBase: '/api/', pin: 'p'.repeat(8), sessionId: 's1', signature: '0x00' });
    expect(r2.ok).toBe(false);
  });
});
