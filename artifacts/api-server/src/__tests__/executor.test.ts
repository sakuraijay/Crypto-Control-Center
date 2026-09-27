/**
 * Executor 테스트 — LIVE_EXECUTION_LOCKED 상수 및 dry-run 반환 검증
 *
 * 실제 주문·서명·자금이동이 발생하지 않음을 확인합니다.
 */
import { vi, describe, it, expect, afterEach } from 'vitest';

// ── 의존성 모킹 (vi.mock은 Vitest에 의해 파일 최상단으로 호이스팅됨) ────────

vi.mock('../workers/aiWorker', () => ({
  workerManager: {
    start:     vi.fn().mockResolvedValue(undefined),
    stop:      vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => ({ workerRunning: false, cycleCount: 0 })),
    isRunning: vi.fn(() => false),
  },
}));

vi.mock('@workspace/db', () => {
  function chain(result: unknown) {
    const c: Record<string, unknown> = {};
    ['from','where','limit','offset','orderBy','values','set',
     'onConflictDoNothing','returning','groupBy'].forEach(m => {
      c[m] = vi.fn(() => c);
    });
    c['then']  = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    c['catch'] = (reject:  (e: unknown) => unknown) => Promise.resolve(result).catch(reject);
    return c;
  }
  const tbl = new Proxy({}, { get: (_t, k) => ({ col: String(k) }) });
  return {
    db: {
      select: vi.fn(() => chain([])),
      insert: vi.fn(() => chain(undefined)),
      update: vi.fn(() => chain(undefined)),
      delete: vi.fn(() => chain(undefined)),
    },
    aiDecisionsTable:   tbl,
    tradesTable:        tbl,
    workerStateTable:   tbl,
    strategyConfigTable: tbl,
    liveApprovalsTable: tbl,
  };
});

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn(() => ({})),
  desc:      vi.fn(() => ({})),
  asc:       vi.fn(() => ({})),
  sql:       Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
  and:       vi.fn(() => ({})),
  or:        vi.fn(() => ({})),
  gt:        vi.fn(() => ({})),
  gte:       vi.fn(() => ({})),
  lt:        vi.fn(() => ({})),
  lte:       vi.fn(() => ({})),
  ne:        vi.fn(() => ({})),
  inArray:   vi.fn(() => ({})),
  isNull:    vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
}));

// 모킹 이후 실제 모듈 import
import { LIVE_EXECUTION_LOCKED, executeOrder, getExecutorStatus } from '../workers/internalExecutor';

// ── 테스트 ─────────────────────────────────────────────────────────────────────

describe('LIVE_EXECUTION_LOCKED 상수', () => {
  it('LIVE_EXECUTION_LOCKED = true (절대 불변)', () => {
    expect(LIVE_EXECUTION_LOCKED).toBe(true);
  });

  it('LIVE_EXECUTION_LOCKED는 리터럴 상수 타입이다 (as const)', () => {
    // TypeScript 타입 레벨에서 true as const — 런타임에서 타입은 boolean이지만 값은 true
    const val: true = LIVE_EXECUTION_LOCKED;  // 컴파일 오류 없으면 as const ✓
    expect(val).toBe(true);
  });
});

describe('executeOrder — LIVE_EXECUTION_LOCKED 시 dry-run 반환', () => {
  const baseParams = {
    decisionId:      'test-decision-001',
    operatingState:  'LONG',
    symbol:          'BTC',
    executionType:   'perp_long_open',
    sizeUsd:         1_000,
    leverage:        5,
    tpPrice:         null,
    slPrice:         null,
    trailingStopPct: null,
    cycleNumber:     1,
  } as const;

  it('executeOrder는 simulated=true를 반환한다 (실제 주문 없음)', async () => {
    const result = await executeOrder(baseParams);
    expect(result.simulated).toBe(true);
  });

  it('executeOrder는 txHash=null을 반환한다 (블록체인 전송 없음)', async () => {
    const result = await executeOrder(baseParams);
    expect(result.txHash).toBeNull();
  });

  it('executeOrder는 ok=true를 반환한다 (dry-run 성공)', async () => {
    const result = await executeOrder(baseParams);
    expect(result.ok).toBe(true);
  });

  it('LONG/SHORT/SPOT/HEDGE 모두 dry-run으로 처리된다', async () => {
    const states = ['LONG', 'SHORT', 'SPOT', 'HEDGE'] as const;
    for (const state of states) {
      const result = await executeOrder({ ...baseParams, operatingState: state });
      expect(result.simulated).toBe(true);
      expect(result.txHash).toBeNull();
    }
  });

  it('실행 결과 note에 LIVE_EXECUTION_LOCKED 언급이 있다', async () => {
    const result = await executeOrder(baseParams);
    expect(result.note).toContain('LIVE_EXECUTION_LOCKED');
  });
});

// ── ExecutorStatus 활성 모드 필드 (UI 배지 근거) ──────────────────────────────

describe('getExecutorStatus — engineMode / liveExecutionLocked', () => {
  const savedMode = process.env.WORKER_ENGINE_MODE;
  const savedLock = process.env.LIVE_TEST_EXECUTION_LOCKED;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.WORKER_ENGINE_MODE;
    else process.env.WORKER_ENGINE_MODE = savedMode;
    if (savedLock === undefined) delete process.env.LIVE_TEST_EXECUTION_LOCKED;
    else process.env.LIVE_TEST_EXECUTION_LOCKED = savedLock;
  });

  it("WORKER_ENGINE_MODE 미설정 → engineMode='PAPER' (fail-closed)", () => {
    delete process.env.WORKER_ENGINE_MODE;
    expect(getExecutorStatus().engineMode).toBe('PAPER');
  });

  it("WORKER_ENGINE_MODE='PAPER' → engineMode='PAPER'", () => {
    process.env.WORKER_ENGINE_MODE = 'PAPER';
    expect(getExecutorStatus().engineMode).toBe('PAPER');
  });

  it("WORKER_ENGINE_MODE='LIVE' → engineMode='LIVE'", () => {
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    expect(getExecutorStatus().engineMode).toBe('LIVE');
  });

  it("WORKER_ENGINE_MODE 오타/기타 값 → engineMode='PAPER' (정확 일치만 LIVE)", () => {
    process.env.WORKER_ENGINE_MODE = 'live';
    expect(getExecutorStatus().engineMode).toBe('PAPER');
  });

  it('LIVE_TEST_EXECUTION_LOCKED 미설정 → liveExecutionLocked=true (기본 잠금)', () => {
    delete process.env.LIVE_TEST_EXECUTION_LOCKED;
    expect(getExecutorStatus().liveExecutionLocked).toBe(true);
  });

  it("LIVE_TEST_EXECUTION_LOCKED='true' → liveExecutionLocked=true", () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'true';
    expect(getExecutorStatus().liveExecutionLocked).toBe(true);
  });

  it("LIVE_TEST_EXECUTION_LOCKED='false' 명시 시에만 잠금 해제로 보고된다", () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    expect(getExecutorStatus().liveExecutionLocked).toBe(false);
  });
});
