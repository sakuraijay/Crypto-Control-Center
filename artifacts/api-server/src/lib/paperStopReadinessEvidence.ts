/**
 * Process-local PAPER Stop readiness explanation.
 *
 * This cache is diagnostic evidence only. It deliberately has no path to the
 * shared LIVE Stop capability state and no durable or execution dependencies.
 */
import { MANUAL_CANARY_CAPS } from './manualCanaryCaps';
import type { PaperRuntimeReadinessView } from './paperRuntimeReadiness';

export const PAPER_STOP_READINESS_EVIDENCE_TTL_MS = 90_000;

export type PaperStopReadinessConditionStatus =
  | 'verified'
  | 'failed'
  | 'stale'
  | 'not_evaluated';

export interface PaperStopReadinessCondition {
  id: string;
  label: string;
  category: 'supporting_readonly' | 'execution_required';
  status: PaperStopReadinessConditionStatus;
  source: string | null;
  observedAtMs: number | null;
  ageMs: number | null;
  fresh: boolean;
  failureId: string | null;
  detail: string | null;
}

export interface PaperStopReadinessEvidence {
  scope: 'PAPER_READ_ONLY_STOP_READINESS';
  boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
  readinessComplete: boolean;
  executionAuthorized: false;
  generation: number | null;
  evaluatedAtMs: number | null;
  expiresAtMs: number | null;
  fresh: boolean;
  reasons: string[];
  missingConditionIds: string[];
  conditions: PaperStopReadinessCondition[];
}

export interface PaperStopReadinessPublishInput {
  generation: number;
  /** Opaque process-local token returned by begin; prevents stale publication. */
  publicationToken: number;
  env: NodeJS.ProcessEnv;
  readonlyEnabled: boolean;
  peerHealth: Array<{ ok: boolean }> | null;
  paperRuntimeReadiness: PaperRuntimeReadinessView;
  evaluatedAtMs?: number;
}

export interface PaperStopReadinessUnavailableInput {
  generation: number;
  publicationToken: number;
  env: NodeJS.ProcessEnv;
  readonlyEnabled: boolean;
  peerHealth: Array<{ ok: boolean }> | null;
  failureId: string;
  reason: string;
  failedConditionIds?: string[];
  evaluatedAtMs?: number;
}

interface ConditionDefinition {
  id: string;
  label: string;
  category: PaperStopReadinessCondition['category'];
}

const SUPPORTING_DEFINITIONS: readonly ConditionDefinition[] = [
  { id: 'paperMode', label: 'Exact PAPER worker mode', category: 'supporting_readonly' },
  { id: 'readonlyEnabled', label: 'GMX API read-only enabled', category: 'supporting_readonly' },
  { id: 'healthyPeer', label: 'At least one healthy GMX API peer', category: 'supporting_readonly' },
  { id: 'deploymentVerified', label: 'Fresh verified deployment', category: 'supporting_readonly' },
  { id: 'arbitrumRpc42161', label: 'Fresh verified Arbitrum RPC chain 42161', category: 'supporting_readonly' },
  { id: 'btcDecimals8', label: 'Fresh BTC decimals equal 8', category: 'supporting_readonly' },
  { id: 'ethDecimals18', label: 'Fresh ETH decimals equal 18', category: 'supporting_readonly' },
  { id: 'btcCostEvidence', label: 'Fresh validated BTC $20 LONG 1h cost evidence', category: 'supporting_readonly' },
  { id: 'ethCostEvidence', label: 'Fresh validated ETH $20 LONG 1h cost evidence', category: 'supporting_readonly' },
  { id: 'canonicalCostCap', label: 'Exact canonical round-trip cap is $0.40', category: 'supporting_readonly' },
  { id: 'btcWithinCap', label: 'BTC cost is within canonical cap', category: 'supporting_readonly' },
  { id: 'ethWithinCap', label: 'ETH cost is within canonical cap', category: 'supporting_readonly' },
] as const;

const EXECUTION_DEFINITIONS: readonly ConditionDefinition[] = [
  { id: 'initialStopHandoffReady', label: 'Initial Stop handoff ready', category: 'execution_required' },
  { id: 'schemaVerified', label: 'Stop schema verified', category: 'execution_required' },
  { id: 'transportConfigured', label: 'Execution transport configured', category: 'execution_required' },
  { id: 'signerReady', label: 'Execution signer ready', category: 'execution_required' },
  { id: 'durableStoreOk', label: 'Durable protection store available', category: 'execution_required' },
  { id: 'reconciliationOk', label: 'Execution reconciliation complete', category: 'execution_required' },
  { id: 'actionBudgetSufficient', label: 'Execution action budget sufficient', category: 'execution_required' },
  { id: 'freshFeeQuote', label: 'Fresh execution fee quote', category: 'execution_required' },
  { id: 'uncoveredCount', label: 'No uncovered live positions', category: 'execution_required' },
  { id: 'blockingProtectionCount', label: 'No blocking protection orders', category: 'execution_required' },
  { id: 'executionUnlocked', label: 'LIVE execution unlocked', category: 'execution_required' },
  { id: 'decimalsSourceReady', label: 'Index token decimals source ready', category: 'execution_required' },
  { id: 'priceConversionVerified', label: 'Execution price conversion verified', category: 'execution_required' },
  { id: 'evidenceCollectorReady', label: 'Execution evidence collector ready', category: 'execution_required' },
  { id: 'protectionReconciliationClean', label: 'Protection reconciliation clean', category: 'execution_required' },
  { id: 'positionSnapshotFresh', label: 'Authoritative position snapshot fresh', category: 'execution_required' },
] as const;

let activeGeneration: number | null = null;
let cached: PaperStopReadinessEvidence | null = null;
let publicationSequence = 0;
let activePublicationToken: number | null = null;
let cachedMode: string | undefined;
let cachedReadonlyEnabled: boolean | null = null;

function condition(
  definition: ConditionDefinition,
  status: PaperStopReadinessConditionStatus,
  options: {
    source?: string | null;
    observedAtMs?: number | null;
    nowMs?: number;
    failureId?: string | null;
    detail?: string | null;
  } = {},
): PaperStopReadinessCondition {
  const observedAtMs = options.observedAtMs ?? null;
  const ageMs = observedAtMs === null || options.nowMs === undefined
    ? null
    : Math.max(0, options.nowMs - observedAtMs);
  return {
    ...definition,
    status,
    source: options.source ?? null,
    observedAtMs,
    ageMs,
    fresh: status === 'verified',
    failureId: status === 'verified' ? null : options.failureId ?? 'PAPER_EVIDENCE_UNAVAILABLE',
    detail: options.detail ?? null,
  };
}

function unevaluatedEvidence(generation: number | null): PaperStopReadinessEvidence {
  const conditions = [...SUPPORTING_DEFINITIONS, ...EXECUTION_DEFINITIONS].map((definition) =>
    condition(definition, 'not_evaluated', {
      failureId: definition.category === 'execution_required'
        ? 'EXECUTION_EVIDENCE_NOT_EVALUATED_IN_PAPER'
        : 'PAPER_READINESS_NOT_EVALUATED',
      detail: definition.category === 'execution_required'
        ? 'Execution-only requirement is not evaluated by PAPER read-only readiness.'
        : 'A completed current PAPER read-only generation is required.',
    }));
  return {
    scope: 'PAPER_READ_ONLY_STOP_READINESS',
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    readinessComplete: false,
    executionAuthorized: false,
    generation,
    evaluatedAtMs: null,
    expiresAtMs: null,
    fresh: false,
    reasons: ['PAPER Stop readiness evidence is unavailable (fail-closed).'],
    missingConditionIds: SUPPORTING_DEFINITIONS.map(({ id }) => id),
    conditions,
  };
}

function fromMeta(
  definition: ConditionDefinition,
  meta: {
    state: string;
    fresh: boolean;
    observedAtMs: number | null;
  },
  valid: boolean,
  nowMs: number,
  source: string,
  failureId: string,
): PaperStopReadinessCondition {
  if (meta.state === 'stale') {
    return condition(definition, 'stale', {
      source,
      observedAtMs: meta.observedAtMs,
      nowMs,
      failureId: `${failureId}_STALE`,
      detail: 'Previously observed read-only evidence is stale.',
    });
  }
  if (meta.state === 'verified' && meta.fresh === true && valid
    && typeof meta.observedAtMs === 'number' && Number.isFinite(meta.observedAtMs)) {
    return condition(definition, 'verified', {
      source,
      observedAtMs: meta.observedAtMs,
      nowMs,
      detail: 'Fresh read-only evidence verified.',
    });
  }
  return condition(definition, meta.state === 'not_evaluated' ? 'not_evaluated' : 'failed', {
    source,
    observedAtMs: meta.observedAtMs,
    nowMs,
    failureId,
    detail: 'Required read-only evidence is unavailable or invalid.',
  });
}

export function beginPaperStopReadinessEvidenceGeneration(generation: number): number {
  activeGeneration = generation;
  activePublicationToken = ++publicationSequence;
  cached = null;
  cachedMode = undefined;
  cachedReadonlyEnabled = null;
  return activePublicationToken;
}

export function publishPaperStopReadinessEvidence(
  input: PaperStopReadinessPublishInput,
): PaperStopReadinessEvidence {
  if (activeGeneration !== input.generation
    || activePublicationToken !== input.publicationToken) {
    return getPaperStopReadinessEvidence(input.evaluatedAtMs ?? Date.now(), input.env);
  }

  const nowMs = input.evaluatedAtMs ?? Date.now();
  const paper = input.paperRuntimeReadiness;
  const byId = new Map(SUPPORTING_DEFINITIONS.map((definition) => [definition.id, definition]));
  const conditions: PaperStopReadinessCondition[] = [];
  const booleanCondition = (
    id: string,
    ok: boolean,
    source: string,
    failureId: string,
  ) => conditions.push(condition(byId.get(id)!, ok ? 'verified' : 'failed', {
    source,
    observedAtMs: ok ? nowMs : null,
    nowMs,
    failureId,
    detail: ok ? 'Read-only prerequisite verified.' : 'Required read-only prerequisite is not satisfied.',
  }));

  booleanCondition('paperMode',
    input.env.WORKER_ENGINE_MODE === 'PAPER' && paper.paperMode === true,
    'WORKER_ENGINE_MODE', 'PAPER_MODE_REQUIRED');
  booleanCondition('readonlyEnabled',
    input.readonlyEnabled === true
      && input.env.GMX_API_READONLY_ENABLED === 'true'
      && paper.readonlyEnabled === true,
    'GMX_API_READONLY_ENABLED', 'READONLY_MODE_REQUIRED');
  booleanCondition('healthyPeer',
    Array.isArray(input.peerHealth) && input.peerHealth.some((peer) => peer?.ok === true),
    'GMX_API_PEER_HEALTH', 'HEALTHY_PEER_REQUIRED');

  conditions.push(fromMeta(byId.get('deploymentVerified')!, paper.deployment,
    paper.deployment.state === 'verified'
      && typeof paper.deployment.manifestVersion === 'number'
      && Number.isInteger(paper.deployment.manifestVersion)
      && paper.deployment.manifestVersion > 0,
    nowMs, 'PAPER_DEPLOYMENT_EVIDENCE',
    'DEPLOYMENT_EVIDENCE_INVALID'));
  conditions.push(fromMeta(byId.get('arbitrumRpc42161')!, paper.rpc,
    paper.rpc.chainId === 42161, nowMs, 'PAPER_ARBITRUM_RPC_EVIDENCE',
    'ARBITRUM_RPC_EVIDENCE_INVALID'));

  for (const [symbol, expected, id] of [
    ['BTC', 8, 'btcDecimals8'],
    ['ETH', 18, 'ethDecimals18'],
  ] as const) {
    const evidence = paper.decimals[symbol];
    conditions.push(fromMeta(byId.get(id)!, evidence,
      evidence.decimals === expected && typeof evidence.source === 'string',
      nowMs, `PAPER_${symbol}_DECIMALS_EVIDENCE`, `${symbol}_DECIMALS_EVIDENCE_INVALID`));
  }

  for (const symbol of ['BTC', 'ETH'] as const) {
    const evidence = paper.costs[symbol];
    const evidenceId = `${symbol.toLowerCase()}CostEvidence`;
    conditions.push(fromMeta(byId.get(evidenceId)!, evidence,
      evidence.direction === 'LONG'
        && evidence.notionalUsd === 20
        && evidence.holdingHours === 1
        && evidence.capUsd === MANUAL_CANARY_CAPS.maxRoundTripCostUsd
        && typeof evidence.effectiveRoundTripCostUsd === 'number'
        && Number.isFinite(evidence.effectiveRoundTripCostUsd)
        && evidence.effectiveRoundTripCostUsd >= 0
        && evidence.effectiveRoundTripCostUsd <= MANUAL_CANARY_CAPS.maxRoundTripCostUsd
        && evidence.withinCap === true
        && typeof evidence.source === 'string',
      nowMs, `PAPER_${symbol}_COST_EVIDENCE`, `${symbol}_COST_EVIDENCE_INVALID`));
  }

  booleanCondition('canonicalCostCap',
    MANUAL_CANARY_CAPS.maxRoundTripCostUsd === 0.40,
    'MANUAL_CANARY_CAPS', 'CANONICAL_COST_CAP_MISMATCH');
  for (const symbol of ['BTC', 'ETH'] as const) {
    const evidence = paper.costs[symbol];
    const evidenceCondition = conditions.find((entry) =>
      entry.id === `${symbol.toLowerCase()}CostEvidence`);
    booleanCondition(`${symbol.toLowerCase()}WithinCap`,
      evidenceCondition?.status === 'verified'
        && evidence.capUsd === MANUAL_CANARY_CAPS.maxRoundTripCostUsd
        && typeof evidence.effectiveRoundTripCostUsd === 'number'
        && Number.isFinite(evidence.effectiveRoundTripCostUsd)
        && evidence.effectiveRoundTripCostUsd >= 0
        && evidence.effectiveRoundTripCostUsd <= MANUAL_CANARY_CAPS.maxRoundTripCostUsd
        && evidence.withinCap === true,
      `PAPER_${symbol}_COST_EVIDENCE`, `${symbol}_COST_CAP_NOT_SATISFIED`);
  }

  for (const definition of EXECUTION_DEFINITIONS) {
    conditions.push(condition(definition, 'not_evaluated', {
      failureId: definition.id === 'decimalsSourceReady'
        ? 'LIVE_DECIMALS_SOURCE_NOT_EVALUATED_IN_PAPER'
        : 'EXECUTION_EVIDENCE_NOT_EVALUATED_IN_PAPER',
      detail: definition.id === 'decimalsSourceReady'
        ? 'PAPER token observations do not verify the LIVE execution decimals source.'
        : 'Execution-only requirement is not evaluated by PAPER read-only readiness.',
    }));
  }

  const missingConditionIds = conditions
    .filter((entry) => entry.category === 'supporting_readonly' && entry.status !== 'verified')
    .map((entry) => entry.id);
  const readinessComplete = missingConditionIds.length === 0;
  const executionReasons = conditions
    .filter((entry) => entry.category === 'execution_required' && entry.status !== 'verified')
    .map((entry) => `${entry.id}: execution-only evidence is not evaluated in PAPER.`);
  cached = {
    scope: 'PAPER_READ_ONLY_STOP_READINESS',
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    readinessComplete,
    executionAuthorized: false,
    generation: input.generation,
    evaluatedAtMs: nowMs,
    expiresAtMs: nowMs + PAPER_STOP_READINESS_EVIDENCE_TTL_MS,
    fresh: true,
    reasons: [
      ...(readinessComplete
        ? ['PAPER read-only Stop readiness is complete; LIVE execution remains unauthorized.']
        : missingConditionIds.map((id) =>
          `${id}: required PAPER read-only evidence is incomplete.`)),
      ...executionReasons,
    ],
    missingConditionIds,
    conditions,
  };
  cachedMode = input.env.WORKER_ENGINE_MODE;
  cachedReadonlyEnabled = input.env.GMX_API_READONLY_ENABLED === 'true';
  return cloneEvidence(cached);
}

/**
 * Publish a completed, explicit fail-closed generation when the read-only
 * pipeline could not produce a PaperRuntimeReadinessView.
 */
export function publishPaperStopReadinessEvidenceUnavailable(
  input: PaperStopReadinessUnavailableInput,
): PaperStopReadinessEvidence {
  if (activeGeneration !== input.generation
    || activePublicationToken !== input.publicationToken) {
    return getPaperStopReadinessEvidence(input.evaluatedAtMs ?? Date.now(), input.env);
  }
  const nowMs = input.evaluatedAtMs ?? Date.now();
  const failedIds = new Set(input.failedConditionIds ?? []);
  const conditions = SUPPORTING_DEFINITIONS.map((definition) => {
    let verified = false;
    let evaluated = false;
    if (definition.id === 'paperMode') {
      evaluated = true;
      verified = input.env.WORKER_ENGINE_MODE === 'PAPER';
    } else if (definition.id === 'readonlyEnabled') {
      evaluated = true;
      verified = input.readonlyEnabled
        && input.env.GMX_API_READONLY_ENABLED === 'true';
    } else if (definition.id === 'healthyPeer' && input.peerHealth !== null) {
      evaluated = true;
      verified = input.peerHealth.some((peer) => peer?.ok === true);
    } else if (definition.id === 'canonicalCostCap') {
      evaluated = true;
      verified = MANUAL_CANARY_CAPS.maxRoundTripCostUsd === 0.40;
    }
    if (failedIds.has(definition.id)) {
      evaluated = true;
      verified = false;
    }
    return condition(
      definition,
      verified ? 'verified' : evaluated ? 'failed' : 'not_evaluated',
      {
        source: evaluated ? 'PAPER_READINESS_COORDINATOR' : null,
        observedAtMs: verified ? nowMs : null,
        nowMs,
        failureId: verified
          ? null
          : failedIds.has(definition.id)
            ? input.failureId
            : evaluated
              ? `${definition.id.toUpperCase()}_NOT_SATISFIED`
              : 'PAPER_DEPENDENCY_NOT_EVALUATED',
        detail: verified
          ? 'Read-only prerequisite verified.'
          : failedIds.has(definition.id)
            ? 'The current read-only readiness stage failed.'
            : evaluated
              ? 'Required read-only prerequisite is not satisfied.'
              : 'Dependency was not evaluated in the current generation.',
      },
    );
  });
  conditions.push(...EXECUTION_DEFINITIONS.map((definition) =>
    condition(definition, 'not_evaluated', {
      failureId: definition.id === 'decimalsSourceReady'
        ? 'LIVE_DECIMALS_SOURCE_NOT_EVALUATED_IN_PAPER'
        : 'EXECUTION_EVIDENCE_NOT_EVALUATED_IN_PAPER',
      detail: definition.id === 'decimalsSourceReady'
        ? 'PAPER token observations do not verify the LIVE execution decimals source.'
        : 'Execution-only requirement is not evaluated by PAPER read-only readiness.',
    })));
  const missingConditionIds = conditions
    .filter((entry) => entry.category === 'supporting_readonly' && entry.status !== 'verified')
    .map((entry) => entry.id);
  cached = {
    scope: 'PAPER_READ_ONLY_STOP_READINESS',
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    readinessComplete: false,
    executionAuthorized: false,
    generation: input.generation,
    evaluatedAtMs: nowMs,
    expiresAtMs: nowMs + PAPER_STOP_READINESS_EVIDENCE_TTL_MS,
    fresh: true,
    reasons: [input.reason],
    missingConditionIds,
    conditions,
  };
  cachedMode = input.env.WORKER_ENGINE_MODE;
  cachedReadonlyEnabled = input.env.GMX_API_READONLY_ENABLED === 'true';
  return cloneEvidence(cached);
}

function cloneEvidence(value: PaperStopReadinessEvidence): PaperStopReadinessEvidence {
  return {
    ...value,
    reasons: [...value.reasons],
    missingConditionIds: [...value.missingConditionIds],
    conditions: value.conditions.map((entry) => ({ ...entry })),
  };
}

export function getPaperStopReadinessEvidence(
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): PaperStopReadinessEvidence {
  if (!cached) return unevaluatedEvidence(activeGeneration);
  if (env.WORKER_ENGINE_MODE !== cachedMode
    || (env.GMX_API_READONLY_ENABLED === 'true') !== cachedReadonlyEnabled) {
    cached = null;
    cachedMode = undefined;
    cachedReadonlyEnabled = null;
    return unevaluatedEvidence(activeGeneration);
  }
  if (cached.expiresAtMs === null || nowMs >= cached.expiresAtMs) {
    const expired = cloneEvidence(cached);
    expired.readinessComplete = false;
    expired.fresh = false;
    expired.reasons = ['PAPER Stop readiness evidence expired (fail-closed).'];
    expired.missingConditionIds = SUPPORTING_DEFINITIONS.map(({ id }) => id);
    expired.conditions = expired.conditions.map((entry) =>
      entry.category === 'supporting_readonly' && entry.status === 'verified'
        ? {
          ...entry,
          status: 'stale',
          fresh: false,
          failureId: 'PAPER_STOP_READINESS_CACHE_EXPIRED',
          detail: 'Cached read-only readiness evidence is stale.',
          ageMs: entry.observedAtMs === null ? null : Math.max(0, nowMs - entry.observedAtMs),
        }
        : entry);
    return expired;
  }
  return cloneEvidence(cached);
}

export function __resetPaperStopReadinessEvidenceForTests(): void {
  activeGeneration = null;
  activePublicationToken = null;
  cached = null;
  cachedMode = undefined;
  cachedReadonlyEnabled = null;
}