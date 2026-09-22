import { validatePaperContributions, type PaperContribution } from './virtualPaperContribution';
import { evaluateDailyPaperRisk } from './virtualPaperDailyPolicy';
import type { DbTrade } from '@workspace/db';
import { accrueHoldingCostsFromEntryRates } from '../lib/holdingCosts';
import { initialRiskEngineState, rollRiskPeriods, type PersistedRiskEngineState } from '../lib/riskEngineState';
import { evaluateRiskState, type RiskEvaluationResult } from '../lib/riskStateMachine';
import { RISK_POLICY } from '../lib/riskPolicy';
import { manilaDayStartIso, manilaWeekStartIso } from '../lib/manilaTime';
import { validRiskState, fixedBetaNumber, fixedBetaLedgerBinding } from './fixedBetaAccountingState';
import { deriveVirtualPaper400Ledger, parseVirtualPaper400Session, type VirtualPaper400SessionV1 } from './virtualPaper400Ledger';
import type { PriceLookup } from './serverPaperExecutor';

/** Dedicated durable state. Never reads or writes Standard/fixed-beta risk keys. */
export function virtualPaper400RiskKey(session: VirtualPaper400SessionV1): string {
  if (!parseVirtualPaper400Session(session).ok) throw new Error('VIRTUAL_SESSION_INVALID');
  return `virtual_paper_400_risk_v1:${session.sessionId}`;
}

export interface VirtualPaper400RiskState {
  version: 1;
  contributions?: PaperContribution[];
  sessionId: string;
  strategyTag: string;
  equityHwmUsd: number;
  ledgerRowCount: number;
  settlementCount: number;
  settlementSha256: string;
  risk: PersistedRiskEngineState;
}

export function parseVirtualPaper400RiskState(raw: string, session: VirtualPaper400SessionV1): VirtualPaper400RiskState {
  const v = JSON.parse(raw) as VirtualPaper400RiskState;
  if (!v || v.version !== 1 || v.sessionId !== session.sessionId || v.strategyTag !== session.strategyTag
    || !Number.isFinite(v.equityHwmUsd) || v.equityHwmUsd < 400 || !validRiskState(v.risk)
    || !Number.isSafeInteger(v.ledgerRowCount) || v.ledgerRowCount < 0
    || !Number.isSafeInteger(v.settlementCount) || v.settlementCount < 0
    || typeof v.settlementSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.settlementSha256)) {
    throw new Error('VIRTUAL_RISK_STATE_INVALID');
  }
  const contributions = validatePaperContributions(v.contributions, session);
  if (v.equityHwmUsd < 400 + contributions.reduce((sum, c) => sum + c.amountUsd, 0)) throw Error('PAPER_CONTRIBUTION_HWM_INVALID');
  return v;
}

export function initialVirtualPaper400RiskState(session: VirtualPaper400SessionV1): VirtualPaper400RiskState {
  if (!parseVirtualPaper400Session(session).ok) throw new Error('VIRTUAL_SESSION_INVALID');
  return { version: 1, sessionId: session.sessionId, strategyTag: session.strategyTag,
    equityHwmUsd: 400, ledgerRowCount: 0, settlementCount: 0,
    settlementSha256: fixedBetaLedgerBinding([]).sha256,
    risk: initialRiskEngineState(new Date(session.startedAtMs), 400) };
}

/** Strict full-history projection. Missing settlement/quote/cost evidence is never zero PnL. */
export function evaluateVirtualPaper400Account(args: {
  session: VirtualPaper400SessionV1;
  rows: readonly DbTrade[];
  previous: VirtualPaper400RiskState;
  quote: PriceLookup;
  now: Date;
  aggressiveDaily?: boolean;
}) {
  const { session, rows, now, quote } = args;
  const previous = parseVirtualPaper400RiskState(JSON.stringify(args.previous), session);
  const nowMs = now.getTime();
  const ids = new Set<string>();
  for (const row of rows) {
    const at = new Date(row.timestamp).getTime();
    if (row.strategy !== session.strategyTag || ids.has(row.id) || !row.id
      || !['OPEN', 'CLOSE'].includes(row.action) || !['LONG', 'SHORT'].includes(row.side)
      || !Number.isFinite(at) || at < session.startedAtMs || at > nowMs
      || row.managedBy !== 'SERVER' || row.testMode !== false
      || row.settlementStatus !== 'PAPER_ESTIMATED' || row.costSource !== 'PAPER_GMX_ESTIMATE') {
      throw new Error('VIRTUAL_LEDGER_ROW_INVALID');
    }
    ids.add(row.id);
  }
  const opens = rows.filter(row => row.action === 'OPEN');
  const closes = rows.filter(row => row.action === 'CLOSE').sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() || a.id.localeCompare(b.id));
  if (rows.length < previous.ledgerRowCount || closes.length < previous.settlementCount
    || fixedBetaLedgerBinding(closes.slice(0, previous.settlementCount)).sha256 !== previous.settlementSha256) {
    throw new Error('VIRTUAL_SETTLED_HISTORY_CHANGED');
  }
  for (const row of closes) {
    const parent = opens.find(open => open.id === row.closesTradeId);
    if (!parent || parent.symbol !== row.symbol || parent.side !== row.side
      || new Date(row.timestamp).getTime() < new Date(parent.timestamp).getTime()
      || !['FULL', 'REDUCE70'].includes(row.closeKind ?? '')
      || (row.closeKind === 'FULL' && parent.closeTime === 0)) {
      throw new Error('VIRTUAL_SETTLEMENT_UNRESOLVED');
    }
  }
  for (const open of opens) {
    const settlements = closes.filter(row => row.closesTradeId === open.id);
    const full = settlements.filter(row => row.closeKind === 'FULL');
    const partial = settlements.filter(row => row.closeKind === 'REDUCE70');
    if (!Number.isFinite(open.closeTime) || open.closeTime < 0
      || full.length !== (open.closeTime === 0 ? 0 : 1) || partial.length > 1) {
      throw new Error('VIRTUAL_SETTLEMENT_UNRESOLVED');
    }
  }
  const ledgerResult = deriveVirtualPaper400Ledger(session, closes);
  if (!ledgerResult.ok) throw new Error(ledgerResult.reason);
  const contributions = validatePaperContributions(previous.contributions, session);
  if (contributions.some(c => Date.parse(c.appliedAt) > nowMs)) throw Error('PAPER_CONTRIBUTION_FUTURE');
  const contributed = contributions.reduce((sum, c) => sum + c.amountUsd, 0);
  const ledger = { ...ledgerResult.value, netContributionsUsd: contributed,
    fundedCapitalUsd: 400 + contributed, contributions,
    realizedEquityUsd: ledgerResult.value.realizedEquityUsd + contributed };
  const dayStart = Date.parse(manilaDayStartIso(now));
  const weekStart = Date.parse(manilaWeekStartIso(now));
  let cumulative = 400;
  let hwm = previous.equityHwmUsd;
  let dayOpening = 400;
  let weekOpening = 400;
  let dailyNet = 0;
  let weeklyNet = 0;
  let losses = 0;
  const cashFlows = [
    ...closes.map(row => ({ at: new Date(row.timestamp).getTime(), net: fixedBetaNumber(row.netPnlEstimatedUsd), contribution: false })),
    ...contributions.map(c => ({ at: Date.parse(c.appliedAt), net: c.amountUsd, contribution: true })),
  ].sort((a, b) => a.at - b.at);
  for (const { at, net, contribution } of cashFlows) {
    cumulative += net;
    hwm = Math.max(hwm, cumulative);
    if (at < dayStart) dayOpening += net;
    else if (!contribution) { dailyNet += net; losses = net < 0 ? losses + 1 : 0; }
    if (at < weekStart) weekOpening += net;
    else if (!contribution) weeklyNet += net;
  }
  const held = opens.filter(row => row.closeTime === 0);
  let unrealizedNet = 0;
  let quotesFresh = true;
  for (const row of held) {
    const q = quote(row.symbol);
    if (!q || !Number.isFinite(q.priceUsd) || q.priceUsd <= 0 || !Number.isFinite(q.ageMs)
      || q.ageMs < 0 || q.ageMs > 60_000) { quotesFresh = false; continue; }
    const entry = fixedBetaNumber(row.price);
    const size = fixedBetaNumber(row.sizeInUsd);
    if (entry <= 0 || size <= 0) throw new Error('VIRTUAL_POSITION_INVALID');
    const holding = accrueHoldingCostsFromEntryRates({ notionalUsd: size,
      openedAtMs: new Date(row.timestamp).getTime(), closedAtMs: nowMs,
      fundingRatePerHourFraction: fixedBetaNumber(row.fundingRatePerHour),
      borrowingRatePerHourFraction: fixedBetaNumber(row.borrowingRatePerHour) });
    if (!holding.ok) throw new Error(holding.reason);
    const entryCost = fixedBetaNumber(row.estEntryCostUsd);
    const exitCost = fixedBetaNumber(row.estExitCostUsd);
    if (entryCost < 0 || exitCost < 0) throw new Error('VIRTUAL_POSITION_COST_INVALID');
    unrealizedNet += (q.priceUsd - entry) / entry * size * (row.side === 'LONG' ? 1 : -1)
      - entryCost - exitCost - holding.totalUsd;
  }
  const equity = quotesFresh ? ledger.realizedEquityUsd + unrealizedNet : null;
  if (equity !== null) hwm = Math.max(hwm, equity);
  const rolled = rollRiskPeriods(previous.risk, now, ledger.realizedEquityUsd);
  const risk = { ...rolled.state,
    startOfDayEquityUsd: rolled.rolledDay ? dayOpening : rolled.state.startOfDayEquityUsd,
    startOfWeekEquityUsd: rolled.rolledWeek ? weekOpening : rolled.state.startOfWeekEquityUsd,
    dailyRealizedNetPnlUsd: dailyNet,
    dailyLossAwareNetPnlUsd: dailyNet + Math.min(unrealizedNet, 0),
    weeklyRealizedNetPnlUsd: weeklyNet,
    dailyEntryCount: opens.filter(row => new Date(row.timestamp).getTime() >= dayStart).length,
    consecutiveLossCount: losses, lastUpdatedAt: now.toISOString() };
  const evaluation: RiskEvaluationResult = args.aggressiveDaily ? evaluateDailyPaperRisk({equity,dayOpening:risk.startOfDayEquityUsd,
    dailyLossAware:risk.dailyLossAwareNetPnlUsd,dailyRealized:dailyNet,entries:risk.dailyEntryCount,held:held.length,fresh:quotesFresh,locks:risk.locks}) : evaluateRiskState({
    dailyRiskCapitalUsd: Math.min(ledger.fundedCapitalUsd, risk.startOfDayEquityUsd),
    weeklyRiskCapitalUsd: Math.min(ledger.fundedCapitalUsd, risk.startOfWeekEquityUsd),
    currentEquityUsd: equity, newHardStopEvaluationAllowed: true,
    hardStopPolicyReferenceCapitalUsd: hwm,
    hardStopPolicyEquityUsd: hwm * RISK_POLICY.hardStopEquityUsd / RISK_POLICY.initialCapitalUsd,
    dailyRealizedNetPnlUsd: dailyNet, dailyLossAwareNetPnlUsd: quotesFresh ? risk.dailyLossAwareNetPnlUsd : null,
    estimatedExitNetPnlUsd: quotesFresh ? dailyNet + unrealizedNet : null,
    weeklyRealizedNetPnlUsd: weeklyNet, dailyEntryCount: risk.dailyEntryCount,
    consecutiveLossCount: losses, openPositionCount: held.length, maxConcurrentPositions: 1,
    dbOk: true, feeDataOk: true, marketDataFresh: quotesFresh, locks: risk.locks,
  });
  const next: VirtualPaper400RiskState = { ...previous, equityHwmUsd: hwm,
    ledgerRowCount: rows.length, settlementCount: closes.length,
    settlementSha256: fixedBetaLedgerBinding(closes).sha256,
    risk: { ...risk, riskOperatingState: evaluation.state, locks: evaluation.locks } };
  return { ledger, equityUsd: equity, unrealizedNetPnlUsd: quotesFresh ? unrealizedNet : null,
    held, evaluation, next, lastOpenAtMs: opens.length ? Math.max(...opens.map(row => new Date(row.timestamp).getTime())) : null };
}
