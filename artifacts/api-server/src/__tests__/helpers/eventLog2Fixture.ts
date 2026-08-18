/**
 * 6H-2D 테스트 공용 — EventLog2 로그 fixture 인코딩 헬퍼.
 * 공식 EVENT_LOG_2_ABI 구조 그대로 encodeAbiParameters로 data를 생성해
 * decodeEventLog2Data(프로덕션 디코더)가 실제 온체인 로그와 동일하게 해석한다.
 * 실 RPC 0회 — 전부 로컬 인코딩.
 */
import { encodeAbiParameters, pad, type AbiParameter } from 'viem';
import { EVENT_LOG_2_ABI, EVENT_LOG_2_TOPIC0, ORDER_EVENT_NAME_HASH, type RawLog } from '../../lib/gmxOrderEvents';

type KV<T> = { key: string; value: T };
type Items<T> = { items: KV<T>[]; arrayItems: { key: string; value: T[] }[] };

const emptyItems = <T,>(): Items<T> => ({ items: [], arrayItems: [] });

export interface EventDataFields {
  addressItems?: KV<`0x${string}`>[];
  addressArrayItems?: { key: string; value: `0x${string}`[] }[];
  uintItems?: KV<bigint>[];
  boolItems?: KV<boolean>[];
  bytes32Items?: KV<`0x${string}`>[];
}

/** EventLog2 비인덱스 파라미터(msgSender, eventName, eventData) ABI 인코딩 */
export function encodeEventLog2Data(eventName: string, fields: EventDataFields): `0x${string}` {
  const nonIndexed = (EVENT_LOG_2_ABI.inputs as readonly (AbiParameter & { indexed?: boolean })[])
    .filter(i => !i.indexed);
  const eventData = {
    addressItems: {
      items: fields.addressItems ?? [],
      arrayItems: fields.addressArrayItems ?? [],
    },
    uintItems: { items: fields.uintItems ?? [], arrayItems: [] },
    intItems: emptyItems<bigint>(),
    boolItems: { items: fields.boolItems ?? [], arrayItems: [] },
    bytes32Items: { items: fields.bytes32Items ?? [], arrayItems: [] },
    bytesItems: emptyItems<`0x${string}`>(),
    stringItems: emptyItems<string>(),
  };
  return encodeAbiParameters(nonIndexed, [
    '0x' + '11'.repeat(20) as `0x${string}`, // msgSender (검증 대상 아님)
    eventName,
    eventData,
  ]);
}

export interface VerifiedLogArgs {
  name: keyof typeof ORDER_EVENT_NAME_HASH;
  orderKey: string;
  emitter: string;
  account: string;              // topics[3]에 32바이트 패딩되어 들어감
  txHash?: string;
  blockNumber?: string;
  fields?: EventDataFields;     // 미지정 = eventName만 인코딩 (의미 필드 없음)
  data?: `0x${string}` | null;  // 명시 지정 시 fields 무시
}

/** account topic 포함 + eventData 인코딩된 완전한 EventLog2 fixture 로그 */
export function mkEventLog2(a: VerifiedLogArgs): RawLog {
  return {
    address: a.emitter,
    topics: [
      EVENT_LOG_2_TOPIC0,
      ORDER_EVENT_NAME_HASH[a.name],
      a.orderKey,
      pad(a.account as `0x${string}`, { size: 32 }),
    ],
    transactionHash: a.txHash ?? ('0x' + 'cd'.repeat(32)),
    blockNumber: a.blockNumber ?? '123',
    data: a.data !== undefined ? a.data : encodeEventLog2Data(a.name, a.fields ?? {}),
  };
}

/** 의미 결속 전 필드가 기대값과 일치하는 OrderCreated fixture 필드 셋 */
export function stopCreatedFields(args: {
  account: `0x${string}`; receiver: `0x${string}`; market: `0x${string}`;
  isLong: boolean; sizeDeltaUsd: number; triggerPriceUsd: number; decimals: number;
  orderType?: bigint; autoCancel?: boolean;
}): EventDataFields {
  const size = BigInt(Math.round(args.sizeDeltaUsd * 1e6)) * 10n ** 24n; // ×1e30
  const trig = BigInt(Math.round(args.triggerPriceUsd * 1e6)) * 10n ** BigInt(30 - args.decimals - 6);
  return {
    addressItems: [
      { key: 'account', value: args.account },
      { key: 'receiver', value: args.receiver },
      { key: 'market', value: args.market },
    ],
    addressArrayItems: [{ key: 'swapPath', value: [] }],
    uintItems: [
      { key: 'orderType', value: args.orderType ?? 6n }, // StopLossDecrease
      { key: 'sizeDeltaUsd', value: size },
      { key: 'triggerPrice', value: trig },
    ],
    boolItems: [
      { key: 'isLong', value: args.isLong },
      { key: 'autoCancel', value: args.autoCancel ?? false },
    ],
  };
}

/** receipt fixture — 해당 로그를 포함한 success receipt */
export function mkReceiptFor(log: RawLog): { status: 'success' | 'reverted'; blockNumber: string | null; logs: RawLog[] } {
  return { status: 'success', blockNumber: log.blockNumber == null ? null : String(log.blockNumber), logs: [log] };
}
