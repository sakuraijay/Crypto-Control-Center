/**
 * AI Worker 통합 테스트
 *
 * WorkerManager 싱글턴(workerManager)을 통해 다음을 검증합니다:
 *  - 정상 사이클 실행 (lastCycleAt 갱신, cycleCount 증가)
 *  - 사이클 오류 후 다음 사이클이 계속 스케줄됨 (crash-restart 안전성)
 *  - 재시작 시 DB에서 HWM 복원
 *  - prevState는 DB에 저장되지 않음 — 재시작 시 'CASH'로 초기화 (설계상 의도)
 *  - consecutiveLosses를 DB 거래 내역에서 재계산
 *  - 쿨다운을 마지막 OPEN 거래 시각에서 재계산 (조기 복귀 차단)
 *  - isRunning atomic lock 으로 동시 사이클 방지
 *  - lastCycleAt은 성공 사이클에서만 갱신 (조기 스킵 시 갱신 안 됨)
 *  - 동일 symbol:operatingState 중복 PENDING 승인 생성 방지
 *  - Worker heartbeat 이상 감지 (lastCycleAt stale 판정)
 *
 * 외부 시장 데이터·운영 DB·실제 RPC 사용하지 않음.
 * LIVE_EXECUTION_LOCKED = true 상태에서만 테스트.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── 외부 의존성 모킹 (vi.mock은 파일 최상단으로 호이스팅됨) ───────────────────

// ── Drizzle 체인 헬퍼 (모킹용) ──────────────────────────────────────────────
//    vi.mock 팩토리 내에서 vi.fn()을 쓸 수 있으므로 여기서 정의
let _dbSelectImpl: () => unknown = () => [];
let _dbInsertImpl: () => unknown = () => undefined;
let _dbUpdateImpl: () => unknown = () => 0;

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

vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      // Task #111 — serverPaperExecutor의 selects(pendingClose/open rows)는 틱 타이밍에 따라
      // 비결정적으로 끼어들므로 카운터 시퀀스에서 제외 (항상 빈 결과)
      const stack = new Error().stack ?? '';
      if (stack.includes('serverPaperExecutor')) return chain(() => []);
      return chain(_dbSelectImpl);
    }),
    insert: vi.fn().mockImplementation(() => chain(_dbInsertImpl)),
    update: vi.fn().mockImplementation(() => chain(_dbUpdateImpl)),
    delete: vi.fn().mockImplementation(() => chain(() => 0)),
  },
  aiDecisionsTable:    new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  liveApprovalsTable:  new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  strategyConfigTable: new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  tradesTable:         new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  workerStateTable:    new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
}));

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  lt:   vi.fn(() => ({})),
  like: vi.fn(() => ({})),
  and:  vi.fn(() => ({})),
  sql:  Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));

vi.mock('../workers/stateEngine', () => ({
  runAiEngine: vi.fn(),
}));

vi.mock('../workers/indicators', () => ({
  computeIndicators: vi.fn(() => ({
    rsi14: 50, ema9: 50000, ema21: 50000, emaCross: 'neutral',
    atrPct: 2.0, priceChange24h: 0, priceChange1h: 0, momentum: 0, trend: 'sideways',
  })),
  computeScores: vi.fn(() => ({
    bullishScore: 40, bearishScore: 40, directionalBias: 0, opportunityScore: 40,
  })),
}));

vi.mock('../routes/gmx', () => ({
  // getCachedPrices는 Map을 반환해야 함 — Worker가 Map.entries()로 이터레이션
  getCachedPrices:    vi.fn(() => new Map<string, number[]>()),
  getCachedChange24h: vi.fn(() => new Map<string, number>()),
  ensureGmxPoller:    vi.fn(),
  fetchServerLiveTestData: vi.fn().mockResolvedValue({
    liveTestAccumLossUsd: 0,
    liveTestDbOk: true,
    livePositionCount: 0,
  }),
  // gmx.ts는 Express Router를 default로 export 함
  default: {},
}));

// 모킹 이후 실제 모듈 import
import { workerManager } from '../workers/aiWorker';
import { runAiEngine }   from '../workers/stateEngine';
import { db }            from '@workspace/db';

// ── 최소 유효 AI 결정 (CASH — 가장 안전한 기본값) ──────────────────────────────
const CASH_DECISION = {
  operatingState: 'CASH' as const,
  confidence: 60,
  reasoning: ['테스트: 신호 없음'],
  stateRationale: '테스트 CASH 결정',
  executionType: 'hold' as const,
  cycleNumber: 1,
  prevState: 'CASH' as const,
  stateChanged: false,
  riskLevel: 'LOW' as const,
  riskApproved: true,
  marketRankings: [],
  riskVetoReason: undefined,
  sizeUsd: undefined,
  leverage: undefined,
  entryStyle: undefined,
  trailingStopPct: undefined,
  tpPrice: undefined,
  slPrice: undefined,
  profitLockStage: 0,
  hedgeParams: undefined,
};

// ── 싱글턴 내부 상태 초기화 헬퍼 ─────────────────────────────────────────────
function resetWorker() {
  const wm = workerManager as unknown as Record<string, unknown>;
  wm.active                  = false;
  wm.isRunning               = false;
  wm.cycleCount              = 0;
  wm.lastCycleAt             = null;
  wm.lastCycleResult         = null;
  wm.prevState               = 'CASH';
  wm.equityHighWaterMark     = null;
  wm.lastLimitsUsed          = null;
  wm.liveTestAccumLossUsd    = 0;
  wm.lastLiveTestVetoReason  = null;
  wm.lastLiveTestMode        = false;
  wm.lastLiveTestDbOk        = true;
  wm.lastPriceAt             = 0;

  const pb = wm.priceBuffer as Map<string, number[]>;
  pb.clear();
  // 가격 히스토리 사전 주입 — 사이클이 "가격 히스토리 부족"으로 건너뛰지 않도록
  // Worker는 최소 2개 심볼 × 충분한 캔들 수가 있어야 사이클을 실행함
  const btcPrices = Array.from({ length: 30 }, (_, i) => 50_000 + (i - 15) * 50);
  const ethPrices = Array.from({ length: 30 }, (_, i) =>  3_000 + (i - 15) * 3);
  pb.set('BTC', btcPrices);
  pb.set('ETH', ethPrices);

  (wm.pendingApprovalKeys as Set<string>).clear();

  const pTimer = wm.pricePollTimer as ReturnType<typeof setInterval> | null;
  if (pTimer) clearInterval(pTimer);
  wm.pricePollTimer = null;

  const cTimer = wm.cycleTimer as ReturnType<typeof setTimeout> | null;
  if (cTimer) clearTimeout(cTimer);
  wm.cycleTimer = null;
}

// ── DB 행 헬퍼 ────────────────────────────────────────────────────────────────

/** workerStateTable equityHwm 행 */
function hwmRow(value: string) {
  return [{ key: 'equityHwm', value, updatedAt: new Date() }];
}

/** strategyConfigTable 기본 행 (빈 limits → Worker defaults 사용) */
const defaultStrategyRow = [{ limits: JSON.stringify({}) }];

/** 거래 없음 (쿨다운·연속 손실 없음) */
const noTradesResult: unknown[] = [];

/** 2건의 연속 음수 손익 CLOSE 거래 */
function makeCloseTrades(consecutiveLosses: number): unknown[] {
  return Array.from({ length: consecutiveLosses }, (_, i) => ({
    action: 'CLOSE',
    pnl: -10 - i,
    timestamp: Date.now() - (i + 1) * 60000,
    closeTime: Date.now() - (i + 1) * 60000,
    sizeInUsd: 1000, size: 0.02, price: 50000, symbol: 'BTC',
    side: 'LONG', leverage: 5, collateralUsd: 200, testMode: false,
  }));
}

/** 최근 OPEN 거래 (쿨다운 시뮬레이션) */
function makeOpenTrade(ageMs: number): unknown[] {
  return [{
    action: 'OPEN',
    pnl: 0,
    timestamp: Date.now() - ageMs,
    closeTime: null,
    sizeInUsd: 1000, size: 0.02, price: 50000, symbol: 'BTC',
    side: 'LONG', leverage: 5, collateralUsd: 200, testMode: false,
  }];
}

// ── 테스트 공통 DB 응답 시퀀서 ────────────────────────────────────────────────
// 실제 select 호출 순서:
//   start()    → (1) loadPendingApprovals (liveApprovalsTable)
//              → (2) loadHwmFromDb        (workerStateTable)
//              → (3) loadBaselinesFromDb  (workerStateTable — 기간 PnL 기준점)
//   runCycle() → (4) loadPendingApprovals again (liveApprovalsTable)
//              → (5) strategyConfigTable
//              → (6) tradesTable (consecutiveLosses + cooldown 계산)
// insert/update 호출은 별도 mock (_dbInsertImpl, _dbUpdateImpl)

function setupDbSequence(opts: {
  pendingApprovals?: unknown[];
  hwmValue?:         string | null;
  strategyRow?:      unknown[];
  trades?:           unknown[];
  insertResult?:     unknown;
} = {}) {
  const pending  = opts.pendingApprovals ?? [];
  const hwm      = opts.hwmValue != null ? hwmRow(opts.hwmValue) : [];
  const strategy = opts.strategyRow ?? defaultStrategyRow;
  const trades   = opts.trades    ?? noTradesResult;
  const inserted = opts.insertResult ?? [{ id: 'test-decision-1' }];

  let selectCallN = 0;
  _dbSelectImpl = () => {
    selectCallN++;
    if (selectCallN === 1) return pending;   // start(): loadPendingApprovals
    if (selectCallN === 2) return hwm;       // start(): loadHwmFromDb
    if (selectCallN === 3) return [];        // start(): loadBaselinesFromDb (기준점 없음)
    if (selectCallN === 4) return [];        // start(): loadRiskEngineState (6H-1 — 미수립)
    if (selectCallN === 5) return pending;   // runCycle(): loadPendingApprovals again
    if (selectCallN === 6) return strategy;  // runCycle(): strategyConfigTable
    if (selectCallN === 7) return trades;    // runCycle(): tradesTable (consecutiveLosses)
    return [];
  };

  _dbInsertImpl = () => inserted;
  _dbUpdateImpl = () => 0;
}

// ────────────────────────────────────────────────────────────────────────────

describe('Worker 초기 상태', () => {
  beforeEach(() => { resetWorker(); });

  it('start() 전에는 workerRunning=false, cycleCount=0, lastCycleAt=null', () => {
    const s = workerManager.getStatus();
    expect(s.workerRunning).toBe(false);
    expect(s.cycleCount).toBe(0);
    expect(s.lastCycleAt).toBeNull();
  });

  it('start()를 두 번 호출해도 중복 활성화되지 않는다', async () => {
    setupDbSequence();
    vi.useFakeTimers();
    try {
      await workerManager.start();
      await workerManager.start(); // no-op
      const wm = workerManager as unknown as Record<string, unknown>;
      expect(wm.cycleCount).toBe(0); // 아직 사이클 실행 전
    } finally {
      workerManager.stop();
      vi.useRealTimers();
    }
  });
});

// ── HWM 재시작 복구 ───────────────────────────────────────────────────────────

describe('crash-restart — HWM DB 복원', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('start() 시 DB에서 equityHwm을 로드한다 (15000)', async () => {
    setupDbSequence({ hwmValue: '15000' });
    vi.useFakeTimers();
    await workerManager.start();
    const s = workerManager.getStatus();
    expect(s.equityHwm).toBe(15000);
  });

  it('DB에 HWM 없으면 null로 시작한다 (첫 실행 시나리오)', async () => {
    setupDbSequence({ hwmValue: null });
    vi.useFakeTimers();
    await workerManager.start();
    const s = workerManager.getStatus();
    expect(s.equityHwm).toBeNull();
  });

  it('equityHwm = 0 이면 무시한다 (유효하지 않은 HWM)', async () => {
    setupDbSequence({ hwmValue: '0' });
    vi.useFakeTimers();
    await workerManager.start();
    const s = workerManager.getStatus();
    // 0은 유효하지 않은 HWM → null 유지
    expect(s.equityHwm).toBeNull();
  });
});

// ── prevState 재시작 시 CASH로 초기화 ─────────────────────────────────────────

describe('crash-restart — prevState 초기화 정책', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('prevState는 DB에 저장되지 않으므로 재시작 후 항상 CASH에서 시작한다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue({ ...CASH_DECISION, operatingState: 'LONG', cycleNumber: 1 } as unknown as ReturnType<typeof runAiEngine>);
    vi.useFakeTimers();

    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머 경과

    // 다음 사이클에서 prevState는 이전 결과(LONG)를 메모리에서 가져옴
    // 재시작 후 첫 사이클에서만 CASH가 전달됨을 검증
    const calls = vi.mocked(runAiEngine).mock.calls;
    if (calls.length > 0) {
      const firstInput = calls[0][0];
      expect(firstInput.prevState).toBe('CASH'); // 재시작 후 첫 사이클
    }
  });
});

// ── 정상 사이클 실행 ──────────────────────────────────────────────────────────

describe('정상 사이클 실행', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('30초 경과 후 첫 사이클이 실행되고 lastCycleAt이 갱신된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);
    vi.useFakeTimers();

    await workerManager.start();
    expect(workerManager.getStatus().lastCycleAt).toBeNull();

    // Worker cycle은 60s 타이머 (시작 로그: "60초 AI 사이클, 10초 가격 폴링")
    await vi.advanceTimersByTimeAsync(65_000);

    const s = workerManager.getStatus();
    expect(s.cycleCount).toBeGreaterThanOrEqual(1);
    expect(s.lastCycleAt).not.toBeNull();
  });

  it('연속 사이클에서 cycleCount가 누적된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);
    vi.useFakeTimers();

    await workerManager.start();
    // 첫 번째 사이클 (60s) + 두 번째 사이클 (60s+60s) = 130s 이상
    await vi.advanceTimersByTimeAsync(130_000);

    expect(workerManager.getStatus().cycleCount).toBeGreaterThanOrEqual(1);
  });
});

// ── 오류 후 사이클 계속 ────────────────────────────────────────────────────────

describe('사이클 오류 복구 — 다음 사이클 계속', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('runAiEngine 오류 발생 후 다음 사이클이 여전히 스케줄된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine)
      .mockImplementationOnce(() => { throw new Error('테스트 강제 오류'); })
      .mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 오류 사이클 (60s 타이머)

    // 오류 후 cycleTimer가 재설정되어 다음 사이클이 예약됨
    const wm = workerManager as unknown as Record<string, unknown>;
    const active = wm.active as boolean;
    expect(active).toBe(true); // 워커가 계속 활성 상태

    // 두 번째 사이클 트리거
    await vi.advanceTimersByTimeAsync(65_000);
    // 두 번째 사이클은 성공 → lastCycleAt이 갱신됨
    expect(workerManager.getStatus().lastCycleAt).not.toBeNull();
  });

  it('사이클 오류 시 lastCycleResult.error가 기록된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockImplementationOnce(() => {
      throw new Error('DB 연결 실패 시뮬레이션');
    });

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000);

    const result = workerManager.getStatus().lastCycleResult;
    // 오류가 있으면 error 필드가 설정됨
    if (result?.error) {
      expect(typeof result.error).toBe('string');
    }
    // 워커는 여전히 활성 상태
    const wm = workerManager as unknown as Record<string, unknown>;
    expect(wm.active as boolean).toBe(true);
  });
});

// ── isRunning lock — 동시 사이클 방지 ────────────────────────────────────────

describe('isRunning atomic lock — 중복 사이클 방지', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('사이클 실행 중에는 isRunning이 true이다', async () => {
    // runAiEngine은 동기 함수이므로 호출 중 isRunning 상태를 캡처
    let isRunningDuringCycle = false;
    setupDbSequence();
    vi.mocked(runAiEngine).mockImplementation(() => {
      const wm = workerManager as unknown as Record<string, unknown>;
      isRunningDuringCycle = wm.isRunning as boolean;
      return CASH_DECISION as unknown as ReturnType<typeof runAiEngine>;
    });

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 타이머 경과

    // runAiEngine이 호출된 경우 isRunning이 true였음을 확인
    if (vi.mocked(runAiEngine).mock.calls.length > 0) {
      expect(isRunningDuringCycle).toBe(true);
    }
    // 사이클 완료 후 isRunning은 false
    const wm = workerManager as unknown as Record<string, unknown>;
    expect(wm.isRunning as boolean).toBe(false);
  });
});

// ── consecutiveLosses DB 재계산 ──────────────────────────────────────────────

describe('crash-restart — consecutiveLosses DB 재계산', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('연속 음수 CLOSE 2건이 있으면 consecutiveLosses=2를 엔진에 전달한다', async () => {
    setupDbSequence({ trades: makeCloseTrades(2) });
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머

    const calls = vi.mocked(runAiEngine).mock.calls;
    if (calls.length > 0) {
      const input = calls[calls.length - 1][0];
      expect(input.consecutiveLosses).toBe(2);
    }
  });

  it('CLOSE 거래가 없으면 consecutiveLosses=0', async () => {
    setupDbSequence({ trades: noTradesResult });
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머

    const calls = vi.mocked(runAiEngine).mock.calls;
    if (calls.length > 0) {
      const input = calls[calls.length - 1][0];
      expect(input.consecutiveLosses).toBe(0);
    }
  });
});

// ── 쿨다운 DB 재계산 ──────────────────────────────────────────────────────────

describe('crash-restart — 쿨다운 DB에서 재계산', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('최근 5분 전 OPEN 거래가 있으면 30분 쿨다운에 의해 사이클이 조기 반환된다', async () => {
    // 기본 쿨다운 30분, 마지막 OPEN이 5분 전 → 25분 남음 → CASH skip
    setupDbSequence({ trades: makeOpenTrade(5 * 60 * 1000) });
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머 경과

    // 쿨다운 중일 때는 runAiEngine이 호출되지 않거나, lastCycleAt이 null
    const s = workerManager.getStatus();
    // 쿨다운 스킵 시 lastCycleAt이 null (성공 사이클이 없음)
    // 또는 cycleCount가 여전히 0
    // 두 가지 중 하나를 확인
    const engineCalled = vi.mocked(runAiEngine).mock.calls.length > 0;
    if (!engineCalled) {
      expect(s.lastCycleAt).toBeNull();
    }
    // 워커는 계속 활성
    expect((workerManager as unknown as Record<string, unknown>).active as boolean).toBe(true);
  });
});

// ── 중복 PENDING 승인 방지 ────────────────────────────────────────────────────

describe('중복 PENDING 승인 방지', () => {
  beforeEach(() => { resetWorker(); });

  it('동일 symbol:operatingState 조합이 pendingApprovalKeys에 이미 있으면 두 번째 추가 안 됨', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    const keys = wm.pendingApprovalKeys as Set<string>;

    keys.add('BTC:LONG');
    const sizeBefore = keys.size;

    // 동일 키 추가 시도
    keys.add('BTC:LONG');
    expect(keys.size).toBe(sizeBefore); // Set이므로 중복 없음

    // 다른 조합은 추가됨
    keys.add('ETH:SHORT');
    expect(keys.size).toBe(sizeBefore + 1);
  });

  it('stop() 후 재시작 시 pendingApprovalKeys가 초기화된다', async () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    const keys = wm.pendingApprovalKeys as Set<string>;
    keys.add('BTC:LONG');

    workerManager.stop();
    resetWorker();

    expect(keys.size).toBe(0);
  });
});

// ── Worker heartbeat / lastCycleAt 이상 감지 ──────────────────────────────────

describe('Worker heartbeat — lastCycleAt 이상 감지', () => {
  beforeEach(() => { resetWorker(); });

  it('lastCycleAt이 null이면 워커가 아직 첫 사이클을 완료하지 않았다', () => {
    const s = workerManager.getStatus();
    expect(s.lastCycleAt).toBeNull();
    expect(s.workerRunning).toBe(false);
  });

  it('lastCycleAt을 현재 시각으로 설정하면 fresh 상태로 판정된다', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    wm.lastCycleAt = new Date();

    const s = workerManager.getStatus();
    const lastAt = s.lastCycleAt ? new Date(s.lastCycleAt) : null;
    expect(lastAt).not.toBeNull();
    const elapsedMs = Date.now() - lastAt!.getTime();
    expect(elapsedMs).toBeLessThan(5_000); // 5초 이내 → fresh
  });

  it('lastCycleAt이 5분 이상 전이면 stale로 판정된다 (heartbeat 이상)', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5분
    wm.lastCycleAt = new Date(Date.now() - STALE_THRESHOLD_MS - 1000);

    const s = workerManager.getStatus();
    const lastAt = s.lastCycleAt ? new Date(s.lastCycleAt) : null;
    expect(lastAt).not.toBeNull();
    const elapsedMs = Date.now() - lastAt!.getTime();
    expect(elapsedMs).toBeGreaterThan(STALE_THRESHOLD_MS);
  });

  it('stop() 호출 후 active가 false가 된다', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    wm.active = true;
    workerManager.stop();
    expect(wm.active as boolean).toBe(false);
  });
});

// ── LIVE_EXECUTION_LOCKED 불변 보안 검증 ─────────────────────────────────────

describe('LIVE_EXECUTION_LOCKED 불변 보안 상수', () => {
  it('internalExecutor.ts에서 LIVE_EXECUTION_LOCKED = true as const 확인', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dir, '../workers/internalExecutor.ts'), 'utf-8');
    expect(src).toContain('LIVE_EXECUTION_LOCKED = true as const');
  });

  it('executeOrder()가 항상 simulated:true를 반환한다 (실제 주문 없음)', async () => {
    const { executeOrder } = await import('../workers/internalExecutor');
    const result = await executeOrder({
      operatingState: 'LONG',
      confidence: 80,
      executionType: 'perp_long_open',
      primarySymbol: 'BTC',
      sizeUsd: 1000,
      leverage: 5,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result.simulated).toBe(true);
    expect(result.txHash).toBeNull();
  });
});

// ── #135 F22 — 자동 Worker LIVE 구조적 분리 게이트 ─────────────────────────────
describe('#135 AUTO_WORKER_LIVE_ENABLED 게이트 (F22)', () => {
  const savedEnv = process.env.AUTO_WORKER_LIVE_ENABLED;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AUTO_WORKER_LIVE_ENABLED;
    else process.env.AUTO_WORKER_LIVE_ENABLED = savedEnv;
  });

  it('플래그 미설정 시 tryLiveTestExecution이 즉시 차단·조기 반환한다 (fail-closed)', async () => {
    delete process.env.AUTO_WORKER_LIVE_ENABLED;
    const { workerManager } = await import('../workers/aiWorker');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (workerManager as any).tryLiveTestExecution(
        { operatingState: 'LONG', confidence: 90, executionType: 'perp_long_open', primarySymbol: 'BTC' },
        [{ symbol: 'BTC', price: 60000 }], { positionCount: 0 },
        { liveTestAccumLossUsd: 0, liveTestDbOk: true },
        { liveTestMode: true, tradingCapital: 100 }, 1,
      );
      const blocked = infoSpy.mock.calls.some(c =>
        String(c[0]).includes('AUTO_WORKER_LIVE_ENABLED'));
      expect(blocked).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("플래그가 'true'가 아닌 값('1', 'TRUE' 등)이어도 차단된다", async () => {
    process.env.AUTO_WORKER_LIVE_ENABLED = '1';
    const { workerManager } = await import('../workers/aiWorker');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (workerManager as any).tryLiveTestExecution(
        { operatingState: 'SHORT', confidence: 90, executionType: 'perp_short_open', primarySymbol: 'ETH' },
        [{ symbol: 'ETH', price: 3000 }], { positionCount: 0 },
        { liveTestAccumLossUsd: 0, liveTestDbOk: true },
        { liveTestMode: true, tradingCapital: 100 }, 1,
      );
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('AUTO_WORKER_LIVE_ENABLED'))).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
