/**
 * activeCapitalSemantics — 자본 의미 분리 진단.
 *
 * Planned Seed, 승인된 Active Trading Capital, 실제 온체인 지갑 잔액,
 * RiskEngine이 사용한 runtime capital/equity를 서로 다른 값으로 유지한다.
 * 이 모듈은 읽기 전용 진단만 제공하며 DB·지갑·Risk lock을 변경하지 않는다.
 */
import { CAPITAL_PLAN, PAPER_TEST_ALLOCATION_PLAN, RISK_POLICY } from './riskPolicy';

export type ActiveCapitalAlignment =
  | 'ALIGNED'
  | 'RUNTIME_BELOW_APPROVED_STAGE'
  | 'RUNTIME_ABOVE_APPROVED_STAGE'
  | 'UNAVAILABLE';

/**
 * 자본 의미 평가 context.
 * STANDARD_ACTIVE가 기본값이며 기존 1,000-USDC 정책을 그대로 유지한다.
 * FIXED_BETA_400은 2026-09-15 고정 Beta 준비용 read-only 의미 분리이며
 * 자체로 DB/HWM 변경, 주문, signer, LIVE/Canary 실행 권한을 부여하지 않는다.
 */
export type ActiveCapitalPolicyContext = 'STANDARD_ACTIVE' | 'FIXED_BETA_400';

/**
 * 새 HARD_STOP 평가가 어떤 자본 의미를 전제로 가능한지 명시한다.
 * - 승인 Active 단계와 runtime이 일치할 때만 현재 정책 threshold 평가 가능
 * - 자본 설정 drift에서는 새 HARD_STOP을 만들지 말고 구성 문제로 fail-closed
 * - 400 Beta는 $368 threshold가 RiskStateMachine에 명시적으로 결속되기 전까지 fail-closed
 * - 이미 존재하는 HARD_STOP은 자동 해제하지 않고 별도 운영자 검토 대상으로 보존
 */
export type HardStopEvaluationGate =
  | 'EVALUATE_CURRENT_POLICY'
  | 'BLOCK_CAPITAL_CONFIGURATION_DRIFT'
  | 'BLOCK_FIXED_BETA_HARD_STOP_BINDING'
  | 'PRESERVE_EXISTING_HARD_STOP_REVIEW';

export interface ActiveCapitalSemanticsInput {
  runtimeConfiguredCapitalUsd: number | null | undefined;
  observedWalletBalanceUsd: number | null | undefined;
  currentRiskEquityUsd: number | null | undefined;
  historicalHardStopTriggerReason: string | null | undefined;
  /** 생략 시 기존 STANDARD_ACTIVE 의미를 유지한다. */
  policyContext?: ActiveCapitalPolicyContext;
}

export interface ActiveCapitalSemanticsDiagnostic {
  diagnosticOnly: true;
  policyContext: ActiveCapitalPolicyContext;
  plannedSeedCapitalUsd: number;
  approvedActiveTradingCapitalUsd: number;
  runtimeConfiguredCapitalUsd: number | null;
  observedWalletBalanceUsd: number | null;
  currentRiskEquityUsd: number | null;
  hardStopPolicyEquityUsd: number;
  alignment: ActiveCapitalAlignment;
  runtimeConfiguredCapitalAligned: boolean;
  walletBalanceTreatedAsActiveCapital: false;
  historicalHardStopReviewRequired: boolean;
  automaticHardStopClearAllowed: false;
  /** 현재 자본 의미로 새 HARD_STOP threshold 평가가 허용되는지 */
  newHardStopEvaluationAllowed: boolean;
  /** 기존 HARD_STOP은 drift 해소와 별개로 보존·검토해야 하는지 */
  historicalHardStopPreserved: boolean;
  hardStopEvaluationGate: HardStopEvaluationGate;
  /** 400 Beta 계획이 선택되었는지. 계획 선택 자체는 실행 승인이 아니다. */
  betaScopeRequested: boolean;
  /** authoritative 계획의 현재 적용 상태를 그대로 노출한다. */
  betaPlanApplied: boolean;
  /** authoritative 계획의 현재 실행 승인 상태를 그대로 노출한다. */
  betaExecutionAuthorized: boolean;
  /** 400/$368 쌍이 실제 RiskStateMachine threshold 입력까지 결속되었는지. */
  hardStopThresholdBoundToRiskEngine: boolean;
  blockers: string[];
}

/**
 * Worker가 RiskStateMachine에 전달해야 하는 최소 자본 gate 필드.
 * 진단 객체 전체를 실행 입력으로 넘기지 않아 Planned Seed/wallet 관측치가
 * 위험 자본으로 오인되는 경로를 구조적으로 차단한다.
 */
export interface ActiveCapitalRiskGateBinding {
  newHardStopEvaluationAllowed: boolean;
  activeCapitalConfigurationDriftReason: string | null;
}

export interface ActiveCapitalWorkerBinding {
  diagnostic: ActiveCapitalSemanticsDiagnostic;
  riskGate: ActiveCapitalRiskGateBinding;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * 현재 runtime capital이 선택된 자본 context와 일치하는지 분류한다.
 * 지갑 잔액은 관측값일 뿐 Active Capital을 대체하지 않는다.
 * 과거 HARD_STOP은 자동 해제하지 않고 운영자 검토 대상으로만 표시한다.
 *
 * FIXED_BETA_400은 400/$368 의미를 진단에 노출하되, 현재 RiskStateMachine이
 * $368 threshold를 명시적으로 입력받는 결속이 아직 없으므로 신규 HARD_STOP
 * 평가를 허용하지 않는다. 따라서 단순히 policyContext만 바꿔 기존 $920
 * HARD_STOP을 400-USDC Beta에 잘못 적용하는 경로를 fail-closed로 차단한다.
 */
export function assessActiveCapitalSemantics(
  input: ActiveCapitalSemanticsInput,
): ActiveCapitalSemanticsDiagnostic {
  const policyContext = input.policyContext ?? 'STANDARD_ACTIVE';
  const betaScopeRequested = policyContext === 'FIXED_BETA_400';
  const approved = betaScopeRequested
    ? PAPER_TEST_ALLOCATION_PLAN.totalAllocationUsd
    : CAPITAL_PLAN.activeTradingCapitalUsd;
  const hardStopPolicyEquityUsd = betaScopeRequested
    ? PAPER_TEST_ALLOCATION_PLAN.futureActiveCapitalPolicyCandidate.hardStopEquityUsd
    : RISK_POLICY.hardStopEquityUsd;
  // 현재 RiskStateMachine의 threshold는 standard RISK_POLICY($920) 단일 원본이다.
  // $368 Beta threshold가 명시적으로 연결되기 전까지 Beta는 fail-closed한다.
  const hardStopThresholdBoundToRiskEngine = !betaScopeRequested;

  const runtime = finiteNonNegative(input.runtimeConfiguredCapitalUsd);
  const wallet = finiteNonNegative(input.observedWalletBalanceUsd);
  const currentRiskEquity = finiteNonNegative(input.currentRiskEquityUsd);
  const blockers: string[] = [];

  let alignment: ActiveCapitalAlignment;
  if (runtime === null) {
    alignment = 'UNAVAILABLE';
    blockers.push('ACTIVE_CAPITAL_RUNTIME_UNAVAILABLE');
  } else if (Math.abs(runtime - approved) < 0.005) {
    alignment = 'ALIGNED';
  } else if (runtime < approved) {
    alignment = 'RUNTIME_BELOW_APPROVED_STAGE';
    blockers.push('ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE');
  } else {
    alignment = 'RUNTIME_ABOVE_APPROVED_STAGE';
    blockers.push('ACTIVE_CAPITAL_RUNTIME_ABOVE_APPROVED_STAGE');
  }

  const historicalHardStopReviewRequired =
    typeof input.historicalHardStopTriggerReason === 'string'
    && input.historicalHardStopTriggerReason.trim().length > 0;
  if (historicalHardStopReviewRequired) {
    blockers.push('HISTORICAL_HARD_STOP_REQUIRES_OPERATOR_REVIEW');
  }

  if (
    betaScopeRequested
    && alignment === 'ALIGNED'
    && !historicalHardStopReviewRequired
    && !hardStopThresholdBoundToRiskEngine
  ) {
    blockers.push('FIXED_BETA_HARD_STOP_BINDING_NOT_WIRED');
  }

  const hardStopEvaluationGate: HardStopEvaluationGate = historicalHardStopReviewRequired
    ? 'PRESERVE_EXISTING_HARD_STOP_REVIEW'
    : alignment !== 'ALIGNED'
      ? 'BLOCK_CAPITAL_CONFIGURATION_DRIFT'
      : betaScopeRequested && !hardStopThresholdBoundToRiskEngine
        ? 'BLOCK_FIXED_BETA_HARD_STOP_BINDING'
        : 'EVALUATE_CURRENT_POLICY';

  return {
    diagnosticOnly: true,
    policyContext,
    plannedSeedCapitalUsd: CAPITAL_PLAN.plannedSeedCapitalUsd,
    approvedActiveTradingCapitalUsd: approved,
    runtimeConfiguredCapitalUsd: runtime,
    observedWalletBalanceUsd: wallet,
    currentRiskEquityUsd: currentRiskEquity,
    hardStopPolicyEquityUsd,
    alignment,
    runtimeConfiguredCapitalAligned: alignment === 'ALIGNED',
    walletBalanceTreatedAsActiveCapital: false,
    historicalHardStopReviewRequired,
    automaticHardStopClearAllowed: false,
    newHardStopEvaluationAllowed: hardStopEvaluationGate === 'EVALUATE_CURRENT_POLICY',
    historicalHardStopPreserved: historicalHardStopReviewRequired,
    hardStopEvaluationGate,
    betaScopeRequested,
    betaPlanApplied: betaScopeRequested ? PAPER_TEST_ALLOCATION_PLAN.applied : false,
    betaExecutionAuthorized: betaScopeRequested
      ? PAPER_TEST_ALLOCATION_PLAN.executionAuthorized
      : false,
    hardStopThresholdBoundToRiskEngine,
    blockers,
  };
}

/**
 * Worker용 binding 생성.
 *
 * - 실행 권한은 오직 승인 Active Capital ↔ runtime 정합성으로 판단한다.
 * - wallet balance/Planned Seed는 진단에만 남고 riskGate 입력에는 들어가지 않는다.
 * - 기존 HARD_STOP이 있으면 RiskStateMachine의 sticky-lock 우선 규칙이 그대로 작동한다.
 * - drift/beta-binding 사유는 비영속 진단 문자열이며 HARD_STOP/UNRESOLVED lock을 새로 만들지 않는다.
 * - FIXED_BETA_400을 선택해도 $368 threshold binding 전에는 신규 Risk 평가를 열지 않는다.
 */
export function buildActiveCapitalWorkerBinding(
  input: ActiveCapitalSemanticsInput,
): ActiveCapitalWorkerBinding {
  const diagnostic = assessActiveCapitalSemantics(input);
  const riskGateBlockers = diagnostic.blockers.filter((reason) =>
    reason.startsWith('ACTIVE_CAPITAL_RUNTIME_')
    || reason.startsWith('FIXED_BETA_HARD_STOP_'),
  );

  return {
    diagnostic,
    riskGate: {
      newHardStopEvaluationAllowed: diagnostic.newHardStopEvaluationAllowed,
      activeCapitalConfigurationDriftReason: diagnostic.newHardStopEvaluationAllowed
        ? null
        : (riskGateBlockers.join(', ') || diagnostic.hardStopEvaluationGate),
    },
  };
}
