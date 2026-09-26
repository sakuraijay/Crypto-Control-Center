/**
 * CLOSE settlement evidence judge.
 *
 * This module is deliberately pure and dependency-injected: it never submits,
 * signs, prepares, or retries an order. It only validates already-durable CLOSE
 * binding against read-only status / receipt / finality / position evidence.
 */

import { keccak256, toHex } from 'viem';
import {
  decodeEventLog1Data,
  EVENT_LOG_1_TOPIC0,
  EVENT_LOG_2_TOPIC0,
  ORDER_EVENT_NAME_HASH,
  type DecodedEventData,
  type RawLog,
} from './gmxOrderEvents';
import { EVIDENCE_CONFIRMATION_DEPTH } from './protectionEvidence';
import { WETH_ARBITRUM } from './relayFeeQuote';

const USD_SCALE = 10n ** 30n;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const EVENT_HASH = {
  PositionDecrease: keccak256(toHex('PositionDecrease')).toLowerCase(),
  PositionFeesCollected: keccak256(toHex('PositionFeesCollected')).toLowerCase(),
  KeeperExecutionFee: keccak256(toHex('KeeperExecutionFee')).toLowerCase(),
  OraclePriceUpdate: keccak256(toHex('OraclePriceUpdate')).toLowerCase(),
} as const;

export interface CloseSettlementBinding {
  tradeId: string;
  intentId: string;
  relayTaskId: string;
  accountAddress: string;
  marketAddress: string;
  collateralTokenAddress: string;
  positionKey: string;
  isLong: boolean;
  /** Exact GMX USD integer (1e30), captured before durable intent creation. */
  preCloseSizeUsd30: bigint;
  /** Exact requested MarketDecrease sizeDeltaUsd integer (1e30). */
  requestedReductionUsd30: bigint;
  expectedOrderKey: string;
  expectedTxHash: string;
  expectedEmitterAddress: string;
  expectedBlockNumber: bigint;
}

export interface ExactPositionReadback {
  positionKey: string;
  accountAddress: string;
  marketAddress: string;
  collateralTokenAddress: string;
  isLong: boolean;
  /** Exact PositionReader sizeInUsd integer (1e30). */
  sizeUsd30: bigint;
}

export interface CloseSettlementObservation {
  receiptStatus: 'success' | 'reverted';
  receiptTxHash: string;
  receiptBlockNumber: bigint;
  receiptLogs: RawLog[];
  latestBlockNumber: bigint;
  /** Timestamp of receiptBlockNumber from an RPC block read. */
  receiptBlockTimestampMs: number;
  postClosePositions: ExactPositionReadback[];
}

export interface VerifiedCloseSettlement {
  grossPnlUsd: number;
  positionFeeUsd: number;
  executionFeeUsd: number;
  /** Positive = adverse cost; negative = favorable improvement. */
  priceImpactUsd: number;
  fundingFeeUsd: number;
  borrowingFeeUsd: number;
  evidenceTxHash: string;
  settledAt: Date;
  orderKey: string;
  emitterAddress: string;
  resolutionBlock: string;
  latestBlock: string;
  confirmations: number;
  postCloseSizeUsd30: string;
  evidenceBasis: string;
}

export type CloseSettlementVerdict =
  | { ok: true; settlement: VerifiedCloseSettlement }
  | { ok: false; reason: string };

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isAllowedEmitter(log: RawLog, expected: string): boolean {
  return ADDRESS_RE.test(log.address ?? '') && sameHex(log.address, expected);
}

function topic(log: RawLog, index: number): string {
  return (log.topics?.[index] ?? '').toLowerCase();
}

function requireMapValue<T>(
  data: DecodedEventData,
  map: Map<string, T>,
  key: string,
): T | null {
  if (data.duplicateKeys.includes(key)) return null;
  return map.has(key) ? map.get(key)! : null;
}

/**
 * Convert an exact 1e30 fixed-point USD integer to the DB's 8-decimal number.
 * Rounding is deterministic half-up; overflow / non-finite values are rejected.
 */
export function usd30ToDbNumber(value: bigint): number | null {
  const negative = value < 0n;
  let abs = negative ? -value : value;
  const whole = abs / USD_SCALE;
  if (whole > 9_999_999_999n) return null; // numeric(18,8)
  let frac8 = (abs % USD_SCALE) / (10n ** 22n);
  const next = ((abs % USD_SCALE) / (10n ** 21n)) % 10n;
  if (next >= 5n) frac8 += 1n;
  let roundedWhole = whole;
  if (frac8 >= 100_000_000n) {
    roundedWhole += 1n;
    frac8 -= 100_000_000n;
  }
  if (roundedWhole > 9_999_999_999n) return null;
  const text = `${negative ? '-' : ''}${roundedWhole}.${frac8.toString().padStart(8, '0')}`;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function fail(reason: string): CloseSettlementVerdict {
  return { ok: false, reason };
}

function exactEventLog1(
  logs: RawLog[],
  expectedEmitter: string,
  nameHash: string,
  label: string,
): { log: RawLog; data: DecodedEventData } | { reason: string } {
  const named = (logs ?? []).filter((log) =>
    isAllowedEmitter(log, expectedEmitter)
    && topic(log, 0) === EVENT_LOG_1_TOPIC0.toLowerCase()
    && topic(log, 1) === nameHash,
  );
  if (named.length !== 1) {
    return { reason: `${label} 이벤트 ${named.length}건 — 정확히 1건 필요` };
  }
  const data = decodeEventLog1Data(named[0]);
  if (!data || data.duplicateKeys.length > 0) {
    return { reason: `${label} eventData 디코딩 실패/중복 key — 정산 거부` };
  }
  return { log: named[0], data };
}

/**
 * Actual keeper fee (WNT amount) × the same execution receipt's WNT oracle
 * price. A min/max range is not collapsed to an estimate: only an exact single
 * oracle value is settlement-eligible.
 */
export function deriveExecutionFeeUsd30(
  logs: RawLog[],
  expectedEmitter: string,
): { ok: true; value: bigint } | { ok: false; reason: string } {
  const keeper = exactEventLog1(
    logs,
    expectedEmitter,
    EVENT_HASH.KeeperExecutionFee,
    'KeeperExecutionFee',
  );
  if ('reason' in keeper) return { ok: false, reason: keeper.reason };
  const amount = requireMapValue(keeper.data, keeper.data.uintItems, 'executionFeeAmount');
  if (amount === null || amount < 0n) {
    return { ok: false, reason: 'KeeperExecutionFee.executionFeeAmount 부재/비정상' };
  }

  const oracleNamed = (logs ?? []).filter((log) =>
    isAllowedEmitter(log, expectedEmitter)
    && topic(log, 0) === EVENT_LOG_1_TOPIC0.toLowerCase()
    && topic(log, 1) === EVENT_HASH.OraclePriceUpdate,
  );
  const wethUpdates: DecodedEventData[] = [];
  for (const log of oracleNamed) {
    const data = decodeEventLog1Data(log);
    if (!data || data.duplicateKeys.length > 0) {
      return { ok: false, reason: 'OraclePriceUpdate 디코딩 실패/중복 key' };
    }
    const token = requireMapValue(data, data.addressItems, 'token');
    if (token !== null && sameHex(token, WETH_ARBITRUM)) wethUpdates.push(data);
  }
  if (wethUpdates.length !== 1) {
    return { ok: false, reason: `WNT OraclePriceUpdate ${wethUpdates.length}건 — 정확히 1건 필요` };
  }
  const minPrice = requireMapValue(wethUpdates[0], wethUpdates[0].uintItems, 'minPrice');
  const maxPrice = requireMapValue(wethUpdates[0], wethUpdates[0].uintItems, 'maxPrice');
  if (minPrice === null || maxPrice === null || minPrice <= 0n || minPrice !== maxPrice) {
    return { ok: false, reason: 'WNT oracle min/max 단일값 증거 부재 — 실행 수수료 USD 추정 금지' };
  }
  return { ok: true, value: amount * minPrice };
}

function verifyTerminal(
  binding: CloseSettlementBinding,
  observation: CloseSettlementObservation,
): { ok: true } | { ok: false; reason: string } {
  const terminalHashes = new Set(Object.values(ORDER_EVENT_NAME_HASH).slice(1).map((x) => x.toLowerCase()));
  const terminal = observation.receiptLogs.filter((log) =>
    isAllowedEmitter(log, binding.expectedEmitterAddress)
    && topic(log, 0) === EVENT_LOG_2_TOPIC0.toLowerCase()
    && terminalHashes.has(topic(log, 1)),
  );
  if (terminal.length !== 1) {
    return { ok: false, reason: `terminal GMX 이벤트 ${terminal.length}건 — 다중/부재 정산 금지` };
  }
  const log = terminal[0];
  if (topic(log, 1) !== ORDER_EVENT_NAME_HASH.OrderExecuted.toLowerCase()) {
    return { ok: false, reason: 'terminal 이벤트가 OrderExecuted가 아님 — 정산 금지' };
  }
  if (!sameHex(topic(log, 2), binding.expectedOrderKey)) {
    return { ok: false, reason: 'OrderExecuted orderKey 불일치 — 정산 금지' };
  }
  if (!log.transactionHash || !sameHex(log.transactionHash, binding.expectedTxHash)) {
    return { ok: false, reason: 'OrderExecuted txHash 불일치/부재 — 정산 금지' };
  }
  if (log.blockNumber == null || BigInt(log.blockNumber) !== binding.expectedBlockNumber) {
    return { ok: false, reason: 'OrderExecuted block 불일치/부재 — 정산 금지' };
  }
  return { ok: true };
}

function validateBinding(binding: CloseSettlementBinding): string | null {
  if (!binding.tradeId || !binding.intentId || !binding.relayTaskId) return 'durable CLOSE linkage 부재';
  if (!ADDRESS_RE.test(binding.accountAddress)
      || !ADDRESS_RE.test(binding.marketAddress)
      || !ADDRESS_RE.test(binding.collateralTokenAddress)
      || !ADDRESS_RE.test(binding.expectedEmitterAddress)) return 'CLOSE 주소 결속 형식 오류';
  if (!HASH_RE.test(binding.positionKey)
      || !HASH_RE.test(binding.expectedOrderKey)
      || !HASH_RE.test(binding.expectedTxHash)) return 'CLOSE hash 결속 형식 오류';
  if (binding.preCloseSizeUsd30 <= 0n
      || binding.requestedReductionUsd30 <= 0n
      || binding.requestedReductionUsd30 > binding.preCloseSizeUsd30) return 'CLOSE size 결속 범위 오류';
  if (binding.expectedBlockNumber < 0n) return 'CLOSE block 결속 오류';
  return null;
}

export function evaluateCloseSettlement(
  binding: CloseSettlementBinding,
  observation: CloseSettlementObservation,
): CloseSettlementVerdict {
  const bindingError = validateBinding(binding);
  if (bindingError) return fail(bindingError);

  if (observation.receiptStatus !== 'success') return fail('receipt reverted — SETTLED 전환 금지');
  if (!sameHex(observation.receiptTxHash, binding.expectedTxHash)) return fail('receipt txHash 결속 불일치');
  if (observation.receiptBlockNumber !== binding.expectedBlockNumber) return fail('receipt block 결속 불일치');
  if (observation.latestBlockNumber < observation.receiptBlockNumber) return fail('latest block이 receipt block보다 과거');
  const confirmations = Number(observation.latestBlockNumber - observation.receiptBlockNumber);
  if (!Number.isSafeInteger(confirmations) || confirmations < EVIDENCE_CONFIRMATION_DEPTH) {
    return fail(`finality 부족 — confirmations=${confirmations}`);
  }
  if (!Number.isFinite(observation.receiptBlockTimestampMs) || observation.receiptBlockTimestampMs <= 0) {
    return fail('receipt block timestamp 부재/비정상');
  }

  const terminal = verifyTerminal(binding, observation);
  if (!terminal.ok) return fail(terminal.reason);

  const decrease = exactEventLog1(
    observation.receiptLogs,
    binding.expectedEmitterAddress,
    EVENT_HASH.PositionDecrease,
    'PositionDecrease',
  );
  if ('reason' in decrease) return fail(decrease.reason);
  const d = decrease.data;
  const dAccount = requireMapValue(d, d.addressItems, 'account');
  const dMarket = requireMapValue(d, d.addressItems, 'market');
  const dCollateral = requireMapValue(d, d.addressItems, 'collateralToken');
  const dOrderKey = requireMapValue(d, d.bytes32Items, 'orderKey');
  const dPositionKey = requireMapValue(d, d.bytes32Items, 'positionKey');
  const dIsLong = requireMapValue(d, d.boolItems, 'isLong');
  const postEventSize = requireMapValue(d, d.uintItems, 'sizeInUsd');
  const sizeDelta = requireMapValue(d, d.uintItems, 'sizeDeltaUsd');
  const basePnlUsd30 = requireMapValue(d, d.intItems, 'basePnlUsd');
  const impactUsd30 = requireMapValue(d, d.intItems, 'priceImpactUsd');
  if (dAccount === null || dMarket === null || dCollateral === null || dOrderKey === null
      || dPositionKey === null || dIsLong === null || postEventSize === null
      || sizeDelta === null || basePnlUsd30 === null || impactUsd30 === null) {
    return fail('PositionDecrease 필수 결속/금융 필드 부재');
  }
  if (!sameHex(dAccount, binding.accountAddress)
      || !sameHex(dMarket, binding.marketAddress)
      || !sameHex(dCollateral, binding.collateralTokenAddress)
      || !sameHex(dOrderKey, binding.expectedOrderKey)
      || !sameHex(dPositionKey, binding.positionKey)
      || dIsLong !== binding.isLong) return fail('PositionDecrease 의미 결속 불일치');
  if (sizeDelta !== binding.requestedReductionUsd30) return fail('PositionDecrease sizeDeltaUsd 요청값 불일치');
  const expectedPostSize = binding.preCloseSizeUsd30 - binding.requestedReductionUsd30;
  if (postEventSize !== expectedPostSize) return fail('PositionDecrease post-size 산술 불일치');

  const exactPostPositions = observation.postClosePositions.filter((p) =>
    sameHex(p.positionKey, binding.positionKey)
    && sameHex(p.accountAddress, binding.accountAddress)
    && sameHex(p.marketAddress, binding.marketAddress)
    && sameHex(p.collateralTokenAddress, binding.collateralTokenAddress)
    && p.isLong === binding.isLong,
  );
  const fullClose = expectedPostSize === 0n;
  if (fullClose) {
    if (exactPostPositions.length > 1 || (exactPostPositions[0]?.sizeUsd30 ?? 0n) !== 0n) {
      return fail('full close 후 exact position 부재/protocol-zero 증거 불충분');
    }
  } else {
    if (exactPostPositions.length !== 1 || exactPostPositions[0].sizeUsd30 !== expectedPostSize) {
      return fail('partial close exact 감소량 readback 불일치');
    }
  }

  const fees = exactEventLog1(
    observation.receiptLogs,
    binding.expectedEmitterAddress,
    EVENT_HASH.PositionFeesCollected,
    'PositionFeesCollected',
  );
  if ('reason' in fees) return fail(fees.reason);
  const f = fees.data;
  const fMarket = requireMapValue(f, f.addressItems, 'market');
  const fCollateral = requireMapValue(f, f.addressItems, 'collateralToken');
  const fOrderKey = requireMapValue(f, f.bytes32Items, 'orderKey');
  const fPositionKey = requireMapValue(f, f.bytes32Items, 'positionKey');
  const fIsIncrease = requireMapValue(f, f.boolItems, 'isIncrease');
  const tradeSize = requireMapValue(f, f.uintItems, 'tradeSizeUsd');
  const collateralPriceMin = requireMapValue(f, f.uintItems, 'collateralTokenPrice.min');
  const fundingFeeAmount = requireMapValue(f, f.uintItems, 'fundingFeeAmount');
  const borrowingFeeUsd30 = requireMapValue(f, f.uintItems, 'borrowingFeeUsd');
  const positionFeeAmount = requireMapValue(f, f.uintItems, 'positionFeeAmount');
  if (fMarket === null || fCollateral === null || fOrderKey === null || fPositionKey === null
      || fIsIncrease === null || tradeSize === null || collateralPriceMin === null
      || fundingFeeAmount === null || borrowingFeeUsd30 === null || positionFeeAmount === null) {
    return fail('PositionFeesCollected 필수 결속/금융 필드 부재');
  }
  if (!sameHex(fMarket, binding.marketAddress)
      || !sameHex(fCollateral, binding.collateralTokenAddress)
      || !sameHex(fOrderKey, binding.expectedOrderKey)
      || !sameHex(fPositionKey, binding.positionKey)
      || fIsIncrease !== false
      || tradeSize !== binding.requestedReductionUsd30) {
    return fail('PositionFeesCollected 의미 결속 불일치');
  }
  if (collateralPriceMin <= 0n) return fail('collateralTokenPrice.min 부재/0 — fee USD 환산 불가');
  const executionFee = deriveExecutionFeeUsd30(
    observation.receiptLogs,
    binding.expectedEmitterAddress,
  );
  if (!executionFee.ok) return fail(executionFee.reason);

  // GMX token prices use 1e(30-tokenDecimals), so raw token amount × price
  // is already an exact USD 1e30 integer.
  const positionFeeUsd30 = positionFeeAmount * collateralPriceMin;
  const fundingFeeUsd30 = fundingFeeAmount * collateralPriceMin;
  const converted = {
    grossPnlUsd: usd30ToDbNumber(basePnlUsd30),
    positionFeeUsd: usd30ToDbNumber(positionFeeUsd30),
    executionFeeUsd: usd30ToDbNumber(executionFee.value),
    // GMX positive price impact is favorable. Settlement storage models
    // positive as an adverse cost, therefore invert the official signed value.
    priceImpactUsd: usd30ToDbNumber(-impactUsd30),
    fundingFeeUsd: usd30ToDbNumber(fundingFeeUsd30),
    borrowingFeeUsd: usd30ToDbNumber(borrowingFeeUsd30),
  };
  if (Object.values(converted).some((v) => v === null)) return fail('금융 필드 DB 정밀도/범위 변환 실패');

  return {
    ok: true,
    settlement: {
      grossPnlUsd: converted.grossPnlUsd!,
      positionFeeUsd: converted.positionFeeUsd!,
      executionFeeUsd: converted.executionFeeUsd!,
      priceImpactUsd: converted.priceImpactUsd!,
      fundingFeeUsd: converted.fundingFeeUsd!,
      borrowingFeeUsd: converted.borrowingFeeUsd!,
      evidenceTxHash: binding.expectedTxHash,
      settledAt: new Date(observation.receiptBlockTimestampMs),
      orderKey: binding.expectedOrderKey,
      emitterAddress: binding.expectedEmitterAddress,
      resolutionBlock: binding.expectedBlockNumber.toString(),
      latestBlock: observation.latestBlockNumber.toString(),
      confirmations,
      postCloseSizeUsd30: expectedPostSize.toString(),
      evidenceBasis: `receipt success + exact OrderExecuted/PositionDecrease/PositionFeesCollected + ${confirmations} confirmations + exact post-position readback`,
    },
  };
}