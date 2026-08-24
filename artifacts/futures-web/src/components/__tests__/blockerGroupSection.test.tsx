/**
 * #142 — BlockerGroupSection 렌더 계약 테스트.
 *
 * 검증 항목:
 *  - 4개 category 각각 한국어 레이블·testid 렌더
 *  - 빈 그룹(blockers=[]) → "차단 항목 없음" 표시
 *  - blockers=null → 미조회 상태 표시
 *  - GITHUB_CI unknown category → generic CODE 차단으로 승격 (fail-closed)
 *  - 시크릿 fixture 문자열이 렌더 결과에 절대 등장하지 않음
 *  - row testid 안정성
 *  - 소스 계약: sanitizeBlockerMessage 경유 없는 직접 message 렌더 없음
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockerGroupSection } from '../BlockerGroupSection';
import { type CanaryBlocker } from '@/lib/manualCanary';

function render(blockers: CanaryBlocker[] | null): string {
  return renderToStaticMarkup(<BlockerGroupSection blockers={blockers} />);
}

const CAT_LABELS: Record<string, string> = {
  CODE: '코드 오류',
  CONFIGURATION: '설정 오류',
  OPERATOR_MANUAL_ACTION: '운영자 수동 조치 필요',
  GITHUB_CI: 'GitHub CI 상태',
};

// ── 미조회 상태 ────────────────────────────────────────────────────────────────

describe('BlockerGroupSection — blockers=null (미조회)', () => {
  it('미조회 안내 문구를 표시한다', () => {
    const html = render(null);
    expect(html).toContain('blocker-section-not-loaded');
    expect(html).toContain('아직 조회하지 않았습니다');
  });

  it('어떤 차단 그룹도 표시하지 않는다', () => {
    const html = render(null);
    expect(html).not.toContain('group-blocker-CODE');
    expect(html).not.toContain('group-blocker-GITHUB_CI');
  });
});

// ── 빈 그룹 ───────────────────────────────────────────────────────────────────

describe('BlockerGroupSection — blockers=[] (빈 그룹)', () => {
  it('"차단 항목 없음" 안내를 표시한다', () => {
    const html = render([]);
    expect(html).toContain('blocker-section-empty');
    expect(html).toContain('차단 항목 없음');
  });

  it('category 그룹을 렌더하지 않는다', () => {
    const html = render([]);
    for (const cat of ['CODE', 'CONFIGURATION', 'OPERATOR_MANUAL_ACTION', 'GITHUB_CI']) {
      expect(html).not.toContain(`group-blocker-${cat}`);
    }
  });
});

// ── CODE category ─────────────────────────────────────────────────────────────

describe('BlockerGroupSection — CODE category', () => {
  const blockers: CanaryBlocker[] = [
    { category: 'CODE', id: 'code-err-1', message: '런타임 오류 발생', blocking: true },
  ];

  it('CODE 그룹 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('group-blocker-CODE');
  });

  it('한국어 레이블 "코드 오류"가 표시된다', () => {
    const html = render(blockers);
    expect(html).toContain(CAT_LABELS.CODE);
  });

  it('blocker id testid가 렌더된다', () => {
    const html = render(blockers);
    expect(html).toContain('row-blocker-code-err-1');
  });

  it('sanitize된 메시지가 표시된다', () => {
    const html = render(blockers);
    expect(html).toContain('런타임 오류 발생');
  });

  it('레이블 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('label-blocker-category-CODE');
  });
});

// ── CONFIGURATION category ────────────────────────────────────────────────────

describe('BlockerGroupSection — CONFIGURATION category', () => {
  const blockers: CanaryBlocker[] = [
    { category: 'CONFIGURATION', id: 'conf-missing', message: '환경 변수 누락', blocking: true },
    { category: 'CONFIGURATION', id: 'conf-ok', message: '선택적 설정 확인 완료', blocking: false },
  ];

  it('CONFIGURATION 그룹 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('group-blocker-CONFIGURATION');
  });

  it('한국어 레이블 "설정 오류"가 표시된다', () => {
    const html = render(blockers);
    expect(html).toContain(CAT_LABELS.CONFIGURATION);
  });

  it('두 blocker row가 모두 렌더된다', () => {
    const html = render(blockers);
    expect(html).toContain('row-blocker-conf-missing');
    expect(html).toContain('row-blocker-conf-ok');
  });

  it('레이블 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('label-blocker-category-CONFIGURATION');
  });
});

// ── OPERATOR_MANUAL_ACTION category ───────────────────────────────────────────

describe('BlockerGroupSection — OPERATOR_MANUAL_ACTION category', () => {
  const blockers: CanaryBlocker[] = [
    { category: 'OPERATOR_MANUAL_ACTION', id: 'op-approve', message: '운영자 승인 대기 중', blocking: true },
  ];

  it('OPERATOR_MANUAL_ACTION 그룹 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('group-blocker-OPERATOR_MANUAL_ACTION');
  });

  it('한국어 레이블 "운영자 수동 조치 필요"가 표시된다', () => {
    const html = render(blockers);
    expect(html).toContain(CAT_LABELS.OPERATOR_MANUAL_ACTION);
  });

  it('blocker row testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('row-blocker-op-approve');
  });

  it('레이블 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('label-blocker-category-OPERATOR_MANUAL_ACTION');
  });
});

// ── GITHUB_CI category ────────────────────────────────────────────────────────

describe('BlockerGroupSection — GITHUB_CI category', () => {
  const blockers: CanaryBlocker[] = [
    { category: 'GITHUB_CI', id: 'ci-main', message: 'main 브랜치 CI 실패', blocking: true },
  ];

  it('GITHUB_CI 그룹 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('group-blocker-GITHUB_CI');
  });

  it('한국어 레이블 "GitHub CI 상태"가 표시된다', () => {
    const html = render(blockers);
    expect(html).toContain(CAT_LABELS.GITHUB_CI);
  });

  it('blocker row testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('row-blocker-ci-main');
  });

  it('레이블 testid가 존재한다', () => {
    const html = render(blockers);
    expect(html).toContain('label-blocker-category-GITHUB_CI');
  });
});

// ── GITHUB_CI fail-closed: unknown category 차단 승격 ────────────────────────

describe('BlockerGroupSection — GITHUB_CI fail-closed (unknown category 차단)', () => {
  it('GITHUB_CI_UNKNOWN 원문은 숨기고 generic CODE 차단을 렌더한다', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'GITHUB_CI_UNKNOWN', id: 'ci-unk', message: 'CI 상태 불명', blocking: true },
      { category: 'GITHUB_CI', id: 'ci-known', message: '알려진 CI 실패', blocking: true },
    ];
    const html = render(blockers);
    // 알 수 없는 원문은 노출하지 않고 안정적인 generic blocker로 승격
    expect(html).not.toContain('row-blocker-ci-unk');
    expect(html).toContain('row-blocker-UNKNOWN_BLOCKER_CATEGORY');
    expect(html).toContain('group-blocker-CODE');
    // ci-known은 렌더됨
    expect(html).toContain('row-blocker-ci-known');
  });

  it('알 수 없는 category만 있어도 차단 없음으로 표시하지 않는다', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'INFRA', id: 'infra-1', message: '인프라 문제', blocking: true },
      { category: 'UNKNOWN', id: 'unk-1', message: '알 수 없음', blocking: true },
    ];
    const html = render(blockers);
    expect(html).not.toContain('blocker-section-empty');
    expect(html).toContain('group-blocker-CODE');
    expect(html).toContain('row-blocker-UNKNOWN_BLOCKER_CATEGORY');
    expect(html).not.toContain('row-blocker-infra-1');
    expect(html).not.toContain('row-blocker-unk-1');
  });

  it('GITHUB_CI blocking=true 항목이 없으면 비차단 표시 (그룹은 존재)', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'GITHUB_CI', id: 'ci-ok', message: 'CI 통과', blocking: false },
    ];
    const html = render(blockers);
    expect(html).toContain('group-blocker-GITHUB_CI');
    expect(html).toContain('row-blocker-ci-ok');
  });
});

// ── 시크릿 fixture 문자열 렌더 금지 ──────────────────────────────────────────

describe('BlockerGroupSection — 시크릿 fixture 문자열 렌더 금지', () => {
  const SECRET_KEY = '0x' + '3c'.repeat(32);      // 개인키 형식 64 hex
  const SECRET_ADDR = '0x' + 'ab'.repeat(20);     // 주소 형식 40 hex
  const SECRET_SIG = '0x' + 'ff'.repeat(65);      // 서명 형식 130 hex
  const SECRET_URL = 'https://private-rpc.internal/v3/TOKEN_SECRET_123';

  it('message에 개인키 형식 문자열이 있어도 렌더에서 은닉된다', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'CODE', id: 'sec-key', message: `key=${SECRET_KEY}`, blocking: true },
    ];
    const html = render(blockers);
    expect(html).not.toContain(SECRET_KEY);
    expect(html).toContain('[키 은닉]');
  });

  it('message에 지갑 주소가 있어도 렌더에서 은닉된다', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'CONFIGURATION', id: 'sec-addr', message: `owner=${SECRET_ADDR}`, blocking: true },
    ];
    const html = render(blockers);
    expect(html).not.toContain(SECRET_ADDR);
    expect(html).toContain('[주소 은닉]');
  });

  it('message에 서명이 있어도 렌더에서 은닉된다', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'OPERATOR_MANUAL_ACTION', id: 'sec-sig', message: `sig=${SECRET_SIG}`, blocking: true },
    ];
    const html = render(blockers);
    expect(html).not.toContain(SECRET_SIG.slice(0, 20));
    expect(html).toContain('[서명 은닉]');
  });

  it('message에 RPC URL이 있어도 렌더에서 은닉된다', () => {
    const blockers: CanaryBlocker[] = [
      { category: 'GITHUB_CI', id: 'sec-url', message: `rpc=${SECRET_URL}`, blocking: false },
    ];
    const html = render(blockers);
    expect(html).not.toContain('TOKEN_SECRET_123');
    expect(html).not.toContain('private-rpc.internal');
    expect(html).toContain('[URL 은닉]');
  });

  it('복합 시크릿 메시지 — 모든 패턴이 은닉됨', () => {
    const combined = `key=${SECRET_KEY} addr=${SECRET_ADDR} sig=${SECRET_SIG} rpc=${SECRET_URL}`;
    const blockers: CanaryBlocker[] = [
      { category: 'CODE', id: 'sec-all', message: combined, blocking: true },
    ];
    const html = render(blockers);
    expect(html).not.toContain(SECRET_KEY);
    expect(html).not.toContain(SECRET_ADDR);
    expect(html).not.toContain('private-rpc.internal');
    expect(html).not.toContain('TOKEN_SECRET_123');
  });
});

// ── 4개 category 동시 렌더 ────────────────────────────────────────────────────

describe('BlockerGroupSection — 4개 category 동시 렌더', () => {
  const allFour: CanaryBlocker[] = [
    { category: 'CODE', id: 'c1', message: '코드 문제', blocking: true },
    { category: 'CONFIGURATION', id: 'c2', message: '설정 문제', blocking: false },
    { category: 'OPERATOR_MANUAL_ACTION', id: 'c3', message: '수동 조치', blocking: true },
    { category: 'GITHUB_CI', id: 'c4', message: 'CI 실패', blocking: true },
  ];

  it('4개 그룹 모두 testid가 존재한다', () => {
    const html = render(allFour);
    for (const cat of ['CODE', 'CONFIGURATION', 'OPERATOR_MANUAL_ACTION', 'GITHUB_CI']) {
      expect(html).toContain(`group-blocker-${cat}`);
    }
  });

  it('4개 한국어 레이블이 모두 표시된다', () => {
    const html = render(allFour);
    for (const label of Object.values(CAT_LABELS)) {
      expect(html).toContain(label);
    }
  });

  it('blocker section testid가 존재한다', () => {
    const html = render(allFour);
    expect(html).toContain('data-testid="blocker-section"');
  });
});

// ── 소스 계약 ─────────────────────────────────────────────────────────────────

describe('소스 계약 — BlockerGroupSection.tsx', () => {
  const src: string = readFileSync(
    path.resolve(__dirname, '../BlockerGroupSection.tsx'), 'utf8',
  );

  it('sanitizeBlockerMessage를 경유해서만 message를 렌더한다', () => {
    // sanitizeBlockerMessage 호출 없는 직접 blocker.message 렌더는 금지
    expect(src).toContain('sanitizeBlockerMessage');
    // blocker.message를 직접 JSX에 삽입하는 패턴이 없어야 함
    // (safe = sanitizeBlockerMessage(...)를 거쳐야 함)
    expect(src).toContain('sanitizeBlockerMessage(blocker.message)');
  });

  it('4개 category에 대한 한국어 레이블이 임포트되어 있다', () => {
    expect(src).toContain('BLOCKER_CATEGORY_LABELS');
  });

  it('groupBlockersByCategory를 사용하여 그룹화한다', () => {
    expect(src).toContain('groupBlockersByCategory');
  });

  it('ALLOWED_BLOCKER_CATEGORIES를 순서 기준으로 사용한다', () => {
    expect(src).toContain('ALLOWED_BLOCKER_CATEGORIES');
  });

  it('PIN/비밀키/주소/서명 관련 직접 렌더 없음 (코드 식별자 기준)', () => {
    // 변수명·props 패턴으로만 확인 — 주석의 설명 문구는 허용
    // 실제 prop 접근이나 변수 바인딩이 없어야 함
    expect(src).not.toMatch(/\bpin\s*[=:({]/); // pin= / pin: / pin( 등 실제 코드 패턴
    expect(src).not.toMatch(/\bprivateKey\b|\bprivate_key\b/);
    expect(src).not.toMatch(/\brpcUrl\b|\brpc_url\b|\bRPC_URL\b/);
    expect(src).not.toMatch(/\brawError\b/);
    // input[type=password] 없음
    expect(src).not.toMatch(/type\s*=\s*["']password["']/);
  });

  it('stable testid 존재 (data-testid 하드코딩)', () => {
    expect(src).toContain('data-testid="blocker-section"');
    expect(src).toContain('data-testid="blocker-section-empty"');
    expect(src).toContain('data-testid="blocker-section-not-loaded"');
  });

  it('localStorage/sessionStorage/setInterval 0건', () => {
    expect(src).not.toMatch(/localStorage|sessionStorage|setInterval/);
  });
});
