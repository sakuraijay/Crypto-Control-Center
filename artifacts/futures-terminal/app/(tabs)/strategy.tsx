import React from 'react';
import { Platform, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useStrategy } from '@/contexts/StrategyContext';
import type { IndicatorConfig, RiskLimits } from '@/contexts/StrategyContext';

// ── Indicator row ─────────────────────────────────────────────────────────────
interface IndRowProps {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}
function IndRow({ title, description, enabled, onToggle, children }: IndRowProps) {
  const colors = useColors();
  return (
    <View style={[styles.indRow, { borderBottomColor: colors.border }]}>
      <View style={styles.indTop}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.indTitle, { color: colors.foreground }]}>{title}</Text>
          <Text style={[styles.indDesc, { color: colors.mutedForeground }]}>{description}</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={v => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onToggle(v); }}
          trackColor={{ false: '#2A2D3A', true: '#00C4FF44' }}
          thumbColor={enabled ? '#00C4FF' : '#6B7280'}
        />
      </View>
      {enabled && children ? (
        <View style={[styles.indParams, { backgroundColor: '#0A0B0E55' }]}>{children}</View>
      ) : null}
    </View>
  );
}

// ── Parameter chip ─────────────────────────────────────────────────────────────
interface ParamChipProps { label: string; value: string }
function ParamChip({ label, value }: ParamChipProps) {
  const colors = useColors();
  return (
    <View style={[styles.chip, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[styles.chipLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.chipValue, { color: colors.primary }]}>{value}</Text>
    </View>
  );
}

// ── Risk row ──────────────────────────────────────────────────────────────────
interface RiskRowProps {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}
function RiskRow({ label, value, unit, step, min, max, onChange }: RiskRowProps) {
  const colors = useColors();
  const dec = () => { const v = Math.max(min, value - step); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onChange(v); };
  const inc = () => { const v = Math.min(max, value + step); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onChange(v); };
  return (
    <View style={[styles.riskRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.riskLabel, { color: colors.foreground, flex: 1 }]}>{label}</Text>
      <View style={styles.riskCtrl}>
        <TouchableOpacity onPress={dec} style={[styles.riskBtn, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.riskBtnTxt, { color: colors.foreground }]}>−</Text>
        </TouchableOpacity>
        <View style={[styles.riskValBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Text style={[styles.riskVal, { color: colors.primary }]}>
            {unit === '$' ? `$${value.toLocaleString()}` : unit === '%' ? `${value}%` : unit === 'x' ? `${value}x` : `${value} ${unit}`}
          </Text>
        </View>
        <TouchableOpacity onPress={inc} style={[styles.riskBtn, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.riskBtnTxt, { color: colors.foreground }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return (
    <View style={[styles.secHeader, { borderBottomColor: colors.border }]}>
      <Text style={[styles.secTitle, { color: colors.mutedForeground }]}>{title}</Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function StrategyScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { config, updateIndicator, updateRiskLimit, resetToDefaults } = useStrategy();
  const ind = config.indicators;
  const risk = config.riskLimits;

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);

  function updInd<K extends keyof IndicatorConfig>(key: K, patch: Partial<IndicatorConfig[K]>) {
    updateIndicator(key, patch);
  }
  function updRisk<K extends keyof RiskLimits>(key: K, val: RiskLimits[K]) {
    updateRiskLimit(key, val);
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Strategy</Text>
        <TouchableOpacity onPress={resetToDefaults} style={[styles.resetBtn, { borderColor: colors.border }]}>
          <Text style={[styles.resetTxt, { color: colors.mutedForeground }]}>Reset</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 0) + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── INDICATORS ─── */}
        <SectionHeader title="INDICATORS" />

        <IndRow title="EMA Crossover" description="Fast/slow exponential moving average cross"
          enabled={ind.ema.enabled} onToggle={v => updInd('ema', { enabled: v })}>
          <ParamChip label="Fast" value={`${ind.ema.fastPeriod}`} />
          <ParamChip label="Slow" value={`${ind.ema.slowPeriod}`} />
        </IndRow>

        <IndRow title="RSI" description="Relative strength index overbought/oversold"
          enabled={ind.rsi.enabled} onToggle={v => updInd('rsi', { enabled: v })}>
          <ParamChip label="Period" value={`${ind.rsi.period}`} />
          <ParamChip label="OB" value={`${ind.rsi.overbought}`} />
          <ParamChip label="OS" value={`${ind.rsi.oversold}`} />
        </IndRow>

        <IndRow title="MACD" description="Moving average convergence divergence"
          enabled={ind.macd.enabled} onToggle={v => updInd('macd', { enabled: v })}>
          <ParamChip label="Fast" value={`${ind.macd.fast}`} />
          <ParamChip label="Slow" value={`${ind.macd.slow}`} />
          <ParamChip label="Signal" value={`${ind.macd.signal}`} />
        </IndRow>

        <IndRow title="Bollinger Bands" description="Volatility bands for breakout signals"
          enabled={ind.bollingerBands.enabled} onToggle={v => updInd('bollingerBands', { enabled: v })}>
          <ParamChip label="Period" value={`${ind.bollingerBands.period}`} />
          <ParamChip label="Deviation" value={`${ind.bollingerBands.deviation}σ`} />
        </IndRow>

        <IndRow title="Volume Breakout" description="Trigger on volume spike above average"
          enabled={ind.volumeBreakout.enabled} onToggle={v => updInd('volumeBreakout', { enabled: v })}>
          <ParamChip label="Multiplier" value={`${ind.volumeBreakout.multiplier}x`} />
        </IndRow>

        <IndRow title="Price Breakout" description="Break above/below recent range highs/lows"
          enabled={ind.priceBreakout.enabled} onToggle={v => updInd('priceBreakout', { enabled: v })}>
          <ParamChip label="Lookback" value={`${ind.priceBreakout.lookback} bars`} />
        </IndRow>

        <IndRow title="Multi-Timeframe Trend" description="Require agreement across 1H, 4H, 1D"
          enabled={ind.multiTimeframeTrend.enabled} onToggle={v => updInd('multiTimeframeTrend', { enabled: v })} />

        <IndRow title="Funding Rate Filter" description="Skip entries during extreme funding rates"
          enabled={ind.fundingRateFilter.enabled} onToggle={v => updInd('fundingRateFilter', { enabled: v })}>
          <ParamChip label="Max Rate" value={`${ind.fundingRateFilter.maxRate}%`} />
        </IndRow>

        <IndRow title="BTC Direction Filter" description="Only trade in BTC's higher-TF direction"
          enabled={ind.btcDirectionFilter.enabled} onToggle={v => updInd('btcDirectionFilter', { enabled: v })} />

        <IndRow title="Combined Scoring" description="Require minimum aggregate score to enter"
          enabled={ind.combinedScoring.enabled} onToggle={v => updInd('combinedScoring', { enabled: v })}>
          <ParamChip label="Min Score" value={`${ind.combinedScoring.minScore}/100`} />
        </IndRow>

        {/* ── RISK LIMITS ─── */}
        <SectionHeader title="RISK LIMITS" />

        <RiskRow label="Max Total Exposure" value={risk.maxTotalExposureUSDT} unit="$" step={500} min={500} max={50000}
          onChange={v => updRisk('maxTotalExposureUSDT', v)} />
        <RiskRow label="Max Margin Per Trade" value={risk.maxMarginPerTrade} unit="$" step={50} min={50} max={5000}
          onChange={v => updRisk('maxMarginPerTrade', v)} />
        <RiskRow label="Max Leverage" value={risk.maxLeverage} unit="x" step={1} min={1} max={125}
          onChange={v => updRisk('maxLeverage', v)} />
        <RiskRow label="Max Simultaneous Positions" value={risk.maxSimultaneousPositions} unit="pos" step={1} min={1} max={20}
          onChange={v => updRisk('maxSimultaneousPositions', v)} />
        <RiskRow label="Daily Loss Limit" value={risk.dailyLossLimitUSDT} unit="$" step={100} min={100} max={10000}
          onChange={v => updRisk('dailyLossLimitUSDT', v)} />
        <RiskRow label="Weekly Loss Limit" value={risk.weeklyLossLimitUSDT} unit="$" step={200} min={200} max={20000}
          onChange={v => updRisk('weeklyLossLimitUSDT', v)} />
        <RiskRow label="Max Drawdown" value={risk.maxDrawdownPercent} unit="%" step={1} min={1} max={50}
          onChange={v => updRisk('maxDrawdownPercent', v)} />
        <RiskRow label="Consecutive Loss Limit" value={risk.consecutiveLossLimit} unit="trades" step={1} min={1} max={20}
          onChange={v => updRisk('consecutiveLossLimit', v)} />
        <RiskRow label="Cooldown Period" value={risk.cooldownMinutes} unit="min" step={5} min={0} max={240}
          onChange={v => updRisk('cooldownMinutes', v)} />
        <RiskRow label="Max Trades Per Hour" value={risk.maxTradesPerHour} unit="trades" step={1} min={1} max={60}
          onChange={v => updRisk('maxTradesPerHour', v)} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  resetBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  resetTxt: { fontFamily: 'Inter_500Medium', fontSize: 13 },
  scroll: { flex: 1 },
  content: { paddingBottom: 40 },
  secHeader: {
    paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1,
    marginTop: 8,
  },
  secTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.2 },
  indRow: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  indTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  indTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  indDesc: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  indParams: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, padding: 10, borderRadius: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1,
  },
  chipLabel: { fontFamily: 'Inter_500Medium', fontSize: 10 },
  chipValue: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  riskRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1,
  },
  riskLabel: { fontFamily: 'Inter_500Medium', fontSize: 14 },
  riskCtrl: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  riskBtn: {
    width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  riskBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 18 },
  riskValBox: {
    minWidth: 86, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1, alignItems: 'center',
  },
  riskVal: { fontFamily: 'Inter_700Bold', fontSize: 13 },
});
