/**
 * #121 — 콜드스타트 부트스트랩 503 계약 테스트.
 *
 *  §1 부팅 창(본체 미로드): 모든 경로·메서드에 503 JSON + Retry-After (500·HTML 금지)
 *  §2 위임 후: 요청이 그대로 delegate(Express app)로 전달 — 기존 계약 불변
 *  §3 readiness 게이트(기존 계약 고정): markNotReady → /healthz 503, markReady → 200
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createBootstrapControl } from '../lib/bootstrapServer';

// §3에서 app import — CI는 db-free이므로 @workspace/db mock 필수
vi.mock('@workspace/db', () => {
  function chain() {
    const c: Record<string, unknown> = {};
    for (const m of ['from','where','limit','offset','orderBy','set','values',
                     'onConflictDoNothing','onConflictDoUpdate','returning']) c[m] = () => c;
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then = (resolve) => Promise.resolve([]).then(resolve);
    return c;
  }
  const t = (cols: string[]) => Object.fromEntries([...cols.map((k) => [k, k]), ['$inferSelect', {}]]);
  return {
    db: { select: vi.fn(chain), insert: vi.fn(chain), update: vi.fn(chain), delete: vi.fn(chain) },
    tradesTable: t(['id','symbol','side','action','size','price','pnl','strategy','timestamp','closeTime','sizeInUsd','managedBy','openDecisionId','closesTradeId','closeKind','stopPriceUsd','takeProfitPriceUsd','leverage','estEntryCostUsd','estExitCostUsd','fundingRatePerHour','borrowingRatePerHour','costFetchedAt','testMode','collateralUsd']),
    workerStateTable: t(['key','value','updatedAt']),
    aiDecisionsTable: t(['id','fullJson','timestamp','direction','symbol','confidence']),
    liveApprovalsTable: t(['id','status','decisionJson','createdAt','expiresAt','retryCount','executionOutcome','approvedAt','rejectedAt','rejectionReason','lastRetriedAt','lastError','testMode']),
    strategyConfigTable: t(['id','configJson','updatedAt']),
    executionIntentsTable: t(['id','status','createdAt']),
    subaccountApprovalSessionsTable: t(['id','status','createdAt']),
    relayTasksTable: t(['id','status','createdAt']),
    relayNoncesTable: t(['id']),
    protectionOrdersTable: t(['id','status','createdAt']),
    marketIntelligenceTable: t(['id','cycleId','createdAt']),
    shadowDecisionsTable: t(['id','createdAt']),
  };
});

import app from '../app';
import { markReady, markNotReady } from '../lib/readiness';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function get(port: number, path: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('#121 부트스트랩 콜드스타트 503', () => {
  let server: http.Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    markReady(); // 다른 테스트 오염 방지 (기본값 복원)
  });

  it('§1 본체 미로드: 모든 경로에 503 JSON + Retry-After (500·HTML 아님)', async () => {
    const control = createBootstrapControl();
    expect(control.hasDelegate()).toBe(false);
    server = http.createServer(control.handler);
    const port = await listen(server);

    for (const path of ['/', '/healthz', '/api/executor/status', '/futures-web/', '/futures-terminal/']) {
      const r = await get(port, path);
      expect(r.status, path).toBe(503);
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.headers['retry-after']).toBe('5');
      expect(JSON.parse(r.body)).toEqual({ status: 'starting', ready: false });
    }
    // POST도 동일 — 메서드 무관 fail-closed
    const post = await get(port, '/api/ai/approvals', 'POST');
    expect(post.status).toBe(503);
  });

  it('§2 위임 후: delegate가 그대로 요청을 받는다 (기존 라우팅 계약 유지)', async () => {
    const control = createBootstrapControl();
    const seen: string[] = [];
    control.setDelegate((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"delegated":true}');
    });
    expect(control.hasDelegate()).toBe(true);
    server = http.createServer(control.handler);
    const port = await listen(server);

    const r = await get(port, '/healthz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ delegated: true });
    expect(seen).toEqual(['GET /healthz']);
  });

  it('§3 위임 후 readiness 계약 고정: 준비 전 /healthz 503 JSON → 준비 후 200 JSON', async () => {
    const control = createBootstrapControl();
    control.setDelegate(app as unknown as Parameters<typeof control.setDelegate>[0]);
    server = http.createServer(control.handler);
    const port = await listen(server);

    markNotReady();
    const before = await get(port, '/healthz');
    expect(before.status).toBe(503);
    expect(JSON.parse(before.body)).toEqual({ status: 'starting', ready: false });

    // /api도 준비 전 503 JSON (500 아님)
    const apiBefore = await get(port, '/api/executor/status');
    expect(apiBefore.status).toBe(503);
    expect(apiBefore.headers['content-type']).toContain('application/json');

    markReady();
    const after = await get(port, '/healthz');
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body)).toEqual({ status: 'ok', ready: true });

    // supertest 경유 기존 계약도 동일 (회귀 고정)
    const st = await request(app).get('/healthz');
    expect(st.status).toBe(200);
  });
});
