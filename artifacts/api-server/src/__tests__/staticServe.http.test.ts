/**
 * Reserved VM 단일 프로세스 배포 — 정적 파일 + SPA fallback HTTP 통합 테스트
 *
 * 외부 RPC, 실제 지갑, 실제 주문, Production DB를 전혀 사용하지 않는 격리 테스트.
 * 임시 디렉터리에 가짜 빌드 산출물(index.html + asset)을 만들어 검증한다.
 *
 * 검증 항목:
 *  - /api/healthz 정상 응답 (API 라우트가 SPA fallback보다 우선)
 *  - `/` 및 SPA 경로(/dashboard)에서 index.html 반환
 *  - JS/CSS asset 올바른 Content-Type으로 반환
 *  - 존재하지 않는 /api/* 는 JSON 404 (index.html fallback 금지)
 *  - path traversal 차단
 *  - 산출물 부재 시 assertStaticDirReady가 명확한 오류로 실패
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 다른 HTTP 테스트와 동일한 격리 mock (DB 미접속) ─────────────────────────
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

vi.mock('web-push', () => ({
  default: {
    setVapidDetails:   vi.fn(),
    sendNotification:  vi.fn().mockResolvedValue({ statusCode: 201 }),
    generateVAPIDKeys: vi.fn(),
  },
}));

import app from '../app';
import { attachStaticServing, assertStaticDirReady, resolveStaticDir } from '../lib/staticSite';

const INDEX_HTML = '<!doctype html><html><head><title>CCC</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
const APP_JS = 'console.log("ccc");';
const APP_CSS = 'body{background:#000}';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-static-'));
  fs.mkdirSync(path.join(tmpDir, 'assets'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(tmpDir, 'assets', 'app.js'), APP_JS);
  fs.writeFileSync(path.join(tmpDir, 'assets', 'app.css'), APP_CSS);
  // 트래버설 표적: 정적 루트 바깥의 비밀 파일
  fs.writeFileSync(path.join(os.tmpdir(), 'ccc-secret-outside.txt'), 'SECRET');
  attachStaticServing(app, tmpDir);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'ccc-secret-outside.txt'), { force: true });
});

describe('정적 파일 + SPA fallback', () => {
  it('API 라우트가 fallback보다 우선 — /api/healthz 정상 응답', async () => {
    const res = await request(app).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('/ 에서 index.html 반환', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toBe(INDEX_HTML);
  });

  it('/dashboard SPA 경로에서 index.html 반환', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX_HTML);
  });

  it('index.html이 참조하는 JS asset을 올바른 Content-Type으로 반환', async () => {
    const res = await request(app).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.text).toBe(APP_JS);
  });

  it('CSS asset을 올바른 Content-Type으로 반환', async () => {
    const res = await request(app).get('/assets/app.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.text).toBe(APP_CSS);
  });

  it('존재하지 않는 /api/* 는 JSON 404 — index.html fallback 금지', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: 'Not found' });
    expect(res.text).not.toContain('<html');
  });

  it('path traversal 요청이 정적 루트 밖 파일에 접근하지 못함', async () => {
    for (const p of [
      '/../ccc-secret-outside.txt',
      '/..%2fccc-secret-outside.txt',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/../../ccc-secret-outside.txt',
    ]) {
      const res = await request(app).get(p);
      expect(res.text).not.toContain('SECRET');
      expect(res.text).not.toContain('root:');
    }
  });
});

describe('산출물 부재 시 시작 실패', () => {
  it('index.html이 없으면 assertStaticDirReady가 명확한 오류를 던짐', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-empty-'));
    try {
      expect(() => assertStaticDirReady(emptyDir)).toThrow(/index\.html not found/);
      expect(() => assertStaticDirReady(emptyDir)).toThrow(/build:deploy/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('STATIC_DIR 환경변수로 정적 디렉터리를 재정의 가능', () => {
    const prev = process.env['STATIC_DIR'];
    process.env['STATIC_DIR'] = '/tmp/custom-static';
    try {
      expect(resolveStaticDir()).toBe(path.resolve('/tmp/custom-static'));
    } finally {
      if (prev === undefined) delete process.env['STATIC_DIR'];
      else process.env['STATIC_DIR'] = prev;
    }
  });

  it('STATIC_DIR 미설정 시 저장소 루트 기준 기본 경로 사용', () => {
    const prev = process.env['STATIC_DIR'];
    delete process.env['STATIC_DIR'];
    try {
      expect(resolveStaticDir()).toBe(
        path.resolve(process.cwd(), 'artifacts/futures-web/dist/public'),
      );
    } finally {
      if (prev !== undefined) process.env['STATIC_DIR'] = prev;
    }
  });
});
