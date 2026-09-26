/**
 * riskPolicy — 단일 authoritative Risk Policy (6H-1 §3).
 *
 * 최종 운용 정책의 유일한 원본. 브라우저 localStorage나 UI 상태는
 * 절대 authoritative가 아니다 — 서버의 이 상수만 진실이다.
 *
 * 퍼센트만 저장하고 달러 파생값은 서버가 기준 자본에서 계산한다
 * (퍼센트/달러 이중 저장으로 어긋나는 것 금지 — §3).
 */

export const RISK_POLICY = {
  /** 현재 승인된 Active Trading Capital (USDC). Planned Seed와 별개. */
  initialCapitalUsd: 1000,
  /** 현재 단계에서 위험계산에 사용할 수 있는 최대 Active Capital */
  maxRiskCapitalUsd: 1000,
  /** 일일 과열 방지 1차 상한 (+5%) — 수익 목표가 아님 */
  primaryProfitTargetPercent: 5,
  /** 일일 절대 과열 상한 (+10%) — 수익 목표가 아님 */
  absoluteProfitCapPercent: 10,
  /** Profit Protection 후 보호 수익 floor (+3.5%) */
  protectedProfitFloorPercent: 3.5,
  /** 거래당 기본 허용손실 (Active Capital의 0.25%) */
  baseRiskPerTradePercent: 0.25,
  /** 거래당 절대 최대손실 (Active Capital의 0.5%) */
  maxRiskPerTradePercent: 0.5,
  /** 일일 Defensive Mode 진입 손실 (-0.5%) — 1% 일일 잠금 전에 선제 축소 */
  defensiveModeLossPercent: 0.5,
  /** 일일 최대손실 (-1%) — 도달 시 전량 종료 + 일일 잠금 */
  dailyMaxLossPercent: 1,
  /** 주간 최대손실 (-8%) */
  weeklyMaxLossPercent: 8,
  /** 전체 강제중단 equity 하한 — 현재 Active $1,000 대비 -8% */
  hardStopEquityUsd: 920,
  /** 현재 Active 단계의 포지션당 담보 절대 상한 */
  maxMarginPerTradeUsd: 334,
  /** 기본 최대 레버리지 */
  baseMaxLeverage: 3,
  /** 조건부 최대 레버리지 (현재 비활성) */
  conditionalMaxLeverage: 5,
  /** 5x 경로 활성 여부 — false인 동안 5x는 무조건 차단 */
  conditional5xEnabled: false,
  /** 동시 포지션 최대 */
  maxConcurrentPositions: 1,
  /** 버전 프로필이 요청할 수 있는 절대 동시 포지션 상한 — profile로 완화 금지 */
  maxProfileConcurrentPositions: 1,
  /** Manila 거래일 기준 신규 진입 최대 횟수 */
  maxDailyEntries: 3,
  /** 연속 순손실 즉시 중단 기준 */
  maxConsecutiveLosses: 3,
  /** 마틴게일 금지 */
  martingaleEnabled: false,
  /** 물타기 금지 */
  averagingDownEnabled: false,
  /** 목표/손실 추격 금지 */
  chaseTargetEnabled: false,
  /** 자동 복리 비활성 */
  autoCompoundingEnabled: false,
  /** 거래일 timezone */
  tradingTimezone: 'Asia/Manila',
} as const;

export type RiskPolicy = typeof RISK_POLICY;

/**
 * 자본 의미의 authoritative 분리.
 * plannedSeed는 계획/평가 기준일 뿐 wallet 입금·Active 증액·실행 권한이 아니다.
 */
export const CAPITAL_PLAN = {
  plannedSeedCapitalUsd: 10_000,
  activeTradingCapitalUsd: RISK_POLICY.maxRiskCapitalUsd,
  reserveCapitalPercent: 20,
  reserveCapitalUsd: RISK_POLICY.maxRiskCapitalUsd * 0.20,
  deployableActiveCapitalUsd: RISK_POLICY.maxRiskCapitalUsd * 0.80,
  onchainBalanceSource: 'GMX_RPC_READ_ONLY',
  plannedSeedAuthorizesFunding: false,
  plannedSeedAuthorizesPromotion: false,
  monthlyNetReturnReferenceRangePercent: [1, 3] as const,
} as const;

/**
 * 사용자가 승인한 차기 PAPER 테스트 할당 계획.
 *
 * 이 객체는 코드에 고정된 권위 있는 계획/표시 원본일 뿐이며, 현재 runtime의
 * Active Trading Capital, DB 전략값, HWM, baseline 또는 HARD_STOP을 변경하거나
 * 실행 권한을 부여하지 않는다. 실제 적용은 별도의 명시적 epoch activation
 * 절차와 운영자 승인을 필요로 한다.
 */
export const PAPER_TEST_ALLOCATION_PLAN = {
  scope: 'PAPER_TEST_ALLOCATION',
  authority: 'SERVER_CODE_USER_APPROVED_PLAN',
  approvalStatus: 'USER_APPROVED_PLAN',
  applicationStatus: 'PROPOSED_NOT_APPLIED',
  totalAllocationUsd: 400,
  reservePercent: 20,
  reserveUsd: 80,
  deployableUsd: 320,
  walletEligibilityMinimumUsdc: 400,
  futureActiveCapitalPolicyCandidate: {
    baseRiskPerTradePercent: 0.25,
    baseRiskPerTradeUsd: 1,
    maxRiskPerTradePercent: 0.5,
    maxRiskPerTradeUsd: 2,
    hardStopDrawdownPercent: 8,
    hardStopEquityUsd: 368,
    maxLeverage: 3,
    recommendedMaxMarginPerTradeUsd: 100,
    targetRoundTripCostCapUsd: 0.40,
  },
  applied: false,
  executionAuthorized: false,
  autoActivationAllowed: false,
  stateChangePerformed: false,
  runtimeDbHwmUnchanged: true,
} as const;

export type PaperTestAllocationPlan = typeof PAPER_TEST_ALLOCATION_PLAN;

/** 서버가 기준 자본에서 파생한 달러 한도 (§3 — 파생값은 저장하지 않고 계산) */
export interface DerivedRiskTargets {
  /** 오늘 위험계산 기준금액 = min(startOfDayEquity, 1000) */
  dailyRiskCapitalUsd: number;
  /** +5% 일일 목표 달러값 */
  primaryProfitTargetUsd: number;
  /** +10% 절대 상한 달러값 */
  absoluteProfitCapUsd: number;
  /** +3.5% 보호 수익 floor 달러값 */
  protectedProfitFloorUsd: number;
  /** -2% Defensive 진입 달러값 (양수 표기) */
  defensiveModeLossUsd: number;
  /** -1% 일일 최대손실 달러값 (양수 표기) */
  dailyMaxLossUsd: number;
}

/** 일일 파생 한도 계산 — dailyRiskCapital 기준 */
export function deriveDailyTargets(dailyRiskCapitalUsd: number): DerivedRiskTargets {
  const c = dailyRiskCapitalUsd;
  return {
    dailyRiskCapitalUsd: c,
    primaryProfitTargetUsd:  c * RISK_POLICY.primaryProfitTargetPercent / 100,
    absoluteProfitCapUsd:    c * RISK_POLICY.absoluteProfitCapPercent / 100,
    protectedProfitFloorUsd: c * RISK_POLICY.protectedProfitFloorPercent / 100,
    defensiveModeLossUsd:    c * RISK_POLICY.defensiveModeLossPercent / 100,
    dailyMaxLossUsd:         c * RISK_POLICY.dailyMaxLossPercent / 100,
  };
}

// ── 소프트 KPI(dailyTargetUSDT) 정책 결속 ─────────────────────────────────────
// dailyTargetUSDT는 모니터링 전용 soft KPI지만, 과열 상한(+10% = $100 @
// 현재 Active $1,000)을 초과해 저장·표시되는 것은 금지한다. 화면·API·worker의
// 표시는 항상 riskDerivedTargets(=deriveDailyTargets)를 원본으로 삼고, legacy
// 저장값(예: 구형 $500)은 실행·표시·목표 판단에 사용하지 않는다.

/** 정책 파생 일일 1차 과열 상한 — Active $1,000 기준 +5% = $50 */
export const POLICY_DAILY_TARGET_USD =
  RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.primaryProfitTargetPercent / 100;

/** 정책 파생 일일 절대 과열 상한 — Active $1,000 기준 +10% = $100 */
export const POLICY_DAILY_TARGET_CAP_USD =
  RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.absoluteProfitCapPercent / 100;

/**
 * clampDailyTargetUSDT — soft KPI 저장값을 정책 범위로 강제.
 * 유한하지 않은 값 → undefined (worker/web 기본값으로 폴백, 0 대체 금지).
 * 음수 → 0, 정책 상한($100) 초과(legacy $500 포함) → 상한으로 클램프.
 */
export function clampDailyTargetUSDT(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === 'boolean') return undefined;
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(POLICY_DAILY_TARGET_CAP_USD, Math.max(0, n));
}

/** 주간 최대손실 달러값 — weeklyRiskCapital 기준 */
export function deriveWeeklyMaxLossUsd(weeklyRiskCapitalUsd: number): number {
  return weeklyRiskCapitalUsd * RISK_POLICY.weeklyMaxLossPercent / 100;
}

/** 거래당 위험 달러값 — positionSizingCapital 기준 (§9) */
export function deriveTradeRiskUsd(positionSizingCapitalUsd: number): {
  baseRiskUsd: number;
  absoluteMaxRiskUsd: number;
} {
  return {
    baseRiskUsd:        positionSizingCapitalUsd * RISK_POLICY.baseRiskPerTradePercent / 100,
    absoluteMaxRiskUsd: positionSizingCapitalUsd * RISK_POLICY.maxRiskPerTradePercent / 100,
  };
}

// ── LIVE Canary 별도 하드캡 (6H-1 §13) ─────────────────────────────────────────

export const CANARY_POLICY = {
  /** 기본 false — 브라우저만으로 활성화 불가, 별도 서버 플래그+운영자 승인 필요 */
  canaryEnabled: false,
  canaryMaxCapitalAtRiskUsd: 15,
  canaryMaxCumulativeLossUsd: 3,
  canaryMaxLeverage: 2,
  canaryMaxConcurrentPositions: 1,
  canaryMaxEntries: 1,
  canaryRequiresManualApproval: true,
} as const;

export type CanaryPolicy = typeof CANARY_POLICY;

/** 승급 사다리 — 자동 승급 절대 금지, 각 단계는 별도 운영자 승인 (§13) */
export const CAPITAL_TIER_LADDER = [
  { tier: 'CANARY', capitalUsd: 15,   requirement: '주문경로 Canary — OPEN 1회 + CLOSE/보호 주문 검증' },
  { tier: 'ACTIVE_1000',  capitalUsd: 1_000,  requirement: '현재 단계 · 자동 증액 금지' },
  { tier: 'ACTIVE_2500',  capitalUsd: 2_500,  requirement: '비용 차감 후 양의 기대값 · GMX 주문/체결/정산 일치 · Stop/비상청산 가능 · unresolved 0 · Risk 준수 · Canary · 사용자 승인' },
  { tier: 'ACTIVE_5000',  capitalUsd: 5_000,  requirement: '직전 단계 재검증 · 비용/Stop/정산/Risk/Canary 증거 · 사용자 승인' },
  { tier: 'ACTIVE_10000', capitalUsd: 10_000, requirement: '직전 단계 재검증 · 비용/Stop/정산/Risk/Canary 증거 · 사용자 승인' },
] as const;

export type ActiveCapitalStage = 1_000 | 2_500 | 5_000 | 10_000;

export interface CapitalPromotionEvidence {
  fromCapitalUsd: ActiveCapitalStage;
  toCapitalUsd: ActiveCapitalStage;
  positiveNetExpectancyAfterCosts: boolean;
  gmxOrderExecutionSettlementMatched: boolean;
  stopLossExecutable: boolean;
  emergencyCloseExecutable: boolean;
  unresolvedCount: number | null;
  drawdownWithinLimit: boolean;
  dailyLossWithinLimit: boolean;
  stageCanaryVerified: boolean;
  userReportReviewed: boolean;
  userExplicitlyApproved: boolean;
}

export type CapitalPromotionResult =
  | { allowed: true }
  | { allowed: false; reasons: string[] };

/** 단계 증액은 순차 승격 + 전 증거 + 사용자 명시 승인일 때만 허용된다. */
export function evaluateCapitalPromotion(input: CapitalPromotionEvidence): CapitalPromotionResult {
  const stages: readonly ActiveCapitalStage[] = [1_000, 2_500, 5_000, 10_000];
  const from = stages.indexOf(input.fromCapitalUsd);
  const sequential = from >= 0 && stages[from + 1] === input.toCapitalUsd;
  const reasons: string[] = [];
  if (!sequential) reasons.push('Active Capital은 1,000→2,500→5,000→10,000 순차 승격만 허용');
  if (!input.positiveNetExpectancyAfterCosts) reasons.push('비용 차감 후 양의 기대값 미확인');
  if (!input.gmxOrderExecutionSettlementMatched) reasons.push('GMX 주문/체결/정산 일치 미확인');
  if (!input.stopLossExecutable) reasons.push('Stop-Loss 실제 실행 가능성 미확인');
  if (!input.emergencyCloseExecutable) reasons.push('비상청산 실제 실행 가능성 미확인');
  if (input.unresolvedCount !== 0) reasons.push('unresolved 0 미확인');
  if (!input.drawdownWithinLimit) reasons.push('Drawdown 제한 준수 미확인');
  if (!input.dailyLossWithinLimit) reasons.push('일일 손실 제한 준수 미확인');
  if (!input.stageCanaryVerified) reasons.push('해당 단계 Canary 검증 미완료');
  if (!input.userReportReviewed) reasons.push('사용자 보고 검토 미완료');
  if (!input.userExplicitlyApproved) reasons.push('사용자 명시 승인 없음');
  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons };
}

export interface CanaryGateInput {
  /** 서버 authoritative 플래그 (환경/DB) — 브라우저 값 사용 금지 */
  serverCanaryEnabled: boolean;
  /** 운영자 수동 승인 기록 존재 여부 */
  operatorApprovalRecorded: boolean;
  entriesUsed: number;
  cumulativeLossUsd: number;
  requestedLeverage: number;
  requestedCapitalUsd: number;
  openPositionCount: number;
}

export type CanaryGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Canary 진입 게이트 — 모든 조건 AND, 하나라도 실패 시 차단 (fail-closed) */
export function evaluateCanaryGate(input: CanaryGateInput): CanaryGateResult {
  const p = CANARY_POLICY;
  if (!p.canaryEnabled) return { allowed: false, reason: 'Canary 정책 자체가 비활성 (canaryEnabled=false)' };
  if (!input.serverCanaryEnabled) return { allowed: false, reason: '서버 Canary 플래그 비활성' };
  if (p.canaryRequiresManualApproval && !input.operatorApprovalRecorded) {
    return { allowed: false, reason: '운영자 수동 승인 기록 없음' };
  }
  if (input.entriesUsed >= p.canaryMaxEntries) {
    return { allowed: false, reason: `Canary 진입 횟수 소진 (${input.entriesUsed}/${p.canaryMaxEntries}) — 재잠금` };
  }
  if (input.cumulativeLossUsd >= p.canaryMaxCumulativeLossUsd) {
    return { allowed: false, reason: `Canary 누적 손실 한도 도달 ($${input.cumulativeLossUsd} ≥ $${p.canaryMaxCumulativeLossUsd})` };
  }
  if (input.requestedLeverage > p.canaryMaxLeverage) {
    return { allowed: false, reason: `Canary 레버리지 초과 (${input.requestedLeverage}x > ${p.canaryMaxLeverage}x)` };
  }
  if (input.requestedCapitalUsd > p.canaryMaxCapitalAtRiskUsd) {
    return { allowed: false, reason: `Canary 자본 초과 ($${input.requestedCapitalUsd} > $${p.canaryMaxCapitalAtRiskUsd})` };
  }
  if (input.openPositionCount >= p.canaryMaxConcurrentPositions) {
    return { allowed: false, reason: `Canary 동시 포지션 한도 (${input.openPositionCount}/${p.canaryMaxConcurrentPositions})` };
  }
  return { allowed: true };
}

/** tier 자동 승급은 어떤 조건에서도 false — 별도 운영자 승인만 가능 (§13) */
export function isAutoPromotionAllowed(): false {
  return false;
}
