import type {
  PaperCostEvidenceView,
  PaperRuntimeReadinessView,
} from './paperRuntimeReadiness';
import type { StopExecutionCapabilitySnapshot } from './stopExecutionCapabilityState';

export const PUBLIC_READINESS_COST_CAP_USD = 0.4 as const;

export type PublicReadinessSymbol = 'BTC' | 'ETH';

export interface PublicCostEvidence {
  symbol: PublicReadinessSymbol;
  direction: 'LONG';
  exactNotionalUsd: number;
  holdingHours: number;
  effectiveRoundTripCostUsd: number | null;
  observedAt: string | null;
  ageMs: number | null;
  fresh: boolean;
  capUsd: typeof PUBLIC_READINESS_COST_CAP_USD;
  withinCap: boolean | null;
  blockerIds: string[];
}

export interface PublicReadinessAttestation {
  boundary: 'SANITIZED_READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
  observedAt: string;
  costs: Record<PublicReadinessSymbol, PublicCostEvidence>;
  canary: {
    ready: boolean;
    blockerIds: string[];
  };
  stop: {
    ready: boolean;
    evaluatedAt: string | null;
    blockerIds: string[];
  };
}

function costBlocker(symbol: PublicReadinessSymbol, suffix: string): string {
  return `PUBLIC_COST_${symbol}_${suffix}`;
}

function projectCost(
  cost: PaperCostEvidenceView,
  symbol: PublicReadinessSymbol,
): PublicCostEvidence {
  const observedAt = cost.observedAtMs === null
    ? null
    : new Date(cost.observedAtMs).toISOString();
  const base = {
    symbol,
    direction: 'LONG' as const,
    exactNotionalUsd: cost.notionalUsd,
    holdingHours: cost.holdingHours,
    observedAt,
    ageMs: cost.ageMs,
    capUsd: PUBLIC_READINESS_COST_CAP_USD,
  };

  if (
    cost.observedAtMs === null
    || cost.state === 'not_evaluated'
    || cost.state === 'failed'
  ) {
    return {
      ...base,
      effectiveRoundTripCostUsd: null,
      fresh: false,
      withinCap: null,
      blockerIds: [costBlocker(symbol, 'UNAVAILABLE')],
    };
  }
  if (!cost.fresh || !cost.observationalFresh || !cost.executionSnapshot.fresh) {
    return {
      ...base,
      effectiveRoundTripCostUsd: null,
      fresh: false,
      withinCap: null,
      blockerIds: [costBlocker(symbol, 'STALE')],
    };
  }
  if (
    cost.state !== 'verified'
    || cost.capUsd !== PUBLIC_READINESS_COST_CAP_USD
    || !Number.isFinite(cost.effectiveRoundTripCostUsd)
    || cost.withinCap === null
  ) {
    return {
      ...base,
      effectiveRoundTripCostUsd: null,
      fresh: false,
      withinCap: null,
      blockerIds: [costBlocker(symbol, 'INVALID')],
    };
  }

  return {
    ...base,
    effectiveRoundTripCostUsd: cost.effectiveRoundTripCostUsd,
    fresh: true,
    withinCap: cost.withinCap,
    blockerIds: cost.withinCap ? [] : [costBlocker(symbol, 'CAP_EXCEEDED')],
  };
}

export function buildPublicReadinessAttestation(input: {
  nowMs: number;
  paper: PaperRuntimeReadinessView;
  stop: StopExecutionCapabilitySnapshot;
  canaryReady: boolean;
}): PublicReadinessAttestation {
  const costs = {
    BTC: projectCost(input.paper.costs.BTC, 'BTC'),
    ETH: projectCost(input.paper.costs.ETH, 'ETH'),
  };
  const stopBlockerIds = input.stop.available
    ? []
    : ['PUBLIC_STOP_CAPABILITY_UNAVAILABLE'];
  const diagnosticCanaryBlockerIds = [
    ...(input.paper.paperMode ? ['PUBLIC_CANARY_PAPER_MODE'] : []),
    ...costs.BTC.blockerIds,
    ...costs.ETH.blockerIds,
    ...stopBlockerIds,
  ];
  const canaryBlockerIds = input.canaryReady
    ? []
    : diagnosticCanaryBlockerIds.length > 0
      ? diagnosticCanaryBlockerIds
      : ['PUBLIC_CANARY_DETAILED_READINESS_BLOCKED'];

  return {
    boundary: 'SANITIZED_READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    observedAt: new Date(input.nowMs).toISOString(),
    costs,
    canary: {
      // Observational parity only: this never grants execution authorization.
      ready: input.canaryReady,
      blockerIds: [...new Set(canaryBlockerIds)],
    },
    stop: {
      ready: input.stop.available,
      evaluatedAt: input.stop.evaluatedAt,
      blockerIds: stopBlockerIds,
    },
  };
}