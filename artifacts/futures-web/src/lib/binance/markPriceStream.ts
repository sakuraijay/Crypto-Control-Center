/**
 * Binance USD-M Futures public mark-price WebSocket stream.
 * No API key required — connects to public fstream endpoint.
 *
 * Docs: https://binance-docs.github.io/apidocs/futures/en/#mark-price-stream
 */

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface MarkPriceUpdate {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;   // next estimated funding rate (8h)
  fundingTime: number;   // next funding timestamp (ms)
  eventTime: number;
}

type UpdateCallback = (update: MarkPriceUpdate) => void;
type StatusCallback = (status: StreamStatus) => void;

const WS_BASE = 'wss://fstream.binance.com/stream';
const REST_BASE = 'https://fstream.binance.com/fapi/v1';
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2_000;

export class MarkPriceStream {
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private onUpdate: UpdateCallback;
  private onStatus: StatusCallback;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(onUpdate: UpdateCallback, onStatus: StatusCallback) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
  }

  /** Initial connect with symbol list. */
  connect(symbols: string[]) {
    this.destroyed = false;
    this.symbols = [...symbols];
    this.retries = 0;
    this._open();
  }

  /**
   * Update the subscription list.
   * Reconnects only if the sorted symbol list actually changed.
   */
  updateSymbols(symbols: string[]) {
    const next = [...symbols].sort().join(',');
    const current = [...this.symbols].sort().join(',');
    if (next === current) return;
    this.symbols = [...symbols];
    this._close();
    if (!this.destroyed) {
      this.retries = 0;
      this._open();
    }
  }

  /** Permanent disconnect — call on unmount. */
  disconnect() {
    this.destroyed = true;
    this._close();
    this.onStatus('offline');
  }

  // ─── private ────────────────────────────────────────────────────

  private _open() {
    if (this.destroyed || this.symbols.length === 0) return;

    const streams = this.symbols
      .map(s => `${s.toLowerCase()}@markPrice@1s`)
      .join('/');
    const url = `${WS_BASE}?streams=${streams}`;

    this.onStatus('connecting');

    try {
      this.ws = new WebSocket(url);
    } catch {
      this._scheduleRetry();
      return;
    }

    this.ws.onopen = () => {
      this.retries = 0;
      this.onStatus('connected');
    };

    this.ws.onmessage = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data as string);
        // Combined stream wraps payload in { stream, data }
        const d = msg.data ?? msg;
        if (d.e === 'markPriceUpdate') {
          this.onUpdate({
            symbol: d.s,
            markPrice: parseFloat(d.p),
            indexPrice: parseFloat(d.i ?? d.p),
            fundingRate: parseFloat(d.r ?? '0'),
            fundingTime: d.T ?? 0,
            eventTime: d.E ?? Date.now(),
          });
        }
      } catch {
        // malformed frame — ignore
      }
    };

    this.ws.onerror = () => {
      // onerror is always followed by onclose in browsers; handle there
      this.ws?.close();
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.destroyed) this._scheduleRetry();
    };
  }

  private _close() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private _scheduleRetry() {
    this.retries += 1;
    if (this.retries > MAX_RETRIES) {
      this.onStatus('offline');
      return;
    }
    this.onStatus('reconnecting');
    const delay = RETRY_BASE_MS * Math.pow(1.5, this.retries - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.destroyed) this._open();
    }, delay);
  }
}

// ─── REST helpers ────────────────────────────────────────────────

/** Fetch 24-hour price change % for multiple symbols in one call. */
export async function fetch24hStats(
  symbols: string[],
): Promise<Record<string, { changePercent: number; volume: number }>> {
  if (symbols.length === 0) return {};
  try {
    const param = encodeURIComponent(JSON.stringify(symbols));
    // Use the API server proxy (/api-server/ → port 8080) to avoid browser CORS.
    // Replit's proxy strips the /api-server prefix before forwarding to Express.
    const res = await fetch(`/api-server/api/binance/ticker24h?symbols=${param}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return {};
    const data = await res.json() as Array<{
      symbol: string;
      priceChangePercent: string;
      quoteVolume: string;
    }>;
    return Object.fromEntries(
      data.map(d => [d.symbol, {
        changePercent: parseFloat(d.priceChangePercent),
        volume: parseFloat(d.quoteVolume),
      }]),
    );
  } catch {
    return {};
  }
}

/** Fetch current mark prices for multiple symbols (initial seeding). */
export async function fetchMarkPrices(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  try {
    const res = await fetch(`/api-server/api/binance/markprices`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return {};
    const data = await res.json() as Array<{ symbol: string; markPrice: string }>;
    return Object.fromEntries(
      data
        .filter(d => symbols.includes(d.symbol))
        .map(d => [d.symbol, parseFloat(d.markPrice)])
    );
  } catch {
    return {};
  }
}
