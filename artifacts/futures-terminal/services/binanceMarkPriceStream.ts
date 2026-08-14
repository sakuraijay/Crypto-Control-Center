/**
 * Binance USD-M Futures public mark-price WebSocket stream — React Native compatible.
 * No API key required.
 *
 * React Native's WebSocket API mirrors the browser API (onopen / onmessage / etc.)
 * so the same connection pattern works on iOS, Android, and web.
 */

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface MarkPriceUpdate {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  fundingTime: number;
  eventTime: number;
}

type UpdateCallback = (update: MarkPriceUpdate) => void;
type StatusCallback = (status: StreamStatus) => void;

const WS_BASE = 'wss://fstream.binance.com/stream';
// REST API: fapi.binance.com — fstream.binance.com is WebSocket-only
const REST_BASE = 'https://fapi.binance.com/fapi/v1';
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

  connect(symbols: string[]) {
    this.destroyed = false;
    this.symbols = [...symbols];
    this.retries = 0;
    this._open();
  }

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

  disconnect() {
    this.destroyed = true;
    this._close();
    this.onStatus('offline');
  }

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
    this.ws.onmessage = (evt: WebSocketMessageEvent) => {
      try {
        const msg = JSON.parse(evt.data);
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
      } catch {}
    };
    this.ws.onerror = () => { this.ws?.close(); };
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
    if (this.retries > MAX_RETRIES) { this.onStatus('offline'); return; }
    this.onStatus('reconnecting');
    const delay = RETRY_BASE_MS * Math.pow(1.5, this.retries - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.destroyed) this._open();
    }, delay);
  }
}

/** Fetch 24h stats via REST (initial seed). */
export async function fetch24hStats(
  symbols: string[],
): Promise<Record<string, { changePercent: number; volume: number }>> {
  if (symbols.length === 0) return {};
  try {
    const param = encodeURIComponent(JSON.stringify(symbols));
    const res = await fetch(`${REST_BASE}/ticker/24hr?symbols=${param}`);
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
      }])
    );
  } catch {
    return {};
  }
}

/** Fetch current mark prices for initial seeding (all symbols in one call). */
export async function fetchMarkPrices(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  try {
    const res = await fetch(`${REST_BASE}/premiumIndex`);
    if (!res.ok) return {};
    const data = await res.json() as Array<{ symbol: string; markPrice: string }>;
    return Object.fromEntries(
      data
        .filter((d: { symbol: string }) => symbols.includes(d.symbol))
        .map((d: { symbol: string; markPrice: string }) => [d.symbol, parseFloat(d.markPrice)])
    );
  } catch {
    return {};
  }
}
