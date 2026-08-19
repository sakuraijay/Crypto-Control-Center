/**
 * #135 — Manual Controlled Canary 기본 의존성 배선 (production 구현).
 *
 * 전부 기존 검증된 모듈을 재사용한다. preflight 경로는 read-only만 —
 * 주문·서명·키 복호화·설정 변경을 유발하는 함수는 executeOrder/closePosition/
 * runEmergencyClose 3개뿐이며, 이는 execute 단계에서만 호출된다.
 * Secret/PIN/키/RPC URL은 어떤 반환값에도 포함되지 않는다.
 */
import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { getAddress } from 'viem';

import type { ManualCanaryDeps, CheckOutcome } from './manualCanary';
import { __canaryStateAccess } from './manualCanary';
import { verifySdkRouterPin } from './gmxLivePreflight';
import { getDeploymentVerificationState, getCanonicalSnapshot } from './relayActivationStatus';
import { getActiveReadySession } from './ownerApprovalSession';
import { getUsdcAllowanceForSpender } from './gmxSubaccount';
import { resolveSdkSyntheticsRouter, EXPECTED_CANARY_SIGNER, CANARY_ALLOWANCE_AMOUNT_UNITS } from './canaryAllowanceInfo';
import { countBlockingIntentsOrNull, listRecentIntents } from './executionIntents';
import { countOpenRelayTasksOrNull, listUnresolvedTasks } from './relayLifecycle';
import {
  fetchLiveCostSnapshot,
  recordExecutionEligibleCostEvidence,
  validateExecutionEligibleSnapshot,
  type FetchedCostFields,
} from './costSnapshot';
import { resolveIndexTokenDecimals } from './indexTokenDecimals';
import { MARKET_BY_SYMBOL_SERVER } from './gmxMarkets';
import { isLiveTestExecutionLocked } from './liveTestGate';
import { getStoredPublicSignerAddress, isManualCanarySignerRestoreAllowed } from './delegatedSigner';
import {
  executeLiveTestOrder, closeLiveTestPosition, fetchAuthoritativeOpenPositions,
  getStopExecutionCapability, fetchOnchainErc20Decimals,
} from '../workers/liveTestExecutor';
import { runEmergencyClose } from '../workers/protectionExecutor';
import { workerManager } from '../workers/aiWorker';
import { db as _db, executionIntentsTable, protectionOrdersTable, tradesTable } from '@workspace/db';
import { buildFreshExecutionCostBreakdown } from './manualCanaryCostFetcher';

const ARBITRUM_CHAIN_ID = 42161;

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
      try {
        const owner = process.env.GMX_WALLET_ADDRESS ?? null;
        const session = await getActiveReadySession({
          expectedOwner: owner ? getAddress(owner) : null,
          expectedSubaccount: getAddress(EXPECTED_CANARY_SIGNER),
          canonicalNonce: null,
        });
        if (!session) return outcome(false, 'READY Owner Approval 없음 — 새 Prepare+MetaMask 서명 필요');
        if (session.maxAllowedCount !== '8') return outcome(false, `maxAllowedCount ${session.maxAllowedCount} ≠ 8`);
        const deadlineMs = Number(session.deadline) * 1000;
        if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
          return outcome(false, 'Owner Approval deadline 만료 — 자동 사용 금지, 새 Prepare+서명 필요');
        }
        const expiresMs = Number(session.expiresAt) * 1000;
        if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
          return outcome(false, 'Owner Approval expiresAt 경과 — 새 Prepare+서명 필요');
        }
        return outcome(true, `READY 세션 유효 (nonce ${session.approvalNonce}, deadline까지 ${Math.floor((deadlineMs - nowMs) / 1000)}s)`);
      } catch {
        return outcome(false, 'Owner Approval 조회 실패 (fail-closed)');
      }
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

    // close 크기 결속용 — authoritative 온체인 포지션 실측 (실패=null, fail-closed)
    openPositions: async () => {
      const positions = await fetchAuthoritativeOpenPositions();
      return positions === null ? null
        : positions.map(p => ({ marketAddress: p.marketAddress, isLong: p.isLong, sizeUsd: p.sizeUsd }));
    },

    costSnapshot: async ({ symbol, isLong, notionalUsd }) => {
      const market = MARKET_BY_SYMBOL_SERVER.get(symbol);
      if (!market) return { ok: false, reason: '시장 미확인' };
      const res = await fetchLiveCostSnapshot(
        { market: market.marketToken, isLong, orderType: 'MarketIncrease', notionalUsd, now: new Date() },
        {
          readonlyEnabled: process.env.GMX_API_READONLY_ENABLED === 'true',
          fetchCosts: ({ market: marketAddress, isLong: side, notionalUsd: size }) =>
            fetchMeasuredCanaryCosts({ market: marketAddress, symbol, isLong: side, notionalUsd: size }),
        },
      );
      if (!res.ok) return { ok: false, reason: res.reason };
      const expected = { market: market.marketToken, isLong, orderType: 'MarketIncrease' as const, notionalUsd };
      const v = validateExecutionEligibleSnapshot(
        res.snapshot,
        expected,
        Date.now(),
      );
      if (!v.ok) return { ok: false, reason: v.reason };
      recordExecutionEligibleCostEvidence(res.snapshot, expected, Date.now());
      return { ok: true, snapshot: res.snapshot, roundTripCostUsd: v.effectiveRoundTripCostUsd };
    },

    decimalsReady: async (symbol: string) => {
      const market = MARKET_BY_SYMBOL_SERVER.get(symbol);
      if (!market) return outcome(false, '시장 미확인');
      try {
        const r = await resolveIndexTokenDecimals({
          chainId: ARBITRUM_CHAIN_ID, marketAddress: market.marketToken,
          fetchOnchainDecimals: fetchOnchainErc20Decimals,
        });
        return r.ok ? outcome(true, 'SDK+온체인 교차검증 완료') : outcome(false, r.reason);
      } catch {
        return outcome(false, 'decimals 검증 실패 (fail-closed)');
      }
    },

    stopCapability: async () => {
      const cap = getStopExecutionCapability();
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

/** readiness/refresh 전용 — decimals와 30초 비용 증거만 read-only로 갱신한다. */
export async function refreshManualCanaryReadonlyEvidence(): Promise<{
  decimals: Record<string, CheckOutcome>;
  costs: Record<string, { ok: boolean; reason: string | null }>;
}> {
  const deps = buildDefaultCanaryDeps();
  const decimals: Record<string, CheckOutcome> = {};
  const costs: Record<string, { ok: boolean; reason: string | null }> = {};
  for (const symbol of MANUAL_CANARY_REFRESH_SYMBOLS) {
    decimals[symbol] = await deps.decimalsReady(symbol);
    const cost = await deps.costSnapshot({
      symbol,
      isLong: true,
      notionalUsd: 20,
    });
    costs[symbol] = { ok: cost.ok, reason: cost.ok ? null : cost.reason };
  }
  return { decimals, costs };
}

const MANUAL_CANARY_REFRESH_SYMBOLS = ['BTC', 'ETH'] as const;
