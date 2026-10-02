#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BAR = 15 * 60_000;
const TF_MS = { '15m': BAR, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000 };
const SYMBOLS = { primary: ['BTC', 'SOL', 'XRP'], supplementary: ['ETH', 'LINK'] };
const FROM = Date.parse('2026-10-01T16:00:00Z');
const TO = Date.parse('2026-10-02T16:00:00Z');
const COSTS = [{ name: 'LOW_MODELED', roundTripBps: 10 }, { name: 'HIGH_MODELED', roundTripBps: 20 }];
const NEUTRAL_PATTERN_IDS = new Set(['DOJI', 'DRAGONFLY_DOJI', 'GRAVESTONE_DOJI', 'SPINNING_TOP']);
const DEFAULT_INPUT = 'docs/verification/paper-v10/gmx-candles-2026-10-02.json';
const DEFAULT_OUTPUT = 'docs/verification/paper-v10/causal-replay-2026-10-02.json';
const ENGINE_SOURCE = new URL('../artifacts/api-server/src/intel/patterns/patternEntryStrategies.ts', import.meta.url);
const CANDIDATE_SOURCE = new URL('../artifacts/api-server/src/workers/virtualPaperDailyCandidate.ts', import.meta.url);
const LEGACY_POLICY_SOURCE = new URL('../artifacts/api-server/src/workers/virtualPaperDailyPolicy.ts', import.meta.url);
const PATTERN_RUNTIME_SOURCE = new URL('../artifacts/api-server/src/workers/virtualPaper400Runtime.ts', import.meta.url);
const PATTERN_CYCLE_SOURCE = new URL('../artifacts/api-server/src/workers/virtualPaperPatternDailyCycle.ts', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const finite = Number.isFinite;
const direction = (side) => side === 'LONG' ? 1 : -1;
const require = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { buildSync, transform } = require('esbuild');
const engineBuild = buildSync({
  entryPoints: [ENGINE_SOURCE.pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const engineModule = await import(`data:text/javascript;base64,${Buffer.from(engineBuild.outputFiles[0].contents).toString('base64')}`);
const { evaluatePatternEntries, CANONICAL_PATTERN_ENTRY_REGISTRY, PATTERN_ENTRY_VERSION } = engineModule;
const legacySourceText = await readFile(CANDIDATE_SOURCE, 'utf8');
const legacyBuild = await transform(legacySourceText, { loader: 'ts', format: 'esm', target: 'node20' });
const legacyModule = await import(`data:text/javascript;base64,${Buffer.from(legacyBuild.code).toString('base64')}`);
const { dailyPaperCandidate } = legacyModule;

export function resolveBarOutcome({ side, stop, target, bar }) {
  const long = side === 'LONG';
  if ((long && bar[1] <= stop) || (!long && bar[1] >= stop))
    return { exit: bar[1], result: 'STOP_GAP' };
  if (finite(target) && ((long && bar[1] >= target) || (!long && bar[1] <= target)))
    return { exit: bar[1], result: 'TARGET_GAP' };
  const stopTouched = long ? bar[3] <= stop : bar[2] >= stop;
  const targetTouched = finite(target) && (long ? bar[2] >= target : bar[3] <= target);
  if (stopTouched && targetTouched) return { exit: stop, result: 'AMBIGUOUS_STOP_FIRST' };
  if (stopTouched) return { exit: stop, result: 'STOP' };
  if (targetTouched) return { exit: target, result: 'TARGET' };
  return null;
}

function verifyCapture(capture) {
  if (capture.schema !== 'paper-v10-gmx-multitimeframe-capture/v1') throw new Error('PAPER_V10_CAPTURE_SCHEMA_INVALID');
  const hashable = { ...capture };
  delete hashable.captureSha256;
  if (sha256(JSON.stringify(hashable)) !== capture.captureSha256) throw new Error('PAPER_V10_CAPTURE_HASH_MISMATCH');
  const captureAt = Date.parse(capture.fetchedAt);
  if (!finite(captureAt) || captureAt <= FROM || FROM >= TO) throw new Error('PAPER_V10_CAPTURE_WINDOW_INVALID');
  for (const [symbol, asset] of Object.entries(capture.symbols)) for (const [tf, source] of Object.entries(asset.timeframes)) {
    const step = TF_MS[tf];
    if (!step || sha256(source.rawResponse) !== source.responseSha256)
      throw new Error(`${symbol} ${tf}: raw response hash mismatch or unknown timeframe`);
    const parsed = JSON.parse(source.rawResponse);
    if (!Array.isArray(parsed.candles)) throw new Error(`${symbol} ${tf}: raw candle schema invalid`);
    const unique = new Map(parsed.candles.map((row) => [row[0] * 1_000, [row[0] * 1_000, ...row.slice(1, 5)]]));
    const closed = [...unique.values()].sort((a, b) => a[0] - b[0]).filter((row) => row[0] + step <= captureAt);
    if (JSON.stringify(closed) !== JSON.stringify(source.candles))
      throw new Error(`${symbol} ${tf}: filtered candle data differs from immutable raw response`);
    if (closed.length < 60) throw new Error(`${symbol} ${tf}: fewer than 60 closed warmup candles`);
    for (let i = 0; i < closed.length; i++) {
      const row = closed[i];
      if (row[0] % step || row.slice(1).some((v) => !finite(v) || v <= 0)
        || row[2] < Math.max(row[1], row[3], row[4]) || row[3] > Math.min(row[1], row[2], row[4])
        || (i > 0 && row[0] - closed[i - 1][0] !== step))
        throw new Error(`${symbol} ${tf}: invalid or discontinuous closed candle series`);
    }
  }
  return captureAt;
}

function rawAtTimeframes(asset, decisionAt) {
  return Object.fromEntries(Object.entries(TF_MS).map(([tf, step]) => {
    const captured = asset.timeframes[tf].candles.filter((bar) => bar[0] + step <= decisionAt);
    return [tf, { source: 'gmx-official-api', prices: captured.map(([t, ...ohlc]) => [t, ...ohlc]) }];
  }));
}

function baselineAt(symbol, prices, index) {
  const decisionAt = prices[index][0] + BAR;
  const evaluatedAt = decisionAt + 2_000;
  const next = prices[index + 1];
  const candidate = dailyPaperCandidate(symbol, { source: 'gmx-official-api', prices: prices.slice(0, index + 1) },
    evaluatedAt, 'v9', 'INTRADAY');
  if (!candidate?.evaluation) return { symbol, decisionAt, evaluatedAt, entryAt: evaluatedAt,
    quoteProxyAt: decisionAt, priceProxyBasis: 'NEXT_BAR_OPEN_ASSUMPTION', decline: 'CANDIDATE_UNAVAILABLE' };
  const e = candidate.evaluation;
  const signal = e.selectedSetup ? e.signals.find((item) => item.kind === e.selectedSetup) : null;
  const side = signal?.side;
  const stop = e.observedStopPrice;
  const target = signal?.targetPrice;
  const entry = next[1];
  const stopFraction = finite(stop) && stop > 0 ? Math.abs(entry - stop) / entry : null;
  let decline = null;
  if (!e.eligible || !signal?.eligible || signal.side !== candidate.side) decline = e.reason ?? 'V9_SIGNAL_INELIGIBLE';
  else if (!side || !finite(stop)) decline = 'V9_SIDE_OR_STOP_UNAVAILABLE';
  else if (side === 'LONG' ? stop >= entry : stop <= entry) decline = 'V9_STOP_WRONG_SIDE_AT_NEXT_OPEN';
  else if (!finite(stopFraction) || stopFraction < .002 || stopFraction > .008) decline = 'V9_STOP_OUTSIDE_EXECUTOR_BOUNDS';
  else if (!finite(target) || (side === 'LONG' ? target <= entry : target >= entry)) decline = 'V9_OBSERVED_TARGET_NOT_AHEAD';
  else if (!finite(e.observedHorizonMoveFraction?.INTRADAY)
    || Math.abs(target / entry - 1) > e.observedHorizonMoveFraction.INTRADAY + 1e-10)
    decline = 'V9_TARGET_OUTSIDE_OBSERVED_HORIZON';
  return {
    symbol, decisionAt, evaluatedAt, entryAt: evaluatedAt, quoteProxyAt: decisionAt,
    priceProxyBasis: 'NEXT_BAR_OPEN_ASSUMPTION', side: side ?? null, setup: e.selectedSetup ?? null,
    stopPrice: finite(stop) ? stop : null, targetPrice: finite(target) ? target : null,
    entryPrice: entry, stopFraction, eligibleBeforeEconomics: decline === null, decline,
  };
}

function legacyEconomics(event, cost) {
  const riskBudget = 4;
  const distance = event.stopFraction;
  const notional = Math.min(1_000, Math.max(0, riskBudget - 2) / distance);
  const modeledCost = notional * cost.roundTripBps / 10_000;
  const grossReward = notional * (event.targetPrice / event.entryPrice - 1) * direction(event.side);
  const netRisk = notional * distance + 2;
  const netReward = grossReward - modeledCost;
  const netRR = netReward / netRisk;
  const leverage = Math.floor(Math.min(10, notional * .1 / netRisk) + 1e-10);
  const margin = notional / leverage;
  const eligible = finite(netRR) && netReward > 0 && netRR >= 1.5 - 1e-10
    && modeledCost <= 2 + 1e-10 && netRisk <= riskBudget + 1e-8
    && leverage >= 5 && finite(margin) && margin >= 1.1 && margin <= 100;
  return { eligible, netRR, modeledCost, notional, leverage, margin,
    reason: eligible ? null : 'V9_OLD_NET_RR_COST_OR_MARGIN_GATE' };
}

function closeTrade(event, prices, capturedAt) {
  const quoteProxyAt = event.quoteProxyAt ?? event.entryAt;
  const entryIndex = prices.findIndex((bar) => bar[0] === quoteProxyAt);
  if (entryIndex < 0) return { exitAt: Infinity, result: 'PENDING_NO_ENTRY_BAR' };
  const holdDeadline = event.entryAt + event.maxHoldMs;
  for (let offset = 0; entryIndex + offset < prices.length; offset++) {
    const bar = prices[entryIndex + offset];
    const barCloseAt = bar[0] + BAR;
    if (barCloseAt > capturedAt) break;
    const hit = resolveBarOutcome({ side: event.direction, stop: event.stopPrice, target: event.targetPrice, bar });
    if (hit) return { ...hit, exitAt: barCloseAt, barsHeld: offset + 1 };
    if (barCloseAt >= holdDeadline)
      return { exit: bar[4], result: 'MAX_HOLD_CLOSE',
        exitAt: barCloseAt, barsHeld: offset + 1 };
  }
  return { exitAt: Infinity, result: 'PENDING_INCOMPLETE_CAPTURE' };
}

export function withholdCrossTimeframeOpposition(events) {
  const sidesBySymbol = new Map();
  for (const event of events) {
    if (!sidesBySymbol.has(event.symbol)) sidesBySymbol.set(event.symbol, new Set());
    sidesBySymbol.get(event.symbol).add(event.direction);
  }
  const conflictedSymbols = new Set([...sidesBySymbol]
    .filter(([, sides]) => sides.size > 1).map(([symbol]) => symbol));
  const conflicts = [];
  for (const symbol of [...conflictedSymbols].sort()) {
    const rows = events.filter((event) => event.symbol === symbol);
    const timeframes = [...new Set(rows.map((event) => event.timeframe))].sort();
    for (const timeframe of timeframes) {
      const local = rows.filter((event) => event.timeframe === timeframe);
      const formationAt = Math.max(...local.map((event) => event.formationAt));
      conflicts.push({ symbol, timeframe, formationAt,
        eventId: `${symbol}:CROSS_TIMEFRAME_CONFLICT:${timeframe}:${formationAt}` });
    }
  }
  return {
    conflictedSymbols,
    conflicts,
    events: events.map((event) => conflictedSymbols.has(event.symbol)
      ? { ...event, decline: 'CROSS_TIMEFRAME_OPPOSING_EVIDENCE_WITHHELD' } : event),
  };
}

function summarizeReasons(rows, key) {
  const result = {};
  for (const row of rows) {
    const reason = row[key] ?? 'ELIGIBLE';
    result[reason] = (result[reason] ?? 0) + 1;
  }
  return result;
}

export function evaluatePatternAt(symbol, asset, decisionAt) {
  return evaluatePatternEntries(symbol, rawAtTimeframes(asset, decisionAt), decisionAt + 2_000, 'INTRADAY');
}

export function rankCandidateEvents(events) {
  return [...events].sort((a, b) => (a.confirmedAt ?? a.entryAt) - (b.confirmedAt ?? b.entryAt)
    || a.timeframe.localeCompare(b.timeframe) || a.eventId.localeCompare(b.eventId));
}

export function simulate(events, candlesBySymbol, captureAt, cost, { legacyGates = false } = {}) {
  const queue = rankCandidateEvents(events);
  let equity = 400;
  let peak = equity;
  let maxClosedDrawdown = 0;
  let heldUntil = -Infinity;
  let lastEntryAt = -Infinity;
  let lastCloseAt = null;
  let entries = 0;
  const dailyPnl = new Map();
  const weeklyPnl = new Map();
  const dailyEntries = new Map();
  const blocked = {};
  const trades = [];
  const block = (reason) => { blocked[reason] = (blocked[reason] ?? 0) + 1; };
  for (const event of queue) {
    const day = new Date(event.entryAt).toISOString().slice(0, 10);
    const weekday = (new Date(event.entryAt).getUTCDay() + 6) % 7;
    const week = new Date(event.entryAt - weekday * 86_400_000).toISOString().slice(0, 10);
    const daily = dailyPnl.get(day) ?? 0;
    const weekly = weeklyPnl.get(week) ?? 0;
    if (event.entryAt < heldUntil) { block('SINGLE_POSITION_HELD'); continue; }
    if (entries >= 1_000) { block('GLOBAL_MAX_TRADES_1000'); continue; }
    if (legacyGates && event.entryAt - lastEntryAt < 45 * 60_000) { block('LEGACY_POLICY_COOLDOWN_45M'); continue; }
    if (legacyGates && (dailyEntries.get(day) ?? 0) >= 32) { block('LEGACY_POLICY_MAX_DAILY_ENTRIES_32'); continue; }
    if (daily <= -20) { block('DAILY_LOSS_5_PERCENT'); continue; }
    if (weekly <= -40) { block('WEEKLY_LOSS_10_PERCENT'); continue; }
    if (equity <= 280) { block('CUMULATIVE_LOSS_30_PERCENT'); continue; }
    if (legacyGates && daily >= 80) { block('LEGACY_POLICY_DAILY_PROFIT_CAP_20_PERCENT'); continue; }
    const evaluatedAt = event.evaluatedAt ?? (event.decisionAt !== undefined
      ? event.decisionAt + 2_000 : event.entryAt);
    if (event.entryAt < evaluatedAt) {
      block('ENTRY_PRECEDES_EVALUATION');
      continue;
    }
    const proxyAt = event.quoteProxyAt ?? event.entryAt;
    const bar = candlesBySymbol[event.symbol].find((row) => row[0] === proxyAt);
    if (!bar) { block('NEXT_BAR_OPEN_UNAVAILABLE'); continue; }
    const entry = bar[1];
    const stopFraction = Math.abs(entry - event.stopPrice) / entry;
    if (!finite(stopFraction) || stopFraction < .002 - 1e-10 || stopFraction > .008 + 1e-10
      || (event.direction === 'LONG' ? event.stopPrice >= entry : event.stopPrice <= entry)) {
      block('STOP_INVALID_AT_NEXT_BAR_OPEN'); continue;
    }
    // The v10 worker currently passes null as dailyPaperRiskPct's last-close time.
    const throttle = 1;
    const riskBudget = Math.min(equity, 1_000) * .01 * throttle;
    const remainingDaily = Math.max(0, 20 + daily);
    const remainingWeekly = Math.max(0, 40 + weekly);
    const remainingCumulative = Math.max(0, equity - 280);
    const risk = Math.min(riskBudget, remainingDaily, remainingWeekly, remainingCumulative);
    const notional = Math.min(1_000, Math.max(0, risk - 2) / stopFraction);
    if (!(notional > 0)) { block('NO_REMAINING_RISK_BUDGET'); continue; }
    const leverage = Math.min(10, Math.max(5, Math.ceil(notional / 100)));
    const margin = notional / leverage;
    if (margin > 100 + 1e-10) { block('MARGIN_CAP_100'); continue; }
    const path = closeTrade(event, candlesBySymbol[event.symbol], captureAt);
    entries++;
    dailyEntries.set(day, (dailyEntries.get(day) ?? 0) + 1);
    lastEntryAt = event.entryAt;
    heldUntil = path.exitAt;
    if (!finite(path.exit)) {
      trades.push({ eventId: event.eventId, symbol: event.symbol, timeframe: event.timeframe,
        patternId: event.patternId, direction: event.direction, decisionAt: event.decisionAt ?? null,
        evaluatedAt: event.evaluatedAt ?? null, entryAt: event.entryAt,
        quoteProxyAt: event.quoteProxyAt ?? event.entryAt,
        priceProxyBasis: event.priceProxyBasis ?? 'NEXT_BAR_OPEN_ASSUMPTION',
        entryPrice: entry, stopPrice: event.stopPrice, targetPrice: event.targetPrice,
        notionalUsd: notional, leverage, marginUsd: margin, modeledCostUsd: notional * cost.roundTripBps / 10_000,
        exitReason: path.result, exitAt: null, modeledNetPnlUsd: null });
      continue;
    }
    const gross = notional * (path.exit / entry - 1) * direction(event.direction);
    const fee = notional * cost.roundTripBps / 10_000;
    const pnl = gross - fee;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxClosedDrawdown = Math.max(maxClosedDrawdown, peak - equity);
    dailyPnl.set(day, daily + pnl);
    weeklyPnl.set(week, weekly + pnl);
    lastCloseAt = path.exitAt;
    trades.push({ eventId: event.eventId, symbol: event.symbol, timeframe: event.timeframe,
      patternId: event.patternId, direction: event.direction, decisionAt: event.decisionAt ?? null,
      evaluatedAt: event.evaluatedAt ?? null, entryAt: event.entryAt,
      quoteProxyAt: event.quoteProxyAt ?? event.entryAt,
      priceProxyBasis: event.priceProxyBasis ?? 'NEXT_BAR_OPEN_ASSUMPTION',
      entryPrice: entry, stopPrice: event.stopPrice, targetPrice: event.targetPrice,
      notionalUsd: notional, leverage, marginUsd: margin, modeledCostUsd: fee,
      exitPrice: path.exit, exitAt: path.exitAt, exitReason: path.result,
      modeledGrossPnlUsd: gross, modeledNetPnlUsd: pnl });
  }
  return {
    classification: 'MODELED_ONLY',
    assumedInitialEquityUsd: 400,
    riskPerTradePct: 1,
    legacyV9OperationalGatesApplied: legacyGates,
    currentV10Throttle: '1.0x only: virtualPaperPatternDailyCycle currently calls dailyPaperRiskPct(consecutiveLossCount, null, now), so the helper cannot apply its 0.5x reduction without a last-close timestamp.',
    modeledCost: cost,
    eligibleEvents: events.length,
    entries,
    blocked,
    modeledNetPnlUsd: trades.reduce((sum, t) => sum + (t.modeledNetPnlUsd ?? 0), 0),
    modeledSettledMaxDrawdownUsd: maxClosedDrawdown,
    modeledEndingEquityUsd: equity,
    pendingOpenTrades: trades.filter((t) => t.modeledNetPnlUsd === null).length,
    trades,
  };
}

export function replayCapture(capture, { sourcePins = {} } = {}) {
  const captureAt = verifyCapture(capture);
  const candidates = [];
  const baseline = [];
  const observations = {
    neutralWaitingEventIds: new Set(), otherWaitingEventIds: new Set(), conflictEventIds: new Set(),
    crossTimeframeConflictEventIds: new Set(), candidateEventIds: new Set(), waitingReasonCounts: {},
  };
  const perSymbol = {};
  const candlesBySymbol = {};
  for (const [poolName, symbols] of Object.entries(SYMBOLS)) {
    for (const symbol of symbols) {
      const asset = capture.symbols[symbol];
      if (!asset) continue;
      const prices15 = asset.timeframes['15m'].candles;
      candlesBySymbol[symbol] = prices15;
      perSymbol[symbol] = {
        pool: poolName,
        closedCandlesByTimeframe: Object.fromEntries(Object.entries(asset.timeframes).map(([tf, d]) => [tf, d.closedRows])),
        v10: { decisions: 0, candidates: 0, waitingObservations: 0, conflictObservations: 0, declines: {} },
        v9Baseline: { decisions: 0, candidates: 0, declines: {} },
      };
      for (let i = 0; i < prices15.length - 1; i++) {
        const decisionAt = prices15[i][0] + BAR;
        if (decisionAt < FROM || decisionAt >= TO || decisionAt > captureAt) continue;
        perSymbol[symbol].v10.decisions++;
        const engineResult = evaluatePatternAt(symbol, asset, decisionAt);
        const evaluatedAt = decisionAt + 2_000;
        const crossTimeframe = withholdCrossTimeframeOpposition(engineResult.candidates.map((item) => ({
          ...item, symbol,
        })));
        for (const conflict of crossTimeframe.conflicts)
          observations.crossTimeframeConflictEventIds.add(conflict.eventId);
        for (const w of engineResult.waiting) {
          if (w.reason.startsWith('CONFLICT:')) continue;
          const destination = NEUTRAL_PATTERN_IDS.has(w.patternId)
            ? observations.neutralWaitingEventIds : observations.otherWaitingEventIds;
          destination.add(w.eventId);
          observations.waitingReasonCounts[w.reason] = (observations.waitingReasonCounts[w.reason] ?? 0) + 1;
        }
        for (const c of engineResult.conflicts) observations.conflictEventIds.add(c.eventId);
        perSymbol[symbol].v10.waitingObservations += engineResult.waiting.length;
        perSymbol[symbol].v10.conflictObservations += engineResult.conflicts.length;
        for (const item of crossTimeframe.events) {
          if (observations.candidateEventIds.has(item.eventId)) continue;
          observations.candidateEventIds.add(item.eventId);
          perSymbol[symbol].v10.candidates++;
          const entryBar = prices15.find((bar) => bar[0] === decisionAt);
          let decline = item.decline ?? null;
          if (!decline && item.confirmedAt > evaluatedAt) decline = 'UNCONFIRMED_AT_EVALUATION';
          else if (!decline && evaluatedAt - item.confirmedAt > 60_000) decline = 'PATTERN_CONFIRMATION_STALE';
          else if (!decline && evaluatedAt >= item.expiresAt) decline = 'ENTRY_TRIGGER_EXPIRED';
          if (!decline && !entryBar) decline = 'NEXT_15M_BAR_OPEN_UNAVAILABLE';
          if (!decline) {
            const entry = entryBar[1];
            const stopFraction = Math.abs(entry - item.stopPrice) / entry;
            const triggerValid = item.direction === 'LONG' ? entry + 1e-10 >= item.triggerPrice : entry - 1e-10 <= item.triggerPrice;
            if (!triggerValid) decline = 'PATTERN_TRIGGER_NOT_CURRENT_AT_NEXT_OPEN';
            else if (Math.abs(entry / item.referencePrice - 1) > .02) decline = 'PATTERN_REFERENCE_PRICE_DRIFT';
            else if (!finite(item.stopPrice) || (item.direction === 'LONG' ? item.stopPrice >= entry : item.stopPrice <= entry))
              decline = 'STOP_WRONG_SIDE_AT_NEXT_OPEN';
            else if (!finite(stopFraction) || stopFraction < .002 - 1e-10 || stopFraction > .008 + 1e-10)
              decline = 'STOP_OUTSIDE_EXECUTOR_BOUNDS_AT_NEXT_OPEN';
            else if (item.targetPrice !== null
              && (item.direction === 'LONG' ? item.targetPrice <= entry : item.targetPrice >= entry))
              decline = 'OBSERVED_TARGET_NOT_AHEAD_AT_NEXT_OPEN';
          }
          if (decline) perSymbol[symbol].v10.declines[decline] = (perSymbol[symbol].v10.declines[decline] ?? 0) + 1;
          candidates.push({
            eventId: item.eventId, durableFormationId: item.durableFormationId,
            symbol, patternId: item.patternId, timeframe: item.timeframe,
            direction: item.direction, formationAt: item.formationAt, confirmedAt: item.confirmedAt,
            decisionAt, evaluatedAt, entryAt: evaluatedAt, quoteProxyAt: decisionAt,
            priceProxyBasis: 'NEXT_BAR_OPEN_ASSUMPTION',
            triggerPrice: item.triggerPrice, referencePrice: item.referencePrice,
            stopPrice: item.stopPrice, targetPrice: item.targetPrice, expiresAt: item.expiresAt,
            maxHoldMs: item.maxHoldMs, supportingPatternIds: item.supportingPatternIds,
            conflictingPatternIds: item.conflictingPatternIds, auxiliary: item.auxiliary,
            decline,
          });
        }
        const old = baselineAt(symbol, prices15, i);
        perSymbol[symbol].v9Baseline.decisions++;
        if (old.decline === null) {
          perSymbol[symbol].v9Baseline.candidates++;
          baseline.push(old);
        } else perSymbol[symbol].v9Baseline.declines[old.decline] =
          (perSymbol[symbol].v9Baseline.declines[old.decline] ?? 0) + 1;
      }
    }
  }
  const candidatePool = (pool) => candidates.filter((e) => pool.includes(e.symbol));
  const eligibleCandidates = candidates.filter((e) => e.decline === null);
  const baselinePool = (pool) => baseline.filter((e) => pool.includes(e.symbol));
  const scenarios = {};
  for (const [poolName, symbols] of Object.entries(SYMBOLS)) {
    const v10Events = eligibleCandidates.filter((e) => symbols.includes(e.symbol));
    for (const cost of COSTS) scenarios[`${poolName}_v10_${cost.name}`] =
      simulate(v10Events, candlesBySymbol, captureAt, cost);
    for (const cost of COSTS) {
      const economicallyEligible = baselinePool(symbols).filter((event) => legacyEconomics(event, cost).eligible);
      scenarios[`${poolName}_v9_baseline_${cost.name}`] =
        simulate(economicallyEligible.map((old) => ({
          eventId: `${old.symbol}:v9:${old.decisionAt}`, symbol: old.symbol,
          patternId: old.setup, timeframe: '15m', direction: old.side,
          decisionAt: old.decisionAt, evaluatedAt: old.evaluatedAt, entryAt: old.entryAt,
          quoteProxyAt: old.quoteProxyAt, priceProxyBasis: old.priceProxyBasis,
          confirmedAt: old.decisionAt, stopPrice: old.stopPrice, targetPrice: old.targetPrice,
          expiresAt: old.entryAt + 4 * BAR, maxHoldMs: 4 * BAR,
        })), candlesBySymbol, captureAt, cost, { legacyGates: true });
      scenarios[`${poolName}_v9_baseline_${cost.name}`].structuralCandidates = baselinePool(symbols).length;
      scenarios[`${poolName}_v9_baseline_${cost.name}`].economicsDeclines =
        baselinePool(symbols).length - economicallyEligible.length;
    }
  }
  const patterns = {};
  const timeframeCounts = {};
  for (const event of eligibleCandidates) {
    patterns[event.patternId] = (patterns[event.patternId] ?? 0) + 1;
    timeframeCounts[event.timeframe] = (timeframeCounts[event.timeframe] ?? 0) + 1;
  }
  return {
    schema: 'paper-v10-causal-replay/v1',
    capture: {
      source: capture.source, fetchedAt: capture.fetchedAt, captureSha256: capture.captureSha256,
      decisionWindow: { from: new Date(FROM).toISOString(), toExclusive: new Date(TO).toISOString(),
        capturedThrough: new Date(captureAt).toISOString(),
        localFrom: '2026-10-02T00:00:00+08:00', localToExclusive: '2026-10-03T00:00:00+08:00' },
      symbols: Object.fromEntries(Object.entries(capture.symbols).map(([symbol, asset]) => [symbol, {
        classification: asset.classification,
        timeframes: Object.fromEntries(Object.entries(asset.timeframes).map(([tf, d]) => [tf, {
          closedCandles: d.closedRows, firstClosedOpenMs: d.firstClosedOpenMs,
          lastClosedAtMs: d.lastClosedAtMs, rawResponseSha256: d.responseSha256,
        }])),
      }])),
    },
    sourcePins,
    engine: { version: PATTERN_ENTRY_VERSION, registryCount: CANONICAL_PATTERN_ENTRY_REGISTRY.length,
      registryPatternIds: CANONICAL_PATTERN_ENTRY_REGISTRY.map((entry) => entry.patternId) },
    replayMethod: {
      causality: 'At each 15m close, each timeframe receives only bars completed by that decision timestamp; detector is recomputed from official raw OHLC. Evaluation occurs at decisionAt + 2 seconds to respect the engine closed-bar buffer. Right-confirmed pivots remain unavailable until their two right bars have closed.',
      entry: 'Modeled entryAt is the post-confirmation evaluatedAt (decisionAt + 2 seconds). Price and trigger checks use only the next 15m candle open at quoteProxyAt=decisionAt as an explicit NEXT_BAR_OPEN_ASSUMPTION, not an observed quote or fill; no future candle high/low/close is used during candidate selection. First two seconds of entry-bar intrabar path are unobservable; OHLC stop/time outcomes are conservative proxies. Each durable eventId is consumed at most once.',
      admission: 'V10 formation/confirmation, valid protective stop, observed target if any, executor stop bounds, expiry, and account limits only. No legacy quality, momentum, regime, horizon, or net-RR filter vetoes v10.',
      neutralAndConflict: 'Neutral formations awaiting completed breakout are counted as WAIT; same-timeframe opposite-side evidence is counted as conflict and withheld by the engine. As in the runtime, if current issued candidates for one symbol contain opposing directions across timeframes, all those candidates are withheld for that evaluation snapshot. Same-side pattern events remain independent and are ranked by confirmedAt, timeframe, then eventId.',
      exits: 'Observed individual stop; observed target only when supplied by evidence; otherwise first completed close at or after evaluatedAt + maxHoldMs. Stop-first on simultaneous stop/target; adverse gap uses the opening price. The first entry-bar OHLC covers an unknown initial two-second path, conservatively treated as potentially touching the stop.',
      modelRisk: 'Model only: $400 assumed starting equity, 1% risk budget less the policy $2 reserve before stop-distance notional sizing, $1,000 notional cap, 5–10x leverage, $100 margin cap, one position, 5% daily / 10% weekly / 30% cumulative loss limits. The v10 worker intentionally omits v9 45m cooldown, 32-entry daily cap, and 20% profit cap; a 1,000-entry global ceiling only bounds this replay. The worker currently passes null as dailyPaperRiskPct last-close time, so its applied sizing throttle is 1x; the 0.5x helper branch is not active.',
      cost: '10 and 20 bps round-trip costs are explicit model assumptions only. Formal actual account performance is unavailable.',
      comparison: 'Legacy v9 baseline applies dailyPaperCandidate(..., v9, INTRADAY), initial-state 1.5 net-RR / 10-or-20bp / margin gates, and the v9 45m cooldown / 32-entry / 20% profit-cap controls. It is not passed through v10 rules.',
      knownUnavailable: 'Point-in-time exact-notional quotes, exchange fills, fee/funding ledger, and account state are absent; actual net PnL, actual max drawdown, actual win rate, and actual entry-price delta are null.',
      sourcePins,
    },
    inventory: {
      rawCandidateCount: candidates.length,
      v10CandidatesByPool: Object.fromEntries(Object.entries(SYMBOLS).map(([pool, syms]) =>
        [pool, candidatePool(syms).length])),
      v10ExecutableCandidateCount: eligibleCandidates.length,
      v10ExecutableCandidatesByPool: Object.fromEntries(Object.entries(SYMBOLS).map(([pool, syms]) =>
        [pool, eligibleCandidates.filter((event) => syms.includes(event.symbol)).length])),
      v10CandidateDeclines: summarizeReasons(candidates, 'decline'),
      v9BaselineEvaluatedDecisions: Object.values(perSymbol).reduce((sum, data) => sum + data.v9Baseline.decisions, 0),
      v9BaselineStructurallyEligibleCandidates: baseline.length,
      v9BaselineEconomicAcceptanceAtInitialState: Object.fromEntries(COSTS.map((cost) => [cost.name,
        baseline.filter((event) => legacyEconomics(event, cost).eligible).length])),
      v9BaselineByPool: Object.fromEntries(Object.entries(SYMBOLS).map(([pool, syms]) =>
        [pool, baselinePool(syms).length])),
      v9BaselineDeclines: Object.fromEntries(Object.entries(perSymbol).map(([symbol, data]) =>
        [symbol, data.v9Baseline.declines])),
      v10WaitingNeutralUniqueEventIds: observations.neutralWaitingEventIds.size,
      v10OtherWaitingUniqueEventIds: observations.otherWaitingEventIds.size,
      v10WaitingReasonObservations: observations.waitingReasonCounts,
      v10ConflictUniqueEventIds: observations.conflictEventIds.size,
       v10CrossTimeframeConflictUniqueEventIds: observations.crossTimeframeConflictEventIds.size,
      v10CandidateUniqueEventIds: observations.candidateEventIds.size,
      v10ExecutableCandidatesByPattern: patterns,
      v10ExecutableCandidatesByTimeframe: timeframeCounts,
      leadingV10Candidates: eligibleCandidates.slice().sort((a, b) => a.decisionAt - b.decisionAt
        || a.symbol.localeCompare(b.symbol) || a.timeframe.localeCompare(b.timeframe)).slice(0, 30).map((event) => ({
        eventId: event.eventId, symbol: event.symbol, patternId: event.patternId, timeframe: event.timeframe,
        direction: event.direction, formationAt: event.formationAt, confirmedAt: event.confirmedAt,
        triggerPrice: event.triggerPrice, stopPrice: event.stopPrice, targetPrice: event.targetPrice,
         evaluatedAt: event.evaluatedAt, entryAt: event.entryAt,
         quoteProxyAt: event.quoteProxyAt, priceProxyBasis: event.priceProxyBasis,
      })),
      perSymbol,
    },
    candidateEvents: candidates,
    modeledPortfolioScenarios: scenarios,
    formalFinancialEvidence: {
      classification: 'UNAVAILABLE',
      reason: 'No point-in-time exact-notional quote/fill, actual account state, or realized fee/funding evidence was captured.',
      actualNetPnlUsd: null, actualMaxDrawdownUsd: null, actualWinRate: null, actualEntryPriceDelta: null,
    },
    sampleLimits: [
      'Oct 2 PHT replay includes only the captured closed-bar portion of the requested day; no future bars are inferred.',
      'The five-symbol set includes BTC/SOL/XRP primary and separately labeled ETH/LINK supplementary samples.',
      'The next-bar open is only a modeled price proxy, not a quote or fill. Entry is timestamped at evaluation (two seconds after the close); the first two seconds of the entry-bar intrabar path are unknown. Conservative OHLC stop/time proxies cannot recover actual execution chronology.',
      'No actual account state, exact-notional market impact, funding, fills, or fees are available; modeled costs are not factual performance.',
    ],
  };
}

async function main() {
  const input = resolve(process.argv[2] ?? DEFAULT_INPUT);
  const output = resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const capture = JSON.parse(await readFile(input, 'utf8'));
  const sourcePins = {
    patternEntryStrategiesSha256: sha256(await readFile(ENGINE_SOURCE)),
    chartPatternsSha256: sha256(await readFile(new URL('../artifacts/api-server/src/intel/patterns/chartPatterns.ts', import.meta.url))),
    virtualPaper400RuntimeSha256: sha256(await readFile(PATTERN_RUNTIME_SOURCE)),
    virtualPaperPatternDailyCycleSha256: sha256(await readFile(PATTERN_CYCLE_SOURCE)),
    v9CandidateSha256: sha256(await readFile(CANDIDATE_SOURCE)),
    v9PolicySha256: sha256(await readFile(LEGACY_POLICY_SOURCE)),
  };
  const report = replayCapture(capture, { sourcePins });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`replay=${output}`);
  console.log(`primary v10 candidates=${report.inventory.v10CandidatesByPool.primary} executable=${report.inventory.v10ExecutableCandidateCount}; v9 structural baseline=${report.inventory.v9BaselineByPool.primary}`);
  console.log(`unique waits=${report.inventory.v10WaitingNeutralUniqueEventIds}; conflicts=${report.inventory.v10ConflictUniqueEventIds}`);
  console.log(`formal actual net PnL=${report.formalFinancialEvidence.actualNetPnlUsd ?? 'UNAVAILABLE'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();