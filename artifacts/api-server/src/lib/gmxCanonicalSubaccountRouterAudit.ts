/**
 * Canonical GMX SubaccountRouter audit pin — Arbitrum One.
 *
 * This is deliberately separate from gmxDeploymentManifest, whose v2 contract
 * audits the Gelato relay path. The two routers have different responsibilities
 * and must never be treated as interchangeable.
 *
 * Read-only safety contract only:
 * - no env fallback or mutation
 * - no RPC, DB, signing, approval, or order submission
 * - missing / malformed / mismatched values fail closed
 */

export const GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT = {
  auditVersion: 1,
  chainId: 42161,
  checkedAt: '2026-08-29',
  source: 'GMX official Contract Addresses documentation — Arbitrum',
  address: '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db',
} as const;

export interface CanonicalSubaccountRouterValidationResult {
  ok: boolean;
  mismatches: string[];
}

function normalizedAddress(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Validate GMX_SUBACCOUNT_ROUTER_ADDRESS against the separately audited
 * canonical Arbitrum SubaccountRouter. The function never supplies a value.
 */
export function validateCanonicalSubaccountRouterEnv(
  env: NodeJS.ProcessEnv,
): CanonicalSubaccountRouterValidationResult {
  const mismatches: string[] = [];
  const actual = normalizedAddress(env.GMX_SUBACCOUNT_ROUTER_ADDRESS);
  const expected = GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address.toLowerCase();

  if (actual === null) {
    mismatches.push('GMX_SUBACCOUNT_ROUTER_ADDRESS missing or malformed — canonical audit unavailable (fail-closed)');
  } else if (actual !== expected) {
    mismatches.push(
      `GMX_SUBACCOUNT_ROUTER_ADDRESS does not match canonical Arbitrum audit v${GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.auditVersion} (fail-closed)`,
    );
  }

  const chainRaw = (env.GMX_CHAIN_ID ?? '').trim();
  if (chainRaw !== '' && chainRaw !== String(GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.chainId)) {
    mismatches.push(
      `GMX_CHAIN_ID != ${GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.chainId} — canonical subaccount audit mismatch (fail-closed)`,
    );
  }

  return { ok: mismatches.length === 0, mismatches };
}
