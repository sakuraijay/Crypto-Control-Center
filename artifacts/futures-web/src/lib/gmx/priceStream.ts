/**
 * GMX V2 oracle price stream — web
 *
 * Polls the API server's /api/gmx/prices endpoint every 3 seconds.
 * GMX does not provide a native WebSocket price feed; the API server
 * polls gmxinfra.io server-side and caches results, so clients only
 * need to call the local proxy.
 *
 * GMX oracle price stream for Arbitrum One.
 */

import type { GmxOraclePrice, StreamStatus } from './types';

export type { StreamStatus };
export type { GmxOraclePrice };

const POLL_MS    = 3_000;
const RETRY_BASE = 2_000;
const MAX_RETRY  = 5;
const ENDPOINT   = '/api/gmx/prices';

type UpdateCallback = (prices: Map<string, GmxOraclePrice>) => void;
type StatusCallback = (status: StreamStatus) => void;

export class GmxPriceStream {
  private symbols:    Set<string> = new Set();
  private onUpdate:   UpdateCallback;
  private onStatus:   StatusCallback;
  private pollTimer:  ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout>  | null = null;
  private retries  = 0;
  private destroyed = false;
  private lastAll: Map<string, GmxOraclePrice> = new Map();

  constructor(onUpdate: UpdateCallback, onStatus: StatusCallback) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
  }

  /** Start polling for the given symbol list. */
  connect(symbols: string[]) {
    this.destroyed = false;
    this.symbols   = new Set(symbols);
    this.retries   = 0;
    this.onStatus('connecting');
    this._start();
  }

  /** Update the symbol subscription without reconnecting. */
  updateSymbols(symbols: string[]) {
    this.symbols = new Set(symbols);
    // Next poll automatically applies the new filter — no reconnect needed.
  }

  /** Stop polling permanently (call on unmount). */
  disconnect() {
    this.destroyed = true;
    this._stop();
    this.onStatus('offline');
  }

  /** Synchronous lookup from the last successful response. */
  getPrice(symbol: string): GmxOraclePrice | undefined {
    return this.lastAll.get(symbol);
  }

  // ── private ─────────────────────────────────────────────────────

  private _start() {
    this._stop();
    if (this.destroyed) return;
    void this._fetch();
    this.pollTimer = setInterval(() => void this._fetch(), POLL_MS);
  }

  private _stop() {
    if (this.pollTimer)  { clearInterval(this.pollTimer);  this.pollTimer  = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer);  this.retryTimer = null; }
  }

  private async _fetch() {
    if (this.destroyed) return;
    try {
      const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as GmxOraclePrice[];

      const all = new Map<string, GmxOraclePrice>();
      for (const tick of data) {
        all.set(tick.tokenSymbol, tick);
        all.set(tick.tokenAddress.toLowerCase(), tick);
      }
      this.lastAll = all;

      this.retries = 0;
      this.onStatus('connected');

      // Emit only subscribed symbols; emit all if no filter set
      const out = new Map<string, GmxOraclePrice>();
      if (this.symbols.size === 0) {
        all.forEach((v, k) => out.set(k, v));
      } else {
        for (const sym of this.symbols) {
          const tick = all.get(sym);
          if (tick) out.set(sym, tick);
        }
      }
      this.onUpdate(out);
    } catch {
      this._scheduleRetry();
    }
  }

  private _scheduleRetry() {
    this.retries++;
    if (this.retries > MAX_RETRY) { this.onStatus('offline'); return; }
    this.onStatus('reconnecting');
    const delay = RETRY_BASE * Math.pow(1.5, this.retries - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.destroyed) void this._fetch();
    }, delay);
  }
}

/** One-shot fetch of all GMX oracle prices (for seeding). */
export async function fetchGmxPrices(): Promise<Map<string, GmxOraclePrice>> {
  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return new Map();
    const data = await res.json() as GmxOraclePrice[];
    const map = new Map<string, GmxOraclePrice>();
    for (const tick of data) map.set(tick.tokenSymbol, tick);
    return map;
  } catch {
    return new Map();
  }
}
