/**
 * Beta RC — 서버 권위 PAPER 실행기 E2E 수명주기 (fixture 상태 저장소, 실제 상태 머신).
 *
 * 기존 serverPaperExecutor.test.ts는 시나리오별 sequence mock — 이 파일은 stateful
 * in-memory 저장소를 두고 OPEN→관리 틱→CLOSE→재시작 복구를 하나의 저장소 위에서
 * round-trip으로 검증한다 (OPEN insert 값이 그대로 이후 select에 돌아온다).
 *
 *  §1 OPEN → SL 터치 → net settlement (gross − 진입·청산·funding·borrowing) → 중복 close 0건
 *  §2 OPEN → TP 터치 → CLOSE reason=TAKE_PROFIT
 *  §3 CASH 전환: requestServerPaperCloseAll → pendingClose 최우선 전량 청산 → 키 해제
 *  §4 RISK_CLOSE_ALL 사유 결속
 *  §5 재시작 복구: 상태 리셋 후 loadPendingCloseFromDb + DB open 행만으로 틱이 청산 완수
 *  §6 프로필별 진입 차단: 보수적 1개, aggressive는 서로 다른 심볼 슬롯 2개
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── stateful in-memory 저장소 mock ───────────────────────────────────────────
interface Store {
  trades: Record<string, unknown>[];
  workerState: Map<string, string>;
}
const store: Store = { trades: [], workerState: new Map() };

/** where 인자(드리즐 SQL 객체)를 순환 안전하게 평탄화해 포함된 문자열 수집 */
function flatStrings(x: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (x == null) return out;
  if (typeof x === 'string') { out.push(x); return out; }
  if (typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  for (const v of Object.values(x as Record<string, unknown>)) flatStrings(v, out, seen);
  return out;
}

vi.mock('@workspace/db', () => {
  const tradesTable = {
    id: 'id', symbol: 'symbol', side: 'side', action: 'action', size: 'size',
    price: 'price', pnl: 'pnl', strategy: 'strategy', timestamp: 'timestamp',
    closeTime: 'closeTime', sizeInUsd: 'sizeInUsd', managedBy: 'managedBy',
    openDecisionId: 'openDecisionId', closesTradeId: 'closesTradeId',
    closeKind: 'closeKind', stopPriceUsd: 'stopPriceUsd',
    takeProfitPriceUsd: 'takeProfitPriceUsd', leverage: 'leverage',
    estEntryCostUsd: 'estEntryCostUsd', estExitCostUsd: 'estExitCostUsd',
    fundingRatePerHour: 'fundingRatePerHour', borrowingRatePerHour: 'borrowingRatePerHour',
    costFetchedAt: 'costFetchedAt', $inferSelect: {},
  };
  const workerStateTable = { key: 'wsKey', value: 'value', updatedAt: 'updatedAt' };

  function chain(exec: (op: { where?: unknown; values?: unknown; set?: unknown }) => unknown) {
    const op: { where?: unknown; values?: unknown; set?: unknown } = {};
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'limit', 'offset', 'orderBy', 'onConflictDoNothing', 'onConflictDoUpdate', 'returning']) c[m] = () => c;
    c['where'] = (arg: unknown) => { op.where = arg; return c; };
    c['values'] = (arg: unknown) => { op.values = arg; return c; };
    c['set'] = (arg: unknown) => { op.set = arg; return c; };
    (c as { then(r: (v: unknown) => unknown, j?: (e: unknown) => unknown): Promise<unknown> }).then =
      (resolve, reject) => Promise.resolve().then(() => exec(op)).then(resolve, reject);
    return c;
  }
  return { db: {
    select: vi.fn(() => chain((op) => globalThis.__e2eExec('select', op))),
    insert: vi.fn(() => chain((op) => globalThis.__e2eExec('insert', op))),
    update: vi.fn(() => chain((op) => globalThis.__e2eExec('update', op))),
    delete: vi.fn(() => chain((op) => globalThis.__e2eExec('delete', op))),
  }, tradesTable, workerStateTable };
});

declare global {
  // eslint-disable-next-line no-var
  var __e2eExec: (kind: string, op: { where?: unknown; values?: unknown; set?: unknown }) => unknown;
}

const WS_KEYS = ['serverPaperPendingClose', 'pendingClose'];

globalThis.__e2eExec = (kind, op) => {
  const strs = flatStrings(op.where);
  const isWorkerState = strs.includes('wsKey') ||
    (op.values != null && typeof (op.values as Record<string, unknown>)['key'] === 'string') ||
    strs.some((s) => WS_KEYS.some((k) => s.includes(k)) || s.startsWith('profitProtect'));

  if (isWorkerState) {
    const key = strs.find((s) => WS_KEYS.some((k) => s.includes(k)) || s.startsWith('profitProtect'))
      ?? (op.values as Record<string, string> | undefined)?.['key'];
    if (kind === 'select') return key && store.workerState.has(key) ? [{ key, value: store.workerState.get(key) }] : [];
    if (kind === 'insert') { const v = op.values as Record<string, string>; store.workerState.set(v['key']!, v['value']!); return [{}]; }
    if (kind === 'update') { if (key) store.workerState.set(key, (op.set as Record<string, string>)['value']!); return []; }
    if (kind === 'delete') { if (key) store.workerState.delete(key); return 1; }
    return [];
  }

  // trades
  if (kind === 'insert') {
    const v = op.values as Record<string, unknown>;
    // unique 강제: openDecisionId(OPEN)·closesTradeId(FULL CLOSE)·SERVER slot/symbol
    if (v['action'] === 'OPEN') {
      if (store.trades.some((r) => r['action'] === 'OPEN' && r['openDecisionId'] === v['openDecisionId']))
        throw new Error('duplicate key value violates unique constraint "trades_open_decision_uq"');
      if (store.trades.some((r) => r['action'] === 'OPEN' && r['managedBy'] === 'SERVER'
        && r['closeTime'] === 0 && r['paperPositionSlot'] === v['paperPositionSlot']))
        throw new Error('duplicate key value violates unique constraint "trades_server_open_slot_uq"');
      if (store.trades.some((r) => r['action'] === 'OPEN' && r['managedBy'] === 'SERVER'
        && r['closeTime'] === 0 && String(r['symbol']).toUpperCase() === String(v['symbol']).toUpperCase()))
        throw new Error('duplicate key value violates unique constraint "trades_server_open_symbol_uq"');
    }
    if (v['action'] === 'CLOSE' && v['closeKind'] === 'FULL') {
      if (store.trades.some((r) => r['action'] === 'CLOSE' && r['closeKind'] === 'FULL' && r['closesTradeId'] === v['closesTradeId']))
        throw new Error('duplicate key value violates unique constraint "trades_full_close_uq"');
    }
    store.trades.push({ ...v });
    return [{ id: v['id'] }];
  }
  if (kind === 'select') {
    // by-id: where에 저장된 trade id가 등장하면 해당 행 (closeTime 무관 — idempotency 판정용)
    const byId = store.trades.find((r) => strs.includes(r['id'] as string));
    if (byId) return [byId];
    if (strs.includes('SERVER') || strs.includes('managedBy')) {
      return store.trades.filter((r) => r['managedBy'] === 'SERVER' && r['action'] === 'OPEN' && r['closeTime'] === 0);
    }
    return [];
  }
  if (kind === 'update') {
    const target = store.trades.find((r) => strs.includes(r['id'] as string));
    if (target) {
      // 조건부 UPDATE: closeTime=0 조건 존중 (이미 닫힌 행 재청산 금지)
      if (strs.includes('closeTime') && target['closeTime'] !== 0) return [];
      Object.assign(target, op.set as Record<string, unknown>);
    }
    return [];
  }
  return [];
};

vi.mock('../lib/paperCostCache', () => ({ getPaperCostBinding: vi.fn(() => null) }));

import { getPaperCostBinding } from '../lib/paperCostCache';
import {
  openServerPaperPosition, requestServerPaperCloseAll, loadPendingCloseFromDb,
  manageServerPaperTick, loadServerOpenRows, getServerPaperStatus,
  __resetServerPaperStateForTests, PENDING_CLOSE_KEY,
} from '../workers/serverPaperExecutor';

const BINDING = {
  costSource: 'PAPER_GMX_ESTIMATE' as const,
  estEntryCostUsd: 0.9, estExitCostUsd: 0.7,
  fundingRatePerHourFraction: 0.00001, borrowingRatePerHourFraction: 0.00002,
  costFetchedAt: new Date().toISOString(),
};

const T0 = Date.now();
const H = 3_600_000;
const CONSERVATIVE_PROFILE = {
  name: 'conservative' as const,
  version: 'risk-profile/v1' as const,
  appliedAt: '2026-08-21T00:00:00.000Z',
  derivedLimits: {
    immediateEntryThreshold: 80, maxRiskPerTradePct: 0.25, reserveCashPct: 20,
    maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30,
    maxLeverage: 3, maxTotalExposureUsd: 3_000,
    allocatedTradingCapitalUsd: 1_000, maxRiskPerTradeUsd: 2.5,
  },
};

async function openBtcLong(nowMs = T0, decisionId = 'dec-e2e-1') {
  return openServerPaperPosition({
    decisionId, symbol: 'BTC', side: 'LONG', sizeUsd: 300, leverage: 3,
    quote: { priceUsd: 50_000, ageMs: 5_000 }, tpPriceUsd: 52_000,
    openPositionCount: 0, entriesManilaDay: 0,
    riskProfileSnapshot: CONSERVATIVE_PROFILE, nowMs,
  });
}

const quoteFn = (priceUsd: number) => (_sym: string) => ({ priceUsd, ageMs: 5_000 });

function closeRows() {
  return store.trades.filter((r) => r['action'] === 'CLOSE');
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetServerPaperStateForTests();
  store.trades = [];
  store.workerState.clear();
  vi.mocked(getPaperCostBinding).mockReturnValue(BINDING as ReturnType<typeof getPaperCostBinding>);
});

describe('E2E §1 — OPEN → SL 터치 → net settlement → 중복 0건', () => {
  it('전 수명주기 round-trip: 저장된 OPEN 값 그대로 정산', async () => {
    const r = await openBtcLong();
    expect(r.ok).toBe(true);
    expect(store.trades).toHaveLength(1);
    const open = store.trades[0]!;
    expect(open['stopPriceUsd']).toBe(String(50_000 * 0.99));

    // 1h 후 SL 터치 (49_400 < 49_500)
    await manageServerPaperTick(quoteFn(49_400), T0 + H);
    const closes = closeRows();
    expect(closes).toHaveLength(1);
    const c = closes[0]!;
    expect(c['closeReason']).toBe('STOP_LOSS');
    expect(c['closeKind']).toBe('FULL');
    expect(c['closesTradeId']).toBe(open['id']);
    // gross = (49400-50000)/50000 * 300 = -3.6
    expect(parseFloat(c['pnl'] as string)).toBeCloseTo(-3.6, 6);
    // holding 1h: funding 0.003→ceilCents 0.01, borrowing 0.006→0.01 → 총 0.02 (센트 올림 계약)
    expect(parseFloat(c['netPnlEstimatedUsd'] as string)).toBeCloseTo(-3.6 - 0.9 - 0.7 - 0.02, 6);
    expect(c['settlementStatus']).toBe('PAPER_ESTIMATED');
    // OPEN 행 확정 + 미청산 0건
    expect(open['closeTime']).toBe(T0 + H);
    expect(await loadServerOpenRows()).toHaveLength(0);

    // 같은 가격으로 틱 반복 — 추가 CLOSE 0건 (중복 정산 금지)
    await manageServerPaperTick(quoteFn(49_400), T0 + H + 10_000);
    await manageServerPaperTick(quoteFn(49_400), T0 + H + 20_000);
    expect(closeRows()).toHaveLength(1);
  });
});

describe('E2E §2 — TP 터치', () => {
  it('TP 도달 시 reason=TAKE_PROFIT, net = gross − 비용', async () => {
    await openBtcLong();
    await manageServerPaperTick(quoteFn(52_100), T0 + 2 * H);
    const c = closeRows();
    expect(c).toHaveLength(1);
    expect(c[0]!['closeReason']).toBe('TAKE_PROFIT');
    const gross = ((52_100 - 50_000) / 50_000) * 300;
    // holding 2h: funding 0.006→ceilCents 0.01, borrowing 0.012→0.02 → 총 0.03
    expect(parseFloat(c[0]!['netPnlEstimatedUsd'] as string)).toBeCloseTo(gross - 0.9 - 0.7 - 0.03, 6);
  });
});

describe('E2E §3/§4 — CASH·RISK 전환 pendingClose', () => {
  it('CASH_TRANSITION: pendingClose 최우선 청산 + worker_state 키 정리', async () => {
    await openBtcLong();
    const req = await requestServerPaperCloseAll('CASH_TRANSITION');
    expect(req.persisted).toBe(true);
    expect(store.workerState.has(PENDING_CLOSE_KEY)).toBe(true);
    // SL/TP 미터치 가격에서도 pendingClose가 우선 청산
    await manageServerPaperTick(quoteFn(50_100), T0 + H);
    const c = closeRows();
    expect(c).toHaveLength(1);
    expect(c[0]!['closeReason']).toBe('CASH_TRANSITION');
    expect(store.workerState.has(PENDING_CLOSE_KEY)).toBe(false);
    expect(getServerPaperStatus().pendingClose).toBeNull();
  });

  it('RISK_CLOSE_ALL 사유가 CLOSE 행에 결속된다', async () => {
    await openBtcLong();
    await requestServerPaperCloseAll('RISK_CLOSE_ALL');
    await manageServerPaperTick(quoteFn(50_000), T0 + H);
    expect(closeRows()[0]!['closeReason']).toBe('RISK_CLOSE_ALL');
  });
});

describe('E2E §5 — 재시작 복구', () => {
  it('프로세스 재시작 시뮬레이션: 메모리 리셋 후 DB만으로 pendingClose 복원·청산 완수', async () => {
    await openBtcLong();
    await requestServerPaperCloseAll('CASH_TRANSITION');
    // 재시작: 메모리 상태 소멸, DB(store)는 유지
    __resetServerPaperStateForTests();
    expect(getServerPaperStatus().pendingClose).toBeNull();
    await loadPendingCloseFromDb();
    expect(getServerPaperStatus().pendingClose?.reason).toBe('CASH_TRANSITION');
    await manageServerPaperTick(quoteFn(50_050), T0 + H);
    expect(closeRows()).toHaveLength(1);
    expect(await loadServerOpenRows()).toHaveLength(0);
    expect(store.workerState.has(PENDING_CLOSE_KEY)).toBe(false);
  });

  it('pendingClose 없는 재시작: DB open 행이 SL/TP 계약으로 계속 관리된다', async () => {
    await openBtcLong();
    __resetServerPaperStateForTests();
    // stale 아님 + SL 미터치 → 유지
    await manageServerPaperTick(quoteFn(50_200), T0 + H);
    expect(closeRows()).toHaveLength(0);
    expect(await loadServerOpenRows()).toHaveLength(1);
    // SL 터치 → 청산
    await manageServerPaperTick(quoteFn(49_000), T0 + 2 * H);
    expect(closeRows()).toHaveLength(1);
    expect(closeRows()[0]!['closeReason']).toBe('STOP_LOSS');
  });
});

describe('E2E §6 — 중복 진입 차단', () => {
  it('동일 decisionId 재시도 = unique 차단 no-op (OPEN 1건 유지)', async () => {
    const r1 = await openBtcLong(T0, 'dec-dup');
    expect(r1.ok).toBe(true);
    const r2 = await openBtcLong(T0 + 1_000, 'dec-dup');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('중복');
    expect(store.trades.filter((r) => r['action'] === 'OPEN')).toHaveLength(1);
  });

  it('보수적 기본은 SERVER 미청산 1개에서 다른 결정도 차단', async () => {
    await openBtcLong(T0, 'dec-a');
    const r2 = await openBtcLong(T0 + 1_000, 'dec-b');
    expect(r2.ok).toBe(false);
    expect(store.trades.filter((r) => r['action'] === 'OPEN')).toHaveLength(1);
  });

  it('aggressive 이름을 선택해도 동시 포지션 1개 한도는 완화되지 않는다', async () => {
    const profile = {
      name: 'aggressive' as const,
      version: 'risk-profile/v1' as const,
      appliedAt: new Date(T0).toISOString(),
      derivedLimits: {
        immediateEntryThreshold: 80, maxRiskPerTradePct: 0.5, reserveCashPct: 20,
        maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30,
        maxLeverage: 3, maxTotalExposureUsd: 3_000,
        allocatedTradingCapitalUsd: 1_000, maxRiskPerTradeUsd: 5,
      },
    };
    const first = await openServerPaperPosition({
      decisionId: 'dec-slot-1', symbol: 'BTC', side: 'LONG', sizeUsd: 300, leverage: 3,
      quote: { priceUsd: 50_000, ageMs: 5_000 }, tpPriceUsd: null,
      openPositionCount: 0, maxConcurrentPositions: 1, entriesManilaDay: 0,
      riskProfileSnapshot: profile, nowMs: T0,
    });
    const second = await openServerPaperPosition({
      decisionId: 'dec-slot-2', symbol: 'ETH', side: 'SHORT', sizeUsd: 300, leverage: 3,
      quote: { priceUsd: 3_000, ageMs: 5_000 }, tpPriceUsd: null,
      openPositionCount: 1, maxConcurrentPositions: 1, entriesManilaDay: 1,
      riskProfileSnapshot: profile, nowMs: T0 + 1,
    });
    const third = await openServerPaperPosition({
      decisionId: 'dec-slot-3', symbol: 'SOL', side: 'LONG', sizeUsd: 300, leverage: 3,
      quote: { priceUsd: 150, ageMs: 5_000 }, tpPriceUsd: null,
      openPositionCount: 2, maxConcurrentPositions: 1, entriesManilaDay: 2,
      riskProfileSnapshot: profile, nowMs: T0 + 2,
    });
    const duplicate = await openServerPaperPosition({
      decisionId: 'dec-slot-4', symbol: 'BTC', side: 'LONG', sizeUsd: 300, leverage: 3,
      quote: { priceUsd: 50_000, ageMs: 5_000 }, tpPriceUsd: null,
      openPositionCount: 1, maxConcurrentPositions: 1, entriesManilaDay: 2,
      riskProfileSnapshot: profile, nowMs: T0 + 3,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
    const opens = store.trades.filter((r) => r['action'] === 'OPEN');
    expect(opens.map(row => row['paperPositionSlot'])).toEqual([1]);
    expect(opens.every(row => row['riskProfileSnapshot'] === profile)).toBe(true);
  });
});
