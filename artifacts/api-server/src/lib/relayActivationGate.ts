/**
 * relayActivationGate — 실제 transport 호출 활성화 이중 게이트 (4단계 §4).
 *
 * 실제 Gelato transport 호출은 아래 조건이 **전부** 충족될 때만 후보가 된다.
 * 하나라도 빠지면 transport 호출 0회. 이번 단계에서는 활성화 환경변수를
 * 실제로 설정하지 않으므로 항상 비활성이다.
 */

export interface ActivationGateInput {
  env: NodeJS.ProcessEnv;
  liveTestMode: boolean;            // server liveTestMode=true
  signerInitialized: boolean;
  canonicalAuthorized: boolean;     // AUTHORIZED 또는 유효한 첫-action approval(READY 세션+canonical nonce 일치)
  emergencyStopActive: boolean;
  dbOk: boolean;
  rpcOk: boolean;
  reconciliationComplete: boolean;
  blockingIntentCount: number;
  activeRevokeInProgress: boolean;  // revoke 진행 중 신규 주문 차단 (REVOKE 자체 제출은 별도 판단)
  freshLiveFeeQuote: boolean;       // 실제(live) quote가 신선하게 검증됨 — mock 불인정
  currentChainId: number | null;
  gmxConfigOk: boolean;             // 모든 GMX public config 해석 성공
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
}

export interface ActivationGateResult {
  networkEligible: boolean;
  missing: string[];
}

export function evaluateActivationGate(input: ActivationGateInput): ActivationGateResult {
  const missing: string[] = [];
  const env = input.env;

  if (env.WORKER_ENGINE_MODE !== 'LIVE') missing.push("WORKER_ENGINE_MODE !== 'LIVE'");
  if (env.LIVE_TEST_EXECUTION_LOCKED !== 'false') missing.push("LIVE_TEST_EXECUTION_LOCKED !== 'false'");
  if (!input.liveTestMode) missing.push('server liveTestMode 아님');
  if (env.DELEGATED_SIGNER_ENABLED !== 'true') missing.push("DELEGATED_SIGNER_ENABLED !== 'true'");
  if (!input.signerInitialized) missing.push('signer 미초기화');
  if (!input.canonicalAuthorized) missing.push('canonical AUTHORIZED/유효한 첫-action approval 아님');
  if (input.emergencyStopActive) missing.push('Emergency Stop 활성');
  if (!input.dbOk) missing.push('DB 비정상');
  if (!input.rpcOk) missing.push('RPC 비정상');
  if (!input.reconciliationComplete) missing.push('reconciliation 미완료');
  if (input.blockingIntentCount !== 0) missing.push(`blocking intent ${input.blockingIntentCount}건`);
  if (input.activeRevokeInProgress && input.kind !== 'REVOKE') missing.push('revoke 진행 중 — 신규 주문 차단');
  if (!input.freshLiveFeeQuote) missing.push('fresh live fee quote 없음 (mock 불인정)');
  if (input.currentChainId !== 42161) missing.push(`chainId ${input.currentChainId ?? '미확인'} ≠ 42161`);
  if (!input.gmxConfigOk) missing.push('GMX public config 미해결');
  if (env.GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true') missing.push("GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true'");
  if (env.GMX_RELAY_SUBMISSION_ENABLED !== 'true') missing.push("GMX_RELAY_SUBMISSION_ENABLED !== 'true'");
  if (env.GMX_RELAY_NETWORK_ENABLED !== 'true') missing.push("GMX_RELAY_NETWORK_ENABLED !== 'true'");
  if ((env.GMX_RELAY_MODE ?? '').toUpperCase() !== 'LIVE') missing.push("GMX_RELAY_MODE !== 'LIVE'");

  return { networkEligible: missing.length === 0, missing };
}
