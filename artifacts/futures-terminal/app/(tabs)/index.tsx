import React, { useState, useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEngine, EngineState } from '@/contexts/EngineContext';
import { useTrading } from '@/contexts/TradingContext';
import { EngineStatusBadge } from '@/components/EngineStatusBadge';
import { ConfirmModal } from '@/components/ConfirmModal';
import { VpsStatusCard } from '@/components/VpsStatusCard';
import { DailyTargetCard } from '@/components/DailyTargetCard';

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { engineState, stopNewOrdersActive, toggleStopNewOrders, cancelOpenOrders, triggerEmergencyStop, resetFromEmergency } = useEngine();
  const { account, positions, trades } = useTrading();

  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [emergencyConfirm, setEmergencyConfirm] = useState(false);
  const [canceling, setCanceling] = useState(false);

  const isEmergency = engineState === EngineState.EMERGENCY_STOP;
  const todayPnlColor = account.realizedPnlToday >= 0 ? colors.long : colors.short;
  const unrealizedColor = account.unrealizedPnl >= 0 ? colors.long : colors.short;
  const weeklyColor = account.weeklyPnl >= 0 ? colors.long : colors.short;

  // Compute today's stats from trades
  const todayStats = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = trades.filter(t => t.closeTime >= todayStart.getTime());
    const wins = todayTrades.filter(t => t.realizedPnl > 0).length;
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
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>FUTURES</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>TERMINAL</Text>
        </View>
        <EngineStatusBadge state={engineState} size="sm" />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Emergency stop banner */}
        {isEmergency && (
          <View style={[styles.emergencyBanner, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '55' }]}>
            <Feather name="alert-octagon" size={16} color={colors.destructive} />
            <Text style={[styles.emergencyBannerTxt, { color: colors.destructive }]}>EMERGENCY STOP ACTIVE</Text>
            <TouchableOpacity
              style={[styles.resetBtn, { backgroundColor: colors.warning }]}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); resetFromEmergency(); }}
            >
              <Text style={[styles.resetBtnTxt, { color: '#000' }]}>Reset</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* VPS Engine Status — always visible, trading authority */}
        <VpsStatusCard />

        {/* Daily Performance KPI — monitoring only, never drives risk */}
        <DailyTargetCard />

        {/* Account card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>ACCOUNT BALANCE</Text>
            <View style={[styles.modePill, { backgroundColor: colors.accent + '22' }]}>
              <Text style={[styles.modePill, { color: colors.accent, paddingHorizontal: 8, paddingVertical: 2 }]}>PAPER</Text>
            </View>
          </View>
          <Text style={[styles.balanceBig, { color: colors.foreground }]}>
            ${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </Text>
          <View style={styles.balRow}>
            <View style={styles.balItem}>
              <Text style={[styles.balLabel, { color: colors.mutedForeground }]}>Margin Bal.</Text>
              <Text style={[styles.balValue, { color: colors.foreground }]}>${account.marginBalance.toFixed(2)}</Text>
            </View>
            <View style={styles.balItem}>
              <Text style={[styles.balLabel, { color: colors.mutedForeground }]}>Available</Text>
              <Text style={[styles.balValue, { color: colors.foreground }]}>${account.availableBalance.toFixed(2)}</Text>
            </View>
            <View style={styles.balItem}>
              <Text style={[styles.balLabel, { color: colors.mutedForeground }]}>Margin%</Text>
              <Text style={[styles.balValue, { color: account.marginRatio > 0.5 ? colors.warning : colors.foreground }]}>
                {(account.marginRatio * 100).toFixed(1)}%
              </Text>
            </View>
          </View>
        </View>

        {/* PNL row */}
        <View style={styles.statsRow}>
          {[
            { label: 'TODAY P&L', value: account.realizedPnlToday, color: todayPnlColor },
            { label: 'UNREALIZED', value: account.unrealizedPnl, color: unrealizedColor },
            { label: 'WEEKLY', value: account.weeklyPnl, color: weeklyColor },
          ].map(s => (
            <View key={s.label} style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
              <Text style={[styles.statValue, { color: s.color }]}>
                {s.value >= 0 ? '+' : ''}${s.value.toFixed(2)}
              </Text>
            </View>
          ))}
        </View>

        {/* Today performance row */}
        <View style={styles.statsRow}>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>WIN RATE</Text>
            <Text style={[styles.statValue, { color: todayStats.winRate !== null ? (todayStats.winRate >= 50 ? colors.long : colors.short) : colors.mutedForeground }]}>
              {todayStats.winRate !== null ? `${todayStats.winRate.toFixed(0)}%` : '—'}
            </Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>TRADES TODAY</Text>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {todayStats.count}
            </Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>W / L</Text>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              <Text style={{ color: colors.long }}>{todayStats.wins}</Text>
              {' / '}
              <Text style={{ color: colors.short }}>{todayStats.losses}</Text>
            </Text>
          </View>
        </View>

        {/* Positions summary */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.posRow}>
            <View style={styles.posStat}>
              <Text style={[styles.posStatNum, { color: colors.primary }]}>{positions.length}</Text>
              <Text style={[styles.posStatLbl, { color: colors.mutedForeground }]}>Open Positions</Text>
            </View>
            <View style={[styles.posDivider, { backgroundColor: colors.border }]} />
            <View style={styles.posStat}>
              <Text style={[styles.posStatNum, { color: colors.foreground }]}>
                ${positions.reduce((s, p) => s + p.collateralUsd, 0).toFixed(0)}
              </Text>
              <Text style={[styles.posStatLbl, { color: colors.mutedForeground }]}>Collateral</Text>
            </View>
            <View style={[styles.posDivider, { backgroundColor: colors.border }]} />
            <View style={styles.posStat}>
              <Text style={[styles.posStatNum, { color: colors.foreground }]}>
                ${account.totalPositionValue.toFixed(0)}
              </Text>
              <Text style={[styles.posStatLbl, { color: colors.mutedForeground }]}>Position Value</Text>
            </View>
          </View>
        </View>

        {/* Quick controls */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>QUICK CONTROLS</Text>
          <View style={styles.ctrlRow}>
            <TouchableOpacity
              style={[
                styles.ctrlBtn,
                {
                  backgroundColor: stopNewOrdersActive ? colors.warning + '22' : colors.secondary,
                  borderColor: stopNewOrdersActive ? colors.warning : colors.border,
                  borderWidth: 1,
                  flex: 1,
                },
              ]}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); toggleStopNewOrders(); }}
            >
              <Feather name={stopNewOrdersActive ? 'pause-circle' : 'play-circle'} size={16} color={stopNewOrdersActive ? colors.warning : colors.mutedForeground} />
              <Text style={[styles.ctrlBtnTxt, { color: stopNewOrdersActive ? colors.warning : colors.mutedForeground }]}>
                {stopNewOrdersActive ? 'Orders Stopped' : 'Stop New Orders'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.ctrlBtn, { backgroundColor: colors.secondary, flex: 1 }]}
              onPress={() => setCancelConfirm(true)}
              disabled={canceling}
            >
              <Feather name="x-circle" size={16} color={colors.mutedForeground} />
              <Text style={[styles.ctrlBtnTxt, { color: colors.mutedForeground }]}>
                {canceling ? 'Canceling...' : 'Cancel Orders'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Emergency stop */}
        {!isEmergency ? (
          <TouchableOpacity
            style={[styles.emergencyBtn, { backgroundColor: colors.destructive }]}
            onPress={() => setEmergencyConfirm(true)}
            activeOpacity={0.8}
          >
            <Feather name="alert-octagon" size={22} color="#FFFFFF" />
            <Text style={styles.emergencyBtnTxt}>EMERGENCY STOP</Text>
          </TouchableOpacity>
        ) : null}

        <View style={{ height: insets.bottom + (Platform.OS === 'web' ? 34 : 0) + 16 }} />
      </ScrollView>

      {/* Confirm: cancel orders */}
      <ConfirmModal
        visible={cancelConfirm}
        title="Cancel All Open Orders?"
        message="This will cancel all currently open orders for paper trading positions."
        confirmLabel="Cancel Orders"
        dangerous={false}
        onConfirm={handleCancelOrders}
        onCancel={() => setCancelConfirm(false)}
      />

      {/* Confirm: emergency stop */}
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, letterSpacing: 4 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 10, letterSpacing: 4, marginTop: -2 },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 12 },
  emergencyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  emergencyBannerTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 12, flex: 1 },
  resetBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  resetBtnTxt: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  card: { borderRadius: 12, borderWidth: 1, padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  cardLabel: { fontFamily: 'Inter_500Medium', fontSize: 10, letterSpacing: 0.5 },
  modePill: { fontFamily: 'Inter_700Bold', fontSize: 10, borderRadius: 10, letterSpacing: 0.5 },
  balanceBig: { fontFamily: 'Inter_700Bold', fontSize: 32, marginBottom: 12 },
  balRow: { flexDirection: 'row', gap: 0 },
  balItem: { flex: 1 },
  balLabel: { fontFamily: 'Inter_500Medium', fontSize: 10, marginBottom: 2 },
  balValue: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  statsRow: { flexDirection: 'row', gap: 8 },
  statCard: { flex: 1, borderRadius: 10, borderWidth: 1, padding: 12, alignItems: 'center', gap: 4 },
  statLabel: { fontFamily: 'Inter_500Medium', fontSize: 9, letterSpacing: 0.4, textAlign: 'center' },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  posRow: { flexDirection: 'row', alignItems: 'center' },
  posStat: { flex: 1, alignItems: 'center', gap: 4 },
  posStatNum: { fontFamily: 'Inter_700Bold', fontSize: 22 },
  posStatLbl: { fontFamily: 'Inter_500Medium', fontSize: 10, textAlign: 'center' },
  posDivider: { width: 1, height: 36 },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.5, marginBottom: 10 },
  ctrlRow: { flexDirection: 'row', gap: 10 },
  ctrlBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, padding: 12, borderRadius: 10,
  },
  ctrlBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  emergencyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, padding: 18, borderRadius: 14,
  },
  emergencyBtnTxt: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#FFFFFF', letterSpacing: 1 },
});
