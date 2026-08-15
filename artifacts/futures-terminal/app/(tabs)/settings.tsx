import React, { useEffect, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
  Linking,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEngine, EngineState } from '@/contexts/EngineContext';
import { useTrading } from '@/contexts/TradingContext';
import { useAuth } from '@/contexts/AuthContext';
import { EngineStatusBadge } from '@/components/EngineStatusBadge';
import { ConfirmModal } from '@/components/ConfirmModal';
import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '@/services/notifications';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

// ── Tiny UI helpers ───────────────────────────────────────────────────────────

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

// ── GMX Executor Status Panel ─────────────────────────────────────────────────

interface ExecutorHealth {
  gmxConnected?: boolean;
  networkChainId?: number;
  walletAddress?: string;
  subaccountAddress?: string;
  subaccountExpiresAt?: string;
  subaccountActionsRemaining?: number;
  deploymentMode?: string;
}

function GmxSubaccountPanel() {
  const colors = useColors();
  const [health, setHealth] = useState<ExecutorHealth | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/executor/status`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) setHealth(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchHealth();
    setRefreshing(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const truncateAddr = (addr?: string) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';

  const expiresAt = health?.subaccountExpiresAt ? new Date(health.subaccountExpiresAt) : null;
  const isExpired = expiresAt ? expiresAt.getTime() < Date.now() : false;
  const expiresLabel = expiresAt
    ? (isExpired ? 'EXPIRED' : `Expires ${expiresAt.toLocaleDateString()}`)
    : '—';
  const expiryColor = isExpired ? colors.short : expiresAt ? colors.long : colors.mutedForeground;

  return (
    <View style={[gsa.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Security notice */}
      <View style={[gsa.secNote, { backgroundColor: colors.warning + '11', borderColor: colors.warning + '33' }]}>
        <Feather name="shield" size={12} color={colors.warning} />
        <Text style={[gsa.secNoteTxt, { color: colors.warning }]}>
          This panel shows read-only status from the execution engine. Private keys are never stored
          or requested here.
        </Text>
      </View>

      {health ? (
        <>
          {health.subaccountAddress && (
            <GsaRow label="Delegated subaccount" value={truncateAddr(health.subaccountAddress)} valueColor={colors.long} />
          )}
          {health.walletAddress && (
            <GsaRow label="Primary wallet" value={truncateAddr(health.walletAddress)} />
          )}
          <GsaRow label="Authorization" value={expiresLabel} valueColor={expiryColor} />
          {health.subaccountActionsRemaining != null && (
            <GsaRow
              label="Action quota"
              value={`${health.subaccountActionsRemaining.toLocaleString()} remaining`}
              valueColor={health.subaccountActionsRemaining < 10 ? colors.short : health.subaccountActionsRemaining < 50 ? colors.warning : colors.long}
            />
          )}
          {health.networkChainId && (
            <GsaRow label="Network" value={`Arbitrum One (${health.networkChainId})`} />
          )}
          <GsaRow
            label="GMX RPC"
            value={health.gmxConnected ? 'Connected' : 'Disconnected'}
            valueColor={health.gmxConnected ? colors.long : colors.short}
          />

          {isExpired && (
            <View style={[gsa.warnBox, { backgroundColor: colors.short + '11', borderColor: colors.short + '33' }]}>
              <Feather name="alert-triangle" size={12} color={colors.short} />
              <Text style={[gsa.warnTxt, { color: colors.short }]}>
                Authorization expired. Re-authorize on GMX to resume live trading.
              </Text>
            </View>
          )}

          <TouchableOpacity
            onPress={() => Linking.openURL('https://app.gmx.io/#/trade')}
            style={[gsa.linkBtn, { borderColor: colors.border }]}
            activeOpacity={0.75}
          >
            <Feather name="external-link" size={12} color={colors.primary} />
            <Text style={[gsa.linkTxt, { color: colors.primary }]}>Manage subaccount on GMX</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={gsa.stepsBox}>
            <Text style={[gsa.stepsTitle, { color: colors.foreground }]}>How to set up One-Click Trading:</Text>
            {[
              'Open GMX and go to Settings → One-Click Trading',
              'Authorize a delegated subaccount',
              'Fund the subaccount with execution gas (ETH on Arbitrum)',
              'Execution uses only the delegated key — never your primary wallet',
            ].map((step, i) => (
              <Text key={i} style={[gsa.stepsTxt, { color: colors.mutedForeground }]}>
                {i + 1}. {step}
              </Text>
            ))}
          </View>

          <TouchableOpacity
            onPress={() => Linking.openURL('https://app.gmx.io/#/trade')}
            style={[gsa.openGmxBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Feather name="external-link" size={14} color="#000" />
            <Text style={[gsa.openGmxTxt, { color: '#000' }]}>Open GMX to Enable</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity
        onPress={handleRefresh}
        disabled={refreshing}
        style={[gsa.refreshBtn, { borderColor: colors.border, opacity: refreshing ? 0.5 : 1 }]}
        activeOpacity={0.75}
      >
        {refreshing
          ? <ActivityIndicator size="small" color={colors.primary} />
          : <Feather name="refresh-cw" size={13} color={colors.mutedForeground} />
        }
        <Text style={[gsa.refreshTxt, { color: colors.mutedForeground }]}>
          {refreshing ? 'Refreshing…' : 'Refresh executor status'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function GsaRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  const colors = useColors();
  return (
    <View style={[gsa.row, { borderBottomColor: colors.border }]}>
      <Text style={[gsa.rowLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[gsa.rowValue, { color: valueColor ?? colors.foreground }]}>{value}</Text>
    </View>
  );
}

const gsa = StyleSheet.create({
  card:        { marginHorizontal: 16, marginVertical: 6, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  secNote:     { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderBottomWidth: 1, borderColor: 'transparent' },
  secNoteTxt:  { fontFamily: 'Inter_400Regular', fontSize: 10, lineHeight: 15, flex: 1 },
  row:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  rowLabel:    { fontFamily: 'Inter_400Regular', fontSize: 12 },
  rowValue:    { fontFamily: 'Inter_600SemiBold', fontSize: 12, fontVariant: ['tabular-nums'] },
  warnBox:     { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderWidth: 1, margin: 12, borderRadius: 8 },
  warnTxt:     { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 15, flex: 1 },
  linkBtn:     { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  linkTxt:     { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  stepsBox:    { padding: 14, gap: 6 },
  stepsTitle:  { fontFamily: 'Inter_600SemiBold', fontSize: 12, marginBottom: 4 },
  stepsTxt:    { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17 },
  openGmxBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 14, marginBottom: 12, padding: 12, borderRadius: 10 },
  openGmxTxt:  { fontFamily: 'Inter_700Bold', fontSize: 13 },
  refreshBtn:  { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  refreshTxt:  { fontFamily: 'Inter_400Regular', fontSize: 11 },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { engineState, stopNewOrdersActive, toggleStopNewOrders, cancelOpenOrders, triggerEmergencyStop, resetFromEmergency } = useEngine();
  const { clearAllPositions } = useTrading();
  const { logout } = useAuth();

  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [closeStep, setCloseStep] = useState<0 | 1 | 2>(0);
  const [emergencyConfirm, setEmergencyConfirm] = useState(false);
  const [processing, setProcessing] = useState(false);

  const isEmergency = engineState === EngineState.EMERGENCY_STOP;
  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  // ── Notification permission ────────────────────────────────────────────────
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

  const handleCancelOrders = async () => {
    setCancelConfirm(false);
    setProcessing(true);
    await cancelOpenOrders();
    setProcessing(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleCloseStep1Confirm = () => {
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
          sub="Requires GMX One-Click subaccount configuration below"
        >
          <View style={[styles.disabledBadge, { backgroundColor: colors.secondary }]}>
            <Feather name="lock" size={12} color={colors.mutedForeground} />
            <Text style={[styles.disabledTxt, { color: colors.mutedForeground }]}>Locked</Text>
          </View>
        </SettingRow>

        <View style={[styles.infoBox, { backgroundColor: colors.primary + '11', borderColor: colors.primary + '33' }]}>
          <Feather name="info" size={14} color={colors.primary} />
          <Text style={[styles.infoTxt, { color: colors.primary }]}>
            Replit handles AI decisions, operator approval gate, and risk monitoring.
            Real GMX order execution requires One-Click subaccount setup.
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

        {/* ── GMX ONE-CLICK SUBACCOUNT ── */}
        <SectionHeader title="GMX ONE-CLICK SUBACCOUNT" />
        <GmxSubaccountPanel />

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
          Emergency stop immediately halts all engine operations and locks trading until manually reset.
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
        <SettingRow label="Mode" sub="Replit — AI decisions · Approval gate · Risk monitoring" />
        <SettingRow label="Exchange" sub="GMX V2 · Arbitrum One" />
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
  dangerSection: { gap: 10 },
  emergencyActive: { margin: 16, padding: 16, borderRadius: 12, borderWidth: 1, alignItems: 'center', gap: 10 },
  emergencyActiveTxt: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  resetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  resetTxt: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  emergencyStopBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, margin: 16, padding: 16, borderRadius: 12 },
  emergencyStopTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.8 },
  emergencyNote: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17, paddingHorizontal: 20, paddingBottom: 8 },
});
