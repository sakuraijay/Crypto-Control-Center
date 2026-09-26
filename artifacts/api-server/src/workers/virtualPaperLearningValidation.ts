import { createHash } from 'node:crypto';

export const PAPER_LEARNING_VALIDATION_VERSION = 'paper-learning-validation/v2' as const;

export interface PaperLearningValidationSample {
  sampleId: string;
  positionId: string;
  featureAt: string;
  openedAt: string;
  labelAvailableAt: string;
  labels: {
    grossPnlUsd: number;
    netPnlUsd: number;
    estimatedCostsUsd: number;
    settlementIds: readonly string[];
    slippageUsd?: number | null;
    fundingUsd?: number | null;
  };
}

export interface PaperLearningValidationInput {
  datasetSha256: string;
  samples: readonly PaperLearningValidationSample[];
  validationStartAt: string;
  testStartAt: string;
  nowMs: number;
}

type SegmentName = 'train' | 'validation' | 'test';
type Period = { first: string | null; last: string | null };

interface SegmentSummary {
  sampleIds: string[];
  count: number;
  periods: {
    featureAt: Period;
    openedAt: Period;
    labelAvailableAt: Period;
  };
  labels: {
    grossPnlUsd: number | null;
    netPnlUsd: number | null;
    estimatedCostsUsd: number | null;
  };
}

interface PurgedSample {
  sampleId: string;
  positionId: string;
  fromSegment: 'train' | 'validation';
  reason: 'LABEL_OVERLAPS_VALIDATION_START' | 'LABEL_OVERLAPS_TEST_START';
  boundaryAt: string;
  labelAvailableAt: string;
}

const strictIsoMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number): number => Number(value.toPrecision(12));

function period(samples: readonly PaperLearningValidationSample[], key: 'featureAt' | 'openedAt' | 'labelAvailableAt'): Period {
  const values = samples.map(sample => sample[key]).sort();
  return { first: values[0] ?? null, last: values.at(-1) ?? null };
}

function summarize(samples: readonly PaperLearningValidationSample[]): SegmentSummary {
  const labels = samples.length === 0 ? {
    grossPnlUsd: null, netPnlUsd: null, estimatedCostsUsd: null,
  } : {
    grossPnlUsd: round(samples.reduce((sum, sample) => sum + sample.labels.grossPnlUsd, 0)),
    netPnlUsd: round(samples.reduce((sum, sample) => sum + sample.labels.netPnlUsd, 0)),
    estimatedCostsUsd: round(samples.reduce((sum, sample) => sum + sample.labels.estimatedCostsUsd, 0)),
  };
  return {
    sampleIds: samples.map(sample => sample.sampleId),
    count: samples.length,
    periods: {
      featureAt: period(samples, 'featureAt'),
      openedAt: period(samples, 'openedAt'),
      labelAvailableAt: period(samples, 'labelAvailableAt'),
    },
    labels,
  };
}

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function validationHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function evaluatePaperLearningValidation(input: PaperLearningValidationInput) {
  const unavailableReasons: string[] = [];
  const validationStartMs = strictIsoMs(input.validationStartAt);
  const testStartMs = strictIsoMs(input.testStartAt);
  if (!/^[a-f0-9]{64}$/.test(input.datasetSha256)) unavailableReasons.push('DATASET_HASH_INVALID');
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) unavailableReasons.push('EVALUATION_TIME_INVALID');
  if (validationStartMs === null) unavailableReasons.push('VALIDATION_START_INVALID');
  if (testStartMs === null) unavailableReasons.push('TEST_START_INVALID');
  if (validationStartMs !== null && testStartMs !== null && validationStartMs >= testStartMs) {
    unavailableReasons.push('BOUNDARY_ORDER_INVALID');
  }
  if (validationStartMs !== null && validationStartMs > input.nowMs
    || testStartMs !== null && testStartMs > input.nowMs) unavailableReasons.push('BOUNDARY_IN_FUTURE');

  const ordered = [...input.samples].sort((a, b) =>
    (strictIsoMs(a.openedAt) ?? Infinity) - (strictIsoMs(b.openedAt) ?? Infinity)
    || a.sampleId.localeCompare(b.sampleId));
  if (duplicateValues(ordered.map(sample => sample.sampleId)).length > 0) unavailableReasons.push('DUPLICATE_SAMPLE_ID');
  if (duplicateValues(ordered.map(sample => sample.positionId)).length > 0) unavailableReasons.push('DUPLICATE_POSITION_ID');
  if (duplicateValues(ordered.flatMap(sample => [...sample.labels.settlementIds])).length > 0) {
    unavailableReasons.push('DUPLICATE_SETTLEMENT_ID');
  }
  for (const sample of ordered) {
    const featureAt = strictIsoMs(sample.featureAt);
    const openedAt = strictIsoMs(sample.openedAt);
    const labelAvailableAt = strictIsoMs(sample.labelAvailableAt);
    if (!sample.sampleId || !sample.positionId || featureAt === null || openedAt === null || labelAvailableAt === null) {
      unavailableReasons.push('SAMPLE_ID_OR_TIME_INVALID');
      continue;
    }
    if (featureAt > openedAt || openedAt > labelAvailableAt) unavailableReasons.push('SAMPLE_TIME_ORDER_INVALID');
    if (featureAt > input.nowMs || openedAt > input.nowMs || labelAvailableAt > input.nowMs) {
      unavailableReasons.push('FUTURE_SAMPLE_EVIDENCE');
    }
    if (![sample.labels.grossPnlUsd, sample.labels.netPnlUsd, sample.labels.estimatedCostsUsd].every(finite)
      || sample.labels.estimatedCostsUsd < 0 || !Array.isArray(sample.labels.settlementIds)
      || sample.labels.settlementIds.some(id => typeof id !== 'string' || id.length === 0)) {
      unavailableReasons.push('STORED_LABEL_INVALID');
    }
  }

  const purged: PurgedSample[] = [];
  let train: PaperLearningValidationSample[] = [];
  let validation: PaperLearningValidationSample[] = [];
  let test: PaperLearningValidationSample[] = [];
  if (unavailableReasons.length === 0 && validationStartMs !== null && testStartMs !== null) {
    const rawTrain = ordered.filter(sample => Date.parse(sample.openedAt) < validationStartMs);
    const rawValidation = ordered.filter(sample => Date.parse(sample.openedAt) >= validationStartMs
      && Date.parse(sample.openedAt) < testStartMs);
    test = ordered.filter(sample => Date.parse(sample.openedAt) >= testStartMs);
    train = rawTrain.filter(sample => {
      if (Date.parse(sample.labelAvailableAt) < validationStartMs) return true;
      purged.push({ sampleId: sample.sampleId, positionId: sample.positionId, fromSegment: 'train',
        reason: 'LABEL_OVERLAPS_VALIDATION_START', boundaryAt: input.validationStartAt,
        labelAvailableAt: sample.labelAvailableAt });
      return false;
    });
    validation = rawValidation.filter(sample => {
      if (Date.parse(sample.labelAvailableAt) < testStartMs) return true;
      purged.push({ sampleId: sample.sampleId, positionId: sample.positionId, fromSegment: 'validation',
        reason: 'LABEL_OVERLAPS_TEST_START', boundaryAt: input.testStartAt,
        labelAvailableAt: sample.labelAvailableAt });
      return false;
    });
    if (train.length === 0) unavailableReasons.push('TRAIN_SEGMENT_EMPTY');
    if (validation.length === 0) unavailableReasons.push('VALIDATION_SEGMENT_EMPTY');
    if (test.length === 0) unavailableReasons.push('TEST_SEGMENT_EMPTY');
  }

  const partitions: Record<SegmentName, SegmentSummary> = {
    train: summarize(train),
    validation: summarize(validation),
    test: summarize(test),
  };
  const retained = [...train, ...validation, ...test];
  const storedLabelsAvailable = retained.length > 0
    && !unavailableReasons.includes('STORED_LABEL_INVALID');
  const slippageAvailable = retained.length > 0 && retained.every(sample => finite(sample.labels.slippageUsd));
  const fundingAvailable = retained.length > 0 && retained.every(sample => finite(sample.labels.fundingUsd));
  const core = {
    schemaVersion: PAPER_LEARNING_VALIDATION_VERSION,
    sourceDatasetSha256: input.datasetSha256,
    boundaries: { validationStartAt: input.validationStartAt, testStartAt: input.testStartAt },
    status: unavailableReasons.length === 0
      ? 'PARTITION_BOUNDARIES_READY' as const
      : 'PARTITION_BOUNDARIES_UNAVAILABLE' as const,
    partitionBoundariesReady: unavailableReasons.length === 0,
    unavailableReasons: [...new Set(unavailableReasons)].sort(),
    partitions,
    purged: purged.sort((a, b) => a.sampleId.localeCompare(b.sampleId)),
    costEvidence: {
      storedLabels: storedLabelsAvailable
        ? { status: 'AVAILABLE' as const, basis: 'ACTUAL_EXPORTED_GROSS_NET_ESTIMATED_COST' as const }
        : { status: 'UNAVAILABLE' as const, reason: 'NO_RETAINED_SAMPLES_OR_INVALID_LABELS' as const },
      slippage: slippageAvailable
        ? { status: 'AVAILABLE' as const, totalUsd: round(retained.reduce((sum, sample) => sum + sample.labels.slippageUsd!, 0)) }
        : { status: 'UNAVAILABLE' as const, reason: 'SLIPPAGE_DETAIL_NOT_EXPORTED' as const },
      funding: fundingAvailable
        ? { status: 'AVAILABLE' as const, totalUsd: round(retained.reduce((sum, sample) => sum + sample.labels.fundingUsd!, 0)) }
        : { status: 'UNAVAILABLE' as const, reason: 'FUNDING_DETAIL_NOT_EXPORTED' as const },
    },
    trainingPerformed: false as const,
    tuningPerformed: false as const,
    automaticPromotionAllowed: false as const,
    downstreamEvaluation: {
      walkForward: { status: 'NOT_EVALUATED' as const, executed: false as const },
      outOfSample: { status: 'NOT_EVALUATED' as const, evaluated: false as const },
      statisticalSampleSufficiency: { status: 'NOT_EVALUATED' as const, sufficient: false as const },
    },
  };
  return { ...core, validationSha256: validationHash(core) };
}