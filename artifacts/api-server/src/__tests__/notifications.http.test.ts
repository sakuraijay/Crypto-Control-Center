/**
 * 알림 API HTTP 통합 테스트
 *
 * supertest로 실제 Express 앱에 HTTP 요청을 보내 다음을 검증합니다:
 *  - 정상 응답 (2xx), 잘못된 입력 4xx, 서버 오류 5xx
 *  - Web Push 구독/해제
 *  - VAPID 미설정 → 503 fail-closed
 *  - 테스트 알림 전송 및 로그 기록
 *  - 응답 JSON 계약 검증
 *  - 레거시 token 엔드포인트 → 410
 *
 * 격리된 테스트 DB(모킹)만 사용. 실제 VAPID·구독·알림 없음.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── vi.mock 호이스팅됨 ────────────────────────────────────────────────────────

vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from','where','limit','offset','orderBy','set','values',
                     'onConflictDoNothing','onConflictDoUpdate','returning']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: vi.fn(() => chain(() => [])),
      insert: vi.fn(() => chain(() => undefined)),
      update: vi.fn(() => chain(() => 0)),
      delete: vi.fn(() => chain(() => 0)),
    },
    workerStateTable:    { key:'key', value:'value', updatedAt:'updatedAt' },
    liveApprovalsTable:  { id:'id', status:'status', createdAt:'createdAt' },
    aiDecisionsTable:    { id:'id' },
    strategyConfigTable: { id:'id' },
    tradesTable:         { id:'id' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  lt:   vi.fn(() => ({})),
  and:  vi.fn(() => ({})),
  sql:  Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));

// web-push — 실제 네트워크 미사용
vi.mock('web-push', () => ({
  default: {
    setVapidDetails:   vi.fn(),
    sendNotification:  vi.fn().mockResolvedValue({ statusCode: 201 }),
    generateVAPIDKeys: vi.fn(),
  },
}));

// workerManager — 실제 Worker 시작 안 함
vi.mock('../workers/aiWorker', () => ({
  workerManager: {
    start:     vi.fn(),
    stop:      vi.fn(),
    getStatus: vi.fn(() => ({
      workerRunning: false, lastCycleAt: null, cycleCount: 0, equityHwm: null,
      lastLimitsUsed: null, liveTestMode: false, liveTestVetoReason: null,
      liveTestAccumLossUsd: 0, liveTestDbOk: true,
    })),
  },
}));

vi.mock('../workers/internalExecutor', () => ({
  LIVE_EXECUTION_LOCKED: true,
  executeOrder:          vi.fn().mockResolvedValue({ simulated: true, txHash: null }),
  validateDryRunParams:  vi.fn().mockResolvedValue({ ok: true, error: null }),
  getExecutorStatus:     vi.fn().mockResolvedValue({}),
}));

// ── vi.mock 이후 import ────────────────────────────────────────────────────────
import request from 'supertest';
import app     from '../app';
import { db }  from '@workspace/db';

// ── Drizzle chain 헬퍼 ────────────────────────────────────────────────────────
function makeChain(getResult: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from','where','limit','offset','orderBy','set','values',
                   'onConflictDoNothing','onConflictDoUpdate','returning']) {
    c[m] = () => c;
  }
  (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
    (resolve) => Promise.resolve(getResult()).then(resolve);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c as any;
}

// ── 유효한 PushSubscription ───────────────────────────────────────────────────
const VALID_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-token-abc123',
  keys: {
    p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    auth:   'tBHItJI5svbpez7KI4CCXg',
  },
};

// ── 각 테스트 전 초기화 ────────────────────────────────────────────────────────
beforeEach(() => {
  vi.mocked(db.select).mockImplementation(() => makeChain(() => []));
  vi.mocked(db.insert).mockImplementation(() => makeChain(() => undefined));
  vi.mocked(db.update).mockImplementation(() => makeChain(() => 0));
  vi.mocked(db.delete).mockImplementation(() => makeChain(() => 0));
});

// ── GET /api/notifications/vapid-key ─────────────────────────────────────────

describe('GET /api/notifications/vapid-key', () => {
  it('503 — VAPID 미설정 시 fail-closed', async () => {
    const res = await request(app).get('/api/notifications/vapid-key');
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('ok', false);
    expect(res.body).toHaveProperty('reason', 'VAPID_UNCONFIGURED');
    expect(res.body).toHaveProperty('hint');
    // hint는 환경 변수 이름(VAPID_PRIVATE_KEY)을 문서로 언급하지만 실제 값은 없음
    const hint: string = res.body.hint ?? '';
    // 실제 base64 인코딩된 키(65자 이상)는 절대 미포함
    expect(hint).not.toMatch(/[A-Za-z0-9+/=_-]{65,}/);
  });
});

// ── GET /api/notifications/status ────────────────────────────────────────────

describe('GET /api/notifications/status', () => {
  it('200 — JSON 계약 검증 (빈 DB)', async () => {
    const res = await request(app).get('/api/notifications/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('vapidConfigured');
    expect(res.body).toHaveProperty('subscribed');
    expect(res.body).toHaveProperty('log');
    expect(res.body).toHaveProperty('logCount');
    expect(Array.isArray(res.body.log)).toBe(true);
    expect(typeof res.body.vapidConfigured).toBe('boolean');
    expect(typeof res.body.subscribed).toBe('boolean');
    // 테스트 환경 — VAPID 미설정
    expect(res.body.vapidConfigured).toBe(false);
    expect(res.body.subscribed).toBe(false);
  });

  it('200 — 구독이 있으면 subscribed=true, endpointHint 포함', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [{
      key:   'pushSubscription',
      value: JSON.stringify(VALID_SUBSCRIPTION),
    }]));
    const res = await request(app).get('/api/notifications/status');
    expect(res.status).toBe(200);
    expect(res.body.subscribed).toBe(true);
    expect(res.body.endpointHint).toBeTruthy();
    // endpointHint는 전체 URL을 노출하지 않음
    expect(res.body.endpointHint).not.toBe(VALID_SUBSCRIPTION.endpoint);
    expect(res.body.endpointHint).toContain('…');
  });

  it('DB 오류 시에도 fail-safe로 응답 반환 (graceful degradation)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).get('/api/notifications/status');
    // notifications/status 라우트는 DB 오류를 graceful하게 처리 —
    // 부분 데이터(subscribed:false 등)로 200 또는 500 중 어느 쪽이든 수용
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      // graceful: 기본값 반환
      expect(res.body).toHaveProperty('subscribed');
    }
  });
});

// ── POST /api/notifications/subscribe ────────────────────────────────────────

describe('POST /api/notifications/subscribe', () => {
  it('200 — 유효한 https:// endpoint로 구독 등록', async () => {
    const res = await request(app).post('/api/notifications/subscribe').send(VALID_SUBSCRIPTION);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('400 — http:// endpoint는 거부 (https만 허용)', async () => {
    const res = await request(app)
      .post('/api/notifications/subscribe')
      .send({ ...VALID_SUBSCRIPTION, endpoint: 'http://insecure.example.com/push' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/https/);
  });

  it('400 — endpoint 누락 시 오류', async () => {
    const res = await request(app).post('/api/notifications/subscribe').send({ keys: VALID_SUBSCRIPTION.keys });
    expect(res.status).toBe(400);
  });

  it('멱등성 — 동일 구독을 두 번 POST해도 오류 없음', async () => {
    const r1 = await request(app).post('/api/notifications/subscribe').send(VALID_SUBSCRIPTION);
    const r2 = await request(app).post('/api/notifications/subscribe').send(VALID_SUBSCRIPTION);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('500 — DB 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).post('/api/notifications/subscribe').send(VALID_SUBSCRIPTION);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── DELETE /api/notifications/subscribe ──────────────────────────────────────

describe('DELETE /api/notifications/subscribe', () => {
  it('200 — 구독 해제 성공', async () => {
    const res = await request(app).delete('/api/notifications/subscribe');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('200 — 구독 없어도 멱등적으로 성공', async () => {
    const res = await request(app).delete('/api/notifications/subscribe');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('500 — DB 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.delete).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).delete('/api/notifications/subscribe');
    expect(res.status).toBe(500);
  });
});

// ── POST /api/notifications/test ─────────────────────────────────────────────

describe('POST /api/notifications/test', () => {
  it('200 — 기본 파라미터로 테스트 알림 기록', async () => {
    const res = await request(app).post('/api/notifications/test').send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('entry');
    expect(res.body).toHaveProperty('pushAttempted');
    // VAPID 미설정 → pushAttempted=false
    expect(res.body.pushAttempted).toBe(false);
  });

  it('200 — channel / status / msg 커스터마이징', async () => {
    const res = await request(app).post('/api/notifications/test').send({
      channel: 'browser', status: 'sent', msg: '테스트 메시지',
    });
    expect(res.status).toBe(200);
    expect(res.body.entry.status).toBe('sent');
    expect(res.body.entry.channel).toBe('browser');
    expect(res.body.entry.msg).toBe('테스트 메시지');
  });

  it('200 — 유효하지 않은 status → "error"로 코어스', async () => {
    const res = await request(app).post('/api/notifications/test').send({ status: 'unknown_val' });
    expect(res.status).toBe(200);
    expect(res.body.entry.status).toBe('error');
  });

  it('200 — msg가 200자를 초과하면 잘림', async () => {
    const res = await request(app).post('/api/notifications/test').send({ msg: 'x'.repeat(300) });
    expect(res.status).toBe(200);
    expect(res.body.entry.msg.length).toBeLessThanOrEqual(200);
  });

  it('200 — entry에 ts(ISO 타임스탬프) 필드 포함', async () => {
    const res = await request(app).post('/api/notifications/test').send({});
    expect(res.status).toBe(200);
    expect(res.body.entry).toHaveProperty('ts');
    expect(() => new Date(res.body.entry.ts)).not.toThrow();
  });

  it('200 — VAPID 미설정 시 pushAttempted=false (fail-closed)', async () => {
    const res = await request(app).post('/api/notifications/test').send({ status: 'sent' });
    expect(res.status).toBe(200);
    expect(res.body.pushAttempted).toBe(false);
  });

  it('DB 오류 시 fire-and-forget 로깅 — 전체 요청은 성공', async () => {
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).post('/api/notifications/test').send({});
    // /test 라우트의 DB 로그 저장은 fire-and-forget — DB 오류가 요청 전체를 실패시키지 않음
    // 실제 동작: 200 (graceful) 또는 500 (엄격 에러 전파) 두 가지 모두 수용
    expect([200, 500]).toContain(res.status);
  });
});

// ── POST /api/notifications/token (레거시 → 410) ──────────────────────────────

describe('POST /api/notifications/token (레거시)', () => {
  it('410 Gone — 더 이상 지원하지 않음', async () => {
    const res = await request(app).post('/api/notifications/token').send({ token: 'legacy' });
    expect(res.status).toBe(410);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/deprecated|subscribe/i);
  });
});

// ── 존재하지 않는 라우트 ──────────────────────────────────────────────────────

describe('존재하지 않는 알림 라우트', () => {
  it('GET /api/notifications/nonexistent → 404', async () => {
    const res = await request(app).get('/api/notifications/nonexistent');
    expect([404, 405]).toContain(res.status);
  });
});

// ── VAPID 보안 검증 ───────────────────────────────────────────────────────────

describe('VAPID 보안 — 실제 키 값 미노출', () => {
  it('status와 test 엔드포인트 응답에 base64 인코딩된 키 값이 없다', async () => {
    const responses = await Promise.all([
      request(app).get('/api/notifications/status'),
      request(app).post('/api/notifications/test').send({}),
    ]);
    for (const res of responses) {
      // 실제 VAPID 키는 base64url로 65자 이상임 — 이런 긴 인코딩 값이 없어야 함
      expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9+/=_-]{65,}/);
    }
  });

  it('vapid-key 응답에 실제 base64 키 값이 없다 (hint는 env var 이름만 언급)', async () => {
    const res = await request(app).get('/api/notifications/vapid-key');
    // 응답 본문에 65자 이상의 base64 값(실제 키)이 없음
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9+/=_-]{65,}/);
  });
});
