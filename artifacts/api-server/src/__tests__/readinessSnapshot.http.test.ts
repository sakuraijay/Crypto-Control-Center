/**
 * 6E-10 §2·§8 — 인증된 readiness POST 응답에 서버 저장 스냅샷 동봉 검증.
 *
 * 실제 라우트 핸들러를 통과시키되 canonical client·readonly public client·
 * transport 전부 spy 주입 → 실제 네트워크 0회.
 * 검증:
 *  - 응답에 refresh + snapshot 포함 (deploymentVerification 항목·canonical·statusFlags)
 *  - snapshot 조립이 추가 외부 호출을 유발하지 않음 (refresh 수행분 그대로)
 *  - fee oracle 500이 snapshot의 lastReadinessRefresh.failures에 보존
 *  - signer 부재 시 canonical client 0회 유지
 *  - readyForControlledCanary === false, refresh.ok === false 계약 유지
 *  - PIN·Secret·RPC URL·암호문 미노출
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
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import { __setRelayCanonicalClientFactoryForTests, __setRelayTransportForTests } from '../routes/relay';
import { __setRelayReadonlyPublicClientFactoryForTests } from '../lib/relayReadonlyClient';
import { __resetReadinessRefreshForTests, __resetDeploymentVerificationForTests } from '../lib/relayActivationStatus';

const PIN = 'test-pin-123456';
const ADDR = '0x1111111111111111111111111111111111111111';

describe('readiness refresh 응답 snapshot (6E-10)', () => {
  const canonicalFactorySpy = vi.fn(() => null);
  const getCodeSpy = vi.fn().mockResolvedValue('0x1234');
  const getChainIdSpy = vi.fn().mockResolvedValue(42161);
  const readContractSpy = vi.fn(async (args: { functionName: string }) =>
    args.functionName === 'digests' ? false : 0n);
  const getGasPriceSpy = vi.fn().mockResolvedValue(100_000_000n);
  const sponsorSpy = vi.fn().mockResolvedValue({ ok: false, kind: 'http', httpStatus: 500, message: 'HTTP 500' });
  const taskStatusSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv('OPERATOR_MASTER_PIN', PIN);
    vi.stubEnv('GMX_RELAY_READONLY_NETWORK_ENABLED', 'true');
    // manifest 감사 주소와 일치해야 dv.ok=true (자동 대입 없음 — env 필수)
    vi.stubEnv('GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter);
    vi.stubEnv('GMX_DATA_STORE_ADDRESS', GMX_DEPLOYMENT_MANIFEST.addresses.dataStore);
    vi.stubEnv('GMX_EVENT_EMITTER_ADDRESS', GMX_DEPLOYMENT_MANIFEST.addresses.eventEmitter);
    vi.stubEnv('GMX_WALLET_ADDRESS', ADDR);
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', '');       // signer 구조적 비활성
    vi.stubEnv('GMX_RPC_URL', 'https://rpc.invalid'); // 실제로는 fake client가 대신함
    __setRelayCanonicalClientFactoryForTests(canonicalFactorySpy as never);
    __setRelayReadonlyPublicClientFactoryForTests((() => ({
      getCode: getCodeSpy,
      getChainId: getChainIdSpy,
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1n }),
      getGasPrice: getGasPriceSpy,
      readContract: readContractSpy,
    })) as never);
    __setRelayTransportForTests({
      getSponsorBalance: sponsorSpy,
      getRelayTaskStatus: taskStatusSpy,
      submitRelayTask: vi.fn(),
    } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __setRelayCanonicalClientFactoryForTests(null as never);
    __setRelayReadonlyPublicClientFactoryForTests(null);
    __setRelayTransportForTests(null);
    __resetReadinessRefreshForTests();
    __resetDeploymentVerificationForTests();
    for (const s of [canonicalFactorySpy, getCodeSpy, getChainIdSpy, readContractSpy, getGasPriceSpy, sponsorSpy, taskStatusSpy]) s.mockClear();
  });

  async function callRefresh() {
    return request(app)
      .post('/api/executor/relay/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({});
  }

  it('응답에 refresh + snapshot(deploymentVerification·canonical·statusFlags) 포함', async () => {
    const res = await callRefresh();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refresh.ok).toBe(false);              // sponsor 조회 500 + signer 부재 → fail-closed 유지
    const snap = res.body.snapshot;
    expect(snap).toBeTruthy();

    // deploymentVerification — 검증 항목이 basis로 전부 포함 (7개 항목)
    const dv = snap.deploymentVerification;
    expect(dv.attempted).toBe(true);
    expect(dv.ok).toBe(true);
    const basisDump = dv.basis.join('\n');
    expect(basisDump).toContain('chainId 42161 확인');
    expect(basisDump).toContain('manifest');
    expect(basisDump).toContain('SubaccountGelatoRelayRouter 코드 존재 확인');
    expect(basisDump).toContain('DataStore 코드 존재 확인');
    expect(basisDump).toContain('EventEmitter 코드 존재 확인');
    expect(basisDump).toContain('digests(bytes32) decode 정상');
    expect(basisDump).toContain('DataStore.getUint decode 정상');

    // canonical — 조회 경로에서 저장된 스냅샷 (signer 미초기화 사유 포함, fail-closed)
    expect(snap.canonical).toBeTruthy();
    expect(snap.canonical.confirmed).toBe(false);

    // statusFlags — env 파생 + fail-closed canary
    expect(snap.statusFlags.readonlyNetworkDisabled).toBe(false);
    expect(snap.statusFlags.submitNetworkDisabled).toBe(true);
    expect(snap.statusFlags.relayMode).toBe('DISABLED');
    expect(snap.statusFlags.signerDisabled).toBe(true);
    expect(snap.statusFlags.liveLocked).toBe(true);
    expect(snap.statusFlags.readyForControlledCanary).toBe(false);

    // lastReadinessRefresh — refresh 결과와 동일 스냅샷
    expect(snap.lastReadinessRefresh.attempted).toBe(true);
    expect(snap.lastReadinessRefresh.ok).toBe(false);
  });

  it('6G-1: GMX API peer 점검 비활성(플래그 off)이 snapshot failures에 보존된다 (조회 0회)', async () => {
    const res = await callRefresh();
    const failures: string[] = res.body.snapshot.lastReadinessRefresh.failures;
    expect(failures.some((f) => f.includes('GMX API peer'))).toBe(true);
    // 실패를 성공으로 오표시하지 않음
    expect(res.body.snapshot.lastReadinessRefresh.ok).toBe(false);
    // legacy sponsor balance 조회는 0회
    expect(sponsorSpy).not.toHaveBeenCalled();
  });

  it('snapshot 조립은 추가 외부 호출을 유발하지 않는다 (refresh 수행분 그대로)', async () => {
    await callRefresh();
    // refresh 자체가 수행한 읽기만 존재: getCode 3회, chainId 1회, readContract 3회(digests+getUint+fee getUint), gasPrice 1회, sponsor 1회
    expect(getCodeSpy).toHaveBeenCalledTimes(3);
    expect(getChainIdSpy).toHaveBeenCalledTimes(1);
    expect(readContractSpy).toHaveBeenCalledTimes(3);
    expect(getGasPriceSpy).toHaveBeenCalledTimes(1);
    expect(sponsorSpy).not.toHaveBeenCalled(); // 6G-1: legacy sponsor 조회 0회
    expect(taskStatusSpy).not.toHaveBeenCalled();
    // signer 부재 → canonical client 생성 0회 (eth_call 0회)
    expect(canonicalFactorySpy).not.toHaveBeenCalled();
  });

  it('PIN·Secret·RPC URL·서명 미노출', async () => {
    const res = await callRefresh();
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain(PIN);
    expect(dump).not.toContain('https://');
    expect(dump).not.toContain('rpc.invalid');
    expect(dump.toLowerCase()).not.toContain('privatekey');
    expect(dump).not.toContain('signature');
  });
});
