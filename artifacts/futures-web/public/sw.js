/**
 * Crypto Control Center — Service Worker (Web Push receiver)
 *
 * Responsibilities:
 *   1. Receive server-sent Web Push notifications (VAPID) and show OS-level alerts.
 *   2. On notification click, focus an existing Crypto CTL tab or open one.
 *
 * Security:
 *   - No fetch interception, no caching of app routes — purely push + click handling.
 *   - Does NOT have access to wallet keys, secrets, or signing capability.
 */

'use strict';

// Install: activate immediately so the push handler is ready without a page reload.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// ── Push event ─────────────────────────────────────────────────────────────────
self.addEventListener('push', (e) => {
  let data = {};
  if (e.data) {
    try { data = e.data.json(); }
    catch { data = { title: 'Crypto CTL', body: e.data.text() }; }
  }

  const title   = data.title   ?? 'Crypto CTL Alert';
  const body    = data.body    ?? '';
  const tag     = data.tag     ?? 'ccc-push';
  const url     = data.url     ?? '/futures-web/';
  const reqInteract = data.requireInteraction ?? false;

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon:               '/futures-web/favicon.svg',
      badge:              '/futures-web/favicon.svg',
      requireInteraction: reqInteract,
      data:               { url },
    })
  );
});

// ── Notification click ─────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = e.notification.data?.url ?? '/futures-web/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      // Focus an existing Crypto CTL window if found
      const found = cs.find((c) => c.url.includes('/futures-web'));
      if (found) { return found.focus(); }
      // Otherwise open a new window
      return self.clients.openWindow(targetUrl);
    })
  );
});
