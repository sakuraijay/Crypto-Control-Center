import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  evaluateCandidateAt, evaluateDecision, MAX_DAILY_ENTRIES, modeledHalfRiskApplies,
  replayCapture, resolveBarOutcome, v8ThreeLossLockApplies,
} from './paper-v9-replay.mjs';

const input = 'docs/verification/paper-v9/gmx-candles-2026-10-02.json';
const PHT_FROM = Date.parse('2026-10-01T16:00:00Z');
const PHT_TO = Date.parse('2026-10-02T16:00:00Z');
const BASELINE_SHA = 'e8a6502618a2e971c6e5f91a3d43dcea2aff71bd';
const BASELINE_CANDIDATE_SHA = 'c1be76e7213bc0aefed5d162d7c35f28ed052f68b33da921343a8837e7a17ded';
const require = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { transform } = require('esbuild');

async function importBaselineCandidate() {
  const source = execFileSync('git', ['show', `${BASELINE_SHA}:artifacts/api-server/src/workers/virtualPaperDailyCandidate.ts`], { encoding: 'utf8' });
  assert.equal(createHash('sha256').update(source).digest('hex'), BASELINE_CANDIDATE_SHA);
  const compiled = await transform(source, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
}

function baselineV8Fields(candidate) {
  if (!candidate) return null;
  const e = candidate.evaluation;
  return {
    side: candidate.side,
    referencePrice: candidate.referencePrice,
    stopFraction: candidate.stopFraction,
    legacyQuality: candidate.legacyQuality,
    legacySide: candidate.legacySide,
    legacyStopFraction: candidate.legacyStopFraction,
    evaluation: e && {
      version: e.version,
      regime: e.regime,
      atrFraction: e.atrFraction,
      symbolMedianTrueRangeFraction: e.symbolMedianTrueRangeFraction,
      adaptiveVolatilityMin: e.adaptiveVolatilityMin,
      adaptiveVolatilityMax: e.adaptiveVolatilityMax,
      efficiency: e.efficiency,
      momentumFraction: e.momentumFraction,
      stopPrice: e.eligible ? e.stopPrice : null,
      stopFraction: e.stopFraction,
      observedHorizonMoveFraction: e.observedHorizonMoveFraction,
      signals: e.signals.map((signal) => ({
        kind: signal.kind, side: signal.side, score: signal.score, threshold: signal.threshold,
        eligible: signal.eligible, reason: signal.reason, targetPrice: signal.targetPrice,
        targetBasis: signal.targetBasis,
      })),
      selectedSetup: e.selectedSetup,
      selectedScore: e.selectedScore,
      scoreThreshold: e.scoreThreshold,
      eligible: e.eligible,
    },
  };
}

test('decision features ignore every candle after the decision and next-open entry', async () => {
  const capture = JSON.parse(await readFile(input, 'utf8'));
  const prices = capture.symbols.BTC.candles;
  const index = 90;
  const original = evaluateDecision({ symbol: 'BTC', prices, index, version: 'v9' });
  const corruptedFuture = prices.map((bar, i) => i > index + 1
    ? [bar[0], bar[1] * .1, bar[2] * 10, bar[3] * .01, bar[4] * 5]
    : bar);
  const withFutureMutation = evaluateDecision({ symbol: 'BTC', prices: corruptedFuture, index, version: 'v9' });
  assert.deepEqual(withFutureMutation, original);
});

test('same-bar stop/target ambiguity resolves against the position', () => {
  assert.deepEqual(resolveBarOutcome({
    side: 'LONG', stop: 95, target: 105, bar: [0, 100, 106, 94, 101],
  }), { exit: 95, result: 'AMBIGUOUS_STOP_FIRST' });
  assert.deepEqual(resolveBarOutcome({
    side: 'SHORT', stop: 105, target: 95, bar: [0, 100, 106, 94, 99],
  }), { exit: 105, result: 'AMBIGUOUS_STOP_FIRST' });
  assert.deepEqual(resolveBarOutcome({
    side: 'LONG', stop: 95, target: 105, bar: [0, 90, 102, 89, 100],
  }), { exit: 90, result: 'STOP_GAP' });
});

test('v8 replay matches the original HEAD candidate on today-window candidate inputs', async () => {
  const { dailyPaperCandidate: originalV8 } = await importBaselineCandidate();
  const capture = JSON.parse(await readFile(input, 'utf8'));
  let checked = 0;
  for (const symbol of ['BTC', 'SOL', 'XRP']) {
    const prices = capture.symbols[symbol].candles;
    for (let i = 15; i < prices.length - 1; i++) {
      const decisionAt = prices[i][0] + 15 * 60_000;
      const entryAt = prices[i + 1][0];
      if (decisionAt < PHT_FROM || decisionAt >= PHT_TO || entryAt < PHT_FROM || entryAt >= PHT_TO) continue;
      const now = decisionAt + 2_000;
      const past = prices.slice(0, i + 1);
      const input = { source: 'gmx-official-api', prices: past };
      const baseline = originalV8(symbol, input, now);
      const current = evaluateCandidateAt(symbol, prices, i, 'v8');
      assert.deepEqual(baselineV8Fields(current), baselineV8Fields(baseline), `${symbol} decision ${new Date(decisionAt).toISOString()}`);
      if (baseline?.evaluation?.eligible)
        assert.equal(current.evaluation.stopPrice, baseline.evaluation.stopPrice, `${symbol} eligible stop`);
      else if (baseline?.evaluation) {
        assert.equal(current.evaluation.eligible, false);
        assert.equal(current.evaluation.stopFraction, null);
        // New diagnostics may retain a rejected structural stop; it must not
        // be silently promoted into an eligible/executable stop.
        assert.equal(current.evaluation.eligible, baseline.evaluation.eligible);
      }
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('PHT replay filters decisions to Oct 2 local day and pools primary vs supplementary symbols', async () => {
  const capture = JSON.parse(await readFile(input, 'utf8'));
  const report = replayCapture(capture);
  assert.equal(report.replayMethod.decisionWindow.fromLocal, '2026-10-02T00:00:00+08:00');
  assert.equal(report.replayMethod.decisionWindow.toExclusiveLocal, '2026-10-03T00:00:00+08:00');
  for (const version of ['v8', 'v9']) {
    for (const pool of [report.eligibleCounts.primaryPool, report.eligibleCounts.supplementaryPool]) {
      assert.ok(pool[version].firstDecisionAt >= PHT_FROM);
      assert.ok(pool[version].lastDecisionAt < PHT_TO);
      assert.ok(pool[version].firstEntryAt >= PHT_FROM);
      assert.ok(pool[version].lastEntryAt < PHT_TO);
    }
  }
  assert.equal(report.eligibleCounts.primaryPool.v8.decisions,
    report.eligibleCounts.perSymbol.BTC.v8.decisions
    + report.eligibleCounts.perSymbol.SOL.v8.decisions
    + report.eligibleCounts.perSymbol.XRP.v8.decisions);
  assert.equal(report.eligibleCounts.supplementaryPool.v8.decisions,
    report.eligibleCounts.perSymbol.ETH.v8.decisions
    + report.eligibleCounts.perSymbol.LINK.v8.decisions);
});

test('account simulation preserves 32/day cap, v8-only 3-loss gate, and optional half sizing on both arms', () => {
  assert.equal(MAX_DAILY_ENTRIES, 32);
  const recentThreeLosses = { consecutiveLosses: 3, lastCloseAtMs: 10_000, entryAt: 20_000 };
  assert.equal(v8ThreeLossLockApplies({ version: 'v8', ...recentThreeLosses }), true);
  assert.equal(v8ThreeLossLockApplies({ version: 'v9', ...recentThreeLosses }), false);
  assert.equal(v8ThreeLossLockApplies({ version: 'v8', ...recentThreeLosses, entryAt: 10_000 + 4 * 3_600_000 }), false);
  const recentTwoLosses = { consecutiveLosses: 2, lastCloseAtMs: 10_000, entryAt: 20_000, riskMode: 'POLICY_HALF_AFTER_2_LOSSES_4H' };
  assert.equal(modeledHalfRiskApplies(recentTwoLosses), true);
  assert.equal(modeledHalfRiskApplies({ ...recentTwoLosses, riskMode: 'NO_HALF_RISK_SENSITIVITY' }), false);
  assert.equal(modeledHalfRiskApplies({ ...recentTwoLosses, entryAt: 10_000 + 4 * 3_600_000 }), false);
});

test('missing observed execution economics stays formally unavailable; modeled sensitivity is labeled', async () => {
  const capture = JSON.parse(await readFile(input, 'utf8'));
  const report = replayCapture(capture);
  assert.equal(report.formalFinancialEvidence.classification, 'UNAVAILABLE');
  assert.equal(report.formalFinancialEvidence.measuredNetPnlUsd, null);
  assert.equal(report.formalFinancialEvidence.measuredMaxDrawdownUsd, null);
  assert.ok(report.netRewardRiskSensitivity.scenarios.every((row) =>
    Number.isFinite(row.modeledNetPnlUsd) && Number.isFinite(row.modeledRealizedSettlementMaxDrawdownUsd)));
  assert.ok(report.eligibleCounts.primaryPool.v8.eligibleBeforeEconomics > 0);
  assert.ok(report.eligibleCounts.primaryPool.v9.eligibleBeforeEconomics > 0);
});