/**
 * gmxApiMarkets — 공식 GMX API v2 시장 매핑·잔액·allowance 게이트 (6G-1 §8).
 *
 * GmxApiSdk(@gmx-io/sdk 1.7.0)에 hardened readonly 어댑터를 주입해 사용한다:
 *  - fetchMarkets/fetchMarketsInfo: marketToken 주소 ↔ 심볼 매핑 검증
 *  - USDC 주소가 canonical 상수(0xaf88…5831)와 일치하는지 대조 (불일치=차단)
 *  - fetchWalletBalances + fetchAllowances({spender:'router'}):
 *    allowance 부족 = 제출 차단 + UI 안내만 (서버가 approve 트랜잭션을 만들거나
 *    서명하지 않는다 — MetaMask 운영자 수동 처리)
 *
 * 전부 readonly. 실패 시 fail-closed (allowance 불명 = 차단).
 */

import { GmxApiSdk } from '@gmx-io/sdk/v2';
import { createSdkApiAdapter, GMX_API_CHAIN_ID, type GmxApiTransport } from './gmxApiTransport';

/** Arbitrum One canonical USDC — WalletContext/gmxContracts와 동일 상수 */
export const GMX_API_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

export interface GmxApiMarketEntry {
  marketToken: string;
  indexToken: string;
  longToken: string;
  shortToken: string;
  name: string;
}

export type MarketMapResult =
  | { ok: true; markets: GmxApiMarketEntry[]; byMarketToken: Map<string, GmxApiMarketEntry> }
  | { ok: false; reason: string };

export type CollateralGateResult =
  | { ok: true; usdcBalance: bigint; usdcAllowance: bigint; sufficient: boolean; uiHint: string | null }
  | { ok: false; reason: string };

function makeSdk(transport: GmxApiTransport): GmxApiSdk {
  const api = createSdkApiAdapter(transport);
  return new GmxApiSdk({ chainId: GMX_API_CHAIN_ID, api: api as ConstructorParameters<typeof GmxApiSdk>[0]['api'] });
}

/** 시장 매핑 조회 — SDK fetchMarkets 경유 (readonly) */
export async function fetchGmxApiMarketMap(transport: GmxApiTransport): Promise<MarketMapResult> {
  if (!transport.readonlyEnabled) return { ok: false, reason: "GMX_API_READONLY_ENABLED !== 'true' — 시장 매핑 조회 불가 (fail-closed)" };
  let raw: unknown[];
  try {
    raw = await makeSdk(transport).fetchMarkets();
  } catch {
    return { ok: false, reason: 'GMX API 시장 조회 실패 — 매핑 불가 (fail-closed)' };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'GMX API 시장 응답 비어있음 (fail-closed)' };
  const markets: GmxApiMarketEntry[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const marketToken = String(m.marketToken ?? m.marketTokenAddress ?? '');
    const indexToken = String(m.indexToken ?? m.indexTokenAddress ?? '');
    const longToken = String(m.longToken ?? m.longTokenAddress ?? '');
    const shortToken = String(m.shortToken ?? m.shortTokenAddress ?? '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(marketToken)) continue;
    markets.push({ marketToken, indexToken, longToken, shortToken, name: String(m.name ?? '') });
  }
  if (markets.length === 0) return { ok: false, reason: 'GMX API 시장 응답에 유효 항목 없음 (fail-closed)' };
  return { ok: true, markets, byMarketToken: new Map(markets.map((m) => [m.marketToken.toLowerCase(), m])) };
}

/**
 * USDC 잔액 + router allowance 게이트 (readonly).
 * - USDC 주소가 canonical 상수와 다르면 즉시 차단 (주소 스푸핑 방지)
 * - allowance < 필요액 → sufficient=false + uiHint (서버는 approve를 만들지 않음)
 * - 조회 실패/USDC 미발견 → fail-closed
 */
export async function checkUsdcCollateralGate(
  transport: GmxApiTransport,
  params: { account: string; requiredUsdc: bigint },
): Promise<CollateralGateResult> {
  if (!transport.readonlyEnabled) return { ok: false, reason: "GMX_API_READONLY_ENABLED !== 'true' — allowance 게이트 조회 불가 (fail-closed)" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.account)) return { ok: false, reason: 'account 주소 형식 오류' };
  if (params.requiredUsdc < 0n) return { ok: false, reason: 'requiredUsdc 음수' };

  const sdk = makeSdk(transport);
  let balances: { address: string; balance: bigint; symbol: string }[];
  let allowances: { address: string; allowance: bigint; symbol: string }[];
  try {
    [balances, allowances] = await Promise.all([
      sdk.fetchWalletBalances({ address: params.account }),
      sdk.fetchAllowances({ address: params.account, spender: 'router' }),
    ]);
  } catch {
    return { ok: false, reason: 'GMX API 잔액/allowance 조회 실패 (fail-closed — 제출 차단)' };
  }

  const canon = GMX_API_USDC_ADDRESS.toLowerCase();
  const usdcBal = balances.find((b) => (b.address ?? '').toLowerCase() === canon);
  const usdcAlw = allowances.find((a) => (a.address ?? '').toLowerCase() === canon);
  // symbol 'USDC'인데 주소가 canonical과 다른 항목이 있으면 스푸핑 의심 — 차단
  const impostor = [...balances, ...allowances].find(
    (t) => String(t.symbol).toUpperCase() === 'USDC' && (t as { address?: string }).address?.toLowerCase() !== canon,
  );
  if (impostor) return { ok: false, reason: 'USDC 주소가 canonical(0xaf88…5831)과 불일치 — 차단 (fail-closed)' };
  if (!usdcBal || !usdcAlw) return { ok: false, reason: 'GMX API 응답에 canonical USDC 항목 없음 (fail-closed — 제출 차단)' };

  const sufficient = usdcAlw.allowance >= params.requiredUsdc && usdcBal.balance >= params.requiredUsdc;
  return {
    ok: true,
    usdcBalance: usdcBal.balance,
    usdcAllowance: usdcAlw.allowance,
    sufficient,
    uiHint: sufficient ? null
      : usdcAlw.allowance < params.requiredUsdc
        ? 'USDC router allowance 부족 — MetaMask에서 운영자가 직접 approve해야 합니다 (서버는 approve를 생성/서명하지 않음)'
        : 'USDC 잔액 부족 — 입금 후 재시도하십시오',
  };
}
