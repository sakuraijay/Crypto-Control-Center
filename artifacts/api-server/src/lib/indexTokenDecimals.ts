/**
 * indexTokenDecimals — 6H-2C §3 stop 가격 변환용 index token decimals 권위 소스.
 *
 * 결속 순서 (지시서 §3):
 *  1. marketAddress → 공식 SDK MARKETS[42161] registry에서 indexTokenAddress 확정
 *  2. chainId=42161 강제
 *  3. indexToken이 공식 SDK TOKENS metadata에 존재하는지 확인 (decimals 포함)
 *  4. 허용 read-only RPC로 ERC-20 decimals() 조회 (의존성 주입 — 테스트 실 RPC 0회)
 *  5. SDK metadata와 온체인 decimals()가 모두 존재 → 불일치 시 차단
 *
 * 금지: 하드코딩·심볼 기반 추측·브라우저 전달값. 실패/불일치 = 제출 0회 (fail-closed).
 * 캐시: key=`${chainId}:${indexToken소문자}`; 검증 시각 기록; 실행은 VERIFIED_MAX_AGE_MS
 * 이내 검증본만 허용 (stale = 재검증 필요, 표시용으로만 구분 표기).
 */
import { getAddress } from 'viem';
import { createRequire } from 'node:module';

// SDK configs는 CJS require로 로드 — ESM build는 확장자 없는 내부 import 때문에
// vitest/node ESM resolver에서 로드 실패한다 (6G-1 SDK subpath 함정과 동일 계열).
const _require = createRequire(import.meta.url ?? __filename);
const { MARKETS } = _require('@gmx-io/sdk/configs/markets') as typeof import('@gmx-io/sdk/configs/markets');
const { TOKENS } = _require('@gmx-io/sdk/configs/tokens') as typeof import('@gmx-io/sdk/configs/tokens');

export const ARBITRUM_CHAIN_ID = 42161;
/** 검증본 유효 기간 — decimals는 불변이지만 registry 변경 감지를 위해 재검증 강제 */
export const DECIMALS_VERIFIED_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

export interface DecimalsEvidence {
  chainId: number;
  marketAddress: string;
  indexTokenAddress: string;
  decimals: number;
  /** 'sdk+onchain' 만 실행 허용 — 단일 출처는 실행 금지 */
  source: 'sdk+onchain';
  sdkDecimals: number;
  onchainDecimals: number;
  verifiedAtMs: number;
}

export type DecimalsResult =
  | { ok: true; evidence: DecimalsEvidence; fromCache: boolean }
  | { ok: false; reason: string };

/** 온체인 ERC-20 decimals() 조회 함수 — 프로덕션은 viem readContract, 테스트는 mock */
export type OnchainDecimalsFetcher = (tokenAddress: string) => Promise<number | null>;

const _cache = new Map<string, DecimalsEvidence>();

export function __clearDecimalsCacheForTests(): void { _cache.clear(); }

export function isDecimalsEvidenceFresh(e: DecimalsEvidence, nowMs: number): boolean {
  return nowMs - e.verifiedAtMs <= DECIMALS_VERIFIED_MAX_AGE_MS;
}

/** SDK registry에서 market → indexToken 결속 (조회 전용, 외부 호출 없음) */
export function lookupSdkIndexToken(
  chainId: number,
  marketAddress: string,
): { ok: true; indexTokenAddress: string; sdkDecimals: number } | { ok: false; reason: string } {
  if (chainId !== ARBITRUM_CHAIN_ID) return { ok: false, reason: `chainId ${chainId} ≠ 42161 — 차단` };
  let checksummed: string;
  try { checksummed = getAddress(marketAddress); } catch { return { ok: false, reason: 'market 주소 형식 오류 — 차단' }; }
  const markets = (MARKETS as Record<number, Record<string, { indexTokenAddress: string }>>)[chainId] ?? {};
  const entry = markets[checksummed]
    ?? Object.entries(markets).find(([k]) => k.toLowerCase() === checksummed.toLowerCase())?.[1];
  if (!entry) return { ok: false, reason: 'SDK market registry에 없는 market — 차단 (추측 금지)' };
  const idx = entry.indexTokenAddress;
  const tokens = (TOKENS as Record<number, Array<{ address: string; decimals: number; synthetic?: boolean }>>)[chainId] ?? [];
  const tok = tokens.find((t) => t.address.toLowerCase() === idx.toLowerCase());
  if (!tok) return { ok: false, reason: 'SDK token metadata에 없는 index token — 차단' };
  if (!Number.isInteger(tok.decimals) || tok.decimals < 0 || tok.decimals > 30) {
    return { ok: false, reason: 'SDK decimals 범위 밖 — 차단' };
  }
  return { ok: true, indexTokenAddress: idx, sdkDecimals: tok.decimals };
}

/**
 * 권위 decimals 확보 — SDK metadata + 온체인 decimals() 교차검증.
 * 어느 한쪽 실패/불일치 = fail-closed. 캐시는 검증본만, 신선하지 않으면 재검증.
 */
export async function resolveIndexTokenDecimals(args: {
  chainId: number;
  marketAddress: string;
  fetchOnchainDecimals: OnchainDecimalsFetcher;
  nowMs?: number;
}): Promise<DecimalsResult> {
  const nowMs = args.nowMs ?? Date.now();
  const sdk = lookupSdkIndexToken(args.chainId, args.marketAddress);
  if (!sdk.ok) return { ok: false, reason: sdk.reason };

  const cacheKey = `${args.chainId}:${sdk.indexTokenAddress.toLowerCase()}`;
  const cached = _cache.get(cacheKey);
  if (cached && isDecimalsEvidenceFresh(cached, nowMs)) {
    if (cached.sdkDecimals !== sdk.sdkDecimals) {
      _cache.delete(cacheKey); // registry 변경 감지 — 캐시 폐기 후 재검증
    } else {
      return { ok: true, evidence: cached, fromCache: true };
    }
  }

  let onchain: number | null;
  try { onchain = await args.fetchOnchainDecimals(sdk.indexTokenAddress); }
  catch { onchain = null; }
  if (onchain === null) return { ok: false, reason: '온체인 decimals() 조회 실패 — 제출 0회 (fail-closed)' };
  if (!Number.isInteger(onchain) || onchain < 0 || onchain > 30) {
    return { ok: false, reason: `온체인 decimals ${onchain} 범위 밖/비정수 — 차단` };
  }
  if (onchain !== sdk.sdkDecimals) {
    return { ok: false, reason: `decimals 불일치 — SDK ${sdk.sdkDecimals} ≠ 온체인 ${onchain} — 차단` };
  }

  const evidence: DecimalsEvidence = {
    chainId: args.chainId,
    marketAddress: args.marketAddress,
    indexTokenAddress: sdk.indexTokenAddress,
    decimals: onchain,
    source: 'sdk+onchain',
    sdkDecimals: sdk.sdkDecimals,
    onchainDecimals: onchain,
    verifiedAtMs: nowMs,
  };
  _cache.set(cacheKey, evidence);
  return { ok: true, evidence, fromCache: false };
}

/** 상태 API 표시용 스냅샷 (외부 호출 없음 — 저장 캐시만) */
export function getDecimalsCacheSnapshot(nowMs: number): Array<{
  key: string; decimals: number; source: string; tokenAddress: string;
  verifiedAtMs: number; ageMs: number; stale: boolean;
}> {
  return [..._cache.entries()].map(([key, e]) => ({
    key, decimals: e.decimals, source: e.source, tokenAddress: e.indexTokenAddress,
    verifiedAtMs: e.verifiedAtMs, ageMs: nowMs - e.verifiedAtMs,
    stale: !isDecimalsEvidenceFresh(e, nowMs),
  }));
}
