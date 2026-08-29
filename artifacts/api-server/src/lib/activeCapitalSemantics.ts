/**
 * activeCapitalSemantics — 자본 의미 분리 진단.
 *
 * Planned Seed, 승인된 Active Trading Capital, 실제 온체인 지갑 잔액,
 * RiskEngine이 사용한 runtime capital/equity를 서로 다른 값으로 유지한다.
 * 이 모듈은 읽기 전용 진단만 제공하며 DB·지갑·Risk lock을 변경하지 않는다.
 */
import { CAPITAL_PLAN, RISK_POLICY } from './riskPolicy';

export type ActiveCapitalAlignment =
  | 'ALIGNED'
  | 'RUNTIME_BELOW_APPROVED_STAGE'
  | 'RUNTIME_ABOVE_APPROVED_STAGE'
  | 'UNAVAILABLE';

/**
 * 새 HARD_STOP 평가가 어떤 자본 의미를 전제로 가능한지 명시한다.
 * - 승인 Active 단계와 runtime이 일치할 때만 현재 정책 threshold 평가 가능
 * - 자본 설정 drift에서는 새 HARD_STOP을 만들지 말고 구성 문제로 fail-closed
 * - 이미 존재하는 HARD_STOP은 자동 해제하지 않고 별도 운영자 검토 대상으로 보존
 */
export type HardStopEvaluationGate =
  | 'EVALUATE_CURRENT_POLICY'
  | 'BLOCK_CAPITAL_CONFIGURATION_DRIFT'
  | 'PRESERVE_EXISTING_HARD_STOP_REVIEW';

export interface ActiveCapitalSemanticsInput {
  runtimeConfiguredCapitalUsd: number | null | undefined;
  observedWalletBalanceUsd: number | null | undefined;
  currentRiskEquityUsd: number | null | undefined;
  historicalHardStopTriggerReason: string | null | undefined;
}

export interface ActiveCapitalSemanticsDiagnostic {
  diagnosticOnly: true;
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
 * 현재 runtime capital이 승인된 Active Capital 단계와 일치하는지 분류한다.
 * 지갑 잔액은 관측값일 뿐 Active Capital을 대체하지 않는다.
 * 과거 HARD_STOP은 자동 해제하지 않고 운영자 검토 대상으로만 표시한다.
 */
export function assessActiveCapitalSemantics(
  input: ActiveCapitalSemanticsInput,
): ActiveCapitalSemanticsDiagnostic {
  const approved = CAPITAL_PLAN.activeTradingCapitalUsd;
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

  const hardStopEvaluationGate: HardStopEvaluationGate = historicalHardStopReviewRequired
    ? 'PRESERVE_EXISTING_HARD_STOP_REVIEW'
    : alignment === 'ALIGNED'
      ? 'EVALUATE_CURRENT_POLICY'
      : 'BLOCK_CAPITAL_CONFIGURATION_DRIFT';

  return {
    diagnosticOnly: true,
    plannedSeedCapitalUsd: CAPITAL_PLAN.plannedSeedCapitalUsd,
    approvedActiveTradingCapitalUsd: approved,
    runtimeConfiguredCapitalUsd: runtime,
    observedWalletBalanceUsd: wallet,
    currentRiskEquityUsd: currentRiskEquity,
    hardStopPolicyEquityUsd: RISK_POLICY.hardStopEquityUsd,
    alignment,
    runtimeConfiguredCapitalAligned: alignment === 'ALIGNED',
    walletBalanceTreatedAsActiveCapital: false,
    historicalHardStopReviewRequired,
    automaticHardStopClearAllowed: false,
    newHardStopEvaluationAllowed: hardStopEvaluationGate === 'EVALUATE_CURRENT_POLICY',
    historicalHardStopPreserved: historicalHardStopReviewRequired,
    hardStopEvaluationGate,
    blockers,
  };
}

/**
 * Worker용 binding 생성.
 *
 * - 실행 권한은 오직 승인 Active Capital ↔ runtime 정합성으로 판단한다.
 * - wallet balance/Planned Seed는 진단에만 남고 riskGate 입력에는 들어가지 않는다.
 * - 기존 HARD_STOP이 있으면 RiskStateMachine의 sticky-lock 우선 규칙이 그대로 작동한다.
 * - drift 사유는 비영속 진단 문자열이며 HARD_STOP/UNRESOLVED lock을 새로 만들지 않는다.
 */
export function buildActiveCapitalWorkerBinding(
  input: ActiveCapitalSemanticsInput,
): ActiveCapitalWorkerBinding {
  const diagnostic = assessActiveCapitalSemantics(input);
  const activeCapitalBlockers = diagnostic.blockers.filter((reason) =>
    reason.startsWith('ACTIVE_CAPITAL_RUNTIME_'),
  );

  return {
    diagnostic,
    riskGate: {
      newHardStopEvaluationAllowed: diagnostic.newHardStopEvaluationAllowed,
      activeCapitalConfigurationDriftReason: diagnostic.newHardStopEvaluationAllowed
        ? null
        : (activeCapitalBlockers.join(', ') || diagnostic.hardStopEvaluationGate),
    },
  };
}
