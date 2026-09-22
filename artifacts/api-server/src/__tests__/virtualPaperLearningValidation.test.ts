import { describe, expect, it } from 'vitest';
import {
  evaluatePaperLearningValidation,
  type PaperLearningValidationSample,
} from '../workers/virtualPaperLearningValidation';

const hour = 60 * 60 * 1_000;
const base = Date.parse('2026-09-20T00:00:00.000Z');
const iso = (offset: number) => new Date(base + offset * hour).toISOString();
const hash = 'a'.repeat(64);

function sample(id: string, openHour: number, labelHour: number): PaperLearningValidationSample {
  return {
    sampleId:id,positionId:`position-${id}`,featureAt:iso(openHour - 0.1),
    openedAt:iso(openHour),labelAvailableAt:iso(labelHour),
    labels:{grossPnlUsd:10,netPnlUsd:8,estimatedCostsUsd:2,settlementIds:[`settlement-${id}`]},
  };
}

const samples = [
  sample('train-kept',1,2),
  sample('train-purged',2,3),
  sample('validation-kept',3,4),
  sample('validation-purged',4,5),
  sample('test-a',5,6),
  sample('test-b',6,7),
];
const input = {
  datasetSha256:hash,samples,validationStartAt:iso(3),testStartAt:iso(5),nowMs:base + 10 * hour,
};

describe('PAPER learning chronological validation boundary', () => {
  it('deterministically partitions by openedAt and purges prior labels overlapping each boundary', () => {
    const report=evaluatePaperLearningValidation(input);
    expect(report).toMatchObject({
      status:'READY',ready:true,unavailableReasons:[],
      partitions:{
        train:{sampleIds:['train-kept'],count:1,labels:{grossPnlUsd:10,netPnlUsd:8,estimatedCostsUsd:2}},
        validation:{sampleIds:['validation-kept'],count:1},
        test:{sampleIds:['test-a','test-b'],count:2},
      },
      purged:[
        {sampleId:'train-purged',reason:'LABEL_OVERLAPS_VALIDATION_START'},
        {sampleId:'validation-purged',reason:'LABEL_OVERLAPS_TEST_START'},
      ],
      costEvidence:{
        slippage:{status:'UNAVAILABLE',reason:'SLIPPAGE_DETAIL_NOT_EXPORTED'},
        funding:{status:'UNAVAILABLE',reason:'FUNDING_DETAIL_NOT_EXPORTED'},
      },
      trainingPerformed:false,tuningPerformed:false,automaticPromotionAllowed:false,
    });
    expect(evaluatePaperLearningValidation({...input,samples:[...samples].reverse()})).toEqual(report);
  });

  it('fails closed on duplicate identities and future or inverted sample evidence', () => {
    const duplicate=evaluatePaperLearningValidation({...input,samples:[samples[0],{...samples[1],sampleId:samples[0].sampleId}]});
    expect(duplicate.ready).toBe(false);
    expect(duplicate.unavailableReasons).toContain('DUPLICATE_SAMPLE_ID');
    const duplicatePosition=evaluatePaperLearningValidation({...input,samples:[
      samples[0],{...samples[1],positionId:samples[0].positionId},
    ]});
    expect(duplicatePosition.unavailableReasons).toContain('DUPLICATE_POSITION_ID');
    const duplicateSettlement=evaluatePaperLearningValidation({...input,samples:[
      samples[0],{...samples[1],labels:{...samples[1].labels,settlementIds:samples[0].labels.settlementIds}},
    ]});
    expect(duplicateSettlement.unavailableReasons).toContain('DUPLICATE_SETTLEMENT_ID');
    const invalid=evaluatePaperLearningValidation({...input,samples:[
      {...samples[0],featureAt:iso(9),openedAt:iso(8),labelAvailableAt:iso(7)},
      {...samples[1],featureAt:iso(9),openedAt:iso(9.1),labelAvailableAt:iso(11)},
    ]});
    expect(invalid.unavailableReasons).toEqual(expect.arrayContaining([
      'SAMPLE_TIME_ORDER_INVALID','FUTURE_SAMPLE_EVIDENCE',
    ]));
  });

  it('fails closed on reversed, future, insufficient, or negative boundaries', () => {
    const reversed=evaluatePaperLearningValidation({...input,validationStartAt:iso(5),testStartAt:iso(3)});
    expect(reversed.unavailableReasons).toContain('BOUNDARY_ORDER_INVALID');
    const future=evaluatePaperLearningValidation({...input,testStartAt:iso(11)});
    expect(future.unavailableReasons).toContain('BOUNDARY_IN_FUTURE');
    const empty=evaluatePaperLearningValidation({...input,validationStartAt:iso(0),testStartAt:iso(1)});
    expect(empty.unavailableReasons).toContain('TRAIN_SEGMENT_EMPTY');
    const negative=evaluatePaperLearningValidation({...input,validationStartAt:'not-a-date'});
    expect(negative.unavailableReasons).toContain('VALIDATION_START_INVALID');
  });
});