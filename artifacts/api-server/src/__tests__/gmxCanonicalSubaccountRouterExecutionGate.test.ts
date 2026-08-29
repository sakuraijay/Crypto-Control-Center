import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT } from '../lib/gmxCanonicalSubaccountRouterAudit';
import { getSubaccountRouterAddress } from '../lib/gmxContracts';

const ORIGINAL_ROUTER = process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS;
const ORIGINAL_CHAIN = process.env.GMX_CHAIN_ID;

beforeEach(() => {
  process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS = GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address;
  process.env.GMX_CHAIN_ID = '42161';
});

afterEach(() => {
  if (ORIGINAL_ROUTER === undefined) delete process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS;
  else process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS = ORIGINAL_ROUTER;
  if (ORIGINAL_CHAIN === undefined) delete process.env.GMX_CHAIN_ID;
  else process.env.GMX_CHAIN_ID = ORIGINAL_CHAIN;
});

describe('canonical SubaccountRouter execution gate', () => {
  it('returns the separately audited canonical Arbitrum router', () => {
    expect(getSubaccountRouterAddress().toLowerCase())
      .toBe(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address.toLowerCase());
  });

  it('fails closed for a different but syntactically valid address', () => {
    process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS = '0x1111111111111111111111111111111111111111';
    expect(() => getSubaccountRouterAddress()).toThrow(/canonical SubaccountRouter validation failed/);
  });

  it('fails closed when the router setting is absent', () => {
    delete process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS;
    expect(() => getSubaccountRouterAddress()).toThrow(/canonical SubaccountRouter validation failed/);
  });

  it('fails closed when an explicit configured chain is not Arbitrum One', () => {
    process.env.GMX_CHAIN_ID = '43114';
    expect(() => getSubaccountRouterAddress()).toThrow(/canonical SubaccountRouter validation failed/);
  });
});
