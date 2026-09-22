import { createHash } from 'node:crypto';
import type { PaperLearningValidationSample } from './virtualPaperLearningValidation';

export const PAPER_LEARNING_WALK_FORWARD_VERSION = 'paper-learning-walk-forward/v1' as const;

export interface PaperLearningWalkForwardConfig {
  initialTrainCount: number;
  validationCount: number;
  testCount: number;
  stepCount: number;
}

export interface PaperLearningWalkForwardInput {
  datasetSha256: string;
  samples: readonly PaperLearningValidationSample[];
  config: PaperLearningWalkForwardConfig;
  nowMs: number;
}

type OutcomeSegment = 'validation' | 'test';
type PurgeReason = 'LABEL_OVERLAPS_VALIDATION_START' | 'LABEL_OVERLAPS_TEST_START';

interface PurgedSample {
  sampleId: string;
  positionId: string;
  fromSegment: 'train' | 'validation';
  reason: PurgeReason;
  boundaryAt: string;
  labelAvailableAt: string;
}

const strictIsoMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
};

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const validCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const round = (value: number): number => Number(value.toPrecision(12));
const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function summarizeOutcomes(samples: readonly PaperLearningValidationSample[]) {
  let grossSum = 0;
  let costSum = 0;
  for (const sample of samples) {
    grossSum += sample.labels.grossPnlUsd;
    costSum += sample.labels.estimatedCostsUsd;
    if (!finite(grossSum) || !finite(costSum)) return { ok: false as const };
  }
  const observedGrossPnlUsd = round(grossSum);
  const observedModeledCostUsd = round(costSum);
  const baselineNet = observedGrossPnlUsd - observedModeledCostUsd;
  const doubledCost = 2 * observedModeledCostUsd;
  const stressedNet = observedGrossPnlUsd - doubledCost;
  if (![observedGrossPnlUsd, observedModeledCostUsd, baselineNet, doubledCost, stressedNet].every(finite)) {
    return { ok: false as const };
  }
  const observedNetPnlUsd = round(baselineNet);
  const twoXCostStressNetPnlUsd = round(stressedNet);
  const realizedOrder = [...samples].sort((a, b) =>
    Date.parse(a.labelAvailableAt) - Date.parse(b.labelAvailableAt)
    || Date.parse(a.openedAt) - Date.parse(b.openedAt)
    || ordinal(a.sampleId, b.sampleId));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const sample of realizedOrder) {
    const sampleNet = sample.labels.grossPnlUsd - sample.labels.estimatedCostsUsd;
    const nextCumulative = cumulative + sampleNet;
    if (!finite(sampleNet) || !finite(nextCumulative)) return { ok: false as const };
    cumulative = round(nextCumulative);
    peak = Math.max(peak, cumulative);
    const drawdown = peak - cumulative;
    if (!finite(cumulative) || !finite(peak) || !finite(drawdown)) return { ok: false as const };
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdown);
    if (!finite(maxDrawdownUsd)) return { ok: false as const };
  }
  const expectancyPerTradeUsd = round(observedNetPnlUsd / samples.length);
  const winRate = round(samples.filter(sample =>
    sample.labels.grossPnlUsd - sample.labels.estimatedCostsUsd > 0).length / samples.length);
  const roundedMaxDrawdownUsd = round(maxDrawdownUsd);
  if (![observedNetPnlUsd, twoXCostStressNetPnlUsd, expectancyPerTradeUsd,
    winRate, roundedMaxDrawdownUsd].every(finite)) return { ok: false as const };
  return { ok: true as const, value: {
    sampleCount: samples.length,
    observedGrossPnlUsd,
    observedModeledCostUsd,
    observedNetPnlUsd,
    twoXCostStressNetPnlUsd,
    expectancyPerTradeUsd,
    winRate,
    maxDrawdownUsd: roundedMaxDrawdownUsd,
    drawdownBasis: 'LABEL_AVAILABLE_AT' as const,
    drawdownSampleIds: realizedOrder.map(sample => sample.sampleId),
  } };
}

function reportHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function evaluatePaperLearningWalkForward(input: PaperLearningWalkForwardInput) {
  const unavailableReasons: string[] = [];
  if (!/^[a-f0-9]{64}$/.test(input.datasetSha256)) unavailableReasons.push('DATASET_HASH_INVALID');
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) {
    unavailableReasons.push('EVALUATION_TIME_INVALID');
  }
  const configFields = ['initialTrainCount', 'validationCount', 'testCount', 'stepCount'] as const;
  const rawConfig = input.config as unknown as Record<string, unknown> | null;
  if (!rawConfig || typeof rawConfig !== 'object'
    || Object.keys(rawConfig).some(key => !configFields.includes(key as typeof configFields[number]))) {
    unavailableReasons.push('CONFIG_KEYS_INVALID');
  }
  const canonicalConfig = {
    initialTrainCount: rawConfig?.initialTrainCount,
    validationCount: rawConfig?.validationCount,
    testCount: rawConfig?.testCount,
    stepCount: rawConfig?.stepCount,
  };
  for (const [key, value] of Object.entries(canonicalConfig)) {
    if (!validCount(value)) unavailableReasons.push(`${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}_INVALID`);
  }

  const rawSamples = Array.isArray(input.samples) ? [...input.samples] : [];
  if (!Array.isArray(input.samples)) unavailableReasons.push('SAMPLES_INVALID');
  const ordered = rawSamples.sort((a, b) =>
    (strictIsoMs(a.openedAt) ?? Infinity) - (strictIsoMs(b.openedAt) ?? Infinity)
    || ordinal(typeof a.sampleId === 'string' ? a.sampleId : '',
      typeof b.sampleId === 'string' ? b.sampleId : ''));
  if (duplicateValues(ordered.map(sample => sample.sampleId).filter((id): id is string => typeof id === 'string')).length > 0) {
    unavailableReasons.push('DUPLICATE_SAMPLE_ID');
  }
  if (duplicateValues(ordered.map(sample => sample.positionId).filter((id): id is string => typeof id === 'string')).length > 0) {
    unavailableReasons.push('DUPLICATE_POSITION_ID');
  }
  if (duplicateValues(ordered.flatMap(sample =>
    Array.isArray(sample.labels?.settlementIds) ? [...sample.labels.settlementIds] : [])).length > 0) {
    unavailableReasons.push('DUPLICATE_SETTLEMENT_ID');
  }
  for (const sample of ordered) {
    const featureAt = strictIsoMs(sample.featureAt);
    const openedAt = strictIsoMs(sample.openedAt);
    const labelAvailableAt = strictIsoMs(sample.labelAvailableAt);
    if (typeof sample.sampleId !== 'string' || sample.sampleId.length === 0
      || typeof sample.positionId !== 'string' || sample.positionId.length === 0 || featureAt === null
      || openedAt === null || labelAvailableAt === null) {
      unavailableReasons.push('SAMPLE_ID_OR_TIME_INVALID');
      continue;
    }
    if (featureAt > openedAt || openedAt > labelAvailableAt) {
      unavailableReasons.push('SAMPLE_TIME_ORDER_INVALID');
    }
    if (featureAt > input.nowMs || openedAt > input.nowMs || labelAvailableAt > input.nowMs) {
      unavailableReasons.push('FUTURE_SAMPLE_EVIDENCE');
    }
    if (!sample.labels || !finite(sample.labels.grossPnlUsd) || !finite(sample.labels.netPnlUsd)) {
      unavailableReasons.push('STORED_LABEL_INVALID');
    }
    if (!sample.labels || !finite(sample.labels.estimatedCostsUsd) || sample.labels.estimatedCostsUsd < 0) {
      unavailableReasons.push('MODELED_COST_MISSING_OR_INVALID');
    } else if (finite(sample.labels?.grossPnlUsd) && finite(sample.labels?.netPnlUsd)) {
      const recomputedNet = sample.labels.grossPnlUsd - sample.labels.estimatedCostsUsd;
      if (!finite(recomputedNet)) {
        unavailableReasons.push('SAMPLE_ARITHMETIC_NON_FINITE');
        continue;
      }
      const tolerance = Math.max(1e-9, Math.abs(recomputedNet) * 1e-9);
      if (Math.abs(sample.labels.netPnlUsd - recomputedNet) > tolerance) {
        unavailableReasons.push('STORED_NET_COST_ARITHMETIC_MISMATCH');
      }
    }
    if (!Array.isArray(sample.labels?.settlementIds)
      || sample.labels.settlementIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)) {
      unavailableReasons.push('SETTLEMENT_IDS_INVALID');
    }
  }

  const initialTrainCount = validCount(canonicalConfig.initialTrainCount) ? canonicalConfig.initialTrainCount : 0;
  const validationCount = validCount(canonicalConfig.validationCount) ? canonicalConfig.validationCount : 0;
  const testCount = validCount(canonicalConfig.testCount) ? canonicalConfig.testCount : 0;
  const stepCount = validCount(canonicalConfig.stepCount) ? canonicalConfig.stepCount : 0;
  const countsValid = initialTrainCount > 0 && validationCount > 0 && testCount > 0 && stepCount > 0;
  if (countsValid
    && ordered.length < initialTrainCount + validationCount + testCount) {
    unavailableReasons.push('INSUFFICIENT_SAMPLES');
  }

  const folds: Array<{
    foldIndex: number;
    rawRanges: {
      train: { startIndex: number; endIndexExclusive: number };
      validation: { startIndex: number; endIndexExclusive: number };
      test: { startIndex: number; endIndexExclusive: number };
    };
    boundaries: { validationStartAt: string; testStartAt: string };
    train: { sampleIds: string[]; sampleCount: number };
    validation: NonNullable<ReturnType<typeof summarizeOutcomes>['value']> & { sampleIds: string[] };
    test: NonNullable<ReturnType<typeof summarizeOutcomes>['value']> & { sampleIds: string[] };
    purged: PurgedSample[];
  }> = [];

  if (unavailableReasons.length === 0) {
    for (let trainEnd = initialTrainCount, foldIndex = 0;
      trainEnd + validationCount + testCount <= ordered.length;
      trainEnd += stepCount, foldIndex += 1) {
      const validationEnd = trainEnd + validationCount;
      const testEnd = validationEnd + testCount;
      const validationStartAt = ordered[trainEnd].openedAt;
      const testStartAt = ordered[validationEnd].openedAt;
      const purged: PurgedSample[] = [];
      const train = ordered.slice(0, trainEnd).filter(sample => {
        if (Date.parse(sample.labelAvailableAt) < Date.parse(validationStartAt)) return true;
        purged.push({
          sampleId: sample.sampleId, positionId: sample.positionId, fromSegment: 'train',
          reason: 'LABEL_OVERLAPS_VALIDATION_START', boundaryAt: validationStartAt,
          labelAvailableAt: sample.labelAvailableAt,
        });
        return false;
      });
      const validation = ordered.slice(trainEnd, validationEnd).filter(sample => {
        if (Date.parse(sample.labelAvailableAt) < Date.parse(testStartAt)) return true;
        purged.push({
          sampleId: sample.sampleId, positionId: sample.positionId, fromSegment: 'validation',
          reason: 'LABEL_OVERLAPS_TEST_START', boundaryAt: testStartAt,
          labelAvailableAt: sample.labelAvailableAt,
        });
        return false;
      });
      const test = ordered.slice(validationEnd, testEnd);
      if (train.length === 0) unavailableReasons.push(`FOLD_${foldIndex}_TRAIN_SEGMENT_EMPTY`);
      if (validation.length === 0) unavailableReasons.push(`FOLD_${foldIndex}_VALIDATION_SEGMENT_EMPTY`);
      if (test.length === 0) unavailableReasons.push(`FOLD_${foldIndex}_TEST_SEGMENT_EMPTY`);
      if (train.length === 0 || validation.length === 0 || test.length === 0) continue;
      const validationSummary = summarizeOutcomes(validation);
      const testSummary = summarizeOutcomes(test);
      if (!validationSummary.ok) unavailableReasons.push(`FOLD_${foldIndex}_VALIDATION_ARITHMETIC_NON_FINITE`);
      if (!testSummary.ok) unavailableReasons.push(`FOLD_${foldIndex}_TEST_ARITHMETIC_NON_FINITE`);
      if (!validationSummary.ok || !testSummary.ok) continue;
      folds.push({
        foldIndex,
        rawRanges: {
          train: { startIndex: 0, endIndexExclusive: trainEnd },
          validation: { startIndex: trainEnd, endIndexExclusive: validationEnd },
          test: { startIndex: validationEnd, endIndexExclusive: testEnd },
        },
        boundaries: { validationStartAt, testStartAt },
        train: { sampleIds: train.map(sample => sample.sampleId), sampleCount: train.length },
        validation: { sampleIds: validation.map(sample => sample.sampleId), ...validationSummary.value },
        test: { sampleIds: test.map(sample => sample.sampleId), ...testSummary.value },
        purged,
      });
    }
    if (folds.length === 0 && unavailableReasons.length === 0) {
      unavailableReasons.push('NO_COMPLETE_FOLDS');
    }
  }

  const uniqueReasons = [...new Set(unavailableReasons)].sort();
  const ready = uniqueReasons.length === 0;
  const core = {
    schemaVersion: PAPER_LEARNING_WALK_FORWARD_VERSION,
    sourceDatasetSha256: input.datasetSha256,
    config: {
      initialTrainCount: initialTrainCount || null,
      validationCount: validationCount || null,
      testCount: testCount || null,
      stepCount: stepCount || null,
    },
    status: ready ? 'OUTCOME_FOLDS_READY' as const : 'OUTCOME_FOLDS_UNAVAILABLE' as const,
    outcomeFoldsReady: ready,
    unavailableReasons: uniqueReasons,
    foldCount: ready ? folds.length : 0,
    folds: ready ? folds : [],
    semantics: {
      descriptiveOnly: true as const,
      executionAuthorized: false as const,
      modelEvaluated: false as const,
      outOfSampleStrategyValidated: false as const,
      statisticalSufficiency: { status: 'NOT_EVALUATED' as const, sufficient: false as const },
      trainingPerformed: false as const,
      tuningPerformed: false as const,
      automaticPromotionAllowed: false as const,
    },
    costStress: {
      modeledCost: {
        status: ready ? 'AVAILABLE' as const : 'UNAVAILABLE' as const,
        multipliers: ready ? [1, 2] as const : [] as const,
      },
      slippageComponent: {
        status: 'UNAVAILABLE' as const,
        reason: 'SLIPPAGE_COMPONENT_NOT_RECORDED_SEPARATELY' as const,
      },
      fundingComponent: {
        status: 'UNAVAILABLE' as const,
        reason: 'FUNDING_COMPONENT_NOT_RECORDED_SEPARATELY' as const,
      },
      inventedSlippageOrFunding: false as const,
    },
  };
  return { ...core, walkForwardSha256: reportHash(core) };
}