/**
 * relayAdapter — Gelato relay 제출 어댑터 (3단계: 강제 DRY-RUN).
 *
 * 모드:
 *  - DISABLED(기본): 어떤 relay 경로도 수행하지 않음.
 *  - DRY_RUN: 조립·검증·durable 기록까지만. 외부 호출 0회.
 *  - LIVE: **이번 단계에서 활성 불가** — env가 LIVE여도 어댑터가 거부한다.
 *
 * 게이트 (전부 통과해야 DRY_RUN 수행; LIVE는 어떤 경우에도 제출 안 함):
 *  - GMX_RELAY_SUBMISSION_ENABLED === 'true' (그 외 어떤 값도 후보 아님)
 *  - GMX_RELAY_MODE ∈ {DRY_RUN} (미설정·DISABLED → 차단)
 *  - engineMode가 PAPER면 외부 relay 경로 진입 금지 (dry-run 계산은 허용하되 제출 후보 아님)
 *  - LIVE_TEST_EXECUTION_LOCKED → 차단
 *  - delegated signer 비활성 → 차단
 *  - canonical 온체인 상태 미확인 → 차단
 *  - 활성 REVOKE 세션 존재 → 신규 주문 차단
 *
 * 민감정보(서명 전문·개인키·암호문·API key·RPC URL)는 어떤 출력에도 포함하지 않는다.
 */

import type { AssembledRelayCall } from './relayOrderAssembly';
import { validateFeeQuote, type RelayFeeQuote } from './relayFeeQuote';

export type RelayMode = 'DISABLED' | 'DRY_RUN' | 'LIVE';

/** env에서 모드 결정 — LIVE는 이번 단계에서 절대 반환하지 않는다(요청 시 DISABLED 강등+사유) */
export function resolveRelayMode(env: NodeJS.ProcessEnv = process.env): {
  mode: RelayMode; requestedLive: boolean; reasons: string[];
} {
  const reasons: string[] = [];
  const enabled = env.GMX_RELAY_SUBMISSION_ENABLED === 'true';
  const raw = (env.GMX_RELAY_MODE ?? 'DISABLED').toUpperCase();
  const requestedLive = raw === 'LIVE';

  if (!enabled) {
    reasons.push("GMX_RELAY_SUBMISSION_ENABLED !== 'true' — relay 경로 비활성");
    return { mode: 'DISABLED', requestedLive, reasons };
  }
  if (requestedLive) {
    reasons.push('LIVE relay 제출은 이번 단계에서 구조적으로 비활성 — DISABLED로 강등');
    return { mode: 'DISABLED', requestedLive, reasons };
  }
  if (raw === 'DRY_RUN') return { mode: 'DRY_RUN', requestedLive: false, reasons };
  reasons.push(`GMX_RELAY_MODE=${raw} — DRY_RUN만 허용`);
  return { mode: 'DISABLED', requestedLive, reasons };
}

export interface RelayGateInput {
  engineMode: string;                 // 'PAPER' | 'LIVE_TEST' ...
  liveTestLocked: boolean;
  signerActive: boolean;
  canonicalConfirmed: boolean;        // canonical 온체인 조회 성공 여부
  activeRevokeSession: boolean;       // revoke 준비 중이면 신규 주문 차단
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
}

export interface RelayGateResult {
  allowed: boolean;                   // DRY_RUN 수행(기록 포함) 가능 여부
  externalCallBudget: 0;              // 이번 단계 상수 0 — 어떤 경로도 외부 호출 불가
  blockReasons: string[];
}

export function evaluateRelayGate(mode: RelayMode, input: RelayGateInput): RelayGateResult {
  const blockReasons: string[] = [];
  if (mode === 'DISABLED') blockReasons.push('relay 모드 DISABLED');
  if (mode === 'LIVE') blockReasons.push('LIVE 모드는 이번 단계에서 존재할 수 없음 — 차단');
  if (input.engineMode === 'PAPER') blockReasons.push('PAPER 모드 — 외부 relay 경로 금지');
  if (input.liveTestLocked) blockReasons.push('LIVE_TEST_EXECUTION_LOCKED — 실행 잠금');
  if (!input.signerActive) blockReasons.push('delegated signer 비활성');
  if (!input.canonicalConfirmed) blockReasons.push('canonical 온체인 상태 미확인');
  if (input.activeRevokeSession && input.kind !== 'REVOKE') {
    blockReasons.push('REVOKE 준비 중 — 신규 주문 relay 차단');
  }
  return { allowed: blockReasons.length === 0, externalCallBudget: 0, blockReasons };
}

export interface DryRunResult {
  ok: boolean;
  mode: RelayMode;
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
  calldataHash: string | null;
  packedPayloadHash: string | null;
  relayParamsHash: string | null;
  structHash: string | null;
  signingDigest: string | null;      // digest는 공개값(서명 전문 아님)
  signerRole: 'delegated' | 'owner' | null;
  actionCount: number | null;
  feeToken: string | null;
  feeAmount: string | null;
  deadline: string | null;
  userNonce: string | null;
  approvalNonce: string | null;
  receiverVerified: boolean | null;
  approvalAttached: boolean | null;
  feeQuoteOk: boolean;
  /** 제출 가능 여부 — 이번 단계는 항상 false */
  submitEligible: false;
  blockReasons: string[];
}

/**
 * dry-run 판정 — 외부 호출 0회. 조립 결과+fee 검증+게이트 사유를 종합.
 * assembled가 null이면 조립 실패 사유가 blockReasons에 있어야 한다.
 */
export function buildDryRunResult(params: {
  mode: RelayMode;
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
  gate: RelayGateResult;
  modeReasons: string[];
  assembled: AssembledRelayCall | null;
  assembleError?: string;
  quote: RelayFeeQuote | null;
  nowMs: number;
  orderNotionalUsd: number | null;
  ethPriceUsd: number | null;
}): DryRunResult {
  const blockReasons = [...params.modeReasons, ...params.gate.blockReasons];
  if (params.assembleError) blockReasons.push(`조립 실패: ${params.assembleError}`);

  const feeCheck = validateFeeQuote({
    quote: params.quote, nowMs: params.nowMs,
    orderNotionalUsd: params.orderNotionalUsd, ethPriceUsd: params.ethPriceUsd,
  });
  if (!feeCheck.ok) blockReasons.push(`fee 검증 실패: ${feeCheck.reason}`);

  const a = params.assembled;
  if (a && !a.receiverVerified) blockReasons.push('receiver가 main account가 아님 — 차단');

  blockReasons.push('LIVE 제출은 이번 단계에서 비활성 (DRY-RUN 전용)');

  return {
    ok: !!a && feeCheck.ok && params.gate.allowed && !params.assembleError,
    mode: params.mode,
    kind: params.kind,
    calldataHash: a?.calldataHash ?? null,
    packedPayloadHash: a?.packedPayloadHash ?? null,
    relayParamsHash: a?.relayParamsHash ?? null,
    structHash: a?.structHash ?? null,
    signingDigest: a?.signingDigest ?? null,
    signerRole: a?.signerRole ?? null,
    actionCount: a?.actionCount ?? null,
    feeToken: a ? a.feeToken : null,
    feeAmount: a ? a.feeAmount.toString() : null,
    deadline: a ? a.deadline.toString() : null,
    userNonce: a ? a.userNonce.toString() : null,
    approvalNonce: a?.approvalNonce != null ? a.approvalNonce.toString() : null,
    receiverVerified: a?.receiverVerified ?? null,
    approvalAttached: a?.approvalAttached ?? null,
    feeQuoteOk: feeCheck.ok,
    submitEligible: false,
    blockReasons,
  };
}
