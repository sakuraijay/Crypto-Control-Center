/**
 * gmxApiOrders — 공식 GMX API v2 prepare 검증 + status 매핑 (6G-1 §7·§10).
 *
 * prepare → sign → submit → status 흐름 중 "검증"과 "판정"만 담당한다.
 * 네트워크 호출은 gmxApiTransport, durable 흐름은 gmxApiSubmitFlow가 담당.
 */

import { keccak256, toHex, getAddress } from 'viem';
import { GMX_API_CHAIN_ID } from './gmxApiTransport';

export const GMX_API_TRANSPORT_GEN = 'GMX_API_V2';

/** GMX API 주문 status 문자열 (OpenAPI/SDK 기준) */
export const GMX_API_STATUS = {
  PREPARED: 'prepared',
  RELAY_ACCEPTED: 'relay_accepted',
  RELAY_PENDING: 'relay_pending',
  RELAY_SUBMITTED: 'relay_submitted',
  CREATED: 'created',
  EXECUTED: 'executed',
  CANCELLED: 'cancelled',
  RELAY_FAILED: 'relay_failed',
  RELAY_REVERTED: 'relay_reverted',
} as const;

export type GmxApiOrderStatus = (typeof GMX_API_STATUS)[keyof typeof GMX_API_STATUS];

/**
 * status → 내부 판정 (§10).
 *  - executed: 온체인 OrderExecuted + receipt 교차 확인 후에만 CONFIRMED →
 *    여기서는 'confirm_pending_onchain' (온체인 증거 수집 필요) 반환.
 *  - relay_reverted: receipt status=0 확인 후에만 FAILED → 'fail_pending_receipt'.
 *  - relay_failed: pre-broadcast 근거가 명확할 때만 FAILED → API가 명확한
 *    pre-broadcast 사유를 준 경우에만 'failed_pre_broadcast', 아니면 blocking.
 *  - created/pending/submitted/알 수 없음: blocking 유지.
 */
export type GmxStatusVerdict =
  | { action: 'confirm_pending_onchain' }   // executed — 온체인 교차 확인 필요
  | { action: 'cancelled' }                 // cancelled — CANCELLED 확정
  | { action: 'failed_pre_broadcast' }      // relay_failed + 명확한 pre-broadcast 근거
  | { action: 'fail_pending_receipt' }      // relay_reverted — receipt status=0 확인 필요
  | { action: 'blocking'; reason: string }; // 그 외 전부 — 자동 종결 금지

export function mapGmxApiStatus(status: string, opts?: { preBroadcastEvidence?: boolean }): GmxStatusVerdict {
  switch (status) {
    case GMX_API_STATUS.EXECUTED:
      return { action: 'confirm_pending_onchain' };
    case GMX_API_STATUS.CANCELLED:
      return { action: 'cancelled' };
    case GMX_API_STATUS.RELAY_REVERTED:
      return { action: 'fail_pending_receipt' };
    case GMX_API_STATUS.RELAY_FAILED:
      // pre-broadcast 근거(예: relay 수락 전 검증 거부)가 명확할 때만 FAILED.
      return opts?.preBroadcastEvidence
        ? { action: 'failed_pre_broadcast' }
        : { action: 'blocking', reason: 'relay_failed — pre-broadcast 근거 불명, 조사 필요 (자동 FAILED 금지)' };
    case GMX_API_STATUS.PREPARED:
    case GMX_API_STATUS.RELAY_ACCEPTED:
    case GMX_API_STATUS.RELAY_PENDING:
    case GMX_API_STATUS.RELAY_SUBMITTED:
    case GMX_API_STATUS.CREATED:
      return { action: 'blocking', reason: `비종결 상태(${status}) — 대기` };
    default:
      return { action: 'blocking', reason: '알 수 없는 GMX API status — 자동 종결 금지' };
  }
}

/** terminal 판정용 — 역행 방지 (기존 relayLifecycle terminal 정책과 별개 이중 가드) */
export function isTerminalGmxApiStatus(status: string): boolean {
  return status === GMX_API_STATUS.EXECUTED
    || status === GMX_API_STATUS.CANCELLED
    || status === GMX_API_STATUS.RELAY_FAILED
    || status === GMX_API_STATUS.RELAY_REVERTED;
}

/** prepare 응답에서 검증해야 하는 필드의 정규화 뷰 */
export interface PreparedOrderView {
  requestId: string;
  idempotencyKey: string;
  mode: string;                     // 'express' 필수
  payloadType: string;              // 'typed-data' 필수 (external signer 흐름)
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType?: string;
  };
  from: string;                     // main wallet
  subaccountAddress: string | null;
  orderKind: string;
  isLong: boolean | null;
  sizeDeltaUsd: string | null;
  collateralToken: string | null;
  receiver: string | null;
  executionFeeAmount: string | null;
}

export interface PrepareValidationInput {
  prepared: PreparedOrderView;
  expected: {
    mainWallet: string;             // GMX_WALLET_ADDRESS
    subaccountAddress: string;      // delegated signer 공개 주소
    orderKind: string;              // 예: MarketIncrease/MarketDecrease
    isLong: boolean;
    sizeDeltaUsd: string;           // 십진 문자열 정확 일치
    collateralToken: string;
    chainId?: number;               // 기본 42161
  };
}

export type PrepareValidationResult = { ok: true; payloadHash: string } | { ok: false; reasons: string[] };

function normAddr(a: string | null | undefined): string | null {
  if (!a) return null;
  try { return getAddress(a); } catch { return null; }
}

/**
 * prepare 결과 검증 (§7-4) — 하나라도 어긋나면 서명 금지 (fail-closed).
 * 통과 시 typed data 전체를 결정적으로 직렬화한 payloadHash를 반환한다
 * (durable PREPARED 기록·서명 결속·request 결속에 사용).
 */
export function validatePreparedOrder(input: PrepareValidationInput): PrepareValidationResult {
  const { prepared, expected } = input;
  const reasons: string[] = [];
  const chainId = expected.chainId ?? GMX_API_CHAIN_ID;

  if (!prepared.requestId || typeof prepared.requestId !== 'string') reasons.push('requestId 없음');
  if (!prepared.idempotencyKey || typeof prepared.idempotencyKey !== 'string') reasons.push('idempotencyKey 없음');
  if (prepared.mode !== 'express') reasons.push(`mode!=express (${prepared.mode})`);
  if (prepared.payloadType !== 'typed-data') reasons.push(`payloadType!=typed-data (${prepared.payloadType})`);

  const domainChain = Number((prepared.typedData?.domain as { chainId?: unknown })?.chainId);
  if (domainChain !== chainId) reasons.push(`typed data domain chainId!=${chainId}`);

  const from = normAddr(prepared.from);
  const expectedMain = normAddr(expected.mainWallet);
  if (!from || !expectedMain || from !== expectedMain) reasons.push('from이 main wallet과 불일치');

  const sub = normAddr(prepared.subaccountAddress);
  const expectedSub = normAddr(expected.subaccountAddress);
  if (!sub || !expectedSub || sub !== expectedSub) reasons.push('subaccount 주소 불일치');

  if (prepared.orderKind !== expected.orderKind) reasons.push(`order kind 불일치 (${prepared.orderKind})`);
  if (prepared.isLong === null || prepared.isLong !== expected.isLong) reasons.push('direction(isLong) 불일치');
  if (!prepared.sizeDeltaUsd || prepared.sizeDeltaUsd !== expected.sizeDeltaUsd) reasons.push('size 불일치');

  const col = normAddr(prepared.collateralToken);
  const expectedCol = normAddr(expected.collateralToken);
  if (!col || !expectedCol || col !== expectedCol) reasons.push('collateral token 불일치');

  // receiver 제한: main wallet만 허용 (출력 우회 금지)
  const receiver = normAddr(prepared.receiver);
  if (receiver !== null && receiver !== expectedMain) reasons.push('receiver가 main wallet이 아님');

  // execution fee 존재 확인 (없으면 estimate 불명 — 차단)
  if (prepared.executionFeeAmount === null || prepared.executionFeeAmount === undefined) {
    reasons.push('executionFeeAmount(estimates) 없음');
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, payloadHash: hashPreparedPayload(prepared) };
}

/** typed data 전체의 결정적 hash — durable 기록·서명 결속용 */
export function hashPreparedPayload(prepared: PreparedOrderView): string {
  const canonical = JSON.stringify({
    requestId: prepared.requestId,
    idempotencyKey: prepared.idempotencyKey,
    typedData: sortDeep(prepared.typedData),
  });
  return keccak256(toHex(canonical));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return typeof v === 'bigint' ? v.toString() : v;
}

/**
 * GMX API prepare 원시 응답 → PreparedOrderView 정규화.
 * 필드가 없으면 null — validatePreparedOrder가 차단한다 (관대한 파싱 금지 아님:
 * 구조 자체가 다르면 decode 오류로 취급).
 */
export function toPreparedOrderView(raw: unknown, requested: {
  from: string; subaccountAddress: string | null; orderKind: string;
  isLong: boolean; sizeDeltaUsd: string; collateralToken: string; receiver: string | null;
}): { ok: true; view: PreparedOrderView } | { ok: false; reason: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return { ok: false, reason: 'prepare 응답이 object가 아님' };
  const payload = r.payload as Record<string, unknown> | undefined;
  const typedData = payload?.typedData as PreparedOrderView['typedData'] | undefined;
  if (!typedData?.domain || !typedData?.types || !typedData?.message) {
    return { ok: false, reason: 'prepare 응답에 typedData(domain/types/message) 없음' };
  }
  const estimates = r.estimates as Record<string, unknown> | undefined;
  // API가 주문 필드를 echo하는 경우 요청값과 대조 — 불일치는 즉시 decode 거부.
  // (echo가 없으면 요청값으로 결속하되, typed data 재계산 게이트가 최종 검증한다.)
  const echoConflict = (key: string, requestedVal: unknown): boolean => {
    const echoed = r[key];
    if (echoed === undefined || echoed === null) return false;
    if (typeof echoed === 'string' && typeof requestedVal === 'string'
      && /^0x[0-9a-fA-F]{40}$/.test(echoed) && /^0x[0-9a-fA-F]{40}$/.test(requestedVal)) {
      return echoed.toLowerCase() !== requestedVal.toLowerCase();
    }
    return String(echoed) !== String(requestedVal);
  };
  const echoChecks: [string, unknown][] = [
    ['subaccountAddress', requested.subaccountAddress],
    ['orderKind', requested.orderKind],
    ['isLong', requested.isLong],
    ['sizeDeltaUsd', requested.sizeDeltaUsd],
    ['collateralToken', requested.collateralToken],
    ['receiver', requested.receiver],
  ];
  for (const [key, val] of echoChecks) {
    if (echoConflict(key, val)) {
      return { ok: false, reason: `prepare 응답 echo 필드(${key})가 요청값과 불일치 — 차단 (fail-closed)` };
    }
  }
  return {
    ok: true,
    view: {
      requestId: String(r.requestId ?? ''),
      idempotencyKey: String(r.idempotencyKey ?? ''),
      mode: String(r.mode ?? ''),
      payloadType: String(r.payloadType ?? ''),
      typedData,
      // 요청측 파라미터는 요청 값으로 결속 검증 — API가 echo하지 않는 필드는
      // typed data 검증(별도 EIP-712 재계산 게이트)에서 잡는다.
      from: String(r.from ?? requested.from),
      subaccountAddress: requested.subaccountAddress,
      orderKind: requested.orderKind,
      isLong: requested.isLong,
      sizeDeltaUsd: requested.sizeDeltaUsd,
      collateralToken: requested.collateralToken,
      receiver: requested.receiver,
      executionFeeAmount: estimates?.executionFeeAmount !== undefined ? String(estimates.executionFeeAmount) : null,
    },
  };
}
