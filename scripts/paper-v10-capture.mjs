#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE = 'https://arbitrum-api.gmxinfra.io/prices/candles';
const TIMEFRAMES = { '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000 };
const SYMBOLS = ['BTC', 'SOL', 'XRP', 'ETH', 'LINK'];
const PRIMARY = new Set(['BTC', 'SOL', 'XRP']);
const COUNT = 200;
const FROM = Date.parse('2026-10-01T16:00:00Z');
const TO = Date.parse('2026-10-02T16:00:00Z');
const OUT = resolve(process.argv[2] ?? 'docs/verification/paper-v10/gmx-candles-2026-10-02.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fetchedAt = new Date().toISOString();

const capture = {
  schema: 'paper-v10-gmx-multitimeframe-capture/v1',
  source: BASE,
  fetchedAt,
  decisionWindow: { timezone: 'Asia/Manila (UTC+08:00)', fromMs: FROM, toExclusiveMs: TO },
  countRequestedPerSymbolTimeframe: COUNT,
  symbols: {},
};

for (const symbol of SYMBOLS) {
  capture.symbols[symbol] = { classification: PRIMARY.has(symbol) ? 'PRIMARY' : 'SUPPLEMENTARY', timeframes: {} };
  for (const [timeframe, intervalMs] of Object.entries(TIMEFRAMES)) {
    const url = `${BASE}?tokenSymbol=${encodeURIComponent(symbol)}&period=${timeframe}&limit=${COUNT}`;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${symbol} ${timeframe}: GMX HTTP ${response.status}`);
    const rawResponse = await response.text();
    if (rawResponse.length > 2_000_000) throw new Error(`${symbol} ${timeframe}: response too large`);
    const parsed = JSON.parse(rawResponse);
    if (!Array.isArray(parsed.candles) || !parsed.candles.length)
      throw new Error(`${symbol} ${timeframe}: GMX candle schema invalid`);
    const unique = new Map();
    for (const row of parsed.candles) {
      if (!Array.isArray(row) || row.length < 5 || row.slice(0, 5).some((x) => typeof x !== 'number' || !Number.isFinite(x)))
        throw new Error(`${symbol} ${timeframe}: malformed OHLC row`);
      const [seconds, open, high, low, close] = row;
      const openMs = seconds * 1_000;
      if (openMs % intervalMs || [open, high, low, close].some((x) => x <= 0)
        || high < Math.max(open, low, close) || low > Math.min(open, high, close))
        throw new Error(`${symbol} ${timeframe}: invalid candle values at ${seconds}`);
      if (unique.has(openMs)) throw new Error(`${symbol} ${timeframe}: duplicate candle timestamp ${seconds}`);
      unique.set(openMs, [openMs, open, high, low, close]);
    }
    const all = [...unique.values()].sort((a, b) => a[0] - b[0]);
    const closed = all.filter((row) => row[0] + intervalMs <= Date.parse(fetchedAt));
    if (closed.length < 60) throw new Error(`${symbol} ${timeframe}: fewer than 60 completed warmup candles`);
    for (let i = 1; i < closed.length; i++) {
      if (closed[i][0] - closed[i - 1][0] !== intervalMs)
        throw new Error(`${symbol} ${timeframe}: chronological gap between ${closed[i - 1][0]} and ${closed[i][0]}`);
    }
    const entry = {
      sourceUrl: url,
      intervalMs,
      responseSha256: sha256(rawResponse),
      rawResponse,
      rawRows: parsed.candles.length,
      closedRows: closed.length,
      firstClosedOpenMs: closed[0][0],
      lastClosedOpenMs: closed.at(-1)[0],
      lastClosedAtMs: closed.at(-1)[0] + intervalMs,
      excludedOpenOrFutureRows: all.length - closed.length,
      candles: closed,
    };
    capture.symbols[symbol].timeframes[timeframe] = entry;
    console.log(`${symbol} ${timeframe}: ${closed.length} closed, through ${new Date(entry.lastClosedAtMs).toISOString()}, response sha256 ${entry.responseSha256}`);
  }
}

capture.captureSha256 = sha256(JSON.stringify(capture));
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' });
console.log(`capture=${OUT} sha256=${capture.captureSha256}`);