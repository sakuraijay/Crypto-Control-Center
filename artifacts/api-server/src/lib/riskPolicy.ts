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
  /** 최종 기준 자본 (USDC) */
  initialCapitalUsd: 1000,
  /** 위험계산에 사용할 수 있는 최대 기준 자본 — equity가 커져도 이 이상 안 씀 */
  maxRiskCapitalUsd: 1000,
  /** 일일 1차 수익 목표 (+5%) — 도달 시 신규 진입 금지 */
  primaryProfitTargetPercent: 5,
  /** 일일 절대 수익 상한 (+10%) — 도달 시 전량 종료 + 잠금 */
  absoluteProfitCapPercent: 10,
  /** Profit Protection 후 보호 수익 floor (+3.5%) */
  protectedProfitFloorPercent: 3.5,
  /** 거래당 기본 허용손실 (0.75%) */
  baseRiskPerTradePercent: 0.75,
  /** 거래당 절대 최대손실 (1%) */
  maxRiskPerTradePercent: 1,
  /** 일일 Defensive Mode 진입 손실 (-2%) */
  defensiveModeLossPercent: 2,
  /** 일일 최대손실 (-3%) — 도달 시 전량 종료 + 일일 잠금 */
  dailyMaxLossPercent: 3,
  /** 주간 최대손실 (-8%) */
  weeklyMaxLossPercent: 8,
  /** 전체 강제중단 equity 하한 — 최초 $1,000 대비 -15% */
  hardStopEquityUsd: 850,
  /** 기본 최대 레버리지 */
  baseMaxLeverage: 3,
  /** 조건부 최대 레버리지 (현재 비활성) */
  conditionalMaxLeverage: 5,
  /** 5x 경로 활성 여부 — false인 동안 5x는 무조건 차단 */
  conditional5xEnabled: false,
  /** 동시 포지션 최대 */
  maxConcurrentPositions: 1,
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
  /** -3% 일일 최대손실 달러값 (양수 표기) */
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
  { tier: 'T100',   capitalUsd: 100,  requirement: '최소 20건' },
  { tier: 'T300',   capitalUsd: 300,  requirement: '최소 50건 · 비용 차감 후 양수' },
  { tier: 'T500',   capitalUsd: 500,  requirement: '최대낙폭 10% 이내' },
  { tier: 'T1000',  capitalUsd: 1000, requirement: '최소 100건 및 RiskEngine 검증' },
] as const;

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
