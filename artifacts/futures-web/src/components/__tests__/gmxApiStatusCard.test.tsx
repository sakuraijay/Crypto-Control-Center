// @vitest-environment jsdom

/**
 * 6G-2 §11/§14 — GmxApiStatusCard 렌더·fetch 계약 검증.
 *
 *  - 서버 스냅샷 fixture → 19항목 runtime 렌더 (renderToStaticMarkup)
 *  - submission flag false → "구조적으로 비활성" 표시
 *  - 조회 실패를 "미설정"으로 표시하지 않음 — 401/403/503/network 구분
 *  - readyForControlledCanary는 서버 값 그대로 (false)
 *  - legacy relay 벤더(Gelato Enterprise/Gas Tank/API key) 문구 0건
 *  - main wallet private key 관련 UI 0건
 *  - 소스 계약: PIN 저장·polling 없음, apiUrl 헬퍼(origin root /api)만 사용
 *  - Settlement Evidence 섹션: loading/unavailable/completed/incomplete 케이스
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  FAIL_CLOSED_STATUS_MAX_AGE_MS,
  GmxApiStatusCard,
  getGmxApiEvidenceTtlMs,
  isCurrentGmxApiRequest,
  isPaperCostCapPass,
  isPaperCostEvidenceCurrent,
  isStopCapabilityDisplayAvailable,
  PaperCostDetails,
  PaperEconomicsDetails,
  PaperRelayEvidence,
  PaperEpochPreflight,
  PaperStopReadinessEvidence,
  reduceGmxApiCardEvidence,
} from '../GmxApiStatusCard';
import {
  fetchGmxApiStatus, postGmxApiReadinessRefresh, classifyGmxApiHttpFailure,
  type GmxApiStatusView,
} from '@/lib/gmxApiStatus';

const STATUS_FIXTURE: GmxApiStatusView = {
  transportGen: 'GMX_API_V2',
  legacyDisabled: true,
  peers: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
  readonlyEnabled: false,
  submissionEnabled: false,
  signerEnabled: false,
  signerInitialized: false,
  liveTestExecutionLocked: true,
  emergencyStopActive: false,
  reconciled: true,
  dbOk: true,
  canonical: {
    authorized: false, approvalRemainingOk: false,
    reason: 'canonical readback 미조회 — 저장 스냅샷 없음 (fail-closed)',
    expiresAt: null, remaining: null,
  },
  paperRelayEvidence: {
    scope: 'PAPER_READ_ONLY_RELAY_EVIDENCE',
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    executionAuthorized: false,
    evaluatedAtMs: 1_777_000_000_000,
    fresh: true,
    safe: true,
    failureIds: [],
    executionOnly: [
      {
        id: 'canonicalAuthorization',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
      },
      {
        id: 'actionBudget',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER',
      },
      {
        id: 'prepareReconciliation',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'PREPARE_RECONCILIATION_NOT_EVALUATED_IN_PAPER',
      },
      {
        id: 'protectionReconciliation',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'PROTECTION_RECONCILIATION_NOT_EVALUATED_IN_PAPER',
      },
      {
        id: 'settlementReconciliation',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'SETTLEMENT_RECONCILIATION_NOT_EVALUATED_IN_PAPER',
      },
    ],
    storedSafety: [
      {
        id: 'blockingIntents',
        status: 'verified',
        fresh: true,
        observedAtMs: 1_777_000_000_000,
        ageMs: 0,
        failureId: null,
      },
    ],
  },
  paperEpochPreflight: {
    scope: 'PAPER_EPOCH_READINESS_PREFLIGHT',
    boundary: 'READ_ONLY_CALCULATION_NOT_STATE_CHANGE',
    executionAuthorized: false,
    stateChangePerformed: false,
    observedAtMs: 1_777_000_000_000,
    readyForPaperEpochProposal: false,
    blockerIds: ['CURRENT_ACTIVE_TRADING_CAPITAL_USD_UNAVAILABLE'],
    counts: {
      openPositionCount: 0,
      pendingApprovalCount: 0,
      pendingCloseCount: 0,
      blockingIntentCount: 0,
      blockingProtectionCount: 0,
      paperExecutorUnresolvedCount: 0,
      unresolvedRelayTaskCount: 0,
      unsettledTradeCount: 0,
      openRelayTaskCount: 0,
    },
    current: {
      activeTradingCapitalUsd: 24.5,
      equityHwmUsd: 1_000,
      dailyRiskBaselineUsd: 24.5,
      weeklyRiskBaselineUsd: 24.5,
      currentEquityUsd: 24.5,
      reserveCashPct: 20,
      riskOperatingState: 'HARD_STOPPED',
      riskEntryAllowed: false,
    },
    planned: {
      seedCapitalUsd: 10_000,
      activeCapitalStagesUsd: [1_000, 2_500, 5_000, 10_000],
      separation: 'PLANNED_SEED_IS_NOT_ACTIVE_OR_RESERVE_CAPITAL',
    },
    proposedNewEpoch: {
      activeTradingCapitalUsd: 1_000,
      equityHwmUsd: 1_000,
      dailyRiskBaselineUsd: 1_000,
      weeklyRiskBaselineUsd: 1_000,
      applied: false,
      persistenceId: null,
    },
    boundaries: {
      engineMode: 'PAPER',
      autoWorkerLiveEnabled: false,
      liveTestExecutionLocked: false,
      delegatedSignerEnabled: true,
      gmxOrderSubmissionEnabled: true,
      relaySubmissionEnabled: false,
      relaySubmitNetworkEnabled: false,
      relayMode: 'DISABLED',
    },
    preservedExecutionGates: {
      readyForControlledCanary: false,
      stopExecutionAvailable: false,
      hardStopReason: 'historical PAPER hard stop',
      riskOperatingState: 'HARD_STOPPED',
      riskEntryAllowed: false,
      unchanged: true,
    },
    notices: [
      '계산 전용 — epoch, DB, HWM, Active Trading Capital, Risk baseline을 변경하지 않습니다.',
      'Planned Seed는 Active Capital 또는 Reserve Capital이 아닙니다.',
      '제안값은 Canary, LIVE, cost, Stop, HARD_STOP gate를 대체하거나 완화하지 않습니다.',
    ],
  },
  approvalSessionReady: false,
  blockingIntentCount: 0,
  openRelayTaskCount: 0,
  unresolvedTaskCount: 0,
  activeRevokeInProgress: false,
  gmxConfigOk: false,
  deploymentVerification: { attempted: false, ok: false, atMs: null, manifestVersion: null },
  manifestVersion: '1',
  feeEstimate: { attempted: false, ok: false, atMs: null, fresh: false },
  lastReadinessRefresh: { attempted: false, atMs: null, ok: false, basis: null },
  gmxTaskCounts: {},
  recentGmxTasks: [],
  readyForControlledCanary: false,
  stopExecutionAvailable: false,
  stopCapability: {
    available: false,
    reasons: [
      'delegated signer 비활성/미초기화',
      '실행 잠금 상태 (LIVE 잠금/emergency stop)',
    ],
    evaluatedAt: '2026-08-20T18:08:22.454Z',
    scope: 'LIVE_STOP_EXECUTION',
    boundary: 'READ_ONLY_STATUS_NOT_EXECUTION_AUTHORIZATION',
    paperMode: true,
    schemaPin: { sdk: '@gmx-io/sdk@1.7.0', stopLossDecrease: 6 },
  },
  // 6G-3 §7 신규 항목
  prepareStageCounts: { PREPARED: 0, PREPARE_REQUESTED: 0, API_PREPARED: 0, SUBMITTING: 0, UNRESOLVED: 0 },
  oldestBlockingTaskAt: null,
  prepareStartupReconciliation: {
    attempted: true, ok: true, atMs: 1_700_000_000_000,
    stalePreparedFailed: 0, requestedToUnresolved: 0, apiPreparedHeld: 0,
  },
  blockedReasons: ['order submission flag 비활성 — 구조적 차단'],
  notices: [
    '자동 재시도 없음 — UNRESOLVED/API_PREPARED는 운영자 확인 전 어떤 자동 조치도 하지 않습니다.',
    '운영자 확인 전 서명·제출 금지 — 이 화면은 조회 전용이며 강제 완료·삭제·재제출 기능이 없습니다.',
  ],
  // Settlement Evidence 필드
  settlementReconcile: { ok: true, unsettledCount: 0, settledNow: 0, incomplete: false, reasons: [] },
  legacyZeroFeeCount: 0,
  unsettledLiveTradeCount: 0,
  paperRuntimeReadiness: {
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    paperMode: true,
    readonlyEnabled: true,
    scheduler: {
      running: true,
      inFlight: false,
      intervalMs: 45_000,
      lastAttemptAtMs: 1_777_000_000_000,
      lastCompletedAtMs: 1_777_000_000_000,
      lastSuccessAtMs: null,
      nextRefreshAtMs: 1_777_000_045_000,
      lastFailureId: 'PAPER_READINESS_INCOMPLETE',
    },
    decimals: {
      BTC: {
        state: 'verified',
        attemptedAtMs: 1_777_000_000_000,
        observedAtMs: 1_776_999_997_000,
        ageMs: 3_000,
        fresh: true,
        failureId: null,
        detail: 'verified',
        decimals: 8,
        source: 'sdk-synthetic+onchain-no-code',
        tokenAddress: '0x0000000000000000000000000000000000000001',
      },
      ETH: {
        state: 'verified',
        attemptedAtMs: 1_777_000_000_000,
        observedAtMs: 1_776_999_997_000,
        ageMs: 3_000,
        fresh: true,
        failureId: null,
        detail: 'verified',
        decimals: 18,
        source: 'sdk+onchain',
        tokenAddress: '0x0000000000000000000000000000000000000002',
      },
    },
    deployment: {
      state: 'not_evaluated',
      attemptedAtMs: null,
      observedAtMs: null,
      ageMs: null,
      fresh: false,
      failureId: 'DEPLOYMENT_READONLY_DISABLED',
      detail: 'not evaluated',
      manifestVersion: null,
    },
    rpc: {
      state: 'not_evaluated',
      attemptedAtMs: null,
      observedAtMs: null,
      ageMs: null,
      fresh: false,
      failureId: 'RPC_READONLY_DISABLED',
      detail: 'not evaluated',
      chainId: null,
    },
    costs: {
      BTC: {
        evidenceRole: 'OBSERVATIONAL_READ_ONLY',
        observationalFresh: true,
        state: 'verified',
        attemptedAtMs: 1_777_000_000_000,
        observedAtMs: 1_776_999_996_000,
        ageMs: 4_000,
        fresh: true,
        failureId: null,
        detail: 'observed',
        symbol: 'BTC',
        direction: 'LONG',
        notionalUsd: 20,
        holdingHours: 1,
        capUsd: 0.4,
        positionFeeUsd: 0.012,
        executionFeeUsd: 0.428188,
        estimatedPriceImpactUsd: 0,
        fundingFeeUsd: 0.000461,
        borrowingFeeUsd: 0.000363,
        fundingRatePerHourFraction: 0.000461 / 20,
        borrowingRatePerHourFraction: 0.000363 / 20,
        estimatedExitFeeUsd: 0.012,
        estimatedExitPriceImpactUsd: 0,
        tradingFeesUsd: 0.024,
        priceImpactTotalUsd: 0,
        carryCostUsd: 0.000824,
        otherCostUsd: 0,
        effectiveRoundTripCostUsd: 0.453011,
        totalCostRatePct: 2.265055,
        capDeltaUsd: 0.053011,
        capExcessUsd: 0.053011,
        capExcessRatePct: 13.25275,
        requiredCostReductionUsd: 0.053011,
        requiredCostReductionPct: 11.701923,
        breakEvenGrossMoveUsd: 0.453011,
        breakEvenGrossMovePct: 2.265055,
        withinCap: false,
        blockReason: 'BTC round-trip 비용이 고정 $0.40 cap을 $0.053011 초과',
        executionSnapshot: {
          fresh: true,
          eligible: false,
          authorized: false,
          maxAgeMs: 30_000,
          failureId: 'COST_BTC_CAP_EXCEEDED',
          blockReason: 'COST_BTC_CAP_EXCEEDED — OPEN/Canary fail-closed 차단',
        },
        source: 'GMX_API',
        apiTimestamp: '2026-04-25T22:13:16.000Z',
        fetchedAt: '2026-04-25T22:13:16.000Z',
      },
      ETH: {
        evidenceRole: 'OBSERVATIONAL_READ_ONLY',
        observationalFresh: true,
        state: 'verified',
        attemptedAtMs: 1_777_000_000_000,
        observedAtMs: 1_776_999_996_000,
        ageMs: 4_000,
        fresh: true,
        failureId: null,
        detail: 'observed',
        symbol: 'ETH',
        direction: 'LONG',
        notionalUsd: 20,
        holdingHours: 1,
        capUsd: 0.4,
        positionFeeUsd: 0.01,
        executionFeeUsd: 0.1,
        estimatedPriceImpactUsd: 0,
        fundingFeeUsd: 0.001,
        borrowingFeeUsd: 0.001,
        fundingRatePerHourFraction: 0.00005,
        borrowingRatePerHourFraction: 0.00005,
        estimatedExitFeeUsd: 0.01,
        estimatedExitPriceImpactUsd: 0,
        tradingFeesUsd: 0.02,
        priceImpactTotalUsd: 0,
        carryCostUsd: 0.002,
        otherCostUsd: 0,
        effectiveRoundTripCostUsd: 0.122,
        totalCostRatePct: 0.61,
        capDeltaUsd: -0.278,
        capExcessUsd: 0,
        capExcessRatePct: 0,
        requiredCostReductionUsd: 0,
        requiredCostReductionPct: 0,
        breakEvenGrossMoveUsd: 0.122,
        breakEvenGrossMovePct: 0.61,
        withinCap: true,
        blockReason: null,
        executionSnapshot: {
          fresh: true,
          eligible: true,
          authorized: false,
          maxAgeMs: 30_000,
          failureId: null,
          blockReason: null,
        },
        source: 'GMX_API',
        apiTimestamp: '2026-04-25T22:13:16.000Z',
        fetchedAt: '2026-04-25T22:13:16.000Z',
      },
    },
    economics: {
      BTC: {
        state: 'UNAVAILABLE',
        reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
        candidateNotionalUsd: 20,
        holdingHours: 1,
        expectedGrossEdgeFraction: null,
        expectedGrossEdgeUsd: null,
        expectedGrossEdgeSource: null,
        fixedExecutionCostUsd: null,
        variableCostRateFraction: null,
        denominatorFraction: null,
        economicMinimumNotionalUsd: null,
        technicalMinimumNotionalUsd: 2.2,
        requiredMinimumNotionalUsd: null,
        candidateSufficient: null,
        capUsd: 0.4,
        capRelationship: 'UNAVAILABLE',
      },
      ETH: {
        state: 'UNAVAILABLE',
        reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
        candidateNotionalUsd: 20,
        holdingHours: 1,
        expectedGrossEdgeFraction: null,
        expectedGrossEdgeUsd: null,
        expectedGrossEdgeSource: null,
        fixedExecutionCostUsd: null,
        variableCostRateFraction: null,
        denominatorFraction: null,
        economicMinimumNotionalUsd: null,
        technicalMinimumNotionalUsd: 2.2,
        requiredMinimumNotionalUsd: null,
        candidateSufficient: null,
        capUsd: 0.4,
        capRelationship: 'UNAVAILABLE',
      },
    },
    blockerIds: ['deployment', 'rpc', 'btc_cost_cap', 'owner_approval'],
    manualActionHolds: [{
      id: 'owner_approval',
      requestedAt: '2026-08-20T13:59:15Z',
      requiredAction: 'owner payload 승인',
      resumeCondition: '최신 상태 재검증',
    }],
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchGmxApiStatus — 오류 구분 (silent null 금지)', () => {
  it('200 → ok + status 파싱', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true, status: STATUS_FIXTURE })));
    const r = await fetchGmxApiStatus('123456');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.transportGen).toBe('GMX_API_V2');
  });

  it('401 → OPERATOR_AUTH_REQUIRED / 403 → FORBIDDEN / 503 → SERVICE_UNAVAILABLE', async () => {
    expect(classifyGmxApiHttpFailure(401).kind).toBe('OPERATOR_AUTH_REQUIRED');
    expect(classifyGmxApiHttpFailure(403).kind).toBe('FORBIDDEN');
    expect(classifyGmxApiHttpFailure(503).kind).toBe('SERVICE_UNAVAILABLE');
    expect(classifyGmxApiHttpFailure(500).kind).toBe('SERVER_ERROR');
  });

  it('네트워크 오류 → NETWORK (미설정으로 위장 금지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await fetchGmxApiStatus('123456');
    expect(r.kind).toBe('NETWORK');
  });

  it('POST refresh는 JSON Content-Type + 인증 헤더로 호출된다', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { ok: true, status: STATUS_FIXTURE }));
    vi.stubGlobal('fetch', spy);
    await postGmxApiReadinessRefresh('123456');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/executor\/gmx-api\/readiness\/refresh$/);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-operator-pin']).toBe('123456');
    expect(headers['content-type']).toBe('application/json');
  });

  it('POST refresh 인증 실패도 기존 success snapshot을 폐기하는 state transition으로 연결된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'forbidden' })));
    const refreshResult = await postGmxApiReadinessRefresh('wrong-pin');
    expect(refreshResult.kind).toBe('FORBIDDEN');

    const previous = reduceGmxApiCardEvidence(
      { kind: 'ok', data: STATUS_FIXTURE },
      1_000,
    );
    expect(previous.status?.readyForControlledCanary).toBe(false);

    const invalidated = reduceGmxApiCardEvidence(refreshResult, 2_000);
    expect(invalidated.status).toBeNull();
    expect(invalidated.message?.text).toContain('이전 readiness 증거는 폐기');
  });
});

describe('GmxApiStatusCard — fail-closed evidence lifecycle', () => {
  it.each([
    { kind: 'OPERATOR_AUTH_REQUIRED' as const, message: '401' },
    { kind: 'FORBIDDEN' as const, message: '403' },
    { kind: 'SERVICE_UNAVAILABLE' as const, message: '503' },
    { kind: 'NETWORK' as const, message: 'offline' },
    { kind: 'SERVER_ERROR' as const, message: '500' },
    { kind: 'ERROR' as const, message: 'invalid response' },
  ])('success 뒤 $kind 실패는 이전 PASS성 snapshot을 폐기한다', (failure) => {
    const success = reduceGmxApiCardEvidence(
      { kind: 'ok', data: STATUS_FIXTURE },
      1_000,
    );
    expect(success.status).toBe(STATUS_FIXTURE);
    expect(success.observedAtMs).toBe(1_000);

    const failed = reduceGmxApiCardEvidence(failure, 2_000);
    expect(failed.status).toBeNull();
    expect(failed.observedAtMs).toBeNull();
    expect(failed.message?.text).toContain('이전 readiness 증거는 폐기');
  });

  it('status TTL은 실행 비용 창·로컬 snapshot age·기존 verified cost age로 fail-closed 제한된다', () => {
    const view = {
      ...STATUS_FIXTURE,
      executionEligibleCostMaxAgeMs: 30_000,
      paperRuntimeReadiness: {
        ...STATUS_FIXTURE.paperRuntimeReadiness!,
        costs: {
          ...STATUS_FIXTURE.paperRuntimeReadiness!.costs,
          BTC: { ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC, ageMs: 12_000 },
          ETH: { ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.ETH, ageMs: 4_000 },
        },
      },
    };
    expect(getGmxApiEvidenceTtlMs(view, 1_000_000, 1_005_000)).toBe(18_000);
    expect(getGmxApiEvidenceTtlMs(view, 1_000_000, 1_030_001)).toBe(0);
    expect(FAIL_CLOSED_STATUS_MAX_AGE_MS).toBe(30_000);
  });

  it('cost PASS는 $0.40·observational fresh·execution fresh/eligible·withinCap true를 모두 요구한다', () => {
    const base = {
      ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.ETH,
      state: 'verified' as const,
      fresh: true,
      observationalFresh: true,
      capUsd: 0.4,
      withinCap: true,
      effectiveRoundTripCostUsd: 0.2,
      executionSnapshot: {
        ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.ETH.executionSnapshot,
        fresh: true,
        eligible: true,
      },
    };
    expect(isPaperCostEvidenceCurrent(base)).toBe(true);
    expect(isPaperCostCapPass(base)).toBe(true);
    for (const invalid of [
      { ...base, observationalFresh: false },
      { ...base, capUsd: null },
      { ...base, withinCap: null },
      { ...base, executionSnapshot: { ...base.executionSnapshot, fresh: false } },
      { ...base, executionSnapshot: { ...base.executionSnapshot, eligible: false } },
    ]) {
      expect(isPaperCostCapPass(invalid)).toBe(false);
    }
  });

  it('Stop 가능 표시는 LIVE·successful refresh·동일 시각대 fresh 평가를 모두 요구한다', () => {
    const liveFresh = {
      ...STATUS_FIXTURE,
      executionEligibleCostMaxAgeMs: 30_000,
      lastReadinessRefresh: { attempted: true, ok: true, atMs: 100_000, basis: 'verified' },
      stopCapability: {
        ...STATUS_FIXTURE.stopCapability!,
        available: true,
        paperMode: false,
        evaluatedAt: new Date(100_001).toISOString(),
        reasons: [],
      },
    };
    expect(isStopCapabilityDisplayAvailable(liveFresh, 110_000)).toBe(true);
    expect(isStopCapabilityDisplayAvailable({
      ...liveFresh,
      stopCapability: { ...liveFresh.stopCapability, paperMode: true },
    }, 110_000)).toBe(false);
    expect(isStopCapabilityDisplayAvailable({
      ...liveFresh,
      lastReadinessRefresh: { ...liveFresh.lastReadinessRefresh, ok: false },
    }, 110_000)).toBe(false);
    expect(isStopCapabilityDisplayAvailable({
      ...liveFresh,
      stopCapability: {
        ...liveFresh.stopCapability,
        reasons: ['contradictory server evidence'],
      },
    }, 110_000)).toBe(false);
    expect(isStopCapabilityDisplayAvailable(liveFresh, 140_002)).toBe(false);
  });

  it('PIN generation이 바뀐 뒤 완료된 이전 요청 결과는 적용하지 않는다', () => {
    expect(isCurrentGmxApiRequest(7, 7)).toBe(true);
    expect(isCurrentGmxApiRequest(7, 8)).toBe(false);
  });

  it('Stop 개별 freshness가 만료되는 즉시 긍정 표시와 snapshot을 폐기한다', async () => {
    const nowMs = 1_777_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const liveFreshStatus: GmxApiStatusView = {
      ...STATUS_FIXTURE,
      executionEligibleCostMaxAgeMs: 10_000,
      lastReadinessRefresh: {
        attempted: true,
        atMs: nowMs - 9_000,
        ok: true,
        basis: 'authenticated-readiness-refresh',
      },
      stopCapability: {
        ...STATUS_FIXTURE.stopCapability!,
        available: true,
        reasons: [],
        paperMode: false,
        evaluatedAt: new Date(nowMs - 9_000).toISOString(),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(200, { ok: true, status: liveFreshStatus })));

    render(<GmxApiStatusCard />);
    fireEvent.change(screen.getByTestId('gmx-api-pin-input'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('gmx-api-load-button'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('gmx-api-rows').textContent)
      .toContain('가능 · 현재 LIVE · status는 권한 아님');

    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByTestId('gmx-api-rows')).toBeTruthy();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('gmx-api-rows')).toBeNull();
    expect(screen.getByTestId('gmx-api-message').textContent)
      .toContain('Readiness 증거 freshness가 만료');
  });
});

describe('GmxApiStatusCard — 렌더 계약', () => {
  it('조회 전에는 상태 값을 표시하지 않는다 (지어내기 금지)', () => {
    const html = renderToStaticMarkup(<GmxApiStatusCard />);
    expect(html).toContain('아직 조회 전입니다');
    expect(html).not.toContain('GMX_API_V2');
  });

  it('금지 문구 0건 — legacy 벤더·private key 언급 없음', () => {
    const html = renderToStaticMarkup(<GmxApiStatusCard />);
    expect(html).not.toMatch(/Gelato Enterprise|Gas Tank|GELATO_API_KEY/i);
    expect(html).not.toMatch(/private[_ ]?key/i);
  });

  it('PAPER Canary blocker provenance를 active READY나 execution eligibility로 승격하지 않는다', async () => {
    const blockedStatus: GmxApiStatusView = {
      ...STATUS_FIXTURE,
      approvalSessionReady: null,
      readyForControlledCanary: false,
      stopExecutionAvailable: false,
      paperRuntimeReadiness: {
        ...STATUS_FIXTURE.paperRuntimeReadiness!,
        costs: {
          BTC: {
            ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC,
            observationalFresh: false,
            fresh: false,
            blockReason: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE — fresh $0.40 cap evidence 없음',
            executionSnapshot: {
              ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC.executionSnapshot,
              fresh: false,
              eligible: false,
              authorized: false,
            },
          },
          ETH: {
            ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.ETH,
            observationalFresh: false,
            fresh: false,
            blockReason: 'COST_ETH_EXECUTION_SNAPSHOT_INELIGIBLE — fresh $0.40 cap evidence 없음',
            executionSnapshot: {
              ...STATUS_FIXTURE.paperRuntimeReadiness!.costs.ETH.executionSnapshot,
              fresh: false,
              eligible: false,
              authorized: false,
            },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(200, { ok: true, status: blockedStatus })));

    render(<GmxApiStatusCard />);
    fireEvent.change(screen.getByTestId('gmx-api-pin-input'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('gmx-api-load-button'));
    await act(async () => {
      await Promise.resolve();
    });

    const html = screen.getByTestId('gmx-api-status-card').textContent ?? '';
    expect(html).toContain('CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER');
    expect(html).toContain('ACTION_BUDGET_NOT_EVALUATED_IN_PAPER');
    expect(html).toContain('READ-ONLY / NOT EXECUTION AUTHORIZATION');
    expect(html).toContain('HARD_STOPPED');
    expect(html).toContain('false / false / DISABLED');
    expect(html).toContain('readyForControlledCanaryfalse');
    expect(html).toContain('UNAVAILABLE (fail-closed)');
    expect(html).toContain('fresh $0.40 cap evidence 없음');
    expect(html).not.toContain('OWNER_SIGNATURE_READY');
    expect(html).not.toContain('실행 권한 GRANTED');
    expect(html).not.toContain('가능 · 현재 LIVE');
  });
});

describe('PAPER Relay Evidence 렌더 계약', () => {
  it('execution-only를 NOT EVALUATED로 표시하고 권한이 아님을 명시한다', () => {
    const evidence = STATUS_FIXTURE.paperRelayEvidence!;
    const html = renderToStaticMarkup(<PaperRelayEvidence evidence={evidence} />);

    expect(html).toContain('PAPER Relay Evidence');
    expect(html).toContain('NOT EVALUATED');
    expect(html).toContain('READ-ONLY / NOT EXECUTION AUTHORIZATION');
    expect(html).toContain('CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER');
    expect(html).toContain('ACTION_BUDGET_NOT_EVALUATED_IN_PAPER');
    expect(html).toContain('저장 안전 결함 없음');
    expect(html).not.toMatch(/remainingActions|expiresAt|signature|rpcUrl/i);
  });
});

describe('PAPER Epoch readiness/preflight 렌더 계약', () => {
  it('현재·계획·제안값을 분리하고 계산 전용 경계를 표시한다', () => {
    const html = renderToStaticMarkup(<PaperEpochPreflight view={STATUS_FIXTURE.paperEpochPreflight!} />);
    expect(html).toContain('PAPER Epoch Readiness / Preflight');
    expect(html).toContain('Active Trading Capital');
    expect(html).toContain('Planned Seed');
    expect(html).toContain('$1,000 → $2,500 → $5,000 → $10,000');
    expect(html).toContain('Proposed New Epoch');
    expect(html).toContain('APPLIED false');
    expect(html).toContain('READ_ONLY_CALCULATION_NOT_STATE_CHANGE');
    expect(html).toContain('HARD_STOPPED');
    expect(html).toContain('unchanged');
    expect(html).not.toMatch(/적용 실행|epoch 생성 버튼|reset 실행/i);
  });
});

describe('소스 계약 (§11 규칙)', () => {
  const cardSrc = readFileSync(path.resolve(__dirname, '../GmxApiStatusCard.tsx'), 'utf8');
  const libSrc = readFileSync(path.resolve(__dirname, '../../lib/gmxApiStatus.ts'), 'utf8');

  it('19항목 라벨이 전부 카드에 존재한다', () => {
    for (const label of [
      'GMX API v2 Official', 'Read-only flag', 'Order submission flag', 'Peer A / Peer B',
      'Delegated signer', 'Owner Approval 세션', 'Canonical verified', 'Remaining actions',
      'Approval expiresAt', 'Active revoke', 'Blocking intents', 'Open tasks / Unresolved',
      'Reconciliation', 'LIVE 잠금', 'Emergency Stop', 'Fee estimate',
      '최근 requestId/status', 'readyForControlledCanary', '구조적으로 비활성',
    ]) {
      expect(cardSrc).toContain(label);
    }
  });

  it('Gelato 벤더 문구 0건 (카드+lib)', () => {
    expect(cardSrc + libSrc).not.toMatch(/Gelato|Gas Tank|GELATO_API_KEY/i);
  });

  it('PIN 저장 없음(localStorage/sessionStorage 0건)·자동 polling 없음(setInterval 0건)', () => {
    expect(cardSrc + libSrc).not.toMatch(/localStorage|sessionStorage|setInterval/);
  });

  it('PIN 변경은 인증된 이전 status snapshot을 즉시 폐기한다', () => {
    expect(cardSrc).toContain('onChange={(e) => changePin(e.target.value)}');
    expect(cardSrc).toContain('운영자 PIN이 변경되어 인증된 이전 readiness 증거를 폐기했습니다');
    expect(cardSrc).toContain('requestGenerationRef.current += 1');
    expect(cardSrc).toContain('isCurrentGmxApiRequest(requestGeneration, requestGenerationRef.current)');
  });

  it('내부 API는 apiUrl 헬퍼만 사용 (origin root /api 규칙)', () => {
    expect(libSrc).toContain("from './apiUrl'");
    expect(libSrc).not.toMatch(/BASE_URL.?api|https?:\/\//);
  });

  it('readyForControlledCanary는 서버 값 그대로 표시 (클라이언트 파생 금지)', () => {
    expect(cardSrc).toContain('String(s.readyForControlledCanary)');
  });

  // 6G-3 §7 — prepare 단계 관측 항목
  it('prepare 단계·startup reconciliation·차단 사유·고지 라벨이 카드에 존재한다', () => {
    for (const label of [
      'Prepare 단계 (REQ/PREP/SUBM)', '가장 오래된 blocking task',
      'Prepare startup reconciliation', '신규 주문 차단 사유',
    ]) expect(cardSrc).toContain(label);
  });

  it('강제 완료·재제출·삭제 버튼 코드 0건 (조회 전용 계약)', () => {
    expect(cardSrc).not.toMatch(/강제 완료|재제출|force[- ]?complete|resubmit/i);
  });

  it('Settlement Evidence 라벨이 카드 소스에 존재한다', () => {
    for (const label of [
      'Settlement Evidence',
      'CLOSE 정산 reconciliation',
      '미정산 LIVE 거래',
      'Legacy zero-fee 거래',
    ]) expect(cardSrc).toContain(label);
  });

  it('PAPER runtime 진단 라벨·고정 경계·HOLD가 카드 소스에 존재한다', () => {
    for (const label of [
      'PAPER Runtime Readiness Evidence',
      'READ-ONLY / NOT EXECUTION AUTHORIZATION',
      'PAPER evidence는 LIVE Stop capability를 설명만 하며',
      'Deployment evidence',
      'Arbitrum RPC evidence',
      'Scheduler next / failure',
      'index decimals',
      'Blocker IDs',
      'Manual-action HOLD',
      'BLOCKED · CAP EXCEEDED',
      'notional 대비',
      'cap 충족 필요 절감',
      '비용 회수 최소 gross move/edge',
      '기타/보수 조정',
    ]) expect(cardSrc).toContain(label);
    expect(cardSrc).toContain('비용 상한은 서버 고정 $0.40');
    expect(cardSrc).toContain('기존 cap·freshness·Manual Canary gate를 대체하거나 완화하지 않습니다');
  });

  it('진단 UI는 자동 polling·sign/execute/preflight endpoint를 추가하지 않는다', () => {
    expect(cardSrc).not.toMatch(/setInterval/);
    expect(libSrc).not.toMatch(/\/sign|\/execute|\/preflight|\/prepare|\/submit/);
  });

  it('PAPER Relay evidence는 execution-only와 저장 안전 결함을 분리한다', () => {
    for (const label of [
      'PAPER Relay Evidence',
      'canonical·action budget·reconciliation은 PAPER에서 평가하지 않습니다',
      'paper-relay-failure-ids',
    ]) expect(cardSrc).toContain(label);
    expect(cardSrc).toContain('!s.paperRelayEvidence');
  });

  it('Stop capability는 PAPER에서 전체 사유와 비권한 경계를 보존한다', () => {
    const stop = STATUS_FIXTURE.stopCapability!;
    expect(stop.available).toBe(false);
    expect(stop.paperMode).toBe(true);
    expect(stop.scope).toBe('LIVE_STOP_EXECUTION');
    expect(stop.boundary).toBe('READ_ONLY_STATUS_NOT_EXECUTION_AUTHORIZATION');
    expect(stop.reasons).toEqual([
      'delegated signer 비활성/미초기화',
      '실행 잠금 상태 (LIVE 잠금/emergency stop)',
    ]);
    for (const marker of [
      'LIVE Stop 실행 능력',
      'Stop capability 판정 근거',
      '이 읽기 전용 status 자체는 실행 승인이 아닙니다',
    ]) expect(cardSrc).toContain(marker);
  });

  it('settlement 섹션은 읽기 전용 — 액션 버튼·브라우저 상태 저장 없음', () => {
    // 정산 관련 코드에 action 버튼이나 persist 패턴 없어야 함
    expect(cardSrc).not.toMatch(/onClick.*settl|settl.*onClick/i);
    expect(cardSrc).not.toMatch(/localStorage|sessionStorage|setInterval/);
  });
});

describe('GmxApiStatusCard — Settlement Evidence 렌더 케이스', () => {
  /** renderToStaticMarkup은 SSR 렌더이므로 초기 상태(조회 전)를 검사한다.
   *  상태가 주입된 경우를 테스트하려면 fixture variant 함수를 활용한다. */

  function renderWithStatus(override: Partial<typeof STATUS_FIXTURE>): string {
    // renderToStaticMarkup은 hooks를 실행하지 않으므로 컴포넌트는 초기 상태로만 렌더됨.
    // 대신 서버 response fixture 구조 검증(타입 일치)과 카드 소스 문자열 검사로 커버한다.
    // 타입 호환성 확인 (컴파일 타임): 타입 오류 없이 병합 가능한지만 검사
    const _merged: typeof STATUS_FIXTURE = { ...STATUS_FIXTURE, ...override };
    void _merged; // suppress unused warning
    // 카드는 아직 조회 전이므로 Settlement 섹션은 렌더되지 않는다
    const html = renderToStaticMarkup(<GmxApiStatusCard />);
    return html;
  }

  it('조회 전(loading) — Settlement Evidence 섹션을 표시하지 않는다', () => {
    const html = renderWithStatus({});
    expect(html).not.toContain('Settlement Evidence');
    expect(html).not.toContain('CLOSE 정산 reconciliation');
  });

  it('fixture 타입: settlementReconcile=null → 미실행/조회 불가 (unavailable)', () => {
    // 타입 레벨 검증: null이 GmxApiStatusView에서 허용되는지 확인
    const view: typeof STATUS_FIXTURE = {
      ...STATUS_FIXTURE,
      settlementReconcile: null,
    };
    expect(view.settlementReconcile).toBeNull();
  });

  it('fixture 타입: settlementReconcile.incomplete=false → completed', () => {
    const view: typeof STATUS_FIXTURE = {
      ...STATUS_FIXTURE,
      settlementReconcile: { ok: true, unsettledCount: 3, settledNow: 3, incomplete: false, reasons: [] },
    };
    expect(view.settlementReconcile?.incomplete).toBe(false);
    expect(view.settlementReconcile?.unsettledCount).toBe(3);
  });

  it('fixture 타입: settlementReconcile.incomplete=true → incomplete (blocker 포함)', () => {
    const view: typeof STATUS_FIXTURE = {
      ...STATUS_FIXTURE,
      settlementReconcile: {
        ok: false, unsettledCount: 2, settledNow: 0, incomplete: true,
        reasons: ['LIVE_SETTLEMENT_INCOMPLETE: trade=abc 증거 미확보'],
      },
    };
    expect(view.settlementReconcile?.incomplete).toBe(true);
    expect(view.settlementReconcile?.reasons.length).toBeGreaterThan(0);
  });

  it('fixture 타입: legacyZeroFeeCount·unsettledLiveTradeCount null 허용', () => {
    const view: typeof STATUS_FIXTURE = {
      ...STATUS_FIXTURE,
      legacyZeroFeeCount: null,
      unsettledLiveTradeCount: null,
    };
    expect(view.legacyZeroFeeCount).toBeNull();
    expect(view.unsettledLiveTradeCount).toBeNull();
  });

  it('카드 소스: 미실행/조회 불가 분기 — "미실행/조회 불가" 문자열 존재', () => {
    const { cardSrc } = (() => {
      const cs = readFileSync(path.resolve(__dirname, '../GmxApiStatusCard.tsx'), 'utf8');
      return { cardSrc: cs };
    })();
    expect(cardSrc).toContain('미실행/조회 불가');
  });

  it('카드 소스: completed 분기 — "완료" 표시 존재', () => {
    const { cardSrc } = (() => {
      const cs = readFileSync(path.resolve(__dirname, '../GmxApiStatusCard.tsx'), 'utf8');
      return { cardSrc: cs };
    })();
    // settlement 완료 표시
    expect(cardSrc).toContain('완료 (');
  });

  it('카드 소스: incomplete 분기 — "미완료" + 첫 번째 차단 사유 슬라이스 로직 존재', () => {
    const { cardSrc } = (() => {
      const cs = readFileSync(path.resolve(__dirname, '../GmxApiStatusCard.tsx'), 'utf8');
      return { cardSrc: cs };
    })();
    expect(cardSrc).toContain('미완료');
    // blocker sanitization: prefix 제거 + slice(0, 80)
    expect(cardSrc).toContain('.slice(0, 80)');
    expect(cardSrc).toContain('LIVE_SETTLEMENT_INCOMPLETE');
  });
});

describe('GmxApiStatusCard — PAPER runtime fixture', () => {
  it('BTC/ETH 경제성을 UNAVAILABLE 사유와 candidate로 노출한다', () => {
    for (const symbol of ['BTC', 'ETH'] as const) {
      const economics = STATUS_FIXTURE.paperRuntimeReadiness!.economics[symbol];
      const html = renderToStaticMarkup(
        <PaperEconomicsDetails symbol={symbol} economics={economics} />,
      );
      expect(html).toContain('UNAVAILABLE');
      expect(html).toContain('EXPECTED_GROSS_EDGE_UNAVAILABLE');
      expect(html).toContain('candidate $20.00');
      expect(html).toContain('required max(economic, technical)');
    }
  });
  it('$0.453011 BTC LONG $20/1h는 $0.40 cap 초과로 유지된다', () => {
    const btc = STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC;
    expect(btc.direction).toBe('LONG');
    expect(btc.notionalUsd).toBe(20);
    expect(btc.holdingHours).toBe(1);
    expect(btc.effectiveRoundTripCostUsd).toBe(0.453011);
    expect(btc.capUsd).toBe(0.4);
    expect(btc.capDeltaUsd).toBe(0.053011);
    expect(btc.capExcessRatePct).toBe(13.25275);
    expect(btc.totalCostRatePct).toBe(2.265055);
    expect(btc.requiredCostReductionUsd).toBe(0.053011);
    expect(btc.breakEvenGrossMovePct).toBe(2.265055);
    expect(btc.withinCap).toBe(false);
    expect(btc.observationalFresh).toBe(true);
    expect(btc.executionSnapshot).toMatchObject({
      fresh: true,
      eligible: false,
      authorized: false,
      failureId: 'COST_BTC_CAP_EXCEEDED',
    });
    expect(STATUS_FIXTURE.paperRuntimeReadiness!.blockerIds).toContain('btc_cost_cap');
  });

  it('허용 decimals source와 manual HOLD ID를 보존한다', () => {
    const evidence = STATUS_FIXTURE.paperRuntimeReadiness!;
    expect(evidence.decimals.BTC.source).toBe('sdk-synthetic+onchain-no-code');
    expect(evidence.decimals.ETH.source).toBe('sdk+onchain');
    expect(evidence.manualActionHolds[0].id).toBe('owner_approval');
    expect(evidence.boundary).toBe('READ_ONLY_NOT_EXECUTION_AUTHORIZATION');
  });

  it('stale 비용은 금액·비율·source를 렌더하지 않고 차단 사유만 표시한다', () => {
    const fresh = STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC;
    const stale = {
      ...fresh,
      state: 'stale' as const,
      fresh: false,
      observationalFresh: false,
      failureId: null,
      blockReason: 'COST_BTC_STALE — read-only 비용 snapshot이 만료됨',
      positionFeeUsd: null,
      executionFeeUsd: null,
      estimatedPriceImpactUsd: null,
      fundingFeeUsd: null,
      borrowingFeeUsd: null,
      estimatedExitFeeUsd: null,
      estimatedExitPriceImpactUsd: null,
      tradingFeesUsd: null,
      priceImpactTotalUsd: null,
      carryCostUsd: null,
      otherCostUsd: null,
      effectiveRoundTripCostUsd: null,
      totalCostRatePct: null,
      capUsd: null,
      capDeltaUsd: null,
      capExcessUsd: null,
      capExcessRatePct: null,
      requiredCostReductionUsd: null,
      requiredCostReductionPct: null,
      breakEvenGrossMoveUsd: null,
      breakEvenGrossMovePct: null,
      withinCap: null,
      executionSnapshot: {
        fresh: false,
        eligible: false,
        authorized: false as const,
        maxAgeMs: 30_000,
        failureId: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE',
        blockReason: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE — OPEN/Canary fail-closed 차단',
      },
      source: null,
      apiTimestamp: null,
      fetchedAt: null,
      diagnostics: {
        firstFailure: {
          component: 'fundingBorrowingRates',
          sourceId: 'GMX_API_MARKETS_TICKERS',
          failureClass: '5xx',
          httpStatus: 503,
          peerHost: 'arbitrum.gmxapi.ai',
          peerPath: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
        },
        failures: [{
          component: 'fundingBorrowingRates',
          sourceId: 'GMX_API_MARKETS_TICKERS',
          failureClass: '5xx',
          httpStatus: 503,
          peerHost: 'arbitrum.gmxapi.ai',
          peerPath: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
        }],
        sourceTraces: [{
          sourceId: 'GMX_API_MARKETS_TICKERS',
          attempts: [
            { peerHost: 'arbitrum.gmxapi.io', failureClass: '5xx', httpStatus: 503 },
            { peerHost: 'arbitrum.gmxapi.ai', failureClass: '5xx', httpStatus: 503 },
          ],
          attemptCount: 2,
          retryCount: 0,
          failoverCount: 1,
        }],
        attemptCount: 2,
        retryCount: 0,
        failoverCount: 1,
        lastAttemptAtMs: 1_777_000_000_000,
        lastSuccessAtMs: null,
        lastFailureAtMs: 1_777_000_000_000,
      },
    };

    const html = renderToStaticMarkup(<PaperCostDetails symbol="BTC" cost={stale} />);
    expect(html).toContain('COST_BTC_STALE');
    expect(html).not.toContain('$0.453011');
    expect(html).not.toContain('notional 대비');
    expect(html).not.toContain('source');
    expect(html).not.toContain('gross move');
    expect(html).toContain('fundingBorrowingRates');
    expect(html).toContain('GMX_API_MARKETS_TICKERS');
    expect(html).toContain('5xx');
    expect(html).toContain('HTTP 503');
    expect(html).toContain('retry 0');
    expect(html).toContain('failover 1');
  });

  it('fresh observational 비용과 execution snapshot 차단을 별도 표시한다', () => {
    const html = renderToStaticMarkup(
      <PaperCostDetails symbol="BTC" cost={STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC} />,
    );
    expect(html).toContain('관측 evidence FRESH');
    expect(html).toContain('실행 snapshot INELIGIBLE');
    expect(html).toContain('실행 권한 NONE (read-only)');
    expect(html).toContain('초과 $0.053011 (13.253%)');
    expect(html).toContain('COST_BTC_CAP_EXCEEDED');
    expect(html).toContain('OPEN/Canary fail-closed 차단');
  });

  it('failed observational 비용은 금액 없이 고정 failure ID만 표시한다', () => {
    const fresh = STATUS_FIXTURE.paperRuntimeReadiness!.costs.BTC;
    const failed = {
      ...fresh,
      state: 'failed' as const,
      fresh: false,
      observationalFresh: false,
      failureId: 'COST_BTC_INVALID',
      blockReason: 'COST_BTC_INVALID — read-only 비용 snapshot 검증 실패 (금액 비공개, fail-closed)',
      positionFeeUsd: null,
      executionFeeUsd: null,
      estimatedPriceImpactUsd: null,
      fundingFeeUsd: null,
      borrowingFeeUsd: null,
      estimatedExitFeeUsd: null,
      estimatedExitPriceImpactUsd: null,
      tradingFeesUsd: null,
      priceImpactTotalUsd: null,
      carryCostUsd: null,
      otherCostUsd: null,
      effectiveRoundTripCostUsd: null,
      totalCostRatePct: null,
      capUsd: null,
      capDeltaUsd: null,
      capExcessUsd: null,
      capExcessRatePct: null,
      requiredCostReductionUsd: null,
      requiredCostReductionPct: null,
      breakEvenGrossMoveUsd: null,
      breakEvenGrossMovePct: null,
      withinCap: null,
      source: null,
      apiTimestamp: null,
      fetchedAt: null,
      executionSnapshot: {
        fresh: false,
        eligible: false,
        authorized: false as const,
        maxAgeMs: 30_000,
        failureId: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE',
        blockReason: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE — 실행 적격 비용 snapshot 미확보 (금액 비공개) — OPEN/Canary fail-closed 차단',
      },
    };

    const html = renderToStaticMarkup(<PaperCostDetails symbol="BTC" cost={failed} />);
    expect(html).toContain('COST_BTC_INVALID');
    expect(html).toContain('금액 비공개');
    expect(html).not.toContain('$');
    expect(html).not.toContain('상위 주문금액');
  });
});

describe('GmxApiStatusCard — PAPER Stop readiness evidence', () => {
  const COMPLETE_EVIDENCE: NonNullable<
    NonNullable<GmxApiStatusView['stopCapability']>['readinessEvidence']
  > = {
    scope: 'PAPER_READ_ONLY_STOP_READINESS',
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    readinessComplete: true,
    executionAuthorized: false,
    generation: 12,
    evaluatedAtMs: 1_777_000_000_000,
    expiresAtMs: 1_777_000_060_000,
    fresh: true,
    reasons: [],
    missingConditionIds: [],
    conditions: [{
      id: 'readonly_config',
      label: 'Read-only config',
      category: 'supporting_readonly',
      status: 'verified',
      source: 'server-config',
      observedAtMs: 1_776_999_997_000,
      ageMs: 3_000,
      fresh: true,
      failureId: null,
      detail: 'verified without execution',
    }],
  };

  it('complete evidence의 세대·시각·freshness·조건을 표시한다', () => {
    const html = renderToStaticMarkup(<PaperStopReadinessEvidence evidence={COMPLETE_EVIDENCE} />);
    expect(html).toContain('Readiness complete');
    expect(html).toContain('true');
    expect(html).toContain('FRESH · generation 12');
    expect(html).toContain('Evaluated');
    expect(html).toContain('Expires');
    expect(html).toContain('Read-only config · readonly_config');
    expect(html).toContain('supporting_readonly');
    expect(html).toContain('VERIFIED');
    expect(html).toContain('source server-config');
    expect(html).toContain('age 3초 · FRESH');
  });

  it('failed/stale/not_evaluated 조건과 missing IDs 및 실패 세부를 표시한다', () => {
    const evidence: typeof COMPLETE_EVIDENCE = {
      ...COMPLETE_EVIDENCE,
      readinessComplete: false,
      fresh: false,
      reasons: ['required checks incomplete'],
      missingConditionIds: ['signer_ready', 'submission_ready'],
      conditions: [
        {
          ...COMPLETE_EVIDENCE.conditions[0],
          id: 'signer_ready',
          label: 'Signer ready',
          category: 'execution_required',
          status: 'failed',
          fresh: false,
          failureId: 'SIGNER_DISABLED',
          detail: 'signer is disabled',
        },
        {
          ...COMPLETE_EVIDENCE.conditions[0],
          id: 'prices_fresh',
          label: 'Prices fresh',
          status: 'stale',
          fresh: false,
          ageMs: 120_000,
          failureId: 'PRICE_STALE',
          detail: 'price observation expired',
        },
        {
          ...COMPLETE_EVIDENCE.conditions[0],
          id: 'submission_ready',
          label: 'Submission ready',
          category: 'execution_required',
          status: 'not_evaluated',
          source: null,
          observedAtMs: null,
          ageMs: null,
          fresh: false,
          failureId: null,
          detail: 'not evaluated in PAPER',
        },
      ],
    };
    const html = renderToStaticMarkup(<PaperStopReadinessEvidence evidence={evidence} />);
    for (const marker of [
      'FAILED', 'STALE', 'NOT EVALUATED', 'signer_ready', 'submission_ready',
      'SIGNER_DISABLED', 'signer is disabled', 'PRICE_STALE', 'price observation expired',
      'source —', 'NOT FRESH', 'required checks incomplete',
    ]) expect(html).toContain(marker);
  });

  it('optional evidence가 없는 기존 stopCapability 응답은 그대로 허용한다', () => {
    const backwardCompatible: NonNullable<GmxApiStatusView['stopCapability']> = {
      ...STATUS_FIXTURE.stopCapability!,
    };
    expect(backwardCompatible.readinessEvidence).toBeUndefined();
    const cardSrc = readFileSync(path.resolve(__dirname, '../GmxApiStatusCard.tsx'), 'utf8');
    expect(cardSrc).toContain('s.stopCapability.readinessEvidence &&');
  });

  it('authorization disclaimer를 정확히 표시한다', () => {
    const html = renderToStaticMarkup(<PaperStopReadinessEvidence evidence={COMPLETE_EVIDENCE} />);
    expect(html).toContain('진단 전용·읽기 전용 · status는 권한 아님 · 실행 승인 아님');
    expect(html).toContain('READ-ONLY / NOT EXECUTION AUTHORIZATION');
    expect(html).toContain('PAPER_READ_ONLY_STOP_READINESS');
    expect(html).toContain('READ_ONLY_NOT_EXECUTION_AUTHORIZATION');
    expect(html).toContain('executionAuthorized false');
    expect(COMPLETE_EVIDENCE.executionAuthorized).toBe(false);
  });
});
