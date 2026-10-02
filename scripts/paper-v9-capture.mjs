#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE = 'https://arbitrum-api.gmxinfra.io/prices/candles';
const INTERVAL = 15 * 60_000;
const SYMBOLS = ['BTC', 'SOL', 'XRP', 'LINK', 'ETH'];
const COUNT = 200;
const OUT = resolve(process.argv[2] ?? '/tmp/paper-v9-capture-2026-10-02.json');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const observedAt = new Date().toISOString();
const capture = {
  schema: 'paper-v9-gmx-candle-capture/v1',
  source: 'https://arbitrum-api.gmxinfra.io/prices/candles',
  fetchedAt: observedAt,
  requestedAtDateUtc: observedAt.slice(0, 10),
  interval: '15m',
  intervalMs: INTERVAL,
  countRequested: COUNT,
  symbols: {},
};

for (const symbol of SYMBOLS) {
  const url = `${BASE}?tokenSymbol=${encodeURIComponent(symbol)}&period=15m&limit=${COUNT}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${symbol}: GMX HTTP ${response.status}`);
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error(`${symbol}: response too large`);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.candles) || !parsed.candles.length) throw new Error(`${symbol}: GMX candle schema invalid`);
  const seen = new Set();
  const all = [];
  for (const row of parsed.candles) {
    if (!Array.isArray(row) || row.length < 5 || row.slice(0, 5).some(x => typeof x !== 'number' || !Number.isFinite(x)))
      throw new Error(`${symbol}: malformed OHLC row`);
    const [seconds, open, high, low, close] = row;
    const t = seconds * 1000;
    if (seen.has(t)) continue;
    seen.add(t);
    if (t % INTERVAL || [open, high, low, close].some(x => x <= 0)
      || high < Math.max(open, low, close) || low > Math.min(open, high, close))
      throw new Error(`${symbol}: invalid candle values at ${seconds}`);
    all.push([t, open, high, low, close]);
  }
  all.sort((a, b) => a[0] - b[0]);
  const now = Date.now();
  const closed = all.filter(row => row[0] + INTERVAL <= now);
  if (closed.length < 17) throw new Error(`${symbol}: fewer than 17 completed candles`);
  for (let i = 1; i < closed.length; i++) {
    if (closed[i][0] - closed[i - 1][0] !== INTERVAL)
      throw new Error(`${symbol}: chronological gap between ${closed[i - 1][0]} and ${closed[i][0]}`);
  }
  capture.symbols[symbol] = {
    sourceUrl: url,
    responseSha256: sha256(raw),
    rawResponse: raw,
    rawRows: parsed.candles.length,
    closedRows: closed.length,
    firstClosedOpenMs: closed[0][0],
    lastClosedOpenMs: closed.at(-1)[0],
    lastClosedAtMs: closed.at(-1)[0] + INTERVAL,
    excludedOpenOrFutureRows: all.length - closed.length,
    candles: closed,
  };
  console.log(`${symbol}: ${closed.length} closed candles; ${new Date(closed[0][0]).toISOString()} .. ${new Date(closed.at(-1)[0] + INTERVAL).toISOString()}; raw sha256 ${capture.symbols[symbol].responseSha256}`);
}
capture.captureSha256 = sha256(JSON.stringify(capture));
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' });
console.log(`capture=${OUT} sha256=${capture.captureSha256}`);