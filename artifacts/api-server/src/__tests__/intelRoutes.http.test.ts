/**
 * 6I-1 §15 — Market Intelligence read-only API 테스트.
 *  - 3개 GET 엔드포인트 존재, 쓰기 엔드포인트 없음
 *  - 데이터 없음 = available:false / INSUFFICIENT_SAMPLE (가짜 0/NORMAL 금지)
 * 외부 네트워크·DB 0회 (mock).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'set', 'values',
      'onConflictDoNothing', 'onConflictDoUpdate', 'returning', 'innerJoin', 'leftJoin']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: () => chain(() => []),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: {}, relayTasksTable: {},
    subaccountApprovalSessionsTable: {}, executionIntentsTable: {},
    marketIntelligenceSnapshotsTable: { createdAt: 'created_at' },
    opportunityCandidatesTable: { snapshotId: 'snapshot_id', rawSignalScore: 'raw_signal_score', id: 'id' },
    shadowOutcomesTable: { candidateId: 'candidate_id', complete: 'complete', createdAt: 'created_at' },
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import { __resetIntelServiceForTests } from '../intel/intelService';

beforeEach(() => {
  __resetIntelServiceForTests();
});

describe('6I-1 §15 intel API', () => {
  it('GET /api/market-intelligence/status — 사이클 미실행 시 available:false (가짜 정상 금지)', async () => {
    const r = await request(app).get('/api/market-intelligence/status');
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(typeof r.body.reason).toBe('string');
    // 가짜 universe/regime 값이 없어야 함
    expect(r.body.universeCount).toBeUndefined();
    expect(r.body.regimes).toBeUndefined();
  });

  it('GET /api/opportunities/latest — 저장된 사이클 없음 = available:false + 빈 후보', async () => {
    const r = await request(app).get('/api/opportunities/latest');
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(r.body.candidates).toEqual([]);
  });

  it('GET /api/shadow/metrics — 표본 0건 = INSUFFICIENT_SAMPLE + autoPromotionAllowed=false', async () => {
    const r = await request(app).get('/api/shadow/metrics');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('INSUFFICIENT_SAMPLE');
    expect(r.body.sampleCount).toBe(0);
    expect(r.body.autoPromotionAllowed).toBe(false);
  });

  it('intel 경로에 쓰기(POST/PUT/DELETE) 엔드포인트 없음 — read-only 계약', async () => {
    for (const path of ['/api/market-intelligence/status', '/api/opportunities/latest', '/api/shadow/metrics']) {
      const post = await request(app).post(path);
      expect([404, 405]).toContain(post.status);
    }
  });
});
