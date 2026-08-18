/**
 * 6I-1 §15 — 웹 표시 규칙 테스트.
 *  - 미보정 확률은 절대 %로 표시하지 않음
 *  - 순기대값 null = "산출 불가" (0으로 위장 금지)
 *  - 필수 고지 문구 3종 존재
 */
import { describe, it, expect } from 'vitest';
import {
  formatWinProbability, formatExpectedNetValue,
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
});
