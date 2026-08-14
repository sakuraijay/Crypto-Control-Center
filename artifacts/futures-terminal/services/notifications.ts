/**
 * Notification service for Expo — wraps expo-notifications.
 * Handles permission requests and scheduling local push notifications
 * that fire even when the app is backgrounded or terminated.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configure how notifications are presented while the app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
    shouldShowList:   true,
  }),
});

export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

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

/**
 * Schedule a local push notification to fire immediately.
 * Safe to call when the app is foregrounded — the banner will still appear.
 * Returns the notification identifier for cancellation.
 */
export async function scheduleRiskAlert(
  title: string,
  body: string,
  identifier?: string,
): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    // Cancel any existing notification with the same identifier to avoid duplication
    if (identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
    }

    const id = await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title,
        body,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.HIGH,
        data: { type: 'risk_alert' },
      },
      trigger: null, // fire immediately
    });
    return id;
  } catch {
    return null;
  }
}

/** Cancel a scheduled notification by identifier. */
export async function cancelAlert(identifier: string) {
  if (Platform.OS === 'web') return;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
}

/** Set up the notification channel for Android. Call once on app startup. */
export async function setupAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('risk-alerts', {
    name: 'Risk Alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#ef4444',
    sound: 'default',
  });
}
