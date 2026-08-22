import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runConfirmedOpenStopHandoff,
  type ConfirmedOpenStopHandoffDeps,
} from '../lib/confirmedOpenStopHandoff';

const MARKET = '0x' + '1'.repeat(40);
const POSITION_KEY = '0x' + '2'.repeat(64);
const ORDER_KEY = '0x' + '3'.repeat(64);
const TX = '0x' + '4'.repeat(64);
const EMITTER = '0x' + '5'.repeat(40);
const INTENT_ID = 'intent:open:manual-canary:2026-08-19';
const NOW = new Date('2026-08-19T12:00:00.000Z');

const evidence = {
  taskId: 'task-1',
  intentId: INTENT_ID,
  orderKey: ORDER_KEY,
  executionTxHash: TX,
  emitterAddress: EMITTER,
  resolutionBlock: '100',
  latestBlock: '115',
  confirmations: 15,
};

function makeDeps(): ConfirmedOpenStopHandoffDeps {
  return {
    now: () => NOW,
    finalityDepth: 15,
    expectedCollateralToken: '0x' + '6'.repeat(40),
    postureAllowed: vi.fn(() => true),
    loadIntent: vi.fn(async () => ({
      id: INTENT_ID, orderType: 'open', symbol: 'ETH', isLong: true,
    })),
    marketAddressForSymbol: vi.fn(() => MARKET),
    fetchPositions: vi.fn(async () => [{
      positionKey: POSITION_KEY, marketAddress: MARKET,
      collateralToken: '0x' + '6'.repeat(40), isLong: true, sizeUsd: 20,
    }]),
    loadStopPlan: vi.fn(async () => ({
      ok: true,
      plan: {
        status: 'PENDING', triggerPriceUsd: 2_970, acceptablePriceUsd: 2_955.15,
        marketAddress: MARKET, symbol: 'ETH', isLong: true,
      },
    })),
    decimalsReady: vi.fn(async () => true),
    executionCostReady: vi.fn(() => true),
    actionBudgetReady: vi.fn(async () => true),
    signerBindingReady: vi.fn(async () => true),
    createInitialStop: vi.fn(async () => ({
      ok: true as const, protectionId: `prot:${INTENT_ID}:INITIAL_STOP`, finalStatus: 'SUBMITTED',
    })),
    recordStopFailure: vi.fn(async (_input, reason) => ({
      ok: false as const,
      protectionId: `prot:${INTENT_ID}:INITIAL_STOP`,
      reason,
      emergencyCloseRequired: true,
    })),
    runEmergencyClose: vi.fn(async () => ({
      ok: false, protectionId: `prot:${INTENT_ID}:EMERGENCY_CLOSE`,
    })),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('finalized OPEN → INITIAL_STOP handoff', () => {
  it('final confirmation creates one Stop attempt with exact position and pre-OPEN trigger', async () => {
    const deps = makeDeps();
    const result = await runConfirmedOpenStopHandoff(evidence, deps);
    expect(result.handled).toBe(true);
    expect(deps.createInitialStop).toHaveBeenCalledTimes(1);
    expect(deps.createInitialStop).toHaveBeenCalledWith(expect.objectContaining({
      open: expect.objectContaining({
        parentOpenIntentId: INTENT_ID,
        positionKey: POSITION_KEY,
        marketAddress: MARKET,
        isLong: true,
        confirmedSizeUsd: 20,
        manualCanary: true,
      }),
      triggerPriceUsd: 2_970,
      acceptablePriceUsd: 2_955.15,
    }));
    expect(deps.runEmergencyClose).not.toHaveBeenCalled();
  });

  it('status/event finality 미충족은 position/Stop 계층에 도달하지 않는다', async () => {
    const deps = makeDeps();
    const result = await runConfirmedOpenStopHandoff(
      { ...evidence, confirmations: 14 },
      deps,
    );
    expect(result.handled).toBe(false);
    expect(deps.fetchPositions).not.toHaveBeenCalled();
    expect(deps.createInitialStop).not.toHaveBeenCalled();
    expect(deps.runEmergencyClose).not.toHaveBeenCalled();
  });

  it('exact authoritative position key가 없거나 중복이면 Stop/close 제출 계층을 호출하지 않는다', async () => {
    const deps = makeDeps();
    vi.mocked(deps.fetchPositions).mockResolvedValue([
      { marketAddress: MARKET, isLong: true, sizeUsd: 20 },
    ]);
    const result = await runConfirmedOpenStopHandoff(evidence, deps);
    expect(result.handled).toBe(false);
    expect(deps.createInitialStop).not.toHaveBeenCalled();
    expect(deps.runEmergencyClose).not.toHaveBeenCalled();
  });

  for (const [name, override] of [
    ['decimals', (d: ConfirmedOpenStopHandoffDeps) => vi.mocked(d.decimalsReady).mockResolvedValue(false)],
    ['cost', (d: ConfirmedOpenStopHandoffDeps) => vi.mocked(d.executionCostReady).mockReturnValue(false)],
    ['approval budget', (d: ConfirmedOpenStopHandoffDeps) => vi.mocked(d.actionBudgetReady).mockResolvedValue(false)],
    ['signer binding', (d: ConfirmedOpenStopHandoffDeps) => vi.mocked(d.signerBindingReady).mockResolvedValue(false)],
  ] as const) {
    it(`${name} 소실 → Stop network submit 없이 UNRESOLVED 기록 + emergency state machine 1회`, async () => {
      const deps = makeDeps();
      override(deps);
      const result = await runConfirmedOpenStopHandoff(evidence, deps);
      expect(result.handled).toBe(true);
      expect(deps.createInitialStop).not.toHaveBeenCalled();
      expect(deps.recordStopFailure).toHaveBeenCalledTimes(1);
      expect(deps.runEmergencyClose).toHaveBeenCalledTimes(1);
    });
  }

  it('Stop ambiguous/failure → existing emergency-close state machine을 정확히 1회 호출', async () => {
    const deps = makeDeps();
    vi.mocked(deps.createInitialStop).mockResolvedValue({
      ok: false,
      protectionId: `prot:${INTENT_ID}:INITIAL_STOP`,
      reason: 'submit outcome unknown',
      emergencyCloseRequired: true,
    });
    const result = await runConfirmedOpenStopHandoff(evidence, deps);
    expect(result.handled).toBe(true);
    expect(deps.createInitialStop).toHaveBeenCalledTimes(1);
    expect(deps.runEmergencyClose).toHaveBeenCalledTimes(1);
    expect(deps.recordStopFailure).not.toHaveBeenCalled();
  });

  it('Stop persistence failure + emergency persistence failure → OPEN terminal 전환 금지', async () => {
    const deps = makeDeps();
    vi.mocked(deps.createInitialStop).mockResolvedValue({
      ok: false, protectionId: null, reason: 'db down', emergencyCloseRequired: true,
    });
    vi.mocked(deps.runEmergencyClose).mockResolvedValue({ ok: false, protectionId: null });
    const result = await runConfirmedOpenStopHandoff(evidence, deps);
    expect(result.handled).toBe(false);
    expect(deps.runEmergencyClose).toHaveBeenCalledTimes(1);
  });

  it('existing SUBMITTED/ACTIVE deterministic Stop은 중복 submit 없이 처리 완료로 인정', async () => {
    const deps = makeDeps();
    vi.mocked(deps.createInitialStop).mockResolvedValue({
      ok: false,
      protectionId: `prot:${INTENT_ID}:INITIAL_STOP`,
      reason: '자동 재제출 금지',
      emergencyCloseRequired: false,
      currentStatus: 'SUBMITTED',
    });
    const result = await runConfirmedOpenStopHandoff(evidence, deps);
    expect(result.handled).toBe(true);
    expect(deps.runEmergencyClose).not.toHaveBeenCalled();
  });

  it.each(['PREPARED', 'SUBMITTING'] as const)(
    'concurrent claimant가 %s이면 emergency-close와 OPEN terminal 전환 모두 보류',
    async (status) => {
      const deps = makeDeps();
      vi.mocked(deps.createInitialStop).mockResolvedValue({
        ok: false,
        protectionId: `prot:${INTENT_ID}:INITIAL_STOP`,
        reason: 'CAS loser',
        emergencyCloseRequired: false,
        currentStatus: status,
      });
      const result = await runConfirmedOpenStopHandoff(evidence, deps);
      expect(result.handled).toBe(false);
      expect(deps.runEmergencyClose).not.toHaveBeenCalled();
    },
  );

  it('prerequisite-loss pass도 existing SUBMITTING Stop을 emergency-close로 뒤집지 않는다', async () => {
    const deps = makeDeps();
    vi.mocked(deps.decimalsReady).mockResolvedValue(false);
    vi.mocked(deps.recordStopFailure).mockResolvedValue({
      ok: false,
      protectionId: `prot:${INTENT_ID}:INITIAL_STOP`,
      reason: 'existing claimant',
      emergencyCloseRequired: false,
      currentStatus: 'SUBMITTING',
    });
    const result = await runConfirmedOpenStopHandoff(evidence, deps);
    expect(result.handled).toBe(false);
    expect(deps.runEmergencyClose).not.toHaveBeenCalled();
  });
});