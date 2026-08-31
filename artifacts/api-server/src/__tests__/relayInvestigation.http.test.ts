import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const dbState = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updateCount: 1,
}));

vi.mock('@workspace/db', async () => {
  const schema = await import('@workspace/db/schema');
  function chain(result: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'orderBy', 'set', 'returning']) {
      c[method] = () => c;
    }
    (c as { then(resolve: (value: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(result()).then(resolve);
    return c;
  }
  return {
    ...schema,
    db: {
      select: () => chain(() => dbState.row ? [dbState.row] : []),
      update: () => chain(() => Array.from(
        { length: dbState.updateCount },
        () => ({ id: dbState.row?.id ?? 'relay-investigation-1' }),
      )),
    },
  };
});

import app from '../app';
import {
  __setGmxApiTransportForTests,
  __setRelayTransportForTests,
} from '../routes/relay';
import { GMX_API_TRANSPORT_GEN } from '../lib/gmxApiOrders';
import { RELAY_TASK_STATUS } from '../lib/relayLifecycle';

const PIN = 'test-pin-123456';

function task(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'relay-investigation-1',
    kind: 'OPEN',
    status: RELAY_TASK_STATUS.SUBMITTING,
    transportGen: GMX_API_TRANSPORT_GEN,
    relayTaskId: 'request-1',
    gmxRequestId: 'request-1',
    gmxApiStatus: null,
    gmxExecutionTxHash: null,
    gmxOrderKeys: null,
    txHash: null,
    orderKey: null,
    userNonce: '7',
    approvalNonce: '3',
    errorClass: null,
    resolutionBasis: null,
    createdAt: new Date(now - 180_000),
    updatedAt: new Date(now - 120_000),
    ...overrides,
  };
}

describe('Relay investigation transport dispatch', () => {
  const gmxStatus = vi.fn(async () => ({
    ok: true,
    data: { status: 'relay_pending', requestId: 'request-1' },
    peerHost: 'arbitrum.gmxapi.io',
  }));
  const gelatoStatus = vi.fn();

  beforeEach(() => {
    vi.stubEnv('OPERATOR_MASTER_PIN', PIN);
    dbState.row = task();
    dbState.updateCount = 1;
    gmxStatus.mockClear();
    gelatoStatus.mockClear();
    gelatoStatus.mockResolvedValue({
      ok: true,
      statusCode: 100,
      transactionHash: null,
    });
    __setGmxApiTransportForTests({
      readonlyEnabled: true,
      submissionEnabled: false,
      peers: ['https://arbitrum.gmxapi.io/v1'],
      postJson: gmxStatus,
      getJson: vi.fn(),
    } as never);
    __setRelayTransportForTests({
      getRelayTaskStatus: gelatoStatus,
    } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    dbState.row = null;
    __setGmxApiTransportForTests(null);
    __setRelayTransportForTests(null);
  });

  async function recheck() {
    return request(app)
      .post('/api/executor/relay/unresolved/recheck')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({ taskId: 'relay-investigation-1' });
  }

  it.each([
    RELAY_TASK_STATUS.SUBMITTING,
    RELAY_TASK_STATUS.UNRESOLVED,
  ])('GMX_API_V2 %s task는 GMX status만 조회하고 legacy 판정을 받지 않는다', async (status) => {
    dbState.row = task({ status });
    const res = await recheck();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rechecked).toBe(true);
    expect(String(res.body.verdictBasis)).toContain('GMX API v2');
    expect(String(res.body.verdictBasis)).not.toContain('LEGACY');
    expect(gmxStatus).toHaveBeenCalledTimes(1);
    expect(gmxStatus).toHaveBeenCalledWith('/orders/txns/status', { requestId: 'request-1' }, 'readonly');
    expect(gelatoStatus).not.toHaveBeenCalled();
  });

  it('fresh GMX_API_V2 SUBMITTING은 어떤 transport도 조회하지 않는다', async () => {
    dbState.row = task({ updatedAt: new Date() });
    const res = await recheck();
    expect(res.status).toBe(409);
    expect(gmxStatus).not.toHaveBeenCalled();
    expect(gelatoStatus).not.toHaveBeenCalled();
  });

  it('GMX_API_V2 evidence UPDATE 0행은 rechecked 성공이 아니라 503이다', async () => {
    dbState.updateCount = 0;
    const res = await recheck();
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('상태 유지');
    expect(gmxStatus).toHaveBeenCalledTimes(1);
    expect(gelatoStatus).not.toHaveBeenCalled();
  });

  it('GMX_API_V2 readonly 비활성은 외부 호출·legacy 판정 없이 상태를 유지한다', async () => {
    __setGmxApiTransportForTests({
      readonlyEnabled: false,
      submissionEnabled: false,
      peers: ['https://arbitrum.gmxapi.io/v1'],
      postJson: gmxStatus,
      getJson: vi.fn(),
    } as never);
    const res = await recheck();
    expect(res.status).toBe(200);
    expect(res.body.rechecked).toBe(false);
    expect(res.body.reason).toContain('GMX API v2 readonly 조회 비활성');
    expect(String(res.body.reason)).not.toContain('LEGACY');
    expect(gmxStatus).not.toHaveBeenCalled();
    expect(gelatoStatus).not.toHaveBeenCalled();
  });

  it('jsonrpc-gasless-0.0.10은 Gelato JSON-RPC status만 조회한다', async () => {
    dbState.row = task({
      status: RELAY_TASK_STATUS.UNRESOLVED,
      transportGen: 'jsonrpc-gasless-0.0.10',
      relayTaskId: 'gelato-task-1',
      gmxRequestId: null,
    });
    const res = await recheck();
    expect(res.status).toBe(200);
    expect(res.body.rechecked).toBe(true);
    expect(gelatoStatus).toHaveBeenCalledWith({ taskId: 'gelato-task-1' });
    expect(gmxStatus).not.toHaveBeenCalled();
  });

  it('exact legacy-digital만 legacy 판정을 받고 GMX/Gelato status를 조회하지 않는다', async () => {
    dbState.row = task({
      status: RELAY_TASK_STATUS.UNRESOLVED,
      transportGen: 'legacy-digital',
    });
    const res = await recheck();
    expect(res.status).toBe(200);
    expect(res.body.rechecked).toBe(false);
    expect(res.body.verdictBasis).toContain('UNRESOLVED_LEGACY_TRANSPORT');
    expect(gmxStatus).not.toHaveBeenCalled();
    expect(gelatoStatus).not.toHaveBeenCalled();
  });

  it('unknown generation은 legacy 판정 없이 상태를 유지한다', async () => {
    dbState.row = task({
      status: RELAY_TASK_STATUS.UNRESOLVED,
      transportGen: 'unknown-generation',
    });
    const res = await recheck();
    expect(res.status).toBe(200);
    expect(res.body.rechecked).toBe(false);
    expect(res.body.reason).toContain('알 수 없는 transport generation');
    expect(res.body.verdictBasis).toBeUndefined();
    expect(gmxStatus).not.toHaveBeenCalled();
    expect(gelatoStatus).not.toHaveBeenCalled();
  });
});