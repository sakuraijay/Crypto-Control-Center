/**
 * 6I-1 §9·§10 — Opportunity Ranking과 NO_TRADE, 목표 추격 금지.
 *
 * 선정 순서 (전부 통과해야 후보):
 *  1. 데이터 품질 → 2. regime 방향 허용 → 3. RiskEngine 사전조건 → 4. 비용 snapshot 유효
 *  5. 최소 손익비 → 6. 순기대값 기준 → 7. 실행 위험 → 8. risk-adjusted 비교 → 9. 최상위 1개
 *  10. 모두 탈락 = NO_TRADE (정상 결과)
 *
 * §10 — 이 모듈은 일일 목표/시간/거래 횟수/직전 손실을 입력으로 받지 않는다.
 * threshold·size·leverage는 아래 frozen 상수로만 정의되며 런타임 변경 불가.
 */
import { OpportunityCandidate, CandidateDecision } from './candidate';
import { RegimeResult } from './regime';

/** §10 — 고정 임계값. Object.freeze로 런타임 변경 차단 (목표 추격 금지). */
export const RANKING_THRESHOLDS = Object.freeze({
  /** 최소 raw signal (연구 순위 진입 최소치) */
  minRawSignalScore: 55,
  /** 최소 expected R multiple */
  minExpectedRMultiple: 1.5,
  /** 최소 순기대값 (USD) — 보정 확률 존재 시에만 평가 가능 */
  minExpectedNetValueUsd: 5,
  /** 비용이 gross edge를 이 비율 이상 잠식하면 거부 */
  maxCostToGrossEdgeRatio: 0.5,
  /** 실행 위험 상한 (0..1) */
  maxExecutionRisk: 0.7,
  /** 비용 스냅샷 실행 적격 최대 age (6H-2 §10 재사용) */
  costSnapshotMaxAgeMs: 30_000,
});

export interface RankingGates {
  /** RiskEngine 사전 조건 — 통과하지 못하면 방향 무관 전체 차단 */
  riskEngineAllowsEntry: boolean;
  riskEngineBlockReason: string | null;
  /** 이미 열린 포지션 존재 → 신규 후보 차단 */
  openPositionExists: boolean;
  /** 일일 진입 횟수 초과 */
  dailyEntryLimitReached: boolean;
  nowMs: number;
}

export interface RankingResult {
  decision: 'SELECTED' | 'NO_TRADE';
  selected: OpportunityCandidate | null;
  /** 평가된 후보 (rejectionReasons/decision 갱신본), 순위 포함 */
  evaluated: (OpportunityCandidate & { rank: number | null })[];
  noTradeReasons: string[];
}

/** regime이 해당 방향을 허용하는가 */
export function regimeAllowsDirection(regime: RegimeResult, direction: 'LONG' | 'SHORT'): boolean {
  if (!regime.tradeAllowed) return false;
  const want = direction === 'LONG' ? 'TREND_FOLLOW_LONG' : 'TREND_FOLLOW_SHORT';
  return regime.allowedStrategies.includes(want);
}

/**
 * 후보 순위·선정. 후보의 decision/rejectionReasons를 갱신해 반환.
 * NO_TRADE는 오류가 아니라 정상 의사결정이다.
 */
export function rankAndSelect(
  candidates: OpportunityCandidate[],
  regimes: Map<string, RegimeResult>,   // market address → regime
  gates: RankingGates,
): RankingResult {
  const globalBlocks: string[] = [];
  if (!gates.riskEngineAllowsEntry) globalBlocks.push(`RiskEngine 차단: ${gates.riskEngineBlockReason ?? '사유 미상'}`);
  if (gates.openPositionExists) globalBlocks.push('열린 포지션 존재 — 신규 후보 차단');
  if (gates.dailyEntryLimitReached) globalBlocks.push('일일 진입 횟수 초과');

  const T = RANKING_THRESHOLDS;
  const evaluated = candidates.map(c => {
    const reasons: string[] = [...c.rejectionReasons];
    let decision: CandidateDecision = c.decision;

    const reject = (r: string, d: CandidateDecision = 'REJECTED') => {
      reasons.push(r);
      // DATA_UNAVAILABLE이 이미 확정이면 유지 (더 심한 상태 우선)
      if (decision !== 'DATA_UNAVAILABLE') decision = d;
    };

    // 0. 전역 게이트
    for (const g of globalBlocks) reject(g);

    // 1. 데이터 품질
    if (c.dataQuality === 'UNAVAILABLE') reject('데이터 품질 UNAVAILABLE', 'DATA_UNAVAILABLE');

    // 2. regime 방향 허용
    const regime = regimes.get(c.market);
    if (!regime) reject('regime 미산출', 'DATA_UNAVAILABLE');
    else if (!regimeAllowsDirection(regime, c.direction)) {
      reject(`regime ${regime.regime}에서 ${c.direction} 비허용`);
    }

    // 4. 비용 snapshot 유효 (30초 실행 적격 계약 재사용)
    if (c.totalExpectedCostUsd === null) reject('비용 데이터 누락 — 0 대체 금지', 'DATA_UNAVAILABLE');
    else {
      const fetched = c.cost.costSnapshotFetchedAtMs;
      if (fetched === null || gates.nowMs - fetched > T.costSnapshotMaxAgeMs) {
        reject(`비용 snapshot 실행 적격 초과 (>${T.costSnapshotMaxAgeMs / 1000}s)`);
      }
    }

    // 5. 최소 손익비 / 신호
    if (c.rawSignalScore < T.minRawSignalScore) reject(`rawSignalScore ${c.rawSignalScore.toFixed(1)} < ${T.minRawSignalScore}`);
    if (c.expectedRMultiple !== null && c.expectedRMultiple < T.minExpectedRMultiple) {
      reject(`expected R ${c.expectedRMultiple.toFixed(2)} < ${T.minExpectedRMultiple}`);
    }
    if (c.expectedRMultiple === null) reject('expected R 산출 불가 (비용/입력 누락)');

    // 6. 순기대값 기준 — 보정 확률 없으면 LIVE/자율 후보 불가 (SHADOW_ONLY)
    if (c.expectedNetValueUsd === null) {
      if (decision === 'ELIGIBLE' || reasons.length === 0) {
        reasons.push('보정 확률 없음 — 순기대값 산출 불가, SHADOW_ONLY');
        decision = decision === 'DATA_UNAVAILABLE' ? decision : 'SHADOW_ONLY';
      } else if (decision !== 'DATA_UNAVAILABLE' && decision !== 'REJECTED') {
        decision = 'SHADOW_ONLY';
      }
    } else if (c.expectedNetValueUsd < T.minExpectedNetValueUsd) {
      reject(`순기대값 $${c.expectedNetValueUsd.toFixed(2)} < $${T.minExpectedNetValueUsd}`);
    }
    if (c.costToGrossEdgeRatio !== null && c.costToGrossEdgeRatio > T.maxCostToGrossEdgeRatio) {
      reject(`비용/edge 잠식비 ${(c.costToGrossEdgeRatio * 100).toFixed(0)}% > ${T.maxCostToGrossEdgeRatio * 100}%`);
    }

    // 7. 실행 위험
    if (c.executionRisk !== null && c.executionRisk > T.maxExecutionRisk) {
      reject(`실행 위험 ${c.executionRisk.toFixed(2)} > ${T.maxExecutionRisk}`);
    }
    if (c.executionRisk === null) reject('실행 위험 미산출');

    const finalDecision: CandidateDecision =
      reasons.length === 0 ? 'ELIGIBLE' : decision === 'ELIGIBLE' ? 'REJECTED' : decision;
    return { ...c, rejectionReasons: reasons, decision: finalDecision, rank: null as number | null };
  });

  // 8·9. 통과(ELIGIBLE) 후보끼리 risk-adjusted net value 비교 — 최상위 1개
  const eligible = evaluated.filter(c => c.decision === 'ELIGIBLE' && c.expectedNetValueUsd !== null);
  const riskAdj = (c: OpportunityCandidate) =>
    (c.expectedNetValueUsd ?? -Infinity) * (1 - ((c.volatilityRisk ?? 1) + (c.executionRisk ?? 1)) / 4);
  eligible.sort((a, b) => riskAdj(b) - riskAdj(a));
  eligible.forEach((c, i) => { (c as { rank: number | null }).rank = i + 1; });

  if (eligible.length === 0) {
    const reasons = globalBlocks.length > 0 ? globalBlocks
      : evaluated.length === 0 ? ['후보 없음 — 조건 충족 시장 없음']
        : ['모든 후보 기준 미달 — NO_TRADE는 정상 결과'];
    return { decision: 'NO_TRADE', selected: null, evaluated, noTradeReasons: reasons };
  }
  return { decision: 'SELECTED', selected: eligible[0], evaluated, noTradeReasons: [] };
}
