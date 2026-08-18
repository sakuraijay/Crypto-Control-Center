/**
 * canaryAllowance — Controlled Canary USDC allowance 카드 순수 헬퍼 (#124-B).
 *
 * 원칙 (fail-closed):
 *  - 서버 verified=true(pinned SDK/manifest 교차검증 통과) 아니면 어떤 트랜잭션도 구성하지 않는다.
 *  - 승인 금액은 정확히 15 USDC(15_000_000 units)만 — unlimited/max approval 절대 금지.
 *  - MetaMask 계정=main wallet 정확 일치 + Arbitrum One(42161)일 때만 approve 허용.
 *  - receipt success + allowance readback ≥ 15 USDC 후에만 완료.
 *  - 실패/취소/receipt 불명확 = fail-closed, 자동 retry 0회 (운영자 수동 조작만).
 */

/** 정확히 15 USDC (6 decimals) — 이 외의 금액은 어떤 경로로도 구성 불가 */
export const CANARY_APPROVE_AMOUNT_UNITS = 15_000_000n;
export const ARBITRUM_ONE_CHAIN_ID = 42161;
/** ERC-20 approve(address,uint256) 함수 선택자 */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
/** unlimited approval (uint256 max) — 절대 생성 금지 검증용 */
export const UINT256_MAX = (1n << 256n) - 1n;

export interface CanaryAllowanceServerInfo {
  ok: boolean;
  verified: boolean;
  reasons: string[];
  chainId: number;
  usdcAddress: string;
  spenderAddress: string | null;
  amountUnits: string;
  mainAddress: string | null;
  allowanceUnits: string | null;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** allowance units 문자열 → 표시 문자열 (예: '15000000' → '15.00 USDC'), null=조회 실패 */
export function formatAllowanceUnits(units: string | null): string {
  if (units === null) return '조회 실패';
  let v: bigint;
  try { v = BigInt(units); } catch { return '조회 실패'; }
  if (v < 0n) return '조회 실패';
  const whole = v / 1_000_000n;
  const frac = ((v % 1_000_000n) / 10_000n).toString().padStart(2, '0');
  return `${whole}.${frac} USDC`;
}

export type ApproveGateResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * approve 트랜잭션 허용 게이트 — 전부 충족해야만 ok.
 * 서버 verified·chainId 42161·token/spender/amount 정확 일치·지갑=main wallet 일치.
 */
export function canAttemptCanaryApprove(input: {
  server: CanaryAllowanceServerInfo | null;
  walletStatus: string;
  walletAddress: string | null;
  walletChainId: number | null;
  isArbitrum: boolean;
  busy: boolean;
}): ApproveGateResult {
  const reasons: string[] = [];
  const s = input.server;
  if (!s || !s.ok) {
    return { ok: false, reasons: ['서버 canary allowance 파라미터를 확인할 수 없습니다 (fail-closed)'] };
  }
  if (!s.verified) reasons.push(...(s.reasons.length ? s.reasons : ['서버 교차검증(verified) 미통과 — approve 차단']));
  if (s.chainId !== ARBITRUM_ONE_CHAIN_ID) reasons.push(`서버 chainId ${s.chainId} ≠ 42161`);
  if (!ADDR_RE.test(s.usdcAddress)) reasons.push('USDC 주소 형식 오류');
  if (!s.spenderAddress || !ADDR_RE.test(s.spenderAddress)) reasons.push('spender 주소 미검증/형식 오류');
  if (s.amountUnits !== CANARY_APPROVE_AMOUNT_UNITS.toString()) reasons.push(`승인 금액이 15 USDC가 아님 (${s.amountUnits}) — 차단`);
  if (!s.mainAddress || !ADDR_RE.test(s.mainAddress)) reasons.push('main wallet 미설정');
  if (input.walletStatus !== 'connected') reasons.push('지갑이 연결되지 않았습니다');
  if (!input.isArbitrum || input.walletChainId !== ARBITRUM_ONE_CHAIN_ID) reasons.push('Arbitrum One(42161) 네트워크가 아닙니다');
  if (!input.walletAddress || !s.mainAddress || input.walletAddress.toLowerCase() !== s.mainAddress.toLowerCase()) {
    reasons.push('MetaMask 계정이 main wallet과 일치하지 않습니다');
  }
  if (input.busy) reasons.push('이미 진행 중 — 중복 클릭 차단');
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * ERC-20 approve(spender, 15 USDC) calldata 빌드 — 금액은 상수 고정, 인자로 받지 않는다.
 * spender 형식 오류 시 null (fail-closed).
 */
export function buildCanaryApproveCalldata(spender: string): string | null {
  if (!ADDR_RE.test(spender)) return null;
  const spenderPadded = spender.slice(2).toLowerCase().padStart(64, '0');
  const amountPadded = CANARY_APPROVE_AMOUNT_UNITS.toString(16).padStart(64, '0');
  return `${ERC20_APPROVE_SELECTOR}${spenderPadded}${amountPadded}`;
}

/** 빌드된 calldata가 unlimited/오금액이 아님을 최종 확인 (제출 직전 방어) */
export function isExactCanaryApproveCalldata(data: string, spender: string): boolean {
  const expected = buildCanaryApproveCalldata(spender);
  return expected !== null && data.toLowerCase() === expected.toLowerCase();
}

export type CompletionVerdict = 'complete' | 'not_complete';

/**
 * 완료 판정 — receipt.status가 success('0x1')이고 allowance readback ≥ 15 USDC일 때만 complete.
 * receipt 불명확(null/기타 값)·readback 실패(null)·부족은 전부 not_complete (fail-closed).
 */
export function evaluateApproveCompletion(input: {
  receiptStatus: string | null;
  allowanceReadbackUnits: string | null;
}): CompletionVerdict {
  if (input.receiptStatus !== '0x1') return 'not_complete';
  if (input.allowanceReadbackUnits === null) return 'not_complete';
  let v: bigint;
  try { v = BigInt(input.allowanceReadbackUnits); } catch { return 'not_complete'; }
  return v >= CANARY_APPROVE_AMOUNT_UNITS ? 'complete' : 'not_complete';
}

// ── Canary 예상 signer (#124-C — Prepare 게이트) ─────────────────────────────

/** 운영자 승인 canary delegated signer 공개주소 — 서버 반환값과 정확 일치해야 Prepare 허용 */
export const EXPECTED_CANARY_SIGNER = '0xc56436F09039E15Aa2244659d0fC5b7f706DdbF6';

export function isExpectedCanarySigner(serverSigner: string | null | undefined): boolean {
  return typeof serverSigner === 'string' && serverSigner.toLowerCase() === EXPECTED_CANARY_SIGNER.toLowerCase();
}
