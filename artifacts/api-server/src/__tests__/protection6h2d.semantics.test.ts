/**
 * 6H-2D §12 — autoCancel 인코딩 게이트 · 의미 결속 위조 케이스 · receipt/finality ·
 * ambiguous 결선 · 테스트 override 보안 · 예산 정책 메타.
 * 실 RPC/네트워크 0회 — 전부 로컬 fixture 주입.
 */
import { describe, it, expect, vi } from 'vitest';

// CI db-free 규칙 — @workspace/db 최상위 import 차단 (DATABASE_URL 미설정 환경)
vi.mock('@workspace/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'from', 'where', 'values', 'set', 'limit', 'orderBy', 'offset', 'returning', 'onConflictDoUpdate', 'onConflictDoNothing']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain as { then?: unknown }).then = undefined; // thenable 오인 방지
  return new Proxy({ db: chain }, {
    get: (t, prop) => (prop in t ? (t as Record<string | symbol, unknown>)[prop] : {}),
  });
});

import { verifyOrderSemanticBinding, extractAutoCancelEncoded, type GmxOrderRequest } from '../lib/gmxApiExecution';
import { collectProtectionEvidence, EVIDENCE_CONFIRMATION_DEPTH, type EvidenceClient } from '../lib/protectionEvidence';
import { decodeEventLog2Data, accountTopicOf, type RawLog } from '../lib/gmxOrderEvents';
import {
  ACTION_BUDGET_VERSION, AUTO_CANCEL_BUDGET_POLICY, worstCasePathName,
  RECOMMENDED_OWNER_APPROVAL_COUNT, requiredActionsBeforeOpen, CANARY_ACTION_PATHS,
} from '../lib/actionBudget';
import { mkEventLog2, stopCreatedFields, mkReceiptFor, encodeEventLog2Data } from './helpers/eventLog2Fixture';

const ETH_MARKET = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336';
const EMITTER = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';
const KEY = '0x' + 'ab'.repeat(32);
const ACCOUNT = ('0x' + 'aa'.repeat(20)) as `0x${string}`;
const SUBACCT = ('0x' + 'bb'.repeat(20)) as `0x${string}`;

// ── §2 — typed data autoCancel 인코딩 게이트 ─────────────────────────────────

const stopReq: GmxOrderRequest = {
  kind: 'STOP_LOSS', symbol: 'ETH', marketAddress: ETH_MARKET, isLong: true,
  sizeUsd: 100, collateralUsd: 0, mainWallet: ACCOUNT, subaccountAddress: SUBACCT,
  triggerPriceGmx: '2000' + '0'.repeat(12), acceptablePriceGmx: '1990' + '0'.repeat(12),
};
const stopMsg = (autoCancel: unknown) => ({
  order: {
    sizeDeltaUsd: '100' + '0'.repeat(30), isLong: true, market: ETH_MARKET,
    orderType: '6', triggerPrice: '2000' + '0'.repeat(12), swapPath: [],
    ...(autoCancel === undefined ? {} : { autoCancel }),
  },
});
// sizeDeltaUsd 계산은 sizeDeltaUsdString 규칙(1e30)과 무관히 실제 헬퍼 출력에 결속:
// 여기서는 게이트의 autoCancel 분기만 검증하므로 다른 필드는 통과 fixture를 사용한다.
const passingMsg = (autoCancel: unknown) => {
  const m = stopMsg(autoCancel) as { order: Record<string, unknown> };
  // verifyOrderSemanticBinding이 기대하는 정확한 문자열로 정렬
  m.order.sizeDeltaUsd = (100n * 10n ** 30n).toString();
  m.order.triggerPrice = stopReq.triggerPriceGmx;
  return m;
};

describe('§2 autoCancel typed data 게이트', () => {
  it('STOP_LOSS: autoCancel=false → 서명 허용', () => {
    expect(verifyOrderSemanticBinding(passingMsg(false), stopReq).ok).toBe(true);
    expect(verifyOrderSemanticBinding(passingMsg('false'), stopReq).ok).toBe(true);
  });
  it('STOP_LOSS: autoCancel 부재 → 서명 금지 (결속 불가)', () => {
    const r = verifyOrderSemanticBinding(passingMsg(undefined), stopReq);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('autoCancel 부재');
  });
  it('autoCancel=true / 비boolean → 서명 금지', () => {
    expect(verifyOrderSemanticBinding(passingMsg(true), stopReq).ok).toBe(false);
    expect(verifyOrderSemanticBinding(passingMsg('true'), stopReq).ok).toBe(false);
    expect(verifyOrderSemanticBinding(passingMsg(1), stopReq).ok).toBe(false);
    expect(verifyOrderSemanticBinding(passingMsg({}), stopReq).ok).toBe(false);
  });
  it('extractAutoCancelEncoded — 기록용 추출', () => {
    expect(extractAutoCancelEncoded(passingMsg(false))).toBe(false);
    expect(extractAutoCancelEncoded(passingMsg(true))).toBe(true);
    expect(extractAutoCancelEncoded(passingMsg(undefined))).toBeNull();
  });
});

// ── §3 — eventData 디코딩·의미 결속 ──────────────────────────────────────────

const goodFields = () => stopCreatedFields({
  account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`,
  isLong: true, sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimals: 18,
});
const mkCreated = (fields = goodFields(), over: Partial<Parameters<typeof mkEventLog2>[0]> = {}): RawLog =>
  mkEventLog2({ name: 'OrderCreated', orderKey: KEY, emitter: EMITTER, account: SUBACCT, fields, ...over });

const fullClient = (logs: RawLog[]): EvidenceClient => ({
  getOrderLogs: async () => logs,
  getReceipt: async (tx) => { const f = logs.find(l => l.transactionHash === tx); return f ? mkReceiptFor(f) : null; },
  getLatestBlockNumber: async () => 123n + BigInt(EVIDENCE_CONFIRMATION_DEPTH),
});
const baseRow = {
  requestId: null, orderKey: KEY, marketAddress: ETH_MARKET, isLong: true, emitterAddress: null,
  purpose: 'INITIAL_STOP', sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimalsUsed: 18,
};
const baseArgs = {
  configuredEmitter: EMITTER, positionExists: true,
  expectedAccounts: [ACCOUNT, SUBACCT] as string[], expectedReceiver: ACCOUNT as string,
};

describe('§3 decodeEventLog2Data / accountTopicOf', () => {
  it('공식 ABI round-trip — 의미 필드 복원', () => {
    const log = mkCreated();
    const d = decodeEventLog2Data(log);
    expect(d).not.toBeNull();
    expect(d!.addressItems.get('market')?.toLowerCase()).toBe(ETH_MARKET.toLowerCase());
    expect(d!.uintItems.get('orderType')).toBe(6n);
    expect(d!.boolItems.get('isLong')).toBe(true);
    expect(d!.boolItems.get('autoCancel')).toBe(false);
    expect(d!.addressArrayItems.get('swapPath')).toEqual([]);
    expect(accountTopicOf(log)).toBe(SUBACCT.toLowerCase());
  });
  it('data 부재/파손 → null (성공 가정 금지)', () => {
    expect(decodeEventLog2Data({ ...mkCreated(), data: null })).toBeNull();
    expect(decodeEventLog2Data({ ...mkCreated(), data: '0x1234' })).toBeNull();
  });
});

describe('§3 의미 결속 — 위조/불일치 케이스 전부 ACTIVE 억제', () => {
  it('완전 일치 → semanticOk=true + ACTIVE 적격', async () => {
    const b = await collectProtectionEvidence({ row: baseRow, client: fullClient([mkCreated()]), ...baseArgs });
    expect(b!.semanticOk).toBe(true);
    expect(b!.onchainOrderKey).toBe(KEY);
  });
  const forgeries: Array<[string, () => RawLog]> = [
    ['market 불일치', () => mkCreated({ ...goodFields(), addressItems: goodFields().addressItems!.map(i => i.key === 'market' ? { ...i, value: ('0x' + '99'.repeat(20)) as `0x${string}` } : i) })],
    ['orderType 불일치 (MarketDecrease)', () => mkCreated(stopCreatedFields({ account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`, isLong: true, sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimals: 18, orderType: 4n }))],
    ['isLong 반전', () => mkCreated(stopCreatedFields({ account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`, isLong: false, sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimals: 18 }))],
    ['sizeDeltaUsd 10% 초과', () => mkCreated(stopCreatedFields({ account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`, isLong: true, sizeDeltaUsd: 110, triggerPriceUsd: 2000, decimals: 18 }))],
    ['triggerPrice 상이', () => mkCreated(stopCreatedFields({ account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`, isLong: true, sizeDeltaUsd: 100, triggerPriceUsd: 2100, decimals: 18 }))],
    ['receiver 탈취', () => mkCreated(stopCreatedFields({ account: SUBACCT, receiver: ('0x' + '99'.repeat(20)) as `0x${string}`, market: ETH_MARKET as `0x${string}`, isLong: true, sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimals: 18 }))],
    ['autoCancel=true 인코딩', () => mkCreated(stopCreatedFields({ account: SUBACCT, receiver: ACCOUNT, market: ETH_MARKET as `0x${string}`, isLong: true, sizeDeltaUsd: 100, triggerPriceUsd: 2000, decimals: 18, autoCancel: true }))],
  ];
  for (const [label, mk] of forgeries) {
    it(`${label} → semanticOk=false, ACTIVE 금지`, async () => {
      const b = await collectProtectionEvidence({ row: baseRow, client: fullClient([mk()]), ...baseArgs });
      expect(b!.semanticOk).toBe(false);
      expect(b!.onchainOrderKey).toBeNull();
    });
  }
  it('topic account가 기대 집합 밖 → semanticOk=false', async () => {
    const log = mkEventLog2({ name: 'OrderCreated', orderKey: KEY, emitter: EMITTER, account: '0x' + '99'.repeat(20), fields: goodFields() });
    const b = await collectProtectionEvidence({ row: baseRow, client: fullClient([log]), ...baseArgs });
    expect(b!.semanticOk).toBe(false);
    expect(b!.onchainOrderKey).toBeNull();
  });
  it('기대 account 미구성 / eventData 없음 / decimals 미구성 → 검증 불가(null) → ACTIVE 금지', async () => {
    const noAcct = await collectProtectionEvidence({ row: baseRow, client: fullClient([mkCreated()]), ...baseArgs, expectedAccounts: [] });
    expect(noAcct!.semanticOk).toBeNull();
    expect(noAcct!.onchainOrderKey).toBeNull();
    const noData = await collectProtectionEvidence({ row: baseRow, client: fullClient([{ ...mkCreated(), data: null }]), ...baseArgs });
    expect(noData!.semanticOk).toBeNull();
    expect(noData!.onchainOrderKey).toBeNull();
    const noDec = await collectProtectionEvidence({ row: { ...baseRow, decimalsUsed: null }, client: fullClient([mkCreated()]), ...baseArgs });
    expect(noDec!.semanticOk).toBeNull();
    expect(noDec!.onchainOrderKey).toBeNull();
  });
});

// ── §4 — receipt·finality ────────────────────────────────────────────────────

describe('§4 receipt·finality 게이팅', () => {
  it('receipt 조회 능력 없음 → ACTIVE 금지 (성공 가정 금지)', async () => {
    const noReceipt: EvidenceClient = { getOrderLogs: async () => [mkCreated()], getLatestBlockNumber: async () => 999n };
    const b = await collectProtectionEvidence({ row: baseRow, client: noReceipt, ...baseArgs });
    expect(b!.onchainOrderKey).toBeNull();
  });
  it('receipt reverted → ambiguous + 전이 금지', async () => {
    const log = mkCreated();
    const c: EvidenceClient = {
      getOrderLogs: async () => [log],
      getReceipt: async () => ({ status: 'reverted', blockNumber: '123', logs: [log] }),
      getLatestBlockNumber: async () => 999n,
    };
    const b = await collectProtectionEvidence({ row: baseRow, client: c, ...baseArgs });
    expect(b!.ambiguous).toBe(true);
    expect(b!.onchainOrderKey).toBeNull();
  });
  it('receipt block ≠ log block / receipt에 로그 부재 → ambiguous', async () => {
    const log = mkCreated();
    const wrongBlock: EvidenceClient = {
      getOrderLogs: async () => [log],
      getReceipt: async () => ({ status: 'success', blockNumber: '999', logs: [log] }),
      getLatestBlockNumber: async () => 9999n,
    };
    expect((await collectProtectionEvidence({ row: baseRow, client: wrongBlock, ...baseArgs }))!.ambiguous).toBe(true);
    const missingLog: EvidenceClient = {
      getOrderLogs: async () => [log],
      getReceipt: async () => ({ status: 'success', blockNumber: '123', logs: [] }),
      getLatestBlockNumber: async () => 9999n,
    };
    expect((await collectProtectionEvidence({ row: baseRow, client: missingLog, ...baseArgs }))!.ambiguous).toBe(true);
  });
  it('confirmation depth 미충족 / latest 조회 실패 → 전이 보류', async () => {
    const log = mkCreated();
    const shallow: EvidenceClient = {
      getOrderLogs: async () => [log],
      getReceipt: async () => mkReceiptFor(log),
      getLatestBlockNumber: async () => 123n + BigInt(EVIDENCE_CONFIRMATION_DEPTH - 1),
    };
    const b1 = await collectProtectionEvidence({ row: baseRow, client: shallow, ...baseArgs });
    expect(b1!.finalityOk).toBeNull();
    expect(b1!.onchainOrderKey).toBeNull();
    const noLatest: EvidenceClient = {
      getOrderLogs: async () => [log], getReceipt: async () => mkReceiptFor(log),
    };
    const b2 = await collectProtectionEvidence({ row: baseRow, client: noLatest, ...baseArgs });
    expect(b2!.onchainOrderKey).toBeNull();
  });
  it('Executed+Cancelled 동시 관측 → ambiguous, terminal 전이 금지', async () => {
    const logs = [
      mkCreated(),
      mkEventLog2({ name: 'OrderExecuted', orderKey: KEY, emitter: EMITTER, account: SUBACCT, txHash: '0x' + 'e1'.repeat(32) }),
      mkEventLog2({ name: 'OrderCancelled', orderKey: KEY, emitter: EMITTER, account: SUBACCT, txHash: '0x' + 'e2'.repeat(32) }),
    ];
    const b = await collectProtectionEvidence({ row: baseRow, client: fullClient(logs), ...baseArgs });
    expect(b!.ambiguous).toBe(true);
    expect(b!.onchainExecuted).toBe(false);
    expect(b!.onchainCancelled).toBe(false);
  });
  it('created 없이 terminal 이벤트만 → ambiguous', async () => {
    const logs = [mkEventLog2({ name: 'OrderExecuted', orderKey: KEY, emitter: EMITTER, account: SUBACCT })];
    const b = await collectProtectionEvidence({ row: baseRow, client: fullClient(logs), ...baseArgs });
    expect(b!.ambiguous).toBe(true);
    expect(b!.onchainExecuted).toBe(false);
  });
  it('terminal 이벤트 account 결속 실패 → terminal 전이 금지', async () => {
    const logs = [
      mkCreated(),
      mkEventLog2({ name: 'OrderExecuted', orderKey: KEY, emitter: EMITTER, account: '0x' + '99'.repeat(20), txHash: '0x' + 'e3'.repeat(32) }),
    ];
    const b = await collectProtectionEvidence({ row: baseRow, client: fullClient(logs), ...baseArgs });
    expect(b!.onchainExecuted).toBe(false);
  });
});

// ── §6 — 테스트 override 보안 + 예산 정책 메타 ────────────────────────────────

describe('§6 override 보안 + 예산 메타', () => {
  it('__setProtectionReconStateForTests — 테스트 런타임 밖 호출 = throw', async () => {
    const { __setProtectionReconStateForTests } = await import('../workers/liveTestExecutor');
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      expect(() => __setProtectionReconStateForTests(null)).toThrow(/테스트 런타임 전용/);
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
      process.env.NODE_ENV = savedNodeEnv;
    }
    // 테스트 런타임에서는 정상 동작 (해제 호출)
    __setProtectionReconStateForTests(null);
  });
  it('예산 정책 메타 — version/정책/최악경로/권장 count', () => {
    expect(ACTION_BUDGET_VERSION).toBe('6H-2D');
    expect(AUTO_CANCEL_BUDGET_POLICY).toContain('autoCancel=false');
    expect(AUTO_CANCEL_BUDGET_POLICY).toContain('cancelOrder 1 action');
    const worst = worstCasePathName();
    expect(CANARY_ACTION_PATHS.some(p => p.path === worst)).toBe(true);
    expect(requiredActionsBeforeOpen()).toBe(6); // cancel 예약 유지 → 불변
    expect(RECOMMENDED_OWNER_APPROVAL_COUNT).toBe(8);
  });
  it('encodeEventLog2Data — eventName 위조와 무관하게 topic 기반 분류 유지 (디코더는 data만 해석)', () => {
    // eventName 문자열을 위조해도 분류는 topics[1] 해시로만 이뤄진다는 계약 확인
    const forged = encodeEventLog2Data('OrderExecuted', {});
    const log = { ...mkCreated(), data: forged };
    const d = decodeEventLog2Data(log);
    expect(d).not.toBeNull(); // 디코딩은 되지만
    expect(d!.uintItems.size).toBe(0); // 의미 필드 없음 → 검증 불가 → ACTIVE 금지 경로
  });
});
