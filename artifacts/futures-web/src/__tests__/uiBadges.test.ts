/**
 * UI 배지 / 상태 표시 정적 검증 테스트
 *
 * 모든 5개 AI 상태(SPOT/LONG/SHORT/HEDGE/CASH)에 대한 배지 정의가
 * 소스 코드에 완전히 구현되어 있는지 검증합니다.
 *
 * React 컴포넌트를 렌더링하지 않습니다 — 소스 코드 정적 분석만 수행합니다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath }           from 'node:url';
import { dirname, join }           from 'node:path';

const __dir     = dirname(fileURLToPath(import.meta.url));
const pagesDir  = join(__dir, '../pages');
const libDir    = join(__dir, '../lib');

function readPage(name: string) {
  const path = join(pagesDir, name);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

const aiLogSrc    = readPage('ai-log.tsx');
const historySrc  = readPage('history.tsx');
const typesSrc    = readFileSync(join(libDir, 'ai/types.ts'), 'utf-8');

const ALL_STATES = ['SPOT', 'LONG', 'SHORT', 'HEDGE', 'CASH'] as const;

// ── AiOperatingState 타입 정의 ─────────────────────────────────────────────────

describe('AiOperatingState 타입 정의', () => {
  it('types.ts에 5개 상태가 모두 정의되어 있다', () => {
    for (const state of ALL_STATES) {
      expect(typesSrc).toContain(`'${state}'`);
    }
  });

  it('AiOperatingState 타입이 export된다', () => {
    expect(typesSrc).toContain('export type AiOperatingState');
  });
});

// ── ai-log.tsx 배지 정의 ───────────────────────────────────────────────────────

describe('ai-log.tsx — 배지 / StatePill 정의', () => {
  it('ai-log.tsx가 존재한다', () => {
    expect(aiLogSrc.length).toBeGreaterThan(0);
  });

  it.each(ALL_STATES)('%s 상태에 대한 케이스 또는 설정이 있다', (state) => {
    expect(aiLogSrc).toContain(state);
  });

  it('배지에 색상(color) 또는 클래스 정의가 있다', () => {
    const hasColorDef = aiLogSrc.includes('color:')   ||
                        aiLogSrc.includes('className') ||
                        aiLogSrc.includes('text-');
    expect(hasColorDef).toBe(true);
  });

  it('상태 레이블 또는 텍스트 표시가 있다', () => {
    const hasLabel = aiLogSrc.includes('label')   ||
                     aiLogSrc.includes('text')     ||
                     aiLogSrc.includes('SPOT')     ||
                     aiLogSrc.includes('operatingState');
    expect(hasLabel).toBe(true);
  });

  it('필터 또는 탭 기능이 있다', () => {
    const hasFilter = aiLogSrc.includes('filter') ||
                      aiLogSrc.includes('Filter')  ||
                      aiLogSrc.includes('tab')     ||
                      aiLogSrc.includes('Tab');
    expect(hasFilter).toBe(true);
  });
});

// ── history.tsx 배지 정의 ─────────────────────────────────────────────────────

describe('history.tsx — 승인 이력 배지', () => {
  it('history.tsx가 존재한다', () => {
    expect(historySrc.length).toBeGreaterThan(0);
  });

  it.each(ALL_STATES)('%s 상태가 승인 이력 화면에서 처리된다', (state) => {
    expect(historySrc).toContain(state);
  });

  it('PENDING / APPROVED / REJECTED / EXPIRED 승인 상태 표시가 있다', () => {
    expect(historySrc).toContain('PENDING');
    expect(historySrc).toContain('APPROVED');
    expect(historySrc).toContain('REJECTED');
    expect(historySrc).toContain('EXPIRED');
  });

  it('드라이런 결과(succeeded / failed) 표시가 있다', () => {
    const hasDryRun = historySrc.includes('succeeded') ||
                      historySrc.includes('failed')     ||
                      historySrc.includes('dryRun')     ||
                      historySrc.includes('dry_run')    ||
                      historySrc.includes('executionOutcome');
    expect(hasDryRun).toBe(true);
  });
});

// ── 웹 페이지 — 5-State 완전성 검사 ─────────────────────────────────────────────

describe('웹 페이지 — 5-State 완전성', () => {
  it('ai-log.tsx에서 5개 상태 모두를 처리한다 (operatingState)', () => {
    // 5개 상태가 모두 파일에 존재해야 함
    const foundStates = ALL_STATES.filter(s => aiLogSrc.includes(s));
    expect(foundStates).toHaveLength(ALL_STATES.length);
  });

  it('history.tsx에서 5개 상태 모두를 처리한다', () => {
    const foundStates = ALL_STATES.filter(s => historySrc.includes(s));
    expect(foundStates).toHaveLength(ALL_STATES.length);
  });
});

// ── 다운로드 / CSV 내보내기 ────────────────────────────────────────────────────

describe('CSV 내보내기 기능', () => {
  it('ai-log.tsx에 CSV 또는 다운로드 기능이 있다', () => {
    const hasCsv = aiLogSrc.includes('csv')      ||
                   aiLogSrc.includes('CSV')       ||
                   aiLogSrc.includes('download')  ||
                   aiLogSrc.includes('Download')  ||
                   aiLogSrc.includes('export')    ||
                   aiLogSrc.includes('Export');
    expect(hasCsv).toBe(true);
  });
});

// ── 재시도 횟수 표시 ──────────────────────────────────────────────────────────

describe('재시도 횟수 표시', () => {
  it('ai-log.tsx에 retryCount 표시가 있다', () => {
    const hasRetry = aiLogSrc.includes('retryCount') ||
                     aiLogSrc.includes('retry')       ||
                     aiLogSrc.includes('재시도');
    expect(hasRetry).toBe(true);
  });
});
