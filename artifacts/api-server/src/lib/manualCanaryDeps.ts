/**
 * #135 — Manual Controlled Canary 기본 의존성 배선 (production 구현).
 *
 * 전부 기존 검증된 모듈을 재사용한다. preflight 경로는 read-only만 —
 * 주문·서명·키 복호화·설정 변경을 유발하는 함수는 실행 단계에서만 호출된다.
 * Secret/PIN/키/RPC URL은 어떤 반환값에도 포함되지 않는다.
 */
import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { getAddress } from 'viem';

import type { ManualCanaryDeps, CheckOutcome } from './manualCanary';
import { __canaryStateAccess } from './manualCanary';
import { verifySdkRouterPin } from './gmxLivePreflight';
import { getDeploymentVerificationState, getCanonicalSnapshot } from './relayActivationStatus';
import { getUsdcAllowanceForSpender } from './gmxSubaccount';
import { resolveSdkSyntheticsRouter, EXPECTED_CANARY_SIGNER, CANARY_ALLOWANCE_AMOUNT_UNITS } from './canaryAllowanceInfo';
import { countBlockingIntentsOrNull, listRecentIntents } from './executionIntents';
import { countOpenRelayTasksOrNull, listUnresolvedTasks } from './relayLifecycle';
import {
  fetchLiveCostSnapshot,
  validateExecutionEligibleSnapshot,
  type CostSnapshot,
  type CostSnapshotExpectation,
  type FetchedCostFields,
} from './costSnapshot';
import { activateManualCanaryExecutionEvidence } from './manualCanaryExecutionEvidence';
import { resolveIndexTokenDecimals } from './indexTokenDecimals';
import { MARKET_BY_SYMBOL_SERVER } from './gmxMarkets';
import { isLiveTestExecutionLocked } from './liveTestGate';
import { getStoredPublicSignerAddress, isManualCanarySignerRestoreAllowed } from './delegatedSigner';
import {
  executeLiveTestOrder, closeLiveTestPosition, fetchAuthoritativeOpenPositions,
  evaluateManualCanaryStopCapability, refreshStopExecutionCapability, isStopExecutionAvailable,
  fetchOnchainErc20Decimals, fetchOnchainCodePresence,
} from '../workers/liveTestExecutor';
import { runEmergencyClose } from '../workers/protectionExecutor';
import { workerManager } from '../workers/aiWorker';
import { db as _db, executionIntentsTable, protectionOrdersTable, tradesTable } from '@workspace/db';
import { buildFreshExecutionCostBreakdown } from './manualCanaryCostFetcher';
import { checkManualCanaryOwnerApproval } from './manualCanaryOwnerApproval';
import { checkGitHubCiAttestation } from './githubCiAttestation';

const ARBITRUM_CHAIN_ID = 42161;
const MANUAL_CANARY_REFRESH_SYMBOLS = ['BTC', 'ETH'] as const;

function outcome(ok: boolean, detail: string): CheckOutcome { return { ok, detail }; }

let injectedCostFetcher: ((args: {
  market: string; symbol: string; isLong: boolean; notionalUsd: number;
}) => Promise<FetchedCostFields>) | null = null;

export function __setManualCanaryCostFetcherForTests(
  fetcher: typeof injectedCostFetcher,
): void {
  injectedCostFetcher = fetcher;
}

async function fetchMeasuredCanaryCosts(args: {
  market: string; symbol: string; isLong: boolean; notionalUsd: number;
}): Promise<FetchedCostFields> {
  if (injectedCostFetcher) return injectedCostFetcher(args);
  const c = await buildFreshExecutionCostBreakdown({
    marketToken: args.market,
    symbol: args.symbol,
    isLong: args.isLong,
    notionalUsd: args.notionalUsd,
    holdingHours: 1,
  });
  const d = c?.impactDetail;
  const required = [
    c?.entryFeeUsd, c?.estimatedExitFeeUsd, c?.fundingCostUsd,
    c?.borrowingCostUsd, c?.gasExecutionFeeUsd, c?.costSnapshotFetchedAtMs,
  ];
  if (!c || !d || required.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('공식 GMX 비용 성분 일부 미확보 — 실행 적격 스냅샷 생성 금지');
  }
  return {
    positionFeeUsd: c.entryFeeUsd!,
    executionFeeUsd: c.gasExecutionFeeUsd!,
    estimatedPriceImpactUsd: Math.max(0, -d.entryImpactUsd),
    fundingFeeUsd: c.fundingCostUsd!,
    borrowingFeeUsd: c.borrowingCostUsd!,
    estimatedExitFeeUsd: c.estimatedExitFeeUsd!,
    estimatedExitPriceImpactUsd: Math.max(0, -d.exitImpactUsd),
    fundingRatePerHourFraction: c.fundingCostUsd! / args.notionalUsd,
    borrowingRatePerHourFraction: c.borrowingCostUsd! / args.notionalUsd,
    blockNumber: null,
    apiTimestamp: new Date(c.costSnapshotFetchedAtMs!).toISOString(),
  };
}

async function resolveCanarySymbolDecimals(symbol: string): Promise<CheckOutcome> {
  const market = MARKET_BY_SYMBOL_SERVER.get(symbol);
  if (!market) return outcome(false, `${symbol} 시장 미확인`);
  try {
    const r = await resolveIndexTokenDecimals({
      chainId: ARBITRUM_CHAIN_ID,
      marketAddress: market.marketToken,
      fetchOnchainDecimals: fetchOnchainErc20Decimals,
      fetchOnchainCode: fetchOnchainCodePresence,
    });
    return r.ok
      ? outcome(true, `${symbol} SDK+온체인 교차검증 완료`)
      : outcome(false, `${symbol}: ${r.reason}`);
  } catch {
    return outcome(false, `${symbol} decimals 검증 실패 (fail-closed)`);
  }
}

/**
 * PAPER runtime 진단과 Manual Canary preflight가 공유하는 순수 read-only 비용 조회.
 *
 * 이 함수에는 DB, signer, preflight token, intent/order/protection 생성, 서명·제출
 * 능력이 없다. 실행 직전 전용 recordExecutionEligibleCostEvidence도 호출하지 않는다.
 */
export async function fetchManualCanaryReadonlyCost(args: {
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
}): Promise<
  | { ok: true; snapshot: CostSnapshot; roundTripCostUsd: number }
  | { ok: false; reason: string }
> {
  const market = MARKET_BY_SYMBOL_SERVER.get(args.symbol);
  if (!market) return { ok: false, reason: '시장 미확인' };
  const res = await fetchLiveCostSnapshot(
    {
      market: market.marketToken,
      isLong: args.isLong,
      orderType: 'MarketIncrease',
      notionalUsd: args.notionalUsd,
      now: new Date(),
    },
    {
      readonlyEnabled: process.env.GMX_API_READONLY_ENABLED === 'true',
      fetchCosts: ({ market: marketAddress, isLong: side, notionalUsd: size }) =>
        fetchMeasuredCanaryCosts({
          market: marketAddress,
          symbol: args.symbol,
          isLong: side,
          notionalUsd: size,
        }),
    },
  );
  if (!res.ok) return { ok: false, reason: res.reason };
  const expected = {
    market: market.marketToken,
    isLong: args.isLong,
    orderType: 'MarketIncrease' as const,
    notionalUsd: args.notionalUsd,
  };
  const validated = validateExecutionEligibleSnapshot(res.snapshot, expected, Date.now());
  if (!validated.ok) return { ok: false, reason: validated.reason };
  return {
    ok: true,
    snapshot: res.snapshot,
    roundTripCostUsd: validated.effectiveRoundTripCostUsd,
  };
}

export function buildDefaultCanaryDeps(): ManualCanaryDeps {
  return {
    now: () => new Date(),
    randomId: () => crypto.randomUUID(),

    routerPin: () => {
      const r = verifySdkRouterPin();
      return outcome(r.ok, r.ok ? 'SDK router pin 일치' : (r.reason ?? 'router pin 검증 실패'));
    },

    deploymentVerified: () => {
      const dv = getDeploymentVerificationState();
      return outcome(dv.ok, dv.ok ? `manifest v${dv.manifestVersion} 검증됨` : (dv.failures[0] ?? '배포 코드 검증 미수행 — readiness refresh 필요'));
    },

    // 암호문/메타/공개주소 존재 + 기대 signer 주소 결속만 — 복호화 0회
    signerBinding: async () => {
      try {
        const keys = ['delegatedSignerEncryptedKey', 'delegatedSignerMeta', 'delegatedSignerPublicAddress'];
        const found = new Map<string, string>();
        for (const k of keys) {
          const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, k));
          if (rows[0]?.value) found.set(k, rows[0].value);
        }
        if (!found.has('delegatedSignerEncryptedKey') || !found.has('delegatedSignerMeta')) {
          return outcome(false, 'signer 암호문/메타 부재 — 프로비저닝 필요');
        }
        const pubRes = await getStoredPublicSignerAddress(EXPECTED_CANARY_SIGNER);
        const pub = pubRes.ok ? pubRes.address : (found.get('delegatedSignerPublicAddress') ?? null);
        if (!pub) return outcome(false, 'signer 공개주소 부재');
        if (getAddress(pub) !== getAddress(EXPECTED_CANARY_SIGNER)) {
          return outcome(false, 'signer 공개주소가 기대 canary signer와 불일치');
        }
        return outcome(true, '암호문+공개주소 결속 확인 (복호화 0회)');
      } catch {
        return outcome(false, 'signer 결속 조회 실패 (fail-closed)');
      }
    },

    ownerApproval: async (nowMs: number) => {
      return checkManualCanaryOwnerApproval(
        nowMs,
        process.env.GMX_WALLET_ADDRESS ?? null,
      );
    },

    allowance: async () => {
      try {
        const main = process.env.GMX_WALLET_ADDRESS;
        const router = resolveSdkSyntheticsRouter();
        if (!main || !router) return outcome(false, 'main/router 미구성');
        const units = await getUsdcAllowanceForSpender(main, router);
        if (units === null) return outcome(false, 'allowance 조회 실패');
        return units >= CANARY_ALLOWANCE_AMOUNT_UNITS
          ? outcome(true, `allowance ${Number(units) / 1e6} USDC ≥ 15`)
          : outcome(false, `allowance ${Number(units) / 1e6} USDC < 15`);
      } catch {
        return outcome(false, 'allowance 조회 실패 (fail-closed)');
      }
    },

    gmxApiReadonly: () => outcome(
      process.env.GMX_API_READONLY_ENABLED === 'true',
      process.env.GMX_API_READONLY_ENABLED === 'true' ? 'read-only 활성' : 'GMX_API_READONLY_ENABLED ≠ true',
    ),

    rpcHealthy: async () => {
      const snap = getCanonicalSnapshot();
      if (!snap) return outcome(false, 'canonical readback 스냅샷 없음 — readiness refresh 필요');
      return outcome(snap.confirmed, snap.confirmed ? 'canonical readback 확인' : (snap.reason ?? 'RPC 미확인'));
    },

    reconciliationClean: async () => {
      const intents = await countBlockingIntentsOrNull();
      const tasks = await countOpenRelayTasksOrNull();
      if (intents === null || tasks === null) return outcome(false, 'DB 조회 실패 (fail-closed)');
      const unresolved = (await listUnresolvedTasks(10)).length;
      let blockingProtections = 0;
      try {
        const rows = await _db.select({ status: protectionOrdersTable.status }).from(protectionOrdersTable);
        blockingProtections = rows.filter(r => !['ACTIVE', 'EXECUTED', 'CANCELLED', 'FAILED', 'SUPERSEDED'].includes(r.status)).length;
      } catch {
        return outcome(false, '보호 주문 조회 실패 (fail-closed)');
      }
      const bad = intents > 0 || tasks > 0 || unresolved > 0 || blockingProtections > 0;
      return outcome(!bad, bad
        ? `미종결 존재 — intents ${intents}, tasks ${tasks}, unresolved ${unresolved}, protections ${blockingProtections}`
        : '미종결 intent/task/protection 0');
    },

    openPositionCount: async () => {
      const positions = await fetchAuthoritativeOpenPositions();
      return positions === null ? null : positions.length;
    },

    // close 결속용 — authoritative 온체인 포지션 실측, full identity 포함 (실패=null, fail-closed)
    openPositions: async () => {
      const positions = await fetchAuthoritativeOpenPositions();
      if (positions === null) return null;
      if (positions.some((p) =>
        typeof p.positionKey !== 'string'
        || typeof p.accountAddress !== 'string'
        || typeof p.collateralToken !== 'string'
        || typeof p.sizeUsd30 !== 'string'
      )) return null;
      return positions.map(p => ({
        positionKey:     p.positionKey,
        accountAddress:  p.accountAddress,
        marketAddress:   p.marketAddress,
        collateralToken: p.collateralToken,
        isLong:          p.isLong,
        sizeUsd:         p.sizeUsd,
        sizeUsd30:       p.sizeUsd30,
      })) as Array<{
        positionKey: string; accountAddress: string; marketAddress: string;
        collateralToken: string; isLong: boolean; sizeUsd: number; sizeUsd30: string;
      }>;
    },

    /**
     * #142: read-only costSnapshot — preflight 경로는 recordExecutionEligibleCostEvidence
     * 를 호출하지 않는다. 실행 직전 비용 증거 기록은 recordCostEvidenceForExecution 전용.
     */
    costSnapshot: fetchManualCanaryReadonlyCost,

    canaryDecimalsReady: async () => {
      const results = await Promise.all(
        MANUAL_CANARY_REFRESH_SYMBOLS.map(resolveCanarySymbolDecimals),
      );
      const failed = results.filter((r) => !r.ok);
      return failed.length === 0
        ? outcome(true, 'BTC+ETH SDK+온체인 교차검증 완료')
        : outcome(false, failed.map((r) => r.detail).join('; '));
    },

    stopCapability: async ({ freshCostSnapshotAvailable }) => {
      const cap = await evaluateManualCanaryStopCapability(freshCostSnapshotAvailable);
      return outcome(cap.available, cap.available ? 'stop 실행 능력 확인' : (cap.reasons[0] ?? 'stop 실행 능력 없음'));
    },

    // 시세: aiWorker priceBuffer 최신값 (per-symbol 수신 시각, 60s 초과=stale → null)
    currentPriceUsd: async (symbol: string) => {
      try {
        const q = workerManager.getPriceQuote(symbol);
        if (!q || q.ageMs > 60_000) return null;
        return q.priceUsd;
      } catch { return null; }
    },

    // 누적 손실: test_mode=true CLOSE 거래 중 pnl<0의 절댓값 합 (aiWorker와 동일 규칙)
    accumCanaryLossUsd: async () => {
      try {
        const rows = await _db.select({
          action: tradesTable.action, pnl: tradesTable.pnl, testMode: tradesTable.testMode,
        }).from(tradesTable).where(eq(tradesTable.testMode, true));
        const lossUsd = rows
          .filter(t => t.action === 'CLOSE' && parseFloat(t.pnl ?? '0') < 0)
          .reduce((s, t) => s + Math.abs(parseFloat(t.pnl ?? '0')), 0);
        return { ok: true, lossUsd };
      } catch {
        return { ok: false, lossUsd: null };
      }
    },

    marketAddress: (symbol: string) => MARKET_BY_SYMBOL_SERVER.get(symbol)?.marketToken ?? null,
    mainAddress: () => process.env.GMX_WALLET_ADDRESS ?? '',
    liveTestMode: () => isManualCanarySignerRestoreAllowed(process.env).allowed,

    /**
     * #142/#143: build-bound public Actions attestation. No GitHub credential is
     * read; unavailable/mismatch/timeout remains UNATTESTED fail-closed.
     */
    githubCiAttestation: () => checkGitHubCiAttestation(),

    envSubmissionState: () => {
      const locked = isLiveTestExecutionLocked();
      const manual = isManualCanarySignerRestoreAllowed(process.env);
      const submissionEnabled = manual.allowed;
      return {
        locked, submissionEnabled,
        detail: locked
          ? 'LIVE_TEST_EXECUTION_LOCKED=true — 실행 시 시뮬레이션만 (실제 주문 0건)'
          : submissionEnabled
            ? '수동 GMX API Canary 제출 활성 (Worker PAPER·AUTO LIVE 비활성)'
            : `수동 Canary 제출 조건 미충족: ${manual.missing.join(', ')}`,
      };
    },

    /**
     * #142: 실행 직전 전용 비용 증거 기록 — executeOrder 바로 직전에만 호출.
     * preflight costSnapshot 경로(read-only)와 분리되어 구조적으로 독립.
     * 기록 실패 시 호출자(executeManualCanaryOpen)가 fail-closed (제출 0회).
     */
    recordCostEvidenceForExecution: async (
      snapshot: CostSnapshot,
      args: CostSnapshotExpectation,
      nowMs: number,
    ): Promise<boolean> => {
      return activateManualCanaryExecutionEvidence(snapshot, args, nowMs, {
        refreshStopCapability: refreshStopExecutionCapability,
        isStopCapabilityAvailable: isStopExecutionAvailable,
      });
    },

    executeOrder: executeLiveTestOrder,
    closePosition: closeLiveTestPosition,

    // 단일 emergency close — authoritative 포지션 증거 기반 (runProtectionPass와 동일 규칙)
    runEmergencyClose: async (openIntentId: string) => {
      try {
        const positions = await fetchAuthoritativeOpenPositions();
        if (positions === null) return outcome(false, 'authoritative 포지션 조회 실패 — 제출 0회 (fail-closed)');
        if (positions.length === 0) return outcome(false, '열린 포지션 없음 — emergency close 불필요');
        const p = positions[0];
        const positionKey = `${p.marketAddress.toLowerCase()}:${p.isLong ? 'L' : 'S'}`;
        const r = await runEmergencyClose({
          parentOpenIntentId: openIntentId, positionKey,
          symbol: p.marketAddress, marketAddress: p.marketAddress, isLong: p.isLong,
          fullSizeUsd: p.sizeUsd, reason: '#135 manual canary emergency close (운영자 요청)',
          manualCanary: true,
        });
        return outcome(r.ok, r.ok ? 'emergency close 제출' : (('reason' in r && r.reason) || 'emergency close 실패'));
      } catch {
        return outcome(false, 'emergency close 실행 실패');
      }
    },

    intentStatus: async (intentId: string) => {
      try {
        const rows = await _db.select().from(executionIntentsTable).where(eq(executionIntentsTable.id, intentId));
        const row = rows[0];
        return row ? { status: row.status, orderKey: row.orderKey ?? null, txHash: row.txHash ?? null } : null;
      } catch { return null; }
    },

    initialStopStatus: async (openIntentId: string) => {
      try {
        const rows = await _db.select().from(protectionOrdersTable)
          .where(eq(protectionOrdersTable.parentOpenIntentId, openIntentId));
        const stop = rows.find(r => r.purpose === 'INITIAL_STOP');
        return { status: stop?.status ?? null, orderKey: stop?.orderKey ?? null };
      } catch { return { status: null, orderKey: null }; }
    },

    loadState: __canaryStateAccess.loadWorkerState,
    casState: __canaryStateAccess.casWorkerState,
  };
}

/** readiness/refresh 전용 — decimals와 비용 스냅샷 가용성만 read-only로 확인한다. */
export async function refreshManualCanaryReadonlyEvidence(): Promise<{
  decimals: Record<string, CheckOutcome>;
  costs: Record<string,
    | { ok: true; reason: null; snapshot: CostSnapshot; roundTripCostUsd: number }
    | { ok: false; reason: string; snapshot: null; roundTripCostUsd: null }
  >;
}> {
  const decimals: Record<string, CheckOutcome> = {};
  const costs: Record<string,
    | { ok: true; reason: null; snapshot: CostSnapshot; roundTripCostUsd: number }
    | { ok: false; reason: string; snapshot: null; roundTripCostUsd: null }
  > = {};
  for (const symbol of MANUAL_CANARY_REFRESH_SYMBOLS) {
    decimals[symbol] = await resolveCanarySymbolDecimals(symbol);
    const cost = await fetchManualCanaryReadonlyCost({
      symbol,
      isLong: true,
      notionalUsd: 20,
    });
    costs[symbol] = cost.ok
      ? {
        ok: true,
        reason: null,
        snapshot: cost.snapshot,
        roundTripCostUsd: cost.roundTripCostUsd,
      }
      : {
        ok: false,
        reason: cost.reason,
        snapshot: null,
        roundTripCostUsd: null,
      };
  }
  return { decimals, costs };
}
