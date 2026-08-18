/**
 * Canary 2단계 — DELEGATED_SIGNER_ENABLED=true 전환 시 구조적 안전 보장.
 *
 * 운영 전환: production env에 DELEGATED_SIGNER_ENABLED=true가 추가되되,
 * WORKER_ENGINE_MODE=PAPER·LIVE_TEST_EXECUTION_LOCKED=true·relay 제출
 * network/mode 비활성·GMX_API_ORDER_SUBMISSION_ENABLED 미설정이 유지된다.
 *
 * 이 조합에서 아래가 구조적으로 0회임을 고정한다 (6단계 §4 게이트):
 *  §1 signer 저장소 접근 불허 — DB 조회·암호문 조회·복호화·키 생성 0회
 *  §2 initializeDelegatedSigner()가 저장소 접근 전에 조기 반환 (DB 호출 0회)
 *  §3 서명 경로(getSignerWalletClient 등) 미초기화 유지
 *  §4 주문 제출·relay 제출 네트워크는 여전히 구조적 차단
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// CI db-free 규칙 + DB 접근 0회 검증 — select/insert 호출 자체를 추적한다
const dbCalls: string[] = [];
vi.mock('@workspace/db', () => ({
  db: new Proxy({}, {
    get(_t, prop: string) {
      dbCalls.push(prop);
      throw new Error(`db.${prop} 접근 발생 — 2단계에서 signer DB 접근은 0회여야 함`);
    },
  }),
  workerStateTable: {},
}));

import {
  isDelegatedSignerEnabled,
  isSignerStorageAccessAllowed,
  initializeDelegatedSigner,
  isSignerInitialized,
  getSignerAddress,
} from '../lib/delegatedSigner';
import { createGmxApiTransport, GMX_API_READONLY_FLAG } from '../lib/gmxApiTransport';
import { isRelayNetworkStructurallyDisabled } from '../lib/relayActivationStatus';

/** Canary 2단계 production env 재현 */
const STAGE2_ENV: Record<string, string> = {
  DELEGATED_SIGNER_ENABLED: 'true',
  [GMX_API_READONLY_FLAG]: 'true',
  GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  LIVE_TEST_EXECUTION_LOCKED: 'true',
  // GMX_API_ORDER_SUBMISSION_ENABLED / GMX_RELAY_NETWORK_ENABLED /
  // GMX_RELAY_SUBMISSION_ENABLED / GMX_RELAY_MODE / WORKER_ENGINE_MODE(LIVE) 미설정
};
const UNSET_KEYS = [
  'GMX_API_ORDER_SUBMISSION_ENABLED',
  'GMX_RELAY_NETWORK_ENABLED',
  'GMX_RELAY_SUBMISSION_ENABLED',
  'GMX_RELAY_MODE',
  'WORKER_ENGINE_MODE',
];

beforeEach(() => {
  dbCalls.length = 0;
  for (const [k, v] of Object.entries(STAGE2_ENV)) vi.stubEnv(k, v);
  for (const k of UNSET_KEYS) vi.stubEnv(k, '');
});
afterEach(() => vi.unstubAllEnvs());

describe('Canary 2단계 — signer flag 활성 + 전체 잠금 유지의 구조적 0회 보장', () => {
  it('§1 flag는 활성이지만 signer 저장소 접근은 불허 (missing 사유 명시)', () => {
    expect(isDelegatedSignerEnabled()).toBe(true);
    const res = isSignerStorageAccessAllowed(process.env);
    expect(res.allowed).toBe(false);
    const joined = res.missing.join(' ');
    expect(joined).toContain('GMX_RELAY_NETWORK_ENABLED');
    expect(joined).toContain('GMX_RELAY_SUBMISSION_ENABLED');
    expect(joined).toContain('GMX_RELAY_MODE');
    expect(joined).toContain('PAPER 모드');
    expect(joined).toContain('LIVE 잠금 활성');
    // DELEGATED_SIGNER_ENABLED는 더 이상 missing이 아니어야 한다 (2단계 전환 완료)
    expect(joined).not.toContain("DELEGATED_SIGNER_ENABLED !== 'true'");
  });

  it('§2 initializeDelegatedSigner — 저장소 접근 전 조기 반환, DB 호출 0회·키 생성 0회', async () => {
    await expect(initializeDelegatedSigner()).resolves.toBeUndefined();
    expect(dbCalls).toHaveLength(0);            // DB 조회·암호문 조회 0회
    expect(isSignerInitialized()).toBe(false);  // 키 복원·생성 0회
    expect(getSignerAddress()).toBeNull();
  });

  it('§3 Owner Approval 경로도 signer 미초기화로 차단 상태 유지', () => {
    // 서명·approval 생성의 전제(초기화)가 성립하지 않음을 고정
    expect(isSignerInitialized()).toBe(false);
  });

  it('§4 주문 제출·relay 제출 네트워크는 여전히 구조적 차단', async () => {
    const fetchMock = vi.fn();
    const t = createGmxApiTransport(process.env as Record<string, string | undefined>, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(t.readonlyEnabled).toBe(true);
    expect(t.submissionEnabled).toBe(false);
    const r = await t.postJson('/orders', {}, 'submit');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('config');
    expect(fetchMock).toHaveBeenCalledTimes(0); // prepare/submit 발신 0회
    expect(isRelayNetworkStructurallyDisabled(process.env)).toBe(true);
  });
});
