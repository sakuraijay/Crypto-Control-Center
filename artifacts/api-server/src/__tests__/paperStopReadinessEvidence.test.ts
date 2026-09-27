import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperRuntimeReadinessView } from '../lib/paperRuntimeReadiness';

const NOW = 1_777_000_000_000;
const PAPER_ENV = {
  WORKER_ENGINE_MODE: 'PAPER',
  GMX_API_READONLY_ENABLED: 'true',
} as NodeJS.ProcessEnv;

function verifiedMeta(observedAtMs = NOW - 1_000) {
  return {
    state: 'verified' as const,
    attemptedAtMs: NOW,
    observedAtMs,
    ageMs: NOW - observedAtMs,
    fresh: true,
    failureId: null,
    detail: 'injected read-only evidence',
  };
}

function completePaperView(): PaperRuntimeReadinessView {
  const diagnostics = {
    firstFailure: null,
    failures: [],
    sourceTraces: [],
    attemptCount: 1,
    retryCount: 0,
    failoverCount: 0,
    lastAttemptAtMs: NOW,
    lastSuccessAtMs: NOW,
    lastFailureAtMs: null,
    components: [],
  };
  const cost = (symbol: 'BTC' | 'ETH') => ({
    ...verifiedMeta(),
    evidenceRole: 'OBSERVATIONAL_READ_ONLY' as const,
    observationalFresh: true,
    symbol,
    direction: 'LONG' as const,
    notionalUsd: 20,
    holdingHours: 1,
    capUsd: 0.4,
    positionFeeUsd: 0.01,
    executionFeeUsd: 0.2,
    estimatedPriceImpactUsd: 0,
    fundingFeeUsd: 0,
    borrowingFeeUsd: 0,
    fundingRatePerHourFraction: 0,
    borrowingRatePerHourFraction: 0,
    estimatedExitFeeUsd: 0.01,
    estimatedExitPriceImpactUsd: 0,
    tradingFeesUsd: 0.02,
    priceImpactTotalUsd: 0,
    carryCostUsd: 0,
    otherCostUsd: 0,
    effectiveRoundTripCostUsd: 0.22,
    totalCostRatePct: 1.1,
    capDeltaUsd: -0.18,
    capExcessUsd: 0,
    capExcessRatePct: 0,
    requiredCostReductionUsd: 0,
    requiredCostReductionPct: 0,
    breakEvenGrossMoveUsd: 0.22,
    breakEvenGrossMovePct: 1.1,
    withinCap: true,
    blockReason: null,
    executionSnapshot: {
      fresh: true,
      eligible: true,
      authorized: false as const,
      maxAgeMs: 30_000,
      failureId: null,
      blockReason: null,
    },
    source: 'GMX_API',
    apiTimestamp: new Date(NOW - 1_000).toISOString(),
    fetchedAt: new Date(NOW - 1_000).toISOString(),
    diagnostics,
  });
  const bounded = (symbol: 'BTC' | 'ETH') => ({
    status: 'AVAILABLE' as const,
    symbol,
    boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION' as const,
    constraints: {
      maxNotionalUsd: 20 as const,
      maxCollateralUsd: 10 as const,
      maxLeverage: 2 as const,
      maxRoundTripCostUsd: 0.4 as const,
    },
    search: {
      minNotionalUsd: 2 as const,
      maxNotionalUsd: 20 as const,
      stepUsd: 2 as const,
      quoteLimit: 10 as const,
      testedQuoteCount: 10,
      fetchedQuoteCount: 10,
      complete: true,
      nonlinearInferenceUsed: false as const,
    },
    quotes: [],
    observedAffordableRanges: [],
    evaluatedAtMs: NOW,
    expiresAtMs: NOW + 30_000,
    failureId: null,
    detail: 'injected bounded read-only evidence',
    failedNotionalUsd: null,
    componentDiagnostics: [],
  });
  return {
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    paperMode: true,
    readonlyEnabled: true,
    scheduler: {
      running: true,
      inFlight: false,
      intervalMs: 60_000,
      lastAttemptAtMs: NOW,
      lastCompletedAtMs: NOW,
      lastSuccessAtMs: NOW,
      nextRefreshAtMs: NOW + 60_000,
      lastFailureId: null,
    },
    decimals: {
      BTC: { ...verifiedMeta(), decimals: 8, source: 'sdk+onchain', tokenAddress: 'btc' },
      ETH: { ...verifiedMeta(), decimals: 18, source: 'sdk+onchain', tokenAddress: 'eth' },
    },
    deployment: { ...verifiedMeta(), manifestVersion: 1 },
    rpc: { ...verifiedMeta(), chainId: 42161 },
    costs: { BTC: cost('BTC'), ETH: cost('ETH') },
    boundedCanaryEconomics: {
      BTC: bounded('BTC'),
      ETH: bounded('ETH'),
    },
    economics: {
      BTC: {
        state: 'UNAVAILABLE' as const,
        reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
        candidateNotionalUsd: 20,
        holdingHours: 1,
        expectedGrossEdgeFraction: null,
        expectedGrossEdgeUsd: null,
        expectedGrossEdgeSource: null,
        fixedExecutionCostUsd: null,
        variableCostRateFraction: null,
        denominatorFraction: null,
        economicMinimumNotionalUsd: null,
        technicalMinimumNotionalUsd: 2.2,
        requiredMinimumNotionalUsd: null,
        candidateSufficient: null,
        capUsd: 0.4,
        capRelationship: 'UNAVAILABLE' as const,
      },
      ETH: {
        state: 'UNAVAILABLE' as const,
        reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
        candidateNotionalUsd: 20,
        holdingHours: 1,
        expectedGrossEdgeFraction: null,
        expectedGrossEdgeUsd: null,
        expectedGrossEdgeSource: null,
        fixedExecutionCostUsd: null,
        variableCostRateFraction: null,
        denominatorFraction: null,
        economicMinimumNotionalUsd: null,
        technicalMinimumNotionalUsd: 2.2,
        requiredMinimumNotionalUsd: null,
        candidateSufficient: null,
        capUsd: 0.4,
        capRelationship: 'UNAVAILABLE' as const,
      },
    },
    blockerIds: [],
    manualActionHolds: [],
  };
}

describe('PAPER Stop readiness evidence cache', () => {
  beforeEach(async () => {
    vi.resetModules();
    const evidence = await import('../lib/paperStopReadinessEvidence');
    evidence.__resetPaperStopReadinessEvidenceForTests();
  });

  it('publishes the complete supporting table while execution authorization stays false', async () => {
    const evidence = await import('../lib/paperStopReadinessEvidence');
    const token = evidence.beginPaperStopReadinessEvidenceGeneration(7);
    const result = evidence.publishPaperStopReadinessEvidence({
      generation: 7,
      publicationToken: token,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: completePaperView(),
      evaluatedAtMs: NOW,
    });

    expect(result).toMatchObject({
      scope: 'PAPER_READ_ONLY_STOP_READINESS',
      boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
      readinessComplete: true,
      executionAuthorized: false,
      generation: 7,
      evaluatedAtMs: NOW,
      expiresAtMs: NOW + 90_000,
      fresh: true,
      missingConditionIds: [],
    });
    const executionIds = [
      'initialStopHandoffReady', 'schemaVerified', 'transportConfigured',
      'signerReady', 'durableStoreOk', 'reconciliationOk',
      'actionBudgetSufficient', 'freshFeeQuote', 'uncoveredCount',
      'blockingProtectionCount', 'executionUnlocked', 'decimalsSourceReady',
      'priceConversionVerified', 'evidenceCollectorReady',
      'protectionReconciliationClean', 'positionSnapshotFresh',
    ];
    expect(result.conditions.filter((entry) => entry.category === 'execution_required')
      .map((entry) => entry.id)).toEqual(executionIds);
    expect(result.conditions.filter((entry) => entry.category === 'execution_required')
      .every((entry) => entry.status === 'not_evaluated')).toBe(true);
    expect(result.conditions.find((entry) => entry.id === 'decimalsSourceReady'))
      .toMatchObject({
        status: 'not_evaluated',
        failureId: 'LIVE_DECIMALS_SOURCE_NOT_EVALUATED_IN_PAPER',
      });
  });

  it('fails closed for malformed evidence without retaining cost or cap values in failure details', async () => {
    const evidence = await import('../lib/paperStopReadinessEvidence');
    const view = completePaperView();
    view.decimals.BTC.decimals = 18;
    view.costs.ETH.withinCap = false;
    view.costs.ETH.effectiveRoundTripCostUsd = 99;
    const token = evidence.beginPaperStopReadinessEvidenceGeneration(1);
    const result = evidence.publishPaperStopReadinessEvidence({
      generation: 1,
      publicationToken: token,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [],
      paperRuntimeReadiness: view,
      evaluatedAtMs: NOW,
    });

    expect(result.readinessComplete).toBe(false);
    expect(result.missingConditionIds).toEqual(expect.arrayContaining([
      'healthyPeer', 'btcDecimals8', 'ethWithinCap',
    ]));
    for (const entry of result.conditions.filter((condition) =>
      condition.status === 'failed' || condition.status === 'stale')) {
      expect(entry.detail).not.toMatch(/\b(?:0\.4|99|20)\b|\$/);
    }
  });

  it.each([
    {
      name: 'over-cap cost even when upstream claims within cap',
      effectiveRoundTripCostUsd: 0.41,
      withinCap: true,
    },
    {
      name: 'negative cost even when upstream claims within cap',
      effectiveRoundTripCostUsd: -0.01,
      withinCap: true,
    },
    {
      name: 'non-finite cost',
      effectiveRoundTripCostUsd: Number.POSITIVE_INFINITY,
      withinCap: true,
    },
    {
      name: 'omitted cost',
      effectiveRoundTripCostUsd: undefined,
      withinCap: true,
    },
    {
      name: 'below-cap cost contradicted by upstream false',
      effectiveRoundTripCostUsd: 0.20,
      withinCap: false,
    },
  ])('independently rejects $name', async ({
    effectiveRoundTripCostUsd,
    withinCap,
  }) => {
    const evidence = await import('../lib/paperStopReadinessEvidence');
    const view = completePaperView();
    view.costs.BTC.effectiveRoundTripCostUsd =
      effectiveRoundTripCostUsd as number | null;
    view.costs.BTC.withinCap = withinCap;
    const token = evidence.beginPaperStopReadinessEvidenceGeneration(1);
    const result = evidence.publishPaperStopReadinessEvidence({
      generation: 1,
      publicationToken: token,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: view,
      evaluatedAtMs: NOW,
    });

    expect(result.readinessComplete).toBe(false);
    expect(result.missingConditionIds).toEqual(expect.arrayContaining([
      'btcCostEvidence',
      'btcWithinCap',
    ]));
    for (const id of ['btcCostEvidence', 'btcWithinCap']) {
      const failed = result.conditions.find((entry) => entry.id === id);
      expect(failed).toMatchObject({ status: 'failed', fresh: false });
      expect(failed?.detail).toBe(
        id === 'btcCostEvidence'
          ? 'Required read-only evidence is unavailable or invalid.'
          : 'Required read-only prerequisite is not satisfied.',
      );
      expect(failed?.detail).not.toMatch(/\b(?:0\.4|0\.41|0\.20|-0\.01)\b|\$/);
    }
  });

  it('invalidates success on a new generation, rejects stale publication, and expires at 90 seconds', async () => {
    const evidence = await import('../lib/paperStopReadinessEvidence');
    const firstToken = evidence.beginPaperStopReadinessEvidenceGeneration(1);
    evidence.publishPaperStopReadinessEvidence({
      generation: 1,
      publicationToken: firstToken,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: completePaperView(),
      evaluatedAtMs: NOW,
    });
    expect(evidence.getPaperStopReadinessEvidence(NOW, PAPER_ENV).readinessComplete).toBe(true);

    const secondToken = evidence.beginPaperStopReadinessEvidenceGeneration(2);
    expect(evidence.getPaperStopReadinessEvidence(NOW, PAPER_ENV)).toMatchObject({
      generation: 2,
      readinessComplete: false,
      evaluatedAtMs: null,
    });
    evidence.publishPaperStopReadinessEvidence({
      generation: 1,
      publicationToken: firstToken,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: completePaperView(),
      evaluatedAtMs: NOW,
    });
    expect(evidence.getPaperStopReadinessEvidence(NOW, PAPER_ENV).evaluatedAtMs).toBeNull();

    evidence.publishPaperStopReadinessEvidence({
      generation: 2,
      publicationToken: secondToken,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: completePaperView(),
      evaluatedAtMs: NOW,
    });
    const expired = evidence.getPaperStopReadinessEvidence(NOW + 90_000, PAPER_ENV);
    expect(expired).toMatchObject({ readinessComplete: false, fresh: false });
    expect(expired.conditions.filter((entry) => entry.category === 'supporting_readonly')
      .every((entry) => entry.status === 'stale')).toBe(true);
  });

  it('is cold after module restart and mode/read-only mismatch invalidates the cache', async () => {
    let evidence = await import('../lib/paperStopReadinessEvidence');
    const token = evidence.beginPaperStopReadinessEvidenceGeneration(1);
    evidence.publishPaperStopReadinessEvidence({
      generation: 1,
      publicationToken: token,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: completePaperView(),
      evaluatedAtMs: NOW,
    });
    expect(evidence.getPaperStopReadinessEvidence(NOW, {
      ...PAPER_ENV,
      WORKER_ENGINE_MODE: 'LIVE',
    }).readinessComplete).toBe(false);
    expect(evidence.getPaperStopReadinessEvidence(NOW, PAPER_ENV).evaluatedAtMs).toBeNull();

    vi.resetModules();
    evidence = await import('../lib/paperStopReadinessEvidence');
    expect(evidence.getPaperStopReadinessEvidence(NOW, PAPER_ENV)).toMatchObject({
      generation: null,
      evaluatedAtMs: null,
      readinessComplete: false,
      executionAuthorized: false,
    });
  });

  it('cannot change or authorize the separate shared LIVE Stop capability cache', async () => {
    const evidence = await import('../lib/paperStopReadinessEvidence');
    const stopState = await import('../lib/stopExecutionCapabilityState');
    stopState.setStopExecutionCapability({
      available: false,
      reasons: ['injected LIVE-only blocker'],
    }, '2026-09-01T00:00:00.000Z');
    const before = stopState.getStopExecutionCapability();

    const token = evidence.beginPaperStopReadinessEvidenceGeneration(1);
    const result = evidence.publishPaperStopReadinessEvidence({
      generation: 1,
      publicationToken: token,
      env: PAPER_ENV,
      readonlyEnabled: true,
      peerHealth: [{ ok: true }],
      paperRuntimeReadiness: completePaperView(),
      evaluatedAtMs: NOW,
    });

    expect(result.readinessComplete).toBe(true);
    expect(result.executionAuthorized).toBe(false);
    expect(stopState.getStopExecutionCapability()).toEqual(before);
    expect(stopState.isStopExecutionAvailable()).toBe(false);
  });

  it('has no durable, signer, execution, order, funds, relay-submission, or action imports', () => {
    const source = readFileSync(
      new URL('../lib/paperStopReadinessEvidence.ts', import.meta.url),
      'utf8',
    );
    const imports = [...source.matchAll(
      /(?:import|export)\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g,
    )].map((match) => match[1]);
    expect(imports).toEqual(['./manualCanaryCaps']);
    expect(imports.join(' ')).not.toMatch(
      /@workspace\/db|liveTestExecutor|signer|executionIntent|order|protection|fund|relaySubmission/i,
    );
    expect(source).not.toMatch(
      /\b(?:setStopExecutionCapability|prepareOrder|signOrder|submitOrder|placeOrder)\s*\(/,
    );
  });

  it('guards startup Stop capability refresh outside PAPER and does not statically import it', () => {
    const source = readFileSync(new URL('../startup.ts', import.meta.url), 'utf8');
    const liveExecutorStaticImport = source.match(
      /import\s+\{([\s\S]*?)\}\s+from\s+["']\.\/workers\/liveTestExecutor["'];/,
    )?.[1] ?? '';
    expect(liveExecutorStaticImport).not.toContain('refreshStopExecutionCapability');
    expect(source).toMatch(
      /WORKER_ENGINE_MODE !== 'PAPER'[\s\S]*import\('\.\/workers\/liveTestExecutor'\)[\s\S]*refreshStopExecutionCapability\(\)/,
    );
  });
});