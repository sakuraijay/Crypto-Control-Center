/**
 * PORT 파서 격리 단위 테스트 — 서버 시작·DB 마이그레이션·RPC·worker 미실행
 */
import { describe, it, expect } from 'vitest';
import { parsePort } from '../lib/port';

describe('parsePort — 허용', () => {
  it.each([
    ['1', 1],
    ['8080', 8080],
    ['65535', 65535],
  ])('%s → %d', (raw, expected) => {
    expect(parsePort(raw)).toBe(expected);
  });
});

describe('parsePort — 거부', () => {
  it('미설정(undefined) → required 오류', () => {
    expect(() => parsePort(undefined)).toThrow(/required/);
  });

  it('빈 문자열 → required 오류', () => {
    expect(() => parsePort('')).toThrow(/required/);
  });

  it('앞뒤 공백만 있는 값 → required 오류', () => {
    expect(() => parsePort('   ')).toThrow(/required/);
  });

  it.each([
    ['abc', /not a number/],
    ['Infinity', /not a number/],
    ['1.5', /integer/],
    ['0', /between 1 and 65535/],
    ['-1', /between 1 and 65535/],
    ['65536', /between 1 and 65535/],
  ])('%s → 오류', (raw, pattern) => {
    expect(() => parsePort(raw)).toThrow(pattern);
  });

  it('오류 메시지에 원본 입력값(잠재적 Secret)을 노출하지 않음', () => {
    try {
      parsePort('super-secret-value');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-value');
    }
  });
});
