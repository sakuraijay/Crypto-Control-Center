/**
 * GMX V2 주문 이벤트 파싱 — EventEmitter 로그에서 order key 추출 및 판정 분류.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 온체인 근거 (2026-08-17 갱신 — 공식 문서 기준)
 * ──────────────────────────────────────────────────────────────────────────────
 * 1. 모든 GMX V2 프로토콜 이벤트는 단일 EventEmitter 계약에서 방출된다.
 *    출처: https://docs.gmx.io/docs/api/contracts/events/
 * 2. EventEmitter 주소는 **하드코딩 기본값 없이** GMX_EVENT_EMITTER_ADDRESS
 *    환경변수로만 설정한다. 미설정/형식 오류 → fail-closed (LIVE 실행·온체인
 *    reconciliation 전면 차단). PAPER 모드는 emitter를 사용하지 않으므로 무영향.
 *    근거: 과거 기본값 0xAf2E131d…89C2 는 공식 addresses 문서상 Botanix/MegaETH
 *    체인의 EventEmitter였고, Arbitrum One(42161)의 공식 주소는
 *    0xC8ee91A54287DB53897056e12D9819156D3822Fb 이다 (2026-08-17 문서 기준).
 *    잘못된 기본값이 조용히 사용되는 사고를 막기 위해 기본값 자체를 제거한다.
 *    출처: https://docs.gmx.io/docs/api/contracts/addresses/ (Arbitrum 표)
 * 3. gmx-io/gmx-synthetics contracts/order/OrderEventUtils.sol (main 브랜치):
 *    OrderCreated / OrderExecuted / OrderCancelled / OrderFrozen 은 전부
 *    `eventEmitter.emitEventLog2(eventName, key, Cast.toBytes32(account), data)`
 *    로 방출된다 — 즉 topic1 = order key, topic2 = account.
 * 4. contracts/event/EventEmitter.sol: EventLog2 는
 *    `EventLog2(address msgSender, string eventName, string indexed eventNameHash,
 *      bytes32 indexed topic1, bytes32 indexed topic2, EventLogData eventData)`
 *    → 로그 topics = [EventLog2 signature, keccak256(eventName), topic1(key), topic2(account)]
 *    (indexed string 은 문자열 bytes의 keccak256 해시가 topic으로 들어감)
 *
 * 파싱 전략 (fail-closed):
 *  - topics[0] 은 공식 ABI에서 파생한 EventLog2 signature hash와 정확히 일치해야 한다
 *    (추측 금지 — 아래 EVENT_LOG_2_ABI에서 viem toEventSelector로 계산).
 *  - address 는 허용된 emitter 집합(현재 설정값 + intent에 영속된 과거 매칭 주소)에
 *    속해야 한다. 이전 주소만으로 들어온 로그를 현재 주소로 오인하지 않는다.
 *  - topics[1] == keccak256(이벤트명), topics[2] == order key 로 판별.
 *  - 위조 topic0, 예상 밖 emitter, 복수 orderKey → 전부 무시/ambiguous → UNRESOLVED 유지.
 */

import { keccak256, toHex, toEventSelector, decodeEventLog, type AbiEvent } from 'viem';

// ── EventEmitter 주소 설정 ────────────────────────────────────────────────────

/**
 * Arbitrum One(42161) 공식 EventEmitter — **문서화·설정 예시 전용** 상수.
 * 코드가 이 값을 기본값으로 자동 사용하지 않는다. 운영자는 이 값을 직접 확인 후
 * GMX_EVENT_EMITTER_ADDRESS 환경변수로 명시 설정해야 한다.
 * 출처: https://docs.gmx.io/docs/api/contracts/addresses/ (2026-08-17 기준)
 */
export const GMX_EVENT_EMITTER_ARBITRUM_OFFICIAL_DOC = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';

/**
 * 다른 체인의 EventEmitter로 공식 문서에 기재된 주소들 — Arbitrum 설정값으로
 * 들어오면 구성 오류로 거부한다 (chain/address 교차 오설정 방지).
 * 과거 이 코드베이스가 0xAf2E…를 Arbitrum 기본값으로 잘못 사용한 사고의 재발 방지.
 */
export const KNOWN_NON_ARBITRUM_EVENT_EMITTERS: ReadonlyArray<{ address: string; chain: string }> = [
  { address: '0xAf2E131d483cedE068e21a9228aD91E623a989C2', chain: 'Botanix/MegaETH' },
  { address: '0xDb17B211c34240B014ab6d61d4A31FA0C0e20c26', chain: 'Avalanche' },
];

export const ARBITRUM_ONE_CHAIN_ID = 42161;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidEvmAddress(addr: string | undefined | null): addr is string {
  return typeof addr === 'string' && ADDRESS_RE.test(addr.trim());
}

export type EmitterConfigResult =
  | { ok: true; address: string; source: 'env' }
  | { ok: false; reason: string };

/**
 * 유효 EventEmitter 주소 결정 — 기본값 없음, 환경변수 명시 설정 필수.
 *  - 미설정 → 실패 (fail-closed: LIVE 실행·신규 reconciliation 차단. PAPER 무영향)
 *  - 형식 오류(0x + 40 hex 아님) → 실패
 *  - 알려진 타 체인(Botanix/MegaETH/Avalanche) EventEmitter 주소 → 실패
 *    (Arbitrum One 42161 전용 구성 검증)
 * intent에 영속된 과거 emitter 주소는 historical reconciliation 허용집합에만
 * 쓰이며(intentReconciler 참조), 신규 주문 생성은 항상 현재 명시 설정을 요구한다.
 * chainId 검증은 reconciler가 판정 전에 별도로 수행한다 (42161 필수).
 */
export function resolveGmxEventEmitterAddress(
  env: NodeJS.ProcessEnv = process.env,
): EmitterConfigResult {
  const raw = env.GMX_EVENT_EMITTER_ADDRESS;
  if (raw === undefined || raw.trim() === '') {
    return {
      ok: false,
      reason: 'GMX_EVENT_EMITTER_ADDRESS 미설정 — 기본값 없음, 공식 addresses 문서에서 Arbitrum One 주소 확인 후 명시 설정 필요 (fail-closed)',
    };
  }
  const trimmed = raw.trim();
  if (!isValidEvmAddress(trimmed)) {
    return { ok: false, reason: 'GMX_EVENT_EMITTER_ADDRESS 형식 오류 (0x + 40 hex 필요) — fail-closed' };
  }
  const wrongChain = KNOWN_NON_ARBITRUM_EVENT_EMITTERS.find(
    e => e.address.toLowerCase() === trimmed.toLowerCase(),
  );
  if (wrongChain) {
    return {
      ok: false,
      reason: `GMX_EVENT_EMITTER_ADDRESS가 ${wrongChain.chain} 체인의 EventEmitter 주소임 — Arbitrum One(42161) 주소가 아님 (fail-closed)`,
    };
  }
  return { ok: true, address: trimmed, source: 'env' };
}

// ── EventLog2 signature (topic0) — 공식 ABI에서 파생, 하드코딩 해시 금지 ───────

/** EventUtils.EventLogData 의 canonical tuple 구성 요소 (gmx-synthetics EventUtils.sol) */
function itemsTuple(valueType: string) {
  return {
    type: 'tuple',
    components: [
      {
        type: 'tuple[]',
        name: 'items',
        components: [
          { type: 'string', name: 'key' },
          { type: valueType, name: 'value' },
        ],
      },
      {
        type: 'tuple[]',
        name: 'arrayItems',
        components: [
          { type: 'string', name: 'key' },
          { type: `${valueType}[]`, name: 'value' },
        ],
      },
    ],
  } as const;
}

/**
 * EventEmitter.EventLog2 공식 ABI (gmx-synthetics contracts/event/EventEmitter.sol +
 * contracts/event/EventUtils.sol 구조체 정의 기준).
 */
export const EVENT_LOG_2_ABI: AbiEvent = {
  type: 'event',
  name: 'EventLog2',
  inputs: [
    { type: 'address', name: 'msgSender', indexed: false },
    { type: 'string',  name: 'eventName', indexed: false },
    { type: 'string',  name: 'eventNameHash', indexed: true },
    { type: 'bytes32', name: 'topic1', indexed: true },
    { type: 'bytes32', name: 'topic2', indexed: true },
    {
      type: 'tuple',
      name: 'eventData',
      indexed: false,
      components: [
        { ...itemsTuple('address'), name: 'addressItems' },
        { ...itemsTuple('uint256'), name: 'uintItems' },
        { ...itemsTuple('int256'),  name: 'intItems' },
        { ...itemsTuple('bool'),    name: 'boolItems' },
        { ...itemsTuple('bytes32'), name: 'bytes32Items' },
        { ...itemsTuple('bytes'),   name: 'bytesItems' },
        { ...itemsTuple('string'),  name: 'stringItems' },
      ],
    },
  ],
} as unknown as AbiEvent;

/**
 * EventEmitter.EventLog1 공식 ABI. PositionDecrease / PositionFeesCollected /
 * KeeperExecutionFee는 topic1 하나만 쓰는 EventLog1으로 방출된다.
 */
export const EVENT_LOG_1_ABI: AbiEvent = {
  type: 'event',
  name: 'EventLog1',
  inputs: [
    { type: 'address', name: 'msgSender', indexed: false },
    { type: 'string',  name: 'eventName', indexed: false },
    { type: 'string',  name: 'eventNameHash', indexed: true },
    { type: 'bytes32', name: 'topic1', indexed: true },
    {
      type: 'tuple',
      name: 'eventData',
      indexed: false,
      components: [
        { ...itemsTuple('address'), name: 'addressItems' },
        { ...itemsTuple('uint256'), name: 'uintItems' },
        { ...itemsTuple('int256'),  name: 'intItems' },
        { ...itemsTuple('bool'),    name: 'boolItems' },
        { ...itemsTuple('bytes32'), name: 'bytes32Items' },
        { ...itemsTuple('bytes'),   name: 'bytesItems' },
        { ...itemsTuple('string'),  name: 'stringItems' },
      ],
    },
  ],
} as unknown as AbiEvent;

/** EventLog2 signature hash (topic0) — ABI에서 계산, 절대 손으로 하드코딩하지 않음 */
export const EVENT_LOG_2_TOPIC0 = toEventSelector(EVENT_LOG_2_ABI);
/** EventLog1 signature hash — ABI에서 계산, 하드코딩 금지 */
export const EVENT_LOG_1_TOPIC0 = toEventSelector(EVENT_LOG_1_ABI);

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
  /** 비인덱스 payload (EventLogData ABI 인코딩) — 의미 결속 검증에 필요 */
  data?:            string | null;
}

// ── 6H-2D §3 — EventLogData 디코딩 (의미 결속 검증용) ─────────────────────────

export interface DecodedEventData {
  addressItems: Map<string, string>;
  uintItems:    Map<string, bigint>;
  intItems:     Map<string, bigint>;
  boolItems:    Map<string, boolean>;
  bytes32Items: Map<string, string>;
  addressArrayItems: Map<string, string[]>;
  /** 같은 key 중복 출현 감지 (위조/혼입 방어) */
  duplicateKeys: string[];
}

type ItemsShape<T> = { items: readonly { key: string; value: T }[]; arrayItems: readonly { key: string; value: readonly T[] }[] };

function intoMap<T>(items: readonly { key: string; value: T }[], dups: string[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items ?? []) {
    if (m.has(it.key)) dups.push(it.key);
    m.set(it.key, it.value);
  }
  return m;
}

/**
 * EventLog2 로그의 eventData(EventUtils.EventLogData)를 공식 ABI로 디코딩.
 * data 부재/디코딩 실패 = null — 호출측은 "검증 불가 = 성공 가정 금지"로 처리해야 한다.
 */
function decodeKnownEventLogData(log: RawLog, abi: AbiEvent): DecodedEventData | null {
  if (!log.data || log.data === '0x') return null;
  try {
    const decoded = decodeEventLog({
      abi: [abi],
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    const ev = (decoded.args as unknown as { eventData?: Record<string, ItemsShape<unknown>> }).eventData;
    if (!ev) return null;
    const dups: string[] = [];
    const addr = ev.addressItems as ItemsShape<string> | undefined;
    const uint = ev.uintItems as ItemsShape<bigint> | undefined;
    const int  = ev.intItems as ItemsShape<bigint> | undefined;
    const bool = ev.boolItems as ItemsShape<boolean> | undefined;
    const b32  = ev.bytes32Items as ItemsShape<string> | undefined;
    return {
      addressItems: intoMap(addr?.items ?? [], dups),
      uintItems:    intoMap(uint?.items ?? [], dups),
      intItems:     intoMap(int?.items ?? [], dups),
      boolItems:    intoMap(bool?.items ?? [], dups),
      bytes32Items: intoMap(b32?.items ?? [], dups),
      addressArrayItems: intoMap(
        (addr?.arrayItems ?? []).map(a => ({ key: a.key, value: [...a.value] })), dups,
      ),
      duplicateKeys: dups,
    };
  } catch { return null; }
}

export function decodeEventLog2Data(log: RawLog): DecodedEventData | null {
  if (log.topics?.[0]?.toLowerCase() !== EVENT_LOG_2_TOPIC0.toLowerCase()) return null;
  return decodeKnownEventLogData(log, EVENT_LOG_2_ABI);
}

/** EventLog1 전용 디코더 — exact signature가 아니면 null. */
export function decodeEventLog1Data(log: RawLog): DecodedEventData | null {
  if (log.topics?.[0]?.toLowerCase() !== EVENT_LOG_1_TOPIC0.toLowerCase()) return null;
  return decodeKnownEventLogData(log, EVENT_LOG_1_ABI);
}

/** topic2 (= account) 위치: topics[3] — [sig, eventNameHash, topic1(key), topic2(account)] */
export function accountTopicOf(log: RawLog): string | null {
  const t = log.topics?.[3];
  if (!t || !/^0x[0-9a-fA-F]{64}$/.test(t)) return null;
  // bytes32로 캐스팅된 address — 하위 20바이트
  return ('0x' + t.slice(26)).toLowerCase();
}

function isAllowedEmitter(addr: string, allowed: string[]): boolean {
  const a = addr?.toLowerCase();
  return !!a && allowed.some(x => x.toLowerCase() === a);
}

function hasExactSignature(log: RawLog): boolean {
  return log.topics?.[0]?.toLowerCase() === EVENT_LOG_2_TOPIC0.toLowerCase();
}

function nameHashOf(log: RawLog): string | undefined {
  return log.topics?.[1]?.toLowerCase();
}

/** topic1 (= order key) 위치: topics[2] — [sig, eventNameHash, topic1, topic2] */
function keyOf(log: RawLog): string | undefined {
  return log.topics?.[2]?.toLowerCase();
}

export type OrderKeyExtraction =
  | { ok: true; orderKey: string; emitterAddress: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' };

/**
 * receipt 로그에서 OrderCreated 이벤트의 order key 추출.
 * - 허용 emitter 주소 + 정확한 EventLog2 topic0 + OrderCreated eventNameHash 매칭 필수
 * - 매칭 0건 → not_found (UNRESOLVED 유지 대상)
 * - 서로 다른 key 2건 이상 → ambiguous (판정 불가, UNRESOLVED 유지 대상)
 * - 실제 일치한 emitter 주소를 반환 → 호출자가 intent에 영속 저장해
 *   추후 주소 교체 이후에도 같은 emitter로 reconcile할 수 있게 한다.
 */
export function extractOrderKeyFromReceiptLogs(
  logs: RawLog[],
  allowedEmitters: string[],
): OrderKeyExtraction {
  const keys = new Set<string>();
  let matchedEmitter: string | null = null;
  for (const log of logs ?? []) {
    if (!isAllowedEmitter(log.address, allowedEmitters)) continue;
    if (!hasExactSignature(log)) continue;
    if (nameHashOf(log) !== ORDER_EVENT_NAME_HASH.OrderCreated.toLowerCase()) continue;
    const key = keyOf(log);
    if (key) {
      keys.add(key);
      matchedEmitter = log.address;
    }
  }
  if (keys.size === 0) return { ok: false, reason: 'not_found' };
  if (keys.size > 1)  return { ok: false, reason: 'ambiguous' };
  return { ok: true, orderKey: [...keys][0], emitterAddress: matchedEmitter! };
}

export type OrderResolution =
  | {
      kind: 'executed' | 'cancelled' | 'frozen';
      txHash: string | null;
      blockNumber: string | null;
      emitterAddress: string;
    }
  | null;

/**
 * order key에 대한 실행/취소/동결 이벤트 분류.
 * 허용 emitter + 정확한 EventLog2 topic0 필수 (위조 signature 차단).
 * 우선순위: executed > cancelled > frozen (실행 근거가 있으면 확정 우선).
 * 매칭 없음 → null (생성만 확인된 상태 — 계속 차단).
 */
export function classifyOrderResolutionLogs(
  logs: RawLog[],
  orderKey: string,
  allowedEmitters: string[],
): OrderResolution {
  const wanted = orderKey.toLowerCase();
  let found: { kind: 'executed' | 'cancelled' | 'frozen'; log: RawLog } | null = null;
  const rank = { executed: 3, cancelled: 2, frozen: 1 } as const;
  for (const log of logs ?? []) {
    if (!isAllowedEmitter(log.address, allowedEmitters)) continue;
    if (!hasExactSignature(log)) continue;
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
    emitterAddress: found.log.address,
  };
}
