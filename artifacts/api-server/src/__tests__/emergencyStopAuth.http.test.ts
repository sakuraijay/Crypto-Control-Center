import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

vi.mock('../routes/health', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/gmx', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/data', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/ai', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/approvals', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/executor', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/wallet-diagnostic', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/notifications', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/relay', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/gmxapi', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/risk', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/intel', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/canary', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/signer-readiness', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/offline-backtest', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/release', () => ({ default: (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock('../routes/livetest', () => ({
  default: (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' && req.path === '/executor/emergency-stop') {
      res.status(200).json({ ok: true, downstreamReached: true });
      return;
    }
    if (req.method === 'GET' && req.path === '/executor/livetest/status') {
      res.status(200).json({ ok: true, readOnlyStatus: true });
      return;
    }
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import routes from '../routes/index';

const TEST_PIN = '739251';
const originalPin = process.env.OPERATOR_MASTER_PIN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  return app;
}

beforeEach(() => {
  process.env.OPERATOR_MASTER_PIN = TEST_PIN;
});

afterEach(() => {
  if (originalPin === undefined) delete process.env.OPERATOR_MASTER_PIN;
  else process.env.OPERATOR_MASTER_PIN = originalPin;
  vi.restoreAllMocks();
});

describe('manual Emergency Stop HTTP operator boundary', () => {
  it('fails closed with 503 when OPERATOR_MASTER_PIN is not configured', async () => {
    delete process.env.OPERATOR_MASTER_PIN;
    const res = await request(makeApp())
      .post('/api/executor/emergency-stop')
      .send({ reason: 'manual test' });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/OPERATOR_MASTER_PIN/);
  });

  it('rejects a missing or incorrect operator header before the stop mutation route', async () => {
    const missing = await request(makeApp())
      .post('/api/executor/emergency-stop')
      .send({ reason: 'manual test' });
    expect(missing.status).toBe(401);

    const wrong = await request(makeApp())
      .post('/api/executor/emergency-stop')
      .set('x-operator-pin', '000000')
      .send({ reason: 'manual test' });
    expect(wrong.status).toBe(401);
  });

  it('requires application/json for the authenticated manual mutation', async () => {
    const res = await request(makeApp())
      .post('/api/executor/emergency-stop')
      .set('x-operator-pin', TEST_PIN)
      .set('content-type', 'text/plain')
      .send('{}');

    expect(res.status).toBe(415);
  });

  it('allows the authenticated JSON request to reach the existing stop route', async () => {
    const res = await request(makeApp())
      .post('/api/executor/emergency-stop')
      .set('x-operator-pin', TEST_PIN)
      .send({ reason: 'manual test' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, downstreamReached: true });
  });

  it('does not add operator auth to read-only LIVE TEST status', async () => {
    const res = await request(makeApp()).get('/api/executor/livetest/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, readOnlyStatus: true });
  });
});