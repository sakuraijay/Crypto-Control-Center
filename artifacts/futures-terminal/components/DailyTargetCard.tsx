/**
 * DailyTargetCard — mobile (React Native)
 *
 * Displays daily profit KPI progress on the dashboard.
 *
 * ⚠️  IMPORTANT: dailyTargetUSDT is a MONITORING KPI only.
 *     It never mandates extra trades, larger leverage, or risk escalation.
 *     The Risk Engine retains absolute veto authority in all circumstances.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTrading } from '@/contexts/TradingContext';
import { useVps } from '@/contexts/VpsContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Config hook ───────────────────────────────────────────────────────────────

const STORAGE_KEY = '@futures_daily_target_config';
const DEFAULT_CONFIG = { startingCapital: 10_000, dailyTargetUSDT: 500 };

interface DailyConfig { startingCapital: number; dailyTargetUSDT: number }

function useDailyConfig(): DailyConfig {
  const [cfg, setCfg] = useState<DailyConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    // Load from cache first
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) setCfg(JSON.parse(raw));
    });
    // Fetch from strategy API (same limits object as web)
    const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
      ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
      : '/api-server/api';
    fetch(`${API_BASE}/data/strategy`, { signal: AbortSignal.timeout(6_000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.limits) return;
        const next: DailyConfig = {
          startingCapital: data.limits.startingCapital  ?? DEFAULT_CONFIG.startingCapital,
          dailyTargetUSDT: data.limits.dailyTargetUSDT  ?? DEFAULT_CONFIG.dailyTargetUSDT,
        };
        setCfg(next);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      })
      .catch(() => {});
  }, []);

  return cfg;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type DailyState = 'REACHED' | 'ON_TRACK' | 'DRAWDOWN' | 'HALTED';

function deriveState(
  realized: number,
  totalPnL: number,
  target: number,
  halted: boolean,
): DailyState {
  if (halted)               return 'HALTED';
  if (realized >= target)   return 'REACHED';
  if (totalPnL < 0)         return 'DRAWDOWN';
  return 'ON_TRACK';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPnl(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

// ── Main component ────────────────────────────────────────────────────────────

export function DailyTargetCard() {
  const colors  = useColors();
  const { account } = useTrading();
  const { operatingMode } = useVps();
  const cfg = useDailyConfig();

  const realized   = account.realizedPnlToday ?? 0;
  const unrealized = account.unrealizedPnl    ?? 0;
  const totalPnL   = realized + unrealized;

  const { startingCapital, dailyTargetUSDT: target } = cfg;

  const isHalted   = operatingMode === 'RISK_LOCKED';
  const state      = deriveState(realized, totalPnL, target, isHalted);

  const achievedPct  = target > 0 ? Math.max(0, Math.min(100, (realized / target) * 100)) : 0;
  const totalPct     = target > 0 ? Math.max(0, Math.min(100, (totalPnL / target) * 100)) : 0;
  const remaining    = Math.max(0, target - realized);
  const drawdownUSDT = Math.min(0, totalPnL);
  const drawdownPct  = startingCapital > 0 ? (Math.abs(drawdownUSDT) / startingCapital) * 100 : 0;

  // Colors
  const progressColor =
    state === 'REACHED'  ? '#f59e0b' :
    state === 'DRAWDOWN' || state === 'HALTED' ? colors.short :
    colors.long;

  const stateLabel: Record<DailyState, string> = {
    REACHED:  '✓ TARGET REACHED',
    ON_TRACK: '↑ ON TRACK',
    DRAWDOWN: '↓ DAILY DRAWDOWN',
    HALTED:   '⚠ TRADING HALTED',
  };

  const stateBg: Record<DailyState, string> = {
    REACHED:  '#f59e0b22',
    ON_TRACK: colors.long + '22',
    DRAWDOWN: colors.short + '22',
    HALTED:   colors.short + '22',
  };

  const stateTextColor: Record<DailyState, string> = {
    REACHED:  '#f59e0b',
    ON_TRACK: colors.long,
    DRAWDOWN: colors.short,
    HALTED:   colors.short,
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: progressColor + '33' }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: colors.mutedForeground }]}>DAILY KPI</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            ${startingCapital.toLocaleString()} capital · ${target.toLocaleString()} target
          </Text>
        </View>
        <View style={[styles.stateBadge, { backgroundColor: stateBg[state], borderColor: stateTextColor[state] + '44' }]}>
          <Text style={[styles.stateLabel, { color: stateTextColor[state] }]}>
            {stateLabel[state]}
          </Text>
        </View>
      </View>

      {/* Progress bar */}
      <View style={styles.barSection}>
        <View style={styles.barLabelRow}>
          <Text style={[styles.barLabel, { color: progressColor }]}>
            {fmtPnl(totalPnL)} total PnL
          </Text>
          <Text style={[styles.barPct, { color: colors.mutedForeground }]}>
            {achievedPct.toFixed(1)}% of ${target.toLocaleString()}
          </Text>
        </View>

        {/* Track */}
        <View style={[styles.track, { backgroundColor: colors.secondary }]}>
          {/* Realized fill */}
          <View style={[
            styles.trackFill,
            { width: `${achievedPct}%` as any, backgroundColor: progressColor },
          ]} />
          {/* Unrealized overlay */}
          {totalPct > achievedPct && (
            <View style={[
              styles.trackUnreal,
              {
                left:            `${achievedPct}%` as any,
                width:           `${totalPct - achievedPct}%` as any,
                backgroundColor: progressColor,
              },
            ]} />
          )}
          {/* Label */}
          <View style={styles.trackLabelWrap}>
            <Text style={styles.trackLabel} numberOfLines={1}>
              {fmtPnl(realized)} realized
            </Text>
          </View>
        </View>

        {/* Axis labels */}
        <View style={styles.axisRow}>
          <Text style={[styles.axisLabel, { color: colors.mutedForeground }]}>$0</Text>
          <Text style={[styles.axisLabel, { color: colors.mutedForeground }]}>${target.toLocaleString()}</Text>
        </View>
      </View>

      {/* Stats grid */}
      <View style={[styles.statsGrid, { borderTopColor: colors.border }]}>
        {[
          { label: 'Realized',   value: fmtPnl(realized),   color: realized   >= 0 ? colors.long : colors.short },
          { label: 'Unrealized', value: fmtPnl(unrealized), color: unrealized >= 0 ? colors.long : colors.short },
          { label: 'Remaining',  value: remaining > 0 ? `$${remaining.toFixed(2)}` : '—', color: colors.mutedForeground },
          { label: 'Drawdown',   value: drawdownUSDT < 0 ? fmtPnl(drawdownUSDT) : '$0.00', color: drawdownUSDT < 0 ? colors.short : colors.mutedForeground },
          { label: 'DD %',       value: `${drawdownPct.toFixed(2)}%`, color: drawdownPct > 5 ? colors.short : colors.mutedForeground },
        ].map(s => (
          <View key={s.label} style={styles.statItem}>
            <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
          </View>
        ))}
      </View>

      {/* Disclaimer */}
      <View style={[styles.disclaimer, { borderTopColor: colors.border }]}>
        <Feather name="info" size={9} color={colors.mutedForeground} style={{ opacity: 0.5, marginTop: 1 }} />
        <Text style={[styles.disclaimerTxt, { color: colors.mutedForeground }]}>
          Monitoring KPI only · Risk Engine is independent and retains veto authority
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card:         { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  header:       { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  title:        { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 1 },
  subtitle:     { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 2 },
  stateBadge:   { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, borderWidth: 1 },
  stateLabel:   { fontFamily: 'Inter_700Bold', fontSize: 8, letterSpacing: 0.6 },
  barSection:   { gap: 4 },
  barLabelRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barLabel:     { fontFamily: 'Inter_700Bold', fontSize: 12 },
  barPct:       { fontFamily: 'Inter_400Regular', fontSize: 10 },
  track:        { height: 18, borderRadius: 9, overflow: 'hidden', position: 'relative' },
  trackFill:    { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: 9 },
  trackUnreal:  { position: 'absolute', top: 0, bottom: 0, borderRadius: 9, opacity: 0.4 },
  trackLabelWrap: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' },
  trackLabel:   { fontFamily: 'Inter_600SemiBold', fontSize: 9, color: 'rgba(255,255,255,0.8)' },
  axisRow:      { flexDirection: 'row', justifyContent: 'space-between' },
  axisLabel:    { fontFamily: 'Inter_400Regular', fontSize: 9 },
  statsGrid:    { flexDirection: 'row', borderTopWidth: 1, paddingTop: 10, justifyContent: 'space-between' },
  statItem:     { alignItems: 'center', flex: 1 },
  statValue:    { fontFamily: 'Inter_700Bold', fontSize: 11 },
  statLabel:    { fontFamily: 'Inter_400Regular', fontSize: 8, marginTop: 2 },
  disclaimer:   { flexDirection: 'row', gap: 5, borderTopWidth: 1, paddingTop: 8, alignItems: 'flex-start' },
  disclaimerTxt:{ fontFamily: 'Inter_400Regular', fontSize: 9, lineHeight: 13, flex: 1 },
});
