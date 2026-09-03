/**
 * 승인 API HTTP 통합 테스트
 *
 * supertest로 실제 Express 앱에 HTTP 요청을 보내 다음을 검증합니다:
 *  - 정상 응답 (2xx), 존재하지 않는 리소스 404, 잘못된 입력 4xx, 서버 오류 5xx
 *  - 승인/거부/재시도(최대 3회)/중복 요청
 *  - 응답 JSON 계약 및 라우트 등록 검증
 *
 * 격리된 테스트 DB(모킹)만 사용. 운영 DB·실제 알림·지갑·RPC 없음.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── vi.mock은 호이스팅됨 — import보다 먼저 실행됨 ─────────────────────────────

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
      insert: vi.fn(() => chain(() => [])),
      update: vi.fn(() => chain(() => [])),
      delete: vi.fn(() => chain(() => 0)),
    },
    liveApprovalsTable:  { id:'id', status:'status', decisionJson:'decisionJson', createdAt:'createdAt', expiresAt:'expiresAt', retryCount:'retryCount', executionOutcome:'executionOutcome', approvedAt:'approvedAt', rejectedAt:'rejectedAt', rejectionReason:'rejectionReason', lastRetriedAt:'lastRetriedAt', lastError:'lastError', testMode:'testMode' },
    workerStateTable:    { key:'key', value:'value', updatedAt:'updatedAt' },
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

// sendPushToOperator — 실제 Web Push 미발송
// notifications 모듈은 Express Router를 default export하므로 importOriginal로 실제 라우터를 보존
vi.mock('../routes/notifications', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    sendPushToOperator: vi.fn().mockResolvedValue(undefined),
  };
});

// validateDryRunParams — 실제 주문 실행 없음
vi.mock('../workers/internalExecutor', () => ({
  LIVE_EXECUTION_LOCKED: true,
  executeOrder:          vi.fn().mockResolvedValue({ simulated: true, txHash: null }),
  validateDryRunParams:  vi.fn().mockResolvedValue({ ok: true, error: null }),
  getExecutorStatus:     vi.fn().mockResolvedValue({}),
}));

// workerManager — 실제 Worker 시작 안 함
vi.mock('../workers/aiWorker', () => ({
  applyPaperEpochInMemory: vi.fn(),
  isWorkerCycleInProgress: vi.fn(() => false),
  getWorkerStatus: vi.fn(() => ({
    workerRunning: false, lastCycleAt: null, cycleCount: 0, equityHwm: null,
    lastLimitsUsed: null, liveTestMode: false, liveTestVetoReason: null,
    liveTestAccumLossUsd: 0, liveTestDbOk: true,
  })),
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

// ── vi.mock 이후 import (Vitest가 hoisting 처리) ──────────────────────────────
import request        from 'supertest';
import app            from '../app';
import { db }         from '@workspace/db';

// ── Drizzle chain 헬퍼 (테스트에서 mockImplementation에 사용) ─────────────────
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

// ── 헬퍼: 표준 승인 행 ────────────────────────────────────────────────────────
function makeApprovalRow(overrides: Record<string, unknown> = {}) {
  return {
    id:               'approval-1',
    decisionJson:     JSON.stringify({ operatingState: 'LONG', primarySymbol: 'BTC', sizeUsd: 500 }),
    status:           'PENDING',
    expiresAt:        new Date(Date.now() + 15 * 60 * 1000),
    createdAt:        new Date(),
    retryCount:       0,
    executionOutcome: null,
    approvedAt:       null,
    rejectedAt:       null,
    rejectionReason:  null,
    lastRetriedAt:    null,
    lastError:        null,
    testMode:         false,
    ...overrides,
  };
}

// ── 각 테스트 전 DB mock 초기화 ───────────────────────────────────────────────
beforeEach(() => {
  vi.mocked(db.select).mockImplementation(() => makeChain(() => []));
  vi.mocked(db.insert).mockImplementation(() => makeChain(() => []));
  vi.mocked(db.update).mockImplementation(() => makeChain(() => []));
  vi.mocked(db.delete).mockImplementation(() => makeChain(() => 0));
});

// ── GET /api/ai/approvals ─────────────────────────────────────────────────────

describe('GET /api/ai/approvals', () => {
  it('200 — approvals 배열 반환 (빈 DB)', async () => {
    const res = await request(app).get('/api/ai/approvals');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('approvals');
    expect(Array.isArray(res.body.approvals)).toBe(true);
  });

  it('200 — 승인 목록이 있을 때 rows를 포함', async () => {
    const row = makeApprovalRow();
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [row]));
    const res = await request(app).get('/api/ai/approvals');
    expect(res.status).toBe(200);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0].id).toBe('approval-1');
    expect(res.body.approvals[0].status).toBe('PENDING');
  });

  it('200 — limit/offset 쿼리 파라미터 수락', async () => {
    const res = await request(app).get('/api/ai/approvals?limit=10&offset=0');
    expect(res.status).toBe(200);
  });

  it('500 — DB 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).get('/api/ai/approvals');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── POST /api/ai/approvals ───────────────────────────────────────────────────

describe('POST /api/ai/approvals', () => {
  it('201 — 올바른 본문으로 승인 생성', async () => {
    const row = makeApprovalRow();
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => [row]));
    const res = await request(app).post('/api/ai/approvals').send({
      id:           'approval-1',
      decisionJson: JSON.stringify({ operatingState: 'LONG', primarySymbol: 'BTC' }),
      expiresAt:    new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    expect(res.status).toBe(201);
  });

  it('400 — id 누락', async () => {
    const res = await request(app).post('/api/ai/approvals').send({
      decisionJson: '{}', expiresAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('400 — decisionJson 누락', async () => {
    const res = await request(app).post('/api/ai/approvals').send({
      id: 'approval-1', expiresAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('400 — expiresAt 누락', async () => {
    const res = await request(app).post('/api/ai/approvals').send({
      id: 'approval-1', decisionJson: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('201 — 중복 id(onConflictDoNothing) 시 빈 returning → fallback 응답', async () => {
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => [])); // conflict = empty
    const res = await request(app).post('/api/ai/approvals').send({
      id:           'dup-approval',
      decisionJson: JSON.stringify({ operatingState: 'LONG' }),
      expiresAt:    new Date(Date.now() + 900_000).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('status', 'PENDING');
  });

  it('500 — DB 삽입 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => { throw new Error('DB 삽입 오류'); }));
    const res = await request(app).post('/api/ai/approvals').send({
      id:           'approval-err',
      decisionJson: '{}',
      expiresAt:    new Date().toISOString(),
    });
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── PATCH /api/ai/approvals/:id ──────────────────────────────────────────────

describe('PATCH /api/ai/approvals/:id', () => {
  it('200 — APPROVED 상태 전환', async () => {
    const updated = makeApprovalRow({ status: 'APPROVED', approvedAt: new Date() });
    vi.mocked(db.update).mockImplementation(() => makeChain(() => [updated]));
    const res = await request(app).patch('/api/ai/approvals/approval-1').send({ status: 'APPROVED' });
    expect(res.status).toBe(200);
  });

  it('200 — REJECTED 상태 전환 (rejectionReason 포함)', async () => {
    const updated = makeApprovalRow({ status: 'REJECTED', rejectedAt: new Date() });
    vi.mocked(db.update).mockImplementation(() => makeChain(() => [updated]));
    const res = await request(app).patch('/api/ai/approvals/approval-1').send({
      status: 'REJECTED', rejectionReason: '테스트 거부',
    });
    expect(res.status).toBe(200);
  });

  it('200 — EXPIRED 상태 전환', async () => {
    const updated = makeApprovalRow({ status: 'EXPIRED' });
    vi.mocked(db.update).mockImplementation(() => makeChain(() => [updated]));
    const res = await request(app).patch('/api/ai/approvals/approval-1').send({ status: 'EXPIRED' });
    expect(res.status).toBe(200);
  });

  it('400 — 유효하지 않은 status 값', async () => {
    const res = await request(app).patch('/api/ai/approvals/approval-1').send({ status: 'INVALID' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/APPROVED|REJECTED|EXPIRED/);
  });

  it('400 — status 누락', async () => {
    const res = await request(app).patch('/api/ai/approvals/approval-1').send({});
    expect(res.status).toBe(400);
  });

  it('404 — 존재하지 않는 id (DB에서 empty returning)', async () => {
    vi.mocked(db.update).mockImplementation(() => makeChain(() => []));
    const res = await request(app).patch('/api/ai/approvals/nonexistent').send({ status: 'APPROVED' });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('500 — DB 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.update).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).patch('/api/ai/approvals/approval-1').send({ status: 'APPROVED' });
    expect(res.status).toBe(500);
  });
});

// ── POST /api/ai/approvals/:id/retry ─────────────────────────────────────────

describe('POST /api/ai/approvals/:id/retry — 최대 3회', () => {
  function retryableRow(retryCount: number) {
    return makeApprovalRow({
      status:           'APPROVED',
      executionOutcome: 'failed',
      retryCount,
      decisionJson: JSON.stringify({
        id: 'approval-1', operatingState: 'LONG', primarySymbol: 'BTC',
        executionType: 'perp_long_open', sizeUsd: 500, leverage: 5,
      }),
    });
  }

  it('200 — retryCount=0 이면 재시도 가능', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [retryableRow(0)]));
    vi.mocked(db.update).mockImplementation(() => makeChain(() => [retryableRow(1)]));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok');
    expect(res.body).toHaveProperty('outcome');
  });

  it('200 — retryCount=2 이면 세 번째 재시도 허용 (한도 미만)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [retryableRow(2)]));
    vi.mocked(db.update).mockImplementation(() => makeChain(() => [retryableRow(3)]));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(200);
  });

  it('400 — retryCount=3 이면 한도 초과 거부', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [retryableRow(3)]));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/최대 재시도 횟수/);
  });

  it('404 — 존재하지 않는 승인 id', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => []));
    const res = await request(app).post('/api/ai/approvals/nonexistent/retry');
    expect(res.status).toBe(404);
  });

  it('400 — PENDING 상태는 재시도 불가 (APPROVED만 허용)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [
      makeApprovalRow({ status: 'PENDING', executionOutcome: 'failed', retryCount: 0 }),
    ]));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('APPROVED');
  });

  it('400 — executionOutcome이 failed가 아닌 경우 재시도 불가', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [
      makeApprovalRow({ status: 'APPROVED', executionOutcome: 'succeeded', retryCount: 0 }),
    ]));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(400);
  });

  it('422 — decisionJson이 유효하지 않은 JSON', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [
      makeApprovalRow({ status: 'APPROVED', executionOutcome: 'failed', retryCount: 0, decisionJson: 'NOT_JSON' }),
    ]));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(422);
  });

  it('500 — DB 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).post('/api/ai/approvals/approval-1/retry');
    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/ai/approvals ─────────────────────────────────────────────────

describe('DELETE /api/ai/approvals', () => {
  it('200 — 전체 삭제 성공', async () => {
    const res = await request(app).delete('/api/ai/approvals');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  it('500 — DB 오류 시 안전한 오류 응답', async () => {
    vi.mocked(db.delete).mockImplementation(() => makeChain(() => { throw new Error('DB 오류'); }));
    const res = await request(app).delete('/api/ai/approvals');
    expect(res.status).toBe(500);
  });
});

// ── 라우트 등록 검증 — 존재하지 않는 경로 ────────────────────────────────────

describe('존재하지 않는 라우트', () => {
  it('GET /api/ai/approvals/x/y/z → 404 또는 405', async () => {
    const res = await request(app).get('/api/ai/approvals/x/y/z');
    expect([404, 405]).toContain(res.status);
  });
});
