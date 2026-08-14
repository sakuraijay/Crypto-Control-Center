/**
 * Mobile backtesting engine — mirrors the web engine but as a standalone
 * copy (no cross-package imports in React Native / Expo).
 * Data source: GMX V2 candles via API server proxy.
 */

export interface Candle {
  time: number;
  open: number; high: number; low: number; close: number; volume: number;
}

export interface BacktestIndicatorConfig {
  ema:  { enabled: boolean; fast: number; slow: number };
  rsi:  { enabled: boolean; period: number; overbought: number; oversold: number };
  macd: { enabled: boolean; fast: number; slow: number; signal: number };
  bb:   { enabled: boolean; period: number; deviation: number };
  vol:  { enabled: boolean; multiplier: number };
}

export interface BacktestConfig {
  indicators: BacktestIndicatorConfig;
  initialCapital: number;
  tpPct: number; slPct: number; feePct: number; positionSizePct: number;
}

export interface BacktestTrade {
  entryTime: number; exitTime: number; side: 'LONG' | 'SHORT';
  entryPrice: number; exitPrice: number; pnl: number; pnlPct: number;
  reason: 'SIGNAL' | 'TP' | 'SL';
}

export interface BacktestResult {
  totalReturnPct: number; winRate: number; maxDrawdownPct: number;
  tradeCount: number; profitFactor: number; avgWinPct: number; avgLossPct: number;
  equityCurve: Array<{ time: number; equity: number }>;
  trades: BacktestTrade[]; finalEquity: number;
}

function calcEma(v: number[], p: number): number[] {
  const k = 2 / (p + 1), e = new Array(v.length).fill(NaN);
  if (v.length < p) return e;
  e[p - 1] = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < v.length; i++) e[i] = v[i] * k + e[i - 1] * (1 - k);
  return e;
}

function calcRsi(c: number[], p: number): number[] {
  const r = new Array(c.length).fill(NaN);
  if (c.length <= p) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) ag += d; else al += Math.abs(d); }
  ag /= p; al /= p;
  r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function calcMacd(c: number[], f: number, s: number, sg: number) {
  const ef = calcEma(c, f), es = calcEma(c, s);
  const ml = c.map((_, i) => isNaN(ef[i]) || isNaN(es[i]) ? NaN : ef[i] - es[i]);
  const vs = s - 1;
  const ssl = calcEma(ml.slice(vs).map(v => isNaN(v) ? 0 : v), sg);
  return { ml, sl: new Array(vs).fill(NaN).concat(ssl) };
}

function calcBB(c: number[], p: number, d: number) {
  const u = new Array(c.length).fill(NaN), l = new Array(c.length).fill(NaN);
  for (let i = p - 1; i < c.length; i++) {
    const sl = c.slice(i - p + 1, i + 1), m = sl.reduce((a, b) => a + b, 0) / p;
    const std = Math.sqrt(sl.reduce((a, v) => a + (v - m) ** 2, 0) / p);
    u[i] = m + d * std; l[i] = m - d * std;
  }
  return { u, l };
}

function scores(candles: Candle[], cfg: BacktestIndicatorConfig): number[] {
  const cl = candles.map(c => c.close), vl = candles.map(c => c.volume), n = candles.length;
  const sc = new Array(n).fill(0);

  if (cfg.ema.enabled) {
    const ef = calcEma(cl, cfg.ema.fast), es = calcEma(cl, cfg.ema.slow);
    for (let i = 0; i < n; i++) if (!isNaN(ef[i]) && !isNaN(es[i])) sc[i] += ef[i] > es[i] ? 1 : -1;
  }
  if (cfg.rsi.enabled) {
    const rsi = calcRsi(cl, cfg.rsi.period);
    for (let i = 0; i < n; i++) if (!isNaN(rsi[i])) {
      if (rsi[i] < cfg.rsi.oversold) sc[i] += 1;
      else if (rsi[i] > cfg.rsi.overbought) sc[i] -= 1;
    }
  }
  if (cfg.macd.enabled) {
    const { ml, sl } = calcMacd(cl, cfg.macd.fast, cfg.macd.slow, cfg.macd.signal);
    for (let i = 0; i < n; i++) if (!isNaN(ml[i]) && !isNaN(sl[i])) sc[i] += ml[i] > sl[i] ? 1 : -1;
  }
  if (cfg.bb.enabled) {
    const { u, l } = calcBB(cl, cfg.bb.period, cfg.bb.deviation);
    for (let i = 0; i < n; i++) if (!isNaN(u[i])) {
      if (cl[i] < l[i]) sc[i] += 1; else if (cl[i] > u[i]) sc[i] -= 1;
    }
  }
  if (cfg.vol.enabled) {
    const av = new Array(n).fill(NaN);
    for (let i = 19; i < n; i++) av[i] = vl.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
    const es = cfg.ema.enabled ? calcEma(cl, cfg.ema.slow) : new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (!isNaN(av[i]) && vl[i] > av[i] * cfg.vol.multiplier) {
      sc[i] += isNaN(es[i]) ? 0 : cl[i] > es[i] ? 1 : -1;
    }
  }
  return sc;
}

export function runBacktest(candles: Candle[], bcfg: BacktestConfig): BacktestResult {
  const { indicators, initialCapital, tpPct, slPct, feePct, positionSizePct } = bcfg;
  const sc = scores(candles, indicators);
  const trades: BacktestTrade[] = [];
  const curve: Array<{ time: number; equity: number }> = [];

  let equity = initialCapital, peak = initialCapital, maxDD = 0;
  let pos: { side: 'LONG'|'SHORT'; ep: number; et: number; sizeInUsd: number; tp: number; sl: number } | null = null;

  const closeTrade = (xp: number, xt: number, reason: BacktestTrade['reason']) => {
    if (!pos) return;
    const delta = pos.side === 'LONG' ? (xp - pos.ep)/pos.ep : (pos.ep - xp)/pos.ep;
    const pnl = pos.sizeInUsd * delta - pos.sizeInUsd * (feePct/100);
    const pct = (pnl / pos.sizeInUsd) * 100;
    equity += pnl;
    trades.push({ entryTime:pos.et, exitTime:xt, side:pos.side, entryPrice:pos.ep, exitPrice:xp, pnl, pnlPct:pct, reason });
    pos = null;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity)/peak)*100;
    if (dd > maxDD) maxDD = dd;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      if (pos.side === 'LONG') {
        if (c.high >= pos.tp) closeTrade(pos.tp, c.time, 'TP');
        else if (c.low <= pos.sl) closeTrade(pos.sl, c.time, 'SL');
      } else {
        if (c.low <= pos.tp) closeTrade(pos.tp, c.time, 'TP');
        else if (c.high >= pos.sl) closeTrade(pos.sl, c.time, 'SL');
      }
    }
    if (pos) {
      if (pos.side === 'LONG' && sc[i] < 0) closeTrade(c.close, c.time, 'SIGNAL');
      else if (pos.side === 'SHORT' && sc[i] > 0) closeTrade(c.close, c.time, 'SIGNAL');
    }
    if (!pos && sc[i] !== 0) {
      const side = sc[i] > 0 ? 'LONG' : 'SHORT';
      const sizeInUsd = equity * positionSizePct;
      equity -= sizeInUsd * (feePct / 100);
      const tp = side === 'LONG' ? c.close*(1+tpPct/100) : c.close*(1-tpPct/100);
      const sl = side === 'LONG' ? c.close*(1-slPct/100) : c.close*(1+slPct/100);
      pos = { side, ep: c.close, et: c.time, sizeInUsd, tp, sl };
    }
    const unreal = pos
      ? pos.sizeInUsd * (pos.side==='LONG' ? (c.close-pos.ep)/pos.ep : (pos.ep-c.close)/pos.ep)
      : 0;
    curve.push({ time: c.time, equity: equity + unreal });
  }
  if (pos) { const l = candles[candles.length-1]; closeTrade(l.close, l.time, 'SIGNAL'); }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s,t) => s+t.pnl, 0), gl = Math.abs(losses.reduce((s,t) => s+t.pnl, 0));
  return {
    totalReturnPct: ((equity-initialCapital)/initialCapital)*100,
    winRate: trades.length ? (wins.length/trades.length)*100 : 0,
    maxDrawdownPct: maxDD, tradeCount: trades.length,
    profitFactor: gl > 0 ? gp/gl : gp > 0 ? Infinity : 0,
    avgWinPct:  wins.length   ? wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length   : 0,
    avgLossPct: losses.length ? losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length : 0,
    equityCurve: curve, trades, finalEquity: equity,
  };
}

/**
 * Parse GMX candles API response → typed Candle objects.
 * GMX format: [timestamp_sec, open, high, low, close, volume] (all numbers)
 */
export function parseGmxCandles(raw: number[][]): Candle[] {
  return raw.map(k => ({
    time:   k[0] * 1000,   // seconds → ms
    open:   k[1],
    high:   k[2],
    low:    k[3],
    close:  k[4],
    volume: k[5] ?? 0,
  }));
}

/** Convert mobile StrategyContext config → BacktestIndicatorConfig */
export function mobileStrategyToBacktestConfig(cfg: {
  ema:   { enabled: boolean; fastPeriod: number; slowPeriod: number };
  rsi:   { enabled: boolean; period: number; overbought: number; oversold: number };
  macd:  { enabled: boolean; fast: number; slow: number; signal: number };
  bollingerBands: { enabled: boolean; period: number; deviation: number };
  volumeBreakout: { enabled: boolean; multiplier: number };
}): BacktestIndicatorConfig {
  return {
    ema:  { enabled: cfg.ema.enabled,   fast: cfg.ema.fastPeriod, slow: cfg.ema.slowPeriod },
    rsi:  { enabled: cfg.rsi.enabled,   period: cfg.rsi.period, overbought: cfg.rsi.overbought, oversold: cfg.rsi.oversold },
    macd: { enabled: cfg.macd.enabled,  fast: cfg.macd.fast,    slow: cfg.macd.slow, signal: cfg.macd.signal },
    bb:   { enabled: cfg.bollingerBands.enabled, period: cfg.bollingerBands.period, deviation: cfg.bollingerBands.deviation },
    vol:  { enabled: cfg.volumeBreakout.enabled, multiplier: cfg.volumeBreakout.multiplier },
  };
}
