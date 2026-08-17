/**
 * 6C 단계 — 최신 Router 주소·ABI 호환성 감사 테스트 (§8).
 *
 * 골든 값 근거: gmx-synthetics main deployments/arbitrum artifacts
 * (commit 95bd0c97385737b3227e314fafb04371991bdf1b).
 * 네트워크·RPC·signer 실호출 0회 — 전부 mock/decode 기반.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  toFunctionSelector, decodeFunctionData, keccak256, toHex,
  type Address, type Hex,
} from 'viem';
import {
  GMX_DEPLOYMENT_MANIFEST, GMX_BLOCKED_ADDRESSES,
  validateEnvAgainstManifest, getBlockedAddressReason,
} from '../lib/gmxDeploymentManifest';
import {
  resolveGmxLiveRelayConfig,
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_OFFICIAL_DOC,
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_LEGACY_BLOCKED,
} from '../lib/gmxLiveConfig';
import { evaluateActivationGate, type ActivationGateInput } from '../lib/relayActivationGate';
import { createGelatoHttpTransport, GELATO_API_KEY_SECRET_NAME } from '../lib/relayTransport';
import {
  SUBACCOUNT_CREATE_ORDER_ABI, encodeSubaccountCreateOrderCalldata,
  buildOpenOrderParams, buildCloseOrderParams, computeCreateOrderDigest,
  CREATE_ORDER_ROOT_TYPE_STRING, CREATE_ORDER_ADDRESSES_TYPE_STRING, CREATE_ORDER_NUMBERS_TYPE_STRING,
  type SubaccountApprovalStruct,
} from '../lib/gmxCreateOrder';
import {
  REMOVE_SUBACCOUNT_ABI, encodeRemoveSubaccountCalldata, computeRemoveSubaccountDigest,
  REMOVE_SUBACCOUNT_TYPE_STRING,
} from '../lib/relayOrderAssembly';
import { SUBACCOUNT_APPROVAL_TYPE_STRING, buildMinimalRelayParams, type RelayParamsInput } from '../lib/gmxEip712';
import { DIGESTS_GETTER_SELECTOR } from '../lib/relayDigestReadback';
import { RELAY_ROUTER_NONCE_ABI } from '../lib/gmxDataStore';
import { performReadinessRefresh } from '../lib/relayReadinessRefresh';
import {
  getDeploymentVerificationState, __resetDeploymentVerificationForTests,
} from '../lib/relayActivationStatus';

const NEW_ROUTER = '0x517602BaC704B72993997820981603f5E4901273' as Address;
const OLD_ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f' as Address;
const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const SUB = '0x2222222222222222222222222222222222222222' as Address;
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703' as Address;
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;

const MANIFEST_ENV = {
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: NEW_ROUTER,
  GMX_DATA_STORE_ADDRESS: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
  GMX_EVENT_EMITTER_ADDRESS: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
  GMX_CHAIN_ID: '42161',
} as NodeJS.ProcessEnv;

function relayParams(): RelayParamsInput {
  return buildMinimalRelayParams({ feeToken: USDC, feeAmount: 0n, userNonce: 7n, deadline: 1_800_000_000n });
}

function approval(): SubaccountApprovalStruct {
  return {
    subaccount: SUB, shouldAdd: true, expiresAt: 1_900_000_000n, maxAllowedCount: 10n,
    actionType: keccak256(toHex('SUBACCOUNT_ORDER_ACTION')), nonce: 0n, desChainId: 42161n,
    deadline: 1_800_000_000n, integrationId: `0x${'00'.repeat(32)}` as Hex, signature: '0xaa' as Hex,
  };
}

function orderInput() {
  return {
    mainAccount: OWNER, market: MARKET, collateralToken: USDC,
    isLong: true, sizeDeltaUsd: 10n ** 31n, initialCollateralDeltaAmount: 100_000_000n,
    acceptablePrice: 10n ** 22n, executionFee: 10n ** 15n,
  };
}

// ═════════════ §8-1 골든 셀렉터 — 우리 ABI ↔ 신규 artifact ═════════════
describe('6C — 함수 셀렉터 골든 값 (신규 artifact ABI 기준)', () => {
  it('createOrder = 0x3bf1a0d1', () => {
    expect(toFunctionSelector(SUBACCOUNT_CREATE_ORDER_ABI[0])).toBe('0x3bf1a0d1');
  });
  it('removeSubaccount = 0xf6f2900e', () => {
    expect(toFunctionSelector(REMOVE_SUBACCOUNT_ABI[0])).toBe('0xf6f2900e');
  });
  it('digests = 0x01ac4293', () => {
    expect(DIGESTS_GETTER_SELECTOR).toBe('0x01ac4293');
  });
  it('subaccountApprovalNonces = 0x496747d5', () => {
    expect(toFunctionSelector(RELAY_ROUTER_NONCE_ABI[0])).toBe('0x496747d5');
  });
});

// ═════════════ §8-2 canonical EIP-712 문자열 불변 ═════════════
describe('6C — EIP-712 canonical type 문자열 (신규 배포 RelayUtils.sol과 동일)', () => {
  it('CreateOrder 루트/하위 타입 문자열', () => {
    expect(CREATE_ORDER_ROOT_TYPE_STRING).toBe(
      'CreateOrder(address account,CreateOrderAddresses addresses,CreateOrderNumbers numbers,uint256 orderType,uint256 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList,bytes32 relayParams,bytes32 subaccountApproval)',
    );
    expect(CREATE_ORDER_ADDRESSES_TYPE_STRING).toContain('CreateOrderAddresses(address receiver');
    expect(CREATE_ORDER_NUMBERS_TYPE_STRING).toContain('CreateOrderNumbers(uint256 sizeDeltaUsd');
  });
  it('SubaccountApproval/RemoveSubaccount 타입 문자열', () => {
    expect(SUBACCOUNT_APPROVAL_TYPE_STRING).toBe(
      'SubaccountApproval(address subaccount,bool shouldAdd,uint256 expiresAt,uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,uint256 deadline,bytes32 integrationId)',
    );
    expect(REMOVE_SUBACCOUNT_TYPE_STRING).toBe('RemoveSubaccount(address subaccount,bytes32 relayParams)');
  });
});

// ═════════════ §8-3 calldata round-trip decode ═════════════
describe('6C — OPEN/CLOSE/REVOKE calldata round-trip', () => {
  it('OPEN·CLOSE createOrder calldata가 신규 ABI로 정확히 decode된다', () => {
    for (const order of [buildOpenOrderParams(orderInput()), buildCloseOrderParams(orderInput())]) {
      const data = encodeSubaccountCreateOrderCalldata({
        relayParams: relayParams(), relaySignature: '0xbb' as Hex,
        subaccountApproval: approval(), account: OWNER, subaccount: SUB, order,
      });
      expect(data.startsWith('0x3bf1a0d1')).toBe(true);
      const dec = decodeFunctionData({ abi: SUBACCOUNT_CREATE_ORDER_ABI, data });
      expect(dec.functionName).toBe('createOrder');
      const [rp, ap, account, subaccount, params] = dec.args as unknown as [
        { userNonce: bigint; desChainId: bigint }, { subaccount: string }, string, string,
        { numbers: { sizeDeltaUsd: bigint }; addresses: { receiver: string; market: string } },
      ];
      expect(rp.userNonce).toBe(7n);
      expect(rp.desChainId).toBe(42161n);
      expect(ap.subaccount.toLowerCase()).toBe(SUB.toLowerCase());
      expect(account.toLowerCase()).toBe(OWNER.toLowerCase());
      expect(subaccount.toLowerCase()).toBe(SUB.toLowerCase());
      expect(params.addresses.receiver.toLowerCase()).toBe(OWNER.toLowerCase());
      expect(params.addresses.market.toLowerCase()).toBe(MARKET.toLowerCase());
      expect(params.numbers.sizeDeltaUsd).toBe(order.numbers.sizeDeltaUsd);
    }
  });
  it('REVOKE removeSubaccount calldata round-trip', () => {
    const data = encodeRemoveSubaccountCalldata({
      relayParams: relayParams(), relaySignature: '0xcc' as Hex, account: OWNER, subaccount: SUB,
    });
    expect(data.startsWith('0xf6f2900e')).toBe(true);
    const dec = decodeFunctionData({ abi: REMOVE_SUBACCOUNT_ABI, data });
    expect(dec.functionName).toBe('removeSubaccount');
    const [, account, subaccount] = dec.args as unknown as [unknown, string, string];
    expect(account.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(subaccount.toLowerCase()).toBe(SUB.toLowerCase());
  });
});

// ═════════════ §8-4 신/구 router digest 상이 ═════════════
describe('6C — verifyingContract 교체 시 EIP-712 digest 상이 (구 router 서명 불인정)', () => {
  it('CreateOrder digest: 신규 ≠ 구 router', () => {
    const base = {
      chainId: 42161, order: buildOpenOrderParams(orderInput()),
      relayParams: relayParams(), subaccountApproval: approval(), account: OWNER,
    };
    const dNew = computeCreateOrderDigest({ ...base, verifyingContract: NEW_ROUTER });
    const dOld = computeCreateOrderDigest({ ...base, verifyingContract: OLD_ROUTER });
    expect(dNew).not.toBe(dOld);
  });
  it('RemoveSubaccount digest: 신규 ≠ 구 router', () => {
    const base = { chainId: 42161, relayParams: relayParams(), subaccount: SUB };
    expect(computeRemoveSubaccountDigest({ ...base, verifyingContract: NEW_ROUTER }))
      .not.toBe(computeRemoveSubaccountDigest({ ...base, verifyingContract: OLD_ROUTER }));
  });
});

// ═════════════ §8-5 manifest 검증·차단 목록 ═════════════
describe('6C — manifest 대조·차단 목록 (fail-closed)', () => {
  it('OFFICIAL_DOC 상수는 manifest router를 가리키고, 구주소는 차단 목록에 있다', () => {
    expect(GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_OFFICIAL_DOC).toBe(NEW_ROUTER);
    expect(getBlockedAddressReason(GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_LEGACY_BLOCKED)).toBeTruthy();
    expect(GMX_BLOCKED_ADDRESSES.size).toBeGreaterThanOrEqual(15);
  });
  it('manifest 일치 env → ok (대소문자 무시)', () => {
    expect(validateEnvAgainstManifest(MANIFEST_ENV).ok).toBe(true);
    const lower = Object.fromEntries(
      Object.entries(MANIFEST_ENV).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('0x') ? v.toLowerCase() : v]),
    ) as NodeJS.ProcessEnv;
    expect(validateEnvAgainstManifest(lower).ok).toBe(true);
  });
  it('미설정·형식 오류·불일치·차단 주소 전부 거부', () => {
    expect(validateEnvAgainstManifest({} as NodeJS.ProcessEnv).ok).toBe(false);
    expect(validateEnvAgainstManifest({ ...MANIFEST_ENV, GMX_DATA_STORE_ADDRESS: 'nope' }).ok).toBe(false);
    expect(validateEnvAgainstManifest({ ...MANIFEST_ENV, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: OLD_ROUTER }).ok).toBe(false);
    // Avalanche router
    const r = validateEnvAgainstManifest({
      ...MANIFEST_ENV, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: '0xa62BD1cFE2066c5bF4180b4125BBb5116eEA26c9',
    });
    expect(r.ok).toBe(false);
    expect(r.mismatches.join(' ')).toContain('차단 주소');
    // chainId 불일치
    expect(validateEnvAgainstManifest({ ...MANIFEST_ENV, GMX_CHAIN_ID: '43114' }).ok).toBe(false);
  });
  it('resolveGmxLiveRelayConfig도 차단 주소를 거부한다 (구 router·Avalanche)', () => {
    for (const bad of [OLD_ROUTER, '0xa62BD1cFE2066c5bF4180b4125BBb5116eEA26c9']) {
      const r = resolveGmxLiveRelayConfig({ ...MANIFEST_ENV, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: bad } as NodeJS.ProcessEnv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(' ')).toContain('차단 주소');
    }
    expect(resolveGmxLiveRelayConfig(MANIFEST_ENV).ok).toBe(true);
  });
});

// ═════════════ §8-6 activation gate — manifest·배포검증 필수 ═════════════
describe('6C — activation gate manifest·deploymentVerified 조건', () => {
  const FULL_ENV = {
    WORKER_ENGINE_MODE: 'LIVE', LIVE_TEST_EXECUTION_LOCKED: 'false',
    DELEGATED_SIGNER_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true',
    GMX_RELAY_NETWORK_ENABLED: 'true', GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
    GMX_RELAY_MODE: 'LIVE', ...MANIFEST_ENV,
  } as NodeJS.ProcessEnv;
  function input(overrides?: Partial<ActivationGateInput>): ActivationGateInput {
    return {
      env: FULL_ENV, liveTestMode: true, signerInitialized: true, canonicalAuthorized: true,
      emergencyStopActive: false, dbOk: true, rpcOk: true, reconciliationComplete: true,
      blockingIntentCount: 0, activeRevokeInProgress: false, freshLiveFeeQuote: true,
      currentChainId: 42161, gmxConfigOk: true, deploymentVerified: true, kind: 'OPEN',
      ...overrides,
    };
  }
  it('전 조건 충족 → eligible', () => {
    expect(evaluateActivationGate(input()).networkEligible).toBe(true);
  });
  it('env router가 구주소 → manifest 사유로 차단', () => {
    const g = evaluateActivationGate(input({
      env: { ...FULL_ENV, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: OLD_ROUTER } as NodeJS.ProcessEnv,
    }));
    expect(g.networkEligible).toBe(false);
    expect(g.missing.join(' ')).toContain('manifest');
  });
  it('deploymentVerified=false → 차단', () => {
    const g = evaluateActivationGate(input({ deploymentVerified: false }));
    expect(g.networkEligible).toBe(false);
    expect(g.missing.join(' ')).toContain('배포 코드 존재 검증');
  });
});

// ═════════════ §8-7 submit transport target 강제 ═════════════
describe('6C — Gelato transport: target ≠ manifest router → fetch 0회 차단', () => {
  const SUBMIT_ENV = {
    GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', GMX_RELAY_NETWORK_ENABLED: 'true',
    GMX_RELAY_SUBMISSION_ENABLED: 'true', GMX_RELAY_MODE: 'LIVE',
    [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
  } as NodeJS.ProcessEnv;
  beforeEach(() => { vi.restoreAllMocks(); });
  it('구 router·타 체인 router target은 제출 차단 (네트워크 발신 0회)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const t = createGelatoHttpTransport(SUBMIT_ENV);
    for (const target of [OLD_ROUTER, '0xa62BD1cFE2066c5bF4180b4125BBb5116eEA26c9', '0x3333333333333333333333333333333333333333']) {
      const r = await t.submitRelayTask({ chainId: 42161, target, packedData: '0xdeadbeef11' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe('config');
        expect(r.ambiguous).toBe(false);
        expect(r.message).not.toContain('test-key-not-real'); // Secret 비노출
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ═════════════ §8-8 배포 코드 존재 검증 (readiness refresh) ═════════════
describe('6C — verifyDeployment: 코드 존재·decode·chainId (읽기 전용)', () => {
  beforeEach(() => { __resetDeploymentVerificationForTests(); });

  const READY_ENV = { GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', ...MANIFEST_ENV } as NodeJS.ProcessEnv;
  function deps(client: Parameters<typeof performReadinessRefresh>[0]['readonlyClient'], env = READY_ENV) {
    return {
      env,
      checkCanonical: async () => ({ confirmed: true, reason: null }),
      listOpenTaskIds: async () => [] as { id: string; relayTaskId: string | null; transportGen: string }[],
      countAllocatedNonces: async () => 0,
      transport: {
        getRelayTaskStatus: async () => ({ ok: true as const, statusCode: 200 as const, transactionHash: null, blockNumber: null }),
        getSponsorBalance: async () => ({ ok: true as const, balance: 10n ** 18n, decimals: 18, unit: 'wei' }),
      },
      readonlyClient: client,
      nowMs: () => 9000,
    };
  }
  const goodClient = () => ({
    getCode: async () => '0x6080deadbeef' as `0x${string}`,
    getChainId: async () => 42161,
    getGasPrice: async () => 100_000_000n,
    readContract: async (args: { functionName: string }) =>
      args.functionName === 'digests' ? false : 0n,
  });

  it('정상 경로: 코드 존재+decode+chainId+manifest 일치 → ok 스냅샷 저장', async () => {
    await performReadinessRefresh(deps(goodClient()));
    const dv = getDeploymentVerificationState();
    expect(dv.attempted).toBe(true);
    expect(dv.ok).toBe(true);
    expect(dv.manifestVersion).toBe(GMX_DEPLOYMENT_MANIFEST.manifestVersion);
    expect(dv.atMs).toBe(9000);
  });
  it('empty bytecode → fail-closed', async () => {
    await performReadinessRefresh(deps({ ...goodClient(), getCode: async () => '0x' as `0x${string}` }));
    const dv = getDeploymentVerificationState();
    expect(dv.ok).toBe(false);
    expect(dv.failures.join(' ')).toContain('empty bytecode');
  });
  it('chainId 불일치 → fail-closed', async () => {
    await performReadinessRefresh(deps({ ...goodClient(), getChainId: async () => 43114 }));
    expect(getDeploymentVerificationState().ok).toBe(false);
  });
  it('decode 실패(digests가 bool 아님) → fail-closed', async () => {
    await performReadinessRefresh(deps({ ...goodClient(), readContract: async () => 'garbage' as never }));
    const dv = getDeploymentVerificationState();
    expect(dv.ok).toBe(false);
    expect(dv.failures.join(' ')).toContain('decode');
  });
  it('read 예외 → fail-closed (RPC URL 등 비노출)', async () => {
    await performReadinessRefresh(deps({
      ...goodClient(),
      readContract: async () => { throw new Error('https://rpc.example/SECRETKEY'); },
    }));
    const dv = getDeploymentVerificationState();
    expect(dv.ok).toBe(false);
    expect(JSON.stringify(dv)).not.toContain('SECRETKEY');
  });
  it('env가 manifest와 불일치 → 코드가 있어도 fail-closed', async () => {
    await performReadinessRefresh(deps(goodClient(), {
      ...READY_ENV, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: OLD_ROUTER,
    } as NodeJS.ProcessEnv));
    expect(getDeploymentVerificationState().ok).toBe(false);
  });
  it('read-only 비활성 → RPC 0회 + 검증 fail-closed 기록', async () => {
    const spy = vi.fn();
    await performReadinessRefresh(deps(
      { getCode: spy, getChainId: spy, readContract: spy, getGasPrice: spy } as never,
      { ...MANIFEST_ENV } as NodeJS.ProcessEnv, // readonly 플래그 없음
    ));
    expect(spy).not.toHaveBeenCalled();
    const dv = getDeploymentVerificationState();
    expect(dv.attempted).toBe(true);
    expect(dv.ok).toBe(false);
  });
});
