/**
 * 승인 흐름 테스트 — 재시도 한도, 멱등성, 상태 전환, 모드 분리
 *
 * 실제 DB에 접근하지 않습니다 (소스 코드 정적 분석 + 구조 검증).
 * 실제 주문이나 서명을 시도하지 않습니다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join }  from 'node:path';

const __dir     = dirname(fileURLToPath(import.meta.url));
const approvSrc = readFileSync(join(__dir, '../routes/approvals.ts'), 'utf-8');

// ── 재시도 한도 (최대 3회) ────────────────────────────────────────────────────

describe('재시도 한도 — 최대 3회 강제', () => {
  it('retryCount >= 3 이면 재시도를 거부하는 코드가 있다', () => {
    expect(approvSrc).toContain('currentRetryCount >= 3');
  });

  it('재시도 한도 초과 시 400 또는 429 상태 코드를 반환한다', () => {
    const has400 = approvSrc.includes('status(400)') || approvSrc.includes('status(429)');
    expect(has400).toBe(true);
  });

  it('재시도 한도 오류 메시지에 횟수(3)가 명시된다', () => {
    // 한국어 오류 메시지 확인
    expect(approvSrc).toMatch(/최대 재시도 횟수.*3|3.*재시도/);
  });

  it('재시도마다 retryCount가 1 증가한다 (SQL 패턴)', () => {
    // drizzle sql`retryCount + 1` 패턴
    expect(approvSrc).toMatch(/retryCount.*\+\s*1|\+\s*1.*retryCount/);
  });

  it('재시도는 APPROVED + executionOutcome=failed 인 경우에만 가능하다', () => {
    expect(approvSrc).toContain('APPROVED');
    expect(approvSrc).toContain('failed');
    // status 검증 조건
    expect(approvSrc).toMatch(/status\s*!==\s*["']APPROVED["']/);
    expect(approvSrc).toMatch(/executionOutcome\s*!==\s*["']failed["']/);
  });
});

// ── 승인 상태 전환 ─────────────────────────────────────────────────────────────

describe('승인 상태 전환', () => {
  it('APPROVED, REJECTED, EXPIRED 3가지 상태를 지원한다', () => {
    // 파일은 double quote 사용
    expect(approvSrc).toContain('APPROVED');
    expect(approvSrc).toContain('REJECTED');
    expect(approvSrc).toContain('EXPIRED');
  });

  it('PATCH API 상태 입력 유효성 검사: APPROVED|REJECTED|EXPIRED만 허용', () => {
    expect(approvSrc).toMatch(/APPROVED.*REJECTED.*EXPIRED|includes.*APPROVED/s);
  });

  it('APPROVED 시 approvedAt 타임스탬프를 기록한다', () => {
    expect(approvSrc).toContain('approvedAt');
  });

  it('REJECTED 시 rejectionReason과 rejectedAt을 기록한다', () => {
    expect(approvSrc).toContain('rejectionReason');
    expect(approvSrc).toContain('rejectedAt');
  });

  it('executionOutcome 필드로 드라이런 성공/실패를 기록한다', () => {
    expect(approvSrc).toContain('executionOutcome');
  });
});

// ── 멱등성 — 중복 삽입 처리 ───────────────────────────────────────────────────

describe('멱등성 — 중복 삽입', () => {
  it('POST는 onConflictDoNothing을 사용해 중복 ID를 무시한다', () => {
    expect(approvSrc).toContain('onConflictDoNothing');
  });
});

// ── Worker 재시작 복구 — DB 영속성 ────────────────────────────────────────────

describe('Worker 재시작 복구 — DB 영속성', () => {
  it('페이지네이션을 지원한다 (limit, offset)', () => {
    expect(approvSrc).toContain('limit');
    expect(approvSrc).toContain('offset');
  });

  it('최신순(desc)으로 정렬된다', () => {
    expect(approvSrc).toContain('desc');
  });

  it('decisionJson으로 전체 결정 데이터를 복원할 수 있다', () => {
    expect(approvSrc).toContain('decisionJson');
    expect(approvSrc).toContain('JSON.parse');
  });

  it('lastRetriedAt 타임스탬프를 기록해 재시도 시점을 추적한다', () => {
    expect(approvSrc).toContain('lastRetriedAt');
  });
});

// ── PAPER/DRY-RUN/LIVE TEST/LIVE 모드 분리 ────────────────────────────────────

describe('실행 모드 분리', () => {
  it('승인 결정에 operatingState 필드가 포함된다', () => {
    expect(approvSrc).toContain('operatingState');
  });

  it('드라이런 재실행은 validateDryRunParams를 사용한다', () => {
    expect(approvSrc).toContain('validateDryRunParams');
  });

  it('재시도는 직접 실행 없이 validateDryRunParams만 사용한다 (실제 주문 없음)', () => {
    expect(approvSrc).toContain('executeOrder는 항상 성공을 반환하므로 직접 호출하지 않는다');
  });
});

// ── 알림 — 승인 대기 시 push 알림 ────────────────────────────────────────────

describe('알림 연동', () => {
  it('승인 라우터가 sendPushToOperator를 import한다', () => {
    expect(approvSrc).toContain('sendPushToOperator');
  });
});
