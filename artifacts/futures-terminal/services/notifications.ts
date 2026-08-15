/**
 * Notification service for Expo — wraps expo-notifications.
 *
 * Channels (Android):
 *  • risk-alerts     — Risk control events (RISK_LOCKED, emergency)
 *  • live-approvals  — New LIVE trade proposals awaiting operator approval
 *  • system-events   — Connection health, relay, reconciliation, restart
 *
 * All notifications fire immediately (trigger: null) and work when foregrounded
 * or backgrounded.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// ── Foreground handler ─────────────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
    shouldShowList:   true,
  }),
});

// ── Types ──────────────────────────────────────────────────────────────────────

export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

// ── Permission helpers ────────────────────────────────────────────────────────

/** Request notification permissions. Returns the final status. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (Platform.OS === 'web') return 'denied';
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return 'granted';
  const { status } = await Notifications.requestPermissionsAsync();
  return status as NotificationPermission;
}

/** Check current permission status without prompting. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (Platform.OS === 'web') return 'denied';
  const { status } = await Notifications.getPermissionsAsync();
  return status as NotificationPermission;
}

// ── Low-level scheduler ───────────────────────────────────────────────────────

async function scheduleNow(
  title: string,
  body: string,
  data: Record<string, unknown>,
  identifier?: string,
  channelId = 'risk-alerts',
): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    if (identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
    }
    return await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title,
        body,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: { channelId, ...data },
      },
      trigger: null,
    });
  } catch {
    return null;
  }
}

// ── Risk alert ────────────────────────────────────────────────────────────────

/**
 * Generic risk/safety alert.
 * Identifier can be reused to cancel a previous duplicate.
 */
export async function scheduleRiskAlert(
  title: string,
  body: string,
  identifier?: string,
): Promise<string | null> {
  return scheduleNow(title, body, { type: 'risk_alert' }, identifier, 'risk-alerts');
}

// ── LIVE trade approval ───────────────────────────────────────────────────────

/**
 * Fire when the AI queues a new live-trade proposal awaiting operator approval.
 * @param approvalId   Unique approval ID (used as notification identifier for dedup)
 * @param symbol       GMX index symbol, e.g. "BTC"
 * @param direction    AiOperatingState, e.g. "LONG"
 * @param expiresInMin Minutes until the proposal auto-expires
 */
export async function scheduleLiveApprovalAlert(
  approvalId: string,
  symbol: string,
  direction: string,
  expiresInMin: number,
): Promise<string | null> {
  const title = `🔔 LIVE Trade Proposal — ${symbol}/USD`;
  const body  = `AI recommends ${direction}. Approve within ${expiresInMin} min or it expires.`;
  return scheduleNow(
    title, body,
    { type: 'live_approval', approvalId, symbol, direction },
    `live-approval-${approvalId}`,
    'live-approvals',
  );
}

// ── Risk lock ─────────────────────────────────────────────────────────────────

/**
 * Fire when engine transitions to RISK_LOCKED.
 */
export async function scheduleRiskLockAlert(reason: string): Promise<string | null> {
  return scheduleNow(
    '⛔ Engine RISK LOCKED',
    reason,
    { type: 'risk_lock', reason },
    'risk-lock-event',
    'risk-alerts',
  );
}

// ── Connection / relay health ─────────────────────────────────────────────────

/**
 * Fire when relay, RPC, or API server connection changes state.
 * @param status   'degraded' | 'down' | 'recovered'
 * @param message  Human-readable message
 */
export async function scheduleConnectionHealthAlert(
  status: 'degraded' | 'down' | 'recovered',
  message: string,
): Promise<string | null> {
  const icons: Record<string, string> = {
    degraded: '⚠️', down: '🔴', recovered: '🟢',
  };
  return scheduleNow(
    `${icons[status] ?? '🔌'} Connection ${status}`,
    message,
    { type: 'connection_health', status },
    `connection-health-${status}`,
    'system-events',
  );
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * Fire when the position reconciliation detects a mismatch between local
 * and on-chain state.
 */
export async function scheduleReconciliationAlert(message: string): Promise<string | null> {
  return scheduleNow(
    '🔄 Position Reconciliation Required',
    message,
    { type: 'reconciliation' },
    'reconciliation-alert',
    'system-events',
  );
}

// ── Restart ───────────────────────────────────────────────────────────────────

/**
 * Fire when the VPS or AI engine restarts.
 */
export async function scheduleRestartAlert(message: string): Promise<string | null> {
  return scheduleNow(
    '🔁 Engine Restarted',
    message,
    { type: 'restart' },
    'engine-restart-alert',
    'system-events',
  );
}

// ── Approval events ───────────────────────────────────────────────────────────

/** Fire when operator approves a live trade and it's forwarded to VPS */
export async function scheduleApprovalGrantedAlert(
  symbol: string,
  direction: string,
  vpsForwarded: boolean,
): Promise<string | null> {
  const title = vpsForwarded
    ? `✅ Trade Executed — ${symbol}/USD`
    : `✅ Approved — ${symbol}/USD (VPS unreachable)`;
  const body = vpsForwarded
    ? `${direction} order forwarded to VPS for GMX execution.`
    : `Order approved but VPS did not confirm. Check VPS connection.`;
  return scheduleNow(title, body, { type: 'approval_granted', symbol, direction }, `approval-granted-${symbol}-${Date.now()}`, 'live-approvals');
}

/** Fire when operator rejects a live trade proposal */
export async function scheduleApprovalRejectedAlert(
  symbol: string,
  direction: string,
): Promise<string | null> {
  return scheduleNow(
    `❌ Proposal Rejected — ${symbol}/USD`,
    `${direction} proposal was rejected by operator.`,
    { type: 'approval_rejected', symbol, direction },
    `approval-rejected-${symbol}-${Date.now()}`,
    'live-approvals',
  );
}

/** Fire when a live proposal auto-expires */
export async function scheduleApprovalExpiredAlert(
  symbol: string,
  direction: string,
): Promise<string | null> {
  return scheduleNow(
    `⏰ Proposal Expired — ${symbol}/USD`,
    `${direction} proposal expired without operator action.`,
    { type: 'approval_expired', symbol, direction },
    `approval-expired-${symbol}-${Date.now()}`,
    'live-approvals',
  );
}

/** Fire when engine transitions to EMERGENCY_STOP */
export async function scheduleEmergencyStopAlert(reason?: string): Promise<string | null> {
  return scheduleNow(
    '🚨 EMERGENCY STOP ACTIVATED',
    reason ?? 'All trading halted. Manual review required.',
    { type: 'emergency_stop', reason },
    'emergency-stop-alert',
    'risk-alerts',
  );
}

// ── Cancel ────────────────────────────────────────────────────────────────────

export async function cancelAlert(identifier: string) {
  if (Platform.OS === 'web') return;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
}

// ── Android channel setup (call once on app start) ────────────────────────────

export async function setupAndroidChannel() {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('risk-alerts', {
    name:             'Risk Alerts',
    importance:       Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor:       '#ef4444',
    sound:            'default',
  });

  await Notifications.setNotificationChannelAsync('live-approvals', {
    name:             'Live Trade Approvals',
    importance:       Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 100, 100, 100, 100, 100],
    lightColor:       '#f59e0b',
    sound:            'default',
    bypassDnd:        true,
  });

  await Notifications.setNotificationChannelAsync('system-events', {
    name:             'System Events',
    importance:       Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 150],
    lightColor:       '#60a5fa',
    sound:            'default',
  });
}
