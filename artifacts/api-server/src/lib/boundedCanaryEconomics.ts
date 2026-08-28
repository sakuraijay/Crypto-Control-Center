import {
  EXECUTION_ELIGIBLE_MAX_AGE_MS,
  sanitizeCostError,
  validateExecutionEligibleSnapshot,
  type CostSnapshot,
} from './costSnapshot';
import { MANUAL_CANARY_CAPS } from './manualCanaryCaps';

export const BOUNDED_CANARY_NOTIONALS_USD =
  Object.freeze([2, 4, 6, 8, 10, 12, 14, 16, 18, 20] as const);
export const BOUNDED_CANARY_QUOTE_LIMIT =
  BOUNDED_CANARY_NOTIONALS_USD.length;

export type BoundedCanaryEconomicStatus =
  | 'AVAILABLE'
  | 'UNECONOMIC'
  | 'UNAVAILABLE';

export interface BoundedCanaryQuotePoint {
  notionalUsd: number;
  collateralUsd: number;
  leverage: number;
  roundTripCostUsd: number | null;
  withinCap: boolean | null;
  observedAtMs: number | null;
}

export interface BoundedCanaryObservedRange {
  minNotionalUsd: number;
  maxNotionalUsd: number;
  stepUsd: 2;
  observedPoints: number[];
}

export interface BoundedCanaryEconomicResult {
  status: BoundedCanaryEconomicStatus;
  symbol: 'BTC' | 'ETH';
  boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION';
  constraints: {
    maxNotionalUsd: 20;
    maxCollateralUsd: 10;
    maxLeverage: 2;
    maxRoundTripCostUsd: 0.4;
  };
  search: {
    minNotionalUsd: 2;
    maxNotionalUsd: 20;
    stepUsd: 2;
    quoteLimit: 10;
    testedQuoteCount: number;
    fetchedQuoteCount: number;
    complete: boolean;
    nonlinearInferenceUsed: false;
  };
  quotes: BoundedCanaryQuotePoint[];
  observedAffordableRanges: BoundedCanaryObservedRange[];
  evaluatedAtMs: number;
  expiresAtMs: number | null;
  failureId: string | null;
  detail: string;
}

export type BoundedCanaryQuoteResult =
  | { ok: true; snapshot: CostSnapshot }
  | { ok: false; reason: string };

const constraints = Object.freeze({
  maxNotionalUsd: 20 as const,
  maxCollateralUsd: 10 as const,
  maxLeverage: 2 as const,
  maxRoundTripCostUsd: 0.4 as const,
});

function immutableCapsMatch(): boolean {
  return MANUAL_CANARY_CAPS.maxNotionalUsd === constraints.maxNotionalUsd
    && MANUAL_CANARY_CAPS.maxCollateralUsd === constraints.maxCollateralUsd
    && MANUAL_CANARY_CAPS.maxLeverage === constraints.maxLeverage
    && MANUAL_CANARY_CAPS.maxRoundTripCostUsd
      === constraints.maxRoundTripCostUsd;
}

function observedRanges(
  affordable: number[],
): BoundedCanaryObservedRange[] {
  const ranges: BoundedCanaryObservedRange[] = [];
  for (const value of affordable) {
    const current = ranges[ranges.length - 1];
    if (current && value === current.maxNotionalUsd + 2) {
      current.maxNotionalUsd = value;
      current.observedPoints.push(value);
    } else {
      ranges.push({
        minNotionalUsd: value,
        maxNotionalUsd: value,
        stepUsd: 2,
        observedPoints: [value],
      });
    }
  }
  return ranges;
}

function unavailable(args: {
  symbol: 'BTC' | 'ETH';
  points: BoundedCanaryQuotePoint[];
  fetchedQuoteCount: number;
  evaluatedAtMs: number;
  failureId: string;
  detail: string;
}): BoundedCanaryEconomicResult {
  return {
    status: 'UNAVAILABLE',
    symbol: args.symbol,
    boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
    constraints,
    search: {
      minNotionalUsd: 2,
      maxNotionalUsd: 20,
      stepUsd: 2,
      quoteLimit: BOUNDED_CANARY_QUOTE_LIMIT,
      testedQuoteCount: args.points.length,
      fetchedQuoteCount: args.fetchedQuoteCount,
      complete: false,
      nonlinearInferenceUsed: false,
    },
    quotes: args.points,
    observedAffordableRanges: [],
    evaluatedAtMs: args.evaluatedAtMs,
    expiresAtMs: null,
    failureId: args.failureId,
    detail: sanitizeCostError(args.detail),
  };
}

/**
 * Evaluates only exact, independently quoted grid points. No interpolation,
 * extrapolation, monotonicity assumption, execution capability, or write API is
 * present in this module.
 */
export async function exploreBoundedCanaryEconomics(args: {
  symbol: 'BTC' | 'ETH';
  market: string;
  fetchQuote(input: {
    symbol: 'BTC' | 'ETH';
    isLong: true;
    notionalUsd: number;
  }): Promise<BoundedCanaryQuoteResult>;
  nowMs(): number;
  seedQuotes?: ReadonlyMap<number, BoundedCanaryQuoteResult>;
}): Promise<BoundedCanaryEconomicResult> {
  const points: BoundedCanaryQuotePoint[] = [];
  let fetchedQuoteCount = 0;
  let earliestExpiryMs = Number.POSITIVE_INFINITY;

  if (!immutableCapsMatch()) {
    return unavailable({
      symbol: args.symbol,
      points,
      fetchedQuoteCount,
      evaluatedAtMs: args.nowMs(),
      failureId: 'BOUNDED_CANARY_IMMUTABLE_CAP_MISMATCH',
      detail: 'canonical Canary hard cap 불일치 — bounded 진단 중단',
    });
  }

  for (const notionalUsd of BOUNDED_CANARY_NOTIONALS_USD) {
    const collateralUsd = notionalUsd / constraints.maxLeverage;
    if (
      notionalUsd > constraints.maxNotionalUsd
      || collateralUsd > constraints.maxCollateralUsd
    ) {
      return unavailable({
        symbol: args.symbol,
        points,
        fetchedQuoteCount,
        evaluatedAtMs: args.nowMs(),
        failureId: 'BOUNDED_CANARY_HARD_CAP_VIOLATION',
        detail: 'bounded search grid가 immutable Canary hard cap을 초과',
      });
    }

    let result = args.seedQuotes?.get(notionalUsd);
    if (!result) {
      fetchedQuoteCount += 1;
      try {
        result = await args.fetchQuote({
          symbol: args.symbol,
          isLong: true,
          notionalUsd,
        });
      } catch {
        result = {
          ok: false,
          reason: '공식 GMX read-only quote 호출 실패',
        };
      }
    }

    if (!result.ok) {
      return unavailable({
        symbol: args.symbol,
        points,
        fetchedQuoteCount,
        evaluatedAtMs: args.nowMs(),
        failureId: `BOUNDED_CANARY_${args.symbol}_QUOTE_UNAVAILABLE`,
        detail: result.reason,
      });
    }

    const snapshot = result.snapshot;
    if (Math.abs(snapshot.notionalUsd - notionalUsd) > 1e-9) {
      return unavailable({
        symbol: args.symbol,
        points,
        fetchedQuoteCount,
        evaluatedAtMs: args.nowMs(),
        failureId: `BOUNDED_CANARY_${args.symbol}_QUOTE_BINDING_INVALID`,
        detail: 'exact notional quote 결속 불일치 — quote 재사용 금지',
      });
    }
    const nowMs = args.nowMs();
    const validation = validateExecutionEligibleSnapshot(snapshot, {
      market: args.market,
      isLong: true,
      orderType: 'MarketIncrease',
      notionalUsd,
    }, nowMs);
    if (!validation.ok) {
      return unavailable({
        symbol: args.symbol,
        points,
        fetchedQuoteCount,
        evaluatedAtMs: nowMs,
        failureId: `BOUNDED_CANARY_${args.symbol}_QUOTE_INVALID`,
        detail: validation.reason,
      });
    }
    const observedAtMs = Date.parse(snapshot.apiTimestamp ?? '');
    const expiresAtMs = Math.min(
      Date.parse(snapshot.expiresAt),
      observedAtMs + EXECUTION_ELIGIBLE_MAX_AGE_MS,
    );
    if (!Number.isFinite(expiresAtMs)) {
      return unavailable({
        symbol: args.symbol,
        points,
        fetchedQuoteCount,
        evaluatedAtMs: nowMs,
        failureId: `BOUNDED_CANARY_${args.symbol}_FRESHNESS_UNAVAILABLE`,
        detail: 'quote freshness 경계 계산 불가',
      });
    }
    earliestExpiryMs = Math.min(earliestExpiryMs, expiresAtMs);
    points.push({
      notionalUsd,
      collateralUsd,
      leverage: constraints.maxLeverage,
      roundTripCostUsd: validation.effectiveRoundTripCostUsd,
      withinCap:
        validation.effectiveRoundTripCostUsd
        <= constraints.maxRoundTripCostUsd,
      observedAtMs,
    });
  }

  const affordable = points
    .filter((point) => point.withinCap)
    .map((point) => point.notionalUsd);
  const evaluatedAtMs = args.nowMs();
  if (evaluatedAtMs > earliestExpiryMs) {
    return unavailable({
      symbol: args.symbol,
      points,
      fetchedQuoteCount,
      evaluatedAtMs,
      failureId: `BOUNDED_CANARY_${args.symbol}_SET_STALE_AT_COMPLETION`,
      detail: 'bounded quote 집합 완료 전에 earliest quote freshness 만료',
    });
  }
  const status: BoundedCanaryEconomicStatus =
    affordable.length > 0 ? 'AVAILABLE' : 'UNECONOMIC';
  return {
    status,
    symbol: args.symbol,
    boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
    constraints,
    search: {
      minNotionalUsd: 2,
      maxNotionalUsd: 20,
      stepUsd: 2,
      quoteLimit: BOUNDED_CANARY_QUOTE_LIMIT,
      testedQuoteCount: points.length,
      fetchedQuoteCount,
      complete: true,
      nonlinearInferenceUsed: false,
    },
    quotes: points,
    observedAffordableRanges: observedRanges(affordable),
    evaluatedAtMs,
    expiresAtMs: earliestExpiryMs,
    failureId: status === 'UNECONOMIC'
      ? `BOUNDED_CANARY_${args.symbol}_UNECONOMIC`
      : null,
    detail: status === 'AVAILABLE'
      ? 'cap 이내 exact quote 관측점이 존재함 — 관측 grid 밖 구간은 추정하지 않음'
      : '모든 bounded exact quote 관측점이 round-trip cost cap을 초과',
  };
}

export function expireBoundedCanaryEconomicResult(
  result: BoundedCanaryEconomicResult,
  nowMs: number,
): BoundedCanaryEconomicResult {
  if (
    result.status === 'UNAVAILABLE'
    || result.expiresAtMs === null
    || nowMs <= result.expiresAtMs
  ) {
    return result;
  }
  return unavailable({
    symbol: result.symbol,
    points: result.quotes,
    fetchedQuoteCount: result.search.fetchedQuoteCount,
    evaluatedAtMs: nowMs,
    failureId: `BOUNDED_CANARY_${result.symbol}_STALE`,
    detail: 'bounded Canary quote 집합 freshness 만료 — 재조회 필요',
  });
}