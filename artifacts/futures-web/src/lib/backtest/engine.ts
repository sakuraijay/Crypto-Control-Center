/**
 * Client-side backtesting engine.
 * Replays GMX V2 OHLCV candle data against the current strategy indicator
 * settings and returns full metrics + equity curve.
 *
 * No live trading — paper/simulation only.
 */

export interface Candle {
  time: number; // openTime ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestIndicatorConfig {
  ema:   { enabled: boolean; fast: number; slow: number };
  rsi:   { enabled: boolean; period: number; overbought: number; oversold: number };
  macd:  { enabled: boolean; fast: number; slow: number; signal: number };
  bb:    { enabled: boolean; period: number; deviation: number };
  vol:   { enabled: boolean; multiplier: number };
}

export interface BacktestConfig {
  indicators: BacktestIndicatorConfig;
  initialCapital: number;
  tpPct: number;   // e.g. 2 = 2%
  slPct: number;   // e.g. 1 = 1%
  feePct: number;  // e.g. 0.04 = 0.04% per side
  positionSizePct: number; // fraction of equity per trade, e.g. 0.1 = 10%
}

export interface BacktestTrade {
  entryTime:  number;
  exitTime:   number;
  side:       'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice:  number;
  pnl:        number;
  pnlPct:     number;
  reason:     'SIGNAL' | 'TP' | 'SL';
}

export interface BacktestResult {
  totalReturnPct:  number;
  winRate:         number;
  maxDrawdownPct:  number;
  tradeCount:      number;
  profitFactor:    number;
  avgWinPct:       number;
  avgLossPct:      number;
  equityCurve:     Array<{ time: number; equity: number }>;
  trades:          BacktestTrade[];
  finalEquity:     number;
}

// ── Indicator math ────────────────────────────────────────────────

function calcEma(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema = new Array(values.length).fill(NaN);
  if (values.length < period) return ema;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRsi(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMacd(closes: number[], fast: number, slow: number, sigPeriod: number) {
  const emaFast = calcEma(closes, fast);
  const emaSlow = calcEma(closes, slow);
  const macdLine = closes.map((_, i) =>
    isNaN(emaFast[i]) || isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i],
  );
  const validStart = slow - 1;
  const sigInput = macdLine.slice(validStart).map(v => isNaN(v) ? 0 : v);
  const sigShort = calcEma(sigInput, sigPeriod);
  const sigLine = new Array(validStart).fill(NaN).concat(sigShort);
  return { macdLine, sigLine };
}

function calcBB(closes: number[], period: number, deviation: number) {
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period);
    upper[i] = mean + deviation * std;
    lower[i] = mean - deviation * std;
  }
  return { upper, lower };
}

function calcAvgVolume(volumes: number[], period: number): number[] {
  const avg = new Array(volumes.length).fill(NaN);
  for (let i = period - 1; i < volumes.length; i++) {
    avg[i] = volumes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  }
  return avg;
}

// ── Signal generation ─────────────────────────────────────────────

/**
 * Returns per-candle signal score.
 * +1 per bullish indicator, -1 per bearish. 0 = neutral.
 * Net > 0 → LONG bias, net < 0 → SHORT bias.
 */
function generateSignalScores(candles: Candle[], cfg: BacktestIndicatorConfig): number[] {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n = candles.length;
  const scores = new Array(n).fill(0);

  if (cfg.ema.enabled) {
    const fast = calcEma(closes, cfg.ema.fast);
    const slow = calcEma(closes, cfg.ema.slow);
    for (let i = 0; i < n; i++) {
      if (isNaN(fast[i]) || isNaN(slow[i])) continue;
      scores[i] += fast[i] > slow[i] ? 1 : -1;
    }
  }

  if (cfg.rsi.enabled) {
    const rsi = calcRsi(closes, cfg.rsi.period);
    for (let i = 0; i < n; i++) {
      if (isNaN(rsi[i])) continue;
      if (rsi[i] < cfg.rsi.oversold)       scores[i] += 1;
      else if (rsi[i] > cfg.rsi.overbought) scores[i] -= 1;
    }
  }

  if (cfg.macd.enabled) {
    const { macdLine, sigLine } = calcMacd(closes, cfg.macd.fast, cfg.macd.slow, cfg.macd.signal);
    for (let i = 0; i < n; i++) {
      if (isNaN(macdLine[i]) || isNaN(sigLine[i])) continue;
      scores[i] += macdLine[i] > sigLine[i] ? 1 : -1;
    }
  }

  if (cfg.bb.enabled) {
    const { upper, lower } = calcBB(closes, cfg.bb.period, cfg.bb.deviation);
    for (let i = 0; i < n; i++) {
      if (isNaN(upper[i])) continue;
      if (closes[i] < lower[i])      scores[i] += 1;
      else if (closes[i] > upper[i]) scores[i] -= 1;
    }
  }

  if (cfg.vol.enabled) {
    const avgVol = calcAvgVolume(volumes, 20);
    const emaTrend = cfg.ema.enabled ? calcEma(closes, cfg.ema.slow) : new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (isNaN(avgVol[i])) continue;
      if (volumes[i] > avgVol[i] * cfg.vol.multiplier) {
        const trend = isNaN(emaTrend[i]) ? 0 : closes[i] > emaTrend[i] ? 1 : -1;
        scores[i] += trend;
      }
    }
  }

  return scores;
}

// ── Trade simulation ──────────────────────────────────────────────

export function runBacktest(candles: Candle[], bcfg: BacktestConfig): BacktestResult {
  const { indicators, initialCapital, tpPct, slPct, feePct, positionSizePct } = bcfg;
  const scores = generateSignalScores(candles, indicators);

  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];

  let equity = initialCapital;
  let position: {
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    entryTime: number;
    sizeInUsd: number; // USD value of position
    tp: number;
    sl: number;
  } | null = null;

  let peakEquity = initialCapital;
  let maxDrawdown = 0;

  const closeTrade = (
    exitPrice: number,
    exitTime: number,
    reason: 'SIGNAL' | 'TP' | 'SL',
  ) => {
    if (!position) return;
    const { side, entryPrice, entryTime, sizeInUsd } = position;
    // For perp simulation: PnL = size * (exit - entry) / entry (for LONG)
    const priceDelta = side === 'LONG'
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;
    const rawPnl = sizeInUsd * priceDelta;
    const feesCost = sizeInUsd * (feePct / 100);
    const netPnl = rawPnl - feesCost;
    const pnlPct = (netPnl / sizeInUsd) * 100;

    equity += netPnl;
    trades.push({ entryTime, exitTime, side, entryPrice, exitPrice, pnl: netPnl, pnlPct, reason });
    position = null;

    if (equity > peakEquity) peakEquity = equity;
    const dd = ((peakEquity - equity) / peakEquity) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Check TP/SL on current candle using high/low
    if (position) {
      if (position.side === 'LONG') {
        if (c.high >= position.tp) { closeTrade(position.tp, c.time, 'TP'); }
        else if (c.low <= position.sl) { closeTrade(position.sl, c.time, 'SL'); }
      } else {
        if (c.low <= position.tp)  { closeTrade(position.tp, c.time, 'TP'); }
        else if (c.high >= position.sl) { closeTrade(position.sl, c.time, 'SL'); }
      }
    }

    const score = scores[i];

    // Flip on opposite signal
    if (position) {
      if (position.side === 'LONG' && score < 0) closeTrade(c.close, c.time, 'SIGNAL');
      else if (position.side === 'SHORT' && score > 0) closeTrade(c.close, c.time, 'SIGNAL');
    }

    // Open new position
    if (!position && score !== 0) {
      const side: 'LONG' | 'SHORT' = score > 0 ? 'LONG' : 'SHORT';
      const sizeInUsd = equity * positionSizePct;
      const entryFee = sizeInUsd * (feePct / 100);
      equity -= entryFee;

      const tp = side === 'LONG' ? c.close * (1 + tpPct / 100) : c.close * (1 - tpPct / 100);
      const sl = side === 'LONG' ? c.close * (1 - slPct / 100) : c.close * (1 + slPct / 100);

      position = { side, entryPrice: c.close, entryTime: c.time, sizeInUsd, tp, sl };
    }

    // Unrealised equity mark
    const unreal = position
      ? position.sizeInUsd * (position.side === 'LONG'
          ? (c.close - position.entryPrice) / position.entryPrice
          : (position.entryPrice - c.close) / position.entryPrice)
      : 0;
    equityCurve.push({ time: c.time, equity: equity + unreal });
  }

  // Close any open position at last candle close
  if (position) {
    const last = candles[candles.length - 1];
    closeTrade(last.close, last.time, 'SIGNAL');
  }

  // Metrics
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    totalReturnPct:  ((equity - initialCapital) / initialCapital) * 100,
    winRate:         trades.length ? (wins.length / trades.length) * 100 : 0,
    maxDrawdownPct:  maxDrawdown,
    tradeCount:      trades.length,
    profitFactor:    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWinPct:       wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0,
    avgLossPct:      losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0,
    equityCurve,
    trades,
    finalEquity: equity,
  };
}

/**
 * Parse GMX candles API response → typed Candle objects.
 * GMX format: [timestamp_sec, open, high, low, close, volume] (all numbers)
 */
export function parseGmxCandles(raw: number[][]): Candle[] {
  return raw.map(k => ({
    time:   k[0] * 1000,  // seconds → ms
    open:   k[1],
    high:   k[2],
    low:    k[3],
    close:  k[4],
    volume: k[5] ?? 0,
  }));
}

/** Convert web StrategyContext indicator array → BacktestIndicatorConfig */
export function webIndicatorsToBacktestConfig(
  indicators: Array<{ id: string; enabled: boolean; params: Record<string, string | number> }>
): BacktestIndicatorConfig {
  const get = (id: string) => indicators.find(i => i.id === id);
  const ema   = get('ema');
  const rsi   = get('rsi');
  const macd  = get('macd');
  const bb    = get('bb');
  const vol   = get('vol');

  return {
    ema:  { enabled: ema?.enabled ?? true,  fast: Number(ema?.params.fast ?? 9),    slow: Number(ema?.params.slow ?? 21) },
    rsi:  { enabled: rsi?.enabled ?? true,  period: Number(rsi?.params.period ?? 14), overbought: Number(rsi?.params.OB ?? 70), oversold: Number(rsi?.params.OS ?? 30) },
    macd: { enabled: macd?.enabled ?? false, fast: Number(macd?.params.fast ?? 12), slow: Number(macd?.params.slow ?? 26), signal: Number(macd?.params.signal ?? 9) },
    bb:   { enabled: bb?.enabled ?? false,   period: Number(bb?.params.period ?? 20), deviation: Number(bb?.params.deviation ?? 2) },
    vol:  { enabled: vol?.enabled ?? true,   multiplier: Number(vol?.params.multiplier ?? 2) },
  };
}
