/**
 * GMX V2 oracle price stream — React Native (iOS / Android / Expo Web)
 *
 * Polls the API server's /api/gmx/prices endpoint every 3 seconds.
 * GMX has no native WebSocket price feed; this polls the server-cached
 * REST endpoint instead.
 *
 * Drop-in replacement for the old Binance price stream.
 */

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface GmxPriceUpdate {
  tokenSymbol: string;   // "ETH", "BTC", "SOL" …
  tokenAddress: string;
  priceUsd: number;      // mid price in USD
  minPriceUsd: number;
  maxPriceUsd: number;
  updatedAt: number;     // ms timestamp
}

type UpdateCallback = (update: GmxPriceUpdate) => void;
type StatusCallback = (status: StreamStatus) => void;

const POLL_MS    = 3_000;
const RETRY_BASE = 2_000;
const MAX_RETRY  = 5;

// API server URL — works in Expo Go and Expo web via the EXPO_PUBLIC_DOMAIN var
const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

export class GmxPriceStream {
  private symbols:    Set<string> = new Set();
  private onUpdate:   UpdateCallback;
  private onStatus:   StatusCallback;
  private pollTimer:  ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout>  | null = null;
  private retries  = 0;
  private destroyed = false;

  constructor(onUpdate: UpdateCallback, onStatus: StatusCallback) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
  }

  connect(symbols: string[]) {
    this.destroyed = false;
    this.symbols   = new Set(symbols);
    this.retries   = 0;
    this.onStatus('connecting');
    this._start();
  }

  updateSymbols(symbols: string[]) {
    this.symbols = new Set(symbols);
    // Next poll automatically applies the updated filter
  }

  disconnect() {
    this.destroyed = true;
    this._stop();
    this.onStatus('offline');
  }

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
      const res = await fetch(`${API_BASE}/gmx/prices`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as GmxPriceUpdate[];

      this.retries = 0;
      this.onStatus('connected');

      for (const tick of data) {
        // Emit all if no filter, otherwise only subscribed symbols
        if (this.symbols.size === 0 || this.symbols.has(tick.tokenSymbol)) {
          this.onUpdate(tick);
        }
      }
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

/** One-shot fetch of prices for given symbols (for initial seeding). */
export async function fetchGmxPrices(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  try {
    const res = await fetch(`${API_BASE}/gmx/prices`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return {};
    const data = await res.json() as GmxPriceUpdate[];
    const set = new Set(symbols);
    return Object.fromEntries(
      data
        .filter(d => set.has(d.tokenSymbol))
        .map(d => [d.tokenSymbol, d.priceUsd])
    );
  } catch {
    return {};
  }
}
