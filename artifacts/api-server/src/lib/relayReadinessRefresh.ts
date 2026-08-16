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

import type { RelayTransport } from './relayTransport';
import { isRelayReadonlyNetworkEnabled, recordReadinessRefresh, type ReadinessRefreshState } from './relayActivationStatus';

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
  nowMs(): number;
}

export async function performReadinessRefresh(deps: ReadinessRefreshDeps): Promise<ReadinessRefreshState> {
  const basis: string[] = [];
  const failures: string[] = [];

  if (!isRelayReadonlyNetworkEnabled(deps.env)) {
    // read-only 네트워크 비활성: 어떤 외부 읽기도 수행하지 않는다 (fail-closed)
    const state = {
      atMs: deps.nowMs(), ok: false, basis,
      failures: ["GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true' — 읽기 전용 갱신 불가 (외부 읽기 0회)"],
    };
    recordReadinessRefresh(state);
    return { attempted: true, ...state };
  }

  // 1) canonical authorization readback (eth_call)
  try {
    const canonical = await deps.checkCanonical();
    if (canonical.confirmed) basis.push('canonical readback 성공');
    else failures.push(`canonical readback 미확인: ${canonical.reason ?? '불명'}`);
  } catch {
    failures.push('canonical readback 예외 (fail-closed)');
  }

  // 2) digest/nonce 상태 조회 (DB read — 신규 할당 없음)
  const nonces = await deps.countAllocatedNonces();
  if (nonces === null) failures.push('nonce 상태 조회 실패 (fail-closed)');
  else basis.push(`할당된 userNonce ${nonces}건 (신규 할당 없음)`);

  // 3) 기존 task의 Gelato status GET (존재하는 taskId만 — 생성·재제출 없음)
  const open = await deps.listOpenTaskIds();
  if (open === null) {
    failures.push('relay task 조회 실패 (fail-closed)');
  } else {
    const withTaskId = open.filter((t) => t.relayTaskId);
    basis.push(`미종결 relay task ${open.length}건 (taskId 보유 ${withTaskId.length}건)`);
    if (deps.transport) {
      for (const t of withTaskId) {
        const st = await deps.transport.getRelayTaskStatus({ taskId: t.relayTaskId as string });
        if (st.ok) basis.push(`task ${t.id}: Gelato ${st.taskState}`);
        else failures.push(`task ${t.id}: status 조회 실패(${st.kind})`);
      }
    } else if (withTaskId.length > 0) {
      failures.push('transport 비활성 — Gelato status 재수집 불가');
    }
  }

  // 4) Gelato fee oracle GET (읽기 전용 — 어떤 제출 근거로도 사용하지 않음)
  if (deps.transport) {
    const quote = await deps.transport.quoteRelayFee({
      chainId: 42161,
      paymentToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH (읽기 전용 조회 파라미터)
      gasLimit: 3_000_000n,
    });
    if (quote.ok) basis.push('Gelato fee oracle 조회 성공');
    else failures.push(`fee oracle 조회 실패(${quote.kind})`);
  } else {
    failures.push('transport 비활성 — fee oracle 조회 불가');
  }

  const state = { atMs: deps.nowMs(), ok: failures.length === 0, basis, failures };
  recordReadinessRefresh(state);
  return { attempted: true, ...state };
}
