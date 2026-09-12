/**
 * Read-only binding between the completed-candle Candle Signal and the v2
 * Regime-Aware Strategy Ensemble.  This evidence is intentionally incapable of
 * authorizing Risk, sizing, approvals, PAPER/LIVE mutation, relay or execution.
 */
import { createHash } from 'node:crypto';
import type { CandleSignalToRisk } from './candleSignalContract';
import type { RegimeDecision } from './regimeEngineV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';

export const CANDLE_STRATEGY_SHADOW_EVIDENCE_VERSION =
  'candle-strategy-shadow-evidence/v1' as const;

export interface CandleStrategyShadowEvidence {
  schemaVersion: typeof CANDLE_STRATEGY_SHADOW_EVIDENCE_VERSION;
  mode: 'SHADOW_ONLY';
  symbol: string;
  evaluatedAt: number;
  sourceCandleCloseTime: number;
  frameCloseTimesMs: Record<'15m' | '1h' | '4h', number>;
  candleSignal: CandleSignalToRisk;
  /** Explicitly v2; the worker's legacy operating-state regime is not accepted here. */
  v2Regime: RegimeDecision;
  disposition: 'AGREED' | 'NO_TRADE' | 'DIRECTION_CONFLICT';
  replayFingerprint: string;
  reasons: string[];
  authority: 'EVIDENCE_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  sizingAllowed: false;
  orderCreationAllowed: false;
  relayAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return result;
};

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
function fingerprintPayload(
  evidence: Omit<CandleStrategyShadowEvidence, 'replayFingerprint'>,
): string {
  return fingerprint(evidence);
}

export function buildCandleStrategyShadowEvidence(input: {
  candleSignal: CandleSignalToRisk;
  v2Regime: RegimeDecision;
  shadowRecord: StrategyShadowRecord;
}): CandleStrategyShadowEvidence | null {
  const { candleSignal, v2Regime, shadowRecord } = input;
  const symbol = shadowRecord.symbol.trim().toUpperCase();
  const closeTimes = candleSignal.dataQuality.frameCloseTimesMs;
  if (candleSignal.schemaVersion !== 'candle-signal/v1'
    || candleSignal.dataQuality.status === 'INVALID'
    || candleSignal.symbol.trim().toUpperCase() !== symbol
    || v2Regime.configVersion !== 'regime-engine/v2'
    || v2Regime.symbol.trim().toUpperCase() !== symbol
    || v2Regime.calculatedAt !== shadowRecord.sourceCandleCloseTime
    || candleSignal.evaluatedAtMs !== shadowRecord.evaluatedAt
    || closeTimes['15m'] !== shadowRecord.sourceCandleCloseTime
    || closeTimes['1h'] === null || closeTimes['4h'] === null
    || Object.values(closeTimes).some(value => value! > shadowRecord.evaluatedAt)) {
    return null;
  }
  const selectedDirection = shadowRecord.action === 'LONG' || shadowRecord.action === 'SHORT'
    ? shadowRecord.action : 'NO_TRADE';
  const disposition = candleSignal.direction === 'NO_TRADE' || selectedDirection === 'NO_TRADE'
    ? 'NO_TRADE'
    : candleSignal.direction === selectedDirection ? 'AGREED' : 'DIRECTION_CONFLICT';
  const reasons = disposition === 'AGREED'
    ? ['Candle Signal과 v2 Ensemble 방향 일치 — SHADOW evidence only']
    : disposition === 'DIRECTION_CONFLICT'
      ? ['Candle Signal과 v2 Ensemble 방향 충돌 — fail-closed']
      : ['Candle Signal 또는 v2 Ensemble NO_TRADE — fail-closed'];
  const evidence: Omit<CandleStrategyShadowEvidence, 'replayFingerprint'> = {
    schemaVersion: CANDLE_STRATEGY_SHADOW_EVIDENCE_VERSION,
    mode: 'SHADOW_ONLY',
    symbol,
    evaluatedAt: shadowRecord.evaluatedAt,
    sourceCandleCloseTime: shadowRecord.sourceCandleCloseTime,
    frameCloseTimesMs: closeTimes as Record<'15m' | '1h' | '4h', number>,
    candleSignal,
    v2Regime,
    disposition,
    reasons,
    authority: 'EVIDENCE_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    sizingAllowed: false,
    orderCreationAllowed: false,
    relayAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
  return { ...evidence, replayFingerprint: fingerprintPayload(evidence) };
}

export function validateCandleStrategyShadowEvidence(
  value: unknown,
  record: StrategyShadowRecord,
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['Candle/Ensemble evidence 객체 필요'];
  }
  const evidence = value as CandleStrategyShadowEvidence;
  let rebuilt: CandleStrategyShadowEvidence | null = null;
  try {
    rebuilt = buildCandleStrategyShadowEvidence({
      candleSignal: evidence.candleSignal,
      v2Regime: evidence.v2Regime,
      shadowRecord: { ...record, candleSignalEvidence: undefined },
    });
  } catch {
    return ['Candle/Ensemble evidence malformed — fail-closed'];
  }
  if (!rebuilt) return ['Candle/Ensemble source identity 또는 timestamp binding INVALID'];
  const issues: string[] = [];
  if (evidence.schemaVersion !== CANDLE_STRATEGY_SHADOW_EVIDENCE_VERSION
    || evidence.mode !== 'SHADOW_ONLY' || evidence.authority !== 'EVIDENCE_ONLY'
    || evidence.executionAuthorized !== false || evidence.approvalCreationAllowed !== false
    || evidence.sizingAllowed !== false || evidence.orderCreationAllowed !== false
    || evidence.relayAllowed !== false || evidence.paperPositionMutationAllowed !== false
    || evidence.livePositionMutationAllowed !== false) {
    issues.push('Candle/Ensemble SHADOW authority boundary INVALID');
  }
  if (evidence.disposition !== rebuilt.disposition
    || evidence.symbol !== rebuilt.symbol
    || evidence.evaluatedAt !== rebuilt.evaluatedAt
    || evidence.sourceCandleCloseTime !== rebuilt.sourceCandleCloseTime
    || JSON.stringify(evidence.frameCloseTimesMs) !== JSON.stringify(rebuilt.frameCloseTimesMs)
    || evidence.replayFingerprint !== fingerprintPayload(
      (({ replayFingerprint: _fingerprint, ...payload }) => payload)(evidence),
    )) {
    issues.push('Candle/Ensemble disposition 또는 replay fingerprint INVALID');
  }
  return issues;
}