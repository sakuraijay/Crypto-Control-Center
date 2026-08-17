/**
 * gmxApiExecution — 공식 GMX API v2 주문 실행 production 배선 (6G-2 §4·§5·§6·§7).
 *
 * gmxApiSubmitFlow(runGmxApiSubmitFlow)의 DI 콜백 세트를 실제 구성요소
 * (delegated signer, canonical approval 세션, activation gate, USDC allowance
 * 게이트, GMX API transport)로 조립한다.
 *
 * 원칙 (전부 fail-closed):
 *  - 모든 실행 플래그 기본 false → 이 모듈의 어떤 경로도 Production 기본값에서
 *    prepare/sign/submit 네트워크 호출 0회.
 *  - main wallet 개인키 경로 없음 — 서명은 delegated signer digest 서명만.
 *  - 서명은 서버가 재계산·검증한 typed data digest에 대해서만 수행 (§4).
 *  - typed data의 모든 주소 필드는 허용 목록(main/subaccount/market/USDC/zero/
 *    감사된 manifest 주소) 안에 있어야 한다 — 미지의 주소 = 서명 금지.
 *  - approval 서명 복호화는 flag+storage 게이트 통과 시에만 (§3·§4).
 *  - allowance 부족/조회 실패 = 제출 차단 (§7). 서버는 approve tx를 전송하지 않는다.
 */

import { and, desc, eq } from 'drizzle-orm';
import { hashTypedData, getAddress, isAddress, keccak256, toHex, type Hex, type Address } from 'viem';
import { randomUUID } from 'node:crypto';
import { db, subaccountApprovalSessionsTable, type SubaccountApprovalSessionRow } from '@workspace/db';
import {
  isDelegatedSignerEnabled,
  isSignerInitialized,
  isSignerStorageAccessAllowed,
  getSignerAddress,
  signDigestWithDelegatedSigner,
  decryptSensitiveHex,
} from './delegatedSigner';
import { SESSION_STATUS, APPROVAL_PURPOSE, getConfiguredMainAccount } from './ownerApprovalSession';
import { GMX_DEPLOYMENT_MANIFEST } from './gmxDeploymentManifest';
import { USDC_ADDRESS, ZERO_ADDRESS, usdSizeToGmx, usdToUsdcWei } from './gmxContracts';
import { GMX_API_CHAIN_ID, type GmxApiResult, type GmxApiTransport } from './gmxApiTransport';
import { toPreparedOrderView, type PreparedOrderView, type PrepareValidationInput } from './gmxApiOrders';
// NOTE: gmxApiMarkets는 '@gmx-io/sdk/v2'를 정적 import한다 — vitest에서 SDK
// subpath resolve가 깨지므로(6G-1 함정) 여기서는 lazy import로 격리한다.
// (사용 시점 = OPEN collateral gate 평가 시에만 로드)
type CheckUsdcCollateralGateFn = typeof import('./gmxApiMarkets')['checkUsdcCollateralGate'];
let _checkUsdcCollateralGate: CheckUsdcCollateralGateFn | null = null;
async function loadCheckUsdcCollateralGate(): Promise<CheckUsdcCollateralGateFn> {
  if (!_checkUsdcCollateralGate) {
    _checkUsdcCollateralGate = (await import('./gmxApiMarkets')).checkUsdcCollateralGate;
  }
  return _checkUsdcCollateralGate;
}
/** 테스트 주입용 override (SDK 로드 없이 gate 결과 주입) */
export function __setUsdcCollateralGateForTests(f: CheckUsdcCollateralGateFn | null): void {
  _checkUsdcCollateralGate = f;
}
import { runGmxApiSubmitFlow, type GmxSubmitFlowResult } from './gmxApiSubmitFlow';
import { evaluateActivationGate, type ActivationGateInput } from './relayActivationGate';

// ── 주문 요청 (worker 수치 → GMX 1e30/1e6 문자열 변환은 여기서 단일 규칙) ──────

export interface GmxOrderRequest {
  kind: 'OPEN' | 'CLOSE';
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  sizeUsd: number;
  /** OPEN에서만 사용 — CLOSE는 0 */
  collateralUsd: number;
  mainWallet: string;
  subaccountAddress: string;
}

export function orderKindOf(req: Pick<GmxOrderRequest, 'kind'>): string {
  return req.kind === 'OPEN' ? 'MarketIncrease' : 'MarketDecrease';
}

/** worker USD 수치 → 1e30 십진 문자열 (요청·검증 양쪽 동일 규칙) */
export function sizeDeltaUsdString(sizeUsd: number): string {
  return usdSizeToGmx(sizeUsd).toString();
}

/** OPEN 담보 USD → USDC 1e6 십진 문자열 */
export function collateralAmountString(collateralUsd: number): string {
  return usdToUsdcWei(collateralUsd).toString();
}

/** GMX API `/orders/txns/prepare` 요청 body (express + typed-data, external subaccount) */
export function buildOrderPrepareBody(req: GmxOrderRequest): Record<string, unknown> {
  return {
    chainId: GMX_API_CHAIN_ID,
    from: req.mainWallet,
    subaccountAddress: req.subaccountAddress,
    mode: 'express',
    payloadType: 'typed-data',
    orderKind: orderKindOf(req),
    marketAddress: req.marketAddress,
    isLong: req.isLong,
    sizeDeltaUsd: sizeDeltaUsdString(req.sizeUsd),
    initialCollateralDeltaAmount: req.kind === 'OPEN' ? collateralAmountString(req.collateralUsd) : '0',
    collateralToken: USDC_ADDRESS,
    // 출력·수취는 main wallet으로만 (§5) — subaccount/제3자 수취 금지
    receiver: req.mainWallet,
    ...(req.kind === 'CLOSE' ? { receiveToken: USDC_ADDRESS } : {}),
  };
}

/** validatePreparedOrder expected 블록 — 요청과 동일 변환 규칙으로 결속 */
export function buildExpectedValidation(req: GmxOrderRequest): PrepareValidationInput['expected'] {
  return {
    mainWallet: req.mainWallet,
    subaccountAddress: req.subaccountAddress,
    orderKind: orderKindOf(req),
    isLong: req.isLong,
    sizeDeltaUsd: sizeDeltaUsdString(req.sizeUsd),
    collateralToken: USDC_ADDRESS,
    chainId: GMX_API_CHAIN_ID,
  };
}

// ── §4 typed data 결속 검증 + digest 재계산 ──────────────────────────────────

function manifestAddressSet(): Set<string> {
  const s = new Set<string>();
  for (const v of Object.values(GMX_DEPLOYMENT_MANIFEST.addresses)) {
    if (typeof v === 'string' && isAddress(v)) s.add(v.toLowerCase());
  }
  return s;
}

/** message 내 모든 0x40-hex 문자열을 깊이 우선으로 수집 */
function collectAddressLikeStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) out.push(v);
    return;
  }
  if (Array.isArray(v)) { for (const x of v) collectAddressLikeStrings(x, out); return; }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectAddressLikeStrings(x, out);
  }
}

export type BindingCheck = { ok: true; digest: Hex } | { ok: false; reason: string };

/** message 깊이 우선 탐색으로 특정 key의 모든 값 수집 (중첩 struct/배열 포함) */
function collectFieldValues(v: unknown, key: string, out: unknown[]): void {
  if (Array.isArray(v)) { for (const x of v) collectFieldValues(x, key, out); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === key) out.push(x);
      collectFieldValues(x, key, out);
    }
  }
}

/** GMX OrderType enum — MarketIncrease=2, MarketDecrease=4 */
const ORDER_TYPE_ENUM: Record<string, number> = { MarketIncrease: 2, MarketDecrease: 4 };

/**
 * 6G-2 리뷰(Critical) 반영 — typed data message의 의미 필드를 canonical 요청과
 * 구조적으로 대조한다. 주소 allowlist만으로는 "허용된 주소만 쓴 다른 주문"
 * (방향 반전·사이즈 변조·다른 시장)을 걸러내지 못한다.
 * 규칙: 필수 의미 필드(sizeDeltaUsd/isLong/market 계열)는 message에 반드시
 * 존재해야 하며(부재=서명 금지), 등장하는 모든 값이 요청값과 일치해야 한다.
 */
export function verifyOrderSemanticBinding(
  message: unknown,
  req: GmxOrderRequest,
): { ok: true } | { ok: false; reason: string } {
  const expectSize = sizeDeltaUsdString(req.sizeUsd);
  const expectKind = orderKindOf(req);
  const expectOrderTypeNum = ORDER_TYPE_ENUM[expectKind];

  // sizeDeltaUsd — 필수, 전 출현 일치
  const sizes: unknown[] = [];
  collectFieldValues(message, 'sizeDeltaUsd', sizes);
  if (sizes.length === 0) return { ok: false, reason: 'typed data에 sizeDeltaUsd 부재 — 의미 결속 불가, 서명 금지' };
  for (const s of sizes) {
    if (String(s) !== expectSize) {
      return { ok: false, reason: `typed data sizeDeltaUsd(${String(s)}) ≠ 요청(${expectSize}) — 서명 금지` };
    }
  }

  // isLong — 필수, 전 출현 일치
  const longs: unknown[] = [];
  collectFieldValues(message, 'isLong', longs);
  if (longs.length === 0) return { ok: false, reason: 'typed data에 isLong 부재 — 의미 결속 불가, 서명 금지' };
  for (const l of longs) {
    const b = typeof l === 'boolean' ? l : String(l) === 'true';
    if (b !== req.isLong) return { ok: false, reason: 'typed data isLong이 요청 방향과 불일치 — 서명 금지' };
  }

  // market 계열 — 필수(최소 1개 key 존재), 전 출현 일치
  const markets: unknown[] = [];
  for (const key of ['market', 'marketAddress', 'marketToken']) collectFieldValues(message, key, markets);
  if (markets.length === 0) return { ok: false, reason: 'typed data에 market 필드 부재 — 의미 결속 불가, 서명 금지' };
  for (const m of markets) {
    if (typeof m !== 'string' || m.toLowerCase() !== req.marketAddress.toLowerCase()) {
      return { ok: false, reason: 'typed data market이 요청 시장과 불일치 — 서명 금지' };
    }
  }

  // orderType — 존재하면 요청 kind와 정확 일치 (숫자 enum 또는 문자열 표기)
  const orderTypes: unknown[] = [];
  collectFieldValues(message, 'orderType', orderTypes);
  for (const t of orderTypes) {
    const okNum = String(t) === String(expectOrderTypeNum);
    const okStr = typeof t === 'string' && t === expectKind;
    if (!okNum && !okStr) {
      return { ok: false, reason: `typed data orderType(${String(t)})이 요청(${expectKind})과 불일치 — 서명 금지` };
    }
  }

  // collateral token 계열 — 존재하면 USDC만
  const collaterals: unknown[] = [];
  for (const key of ['initialCollateralToken', 'collateralToken']) collectFieldValues(message, key, collaterals);
  for (const c of collaterals) {
    if (typeof c !== 'string' || c.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
      return { ok: false, reason: 'typed data collateral token이 USDC가 아님 — 서명 금지' };
    }
  }

  // OPEN 담보 수량 — 존재하면 요청 변환값과 일치 (CLOSE는 부분 청산 규칙상 미강제)
  if (req.kind === 'OPEN') {
    const deltas: unknown[] = [];
    collectFieldValues(message, 'initialCollateralDeltaAmount', deltas);
    const expectCollateral = collateralAmountString(req.collateralUsd);
    for (const d of deltas) {
      if (String(d) !== expectCollateral) {
        return { ok: false, reason: `typed data 담보 수량(${String(d)}) ≠ 요청(${expectCollateral}) — 서명 금지` };
      }
    }
  }

  // swapPath — 존재하면 빈 배열만 (경유 스왑으로 자금 우회 금지)
  const swapPaths: unknown[] = [];
  collectFieldValues(message, 'swapPath', swapPaths);
  for (const p of swapPaths) {
    if (!Array.isArray(p) || p.length !== 0) {
      return { ok: false, reason: 'typed data swapPath가 비어있지 않음 — 서명 금지' };
    }
  }

  return { ok: true };
}

/**
 * §4 — 서명 직전 typed data 재계산·결속 검증.
 *  - domain chainId=42161, verifyingContract는 감사된 manifest 주소만
 *  - message의 모든 주소는 허용집합(main/subaccount/market/USDC/zero/manifest)만
 *  - digest는 서버가 viem hashTypedData로 독립 재계산 — 이 digest만 서명된다
 */
export function verifyOrderTypedDataBinding(view: PreparedOrderView, req: GmxOrderRequest): BindingCheck {
  const td = view.typedData;
  if (!td?.domain || !td?.types || !td?.message) return { ok: false, reason: 'typedData 구조 누락' };

  const domain = td.domain as Record<string, unknown>;
  if (Number(domain.chainId) !== GMX_API_CHAIN_ID) {
    return { ok: false, reason: `domain chainId ${String(domain.chainId)} ≠ ${GMX_API_CHAIN_ID}` };
  }
  const vc = typeof domain.verifyingContract === 'string' ? domain.verifyingContract : '';
  if (!isAddress(vc)) return { ok: false, reason: 'verifyingContract 형식 오류' };
  const manifest = manifestAddressSet();
  if (!manifest.has(vc.toLowerCase())) {
    return { ok: false, reason: 'verifyingContract가 감사된 manifest 주소가 아님 — 서명 금지' };
  }

  // 허용 주소 집합 — 미지의 주소가 message에 있으면 서명 금지 (출력 우회/스푸핑 방지)
  const allowed = new Set<string>([
    req.mainWallet.toLowerCase(),
    req.subaccountAddress.toLowerCase(),
    req.marketAddress.toLowerCase(),
    USDC_ADDRESS.toLowerCase(),
    ZERO_ADDRESS.toLowerCase(),
    ...manifest,
  ]);
  const found: string[] = [];
  collectAddressLikeStrings(td.message, found);
  for (const a of found) {
    if (!allowed.has(a.toLowerCase())) {
      return { ok: false, reason: 'typed data message에 허용되지 않은 주소 존재 — 서명 금지 (fail-closed)' };
    }
  }

  // 6G-2 리뷰(Critical) — 의미 필드 결속: 방향·사이즈·시장·담보·orderType이
  // canonical 요청과 일치하지 않으면 서명 금지 (주소 allowlist만으로는 불충분)
  const semantic = verifyOrderSemanticBinding(td.message, req);
  if (!semantic.ok) return semantic;

  // primaryType 명시 필수 — 추론 서명 금지 (스키마 모호성으로 인한 digest 변조 방지)
  if (typeof td.primaryType !== 'string' || td.primaryType.length === 0) {
    return { ok: false, reason: 'typedData.primaryType 부재 — 추론 서명 금지 (fail-closed)' };
  }

  // receiver 계열 필드가 존재하면 main wallet이어야 한다 (명시 강제)
  const msg = td.message as Record<string, unknown>;
  for (const key of ['receiver', 'cancellationReceiver']) {
    const val = msg[key];
    if (typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val)
      && val.toLowerCase() !== req.mainWallet.toLowerCase()) {
      return { ok: false, reason: `${key}가 main wallet이 아님 — 서명 금지` };
    }
  }

  const digest = computeOrderTypedDataDigest(view);
  if (!digest.ok) return digest;
  return { ok: true, digest: digest.digest };
}

/** 서버 독립 digest 재계산 — 실패 = 서명 금지 */
export function computeOrderTypedDataDigest(view: PreparedOrderView): BindingCheck {
  try {
    const td = view.typedData;
    const types = { ...(td.types as Record<string, unknown>) };
    delete types.EIP712Domain; // viem은 domain을 별도 인자로 받는다
    const primaryType = td.primaryType
      ?? Object.keys(types).find((t) => !Object.values(types).some((defs) =>
        Array.isArray(defs) && (defs as { type?: string }[]).some((f) => (f.type ?? '').replace('[]', '') === t)));
    if (!primaryType) return { ok: false, reason: 'primaryType 미확정 — digest 재계산 불가' };
    const digest = hashTypedData({
      domain: td.domain as Parameters<typeof hashTypedData>[0]['domain'],
      types: types as Parameters<typeof hashTypedData>[0]['types'],
      primaryType,
      message: td.message as Record<string, unknown>,
    });
    return { ok: true, digest };
  } catch {
    return { ok: false, reason: 'typed data digest 재계산 실패 — 서명 금지 (fail-closed)' };
  }
}

/**
 * §4 — 예상 digest만 서명. 결속 검증 → digest 재계산 → delegated signer.
 * flag 비활성 시 signDigestWithDelegatedSigner가 throw (저장소/복호화 0회 게이트 포함).
 */
export async function signPreparedOrderView(
  view: PreparedOrderView,
  req: GmxOrderRequest,
): Promise<{ ok: true; signature: string } | { ok: false; reason: string }> {
  const binding = verifyOrderTypedDataBinding(view, req);
  if (!binding.ok) return { ok: false, reason: binding.reason };
  try {
    const signature = await signDigestWithDelegatedSigner(binding.digest);
    return { ok: true, signature };
  } catch (e: unknown) {
    // 서명 원문·개인키 정보 없는 게이트 사유만 노출
    return { ok: false, reason: (e as Error).message ?? '서명 실패' };
  }
}

// ── §3 저장된 canonical approval → submit body 동봉 ──────────────────────────

export interface StoredApprovalForSubmit {
  subaccount: string;
  shouldAdd: boolean;
  expiresAt: string;
  maxAllowedCount: string;
  actionType: string;
  nonce: string;
  desChainId: string;
  deadline: string;
  integrationId: string;
  /** 복호화된 owner 서명 — submit body 전송 외 어디에도 노출 금지 */
  signature: string;
}

export type ApprovalFetchResult =
  | { ok: true; approval: StoredApprovalForSubmit; sessionId: string }
  | { ok: false; reason: string };

/**
 * OWNER_SIGNATURE_READY 세션의 approval + 복호화 서명 반환.
 * 게이트: DELEGATED_SIGNER_ENABLED + storage env 게이트 통과 시에만 복호화 (§4).
 * expectedOwner/subaccount/nonce 불일치 = 거부 (세션 무효화는 조회 경로가 담당).
 */
export async function getReadyApprovalForSubmit(params: {
  expectedOwner: Address;
  expectedSubaccount: Address;
  canonicalNonce: bigint | null;
}): Promise<ApprovalFetchResult> {
  if (!isDelegatedSignerEnabled()) return { ok: false, reason: 'DELEGATED_SIGNER_ENABLED!=true — approval 복호화 0회 (fail-closed)' };
  const storage = isSignerStorageAccessAllowed();
  if (!storage.allowed) return { ok: false, reason: `storage 게이트 미충족(${storage.missing.join(', ')}) — approval 복호화 0회` };

  let row: SubaccountApprovalSessionRow | undefined;
  try {
    const rows = await db.select().from(subaccountApprovalSessionsTable)
      .where(and(
        eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.OWNER_SIGNATURE_READY),
      ))
      .orderBy(desc(subaccountApprovalSessionsTable.createdAt)).limit(1);
    row = rows[0];
  } catch {
    return { ok: false, reason: 'approval 세션 조회 실패 — 차단 (fail-closed)' };
  }
  if (!row) return { ok: false, reason: 'OWNER_SIGNATURE_READY approval 세션 없음' };
  if (row.mainAccount !== params.expectedOwner.toLowerCase()) return { ok: false, reason: 'approval main account 불일치' };
  if (row.subaccount !== params.expectedSubaccount.toLowerCase()) return { ok: false, reason: 'approval subaccount 불일치' };
  if (params.canonicalNonce !== null && BigInt(row.approvalNonce) !== params.canonicalNonce) {
    return { ok: false, reason: 'approval nonce가 canonical과 불일치' };
  }
  if (!row.encryptedSignature) return { ok: false, reason: 'approval 서명 미저장' };

  let signature: string;
  try {
    signature = decryptSensitiveHex(row.encryptedSignature);
  } catch {
    return { ok: false, reason: 'approval 서명 복호화 실패 — 차단 (fail-closed)' };
  }
  return {
    ok: true,
    sessionId: row.id,
    approval: {
      subaccount: row.subaccount,
      shouldAdd: row.shouldAdd,
      expiresAt: row.expiresAt,
      maxAllowedCount: row.maxAllowedCount,
      actionType: row.actionType,
      nonce: row.approvalNonce,
      desChainId: row.desChainId,
      deadline: row.deadline,
      integrationId: row.integrationId,
      signature,
    },
  };
}

/** submit body — requestId + 주문 서명 + (OPEN) canonical subaccountApproval 동봉 */
export function buildOrderSubmitBody(
  view: PreparedOrderView,
  signature: string,
  approval: StoredApprovalForSubmit | null,
): Record<string, unknown> {
  return {
    requestId: view.requestId,
    signature,
    ...(approval ? { subaccountApproval: approval } : {}),
  };
}

// ── §6 activation gate 입력 조립 (실제 파생값, DI 가능) ───────────────────────

export interface ActivationSourceDeps {
  env: NodeJS.ProcessEnv;
  liveTestMode: boolean;
  emergencyStopActive: boolean;
  reconciled: boolean;
  canonicalAuthorized: boolean;
  approvalRemainingOk: boolean;      // remainingActions > 0 && not expired
  blockingIntentCount: number | null; // null = 조회 실패 → 차단
  activeRevokeInProgress: boolean;
  freshLiveFeeQuote: boolean;
  gmxConfigOk: boolean;
  deploymentVerified: boolean;
  dbOk: boolean;
  rpcOk: boolean;
  kind: 'OPEN' | 'CLOSE';
}

export function buildActivationInput(d: ActivationSourceDeps): ActivationGateInput {
  return {
    env: d.env,
    liveTestMode: d.liveTestMode,
    signerInitialized: isSignerInitialized(),
    // §6 — canonical verified + approval 미만료·잔여 액션 확인까지 묶어서 결속
    canonicalAuthorized: d.canonicalAuthorized && d.approvalRemainingOk,
    emergencyStopActive: d.emergencyStopActive,
    dbOk: d.dbOk && d.blockingIntentCount !== null,
    rpcOk: d.rpcOk,
    reconciliationComplete: d.reconciled,
    blockingIntentCount: d.blockingIntentCount ?? 1, // 조회 실패 = 차단
    activeRevokeInProgress: d.activeRevokeInProgress,
    freshLiveFeeQuote: d.freshLiveFeeQuote,
    currentChainId: GMX_API_CHAIN_ID,
    gmxConfigOk: d.gmxConfigOk,
    deploymentVerified: d.deploymentVerified,
    kind: d.kind,
  };
}

// ── §5 실행 오케스트레이터 ────────────────────────────────────────────────────

export interface OpenPositionEvidence {
  marketAddress: string;
  isLong: boolean;
  sizeUsd: number;
}

export interface ExecuteViaGmxApiInput {
  transport: GmxApiTransport;
  req: GmxOrderRequest;
  intentId: string | null;
  activation: ActivationGateInput;
  reevaluateActivation: () => Promise<ActivationGateInput>;
  /** CLOSE에서만: 온체인/공식 조회로 확인된 열린 포지션. null = 조회 실패/없음 → 차단 */
  openPosition?: OpenPositionEvidence | null;
  /** canonical approval nonce (재확인용). null = 미확인 → approval 동봉 불가 */
  canonicalNonce: bigint | null;
  nowMs?: number;
}

export type ExecuteViaGmxApiResult = GmxSubmitFlowResult & { preBlocked: boolean };

/**
 * OPEN/CLOSE 공통 GMX API v2 실행 경로 (§5 순서).
 * Production 기본값(플래그 false)에서는 activation gate가 첫 단계에서 차단
 * → prepare/sign/submit·allowance 네트워크 호출 전부 0회.
 */
export async function executeViaGmxApi(input: ExecuteViaGmxApiInput): Promise<ExecuteViaGmxApiResult> {
  const { transport, req } = input;
  const blocked = (reasons: string[]): ExecuteViaGmxApiResult => ({
    submitted: false, prepareCalls: 0, signCalls: 0, submitCalls: 0,
    finalStatus: null, taskRowId: null, gmxRequestId: null,
    blockReasons: reasons, preBlocked: true,
  });

  // 요청 무결성 (주소 형식 — checksum 정규화 실패 = 차단)
  try {
    getAddress(req.mainWallet); getAddress(req.subaccountAddress); getAddress(req.marketAddress);
  } catch {
    return blocked(['주소 형식 오류 — 실행 차단']);
  }
  const mainConfigured = getConfiguredMainAccount();
  if (!mainConfigured || mainConfigured.toLowerCase() !== req.mainWallet.toLowerCase()) {
    return blocked(['main wallet이 GMX_WALLET_ADDRESS와 불일치 — 차단 (fail-closed)']);
  }
  const signerAddr = getSignerAddress();
  if (!signerAddr || signerAddr.toLowerCase() !== req.subaccountAddress.toLowerCase()) {
    return blocked(['subaccount가 delegated signer 주소와 불일치 — 차단 (fail-closed)']);
  }

  // CLOSE — 포지션 증거 필수 (§5): 없거나 초과 청산이면 prepare 0회
  if (req.kind === 'CLOSE') {
    const pos = input.openPosition ?? null;
    if (!pos) return blocked(['열린 포지션 확인 실패/없음 — CLOSE prepare·submit 0회 (fail-closed)']);
    if (pos.marketAddress.toLowerCase() !== req.marketAddress.toLowerCase()) return blocked(['CLOSE market 불일치 — 차단']);
    if (pos.isLong !== req.isLong) return blocked(['CLOSE 방향(isLong) 불일치 — 차단']);
    if (req.sizeUsd > pos.sizeUsd + 1e-9) return blocked([`CLOSE size $${req.sizeUsd} > 열린 포지션 $${pos.sizeUsd} — 초과 청산 금지`]);
  }

  // §7 allowance/잔액 게이트 (readonly) — gate 통과가 먼저다: 플래그 꺼져 있으면
  // transport.readonlyEnabled=false로 조회 자체가 차단되고 흐름도 gate에서 죽는다.
  // OPEN만 담보 이동이 있으므로 OPEN에서 필수.
  let approval: StoredApprovalForSubmit | null = null;
  {
    // gate 사전 평가 — 미충족이면 allowance 조회·approval 복호화 0회
    const preGate = evaluateActivationGate(input.activation);
    if (!preGate.networkEligible) {
      return { ...(await runGmxApiSubmitFlow(makeFlowInput(input, null))), preBlocked: false };
    }

    if (req.kind === 'OPEN') {
      const checkGate = await loadCheckUsdcCollateralGate();
      const gateRes = await checkGate(transport, {
        account: req.mainWallet,
        requiredUsdc: usdToUsdcWei(req.collateralUsd),
      });
      if (!gateRes.ok) return blocked([`allowance/잔액 조회 실패: ${gateRes.reason} — 제출 차단 (fail-closed)`]);
      if (!gateRes.sufficient) return blocked(['USDC 잔액/router allowance 부족 — 제출 차단 (MetaMask 1회 승인 필요)']);
    }

    // canonical approval 동봉 (OPEN·CLOSE 공통 — express subaccount 흐름 필수)
    const ap = await getReadyApprovalForSubmit({
      expectedOwner: req.mainWallet as Address,
      expectedSubaccount: req.subaccountAddress as Address,
      canonicalNonce: input.canonicalNonce,
    });
    if (!ap.ok) return blocked([`canonical approval 확보 실패: ${ap.reason} — 제출 차단`]);
    approval = ap.approval;
  }

  const flowResult = await runGmxApiSubmitFlow(makeFlowInput(input, approval));
  return { ...flowResult, preBlocked: false };
}

/** prepare 요청 body의 결정적 hash — durable task 생성 시 payload hash (6G-3 §3) */
export function hashPrepareRequestBody(body: Record<string, unknown>): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
      return out;
    }
    return typeof v === 'bigint' ? v.toString() : v;
  };
  return keccak256(toHex(JSON.stringify(sortDeep(body))));
}

function makeFlowInput(input: ExecuteViaGmxApiInput, approval: StoredApprovalForSubmit | null) {
  const { transport, req } = input;
  return {
    transport,
    activation: input.activation,
    kind: req.kind,
    intentId: input.intentId,
    approvalSessionId: null,
    // 6G-3 §3 — 외부 prepare 호출 전에 결정되는 flow idempotency key.
    // intent 1건당 relay task 1건 (intent id 자체가 결정적 idempotent id).
    flowIdempotencyKey: `gmxapi:flow:${input.intentId ?? randomUUID()}`,
    requestPayloadHash: hashPrepareRequestBody(buildOrderPrepareBody(req)),
    extractEvidence: (view: PreparedOrderView) => {
      const digest = computeOrderTypedDataDigest(view);
      return {
        primaryType: view.typedData?.primaryType ?? null,
        typedDataDigest: digest.ok ? digest.digest : null,
      };
    },
    prepareOrder: (): Promise<GmxApiResult<unknown>> =>
      transport.postJson('/orders/txns/prepare', buildOrderPrepareBody(req), 'readonly'),
    toView: (raw: unknown) => toPreparedOrderView(raw, {
      from: req.mainWallet,
      subaccountAddress: req.subaccountAddress,
      orderKind: orderKindOf(req),
      isLong: req.isLong,
      sizeDeltaUsd: sizeDeltaUsdString(req.sizeUsd),
      collateralToken: USDC_ADDRESS,
      receiver: req.mainWallet,
    }),
    expected: buildExpectedValidation(req),
    verifyTypedDataBinding: async (view: PreparedOrderView) => {
      const b = verifyOrderTypedDataBinding(view, req);
      return b.ok ? { ok: true } : { ok: false, reason: b.reason };
    },
    signTypedData: (view: PreparedOrderView) => signPreparedOrderView(view, req),
    reevaluateActivation: input.reevaluateActivation,
    buildSubmitBody: (view: PreparedOrderView, signature: string) =>
      buildOrderSubmitBody(view, signature, approval),
    nowMs: input.nowMs ?? Date.now(),
  };
}
