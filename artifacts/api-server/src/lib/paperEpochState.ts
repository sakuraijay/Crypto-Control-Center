import { createHash } from 'node:crypto';

export const PAPER_EPOCH_ACTIVE_KEY = 'paperEpochActiveV1';
export const PAPER_EPOCH_AUDIT_PREFIX = 'paperEpochActivation:';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export interface ActivePaperEpochV1 {
  schemaVersion: 1;
  epochId: string;
  idempotencyKey: string;
  auditKey: string;
  startedAt: string;
  startedAtMs: number;
  activeCapitalUsd: 1000;
  equityHwmUsd: 1000;
  dailyBaselineUsd: 1000;
  weeklyBaselineUsd: 1000;
  engineMode: 'PAPER';
  executionAuthorized: false;
  autoWorkerLiveEnabled: false;
  relaySubmissionEnabled: false;
  relaySubmitNetworkEnabled: false;
  relayMode: 'DISABLED';
  delegatedSignerEnabled: true;
  gmxOrderSubmissionEnabled: true;
  liveTestExecutionLocked: false;
}

export interface PaperEpochBindingV1 {
  activeEpochSha256: string;
  limitsSha256: string;
  dailySha256: string;
  weeklySha256: string;
  riskSha256: string;
}

export interface PaperEpochAuditV1 {
  schemaVersion: 1;
  idempotencyKey: string;
  epochId: string;
  appliedAt: string;
  appliedAtMs: number;
  before: {
    activeEpoch: string | null;
    equityHwm: string | null;
    daily: string | null;
    weekly: string | null;
    risk: string | null;
    limits: Record<string, unknown>;
  };
  after: {
    activeEpoch: ActivePaperEpochV1;
    limits: Record<string, unknown>;
    equityHwm: 1000;
    daily: Record<string, unknown>;
    weekly: Record<string, unknown>;
    risk: Record<string, unknown>;
  };
  zeroStateCounts: {
    open: 0;
    approvals: 0;
    intents: 0;
    protections: 0;
    unsettled: 0;
    relay: 0;
  };
  binding: PaperEpochBindingV1;
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function parseCanonicalTime(value: unknown, valueMs: unknown, nowMs: number): number | null {
  if (typeof value !== 'string' || typeof valueMs !== 'number'
    || !Number.isSafeInteger(valueMs) || valueMs <= 0 || valueMs > nowMs) return null;
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs) || parsedMs !== valueMs) return null;
  return new Date(valueMs).toISOString() === value ? valueMs : null;
}

export function isValidPaperEpochIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_RE.test(value);
}

export function buildActivePaperEpoch(
  idempotencyKey: string,
  startedAt: Date,
): ActivePaperEpochV1 {
  const startedAtMs = startedAt.getTime();
  const auditKey = `${PAPER_EPOCH_AUDIT_PREFIX}${idempotencyKey}`;
  return {
    schemaVersion: 1,
    epochId: `paper-${startedAtMs}-${idempotencyKey}`,
    idempotencyKey,
    auditKey,
    startedAt: startedAt.toISOString(),
    startedAtMs,
    activeCapitalUsd: 1000,
    equityHwmUsd: 1000,
    dailyBaselineUsd: 1000,
    weeklyBaselineUsd: 1000,
    engineMode: 'PAPER',
    executionAuthorized: false,
    autoWorkerLiveEnabled: false,
    relaySubmissionEnabled: false,
    relaySubmitNetworkEnabled: false,
    relayMode: 'DISABLED',
    delegatedSignerEnabled: true,
    gmxOrderSubmissionEnabled: true,
    liveTestExecutionLocked: false,
  };
}

export function parseActivePaperEpoch(
  raw: unknown,
  nowMs: number,
): ParseResult<ActivePaperEpochV1> {
  let value: unknown = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'ACTIVE_EPOCH_JSON_INVALID' };
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'ACTIVE_EPOCH_SHAPE_INVALID' };
  const keys = [
    'schemaVersion', 'epochId', 'idempotencyKey', 'auditKey', 'startedAt', 'startedAtMs',
    'activeCapitalUsd', 'equityHwmUsd', 'dailyBaselineUsd', 'weeklyBaselineUsd',
    'engineMode', 'executionAuthorized', 'autoWorkerLiveEnabled', 'relaySubmissionEnabled',
    'relaySubmitNetworkEnabled', 'relayMode', 'delegatedSignerEnabled',
    'gmxOrderSubmissionEnabled', 'liveTestExecutionLocked',
  ] as const;
  if (!hasExactKeys(value, keys)) return { ok: false, reason: 'ACTIVE_EPOCH_KEYS_INVALID' };
  if (!isValidPaperEpochIdempotencyKey(value.idempotencyKey)
    || value.epochId !== `paper-${String(value.startedAtMs)}-${value.idempotencyKey}`
    || value.auditKey !== `${PAPER_EPOCH_AUDIT_PREFIX}${value.idempotencyKey}`
    || parseCanonicalTime(value.startedAt, value.startedAtMs, nowMs) === null
    || value.schemaVersion !== 1
    || value.activeCapitalUsd !== 1000
    || value.equityHwmUsd !== 1000
    || value.dailyBaselineUsd !== 1000
    || value.weeklyBaselineUsd !== 1000
    || value.engineMode !== 'PAPER'
    || value.executionAuthorized !== false
    || value.autoWorkerLiveEnabled !== false
    || value.relaySubmissionEnabled !== false
    || value.relaySubmitNetworkEnabled !== false
    || value.relayMode !== 'DISABLED'
    || value.delegatedSignerEnabled !== true
    || value.gmxOrderSubmissionEnabled !== true
    || value.liveTestExecutionLocked !== false) {
    return { ok: false, reason: 'ACTIVE_EPOCH_VALUES_INVALID' };
  }
  return { ok: true, value: value as unknown as ActivePaperEpochV1 };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new Error('undefined value');
      normalized[key] = canonicalize(value[key]);
    }
    return normalized;
  }
  throw new Error('non-json value');
}

export function paperEpochHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function buildPaperEpochBinding(
  activeEpoch: ActivePaperEpochV1,
  limits: unknown,
  daily: unknown,
  weekly: unknown,
  risk: unknown,
): PaperEpochBindingV1 {
  return {
    activeEpochSha256: paperEpochHash(activeEpoch),
    limitsSha256: paperEpochHash(limits),
    dailySha256: paperEpochHash(daily),
    weeklySha256: paperEpochHash(weekly),
    riskSha256: paperEpochHash(risk),
  };
}

export function parsePaperEpochAudit(
  raw: unknown,
  expectedAuditKey: string,
  nowMs: number,
): ParseResult<PaperEpochAuditV1> {
  let value: unknown = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'PAPER_EPOCH_AUDIT_JSON_INVALID' };
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'PAPER_EPOCH_AUDIT_SHAPE_INVALID' };
  if (!hasExactKeys(value, [
    'schemaVersion', 'idempotencyKey', 'epochId', 'appliedAt', 'appliedAtMs',
    'before', 'after', 'zeroStateCounts', 'binding',
  ])) return { ok: false, reason: 'PAPER_EPOCH_AUDIT_KEYS_INVALID' };
  if (!isValidPaperEpochIdempotencyKey(value.idempotencyKey)
    || expectedAuditKey !== `${PAPER_EPOCH_AUDIT_PREFIX}${value.idempotencyKey}`
    || typeof value.epochId !== 'string'
    || value.schemaVersion !== 1
    || parseCanonicalTime(value.appliedAt, value.appliedAtMs, nowMs) === null
    || !isPlainObject(value.before)
    || !hasExactKeys(value.before, ['activeEpoch', 'equityHwm', 'daily', 'weekly', 'risk', 'limits'])
    || !isPlainObject(value.after)
    || !hasExactKeys(value.after, ['activeEpoch', 'limits', 'equityHwm', 'daily', 'weekly', 'risk'])
    || !isPlainObject(value.zeroStateCounts)
    || !hasExactKeys(value.zeroStateCounts, ['open', 'approvals', 'intents', 'protections', 'unsettled', 'relay'])
    || Object.values(value.zeroStateCounts).some(count => count !== 0)
    || !isPlainObject(value.binding)
    || !hasExactKeys(value.binding, ['activeEpochSha256', 'limitsSha256', 'dailySha256', 'weeklySha256', 'riskSha256'])
    || Object.values(value.binding).some(hash => typeof hash !== 'string' || !HASH_RE.test(hash))) {
    return { ok: false, reason: 'PAPER_EPOCH_AUDIT_VALUES_INVALID' };
  }
  return { ok: true, value: value as unknown as PaperEpochAuditV1 };
}

export function verifyPaperEpochBinding(
  audit: PaperEpochAuditV1,
  activeEpoch: ActivePaperEpochV1,
  limits: Record<string, unknown>,
  daily: unknown,
  weekly: unknown,
  risk: unknown,
): boolean {
  if (audit.epochId !== activeEpoch.epochId
    || audit.idempotencyKey !== activeEpoch.idempotencyKey
    || audit.after.equityHwm !== 1000) return false;
  const expected = buildPaperEpochBinding(activeEpoch, limits, daily, weekly, risk);
  if (Object.keys(expected).some(
    key => expected[key as keyof PaperEpochBindingV1] !== audit.binding[key as keyof PaperEpochBindingV1],
  )) return false;
  return paperEpochHash(audit.after.activeEpoch) === expected.activeEpochSha256
    && paperEpochHash(audit.after.limits) === expected.limitsSha256
    && paperEpochHash(audit.after.daily) === expected.dailySha256
    && paperEpochHash(audit.after.weekly) === expected.weeklySha256
    && paperEpochHash(audit.after.risk) === expected.riskSha256;
}

export interface ActivePaperEpochSnapshotInput {
  activeRaw: string;
  auditRaw: string | null;
  equityHwmRaw: string | null;
  limits: unknown;
  dailyRaw: string | null;
  weeklyRaw: string | null;
  riskRaw: string | null;
  nowMs: number;
}

export function verifyActivePaperEpochSnapshot(
  input: ActivePaperEpochSnapshotInput,
): ParseResult<{
  activeEpoch: ActivePaperEpochV1;
  audit: PaperEpochAuditV1;
}> {
  const activeResult = parseActivePaperEpoch(input.activeRaw, input.nowMs);
  if (!activeResult.ok) return activeResult;
  if (input.auditRaw === null) return { ok: false, reason: 'ACTIVE_EPOCH_AUDIT_MISSING' };
  const auditResult = parsePaperEpochAudit(
    input.auditRaw,
    activeResult.value.auditKey,
    input.nowMs,
  );
  if (!auditResult.ok) return auditResult;
  const initial = auditResult.value.after;
  if (!isPlainObject(initial.limits) || initial.limits.tradingCapital !== 1000
    || !isPlainObject(initial.daily) || initial.daily.equity !== 1000
    || !isPlainObject(initial.weekly) || initial.weekly.equity !== 1000
    || !isPlainObject(initial.risk) || initial.risk.riskOperatingState !== 'NORMAL'
    || initial.risk.startOfDayEquityUsd !== 1000
    || initial.risk.startOfWeekEquityUsd !== 1000
    || !verifyPaperEpochBinding(
      auditResult.value,
      activeResult.value,
      initial.limits,
      initial.daily,
      initial.weekly,
      initial.risk,
    )) {
    return { ok: false, reason: 'ACTIVE_EPOCH_IMMUTABLE_AUDIT_INVALID' };
  }
  const currentHwm = Number(input.equityHwmRaw);
  if (!isPlainObject(input.limits) || input.limits.tradingCapital !== 1000
    || !Number.isFinite(currentHwm) || currentHwm < 1000) {
    return { ok: false, reason: 'ACTIVE_EPOCH_CAPITAL_BINDING_INVALID' };
  }
  try {
    const daily = input.dailyRaw ? JSON.parse(input.dailyRaw) as unknown : null;
    const weekly = input.weeklyRaw ? JSON.parse(input.weeklyRaw) as unknown : null;
    const risk = input.riskRaw ? JSON.parse(input.riskRaw) as unknown : null;
    const states = new Set(['NORMAL', 'DAILY_LOCKED', 'WEEKLY_LOCKED', 'HARD_STOPPED']);
    if (!isPlainObject(daily) || typeof daily.periodStart !== 'string'
      || typeof daily.recordedAt !== 'string' || typeof daily.equity !== 'number'
      || !Number.isFinite(daily.equity) || daily.equity < 0
      || !isPlainObject(weekly) || typeof weekly.periodStart !== 'string'
      || typeof weekly.recordedAt !== 'string' || typeof weekly.equity !== 'number'
      || !Number.isFinite(weekly.equity) || weekly.equity < 0
      || !isPlainObject(risk) || !states.has(String(risk.riskOperatingState))
      || typeof risk.startOfDayEquityUsd !== 'number'
      || !Number.isFinite(risk.startOfDayEquityUsd) || risk.startOfDayEquityUsd < 0
      || typeof risk.startOfWeekEquityUsd !== 'number'
      || !Number.isFinite(risk.startOfWeekEquityUsd) || risk.startOfWeekEquityUsd < 0
      || typeof risk.lastUpdatedAt !== 'string'
      || !isPlainObject(risk.locks)) {
      return { ok: false, reason: 'ACTIVE_EPOCH_CURRENT_STATE_INVALID' };
    }
  } catch {
    return { ok: false, reason: 'ACTIVE_EPOCH_BOUND_STATE_INVALID' };
  }
  return {
    ok: true,
    value: {
      activeEpoch: activeResult.value,
      audit: auditResult.value,
    },
  };
}