import type { VirtualPaper400Snapshot } from './context/VirtualPaper400Context';
export type VirtualRuntime = NonNullable<VirtualPaper400Snapshot['runtime']>;
export type VirtualSettlement = NonNullable<VirtualRuntime['journal']>[number];

export function finite(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}
export function amount(value: unknown, signed = false, digits = 2): string {
  const number = finite(value);
  if (number === null) return '미확인';
  return (signed && number > 0 ? '+' : '') + number.toLocaleString('en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}
export function timestamp(value: string | null | undefined, date = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '미확인';
  return new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Manila',
    ...(date ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
export const REASON_LABELS: Record<string, string> = {
  NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL: '진입 기준에 맞는 확정 신호를 기다리고 있습니다.',
  COST_UNAVAILABLE: '거래 비용 확인 대기', COST_INVALID_OR_OVER_CAP: '거래 비용 한도 초과',
  VIRTUAL_COOLDOWN: '다음 진입 간격 대기', DUPLICATE_SIGNAL: '이미 처리한 신호',
  CLAIM_UNAVAILABLE_OR_DUPLICATE: '신호 처리 상태 확인 필요',
  CONFIDENCE_OR_SIGNAL_FRESHNESS: '신호 신뢰도·유효시간 기준 미충족',
  QUOTE_CHANGED_OR_STALE: '최신 가격 재확인 필요', QUOTE_OR_MARKET_UNAVAILABLE: '시장 가격 확인 대기',
  STOP_OR_PRICE_CHASE: '손절 거리·추격 진입 기준 미충족',
  STRATEGY_OR_RISK_REJECTED: '전략 또는 위험 기준 미충족', SIZING_REJECTED: '주문 규모 기준 미충족',
  RISK_BUDGET_AFTER_COST: '비용 차감 후 위험 예산 부족',
  EXACT_SIZE_OR_TOTAL_RISK_MISMATCH: '주문 규모·위험 예산 재확인 필요',
  UNSUPPORTED_SYMBOL: '지원 시장 확인 필요',
  VIRTUAL_PROTECTION_CLOSE_PENDING: '보호 청산 처리 중', VIRTUAL_REDUCTION_PENDING: '포지션 축소 처리 중',
  DAILY_LOSS_LOCKED: '일일 손실 제한 도달', PROFIT_CAP_LOCKED: '이익 보호 조건으로 신규 진입 중지',
  STOPPED: '신규 진입이 중지되어 있습니다.', VIRTUAL_SESSION_INVALID: '가상 세션 확인 필요',
  PAPER_MODE_REQUIRED: '가상 매매 모드 확인 필요',
};
export function explainReason(reason: string | null | undefined): string {
  if (!reason) return '서버 판단을 확인하고 있습니다.';
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.includes('Strategy Arbiter NO TRADE')) return '시장 국면·품질·비용·구조 기준 미충족';
  return reason;
}
export function settlementCosts(row: VirtualSettlement): number | null {
  const values = [row.entryCostUsd, row.exitCostUsd, row.holdingCostUsd].map(finite);
  return values.some(v => v === null) ? null : finite((values as number[]).reduce((a, b) => a + b, 0));
}

/** Reconstruct only the returned settlement window, anchored to the server ledger.
 * Invalid or duplicate evidence yields no chart; never invent missing performance. */
export function settlementSeries(runtime: VirtualRuntime | null) {
  const rows = [...(runtime?.journal ?? [])].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const equity = finite(runtime?.account.ledger.realizedEquityUsd);
  if (equity === null || !rows.length || new Set(rows.map(row => row.id)).size !== rows.length
    || rows.some(row => finite(row.netPnlUsd) === null || !Number.isFinite(Date.parse(row.closedAt)))) return [];
  let balance = equity - rows.reduce((sum, row) => sum + Number(row.netPnlUsd), 0);
  if (!Number.isFinite(balance)) return [];
  const points = [{ label: '직전 잔액', balance, net: 0, id: 'baseline' }];
  for (const row of rows) {
    balance += Number(row.netPnlUsd);
    if (!Number.isFinite(balance)) return [];
    points.push({ label: timestamp(row.closedAt, true), balance, net: Number(row.netPnlUsd), id: row.id });
  }
  return points;
}
export function settlementCsv(rows: VirtualSettlement[]): string {
  const cell = (value: unknown) => {
    let text = value == null ? 'UNAVAILABLE' : String(value);
    // Preserve legitimate negative numbers; neutralize spreadsheet formulas in text.
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const headers = ['Mode', 'ID', 'Symbol', 'Side', 'Opened UTC', 'Closed UTC', 'Strategy', 'Gross USDC',
    'Entry cost USDC', 'Exit cost USDC', 'Holding cost USDC', 'Net USDC', 'Close reason'];
  return '\uFEFF' + [headers, ...rows.map(row => ['SIMULATED / ESTIMATED', row.id, row.symbol, row.side,
    row.openedAt, row.closedAt, row.strategy, row.grossPnlUsd, row.entryCostUsd, row.exitCostUsd,
    row.holdingCostUsd, row.netPnlUsd, row.closeReason])].map(row => row.map(cell).join(',')).join('\r\n');
}
