/**
 * Readiness 게이트 HTTP 테스트
 *
 * 배포/재시작 시 마이그레이션 완료 전에는 /api/healthz를 제외한
 * API 요청이 503으로 응답하고, markReady() 이후 정상 라우팅되는지 검증.
 * (포트는 즉시 열리므로 업타임 모니터가 다운타임으로 기록하지 않는다.)
 */
import { vi, describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';

// DB 미접속 격리 mock — 다른 HTTP 테스트와 동일한 패턴
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
      select: () => chain(() => []),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import { markNotReady, markReady, isReady } from '../lib/readiness';

afterAll(() => markReady());

describe('readiness gate', () => {
  it('defaults to ready (tests/import path unaffected)', () => {
    expect(isReady()).toBe(true);
  });

  it('returns 503 for API routes while not ready', async () => {
    markNotReady();
    const res = await request(app).get('/api/data/trades');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/starting/i);
  });

  it('keeps /api/healthz responding while not ready', async () => {
    markNotReady();
    const res = await request(app).get('/api/healthz');
    expect(res.status).toBe(200);
  });

  it('keeps "/" redirect responding while not ready', async () => {
    markNotReady();
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/futures-web/');
  });

  it('routes API normally after markReady()', async () => {
    markReady();
    const res = await request(app).get('/api/data/trades');
    expect(res.status).toBe(200);
  });
});
