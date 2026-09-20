export const VIRTUAL_PAPER_400_SCHEMA_VERSION = 1 as const;
export const VIRTUAL_PAPER_400_INITIAL_EQUITY_USD = 400 as const;
export const VIRTUAL_PAPER_400_MODE = 'VIRTUAL_PAPER_400' as const;
export const VIRTUAL_PAPER_400_STRATEGY_PREFIX = 'SERVER_WORKER_AI_VIRTUAL_400_V1' as const;

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const COST_TOLERANCE_USD = 0.01;

export interface VirtualPaper400SessionV1 {
  schemaVersion: 1;
  mode: typeof VIRTUAL_PAPER_400_MODE;
  sessionId: string;
  startedAt: string;
  startedAtMs: number;
  initialEquityUsd: 400;
  strategyTag: string;
  realFundsUsed: false;
}

export interface VirtualPaper400SettlementRow {
  id: string | number;
  action: string;
  strategy: string | null;
  settlementStatus: string | null;
  costSource: string | null;
  pnl: string | number | null;
  netPnlEstimatedUsd: string | number | null;
  estEntryCostUsd: string | number | null;
  estExitCostUsd: string | number | null;
  estHoldingCostUsd: string | number | null;
}

export interface VirtualPaper400Ledger {
  sessionId: string;
  initialEquityUsd: 400;
  realizedGrossPnlUsd: number;
  modeledTradingCostUsd: number;
  realizedNetPnlUsd: number;
  realizedEquityUsd: number;
  settlementCount: number;
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

function finiteNumber(value: string | number | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableTradeId(value: string | number): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 160 ? normalized : null;
}

export function virtualPaper400StrategyTag(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('VIRTUAL_SESSION_ID_INVALID');
  return `${VIRTUAL_PAPER_400_STRATEGY_PREFIX}:${sessionId}`;
}

/**
 * Validate an execution strategy before it is allowed to select a VIRTUAL/PAPER
 * session. This intentionally accepts only tags produced by
 * virtualPaper400StrategyTag(); callers must handle Standard PAPER separately.
 */
export function parseVirtualPaper400StrategyTag(
  value: unknown,
): ParseResult<{ sessionId: string; strategyTag: string }> {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'VIRTUAL_STRATEGY_TAG_INVALID' };
  }
  const prefix = `${VIRTUAL_PAPER_400_STRATEGY_PREFIX}:`;
  if (!value.startsWith(prefix)) {
    return { ok: false, reason: 'VIRTUAL_STRATEGY_TAG_INVALID' };
  }
  const sessionId = value.slice(prefix.length);
  if (!SESSION_ID_RE.test(sessionId)) {
    return { ok: false, reason: 'VIRTUAL_STRATEGY_TAG_INVALID' };
  }
  const strategyTag = virtualPaper400StrategyTag(sessionId);
  if (strategyTag !== value) {
    return { ok: false, reason: 'VIRTUAL_STRATEGY_TAG_INVALID' };
  }
  return { ok: true, value: { sessionId, strategyTag } };
}

export function isVirtualPaper400StrategyTag(value: unknown): value is string {
  return parseVirtualPaper400StrategyTag(value).ok;
}

export function buildVirtualPaper400Session(
  sessionId: string,
  startedAt: Date,
): VirtualPaper400SessionV1 {
  const strategyTag = virtualPaper400StrategyTag(sessionId);
  const startedAtMs = startedAt.getTime();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) {
    throw new Error('VIRTUAL_SESSION_STARTED_AT_INVALID');
  }
  return {
    schemaVersion: VIRTUAL_PAPER_400_SCHEMA_VERSION,
    mode: VIRTUAL_PAPER_400_MODE,
    sessionId,
    startedAt: startedAt.toISOString(),
    startedAtMs,
    initialEquityUsd: VIRTUAL_PAPER_400_INITIAL_EQUITY_USD,
    strategyTag,
    realFundsUsed: false,
  };
}

export function parseVirtualPaper400Session(raw: unknown): ParseResult<VirtualPaper400SessionV1> {
  let value: unknown = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'VIRTUAL_SESSION_JSON_INVALID' };
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'VIRTUAL_SESSION_SHAPE_INVALID' };
  if (!hasExactKeys(value, [
    'schemaVersion', 'mode', 'sessionId', 'startedAt', 'startedAtMs',
    'initialEquityUsd', 'strategyTag', 'realFundsUsed',
  ])) return { ok: false, reason: 'VIRTUAL_SESSION_KEYS_INVALID' };
  const parsedStartedAt = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
  const expectedStrategy = typeof value.sessionId === 'string' && SESSION_ID_RE.test(value.sessionId)
    ? virtualPaper400StrategyTag(value.sessionId)
    : null;
  if (value.schemaVersion !== VIRTUAL_PAPER_400_SCHEMA_VERSION
    || value.mode !== VIRTUAL_PAPER_400_MODE
    || typeof value.sessionId !== 'string' || !SESSION_ID_RE.test(value.sessionId)
    || typeof value.startedAtMs !== 'number' || !Number.isSafeInteger(value.startedAtMs)
    || value.startedAtMs <= 0 || parsedStartedAt !== value.startedAtMs
    || new Date(value.startedAtMs).toISOString() !== value.startedAt
    || value.initialEquityUsd !== VIRTUAL_PAPER_400_INITIAL_EQUITY_USD
    || value.strategyTag !== expectedStrategy
    || value.realFundsUsed !== false) {
    return { ok: false, reason: 'VIRTUAL_SESSION_VALUES_INVALID' };
  }
  return { ok: true, value: value as unknown as VirtualPaper400SessionV1 };
}

export function deriveVirtualPaper400Ledger(
  session: VirtualPaper400SessionV1,
  settlements: readonly VirtualPaper400SettlementRow[],
): ParseResult<VirtualPaper400Ledger> {
  const sessionCheck = parseVirtualPaper400Session(session);
  if (!sessionCheck.ok) return sessionCheck;

  let grossTotal = 0;
  let costTotal = 0;
  let netTotal = 0;
  const seen = new Set<string>();

  for (const row of settlements) {
    const id = stableTradeId(row.id);
    if (!id) return { ok: false, reason: 'VIRTUAL_SETTLEMENT_ID_INVALID' };
    if (seen.has(id)) return { ok: false, reason: 'VIRTUAL_SETTLEMENT_DUPLICATE' };
    seen.add(id);

    if (row.action !== 'CLOSE' || row.strategy !== session.strategyTag) {
      return { ok: false, reason: 'VIRTUAL_SETTLEMENT_SCOPE_MISMATCH' };
    }
    if (row.settlementStatus !== 'PAPER_ESTIMATED' || row.costSource !== 'PAPER_GMX_ESTIMATE') {
      return { ok: false, reason: 'VIRTUAL_SETTLEMENT_COST_BINDING_INVALID' };
    }

    const gross = finiteNumber(row.pnl);
    const net = finiteNumber(row.netPnlEstimatedUsd);
    const entry = finiteNumber(row.estEntryCostUsd);
    const exit = finiteNumber(row.estExitCostUsd);
    const holding = finiteNumber(row.estHoldingCostUsd);
    if (gross === null || net === null || entry === null || exit === null || holding === null
      || entry < 0 || exit < 0 || holding < 0) {
      return { ok: false, reason: 'VIRTUAL_SETTLEMENT_NUMERIC_INVALID' };
    }

    const modeledCost = entry + exit + holding;
    const expectedNet = gross - modeledCost;
    if (Math.abs(expectedNet - net) > COST_TOLERANCE_USD) {
      return { ok: false, reason: 'VIRTUAL_SETTLEMENT_NET_MISMATCH' };
    }

    grossTotal += gross;
    costTotal += modeledCost;
    netTotal += net;
  }

  const realizedEquityUsd = VIRTUAL_PAPER_400_INITIAL_EQUITY_USD + netTotal;
  if (![grossTotal, costTotal, netTotal, realizedEquityUsd].every(Number.isFinite)) {
    return { ok: false, reason: 'VIRTUAL_LEDGER_NON_FINITE' };
  }

  return {
    ok: true,
    value: {
      sessionId: session.sessionId,
      initialEquityUsd: VIRTUAL_PAPER_400_INITIAL_EQUITY_USD,
      realizedGrossPnlUsd: grossTotal,
      modeledTradingCostUsd: costTotal,
      realizedNetPnlUsd: netTotal,
      realizedEquityUsd,
      settlementCount: settlements.length,
    },
  };
}
