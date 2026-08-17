/**
 * relayReadinessRefresh — 6단계 §7: 명시적 읽기 전용 readiness 갱신.
 *
 * 운영자 인증이 적용된 POST /executor/relay/readiness/refresh 에서만 호출된다.
 * 허용 작업 (전부 읽기 전용):
 *  - canonical subaccount authorization 조회 (eth_call)
 *  - digest/nonce 상태 조회 (DB read)
 *  - 기존 relay task의 Gelato status GET
 *  - Gelato fee oracle GET
 * 금지 (이 모듈은 해당 능력 자체를 주입받지 않는다):
 *  - signer 접근, approval/revoke 서명, nonce 신규 할당,
 *    execution intent/relay task 생성, sponsored-call POST, 주문 생성, 자동 재제출
 *
 * 결과는 relayActivationStatus의 readiness refresh 상태(최신 시각+근거)로만
 * 저장된다. 조회 실패는 fail-closed(ok=false)로 기록한다.
 */

import { decodeAbiParameters } from 'viem';
import type { RelayReadonlyTransport } from './relayTransport';
import {
  isRelayReadonlyNetworkEnabled, recordReadinessRefresh, recordDeploymentVerification,
  recordFeeEstimateState, recordSponsorBalanceState,
  type ReadinessRefreshState,
} from './relayActivationStatus';
import { fetchGmxFeeEstimateInputs } from './gmxFeeEstimate';
import { GMX_DEPLOYMENT_MANIFEST, validateEnvAgainstManifest } from './gmxDeploymentManifest';
import { DIGESTS_GETTER_SELECTOR } from './relayDigestReadback';
import type { RelayReadonlyClient } from './relayReadonlyClient';

export interface ReadinessRefreshDeps {
  env: NodeJS.ProcessEnv;
  /** canonical authorization 읽기 (read-only eth_call). 게이트는 호출측 checkCanonical이 이미 포함 */
  checkCanonical(): Promise<{ confirmed: boolean; reason: string | null }>;
  /** DB read — 미종결 task 중 Gelato taskId가 있는 것들 (transport 세대 포함) */
  listOpenTaskIds(): Promise<{ id: string; relayTaskId: string | null; transportGen: string }[] | null>;
  /** DB read — nonce 상태 요약 (신규 할당 없음) */
  countAllocatedNonces(): Promise<number | null>;
  /** 읽기 전용 transport (없으면 조회 생략) — submit 능력은 구조적으로 없다 (§4) */
  transport: Pick<RelayReadonlyTransport, 'getRelayTaskStatus' | 'getSponsorBalance'> | null;
  /** 6C §7 — 배포 코드 존재 검증 + §6 fee estimate 입력용 read-only RPC client */
  readonlyClient: Pick<RelayReadonlyClient, 'getCode' | 'getChainId' | 'readContract' | 'getGasPrice'> | null;
  nowMs(): number;
}

/**
 * 6C §7 — 배포 코드 존재 검증 (읽기 전용 refresh 활성 시에만 호출).
 * 조회 실패·empty bytecode·decode 실패·manifest 불일치·chainId 불일치 전부
 * failures로 기록 → ok=false (activation 차단 근거).
 */
async function verifyDeployment(
  deps: Pick<ReadinessRefreshDeps, 'env' | 'readonlyClient' | 'nowMs'>,
): Promise<void> {
  const basis: string[] = [];
  const failures: string[] = [];
  const env = deps.env;

  // 1) env 주소 ↔ manifest 대조 (자동 대입 없음 — env 필수)
  const mv = validateEnvAgainstManifest(env);
  if (mv.ok) basis.push(`env 주소가 manifest v${GMX_DEPLOYMENT_MANIFEST.manifestVersion} 감사 주소와 일치`);
  else failures.push(...mv.mismatches);

  const client = deps.readonlyClient;
  if (!client) {
    failures.push('read-only RPC client 미생성 — 코드 존재 검증 불가 (fail-closed)');
  } else {
    // 2) chainId 42161
    try {
      const cid = await client.getChainId();
      if (cid === GMX_DEPLOYMENT_MANIFEST.chainId) basis.push('chainId 42161 확인');
      else failures.push(`chainId ${cid} ≠ 42161 — 차단 (fail-closed)`);
    } catch { failures.push('chainId 조회 실패 (fail-closed)'); }

    // 3) configured 주소별 eth_getCode 비어있지 않음
    const targets: [string, string | undefined][] = [
      ['SubaccountGelatoRelayRouter', env.GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS],
      ['DataStore', env.GMX_DATA_STORE_ADDRESS],
      ['EventEmitter', env.GMX_EVENT_EMITTER_ADDRESS],
    ];
    for (const [label, addr] of targets) {
      const a = (addr ?? '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { failures.push(`${label} env 미설정/형식 오류 — getCode 생략 (fail-closed)`); continue; }
      try {
        const code = await client.getCode({ address: a as `0x${string}` });
        if (code && code !== '0x' && code.length > 2) basis.push(`${label} 코드 존재 확인`);
        else failures.push(`${label} 주소에 코드 없음 (empty bytecode) — 차단 (fail-closed)`);
      } catch { failures.push(`${label} getCode 조회 실패 (fail-closed)`); }
    }

    // 4) Router digests(bytes32(0)) read가 bool로 정상 decode
    const router = (env.GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS ?? '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(router)) {
      try {
        const r = await client.readContract({
          address: router as `0x${string}`,
          abi: [{ type: 'function', name: 'digests', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }],
          functionName: 'digests',
          args: ['0x' + '0'.repeat(64)],
        });
        if (typeof r === 'boolean') basis.push(`digests(bytes32) decode 정상 (selector ${DIGESTS_GETTER_SELECTOR})`);
        else failures.push('digests(bytes32) 반환값이 bool로 decode되지 않음 — 차단 (fail-closed)');
      } catch { failures.push('digests(bytes32) read 실패 — 차단 (fail-closed)'); }
    }

    // 5) DataStore read (getUint(bytes32(0)))가 uint256으로 정상 decode
    const ds = (env.GMX_DATA_STORE_ADDRESS ?? '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(ds)) {
      try {
        const r = await client.readContract({
          address: ds as `0x${string}`,
          abi: [{ type: 'function', name: 'getUint', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] }],
          functionName: 'getUint',
          args: ['0x' + '0'.repeat(64)],
        });
        if (typeof r === 'bigint') basis.push('DataStore.getUint decode 정상');
        else failures.push('DataStore.getUint 반환값이 uint256으로 decode되지 않음 — 차단 (fail-closed)');
      } catch { failures.push('DataStore read 실패 — 차단 (fail-closed)'); }
    }
  }

  recordDeploymentVerification({
    atMs: deps.nowMs(), ok: failures.length === 0,
    manifestVersion: GMX_DEPLOYMENT_MANIFEST.manifestVersion,
    basis, failures,
  });
}

export async function performReadinessRefresh(deps: ReadinessRefreshDeps): Promise<ReadinessRefreshState> {
  const basis: string[] = [];
  const failures: string[] = [];

  if (!isRelayReadonlyNetworkEnabled(deps.env)) {
    // read-only 네트워크 비활성: 어떤 외부 읽기도 수행하지 않는다 (fail-closed)
    // 배포 코드 존재 검증도 수행하지 않고 fail-closed로만 기록한다 (RPC 0회).
    recordDeploymentVerification({
      atMs: deps.nowMs(), ok: false, manifestVersion: GMX_DEPLOYMENT_MANIFEST.manifestVersion,
      basis: [], failures: ["GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true' — 코드 존재 검증 불가 (외부 읽기 0회)"],
    });
    const state = {
      atMs: deps.nowMs(), ok: false, basis,
      failures: ["GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true' — 읽기 전용 갱신 불가 (외부 읽기 0회)"],
    };
    recordReadinessRefresh(state);
    return { attempted: true, ...state };
  }

  // 6C §7 — 배포 코드 존재 검증 (읽기 전용; 결과는 저장 스냅샷으로만)
  try { await verifyDeployment(deps); } catch {
    recordDeploymentVerification({
      atMs: deps.nowMs(), ok: false, manifestVersion: GMX_DEPLOYMENT_MANIFEST.manifestVersion,
      basis: [], failures: ['배포 코드 존재 검증 예외 (fail-closed)'],
    });
  }

  // 1) canonical authorization readback (eth_call)
  try {
    const canonical = await deps.checkCanonical();
    if (canonical.confirmed) basis.push('canonical readback 성공');
    else if ((canonical.reason ?? '').includes('delegated signer 미초기화')) {
      // 6E-8 §4 — 시스템 고장이 아닌 의도된 차단임을 구분 표기 (여전히 fail-closed 근거)
      failures.push('canonical readback 생략: delegated signer 미초기화 (예상된 fail-closed)');
    } else failures.push(`canonical readback 미확인: ${canonical.reason ?? '불명'}`);
  } catch {
    failures.push('canonical readback 예외 (fail-closed)');
  }

  // 2) digest/nonce 상태 조회 (DB read — 신규 할당 없음).
  // 예외 throw도 fail-closed 기록으로 흡수한다 (상태 저장 없이 500으로 새지 않게).
  let nonces: number | null = null;
  try { nonces = await deps.countAllocatedNonces(); } catch { nonces = null; }
  if (nonces === null) failures.push('nonce 상태 조회 실패 (fail-closed)');
  else basis.push(`할당된 userNonce ${nonces}건 (신규 할당 없음)`);

  // 3) 기존 task의 Gelato status 조회 — 신형(jsonrpc) 세대만. legacy 세대는
  //    신형 endpoint 조회 금지(§3) → UNRESOLVED_LEGACY_TRANSPORT 분류만 기록.
  let open: { id: string; relayTaskId: string | null; transportGen: string }[] | null = null;
  try { open = await deps.listOpenTaskIds(); } catch { open = null; }
  if (open === null) {
    failures.push('relay task 조회 실패 (fail-closed)');
  } else {
    const withTaskId = open.filter((t) => t.relayTaskId);
    const legacy = withTaskId.filter((t) => t.transportGen !== 'jsonrpc-gasless-0.0.10');
    const modern = withTaskId.filter((t) => t.transportGen === 'jsonrpc-gasless-0.0.10');
    basis.push(`미종결 relay task ${open.length}건 (taskId 보유 ${withTaskId.length}건)`);
    for (const t of legacy) {
      failures.push(`task ${t.id}: legacy transport 세대(${t.transportGen}) — 신형 조회 금지, UNRESOLVED_LEGACY_TRANSPORT (운영자 조사·자동 재제출 금지)`);
    }
    if (deps.transport) {
      for (const t of modern) {
        try {
          const st = await deps.transport.getRelayTaskStatus({ taskId: t.relayTaskId as string });
          if (st.ok) basis.push(`task ${t.id}: Gelato StatusCode ${st.statusCode}`);
          else failures.push(`task ${t.id}: status 조회 실패(${st.kind})`);
        } catch {
          failures.push(`task ${t.id}: status 조회 예외 (fail-closed)`);
        }
      }
    } else if (modern.length > 0) {
      failures.push('transport 비활성 — Gelato status 재수집 불가');
    }
  }

  // 4) 6F-2 §6 — GMX 공식 fee estimate 입력 (eth_gasPrice + DataStore multiplier;
  //    읽기 전용, Gelato fee oracle 사용 안 함)
  {
    const feeBasis: string[] = [];
    const feeFailures: string[] = [];
    const ds = (deps.env.GMX_DATA_STORE_ADDRESS ?? '').trim();
    if (!deps.readonlyClient) {
      feeFailures.push('read-only RPC client 미생성 — fee estimate 입력 조회 불가 (fail-closed)');
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(ds)) {
      feeFailures.push('GMX_DATA_STORE_ADDRESS 미설정/형식 오류 — multiplier 조회 불가 (fail-closed)');
    } else {
      try {
        const inputs = await fetchGmxFeeEstimateInputs({ client: deps.readonlyClient, dataStore: ds as `0x${string}` });
        if (inputs.ok) feeBasis.push('GMX fee estimate 입력 확보 (eth_gasPrice + gelatoRelayFeeMultiplierFactor)');
        else feeFailures.push(inputs.reason);
      } catch {
        feeFailures.push('fee estimate 입력 조회 예외 (fail-closed)');
      }
    }
    recordFeeEstimateState({ atMs: deps.nowMs(), ok: feeFailures.length === 0, basis: feeBasis, failures: feeFailures });
    basis.push(...feeBasis);
    failures.push(...feeFailures);
  }

  // 5) 6F-2 §10 — sponsor balance (gelato_getBalance, 읽기 전용; key 없으면 fetch 0회)
  {
    const sbBasis: string[] = [];
    let sbStatus: 'verified' | 'unverified' | 'insufficient' = 'unverified';
    if (!deps.transport) {
      sbBasis.push('transport 비활성 — sponsor balance 조회 불가 (unverified)');
      failures.push('transport 비활성 — sponsor balance 조회 불가');
    } else {
      try {
        const bal = await deps.transport.getSponsorBalance();
        if (bal.ok) {
          sbStatus = bal.balance > 0n ? 'verified' : 'insufficient';
          sbBasis.push(`sponsor balance 조회 성공 — ${sbStatus} (unit ${bal.unit})`);
          if (sbStatus === 'insufficient') failures.push('sponsor balance 0 — insufficient');
        } else {
          sbBasis.push(`sponsor balance 조회 실패(${bal.kind}) — unverified`);
          failures.push(`sponsor balance 조회 실패(${bal.kind})`);
        }
      } catch {
        sbBasis.push('sponsor balance 조회 예외 — unverified');
        failures.push('sponsor balance 조회 예외 (fail-closed)');
      }
    }
    recordSponsorBalanceState({ atMs: deps.nowMs(), status: sbStatus, basis: sbBasis });
    basis.push(...sbBasis.filter((b) => b.includes('성공')));
  }

  const state = { atMs: deps.nowMs(), ok: failures.length === 0, basis, failures };
  recordReadinessRefresh(state);
  return { attempted: true, ...state };
}
