import { VIRTUAL_ACTIVE_POLICY, virtualActiveProfile } from './virtualPaper400Policy';
import { createHash } from 'node:crypto';
import type { DbTrade } from '@workspace/db';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import { adaptStrategySignalToRisk } from '../intel/strategyRiskAdapterV2';
import { deriveRiskProfileLimits, PROFILE_FALLBACK_LIMITS, type AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import { enforceOrderSizing } from '../lib/orderSizingEnforcement';
import { validateExecutionEligibleSnapshot, type CostSnapshot } from '../lib/costSnapshot';
import { MARKET_BY_SYMBOL_SERVER } from '../lib/gmxMarkets';
import { evaluateVirtualPaper400SessionState } from './virtualPaper400SessionState';
import { evaluateVirtualPaper400Account, type VirtualPaper400RiskState } from './virtualPaper400Accounting';
import type { PriceLookup, ServerPaperOpenArgs, ServerPaperOpenResult } from './serverPaperExecutor';

/** The explicit session + Risk + sizing grants PAPER authority. SHADOW records
 * remain evidence only; their authority flags are never changed or trusted as a grant. */
export interface VirtualPaper400CycleDeps {
  sessionRaw: string;
  policyAppliedAt?: string;
  entryBlockedReason?: string | null;
  previous: VirtualPaper400RiskState;
  rows: readonly DbTrade[];
  now: Date;
  clock?: () => Date;
  engineMode: string;
  quote: PriceLookup;
  shouldContinue(): boolean;
  persistRisk(state: VirtualPaper400RiskState): Promise<void>;
  readSignals(): Promise<readonly StrategyShadowRecord[]>;
  readCost(symbol: string, isLong: boolean, notionalUsd: number): Promise<CostSnapshot | null>;
  claim(id: string, audit: unknown): Promise<boolean>;
  open(args: ServerPaperOpenArgs, cost: CostSnapshot): Promise<ServerPaperOpenResult>;
  close(row: DbTrade, reason: string): Promise<boolean>;
  reduce(row: DbTrade): Promise<boolean>;
}

export async function runVirtualPaper400Cycle(d: VirtualPaper400CycleDeps) {
  const session = evaluateVirtualPaper400SessionState(d.sessionRaw);
  if (!session.state || session.status === 'INVALID') throw new Error('VIRTUAL_SESSION_INVALID');
  const account = evaluateVirtualPaper400Account({ session: session.state.session,
    previous: d.previous, rows: d.rows, now: d.now, quote: d.quote });
  const diagnostics: { symbol: string; reason: string; details?: string[] }[] = [];
  const policy = d.policyAppliedAt ? { ...VIRTUAL_ACTIVE_POLICY, appliedAt: d.policyAppliedAt } : null;
  const outcome = (status: string, reason: string | null = null) => ({
    policy, diagnostics, status, reason, at: d.now.toISOString(), mode: 'VIRTUAL_PAPER_400' as const,
    realFundsUsed: false, costBasis: 'SIMULATED / ESTIMATED' as const,
    account: { ...account, held: account.held.map(row => ({ id: row.id, symbol: row.symbol,
      side: row.side, sizeUsd: row.sizeInUsd, entryPrice: row.price,
      stopPrice: row.stopPriceUsd, takeProfitPrice: row.takeProfitPriceUsd })) },
  });
  // Never enter a LIVE path, even if the virtual session is still ACTIVE.
  if (d.engineMode !== 'PAPER' || !d.shouldContinue()) return outcome('BLOCKED', 'PAPER_MODE_REQUIRED');
  await d.persistRisk(account.next);
  if (!d.shouldContinue()) return outcome('STOPPED');

  const risk = account.evaluation;
  const mustClose = risk.actions.includes('CLOSE_ALL_POSITIONS')
    || !!risk.locks.hardStopReason || !!risk.locks.weeklyLockReason
    || ['DAILY_LOSS_LOCKED', 'PROFIT_CAP_LOCKED'].includes(risk.locks.dailyLockState ?? '');
  if (mustClose && account.held.length) {
    for (const row of account.held) {
      if (!d.shouldContinue() || !await d.close(row, `VIRTUAL_RISK_${risk.state}`)) {
        return outcome('BLOCKED', 'VIRTUAL_PROTECTION_CLOSE_PENDING');
      }
    }
    return outcome('CLOSED');
  }
  if (risk.actions.includes('REDUCE_POSITION_70PCT') && account.held.length) {
    for (const row of account.held) {
      if (!d.shouldContinue() || !await d.reduce(row)) return outcome('BLOCKED', 'VIRTUAL_REDUCTION_PENDING');
    }
    await d.persistRisk({ ...account.next, risk: { ...account.next.risk,
      locks: { ...account.next.risk.locks, profitReductionDone: true } } });
    return outcome('REDUCED');
  }
  // STOP is an entry veto. Existing SL/TP/management remains independent.
  if (!session.active) return outcome('STOPPED');
  if (d.entryBlockedReason) return outcome('BLOCKED', d.entryBlockedReason);
  if (!risk.entryAllowed) return outcome('BLOCKED', risk.blockReasons.join('; '));
  if (account.lastOpenAtMs !== null && d.now.getTime() - account.lastOpenAtMs < (policy?.cooldownMinutes ?? 30) * 60_000) {
    return outcome('NO_TRADE', 'VIRTUAL_COOLDOWN');
  }
  const capital = Math.max(0, Math.min(400, account.equityUsd ?? 0));
  const profile: AppliedRiskProfileSnapshot = policy ? virtualActiveProfile(capital, policy.appliedAt) : { name: 'conservative', version: 'risk-profile/v1',
    appliedAt: session.state.session.startedAt,
    derivedLimits: deriveRiskProfileLimits('conservative', { ...PROFILE_FALLBACK_LIMITS,
      tradingCapital: capital, maxMarginPerTrade: Math.min(100, capital * 0.8),
      maxTotalExposureUSDT: Math.min(300, capital * 0.8), maxLeverage: 1 }) };
  const signals = [...await d.readSignals()].sort((a, b) => (b.selectedScore ?? 0) - (a.selectedScore ?? 0));
  for (const signal of signals) {
    const entryNow = d.clock?.() ?? d.now;
    if (!d.shouldContinue()) return outcome('STOPPED');
    const reject = (reason: string) => diagnostics.push({ symbol: signal.symbol, reason, details: signal.reasons.slice(0, 5) });
    if (policy && !policy.symbols.includes(signal.symbol)) { reject('UNSUPPORTED_SYMBOL'); continue; }
    const decision = adaptStrategySignalToRisk({ shadowRecord: signal, riskEvaluation: risk });
    if (decision.action === 'REJECT') { reject('STRATEGY_OR_RISK_REJECTED'); continue; }
    if (!signal.signalId || signal.confidence === null
      || !Number.isFinite(signal.confidence) || signal.confidence > 100
      || signal.confidence < profile.derivedLimits.immediateEntryThreshold
      || signal.evaluatedAt > entryNow.getTime() || entryNow.getTime() - signal.evaluatedAt > 60_000
      || signal.sourceCandleCloseTime > entryNow.getTime()
      || entryNow.getTime() - signal.sourceCandleCloseTime > 15 * 60_000) { reject('CONFIDENCE_OR_SIGNAL_FRESHNESS'); continue; }
    const q = d.quote(signal.symbol);
    const market = MARKET_BY_SYMBOL_SERVER.get(signal.symbol);
    if (!q || !market || !Number.isFinite(q.priceUsd) || q.priceUsd <= 0 || !Number.isFinite(q.ageMs)
      || q.ageMs < 0 || q.ageMs > 60_000 || signal.structuralStop === null || signal.entryPrice === null) { reject('QUOTE_OR_MARKET_UNAVAILABLE'); continue; }
    const isLong = decision.direction === 'LONG';
    const stopDistance = (q.priceUsd - signal.structuralStop) / q.priceUsd * (isLong ? 1 : -1);
    // Do not chase away from the completed-candle entry or move its invalidation.
    if (stopDistance <= 0 || stopDistance >= 0.5 || Math.abs(q.priceUsd / signal.entryPrice - 1) > 0.005) { reject('STOP_OR_PRICE_CHASE'); continue; }
    // Reserve the full cost cap before sizing: fixed fees must not be scaled
    // down with notional, and the executor must use the exact quoted notional.
    const activeRiskPct = profile.derivedLimits.maxRiskPerTradePct * Math.min(1, decision.sizeFactor, risk.sizeFactor);
    const requested = policy ? Math.min(profile.derivedLimits.maxTotalExposureUsd,
      profile.derivedLimits.maxMarginPerTradeUsd * profile.derivedLimits.maxLeverage,
      Math.max(0, capital * activeRiskPct / 100 - policy.maxRoundTripCostUsd) / stopDistance)
      : Math.min(profile.derivedLimits.maxMarginPerTradeUsd,
      capital * profile.derivedLimits.maxRiskPerTradePct / 100 / stopDistance) * decision.sizeFactor;
    if (!Number.isFinite(requested) || requested < 2.2) { reject('RISK_BUDGET_AFTER_COST'); continue; }
    const cost = await d.readCost(signal.symbol, isLong, requested);
    if (!cost || cost.source !== 'PAPER_GMX_ESTIMATE') { reject('COST_UNAVAILABLE'); continue; }
    const submitNow = d.clock?.() ?? d.now;
    const freshQuote = d.quote(signal.symbol);
    if (!freshQuote || freshQuote.priceUsd !== q.priceUsd || !Number.isFinite(freshQuote.ageMs)
      || freshQuote.ageMs < 0 || freshQuote.ageMs > 60_000) { reject('QUOTE_CHANGED_OR_STALE'); continue; }
    const checked = validateExecutionEligibleSnapshot(cost, { market: market.marketToken,
      isLong, orderType: 'MarketIncrease', notionalUsd: requested }, submitNow.getTime());
    if (!checked.ok || checked.effectiveRoundTripCostUsd > 0.40) { reject('COST_INVALID_OR_OVER_CAP'); continue; }
    const sizing = enforceOrderSizing({ requestedSizeUsd: requested, requestedCollateralUsd: requested / profile.derivedLimits.maxLeverage,
      requestedLeverage: profile.derivedLimits.maxLeverage, positionSizingCapitalUsd: capital, stopDistanceFraction: stopDistance,
      costSnapshot: cost, liquidityCapUsd: profile.derivedLimits.maxTotalExposureUsd,
      tierNotionalCapUsd: policy ? profile.derivedLimits.maxTotalExposureUsd : profile.derivedLimits.maxMarginPerTradeUsd, defensiveMode: policy ? false : risk.sizeFactor < 1,
      liveMode: false, canaryActive: false, riskBudgetPct: policy ? activeRiskPct : profile.derivedLimits.maxRiskPerTradePct,
      expected: { market: market.marketToken, isLong, orderType: 'MarketIncrease' }, now: submitNow });
    if (!sizing.ok) { reject('SIZING_REJECTED'); continue; }
    if (policy && (Math.abs(sizing.finalNotionalUsd - requested) > 1e-8
      || sizing.finalNotionalUsd * stopDistance + checked.effectiveRoundTripCostUsd > capital * activeRiskPct / 100 + 1e-8)) {
      reject('EXACT_SIZE_OR_TOTAL_RISK_MISMATCH'); continue;
    }
    const id = `vp400:${createHash('sha256').update(`${session.state.session.strategyTag}:${signal.signalId}`).digest('hex')}`;
    if (d.rows.some(row => row.openDecisionId === id)) { reject('DUPLICATE_SIGNAL'); continue; }
    if (!d.shouldContinue() || !await d.claim(id, { mode: 'VIRTUAL_PAPER_400', signal, decision, sizing,
      cost, policy, sessionId: session.state.session.sessionId })) { reject('CLAIM_UNAVAILABLE_OR_DUPLICATE'); continue; }
    if (risk.locks.defensiveActive) {
      // Reserve before dispatch: a crash/failed OPEN must not mint another
      // defensive allowance on restart. It never increases after a loss.
      await d.persistRisk({ ...account.next, risk: { ...account.next.risk,
        locks: { ...account.next.risk.locks, defensiveEntriesUsed: risk.locks.defensiveEntriesUsed + 1 } } });
    }
    if (!d.shouldContinue()) return outcome('STOPPED');
    const result = await d.open({ strategy: session.state.session.strategyTag, decisionId: id,
      symbol: signal.symbol, side: isLong ? 'LONG' : 'SHORT', sizeUsd: sizing.finalNotionalUsd,
      leverage: sizing.finalLeverage, quote: freshQuote, stopPriceUsd: signal.structuralStop,
      tpPriceUsd: q.priceUsd + (isLong ? 1 : -1) * Math.abs(q.priceUsd - signal.structuralStop) * 2,
      openPositionCount: account.held.length, maxConcurrentPositions: 1,
      riskProfileSnapshot: profile, entriesManilaDay: account.next.risk.dailyEntryCount,
      nowMs: submitNow.getTime() }, cost);
    return outcome(result.ok ? 'OPENED' : 'BLOCKED', result.ok ? null : result.reason);
  }
  return outcome('NO_TRADE', 'NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL');
}
