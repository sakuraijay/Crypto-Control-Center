/**
 * GMX V2 주문 이벤트 파싱 — EventEmitter 로그에서 order key 추출 및 판정 분류.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 온체인 근거 (2026-08-17 조사, 코드베이스에 이벤트 ABI 부재 → 공식 자료 대조)
 * ──────────────────────────────────────────────────────────────────────────────
 * 1. 모든 GMX V2 프로토콜 이벤트는 단일 EventEmitter 계약에서 방출된다.
 *    출처: https://docs.gmx.io/docs/api/contracts/events/
 * 2. Arbitrum One EventEmitter 주소: 0xC8ee91A54287DB53897056e12D9819156D3822Fb
 *    출처: https://docs.gmx.io/docs/api/contracts/addresses/ (Arbitrum 표)
 * 3. gmx-io/gmx-synthetics contracts/order/OrderEventUtils.sol (main 브랜치):
 *    OrderCreated / OrderExecuted / OrderCancelled / OrderFrozen 은 전부
 *    `eventEmitter.emitEventLog2(eventName, key, Cast.toBytes32(account), data)`
 *    로 방출된다 — 즉 topic1 = order key, topic2 = account.
 * 4. contracts/event/EventEmitter.sol: EventLog2 는
 *    `EventLog2(address msgSender, string eventName, string indexed eventNameHash,
 *      bytes32 indexed topic1, bytes32 indexed topic2, EventLogData eventData)`
 *    → 로그 topics = [signatureHash, keccak256(eventName), topic1(key), topic2(account)]
 *    (indexed string 은 문자열 bytes의 keccak256 해시가 topic으로 들어감)
 *
 * 파싱 전략: EventLog2 signature hash를 하드코딩하지 않고,
 *   address == EventEmitter && topics[1] == keccak256(이벤트명) 으로 필터 →
 *   topics[2] 가 order key. 이벤트명 해시는 런타임에 keccak256으로 계산하므로
 *   추측 signature가 없다. 잘못 매칭되면 orderKey 불일치로 무시되어 fail-closed.
 */

import { keccak256, toHex } from 'viem';

/** Arbitrum One GMX V2 EventEmitter — 출처는 파일 상단 주석 참조 */
export const GMX_EVENT_EMITTER_ADDRESS = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';

export const ARBITRUM_ONE_CHAIN_ID = 42161;

/** eventNameHash = keccak256(utf8 bytes of event name) — indexed string topic 규칙 */
export const ORDER_EVENT_NAME_HASH = {
  OrderCreated:   keccak256(toHex('OrderCreated')),
  OrderExecuted:  keccak256(toHex('OrderExecuted')),
  OrderCancelled: keccak256(toHex('OrderCancelled')),
  OrderFrozen:    keccak256(toHex('OrderFrozen')),
} as const;

export interface RawLog {
  address:          string;
  topics:           string[];
  transactionHash?: string | null;
  blockNumber?:     bigint | string | number | null;
}

function isEmitter(addr: string): boolean {
  return addr?.toLowerCase() === GMX_EVENT_EMITTER_ADDRESS.toLowerCase();
}

function nameHashOf(log: RawLog): string | undefined {
  return log.topics?.[1]?.toLowerCase();
}

/** topic1 (= order key) 위치: topics[2] — [sig, eventNameHash, topic1, topic2] */
function keyOf(log: RawLog): string | undefined {
  return log.topics?.[2]?.toLowerCase();
}

export type OrderKeyExtraction =
  | { ok: true; orderKey: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' };

/**
 * receipt 로그에서 OrderCreated 이벤트의 order key 추출.
 * - EventEmitter 주소 + OrderCreated eventNameHash 매칭 필수
 * - 매칭 0건 → not_found (UNRESOLVED 유지 대상)
 * - 서로 다른 key 2건 이상 → ambiguous (판정 불가, UNRESOLVED 유지 대상)
 */
export function extractOrderKeyFromReceiptLogs(logs: RawLog[]): OrderKeyExtraction {
  const keys = new Set<string>();
  for (const log of logs ?? []) {
    if (!isEmitter(log.address)) continue;
    if (nameHashOf(log) !== ORDER_EVENT_NAME_HASH.OrderCreated.toLowerCase()) continue;
    const key = keyOf(log);
    if (key) keys.add(key);
  }
  if (keys.size === 0) return { ok: false, reason: 'not_found' };
  if (keys.size > 1)  return { ok: false, reason: 'ambiguous' };
  return { ok: true, orderKey: [...keys][0] };
}

export type OrderResolution =
  | { kind: 'executed' | 'cancelled' | 'frozen'; txHash: string | null; blockNumber: string | null }
  | null;

/**
 * order key에 대한 실행/취소/동결 이벤트 분류.
 * 우선순위: executed > cancelled > frozen (실행 근거가 있으면 확정 우선).
 * 매칭 없음 → null (생성만 확인된 상태 — 계속 차단).
 */
export function classifyOrderResolutionLogs(logs: RawLog[], orderKey: string): OrderResolution {
  const wanted = orderKey.toLowerCase();
  let found: { kind: 'executed' | 'cancelled' | 'frozen'; log: RawLog } | null = null;
  const rank = { executed: 3, cancelled: 2, frozen: 1 } as const;
  for (const log of logs ?? []) {
    if (!isEmitter(log.address)) continue;
    if (keyOf(log) !== wanted) continue;
    const nh = nameHashOf(log);
    let kind: 'executed' | 'cancelled' | 'frozen' | null = null;
    if (nh === ORDER_EVENT_NAME_HASH.OrderExecuted.toLowerCase())  kind = 'executed';
    if (nh === ORDER_EVENT_NAME_HASH.OrderCancelled.toLowerCase()) kind = 'cancelled';
    if (nh === ORDER_EVENT_NAME_HASH.OrderFrozen.toLowerCase())    kind = 'frozen';
    if (!kind) continue;
    if (!found || rank[kind] > rank[found.kind]) found = { kind, log };
  }
  if (!found) return null;
  const bn = found.log.blockNumber;
  return {
    kind:        found.kind,
    txHash:      found.log.transactionHash ?? null,
    blockNumber: bn == null ? null : String(bn),
  };
}
