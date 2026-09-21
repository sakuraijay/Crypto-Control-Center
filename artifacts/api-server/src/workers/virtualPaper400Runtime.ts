import { advanceVirtualDiagnostics, virtualDiagnosticsKey } from './virtualPaper400Diagnostics';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import { discoverVirtualGmxUniverse, selectVirtualAnalysisBatch, VIRTUAL_GMX_SYMBOLS } from '../lib/virtualGmxUniverse';
import { VIRTUAL_ACTIVE_POLICY, VIRTUAL_LEGACY_POLICY } from './virtualPaper400Policy';
import { readTradingMode, tradingModeKey, MODE_VERSION, MODE_DECISION_PREFIX } from './virtualPaperTradingMode';
import { eq, sql } from 'drizzle-orm';
import { evaluateVirtualPaper400SessionState, VIRTUAL_PAPER_400_SESSION_STATE_KEY, VIRTUAL_PAPER_400_LOCK_ID } from './virtualPaper400SessionState';
import { initialVirtualPaper400RiskState, parseVirtualPaper400RiskState, virtualPaper400RiskKey,
  evaluateVirtualPaper400Account } from './virtualPaper400Accounting';
import { runVirtualPaper400Cycle } from './virtualPaper400Cycle';
import { openServerPaperPosition, closeServerPaperPosition, reduceServerPaper70,
  getServerPaperStatus, type PriceLookup } from './serverPaperExecutor';
import { storePaperCostSnapshot } from '../lib/paperCostCache';
import { sanitizeCostError, type CostSnapshot } from '../lib/costSnapshot';
import { virtualPaper400Activity as activity } from './virtualPaper400Activity';
import {
  advanceVirtualPaper400StrategyContinuity,
  filterNewVirtualPaper400StrategyRecords,
  restoreVirtualPaper400StrategyContinuity,
  summarizeVirtualPaper400StrategyContinuity,
  virtualPaper400StrategyContinuityKey,
  type VirtualPaper400StrategyContinuityRestore,
} from './virtualPaper400StrategyContinuity';

export const VIRTUAL_PAPER_400_RUNTIME_KEY = 'virtual_paper_400_runtime_v1';
// Shared with START/STOP. This is a coordination lock, not a trading permission.

/** Returns false only for an absent session. A stopped/invalid virtual session
 * must not silently fall back to Standard entries. No financial modules are called. */
export async function maybeRunVirtualPaper400Cycle(args: {
  cycleNumber: number; quote: PriceLookup; shouldContinue(): boolean;
}): Promise<boolean> {
  const { db, workerStateTable, tradesTable } = await import('@workspace/db');
  const observed = await db.select().from(workerStateTable)
    .where(eq(workerStateTable.key, VIRTUAL_PAPER_400_SESSION_STATE_KEY)).limit(2);
  if (observed.length === 0) return false;
  if (observed.length !== 1) throw new Error('VIRTUAL_SESSION_DUPLICATE');
  let activityRun: number | null = null;
  let activityOutcome: { status: string; reason: string | null } | null = null;
  try {
  await db.transaction(async tx => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${VIRTUAL_PAPER_400_LOCK_ID}) AS acquired`);
    if (lock.rows[0]?.acquired !== true) return;
    const read = async (key: string) => {
      const rows = await tx.select().from(workerStateTable).where(eq(workerStateTable.key, key)).limit(2);
      if (rows.length > 1) throw new Error('VIRTUAL_STATE_DUPLICATE');
      return rows[0]?.value ?? null;
    };
    const write = async (key: string, value: unknown) => {
      if (!args.shouldContinue()) throw new Error('VIRTUAL_WORKER_STOPPED');
      const updatedAt = new Date();
      await db.insert(workerStateTable).values({ key, value: JSON.stringify(value), updatedAt })
        .onConflictDoUpdate({ target: workerStateTable.key,
          set: { value: JSON.stringify(value), updatedAt } });
    };
    const raw = await read(VIRTUAL_PAPER_400_SESSION_STATE_KEY);
    const session = evaluateVirtualPaper400SessionState(raw);
    if (!session.state) throw new Error('VIRTUAL_SESSION_INVALID');
    if ((process.env.WORKER_ENGINE_MODE ?? 'PAPER') !== 'PAPER') throw new Error('VIRTUAL_PAPER_MODE_REQUIRED');
    const identity = session.state.session;
    const run = activity.begin(identity.sessionId, args.cycleNumber);
    activityRun = run;
    const riskKey = virtualPaper400RiskKey(identity);
    const loadTrades = () => db.select().from(tradesTable).where(eq(tradesTable.strategy, identity.strategyTag));
    const rows = await loadTrades();
    const riskRaw = await read(riskKey);
    // Missing risk state may initialize only a completely unused virtual ledger.
    if (riskRaw === null && rows.length !== 0) throw new Error('VIRTUAL_RISK_STATE_MISSING_WITH_HISTORY');
    const previous = riskRaw === null ? initialVirtualPaper400RiskState(identity)
      : parseVirtualPaper400RiskState(riskRaw, identity);
    const now = new Date();
    const policyKey = `virtual_paper_400_policy_v1:${identity.sessionId}`;
    const policyRaw = await read(policyKey);
    let applied = policyRaw ? JSON.parse(policyRaw) as { version: string; appliedAt: string; sessionId: string } : null;
    if (policyRaw !== null && (!applied || (applied.version !== VIRTUAL_ACTIVE_POLICY.version && applied.version !== VIRTUAL_LEGACY_POLICY.version) || applied.sessionId !== identity.sessionId
      || !Number.isFinite(Date.parse(applied.appliedAt)) || Date.parse(applied.appliedAt) > now.getTime())) {
      throw new Error('VIRTUAL_POLICY_INVALID');
    }
    const executor = getServerPaperStatus();
    const accountBefore = evaluateVirtualPaper400Account({ session: identity, previous, rows, now, quote: args.quote });
    const universe = session.active && accountBefore.evaluation.entryAllowed && !executor.pendingClose && !executor.unresolved
      ? await discoverVirtualGmxUniverse() : null;
    const markets = new Map((universe?.complete ? universe.markets : []).map(m => [m.name.split('/')[0], m]));
    const rotationKey = `virtual_universe_rotation_v1:${identity.sessionId}`;
    const rotationRaw = await read(rotationKey);
    let rotation: Record<string, number> = {};
    let rotationInvalid = false;
    try {
      rotation = rotationRaw === null ? {} : JSON.parse(rotationRaw);
      rotationInvalid = !rotation || typeof rotation !== 'object' || Array.isArray(rotation) || Object.entries(rotation).some(([s,t]) => !VIRTUAL_GMX_SYMBOLS.includes(s) || !Number.isFinite(t) || t < 0 || t > Date.now());
    } catch { rotationInvalid = true; }
    const symbols = universe && !rotationInvalid ? selectVirtualAnalysisBatch(universe, rotation) : [];
    const continuityKey = virtualPaper400StrategyContinuityKey(identity.sessionId);
    let continuity: VirtualPaper400StrategyContinuityRestore =
      restoreVirtualPaper400StrategyContinuity(
        await read(continuityKey), identity.sessionId, now.getTime(), VIRTUAL_GMX_SYMBOLS,
      );
    const modeKey = tradingModeKey(identity.sessionId);
    let selectedMode = readTradingMode(await read(modeKey), identity.sessionId);
    if (!selectedMode && session.active) {
      selectedMode = { version: MODE_VERSION, mode: 'INTRADAY', sessionId: identity.sessionId, updatedAt: now.toISOString() };
      await write(modeKey, selectedMode);
    }
    if (applied?.version !== VIRTUAL_ACTIVE_POLICY.version && session.active && !accountBefore.held.length && !executor.pendingClose && !executor.unresolved) {
      applied = { version: VIRTUAL_ACTIVE_POLICY.version, appliedAt: now.toISOString(), sessionId: identity.sessionId };
      await write(policyKey, applied);
    }
    let analysis: { symbol: string; reason: string }[] = [];
    let evaluatedRecords: StrategyShadowRecord[] = [];
    const costFailureBySymbol: Record<string, { long: string | null; short: string | null }> = {};
    const readCost = async (symbol: string, isLong: boolean, notionalUsd: number): Promise<CostSnapshot | null> => {
      const { fetchVirtualGmxReadonlyCost } = await import('../lib/manualCanaryReadonlyEvidence');
      const market = markets.get(symbol);
      if (!market) return null;
      const result = await fetchVirtualGmxReadonlyCost({ symbol, marketAddress: market.marketToken, isLong, notionalUsd });
      const side = isLong ? 'long' : 'short';
      costFailureBySymbol[symbol] ??= { long: null, short: null };
      if (!result.ok) {
        const reason = typeof result.reason === 'string' && result.reason.trim().length > 0
          ? result.reason : 'COST_DATA_UNAVAILABLE: 비용 공급자가 실패 사유를 제공하지 않음';
        // The provider already returns a sanitized reason, but sanitize again at
        // this public runtime boundary and bound its size. Never expose raw errors.
        costFailureBySymbol[symbol][side] = sanitizeCostError(reason).slice(0, 300);
        return null;
      }
      costFailureBySymbol[symbol][side] = null;
      // Inputs are official read-only observations; simulated fills/settlement
      // remain PAPER estimates, never observed real execution.
      return { ...result.snapshot, source: 'PAPER_GMX_ESTIMATE' };
    };
    const result = await runVirtualPaper400Cycle({ sessionRaw: raw!, policyAppliedAt: applied?.appliedAt, policyVersion: applied?.version,
      tradingMode: selectedMode?.mode, structuralTargets: true, markets,
      entryBlockedReason: executor.unresolved || executor.pendingClose ? 'EXECUTOR_RECOVERY_PENDING'
        : continuity.status === 'BLOCKED' ? continuity.reason
        : !applied ? 'POLICY_SAFE_BOUNDARY_PENDING'
        : rotationInvalid ? 'VIRTUAL_UNIVERSE_ROTATION_INVALID'
        : universe && !universe.complete ? universe.reason ?? 'UNIVERSE_UNAVAILABLE'
        : universe && !symbols.length ? 'NO_ELIGIBLE_GMX_MARKETS' : null, previous, rows, now, clock: () => new Date(),
      engineMode: process.env.WORKER_ENGINE_MODE ?? 'PAPER', quote: args.quote,
      shouldContinue: args.shouldContinue,
      persistRisk: state => write(riskKey, state),
      readCost: async (symbol, isLong, notionalUsd) => {
        activity.stage(run, 'CHECKING_ENTRY', [symbol]);
        return readCost(symbol, isLong, notionalUsd);
      },
      readSignals: async () => {
        if (getServerPaperStatus().unresolved) return [];
        const { runStrategyShadowWorkerReadOnly } = await import('../intel/intelService');
        if (!universe?.complete || !symbols.length) return [];
        await write(rotationKey, { ...rotation, ...Object.fromEntries(symbols.map(s => [s, Date.now()])) });
        activity.stage(run, 'CHECKING_COSTS', symbols);
        const notionalUsd = 100;
        const costsBySymbol: NonNullable<import('../intel/intelService').StrategyShadowWorkerReadOnlyInput['costsBySymbol']> =
          Object.fromEntries(await Promise.all(symbols.map(async symbol => {
            const market = markets.get(symbol);
            if (!market) return [symbol, null];
            const [long, short] = await Promise.all([readCost(symbol, true, notionalUsd), readCost(symbol, false, notionalUsd)]);
            return [symbol, { market: market.marketToken, notionalUsd, holdingHorizonHours: 1, long, short }];
          })));
        if (!args.shouldContinue()) return [];
        const evaluatedAt = Date.now();
        activity.stage(run, 'ANALYZING_MARKETS', symbols);
        const envelope = await runStrategyShadowWorkerReadOnly({ cycleNumber: args.cycleNumber,
          evaluatedAt, expectedSymbols: symbols, existingAi: { decisionId: `vp400-analysis:${evaluatedAt}`,
            action: 'NO_TRADE', confidence: 0, primarySymbol: null, createdAt: new Date(evaluatedAt).toISOString() },
          lifecycleSnapshot: continuity.status === 'BLOCKED' ? null : continuity.lifecycleSnapshot,
          previousRegimes: continuity.status === 'BLOCKED' ? {} : continuity.previousRegimes,
          allowedRegimeSymbols: VIRTUAL_GMX_SYMBOLS, costsBySymbol });
        const filtered = filterNewVirtualPaper400StrategyRecords(continuity, envelope, evaluatedAt);
        const acceptedEnvelope = filtered?.envelope ?? envelope;
        const nextContinuity = filtered ? advanceVirtualPaper400StrategyContinuity(
          identity.sessionId, continuity, acceptedEnvelope, evaluatedAt,
        ) : null;
        if (nextContinuity && filtered) {
          nextContinuity.lastSourceCandleCloseTimeBySymbol = filtered.cursors;
        }
        if (!nextContinuity) {
          analysis = symbols.map(symbol => ({ symbol, reason: 'STRATEGY_CONTINUITY_ADVANCE_INVALID' }));
          activity.analyzed(run, analysis.map(row => ({ ...row, evaluated: false })));
          return [];
        }
        await write(continuityKey, nextContinuity);
        evaluatedRecords = acceptedEnvelope.records;
        continuity = restoreVirtualPaper400StrategyContinuity(
          nextContinuity, identity.sessionId, evaluatedAt, VIRTUAL_GMX_SYMBOLS,
        );
        analysis = symbols.map(symbol => ({ symbol, reason: acceptedEnvelope.records.find(record => record.symbol === symbol)
          ?.reasons.join('; ') || (!costsBySymbol[symbol]?.long || !costsBySymbol[symbol]?.short
            ? `COST_UNAVAILABLE: long=${costFailureBySymbol[symbol]?.long ?? 'AVAILABLE'}; short=${costFailureBySymbol[symbol]?.short ?? 'AVAILABLE'}`
            : `ANALYSIS_${acceptedEnvelope.status}: ${acceptedEnvelope.reasons.join('; ')}`) }));
        activity.analyzed(run, analysis.map(row => ({ ...row,
          evaluated: ['EVALUATED', 'PARTIAL'].includes(acceptedEnvelope.status)
            && acceptedEnvelope.records.some(record => record.symbol === row.symbol) })));
        activity.stage(run, 'CHECKING_ENTRY', symbols);
        return ['EVALUATED', 'PARTIAL'].includes(acceptedEnvelope.status) ? acceptedEnvelope.records : [];
      },
      claim: async (id, audit) => {
        const claimed = await db.insert(workerStateTable).values({ key: id, value: JSON.stringify(audit), updatedAt: new Date() })
          .onConflictDoNothing({ target: workerStateTable.key }).returning({ key: workerStateTable.key });
        return claimed.length === 1;
      },
      open: async (open, cost) => {
        activity.stage(run, 'EXECUTING_PAPER', [open.symbol]);
        storePaperCostSnapshot(open.symbol, cost, open.nowMs);
        return openServerPaperPosition(open, args.shouldContinue);
      },
      close: async (row, reason) => {
        activity.stage(run, 'EXECUTING_PAPER', [row.symbol]);
        return (await closeServerPaperPosition({ openTradeId: row.id,
          expectedStrategy: identity.strategyTag, reason, kind: 'FULL', quote: args.quote(row.symbol) }, args.shouldContinue)).ok;
      },
      reduce: async row => {
        activity.stage(run, 'EXECUTING_PAPER', [row.symbol]);
        return (await reduceServerPaper70({ openRow: row, quote: args.quote(row.symbol),
          shouldContinue: args.shouldContinue })).ok;
      },
    });
    activity.decisions(run, result.diagnostics);
    activity.stage(run, 'RECONCILING');
    // Read back the durable executor rows after OPEN/CLOSE/REDUCE. No invented PnL.
    const finalRows = await loadTrades();
    const currentRisk = parseVirtualPaper400RiskState((await read(riskKey))!, identity);
    const final = evaluateVirtualPaper400Account({ session: identity, rows: finalRows,
      previous: currentRisk, now: new Date(), quote: args.quote });
    await write(riskKey, final.next);
    const journal = await Promise.all([...finalRows].filter(row => row.action === 'CLOSE')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 10).map(async close => {
        const open = finalRows.find(row => row.id === close.closesTradeId);
        const auditRaw = open?.openDecisionId && (open.openDecisionId.startsWith('vp400:') || open.openDecisionId.startsWith(MODE_DECISION_PREFIX)) ? await read(open.openDecisionId) : null;
        let audit: { signal?: { strategyId?: string; reasons?: string[] }; sizing?: { finalNotionalUsd?: number }; cost?: { totalEstimatedRoundTripCostUsd?: number } } | null = null;
        try { audit = auditRaw ? JSON.parse(auditRaw) : null; } catch { /* unavailable, never fake reasons */ }
        const priorRisk = open && audit?.cost && audit.sizing ? Number(audit.sizing.finalNotionalUsd)
          * Math.abs(Number(open.price) - Number(open.stopPriceUsd)) / Number(open.price)
          + Number(audit.cost.totalEstimatedRoundTripCostUsd) : null;
        return { id: close.id, symbol: close.symbol, side: close.side, openedAt: open?.timestamp ?? null,
          closedAt: close.timestamp, entryPrice: open?.price ?? null, exitPrice: close.price,
          stopPrice: open?.stopPriceUsd ?? null, targetPrice: open?.takeProfitPriceUsd ?? null,
          strategy: audit?.signal?.strategyId ?? null, reasons: audit?.signal?.reasons ?? [],
          closeReason: close.closeReason, grossPnlUsd: close.pnl, netPnlUsd: close.netPnlEstimatedUsd,
          entryCostUsd: close.estEntryCostUsd, exitCostUsd: close.estExitCostUsd, holdingCostUsd: close.estHoldingCostUsd,
          plannedRiskUsd: priorRisk !== null && Number.isFinite(priorRisk) ? priorRisk : null,
          netR: priorRisk !== null && priorRisk > 0 ? Number(close.netPnlEstimatedUsd) / priorRisk : null,
          costBasis: 'SIMULATED / ESTIMATED', closeKind: close.closeKind };
      }));
    const diagnosticKey = virtualDiagnosticsKey(identity.sessionId);
    const diagnostic = advanceVirtualDiagnostics({ raw: await read(diagnosticKey), sessionId: identity.sessionId,
      now: Date.now(), records: evaluatedRecords, analysis, diagnostics: result.diagnostics, entryStages: result.entryStages,
      status: result.status, reason: result.reason, openCount: finalRows.filter(r => r.action === 'OPEN').length,
      closeCount: finalRows.filter(r => r.action === 'CLOSE').length,
      lastOpenAtMs: final.lastOpenAtMs, sessionStartedAtMs: identity.startedAtMs });
    // Corrupt diagnostic history must neither erase evidence nor disable position protection.
    if (diagnostic.state) await write(diagnosticKey, diagnostic.state);
    await write(VIRTUAL_PAPER_400_RUNTIME_KEY, { ...result, tradingDiagnostics: diagnostic.summary, universe: universe ? { ...universe, batchSymbols: symbols } : null, analysis, journal, sessionId: identity.sessionId,
      strategyContinuity: summarizeVirtualPaper400StrategyContinuity(continuity),
      at: new Date().toISOString(), account: { ...result.account, ledger: final.ledger,
        equityUsd: final.equityUsd, unrealizedNetPnlUsd: final.unrealizedNetPnlUsd,
        evaluation: final.evaluation, next: final.next,
        held: final.held.map(row => ({ id: row.id, symbol: row.symbol, side: row.side,
          sizeUsd: row.sizeInUsd, entryPrice: row.price, stopPrice: row.stopPriceUsd,
          takeProfitPrice: row.takeProfitPriceUsd })) } });
    activityOutcome = { status: result.status, reason: result.reason };
  });
  // Publish completion only after the transaction commits; rollback must never
  // look like a successful cycle. Raw errors are not exposed in public telemetry.
  if (activityRun !== null && activityOutcome !== null) {
    const outcome = activityOutcome as { status: string; reason: string | null };
    activity.finish(activityRun, outcome.status, outcome.reason);
  }
  } catch (error) {
    if (activityRun !== null) activity.finish(activityRun, 'ERROR', 'CYCLE_FAILED');
    throw error;
  }
  return true;
}
