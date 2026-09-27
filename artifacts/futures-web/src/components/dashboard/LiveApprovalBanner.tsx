/**
 * LiveApprovalBanner — fallback in-page alert for LIVE approval requests.
 *
 * Shown when:
 *   - There is at least one PENDING live approval, AND
 *   - Browser Notification API is unavailable OR permission is not 'granted'
 *
 * When notifications work (permission === 'granted'), the OS-level desktop
 * notification is the primary alert path and this banner stays hidden to
 * reduce noise. When they don't, this banner is the operator's only signal.
 *
 * Auto-dismisses as soon as the pending count drops to zero.
 */

import { Zap, Bell, BellOff, X } from 'lucide-react';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

export function LiveApprovalBanner() {
  const { pendingApprovals, notificationPermission, requestNotificationPermission } = useAiEngine();
  const [dismissed, setDismissed] = useState(false);

  const pendingItems = pendingApprovals.filter(a => a.status === 'PENDING');
  const count = pendingItems.length;

  // Notifications fully working → no need for in-page banner
  const notifWorking = notificationPermission === 'granted';

  // Nothing to show: no pending items, OR notifications handle the alert
  if (count === 0 || notifWorking) return null;

  // Re-show on new pending items even if previously dismissed
  // (dismissed state resets when user navigates away, which is fine)
  if (dismissed) return null;

  const isUnsupported = notificationPermission === 'unsupported';
  const isDenied      = notificationPermission === 'denied';
  const isDefault     = notificationPermission === 'default';

  // Oldest pending first for the summary line
  const first = pendingItems[0]!;
  const sym   = first.decision.primarySymbol ?? 'MULTI';
  const state = first.decision.operatingState;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-lg border',
        'bg-[var(--color-short)]/10 border-[var(--color-short)]/40',
        'animate-in slide-in-from-top-2 duration-200',
      )}
    >
      {/* Pulsing icon */}
      <span className="relative shrink-0">
        <Zap className="w-4 h-4 text-[var(--color-short)] animate-pulse" />
      </span>

      {/* Main message */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-[var(--color-short)]">
          ⚡ LIVE 승인 대기 중 — {count}건
        </p>
        <p className="text-xs text-foreground/70 mt-0.5">
          {state} {sym}/USD
          {count > 1 ? ` 외 ${count - 1}건` : ''}
          {' '}· 대시보드에서 즉시 승인하세요
        </p>
      </div>

      {/* Notification status hint + action */}
      <div className="flex items-center gap-2 shrink-0">
        {isUnsupported && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground border border-border rounded px-2 py-1">
            <BellOff className="w-3 h-3" />
            브라우저 알림 미지원
          </span>
        )}
        {isDenied && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-short)]/80 border border-[var(--color-short)]/30 rounded px-2 py-1">
            <BellOff className="w-3 h-3" />
            알림 차단됨
          </span>
        )}
        {isDefault && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5 border-[var(--color-short)]/40 text-[var(--color-short)] hover:bg-[var(--color-short)]/10"
            onClick={requestNotificationPermission}
          >
            <Bell className="w-3 h-3" />
            알림 허용
          </Button>
        )}

        {/* Dismiss — only silences until page refresh; new items resurface */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          aria-label="배너 닫기"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
