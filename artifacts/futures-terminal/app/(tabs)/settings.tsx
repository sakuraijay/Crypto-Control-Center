import React, { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEngine, EngineState } from '@/contexts/EngineContext';
import { useTrading } from '@/contexts/TradingContext';
import { useAuth } from '@/contexts/AuthContext';
import { EngineStatusBadge } from '@/components/EngineStatusBadge';
import { ConfirmModal } from '@/components/ConfirmModal';

function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return (
    <View style={[styles.secHeader, { borderBottomColor: colors.border }]}>
      <Text style={[styles.secTitle, { color: colors.mutedForeground }]}>{title}</Text>
    </View>
  );
}

function SettingRow({ label, sub, children }: { label: string; sub?: string; children?: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.settRow, { borderBottomColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.settLabel, { color: colors.foreground }]}>{label}</Text>
        {sub ? <Text style={[styles.settSub, { color: colors.mutedForeground }]}>{sub}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function DangerButton({ label, icon, onPress, disabled }: {
  label: string; icon: string; onPress: () => void; disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <TouchableOpacity
      style={[
        styles.dangerBtn,
        { borderColor: disabled ? colors.border : colors.destructive + '66', opacity: disabled ? 0.5 : 1 },
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Feather name={icon as any} size={15} color={disabled ? colors.mutedForeground : colors.destructive} />
      <Text style={[styles.dangerBtnTxt, { color: disabled ? colors.mutedForeground : colors.destructive }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { engineState, stopNewOrdersActive, setEngineState, toggleStopNewOrders,
    cancelOpenOrders, triggerEmergencyStop, resetFromEmergency } = useEngine();
  const { clearAllPositions } = useTrading();
  const { logout } = useAuth();

  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [closeStep, setCloseStep] = useState<0 | 1 | 2>(0);
  const [emergencyConfirm, setEmergencyConfirm] = useState(false);
  const [processing, setProcessing] = useState(false);

  const isEmergency = engineState === EngineState.EMERGENCY_STOP;
  const isLiveMode = engineState === EngineState.LIVE_READY || engineState === EngineState.LIVE_TRADING;
  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const handleCancelOrders = async () => {
    setCancelConfirm(false);
    setProcessing(true);
    await cancelOpenOrders();
    setProcessing(false);
  };

  const handleCloseStep1Confirm = () => {
    setCloseStep(0);
    setCloseStep(2);
  };

  const handleCloseAllFinal = async () => {
    setCloseStep(0);
    setProcessing(true);
    await new Promise<void>(r => setTimeout(r, 800));
    clearAllPositions();
    setProcessing(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleEmergency = () => {
    setEmergencyConfirm(false);
    triggerEmergencyStop();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Settings</Text>
        <EngineStatusBadge state={engineState} size="sm" />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: botPad + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── ENGINE MODE ── */}
        <SectionHeader title="ENGINE MODE" />
        <SettingRow
          label="Paper Trading (ACTIVE)"
          sub="Safe mode — no real orders executed"
        >
          <View style={[styles.activeBadge, { backgroundColor: colors.accent + '22', borderColor: colors.accent + '44' }]}>
            <Text style={[styles.activeTxt, { color: colors.accent }]}>ON</Text>
          </View>
        </SettingRow>
        <SettingRow
          label="Live Trading"
          sub="Connect to VPS execution service to enable"
        >
          <View style={[styles.disabledBadge, { backgroundColor: colors.secondary }]}>
            <Feather name="lock" size={12} color={colors.mutedForeground} />
            <Text style={[styles.disabledTxt, { color: colors.mutedForeground }]}>Locked</Text>
          </View>
        </SettingRow>

        <View style={[styles.infoBox, { backgroundColor: colors.warning + '11', borderColor: colors.warning + '33' }]}>
          <Feather name="info" size={14} color={colors.warning} />
          <Text style={[styles.infoTxt, { color: colors.warning }]}>
            Live trading requires connecting to a separate private VPS execution service.
            Credentials are never stored on this device. This prevents accidental live trading.
          </Text>
        </View>

        {/* ── VPS CONNECTION ── */}
        <SectionHeader title="VPS EXECUTION SERVICE" />
        <SettingRow label="Connection Status" sub="Not configured">
          <View style={[styles.offlineBadge, { backgroundColor: colors.secondary }]}>
            <View style={[styles.offlineDot, { backgroundColor: colors.mutedForeground }]} />
            <Text style={[styles.offlineTxt, { color: colors.mutedForeground }]}>OFFLINE</Text>
          </View>
        </SettingRow>
        <SettingRow label="Configure VPS" sub="Set host, port, and API keys on the VPS — coming in v2" />

        {/* ── STOP CONTROLS ── */}
        <SectionHeader title="ENGINE CONTROLS" />
        <SettingRow
          label="Stop New Orders"
          sub={stopNewOrdersActive ? 'Active — engine will not place new orders' : 'Allow engine to place new orders normally'}
        >
          <Switch
            value={stopNewOrdersActive}
            onValueChange={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); toggleStopNewOrders(); }}
            trackColor={{ false: '#2A2D3A', true: '#FF980044' }}
            thumbColor={stopNewOrdersActive ? colors.warning : '#6B7280'}
          />
        </SettingRow>

        <View style={[styles.dangerSection, { padding: 16 }]}>
          <DangerButton
            label={processing ? 'Processing...' : 'Cancel All Open Orders'}
            icon="x-circle"
            onPress={() => setCancelConfirm(true)}
            disabled={processing}
          />
          <DangerButton
            label={processing ? 'Processing...' : 'Close All Positions'}
            icon="trending-down"
            onPress={() => setCloseStep(1)}
            disabled={processing}
          />
        </View>

        {/* ── EMERGENCY STOP ── */}
        <SectionHeader title="EMERGENCY" />
        {isEmergency ? (
          <View style={[styles.emergencyActive, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '55' }]}>
            <Feather name="alert-octagon" size={18} color={colors.destructive} />
            <Text style={[styles.emergencyActiveTxt, { color: colors.destructive }]}>
              Emergency Stop is ACTIVE
            </Text>
            <TouchableOpacity
              style={[styles.resetBtn, { backgroundColor: colors.warning }]}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); resetFromEmergency(); }}
            >
              <Text style={[styles.resetTxt, { color: '#000' }]}>Reset to Paper Trading</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.emergencyStopBtn, { backgroundColor: colors.destructive }]}
            onPress={() => setEmergencyConfirm(true)}
            activeOpacity={0.8}
          >
            <Feather name="alert-octagon" size={20} color="#FFF" />
            <Text style={styles.emergencyStopTxt}>EMERGENCY STOP</Text>
          </TouchableOpacity>
        )}
        <Text style={[styles.emergencyNote, { color: colors.mutedForeground }]}>
          Emergency stop immediately halts all engine operations, cancels pending orders, and locks trading until manually reset.
        </Text>

        {/* ── SECURITY ── */}
        <SectionHeader title="SECURITY" />
        <TouchableOpacity
          style={[styles.settRow, { borderBottomColor: colors.border }]}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); logout(); }}
        >
          <Text style={[styles.settLabel, { color: colors.destructive }]}>Lock App</Text>
          <Feather name="lock" size={16} color={colors.destructive} />
        </TouchableOpacity>

        {/* ── ABOUT ── */}
        <SectionHeader title="ABOUT" />
        <SettingRow label="Version" sub="Futures Terminal v1.0.0 — Paper Trading" />
        <SettingRow label="Mode" sub="Standalone local app — no cloud sync" />
        <SettingRow label="Architecture" sub="Ready for VPS connection in v2" />
      </ScrollView>

      {/* Modals */}
      <ConfirmModal
        visible={cancelConfirm}
        title="Cancel All Open Orders?"
        message="All currently open orders will be canceled immediately. Positions will remain open."
        confirmLabel="Cancel Orders"
        dangerous={false}
        onConfirm={handleCancelOrders}
        onCancel={() => setCancelConfirm(false)}
      />
      <ConfirmModal
        visible={closeStep === 1}
        title="Close All Positions?"
        message="This will close ALL open positions at market price. Are you sure you want to proceed?"
        confirmLabel="Continue"
        dangerous={true}
        onConfirm={handleCloseStep1Confirm}
        onCancel={() => setCloseStep(0)}
      />
      <ConfirmModal
        visible={closeStep === 2}
        title="FINAL CONFIRMATION"
        message="This is your last chance to cancel. ALL positions will be closed at market price immediately. This cannot be undone."
        confirmLabel="Close All Positions"
        dangerous={true}
        onConfirm={handleCloseAllFinal}
        onCancel={() => setCloseStep(0)}
      />
      <ConfirmModal
        visible={emergencyConfirm}
        title="Emergency Stop"
        message="This will immediately halt all trading. The engine must be manually reset before trading can resume."
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
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  scroll: { flex: 1 },
  content: {},
  secHeader: { paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, marginTop: 8 },
  secTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.2 },
  settRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1,
  },
  settLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  settSub: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  activeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },
  activeTxt: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  disabledBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  disabledTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  infoBox: {
    flexDirection: 'row', gap: 10, padding: 14, borderRadius: 10, borderWidth: 1,
    marginHorizontal: 16, marginVertical: 8,
  },
  infoTxt: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18, flex: 1 },
  offlineBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  offlineDot: { width: 5, height: 5, borderRadius: 3 },
  offlineTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.5 },
  dangerSection: { gap: 10 },
  dangerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: 14, borderRadius: 10, borderWidth: 1,
  },
  dangerBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  emergencyActive: {
    margin: 16, padding: 16, borderRadius: 12, borderWidth: 1,
    alignItems: 'center', gap: 10,
  },
  emergencyActiveTxt: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  resetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  resetTxt: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  emergencyStopBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, margin: 16, padding: 16, borderRadius: 12,
  },
  emergencyStopTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.8 },
  emergencyNote: {
    fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17,
    paddingHorizontal: 20, paddingBottom: 8,
  },
});
