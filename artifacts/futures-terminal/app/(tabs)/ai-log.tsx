/**
 * AI Decision Log — mobile tab
 *
 * Displays every autonomous trading decision the VPS AI has made.
 * Risk controls sit above the AI with absolute veto authority.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ActivityIndicator, FlatList, Platform, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useVps, OperatingMode } from '@/contexts/VpsContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AiDecision {
  id: number;
  ts: string;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE' | 'CLOSE' | 'REVERSE';
  confidence: number;
  rationale: string;
  strategy: string;
  entryPrice: number | null;
  exitPrice: number | null;
  size: number | null;
  riskResult: 'APPROVED' | 'VETOED' | 'MODIFIED';
  riskNote: string | null;
  executionOutcome: 'FILLED' | 'REJECTED' | 'PENDING' | 'CANCELLED' | 'SIMULATED';
  pnl: number | null;
  durationMs: number | null;
}

interface AiStats {
  today: number;
  todayApproved: number;
  todayVetoed: number;
  todayFilled: number;
  avgConfidence: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DIR_ICONS: Record<string, string> = {
  LONG: 'trending-up', SHORT: 'trending-down', NO_TRADE: 'minus',
  CLOSE: 'x-circle', REVERSE: 'repeat',
};

const DIR_LABELS: Record<string, string> = {
  LONG: 'LONG', SHORT: 'SHORT', NO_TRADE: 'NO TRADE',
  CLOSE: 'CLOSE', REVERSE: 'REVERSE',
};

const MODE_CONFIG: Record<OperatingMode, { icon: string; label: string; sub: string }> = {
  AUTONOMOUS_AI:   { icon: 'cpu',      label: 'AUTONOMOUS AI',   sub: 'AI trading 24/7 · Risk controls active' },
  MANUAL_OVERRIDE: { icon: 'user',     label: 'MANUAL OVERRIDE', sub: 'AI paused · User in control'           },
  RISK_LOCKED:     { icon: 'shield',   label: 'RISK LOCKED',     sub: 'Risk controls vetoed all activity'     },
};

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

// ── Stat pill ─────────────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  const colors = useColors();
  return (
    <View style={[styles.statPill, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: color ?? colors.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

// ── Decision card ─────────────────────────────────────────────────────────────

function DecisionCard({ d }: { d: AiDecision }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);

  const dirIcon = DIR_ICONS[d.direction] ?? 'minus';
  const dirLabel = DIR_LABELS[d.direction] ?? d.direction;
  const confPct = Math.round(d.confidence * 100);

  const dirColor = d.direction === 'LONG'
    ? colors.long : d.direction === 'SHORT'
    ? colors.short : d.direction === 'REVERSE'
    ? '#a855f7' : colors.mutedForeground;

  const riskColor = d.riskResult === 'APPROVED' ? colors.long
    : d.riskResult === 'VETOED' ? colors.short : colors.warning;

  const pnlColor = d.pnl != null ? (d.pnl >= 0 ? colors.long : colors.short) : colors.mutedForeground;

  const outcomeColor = {
    FILLED: colors.long, REJECTED: colors.short,
    PENDING: colors.warning, CANCELLED: colors.mutedForeground, SIMULATED: '#60a5fa',
  }[d.executionOutcome] ?? colors.mutedForeground;

  return (
    <TouchableOpacity
      onPress={() => setExpanded(e => !e)}
      style={[styles.card, {
        backgroundColor: colors.card,
        borderColor: d.riskResult === 'VETOED' ? colors.short + '33' : colors.border,
      }]}
      activeOpacity={0.85}
    >
      {/* Row 1: symbol + direction + confidence + time */}
      <View style={styles.cardRow}>
        <Feather name={dirIcon as any} size={13} color={dirColor} />
        <Text style={[styles.symbol, { color: colors.foreground }]}>{d.symbol}</Text>
        <View style={[styles.dirBadge, { backgroundColor: dirColor + '22', borderColor: dirColor + '44' }]}>
          <Text style={[styles.dirLabel, { color: dirColor }]}>{dirLabel}</Text>
        </View>
        <View style={styles.confRow}>
          <View style={[styles.confBar, { backgroundColor: colors.secondary }]}>
            <View style={[styles.confFill, {
              width: `${confPct}%` as any,
              backgroundColor: confPct >= 75 ? colors.long : confPct >= 50 ? colors.warning : colors.short,
            }]} />
          </View>
          <Text style={[styles.confTxt, { color: colors.mutedForeground }]}>{confPct}%</Text>
        </View>
        <Text style={[styles.time, { color: colors.mutedForeground }]}>{timeAgoShort(d.ts)}</Text>
      </View>

      {/* Row 2: rationale */}
      {d.rationale ? (
        <Text style={[styles.rationale, { color: colors.mutedForeground }]} numberOfLines={expanded ? undefined : 1}>
          {d.rationale}
        </Text>
      ) : null}

      {/* Row 3: risk + outcome + pnl */}
      <View style={styles.cardRow}>
        <Text style={[styles.riskTxt, { color: riskColor }]}>{d.riskResult}</Text>
        <Text style={[styles.sep, { color: colors.border }]}>·</Text>
        <Text style={[styles.outcomeTxt, { color: outcomeColor }]}>{d.executionOutcome}</Text>
        {d.pnl != null && (
          <>
            <Text style={[styles.sep, { color: colors.border }]}>·</Text>
            <Text style={[styles.pnl, { color: pnlColor }]}>
              {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
            </Text>
          </>
        )}
      </View>

      {/* Expanded detail */}
      {expanded && (
        <View style={[styles.detail, { borderTopColor: colors.border }]}>
          {d.riskNote ? (
            <Text style={[styles.detailRow, { color: colors.warning }]}>Risk note: {d.riskNote}</Text>
          ) : null}
          <Text style={[styles.detailRow, { color: colors.mutedForeground }]}>
            Strategy: <Text style={{ color: colors.foreground }}>{d.strategy || '—'}</Text>
          </Text>
          {d.entryPrice != null && (
            <Text style={[styles.detailRow, { color: colors.mutedForeground }]}>
              Entry: <Text style={{ color: colors.foreground }}>${d.entryPrice.toLocaleString()}</Text>
            </Text>
          )}
          {d.size != null && (
            <Text style={[styles.detailRow, { color: colors.mutedForeground }]}>
              Size: <Text style={{ color: colors.foreground }}>{d.size}</Text>
            </Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

const DIR_FILTERS = ['ALL', 'LONG', 'SHORT', 'NO_TRADE', 'CLOSE', 'REVERSE'] as const;
const RISK_FILTERS = ['ALL', 'APPROVED', 'VETOED', 'MODIFIED'] as const;

export default function AiLogScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { operatingMode } = useVps();

  const [decisions, setDecisions] = useState<AiDecision[]>([]);
  const [stats, setStats] = useState<AiStats>({ today: 0, todayApproved: 0, todayVetoed: 0, todayFilled: 0, avgConfidence: 0 });
  const [loading, setLoading] = useState(false);
  const [dirFilter, setDirFilter] = useState('ALL');
  const [riskFilter, setRiskFilter] = useState('ALL');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const modeCfg = MODE_CONFIG[operatingMode];
  const modeColor = operatingMode === 'AUTONOMOUS_AI' ? colors.long
    : operatingMode === 'RISK_LOCKED' ? colors.short : colors.warning;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/ai/decisions?limit=200`);
      if (res.ok) {
        const data = await res.json();
        setDecisions(data.decisions ?? []);
        setStats(data.stats ?? stats);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = decisions.filter(d => {
    if (dirFilter !== 'ALL' && d.direction !== dirFilter) return false;
    if (riskFilter !== 'ALL' && d.riskResult !== riskFilter) return false;
    return true;
  });

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <Feather name="cpu" size={16} color={modeColor} />
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>AI Decisions</Text>
        </View>
        <View style={[styles.modeBadge, { backgroundColor: modeColor + '22', borderColor: modeColor + '44' }]}>
          <Text style={[styles.modeTxt, { color: modeColor }]}>{modeCfg.label}</Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: botPad + 20 }} showsVerticalScrollIndicator={false}>

        {/* Mode info */}
        <View style={[styles.modeInfo, { backgroundColor: modeColor + '11', borderColor: modeColor + '22' }]}>
          <Feather name={modeCfg.icon as any} size={13} color={modeColor} />
          <Text style={[styles.modeInfoTxt, { color: colors.mutedForeground }]}>{modeCfg.sub}</Text>
        </View>

        {/* Stats */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statsRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          <StatPill label="Today"    value={stats.today} />
          <StatPill label="Approved" value={stats.todayApproved} color={colors.long} />
          <StatPill label="Vetoed"   value={stats.todayVetoed}   color={colors.short} />
          <StatPill label="Filled"   value={stats.todayFilled}   color={colors.long} />
          <StatPill label="Avg Conf" value={`${Math.round(stats.avgConfidence * 100)}%`} />
        </ScrollView>

        {/* Direction filters */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}>
          {DIR_FILTERS.map(f => (
            <TouchableOpacity
              key={f}
              onPress={() => setDirFilter(f)}
              style={[styles.filterBtn, {
                backgroundColor: dirFilter === f ? colors.primary : colors.secondary,
                borderColor: dirFilter === f ? colors.primary : colors.border,
              }]}
            >
              <Text style={[styles.filterTxt, { color: dirFilter === f ? '#000' : colors.mutedForeground }]}>
                {f === 'NO_TRADE' ? 'NO TRADE' : f}
              </Text>
            </TouchableOpacity>
          ))}
          <View style={[styles.filterSep, { backgroundColor: colors.border }]} />
          {RISK_FILTERS.map(f => (
            <TouchableOpacity
              key={f}
              onPress={() => setRiskFilter(f)}
              style={[styles.filterBtn, {
                backgroundColor: riskFilter === f ? colors.primary : colors.secondary,
                borderColor: riskFilter === f ? colors.primary : colors.border,
              }]}
            >
              <Text style={[styles.filterTxt, { color: riskFilter === f ? '#000' : colors.mutedForeground }]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Count + refresh */}
        <View style={[styles.countRow, { paddingHorizontal: 16 }]}>
          <Text style={[styles.countTxt, { color: colors.mutedForeground }]}>{filtered.length} decisions</Text>
          <TouchableOpacity onPress={refresh} disabled={loading} style={styles.refreshBtn}>
            {loading
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Feather name="refresh-cw" size={14} color={colors.primary} />
            }
          </TouchableOpacity>
        </View>

        {/* Decision list */}
        {filtered.length === 0 && !loading ? (
          <View style={styles.empty}>
            <Feather name="cpu" size={36} color={colors.mutedForeground} style={{ opacity: 0.3 }} />
            <Text style={[styles.emptyTxt, { color: colors.mutedForeground }]}>No AI decisions logged yet</Text>
            <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
              Decisions appear once the VPS AI starts operating autonomously
            </Text>
          </View>
        ) : (
          <View style={{ padding: 16, gap: 8 }}>
            {filtered.map(d => <DecisionCard key={d.id} d={d} />)}
          </View>
        )}

        {/* Risk note */}
        <View style={[styles.riskNote, { paddingHorizontal: 16 }]}>
          <Feather name="shield" size={11} color={colors.warning} />
          <Text style={[styles.riskNoteTxt, { color: colors.mutedForeground }]}>
            Risk controls have absolute veto authority above the AI.
            Vetoed decisions are logged but never executed.
            Live trading is NOT enabled by default.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root:       { flex: 1 },
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle:{ fontFamily: 'Inter_600SemiBold', fontSize: 16 },
  modeBadge:  { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },
  modeTxt:    { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.8 },
  scroll:     { flex: 1 },
  modeInfo:   { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 16, padding: 12, borderRadius: 10, borderWidth: 1 },
  modeInfoTxt:{ fontFamily: 'Inter_400Regular', fontSize: 11, flex: 1, lineHeight: 16 },
  statsRow:   { marginBottom: 8 },
  statPill:   { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1, alignItems: 'center', minWidth: 60 },
  statValue:  { fontFamily: 'Inter_700Bold', fontSize: 16 },
  statLabel:  { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 2 },
  filterRow:  { marginBottom: 8 },
  filterBtn:  { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  filterTxt:  { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  filterSep:  { width: 1, marginHorizontal: 4 },
  countRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  countTxt:   { fontFamily: 'Inter_400Regular', fontSize: 11 },
  refreshBtn: { padding: 6 },
  card:       { borderRadius: 10, borderWidth: 1, padding: 12, gap: 6 },
  cardRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  symbol:     { fontFamily: 'Inter_700Bold', fontSize: 13 },
  dirBadge:   { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  dirLabel:   { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.6 },
  confRow:    { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  confBar:    { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  confFill:   { height: '100%', borderRadius: 2 },
  confTxt:    { fontFamily: 'Inter_400Regular', fontSize: 10, width: 28, textAlign: 'right' },
  time:       { fontFamily: 'Inter_400Regular', fontSize: 10 },
  rationale:  { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 15 },
  riskTxt:    { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  outcomeTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  pnl:        { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  sep:        { fontFamily: 'Inter_400Regular', fontSize: 10 },
  detail:     { borderTopWidth: 1, paddingTop: 8, gap: 3 },
  detailRow:  { fontFamily: 'Inter_400Regular', fontSize: 11 },
  empty:      { alignItems: 'center', paddingVertical: 60, gap: 8, paddingHorizontal: 16 },
  emptyTxt:   { fontFamily: 'Inter_500Medium', fontSize: 14 },
  emptySub:   { fontFamily: 'Inter_400Regular', fontSize: 12, textAlign: 'center', lineHeight: 18 },
  riskNote:   { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingBottom: 16, paddingTop: 8 },
  riskNoteTxt:{ fontFamily: 'Inter_400Regular', fontSize: 10, lineHeight: 15, flex: 1 },
});
