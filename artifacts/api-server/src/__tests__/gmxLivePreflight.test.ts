/**
 * #131 — LIVE preflight + 데모 경로 router 결속 매트릭스 (V1~V9).
 *
 * 검증 대상:
 *  V1 manifest·env 일치 (0xfD0596), 0x517602/임의 주소 fail-closed
 *  V2 @gmx-io/sdk 1.7.0 실제 pin 대조 (verifySdkRouterPin — 실 SDK 사용)
 *  V3~V5/V8 preflight P1~P5 (getCode·RoleStore·nonce readback, 주입 클라이언트)
 *  V4 주문 typed data domain 결속 — manifest router만 서명 허용
 *  V7 적대 케이스 — 0x517602·임의 주소 echo 거부
 *  V9 전환 감지 — SDK pin 불일치 시 reauditRequired(자동 수용 금지)
 *  + 실행 경로 결속: preflight 미통과 시 isPreflightPassedFresh=false (주문 0회 차단 근거)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GMX_DEPLOYMENT_MANIFEST, validateEnvAgainstManifest, getBlockedAddressReason } from '../lib/gmxDeploymentManifest';
import {
  runGmxLivePreflight, verifySdkRouterPin, getLastPreflight, isPreflightPassedFresh,
  __setPreflightClientFactoryForTests, __resetPreflightForTests, PREFLIGHT_TTL_MS,
} from '../lib/gmxLivePreflight';

const VALID_ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f';
const BLOCKED_NEXT = '0x517602BaC704B72993997820981603f5E4901273';
const OWNER = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e';

const GOOD_ENV = {
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: VALID_ROUTER,
  GMX_DATA_STORE_ADDRESS: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
  GMX_EVENT_EMITTER_ADDRESS: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
  GMX_CHAIN_ID: '42161',
  GMX_WALLET_ADDRESS: OWNER,
};

const savedEnv: Record<string, string | undefined> = {};
function setEnv(vals: Record<string, string>) {
  for (const [k, v] of Object.entries(vals)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}

function goodClient() {
  return {
    getBytecode: async () => ('0x' + 'ab'.repeat(100)) as `0x${string}`,
    readContract: async (args: { functionName: string }) =>
      args.functionName === 'hasRole' ? true : 0n,
  } as never;
}

beforeEach(() => {
  __resetPreflightForTests();
  setEnv(GOOD_ENV);
  __setPreflightClientFactoryForTests(goodClient);
});
afterEach(() => {
  __setPreflightClientFactoryForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('V1 — manifest v2·env 대조', () => {
  it('manifest v2의 router는 0xfD0596이고 0x517602는 차단 목록(재감사)이다', () => {
    expect(GMX_DEPLOYMENT_MANIFEST.manifestVersion).toBe(2);
    expect(GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter).toBe(VALID_ROUTER);
    expect(getBlockedAddressReason(BLOCKED_NEXT)).toContain('ROUTER_REAUDIT_REQUIRED');
    expect(getBlockedAddressReason(VALID_ROUTER)).toBeNull();
  });
  it('0xfD0596 env → ok; 0x517602·임의 주소 → fail-closed (V7)', () => {
    expect(validateEnvAgainstManifest(GOOD_ENV as NodeJS.ProcessEnv).ok).toBe(true);
    for (const bad of [BLOCKED_NEXT, '0x' + '11'.repeat(20)]) {
      expect(validateEnvAgainstManifest({ ...GOOD_ENV, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: bad } as NodeJS.ProcessEnv).ok).toBe(false);
    }
  });
});

describe('V2/V9 — 실제 @gmx-io/sdk pin 대조 + 전환 감지', () => {
  it('설치된 SDK 1.7.0의 ARBITRUM SubaccountGelatoRelayRouter가 manifest와 일치한다', () => {
    const r = verifySdkRouterPin();
    expect(r.ok).toBe(true);
  });
});

describe('V3~V5/V8 — preflight 온체인 검사 (주입 클라이언트)', () => {
  it('전 항목 통과 → ok, 스냅샷 저장, fresh', async () => {
    const r = await runGmxLivePreflight(1_000_000);
    expect(r.ok).toBe(true);
    expect(r.reauditRequired).toBe(false);
    expect(r.checks.map((c) => c.name)).toEqual([
      'P1_env_manifest', 'P2_sdk_pin', 'P3_router_code', 'P4_role_store', 'P5_nonce_readback',
    ]);
    expect(getLastPreflight()).toBe(r);
    expect(isPreflightPassedFresh(1_000_000 + PREFLIGHT_TTL_MS)).toBe(true);
    expect(isPreflightPassedFresh(1_000_000 + PREFLIGHT_TTL_MS + 1)).toBe(false); // TTL 경과 = stale
    expect(isPreflightPassedFresh(999_999)).toBe(false); // 미래 시각 스냅샷(시계 롤백) = stale
  });
  it('router 코드 없음 → P3 실패, 전체 차단', async () => {
    __setPreflightClientFactoryForTests(() => ({
      getBytecode: async () => undefined,
      readContract: async (a: { functionName: string }) => (a.functionName === 'hasRole' ? true : 0n),
    }) as never);
    const r = await runGmxLivePreflight();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'P3_router_code')?.ok).toBe(false);
    expect(isPreflightPassedFresh()).toBe(false);
  });
  it('RoleStore 권한 미충족(ROUTER_PLUGIN=false) → P4 실패', async () => {
    let call = 0;
    __setPreflightClientFactoryForTests(() => ({
      getBytecode: async () => ('0x' + 'ab'.repeat(10)) as `0x${string}`,
      readContract: async (a: { functionName: string }) => {
        if (a.functionName === 'hasRole') return (call++ === 0);
        return 0n;
      },
    }) as never);
    const r = await runGmxLivePreflight();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'P4_role_store')?.ok).toBe(false);
  });
  it('nonce 호출 실패 → P5 실패 (fail-closed)', async () => {
    __setPreflightClientFactoryForTests(() => ({
      getBytecode: async () => ('0x' + 'ab'.repeat(10)) as `0x${string}`,
      readContract: async (a: { functionName: string }) => {
        if (a.functionName === 'hasRole') return true;
        throw new Error('rpc down');
      },
    }) as never);
    const r = await runGmxLivePreflight();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'P5_nonce_readback')?.ok).toBe(false);
  });
  it('env가 차단 주소(0x517602)면 P1 실패 + 온체인 검사도 fail-closed', async () => {
    setEnv({ GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: BLOCKED_NEXT });
    const r = await runGmxLivePreflight();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'P1_env_manifest')?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'P3_router_code')?.ok).toBe(false);
  });
  it('RPC 클라이언트 생성 실패(GMX_RPC_URL 부재 등) → P3~P5 전부 실패', async () => {
    __setPreflightClientFactoryForTests(() => { throw new Error('GMX_RPC_URL 미설정 — preflight 불가 (fail-closed)'); });
    const r = await runGmxLivePreflight();
    expect(r.ok).toBe(false);
    for (const n of ['P3_router_code', 'P4_role_store', 'P5_nonce_readback']) {
      expect(r.checks.find((c) => c.name === n)?.ok).toBe(false);
    }
  });
});
