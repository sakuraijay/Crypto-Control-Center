/** Server decision history, approval review and notification UI. No browser trading engine. */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode,
} from 'react';
import { useToast } from '@/hooks/use-toast';
import type {
  AiEngineDecision, AiOperatingState,
  PendingLiveApproval, ApprovalStatus,
} from '../ai/types';
import { useTradingContext } from './TradingContext';
import { useStrategyContext } from './StrategyContext';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Prune expired approvals older than this (keep for audit) */
const APPROVAL_HISTORY_KEEP_MS = 24 * 60 * 60 * 1000;

// ── Context type ──────────────────────────────────────────────────────────────

interface AiEngineContextType {
  decisionHistory: AiEngineDecision[];
  clearHistory: () => void;

  // ── Live approval gate ───────────────────────────────────────────────────
  /** All approvals (pending + historical) */
  pendingApprovals: PendingLiveApproval[];
  /** Approve a queued live order (logged; execution via GMX SDK when configured) */
  approveLiveOrder: (id: string) => Promise<void>;
  /** Reject a queued live order → discard */
  rejectLiveOrder: (id: string, reason?: string) => void;
  /**
   * Retry a failed dry-run on an already-APPROVED approval.
   * Calls POST /api/ai/approvals/:id/retry and updates local state.
   */
  retryLiveApproval: (id: string) => Promise<void>;
  /** Count of currently pending (not yet approved/rejected/expired) */
  pendingCount: number;
  /** Load the next page (200 rows) of older decisions from the server. */
  loadMoreHistory: () => Promise<boolean>;

  // ── Browser notification ─────────────────────────────────────────────────
  /**
   * Current browser Notification permission.
   * 'unsupported' is a synthetic value used when the Notification API is absent.
   */
  notificationPermission: NotificationPermission | 'unsupported';
  /**
   * User-driven permission request. Only prompts if current permission is 'default'.
   * Call this from a button click — never automatically.
   */
  requestNotificationPermission: () => Promise<void>;
  /**
   * Fire a test browser notification, requesting permission first if needed.
   * Updates shared `notificationPermission` state so the rest of the UI stays in sync.
   * Returns 'sent' | 'denied' | 'unsupported'.
   */
  sendTestNotification: () => Promise<'sent' | 'denied' | 'unsupported'>;

  weeklyRealizedPnl: number;
  /**
   * True when LIVE TEST MODE is active (from strategy limits).
   * Controls TopBar badge and Dashboard mode indicator.
   */
  liveTestMode: boolean;
}

const AiEngineContext = createContext<AiEngineContextType | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function AiEngineProvider({ children }: { children: ReactNode }) {
  const { closedTrades } = useTradingContext();
  const { limits } = useStrategyContext();
  const { toast } = useToast();

  const [decisionHistory, setDecisionHistory] = useState<AiEngineDecision[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingLiveApproval[]>([]);
  const seenApprovalIds = useRef<Set<string>>(new Set());
  const dbPage = useRef(1); // page 0 loaded on mount
  // ── Seed history from persisted DB records on mount ───────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ai/decisions?limit=200');
        if (!res.ok) return;
        const { decisions } = await res.json() as {
          decisions: Array<{
            id: number; ts: string; symbol: string; direction: string;
            confidence: number; rationale: string; riskResult: string;
            riskNote?: string | null; executionOutcome: string;
            fullJson?: string | null;
          }>;
        };
        if (!decisions?.length) return;
        const opStateMap: Record<string, AiOperatingState> = {
          LONG: 'LONG', SHORT: 'SHORT', NO_TRADE: 'CASH',
        };
        const seeded = decisions.map((row): AiEngineDecision => {
          if (row.fullJson) {
            try {
              const parsed = JSON.parse(row.fullJson) as AiEngineDecision;
              return { ...parsed, id: String(row.id) };
            } catch { /* fall through */ }
          }
          return {
            id: String(row.id), cycleNumber: 0, createdAt: row.ts,
            operatingState: opStateMap[row.direction] ?? 'CASH',
            prevState: 'CASH', stateChanged: false,
            selectedSymbols: row.symbol ? [row.symbol] : [],
            primarySymbol: row.symbol || null,
            confidence: Math.round((row.confidence ?? 0) * 100),
            marketCondition: 'RANGING', riskLevel: 'MEDIUM',
            symbolAnalyses: [], marketRankings: [],
            executionType: 'hold', entryStyle: 'none',
            stateRationale: row.rationale ?? '', reasoning: [],
            riskApproved: row.riskResult === 'APPROVED',
            riskVetoReason: row.riskNote ?? undefined,
            paperExecuted: row.executionOutcome === 'SIMULATED',
          };
        });
        setDecisionHistory(seeded);
      } catch { /* non-fatal */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Seed LIVE approval history from DB on mount ────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ai/approvals?limit=200');
        if (!res.ok) return;
        const { approvals } = await res.json() as {
          approvals: Array<{
            id: string; decisionJson: string; status: string;
            createdAt: string; expiresAt: string;
            approvedAt?: string | null; rejectedAt?: string | null;
            rejectionReason?: string | null;
            executionOutcome?: string | null;
          }>;
        };
        if (!approvals?.length) return;

        const seeded = approvals.map((row): PendingLiveApproval => {
          let decision: AiEngineDecision;
          try {
            decision = JSON.parse(row.decisionJson) as AiEngineDecision;
          } catch {
            // 파싱 실패 시 최소 구조로 복원
            decision = {
              id: row.id, cycleNumber: 0, createdAt: row.createdAt,
              operatingState: 'CASH', prevState: 'CASH', stateChanged: false,
              selectedSymbols: [], primarySymbol: null,
              confidence: 0, marketCondition: 'RANGING', riskLevel: 'MEDIUM',
              symbolAnalyses: [], marketRankings: [],
              executionType: 'hold', entryStyle: 'none',
              stateRationale: '', reasoning: [],
              riskApproved: false, paperExecuted: false,
            };
          }
          // Rehydrate executionOutcome → executionFeedback so feedback survives refresh
          const executionFeedback: PendingLiveApproval['executionFeedback'] =
            row.executionOutcome === 'succeeded' ? 'ok'
            : row.executionOutcome === 'failed'    ? 'failed'
            : undefined;
          return {
            id:              row.id,
            decision,
            createdAt:       row.createdAt,
            expiresAt:       row.expiresAt,
            status:          row.status as ApprovalStatus,
            approvedAt:      row.approvedAt ?? undefined,
            rejectedAt:      row.rejectedAt ?? undefined,
            rejectionReason: row.rejectionReason ?? undefined,
            executionFeedback,
            retryCount:      (row as { retryCount?: number }).retryCount ?? 0,
          };
        });

        // 현재 세션 메모리에 없는 항목만 추가 (중복 방지)
        setPendingApprovals(prev => {
          const existingIds = new Set(prev.map(a => a.id));
          const newItems = seeded.filter(a => !existingIds.has(a.id));
          return newItems.length > 0 ? [...newItems, ...prev] : prev;
        });
        // 로드된 항목을 seenApprovalIds에 추가 (중복 토스트 방지)
        for (const a of seeded) seenApprovalIds.current.add(a.id);
      } catch { /* non-fatal */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Browser Notification permission state ────────────────────────────────
  // Reactive state (not just a ref) so consumers can show fallback UI.
  // 'unsupported' is a synthetic value for environments without the Notification API.
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'));

  // ── Web Push / Service Worker registration helper ─────────────────────────
  // Registers sw.js, subscribes to push, and POSTs subscription to the server.
  // Fail-closed: any missing piece (no VAPID key, no SW support) → silent return.
  // Never throws. Call after permission is granted.
  // MUST be declared before requestNotificationPermission to avoid TDZ error.
  const tryRegisterPush = useCallback(async (): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      // Get VAPID public key — 503 means not configured, skip silently
      const keyResp = await fetch('/api/notifications/vapid-key');
      if (!keyResp.ok) return;
      const { publicKey } = await keyResp.json() as { publicKey: string };
      if (!publicKey) return;

      // Register (or reuse) the service worker
      const reg = await navigator.serviceWorker.register('/futures-web/sw.js', {
        scope: '/futures-web/',
      });
      await navigator.serviceWorker.ready;

      // Check for existing subscription first
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Re-POST to ensure server has it (idempotent)
        await fetch('/api/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing.toJSON()),
        }).catch(() => {});
        return;
      }

      // Convert VAPID public key (URL-safe base64) → Uint8Array
      const padding = '='.repeat((4 - publicKey.length % 4) % 4);
      const b64     = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw     = window.atob(b64);
      const appKey  = Uint8Array.from([...raw].map(c => c.charCodeAt(0)));

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: appKey,
      });
      await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      }).catch(() => {});
    } catch (err) {
      // SW registration can fail in iframe/insecure contexts — log but never crash
      console.warn('[Push] SW registration failed:', (err as Error).message);
    }
  }, []);

  // User-driven permission request — must never be called automatically.
  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    const perm = await Notification.requestPermission();
    setNotificationPermission(perm);
    // Register push subscription when permission is granted
    if (perm === 'granted') void tryRegisterPush();
  }, [tryRegisterPush]);

  // Test notification — requests permission if needed, then fires a desktop alert.
  // Always syncs notificationPermission so badges/buttons update immediately.
  const sendTestNotification = useCallback(async (): Promise<'sent' | 'denied' | 'unsupported'> => {
    if (typeof Notification === 'undefined') return 'unsupported';
    let perm = Notification.permission;
    if (perm === 'default') {
      perm = await Notification.requestPermission();
      setNotificationPermission(perm);  // sync shared state regardless of outcome
    }
    if (perm !== 'granted') {
      setNotificationPermission(perm);  // ensure denied state is reflected
      fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'browser', status: 'denied', msg: '알림 권한 없음 (사용자 차단)' }),
      }).catch(() => {});
      return 'denied';
    }
    new Notification('Crypto Control Center', {
      body: '알림이 정상 동작합니다. ✅',
      icon: '/favicon.ico',
    });
    // 서버에 결과 기록 + Web Push 구독 등록 시도 (비동기, non-blocking)
    fetch('/api/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'browser', status: 'sent', msg: '테스트 알림 전송됨 ✅' }),
    }).catch(() => {});
    void tryRegisterPush();
    return 'sent';
  }, [tryRegisterPush]);

  // ── Toast + browser notification when a new LIVE approval enters the queue ──
  useEffect(() => {
    const newPending = pendingApprovals.filter(
      a => a.status === 'PENDING' && !seenApprovalIds.current.has(a.id)
    );
    for (const approval of newPending) {
      seenApprovalIds.current.add(approval.id);
      const d = approval.decision;
      const sym   = d.primarySymbol ?? 'MULTI';
      const state = d.operatingState;
      const size  = d.sizeUsd ? ` · $${d.sizeUsd.toLocaleString()}` : '';
      const expiresMs  = new Date(approval.expiresAt).getTime() - Date.now();
      const expiresMins = Math.max(1, Math.round(expiresMs / 60_000));

      // In-app toast (always shown — covers background-tab and no-permission cases)
      toast({
        title:       '⚡ LIVE Trade Approval Required',
        description: `${state} ${sym}/USD${size} — expires in ${expiresMins}m · Approve on Dashboard`,
        variant:     'destructive',
        duration:    15_000,
      });

      // Browser desktop notification — fires when permission is granted.
      // The Notification API works regardless of document.visibilityState:
      // a notification created in a hidden tab still appears on the OS desktop.
      // We do NOT auto-request permission here; requestNotificationPermission()
      // must be called explicitly by the user via the Settings page button.
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('⚡ LIVE 승인 필요 — Crypto Control Center', {
            body:              `${state} ${sym}/USD${size} — ${expiresMins}분 내 승인`,
            tag:               `live-approval-${approval.id}`,
            icon:              '/futures-web/favicon.ico',
            requireInteraction: true,
          });
        } catch { /* non-fatal — some browsers restrict in iframes */ }
      }
    }
  }, [pendingApprovals, toast]);

  // ── Auto-expire pending approvals ─────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const newlyExpiredIds: string[] = [];

      setPendingApprovals(prev => prev.map(a => {
        if (a.status === 'PENDING' && new Date(a.expiresAt).getTime() <= now) {
          newlyExpiredIds.push(a.id);
          return { ...a, status: 'EXPIRED' as ApprovalStatus };
        }
        return a;
      }).filter(a =>
        a.status === 'PENDING' ||
        new Date(a.createdAt).getTime() > now - APPROVAL_HISTORY_KEEP_MS
      ));

      // DB에도 EXPIRED 상태 동기화 (non-fatal)
      for (const id of newlyExpiredIds) {
        fetch(`/api/ai/approvals/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'EXPIRED' }),
        }).catch(() => { /* non-fatal */ });
      }
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  // ── Approve a live order (paper dry-run validation) ─────────────────────────
  // 1. Optimistically mark APPROVED + executionFeedback: 'pending'
  // 2. Persist APPROVED status to DB
  // 3. POST to /executor/execute with dryRun:true — paper simulation only, no real order
  // 4. Update executionFeedback to 'ok' or 'failed' based on paper-sim result
  // 5. Persist dry-run outcome to DB
  const approveLiveOrder = useCallback(async (id: string) => {
    const approval = pendingApprovals.find(a => a.id === id);
    if (!approval || approval.status !== 'PENDING') return;

    const approvedAt = new Date().toISOString();

    // Step 1 — optimistic update with feedback 'pending'
    setPendingApprovals(prev => prev.map(a =>
      a.id === id
        ? { ...a, status: 'APPROVED' as ApprovalStatus, approvedAt, executionFeedback: 'pending' as const }
        : a
    ));

    // Step 2 — DB APPROVED (non-fatal)
    fetch(`/api/ai/approvals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED' }),
    }).catch(() => { /* non-fatal */ });

    // Audit trail — AI decisions log에도 기록
    fetch('/api/ai/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ts: approvedAt,
        symbol: approval.decision.primarySymbol ?? 'MULTI',
        direction: approval.decision.operatingState,
        confidence: approval.decision.confidence / 100,
        rationale: `[LIVE APPROVED — PAPER DRY-RUN] ${approval.decision.stateRationale}`,
        strategy: `AI_5STATE_LIVE_${approval.decision.operatingState}`,
        riskResult: 'APPROVED',
        executionOutcome: 'PENDING',
        fullJson: JSON.stringify({ ...approval.decision, operatorApproved: true, dryRun: true }),
      }),
    }).catch(() => { /* non-fatal */ });

    // Step 3 — paper dry-run: validate params via executor (NO real order placed)
    try {
      const d = approval.decision;
      const dryRunRes = await fetch('/api/executor/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId:    d.id,
          operatingState: d.operatingState,
          symbol:        d.primarySymbol ?? d.selectedSymbols[0] ?? null,
          executionType: d.executionType,
          sizeUsd:       d.sizeUsd ?? null,
          leverage:      d.leverage ?? null,
          tpPrice:       d.tpPrice ?? null,
          slPrice:       d.slPrice ?? null,
          trailingStopPct: d.trailingStopPct ?? null,
          cycleNumber:   d.cycleNumber,
          dryRun:        true,  // paper simulation — no real order
        }),
      });

      const result = await dryRunRes.json() as { ok: boolean; error?: string };
      const feedback: 'ok' | 'failed' = result.ok ? 'ok' : 'failed';
      const errMsg = result.ok ? undefined : (result.error ?? '드라이런 시뮬레이션 실패');

      // Step 4 — update feedback state
      setPendingApprovals(prev => prev.map(a =>
        a.id === id
          ? { ...a, executionFeedback: feedback, executionError: errMsg }
          : a
      ));

      // Step 5 — persist outcome + lastError to DB (non-fatal)
      fetch(`/api/ai/approvals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'APPROVED',
          executionOutcome: result.ok ? 'succeeded' : 'failed',
          lastError: result.ok ? null : (result.error ?? '드라이런 시뮬레이션 실패'),
        }),
      }).catch(() => { /* non-fatal */ });

    } catch (e) {
      const msg = (e as Error).message ?? '드라이런 요청 실패';
      setPendingApprovals(prev => prev.map(a =>
        a.id === id
          ? { ...a, executionFeedback: 'failed' as const, executionError: msg }
          : a
      ));
      // Persist failure outcome + lastError to DB (non-fatal) — catch path must also sync
      fetch(`/api/ai/approvals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED', executionOutcome: 'failed', lastError: msg }),
      }).catch(() => { /* non-fatal */ });
    }
  }, [pendingApprovals]);

  // ── Retry a failed dry-run ──────────────────────────────────────────────────
  // The operator calls this after a dry-run failure to re-validate the order.
  // Hits POST /api/ai/approvals/:id/retry on the server which re-runs executeOrder
  // and increments retryCount + stores the error if it fails again.
  const retryLiveApproval = useCallback(async (id: string) => {
    const approval = pendingApprovals.find(a => a.id === id);
    if (!approval || approval.status !== 'APPROVED') return;

    // Optimistic: mark as retrying + feedback 'pending'
    setPendingApprovals(prev => prev.map(a =>
      a.id === id
        ? { ...a, executionFeedback: 'pending' as const, retrying: true }
        : a
    ));

    try {
      const res = await fetch(`/api/ai/approvals/${id}/retry`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; lastError?: string | null };
      const feedback: 'ok' | 'failed' = data.ok ? 'ok' : 'failed';
      const errMsg = data.ok ? undefined : (data.lastError ?? '재시도 실패');

      setPendingApprovals(prev => prev.map(a =>
        a.id === id
          ? {
              ...a,
              executionFeedback: feedback,
              executionError: errMsg,
              retryCount: (a.retryCount ?? 0) + 1,
              retrying: false,
            }
          : a
      ));
    } catch (e) {
      const msg = (e as Error).message ?? '재시도 요청 실패';
      setPendingApprovals(prev => prev.map(a =>
        a.id === id
          ? { ...a, executionFeedback: 'failed' as const, executionError: msg, retrying: false }
          : a
      ));
    }
  }, [pendingApprovals]);

  // ── Reject a live order ─────────────────────────────────────────────────────
  // Handles both PENDING (normal reject) and APPROVED with failed dry-run (operator discards after failure).
  const rejectLiveOrder = useCallback((id: string, reason?: string) => {
    setPendingApprovals(prev => prev.map(a =>
      a.id === id && (a.status === 'PENDING' || a.status === 'APPROVED')
        ? { ...a, status: 'REJECTED' as ApprovalStatus, rejectedAt: new Date().toISOString(), rejectionReason: reason }
        : a
    ));
    // DB에 REJECTED 상태 업데이트 (non-fatal)
    fetch(`/api/ai/approvals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED', rejectionReason: reason ?? null }),
    }).catch(() => { /* non-fatal */ });
  }, []);

  // ── Load older decisions from server (paginated) ──────────────────────────
  const loadMoreHistory = useCallback(async (): Promise<boolean> => {
    try {
      const offset = dbPage.current * 200;
      const res = await fetch(`/api/ai/decisions?limit=200&offset=${offset}`);
      if (!res.ok) return false;
      const { decisions } = await res.json() as {
        decisions: Array<{
          id: number; ts: string; symbol: string; direction: string;
          confidence: number; rationale: string; riskResult: string;
          riskNote?: string | null; executionOutcome: string;
        }>;
      };
      if (!decisions?.length) return false;
      const opStateMap: Record<string, AiOperatingState> = {
        LONG: 'LONG', SHORT: 'SHORT', NO_TRADE: 'CASH',
      };
      const converted = decisions.map((row): AiEngineDecision => ({
        id: String(row.id), cycleNumber: 0, createdAt: row.ts,
        operatingState: opStateMap[row.direction] ?? 'CASH',
        prevState: 'CASH', stateChanged: false,
        selectedSymbols: row.symbol ? [row.symbol] : [],
        primarySymbol: row.symbol || null,
        confidence: Math.round((row.confidence ?? 0) * 100),
        marketCondition: 'RANGING', riskLevel: 'MEDIUM',
        symbolAnalyses: [], marketRankings: [],
        executionType: 'hold', entryStyle: 'none',
        stateRationale: row.rationale ?? '', reasoning: [],
        riskApproved: row.riskResult === 'APPROVED',
        riskVetoReason: row.riskNote ?? undefined,
        paperExecuted: row.executionOutcome === 'SIMULATED',
      }));
      setDecisionHistory(prev => [...prev, ...converted]);
      dbPage.current += 1;
      return true;
    } catch { return false; }
  }, []);

  const clearHistory = useCallback(() => {
    setDecisionHistory([]);
  }, []);

  const pendingCount = pendingApprovals.filter(a => a.status === 'PENDING').length;

  // ── Weekly realized PnL (since Monday 00:00 local) — derived from closedTrades ──
  const weeklyRealizedPnl = (() => {
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return closedTrades
      .filter(t => new Date(t.timestamp) >= monday)
      .reduce((s, t) => s + (t.pnl ?? 0), 0);
  })();

  return (
    <AiEngineContext.Provider value={{
      decisionHistory, clearHistory,
      pendingApprovals, approveLiveOrder, rejectLiveOrder, retryLiveApproval, pendingCount, loadMoreHistory,
      notificationPermission, requestNotificationPermission, sendTestNotification,
      weeklyRealizedPnl,
      liveTestMode: limits.liveTestMode ?? false,
    }}>
      {children}
    </AiEngineContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAiEngine(): AiEngineContextType {
  const ctx = useContext(AiEngineContext);
  if (!ctx) throw new Error('useAiEngine must be used inside AiEngineProvider');
  return ctx;
}
