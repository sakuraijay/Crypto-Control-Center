/**
 * 6E-8 §4 리뷰 반영 — 실제 canonical 경로에서 signer 미초기화 시
 * canonical client 생성·eth_call이 0회임을 라우트 레벨로 검증.
 *
 * POST /api/executor/relay/readiness/refresh 실제 핸들러를 통과시키되:
 *  - canonical client factory / readonly public client / transport 전부 spy 주입
 *    → 어떤 실제 네트워크 호출도 발생하지 않는다.
 *  - DELEGATED_SIGNER_ENABLED 미설정 (signer 저장소 접근 자체가 구조적 차단).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// DB 미접속 격리 mock — readiness.http.test.ts와 동일 패턴
vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from','where','limit','offset','orderBy','set','values',
                     'onConflictDoNothing','onConflictDoUpdate','returning']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: () => chain(() => []),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import { __setRelayCanonicalClientFactoryForTests, __setRelayTransportForTests } from '../routes/relay';
import { __setRelayReadonlyPublicClientFactoryForTests } from '../lib/relayReadonlyClient';
import { __resetReadinessRefreshForTests } from '../lib/relayActivationStatus';

const PIN = 'test-pin-123456';
const ADDR = '0x1111111111111111111111111111111111111111';

describe('readiness refresh — signer 미초기화 시 canonical 생략 (실경로)', () => {
  const canonicalFactorySpy = vi.fn(() => null);
  const readContractSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv('OPERATOR_MASTER_PIN', PIN);
    vi.stubEnv('GMX_RELAY_READONLY_NETWORK_ENABLED', 'true');
    vi.stubEnv('GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', ADDR);
    vi.stubEnv('GMX_DATA_STORE_ADDRESS', ADDR);
    vi.stubEnv('GMX_EVENT_EMITTER_ADDRESS', ADDR);
    vi.stubEnv('GMX_WALLET_ADDRESS', ADDR);
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', '');       // signer 구조적 비활성
    vi.stubEnv('GMX_RPC_URL', 'https://rpc.invalid'); // 실제로는 fake client가 대신함
    // 어떤 실제 네트워크도 접촉하지 않도록 전부 주입
    __setRelayCanonicalClientFactoryForTests(canonicalFactorySpy as never);
    __setRelayReadonlyPublicClientFactoryForTests((() => ({
      getCode: vi.fn().mockResolvedValue('0x1234'),
      getChainId: vi.fn().mockResolvedValue(42161),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1n }),
      readContract: readContractSpy,
    })) as never);
    __setRelayTransportForTests({
      quoteRelayFee: vi.fn().mockResolvedValue({ ok: true, estimatedFeeWei: 100n, quotedAtMs: 1 }),
      getRelayTaskStatus: vi.fn(),
      submitRelayTask: vi.fn(),
    } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __setRelayCanonicalClientFactoryForTests(null as never);
    __setRelayReadonlyPublicClientFactoryForTests(null);
    __setRelayTransportForTests(null);
    __resetReadinessRefreshForTests();
    canonicalFactorySpy.mockClear();
    readContractSpy.mockClear();
  });

  it('signer 미초기화 → 생략 문구 + canonical client 생성·eth_call 0회 + ok=false', async () => {
    const res = await request(app)
      .post('/api/executor/relay/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refresh.ok).toBe(false);          // 여전히 fail-closed
    expect(res.body.refresh.failures).toContain(
      'canonical readback 생략: delegated signer 미초기화 (예상된 fail-closed)',
    );
    // signer 부재 → canonical client 생성조차 안 됨 = eth_call 0회
    expect(canonicalFactorySpy).not.toHaveBeenCalled();
    // 응답 어디에도 URL·본문 미포함
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain('https://');
  });
});
