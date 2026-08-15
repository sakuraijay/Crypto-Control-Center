/**
 * Internal Executor — Replit-hosted GMX V2 / Arbitrum One execution worker.
 *
 * This module runs inside the API server process on a Replit Reserved VM,
 * providing 24/7 execution without an external VPS.
 *
 * SECURITY CONTRACT
 *   - All GMX credentials (signer key, RPC URL) are read from server env vars only.
 *   - No key material is ever returned to any client response.
 *   - The /executor/status endpoint returns only boolean readiness signals.
 *
 * DEPLOYMENT MODES
 *   - reserved_vm   — Replit Reserved VM (always-on); full autonomous operation.
 *   - development   — Replit development container (sleeps when idle); use for testing only.
 *
 * CREDENTIALS (set as Replit Secrets on the api-server artifact)
 *   GMX_SIGNER_KEY        — GMX One-Click delegated subaccount private key (hex, no 0x prefix).
 *                           This is the subaccount key only — never the primary wallet key.
 *   GMX_RPC_URL           — Arbitrum One RPC endpoint (e.g. https://arb1.arbitrum.io/rpc)
 *   GMX_WALLET_ADDRESS    — Primary wallet address (public, informational only)
 *   GMX_SUBACCOUNT_ADDRESS — Delegated One-Click subaccount address (public, informational only)
 */

export type DeploymentMode = 'reserved_vm' | 'development';

export interface ExecutorStatus {
  mode: 'internal';
  ready: boolean;
  /** True when GMX_SIGNER_KEY env var is set (value never returned) */
  signerConfigured: boolean;
  /** True when GMX_RPC_URL env var is set */
  rpcConfigured: boolean;
  /** True when Arbitrum One RPC responds within 5 s (checked on startup + every 60 s) */
  gmxRpcHealthy: boolean;
  /** Reserved VM = always-on; development = may sleep */
  deploymentMode: DeploymentMode;
  /** Public wallet info — never private keys */
  walletAddress: string | null;
  subaccountAddress: string | null;
  uptimeMs: number;
  startedAt: string;
  lastRpcCheckAt: string | null;
}

export interface ExecuteOrderParams {
  decisionId: string;
  operatingState: string;     // 'LONG' | 'SHORT' | 'CASH' | 'SPOT' | 'HEDGE'
  symbol: string | null;
  executionType: string;      // 'perp_long_open' | 'perp_short_open' | etc.
  sizeUsd?: number | null;
  leverage?: number | null;
  tpPrice?: number | null;
  slPrice?: number | null;
  trailingStopPct?: number | null;
  cycleNumber?: number;
}

export interface ExecuteOrderResult {
  ok: boolean;
  executedAt: string;
  txHash?: string | null;
  error?: string;
  code?: string;
  /** Simulated when signer not configured */
  simulated?: boolean;
}

// ── Startup timestamp ─────────────────────────────────────────────────────────
const START_TIME = Date.now();
const STARTED_AT = new Date().toISOString();

// ── RPC health cache ──────────────────────────────────────────────────────────
let gmxRpcHealthy = false;
let lastRpcCheckAt: string | null = null;
const RPC_CHECK_INTERVAL_MS = 60_000;

/** Detect Replit deployment mode from environment */
function detectDeploymentMode(): DeploymentMode {
  // REPLIT_DEPLOYMENT is set in Reserved VM / Autoscale deployments
  if (process.env.REPLIT_DEPLOYMENT) return 'reserved_vm';
  return 'development';
}

/** Check Arbitrum One RPC health without revealing the RPC URL to clients */
async function checkRpcHealth(): Promise<boolean> {
  const rpcUrl = process.env.GMX_RPC_URL;
  if (!rpcUrl?.trim()) return false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const json = await res.json() as { result?: string };
    // Arbitrum One chainId = 0xa4b1 = 42161
    return json.result === '0xa4b1';
  } catch {
    return false;
  }
}

/** Start periodic RPC health check */
export function startRpcHealthMonitor(): void {
  const check = async () => {
    gmxRpcHealthy = await checkRpcHealth();
    lastRpcCheckAt = new Date().toISOString();
  };
  void check(); // immediate first check
  setInterval(check, RPC_CHECK_INTERVAL_MS);
}

/** Return current executor status — no secrets included */
export function getExecutorStatus(): ExecutorStatus {
  const signerConfigured = Boolean(process.env.GMX_SIGNER_KEY?.trim());
  const rpcConfigured    = Boolean(process.env.GMX_RPC_URL?.trim());

  return {
    mode:               'internal',
    ready:              signerConfigured && rpcConfigured && gmxRpcHealthy,
    signerConfigured,
    rpcConfigured,
    gmxRpcHealthy,
    deploymentMode:     detectDeploymentMode(),
    walletAddress:      process.env.GMX_WALLET_ADDRESS ?? null,
    subaccountAddress:  process.env.GMX_SUBACCOUNT_ADDRESS ?? null,
    uptimeMs:           Date.now() - START_TIME,
    startedAt:          STARTED_AT,
    lastRpcCheckAt,
  };
}

/**
 * Execute a GMX V2 order via the internal signer.
 *
 * In development (signer not configured), returns a simulated success so the
 * full approval-gate and logging flow can be exercised without real credentials.
 *
 * In production (GMX_SIGNER_KEY set), this is where the GMX SDK call will go
 * once the One-Click subaccount key is provided.
 */
export async function executeOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  const ts = new Date().toISOString();
  const signerConfigured = Boolean(process.env.GMX_SIGNER_KEY?.trim());

  // ── Development / unconfigured: simulate ────────────────────────────────────
  if (!signerConfigured) {
    console.info(
      `[InternalExecutor] SIMULATED — signer not configured. decision=${params.decisionId} type=${params.executionType} symbol=${params.symbol ?? 'MULTI'}`,
    );
    return {
      ok:          true,
      executedAt:  ts,
      txHash:      null,
      simulated:   true,
    };
  }

  // ── Production: GMX SDK execution (stub — implement when key is provided) ───
  // TODO: Replace this stub with actual GMX V2 SDK order submission.
  //       The signer key is available as process.env.GMX_SIGNER_KEY
  //       The RPC URL is available as process.env.GMX_RPC_URL
  //       Neither value should ever be returned to clients.
  console.info(
    `[InternalExecutor] LIVE — would execute decision=${params.decisionId} type=${params.executionType} symbol=${params.symbol ?? 'MULTI'} sizeUsd=${params.sizeUsd ?? 'n/a'}`,
  );

  // Return simulated until GMX SDK is integrated
  return {
    ok:         true,
    executedAt: ts,
    txHash:     null,
    simulated:  true,
  };
}
