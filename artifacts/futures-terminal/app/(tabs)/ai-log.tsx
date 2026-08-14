/**
 * AI Decision Log — mobile tab
 *
 * Two data sources merged:
 *  1. AiEngineContext.decisionHistory — current session decisions with FULL indicator data
 *  2. API /ai/decisions — persisted historical decisions (older sessions)
 *
 * Local session decisions show a "SESSION" badge and support full indicator drill-down.
 * Historical API decisions show whatever fields the server returned.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ActivityIndicator, FlatList, Platform, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useVps, OperatingMode } from '@/contexts/VpsContext';
import { useAiEngine }           from '@/contexts/AiEngineContext';
import type { AiEngineDecision, IndicatorValues, SymbolAnalysis } from '@/lib/ai/types';

// ── API historical decision type (flat, persisted) ────────────────────────────

interface ApiDecision {
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

interface ApiStats {
  today: number;
  todayApproved: number;
  todayVetoed: number;
  todayFilled: number;
  avgConfidence: number;
}

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)     return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

const STATE_ICONS: Record<string, string> = {
  LONG: 'trending-up', SHORT: 'trending-down', SPOT: 'sun',
  HEDGE: 'shield', CASH: 'dollar-sign', NO_TRADE: 'minus',
  CLOSE: 'x-circle', REVERSE: 'repeat',
};

const MODE_CONFIG: Record<OperatingMode, { icon: string; label: string; sub: string }> = {
  AUTONOMOUS_AI:   { icon: 'cpu',    label: 'AUTONOMOUS AI',   sub: 'AI trading 24/7 · Risk controls active' },
  MANUAL_OVERRIDE: { icon: 'user',   label: 'MANUAL OVERRIDE', sub: 'AI paused · User in control'           },
  RISK_LOCKED:     { icon: 'shield', label: 'RISK LOCKED',     sub: 'Risk controls vetoed all activity'     },
};

// ── Stat pill ─────────────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  const colors = useColors();
  return (
    <View style={[st.statPill, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[st.statValue, { color: color ?? colors.foreground }]}>{value}</Text>
      <Text style={[st.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

// ── Indicator row (for drill-down) ────────────────────────────────────────────

function IndicatorRow({ label, value, sub, valueColor }: {
  label: string; value: string; sub?: string; valueColor?: string;
}) {
  const colors = useColors();
  return (
    <View style={st.indRow}>
      <Text style={[st.indLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[st.indValue, { color: valueColor ?? colors.foreground }]}>{value}</Text>
      {sub ? <Text style={[st.indSub, { color: colors.mutedForeground }]}>{sub}</Text> : null}
    </View>
  );
}

// ── Indicator drill-down panel ────────────────────────────────────────────────

function IndicatorDrillDown({ ind, price }: { ind: IndicatorValues; price: number }) {
  const colors = useColors();

  const rsiColor = ind.rsi14 < 35 ? '#22c55e' : ind.rsi14 > 65 ? '#ef4444' : colors.foreground;
  const crossColor = ind.emaCross === 'bullish' ? '#22c55e'
    : ind.emaCross === 'bearish' ? '#ef4444' : colors.mutedForeground;
  const trendColor = ind.trend === 'up' ? '#22c55e' : ind.trend === 'down' ? '#ef4444' : colors.mutedForeground;
  const momColor   = ind.momentum > 0 ? '#22c55e' : ind.momentum < 0 ? '#ef4444' : colors.mutedForeground;
  const atrColor   = ind.atrPct > 5 ? '#ef4444' : ind.atrPct > 2.5 ? '#f59e0b' : '#22c55e';

  return (
    <View style={[st.drillDown, { backgroundColor: colors.secondary + 'aa', borderColor: colors.border }]}>
      <Text style={[st.drillTitle, { color: colors.mutedForeground }]}>INDICATORS @ ${price.toLocaleString()}</Text>

      <View style={st.indGrid}>
        <IndicatorRow label="RSI 14"  value={fmt(ind.rsi14, 1)}  sub={ind.rsi14 < 35 ? 'oversold' : ind.rsi14 > 65 ? 'overbought' : 'neutral'}  valueColor={rsiColor} />
        <IndicatorRow label="EMA 9"   value={`$${ind.ema9.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <IndicatorRow label="EMA 21"  value={`$${ind.ema21.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <IndicatorRow label="EMA Cross" value={ind.emaCross.toUpperCase()} valueColor={crossColor} />
        <IndicatorRow label="ATR%"    value={`${fmt(ind.atrPct, 3)}%`}  sub={ind.atrPct > 5 ? 'volatile' : ind.atrPct > 2.5 ? 'moderate' : 'calm'} valueColor={atrColor} />
        <IndicatorRow label="24h Δ"   value={`${ind.priceChange24h >= 0 ? '+' : ''}${fmt(ind.priceChange24h, 2)}%`}
          valueColor={ind.priceChange24h >= 0 ? '#22c55e' : '#ef4444'} />
        <IndicatorRow label="1h Δ"    value={`${ind.priceChange1h >= 0 ? '+' : ''}${fmt(ind.priceChange1h, 3)}%`}
          valueColor={ind.priceChange1h >= 0 ? '#22c55e' : '#ef4444'} />
        <IndicatorRow label="Momentum" value={`${fmt(ind.momentum, 0)} bp`} valueColor={momColor} />
        <IndicatorRow label="Trend"   value={ind.trend.toUpperCase()} valueColor={trendColor} />
      </View>
    </View>
  );
}

// ── Symbol analysis pill ──────────────────────────────────────────────────────

function SymbolAnalysisPill({ a }: { a: SymbolAnalysis }) {
  const colors = useColors();
  const biasColor = a.directionalBias > 20 ? '#22c55e' : a.directionalBias < -20 ? '#ef4444' : colors.mutedForeground;
  return (
    <View style={[st.symPill, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[st.symPillSym, { color: colors.foreground }]}>{a.displaySymbol}</Text>
      <Text style={[st.symPillBias, { color: biasColor }]}>
        {a.directionalBias > 0 ? '▲' : a.directionalBias < 0 ? '▼' : '—'}{Math.abs(a.directionalBias).toFixed(0)}
      </Text>
      <Text style={[st.symPillOpp, { color: colors.mutedForeground }]}>opp:{a.opportunityScore}</Text>
    </View>
  );
}

// ── Session Decision Card (full AiEngineDecision with indicators) ─────────────

function SessionDecisionCard({ d }: { d: AiEngineDecision }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);

  const state      = d.operatingState;
  const stateIcon  = STATE_ICONS[state] ?? 'cpu';
  const stateColor = state === 'LONG' || state === 'SPOT' ? colors.long
    : state === 'SHORT' ? colors.short
    : state === 'HEDGE' ? '#a855f7'
    : colors.mutedForeground;

  const confPct = Math.round(d.confidence);

  // Primary symbol analysis for indicator drill-down
  const primaryAnalysis = d.symbolAnalyses.find(a => a.symbol === d.primarySymbol)
    ?? d.symbolAnalyses[0];

  return (
    <TouchableOpacity
      onPress={() => setExpanded(e => !e)}
      style={[st.card, {
        backgroundColor: colors.card,
        borderColor:     d.riskApproved ? colors.border : colors.short + '33',
      }]}
      activeOpacity={0.85}
    >
      {/* Row 1: symbol + state + confidence + time */}
      <View style={st.cardRow}>
        <Feather name={stateIcon as any} size={13} color={stateColor} />
        <Text style={[st.symbol, { color: colors.foreground }]}>
          {d.primarySymbol ? `${d.primarySymbol}/USD` : 'MULTI'}
        </Text>
        <View style={[st.dirBadge, { backgroundColor: stateColor + '22', borderColor: stateColor + '44' }]}>
          <Text style={[st.dirLabel, { color: stateColor }]}>{state}</Text>
        </View>
        <View style={[st.sessionBadge, { backgroundColor: '#60a5fa22' }]}>
          <Text style={[st.sessionTxt, { color: '#60a5fa' }]}>SESSION</Text>
        </View>
        <View style={st.confRow}>
          <View style={[st.confBar, { backgroundColor: colors.secondary }]}>
            <View style={[st.confFill, {
              width: `${confPct}%` as any,
              backgroundColor: confPct >= 75 ? colors.long : confPct >= 50 ? colors.warning : colors.short,
            }]} />
          </View>
          <Text style={[st.confTxt, { color: colors.mutedForeground }]}>{confPct}%</Text>
        </View>
        <Text style={[st.time, { color: colors.mutedForeground }]}>{timeAgoShort(d.createdAt)}</Text>
      </View>

      {/* Rationale */}
      <Text style={[st.rationale, { color: colors.mutedForeground }]} numberOfLines={expanded ? undefined : 1}>
        {d.stateRationale}
      </Text>

      {/* Row 2: risk + execution */}
      <View style={st.cardRow}>
        <Text style={[st.riskTxt, { color: d.riskApproved ? colors.long : colors.short }]}>
          {d.riskApproved ? 'APPROVED' : 'VETOED'}
        </Text>
        <Text style={[st.sep, { color: colors.border }]}>·</Text>
        <Text style={[st.outcomeTxt, { color: d.paperExecuted ? '#60a5fa' : colors.mutedForeground }]}>
          {d.paperExecuted ? 'SIMULATED' : 'NO_EXEC'}
        </Text>
        {d.sizeUsd && (
          <>
            <Text style={[st.sep, { color: colors.border }]}>·</Text>
            <Text style={[st.outcomeTxt, { color: colors.foreground }]}>${d.sizeUsd.toLocaleString()}</Text>
          </>
        )}
        {d.leverage && (
          <>
            <Text style={[st.sep, { color: colors.border }]}>·</Text>
            <Text style={[st.outcomeTxt, { color: colors.mutedForeground }]}>{d.leverage}×</Text>
          </>
        )}
      </View>

      {/* Expanded drill-down */}
      {expanded && (
        <View style={[st.detail, { borderTopColor: colors.border }]}>
          {/* Reasoning bullets */}
          {d.reasoning.map((r, i) => (
            <Text key={i} style={[st.detailRow, { color: colors.mutedForeground }]}>• {r}</Text>
          ))}

          {/* Risk veto reason */}
          {d.riskVetoReason && (
            <Text style={[st.detailRow, { color: colors.short }]}>⛔ {d.riskVetoReason}</Text>
          )}

          {/* TP / SL / Trailing */}
          {(d.tpPrice || d.slPrice || d.trailingStopPct) && (
            <View style={st.cardRow}>
              {d.tpPrice && <Text style={[st.detailRow, { color: '#22c55e' }]}>TP ${d.tpPrice.toLocaleString()}</Text>}
              {d.slPrice && <Text style={[st.detailRow, { color: '#ef4444', marginLeft: 12 }]}>SL ${d.slPrice.toLocaleString()}</Text>}
              {d.trailingStopPct && <Text style={[st.detailRow, { color: '#f59e0b', marginLeft: 12 }]}>Trail {d.trailingStopPct.toFixed(1)}%</Text>}
            </View>
          )}

          {/* Hedge params */}
          {d.hedgeParams && (
            <Text style={[st.detailRow, { color: '#a855f7' }]}>
              Hedge: {d.hedgeParams.direction} {d.hedgeParams.symbol} ${d.hedgeParams.sizeUsd} @ {d.hedgeParams.leverage}×
            </Text>
          )}

          {/* Indicator drill-down for primary symbol */}
          {primaryAnalysis && (
            <IndicatorDrillDown ind={primaryAnalysis.indicators} price={primaryAnalysis.price} />
          )}

          {/* Other analyzed symbols */}
          {d.symbolAnalyses.length > 1 && (
            <View>
              <Text style={[st.drillTitle, { color: colors.mutedForeground, marginBottom: 4 }]}>ALL ANALYZED SYMBOLS</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {d.symbolAnalyses.map(a => <SymbolAnalysisPill key={a.symbol} a={a} />)}
                </View>
              </ScrollView>
            </View>
          )}

          {/* Cycle info */}
          <Text style={[st.detailRow, { color: colors.mutedForeground }]}>
            Cycle #{d.cycleNumber} · Market: {d.marketCondition.replace(/_/g, ' ')} · Risk: {d.riskLevel}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Historical (API) Decision Card ────────────────────────────────────────────

function ApiDecisionCard({ d }: { d: ApiDecision }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);

  const dirIcon  = STATE_ICONS[d.direction] ?? 'minus';
  const confPct  = Math.round(d.confidence * 100);

  const dirColor = d.direction === 'LONG' ? colors.long
    : d.direction === 'SHORT' ? colors.short
    : d.direction === 'REVERSE' ? '#a855f7'
    : colors.mutedForeground;

  const riskColor    = d.riskResult === 'APPROVED' ? colors.long : d.riskResult === 'VETOED' ? colors.short : colors.warning;
  const pnlColor     = d.pnl != null ? (d.pnl >= 0 ? colors.long : colors.short) : colors.mutedForeground;
  const outcomeColor = { FILLED: colors.long, REJECTED: colors.short, PENDING: colors.warning, CANCELLED: colors.mutedForeground, SIMULATED: '#60a5fa' }[d.executionOutcome] ?? colors.mutedForeground;

  return (
    <TouchableOpacity
      onPress={() => setExpanded(e => !e)}
      style={[st.card, { backgroundColor: colors.card, borderColor: d.riskResult === 'VETOED' ? colors.short + '33' : colors.border }]}
      activeOpacity={0.85}
    >
      <View style={st.cardRow}>
        <Feather name={dirIcon as any} size={13} color={dirColor} />
        <Text style={[st.symbol, { color: colors.foreground }]}>{d.symbol}</Text>
        <View style={[st.dirBadge, { backgroundColor: dirColor + '22', borderColor: dirColor + '44' }]}>
          <Text style={[st.dirLabel, { color: dirColor }]}>{d.direction}</Text>
        </View>
        <View style={st.confRow}>
          <View style={[st.confBar, { backgroundColor: colors.secondary }]}>
            <View style={[st.confFill, { width: `${confPct}%` as any, backgroundColor: confPct >= 75 ? colors.long : confPct >= 50 ? colors.warning : colors.short }]} />
          </View>
          <Text style={[st.confTxt, { color: colors.mutedForeground }]}>{confPct}%</Text>
        </View>
        <Text style={[st.time, { color: colors.mutedForeground }]}>{timeAgoShort(d.ts)}</Text>
      </View>

      {d.rationale ? (
        <Text style={[st.rationale, { color: colors.mutedForeground }]} numberOfLines={expanded ? undefined : 1}>
          {d.rationale}
        </Text>
      ) : null}

      <View style={st.cardRow}>
        <Text style={[st.riskTxt, { color: riskColor }]}>{d.riskResult}</Text>
        <Text style={[st.sep, { color: colors.border }]}>·</Text>
        <Text style={[st.outcomeTxt, { color: outcomeColor }]}>{d.executionOutcome}</Text>
        {d.pnl != null && (
          <>
            <Text style={[st.sep, { color: colors.border }]}>·</Text>
            <Text style={[st.pnl, { color: pnlColor }]}>{d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}</Text>
          </>
        )}
      </View>

      {expanded && (
        <View style={[st.detail, { borderTopColor: colors.border }]}>
          {d.riskNote && <Text style={[st.detailRow, { color: colors.warning }]}>Risk note: {d.riskNote}</Text>}
          <Text style={[st.detailRow, { color: colors.mutedForeground }]}>
            Strategy: <Text style={{ color: colors.foreground }}>{d.strategy || '—'}</Text>
          </Text>
          {d.entryPrice != null && <Text style={[st.detailRow, { color: colors.mutedForeground }]}>Entry: <Text style={{ color: colors.foreground }}>${d.entryPrice.toLocaleString()}</Text></Text>}
          {d.size != null && <Text style={[st.detailRow, { color: colors.mutedForeground }]}>Size: <Text style={{ color: colors.foreground }}>{d.size}</Text></Text>}
          <Text style={[st.detailRow, { color: colors.mutedForeground, fontStyle: 'italic' }]}>
            Indicator drill-down only available for current-session decisions.
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

const OPERATING_STATE_FILTERS = ['ALL', 'SPOT', 'LONG', 'SHORT', 'HEDGE', 'CASH'] as const;
const RISK_FILTERS             = ['ALL', 'APPROVED', 'VETOED'] as const;
const SOURCE_FILTERS           = ['ALL', 'SESSION', 'HISTORY'] as const;

export default function AiLogScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { operatingMode } = useVps();
  const { decisionHistory: sessionDecisions, stats: aiStats, pendingCount } = useAiEngine();

  const [apiDecisions, setApiDecisions] = useState<ApiDecision[]>([]);
  const [apiStats, setApiStats] = useState<ApiStats>({ today: 0, todayApproved: 0, todayVetoed: 0, todayFilled: 0, avgConfidence: 0 });
  const [loading,    setLoading]    = useState(false);
  const [stateFilter, setStateFilter] = useState('ALL');
  const [riskFilter,  setRiskFilter]  = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState('ALL');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const modeCfg   = MODE_CONFIG[operatingMode];
  const modeColor = operatingMode === 'AUTONOMOUS_AI' ? colors.long
    : operatingMode === 'RISK_LOCKED' ? colors.short : colors.warning;

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/ai/decisions?limit=200`);
      if (res.ok) {
        const data = await res.json();
        setApiDecisions(data.decisions ?? []);
        setApiStats(data.stats ?? apiStats);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // Filter session decisions
  const filteredSession = useMemo(() => {
    if (sourceFilter === 'HISTORY') return [];
    return sessionDecisions.filter(d => {
      if (stateFilter !== 'ALL' && d.operatingState !== stateFilter) return false;
      if (riskFilter  !== 'ALL' && (riskFilter === 'APPROVED' ? !d.riskApproved : d.riskApproved)) return false;
      return true;
    });
  }, [sessionDecisions, stateFilter, riskFilter, sourceFilter]);

  // Filter API decisions
  const filteredApi = useMemo(() => {
    if (sourceFilter === 'SESSION') return [];
    return apiDecisions.filter(d => {
      if (stateFilter !== 'ALL') {
        // Map API direction to operating state
        const dirMap: Record<string, string> = { LONG: 'LONG', SHORT: 'SHORT', NO_TRADE: 'CASH', CLOSE: 'CASH', REVERSE: 'HEDGE' };
        if (dirMap[d.direction] !== stateFilter && d.direction !== stateFilter) return false;
      }
      if (riskFilter !== 'ALL' && d.riskResult !== riskFilter) return false;
      return true;
    });
  }, [apiDecisions, stateFilter, riskFilter, sourceFilter]);

  const totalCount = filteredSession.length + filteredApi.length;

  return (
    <View style={[st.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[st.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={st.headerLeft}>
          <Feather name="cpu" size={16} color={modeColor} />
          <Text style={[st.headerTitle, { color: colors.foreground }]}>AI Decisions</Text>
          {pendingCount > 0 && (
            <View style={[st.pendingBadge, { backgroundColor: '#f59e0b' }]}>
              <Text style={st.pendingTxt}>{pendingCount}</Text>
            </View>
          )}
        </View>
        <View style={[st.modeBadge, { backgroundColor: modeColor + '22', borderColor: modeColor + '44' }]}>
          <Text style={[st.modeTxt, { color: modeColor }]}>{modeCfg.label}</Text>
        </View>
      </View>

      <ScrollView style={st.scroll} contentContainerStyle={{ paddingBottom: botPad + 20 }} showsVerticalScrollIndicator={false}>

        {/* Mode info */}
        <View style={[st.modeInfo, { backgroundColor: modeColor + '11', borderColor: modeColor + '22' }]}>
          <Feather name={modeCfg.icon as any} size={13} color={modeColor} />
          <Text style={[st.modeInfoTxt, { color: colors.mutedForeground }]}>{modeCfg.sub}</Text>
        </View>

        {/* Session stats (from AiEngineContext) */}
        {aiStats.totalCycles > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.statsRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            <StatPill label="Cycles"  value={aiStats.totalCycles} />
            <StatPill label="Avg Conf" value={`${Math.round(aiStats.avgConfidence)}%`} />
            <StatPill label="SPOT"   value={aiStats.stateDistribution.SPOT  ?? 0} color={colors.long} />
            <StatPill label="LONG"   value={aiStats.stateDistribution.LONG  ?? 0} color={colors.long} />
            <StatPill label="SHORT"  value={aiStats.stateDistribution.SHORT ?? 0} color={colors.short} />
            <StatPill label="HEDGE"  value={aiStats.stateDistribution.HEDGE ?? 0} color="#a855f7" />
            <StatPill label="CASH"   value={aiStats.stateDistribution.CASH  ?? 0} />
            <StatPill label="Session" value={sessionDecisions.length} />
          </ScrollView>
        )}

        {/* API stats */}
        {apiStats.today > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.statsRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            <StatPill label="Today (API)"   value={apiStats.today} />
            <StatPill label="Approved" value={apiStats.todayApproved} color={colors.long} />
            <StatPill label="Vetoed"   value={apiStats.todayVetoed}   color={colors.short} />
            <StatPill label="Filled"   value={apiStats.todayFilled}   color={colors.long} />
          </ScrollView>
        )}

        {/* Source filter */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.filterRow} contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}>
          {SOURCE_FILTERS.map(f => (
            <TouchableOpacity
              key={f}
              onPress={() => setSourceFilter(f)}
              style={[st.filterBtn, {
                backgroundColor: sourceFilter === f ? '#60a5fa' : colors.secondary,
                borderColor:     sourceFilter === f ? '#60a5fa' : colors.border,
              }]}
            >
              <Text style={[st.filterTxt, { color: sourceFilter === f ? '#000' : colors.mutedForeground }]}>{f}</Text>
            </TouchableOpacity>
          ))}
          <View style={[st.filterSep, { backgroundColor: colors.border }]} />
          {OPERATING_STATE_FILTERS.map(f => (
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

        {/* Count + refresh */}
        <View style={[st.countRow, { paddingHorizontal: 16 }]}>
          <Text style={[st.countTxt, { color: colors.mutedForeground }]}>
            {totalCount} decisions ({filteredSession.length} session · {filteredApi.length} history)
          </Text>
          <TouchableOpacity onPress={fetchHistory} disabled={loading} style={st.refreshBtn}>
            {loading
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Feather name="refresh-cw" size={14} color={colors.primary} />
            }
          </TouchableOpacity>
        </View>

        {/* Decision lists */}
        {totalCount === 0 && !loading ? (
          <View style={st.empty}>
            <Feather name="cpu" size={36} color={colors.mutedForeground} style={{ opacity: 0.3 }} />
            <Text style={[st.emptyTxt, { color: colors.mutedForeground }]}>No AI decisions logged yet</Text>
            <Text style={[st.emptySub, { color: colors.mutedForeground }]}>
              Decisions appear once the AI engine starts its 60-second cycles.
            </Text>
          </View>
        ) : (
          <View style={{ padding: 16, gap: 8 }}>
            {/* Session decisions first (with indicator drill-down) */}
            {filteredSession.map(d => <SessionDecisionCard key={d.id} d={d} />)}
            {/* Historical API decisions */}
            {filteredApi.map(d => <ApiDecisionCard key={d.id} d={d} />)}
          </View>
        )}

        {/* Risk note */}
        <View style={[st.riskNote, { paddingHorizontal: 16 }]}>
          <Feather name="shield" size={11} color={colors.warning} />
          <Text style={[st.riskNoteTxt, { color: colors.mutedForeground }]}>
            Risk controls have absolute veto authority above the AI.
            Vetoed decisions are logged but never executed.
            SESSION decisions include indicator drill-down. Tap any card to expand.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  root:         { flex: 1 },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  headerLeft:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle:  { fontFamily: 'Inter_600SemiBold', fontSize: 16 },
  pendingBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
  pendingTxt:   { fontFamily: 'Inter_700Bold', fontSize: 9, color: '#000' },
  modeBadge:    { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },
  modeTxt:      { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.8 },
  scroll:       { flex: 1 },
  modeInfo:     { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 16, padding: 12, borderRadius: 10, borderWidth: 1 },
  modeInfoTxt:  { fontFamily: 'Inter_400Regular', fontSize: 11, flex: 1, lineHeight: 16 },
  statsRow:     { marginBottom: 8 },
  statPill:     { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1, alignItems: 'center', minWidth: 60 },
  statValue:    { fontFamily: 'Inter_700Bold', fontSize: 14 },
  statLabel:    { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 2 },
  filterRow:    { marginBottom: 8 },
  filterBtn:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  filterTxt:    { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  filterSep:    { width: 1, marginHorizontal: 4 },
  countRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  countTxt:     { fontFamily: 'Inter_400Regular', fontSize: 10 },
  refreshBtn:   { padding: 6 },

  // Cards
  card:         { borderRadius: 10, borderWidth: 1, padding: 12, gap: 6 },
  cardRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  symbol:       { fontFamily: 'Inter_700Bold', fontSize: 13 },
  dirBadge:     { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  dirLabel:     { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.6 },
  sessionBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6 },
  sessionTxt:   { fontFamily: 'Inter_700Bold', fontSize: 8, letterSpacing: 0.5 },
  confRow:      { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  confBar:      { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  confFill:     { height: '100%', borderRadius: 2 },
  confTxt:      { fontFamily: 'Inter_400Regular', fontSize: 10, width: 28, textAlign: 'right' },
  time:         { fontFamily: 'Inter_400Regular', fontSize: 10 },
  rationale:    { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 15 },
  riskTxt:      { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  outcomeTxt:   { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  pnl:          { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  sep:          { fontFamily: 'Inter_400Regular', fontSize: 10 },

  // Detail
  detail:       { borderTopWidth: 1, paddingTop: 8, gap: 4 },
  detailRow:    { fontFamily: 'Inter_400Regular', fontSize: 11 },

  // Indicator drill-down
  drillDown:    { borderRadius: 8, borderWidth: 1, padding: 10, marginTop: 4, gap: 6 },
  drillTitle:   { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.6 },
  indGrid:      { gap: 4 },
  indRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  indLabel:     { fontFamily: 'Inter_500Medium', fontSize: 10, width: 70 },
  indValue:     { fontFamily: 'Inter_600SemiBold', fontSize: 10, minWidth: 70 },
  indSub:       { fontFamily: 'Inter_400Regular', fontSize: 9, fontStyle: 'italic' },

  // Symbol analysis pill
  symPill:      { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, borderWidth: 1, alignItems: 'center', minWidth: 72 },
  symPillSym:   { fontFamily: 'Inter_700Bold', fontSize: 10 },
  symPillBias:  { fontFamily: 'Inter_600SemiBold', fontSize: 11, marginTop: 2 },
  symPillOpp:   { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 1 },

  // Empty
  empty:        { alignItems: 'center', paddingVertical: 60, gap: 8, paddingHorizontal: 16 },
  emptyTxt:     { fontFamily: 'Inter_500Medium', fontSize: 14 },
  emptySub:     { fontFamily: 'Inter_400Regular', fontSize: 12, textAlign: 'center', lineHeight: 18 },
  riskNote:     { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingBottom: 16, paddingTop: 8 },
  riskNoteTxt:  { fontFamily: 'Inter_400Regular', fontSize: 10, lineHeight: 15, flex: 1 },
});
