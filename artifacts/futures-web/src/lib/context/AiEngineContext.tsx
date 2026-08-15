/**
 * AiEngineContext — 5-State AI Trading Engine
 *
 * Runs a decision cycle every CYCLE_MS milliseconds:
 *   1. Build SymbolAnalysis from live price buffer + 24h change data
 *   2. Call runAiEngine() — pure state-selection logic
 *   3. Risk gate check
 *   4. Paper mode + autoExecute → placeOrder() locally (simulated)
 *   5. LIVE_TRADING mode → queue as PendingLiveApproval (operator must APPROVE)
 *   6. Persist decision to API server
 *
 * Operator role:
 *   • Paper mode: monitoring + optional auto-execute toggle
 *   • Live mode:  APPROVE / REJECT each proposed order before real money moves
 *   • Always:     Emergency Stop, pause/resume
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode,
} from 'react';
import { v4 as uuid } from 'uuid';
import { useToast } from '@/hooks/use-toast';
import type {
  AiEngineDecision, AiEngineStats, AiOperatingState, MarketRanking,
  PriceBuffer, SymbolAnalysis, PendingLiveApproval, ApprovalStatus,
} from '../ai/types';
import { APPROVAL_TIMEOUT_MS } from '../ai/types';
import { computeIndicators, computeScores } from '../ai/indicators';
import { runAiEngine } from '../ai/stateEngine';
import { displaySymbol as gmxDisplaySymbol } from '../gmx/markets';
import { useTradingContext } from './TradingContext';
import { useAppContext } from './AppContext';
import { useStrategyContext } from './StrategyContext';
import { useWatchlistContext } from './WatchlistContext';

// ── Constants ─────────────────────────────────────────────────────────────────

const CYCLE_MS = 60_000;
const MAX_BUFFER = 200;
const CORE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'ARB', 'LINK'];
/** Prune expired approvals older than this (keep for audit) */
const APPROVAL_HISTORY_KEEP_MS = 24 * 60 * 60 * 1000;

// ── Operating mode ────────────────────────────────────────────────────────────

export type OperatingMode = 'AUTONOMOUS_AI' | 'MANUAL_OVERRIDE' | 'RISK_LOCKED';

function deriveOperatingMode(engineState: string, autoExecute: boolean): OperatingMode {
  if (engineState === 'RISK_LOCKED' || engineState === 'EMERGENCY_STOP') return 'RISK_LOCKED';
  if (engineState === 'LIVE_TRADING') return 'AUTONOMOUS_AI';
  if (engineState === 'PAPER_TRADING' && autoExecute) return 'AUTONOMOUS_AI';
  return 'MANUAL_OVERRIDE';
}

// ── Context type ──────────────────────────────────────────────────────────────

interface AiEngineContextType {
  currentDecision: AiEngineDecision | null;
  decisionHistory: AiEngineDecision[];
  stats: AiEngineStats;
  running: boolean;
  autoExecute: boolean;
  setAutoExecute: (v: boolean) => void;
  triggerCycle: () => void;
  clearHistory: () => void;
  nextCycleMs: number;

  /** Derived operating mode for sidebar / status displays */
  operatingMode: OperatingMode;

  // ── Market rankings ──────────────────────────────────────────────────────
  /** Ranked list of all analysed GMX markets from the latest cycle */
  marketRankings: MarketRanking[];

  // ── System health / pause ────────────────────────────────────────────────
  /** True when the engine is paused */
  systemPaused: boolean;
  pauseReason: string | null;

  // ── Daily benchmark ──────────────────────────────────────────────────────
  benchmarkAccountSize: number;
  benchmarkDailyMin: number;
  benchmarkDailyMax: number;

  // ── Live approval gate ───────────────────────────────────────────────────
  /** All approvals (pending + historical) */
  pendingApprovals: PendingLiveApproval[];
  /** Approve a queued live order (logged; execution via GMX SDK when configured) */
  approveLiveOrder: (id: string) => Promise<void>;
  /** Reject a queued live order → discard */
  rejectLiveOrder: (id: string, reason?: string) => void;
  /** Count of currently pending (not yet approved/rejected/expired) */
  pendingCount: number;
  /** Load the next page (200 rows) of older decisions from the server. */
  loadMoreHistory: () => Promise<boolean>;
}

const AiEngineContext = createContext<AiEngineContextType | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function AiEngineProvider({ children }: { children: ReactNode }) {
  const { account, positions, placeOrder, clearAllPositions, consecutiveLosses } = useTradingContext();
  const { engineState, setEngineState } = useAppContext();
  const { limits } = useStrategyContext();
  const { watchlist } = useWatchlistContext();
  const { toast } = useToast();

  const [currentDecision, setCurrentDecision] = useState<AiEngineDecision | null>(null);
  const [decisionHistory, setDecisionHistory] = useState<AiEngineDecision[]>([]);
  const [stats, setStats] = useState<AiEngineStats>({
    totalCycles: 0,
    stateDistribution: { SPOT: 0, LONG: 0, SHORT: 0, HEDGE: 0, CASH: 0 },
    currentStreak: { state: 'CASH', cycles: 0 },
    avgConfidence: 0,
    lastCycleAt: null,
  });
  const [autoExecute, setAutoExecute] = useState(false);
  const [running, setRunning] = useState(false);
  const [nextCycleMs, setNextCycleMs] = useState(CYCLE_MS);
  const [pendingApprovals, setPendingApprovals] = useState<PendingLiveApproval[]>([]);
  const [marketRankings, setMarketRankings] = useState<MarketRanking[]>([]);
  const [systemPaused] = useState(false);
  const [pauseReason] = useState<string | null>(null);

  // ── Benchmark constants (display-only, not enforced by engine) ─────────────
  const BENCHMARK_ACCOUNT = 10_000;
  const BENCHMARK_DAILY_MIN = 500;
  const BENCHMARK_DAILY_MAX = 1_000;

  const priceBuffer = useRef<PriceBuffer>(new Map());
  const lastPriceUpdate = useRef<number>(Date.now());
  const cycleNumber = useRef(0);
  const prevState = useRef<AiOperatingState>('CASH');
  const cycleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextCycleAt = useRef<number>(Date.now() + CYCLE_MS);
  const seenApprovalIds = useRef<Set<string>>(new Set());
  const dbPage = useRef(1); // page 0 loaded on mount

  // ── Feed price buffer from watchlist ───────────────────────────────────────
  useEffect(() => {
    const symbols = [...CORE_SYMBOLS, ...watchlist.map(w => w.symbol)];
    for (const sym of symbols) {
      const entry = watchlist.find(w => w.symbol === sym);
      if (!entry?.price || entry.price <= 0) continue;
      if (!priceBuffer.current.has(sym)) priceBuffer.current.set(sym, []);
      const buf = priceBuffer.current.get(sym)!;
      const last = buf[buf.length - 1];
      if (last !== entry.price) {
        buf.push(entry.price);
        if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
        lastPriceUpdate.current = Date.now();
      }
    }
  }, [watchlist]);

  // ── Seed history from persisted DB records on mount ───────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api-server/api/ai/decisions?limit=200');
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
        const res = await fetch('/api-server/api/ai/approvals?limit=200');
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

  // ── Browser Notification permission request (on first LIVE approval queue) ──
  const notifPermissionRef = useRef<NotificationPermission>('default');
  useEffect(() => {
    if (typeof Notification !== 'undefined') {
      notifPermissionRef.current = Notification.permission;
    }
  }, []);

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

      // In-app toast
      toast({
        title:       '⚡ LIVE Trade Approval Required',
        description: `${state} ${sym}/USD${size} — expires in ${expiresMins}m · Approve on Dashboard`,
        variant:     'destructive',
        duration:    15_000,
      });

      // Browser push notification (request permission lazily on first event)
      if (typeof Notification !== 'undefined') {
        const fireNotif = () => {
          try {
            new Notification('⚡ LIVE 승인 필요 — Crypto Control Center', {
              body: `${state} ${sym}/USD${size} — ${expiresMins}분 내 승인`,
              tag:  `live-approval-${approval.id}`,
              icon: '/favicon.ico',
            });
          } catch { /* non-fatal */ }
        };
        if (Notification.permission === 'granted') {
          fireNotif();
        } else if (Notification.permission === 'default') {
          Notification.requestPermission().then(perm => {
            notifPermissionRef.current = perm;
            if (perm === 'granted') fireNotif();
          });
        }
      }
    }
  }, [pendingApprovals, toast]);

  // ── Daily / weekly loss limit → RISK_LOCKED ───────────────────────────────
  useEffect(() => {
    if (engineState === 'EMERGENCY_STOP' || engineState === 'RISK_LOCKED') return;

    const dailyLoss = account.realizedPnlToday;
    const dailyLimit = limits.dailyLossLimitUSDT;
    const weeklyLimit = limits.weeklyLossLimitUSDT ?? 0;
    const consecLimit = limits.consecutiveLossLimit ?? 3;

    const hitDaily  = dailyLimit  > 0 && dailyLoss < 0 && Math.abs(dailyLoss) >= dailyLimit;
    const hitWeekly = weeklyLimit > 0 && dailyLoss < 0 && Math.abs(dailyLoss) >= weeklyLimit;
    const hitConsec = consecLimit > 0 && consecutiveLosses >= consecLimit;

    if (hitDaily || hitWeekly || hitConsec) {
      const reason = hitDaily
        ? `Daily loss limit hit ($${Math.abs(dailyLoss).toFixed(0)} / $${dailyLimit})`
        : hitWeekly
          ? `Weekly loss limit hit ($${Math.abs(dailyLoss).toFixed(0)} / $${weeklyLimit})`
          : `${consecutiveLosses} consecutive losses (limit ${consecLimit})`;
      console.warn(`[AiEngine] RISK_LOCKED — ${reason}`);
      setEngineState('RISK_LOCKED');
    }
  }, [account.realizedPnlToday, consecutiveLosses, limits, engineState, setEngineState]);

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
        fetch(`/api-server/api/ai/approvals/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'EXPIRED' }),
        }).catch(() => { /* non-fatal */ });
      }
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  // ── Build SymbolAnalysis ───────────────────────────────────────────────────
  const buildAnalyses = useCallback((): SymbolAnalysis[] => {
    const analyses: SymbolAnalysis[] = [];
    const allSymbols = [...new Set([...CORE_SYMBOLS, ...watchlist.map(w => w.symbol)])];

    for (const sym of allSymbols) {
      const wlEntry = watchlist.find(w => w.symbol === sym);
      const buf = priceBuffer.current.get(sym);
      const price = wlEntry?.price ?? buf?.[buf.length - 1] ?? 0;
      if (price <= 0 || !buf || buf.length < 5) continue;

      const displaySym = gmxDisplaySymbol(sym);
      const priceChange24h = wlEntry?.change24h ?? 0;
      const indicators = computeIndicators(buf, priceChange24h);
      const { bullishScore, bearishScore, directionalBias, opportunityScore } = computeScores(indicators);

      analyses.push({
        symbol: sym, displaySymbol: displaySym, price, indicators,
        bullishScore, bearishScore, directionalBias, opportunityScore,
      });
    }
    return analyses.sort((a, b) => b.opportunityScore - a.opportunityScore);
  }, [watchlist]);

  // ── Persist decision to API ─────────────────────────────────────────────────
  const persistDecision = useCallback(async (decision: AiEngineDecision) => {
    try {
      await fetch('/api-server/api/ai/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ts: decision.createdAt,
          symbol: decision.primarySymbol ?? 'MULTI',
          direction: decision.operatingState === 'LONG' ? 'LONG'
            : decision.operatingState === 'SHORT' ? 'SHORT'
            : 'NO_TRADE',
          confidence: decision.confidence / 100,
          rationale: decision.stateRationale,
          strategy: `AI_5STATE_${decision.operatingState}`,
          riskResult: decision.riskApproved ? 'APPROVED' : 'VETOED',
          riskNote: decision.riskVetoReason ?? null,
          executionOutcome: decision.paperExecuted ? 'SIMULATED' : 'PENDING',
          operatingState: decision.operatingState,
          cycleNumber: decision.cycleNumber,
          fullJson: JSON.stringify(decision),
        }),
      });
    } catch { /* non-fatal */ }
  }, []);

  // ── Update stats ────────────────────────────────────────────────────────────
  const updateStats = useCallback((decision: AiEngineDecision) => {
    setStats(prev => {
      const dist = { ...prev.stateDistribution };
      dist[decision.operatingState] = (dist[decision.operatingState] ?? 0) + 1;
      const streak = prev.currentStreak.state === decision.operatingState
        ? { state: decision.operatingState, cycles: prev.currentStreak.cycles + 1 }
        : { state: decision.operatingState, cycles: 1 };
      const total = prev.totalCycles + 1;
      return {
        totalCycles: total,
        stateDistribution: dist,
        currentStreak: streak,
        avgConfidence: (prev.avgConfidence * prev.totalCycles + decision.confidence) / total,
        lastCycleAt: decision.createdAt,
      };
    });
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
    fetch(`/api-server/api/ai/approvals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED' }),
    }).catch(() => { /* non-fatal */ });

    // Audit trail — AI decisions log에도 기록
    fetch('/api-server/api/ai/decisions', {
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
      const dryRunRes = await fetch('/api-server/api/executor/execute', {
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

      // Step 5 — persist outcome to DB (non-fatal)
      fetch(`/api-server/api/ai/approvals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'APPROVED',
          executionOutcome: result.ok ? 'succeeded' : 'failed',
        }),
      }).catch(() => { /* non-fatal */ });

    } catch (e) {
      const msg = (e as Error).message ?? '드라이런 요청 실패';
      setPendingApprovals(prev => prev.map(a =>
        a.id === id
          ? { ...a, executionFeedback: 'failed' as const, executionError: msg }
          : a
      ));
      // Persist failure outcome to DB (non-fatal) — catch path must also sync
      fetch(`/api-server/api/ai/approvals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED', executionOutcome: 'failed' }),
      }).catch(() => { /* non-fatal */ });
    }
  }, [pendingApprovals]);

  // ── Reject a live order ─────────────────────────────────────────────────────
  const rejectLiveOrder = useCallback((id: string, reason?: string) => {
    setPendingApprovals(prev => prev.map(a =>
      a.id === id && a.status === 'PENDING'
        ? { ...a, status: 'REJECTED' as ApprovalStatus, rejectedAt: new Date().toISOString(), rejectionReason: reason }
        : a
    ));
    // DB에 REJECTED 상태 업데이트 (non-fatal)
    fetch(`/api-server/api/ai/approvals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED', rejectionReason: reason ?? null }),
    }).catch(() => { /* non-fatal */ });
  }, []);

  // ── Run one engine cycle ────────────────────────────────────────────────────
  const runCycle = useCallback(async () => {
    if (running) return;
    setRunning(true);

    try {
      const analyses = buildAnalyses();
      const dataFreshMs = Date.now() - lastPriceUpdate.current;
      cycleNumber.current += 1;

      const rawDecision = runAiEngine({
        cycleNumber: cycleNumber.current,
        prevState: prevState.current,
        analyses,
        positions,
        account: {
          balance: account.balance,
          availableBalance: account.availableBalance,
          unrealizedPnl: account.unrealizedPnl,
          realizedPnlToday: account.realizedPnlToday,
        },
        limits,
        engineState: String(engineState),
        consecutiveLosses: consecutiveLosses,
        dataFreshMs,
      });

      const isLiveTrade  = engineState === 'LIVE_TRADING';
      const isPaperTrade = !isLiveTrade && engineState !== 'EMERGENCY_STOP' && engineState !== 'RISK_LOCKED';
      const isActionable =
        rawDecision.riskApproved &&
        rawDecision.operatingState !== 'CASH' &&
        rawDecision.executionType !== 'hold' &&
        !!rawDecision.sizeUsd && rawDecision.sizeUsd > 0 &&
        !!rawDecision.primarySymbol;

      setMarketRankings(rawDecision.marketRankings ?? []);

      let paperExecuted = false;
      let paperOrderId: string | undefined;

      if (isActionable) {
        if (isLiveTrade) {
          // ── LIVE: queue for operator approval ──────────────────────────────
          const now = new Date().toISOString();
          const approval: PendingLiveApproval = {
            id: uuid(),
            decision: { ...rawDecision, id: uuid(), createdAt: now, paperExecuted: false } as AiEngineDecision,
            createdAt: now,
            expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
            status: 'PENDING',
          };
          setPendingApprovals(prev => [...prev, approval]);

          // DB에 영속 저장 (non-fatal)
          fetch('/api-server/api/ai/approvals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id:           approval.id,
              decisionJson: JSON.stringify(approval.decision),
              expiresAt:    approval.expiresAt,
            }),
          }).catch(() => { /* non-fatal */ });

        } else if (isPaperTrade && autoExecute) {
          // ── PAPER: auto-execute locally ────────────────────────────────────
          const sym = rawDecision.primarySymbol!;
          const side = rawDecision.operatingState === 'SHORT' ? 'SHORT' : 'LONG';
          const baseOrder = {
            symbol: sym,
            side: side as 'LONG' | 'SHORT',
            orderType: 'MarketIncrease' as const,
            sizeInUsd: rawDecision.sizeUsd!,
            leverage: rawDecision.leverage ?? 5,
            tpPrice: rawDecision.tpPrice,
            slPrice: rawDecision.slPrice,
          };

          let result;
          if (['perp_long_open', 'perp_short_open', 'hedge_open', 'scale_in'].includes(rawDecision.executionType)) {
            result = placeOrder(baseOrder);
          } else if (rawDecision.executionType === 'spot_swap') {
            result = placeOrder({ ...baseOrder, leverage: 1 });
          }
          if (result?.success) {
            paperExecuted = true;
            paperOrderId = uuid();
          }
        }
      } else if (
        rawDecision.operatingState === 'CASH' &&
        isPaperTrade && autoExecute &&
        positions.length > 0
      ) {
        console.info('[AiEngine] CASH state with open positions — closing all (paper)');
        clearAllPositions();
      }

      const decision: AiEngineDecision = {
        id: uuid(),
        createdAt: new Date().toISOString(),
        paperExecuted,
        paperOrderId,
        ...rawDecision,
      };

      prevState.current = decision.operatingState;
      setCurrentDecision(decision);
      setDecisionHistory(prev => [decision, ...prev].slice(0, 200));
      updateStats(decision);
      await persistDecision(decision);
    } finally {
      setRunning(false);
    }
  }, [
    running, buildAnalyses, positions, account, limits, engineState,
    autoExecute, placeOrder, clearAllPositions,
    updateStats, persistDecision, consecutiveLosses,
  ]);

  // ── Schedule cycles ─────────────────────────────────────────────────────────
  useEffect(() => {
    const schedule = () => {
      nextCycleAt.current = Date.now() + CYCLE_MS;
      cycleTimer.current = setTimeout(async () => {
        await runCycle();
        schedule();
      }, CYCLE_MS);
    };

    const initTimer = setTimeout(() => {
      runCycle().then(schedule);
    }, 8_000);

    countdownTimer.current = setInterval(() => {
      setNextCycleMs(Math.max(0, nextCycleAt.current - Date.now()));
    }, 1_000);

    return () => {
      clearTimeout(initTimer);
      if (cycleTimer.current) clearTimeout(cycleTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerCycle = useCallback(async () => {
    if (cycleTimer.current) clearTimeout(cycleTimer.current);
    await runCycle();
    nextCycleAt.current = Date.now() + CYCLE_MS;
    cycleTimer.current = setTimeout(triggerCycle, CYCLE_MS);
  }, [runCycle]);

  // ── Load older decisions from server (paginated) ──────────────────────────
  const loadMoreHistory = useCallback(async (): Promise<boolean> => {
    try {
      const offset = dbPage.current * 200;
      const res = await fetch(`/api-server/api/ai/decisions?limit=200&offset=${offset}`);
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
    setCurrentDecision(null);
  }, []);

  const pendingCount = pendingApprovals.filter(a => a.status === 'PENDING').length;
  const operatingMode = deriveOperatingMode(String(engineState), autoExecute);

  return (
    <AiEngineContext.Provider value={{
      currentDecision, decisionHistory, stats,
      running, autoExecute, setAutoExecute,
      triggerCycle, clearHistory, nextCycleMs,
      operatingMode,
      marketRankings,
      systemPaused, pauseReason,
      benchmarkAccountSize: BENCHMARK_ACCOUNT,
      benchmarkDailyMin:    BENCHMARK_DAILY_MIN,
      benchmarkDailyMax:    BENCHMARK_DAILY_MAX,
      pendingApprovals, approveLiveOrder, rejectLiveOrder, pendingCount, loadMoreHistory,
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
