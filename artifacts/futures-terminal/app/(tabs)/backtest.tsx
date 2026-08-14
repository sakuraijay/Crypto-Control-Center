import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useStrategy } from '@/contexts/StrategyContext';
import {
  runBacktest, parseGmxCandles,
  mobileStrategyToBacktestConfig,
  type BacktestResult, type BacktestTrade,
} from '@/utils/backtestEngine';

const SYMBOLS = ['BTC','ETH','SOL','ARB','LINK','AVAX','DOGE'];
const INTERVALS = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
];
const PERIODS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
];

function fmt(n: number, d = 2) { return n.toFixed(d); }
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${fmt(n)}%`; }

export default function BacktestScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { config } = useStrategy();

  const [symbol,   setSymbol]   = useState('BTC');
  const [interval, setInterval] = useState('1h');
  const [period,   setPeriod]   = useState(90);
  const [capital,  setCapital]  = useState('10000');
  const [tpPct,    setTpPct]    = useState('2');
  const [slPct,    setSlPct]    = useState('1');

  const [result,     setResult]     = useState<BacktestResult | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [dataSource, setDataSource] = useState<string>('');

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    setResult(null);
    setDataSource('');

    try {
      const limitMap: Record<string, number> = { '1h': 500, '4h': 500, '1d': 365 };
      const countBack = Math.min(
        limitMap[interval] ?? 500,
        Math.ceil(period * 24 / (interval === '1d' ? 24 : interval === '4h' ? 4 : 1)),
      );

      // Use API server proxy — avoids CORS and centralises GMX access
      const apiBase = process.env.EXPO_PUBLIC_API_BASE ?? '';
      const url = `${apiBase}/api-server/api/gmx/candles?symbol=${symbol}&period=${interval}&countBack=${countBack}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GMX candle fetch failed: ${res.status}`);
      const data = await res.json() as { prices: number[][]; source: string };
      if (!data.prices?.length) throw new Error('No candle data returned');

      setDataSource(data.source);
      const candles = parseGmxCandles(data.prices);
      const btResult = runBacktest(candles, {
        indicators: mobileStrategyToBacktestConfig(config.indicators as any),
        initialCapital: parseFloat(capital) || 10000,
        tpPct: parseFloat(tpPct) || 2,
        slPct: parseFloat(slPct) || 1,
        feePct: 0.06,         // GMX taker fee
        positionSizePct: 0.10,
      });
      setResult(btResult);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Backtest failed');
    } finally {
      setLoading(false);
    }
  }, [symbol, interval, period, capital, tpPct, slPct, config]);

  // Simple equity sparkline using Views
  const renderSparkline = (curve: BacktestResult['equityCurve'], initialCap: number) => {
    if (!curve.length) return null;
    const step = Math.max(1, Math.floor(curve.length / 60));
    const sampled = curve.filter((_, i) => i % step === 0);
    const values = sampled.map(p => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const HEIGHT = 80;

    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: HEIGHT, gap: 1, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, right: 0,
          top: HEIGHT - ((initialCap - min) / range) * HEIGHT,
          height: 1, backgroundColor: colors.mutedForeground + '40' }} />
        {sampled.map((p, i) => {
          const h = Math.max(2, ((p.equity - min) / range) * HEIGHT);
          const isGain = p.equity >= initialCap;
          return (
            <View key={i} style={{
              flex: 1, height: h,
              backgroundColor: isGain ? '#10b981' : '#ef4444',
              borderRadius: 1, opacity: 0.85,
            }} />
          );
        })}
      </View>
    );
  };

  const pos = result ? result.totalReturnPct >= 0 : null;

  return (
    <ScrollView
      style={[s.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 100, paddingHorizontal: 16 }}
    >
      {/* Header */}
      <Text style={[s.title, { color: colors.foreground }]}>Backtest</Text>
      <Text style={[s.sub, { color: colors.mutedForeground }]}>
        Simulate strategy against GMX V2 historical data · Arbitrum One
      </Text>

      {/* Config card */}
      <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {/* Symbol row */}
        <Text style={[s.label, { color: colors.mutedForeground }]}>SYMBOL</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {SYMBOLS.map(sym => (
              <TouchableOpacity key={sym} onPress={() => setSymbol(sym)}
                style={[s.chip, { borderColor: symbol === sym ? colors.primary : colors.border,
                  backgroundColor: symbol === sym ? colors.primary + '18' : 'transparent' }]}>
                <Text style={[s.chipTxt, { color: symbol === sym ? colors.primary : colors.mutedForeground }]}>
                  {sym}/USD
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* Interval + Period */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.label, { color: colors.mutedForeground }]}>INTERVAL</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {INTERVALS.map(iv => (
                <TouchableOpacity key={iv.value} onPress={() => setInterval(iv.value)}
                  style={[s.chip, { borderColor: interval === iv.value ? colors.primary : colors.border,
                    backgroundColor: interval === iv.value ? colors.primary + '18' : 'transparent' }]}>
                  <Text style={[s.chipTxt, { color: interval === iv.value ? colors.primary : colors.mutedForeground }]}>
                    {iv.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.label, { color: colors.mutedForeground }]}>PERIOD</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {PERIODS.map(p => (
                <TouchableOpacity key={p.days} onPress={() => setPeriod(p.days)}
                  style={[s.chip, { borderColor: period === p.days ? colors.primary : colors.border,
                    backgroundColor: period === p.days ? colors.primary + '18' : 'transparent' }]}>
                  <Text style={[s.chipTxt, { color: period === p.days ? colors.primary : colors.mutedForeground }]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Capital + TP/SL */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
          <View style={{ flex: 2 }}>
            <Text style={[s.label, { color: colors.mutedForeground }]}>CAPITAL (USDC)</Text>
            <TextInput value={capital} onChangeText={setCapital} keyboardType="numeric"
              style={[s.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.label, { color: colors.mutedForeground }]}>TP %</Text>
            <TextInput value={tpPct} onChangeText={setTpPct} keyboardType="numeric"
              style={[s.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.label, { color: colors.mutedForeground }]}>SL %</Text>
            <TextInput value={slPct} onChangeText={setSlPct} keyboardType="numeric"
              style={[s.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
          </View>
        </View>

        {/* Run button */}
        <TouchableOpacity onPress={run} disabled={loading}
          style={[s.runBtn, { backgroundColor: colors.primary, opacity: loading ? 0.6 : 1 }]}>
          {loading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={s.runBtnTxt}>Run Backtest</Text>}
        </TouchableOpacity>
      </View>

      {/* Data source badge */}
      {dataSource ? (
        <View style={{ marginBottom: 8, alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 10, color: dataSource === 'synthetic' ? '#f59e0b' : '#10b981' }}>
            {dataSource === 'synthetic' ? '⚠ Synthetic data' : '✓ GMX live data'}
          </Text>
        </View>
      ) : null}

      {/* Error */}
      {!!error && (
        <View style={[s.card, { backgroundColor: '#ef444418', borderColor: '#ef444440' }]}>
          <Text style={{ color: '#ef4444', fontSize: 13 }}>{error}</Text>
        </View>
      )}

      {/* Results */}
      {result && !loading && (
        <>
          {/* Equity sparkline */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={[s.sectionTitle, { color: colors.foreground }]}>Equity Curve</Text>
              <Text style={[{ color: pos ? '#10b981' : '#ef4444', fontWeight: '700', fontSize: 15 }]}>
                {fmtPct(result.totalReturnPct)}
              </Text>
            </View>
            {renderSparkline(result.equityCurve, parseFloat(capital) || 10000)}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={[s.micro, { color: colors.mutedForeground }]}>
                Start: ${(parseFloat(capital)||10000).toLocaleString()}
              </Text>
              <Text style={[s.micro, { color: colors.mutedForeground }]}>
                End: ${result.finalEquity.toLocaleString('en', { maximumFractionDigits: 0 })}
              </Text>
            </View>
          </View>

          {/* Metric grid */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            {[
              { label: 'Win Rate',      value: `${fmt(result.winRate)}%`,        color: result.winRate >= 50 ? '#10b981' : '#ef4444' },
              { label: 'Max Drawdown',  value: `-${fmt(result.maxDrawdownPct)}%`, color: result.maxDrawdownPct < 10 ? '#10b981' : '#ef4444' },
              { label: 'Trade Count',   value: String(result.tradeCount),         color: colors.foreground },
              { label: 'Profit Factor', value: result.profitFactor === Infinity ? '∞' : fmt(result.profitFactor), color: result.profitFactor >= 1.5 ? '#10b981' : '#ef4444' },
              { label: 'Avg Win',       value: fmtPct(result.avgWinPct),         color: '#10b981' },
              { label: 'Avg Loss',      value: fmtPct(result.avgLossPct),        color: '#ef4444' },
            ].map(m => (
              <View key={m.label} style={[s.metricCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[s.micro, { color: colors.mutedForeground, marginBottom: 2 }]}>{m.label}</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: m.color, fontVariant: ['tabular-nums'] as any }}>
                  {m.value}
                </Text>
              </View>
            ))}
          </View>

          {/* Trade list (last 20) */}
          {result.trades.length > 0 && (
            <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[s.sectionTitle, { color: colors.foreground, marginBottom: 8 }]}>
                Trades ({result.tradeCount})
              </Text>
              {result.trades.slice(0, 20).map((t: BacktestTrade, i: number) => (
                <View key={i} style={[s.tradeRow, { borderBottomColor: colors.border }]}>
                  <Text style={[s.micro, { color: t.side === 'LONG' ? '#10b981' : '#ef4444', width: 40 }]}>
                    {t.side}
                  </Text>
                  <Text style={[s.micro, { color: colors.mutedForeground, flex: 1 }]}>
                    {new Date(t.entryTime).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </Text>
                  <Text style={[s.micro, { color: t.pnl >= 0 ? '#10b981' : '#ef4444', fontWeight: '600' }]}>
                    {fmtPct(t.pnlPct)}
                  </Text>
                  <Text style={[s.micro, { color: colors.mutedForeground, width: 48, textAlign: 'right' }]}>
                    {t.reason}
                  </Text>
                </View>
              ))}
              {result.trades.length > 20 && (
                <Text style={[s.micro, { color: colors.mutedForeground, textAlign: 'center', marginTop: 8 }]}>
                  + {result.trades.length - 20} more trades
                </Text>
              )}
            </View>
          )}
        </>
      )}

      {/* Empty state */}
      {!result && !loading && !error && (
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center', paddingVertical: 32 }]}>
          <Text style={{ fontSize: 32, marginBottom: 8 }}>📊</Text>
          <Text style={[s.sub, { color: colors.mutedForeground, textAlign: 'center' }]}>
            Configure settings above and tap Run Backtest
          </Text>
          <Text style={[s.micro, { color: colors.mutedForeground, textAlign: 'center', marginTop: 4 }]}>
            Data: GMX V2 · Arbitrum One
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1 },
  title:        { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  sub:          { fontSize: 13, marginBottom: 16 },
  card:         { borderRadius: 12, borderWidth: 1, padding: 16, marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  label:        { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  chip:         { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  chipTxt:      { fontSize: 12, fontWeight: '500' },
  input:        { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  runBtn:       { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  runBtnTxt:    { color: '#fff', fontWeight: '700', fontSize: 15 },
  metricCard:   { borderRadius: 10, borderWidth: 1, padding: 12, width: '48%' },
  micro:        { fontSize: 11 },
  tradeRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1 },
});
