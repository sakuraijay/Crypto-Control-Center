/**
 * 6F-2 §13 — GMX 공식 fee 산정 + Gelato JSON-RPC transport 신규 검증.
 *
 * 기존 stage4/5/6 수정으로 커버된 부분(제출 gate 매트릭스·reconciler statusCode
 * 매핑·legacy fail-closed·HTTP status 보존)은 중복하지 않고, 이 파일은:
 *  A) transport JSON-RPC 계약 — envelope/id 검증, method allowlist, taskId 사전
 *     검증(fetch 0회), 응답 크기 상한, 5xx retry 0회, submit 결과 taskId 검증.
 *  B) 순수 파서 — parseRelayerStatusResult / parseSponsorBalanceResult.
 *  C) fee 산정 golden fixture — applyFactor 내림, buffer, sanity 상한, 결속.
 *  D) validateFeeQuote 결속 — mock/미결속 quote는 제출 검증에서 거부.
 *
 * DB-free, 실제 네트워크 0회 (fetch 전부 mock).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createGelatoHttpTransport, createGelatoReadonlyTransport,
  parseRelayerStatusResult, parseSponsorBalanceResult,
  GELATO_API_KEY_SECRET_NAME, GELATO_RPC_URL, GELATO_HOST_ALLOWLIST,
  TRANSPORT_GENERATION, MAX_RESPONSE_BYTES, GELATO_STATUS,
} from '../lib/relayTransport';
import {
  applyFactor, computeGmxRelayFeeWei, buildGmxOfficialFeeQuote,
  fetchGmxFeeEstimateInputs, KEY_GELATO_RELAY_FEE_MULTIPLIER_FACTOR,
  GMX_PRECISION, ARBITRUM_EXECUTION_FEE_BUFFER_BPS,
  MAX_SANE_GAS_PRICE_WEI, MAX_SANE_MULTIPLIER_FACTOR,
} from '../lib/gmxFeeEstimate';
import { validateFeeQuote, getMockFeeQuote, WETH_ARBITRUM } from '../lib/relayFeeQuote';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';

const RO_ENV = {
  GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
} as unknown as NodeJS.ProcessEnv;
const SUBMIT_ENV = {
  ...RO_ENV,
  GMX_RELAY_NETWORK_ENABLED: 'true',
  GMX_RELAY_SUBMISSION_ENABLED: 'true',
  GMX_RELAY_MODE: 'LIVE',
} as unknown as NodeJS.ProcessEnv;
const VALID_TASK_ID = `0x${'ab'.repeat(32)}`;
const VALID_TARGET = GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter; // submit은 manifest router만 허용
const VALID_DATA = `0x${'11'.repeat(64)}`;
const ROUTER = '0x3333333333333333333333333333333333333333' as const;
const PAYLOAD_HASH = `0x${'44'.repeat(32)}`;

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>; });
afterEach(() => { fetchSpy.mockRestore(); });

function rpcOk(result: unknown) {
  fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
    const id = (JSON.parse(String((init as RequestInit).body)) as { id: number }).id;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

// ════════════════════ A) transport JSON-RPC 계약 ════════════════════
describe('6F-2 §13-A — transport JSON-RPC 계약', () => {
  it('endpoint 상수 — https + 허용 host 단일', () => {
    expect(GELATO_RPC_URL).toBe('https://api.gelato.cloud/rpc');
    expect([...GELATO_HOST_ALLOWLIST]).toEqual(['api.gelato.cloud']);
    expect(TRANSPORT_GENERATION).toBe('jsonrpc-gasless-0.0.10');
  });

  it('요청은 항상 POST + JSON-RPC 2.0 envelope + X-API-Key 헤더 (URL에 key 없음)', async () => {
    rpcOk({ balance: '1', decimals: 18, unit: 'wei' });
    const t = createGelatoReadonlyTransport(RO_ENV);
    const r = await t.getSponsorBalance();
    expect(r.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GELATO_RPC_URL);            // query param 없음 = key 미노출
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body)) as { jsonrpc: string; method: string; id: number };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('gelato_getBalance');
    expect(typeof body.id).toBe('number');
  });

  it('응답 id가 요청 id와 다르면 decode 거부', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 999_999_999, result: { balance: '1', decimals: 18, unit: 'wei' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await createGelatoReadonlyTransport(RO_ENV).getSponsorBalance();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('decode');
  });

  it("jsonrpc !== '2.0' envelope → decode 거부", async () => {
    fetchSpy.mockImplementation(async (_u: unknown, init: unknown) => {
      const id = (JSON.parse(String((init as RequestInit).body)) as { id: number }).id;
      return new Response(JSON.stringify({ jsonrpc: '1.0', id, result: { balance: '1', decimals: 18, unit: 'wei' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await createGelatoReadonlyTransport(RO_ENV).getSponsorBalance();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('decode');
  });

  it('API key 미설정 → fetch 0회, kind=config', async () => {
    const env = { GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
    const t = createGelatoReadonlyTransport(env);
    const b = await t.getSponsorBalance();
    const s = await t.getRelayTaskStatus({ taskId: VALID_TASK_ID });
    expect(b.ok).toBe(false); expect(s.ok).toBe(false);
    if (!b.ok) expect(b.kind).toBe('config');
    if (!s.ok) expect(s.kind).toBe('config');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('taskId 형식 오류(32-byte hex 아님) → fetch 0회, kind=config', async () => {
    const t = createGelatoReadonlyTransport(RO_ENV);
    for (const bad of ['task-1', '0x1234', `0x${'zz'.repeat(32)}`, '']) {
      const r = await t.getRelayTaskStatus({ taskId: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('config');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('readonly transport에는 submit 능력 자체가 없다 (method allowlist 분리)', () => {
    const t = createGelatoReadonlyTransport(RO_ENV);
    expect('submitRelayTask' in t).toBe(false);
    expect(Object.keys(t).sort()).toEqual(['getRelayTaskStatus', 'getSponsorBalance']);
  });

  it('응답 크기 상한(256KB) 초과 → 거부 (본문 미채택)', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { balance: '1'.padEnd(MAX_RESPONSE_BYTES + 100, '0'), decimals: 18, unit: 'wei' } });
    fetchSpy.mockImplementation(async () =>
      new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await createGelatoReadonlyTransport(RO_ENV).getSponsorBalance();
    expect(r.ok).toBe(false);
    // readBounded가 스트림을 중단 — 초과 본문은 어떤 경로로도 채택되지 않는다
    if (!r.ok) expect(['decode', 'network']).toContain(r.kind);
  });

  it('5xx → 자동 retry 0회 (fetch 정확히 1회)', async () => {
    fetchSpy.mockImplementation(async () => new Response('oops', { status: 503 }));
    const r = await createGelatoReadonlyTransport(RO_ENV).getSponsorBalance();
    expect(r.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('6G-1: legacy submit은 전 플래그 충족이어도 LEGACY_DISABLED — fetch 0회', async () => {
    rpcOk(VALID_TASK_ID);
    const s = await createGelatoHttpTransport(SUBMIT_ENV)
      .submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
    expect(s.ok).toBe(false);
    if (!s.ok) { expect(s.kind).toBe('config'); expect(s.ambiguous).toBe(false); expect(s.message).toContain('LEGACY_DISABLED'); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('6G-1: legacy submit은 relayer_sendTransaction을 절대 발신하지 않는다', async () => {
    rpcOk(VALID_TASK_ID);
    await createGelatoHttpTransport(SUBMIT_ENV)
      .submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
    const methods = fetchSpy.mock.calls.map((c: unknown[]) =>
      { try { return (JSON.parse(String((c[1] as RequestInit).body)) as { method: string }).method; } catch { return null; } });
    expect(methods).not.toContain('relayer_sendTransaction');
  });
});

// ════════════════════ B) 순수 파서 ════════════════════
describe('6F-2 §13-B — parseRelayerStatusResult / parseSponsorBalanceResult', () => {
  const HASH = `0x${'cd'.repeat(32)}`;

  it('허용 StatusCode 100/110/200/400/500만 통과', () => {
    for (const code of Object.values(GELATO_STATUS)) {
      const r = parseRelayerStatusResult({ status: code });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.statusCode).toBe(code);
    }
    for (const bad of [0, 42, 300, 999, -1, 1.5, '200', null]) {
      const r = parseRelayerStatusResult({ status: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('decode');
    }
  });

  it('transactionHash — 64-hex만 채택, receipt.transactionHash fallback', () => {
    const direct = parseRelayerStatusResult({ status: 200, hash: HASH });
    expect(direct.ok && direct.transactionHash).toBe(HASH);
    const viaReceipt = parseRelayerStatusResult({ status: 200, receipt: { transactionHash: HASH, blockNumber: 7 } });
    expect(viaReceipt.ok && viaReceipt.transactionHash).toBe(HASH);
    expect(viaReceipt.ok && viaReceipt.blockNumber).toBe(7);
    const badHash = parseRelayerStatusResult({ status: 200, hash: '0x1234' });
    expect(badHash.ok && badHash.transactionHash).toBeNull();
  });

  it('blockNumber — 정수 또는 0x-hex 문자열만', () => {
    const hex = parseRelayerStatusResult({ status: 200, receipt: { transactionHash: HASH, blockNumber: '0x10' } });
    expect(hex.ok && hex.blockNumber).toBe(16);
    const junk = parseRelayerStatusResult({ status: 200, receipt: { transactionHash: HASH, blockNumber: 'ten' } });
    expect(junk.ok && junk.blockNumber).toBeNull();
  });

  it('sponsor balance — 문자열/숫자 bigint화, 음수·비정상 decimals·빈 unit 거부', () => {
    const good = parseSponsorBalanceResult({ balance: '123456', decimals: 18, unit: 'wei' });
    expect(good.ok && good.balance).toBe(123456n);
    for (const bad of [
      { balance: '-1', decimals: 18, unit: 'wei' },
      { balance: '1', decimals: -1, unit: 'wei' },
      { balance: '1', decimals: 37, unit: 'wei' },
      { balance: '1', decimals: 1.5, unit: 'wei' },
      { balance: '1', decimals: 18, unit: '' },
      { balance: 'abc', decimals: 18, unit: 'wei' },
      null, 'x', 42,
    ]) {
      const r = parseSponsorBalanceResult(bad);
      expect(r.ok).toBe(false);
    }
  });
});

// ════════════════════ C) fee 산정 golden fixture ════════════════════
describe('6F-2 §13-C — GMX 공식 fee 산정', () => {
  it('applyFactor — 공식 정의 value×factor/1e30, bigint 내림', () => {
    expect(applyFactor(10n ** 30n, 10n ** 30n)).toBe(10n ** 30n);       // 1×1=1
    expect(applyFactor(10n, 15n * 10n ** 28n)).toBe(1n);                // 10×0.15=1.5→1 내림
    expect(applyFactor(3n, 10n ** 29n)).toBe(0n);                       // 0.3→0
  });

  it('golden fixture — gasLimit 2M × 10 gwei × factor 1e29(0.1x) + 30% buffer', () => {
    // base = applyFactor(2e6×1e10, 1e29) = 2e16×0.1 = 2e15; buffer 3000bps → ×1.3 = 2.6e15
    const r = computeGmxRelayFeeWei({
      gasLimit: 2_000_000n, gasPrice: 10n * 10n ** 9n,
      multiplierFactor: 10n ** 29n, bufferBps: ARBITRUM_EXECUTION_FEE_BUFFER_BPS,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feeWei).toBe(2_600_000_000_000_000n);
  });

  it('buffer 내림 순서 — buffer는 base 산정 후 별도 내림', () => {
    // base = applyFactor(7×1e30, 1e30) = 7; buffer = 7×3000/10000 = 2.1 → 2; total 9
    const r = computeGmxRelayFeeWei({ gasLimit: 7n, gasPrice: 10n ** 30n, multiplierFactor: 10n ** 30n, bufferBps: 3000n });
    expect(r.ok).toBe(false); // gasPrice sanity 상한(1e13) 초과 → 거부가 우선
    const r2 = computeGmxRelayFeeWei({ gasLimit: 7_000n, gasPrice: 10n ** 12n, multiplierFactor: 10n ** 27n, bufferBps: 3000n });
    // base = 7e15×0.001 = 7e12; buffer = 2.1e12 → 2_100_000_000_000n
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.feeWei).toBe(9_100_000_000_000n);
  });

  it('sanity 거부 — 0/음수/상한 초과/base 0', () => {
    const base = { gasLimit: 1_000n, gasPrice: 10n ** 9n, multiplierFactor: 10n ** 30n, bufferBps: 0n };
    expect(computeGmxRelayFeeWei({ ...base, gasLimit: 0n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, gasLimit: 2_000_000_000n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, gasPrice: 0n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, gasPrice: MAX_SANE_GAS_PRICE_WEI + 1n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, multiplierFactor: 0n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, multiplierFactor: MAX_SANE_MULTIPLIER_FACTOR + 1n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, bufferBps: 10_001n }).ok).toBe(false);
    expect(computeGmxRelayFeeWei({ ...base, bufferBps: -1n }).ok).toBe(false);
    // base가 내림으로 0이 되는 극단값 → 거부 (0 fee 제출 금지)
    expect(computeGmxRelayFeeWei({ gasLimit: 1n, gasPrice: 1n, multiplierFactor: 1n, bufferBps: 0n }).ok).toBe(false);
  });

  it('buildGmxOfficialFeeQuote — source/feeToken/feeSwapPath/결속 필드 고정', () => {
    const r = buildGmxOfficialFeeQuote({
      gasLimit: 2_000_000n, gasPrice: 10n ** 9n, multiplierFactor: 10n ** 30n,
      nowMs: 1_000, boundChainId: 42161, boundRelayRouter: ROUTER, boundPayloadHash: PAYLOAD_HASH,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.source).toBe('gmx_official_estimate');
    expect(r.quote.feeToken).toBe(WETH_ARBITRUM);
    expect(r.quote.feeSwapPath).toEqual([]);            // USDC 등 swap 경로 금지 (공식 근거 확보 전 차단)
    expect(r.quote.boundChainId).toBe(42161);
    expect(r.quote.boundRelayRouter).toBe(ROUTER);
    expect(r.quote.boundPayloadHash).toBe(PAYLOAD_HASH);
  });

  it('boundPayloadHash 형식 오류 → quote 생성 거부', () => {
    const r = buildGmxOfficialFeeQuote({
      gasLimit: 2_000_000n, gasPrice: 10n ** 9n, multiplierFactor: 10n ** 30n,
      nowMs: 1_000, boundChainId: 42161, boundRelayRouter: ROUTER, boundPayloadHash: '0x1234',
    });
    expect(r.ok).toBe(false);
  });

  it('fetchGmxFeeEstimateInputs — DataStore key는 공식 hashKeyString 상수 사용', async () => {
    const readContract = vi.fn().mockResolvedValue(10n ** 29n);
    const r = await fetchGmxFeeEstimateInputs({
      client: { getGasPrice: async () => 10n ** 9n, readContract },
      dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    });
    expect(r.ok).toBe(true);
    expect(readContract.mock.calls[0][0].args).toEqual([KEY_GELATO_RELAY_FEE_MULTIPLIER_FACTOR]);
    expect(KEY_GELATO_RELAY_FEE_MULTIPLIER_FACTOR).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('fetchGmxFeeEstimateInputs — decode 비정상(bigint 아님)·factor 상한 초과 거부', async () => {
    const client = (v: unknown) => ({ getGasPrice: async () => 10n ** 9n, readContract: vi.fn().mockResolvedValue(v) });
    expect((await fetchGmxFeeEstimateInputs({ client: client('123'), dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8' })).ok).toBe(false);
    expect((await fetchGmxFeeEstimateInputs({ client: client(MAX_SANE_MULTIPLIER_FACTOR + 1n), dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8' })).ok).toBe(false);
  });
});

// ════════════════════ D) validateFeeQuote 결속 ════════════════════
describe('6F-2 §13-D — 제출 검증에서 mock/미결속 quote 거부', () => {
  const binding = { chainId: 42161, relayRouter: ROUTER as string, payloadHash: PAYLOAD_HASH };
  const common = { nowMs: 2_000, orderNotionalUsd: null, ethPriceUsd: null };
  function officialQuote() {
    const r = buildGmxOfficialFeeQuote({
      gasLimit: 2_000_000n, gasPrice: 10n ** 9n, multiplierFactor: 10n ** 30n,
      nowMs: 1_000, boundChainId: 42161, boundRelayRouter: ROUTER, boundPayloadHash: PAYLOAD_HASH,
    });
    if (!r.ok) throw new Error('fixture');
    return r.quote;
  }

  it('mock quote → expectedBinding 지정 시 무조건 거부', () => {
    const q = getMockFeeQuote({ gasLimit: 2_000_000n, gasPrice: 10n ** 9n, nowMs: 1_000 });
    const v = validateFeeQuote({ quote: q, ...common, expectedBinding: binding });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('gmx_official_estimate');
  });

  it('결속 3필드 정확 일치 시에만 통과 — chainId/router/payloadHash 각각 검사', () => {
    expect(validateFeeQuote({ quote: officialQuote(), ...common, expectedBinding: binding }).ok).toBe(true);
    expect(validateFeeQuote({ quote: officialQuote(), ...common, expectedBinding: { ...binding, chainId: 1 } }).ok).toBe(false);
    expect(validateFeeQuote({ quote: officialQuote(), ...common, expectedBinding: { ...binding, relayRouter: VALID_TARGET } }).ok).toBe(false);
    expect(validateFeeQuote({ quote: officialQuote(), ...common, expectedBinding: { ...binding, payloadHash: `0x${'55'.repeat(32)}` } }).ok).toBe(false);
  });

  it('router/payloadHash 대소문자 차이는 허용 (checksum 무관 일치)', () => {
    const v = validateFeeQuote({
      quote: officialQuote(), ...common,
      expectedBinding: { ...binding, relayRouter: binding.relayRouter.toUpperCase().replace('0X', '0x'), payloadHash: PAYLOAD_HASH.toUpperCase().replace('0X', '0x') },
    });
    expect(v.ok).toBe(true);
  });
});
