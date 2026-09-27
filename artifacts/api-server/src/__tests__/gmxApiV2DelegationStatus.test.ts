import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setApiV2DelegationClientFactoryForTests,
  checkDelegationStatus,
} from '../lib/gmxSubaccount';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import type { DataStoreClient } from '../lib/gmxDataStore';

const MAIN = '0x1111111111111111111111111111111111111111';
const SIGNER = '0x2222222222222222222222222222222222222222';
const FUTURE = 2_000_000_000n;

function setApiV2Env(): void {
  vi.stubEnv('GMX_CHAIN_ID', '42161');
  vi.stubEnv(
    'GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS',
    GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter,
  );
  vi.stubEnv('GMX_DATA_STORE_ADDRESS', GMX_DEPLOYMENT_MANIFEST.addresses.dataStore);
  vi.stubEnv('GMX_EVENT_EMITTER_ADDRESS', GMX_DEPLOYMENT_MANIFEST.addresses.eventEmitter);
  vi.stubEnv('GMX_SUBACCOUNT_ROUTER_ADDRESS', '');
}

function canonicalClient(overrides: {
  listed?: boolean;
  featureDisabled?: boolean;
  integrationDisabled?: boolean;
  expiresAt?: bigint;
  maxAllowed?: bigint;
  used?: bigint;
  blockTimestamp?: bigint;
} = {}): DataStoreClient {
  let uintCall = 0;
  let boolCall = 0;
  return {
    readContract: vi.fn(async ({ functionName }) => {
      if (functionName === 'containsAddress') return overrides.listed ?? true;
      if (functionName === 'getUint') {
        return [
          overrides.expiresAt ?? FUTURE,
          overrides.maxAllowed ?? 8n,
          overrides.used ?? 1n,
        ][uintCall++] ?? 0n;
      }
      if (functionName === 'getBytes32') return `0x${'11'.repeat(32)}`;
      if (functionName === 'subaccountApprovalNonces') return 7n;
      if (functionName === 'getBool') {
        return [
          overrides.featureDisabled ?? false,
          overrides.integrationDisabled ?? false,
        ][boolCall++] ?? false;
      }
      throw new Error(`unexpected function ${functionName}`);
    }),
    getBlockTimestamp: vi.fn(async () => overrides.blockTimestamp ?? 1_900_000_000n),
  };
}

beforeEach(() => {
  setApiV2Env();
});

afterEach(() => {
  __setApiV2DelegationClientFactoryForTests(null);
  vi.unstubAllEnvs();
});

describe('GMX API v2 canonical delegation status', () => {
  it('uses DataStore + SubaccountGelatoRelayRouter without the legacy direct-router env', async () => {
    const client = canonicalClient();
    __setApiV2DelegationClientFactoryForTests(() => client);

    const result = await checkDelegationStatus(MAIN, SIGNER);

    expect(result).toMatchObject({
      queryOk: true,
      isAuthorized: true,
      remainingActions: 7,
      expiresAtUnix: Number(FUTURE),
      isExpired: false,
    });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter,
      functionName: 'subaccountApprovalNonces',
    }));
  });

  it('does not accept the legacy direct router as an API v2 relay substitute', async () => {
    vi.stubEnv(
      'GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS',
      '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db',
    );
    const factory = vi.fn(() => canonicalClient());
    __setApiV2DelegationClientFactoryForTests(factory);

    const result = await checkDelegationStatus(MAIN, SIGNER);

    expect(result.queryOk).toBe(false);
    expect(result.isAuthorized).toBe(false);
    expect(result.queryError).toContain('manifest mismatch');
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed when canonical feature or integration authorization is disabled', async () => {
    for (const disabled of [
      { featureDisabled: true },
      { integrationDisabled: true },
    ]) {
      __setApiV2DelegationClientFactoryForTests(() => canonicalClient(disabled));
      const result = await checkDelegationStatus(MAIN, SIGNER);
      expect(result.queryOk).toBe(true);
      expect(result.isAuthorized).toBe(false);
    }
  });

  it('does not authorize unlisted, expired, zero-expiry, or exhausted evidence', async () => {
    for (const invalid of [
      { listed: false },
      { expiresAt: 1_800_000_000n },
      { expiresAt: 0n },
      { maxAllowed: 8n, used: 8n },
    ]) {
      __setApiV2DelegationClientFactoryForTests(() => canonicalClient(invalid));
      const result = await checkDelegationStatus(MAIN, SIGNER);
      expect(result.queryOk).toBe(true);
      expect(result.isAuthorized).toBe(false);
    }
  });

  it('classifies missing API v2 config before creating a client', async () => {
    vi.stubEnv('GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', '');
    const factory = vi.fn(() => canonicalClient());
    __setApiV2DelegationClientFactoryForTests(factory);

    const result = await checkDelegationStatus(MAIN, SIGNER);

    expect(result.queryOk).toBe(false);
    expect(result.queryError).toContain('relay config unavailable');
    expect(factory).not.toHaveBeenCalled();
  });
});