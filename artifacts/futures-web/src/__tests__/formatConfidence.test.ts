/**
 * 6E-2 §7 — 신뢰도 표시 경계 테스트.
 * 서버는 0~100 스케일을 반환한다. ×100 중복 적용(84 → 8400%) 재발 방지.
 */
import { describe, it, expect } from 'vitest';
import { formatConfidencePct } from '../lib/formatConfidence';

describe('formatConfidencePct', () => {
  it('0 → 0% (하한 경계)', () => expect(formatConfidencePct(0)).toBe('0%'));
  it('0.7 → 1% — 0~1 스케일로 재해석해 70%로 부풀리지 않는다', () =>
    expect(formatConfidencePct(0.7)).toBe('1%'));
  it('70 → 70% (서버 0~100 스케일 그대로)', () => expect(formatConfidencePct(70)).toBe('70%'));
  it('84 → 84% — 절대 8400%가 되지 않는다', () => {
    expect(formatConfidencePct(84)).toBe('84%');
    expect(formatConfidencePct(84)).not.toContain('8400');
  });
  it('100 → 100% (상한 경계)', () => expect(formatConfidencePct(100)).toBe('100%'));
  it('범위 밖(>100)은 N/A — 임의 clamp 금지 정책', () => {
    expect(formatConfidencePct(100.01)).toBe('N/A');
    expect(formatConfidencePct(8400)).toBe('N/A');
  });
  it('음수 → N/A', () => expect(formatConfidencePct(-1)).toBe('N/A'));
  it('NaN/Infinity → N/A', () => {
    expect(formatConfidencePct(NaN)).toBe('N/A');
    expect(formatConfidencePct(Infinity)).toBe('N/A');
  });
  it('null/undefined → —', () => {
    expect(formatConfidencePct(null)).toBe('—');
    expect(formatConfidencePct(undefined)).toBe('—');
  });
});
