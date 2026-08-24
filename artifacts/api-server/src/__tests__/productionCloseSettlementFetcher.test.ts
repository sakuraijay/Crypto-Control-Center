import { afterEach, describe, expect, it } from 'vitest';

import { createProductionCloseSettlementFetcher } from '../lib/productionCloseSettlementFetcher';

const savedReadonly = process.env.GMX_API_READONLY_ENABLED;
const savedRpc = process.env.GMX_RPC_URL;

afterEach(() => {
  if (savedReadonly === undefined) delete process.env.GMX_API_READONLY_ENABLED;
  else process.env.GMX_API_READONLY_ENABLED = savedReadonly;
  if (savedRpc === undefined) delete process.env.GMX_RPC_URL;
  else process.env.GMX_RPC_URL = savedRpc;
});

describe('production CLOSE settlement collector — read-only fail-closed gates', () => {
  it('readonly network disabled: DB/RPC work is not attempted and trade stays unsettled', async () => {
    process.env.GMX_API_READONLY_ENABLED = 'false';
    delete process.env.GMX_RPC_URL;
    const result = await createProductionCloseSettlementFetcher().fetchEvidence?.({
      tradeId: 'settlement:close:intent:close:test',
      symbol: 'BTC',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'GMX_API_READONLY_ENABLED!=true — 정산 read-only 네트워크 비활성',
    });
  });

  it('readonly enabled but RPC missing: no fallback endpoint or estimated evidence is used', async () => {
    process.env.GMX_API_READONLY_ENABLED = 'true';
    delete process.env.GMX_RPC_URL;
    const result = await createProductionCloseSettlementFetcher().fetchEvidence?.({
      tradeId: 'settlement:close:intent:close:test',
      symbol: 'BTC',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'GMX_RPC_URL 미설정 — read-only 정산 증거 조회 불가',
    });
  });
});