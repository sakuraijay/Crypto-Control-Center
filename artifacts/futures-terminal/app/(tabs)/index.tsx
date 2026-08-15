/**
 * Dashboard — Crypto Control Center mobile
 *
 * Panels (top → bottom):
 *  1. Emergency stop banner
 *  2. AI State Card — current 5-state operating state, confidence, next cycle
 *  3. Live Approvals — APPROVE / REJECT pending live trade proposals
 *  4. Daily performance KPI
 *  6. Account summary (GMX: collateral, available, margin ratio)
 *  7. PnL stats
 *  8. Positions summary
 *  9. Quick controls (stop new orders, cancel orders)
 * 10. Emergency stop button
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  ActivityIndicator, Platform, ScrollView, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useEngine, EngineState } from '@/contexts/EngineContext';
import { useTrading } from '@/contexts/TradingContext';
import { useAiEngine } from '@/contexts/AiEngineContext';
import type { PendingLiveApproval } from '@/lib/ai/types';

import { EngineStatusBadge } from '@/components/EngineStatusBadge';
import { ConfirmModal }      from '@/components/ConfirmModal';
import { DailyTargetCard }   from '@/components/DailyTargetCard';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function fmtExpiry(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  return fmtMs(ms);
}

const STATE_COLOR: Record<string, string> = {
  SPOT:  '#22c55e',
  LONG:  '#22c55e',
  SHORT: '#ef4444',
  HEDGE: '#a855f7',
  CASH:  '#94a3b8',
};

const STATE_ICON: Record<string, string> = {
  SPOT:  'sun',
  LONG:  'trending-up',
  SHORT: 'trending-down',
  HEDGE: 'shield',
  CASH:  'dollar-sign',
};

// ── AI State Card ─────────────────────────────────────────────────────────────

function AiStateCard() {
  const colors = useColors();
  const {
    currentDecision, stats, running, autoExecute, setAutoExecute,
    triggerCycle, nextCycleMs, pendingCount,
  } = useAiEngine();

  const state      = currentDecision?.operatingState ?? 'CASH';
  const stateColor = STATE_COLOR[state] ?? colors.mutedForeground;
  const stateIcon  = STATE_ICON[state]  ?? 'cpu';
  const conf       = currentDecision ? Math.round(currentDecision.confidence) : 0;

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: stateColor + '44' }]}>
      {/* Header */}
      <View style={s.rowBetween}>
        <View style={s.rowGap6}>
          <Feather name="cpu" size={13} color={stateColor} />
          <Text style={[s.cardLabel, { color: colors.mutedForeground }]}>AI ENGINE</Text>
          {running && <ActivityIndicator size="small" color={stateColor} style={{ marginLeft: 4 }} />}
        </View>
        <View style={s.rowGap6}>
          {pendingCount > 0 && (
            <View style={[s.badge, { backgroundColor: '#f59e0b' }]}>
              <Text style={s.badgeTxt}>{pendingCount} PENDING</Text>
            </View>
          )}
          <View style={[s.badge, { backgroundColor: stateColor + '22', borderColor: stateColor + '55', borderWidth: 1 }]}>
            <Feather name={stateIcon as any} size={10} color={stateColor} />
            <Text style={[s.badgeTxt, { color: stateColor }]}>{state}</Text>
          </View>
        </View>
      </View>

      {/* Confidence bar */}
      <View style={s.rowGap6}>
        <Text style={[s.smallLabel, { color: colors.mutedForeground, width: 60 }]}>Confidence</Text>
        <View style={[s.confTrack, { backgroundColor: colors.secondary, flex: 1 }]}>
          <View style={[s.confFill, {
            width: `${conf}%` as any,
            backgroundColor: conf >= 75 ? '#22c55e' : conf >= 50 ? '#f59e0b' : '#ef4444',
          }]} />
        </View>
        <Text style={[s.smallLabel, { color: colors.foreground, width: 30, textAlign: 'right' }]}>{conf}%</Text>
      </View>

      {/* Rationale */}
      {currentDecision?.stateRationale ? (
        <Text style={[s.rationale, { color: colors.mutedForeground }]} numberOfLines={2}>
          {currentDecision.stateRationale}
        </Text>
      ) : (
        <Text style={[s.rationale, { color: colors.mutedForeground }]}>
          Waiting for first decision cycle…
        </Text>
      )}

      {/* Footer: cycle countdown + auto-execute */}
      <View style={s.rowBetween}>
        <View style={s.rowGap6}>
          <Feather name="clock" size={11} color={colors.mutedForeground} />
          <Text style={[s.smallLabel, { color: colors.mutedForeground }]}>
            Next cycle in {fmtMs(nextCycleMs)}
          </Text>
        </View>
        <View style={s.rowGap6}>
          <Text style={[s.smallLabel, { color: colors.mutedForeground }]}>Paper auto-exec</Text>
          <TouchableOpacity
            onPress={() => { setAutoExecute(!autoExecute); Haptics.selectionAsync(); }}
            style={[s.toggle, {
              backgroundColor: autoExecute ? '#22c55e22' : colors.secondary,
              borderColor:     autoExecute ? '#22c55e'   : colors.border,
            }]}
          >
            <Text style={[s.toggleTxt, { color: autoExecute ? '#22c55e' : colors.mutedForeground }]}>
              {autoExecute ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { triggerCycle(); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            disabled={running}
            style={[s.toggle, { borderColor: colors.border, backgroundColor: colors.secondary }]}
          >
            <Feather name="refresh-cw" size={11} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Cycle stats */}
      {stats.totalCycles > 0 && (
        <View style={[s.statsBar, { backgroundColor: colors.secondary, borderRadius: 8, padding: 8 }]}>
          {(['SPOT', 'LONG', 'SHORT', 'HEDGE', 'CASH'] as const).map(st => {
            const count = stats.stateDistribution[st] ?? 0;
            const pct   = stats.totalCycles > 0 ? (count / stats.totalCycles) * 100 : 0;
            if (pct < 1) return null;
            return (
              <View key={st} style={s.rowGap4}>
                <View style={[s.dot, { backgroundColor: STATE_COLOR[st] }]} />
                <Text style={[s.tinyLabel, { color: colors.mutedForeground }]}>{st} {pct.toFixed(0)}%</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ── Live Approvals Card ───────────────────────────────────────────────────────

function LiveApprovalsCard() {
  const colors = useColors();
  const { pendingApprovals, approveLiveOrder, rejectLiveOrder, pendingCount } = useAiEngine();
  const { engineState } = useEngine();

  const [approvingId, setApprovingId] = useState<string | null>(null);

  const pending = pendingApprovals.filter(a => a.status === 'PENDING');
  const recent  = pendingApprovals.filter(a => a.status !== 'PENDING').slice(0, 3);

  if (engineState !== EngineState.LIVE_TRADING && pendingCount === 0 && recent.length === 0) return null;

  const handleApprove = useCallback(async (a: PendingLiveApproval) => {
    setApprovingId(a.id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await approveLiveOrder(a.id);
    setApprovingId(null);
  }, [approveLiveOrder]);

  const handleReject = useCallback((a: PendingLiveApproval) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    rejectLiveOrder(a.id, 'Operator rejected');
  }, [rejectLiveOrder]);

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: '#f59e0b44' }]}>
      <View style={s.rowBetween}>
        <View style={s.rowGap6}>
          <Feather name="alert-circle" size={13} color="#f59e0b" />
          <Text style={[s.cardLabel, { color: colors.mutedForeground }]}>LIVE TRADE PROPOSALS</Text>
        </View>
        {pendingCount > 0 && (
          <View style={[s.badge, { backgroundColor: '#f59e0b' }]}>
            <Text style={s.badgeTxt}>{pendingCount} PENDING</Text>
          </View>
        )}
      </View>

      {pending.length === 0 && (
        <Text style={[s.rationale, { color: colors.mutedForeground }]}>
          {engineState === EngineState.LIVE_TRADING
            ? 'No pending proposals — AI will queue new proposals here.'
            : 'Switch to LIVE_TRADING to receive trade proposals.'}
        </Text>
      )}

      {pending.map(a => {
        const d          = a.decision;
        const stateColor = STATE_COLOR[d.operatingState] ?? colors.mutedForeground;
        const isApproving = approvingId === a.id;

        return (
          <View
            key={a.id}
            style={[s.approvalCard, {
              backgroundColor: '#f59e0b11',
              borderColor:     '#f59e0b44',
            }]}
          >
            <View style={s.rowBetween}>
              <View style={s.rowGap6}>
                <Feather name={STATE_ICON[d.operatingState] as any ?? 'cpu'} size={12} color={stateColor} />
                <Text style={[s.symbol, { color: colors.foreground }]}>
                  {d.primarySymbol ? `${d.primarySymbol}/USD` : 'MULTI'}
                </Text>
                <View style={[s.badge, { backgroundColor: stateColor + '22', borderColor: stateColor + '55', borderWidth: 1 }]}>
                  <Text style={[s.badgeTxt, { color: stateColor }]}>{d.operatingState}</Text>
                </View>
              </View>
              <Text style={[s.smallLabel, { color: colors.mutedForeground }]}>
                ⏱ {fmtExpiry(a.expiresAt)}
              </Text>
            </View>

            {/* Confidence */}
            <View style={s.rowGap6}>
              <Text style={[s.smallLabel, { color: colors.mutedForeground, width: 60 }]}>Confidence</Text>
              <View style={[s.confTrack, { flex: 1, backgroundColor: colors.secondary }]}>
                <View style={[s.confFill, {
                  width: `${d.confidence}%` as any,
                  backgroundColor: d.confidence >= 75 ? '#22c55e' : '#f59e0b',
                }]} />
              </View>
              <Text style={[s.smallLabel, { color: colors.foreground, width: 30, textAlign: 'right' }]}>
                {d.confidence}%
              </Text>
            </View>

            {/* Rationale */}
            <Text style={[s.rationale, { color: colors.mutedForeground }]} numberOfLines={2}>
              {d.stateRationale}
            </Text>

            {/* Order details */}
            {d.sizeUsd && (
              <View style={s.rowGap6}>
                <Text style={[s.tinyLabel, { color: colors.mutedForeground }]}>
                  Size: <Text style={{ color: colors.foreground }}>${d.sizeUsd.toLocaleString()}</Text>
                </Text>
                {d.leverage && (
                  <Text style={[s.tinyLabel, { color: colors.mutedForeground, marginLeft: 12 }]}>
                    Lev: <Text style={{ color: colors.foreground }}>{d.leverage}×</Text>
                  </Text>
                )}
                {d.tpPrice && (
                  <Text style={[s.tinyLabel, { color: colors.mutedForeground, marginLeft: 12 }]}>
                    TP: <Text style={{ color: '#22c55e' }}>${d.tpPrice.toLocaleString()}</Text>
                  </Text>
                )}
                {d.slPrice && (
                  <Text style={[s.tinyLabel, { color: colors.mutedForeground, marginLeft: 12 }]}>
                    SL: <Text style={{ color: '#ef4444' }}>${d.slPrice.toLocaleString()}</Text>
                  </Text>
                )}
              </View>
            )}

            {/* Approve / Reject */}
            <View style={[s.rowGap6, { marginTop: 4 }]}>
              <TouchableOpacity
                style={[s.approveBtn, { backgroundColor: '#22c55e', flex: 1 }]}
                onPress={() => handleApprove(a)}
                disabled={isApproving}
              >
                {isApproving
                  ? <ActivityIndicator size="small" color="#000" />
                  : <>
                      <Feather name="check" size={13} color="#000" />
                      <Text style={s.approveBtnTxt}>APPROVE</Text>
                    </>
                }
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.approveBtn, { backgroundColor: '#ef444422', borderColor: '#ef4444', borderWidth: 1, flex: 1 }]}
                onPress={() => handleReject(a)}
                disabled={isApproving}
              >
                <Feather name="x" size={13} color="#ef4444" />
                <Text style={[s.approveBtnTxt, { color: '#ef4444' }]}>REJECT</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {/* Recent resolved */}
      {recent.length > 0 && (
        <View style={{ marginTop: 4, gap: 4 }}>
          <Text style={[s.tinyLabel, { color: colors.mutedForeground }]}>RECENT</Text>
          {recent.map(a => {
            const statusColor = a.status === 'APPROVED' ? '#22c55e'
              : a.status === 'REJECTED' ? '#ef4444' : colors.mutedForeground;
            return (
              <View key={a.id} style={s.rowBetween}>
                <Text style={[s.tinyLabel, { color: colors.mutedForeground }]}>
                  {a.decision.primarySymbol ?? 'MULTI'} {a.decision.operatingState}
                </Text>
                <Text style={[s.tinyLabel, { color: statusColor }]}>{a.status}</Text>
              </View>
            );
          })}
        </View>
      )}

      <View style={[s.riskNote, { borderTopColor: colors.border }]}>
        <Feather name="shield" size={10} color={colors.warning} />
        <Text style={[s.tinyLabel, { color: colors.mutedForeground, flex: 1, lineHeight: 14 }]}>
          Real money only moves after operator APPROVE. Proposals auto-expire in 5 minutes.
        </Text>
      </View>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    engineState, stopNewOrdersActive, toggleStopNewOrders,
    cancelOpenOrders, triggerEmergencyStop, resetFromEmergency,
  } = useEngine();
  const { account, positions, trades } = useTrading();

  const [cancelConfirm,   setCancelConfirm]   = useState(false);
  const [emergencyConfirm, setEmergencyConfirm] = useState(false);
  const [canceling,       setCanceling]       = useState(false);

  const isEmergency     = engineState === EngineState.EMERGENCY_STOP;
  const todayPnlColor   = account.realizedPnlToday >= 0 ? colors.long : colors.short;
  const unrealizedColor = account.unrealizedPnl >= 0    ? colors.long : colors.short;
  const weeklyColor     = account.weeklyPnl >= 0        ? colors.long : colors.short;

  const todayStats = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = trades.filter(t => t.closeTime >= todayStart.getTime());
    // `pnl` is the mobile Trade field (not realizedPnl)
    const wins  = todayTrades.filter(t => t.pnl > 0).length;
    const count = todayTrades.length;
    return { count, wins, losses: count - wins, winRate: count > 0 ? (wins / count) * 100 : null };
  }, [trades]);

  const handleCancelOrders = async () => {
    setCancelConfirm(false);
    setCanceling(true);
    await cancelOpenOrders();
    setCanceling(false);
  };

  const handleEmergency = () => {
    setEmergencyConfirm(false);
    triggerEmergencyStop();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[s.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[s.headerTitle, { color: colors.foreground }]}>CRYPTO CTL</Text>
          <Text style={[s.headerSub,   { color: colors.mutedForeground }]}>GMX V2 · Arbitrum One</Text>
        </View>
        <EngineStatusBadge state={engineState} size="sm" />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 0) + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Emergency stop banner */}
        {isEmergency && (
          <View style={[s.emergencyBanner, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '55' }]}>
            <Feather name="alert-octagon" size={16} color={colors.destructive} />
            <Text style={[s.emergencyBannerTxt, { color: colors.destructive }]}>EMERGENCY STOP ACTIVE</Text>
            <TouchableOpacity
              style={[s.resetBtn, { backgroundColor: colors.warning }]}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); resetFromEmergency(); }}
            >
              <Text style={[s.resetBtnTxt, { color: '#000' }]}>Reset</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* AI 5-State Engine status */}
        <AiStateCard />

        {/* Live trade approval gate (only visible when relevant) */}
        <LiveApprovalsCard />

        {/* Daily performance KPI */}
        <DailyTargetCard />

        {/* Account card — GMX native (collateral, available, margin ratio) */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={s.cardHeader}>
            <Text style={[s.cardLabel, { color: colors.mutedForeground }]}>ACCOUNT BALANCE</Text>
            <View style={[s.modePill, { backgroundColor: colors.accent + '22' }]}>
              <Text style={[s.modePillTxt, { color: colors.accent }]}>PAPER</Text>
            </View>
          </View>
          <Text style={[s.balanceBig, { color: colors.foreground }]}>
            ${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </Text>
          <View style={s.balRow}>
            <View style={s.balItem}>
              <Text style={[s.balLabel, { color: colors.mutedForeground }]}>Collateral Bal.</Text>
              <Text style={[s.balValue, { color: colors.foreground }]}>${account.collateralBalanceUsd.toFixed(2)}</Text>
            </View>
            <View style={s.balItem}>
              <Text style={[s.balLabel, { color: colors.mutedForeground }]}>Available</Text>
              <Text style={[s.balValue, { color: colors.foreground }]}>${account.availableBalance.toFixed(2)}</Text>
            </View>
            <View style={s.balItem}>
              <Text style={[s.balLabel, { color: colors.mutedForeground }]}>Margin%</Text>
              <Text style={[s.balValue, { color: account.marginRatio > 0.5 ? colors.warning : colors.foreground }]}>
                {(account.marginRatio * 100).toFixed(1)}%
              </Text>
            </View>
          </View>
        </View>

        {/* PnL stats row */}
        <View style={s.statsRow}>
          {[
            { label: 'TODAY P&L',   value: account.realizedPnlToday, color: todayPnlColor },
            { label: 'UNREALIZED',  value: account.unrealizedPnl,    color: unrealizedColor },
            { label: 'WEEKLY',      value: account.weeklyPnl,        color: weeklyColor },
          ].map(st => (
            <View key={st.label} style={[s.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[s.statLabel, { color: colors.mutedForeground }]}>{st.label}</Text>
              <Text style={[s.statValue, { color: st.color }]}>
                {st.value >= 0 ? '+' : ''}${st.value.toFixed(2)}
              </Text>
            </View>
          ))}
        </View>

        {/* Today performance row */}
        <View style={s.statsRow}>
          <View style={[s.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[s.statLabel, { color: colors.mutedForeground }]}>WIN RATE</Text>
            <Text style={[s.statValue, { color: todayStats.winRate !== null ? (todayStats.winRate >= 50 ? colors.long : colors.short) : colors.mutedForeground }]}>
              {todayStats.winRate !== null ? `${todayStats.winRate.toFixed(0)}%` : '—'}
            </Text>
          </View>
          <View style={[s.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[s.statLabel, { color: colors.mutedForeground }]}>TRADES TODAY</Text>
            <Text style={[s.statValue, { color: colors.foreground }]}>{todayStats.count}</Text>
          </View>
          <View style={[s.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[s.statLabel, { color: colors.mutedForeground }]}>W / L</Text>
            <Text style={[s.statValue, { color: colors.foreground }]}>
              <Text style={{ color: colors.long }}>{todayStats.wins}</Text>
              {' / '}
              <Text style={{ color: colors.short }}>{todayStats.losses}</Text>
            </Text>
          </View>
        </View>

        {/* Positions summary — GMX collateral/size */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={s.posRow}>
            <View style={s.posStat}>
              <Text style={[s.posStatNum, { color: colors.primary }]}>{positions.length}</Text>
              <Text style={[s.posStatLbl, { color: colors.mutedForeground }]}>Open Positions</Text>
            </View>
            <View style={[s.posDivider, { backgroundColor: colors.border }]} />
            <View style={s.posStat}>
              <Text style={[s.posStatNum, { color: colors.foreground }]}>
                ${positions.reduce((sum, p) => sum + p.collateralUsd, 0).toFixed(0)}
              </Text>
              <Text style={[s.posStatLbl, { color: colors.mutedForeground }]}>Collateral USD</Text>
            </View>
            <View style={[s.posDivider, { backgroundColor: colors.border }]} />
            <View style={s.posStat}>
              <Text style={[s.posStatNum, { color: colors.foreground }]}>
                ${account.totalPositionValue.toFixed(0)}
              </Text>
              <Text style={[s.posStatLbl, { color: colors.mutedForeground }]}>Position Value</Text>
            </View>
          </View>
          {/* Funding / borrowing fees on open positions */}
          {positions.length > 0 && (
            <View style={[s.feesRow, { borderTopColor: colors.border }]}>
              <Text style={[s.tinyLbl, { color: colors.mutedForeground }]}>
                Funding fees: {'  '}
                <Text style={{ color: colors.warning }}>
                  ${positions.reduce((sum, p) => sum + p.pendingFundingFeeUsd, 0).toFixed(4)}
                </Text>
              </Text>
              <Text style={[s.tinyLbl, { color: colors.mutedForeground }]}>
                Borrowing fees: {'  '}
                <Text style={{ color: colors.warning }}>
                  ${positions.reduce((sum, p) => sum + p.pendingBorrowingFeeUsd, 0).toFixed(4)}
                </Text>
              </Text>
            </View>
          )}
        </View>

        {/* Quick controls */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>QUICK CONTROLS</Text>
          <View style={s.ctrlRow}>
            <TouchableOpacity
              style={[
                s.ctrlBtn, { flex: 1, borderWidth: 1 },
                stopNewOrdersActive
                  ? { backgroundColor: colors.warning + '22', borderColor: colors.warning }
                  : { backgroundColor: colors.secondary, borderColor: colors.border },
              ]}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); toggleStopNewOrders(); }}
            >
              <Feather
                name={stopNewOrdersActive ? 'pause-circle' : 'play-circle'}
                size={16}
                color={stopNewOrdersActive ? colors.warning : colors.mutedForeground}
              />
              <Text style={[s.ctrlBtnTxt, { color: stopNewOrdersActive ? colors.warning : colors.mutedForeground }]}>
                {stopNewOrdersActive ? 'Orders Stopped' : 'Stop New Orders'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.ctrlBtn, { backgroundColor: colors.secondary, flex: 1 }]}
              onPress={() => setCancelConfirm(true)}
              disabled={canceling}
            >
              <Feather name="x-circle" size={16} color={colors.mutedForeground} />
              <Text style={[s.ctrlBtnTxt, { color: colors.mutedForeground }]}>
                {canceling ? 'Canceling…' : 'Cancel Orders'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Emergency stop */}
        {!isEmergency && (
          <TouchableOpacity
            style={[s.emergencyBtn, { backgroundColor: colors.destructive }]}
            onPress={() => setEmergencyConfirm(true)}
            activeOpacity={0.8}
          >
            <Feather name="alert-octagon" size={22} color="#FFF" />
            <Text style={s.emergencyBtnTxt}>EMERGENCY STOP</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <ConfirmModal
        visible={cancelConfirm}
        title="Cancel All Open Orders?"
        message="This will cancel all currently open orders for paper trading positions."
        confirmLabel="Cancel Orders"
        dangerous={false}
        onConfirm={handleCancelOrders}
        onCancel={() => setCancelConfirm(false)}
      />
      <ConfirmModal
        visible={emergencyConfirm}
        title="EMERGENCY STOP"
        message="This will immediately halt all trading operations and stop the engine. Confirm to proceed."
        confirmLabel="STOP ENGINE"
        dangerous={true}
        onConfirm={handleEmergency}
        onCancel={() => setEmergencyConfirm(false)}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:             { flex: 1 },
  header:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1 },
  headerTitle:      { fontFamily: 'Inter_700Bold', fontSize: 18, letterSpacing: 3 },
  headerSub:        { fontFamily: 'Inter_400Regular', fontSize: 9, letterSpacing: 1, marginTop: -2 },
  scroll:           { flex: 1 },
  content:          { padding: 16, gap: 12 },

  // Emergency
  emergencyBanner:  { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 10, borderWidth: 1, gap: 8 },
  emergencyBannerTxt:{ fontFamily: 'Inter_600SemiBold', fontSize: 12, flex: 1 },
  resetBtn:         { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  resetBtnTxt:      { fontFamily: 'Inter_700Bold', fontSize: 12 },

  // Generic card
  card:             { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardHeader:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel:        { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.6 },

  // Row helpers
  rowBetween:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowGap6:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowGap4:          { flexDirection: 'row', alignItems: 'center', gap: 4 },

  // Badge
  badge:            { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeTxt:         { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.6, color: '#000' },

  // Confidence bar
  confTrack:        { height: 4, borderRadius: 2, overflow: 'hidden' },
  confFill:         { height: '100%', borderRadius: 2 },

  // Labels
  smallLabel:       { fontFamily: 'Inter_400Regular', fontSize: 10 },
  tinyLabel:        { fontFamily: 'Inter_400Regular', fontSize: 9 },
  rationale:        { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 15 },
  symbol:           { fontFamily: 'Inter_700Bold', fontSize: 13 },

  // Toggle button
  toggle:           { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  toggleTxt:        { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.5 },

  // Stats bar
  statsBar:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dot:              { width: 6, height: 6, borderRadius: 3 },

  // Approval card
  approvalCard:     { borderRadius: 10, borderWidth: 1, padding: 10, gap: 8 },
  approveBtn:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 8 },
  approveBtnTxt:    { fontFamily: 'Inter_700Bold', fontSize: 12, color: '#000' },
  riskNote:         { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingTop: 8, borderTopWidth: 1, marginTop: 4 },

  // Account
  modePill:         { borderRadius: 10 },
  modePillTxt:      { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.5, paddingHorizontal: 8, paddingVertical: 2 },
  balanceBig:       { fontFamily: 'Inter_700Bold', fontSize: 30, marginBottom: 4 },
  balRow:           { flexDirection: 'row' },
  balItem:          { flex: 1 },
  balLabel:         { fontFamily: 'Inter_500Medium', fontSize: 9, marginBottom: 2 },
  balValue:         { fontFamily: 'Inter_600SemiBold', fontSize: 13 },

  // Fees row
  feesRow:          { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, paddingTop: 8, marginTop: 4 },
  tinyLbl:          { fontFamily: 'Inter_400Regular', fontSize: 9 },

  // Stats
  statsRow:         { flexDirection: 'row', gap: 8 },
  statCard:         { flex: 1, borderRadius: 10, borderWidth: 1, padding: 10, alignItems: 'center', gap: 4 },
  statLabel:        { fontFamily: 'Inter_500Medium', fontSize: 9, letterSpacing: 0.4, textAlign: 'center' },
  statValue:        { fontFamily: 'Inter_700Bold', fontSize: 13 },

  // Positions
  posRow:           { flexDirection: 'row', alignItems: 'center' },
  posStat:          { flex: 1, alignItems: 'center', gap: 4 },
  posStatNum:       { fontFamily: 'Inter_700Bold', fontSize: 20 },
  posStatLbl:       { fontFamily: 'Inter_500Medium', fontSize: 9, textAlign: 'center' },
  posDivider:       { width: 1, height: 36 },

  // Controls
  sectionTitle:     { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.5 },
  ctrlRow:          { flexDirection: 'row', gap: 10 },
  ctrlBtn:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, padding: 12, borderRadius: 10 },
  ctrlBtnTxt:       { fontFamily: 'Inter_600SemiBold', fontSize: 12 },

  // Emergency stop button
  emergencyBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 18, borderRadius: 14 },
  emergencyBtnTxt:  { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#FFF', letterSpacing: 1 },
});
