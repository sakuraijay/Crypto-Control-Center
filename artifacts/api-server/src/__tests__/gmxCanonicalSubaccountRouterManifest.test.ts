/**
 * Canonical GMX SubaccountRouter audit contract.
 * No network/RPC/DB/signing/order calls are performed.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import {
  GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT,
  validateCanonicalSubaccountRouterEnv,
} from '../lib/gmxCanonicalSubaccountRouterAudit';

const OFFICIAL = '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db';

describe('canonical SubaccountRouter audit validation', () => {
  it('keeps the legacy relay manifest v2 untouched and pins canonical router separately', () => {
    expect(GMX_DEPLOYMENT_MANIFEST.manifestVersion).toBe(2);
    expect(GMX_DEPLOYMENT_MANIFEST.chainId).toBe(42161);
    expect(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.auditVersion).toBe(1);
    expect(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.chainId).toBe(42161);
    expect(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address).toBe(OFFICIAL);
  });

  it('binds both distinct Arbitrum routers to the installed SDK registry', () => {
    const require = createRequire(import.meta.url);
    const contracts = require('@gmx-io/sdk/configs/contracts') as {
      getContract(chainId: number, name: string): string;
    };
    expect(contracts.getContract(42161, 'SubaccountRouter')).toBe(OFFICIAL);
    expect(contracts.getContract(42161, 'SubaccountGelatoRelayRouter'))
      .toBe(GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter);
    expect(contracts.getContract(42161, 'SubaccountRouter').toLowerCase())
      .not.toBe(contracts.getContract(42161, 'SubaccountGelatoRelayRouter').toLowerCase());
  });

  it('accepts the official address and ignores address case', () => {
    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: OFFICIAL,
      GMX_CHAIN_ID: '42161',
    } as NodeJS.ProcessEnv)).toEqual({ ok: true, mismatches: [] });

    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: OFFICIAL.toLowerCase(),
    } as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it('fails closed for missing, malformed, or different addresses', () => {
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
    expect(wrong.mismatches.join(' ')).toContain('canonical Arbitrum audit v1');
  });

  it('fails closed for a non-Arbitrum configured chain', () => {
    const result = validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: OFFICIAL,
      GMX_CHAIN_ID: '43114',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toContain('GMX_CHAIN_ID');
  });

  it('does not confuse canonical SubaccountRouter with the Gelato relay router', () => {
    const relayRouter = GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter;
    expect(relayRouter.toLowerCase()).not.toBe(OFFICIAL.toLowerCase());
    expect(validateCanonicalSubaccountRouterEnv({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: relayRouter,
    } as NodeJS.ProcessEnv).ok).toBe(false);
  });
});
