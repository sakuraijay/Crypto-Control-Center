/**
 * 6H-2C §12 — decimals 권위 소스 · 온체인 증거 수집기 · 정합성 분석 · action 예산.
 * 실 RPC 0회 — 전부 의존성 주입 mock.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveIndexTokenDecimals, lookupSdkIndexToken, __clearDecimalsCacheForTests,
  getDecimalsCacheSnapshot, DECIMALS_VERIFIED_MAX_AGE_MS, ARBITRUM_CHAIN_ID,
} from '../lib/indexTokenDecimals';
import {
  collectProtectionEvidence, analyzeProtectionAnomalies,
  type EvidenceClient,
} from '../lib/protectionEvidence';
import { ORDER_EVENT_NAME_HASH, type RawLog } from '../lib/gmxOrderEvents';
import { mkEventLog2, stopCreatedFields, mkReceiptFor } from './helpers/eventLog2Fixture';
import {
  evaluateActionBudget, CANARY_ACTION_PATHS, WORST_PATH_ACTIONS,
  RESERVED_EMERGENCY_ACTIONS, requiredActionsBeforeOpen, MIN_SAFE_ACTION_BUDGET,
} from '../lib/actionBudget';

// 공식 ETH/USD market (SDK MARKETS[42161]) — WETH decimals 18
const ETH_MARKET = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336';
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const BTC_MARKET = '0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77';
const BTC_SYNTHETIC = '0x47904963fc8b2340414262125aF798B9655E58Cd';

describe('§3 indexTokenDecimals — SDK+온체인 교차검증', () => {
  beforeEach(() => __clearDecimalsCacheForTests());

  it('SDK 결속: ETH market → WETH decimals 18', () => {
    const r = lookupSdkIndexToken(ARBITRUM_CHAIN_ID, ETH_MARKET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.indexTokenAddress.toLowerCase()).toBe(WETH.toLowerCase());
      expect(r.sdkDecimals).toBe(18);
    }
  });
  it('chainId≠42161 / 미등록 market / 형식 오류 → 차단', () => {
    expect(lookupSdkIndexToken(1, ETH_MARKET).ok).toBe(false);
    expect(lookupSdkIndexToken(ARBITRUM_CHAIN_ID, '0x' + '11'.repeat(20)).ok).toBe(false);
    expect(lookupSdkIndexToken(ARBITRUM_CHAIN_ID, 'not-an-address').ok).toBe(false);
  });
  it('SDK 결속: BTC market → synthetic placeholder decimals 8', () => {
    const r = lookupSdkIndexToken(ARBITRUM_CHAIN_ID, BTC_MARKET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.indexTokenAddress.toLowerCase()).toBe(BTC_SYNTHETIC.toLowerCase());
      expect(r.sdkDecimals).toBe(8);
      expect(r.synthetic).toBe(true);
    }
  });
  it('synthetic placeholder는 SDK synthetic + 온체인 no-code 결속으로 검증한다', async () => {
    let decimalsCalls = 0;
    const r = await resolveIndexTokenDecimals({
      chainId: ARBITRUM_CHAIN_ID,
      marketAddress: BTC_MARKET,
      fetchOnchainCode: async () => false,
      fetchOnchainDecimals: async () => { decimalsCalls++; return null; },
    });
    expect(r.ok).toBe(true);
    expect(decimalsCalls).toBe(0);
    if (r.ok) {
      expect(r.evidence.decimals).toBe(8);
      expect(r.evidence.source).toBe('sdk-synthetic+onchain-no-code');
      expect(r.evidence.onchainDecimals).toBeNull();
    }
  });
  it('synthetic bytecode 판정 실패는 차단하고, code가 있으면 decimals 교차검증한다', async () => {
    const base = {
      chainId: ARBITRUM_CHAIN_ID,
      marketAddress: BTC_MARKET,
      fetchOnchainDecimals: async () => 8,
    };
    expect((await resolveIndexTokenDecimals({ ...base })).ok).toBe(false);
    expect((await resolveIndexTokenDecimals({ ...base, fetchOnchainCode: async () => null })).ok).toBe(false);
    const withCode = await resolveIndexTokenDecimals({ ...base, fetchOnchainCode: async () => true });
    expect(withCode.ok).toBe(true);
    if (withCode.ok) expect(withCode.evidence.source).toBe('sdk+onchain');
  });
  it('교차검증 일치 → ok, source=sdk+onchain', async () => {
    const r = await resolveIndexTokenDecimals({
      chainId: ARBITRUM_CHAIN_ID, marketAddress: ETH_MARKET,
      fetchOnchainDecimals: async () => 18,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence.decimals).toBe(18);
      expect(r.evidence.source).toBe('sdk+onchain');
      expect(r.fromCache).toBe(false);
    }
  });
  it('불일치 / 온체인 실패 / 범위 밖 → fail-closed', async () => {
    const base = { chainId: ARBITRUM_CHAIN_ID, marketAddress: ETH_MARKET };
    expect((await resolveIndexTokenDecimals({ ...base, fetchOnchainDecimals: async () => 8 })).ok).toBe(false);
    expect((await resolveIndexTokenDecimals({ ...base, fetchOnchainDecimals: async () => null })).ok).toBe(false);
    expect((await resolveIndexTokenDecimals({ ...base, fetchOnchainDecimals: async () => { throw new Error('rpc'); } })).ok).toBe(false);
    expect((await resolveIndexTokenDecimals({ ...base, fetchOnchainDecimals: async () => 31 })).ok).toBe(false);
    expect((await resolveIndexTokenDecimals({ ...base, fetchOnchainDecimals: async () => 18.5 })).ok).toBe(false);
  });
  it('검증본 캐시 + stale 재검증 강제', async () => {
    const t0 = Date.now();
    let calls = 0;
    const fetcher = async () => { calls++; return 18; };
    const a = await resolveIndexTokenDecimals({ chainId: ARBITRUM_CHAIN_ID, marketAddress: ETH_MARKET, fetchOnchainDecimals: fetcher, nowMs: t0 });
    expect(a.ok && !a.fromCache).toBe(true);
    const b = await resolveIndexTokenDecimals({ chainId: ARBITRUM_CHAIN_ID, marketAddress: ETH_MARKET, fetchOnchainDecimals: fetcher, nowMs: t0 + 1000 });
    expect(b.ok && b.fromCache).toBe(true);
    expect(calls).toBe(1);
    // stale — 재검증 (온체인 재조회)
    const c = await resolveIndexTokenDecimals({ chainId: ARBITRUM_CHAIN_ID, marketAddress: ETH_MARKET, fetchOnchainDecimals: fetcher, nowMs: t0 + DECIMALS_VERIFIED_MAX_AGE_MS + 1 });
    expect(c.ok && !c.fromCache).toBe(true);
    expect(calls).toBe(2);
    const snap = getDecimalsCacheSnapshot(t0 + DECIMALS_VERIFIED_MAX_AGE_MS + 2000);
    expect(snap).toHaveLength(1);
    expect(snap[0].stale).toBe(false);
  });
});

// ── §4 증거 수집기 (6H-2D: 의미 결속 + receipt + finality 완비 fixture) ────────
const EMITTER = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';
const KEY = '0x' + 'ab'.repeat(32);
const ACCOUNT = ('0x' + 'aa'.repeat(20)) as `0x${string}`;   // main wallet (receiver)
const SUBACCT = ('0x' + 'bb'.repeat(20)) as `0x${string}`;   // subaccount signer
const EXPECTED_ACCOUNTS = [ACCOUNT, SUBACCT];

const stopFields = (over: Partial<Parameters<typeof stopCreatedFields>[0]> = {}) => stopCreatedFields({
  account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`,
  isLong: true, sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimals: 18, ...over,
});
const mkLog = (name: keyof typeof ORDER_EVENT_NAME_HASH, key = KEY, addr = EMITTER): RawLog =>
  mkEventLog2({
    name, orderKey: key, emitter: addr, account: SUBACCT,
    fields: name === 'OrderCreated' ? stopFields() : {},
  });

/** 완전한 클라이언트 — receipt success + finality 충족 (latest = 123 + 100) */
const mkClient = (logs: RawLog[] | null): EvidenceClient => ({
  getOrderLogs: async () => logs,
  getReceipt: async (txHash: string) => {
    const inTx = (logs ?? []).filter(l => l.transactionHash === txHash);
    if (inTx.length === 0) return null;
    // 실제 receipt처럼 해당 tx의 모든 로그 포함
    return { status: 'success' as const, blockNumber: inTx[0].blockNumber == null ? null : String(inTx[0].blockNumber), logs: inTx };
  },
  getLatestBlockNumber: async () => 223n,
});
const baseRow = {
  requestId: null, orderKey: KEY, marketAddress: ETH_MARKET, isLong: true, emitterAddress: null,
  purpose: 'INITIAL_STOP', sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimalsUsed: 18,
};
const baseArgs = { configuredEmitter: EMITTER, expectedAccounts: EXPECTED_ACCOUNTS, expectedReceiver: ACCOUNT };

describe('§4 collectProtectionEvidence', () => {
  it('emitter 미설정 → null (판정 금지)', async () => {
    expect(await collectProtectionEvidence({ row: baseRow, client: mkClient([]), ...baseArgs, configuredEmitter: null, positionExists: true })).toBeNull();
  });
  it('조회 실패 → null (차단 유지)', async () => {
    expect(await collectProtectionEvidence({ row: baseRow, client: mkClient(null), ...baseArgs, positionExists: true })).toBeNull();
    const throwing: EvidenceClient = { getOrderLogs: async () => { throw new Error('rpc'); } };
    expect(await collectProtectionEvidence({ row: baseRow, client: throwing, ...baseArgs, positionExists: true })).toBeNull();
  });
  it('OrderCreated+Executed 결속 (의미결속·receipt·finality 완비) → 증거 필드 채움', async () => {
    const b = await collectProtectionEvidence({
      row: baseRow, client: mkClient([mkLog('OrderCreated'), mkLog('OrderExecuted')]),
      ...baseArgs, positionExists: true,
    });
    expect(b).not.toBeNull();
    expect(b!.semanticOk).toBe(true);
    expect(b!.onchainOrderKey).toBe(KEY);
    expect(b!.onchainExecuted).toBe(true);
    expect(b!.createdTxHash).toBeTruthy();
    expect(b!.resolutionTxHash).toBeTruthy();
    expect(b!.matchedEmitter?.toLowerCase()).toBe(EMITTER.toLowerCase());
    expect(b!.receiptStatus).toBe('success');
    expect(b!.finalityOk).toBe(true);
  });
  it('위조 emitter 로그는 무시 (허용집합 밖)', async () => {
    const forged = mkLog('OrderExecuted', KEY, '0x' + '99'.repeat(20));
    const b = await collectProtectionEvidence({
      row: baseRow, client: mkClient([forged]), ...baseArgs, positionExists: true,
    });
    expect(b!.onchainExecuted).toBe(false);
    expect(b!.onchainOrderKey).toBeNull();
  });
  it('레코드 영속 emitter는 허용집합에 합집합 (created+cancelled)', async () => {
    const stored = '0x' + '77'.repeat(20);
    const b = await collectProtectionEvidence({
      row: { ...baseRow, emitterAddress: stored },
      client: mkClient([mkLog('OrderCreated', KEY, stored), mkLog('OrderCancelled', KEY, stored)]),
      ...baseArgs, positionExists: false,
    });
    expect(b!.onchainCancelled).toBe(true);
  });
  it('서로 다른 orderKey 복수 OrderCreated → ambiguous', async () => {
    const other = '0x' + 'ef'.repeat(32);
    const b = await collectProtectionEvidence({
      row: baseRow, client: mkClient([mkLog('OrderCreated'), mkLog('OrderCreated', other)]),
      ...baseArgs, positionExists: true,
    });
    expect(b!.ambiguous).toBe(true);
    expect(b!.onchainOrderKey).toBeNull();
  });
  it('orderKey 부재 → 온체인 조회 생략, API status 보조만', async () => {
    let called = 0;
    const client: EvidenceClient = { getOrderLogs: async () => { called++; return []; } };
    const b = await collectProtectionEvidence({
      row: { ...baseRow, orderKey: null, requestId: 'req-1' }, client,
      ...baseArgs,
      fetchApiStatus: async () => 'submitted',
      positionExists: true,
    });
    expect(called).toBe(0);
    expect(b!.apiStatus).toBe('submitted');
    expect(b!.onchainOrderKey).toBeNull();
  });
});

// ── §5 정합성 분석 ───────────────────────────────────────────────────────────
describe('§5 analyzeProtectionAnomalies', () => {
  const pos = (k: string, size: number) => ({ positionKey: k, sizeUsd: size });
  const stop = (k: string, size: number, over: Partial<Parameters<typeof analyzeProtectionAnomalies>[0]['stopRows'] extends Array<infer T> | null ? T : never> = {}) =>
    ({ id: `s-${k}-${size}`, positionKey: k, status: 'ACTIVE', purpose: 'INITIAL_STOP', sizeDeltaUsd: size, orderKey: KEY, ...over });

  it('조회 실패 → blockNewOpens (fail-closed)', () => {
    expect(analyzeProtectionAnomalies({ positions: null, stopRows: [] }).blockNewOpens).toBe(true);
    expect(analyzeProtectionAnomalies({ positions: [], stopRows: null }).blockNewOpens).toBe(true);
  });
  it('정상 1:1 커버 → 불일치 0', () => {
    const r = analyzeProtectionAnomalies({ positions: [pos('m:L', 100)], stopRows: [stop('m:L', 100)] });
    expect(r.blockNewOpens).toBe(false);
    expect(r.uncoveredCount + r.staleActiveCount + r.oversizedCount + r.multipleActiveCount + r.keyMismatchCount).toBe(0);
  });
  it('무stop / 고아 / oversized / 다중 / key 부재 각각 검출·차단', () => {
    expect(analyzeProtectionAnomalies({ positions: [pos('a:L', 100)], stopRows: [] }).uncoveredCount).toBe(1);
    expect(analyzeProtectionAnomalies({ positions: [], stopRows: [stop('a:L', 100)] }).staleActiveCount).toBe(1);
    expect(analyzeProtectionAnomalies({ positions: [pos('a:L', 100)], stopRows: [stop('a:L', 150)] }).oversizedCount).toBe(1);
    const multi = analyzeProtectionAnomalies({ positions: [pos('a:L', 100)], stopRows: [stop('a:L', 100), stop('a:L', 50)] });
    expect(multi.multipleActiveCount).toBe(1);
    const nokey = analyzeProtectionAnomalies({ positions: [pos('a:L', 100)], stopRows: [stop('a:L', 100, { orderKey: null } as never)] });
    expect(nokey.keyMismatchCount).toBe(1);
    for (const r of [multi, nokey]) expect(r.blockNewOpens).toBe(true);
  });
  it('허용오차 1.0001 이내 초과분은 oversized 아님 (반올림 방어)', () => {
    const r = analyzeProtectionAnomalies({ positions: [pos('a:L', 100)], stopRows: [stop('a:L', 100.005)] });
    expect(r.oversizedCount).toBe(0);
  });
  it('EMERGENCY_CLOSE purpose는 커버리지 계산에서 제외', () => {
    const r = analyzeProtectionAnomalies({
      positions: [],
      stopRows: [{ id: 'e1', positionKey: 'a:L', status: 'ACTIVE', purpose: 'EMERGENCY_CLOSE', sizeDeltaUsd: 100, orderKey: KEY }],
    });
    expect(r.staleActiveCount).toBe(0);
  });
});

// ── §6 action 예산 경로 표 ────────────────────────────────────────────────────
describe('§6 CANARY_ACTION_PATHS 경로별 소비', () => {
  it('경로 표 골든: 정상 2 / stop실패 4 / +5% 5 / +10% 4 / FROZEN 4', () => {
    const totals = CANARY_ACTION_PATHS.map(p => p.total);
    expect(CANARY_ACTION_PATHS).toHaveLength(5);
    expect(totals).toEqual([2, 4, 5, 4, 4]);
    // 각 경로의 total은 step별 소비 합과 일치 (표-계산 결속)
    for (const p of CANARY_ACTION_PATHS) expect(p.total).toBe(p.steps.length);
  });
  it('WORST_PATH_ACTIONS는 경로 표에서 동적 산출 = 5, required=6', () => {
    expect(WORST_PATH_ACTIONS).toBe(Math.max(...CANARY_ACTION_PATHS.map(p => p.total)));
    expect(WORST_PATH_ACTIONS).toBe(5);
    expect(RESERVED_EMERGENCY_ACTIONS).toBe(1);
    expect(requiredActionsBeforeOpen()).toBe(6);
    expect(MIN_SAFE_ACTION_BUDGET).toBe(6);
  });
  it('부족 시 sufficient=false — 제출 함수 자체가 호출되지 않는 계약 (게이트 위치는 executor)', () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const r = evaluateActionBudget({ remaining: '2', expiresAt: future, nowMs: Date.now(), inFlightReservedActions: 1 });
    expect(r.sufficient).toBe(false);
    expect(r.budgetShortfall).toBe(5); // required 6 + inFlight 1 − remaining 2
  });
});
