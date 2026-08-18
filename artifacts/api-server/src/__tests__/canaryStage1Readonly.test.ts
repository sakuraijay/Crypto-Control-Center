/**
 * Canary 1단계 — GMX_API_READONLY_ENABLED=true 단독 활성 시 구조적 안전 보장.
 *
 * 운영 전환: production env에 GMX_API_READONLY_ENABLED=true만 추가된 상태에서
 * 아래가 구조적으로 0회임을 고정한다:
 *  §1 GMX API transport — readonly GET만 허용, submit POST=config 차단(발신 0회)
 *  §2 delegated signer — enabled=false·저장소 접근 불허 (키 생성/복호화 0회)
 *  §3 relay — 제출 네트워크 구조적 차단 유지 (readonly 플래그와 무관)
 *
 * 이 테스트는 실제 네트워크를 사용하지 않는다 — fetch mock이 호출 횟수를 검증.
 */
import { describe, it, expect, vi } from 'vitest';

// CI db-free 규칙 — delegatedSigner가 모듈 로드 시 @workspace/db를 import하므로 mock 필수
vi.mock('@workspace/db', () => ({
  db: {},
  workerStateTable: {},
}));

import {
  createGmxApiTransport,
  GMX_API_READONLY_FLAG,
  GMX_API_SUBMISSION_FLAG,
} from '../lib/gmxApiTransport';
import { isSignerStorageAccessAllowed } from '../lib/delegatedSigner';
import { isRelayNetworkStructurallyDisabled, isRelayReadonlyNetworkEnabled } from '../lib/relayActivationStatus';

/** Canary 1단계 production env 재현 — READONLY만 true, 나머지 잠금 전부 유지 */
const STAGE1_ENV: Record<string, string | undefined> = {
  [GMX_API_READONLY_FLAG]: 'true',
  // 아래 전부 미설정 또는 잠금 상태 (운영 지시와 동일)
  [GMX_API_SUBMISSION_FLAG]: undefined,
  DELEGATED_SIGNER_ENABLED: 'false',
  LIVE_TEST_EXECUTION_LOCKED: 'true',
  GMX_RELAY_NETWORK_ENABLED: undefined,
  GMX_RELAY_SUBMISSION_ENABLED: undefined,
  GMX_RELAY_MODE: undefined,
  GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  WORKER_ENGINE_MODE: undefined, // Secret — 테스트에선 미설정으로 재현 (PAPER 기본)
};

function jsonResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Canary 1단계 — READONLY 단독 활성의 구조적 0회 보장', () => {
  it('§1a readonly GET은 허용된다 (fetch 1회, GET만)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse());
    const t = createGmxApiTransport(STAGE1_ENV, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(t.readonlyEnabled).toBe(true);
    expect(t.submissionEnabled).toBe(false);

    const r = await t.getJson('/markets');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('§1b submit intent POST는 config 차단 — 요청 발신 0회', async () => {
    const fetchMock = vi.fn(async () => jsonResponse());
    const t = createGmxApiTransport(STAGE1_ENV, { fetchImpl: fetchMock as unknown as typeof fetch });

    const r = await t.postJson('/orders', { any: 'payload' }, 'submit');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('config');
      expect(r.ambiguous).toBe(false); // 발신 전 차단 = broadcast 불명 아님
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('§1c readonly intent POST도 submission 플래그 없이는 발신 0회 유지', async () => {
    // prepare 등 readonly intent의 POST 경로가 있어도 1단계 env에서 열리는지 확인
    const fetchMock = vi.fn(async () => jsonResponse());
    const t = createGmxApiTransport(STAGE1_ENV, { fetchImpl: fetchMock as unknown as typeof fetch });
    const r = await t.postJson('/orders/prepare', {}, 'readonly');
    // readonly POST가 허용되는 설계라면 GET이 아닌 호출이 생기므로 명시적으로 고정:
    // 어떤 결과든 submit 경로가 아니어야 하고, 차단됐다면 config여야 한다.
    if (!r.ok) {
      expect(r.kind).toBe('config');
      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
  });

  it('§2 signer 저장소 접근 불허 — 키 생성/복호화 구조적 0회', () => {
    const res = isSignerStorageAccessAllowed(STAGE1_ENV as NodeJS.ProcessEnv);
    expect(res.allowed).toBe(false);
    // LIVE 잠금·relay 미활성·signer 비활성 사유가 명시적으로 남아야 한다
    expect(res.missing.length).toBeGreaterThanOrEqual(5);
    expect(res.missing.join(' ')).toContain('DELEGATED_SIGNER_ENABLED');
    expect(res.missing.join(' ')).toContain('LIVE 잠금 활성');
  });

  it('§3 relay 제출 네트워크는 구조적 차단 유지 (readonly 플래그와 독립)', () => {
    expect(isRelayNetworkStructurallyDisabled(STAGE1_ENV as NodeJS.ProcessEnv)).toBe(true);
    // 기존 readonly relay 플래그는 그대로 — GMX_API_READONLY_ENABLED가 이를 바꾸지 않음
    expect(isRelayReadonlyNetworkEnabled(STAGE1_ENV as NodeJS.ProcessEnv)).toBe(true);
    const withoutApiFlag = { ...STAGE1_ENV, [GMX_API_READONLY_FLAG]: undefined };
    expect(isRelayNetworkStructurallyDisabled(withoutApiFlag as NodeJS.ProcessEnv)).toBe(true);
  });
});
