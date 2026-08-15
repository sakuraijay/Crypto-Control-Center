/**
 * Privacy-preserving read-only Wallet Diagnostic
 *
 * POST /api/wallet/diagnostic — browser pushes minimal boolean-only snapshot
 * GET  /api/wallet/diagnostic — returns current snapshot + stale flag
 *
 * ── Privacy model ──────────────────────────────────────────────────────────
 * ALLOWED:  walletConnected, addressFingerprint ("0x1234…abcd" only),
 *           chainId, isArbitrum, usdcFetchOk, ethFetchOk,
 *           subgraphOk, positionCount, lastRefreshAt
 * FORBIDDEN (rejected with 400): actual balance amounts, PnL, full address,
 *   privateKey, seed/mnemonic, signature, signed payload, tx data, leverage,
 *   liquidation price, collateral/size amounts.
 *
 * ── Storage ────────────────────────────────────────────────────────────────
 * In-memory only — no DB writes. Lost on server restart (by design).
 * Partial merge: each POST updates only the fields it provides;
 *                previously set fields are preserved.
 * Stale = no update for >90 s (receivedAt timestamp).
 */

import { Router, type Request, type Response } from 'express';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletDiagnosticSnapshot {
  walletConnected:    boolean;
  /** "0x1234…abcd" only — first 6 + last 4 chars of address. Never full address. */
  addressFingerprint: string | null;
  chainId:            number | null;
  isArbitrum:         boolean;
  usdcFetchOk:        boolean;
  ethFetchOk:         boolean;
  subgraphOk:         boolean;
  positionCount:      number;
  lastRefreshAt:      string;  // ISO — browser-reported refresh time
  receivedAt:         string;  // ISO — server-side receipt time (stale calc basis)
}

export const STALE_THRESHOLD_MS = 90_000;

// ── In-memory store (single-operator system — one snapshot) ───────────────────

const DEFAULT_SNAPSHOT: WalletDiagnosticSnapshot = {
  walletConnected:    false,
  addressFingerprint: null,
  chainId:            null,
  isArbitrum:         false,
  usdcFetchOk:        false,
  ethFetchOk:         false,
  subgraphOk:         false,
  positionCount:      0,
  lastRefreshAt:      new Date().toISOString(),
  receivedAt:         new Date().toISOString(),
};

let snapshot: WalletDiagnosticSnapshot = { ...DEFAULT_SNAPSHOT };

// ── Field access-control ──────────────────────────────────────────────────────

/** Fields the browser may send. All others are silently ignored. */
const ALLOWED_FIELDS = new Set<string>([
  'walletConnected', 'addressFingerprint', 'chainId',
  'isArbitrum', 'usdcFetchOk', 'ethFetchOk',
  'subgraphOk', 'positionCount', 'lastRefreshAt',
]);

/** Financial/sensitive fields — reject the entire POST if present. */
const FORBIDDEN_FIELDS = new Set<string>([
  'usdcBalance', 'ethBalance', 'totalExposureUsd',
  'address', 'fullAddress', 'walletAddress',
  'privateKey', 'seed', 'mnemonic', 'signature',
  'signedPayload', 'txData', 'pnl', 'unrealizedPnl',
  'realizedPnl', 'leverage', 'liquidationPrice',
  'collateralUsd', 'sizeUsd', 'entryPrice',
]);

/** Validate addressFingerprint format: "0x<4hex>…<4hex>" (U+2026 ellipsis). */
const FP_RE = /^0x[\da-fA-F]{4}\u2026[\da-fA-F]{4}$/;

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// ── POST /api/wallet/diagnostic ───────────────────────────────────────────────
router.post('/wallet/diagnostic', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  // Reject if any forbidden field is present
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      return void res.status(400).json({
        error: `Forbidden field "${key}" — financial data must never leave the browser.`,
        hint:  'Only boolean fetch-status flags are accepted.',
      });
    }
  }

  // Extract and validate allowed fields
  const now = new Date().toISOString();

  const fp = typeof body.addressFingerprint === 'string' ? body.addressFingerprint : undefined;
  const fingerprintValid = fp == null || FP_RE.test(fp);

  const update: Partial<WalletDiagnosticSnapshot> = {};

  if ('walletConnected'    in body) update.walletConnected    = Boolean(body.walletConnected);
  if ('addressFingerprint' in body) update.addressFingerprint = fingerprintValid ? (fp ?? null) : null;
  if ('chainId'            in body) update.chainId            = typeof body.chainId === 'number' ? body.chainId : null;
  if ('isArbitrum'         in body) update.isArbitrum         = Boolean(body.isArbitrum);
  if ('usdcFetchOk'        in body) update.usdcFetchOk        = Boolean(body.usdcFetchOk);
  if ('ethFetchOk'         in body) update.ethFetchOk         = Boolean(body.ethFetchOk);
  if ('subgraphOk'         in body) update.subgraphOk         = Boolean(body.subgraphOk);
  if ('positionCount'      in body) update.positionCount      = typeof body.positionCount === 'number'
    ? Math.max(0, Math.floor(body.positionCount)) : snapshot.positionCount;
  if ('lastRefreshAt'      in body) update.lastRefreshAt      = typeof body.lastRefreshAt === 'string'
    ? body.lastRefreshAt : now;

  // Ignore unknown keys not in ALLOWED_FIELDS (silent drop)
  for (const key of Object.keys(update)) {
    if (!ALLOWED_FIELDS.has(key)) delete (update as Record<string, unknown>)[key];
  }

  // Partial merge — keeps fields not included in this POST
  snapshot = { ...snapshot, ...update, receivedAt: now };

  return void res.status(204).end();
});

// ── GET /api/wallet/diagnostic ────────────────────────────────────────────────
router.get('/wallet/diagnostic', (_req: Request, res: Response) => {
  const ageMs = Date.now() - new Date(snapshot.receivedAt).getTime();
  const stale  = ageMs > STALE_THRESHOLD_MS;
  const present = snapshot.walletConnected || snapshot.subgraphOk;

  return void res.json({
    present,
    stale,
    ageMs,
    snapshot: { ...snapshot, stale },
  });
});

export default router;
