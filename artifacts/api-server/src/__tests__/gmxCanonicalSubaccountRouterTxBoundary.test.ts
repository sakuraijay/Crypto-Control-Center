import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT } from '../lib/gmxCanonicalSubaccountRouterAudit';
import {
  buildAddSubaccountTx,
  buildRemoveSubaccountTx,
  buildUsdcApproveTx,
} from '../lib/gmxSubaccount';
import { USDC_ADDRESS } from '../lib/gmxContracts';

const SIGNER = '0x2222222222222222222222222222222222222222';

beforeEach(() => {
  vi.stubEnv('GMX_CHAIN_ID', '42161');
  vi.stubEnv(
    'GMX_SUBACCOUNT_ROUTER_ADDRESS',
    GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('canonical SubaccountRouter authorization transaction boundary', () => {
  it('builds add/remove transactions only to the audited canonical Arbitrum router', () => {
    const add = buildAddSubaccountTx(SIGNER, 10, 24);
    const remove = buildRemoveSubaccountTx(SIGNER);

    expect(add.to.toLowerCase())
      .toBe(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address.toLowerCase());
    expect(remove.to.toLowerCase())
      .toBe(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address.toLowerCase());
    expect(add.value).toBe('0x0');
    expect(remove.value).toBe('0x0');
  });

  it('builds USDC approval only after canonical router validation', () => {
    const approve = buildUsdcApproveTx();
    expect(approve.to.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(approve.value).toBe('0x0');
  });

  it('fails closed for a different but syntactically valid router address', () => {
    vi.stubEnv('GMX_SUBACCOUNT_ROUTER_ADDRESS', '0x1111111111111111111111111111111111111111');

    expect(() => buildAddSubaccountTx(SIGNER)).toThrow(/canonical SubaccountRouter/);
    expect(() => buildRemoveSubaccountTx(SIGNER)).toThrow(/canonical SubaccountRouter/);
    expect(() => buildUsdcApproveTx()).toThrow(/canonical SubaccountRouter/);
  });

  it('fails closed when the router configuration is absent', () => {
    vi.stubEnv('GMX_SUBACCOUNT_ROUTER_ADDRESS', '');

    expect(() => buildAddSubaccountTx(SIGNER)).toThrow(/canonical SubaccountRouter/);
  });

  it('fails closed if an explicit chain id is not Arbitrum One', () => {
    vi.stubEnv('GMX_CHAIN_ID', '43114');

    expect(() => buildAddSubaccountTx(SIGNER)).toThrow(/canonical SubaccountRouter/);
  });
});
