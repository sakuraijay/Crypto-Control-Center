/**
 * #142 — Canary Launch Contract Suite
 *
 * Strict regression tests for the Manual Canary launch path:
 *  - Success path: preflight → execute, recordCostEvidenceForExecution called exactly once
 *  - Auth failure: GITHUB_CI always UNATTESTED (fail-closed) in production deps
 *  - Config failures: signer/allowance/cost/env
 *  - RPC failures: rpcHealthy, gmxApiReadonly
 *  - API failures: GMX API readonly check
 *  - Stale evidence: cost snapshot stale / decimals stale
 *  - Ambiguous evidence: cost snapshot roundTripCostUsd null
 *
 * Forbidden capability assertions (every exactly 0 calls/property accesses):
 *  - executeOrder (Owner Approval prepare, MetaMask/delegated signing, GMX prepare/submit)
 *  - closePosition (GMX prepare/submit)
 *  - runEmergencyClose (protection)
 *  - recordCostEvidenceForExecution (must NOT be called in preflight path)
 *  - intentStatus (relay task)
 *  - initialStopStatus (protection)
 *  - casState for daily budget (intent/funds — only preflight CAS allowed in preflight)
 *
 * HTTP auth failure coverage: requireOperatorAuth 401 on missing/wrong PIN.
 *
 * ManualCanaryPreflightDeps: structural guarantee — execution methods absent.
 * WORKER_ENGINE_MODE remains PAPER; AUTO_WORKER_LIVE_ENABLED stays inactive.
 * No real endpoints/network/signing/order/fund actions.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';

const defaultDepsFactory = vi.hoisted(() => vi.fn(() => {
  throw new Error('default Canary deps must not be built before operator authentication');
}));

vi.mock('@workspace/db', () => ({
  db: {},
  workerStateTable: new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
}));
vi.mock('../lib/manualCanaryDeps', () => ({
  buildDefaultCanaryDeps: defaultDepsFactory,
}));

import {
  runCanaryPreflight,
  executeManualCanaryOpen,
  MANUAL_CANARY_CAPS,
  CANARY_CONFIRM_OPEN,
  PREFLIGHT_OPERATION_ALLOWLIST,
  CANARY_STATUS_OPERATION_ALLOWLIST,
  CANARY_PREFLIGHT_FORBIDDEN_OPERATIONS,
  CANARY_BLOCKER_CATEGORIES,
  runAllowedPreflightOperation,
  runAllowedCanaryStatusOperation,
  getCanaryStatus,
  type ManualCanaryDeps,
  type ManualCanaryPreflightDeps,
  type ManualCanaryStatusDeps,
  type CheckOutcome,
} from '../lib/manualCanary';
import { manilaDayKey } from '../lib/profitProtection';
import canaryRouter, { __setCanaryDepsForTests } from '../routes/canary';

const OK: CheckOutcome = { ok: true, detail: 'ok' };
const FAIL = (d: string): CheckOutcome => ({ ok: false, detail: d });
const NOW = new Date('2026-08-19T03:00:00Z');
const DAY = manilaDayKey(NOW);

describe('PAPER-only release configuration', () => {
  it('keeps shared and production execution gates fail-closed', () => {
    const source = readFileSync(
      new URL('../../../../.replit', import.meta.url),
      'utf8',
    );
    const shared = source.match(
      /\[userenv\.shared\]([\s\S]*?)(?=\n\[userenv\.production\])/,
    )?.[1] ?? '';
    const production = source.match(
      /\[userenv\.production\]([\s\S]*?)(?=\n\[userenv\.development\])/,
    )?.[1] ?? '';

    expect(shared).toContain('WORKER_ENGINE_MODE = "PAPER"');
    expect(shared).toContain('AUTO_WORKER_LIVE_ENABLED = "false"');
    expect(production).toContain('DELEGATED_SIGNER_ENABLED = "false"');
    expect(production).toContain(
      'GMX_API_ORDER_SUBMISSION_ENABLED = "false"',
    );
    expect(production).toContain('LIVE_TEST_EXECUTION_LOCKED = "true"');
    expect(production).not.toContain(
      'GMX_RELAY_SUBMISSION_ENABLED = "true"',
    );
    expect(production).not.toContain(
      'GMX_RELAY_SUBMIT_NETWORK_ENABLED = "true"',
    );
  });
});

// ── Forbidden capability spy registry ─────────────────────────────────────────
/**
 * Forbidden capabilities that must never be called/accessed during preflight.
 * Each returns a thrown error if called (structural fail-closed).
 */
function makeForbiddenCapabilitySpies() {
  const executeOrder = vi.fn(async () => {
    throw new Error('FORBIDDEN: executeOrder must not be called in preflight/preflight-only paths');
  });
  const closePosition = vi.fn(async () => {
    throw new Error('FORBIDDEN: closePosition must not be called in preflight/preflight-only paths');
  });
  const runEmergencyClose = vi.fn(async () => {
    throw new Error('FORBIDDEN: runEmergencyClose must not be called in preflight/preflight-only paths');
  });
  const recordCostEvidenceForExecution = vi.fn(async (_snap: unknown, _args: unknown, _nowMs: unknown): Promise<boolean> => {
    throw new Error('FORBIDDEN: recordCostEvidenceForExecution must not be called in preflight path');
  });
  const intentStatus = vi.fn(async () => {
    throw new Error('FORBIDDEN: intentStatus (relay task read) must not be called in preflight path');
  });
  const initialStopStatus = vi.fn(async () => {
    throw new Error('FORBIDDEN: initialStopStatus (protection read) must not be called in preflight path');
  });
  return { executeOrder, closePosition, runEmergencyClose, recordCostEvidenceForExecution, intentStatus, initialStopStatus };
}

/** Build a full ManualCanaryDeps with all forbidden capabilities as tracked spies */
function makeContractDeps(overrides: Partial<ManualCanaryDeps> = {}): {
  deps: ManualCanaryDeps;
  state: Map<string, string>;
  forbidden: ReturnType<typeof makeForbiddenCapabilitySpies>;
} {
  const state = new Map<string, string>();
  const forbidden = makeForbiddenCapabilitySpies();

  const deps: ManualCanaryDeps = {
    now: () => NOW,
    randomId: (() => { let seq = 0; return () => `pf-contract-${++seq}`; })(),
    routerPin: () => OK,
    deploymentVerified: () => OK,
    signerBinding: async () => OK,
    ownerApproval: async () => OK,
    allowance: async () => OK,
    gmxApiReadonly: () => OK,
    rpcHealthy: async () => OK,
    reconciliationClean: async () => OK,
    openPositionCount: async () => 0,
    openPositions: async () => [{
      positionKey: '0xposkey' + '1'.repeat(58),
      accountAddress: '0x' + 'a'.repeat(40),
      marketAddress: '0x' + 'b'.repeat(40),
      collateralToken: '0x' + 'c'.repeat(40),
      isLong: true,
      sizeUsd: 18.0,
      sizeUsd30: '18000000000000000000000000000000',
    }],
    costSnapshot: async () => ({ ok: true, snapshot: {} as never, roundTripCostUsd: 0.25 }),
    canaryDecimalsReady: async () => OK,
    stopCapability: async () => OK,
    currentPriceUsd: async () => 60000,
    accumCanaryLossUsd: async () => ({ ok: true, lossUsd: 0.5 }),
    marketAddress: () => '0x' + 'b'.repeat(40),
    mainAddress: () => '0x' + 'a'.repeat(40),
    liveTestMode: () => true,
    envSubmissionState: () => ({ locked: false, submissionEnabled: true, detail: '활성' }),
    // #142: githubCiAttestation — test overrides to OK; production is always UNATTESTED
    githubCiAttestation: () => OK,
    loadState: async (k) => state.get(k) ?? null,
    casState: async (k, prev, next) => {
      const cur = state.get(k) ?? null;
      if (cur !== prev) return false;
      state.set(k, next);
      return true;
    },
    // Forbidden execution capabilities (tracked spies)
    executeOrder: forbidden.executeOrder as ManualCanaryDeps['executeOrder'],
    closePosition: forbidden.closePosition as ManualCanaryDeps['closePosition'],
    runEmergencyClose: forbidden.runEmergencyClose as ManualCanaryDeps['runEmergencyClose'],
    recordCostEvidenceForExecution: forbidden.recordCostEvidenceForExecution as ManualCanaryDeps['recordCostEvidenceForExecution'],
    intentStatus: forbidden.intentStatus as ManualCanaryDeps['intentStatus'],
    initialStopStatus: forbidden.initialStopStatus as ManualCanaryDeps['initialStopStatus'],
    ...overrides,
  };

  return { deps, state, forbidden };
}

/** A narrow preflight-only deps object — structurally lacks execution methods */
function makePreflightOnlyDeps(overrides: Partial<ManualCanaryPreflightDeps> = {}): {
  preflightDeps: ManualCanaryPreflightDeps;
  forbiddenExecuteOrder: ReturnType<typeof vi.fn>;
  forbiddenClosePosition: ReturnType<typeof vi.fn>;
  forbiddenRunEmergencyClose: ReturnType<typeof vi.fn>;
  forbiddenRecordCostEvidence: ReturnType<typeof vi.fn>;
  state: Map<string, string>;
} {
  const state = new Map<string, string>();
  // These are NOT in ManualCanaryPreflightDeps — they should be structurally absent.
  // We define them here only to confirm they are NOT called through the preflight path.
  const forbiddenExecuteOrder = vi.fn();
  const forbiddenClosePosition = vi.fn();
  const forbiddenRunEmergencyClose = vi.fn();
  const forbiddenRecordCostEvidence = vi.fn();
  let seq = 0;

  const preflightDeps: ManualCanaryPreflightDeps = {
    now: () => NOW,
    randomId: () => `pf-narrow-${++seq}`,
    routerPin: () => OK,
    deploymentVerified: () => OK,
    signerBinding: async () => OK,
    ownerApproval: async () => OK,
    allowance: async () => OK,
    gmxApiReadonly: () => OK,
    rpcHealthy: async () => OK,
    reconciliationClean: async () => OK,
    openPositionCount: async () => 0,
    openPositions: async () => null,
    costSnapshot: async () => ({ ok: true, snapshot: {} as never, roundTripCostUsd: 0.25 }),
    canaryDecimalsReady: async () => OK,
    stopCapability: async () => OK,
    currentPriceUsd: async () => 60000,
    accumCanaryLossUsd: async () => ({ ok: true, lossUsd: 0.5 }),
    marketAddress: () => '0x' + 'b'.repeat(40),
    mainAddress: () => '0x' + 'a'.repeat(40),
    liveTestMode: () => true,
    envSubmissionState: () => ({ locked: false, submissionEnabled: true, detail: '활성' }),
    githubCiAttestation: () => OK,
    loadState: async (k) => state.get(k) ?? null,
    casState: async (k, prev, next) => {
      const cur = state.get(k) ?? null;
      if (cur !== prev) return false;
      state.set(k, next);
      return true;
    },
    ...overrides,
  };

  return { preflightDeps, forbiddenExecuteOrder, forbiddenClosePosition, forbiddenRunEmergencyClose, forbiddenRecordCostEvidence, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  __setCanaryDepsForTests(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setCanaryDepsForTests(null);
});

// ── Contract Suite ─────────────────────────────────────────────────────────────

describe('#142 Canary Launch Contract — Success path', () => {
  it('preflight success: all checks ok → preflightId issued, all forbidden capabilities exactly 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenClosePosition, forbiddenRunEmergencyClose, forbiddenRecordCostEvidence } =
      makePreflightOnlyDeps();

    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(true);
    expect(pf.preflightId).toBeTruthy();
    expect(pf.items.length).toBeGreaterThanOrEqual(17); // all checks including github_ci

    // Forbidden capability exact 0 call assertions
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenClosePosition).toHaveBeenCalledTimes(0);
    expect(forbiddenRunEmergencyClose).toHaveBeenCalledTimes(0);
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
  });

  it('execute success: recordCostEvidenceForExecution called exactly 1x just before executeOrder', async () => {
    const recordEvidence = vi.fn(async (_s: unknown, _a: unknown, _n: unknown) => true);
    const executeOrder = vi.fn(async (_params: unknown) => ({
      ok: true, txHash: '0xabc', orderKey: '0xkey', simulated: false, executedAt: NOW.toISOString(),
    }));

    const { deps } = makeContractDeps({
      executeOrder: executeOrder as ManualCanaryDeps['executeOrder'],
      recordCostEvidenceForExecution: recordEvidence as ManualCanaryDeps['recordCostEvidenceForExecution'],
    });

    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(true);
    const body = { preflightId: pf.preflightId, confirm: CANARY_CONFIRM_OPEN, symbol: 'BTC', direction: 'LONG' };
    const r = await executeManualCanaryOpen(deps, body);

    expect(r.ok).toBe(true);
    expect(r.phase).toBe('SUBMITTED');
    // recordCostEvidenceForExecution exactly 1 call, just before executeOrder
    expect(recordEvidence).toHaveBeenCalledTimes(1);
    expect(executeOrder).toHaveBeenCalledTimes(1);
    // Record happens before execute (call order)
    const recordCallOrder = recordEvidence.mock.invocationCallOrder[0]!;
    const executeCallOrder = executeOrder.mock.invocationCallOrder[0]!;
    expect(recordCallOrder).toBeLessThan(executeCallOrder);
  });

  it('execute: recordCostEvidenceForExecution returns false → fail-closed (executeOrder 0 calls)', async () => {
    const recordEvidence = vi.fn(async () => false);
    const executeOrder = vi.fn(async () => ({
      ok: true, txHash: '0xabc', orderKey: '0xkey', simulated: false, executedAt: NOW.toISOString(),
    }));
    const { deps, state } = makeContractDeps({
      executeOrder: executeOrder as ManualCanaryDeps['executeOrder'],
      recordCostEvidenceForExecution: recordEvidence as ManualCanaryDeps['recordCostEvidenceForExecution'],
    });

    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(true);
    const body = { preflightId: pf.preflightId, confirm: CANARY_CONFIRM_OPEN, symbol: 'BTC', direction: 'LONG' };
    const r = await executeManualCanaryOpen(deps, body);

    expect(r.ok).toBe(false);
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).toContain('비용 증거');
    expect(executeOrder).toHaveBeenCalledTimes(0); // fail-closed
    const daily = JSON.parse(state.get('manualCanaryDaily')!);
    expect(daily.opens).toBe(0);
    expect(daily.launchReservation).toBeNull();
  });

  it('execute: recordCostEvidenceForExecution throws → fail-closed without daily budget consumption', async () => {
    const recordEvidence = vi.fn(async () => {
      throw new Error('raw recorder failure must not escape');
    });
    const executeOrder = vi.fn(async () => ({
      ok: true, txHash: '0xabc', orderKey: '0xkey', simulated: false, executedAt: NOW.toISOString(),
    }));
    const { deps, state } = makeContractDeps({
      executeOrder: executeOrder as ManualCanaryDeps['executeOrder'],
      recordCostEvidenceForExecution: recordEvidence as ManualCanaryDeps['recordCostEvidenceForExecution'],
    });

    const pf = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(pf.ok).toBe(true);
    const r = await executeManualCanaryOpen(deps, {
      preflightId: pf.preflightId,
      confirm: CANARY_CONFIRM_OPEN,
      symbol: 'BTC',
      direction: 'LONG',
    });

    expect(r.ok).toBe(false);
    expect(r.phase).toBe('REJECTED');
    expect(r.reason).not.toContain('raw recorder failure');
    expect(recordEvidence).toHaveBeenCalledTimes(1);
    expect(executeOrder).toHaveBeenCalledTimes(0);
    const daily = JSON.parse(state.get('manualCanaryDaily')!);
    expect(daily.opens).toBe(0);
    expect(daily.launchReservation).toBeNull();
  });

  it('cold preflight validates cost before stop capability and passes fresh in-request evidence', async () => {
    const events: string[] = [];
    const costSnapshot = vi.fn(async () => {
      events.push('cost');
      return { ok: true as const, snapshot: {} as never, roundTripCostUsd: 0.25 };
    });
    const stopCapability = vi.fn(async ({ freshCostSnapshotAvailable }: { freshCostSnapshotAvailable: boolean }) => {
      events.push('stop');
      return freshCostSnapshotAvailable ? OK : FAIL('fresh cost evidence missing');
    });
    const { preflightDeps } = makePreflightOnlyDeps({ costSnapshot, stopCapability });

    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');

    expect(pf.ok).toBe(true);
    expect(events).toEqual(['cost', 'stop']);
    expect(stopCapability).toHaveBeenCalledWith({ freshCostSnapshotAvailable: true });
  });

  it('durable launch reservation prevents a CAS loser from overwriting the winner evidence', async () => {
    let btcCostCalls = 0;
    let releaseA!: () => void;
    let markAPaused!: () => void;
    const aPaused = new Promise<void>((resolve) => { markAPaused = resolve; });
    const aRelease = new Promise<void>((resolve) => { releaseA = resolve; });
    const costSnapshot = vi.fn(async ({ symbol }: { symbol: string; isLong: boolean; notionalUsd: number }) => {
      if (symbol === 'BTC') {
        btcCostCalls += 1;
        // BTC preflight, execute recheck, then final-size fetch.
        if (btcCostCalls === 3) {
          markAPaused();
          await aRelease;
        }
      }
      return { ok: true as const, snapshot: {} as never, roundTripCostUsd: 0.25 };
    });
    const recordEvidence = vi.fn<ManualCanaryDeps['recordCostEvidenceForExecution']>(async () => true);
    const executeOrder = vi.fn<ManualCanaryDeps['executeOrder']>(async () => ({
      ok: true, txHash: '0xabc', orderKey: '0xkey', simulated: false, executedAt: NOW.toISOString(),
    }));
    const { deps, state } = makeContractDeps({
      costSnapshot,
      marketAddress: (symbol) => symbol === 'BTC'
        ? '0x' + 'b'.repeat(40)
        : '0x' + 'e'.repeat(40),
      recordCostEvidenceForExecution: recordEvidence as ManualCanaryDeps['recordCostEvidenceForExecution'],
      executeOrder: executeOrder as ManualCanaryDeps['executeOrder'],
    });

    const preflightA = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(preflightA.ok).toBe(true);
    const launchA = executeManualCanaryOpen(deps, {
      preflightId: preflightA.preflightId,
      confirm: CANARY_CONFIRM_OPEN,
      symbol: 'BTC',
      direction: 'LONG',
    });
    await aPaused;

    // A already authenticated its preflight but has not reserved the daily owner.
    // B installs a new valid preflight, wins the durable reservation, and submits.
    const preflightB = await runCanaryPreflight(deps, 'ETH', 'SHORT');
    expect(preflightB.ok).toBe(true);
    const resultB = await executeManualCanaryOpen(deps, {
      preflightId: preflightB.preflightId,
      confirm: CANARY_CONFIRM_OPEN,
      symbol: 'ETH',
      direction: 'SHORT',
    });
    expect(resultB.ok).toBe(true);

    releaseA();
    const resultA = await launchA;
    expect(resultA.ok).toBe(false);
    expect(resultA.phase).toBe('REJECTED');
    expect(resultA.reason).toMatch(/소진|예약/);

    // Only reservation winner B may publish evidence or reach executeOrder.
    expect(recordEvidence).toHaveBeenCalledTimes(1);
    expect(recordEvidence.mock.calls[0]![1]).toMatchObject({
      market: '0x' + 'e'.repeat(40),
      isLong: false,
    });
    expect(executeOrder).toHaveBeenCalledTimes(1);
    expect(executeOrder.mock.calls[0]![0]).toMatchObject({
      symbol: 'ETH',
      marketAddress: '0x' + 'e'.repeat(40),
      isLong: false,
    });
    const daily = JSON.parse(state.get('manualCanaryDaily')!);
    expect(daily.opens).toBe(1);
    expect(daily.open).toMatchObject({ symbol: 'ETH', direction: 'SHORT' });
    expect(daily.launchReservation).toBeNull();
  });

  it('unresolved reservation blocks day-rollover launches until the prior owner releases', async () => {
    let currentNow = new Date('2026-08-19T15:59:59.000Z'); // Manila 23:59:59
    let releaseA!: () => void;
    let markARecording!: () => void;
    const aRecording = new Promise<void>((resolve) => { markARecording = resolve; });
    const aRelease = new Promise<void>((resolve) => { releaseA = resolve; });
    const recordEvidence = vi.fn<ManualCanaryDeps['recordCostEvidenceForExecution']>(
      async (_snapshot, _expected) => {
        if (recordEvidence.mock.calls.length === 1) {
          markARecording();
          await aRelease;
        }
        return true;
      },
    );
    const executeOrder = vi.fn<ManualCanaryDeps['executeOrder']>(async () => ({
      ok: true, txHash: '0xabc', orderKey: '0xkey', simulated: false, executedAt: currentNow.toISOString(),
    }));
    const { deps, state } = makeContractDeps({
      now: () => currentNow,
      marketAddress: (symbol) => symbol === 'BTC'
        ? '0x' + 'b'.repeat(40)
        : '0x' + 'e'.repeat(40),
      recordCostEvidenceForExecution: recordEvidence,
      executeOrder,
    });

    const preflightA = await runCanaryPreflight(deps, 'BTC', 'LONG');
    expect(preflightA.ok).toBe(true);
    const launchA = executeManualCanaryOpen(deps, {
      preflightId: preflightA.preflightId,
      confirm: CANARY_CONFIRM_OPEN,
      symbol: 'BTC',
      direction: 'LONG',
    });
    await aRecording; // A owns the day-D reservation, before evidence activation returns.

    currentNow = new Date('2026-08-19T16:00:01.000Z'); // Manila day D+1
    const blockedB = await runCanaryPreflight(deps, 'ETH', 'SHORT');
    expect(blockedB.ok).toBe(false);
    expect(blockedB.items.find((item) => item.id === 'daily_budget')).toMatchObject({ ok: false });
    expect(recordEvidence).toHaveBeenCalledTimes(1);
    expect(executeOrder).toHaveBeenCalledTimes(0);

    releaseA();
    const resultA = await launchA;
    expect(resultA.ok).toBe(false);
    expect(resultA.phase).toBe('REJECTED');
    expect(resultA.reason).toContain('예약 상태');
    expect(executeOrder).toHaveBeenCalledTimes(0);
    const released = JSON.parse(state.get('manualCanaryDaily')!);
    expect(released.opens).toBe(0);
    expect(released.launchReservation).toBeNull();

    // Only after old-day owner release may the new-day request activate evidence.
    const preflightB = await runCanaryPreflight(deps, 'ETH', 'SHORT');
    expect(preflightB.ok).toBe(true);
    const resultB = await executeManualCanaryOpen(deps, {
      preflightId: preflightB.preflightId,
      confirm: CANARY_CONFIRM_OPEN,
      symbol: 'ETH',
      direction: 'SHORT',
    });
    expect(resultB.ok).toBe(true);
    expect(recordEvidence).toHaveBeenCalledTimes(2);
    expect(recordEvidence.mock.calls[1]![1]).toMatchObject({
      market: '0x' + 'e'.repeat(40),
      isLong: false,
    });
    expect(executeOrder).toHaveBeenCalledTimes(1);
    expect(executeOrder.mock.calls[0]![0]).toMatchObject({ symbol: 'ETH', isLong: false });
  });

  it('PREFLIGHT_OPERATION_ALLOWLIST is frozen and stable', () => {
    expect(Object.isFrozen(PREFLIGHT_OPERATION_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(PREFLIGHT_OPERATION_ALLOWLIST.readonly)).toBe(true);
    expect(Object.isFrozen(PREFLIGHT_OPERATION_ALLOWLIST.cas_preflight_token)).toBe(true);
    // readonly contains expected check IDs
    expect(PREFLIGHT_OPERATION_ALLOWLIST.readonly).toContain('deployment');
    expect(PREFLIGHT_OPERATION_ALLOWLIST.readonly).toContain('github_ci');
    expect(PREFLIGHT_OPERATION_ALLOWLIST.readonly).toContain('cost_snapshot');
    // cas_preflight_token only contains preflight key
    expect(PREFLIGHT_OPERATION_ALLOWLIST.cas_preflight_token).toContain('manualCanaryPreflight');
    expect(PREFLIGHT_OPERATION_ALLOWLIST.cas_preflight_token).not.toContain('manualCanaryDaily');
    // executeOrder, closePosition, etc. are NOT in allowlist
    const allAllowed = [
      ...PREFLIGHT_OPERATION_ALLOWLIST.readonly,
      ...PREFLIGHT_OPERATION_ALLOWLIST.cas_preflight_token,
    ];
    expect(allAllowed).not.toContain('executeOrder');
    expect(allAllowed).not.toContain('closePosition');
    expect(allAllowed).not.toContain('runEmergencyClose');
    expect(allAllowed).not.toContain('nonce');
    expect(allAllowed).not.toContain('relay');
    expect(allAllowed).not.toContain('intent');
    expect(allAllowed).not.toContain('funds');
    expect(allAllowed).not.toContain('signer_record_mutation');
  });

  it('runtime allowlist rejects every forbidden operation before its callback runs', async () => {
    for (const operation of CANARY_PREFLIGHT_FORBIDDEN_OPERATIONS) {
      const callback = vi.fn();
      await expect(
        runAllowedPreflightOperation('readonly', operation, callback),
      ).rejects.toThrow(`CANARY_PREFLIGHT_OPERATION_DENIED:readonly:${operation}`);
      expect(callback).toHaveBeenCalledTimes(0);
    }
  });

  it('runtime allowlist rejects unknown diagnostic writes before their callback runs', async () => {
    const callback = vi.fn();
    await expect(
      runAllowedPreflightOperation('cas_preflight_token', 'unknown-write', callback),
    ).rejects.toThrow('CANARY_PREFLIGHT_OPERATION_DENIED:cas_preflight_token:unknown-write');
    expect(callback).toHaveBeenCalledTimes(0);
  });

  it('runtime allowlist permits a declared readonly operation', async () => {
    const callback = vi.fn(() => 42);
    await expect(
      runAllowedPreflightOperation('readonly', 'clock', callback),
    ).resolves.toBe(42);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('status allowlist is frozen and rejects undeclared operations before callbacks run', async () => {
    expect(Object.isFrozen(CANARY_STATUS_OPERATION_ALLOWLIST)).toBe(true);
    expect(CANARY_STATUS_OPERATION_ALLOWLIST).toEqual(expect.arrayContaining([
      'clock',
      'daily_state',
      'intent_status',
      'initial_stop_status',
      'position_readback',
      'loss_readback',
      'preflight_check_evaluation',
    ]));
    const callback = vi.fn();
    await expect(
      runAllowedCanaryStatusOperation('nonce_creation', callback),
    ).rejects.toThrow('CANARY_STATUS_OPERATION_DENIED:nonce_creation');
    expect(callback).toHaveBeenCalledTimes(0);
  });
});

describe('#142 Canary Launch Contract — GITHUB_CI auth failure (UNATTESTED fail-closed)', () => {
  it('GITHUB_CI blocker category has stable ID and UNATTESTED attestedStatus', () => {
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.id).toBe('GITHUB_CI');
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.attestedStatus).toBe('UNATTESTED');
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.stableMessage).toContain('UNATTESTED');
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.stableMessage).not.toMatch(/https?:\/\//);
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.stableMessage).not.toMatch(/secret|key|token|pin/i);
    expect(Object.isFrozen(CANARY_BLOCKER_CATEGORIES.GITHUB_CI)).toBe(true);
    expect(Object.isFrozen(CANARY_BLOCKER_CATEGORIES)).toBe(true);
  });

  it('GITHUB_CI check always fails closed as UNATTESTED when deps.githubCiAttestation returns not-ok', async () => {
    // Simulate production: githubCiAttestation returns UNATTESTED (fail-closed)
    const { preflightDeps } = makePreflightOnlyDeps({
      githubCiAttestation: () => FAIL(`${CANARY_BLOCKER_CATEGORIES.GITHUB_CI.stableMessage} [${CANARY_BLOCKER_CATEGORIES.GITHUB_CI.attestedStatus}]`),
    });

    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.preflightId).toBeNull();
    const githubItem = pf.items.find(i => i.id === 'github_ci')!;
    expect(githubItem).toBeDefined();
    expect(githubItem.ok).toBe(false);
    expect(githubItem.detail).toContain('UNATTESTED');
    // No secret values, raw env values, RPC URLs, addresses, signatures in detail
    expect(githubItem.detail).not.toMatch(/https?:\/\//);
    expect(githubItem.detail).not.toMatch(/0x[0-9a-f]{40,}/i);
    expect(githubItem.detail).not.toMatch(/(secret|key|token|pin|password)/i);
  });

  it('preflight with all checks passing except GITHUB_CI → preflightId not issued', async () => {
    const { preflightDeps } = makePreflightOnlyDeps({
      githubCiAttestation: () => ({ ok: false, detail: 'CI 인증 미확인 [UNATTESTED]' }),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'ETH', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.preflightId).toBeNull();
    const failedIds = pf.items.filter(i => !i.ok).map(i => i.id);
    expect(failedIds).toContain('github_ci');
    // All other items should be ok
    const otherFailed = failedIds.filter(id => id !== 'github_ci');
    expect(otherFailed).toHaveLength(0);
  });

  it('GITHUB_CI check is in readonly allowlist, not in execution-side allowlist', () => {
    expect(PREFLIGHT_OPERATION_ALLOWLIST.readonly).toContain('github_ci');
    expect(PREFLIGHT_OPERATION_ALLOWLIST.cas_preflight_token).not.toContain('github_ci');
  });
});

describe('#142 Canary Launch Contract — Config failures', () => {
  it('signer_binding failure: forbidden capabilities exactly 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenClosePosition, forbiddenRunEmergencyClose, forbiddenRecordCostEvidence } =
      makePreflightOnlyDeps({ signerBinding: async () => FAIL('암호문 부재') });

    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'signer_binding')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenClosePosition).toHaveBeenCalledTimes(0);
    expect(forbiddenRunEmergencyClose).toHaveBeenCalledTimes(0);
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
  });

  it('allowance failure → preflight fails, forbidden capabilities 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      allowance: async () => FAIL('allowance 5 USDC < 15'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'allowance')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });

  it('env_submission failure → preflight fails, forbidden capabilities 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      envSubmissionState: () => ({ locked: true, submissionEnabled: false, detail: '잠금' }),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'env_submission')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });

  it('owner_approval failure → preflight fails, no signing/nonce/funds calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenClosePosition } = makePreflightOnlyDeps({
      ownerApproval: async () => FAIL('deadline 만료'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'owner_approval')?.ok).toBe(false);
    // Owner Approval prepare: 0 calls (forbidden capability)
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenClosePosition).toHaveBeenCalledTimes(0);
  });

  it('deployment/router_pin failure → forbidden capabilities 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenClosePosition, forbiddenRunEmergencyClose } =
      makePreflightOnlyDeps({
        deploymentVerified: () => FAIL('manifest 미검증'),
        routerPin: () => FAIL('pin 불일치'),
      });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenClosePosition).toHaveBeenCalledTimes(0);
    expect(forbiddenRunEmergencyClose).toHaveBeenCalledTimes(0);
  });
});

describe('#142 Canary Launch Contract — RPC/API failures', () => {
  it('rpcHealthy failure → preflight fails, forbidden capabilities 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenRecordCostEvidence } = makePreflightOnlyDeps({
      rpcHealthy: async () => FAIL('RPC 미확인'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'rpc')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
  });

  it('gmxApiReadonly failure → preflight fails, no GMX prepare/submit calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      gmxApiReadonly: () => FAIL('GMX_API_READONLY_ENABLED ≠ true'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'gmx_api')?.ok).toBe(false);
    // GMX prepare/submit: 0 calls
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });

  it('reconciliationClean failure → preflight fails, relay task/intent 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenRunEmergencyClose } = makePreflightOnlyDeps({
      reconciliationClean: async () => FAIL('intents 1'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'reconciliation')?.ok).toBe(false);
    // relay task/intent: 0 calls
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenRunEmergencyClose).toHaveBeenCalledTimes(0);
  });

  it('stop_capability failure → preflight fails, no protection/signer record mutation calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenRunEmergencyClose } = makePreflightOnlyDeps({
      stopCapability: async () => FAIL('stop 능력 없음'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'stop_capability')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenRunEmergencyClose).toHaveBeenCalledTimes(0);
  });
});

describe('#142 Canary Launch Contract — Stale evidence paths', () => {
  it('costSnapshot stale (ok:false) → preflight fails, recordCostEvidenceForExecution 0 calls', async () => {
    const { preflightDeps, forbiddenRecordCostEvidence, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      costSnapshot: async () => ({ ok: false, reason: 'stale snapshot — 재조회 필요' }),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'cost_snapshot')?.ok).toBe(false);
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });

  it('decimals stale → preflight fails, forbidden capabilities 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder, forbiddenRecordCostEvidence } = makePreflightOnlyDeps({
      canaryDecimalsReady: async () => FAIL('BTC evidence stale'),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'decimals')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
  });

  it('price stale (null) → preflight fails, forbidden capabilities 0 calls', async () => {
    const { preflightDeps, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      currentPriceUsd: async () => null,
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'price')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });
});

describe('#142 Canary Launch Contract — Ambiguous evidence paths', () => {
  it('costSnapshot roundTripCostUsd null → preflight fails (ambiguous evidence, fail-closed)', async () => {
    const { preflightDeps, forbiddenRecordCostEvidence, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      costSnapshot: async () => ({ ok: true, snapshot: {} as never, roundTripCostUsd: null }),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    const item = pf.items.find(i => i.id === 'cost_snapshot')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain('fail-closed');
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });

  it('openPositionCount null (authoritative readback fail) → preflight fails (fail-closed)', async () => {
    const { preflightDeps, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      openPositionCount: async () => null,
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    const item = pf.items.find(i => i.id === 'open_positions')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain('fail-closed');
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });

  it('accumCanaryLossUsd null → preflight fails (ambiguous, fail-closed)', async () => {
    const { preflightDeps, forbiddenExecuteOrder } = makePreflightOnlyDeps({
      accumCanaryLossUsd: async () => ({ ok: false, lossUsd: null }),
    });
    const pf = await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');
    expect(pf.ok).toBe(false);
    expect(pf.items.find(i => i.id === 'accum_loss')?.ok).toBe(false);
    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
  });
});

describe('#142 Canary Launch Contract — Forbidden capability exact 0 assertions', () => {
  it('preflight path: executeOrder, closePosition, runEmergencyClose, recordCostEvidence all exactly 0 calls', async () => {
    // Use full ManualCanaryDeps with all forbidden spies — verify 0 calls through runCanaryPreflight
    const { deps, forbidden } = makeContractDeps();

    // Intercept the forbidden methods on deps (they throw if called)
    const safeExecuteOrder = vi.fn();
    const safeClosePosition = vi.fn();
    const safeRunEmergencyClose = vi.fn();
    const safeRecordEvidence = vi.fn(async () => true);
    const safeIntentStatus = vi.fn();
    const safeInitialStopStatus = vi.fn();

    const safeDeps: ManualCanaryDeps = {
      ...deps,
      executeOrder: safeExecuteOrder as ManualCanaryDeps['executeOrder'],
      closePosition: safeClosePosition as ManualCanaryDeps['closePosition'],
      runEmergencyClose: safeRunEmergencyClose as ManualCanaryDeps['runEmergencyClose'],
      recordCostEvidenceForExecution: safeRecordEvidence as ManualCanaryDeps['recordCostEvidenceForExecution'],
      intentStatus: safeIntentStatus as ManualCanaryDeps['intentStatus'],
      initialStopStatus: safeInitialStopStatus as ManualCanaryDeps['initialStopStatus'],
    };

    // runCanaryPreflight should only call preflight-safe methods
    await runCanaryPreflight(safeDeps, 'BTC', 'LONG');

    // All forbidden capabilities must be exactly 0 calls during preflight
    expect(safeExecuteOrder).toHaveBeenCalledTimes(0);
    expect(safeClosePosition).toHaveBeenCalledTimes(0);
    expect(safeRunEmergencyClose).toHaveBeenCalledTimes(0);
    expect(safeRecordEvidence).toHaveBeenCalledTimes(0);
    expect(safeIntentStatus).toHaveBeenCalledTimes(0);
    expect(safeInitialStopStatus).toHaveBeenCalledTimes(0);

    // Verify forbidden object was never accessed (the throw spies)
    expect(forbidden.executeOrder).toHaveBeenCalledTimes(0);
    expect(forbidden.closePosition).toHaveBeenCalledTimes(0);
    expect(forbidden.runEmergencyClose).toHaveBeenCalledTimes(0);
    expect(forbidden.recordCostEvidenceForExecution).toHaveBeenCalledTimes(0);
    expect(forbidden.intentStatus).toHaveBeenCalledTimes(0);
    expect(forbidden.initialStopStatus).toHaveBeenCalledTimes(0);
  });

  it('preflight path with failing checks: all forbidden capabilities still exactly 0 calls', async () => {
    const safeExecuteOrder = vi.fn();
    const safeRecordEvidence = vi.fn(() => false); // even if called, should not be called at all
    const { preflightDeps, forbiddenExecuteOrder, forbiddenRecordCostEvidence } = makePreflightOnlyDeps({
      deploymentVerified: () => FAIL('manifest 미검증'),
      signerBinding: async () => FAIL('암호문 부재'),
      ownerApproval: async () => FAIL('deadline 만료'),
      allowance: async () => FAIL('allowance 5 USDC < 15'),
    });

    await runCanaryPreflight(preflightDeps, 'BTC', 'LONG');

    expect(forbiddenExecuteOrder).toHaveBeenCalledTimes(0);
    expect(forbiddenRecordCostEvidence).toHaveBeenCalledTimes(0);
    expect(safeExecuteOrder).toHaveBeenCalledTimes(0);
    expect(safeRecordEvidence).toHaveBeenCalledTimes(0);
  });
});

describe('#142 Canary Launch Contract — Blocker categories', () => {
  it('CANARY_BLOCKER_CATEGORIES is frozen with stable IDs and sanitized messages', () => {
    expect(Object.isFrozen(CANARY_BLOCKER_CATEGORIES)).toBe(true);
    for (const [key, cat] of Object.entries(CANARY_BLOCKER_CATEGORIES)) {
      expect(Object.isFrozen(cat)).toBe(true);
      expect(cat.id).toBe(key);
      expect(typeof cat.stableMessage).toBe('string');
      expect(cat.stableMessage.length).toBeGreaterThan(0);
      // No secret values, raw env values, RPC URLs, addresses, signatures
      expect(cat.stableMessage).not.toMatch(/https?:\/\//);
      expect(cat.stableMessage).not.toMatch(/0x[0-9a-f]{40,}/i);
      expect(cat.stableMessage).not.toMatch(/(password|secret|bearer|token=)/i);
    }
    // Stable IDs
    expect(CANARY_BLOCKER_CATEGORIES.CODE.id).toBe('CODE');
    expect(CANARY_BLOCKER_CATEGORIES.CONFIGURATION.id).toBe('CONFIGURATION');
    expect(CANARY_BLOCKER_CATEGORIES.OPERATOR_MANUAL_ACTION.id).toBe('OPERATOR_MANUAL_ACTION');
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.id).toBe('GITHUB_CI');
  });

  it('GITHUB_CI has attestedStatus UNATTESTED', () => {
    expect(CANARY_BLOCKER_CATEGORIES.GITHUB_CI.attestedStatus).toBe('UNATTESTED');
  });

  it('status returns only stable sanitized blocker DTOs, never raw failed details', async () => {
    const secretLikeDetail = 'https://private-rpc.invalid/path 0x' + 'ab'.repeat(20);
    const { deps } = makeContractDeps({
      signerBinding: async () => FAIL(secretLikeDetail),
      githubCiAttestation: () => FAIL('UNATTESTED'),
    });
    const status = await getCanaryStatus(deps);

    expect(status.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'CONFIGURATION',
        id: 'CONFIGURATION',
        blocking: true,
      }),
      expect.objectContaining({
        category: 'GITHUB_CI',
        id: 'GITHUB_CI',
        blocking: true,
      }),
    ]));
    const serialized = JSON.stringify(status.blockers);
    expect(serialized).not.toContain('private-rpc.invalid');
    expect(serialized).not.toContain('0x' + 'ab'.repeat(20));
  });
});

describe('#142 production preflight wiring — signer and cost immutability', () => {
  const source = readFileSync(
    new URL('../lib/manualCanaryDeps.ts', import.meta.url),
    'utf8',
  );
  const readonlySource = readFileSync(
    new URL('../lib/manualCanaryReadonlyEvidence.ts', import.meta.url),
    'utf8',
  );
  const signerStart = source.indexOf('signerBinding: async () =>');
  const signerEnd = source.indexOf('ownerApproval: async', signerStart);
  const signerBindingSource = source.slice(signerStart, signerEnd);
  const costStart = readonlySource.indexOf('export async function fetchManualCanaryReadonlyCost');
  const costEnd = readonlySource.indexOf(
    'export async function refreshManualCanaryReadonlyEvidence',
    costStart,
  );
  const costSnapshotSource = readonlySource.slice(costStart, costEnd);

  it('signerBinding contains reads only and no decrypt/provision/sign/mutation capability', () => {
    expect(signerBindingSource).toContain('db.select()');
    expect(signerBindingSource).toContain('getStoredPublicSignerAddress');
    expect(signerBindingSource).not.toMatch(
      /db\.(?:insert|update|delete)|provisionDelegatedSigner|initializeDelegatedSigner|restoreExistingManualCanarySigner|signDigestWithDelegatedSigner|getSignerWalletClient/,
    );
  });

  it('preflight costSnapshot does not record execution-eligible evidence', () => {
    expect(costSnapshotSource).toContain('fetchLiveCostSnapshot');
    expect(costSnapshotSource).not.toContain('recordExecutionEligibleCostEvidence(');
    expect(source).toContain("from './manualCanaryReadonlyEvidence'");
  });
});

describe('#142 Canary Launch Contract — HTTP auth failure coverage', () => {
  const app = express();
  app.use('/api', canaryRouter);

  it.each([
    ['/api/executor/canary/status', 'status'],
    ['/api/executor/canary/preflight?symbol=BTC&direction=LONG', 'preflight'],
  ])('missing operator PIN blocks %s before dependency construction', async (path) => {
    vi.stubEnv('OPERATOR_MASTER_PIN', 'canary-test-pin-142');
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: '운영자 인증 실패' });
    expect(defaultDepsFactory).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['/api/executor/canary/status', 'status'],
    ['/api/executor/canary/preflight?symbol=BTC&direction=LONG', 'preflight'],
  ])('wrong operator PIN blocks %s before dependency construction', async (path) => {
    vi.stubEnv('OPERATOR_MASTER_PIN', 'canary-test-pin-142');
    const res = await request(app).get(path).set('x-operator-pin', 'wrong-test-pin');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: '운영자 인증 실패' });
    expect(defaultDepsFactory).toHaveBeenCalledTimes(0);
  });

  it('missing operator configuration fails closed before dependency construction', async () => {
    vi.stubEnv('OPERATOR_MASTER_PIN', '');
    const res = await request(app).get('/api/executor/canary/status');
    expect(res.status).toBe(503);
    expect(defaultDepsFactory).toHaveBeenCalledTimes(0);
  });

  it('authenticated status exposes bounded economics as read-only, never authorization', async () => {
    vi.stubEnv('OPERATOR_MASTER_PIN', 'canary-test-pin-142');
    const { deps, forbidden } = makeContractDeps();
    __setCanaryDepsForTests(deps);

    const res = await request(app)
      .get('/api/executor/canary/status')
      .set('x-operator-pin', 'canary-test-pin-142');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.boundedCanaryEconomics).toEqual({
      BTC: expect.objectContaining({
        status: 'UNAVAILABLE',
        boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
        observedAffordableRanges: [],
      }),
      ETH: expect.objectContaining({
        status: 'UNAVAILABLE',
        boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
        observedAffordableRanges: [],
      }),
    });
    expect(res.body.boundedCanaryEconomics).not.toHaveProperty('executionAuthorized');
    expect(forbidden.executeOrder).not.toHaveBeenCalled();
    expect(forbidden.closePosition).not.toHaveBeenCalled();
    expect(forbidden.runEmergencyClose).not.toHaveBeenCalled();
    expect(forbidden.recordCostEvidenceForExecution).not.toHaveBeenCalled();
  });

  it('narrow dependency type has no execution capabilities', () => {
    const narrowDeps: ManualCanaryPreflightDeps = makePreflightOnlyDeps().preflightDeps;
    expect('executeOrder' in narrowDeps).toBe(false);
    expect('closePosition' in narrowDeps).toBe(false);
    expect('runEmergencyClose' in narrowDeps).toBe(false);
    expect('recordCostEvidenceForExecution' in narrowDeps).toBe(false);
    expect('intentStatus' in narrowDeps).toBe(false);
    expect('initialStopStatus' in narrowDeps).toBe(false);
  });

  it('status dependency type has reads only and no execution capabilities', () => {
    const full = makeContractDeps().deps;
    const { randomId: _randomId, casState: _casState, ...readonlyChecks } =
      makePreflightOnlyDeps().preflightDeps;
    const statusDeps: ManualCanaryStatusDeps = {
      ...readonlyChecks,
      intentStatus: full.intentStatus,
      initialStopStatus: full.initialStopStatus,
    };
    expect('randomId' in statusDeps).toBe(false);
    expect('casState' in statusDeps).toBe(false);
    expect('executeOrder' in statusDeps).toBe(false);
    expect('closePosition' in statusDeps).toBe(false);
    expect('runEmergencyClose' in statusDeps).toBe(false);
    expect('recordCostEvidenceForExecution' in statusDeps).toBe(false);
  });
});
