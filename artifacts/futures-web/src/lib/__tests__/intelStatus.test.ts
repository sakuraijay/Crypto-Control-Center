/**
 * 6I-1 §15 — 웹 표시 규칙 테스트.
 *  - 미보정 확률은 절대 %로 표시하지 않음
 *  - 순기대값 null = "산출 불가" (0으로 위장 금지)
 *  - 필수 고지 문구 3종 존재
 */
import { describe, it, expect } from 'vitest';
import {
  formatWinProbability, formatExpectedNetValue,
  formatBucketSamples, formatTotalCost, costComponentLines,
  INTEL_NOTICE_MONITORING, INTEL_NOTICE_NO_GUARANTEE, INTEL_NOTICE_SHADOW,
} from '../intelStatus';

describe('6I-1 §15 표시 규칙', () => {
  it('보정 확률 null → "미보정" 문구 (%로 위장 금지)', () => {
    expect(formatWinProbability(null, 'UNCALIBRATED')).toContain('미보정');
    expect(formatWinProbability(null, 'CALIBRATED')).toContain('미보정');
  });

  it('CALIBRATED가 아니면 확률 값이 있어도 % 미표시', () => {
    expect(formatWinProbability(0.6, 'CALIBRATING')).toContain('미보정');
    expect(formatWinProbability(0.6, 'STALE')).toContain('미보정');
    expect(formatWinProbability(0.6, 'CALIBRATED')).toBe('60.0%');
  });

  it('순기대값 null → "산출 불가" (0 표시 금지)', () => {
    expect(formatExpectedNetValue(null)).toBe('산출 불가');
    expect(formatExpectedNetValue(0)).toBe('+$0.00');
    expect(formatExpectedNetValue(-3.5)).toBe('-$3.50');
  });

  it('필수 고지 문구 3종', () => {
    expect(INTEL_NOTICE_MONITORING).toContain('NO_TRADE가 정상');
    expect(INTEL_NOTICE_NO_GUARANTEE).toContain('수익 보장이 아닙니다');
    expect(INTEL_NOTICE_SHADOW).toContain('자동 LIVE 승격되지 않습니다');
  });

  // ── 6I-3 — 비용/보정 bucket fail-closed 표시 헬퍼 ─────────────────────────
  it('총비용 null/undefined → "산출 불가" (누락 성분 0 위장 금지)', () => {
    expect(formatTotalCost(null)).toBe('산출 불가');
    expect(formatTotalCost(undefined)).toBe('산출 불가');
    expect(formatTotalCost(2.25)).toBe('$2.25');
  });

  it('bucket 표본 표시 — 없으면 null(표시 생략), 있으면 n/필요치', () => {
    expect(formatBucketSamples(null)).toBeNull();
    expect(formatBucketSamples(undefined)).toBeNull();
    expect(formatBucketSamples({
      key: 'RANGE:LONG', decisiveSamples: 42, targetCount: 22, stopCount: 20,
      noneCount: 3, requiredSamples: 200, reason: '표본 부족',
    })).toBe('42/200 표본');
  });

  it('비용 성분 라인 — null 성분은 "미확보" 표기 (0 위장 금지)', () => {
    const lines = costComponentLines({
      entryFeeUsd: 0.5, estimatedExitFeeUsd: null, fundingCostUsd: 0.08, borrowingCostUsd: null,
      priceImpactUsd: 0.05, slippageUsd: 0, gasExecutionFeeUsd: null,
      latencyRiskReserveUsd: 0.5, failureRiskReserveUsd: 0.2,
      holdingHoursAssumed: 4, costBasis: 'x', costSource: 'GMX_MEASURED_READONLY',
      costSnapshotFetchedAtMs: 1,
    });
    expect(lines).toHaveLength(9);
    expect(lines.find(l => l.label === '진입 수수료')!.value).toBe('$0.5000');
    expect(lines.find(l => l.label === '청산 수수료')!.value).toBe('미확보');
    expect(lines.find(l => l.label === 'Slippage')!.value).toBe('$0.0000');
    expect(costComponentLines(null)).toEqual([]);
  });
});
