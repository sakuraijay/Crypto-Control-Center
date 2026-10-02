#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BAR = 15 * 60_000;
const FLOORS = [1.5, 1.25, 1.0];
const MODES = ['v8', 'v9'];
export const MAX_DAILY_ENTRIES = 32;
const POOLS = {
  PRIMARY_BTC_SOL_XRP: ['BTC', 'SOL', 'XRP'],
  SUPPLEMENTARY_ETH_LINK: ['ETH', 'LINK'],
};
const DEFAULT_INPUT = 'docs/verification/paper-v9/gmx-candles-2026-10-02.json';
const DEFAULT_OUTPUT = 'docs/verification/paper-v9/causal-replay-2026-10-02.json';
const CANDIDATE_SOURCE = new URL('../artifacts/api-server/src/workers/virtualPaperDailyCandidate.ts', import.meta.url);
const PHT_WINDOW = {
  timezone: 'Asia/Manila (UTC+08:00)',
  fromMs: Date.parse('2026-10-01T16:00:00Z'),
  toMs: Date.parse('2026-10-02T16:00:00Z'),
};
const MODELED_COSTS = [
  { name: 'LOW_MODELED', roundTripBps: 10 },
  { name: 'HIGH_MODELED', roundTripBps: 20 },
];
const RISK_MODES = ['POLICY_HALF_AFTER_2_LOSSES_4H', 'NO_HALF_RISK_SENSITIVITY'];
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const finite = (n) => Number.isFinite(n);
const stopBounds = (fraction) => finite(fraction) && fraction >= .002 - 1e-10 && fraction <= .008 + 1e-10;
const direction = (side) => side === 'LONG' ? 1 : -1;
const require = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { transform } = require('esbuild');

const candidateSourceText = await readFile(CANDIDATE_SOURCE, 'utf8');
const compiledCandidate = await transform(candidateSourceText, { loader: 'ts', format: 'esm' });
const candidateModule = await import(`data:text/javascript;base64,${Buffer.from(compiledCandidate.code).toString('base64')}`);
const { dailyPaperCandidate } = candidateModule;

export function evaluateCandidateAt(symbol, prices, index, version, mode = 'INTRADAY') {
  const decisionBar = prices[index];
  const decisionAt = decisionBar[0] + BAR;
  const pastOnly = prices.slice(0, index + 1);
  return dailyPaperCandidate(symbol, { source: 'gmx-official-api', prices: pastOnly }, decisionAt + 2_000, version, mode);
}

const candidateAt = evaluateCandidateAt;

export function v8ThreeLossLockApplies({ version, consecutiveLosses, lastCloseAtMs, entryAt }) {
  return version === 'v8' && consecutiveLosses >= 3 && lastCloseAtMs !== null
    && entryAt >= lastCloseAtMs && entryAt - lastCloseAtMs < 4 * 3_600_000;
}

export function modeledHalfRiskApplies({ riskMode, consecutiveLosses, lastCloseAtMs, entryAt }) {
  return riskMode === 'POLICY_HALF_AFTER_2_LOSSES_4H' && consecutiveLosses >= 2
    && lastCloseAtMs !== null && entryAt >= lastCloseAtMs && entryAt - lastCloseAtMs < 4 * 3_600_000;
}

export function resolveBarOutcome({ side, stop, target, bar }) {
  const long = side === 'LONG';
  if (long && bar[1] <= stop || !long && bar[1] >= stop)
    return { exit: bar[1], result: 'STOP_GAP' };
  if (long && bar[1] >= target || !long && bar[1] <= target)
    return { exit: target, result: 'TARGET_GAP' };
  const stopTouched = long ? bar[3] <= stop : bar[2] >= stop;
  const targetTouched = long ? bar[2] >= target : bar[3] <= target;
  if (stopTouched && targetTouched) return { exit: stop, result: 'AMBIGUOUS_STOP_FIRST' };
  if (stopTouched) return { exit: stop, result: 'STOP' };
  if (targetTouched) return { exit: target, result: 'TARGET' };
  return null;
}

export function evaluateDecision({ symbol, prices, index, version }) {
  if (index < 15 || index + 1 >= prices.length) return null;
  const candidate = candidateAt(symbol, prices, index, version);
  const evaluation = candidate?.evaluation;
  const entryBar = prices[index + 1];
  const entry = entryBar[1]; // no signal-close fill: earliest observable execution is next candle open
  if (!candidate || !evaluation) return { symbol, version, decisionAt: prices[index][0] + BAR, reason: 'CANDIDATE_UNAVAILABLE' };

  const isV9 = version === 'v9';
  const signal = evaluation.selectedSetup
    ? evaluation.signals.find((item) => item.kind === evaluation.selectedSetup)
    : null;
  const side = signal?.side;
  const stop = isV9 ? evaluation.observedStopPrice : evaluation.stopPrice;
  const target = signal?.targetPrice;
  const stopDistance = finite(stop) && stop > 0 ? Math.abs(entry - stop) / entry : null;
  const wrongSide = !side || (side === 'LONG' ? stop >= entry : stop <= entry);
  const structuralTargetMove = finite(target) ? Math.abs(target / entry - 1) : null;
  const horizonMove = evaluation.observedHorizonMoveFraction?.INTRADAY ?? null;
  const signalOK = evaluation.eligible && signal?.eligible && signal.side === candidate.side;
  let reason = null;
  if (!signalOK) reason = evaluation.reason ?? 'SIGNAL_INELIGIBLE';
  else if (!side) reason = 'SIDE_UNAVAILABLE';
  else if (!finite(stop)) reason = evaluation.stopFailure ?? 'NO_OBSERVED_STOP';
  else if (wrongSide) reason = 'STOP_WRONG_SIDE_AT_NEXT_OPEN';
  else if (!stopBounds(stopDistance)) reason = 'STOP_OUTSIDE_EXECUTOR_BOUNDS_AT_NEXT_OPEN';
  else if (!finite(target) || (side === 'LONG' ? target <= entry : target >= entry)) reason = 'OBSERVED_TARGET_NOT_AHEAD_AT_NEXT_OPEN';
  else if (!finite(structuralTargetMove) || !finite(horizonMove) || structuralTargetMove > horizonMove + 1e-10)
    reason = 'TARGET_EXCEEDS_PRIOR_OBSERVED_HORIZON';
  return {
    symbol, version, decisionAt: prices[index][0] + BAR,
    decisionClose: prices[index][4], entryAt: entryBar[0], entryPrice: entry,
    side: side ?? null, setup: evaluation.selectedSetup ?? null,
    score: evaluation.selectedScore ?? null, scoreThreshold: evaluation.scoreThreshold ?? null,
    momentumFraction: evaluation.momentumFraction ?? null,
    candidateReason: evaluation.reason ?? null,
    stopFailure: evaluation.stopFailure ?? null,
    signalChecks: evaluation.signals.map(({ kind, side: signalSide, score, threshold, eligible, reason: signalReason, targetPrice: signalTarget }) =>
      ({ setup: kind, side: signalSide, score, threshold, eligible, reason: signalReason, targetPrice: signalTarget })),
    signalEligible: signalOK, stopPrice: finite(stop) ? stop : null, stopDistance,
    targetPrice: finite(target) ? target : null, targetMove: structuralTargetMove,
    observedPriorHorizonMove: horizonMove,
    rejectionReason: reason,
    eligibleBeforeEconomics: reason === null,
  };
}

function chooseTarget(entry, side, stop, structuralTarget, version) {
  return structuralTarget;
}

function modeledCost(notional, cost) {
  return notional * cost.roundTripBps / 10_000;
}

function economicsFor(event, version, floor, cost, riskBudgetUsd = 4, equityUsd = 400) {
  if (!event.eligibleBeforeEconomics) return { eligible: false, reason: event.rejectionReason };
  const target = chooseTarget(event.entryPrice, event.side, event.stopPrice, event.targetPrice, version);
  const distance = event.stopDistance;
  const exposureCap = Math.min(1_000, equityUsd * 2.5);
  const notionalAtRisk = Math.min(exposureCap, Math.max(0, riskBudgetUsd - 2) / distance);
  if (!(notionalAtRisk >= 2.2)) return { eligible: false, reason: 'ASSUMED_RISK_BUDGET_TOO_SMALL' };
  const moveReward = notionalAtRisk * (target / event.entryPrice - 1) * direction(event.side);
  const costUsd = modeledCost(notionalAtRisk, cost);
  const netRisk = notionalAtRisk * distance + 2;
  const netReward = moveReward - costUsd;
  const netRR = netReward / netRisk;
  const leverage = Math.floor(Math.min(10, notionalAtRisk * .1 / netRisk) + 1e-10);
  const marginUsd = notionalAtRisk / leverage;
  const marginCap = Math.min(100, equityUsd * .8);
  if (leverage < 5 || !finite(marginUsd) || marginUsd < 1.1 || marginUsd > marginCap)
    return { eligible: false, reason: 'MODELED_LEVERAGE_OR_MARGIN_LIMIT' };
  return {
    eligible: finite(netRR) && netReward > 0 && netRR >= floor - 1e-10
      && costUsd <= 2 + 1e-10 && netRisk <= riskBudgetUsd + 1e-8,
    reason: finite(netRR) && netReward > 0 && netRR >= floor - 1e-10 ? null : 'MODELED_NET_RR_BELOW_FLOOR',
    targetPrice: target,
    notionalUsd: notionalAtRisk,
    roundTripCostUsd: costUsd,
    stopRiskUsd: notionalAtRisk * distance,
    leverage,
    marginUsd,
    modeledNetRewardUsd: netReward,
    modeledNetRewardRisk: netRR,
    floor,
    costScenario: cost.name,
  };
}

function closeSimulatedPosition(event, target, prices, maxBars) {
  const first = event.entryAt;
  const entryIndex = prices.findIndex((row) => row[0] === first);
  if (entryIndex < 0) return { outcome: 'PENDING_NO_ENTRY_BAR' };
  for (let offset = 0; offset < maxBars && entryIndex + offset < prices.length; offset++) {
    const bar = prices[entryIndex + offset];
    const hit = resolveBarOutcome({ side: event.side, stop: event.stopPrice, target, bar });
    if (hit) return { ...hit, exitAt: bar[0] + BAR, barsHeld: offset + 1 };
  }
  const expiryIndex = entryIndex + maxBars - 1;
  if (expiryIndex >= prices.length) return { outcome: 'PENDING_INCOMPLETE_HORIZON' };
  const exitBar = prices[expiryIndex];
  return { exit: exitBar[4], result: 'TIME_EXIT', exitAt: exitBar[0] + BAR, barsHeld: maxBars };
}

function summarizeEvents(events) {
  const reasons = {};
  const stopFailures = {};
  const signalConditionDeclines = {};
  for (const event of events) {
    const key = event.rejectionReason ?? 'ELIGIBLE_BEFORE_ECONOMICS';
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (event.stopFailure) stopFailures[event.stopFailure] = (stopFailures[event.stopFailure] ?? 0) + 1;
    for (const signal of event.signalChecks ?? []) {
      const signalKey = `${signal.setup}:${signal.reason}`;
      signalConditionDeclines[signalKey] = (signalConditionDeclines[signalKey] ?? 0) + 1;
    }
  }
  return {
    decisions: events.length,
    firstDecisionAt: events[0]?.decisionAt ?? null,
    lastDecisionAt: events.at(-1)?.decisionAt ?? null,
    firstEntryAt: events[0]?.entryAt ?? null,
    lastEntryAt: events.at(-1)?.entryAt ?? null,
    eligibleBeforeEconomics: events.filter((e) => e.eligibleBeforeEconomics).length,
    declines: reasons,
    stopFailureConditions: stopFailures,
    setupConditionDeclines: signalConditionDeclines,
  };
}

function simulateArm(events, candlesBySymbol, version, floor, cost, riskMode) {
  const queue = events.filter((event) => event.eligibleBeforeEconomics)
    .sort((a, b) => a.entryAt - b.entryAt
      || Math.abs(b.momentumFraction ?? 0) - Math.abs(a.momentumFraction ?? 0)
      || a.symbol.localeCompare(b.symbol));
  const outcomes = [];
  let equity = 400;
  let peak = equity;
  let maxRealizedSettlementDrawdownUsd = 0;
  let heldUntil = 0;
  let lastEntryAt = -Infinity;
  let daily = new Map();
  let weekly = new Map();
  let entriesToday = new Map();
  let consecutiveLosses = 0;
  let lastCloseAtMs = null;
  let blocked = {};
  for (const event of queue) {
    const day = new Date(event.entryAt).toISOString().slice(0, 10);
    const weekdayFromMonday = (new Date(event.entryAt).getUTCDay() + 6) % 7;
    const week = new Date(event.entryAt - weekdayFromMonday * 86_400_000).toISOString().slice(0, 10);
    const reject = (reason) => { blocked[reason] = (blocked[reason] ?? 0) + 1; };
    if (event.entryAt < heldUntil) { reject('SINGLE_POSITION_HELD'); continue; }
    if (event.entryAt - lastEntryAt < 45 * 60_000) { reject('ENTRY_COOLDOWN_45M'); continue; }
    if ((entriesToday.get(day) ?? 0) >= MAX_DAILY_ENTRIES) { reject('DAILY_MAX_32'); continue; }
    if ((daily.get(day) ?? 0) <= -20) { reject('DAILY_LOSS_5_PERCENT'); continue; }
    if ((weekly.get(week) ?? 0) <= -40) { reject('WEEKLY_LOSS_10_PERCENT'); continue; }
    if (equity <= 280) { reject('CUMULATIVE_LOSS_30_PERCENT'); continue; }
    if ((daily.get(day) ?? 0) >= 80) { reject('DAILY_PROFIT_CAP_20_PERCENT'); continue; }
    if (v8ThreeLossLockApplies({ version, consecutiveLosses, lastCloseAtMs, entryAt: event.entryAt })) {
      reject('V8_THREE_LOSSES_4H_LOCK'); continue;
    }
    const dailyRemaining = Math.max(0, 20 + (daily.get(day) ?? 0));
    const weeklyRemaining = Math.max(0, 40 + (weekly.get(week) ?? 0));
    const cumulativeRemaining = Math.max(0, equity - 280);
    const halfRiskApplies = modeledHalfRiskApplies({ riskMode, consecutiveLosses, lastCloseAtMs, entryAt: event.entryAt });
    const percentageRiskBudget = Math.min(equity, 1_000) * .01 * (halfRiskApplies ? .5 : 1);
    const economics = economicsFor(event, version, floor, cost,
      Math.min(percentageRiskBudget, dailyRemaining, weeklyRemaining, cumulativeRemaining), equity);
    if (!economics.eligible) { reject(economics.reason ?? 'MODELED_ECONOMICS_REJECTED'); continue; }

    const pricePath = candlesBySymbol[event.symbol];
    const path = closeSimulatedPosition(event, economics.targetPrice, pricePath, 4);
    if (!finite(path.exit)) { reject(path.outcome); continue; }
    const gross = economics.notionalUsd * (path.exit / event.entryPrice - 1) * direction(event.side);
    const pnl = gross - economics.roundTripCostUsd;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxRealizedSettlementDrawdownUsd = Math.max(maxRealizedSettlementDrawdownUsd, peak - equity);
    daily.set(day, (daily.get(day) ?? 0) + pnl);
    weekly.set(week, (weekly.get(week) ?? 0) + pnl);
    entriesToday.set(day, (entriesToday.get(day) ?? 0) + 1);
    consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
    lastCloseAtMs = path.exitAt;
    lastEntryAt = event.entryAt;
    heldUntil = path.exitAt;
    outcomes.push({
      symbol: event.symbol, entryAt: event.entryAt, side: event.side, setup: event.setup,
      entryPrice: event.entryPrice, stopPrice: event.stopPrice, targetPrice: economics.targetPrice,
      notionalUsd: economics.notionalUsd, modeledCostUsd: economics.roundTripCostUsd,
      leverage: economics.leverage, marginUsd: economics.marginUsd,
      exitPrice: path.exit, exitAt: path.exitAt, exitReason: path.result,
      modeledGrossPnlUsd: gross, modeledNetPnlUsd: pnl, modeledNetRewardRisk: economics.modeledNetRewardRisk,
    });
  }
  return {
    modeledOnly: true,
    assumedInitialEquityUsd: 400,
    riskMode,
    entries: outcomes.length,
    blocked,
    modeledNetPnlUsd: outcomes.reduce((sum, item) => sum + item.modeledNetPnlUsd, 0),
    modeledRealizedSettlementMaxDrawdownUsd: maxRealizedSettlementDrawdownUsd,
    modeledEndingEquityUsd: equity,
    outcomes,
  };
}

export function replayCapture(capture, { candidateSourceSha256 = null } = {}) {
  if (capture.schema !== 'paper-v9-gmx-candle-capture/v1') throw new Error('PAPER_V9_CAPTURE_SCHEMA_INVALID');
  const hashable = { ...capture };
  delete hashable.captureSha256;
  if (sha256(JSON.stringify(hashable)) !== capture.captureSha256) throw new Error('PAPER_V9_CAPTURE_HASH_MISMATCH');
  const candlesBySymbol = {};
  const symbols = Object.keys(capture.symbols).sort();
  const perSymbol = {};
  const pooledEvents = Object.fromEntries(Object.keys(POOLS).map((pool) => [pool,
    Object.fromEntries(MODES.map((version) => [version, []]))]));
  const captureAt = Date.parse(capture.fetchedAt);
  if (!finite(captureAt) || PHT_WINDOW.fromMs >= PHT_WINDOW.toMs || captureAt <= PHT_WINDOW.fromMs)
    throw new Error('PAPER_V9_PHT_WINDOW_INVALID');
  for (const symbol of symbols) {
    const source = capture.symbols[symbol];
    if (sha256(source.rawResponse) !== source.responseSha256) throw new Error(`${symbol}: raw source hash mismatch`);
    const parsed = JSON.parse(source.rawResponse);
    const unique = new Map();
    for (const row of parsed.candles) {
      const [seconds, open, high, low, close] = row;
      unique.set(seconds * 1_000, [seconds * 1_000, open, high, low, close]);
    }
    const rebuiltClosed = [...unique.values()].sort((a, b) => a[0] - b[0])
      .filter((row) => row[0] + BAR <= Date.parse(capture.fetchedAt));
    if (JSON.stringify(rebuiltClosed) !== JSON.stringify(source.candles))
      throw new Error(`${symbol}: filtered candle data does not match immutable raw source`);
    const prices = source.candles;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i][0] - prices[i - 1][0] !== BAR) throw new Error(`${symbol}: chronological gap`);
      if (prices[i][0] + BAR > Date.parse(capture.fetchedAt)) throw new Error(`${symbol}: open/future candle in immutable capture`);
    }
    candlesBySymbol[symbol] = prices;
    perSymbol[symbol] = {};
    const pool = Object.entries(POOLS).find(([,members]) => members.includes(symbol))?.[0];
    if (!pool) continue;
    for (const version of MODES) {
      const events = [];
      for (let i = 15; i < prices.length - 1; i++) {
        const decisionAt = prices[i][0] + BAR;
        const entryAt = prices[i + 1][0];
        if (decisionAt < PHT_WINDOW.fromMs || decisionAt >= PHT_WINDOW.toMs
          || entryAt < PHT_WINDOW.fromMs || entryAt >= PHT_WINDOW.toMs) continue;
        const event = evaluateDecision({ symbol, prices, index: i, version });
        if (event) events.push(event);
      }
      perSymbol[symbol][version] = summarizeEvents(events);
      pooledEvents[pool][version].push(...events);
    }
  }
  for (const pool of Object.keys(POOLS)) for (const version of MODES)
    pooledEvents[pool][version].sort((a, b) => a.decisionAt - b.decisionAt || a.symbol.localeCompare(b.symbol));

  const scenarioRows = [];
  const modeledResults = {};
  for (const [pool, poolSymbols] of Object.entries(POOLS)) for (const cost of MODELED_COSTS)
    for (const floor of FLOORS) for (const version of MODES) for (const riskMode of RISK_MODES) {
    const events = pooledEvents[pool][version];
    const result = simulateArm(events, candlesBySymbol, version, floor, cost, riskMode);
    const initialBudget = Math.min(400, 1_000) * .01;
    const structuralEconomicsPassesAtInitialState = events
      .filter((event) => economicsFor(event, version, floor, cost, initialBudget, 400).eligible).length;
    const key = `${pool}_${version}_RR${floor}_${cost.name}_${riskMode}`;
    modeledResults[key] = result;
    scenarioRows.push({
      pool, symbols: poolSymbols, version, riskMode, netRewardRiskFloor: floor, modeledCostScenario: cost.name,
      structuralEconomicsPassesAtInitialState, entries: result.entries, blocked: result.blocked,
      modeledNetPnlUsd: result.modeledNetPnlUsd,
      modeledRealizedSettlementMaxDrawdownUsd: result.modeledRealizedSettlementMaxDrawdownUsd,
      modeledEndingEquityUsd: result.modeledEndingEquityUsd,
    });
  }
  const formallyUnavailable = {
    classification: 'UNAVAILABLE',
    reason: 'No point-in-time side-specific exact-notional quote, impact, fee, funding, borrow, or replayed risk-state evidence was captured.',
    measuredNetPnlUsd: null,
    measuredMaxDrawdownUsd: null,
    measuredWinRate: null,
  };
  return {
    schema: 'paper-v9-causal-replay/v1',
    capture: {
      source: capture.source, fetchedAt: capture.fetchedAt, captureSha256: capture.captureSha256,
      symbols: Object.fromEntries(symbols.map((symbol) => [symbol, {
        closedCandles: capture.symbols[symbol].closedRows,
        from: capture.symbols[symbol].firstClosedOpenMs,
        to: capture.symbols[symbol].lastClosedAtMs,
        rawResponseSha256: capture.symbols[symbol].responseSha256,
      }])),
    },
    replayMethod: {
      decisionWindow: {
        timezone: PHT_WINDOW.timezone,
        from: new Date(PHT_WINDOW.fromMs).toISOString(),
        toExclusive: new Date(PHT_WINDOW.toMs).toISOString(),
        fromLocal: '2026-10-02T00:00:00+08:00',
        toExclusiveLocal: '2026-10-03T00:00:00+08:00',
        rawCaptureAt: capture.fetchedAt,
        closedCandleCoverageThrough: new Date(Math.min(...symbols.map((s) =>
          capture.symbols[s].lastClosedOpenMs + BAR))).toISOString(),
      },
      decisionInput: 'Only the latest 16 consecutive completed 15m candles ending at each decision close.',
      candidateMode: 'INTRADAY (explicitly supplied after the v8/v9 version argument).',
      entry: 'Next 15m candle open; candidates without the next bar are excluded.',
      horizon: 'INTRADAY; at most 4 bars / 60 minutes, per existing v8/v9 mode.',
      sameBar: 'If stop and target are both touched in one candle, stop is selected first.',
      riskControls: 'Model assumptions only: each pool/arm has independent $400 starting equity. Risk size is min(current modeled equity, $1,000) × 1%, or 0.5% after two recent losses in the optional reduced-risk scenario, then limited by remaining $400-principal daily loss ($20), weekly loss ($40), and cumulative drawdown ($120) budgets after $2 reserve. V8 only gets a modeled 3-consecutive-loss/4h gate; v9 does not. Preserve 32 daily entries, $100 margin cap, 5–10x leverage, $1,000 notional cap, one position, 45m cooldown, -5% daily, -10% weekly, -30% cumulative, +20% daily cap. UTC account-loss buckets; PHT market decision window.',
      drawdown: 'Modeled maximum drawdown is settled-close equity peak-to-trough only; intratrade mark-to-market drawdown is unknown from OHLC and is not claimed.',
      lossStreakPolicy: {
        v8: 'Modeled 3 consecutive settled losses blocks new entries for 4h after the last settled close.',
        v9: 'No consecutive-loss entry lock.',
        both: 'Optional separate risk mode halves sizing after at least 2 consecutive settled losses when the last settled close was within 4h.',
      },
      candidateSourceSha256,
    },
    formalFinancialEvidence: formallyUnavailable,
    eligibleCounts: {
      perSymbol,
      primaryPool: Object.fromEntries(MODES.map((version) =>
        [version, summarizeEvents(pooledEvents.PRIMARY_BTC_SOL_XRP[version])])),
      supplementaryPool: Object.fromEntries(MODES.map((version) =>
        [version, summarizeEvents(pooledEvents.SUPPLEMENTARY_ETH_LINK[version])])),
    },
    netRewardRiskSensitivity: {
      costs: 'MODELED ONLY; 10 bps or 20 bps round trip on each arm’s own notional. No observed production cost evidence.',
      thresholds: FLOORS,
      riskModes: RISK_MODES,
      scenarios: scenarioRows,
      modeledTrades: modeledResults,
    },
    recommendation: 'Keep net RR floor 1.5 unless point-in-time exact-notional cost evidence shows it prevents all feasible opportunities; these modeled sensitivities cannot justify relaxing it.',
  };
}

async function main() {
  const input = resolve(process.argv[2] ?? DEFAULT_INPUT);
  const output = resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const capture = JSON.parse(await readFile(input, 'utf8'));
  const candidateSourceSha256 = sha256(await readFile(CANDIDATE_SOURCE));
  const result = replayCapture(capture, { candidateSourceSha256 });
  const pretty = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(output, pretty);
  console.log(`replay=${output}`);
  for (const pool of ['primaryPool', 'supplementaryPool'])
    for (const [version, summary] of Object.entries(result.eligibleCounts[pool]))
      console.log(`${pool} ${version}: decisions=${summary.decisions} structural=${summary.eligibleBeforeEconomics} declines=${JSON.stringify(summary.declines)}`);
  for (const row of result.netRewardRiskSensitivity.scenarios)
    console.log(`${row.pool} ${row.version} ${row.riskMode} RR${row.netRewardRiskFloor} ${row.modeledCostScenario}: economics=${row.structuralEconomicsPassesAtInitialState} entries=${row.entries} modeledPnL=${row.modeledNetPnlUsd.toFixed(4)} settledDD=${row.modeledRealizedSettlementMaxDrawdownUsd.toFixed(4)}`);
  console.log(`measured-net-pnl=${result.formalFinancialEvidence.measuredNetPnlUsd ?? 'UNAVAILABLE'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();