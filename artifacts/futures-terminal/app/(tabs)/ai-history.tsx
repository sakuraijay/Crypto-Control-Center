/**
 * AI Decision History — mobile tab
 *
 * Shows the persisted AI decision history from AiEngineContext.decisionHistory,
 * which is seeded on mount from the API and updated each cycle.
 */

import React, { useMemo, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAiEngine } from '@/contexts/AiEngineContext';
import type { AiEngineDecision } from '@/lib/ai/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)     return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const STATE_ICONS: Record<string, string> = {
  LONG: 'trending-up', SHORT: 'trending-down', SPOT: 'sun',
  HEDGE: 'shield', CASH: 'dollar-sign',
};

// ── Decision card ─────────────────────────────────────────────────────────────

function DecisionCard({ d }: { d: AiEngineDecision }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);

  const state      = d.operatingState;
  const stateIcon  = STATE_ICONS[state] ?? 'cpu';
  const stateColor = state === 'LONG' || state === 'SPOT'
    ? colors.long
    : state === 'SHORT'
    ? colors.short
    : state === 'HEDGE'
    ? '#a855f7'
    : colors.mutedForeground;

  const confPct = Math.round(d.confidence);
  const confColor = confPct >= 75 ? colors.long : confPct >= 50 ? colors.warning : colors.short;
  const riskColor = d.riskApproved ? colors.long : colors.short;
  const execColor = d.paperExecuted ? '#60a5fa' : colors.mutedForeground;

  return (
    <TouchableOpacity
      onPress={() => setExpanded(e => !e)}
      activeOpacity={0.85}
      style={[
        st.card,
        {
          backgroundColor: colors.card,
          borderColor: d.riskApproved ? colors.border : colors.short + '33',
        },
      ]}
    >
      {/* Row 1: icon + symbol + state badge + time */}
      <View style={st.row}>
        <Feather name={stateIcon as any} size={13} color={stateColor} />
        <Text style={[st.symbol, { color: colors.foreground }]}>
          {d.primarySymbol ? `${d.primarySymbol}/USD` : 'MULTI'}
        </Text>
        <View style={[st.badge, { backgroundColor: stateColor + '22', borderColor: stateColor + '44' }]}>
          <Text style={[st.badgeTxt, { color: stateColor }]}>{state}</Text>
        </View>
        <Text style={[st.time, { color: colors.mutedForeground }]}>{timeAgoShort(d.createdAt)}</Text>
      </View>

      {/* Confidence bar */}
      <View style={st.confRow}>
        <View style={[st.confBar, { backgroundColor: colors.secondary }]}>
          <View style={[st.confFill, { width: `${confPct}%` as any, backgroundColor: confColor }]} />
        </View>
        <Text style={[st.confTxt, { color: colors.mutedForeground }]}>{confPct}%</Text>
      </View>

      {/* Rationale */}
      {!!d.stateRationale && (
        <Text
          style={[st.rationale, { color: colors.mutedForeground }]}
          numberOfLines={expanded ? undefined : 2}
        >
          {d.stateRationale}
        </Text>
      )}

      {/* Row 2: risk result + execution */}
      <View style={st.row}>
        <Text style={[st.tag, { color: riskColor }]}>
          {d.riskApproved ? '✓ APPROVED' : '⛔ VETOED'}
        </Text>
        <Text style={[st.sep, { color: colors.border }]}>·</Text>
        <Text style={[st.tag, { color: execColor }]}>
          {d.paperExecuted ? 'SIMULATED' : 'NO_EXEC'}
        </Text>
        {d.sizeUsd != null && (
          <>
            <Text style={[st.sep, { color: colors.border }]}>·</Text>
            <Text style={[st.tag, { color: colors.foreground }]}>${d.sizeUsd.toLocaleString()}</Text>
          </>
        )}
        {d.leverage != null && (
          <>
            <Text style={[st.sep, { color: colors.border }]}>·</Text>
            <Text style={[st.tag, { color: colors.mutedForeground }]}>{d.leverage}×</Text>
          </>
        )}
      </View>

      {/* Expanded: veto reason + reasoning */}
      {expanded && (
        <View style={[st.detail, { borderTopColor: colors.border }]}>
          {d.riskVetoReason ? (
            <Text style={[st.detailLine, { color: colors.short }]}>⛔ {d.riskVetoReason}</Text>
          ) : null}
          {d.reasoning.map((r, i) => (
            <Text key={i} style={[st.detailLine, { color: colors.mutedForeground }]}>• {r}</Text>
          ))}
          {d.cycleNumber > 0 && (
            <Text style={[st.detailLine, { color: colors.mutedForeground }]}>
              Cycle #{d.cycleNumber} · {d.marketCondition?.replace(/_/g, ' ')} · Risk: {d.riskLevel}
            </Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const STATE_FILTERS = ['ALL', 'LONG', 'SHORT', 'SPOT', 'HEDGE', 'CASH'] as const;
const RISK_FILTERS  = ['ALL', 'APPROVED', 'VETOED'] as const;

// ── Main screen ───────────────────────────────────────────────────────────────

export default function AiHistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { decisionHistory } = useAiEngine();

  const [stateFilter, setStateFilter] = useState('ALL');
  const [riskFilter,  setRiskFilter]  = useState('ALL');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const filtered = useMemo(() => {
    return decisionHistory.filter(d => {
      if (stateFilter !== 'ALL' && d.operatingState !== stateFilter) return false;
      if (riskFilter !== 'ALL') {
        if (riskFilter === 'APPROVED' && !d.riskApproved) return false;
        if (riskFilter === 'VETOED'   &&  d.riskApproved) return false;
      }
      return true;
    });
  }, [decisionHistory, stateFilter, riskFilter]);

  return (
    <View style={[st.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[st.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Feather name="clock" size={16} color={colors.primary} />
        <Text style={[st.headerTitle, { color: colors.foreground }]}>AI History</Text>
        <View style={[st.countBadge, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Text style={[st.countBadgeTxt, { color: colors.mutedForeground }]}>{filtered.length}</Text>
        </View>
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={{ paddingBottom: botPad + 20 }}
        showsVerticalScrollIndicator={false}
      >
        {/* State filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={st.filterRow}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}
        >
          {STATE_FILTERS.map(f => (
            <TouchableOpacity
              key={f}
              onPress={() => setStateFilter(f)}
              style={[st.filterBtn, {
                backgroundColor: stateFilter === f ? colors.primary : colors.secondary,
                borderColor:     stateFilter === f ? colors.primary : colors.border,
              }]}
            >
              <Text style={[st.filterTxt, { color: stateFilter === f ? '#000' : colors.mutedForeground }]}>{f}</Text>
            </TouchableOpacity>
          ))}
          <View style={[st.filterSep, { backgroundColor: colors.border }]} />
          {RISK_FILTERS.map(f => (
            <TouchableOpacity
              key={f}
              onPress={() => setRiskFilter(f)}
              style={[st.filterBtn, {
                backgroundColor: riskFilter === f ? colors.primary : colors.secondary,
                borderColor:     riskFilter === f ? colors.primary : colors.border,
              }]}
            >
              <Text style={[st.filterTxt, { color: riskFilter === f ? '#000' : colors.mutedForeground }]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Empty state */}
        {filtered.length === 0 ? (
          <View style={st.empty}>
            <Feather name="clock" size={36} color={colors.mutedForeground} style={{ opacity: 0.3 }} />
            <Text style={[st.emptyTxt, { color: colors.mutedForeground }]}>
              No AI decisions yet — engine initialising…
            </Text>
            <Text style={[st.emptySub, { color: colors.mutedForeground }]}>
              Decisions appear once the AI engine runs its first 60-second cycle.
            </Text>
          </View>
        ) : (
          <View style={{ padding: 16, gap: 8 }}>
            {filtered.map(d => <DecisionCard key={d.id} d={d} />)}
          </View>
        )}

        {/* Info note */}
        <View style={[st.note, { paddingHorizontal: 16 }]}>
          <Feather name="info" size={11} color={colors.mutedForeground} />
          <Text style={[st.noteTxt, { color: colors.mutedForeground }]}>
            History is seeded from the API on launch and updated each 60-second cycle.
            Tap any card to expand details.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  root:         { flex: 1 },
  header:       { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  headerTitle:  { fontFamily: 'Inter_600SemiBold', fontSize: 16, flex: 1 },
  countBadge:   { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  countBadgeTxt:{ fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  scroll:       { flex: 1 },
  filterRow:    { marginTop: 12, marginBottom: 8 },
  filterBtn:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  filterTxt:    { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  filterSep:    { width: 1, marginHorizontal: 4 },

  // Card
  card:         { borderRadius: 10, borderWidth: 1, padding: 12, gap: 6 },
  row:          { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  symbol:       { fontFamily: 'Inter_700Bold', fontSize: 13 },
  badge:        { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  badgeTxt:     { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.6 },
  time:         { fontFamily: 'Inter_400Regular', fontSize: 10, marginLeft: 'auto' },
  confRow:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  confBar:      { flex: 1, height: 3, borderRadius: 2, overflow: 'hidden' },
  confFill:     { height: '100%', borderRadius: 2 },
  confTxt:      { fontFamily: 'Inter_400Regular', fontSize: 10, width: 28, textAlign: 'right' },
  rationale:    { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },
  tag:          { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  sep:          { fontFamily: 'Inter_400Regular', fontSize: 10 },
  detail:       { borderTopWidth: 1, paddingTop: 8, gap: 4 },
  detailLine:   { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },

  // Empty
  empty:        { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32, gap: 12 },
  emptyTxt:     { fontFamily: 'Inter_600SemiBold', fontSize: 15, textAlign: 'center' },
  emptySub:     { fontFamily: 'Inter_400Regular', fontSize: 12, textAlign: 'center', lineHeight: 18, opacity: 0.7 },

  // Note
  note:         { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8 },
  noteTxt:      { fontFamily: 'Inter_400Regular', fontSize: 10, flex: 1, lineHeight: 15, opacity: 0.7 },
});
