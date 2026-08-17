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
import type { RelayTransport } from './relayTransport';
import {
  isRelayReadonlyNetworkEnabled, recordReadinessRefresh, recordDeploymentVerification,
  type ReadinessRefreshState,
} from './relayActivationStatus';
import { GMX_DEPLOYMENT_MANIFEST, validateEnvAgainstManifest } from './gmxDeploymentManifest';
import { DIGESTS_GETTER_SELECTOR } from './relayDigestReadback';
import type { RelayReadonlyClient } from './relayReadonlyClient';

export interface ReadinessRefreshDeps {
  env: NodeJS.ProcessEnv;
  /** canonical authorization 읽기 (read-only eth_call). 게이트는 호출측 checkCanonical이 이미 포함 */
  checkCanonical(): Promise<{ confirmed: boolean; reason: string | null }>;
  /** DB read — 미종결 task 중 Gelato taskId가 있는 것들 */
  listOpenTaskIds(): Promise<{ id: string; relayTaskId: string | null }[] | null>;
  /** DB read — nonce 상태 요약 (신규 할당 없음) */
  countAllocatedNonces(): Promise<number | null>;
  /** 읽기 전용 GET 전용 transport (없으면 GET 생략) — POST submit은 호출하지 않는다 */
  transport: Pick<RelayTransport, 'quoteRelayFee' | 'getRelayTaskStatus'> | null;
  /** 6C §7 — 배포 코드 존재 검증용 read-only RPC client (없으면 검증 fail-closed 기록) */
  readonlyClient: Pick<RelayReadonlyClient, 'getCode' | 'getChainId' | 'readContract'> | null;
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

  // 3) 기존 task의 Gelato status GET (존재하는 taskId만 — 생성·재제출 없음)
  let open: { id: string; relayTaskId: string | null }[] | null = null;
  try { open = await deps.listOpenTaskIds(); } catch { open = null; }
  if (open === null) {
    failures.push('relay task 조회 실패 (fail-closed)');
  } else {
    const withTaskId = open.filter((t) => t.relayTaskId);
    basis.push(`미종결 relay task ${open.length}건 (taskId 보유 ${withTaskId.length}건)`);
    if (deps.transport) {
      for (const t of withTaskId) {
        try {
          const st = await deps.transport.getRelayTaskStatus({ taskId: t.relayTaskId as string });
          if (st.ok) basis.push(`task ${t.id}: Gelato ${st.taskState}`);
          else failures.push(`task ${t.id}: status 조회 실패(${st.kind})`);
        } catch {
          failures.push(`task ${t.id}: status 조회 예외 (fail-closed)`);
        }
      }
    } else if (withTaskId.length > 0) {
      failures.push('transport 비활성 — Gelato status 재수집 불가');
    }
  }

  // 4) Gelato fee oracle GET (읽기 전용 — 어떤 제출 근거로도 사용하지 않음)
  if (deps.transport) {
    try {
      const quote = await deps.transport.quoteRelayFee({
        chainId: 42161,
        paymentToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH (읽기 전용 조회 파라미터)
        gasLimit: 3_000_000n,
      });
      if (quote.ok) basis.push('Gelato fee oracle 조회 성공');
      else {
        // 6E-8 §3·§6 — httpStatus는 정수일 때만 표시; upstream 본문·문자열 미노출.
        // 5xx는 외부 서비스 일시 장애로 분류하되 activation 차단(fail-closed)은 동일 유지.
        const status = 'httpStatus' in quote && Number.isInteger(quote.httpStatus) ? (quote.httpStatus as number) : null;
        if (status !== null && status >= 500) failures.push(`fee oracle 조회 실패 (외부 fee oracle 일시 장애 — HTTP ${status})`);
        else if (status !== null) failures.push(`fee oracle 조회 실패 (http: HTTP ${status})`);
        else failures.push(`fee oracle 조회 실패(${quote.kind})`);
      }
    } catch {
      failures.push('fee oracle 조회 예외 (fail-closed)');
    }
  } else {
    failures.push('transport 비활성 — fee oracle 조회 불가');
  }

  const state = { atMs: deps.nowMs(), ok: failures.length === 0, basis, failures };
  recordReadinessRefresh(state);
  return { attempted: true, ...state };
}
