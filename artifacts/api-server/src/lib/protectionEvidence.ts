/**
 * protectionEvidence — 6H-2C §4 + 6H-2D §3·§4 보호 주문 온체인 증거 수집기.
 *
 * 증거 우선순위 (지시서 §4):
 *  1. 온체인 tx receipt (성공 여부·block 결속 포함)
 *  2. 허용 EventEmitter의 OrderCreated / OrderExecuted / OrderCancelled / OrderFrozen
 *  3. GMX API status — 보조 참고만 (단독으로 terminal 전이 금지; 판정은 judgeProtection)
 *  4. authoritative 포지션 상태 — 교차검증만
 *
 * 6H-2D §3 의미 결속 (semantic binding):
 *  - OrderCreated → ACTIVE 허용 조건: 허용 emitter + 정확한 EventLog2 topic0 +
 *    eventNameHash + 32-byte orderKey + topic account(topics[3])가 기대 account/
 *    subaccount와 일치 + eventData 의미 필드(market/orderType/isLong/receiver/
 *    autoCancel/swapPath/sizeDeltaUsd/triggerPrice)가 durable 기대값과 일치 +
 *    receipt success·block 결속 + finality 확인 + 모순 이벤트 없음.
 *  - 검증할 수 없는 필드(디코딩 불가·기대값 미구성·receipt/finality 조회 불가)는
 *    성공으로 가정하지 않는다 → 전이 억제 (fail-closed).
 *  - Executed/Cancelled/Frozen도 동일 orderKey + account 결속 + receipt·finality를 요구.
 *
 * 규칙:
 *  - 허용 emitter = [현재 설정 emitter] ∪ [레코드에 영속된 emitter] (gmx-event-emitter 규칙)
 *  - 서로 다른 orderKey 복수 관측 / 상충 terminal 이벤트 / created 없이 terminal /
 *    receipt reverted / eventData 중복 키 = ambiguous → 전이 금지
 *  - 조회 실패 = null (전이 없음 + 신규 OPEN 차단은 호출측 reconcileProtections가 담당)
 *  - 의존성 주입식 — 테스트에서 실 RPC 0회
 */
import {
  EVENT_LOG_2_TOPIC0, ORDER_EVENT_NAME_HASH, classifyOrderResolutionLogs,
  extractOrderKeyFromReceiptLogs, decodeEventLog2Data, accountTopicOf, type RawLog,
} from './gmxOrderEvents';
import { ORDER_TYPE } from './gmxCreateOrder';

/**
 * §4 — 필요한 confirmation depth (보수 정책).
 * 공식 GMX 문서에 이벤트 소비자용 finality 규격이 없어 보수적으로 정의:
 * Arbitrum One의 재구성은 드물지만 L1 posting 이전 구간을 배제하기 위해 15블록.
 */
export const EVIDENCE_CONFIRMATION_DEPTH = 15;

export interface EvidenceClient {
  /** eth_getLogs — orderKey 결속 EventLog2 (Created/Executed/Cancelled/Frozen) */
  getOrderLogs(orderKey: string, emitters: string[]): Promise<RawLog[] | null>;
  /** tx receipt (status·block 포함). 미존재 = null 반환, 조회 오류 = throw */
  getReceipt?(txHash: string): Promise<{ status: 'success' | 'reverted'; blockNumber: string | null; logs: RawLog[] } | null>;
  /** 최신 block number (finality 판정). 실패 = null */
  getLatestBlockNumber?(): Promise<bigint | null>;
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
  /** 모호성 — 어떤 사유든 전이 금지 */
  ambiguous: boolean;
  ambiguousReasons: string[];
  /** 6H-2D §3 — 의미 결속 결과 (true=일치, false=불일치, null=검증 불가) */
  semanticOk: boolean | null;
  semanticMismatches: string[];
  /** 6H-2D §4 — 판정 근거 receipt/finality */
  receiptStatus: 'success' | 'reverted' | null;
  receiptBlockNumber: string | null;
  confirmations: number | null;
  finalityOk: boolean | null;
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

/** 같은 orderKey에 대해 관측된 resolution 종류 집합 (상충 검출용) */
function resolutionKindsOf(logs: RawLog[], orderKey: string, emitters: string[]): Set<string> {
  const wanted = orderKey.toLowerCase();
  const kinds = new Set<string>();
  for (const log of logs ?? []) {
    if (!isAllowed(log.address, emitters)) continue;
    if (log.topics?.[0]?.toLowerCase() !== EVENT_LOG_2_TOPIC0.toLowerCase()) continue;
    if (log.topics?.[2]?.toLowerCase() !== wanted) continue;
    const nh = log.topics?.[1]?.toLowerCase();
    if (nh === ORDER_EVENT_NAME_HASH.OrderExecuted.toLowerCase())  kinds.add('executed');
    if (nh === ORDER_EVENT_NAME_HASH.OrderCancelled.toLowerCase()) kinds.add('cancelled');
    if (nh === ORDER_EVENT_NAME_HASH.OrderFrozen.toLowerCase())    kinds.add('frozen');
  }
  return kinds;
}

export interface CollectArgs {
  row: {
    requestId: string | null;
    orderKey: string | null;
    marketAddress: string;
    isLong: boolean;
    /** 레코드에 영속된 emitter (있으면 허용집합에 합집합) */
    emitterAddress?: string | null;
    /** 6H-2D §3 — 의미 결속 기대값 (durable) */
    purpose?: string | null;              // INITIAL_STOP | PROFIT_FLOOR_STOP | EMERGENCY_CLOSE
    sizeDeltaUsd?: number | null;         // USD (1e30 이벤트값과 상대오차 비교)
    triggerPriceUsd?: number | null;
    decimalsUsed?: number | null;         // triggerPrice 스케일 역산에 필요
  };
  client: EvidenceClient;
  /** 현재 설정 emitter (fail-closed resolve 결과). null = 수집 불가 */
  configuredEmitter: string | null;
  /** GMX API status 조회 (보조) — 실패 = null */
  fetchApiStatus?: (requestId: string) => Promise<string | null>;
  /** authoritative 포지션 존재 여부 (교차검증) — null = 조회 실패 */
  positionExists: boolean | null;
  /** 6H-2D §3 — 기대 account 집합 (main + subaccount, 소문자 비교). 비어있으면 검증 불가 */
  expectedAccounts?: string[];
  /** 기대 receiver (main account). null = 검증 불가 */
  expectedReceiver?: string | null;
}

const REL_TOLERANCE = 0.001; // 0.1% — 수치 의미 필드 상대 오차 허용

/** createdLog eventData 의미 검증 — true/false/null(검증 불가) */
function verifyCreatedSemantics(
  log: RawLog, args: CollectArgs, mismatches: string[], ambiguousReasons: string[],
): boolean | null {
  const expectedAccounts = (args.expectedAccounts ?? []).map(a => a.toLowerCase());
  if (expectedAccounts.length === 0) { mismatches.push('기대 account 미구성 — 검증 불가'); return null; }
  const topicAccount = accountTopicOf(log);
  if (!topicAccount) { mismatches.push('topic account 부재/형식 오류'); return null; }
  if (!expectedAccounts.includes(topicAccount)) { mismatches.push(`topic account ${topicAccount} ∉ 기대 account 집합`); return false; }

  const data = decodeEventLog2Data(log);
  if (!data) { mismatches.push('eventData 디코딩 불가 — 의미 필드 검증 불가'); return null; }
  if (data.duplicateKeys.length > 0) {
    ambiguousReasons.push(`eventData 중복 키: ${data.duplicateKeys.join(',')}`);
    return false;
  }

  let unverifiable = false;
  const requireAddr = (key: string, expected: string | null, label: string): boolean => {
    const v = data.addressItems.get(key);
    if (v === undefined) { mismatches.push(`eventData에 ${key} 부재 — 검증 불가`); unverifiable = true; return true; }
    if (expected === null) { mismatches.push(`기대 ${label} 미구성 — 검증 불가`); unverifiable = true; return true; }
    if (v.toLowerCase() !== expected.toLowerCase()) { mismatches.push(`${label} 불일치 (${v})`); return false; }
    return true;
  };

  let ok = true;
  // account — eventData의 account도 기대 집합과 일치해야 함 (topic과 이중 결속)
  const evAccount = data.addressItems.get('account');
  if (evAccount === undefined) { mismatches.push('eventData에 account 부재 — 검증 불가'); unverifiable = true; }
  else if (!expectedAccounts.includes(evAccount.toLowerCase())) { mismatches.push(`eventData account ${evAccount} ∉ 기대 집합`); ok = false; }

  if (!requireAddr('market', args.row.marketAddress, 'market')) ok = false;
  if (!requireAddr('receiver', args.expectedReceiver ?? null, 'receiver')) ok = false;

  // orderType — purpose별 기대 (stop=StopLossDecrease, emergency=MarketDecrease)
  const expectedOrderType = args.row.purpose === 'EMERGENCY_CLOSE' ? ORDER_TYPE.MarketDecrease : ORDER_TYPE.StopLossDecrease;
  const evOrderType = data.uintItems.get('orderType');
  if (evOrderType === undefined) { mismatches.push('eventData에 orderType 부재 — 검증 불가'); unverifiable = true; }
  else if (evOrderType !== expectedOrderType) { mismatches.push(`orderType ${evOrderType} ≠ 기대 ${expectedOrderType}`); ok = false; }

  // isLong — decrease 주문의 isLong은 포지션 방향과 일치해야 함
  const evIsLong = data.boolItems.get('isLong');
  if (evIsLong === undefined) { mismatches.push('eventData에 isLong 부재 — 검증 불가'); unverifiable = true; }
  else if (evIsLong !== args.row.isLong) { mismatches.push(`isLong ${evIsLong} ≠ 기대 ${args.row.isLong}`); ok = false; }

  // autoCancel — 정책상 false만 (6H-2D §2)
  const evAutoCancel = data.boolItems.get('autoCancel');
  if (evAutoCancel === undefined) { mismatches.push('eventData에 autoCancel 부재 — 검증 불가'); unverifiable = true; }
  else if (evAutoCancel !== false) { mismatches.push('autoCancel=true — 정책(미사용) 불일치'); ok = false; }

  // swapPath — 존재하면 빈 배열만
  const evSwapPath = data.addressArrayItems.get('swapPath');
  if (evSwapPath !== undefined && evSwapPath.length !== 0) { mismatches.push('swapPath 비어있지 않음'); ok = false; }

  // sizeDeltaUsd — 1e30 스케일 상대오차 비교 (기대값 없으면 검증 불가)
  const evSize = data.uintItems.get('sizeDeltaUsd');
  if (evSize === undefined) { mismatches.push('eventData에 sizeDeltaUsd 부재 — 검증 불가'); unverifiable = true; }
  else if (args.row.sizeDeltaUsd == null) { mismatches.push('기대 sizeDeltaUsd 미구성 — 검증 불가'); unverifiable = true; }
  else {
    const evUsd = Number(evSize) / 1e30;
    const exp = args.row.sizeDeltaUsd;
    if (!(exp > 0) || Math.abs(evUsd - exp) / exp > REL_TOLERANCE) { mismatches.push(`sizeDeltaUsd ${evUsd} ≠ 기대 ${exp}`); ok = false; }
  }

  // triggerPrice — stop만. decimalsUsed 없으면 스케일 역산 불가 = 검증 불가
  if (args.row.purpose !== 'EMERGENCY_CLOSE') {
    const evTrig = data.uintItems.get('triggerPrice');
    if (evTrig === undefined) { mismatches.push('eventData에 triggerPrice 부재 — 검증 불가'); unverifiable = true; }
    else if (args.row.triggerPriceUsd == null || args.row.decimalsUsed == null) {
      mismatches.push('기대 triggerPrice/decimals 미구성 — 검증 불가'); unverifiable = true;
    } else {
      const scale = Math.pow(10, 30 - args.row.decimalsUsed);
      const evUsd = Number(evTrig) / scale;
      const exp = args.row.triggerPriceUsd;
      if (!(exp > 0) || Math.abs(evUsd - exp) / exp > REL_TOLERANCE) { mismatches.push(`triggerPrice ${evUsd} ≠ 기대 ${exp}`); ok = false; }
    }
  }

  if (!ok) return false;
  if (unverifiable) return null; // 불일치는 없으나 일부 필드 검증 불가 — 성공 가정 금지
  return true;
}

/** receipt + finality 검증. true=확정, false=모순(ambiguous 사유 push), null=검증 불가 */
async function verifyReceiptAndFinality(
  log: RawLog, args: CollectArgs, latest: bigint | null, label: string,
  ambiguousReasons: string[], out: { receiptStatus: 'success' | 'reverted' | null; receiptBlockNumber: string | null; confirmations: number | null },
): Promise<boolean | null> {
  const txHash = log.transactionHash ?? null;
  if (!txHash) { return null; }
  if (!args.client.getReceipt) { return null; } // receipt 조회 능력 없음 — 확정 금지
  let rc: Awaited<ReturnType<NonNullable<EvidenceClient['getReceipt']>>>;
  try { rc = await args.client.getReceipt(txHash); } catch { return null; }
  if (rc === null) { return null; } // receipt 미존재 — 전이 없음
  out.receiptStatus = rc.status;
  out.receiptBlockNumber = rc.blockNumber;
  if (rc.status === 'reverted') { ambiguousReasons.push(`${label} receipt reverted — 전이 금지`); return false; }
  if (!rc.blockNumber) { return null; } // blockNumber 부재 — 확정 금지
  // log blockNumber 부재 = receipt block과의 일치를 증명할 수 없음 → 확정 금지
  const logBn = log.blockNumber == null ? null : BigInt(String(log.blockNumber));
  if (logBn === null) { return null; }
  if (BigInt(rc.blockNumber) !== logBn) {
    ambiguousReasons.push(`${label} log block(${logBn}) ≠ receipt block(${rc.blockNumber})`);
    return false;
  }
  // receipt logs에 동일 (emitter, topic0, nameHash, orderKey) 로그가 존재해야 함.
  // logs가 배열이 아니면 포함 검증 자체가 불가 → 확정 금지 (성공 가정 금지)
  if (!Array.isArray(rc.logs)) { return null; }
  const present = rc.logs.some(l =>
    l.address?.toLowerCase() === log.address.toLowerCase() &&
    l.topics?.[0]?.toLowerCase() === log.topics?.[0]?.toLowerCase() &&
    l.topics?.[1]?.toLowerCase() === log.topics?.[1]?.toLowerCase() &&
    l.topics?.[2]?.toLowerCase() === log.topics?.[2]?.toLowerCase());
  if (!present) { ambiguousReasons.push(`${label} 로그가 receipt에 없음 — 위조/불일치`); return false; }
  // finality — 최신 block 확인 실패 = terminal 확정 금지
  if (latest === null) { return null; }
  const confirmations = Number(latest - BigInt(rc.blockNumber));
  out.confirmations = confirmations;
  if (confirmations < EVIDENCE_CONFIRMATION_DEPTH) { return null; } // 아직 미확정 — 전이 보류
  return true;
}

/**
 * 보호 주문 1건의 증거 번들 수집. 수집 자체가 불가능(설정/조회 실패)하면 null —
 * 호출측은 전이 없음 + 차단 유지로 처리해야 한다.
 *
 * 6H-2D: onchainOrderKey / executed / cancelled / frozen 플래그는
 * "의미 결속 + receipt 성공 + finality 확인 + 모순 없음"을 전부 통과했을 때만
 * 설정된다 — judgeProtection은 이 플래그를 그대로 신뢰해도 fail-closed가 유지된다.
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

  const empty: ProtectionEvidenceBundle = {
    apiStatus,
    onchainOrderKey: null,
    onchainExecuted: false, onchainCancelled: false, onchainFrozen: false,
    positionExists: args.positionExists,
    createdTxHash: null, resolutionTxHash: null, resolutionBlockNumber: null,
    matchedEmitter: null, ambiguous: false, ambiguousReasons: [],
    semanticOk: null, semanticMismatches: [],
    receiptStatus: null, receiptBlockNumber: null, confirmations: null, finalityOk: null,
  };

  // orderKey가 없으면 온체인 조회 결속 불가 — API status(보조) + 포지션만으로 번들 구성
  if (!args.row.orderKey || !/^0x[0-9a-fA-F]{64}$/.test(args.row.orderKey)) {
    return empty;
  }

  let logs: RawLog[] | null = null;
  try { logs = await args.client.getOrderLogs(args.row.orderKey, emitters); } catch { logs = null; }
  if (logs === null) return null; // 온체인 조회 실패 — 판정 금지 (차단 유지)

  const ambiguousReasons: string[] = [];
  const semanticMismatches: string[] = [];

  // OrderCreated — 동일 receipt에 서로 다른 key가 섞였는지 방어적 재검사
  const createdCheck = extractOrderKeyFromReceiptLogs(
    logs.filter(l => l.topics?.[1]?.toLowerCase() === ORDER_EVENT_NAME_HASH.OrderCreated.toLowerCase()),
    emitters,
  );
  if (!createdCheck.ok && createdCheck.reason === 'ambiguous') {
    ambiguousReasons.push('서로 다른 orderKey OrderCreated 복수 관측');
  }
  const createdLog = findCreatedLog(logs, args.row.orderKey, emitters);

  // 실행/취소/동결 — orderKey 정확 결속 분류 + 상충 검출
  const kinds = resolutionKindsOf(logs, args.row.orderKey, emitters);
  if (kinds.size > 1) ambiguousReasons.push(`상충 terminal 이벤트 동시 관측 (${[...kinds].join('+')})`);
  const resolution = classifyOrderResolutionLogs(logs, args.row.orderKey, emitters);
  if (resolution && !createdLog) ambiguousReasons.push('OrderCreated 증거 없이 terminal 이벤트 관측');

  // ── 6H-2D §3 — created 의미 결속 ─────────────────────────────────────────────
  let semanticOk: boolean | null = null;
  if (createdLog) {
    semanticOk = verifyCreatedSemantics(createdLog, args, semanticMismatches, ambiguousReasons);
  }

  // ── 6H-2D §4 — receipt·finality (판정 근거 로그별) ───────────────────────────
  let latest: bigint | null = null;
  if (args.client.getLatestBlockNumber) {
    try { latest = await args.client.getLatestBlockNumber(); } catch { latest = null; }
  }
  const receiptOut = { receiptStatus: null as 'success' | 'reverted' | null, receiptBlockNumber: null as string | null, confirmations: null as number | null };
  let createdFinal: boolean | null = null;
  if (createdLog) {
    createdFinal = await verifyReceiptAndFinality(createdLog, args, latest, 'OrderCreated', ambiguousReasons, receiptOut);
  }
  // resolution 로그의 account 결속 + receipt·finality
  let resolutionFinal: boolean | null = null;
  let resolutionAccountOk = false;
  if (resolution) {
    // terminal 로그 선택은 resolution kind의 정확한 eventNameHash까지 결속 —
    // 동일 tx의 다른 EventLog2로 대체 검증되는 것을 차단
    const resKindName = `Order${resolution.kind.charAt(0).toUpperCase()}${resolution.kind.slice(1)}` as keyof typeof ORDER_EVENT_NAME_HASH;
    const resNameHash: string | undefined = ORDER_EVENT_NAME_HASH[resKindName];
    const resLog = logs.find(l =>
      isAllowed(l.address, emitters) &&
      l.topics?.[0]?.toLowerCase() === EVENT_LOG_2_TOPIC0.toLowerCase() &&
      l.topics?.[1]?.toLowerCase() === resNameHash?.toLowerCase() &&
      l.topics?.[2]?.toLowerCase() === args.row.orderKey!.toLowerCase() &&
      l.transactionHash === resolution.txHash) ?? null;
    if (resLog) {
      const expectedAccounts = (args.expectedAccounts ?? []).map(a => a.toLowerCase());
      const acct = accountTopicOf(resLog);
      resolutionAccountOk = !!acct && expectedAccounts.length > 0 && expectedAccounts.includes(acct);
      if (!resolutionAccountOk) semanticMismatches.push('terminal 이벤트 account 결속 실패/미구성 — 전이 보류');
      resolutionFinal = await verifyReceiptAndFinality(resLog, args, latest, `Order${resolution.kind}`, ambiguousReasons, receiptOut);
    }
  }

  const ambiguous = ambiguousReasons.length > 0;

  // 플래그 게이팅 — 모든 검증 통과 시에만 설정 (fail-closed by construction)
  const activeEligible = !!createdLog && semanticOk === true && createdFinal === true && !ambiguous;
  const terminalEligible = !!createdLog && !!resolution && resolutionAccountOk && resolutionFinal === true && !ambiguous;

  return {
    apiStatus,
    onchainOrderKey: activeEligible ? args.row.orderKey : null,
    onchainExecuted: terminalEligible && resolution!.kind === 'executed',
    onchainCancelled: terminalEligible && resolution!.kind === 'cancelled',
    onchainFrozen: terminalEligible && resolution!.kind === 'frozen',
    positionExists: args.positionExists,
    createdTxHash: createdLog?.transactionHash ?? null,
    resolutionTxHash: resolution?.txHash ?? null,
    resolutionBlockNumber: resolution?.blockNumber ?? null,
    matchedEmitter: createdLog?.address ?? null,
    ambiguous,
    ambiguousReasons,
    semanticOk,
    semanticMismatches,
    receiptStatus: receiptOut.receiptStatus,
    receiptBlockNumber: receiptOut.receiptBlockNumber,
    confirmations: receiptOut.confirmations,
    finalityOk: createdLog ? createdFinal : resolutionFinal,
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
