import { describe, expect, it } from 'vitest';
import {
  evaluatePaperLearningWalkForward,
  type PaperLearningWalkForwardInput,
} from '../workers/virtualPaperLearningWalkForward';
import type { PaperLearningValidationSample } from '../workers/virtualPaperLearningValidation';

const hour = 60 * 60 * 1_000;
const base = Date.parse('2026-09-20T00:00:00.000Z');
const iso = (value: number) => new Date(base + value * hour).toISOString();
const hash = 'b'.repeat(64);

function sample(
  id: number,
  grossPnlUsd = 10,
  estimatedCostsUsd = 2,
  labelHour = id + 0.5,
): PaperLearningValidationSample {
  return {
    sampleId:`sample-${id}`,positionId:`position-${id}`,
    featureAt:iso(id - 0.1),openedAt:iso(id),labelAvailableAt:iso(labelHour),
    labels:{
      grossPnlUsd,estimatedCostsUsd,netPnlUsd:grossPnlUsd-estimatedCostsUsd,
      settlementIds:[`settlement-${id}`],
    },
  };
}

const samples = Array.from({length:8}, (_, index) => sample(index + 1));
const input: PaperLearningWalkForwardInput = {
  datasetSha256:hash,
  samples,
  config:{initialTrainCount:2,validationCount:2,testCount:2,stepCount:2},
  nowMs:base + 20 * hour,
};

describe('PAPER learning expanding walk-forward outcome evaluator', () => {
  it('forms deterministic chronological folds with an expanding train segment', () => {
    const report=evaluatePaperLearningWalkForward(input);
    expect(report).toMatchObject({
      schemaVersion:'paper-learning-walk-forward/v1',
      status:'OUTCOME_FOLDS_READY',outcomeFoldsReady:true,unavailableReasons:[],foldCount:2,
      folds:[
        {
          foldIndex:0,
          train:{sampleIds:['sample-1','sample-2'],sampleCount:2},
          validation:{sampleIds:['sample-3','sample-4'],sampleCount:2},
          test:{sampleIds:['sample-5','sample-6'],sampleCount:2},
        },
        {
          foldIndex:1,
          train:{sampleIds:['sample-1','sample-2','sample-3','sample-4'],sampleCount:4},
          validation:{sampleIds:['sample-5','sample-6'],sampleCount:2},
          test:{sampleIds:['sample-7','sample-8'],sampleCount:2},
        },
      ],
      semantics:{
        descriptiveOnly:true,executionAuthorized:false,modelEvaluated:false,
        outOfSampleStrategyValidated:false,
        statisticalSufficiency:{status:'NOT_EVALUATED',sufficient:false},
        trainingPerformed:false,tuningPerformed:false,automaticPromotionAllowed:false,
      },
      costStress:{
        slippageComponent:{status:'UNAVAILABLE',reason:'SLIPPAGE_COMPONENT_NOT_RECORDED_SEPARATELY'},
        fundingComponent:{status:'UNAVAILABLE',reason:'FUNDING_COMPONENT_NOT_RECORDED_SEPARATELY'},
        inventedSlippageOrFunding:false,
      },
    });
    expect(evaluatePaperLearningWalkForward({...input,samples:[...samples].reverse()})).toEqual(report);
    const reorderedConfig={
      stepCount:2,testCount:2,validationCount:2,initialTrainCount:2,
    };
    expect(evaluatePaperLearningWalkForward({...input,config:reorderedConfig}).walkForwardSha256)
      .toBe(report.walkForwardSha256);
  });

  it('purges each earlier segment when label availability overlaps the following boundary', () => {
    const overlap=[
      sample(1),sample(2,10,2,3),sample(3),sample(4,10,2,5),sample(5),sample(6),
    ];
    const report=evaluatePaperLearningWalkForward({...input,samples:overlap});
    expect(report.outcomeFoldsReady).toBe(true);
    expect(report.folds[0]).toMatchObject({
      train:{sampleIds:['sample-1'],sampleCount:1},
      validation:{sampleIds:['sample-3'],sampleCount:1},
      purged:[
        {sampleId:'sample-2',reason:'LABEL_OVERLAPS_VALIDATION_START',boundaryAt:iso(3)},
        {sampleId:'sample-4',reason:'LABEL_OVERLAPS_TEST_START',boundaryAt:iso(5)},
      ],
    });
  });

  it('computes recorded 1x and 2x cost outcomes, expectancy, win rate, and drawdown', () => {
    const arithmetic=[
      sample(1),sample(2),
      sample(3,10,2),sample(4,-5,1),sample(5,4,1),
      sample(6,20,5),sample(7,-2,3),
    ];
    const report=evaluatePaperLearningWalkForward({
      ...input,samples:arithmetic,
      config:{initialTrainCount:2,validationCount:3,testCount:2,stepCount:1},
    });
    expect(report.folds[0].validation).toMatchObject({
      sampleCount:3,observedGrossPnlUsd:9,observedModeledCostUsd:4,
      observedNetPnlUsd:5,twoXCostStressNetPnlUsd:1,
      expectancyPerTradeUsd:1.66666666667,winRate:.666666666667,maxDrawdownUsd:6,
    });
    expect(report.folds[0].test).toMatchObject({
      sampleCount:2,observedGrossPnlUsd:18,observedModeledCostUsd:8,
      observedNetPnlUsd:10,twoXCostStressNetPnlUsd:2,
      expectancyPerTradeUsd:5,winRate:.5,maxDrawdownUsd:5,
    });
  });

  it('fails closed on invalid counts and insufficient samples', () => {
    const invalid=evaluatePaperLearningWalkForward({
      ...input,config:{...input.config,stepCount:0},
    });
    expect(invalid).toMatchObject({
      status:'OUTCOME_FOLDS_UNAVAILABLE',outcomeFoldsReady:false,foldCount:0,folds:[],
    });
    expect(invalid.unavailableReasons).toContain('STEP_COUNT_INVALID');
    const insufficient=evaluatePaperLearningWalkForward({
      ...input,samples:samples.slice(0,5),
    });
    expect(insufficient.unavailableReasons).toContain('INSUFFICIENT_SAMPLES');
    const missing=evaluatePaperLearningWalkForward({
      ...input,config:{initialTrainCount:2,validationCount:2,testCount:2} as unknown as typeof input.config,
    });
    expect(missing.unavailableReasons).toContain('STEP_COUNT_INVALID');
    expect(missing.outcomeFoldsReady).toBe(false);
    const extra=evaluatePaperLearningWalkForward({
      ...input,config:{...input.config,promote:true} as unknown as typeof input.config,
    });
    expect(extra.unavailableReasons).toContain('CONFIG_KEYS_INVALID');
  });

  it('fails closed on empty post-purge segments', () => {
    const allTrainOverlap=[
      sample(1,10,2,3),sample(2,10,2,3),sample(3),sample(4),sample(5),sample(6),
    ];
    const report=evaluatePaperLearningWalkForward({...input,samples:allTrainOverlap});
    expect(report.outcomeFoldsReady).toBe(false);
    expect(report.unavailableReasons).toContain('FOLD_0_TRAIN_SEGMENT_EMPTY');
    expect(report.folds).toEqual([]);
  });

  it('rejects duplicate identities and invalid or future timestamps', () => {
    const duplicate=evaluatePaperLearningWalkForward({
      ...input,samples:[samples[0],{...samples[1],sampleId:samples[0].sampleId},...samples.slice(2)],
    });
    expect(duplicate.unavailableReasons).toContain('DUPLICATE_SAMPLE_ID');
    const invalid=evaluatePaperLearningWalkForward({
      ...input,samples:[
        {...samples[0],featureAt:iso(2),openedAt:iso(1),labelAvailableAt:iso(3)},
        {...samples[1],labelAvailableAt:iso(30)},
        ...samples.slice(2),
      ],
    });
    expect(invalid.unavailableReasons).toEqual(expect.arrayContaining([
      'SAMPLE_TIME_ORDER_INVALID','FUTURE_SAMPLE_EVIDENCE',
    ]));
    const malformed=evaluatePaperLearningWalkForward({
      ...input,samples:[
        {...samples[0],sampleId:7 as unknown as string},
        {...samples[1],labels:{...samples[1].labels,settlementIds:null as unknown as string[]}},
        ...samples.slice(2),
      ],
    });
    expect(malformed.unavailableReasons).toEqual(expect.arrayContaining([
      'SAMPLE_ID_OR_TIME_INVALID','SETTLEMENT_IDS_INVALID',
    ]));
  });

  it('uses sampleId ordinal order to break equal openedAt ties', () => {
    const equalTime=[
      sample(1),sample(2),
      {...sample(4),sampleId:'sample-z',positionId:'position-z',openedAt:iso(3),featureAt:iso(2.9)},
      {...sample(3),sampleId:'sample-a',positionId:'position-a'},
      sample(5),sample(6),
    ];
    const report=evaluatePaperLearningWalkForward({...input,samples:equalTime});
    expect(report.folds[0].validation.sampleIds).toEqual(['sample-a','sample-z']);
  });

  it('fails closed when modeled cost is missing', () => {
    const missingCost={...samples[3],labels:{...samples[3].labels,estimatedCostsUsd:undefined as unknown as number}};
    const report=evaluatePaperLearningWalkForward({
      ...input,samples:[...samples.slice(0,3),missingCost,...samples.slice(4)],
    });
    expect(report.outcomeFoldsReady).toBe(false);
    expect(report.unavailableReasons).toContain('MODELED_COST_MISSING_OR_INVALID');
    expect(report.costStress.modeledCost.status).toBe('UNAVAILABLE');
  });
});