/**
 * VpsStatusCard — mobile (React Native)
 *
 * Compact VPS engine status card for the Dashboard tab.
 * Shows system health, arm/disarm controls, and key telemetry.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  useVps, VpsEngineState, OperatingMode, STATE_COLORS, STATE_LABELS, timeAgo, formatUptime,
} from '@/contexts/VpsContext';

const MODE_CFG: Record<OperatingMode, { label: string; icon: string }> = {
  AUTONOMOUS_AI:   { label: 'AUTONOMOUS AI',   icon: 'cpu'    },
  MANUAL_OVERRIDE: { label: 'MANUAL OVERRIDE', icon: 'user'   },
  RISK_LOCKED:     { label: 'RISK LOCKED',     icon: 'shield' },
};
import { useColors } from '@/hooks/useColors';
import { ConfirmModal } from '@/components/ConfirmModal';

// ── Sub-components ────────────────────────────────────────────────────────────

function MetricRow({
  icon, label, value, color,
}: { icon: string; label: string; value: string; color?: string }) {
  const colors = useColors();
  return (
    <View style={styles.metricRow}>
      <Feather name={icon as any} size={11} color={colors.mutedForeground} style={{ width: 14 }} />
      <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: color ?? colors.foreground }]}>{value}</Text>
    </View>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

export function VpsStatusCard() {
  const colors = useColors();
  const {
    config, vpsState, operatingMode, connectionStatus, unattendedArmed, health,
    armUnattended, disarmUnattended,
  } = useVps();

  const [armModal, setArmModal] = useState(false);
  const [disarmModal, setDisarmModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const stateColor = STATE_COLORS[vpsState];
  const configured = Boolean(config.host.trim());

  const handleArm = async () => {
    setArmModal(false);
    setActionLoading(true);
    setActionError('');
    const result = await armUnattended();
    setActionLoading(false);
    if (result.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setActionError(result.error ?? 'Failed to arm VPS');
    }
  };

  const handleDisarm = async () => {
    setDisarmModal(false);
    setActionLoading(true);
    setActionError('');
    const result = await disarmUnattended();
    setActionLoading(false);
    if (result.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setActionError(result.error ?? 'Failed to disarm VPS');
    }
  };

  const isPulsing = vpsState === 'RUNNING' || vpsState === 'ARMED' || vpsState === 'RECONCILING';

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: stateColor + '44' }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={[
            styles.stateDot,
            { backgroundColor: stateColor },
            isPulsing && styles.stateDotPulse,
          ]} />
          <View>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>VPS Trading Engine</Text>
            {config.host.trim() ? (
              <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
                {config.host}:{config.port}
                {health.heartbeatLatencyMs != null && ` · ${health.heartbeatLatencyMs}ms`}
                {health.uptimeSeconds != null && ` · up ${formatUptime(health.uptimeSeconds)}`}
              </Text>
            ) : (
              <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Not configured</Text>
            )}
          </View>
        </View>
        <View style={[styles.stateBadge, { backgroundColor: stateColor + '22', borderColor: stateColor + '55' }]}>
          <Text style={[styles.stateBadgeTxt, { color: stateColor }]}>
            {STATE_LABELS[vpsState]}
          </Text>
        </View>
      </View>

      {/* Operating mode badge */}
      {(() => {
        const m = MODE_CFG[operatingMode];
        const modeColor = operatingMode === 'AUTONOMOUS_AI' ? colors.long
          : operatingMode === 'RISK_LOCKED' ? colors.short : '#f59e0b';
        return (
          <View style={[styles.modeBadge, { backgroundColor: modeColor + '15', borderColor: modeColor + '33' }]}>
            <Feather name={m.icon as any} size={11} color={modeColor} />
            <Text style={[styles.modeLabel, { color: modeColor }]}>{m.label}</Text>
          </View>
        );
      })()}

      {/* Architecture note */}
      <View style={[styles.noteBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
        <Feather name="info" size={11} color={colors.mutedForeground} />
        <Text style={[styles.noteTxt, { color: colors.mutedForeground }]}>
          This app is a monitoring interface only. The VPS trades 24/7 regardless of whether this app is open.
        </Text>
      </View>

      {/* Health metrics */}
      {configured && (
        <View style={[styles.healthGrid, { borderColor: colors.border }]}>
          <View style={styles.healthCol}>
            <MetricRow icon="radio" label="Heartbeat" value={timeAgo(health.lastHeartbeat)}
              color={health.lastHeartbeat && Date.now() - new Date(health.lastHeartbeat).getTime() < 30_000 ? colors.long : undefined} />
            <MetricRow icon="activity" label="User Stream" value={timeAgo(health.lastUserStream)}
              color={health.lastUserStream && Date.now() - new Date(health.lastUserStream).getTime() < 30_000 ? colors.long : undefined} />
            <MetricRow icon="rotate-ccw" label="Last Restart" value={timeAgo(health.lastRestart)} />
          </View>
          <View style={[styles.healthDivider, { backgroundColor: colors.border }]} />
          <View style={styles.healthCol}>
            <MetricRow icon="zap" label="Market Data" value={timeAgo(health.lastMarketUpdate)}
              color={health.lastMarketUpdate && Date.now() - new Date(health.lastMarketUpdate).getTime() < 30_000 ? colors.long : undefined} />
            <MetricRow icon="clock" label="Strategy" value={timeAgo(health.lastStrategyCycle)}
              color={health.lastStrategyCycle && Date.now() - new Date(health.lastStrategyCycle).getTime() < 30_000 ? colors.long : undefined} />
            <MetricRow
              icon="check-circle"
              label="Reconcile"
              value={
                health.reconciliation.status === 'complete'
                  ? `✓ ${health.reconciliation.matchedPositions}/${health.reconciliation.totalPositions}`
                  : health.reconciliation.status === 'in_progress' ? '…'
                  : health.reconciliation.status === 'failed' ? '✗ failed'
                  : '—'
              }
              color={health.reconciliation.status === 'complete' ? colors.long :
                     health.reconciliation.status === 'failed' ? colors.short : undefined}
            />
          </View>
        </View>
      )}

      {/* GMX + Risk lock row */}
      {configured && (
        <View style={styles.statusRow}>
          <View style={styles.statusItem}>
            <Feather
              name={health.gmxConnected ? 'check-circle' : 'x-circle'}
              size={12}
              color={health.gmxConnected ? colors.long : colors.short}
            />
            <Text style={[styles.statusTxt, { color: health.gmxConnected ? colors.long : colors.mutedForeground }]}>
              GMX: {health.gmxConnected ? 'OK' : 'Off'}
            </Text>
          </View>
          <View style={styles.statusItem}>
            <Feather
              name={health.riskLock ? 'alert-triangle' : 'shield'}
              size={12}
              color={health.riskLock ? colors.short : colors.mutedForeground}
            />
            <Text style={[styles.statusTxt, { color: health.riskLock ? colors.short : colors.mutedForeground }]}>
              {health.riskLock ? `Lock: ${health.riskLock.reason}` : 'Risk: Clear'}
            </Text>
          </View>
        </View>
      )}

      {/* Risk lock banner */}
      {vpsState === 'RISK_LOCKED' && health.riskLock && (
        <View style={[styles.lockBanner, { backgroundColor: colors.short + '15', borderColor: colors.short + '44' }]}>
          <Feather name="alert-triangle" size={14} color={colors.short} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.lockTitle, { color: colors.short }]}>VPS Risk Lock Active</Text>
            <Text style={[styles.lockSub, { color: colors.mutedForeground }]}>
              {health.riskLock.reason} · {timeAgo(health.riskLock.since)}
            </Text>
          </View>
        </View>
      )}

      {/* Action error */}
      {actionError !== '' && (
        <Text style={[styles.errorTxt, { color: colors.short }]}>{actionError}</Text>
      )}

      {/* Arm / Disarm button */}
      {configured && (
        actionLoading ? (
          <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 4 }} />
        ) : !unattendedArmed ? (
          <TouchableOpacity
            style={[styles.armBtn, { backgroundColor: '#0ea5e9' }]}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); setArmModal(true); }}
            disabled={connectionStatus !== 'connected'}
            activeOpacity={0.85}
          >
            <Feather name="zap" size={15} color="#000" />
            <Text style={styles.armBtnTxt}>ARM UNATTENDED TRADING</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.disarmBtn, { borderColor: '#06b6d4' + '55' }]}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setDisarmModal(true); }}
            activeOpacity={0.8}
          >
            <Feather name="shield-off" size={14} color="#06b6d4" />
            <Text style={[styles.disarmBtnTxt, { color: '#06b6d4' }]}>DISARM — Stop Autonomous Operation</Text>
          </TouchableOpacity>
        )
      )}

      {/* Warning note */}
      <View style={styles.warnRow}>
        <Feather name="alert-triangle" size={11} color={colors.warning} />
        <Text style={[styles.warnTxt, { color: colors.mutedForeground }]}>
          {unattendedArmed
            ? 'VPS is armed. Autonomous trading active 24/7.'
            : 'Live unattended trading requires a VPS with a GMX One-Click subaccount. Not enabled by default. Paper mode is always safe.'}
        </Text>
      </View>

      {/* ARM confirm modal */}
      <ConfirmModal
        visible={armModal}
        title="ARM Unattended Trading?"
        message={
          `When armed, the VPS will operate autonomously 24/7 — including while you sleep.\n\n` +
          `• If configured for LIVE trading, real orders will be placed on GMX V2 (Arbitrum One).\n` +
          `• The VPS uses a delegated subaccount key — never your primary wallet key.\n` +
          `• Risk controls remain active at all times.\n` +
          `• Live trading is NOT enabled by default.`
        }
        confirmLabel="ARM — I Understand"
        dangerous={false}
        onConfirm={handleArm}
        onCancel={() => setArmModal(false)}
      />

      {/* DISARM confirm modal */}
      <ConfirmModal
        visible={disarmModal}
        title="Disarm VPS?"
        message="The VPS will stop opening new autonomous positions. Existing positions will continue with their TP/SL orders until triggered or manually closed."
        confirmLabel="Disarm"
        dangerous={false}
        onConfirm={handleDisarm}
        onCancel={() => setDisarmModal(false)}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  stateDot: { width: 10, height: 10, borderRadius: 5 },
  stateDotPulse: { opacity: 0.9 },
  headerTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 1 },
  stateBadge: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1,
  },
  stateBadgeTxt: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 0.8 },
  modeBadge: {
    flexDirection: 'row' as const, alignItems: 'center' as const, gap: 7,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1,
  },
  modeLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 0.8 },
  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    padding: 10, borderRadius: 8, borderWidth: 1,
  },
  noteTxt: { fontFamily: 'Inter_400Regular', fontSize: 10, lineHeight: 15, flex: 1 },
  healthGrid: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 10, gap: 0 },
  healthCol: { flex: 1, gap: 7, paddingHorizontal: 4 },
  healthDivider: { width: 1, marginHorizontal: 8 },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metricLabel: { fontFamily: 'Inter_400Regular', fontSize: 10, flex: 1 },
  metricValue: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  statusRow: { flexDirection: 'row', gap: 16 },
  statusItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusTxt: { fontFamily: 'Inter_500Medium', fontSize: 11 },
  lockBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 12, borderRadius: 10, borderWidth: 1,
  },
  lockTitle: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  lockSub: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  errorTxt: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  armBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, borderRadius: 10,
  },
  armBtnTxt: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#000', letterSpacing: 0.6 },
  disarmBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 12, borderRadius: 10, borderWidth: 1,
  },
  disarmBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 12, letterSpacing: 0.4 },
  warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  warnTxt: { fontFamily: 'Inter_400Regular', fontSize: 10, lineHeight: 15, flex: 1 },
});
