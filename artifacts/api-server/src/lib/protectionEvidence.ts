/**
 * protectionEvidence — 6H-2C §4 보호 주문 온체인 증거 수집기.
 *
 * 증거 우선순위 (지시서 §4):
 *  1. 온체인 tx receipt (성공 여부 포함)
 *  2. 허용 EventEmitter의 OrderCreated / OrderExecuted / OrderCancelled / OrderFrozen
 *  3. GMX API status — 보조 참고만 (단독으로 terminal 전이 금지; 판정은 judgeProtection)
 *  4. authoritative 포지션 상태 — 교차검증만
 *
 * 규칙:
 *  - 허용 emitter = [현재 설정 emitter] ∪ [레코드에 영속된 emitter] (gmx-event-emitter 규칙)
 *  - EventLog2 정확한 topic0 + eventNameHash + orderKey 결속 — 위조 emitter/서명 차단
 *  - 서로 다른 orderKey 복수 관측 = 모호 → 증거 없음 취급 (UNRESOLVED 유지)
 *  - 조회 실패 = null (전이 없음 + 신규 OPEN 차단은 호출측 reconcileProtections가 담당)
 *  - 의존성 주입식 — 테스트에서 실 RPC 0회
 */
import {
  EVENT_LOG_2_TOPIC0, ORDER_EVENT_NAME_HASH, classifyOrderResolutionLogs,
  extractOrderKeyFromReceiptLogs, type RawLog,
} from './gmxOrderEvents';

export interface EvidenceClient {
  /** eth_getLogs — orderKey 결속 EventLog2 (Created/Executed/Cancelled/Frozen) */
  getOrderLogs(orderKey: string, emitters: string[]): Promise<RawLog[] | null>;
  /** tx receipt (status 포함). 미존재 = null 반환, 조회 오류 = throw */
  getReceipt?(txHash: string): Promise<{ status: 'success' | 'reverted'; logs: RawLog[] } | null>;
}

export interface ProtectionEvidenceBundle {
  apiStatus: string | null;
  onchainOrderKey: string | null;
  onchainExecuted: boolean;
  onchainCancelled: boolean;
  onchainFrozen: boolean;
  positionExists: boolean | null;
  /** §4 durable 증거 — 상태별 tx hash / block */
  createdTxHash: string | null;
  resolutionTxHash: string | null;
  resolutionBlockNumber: string | null;
  matchedEmitter: string | null;
  /** 서로 다른 orderKey 복수 관측 등 모호성 — 전이 금지 사유 */
  ambiguous: boolean;
}

function isAllowed(addr: string, allowed: string[]): boolean {
  const a = addr?.toLowerCase();
  return !!a && allowed.some(x => x.toLowerCase() === a);
}

/** orderKey 결속 OrderCreated 로그 탐지 (허용 emitter + 정확한 서명) */
function findCreatedLog(logs: RawLog[], orderKey: string, emitters: string[]): RawLog | null {
  const wanted = orderKey.toLowerCase();
  for (const log of logs ?? []) {
    if (!isAllowed(log.address, emitters)) continue;
    if (log.topics?.[0]?.toLowerCase() !== EVENT_LOG_2_TOPIC0.toLowerCase()) continue;
    if (log.topics?.[1]?.toLowerCase() !== ORDER_EVENT_NAME_HASH.OrderCreated.toLowerCase()) continue;
    if (log.topics?.[2]?.toLowerCase() !== wanted) continue;
    return log;
  }
  return null;
}

export interface CollectArgs {
  row: {
    requestId: string | null;
    orderKey: string | null;
    marketAddress: string;
    isLong: boolean;
    /** 레코드에 영속된 emitter (있으면 허용집합에 합집합) */
    emitterAddress?: string | null;
  };
  client: EvidenceClient;
  /** 현재 설정 emitter (fail-closed resolve 결과). null = 수집 불가 */
  configuredEmitter: string | null;
  /** GMX API status 조회 (보조) — 실패 = null */
  fetchApiStatus?: (requestId: string) => Promise<string | null>;
  /** authoritative 포지션 존재 여부 (교차검증) — null = 조회 실패 */
  positionExists: boolean | null;
}

/**
 * 보호 주문 1건의 증거 번들 수집. 수집 자체가 불가능(설정/조회 실패)하면 null —
 * 호출측은 전이 없음 + 차단 유지로 처리해야 한다.
 */
export async function collectProtectionEvidence(args: CollectArgs): Promise<ProtectionEvidenceBundle | null> {
  if (!args.configuredEmitter) return null; // emitter 설정 fail-closed — 판정 금지

  const emitters = [args.configuredEmitter];
  const stored = args.row.emitterAddress ?? null;
  if (stored && !emitters.some(e => e.toLowerCase() === stored.toLowerCase())) emitters.push(stored);

  let apiStatus: string | null = null;
  if (args.row.requestId && args.fetchApiStatus) {
    try { apiStatus = await args.fetchApiStatus(args.row.requestId); } catch { apiStatus = null; }
  }

  // orderKey가 없으면 온체인 조회 결속 불가 — API status(보조) + 포지션만으로 번들 구성
  if (!args.row.orderKey || !/^0x[0-9a-fA-F]{64}$/.test(args.row.orderKey)) {
    return {
      apiStatus,
      onchainOrderKey: null,
      onchainExecuted: false, onchainCancelled: false, onchainFrozen: false,
      positionExists: args.positionExists,
      createdTxHash: null, resolutionTxHash: null, resolutionBlockNumber: null,
      matchedEmitter: null, ambiguous: false,
    };
  }

  let logs: RawLog[] | null = null;
  try { logs = await args.client.getOrderLogs(args.row.orderKey, emitters); } catch { logs = null; }
  if (logs === null) return null; // 온체인 조회 실패 — 판정 금지 (차단 유지)

  // OrderCreated — 동일 receipt에 서로 다른 key가 섞였는지 방어적 재검사
  const createdCheck = extractOrderKeyFromReceiptLogs(
    logs.filter(l => l.topics?.[1]?.toLowerCase() === ORDER_EVENT_NAME_HASH.OrderCreated.toLowerCase()),
    emitters,
  );
  const ambiguous = !createdCheck.ok && createdCheck.reason === 'ambiguous';
  const createdLog = findCreatedLog(logs, args.row.orderKey, emitters);

  // 실행/취소/동결 — orderKey 정확 결속 분류 (executed > cancelled > frozen)
  const resolution = classifyOrderResolutionLogs(logs, args.row.orderKey, emitters);

  return {
    apiStatus,
    onchainOrderKey: createdLog ? args.row.orderKey : null,
    onchainExecuted: resolution?.kind === 'executed',
    onchainCancelled: resolution?.kind === 'cancelled',
    onchainFrozen: resolution?.kind === 'frozen',
    positionExists: args.positionExists,
    createdTxHash: createdLog?.transactionHash ?? null,
    resolutionTxHash: resolution?.txHash ?? null,
    resolutionBlockNumber: resolution?.blockNumber ?? null,
    matchedEmitter: createdLog?.address ?? null,
    ambiguous,
  };
}

// ── §5 — 포지션 ↔ stop 불일치 분석 (순수 함수) ────────────────────────────────

export interface AnomalyPosition { positionKey: string; sizeUsd: number }
export interface AnomalyStopRow {
  id: string; positionKey: string; status: string; purpose: string;
  sizeDeltaUsd: number; orderKey: string | null;
}

export interface ProtectionAnomalies {
  /** 포지션 있는데 ACTIVE stop 없음 */
  uncoveredCount: number;
  /** 포지션 없는데 ACTIVE stop 잔존 (고아 stop — 취소 대상) */
  staleActiveCount: number;
  /** stop size > 포지션 size (InvalidDecreaseOrderSize 위험) */
  oversizedCount: number;
  /** 같은 positionKey에 ACTIVE stop 2개 이상 */
  multipleActiveCount: number;
  /** ACTIVE인데 orderKey 없음/형식 오류 (증거 결속 위반) */
  keyMismatchCount: number;
  blockNewOpens: boolean;
  details: string[];
}

/** §5 — 포지션-보호주문 정합성 분석. 어떤 불일치도 신규 OPEN 차단. */
export function analyzeProtectionAnomalies(args: {
  positions: AnomalyPosition[] | null;
  stopRows: AnomalyStopRow[] | null;
}): ProtectionAnomalies {
  const out: ProtectionAnomalies = {
    uncoveredCount: 0, staleActiveCount: 0, oversizedCount: 0,
    multipleActiveCount: 0, keyMismatchCount: 0, blockNewOpens: false, details: [],
  };
  if (args.positions === null || args.stopRows === null) {
    out.blockNewOpens = true;
    out.details.push('포지션/보호주문 조회 실패 — 정합성 판정 불가 (fail-closed)');
    return out;
  }
  const posByKey = new Map(args.positions.map(p => [p.positionKey, p]));
  const activeStops = args.stopRows.filter(r => r.status === 'ACTIVE' && r.purpose !== 'EMERGENCY_CLOSE');
  const activeByPos = new Map<string, AnomalyStopRow[]>();
  for (const s of activeStops) {
    const list = activeByPos.get(s.positionKey) ?? [];
    list.push(s); activeByPos.set(s.positionKey, list);
  }
  for (const p of args.positions) {
    const stops = activeByPos.get(p.positionKey) ?? [];
    if (stops.length === 0) { out.uncoveredCount++; out.details.push(`무stop 포지션 ${p.positionKey}`); }
    if (stops.length > 1)  { out.multipleActiveCount++; out.details.push(`다중 ACTIVE stop ${p.positionKey} (${stops.length}건)`); }
    for (const s of stops) {
      if (s.sizeDeltaUsd > p.sizeUsd * 1.0001) { out.oversizedCount++; out.details.push(`oversized stop ${s.id} (${s.sizeDeltaUsd} > ${p.sizeUsd})`); }
    }
  }
  for (const s of activeStops) {
    if (!posByKey.has(s.positionKey)) { out.staleActiveCount++; out.details.push(`고아 ACTIVE stop ${s.id} (${s.positionKey} 포지션 없음)`); }
    if (!s.orderKey || !/^0x[0-9a-fA-F]{64}$/.test(s.orderKey)) { out.keyMismatchCount++; out.details.push(`ACTIVE인데 orderKey 부재/형식오류 ${s.id}`); }
  }
  out.blockNewOpens =
    out.uncoveredCount > 0 || out.staleActiveCount > 0 || out.oversizedCount > 0 ||
    out.multipleActiveCount > 0 || out.keyMismatchCount > 0;
  return out;
}
