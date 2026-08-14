import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEngine, EngineState } from '@/contexts/EngineContext';
import { useTrading } from '@/contexts/TradingContext';
import { useAuth } from '@/contexts/AuthContext';
import { useVps, STATE_COLORS, STATE_LABELS, timeAgo, type VpsConnectionStatus } from '@/contexts/VpsContext';
import { VpsStatusCard } from '@/components/VpsStatusCard';
import { EngineStatusBadge } from '@/components/EngineStatusBadge';
import { ConfirmModal } from '@/components/ConfirmModal';
import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '@/services/notifications';

// ── Tiny UI helpers ───────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return (
    <View style={[sh.secHeader, { borderBottomColor: colors.border }]}>
      <Text style={[sh.secTitle, { color: colors.mutedForeground }]}>{title}</Text>
    </View>
  );
}

function SettingRow({ label, sub, children }: { label: string; sub?: string; children?: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[sh.settRow, { borderBottomColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[sh.settLabel, { color: colors.foreground }]}>{label}</Text>
        {sub && <Text style={[sh.settSub, { color: colors.mutedForeground }]}>{sub}</Text>}
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
      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onPress(); }}
      disabled={disabled}
      style={[sh.dangerBtn, {
        backgroundColor: colors.destructive + '12',
        borderColor: colors.destructive + '40',
        opacity: disabled ? 0.5 : 1,
      }]}
      activeOpacity={0.8}
    >
      <Feather name={icon as any} size={16} color={colors.destructive} />
      <Text style={[sh.dangerBtnTxt, { color: colors.destructive }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────
export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { engineState, stopNewOrdersActive, toggleStopNewOrders, cancelOpenOrders, triggerEmergencyStop, resetFromEmergency } = useEngine();
  const { clearAllPositions } = useTrading();
  const { logout } = useAuth();

  // VPS context — polls live status from API server proxy
  const {
    config: vpsConfig, vpsState, connectionStatus: vpsConnStatus,
    connectionError: vpsConnError, health: vpsHealth,
    saveConfig: saveVpsConfig, testConnection: testVpsConn, disconnect: disconnectVps,
  } = useVps();

  // Local form state (mirrors context config; saves on blur/test)
  const [vpsHost, setVpsHost] = useState(vpsConfig.host);
  const [vpsPort, setVpsPort] = useState(vpsConfig.port);
  const [vpsSSL, setVpsSSL] = useState(vpsConfig.useSSL);
  const [vpsTesting, setVpsTesting] = useState(false);

  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [closeStep, setCloseStep] = useState<0 | 1 | 2>(0);
  const [emergencyConfirm, setEmergencyConfirm] = useState(false);
  const [processing, setProcessing] = useState(false);

  const isEmergency = engineState === EngineState.EMERGENCY_STOP;
  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  // ── Notification permission ────────────────────────────────────
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('undetermined');
  const [notifRequesting, setNotifRequesting] = useState(false);

  useEffect(() => {
    getNotificationPermission().then(setNotifPermission);
  }, []);

  const handleRequestNotif = async () => {
    setNotifRequesting(true);
    const status = await requestNotificationPermission();
    setNotifPermission(status);
    setNotifRequesting(false);
    if (status === 'granted') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleTestVps = async () => {
    await saveVpsConfig({ host: vpsHost, port: vpsPort, useSSL: vpsSSL });
    setVpsTesting(true);
    await testVpsConn();
    setVpsTesting(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleCancelOrders = async () => {
    setCancelConfirm(false);
    setProcessing(true);
    await cancelOpenOrders();
    setProcessing(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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

  const statusColors: Record<VpsConnectionStatus, string> = {
    connected: colors.long,
    connecting: colors.warning,
    error: colors.short,
    disconnected: colors.mutedForeground,
  };
  const statusDotColor = statusColors[vpsConnStatus];

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Settings</Text>
        <EngineStatusBadge state={engineState} size="sm" />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: botPad + 20 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
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
            Credentials are never stored on this device.
          </Text>
        </View>

        {/* ── NOTIFICATIONS ── */}
        {Platform.OS !== 'web' && (
          <>
            <SectionHeader title="NOTIFICATIONS" />
            <SettingRow
              label="Risk Alert Notifications"
              sub="Get alerts for margin, loss, and exposure limits even when the app is backgrounded"
            >
              {notifPermission === 'granted' ? (
                <View style={[styles.activeBadge, { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.long + '22', borderColor: colors.long + '44' }]}>
                  <Feather name="check" size={11} color={colors.long} />
                  <Text style={[styles.activeTxt, { color: colors.long }]}>ON</Text>
                </View>
              ) : notifRequesting ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <TouchableOpacity
                  onPress={handleRequestNotif}
                  style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1, backgroundColor: colors.primary + '20', borderColor: colors.primary + '50' }}
                >
                  <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 12, color: colors.primary }}>Enable</Text>
                </TouchableOpacity>
              )}
            </SettingRow>
            {notifPermission === 'denied' && (
              <View style={[styles.infoBox, { backgroundColor: colors.warning + '11', borderColor: colors.warning + '33' }]}>
                <Feather name="info" size={14} color={colors.warning} />
                <Text style={[styles.infoTxt, { color: colors.warning }]}>
                  Notifications are blocked. Enable them in your device Settings → Notifications.
                </Text>
              </View>
            )}
          </>
        )}

        {/* ── VPS TRADING ENGINE — live status + arm/disarm ── */}
        <SectionHeader title="VPS TRADING ENGINE" />

        {/* Live VPS status card — includes health grid, arm/disarm, architecture note */}
        <VpsStatusCard />

        {/* VPS connection settings */}
        <SectionHeader title="VPS CONNECTION SETTINGS" />
        <View style={[styles.vpsForm, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.vpsNote, { backgroundColor: colors.warning + '11', borderColor: colors.warning + '33' }]}>
            <Feather name="alert-triangle" size={12} color={colors.warning} />
            <Text style={[styles.vpsNoteTxt, { color: colors.warning }]}>
              The VPS holds only a delegated GMX subaccount key — never your primary wallet. Only connection metadata is stored here.
            </Text>
          </View>

          <View style={styles.vpsField}>
            <Text style={[styles.vpsLabel, { color: colors.mutedForeground }]}>HOST / IP ADDRESS</Text>
            <TextInput
              value={vpsHost}
              onChangeText={setVpsHost}
              onBlur={() => saveVpsConfig({ host: vpsHost, port: vpsPort, useSSL: vpsSSL })}
              placeholder="e.g. 192.168.1.100 or my-vps.example.com"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.vpsInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <View style={styles.vpsRow}>
            <View style={[styles.vpsField, { flex: 1 }]}>
              <Text style={[styles.vpsLabel, { color: colors.mutedForeground }]}>PORT</Text>
              <TextInput
                value={vpsPort}
                onChangeText={setVpsPort}
                onBlur={() => saveVpsConfig({ host: vpsHost, port: vpsPort, useSSL: vpsSSL })}
                placeholder="8080"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.vpsInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
                keyboardType="number-pad"
              />
            </View>

          </View>

          <View style={[styles.settRow, { borderBottomColor: 'transparent', paddingHorizontal: 0 }]}>
            <Text style={[styles.settLabel, { color: colors.foreground }]}>Use SSL / TLS</Text>
            <Switch
              value={vpsSSL}
              onValueChange={v => { setVpsSSL(v); saveVpsConfig({ host: vpsHost, port: vpsPort, useSSL: v }); }}
              trackColor={{ false: '#2A2D3A', true: colors.primary + '44' }}
              thumbColor={vpsSSL ? colors.primary : '#6B7280'}
            />
          </View>

          <TouchableOpacity
            style={[styles.vpsTestBtn, {
              backgroundColor: vpsConnStatus === 'connected' ? colors.secondary : colors.primary,
              opacity: vpsTesting || !vpsHost.trim() ? 0.6 : 1,
            }]}
            onPress={handleTestVps}
            disabled={vpsTesting || !vpsHost.trim()}
            activeOpacity={0.85}
          >
            {vpsTesting ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Feather name={vpsConnStatus === 'connected' ? 'wifi' : 'wifi-off'} size={15}
                color={vpsConnStatus === 'connected' ? colors.mutedForeground : colors.background} />
            )}
            <Text style={[styles.vpsTestTxt, { color: vpsConnStatus === 'connected' ? colors.mutedForeground : colors.background }]}>
              {vpsTesting ? 'Testing...' : vpsConnStatus === 'connected' ? 'Re-test Connection' : 'Test Connection'}
            </Text>
          </TouchableOpacity>

          {vpsConnError ? (
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: colors.short }}>{vpsConnError}</Text>
          ) : null}
        </View>

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
        <SettingRow label="Version" sub="Crypto Control Center v1.0.0 — Paper Trading" />
        <SettingRow label="Mode" sub="Standalone local app — no cloud sync" />
        <SettingRow label="Architecture" sub="VPS connection ready (configure above)" />
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
    </KeyboardAvoidingView>
  );
}

// Shared sub-component styles extracted for SectionHeader / SettingRow
const sh = StyleSheet.create({
  secHeader: { paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, marginTop: 8 },
  secTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.2 },
  settRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  settLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  settSub: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  dangerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 10, borderWidth: 1 },
  dangerBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1 },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  scroll: { flex: 1 },
  content: {},
  settRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  settLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  activeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },
  activeTxt: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  disabledBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  disabledTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  infoBox: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, marginHorizontal: 16, marginVertical: 8 },
  infoTxt: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18, flex: 1 },
  // VPS
  vpsStatusBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 6, padding: 12, borderRadius: 10, borderWidth: 1 },
  vpsStatusDot: { width: 8, height: 8, borderRadius: 4 },
  vpsStatusTxt: { fontFamily: 'Inter_700Bold', fontSize: 11, letterSpacing: 0.8 },
  vpsLatency: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  vpsErrorTxt: { fontFamily: 'Inter_400Regular', fontSize: 11, flex: 1 },
  vpsDisconnectBtn: { marginLeft: 'auto' as any, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  vpsDisconnectTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  vpsForm: { marginHorizontal: 16, marginVertical: 6, borderRadius: 12, borderWidth: 1, padding: 16, gap: 14 },
  vpsNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 8, borderWidth: 1 },
  vpsNoteTxt: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16, flex: 1 },
  vpsField: { gap: 6 },
  vpsRow: { flexDirection: 'row', gap: 10 },
  vpsLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.6 },
  vpsInput: { height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontFamily: 'Inter_400Regular', fontSize: 14 },
  vpsTestBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 10 },
  vpsTestTxt: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  // Controls
  dangerSection: { gap: 10 },
  emergencyActive: { margin: 16, padding: 16, borderRadius: 12, borderWidth: 1, alignItems: 'center', gap: 10 },
  emergencyActiveTxt: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  resetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  resetTxt: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  emergencyStopBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, margin: 16, padding: 16, borderRadius: 12 },
  emergencyStopTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.8 },
  emergencyNote: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17, paddingHorizontal: 20, paddingBottom: 8 },
});
