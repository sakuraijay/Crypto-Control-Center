/**
 * #135 — Manual Controlled Canary 장애주입 테스트
 *
 * docs/manual-canary.md 실패 가능성 표 F1~F21 커버 (F22는 aiWorker.test.ts).
 * 전 의존성 fake 주입 — 실제 DB/RPC/주문 경로 0회.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// CI db-free import 규칙 — manualCanary가 @workspace/db를 import하므로 mock 필수
vi.mock('@workspace/db', () => ({
  db: {},
  workerStateTable: new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
}));

import {
  runCanaryPreflight, executeManualCanaryOpen, executeManualCanaryClose,
  claimDailyBudget, getCanaryStatus, validateCanaryRequest, buildCanaryDecisionId,
  MANUAL_CANARY_CAPS, CANARY_CONFIRM_OPEN, CANARY_CONFIRM_CLOSE,
  type ManualCanaryDeps, type CheckOutcome,
} from '../lib/manualCanary';
import { manilaDayKey } from '../lib/profitProtection';

const OK: CheckOutcome = { ok: true, detail: 'ok' };
const FAIL = (d: string): CheckOutcome => ({ ok: false, detail: d });
const NOW = new Date('2026-08-19T03:00:00Z');
const DAY = manilaDayKey(NOW);

/** in-memory worker_state + 전부 정상인 기본 fake deps */
function makeDeps(overrides: Partial<ManualCanaryDeps> = {}) {
  const state = new Map<string, string>();
  const executeOrder = vi.fn<ManualCanaryDeps['executeOrder']>(async (_params) => ({
    ok: true, txHash: '0xabc', orderKey: '0xkey', simulated: false, executedAt: NOW.toISOString(),
  }));
  const closePosition = vi.fn<ManualCanaryDeps['closePosition']>(async (_params) => ({
    ok: true, txHash: '0xdef', orderKey: '0xkey2', simulated: false, executedAt: NOW.toISOString(),
  }));
  const runEmergencyClose = vi.fn<ManualCanaryDeps['runEmergencyClose']>(async (_reason) => OK);
  let idSeq = 0;
  const deps: ManualCanaryDeps = {
    now: () => NOW,
    randomId: () => `pf-${++idSeq}`,
    routerPin: () => OK,
    deploymentVerified: () => OK,
    signerBinding: async () => OK,
    ownerApproval: async () => OK,
    allowance: async () => OK,
    gmxApiReadonly: () => OK,
    rpcHealthy: async () => OK,
    reconciliationClean: async () => OK,
    openPositionCount: async () => 0,
    openPositions: async () => [
      { marketAddress: '0x47c031236e19d024b42f8ae6780e44a573170703', isLong: true, sizeUsd: 18.4 },
    ],
    costSnapshot: async () => ({ ok: true, snapshot: {} as never, roundTripCostUsd: 0.25 }),
    decimalsReady: async () => OK,
    stopCapability: async () => OK,
    currentPriceUsd: async () => 60000,
    accumCanaryLossUsd: async () => ({ ok: true, lossUsd: 0.5 }),
    marketAddress: () => '0x47c031236e19d024b42f8ae6780e44a573170703',
    mainAddress: () => '0x46c27887c5ec5e36b2a21e1ec1bc69e7a593950e',
    liveTestMode: () => true,
    envSubmissionState: () => ({ locked: false, submissionEnabled: true, detail: '활성' }),
    executeOrder,
    closePosition,
    runEmergencyClose,
    intentStatus: async () => ({ status: 'CONFIRMED', orderKey: '0xkey', txHash: '0xabc' }),
    initialStopStatus: async () => ({ status: 'ACTIVE', orderKey: '0xstop' }),
    loadState: async (k) => state.get(k) ?? null,
    casState: async (k, prev, next) => {
      const cur = state.get(k) ?? null;
      if (cur !== prev) return false;
      state.set(k, next);
      return true;
    },
    ...overrides,
  };
  return { deps, state, executeOrder, closePosition, runEmergencyClose };
}

async function preflightThenBody(deps: ManualCanaryDeps, symbol = 'BTC', direction = 'LONG') {
  const pf = await runCanaryPreflight(deps, symbol, direction);
  expect(pf.ok).toBe(true);
  return { preflightId: pf.preflightId, confirm: CANARY_CONFIRM_OPEN, symbol, direction };
}

function failedIds(items: { id: string; ok: boolean }[]): string[] {
  return items.filter(i => !i.ok).map(i => i.id);
}

describe('#135 Manual Controlled Canary — 장애주입', () => {
  beforeEach(() => vi.clearAllMocks());

  it('정상 경로: preflight 전 항목 ok → preflightId 발급 → OPEN 단일 제출 1회', async () => {
    const { deps, executeOrder } = makeDeps();
    const body = await preflightThenBody(deps);
    const r = await executeManualCanaryOpen(deps, body);
    expect(r.ok).toBe(true);
    expect(r.phase).toBe('SUBMITTED');
    expect(r.intentId).toBe(`intent:open:manual-canary:${DAY}`);
    expect(executeOrder).toHaveBeenCalledTimes(1);
    // 하드캡이 executeOrder 인자에 그대로 반영
    const params = executeOrder.mock.calls[0]![0];
    expect(params.collateralUsd).toBe(10);
    expect(params.leverage).toBe(2);
    expect(params.sizeUsd).toBe(20);
    const sizing = params.sizingContext!;
    expect(sizing.canaryActive).toBe(true);
    expect(sizing.operatorApprovedNotionalCapUsd).toBe(20);
  });

  it('F1 배포검증/router pin 실패 → preflight FAIL·전체 실패 항목 표시·preflightId 미발급', async () => {
    const { deps, executeOrder } = makeDeps({
      routerPin: () => FAIL('pin 불일치'),
      deploymentVerified: () => FAIL('manifest 미검증'),
    });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.preflightId).toBeNull();
    expect(failedIds(pf.items)).toEqual(expect.arrayContaining(['deployment', 'router_pin']));
    // 나머지 항목도 전부 평가되어 표시된다 (부분 표시 금지)
    expect(pf.items.length).toBeGreaterThanOrEqual(14);
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it('F2 signer 결속 실패 → FAIL (복호화 시도 없음 — read-only deps만 호출)', async () => {
    const { deps } = makeDeps({ signerBinding: async () => FAIL('암호문 부재') });
    const pf = await runCanaryPreflight(deps, 'ETH', 'SHORT');
    expect(pf.ok).toBe(false);
    expect(failedIds(pf.items)).toContain('signer_binding');
  });

  it('F3 Owner Approval 만료 → FAIL·자동 사용 금지', async () => {
    const { deps } = makeDeps({ ownerApproval: async () => FAIL('deadline 만료 — 새 Prepare+서명 필요') });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    const item = pf.items.find(i => i.id === 'owner_approval')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain('서명 필요');
  });

  it('F4 allowance 미확인 → FAIL', async () => {
    const { deps } = makeDeps({ allowance: async () => FAIL('allowance 5 USDC < 15') });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(failedIds(pf.items)).toContain('allowance');
  });

  it('F5 RPC/GMX read-only 불가 → FAIL', async () => {
    const { deps } = makeDeps({
      rpcHealthy: async () => FAIL('canonical readback 없음'),
      gmxApiReadonly: () => FAIL('READONLY ≠ true'),
    });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(failedIds(pf.items)).toEqual(expect.arrayContaining(['rpc', 'gmx_api']));
  });

  it('F6 미종결 intent/task/protection 존재 → FAIL', async () => {
    const { deps } = makeDeps({ reconciliationClean: async () => FAIL('intents 1') });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(failedIds(pf.items)).toContain('reconciliation');
  });

  it('F7 열린 포지션 1건 또는 조회 실패(null) → FAIL (fail-closed)', async () => {
    const a = makeDeps({ openPositionCount: async () => 1 });
    expect(failedIds((await runCanaryPreflight(a.deps, 'BTC', 'LONG')).items)).toContain('open_positions');
    const b = makeDeps({ openPositionCount: async () => null });
    const pfB = await runCanaryPreflight(b.deps, 'BTC', 'LONG');
    const item = pfB.items.find(i => i.id === 'open_positions')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain('fail-closed');
  });

  it('F8 왕복 비용 $0.40 초과 / 스냅샷 미확보 → FAIL', async () => {
    const a = makeDeps({ costSnapshot: async () => ({ ok: true, snapshot: {} as never, roundTripCostUsd: 0.55 }) });
    expect(failedIds((await runCanaryPreflight(a.deps, 'BTC', 'LONG')).items)).toContain('cost_snapshot');
    const b = makeDeps({ costSnapshot: async () => ({ ok: false, reason: 'stale' }) });
    expect(failedIds((await runCanaryPreflight(b.deps, 'BTC', 'LONG')).items)).toContain('cost_snapshot');
  });

  it('F9 decimals 미검증 → FAIL', async () => {
    const { deps } = makeDeps({ decimalsReady: async () => FAIL('교차검증 실패') });
    expect(failedIds((await runCanaryPreflight(deps, 'ETH', 'LONG')).items)).toContain('decimals');
  });

  it('F10 stop capability 불가 → FAIL (OPEN 자체 금지)', async () => {
    const { deps, executeOrder } = makeDeps({ stopCapability: async () => FAIL('stop 능력 없음') });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(failedIds(pf.items)).toContain('stop_capability');
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it('F11 누적 손실 ≥ $3 / 조회 실패 → FAIL', async () => {
    const a = makeDeps({ accumCanaryLossUsd: async () => ({ ok: true, lossUsd: 3.1 }) });
    expect(failedIds((await runCanaryPreflight(a.deps, 'BTC', 'LONG')).items)).toContain('accum_loss');
    const b = makeDeps({ accumCanaryLossUsd: async () => ({ ok: false, lossUsd: null }) });
    expect(failedIds((await runCanaryPreflight(b.deps, 'BTC', 'LONG')).items)).toContain('accum_loss');
  });

  it('F12 일일 1회 소진 → preflight FAIL + claim 거부', async () => {
    const { deps, state } = makeDeps();
    state.set('manualCanaryDaily', JSON.stringify({
      dayKey: DAY, opens: 1, openIntentId: 'intent:open:manual-canary:' + DAY,
      closeIntentId: null, emergencyCloseUsed: false, openedAt: NOW.toISOString(),
    }));
    expect(failedIds((await runCanaryPreflight(deps, 'BTC', 'LONG')).items)).toContain('daily_budget');
    const claim = await claimDailyBudget(deps, 'intent:x');
    expect(claim.ok).toBe(false);
  });

  it('F13 confirm 문구 오류 / preflightId 불일치 / TTL 만료 → 거부·제출 0회', async () => {
    const { deps, executeOrder } = makeDeps();
    const body = await preflightThenBody(deps);
    // confirm 오류
    expect((await executeManualCanaryOpen(deps, { ...body, confirm: 'yes' })).phase).toBe('REJECTED');
    // preflightId 불일치
    expect((await executeManualCanaryOpen(deps, { ...body, preflightId: 'wrong' })).phase).toBe('REJECTED');
    // TTL 만료 (121초 경과)
    const late = makeDeps({ now: () => new Date(NOW.getTime() + 121_000) });
    // 동일 저장 상태 공유를 위해 loadState 위임
    late.deps.loadState = deps.loadState;
    late.deps.casState = deps.casState;
    const r = await executeManualCanaryOpen(late.deps, body);
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('만료');
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it('F14 허용 외 시장/방향 → 거부', async () => {
    expect(validateCanaryRequest('SOL', 'LONG').ok).toBe(false);
    expect(validateCanaryRequest('BTC', 'BOTH').ok).toBe(false);
    const { deps } = makeDeps();
    const pf = await runCanaryPreflight(deps, 'DOGE', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items[0]!.id).toBe('request');
  });

  it('F15 실행 직전 재평가 실패 → 거부·실패 항목 전체 반환·제출 0회', async () => {
    let rpcOk = true;
    const { deps, executeOrder } = makeDeps({ rpcHealthy: async () => (rpcOk ? OK : FAIL('RPC 악화')) });
    const body = await preflightThenBody(deps);
    rpcOk = false; // preflight 이후 상태 악화
    const r = await executeManualCanaryOpen(deps, body);
    expect(r.phase).toBe('REJECTED');
    expect(r.failures.map(f => f.id)).toContain('rpc');
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it('F16 가격 드리프트 0.5% 초과 → 거부 (시장가 추격 방지)', async () => {
    let price = 60000;
    const { deps, executeOrder } = makeDeps({ currentPriceUsd: async () => price });
    const body = await preflightThenBody(deps);
    price = 60400; // +0.67%
    const r = await executeManualCanaryOpen(deps, body);
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('드리프트');
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it('F17 담보/레버리지 확대 시도 → clamp가 아닌 명시 거부', async () => {
    const { deps, executeOrder } = makeDeps();
    const body = await preflightThenBody(deps);
    expect((await executeManualCanaryOpen(deps, { ...body, collateralUsd: 11 })).phase).toBe('REJECTED');
    expect((await executeManualCanaryOpen(deps, { ...body, leverage: 3 })).phase).toBe('REJECTED');
    expect((await executeManualCanaryOpen(deps, { ...body, collateralUsd: -5 })).phase).toBe('REJECTED');
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it('F18 submit 실패/모호 응답 → ERROR·자동 재제출 0회 (executeOrder 1회만)', async () => {
    const { deps, executeOrder } = makeDeps();
    executeOrder.mockResolvedValueOnce({
      ok: false, txHash: null, orderKey: null, error: 'timeout — UNRESOLVED',
      simulated: false, executedAt: NOW.toISOString(),
    });
    const body = await preflightThenBody(deps);
    const r = await executeManualCanaryOpen(deps, body);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('ERROR');
    expect(executeOrder).toHaveBeenCalledTimes(1); // 재시도 없음
    // 예산은 이미 durable claim — 동일 날 재실행 시 daily_budget FAIL
    expect(failedIds((await runCanaryPreflight(deps, 'BTC', 'LONG')).items)).toContain('daily_budget');
  });

  it('F19 stop 미ACTIVE에서 일반 close → 거부·emergency 경로 안내', async () => {
    const { deps, closePosition, runEmergencyClose, state } = makeDeps({
      initialStopStatus: async () => ({ status: 'SUBMITTED', orderKey: null }),
    });
    state.set('manualCanaryDaily', JSON.stringify({
      dayKey: DAY, opens: 1, openIntentId: 'intent:open:manual-canary:' + DAY,
      closeIntentId: null, emergencyCloseUsed: false, openedAt: NOW.toISOString(),
    }));
    const r = await executeManualCanaryClose(deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('emergency');
    expect(closePosition).not.toHaveBeenCalled();
    // emergency 경로는 허용·1회 제한
    const e1 = await executeManualCanaryClose(deps, { confirm: CANARY_CONFIRM_CLOSE, mode: 'emergency' });
    expect(e1.ok).toBe(true);
    expect(runEmergencyClose).toHaveBeenCalledTimes(1);
    const e2 = await executeManualCanaryClose(deps, { confirm: CANARY_CONFIRM_CLOSE, mode: 'emergency' });
    expect(e2.phase).toBe('REJECTED');
    expect(runEmergencyClose).toHaveBeenCalledTimes(1);
  });

  it('F19b OPEN 미CONFIRMED에서 close → 거부', async () => {
    const { deps, state } = makeDeps({
      intentStatus: async () => ({ status: 'SUBMITTING', orderKey: null, txHash: null }),
    });
    state.set('manualCanaryDaily', JSON.stringify({
      dayKey: DAY, opens: 1, openIntentId: 'intent:open:manual-canary:' + DAY,
      closeIntentId: null, emergencyCloseUsed: false, openedAt: NOW.toISOString(),
    }));
    const r = await executeManualCanaryClose(deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('CONFIRMED');
  });

  it('F20 LIVE 잠금(simulated) → 실제 주문 0건으로 표시·성공 처리 금지', async () => {
    const { deps, executeOrder } = makeDeps({
      envSubmissionState: () => ({ locked: true, submissionEnabled: false, detail: '잠금 — 시뮬레이션만' }),
    });
    // preflight 자체가 env_submission FAIL → 실행 불가
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(failedIds(pf.items)).toContain('env_submission');
    expect(executeOrder).not.toHaveBeenCalled();
    // 만약 실행 계층이 simulated를 반환해도 ok=false·SIMULATED로 구분
    const sim = makeDeps();
    sim.executeOrder.mockResolvedValueOnce({
      ok: true, txHash: null, orderKey: null, simulated: true, executedAt: NOW.toISOString(),
    });
    const body = await preflightThenBody(sim.deps);
    const r = await executeManualCanaryOpen(sim.deps, body);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('SIMULATED');
    expect(r.reason).toContain('실제 주문 0건');
  });

  it('F21 daily claim CAS 경합 → 한쪽만 성공, 다른 쪽 fail-closed', async () => {
    const { deps } = makeDeps();
    // 첫 claim 성공
    expect((await claimDailyBudget(deps, 'intent:a')).ok).toBe(true);
    // 두 번째는 예산 소진으로 거부
    expect((await claimDailyBudget(deps, 'intent:b')).ok).toBe(false);
    // CAS 자체 경합 (다른 프로세스가 먼저 씀 → cas false)
    const contested = makeDeps({ casState: async () => false });
    const r = await claimDailyBudget(contested.deps, 'intent:c');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail-closed claim rejection');
    expect(r.reason).toContain('fail-closed');
  });

  it('상태 조회: OPEN CONFIRMED + stop ACTIVE + close CONFIRMED → 5단계 진행 표시', async () => {
    const { deps, state } = makeDeps();
    state.set('manualCanaryDaily', JSON.stringify({
      dayKey: DAY, opens: 1, openIntentId: 'intent:open:manual-canary:' + DAY,
      closeIntentId: 'intent:close:manual-canary:' + DAY + ':close',
      emergencyCloseUsed: false, openedAt: NOW.toISOString(),
    }));
    const s = await getCanaryStatus(deps);
    expect(s.stages.open.status).toBe('CONFIRMED');
    expect(s.stages.stop.status).toBe('ACTIVE');
    expect(s.stages.close.status).toBe('CONFIRMED');
    expect(s.stages.confirmed.status).toBe('CONFIRMED');
    expect(s.stages.readback.status).toBe('DONE');
  });

  it('decisionId는 결정적 — 동일 날 항상 동일 (idempotency 근간)', () => {
    expect(buildCanaryDecisionId(DAY)).toBe(`manual-canary:${DAY}`);
    expect(buildCanaryDecisionId(DAY)).toBe(buildCanaryDecisionId(DAY));
  });

  it('하드캡 상수는 동결 — 런타임 변조 불가', () => {
    expect(Object.isFrozen(MANUAL_CANARY_CAPS)).toBe(true);
    expect(MANUAL_CANARY_CAPS.maxCollateralUsd).toBe(10);
    expect(MANUAL_CANARY_CAPS.maxLeverage).toBe(2);
    expect(MANUAL_CANARY_CAPS.maxAccumLossUsd).toBe(3);
    expect(MANUAL_CANARY_CAPS.maxOrdersPerDay).toBe(1);
  });
});

// ── Architect 리뷰 후속 — durable fail-closed 보강 회귀 테스트 ────────────────
describe('durable/CAS fail-closed 보강 (리뷰 후속)', () => {
  it('preflight 저장 CAS 실패 → 유효 preflightId 미발급 (best-effort 전환 금지)', async () => {
    const { deps } = makeDeps({ casState: async () => false });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.preflightId).toBeNull();
    expect(pf.items.some(i => i.id === 'persist' && !i.ok)).toBe(true);
  });

  it('일일 상태 레코드 손상(JSON 파싱 실패) → preflight/claim/close 전부 거부', async () => {
    const { deps, state } = makeDeps();
    state.set('manualCanaryDaily', '{corrupt');
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'daily_budget')?.ok).toBe(false);
    const claim = await claimDailyBudget(deps, 'intent:x');
    expect(claim.ok).toBe(false);
    const close = await executeManualCanaryClose(deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(close.phase).toBe('REJECTED');
    expect(close.reason).toContain('손상');
  });

  it('preflight: 왕복 비용 null(산정 불가) → 통과 금지 (하위 계층 위임 금지)', async () => {
    const { deps } = makeDeps({ costSnapshot: async () => ({ ok: true, snapshot: {} as never, roundTripCostUsd: null }) });
    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'cost_snapshot')?.ok).toBe(false);
  });

  it('execute: 최종 크기 비용 > $0.40 → 명시 거부·예산 미소진·제출 0회', async () => {
    const { deps, state, executeOrder } = makeDeps();
    const body = await preflightThenBody(deps);
    // preflight 이후 최종 크기 재조회에서만 상한 초과
    let calls = 0;
    deps.costSnapshot = async () => (++calls >= 1
      ? { ok: true, snapshot: {} as never, roundTripCostUsd: 0.55 }
      : { ok: true, snapshot: {} as never, roundTripCostUsd: 0.25 });
    // 재평가 통과를 위해 재평가 시엔 통과값, 최종 조회만 초과값이 필요 —
    // evaluateAllChecks 1회 + 최종 1회 순서이므로 2번째 호출부터 초과로 설정
    calls = -1;
    const r = await executeManualCanaryOpen(deps, body);
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('왕복 비용');
    expect(executeOrder).not.toHaveBeenCalled();
    expect(state.get('manualCanaryDaily') ?? null).toBeNull(); // claim 전 거부 = 예산 미소진
  });

  it('execute 성공 시 OPEN 결속(symbol/direction/size)이 durable 저장된다', async () => {
    const { deps, state } = makeDeps();
    const body = await preflightThenBody(deps);
    const r = await executeManualCanaryOpen(deps, body);
    expect(r.phase).toBe('SUBMITTED');
    const daily = JSON.parse(state.get('manualCanaryDaily')!);
    expect(daily.open).toMatchObject({ symbol: 'BTC', direction: 'LONG' });
    expect(daily.open.requestedSizeUsd).toBeLessThanOrEqual(MANUAL_CANARY_CAPS.maxNotionalUsd);
  });

  it('close: 크기 = 온체인 실측 포지션 (고정 $20 금지); 조회 실패/불일치 = 제출 0회', async () => {
    const mkDaily = (state: Map<string, string>) => state.set('manualCanaryDaily', JSON.stringify({
      dayKey: DAY, opens: 1, openIntentId: 'intent:open:manual-canary:' + DAY,
      closeIntentId: null, emergencyCloseUsed: false, openedAt: NOW.toISOString(),
      open: { symbol: 'BTC', direction: 'LONG', collateralUsd: 10, leverage: 2, requestedSizeUsd: 20 },
    }));
    // ① 정상 — 실측 18.4 사용
    const a = makeDeps();
    mkDaily(a.state);
    const ra = await executeManualCanaryClose(a.deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(ra.phase).toBe('SUBMITTED');
    expect((a.closePosition.mock.calls[0][0] as { sizeUsd: number }).sizeUsd).toBeCloseTo(18.4, 6);
    // ② 조회 실패(null) → 거부
    const b = makeDeps({ openPositions: async () => null });
    mkDaily(b.state);
    const rb = await executeManualCanaryClose(b.deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(rb.phase).toBe('REJECTED');
    expect(b.closePosition).not.toHaveBeenCalled();
    // ③ 결속 방향 불일치(SHORT만 존재) → 거부
    const c = makeDeps({ openPositions: async () => [
      { marketAddress: '0x47c031236e19d024b42f8ae6780e44a573170703', isLong: false, sizeUsd: 18.4 },
    ] });
    mkDaily(c.state);
    const rc = await executeManualCanaryClose(c.deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(rc.phase).toBe('REJECTED');
    expect(c.closePosition).not.toHaveBeenCalled();
  });

  it('close: OPEN 결속 기록 없는 레거시 상태 → 일반 close 거부 (emergency만)', async () => {
    const { deps, state, closePosition } = makeDeps();
    state.set('manualCanaryDaily', JSON.stringify({
      dayKey: DAY, opens: 1, openIntentId: 'intent:open:manual-canary:' + DAY,
      closeIntentId: null, emergencyCloseUsed: false, openedAt: NOW.toISOString(),
    }));
    const r = await executeManualCanaryClose(deps, { confirm: CANARY_CONFIRM_CLOSE });
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('결속');
    expect(closePosition).not.toHaveBeenCalled();
  });
});
