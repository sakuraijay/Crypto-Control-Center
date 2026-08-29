/**
 * Canonical GMX SubaccountRouter manifest contract.
 * 네트워크/RPC/DB/서명/주문 호출 없이 공식 Arbitrum 주소 대조만 검증한다.
 */
import { describe, expect, it } from 'vitest';
import {
  GMX_CANONICAL_SUBACCOUNT_ROUTER_ADDRESS,
  GMX_DEPLOYMENT_MANIFEST,
  validateCanonicalSubaccountRouterEnv,
} from '../lib/gmxDeploymentManifest';

const OFFICIAL = '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db';

describe('canonical SubaccountRouter manifest validation', () => {
  it('manifest v3와 전용 pin이 공식 Arbitrum SubaccountRouter를 고정한다', () => {
    expect(GMX_DEPLOYMENT_MANIFEST.manifestVersion).toBe(3);
    expect(GMX_DEPLOYMENT_MANIFEST.chainId).toBe(42161);
    expect(GMX_CANONICAL_SUBACCOUNT_ROUTER_ADDRESS).toBe(OFFICIAL);
  });

  it('공식 주소는 통과하고 대소문자는 무시한다', () => {
    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: OFFICIAL,
      GMX_CHAIN_ID: '42161',
    } as NodeJS.ProcessEnv)).toEqual({ ok: true, mismatches: [] });

    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: OFFICIAL.toLowerCase(),
    } as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it('누락·형식 오류·다른 42-byte 주소를 모두 fail-closed한다', () => {
    const missing = validateCanonicalSubaccountRouterEnv({} as NodeJS.ProcessEnv);
    expect(missing.ok).toBe(false);
    expect(missing.mismatches.join(' ')).toContain('GMX_SUBACCOUNT_ROUTER_ADDRESS');

    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: 'nope',
    } as NodeJS.ProcessEnv).ok).toBe(false);

    const wrong = validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: '0x1111111111111111111111111111111111111111',
    } as NodeJS.ProcessEnv);
    expect(wrong.ok).toBe(false);
    expect(wrong.mismatches.join(' ')).toContain('manifest v3');
  });

  it('Arbitrum 외 GMX_CHAIN_ID도 fail-closed한다', () => {
    const result = validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: OFFICIAL,
      GMX_CHAIN_ID: '43114',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toContain('GMX_CHAIN_ID');
  });

  it('canonical SubaccountRouter와 Gelato relay router를 혼용하지 않는다', () => {
    const relayRouter = GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter;
    expect(relayRouter.toLowerCase()).not.toBe(OFFICIAL.toLowerCase());
    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: relayRouter,
    } as NodeJS.ProcessEnv).ok).toBe(false);
  });
});
