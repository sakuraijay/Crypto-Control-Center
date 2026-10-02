import type { DailyPaperCandidate } from './virtualPaperDailyCandidate';
import type { VirtualTradePlan } from './virtualPaperTradingMode';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Recheck server-issued structural evidence at the final PAPER-only entry gate.
 * A score is not a probability, and an observed price excursion is not a forecast.
 * Price movement after evaluation cannot silently move the recorded stop/target. */
export function adaptivePaperAuditMatches(
  candidate: DailyPaperCandidate | undefined, plan: VirtualTradePlan,
  input: { symbol: string; side: 'LONG' | 'SHORT'; nowMs: number },
): boolean {
  const e = candidate?.evaluation;
  if (!candidate || !e || candidate.source !== 'gmx-official-api'
    || candidate.purpose !== 'AGGRESSIVE_PAPER_EXPERIMENT'
    || candidate.symbol !== input.symbol || candidate.side !== input.side
    || candidate.quality?.eligible !== true
    || (e.version !== 'paper-entry-signals/v8' && e.version !== 'paper-entry-signals/v9') || e.eligible !== true
    || !finite(candidate.referencePrice) || candidate.referencePrice <= 0
    || !finite(plan.entryPrice) || plan.entryPrice <= 0
    || !finite(candidate.closedAt) || candidate.closedAt > input.nowMs || input.nowMs - candidate.closedAt > 960_000
    || !finite(candidate.evaluatedAt) || candidate.evaluatedAt > input.nowMs || input.nowMs - candidate.evaluatedAt > 60_000
    || !finite(e.stopPrice) || e.stopPrice !== plan.structuralStop
    || !finite(e.stopFraction) || e.stopFraction < .002 - 1e-10 || e.stopFraction > .008 + 1e-10
    || Math.abs(Math.abs(e.stopPrice / candidate.referencePrice - 1) - e.stopFraction) > 1e-8
    || Math.abs(plan.entryPrice / candidate.referencePrice - 1) > .02
    || !Array.isArray(e.signals)) return false;
  const signal = e.signals.find(s => s?.kind === e.selectedSetup && s.eligible === true);
  const horizon = e.observedHorizonMoveFraction?.[plan.mode];
  const direction = input.side === 'LONG' ? 1 : -1;
  if (e.version === 'paper-entry-signals/v9'
    && (e.tradingMode !== plan.mode || signal?.modeAllowed !== true || signal.admissionEligible !== true)) return false;
  const requiredThreshold = e.version === 'paper-entry-signals/v9' ? 30
    : signal?.kind === 'VOLATILITY_BREAKOUT' ? 50 : 45;
  if (!signal || signal.side !== input.side || !finite(signal.score) || !finite(signal.threshold)
    || signal.score < signal.threshold || signal.score > 100 || signal.threshold < 0
    || signal.threshold !== requiredThreshold
    || !['TREND_PULLBACK','VOLATILITY_BREAKOUT','RANGE_MEAN_REVERSION'].includes(signal.kind)
    || e.selectedScore !== signal.score || !finite(signal.targetPrice) || signal.targetPrice !== plan.tpPrice
    || !['OBSERVED_SWING', 'OBSERVED_RANGE_PROJECTION'].includes(signal.targetBasis ?? '')
    || !finite(horizon) || horizon <= 0
    || (plan.tpPrice / candidate.referencePrice - 1) * direction <= 0
    || Math.abs(plan.tpPrice / candidate.referencePrice - 1) > horizon + 1e-10
    || (plan.tpPrice / plan.entryPrice - 1) * direction <= 0
    || Math.abs(plan.tpPrice / plan.entryPrice - 1) > horizon + 1e-10
    || (plan.entryPrice - plan.structuralStop) * direction <= 0) return false;
  return true;
}