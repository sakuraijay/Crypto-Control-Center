/**
 * #124-C — POST /executor/subaccount-approval/prepare 서버 측 signer 강제 테스트.
 *
 * UI 게이트와 무관하게, 직접 API 호출로도 구성된 signer가 canary 예상 주소
 * (EXPECTED_CANARY_SIGNER)와 불일치하면 409로 차단되어야 한다 (fail-closed).
 * 외부 네트워크·DB 0회 (mock 전용).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// DB 미접속 격리 mock — gmxApiRoutes.http.test.ts와 동일 패턴
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
    liveApprovalsTable: {}, workerStateTable: {}, relayTasksTable: {},
    subaccountApprovalSessionsTable: {}, executionIntentsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

// signer 주입 — 테스트별로 주소 전환
const signerState = { address: '0x' + 'ab'.repeat(20) };
vi.mock('../lib/delegatedSigner', () => ({
  isDelegatedSignerEnabled: () => true,
  isSignerInitialized: () => true,
  getSignerAddress: () => signerState.address,
  getSignerCreatedAt: () => new Date().toISOString(),
  getSignerEthBalance: async () => ({ ethWei: 0n, ethFormatted: '0', readyForGas: false }),
  provisionDelegatedSigner: vi.fn(),
}));

import app from '../app';
import { EXPECTED_CANARY_SIGNER } from '../lib/canaryAllowanceInfo';

const PIN = 'test-pin-123456';
const MAIN = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e';
const ADDR = (b: string) => '0x' + b.repeat(20);
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPERATOR_MASTER_PIN: PIN,
  GMX_WALLET_ADDRESS: MAIN,
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: ADDR('11'),
  GMX_DATA_STORE_ADDRESS: ADDR('22'),
  GMX_EVENT_EMITTER_ADDRESS: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('#124-C prepare 서버 측 signer 강제', () => {
  it('signer 불일치 → 409 차단 (직접 API 호출 우회 불가)', async () => {
    signerState.address = ADDR('ab'); // canary 예상 주소가 아님
    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({ walletAddress: MAIN });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('canary 예상 주소');
  });

  it('signer 일치 → 409 아님 (다음 게이트로 진행; wallet 불일치 시 403)', async () => {
    signerState.address = EXPECTED_CANARY_SIGNER;
    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({ walletAddress: ADDR('cd') }); // main과 불일치 → 403으로 결정적 종료
    expect(res.status).toBe(403);
  });

  it('PIN 미제공 → 401 (인증이 signer 게이트보다 먼저)', async () => {
    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('content-type', 'application/json')
      .send({ walletAddress: MAIN });
    expect(res.status).toBe(401);
  });
});
