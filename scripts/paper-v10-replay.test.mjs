import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  evaluatePatternAt, rankCandidateEvents, replayCapture, resolveBarOutcome, simulate,
  withholdCrossTimeframeOpposition,
} from './paper-v10-replay.mjs';

const FROM = Date.parse('2026-10-01T16:00:00Z');
const CAPTURE_AT = Date.parse('2026-10-02T16:00:00Z');
const BAR = 15 * 60_000;
const STEPS = { '15m': BAR, '1h': 3_600_000, '4h': 14_400_000 };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const require = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { buildSync, transform } = require('esbuild');

function candleSeries(tf, { neutralAt = null, breakoutAt = null } = {}) {
  const step = STEPS[tf];
  const start = Math.floor(FROM / step) * step - 100 * step;
  const count = Math.floor((CAPTURE_AT - start) / step);
  const prices = [];
  let previousClose = 100;
  const impulseAt = Math.floor((FROM + 8 * BAR) / step) * step;
  for (let i = 0; i < count; i++) {
    const t = start + i * step;
    const baseline = previousClose + .001;
    let row;
    if (t === impulseAt) {
      const open = baseline;
      row = [t, open, open + .52, open - .02, open + .50];
    } else if (t === neutralAt) {
      const open = baseline;
      row = [t, open + .2, open + .4, open - .2, open + .2];
    } else if (t === breakoutAt) {
      const open = previousClose;
      row = [t, open, open + .7, open - .05, open + .65];
    } else {
      const open = baseline;
      row = [t, open, open + .15, open - .15, open + .005];
    }
    prices.push(row);
    previousClose = row[4];
  }
  return prices;
}

function buildCapture(overrides = {}) {
  const capture = {
    schema: 'paper-v10-gmx-multitimeframe-capture/v1',
    source: 'https://arbitrum-api.gmxinfra.io/prices/candles',
    fetchedAt: new Date(CAPTURE_AT).toISOString(),
    decisionWindow: { timezone: 'Asia/Manila (UTC+08:00)', fromMs: FROM, toExclusiveMs: CAPTURE_AT },
    countRequestedPerSymbolTimeframe: 200,
    symbols: {},
  };
  const symbols = overrides.symbols ?? ['BTC'];
  for (const symbol of symbols) {
    capture.symbols[symbol] = {
      classification: ['BTC', 'SOL', 'XRP'].includes(symbol) ? 'PRIMARY' : 'SUPPLEMENTARY',
      timeframes: {},
    };
    for (const tf of Object.keys(STEPS)) {
      const prices = overrides.series?.[tf] ?? candleSeries(tf);
      const rawResponse = JSON.stringify({ candles: prices.map(([t, ...rest]) => [t / 1_000, ...rest]) });
      capture.symbols[symbol].timeframes[tf] = {
        sourceUrl: `https://arbitrum-api.gmxinfra.io/prices/candles?tokenSymbol=${symbol}&period=${tf}&limit=200`,
        intervalMs: STEPS[tf], responseSha256: sha256(rawResponse), rawResponse,
        rawRows: prices.length, closedRows: prices.length,
        firstClosedOpenMs: prices[0][0], lastClosedOpenMs: prices.at(-1)[0],
        lastClosedAtMs: prices.at(-1)[0] + STEPS[tf], excludedOpenOrFutureRows: 0, candles: prices,
      };
    }
  }
  capture.captureSha256 = sha256(JSON.stringify(capture));
  return capture;
}

test('v10 evaluation ignores every raw candle that is not closed at decision time', () => {
  const capture = buildCapture();
  const asset = capture.symbols.BTC;
  const decisionAt = FROM + 9 * BAR;
  const expected = evaluatePatternAt('BTC', asset, decisionAt);
  const mutated = structuredClone(asset);
  for (const tf of Object.keys(STEPS)) {
    const step = STEPS[tf];
    mutated.timeframes[tf].candles = mutated.timeframes[tf].candles.map((bar) =>
      bar[0] + step > decisionAt ? [bar[0], bar[1] * .1, bar[2] * 10, bar[3] * .01, bar[4] * 5] : bar);
  }
  assert.deepEqual(evaluatePatternAt('BTC', mutated, decisionAt), expected);
  assert.ok(expected.candidates.some((c) => c.patternId === 'BULLISH_MARUBOZU'));
});

test('confirmed candidates are actionable observed formation evidence with protective bounded stops', () => {
  const capture = buildCapture();
  const report = replayCapture(capture);
  const entries = report.modeledPortfolioScenarios.primary_v10_LOW_MODELED.trades;
  const event = entries.find((row) => row.patternId === 'BULLISH_MARUBOZU');
  assert.ok(event, 'a completed bullish marubozu should provide a reproducible trade fixture');
  assert.equal(event.direction, 'LONG');
  assert.ok(event.stopPrice < event.entryPrice);
  assert.ok(Math.abs(event.entryPrice - event.stopPrice) / event.entryPrice >= .002);
  assert.ok(Math.abs(event.entryPrice - event.stopPrice) / event.entryPrice <= .008);
  assert.equal(event.targetPrice, null, 'the engine must not invent a target');
  const candidate = report.candidateEvents.find((row) => row.eventId === event.eventId);
  assert.equal(candidate.evaluatedAt, candidate.decisionAt + 2_000);
  assert.ok(candidate.entryAt >= candidate.evaluatedAt);
  assert.equal(candidate.entryAt, candidate.evaluatedAt);
  assert.equal(candidate.quoteProxyAt, candidate.decisionAt);
  assert.equal(candidate.priceProxyBasis, 'NEXT_BAR_OPEN_ASSUMPTION');
  assert.equal(event.evaluatedAt, event.entryAt);
  assert.equal(event.quoteProxyAt, candidate.decisionAt);
  assert.equal(event.priceProxyBasis, 'NEXT_BAR_OPEN_ASSUMPTION');
});

test('neutral formations are WAIT until a later completed close confirms direction', () => {
  const neutralAt = Math.floor((FROM + 12 * BAR) / BAR) * BAR;
  const later = neutralAt + BAR;
  const series15 = candleSeries('15m', { neutralAt, breakoutAt: later });
  const capture = buildCapture({ series: { '15m': series15 } });
  const beforeConfirmation = evaluatePatternAt('BTC', capture.symbols.BTC, later);
  assert.ok(beforeConfirmation.waiting.some((entry) => entry.patternId === 'DOJI'
    || entry.patternId === 'DRAGONFLY_DOJI' || entry.patternId === 'GRAVESTONE_DOJI'));
  const confirmedAt = later + BAR;
  const afterConfirmation = evaluatePatternAt('BTC', capture.symbols.BTC, confirmedAt);
  assert.ok(afterConfirmation.candidates.some((entry) => entry.formationAt === neutralAt
    && ['LONG', 'SHORT'].includes(entry.direction)));
});

test('event identifiers do not duplicate, and malformed immutable capture is rejected', () => {
  const capture = buildCapture();
  const report = replayCapture(capture);
  assert.equal(report.inventory.v10CandidateUniqueEventIds, report.inventory.rawCandidateCount);
  const eventIds = report.candidateEvents.map((event) => event.eventId);
  assert.equal(new Set(eventIds).size, eventIds.length);
  const mutated = structuredClone(capture);
  mutated.symbols.BTC.timeframes['15m'].rawResponse += ' ';
  assert.throws(() => replayCapture(mutated), /PAPER_V10_CAPTURE_HASH_MISMATCH/);
  const badResponse = structuredClone(capture);
  badResponse.symbols.BTC.timeframes['15m'].rawResponse += ' ';
  const hashable = { ...badResponse };
  delete hashable.captureSha256;
  badResponse.captureSha256 = sha256(JSON.stringify(hashable));
  assert.throws(() => replayCapture(badResponse), /raw response hash mismatch/);
});

test('cross-timeframe opposing directions withhold every symbol candidate without merging patterns', () => {
  const events = [
    { eventId: 'btc-15-a', symbol: 'BTC', timeframe: '15m', direction: 'LONG', patternId: 'HAMMER', formationAt: 100 },
    { eventId: 'btc-1h-b', symbol: 'BTC', timeframe: '1h', direction: 'SHORT', patternId: 'DOJI', formationAt: 200 },
    { eventId: 'eth-15-c', symbol: 'ETH', timeframe: '15m', direction: 'LONG', patternId: 'MARUBOZU', formationAt: 300 },
  ];
  const result = withholdCrossTimeframeOpposition(events);
  assert.equal(result.events.length, events.length, 'all independent pattern candidates remain represented');
  assert.equal(result.events.filter((event) => event.symbol === 'BTC').length, 2);
  assert.ok(result.events.filter((event) => event.symbol === 'BTC')
    .every((event) => event.decline === 'CROSS_TIMEFRAME_OPPOSING_EVIDENCE_WITHHELD'));
  assert.equal(result.events.find((event) => event.symbol === 'ETH').decline, undefined);
  assert.deepEqual(result.conflicts.map((row) => row.timeframe), ['15m', '1h']);
});

test('candidate ranking is stable and matches runtime confirmation/timeframe/event ordering', () => {
  const events = [
    { eventId: 'z', confirmedAt: 10, timeframe: '1h' },
    { eventId: 'b', confirmedAt: 10, timeframe: '15m' },
    { eventId: 'a', confirmedAt: 10, timeframe: '15m' },
    { eventId: 'early', confirmedAt: 9, timeframe: '4h' },
  ];
  assert.deepEqual(rankCandidateEvents(events).map((event) => event.eventId), ['early', 'a', 'b', 'z']);
});

test('stop-first ambiguity and next-open protective-stop checks fail closed', () => {
  assert.deepEqual(resolveBarOutcome({
    side: 'LONG', stop: 95, target: 105, bar: [0, 100, 106, 94, 101],
  }), { exit: 95, result: 'AMBIGUOUS_STOP_FIRST' });
  const captureAt = CAPTURE_AT;
  const bars = [[FROM, 100, 101, 99, 100], [FROM + BAR, 100, 101, 99, 100]];
  const invalidStop = [{
    eventId: 'bad', symbol: 'BTC', timeframe: '15m', patternId: 'HAMMER',
    direction: 'LONG', entryAt: FROM + BAR, stopPrice: 99.9, targetPrice: null,
    expiresAt: FROM + BAR * 3, maxHoldMs: BAR,
  }];
  const result = simulate(invalidStop, { BTC: bars }, captureAt, { name: 'test', roundTripBps: 10 });
  assert.equal(result.entries, 0);
  assert.equal(result.blocked.STOP_INVALID_AT_NEXT_BAR_OPEN, 1);
  const beforeEvaluation = [{
    ...invalidStop[0], eventId: 'before-evaluation', stopPrice: 99.8,
    decisionAt: FROM, evaluatedAt: FROM + 2_000, entryAt: FROM + 1_000,
    quoteProxyAt: FROM,
  }];
  const chronology = simulate(beforeEvaluation, { BTC: bars }, captureAt, { name: 'test', roundTripBps: 10 });
  assert.equal(chronology.entries, 0);
  assert.equal(chronology.blocked.ENTRY_PRECEDES_EVALUATION, 1);
  const cappedNotional = [{
    ...invalidStop[0], eventId: 'cap', stopPrice: 99.8,
  }];
  const capped = simulate(cappedNotional, { BTC: bars }, captureAt, { name: 'test', roundTripBps: 10 });
  assert.ok(Math.abs(capped.trades[0].notionalUsd - 1_000) < 1e-8);
  assert.equal(capped.trades[0].leverage, 10);
  assert.ok(Math.abs(capped.trades[0].marginUsd - 100) < 1e-8);
});

test('daily loss budget and reserved per-trade risk stop further modeled entries', () => {
  const dayStart = Date.parse('2026-10-02T00:00:00Z');
  const bars = Array.from({ length: 60 }, (_, index) =>
    [dayStart + index * BAR, 100, 101, 99, 100]);
  const events = Array.from({ length: 12 }, (_, index) => ({
    eventId: `loss-${index}`, symbol: 'BTC', timeframe: '15m', patternId: 'HAMMER',
    direction: 'LONG', entryAt: dayStart + (index * 4 + 1) * BAR, stopPrice: 99.2,
    targetPrice: null, expiresAt: dayStart + (index * 4 + 4) * BAR, maxHoldMs: BAR,
  }));
  const result = simulate(events, { BTC: bars }, CAPTURE_AT, { name: 'test', roundTripBps: 10 });
  assert.equal(result.entries, 9);
  assert.equal(result.blocked.NO_REMAINING_RISK_BUDGET, 3);
  assert.equal(result.blocked.DAILY_LOSS_5_PERCENT, undefined);
  assert.ok(result.trades.every((trade) => trade.modeledNetPnlUsd < 0));
});

test('formal actual performance fields stay null even when modeled sensitivities are available', () => {
  const report = replayCapture(buildCapture());
  assert.equal(report.formalFinancialEvidence.classification, 'UNAVAILABLE');
  assert.equal(report.formalFinancialEvidence.actualNetPnlUsd, null);
  assert.equal(report.formalFinancialEvidence.actualMaxDrawdownUsd, null);
  assert.equal(report.formalFinancialEvidence.actualWinRate, null);
  assert.equal(report.formalFinancialEvidence.actualEntryPriceDelta, null);
  assert.ok(Object.values(report.modeledPortfolioScenarios).every((scenario) =>
    scenario.classification === 'MODELED_ONLY'));
});

test('baseline v9 is compiled with esbuild and cross-checks the pinned legacy source', async () => {
  const source = await readFile(new URL('../artifacts/api-server/src/workers/virtualPaperDailyCandidate.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'node20' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
  const capture = buildCapture();
  const bars = capture.symbols.BTC.timeframes['15m'].candles;
  const decisionAt = FROM + 9 * BAR;
  const past = bars.filter((bar) => bar[0] + BAR <= decisionAt);
  const candidate = module.dailyPaperCandidate('BTC', { source: 'gmx-official-api', prices: past },
    decisionAt + 2_000, 'v9', 'INTRADAY');
  assert.ok(candidate?.evaluation);
  assert.equal(candidate.evaluation.version, 'paper-entry-signals/v9');
  assert.equal(typeof candidate.evaluation.eligible, 'boolean');
  const v9Report = JSON.parse(await readFile(new URL('../docs/verification/paper-v9/causal-replay-2026-10-02.json', import.meta.url), 'utf8'));
  assert.equal(sha256(source), v9Report.replayMethod.candidateSourceSha256);
});