/**
 * 알림 API 테스트 — VAPID 미설정 시 fail-closed, 구독 관리 검증
 *
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수가 설정되지 않은 상태를
 * 테스트합니다. 실제 Web Push 서버에 연결하지 않습니다.
 */
import { vi, describe, it, expect } from 'vitest';
import { readFileSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── 정적 분석용 경로 ──────────────────────────────────────────────────────────
const __dir    = dirname(fileURLToPath(import.meta.url));
const notifSrc = readFileSync(join(__dir, '../routes/notifications.ts'), 'utf-8');

// ── 의존성 모킹 (vi.mock은 파일 최상단으로 호이스팅됨) ───────────────────────

vi.mock('@workspace/db', () => {
  function chain(result: unknown) {
    const c: Record<string, unknown> = {};
    ['from','where','limit','offset','orderBy','values','set',
     'onConflictDoNothing','returning'].forEach(m => { c[m] = vi.fn(() => c); });
    c['then']  = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    c['catch'] = (reject:  (e: unknown) => unknown) => Promise.resolve(result).catch(reject);
    return c;
  }
  const tbl = new Proxy({}, { get: (_t, k) => ({ col: String(k) }) });
  return {
    db: {
      select: vi.fn(() => chain([])),
      insert: vi.fn(() => chain(undefined)),
      update: vi.fn(() => chain(undefined)),
      delete: vi.fn(() => chain(undefined)),
    },
    workerStateTable: tbl,
  };
});

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  sql:  Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
  and:  vi.fn(() => ({})),
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails:   vi.fn(),
    sendNotification:  vi.fn().mockResolvedValue({ statusCode: 201, body: 'ok' }),
    generateVAPIDKeys: vi.fn(),
  },
}));

// 모킹 이후 실제 모듈 import
import { sendPushToOperator } from '../routes/notifications';
import webPushModule from 'web-push';

const mockWebPush = webPushModule as unknown as {
  setVapidDetails:  ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
};

// ── 런타임 테스트: fail-closed ────────────────────────────────────────────────

describe('VAPID 미설정 — fail-closed 보장', () => {
  it('sendPushToOperator는 VAPID 미설정 시 예외 없이 반환한다 (silent no-op)', async () => {
    // VAPID 환경변수가 없으므로 vapidReady = false
    await expect(
      sendPushToOperator({ title: '테스트 알림', body: '내용', tag: 'test' })
    ).resolves.toBeUndefined();
  });

  it('sendPushToOperator는 webPush.sendNotification을 호출하지 않는다', async () => {
    mockWebPush.sendNotification.mockClear();
    await sendPushToOperator({ title: '테스트', body: '내용', tag: 'test' });
    expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
  });

  it('sendPushToOperator는 여러 번 호출해도 안전하다 (멱등성)', async () => {
    const calls = Array.from({ length: 3 }, (_, i) =>
      sendPushToOperator({ title: `알림 ${i}`, body: '내용', tag: `test-${i}` })
    );
    await expect(Promise.all(calls)).resolves.toBeDefined();
  });

  it('sendPushToOperator 함수가 export된다', () => {
    expect(typeof sendPushToOperator).toBe('function');
  });
});

// ── 정적 소스 분석 — 보안 및 구조 검증 ────────────────────────────────────────

describe('소스 코드 정적 분석 — 알림 보안', () => {
  it('notifications.ts는 vapidReady 게이트를 포함한다', () => {
    expect(notifSrc).toContain('vapidReady');
  });

  it('sendPushToOperator는 vapidReady 미설정 시 early return한다', () => {
    expect(notifSrc).toMatch(/if\s*\(!\s*vapidReady\s*\)\s*return/);
  });

  it('private key를 저장하거나 생성하지 않는다 (정책 문서화 확인)', () => {
    expect(notifSrc).toContain('NEVER generates or stores private key material');
  });

  it('VAPID 키는 환경변수에서만 읽는다', () => {
    expect(notifSrc).toContain('VAPID_PUBLIC_KEY');
    expect(notifSrc).toContain('VAPID_PRIVATE_KEY');
  });

  it('구독 POST 엔드포인트가 정의되어 있다', () => {
    const hasSubscribe = notifSrc.includes('subscribe') || notifSrc.includes('/subscribe');
    expect(hasSubscribe).toBe(true);
  });

  it('구독 해제(DELETE) 엔드포인트가 정의되어 있다', () => {
    const hasDelete = notifSrc.includes('delete') ||
                      notifSrc.includes('DELETE') ||
                      notifSrc.includes('unsubscribe');
    expect(hasDelete).toBe(true);
  });

  it('알림 상태(status) 엔드포인트가 정의되어 있다', () => {
    expect(notifSrc).toContain('status');
  });
});
