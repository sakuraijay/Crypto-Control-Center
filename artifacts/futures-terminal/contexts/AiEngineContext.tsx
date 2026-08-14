/**
 * AiEngineContext — 5-State AI Trading Engine (mobile)
 *
 * Mirrors the web dashboard's AiEngineContext.
 * Runs a 60-second decision cycle and:
 *  • Paper mode + autoExecute → placeOrder() locally (simulated)
 *  • LIVE_TRADING mode → queue as PendingLiveApproval (operator must APPROVE)
 *  • Sends push notifications for new live proposals, risk-lock events, connection alerts
 *
 * Operator role:
 *  • Paper: monitoring + optional auto-execute toggle
 *  • Live:  APPROVE / REJECT each proposed order before real money moves
 *  • Always: Emergency Stop, pause/resume
 */

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode, useMemo,
} from 'react';

import type {
  AiEngineDecision, AiEngineStats, AiOperatingState,
  PriceBuffer, SymbolAnalysis, PendingLiveApproval, ApprovalStatus,
} from '@/lib/ai/types';
import { APPROVAL_TIMEOUT_MS } from '@/lib/ai/types';
import { computeIndicators, computeScores } from '@/lib/ai/indicators';
import { runAiEngine } from '@/lib/ai/stateEngine';
import { displaySymbol as gmxDisplaySymbol } from '@/lib/gmx/markets';

import { useEngine, EngineState } from '@/contexts/EngineContext';
import { useTrading } from '@/contexts/TradingContext';
import { useStrategy } from '@/contexts/StrategyContext';
import { useWatchlist } from '@/contexts/WatchlistContext';
import {
  scheduleLiveApprovalAlert,
  scheduleRiskLockAlert,
} from '@/services/notifications';

// ── Constants ─────────────────────────────────────────────────────────────────

const CYCLE_MS  = 60_000;
const MAX_BUFFER = 200;
const CORE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'ARB', 'LINK'];
const APPROVAL_HISTORY_KEEP_MS = 24 * 60 * 60 * 1000;

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

// ── Simple ID generator (no uuid dep required) ─────────────────────────────────

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Consecutive losses from trades ────────────────────────────────────────────

function calcConsecutiveLosses(trades: { pnl: number; action: string }[]): number {
  let streak = 0;
  // Iterate most-recent-first (trades array is already newest-first in TradingContext)
  for (const t of trades) {
    if (t.action !== 'CLOSE') continue;
    if (t.pnl < 0) streak++;
    else break;
  }
  return streak;
}

// ── Context type ──────────────────────────────────────────────────────────────

export interface AiEngineContextType {
  currentDecision: AiEngineDecision | null;
  decisionHistory: AiEngineDecision[];
  stats: AiEngineStats;
  running: boolean;
  autoExecute: boolean;
  setAutoExecute: (v: boolean) => void;
  triggerCycle: () => void;
  clearHistory: () => void;
  nextCycleMs: number;

  pendingApprovals: PendingLiveApproval[];
  approveLiveOrder: (id: string) => Promise<void>;
  rejectLiveOrder: (id: string, reason?: string) => void;
  pendingCount: number;
}

const AiEngineContext = createContext<AiEngineContextType | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function AiEngineProvider({ children }: { children: ReactNode }) {
  const { engineState, setEngineState } = useEngine();
  const { account, positions, trades, placeOrder } = useTrading();
  const { config: strategyConfig }  = useStrategy();
  const { symbols: watchlist }      = useWatchlist();

  const limits        = strategyConfig.riskLimits;
  const consecutiveLosses = useMemo(() => calcConsecutiveLosses(trades), [trades]);

  const [currentDecision, setCurrentDecision] = useState<AiEngineDecision | null>(null);
  const [decisionHistory, setDecisionHistory] = useState<AiEngineDecision[]>([]);
  const [stats, setStats] = useState<AiEngineStats>({
    totalCycles: 0,
    stateDistribution: { SPOT: 0, LONG: 0, SHORT: 0, HEDGE: 0, CASH: 0 },
    currentStreak: { state: 'CASH', cycles: 0 },
    avgConfidence: 0,
    lastCycleAt: null,
  });
  const [autoExecute,     setAutoExecute]     = useState(false);
  const [running,         setRunning]         = useState(false);
  const [nextCycleMs,     setNextCycleMs]     = useState(CYCLE_MS);
  const [pendingApprovals, setPendingApprovals] = useState<PendingLiveApproval[]>([]);

  const priceBuffer      = useRef<PriceBuffer>(new Map());
  const lastPriceUpdate  = useRef<number>(Date.now());
  const cycleNumber      = useRef(0);
  const prevState        = useRef<AiOperatingState>('CASH');
  const cycleTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextCycleAt      = useRef<number>(Date.now() + CYCLE_MS);
  // Track which risk event notifications we've sent to avoid spamming
  const notifiedRiskLock = useRef(false);

  // ── Feed price buffer from watchlist ──────────────────────────────────────
  useEffect(() => {
    const allSymbols = [...new Set([...CORE_SYMBOLS, ...watchlist.map(w => w.symbol)])];
    for (const sym of allSymbols) {
      const entry = watchlist.find(w => w.symbol === sym);
      if (!entry?.price || entry.price <= 0) continue;
      if (!priceBuffer.current.has(sym)) priceBuffer.current.set(sym, []);
      const buf  = priceBuffer.current.get(sym)!;
      const last = buf[buf.length - 1];
      if (last !== entry.price) {
        buf.push(entry.price);
        if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
        lastPriceUpdate.current = Date.now();
      }
    }
  }, [watchlist]);

  // ── Daily / weekly / consecutive loss → RISK_LOCKED ──────────────────────
  useEffect(() => {
    if (engineState === EngineState.EMERGENCY_STOP || engineState === EngineState.RISK_LOCKED) {
      notifiedRiskLock.current = false; // reset so next lock triggers a new notification
      return;
    }
    const dailyLoss   = account.realizedPnlToday;
    const dailyLimit  = limits.dailyLossLimitUSDT;
    const weeklyLimit = limits.weeklyLossLimitUSDT ?? 0;
    const consecLimit = limits.consecutiveLossLimit ?? 3;

    const hitDaily  = dailyLimit  > 0 && dailyLoss < 0 && Math.abs(dailyLoss)  >= dailyLimit;
    const hitWeekly = weeklyLimit > 0 && dailyLoss < 0 && Math.abs(dailyLoss)  >= weeklyLimit;
    const hitConsec = consecLimit > 0 && consecutiveLosses >= consecLimit;

    if (hitDaily || hitWeekly || hitConsec) {
      const reason = hitDaily
        ? `Daily loss limit hit ($${Math.abs(dailyLoss).toFixed(0)} / $${dailyLimit})`
        : hitWeekly
          ? `Weekly loss limit hit ($${Math.abs(dailyLoss).toFixed(0)} / $${weeklyLimit})`
          : `${consecutiveLosses} consecutive losses (limit ${consecLimit})`;

      setEngineState(EngineState.RISK_LOCKED);

      if (!notifiedRiskLock.current) {
        notifiedRiskLock.current = true;
        scheduleRiskLockAlert(reason);
      }
    }
  }, [account.realizedPnlToday, consecutiveLosses, limits, engineState, setEngineState]);

  // ── Auto-expire pending approvals ─────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setPendingApprovals(prev =>
        prev.map(a => {
          if (a.status === 'PENDING' && new Date(a.expiresAt).getTime() <= now) {
            return { ...a, status: 'EXPIRED' as ApprovalStatus };
          }
          return a;
        }).filter(a =>
          a.status === 'PENDING' ||
          new Date(a.createdAt).getTime() > now - APPROVAL_HISTORY_KEEP_MS,
        )
      );
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  // ── Build SymbolAnalysis ──────────────────────────────────────────────────
  const buildAnalyses = useCallback((): SymbolAnalysis[] => {
    const analyses: SymbolAnalysis[] = [];
    const allSymbols = [...new Set([...CORE_SYMBOLS, ...watchlist.map(w => w.symbol)])];

    for (const sym of allSymbols) {
      const wlEntry = watchlist.find(w => w.symbol === sym);
      const buf     = priceBuffer.current.get(sym);
      const price   = wlEntry?.price ?? buf?.[buf.length - 1] ?? 0;
      if (price <= 0 || !buf || buf.length < 5) continue;

      const priceChange24h = wlEntry?.change24h ?? 0;
      const indicators     = computeIndicators(buf, priceChange24h);
      const { bullishScore, bearishScore, directionalBias, opportunityScore } = computeScores(indicators);

      analyses.push({
        symbol: sym, displaySymbol: gmxDisplaySymbol(sym), price, indicators,
        bullishScore, bearishScore, directionalBias, opportunityScore,
      });
    }
    return analyses.sort((a, b) => b.opportunityScore - a.opportunityScore);
  }, [watchlist]);

  // ── Persist decision to API ───────────────────────────────────────────────
  const persistDecision = useCallback(async (decision: AiEngineDecision) => {
    try {
      await fetch(`${API_BASE}/ai/decisions`, {
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
        }),
      });
    } catch { /* non-fatal */ }
  }, []);

  // ── Update stats ──────────────────────────────────────────────────────────
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

  // ── Forward approved order to VPS ─────────────────────────────────────────
  const forwardToVps = useCallback(async (
    decision: AiEngineDecision,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${API_BASE}/vps/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId:    decision.id,
          operatingState: decision.operatingState,
          symbol:        decision.primarySymbol,
          executionType: decision.executionType,
          sizeUsd:       decision.sizeUsd,
          leverage:      decision.leverage,
          tpPrice:       decision.tpPrice,
          slPrice:       decision.slPrice,
          trailingStopPct: decision.trailingStopPct,
          hedgeParams:   decision.hedgeParams,
          cycleNumber:   decision.cycleNumber,
        }),
      });
      if (!res.ok) return { ok: false, error: `VPS responded ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  }, []);

  // ── Approve a live order ──────────────────────────────────────────────────
  const approveLiveOrder = useCallback(async (id: string) => {
    const approval = pendingApprovals.find(a => a.id === id);
    if (!approval || approval.status !== 'PENDING') return;

    setPendingApprovals(prev => prev.map(a =>
      a.id === id
        ? { ...a, status: 'APPROVED' as ApprovalStatus, approvedAt: new Date().toISOString() }
        : a,
    ));

    const result = await forwardToVps(approval.decision);
    setPendingApprovals(prev => prev.map(a =>
      a.id === id ? { ...a, vpsForwarded: result.ok, vpsError: result.error } : a,
    ));
  }, [pendingApprovals, forwardToVps]);

  // ── Reject a live order ───────────────────────────────────────────────────
  const rejectLiveOrder = useCallback((id: string, reason?: string) => {
    setPendingApprovals(prev => prev.map(a =>
      a.id === id && a.status === 'PENDING'
        ? {
            ...a,
            status: 'REJECTED' as ApprovalStatus,
            rejectedAt: new Date().toISOString(),
            rejectionReason: reason,
          }
        : a,
    ));
  }, []);

  // ── Run one engine cycle ──────────────────────────────────────────────────
  const runCycle = useCallback(async () => {
    if (running) return;
    setRunning(true);

    try {
      const analyses   = buildAnalyses();
      const dataFreshMs = Date.now() - lastPriceUpdate.current;
      cycleNumber.current += 1;

      const rawDecision = runAiEngine({
        cycleNumber: cycleNumber.current,
        prevState:   prevState.current,
        analyses,
        positions,
        account: {
          balance:           account.balance,
          availableBalance:  account.availableBalance,
          unrealizedPnl:     account.unrealizedPnl,
          realizedPnlToday:  account.realizedPnlToday,
        },
        limits,
        engineState: String(engineState),
        consecutiveLosses,
        dataFreshMs,
      });

      const isLiveTrade  = engineState === EngineState.LIVE_TRADING;
      const isPaperTrade = !isLiveTrade &&
        engineState !== EngineState.EMERGENCY_STOP &&
        engineState !== EngineState.RISK_LOCKED;
      const isActionable =
        rawDecision.riskApproved &&
        rawDecision.operatingState !== 'CASH' &&
        rawDecision.executionType !== 'hold' &&
        !!rawDecision.sizeUsd && rawDecision.sizeUsd > 0 &&
        !!rawDecision.primarySymbol;

      let paperExecuted = false;
      let paperOrderId: string | undefined;

      if (isActionable) {
        if (isLiveTrade) {
          // ── LIVE: queue for operator approval ───────────────────────────
          const now      = new Date().toISOString();
          const approvalId = genId();
          const decId    = genId();
          const fullDecision: AiEngineDecision = {
            id: decId, createdAt: now, paperExecuted: false, ...rawDecision,
          };
          const approval: PendingLiveApproval = {
            id:        approvalId,
            decision:  fullDecision,
            createdAt: now,
            expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
            status:    'PENDING',
          };
          setPendingApprovals(prev => [...prev, approval]);

          // Notify operator
          const expiresInMin = Math.round(APPROVAL_TIMEOUT_MS / 60_000);
          scheduleLiveApprovalAlert(
            approvalId,
            rawDecision.primarySymbol ?? 'MULTI',
            rawDecision.operatingState,
            expiresInMin,
          );

        } else if (isPaperTrade && autoExecute) {
          // ── PAPER: auto-execute locally ─────────────────────────────────
          const sym  = rawDecision.primarySymbol!;
          const side = rawDecision.operatingState === 'SHORT' ? 'SHORT' : 'LONG';
          const baseOrder = {
            symbol: sym, side: side as 'LONG' | 'SHORT',
            orderType: 'MarketIncrease' as const,
            sizeInUsd: rawDecision.sizeUsd!,
            leverage:  rawDecision.leverage ?? 5,
            tpPrice:   rawDecision.tpPrice,
            slPrice:   rawDecision.slPrice,
          };

          let result;
          if (['perp_long_open', 'perp_short_open', 'hedge_open'].includes(rawDecision.executionType)) {
            result = placeOrder(baseOrder);
          } else if (rawDecision.executionType === 'spot_swap') {
            result = placeOrder({ ...baseOrder, leverage: 1 });
          }
          if (result?.success) {
            paperExecuted = true;
            paperOrderId  = genId();
          }
        }
      }

      const decision: AiEngineDecision = {
        id: genId(),
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
    consecutiveLosses, autoExecute, placeOrder, updateStats, persistDecision,
  ]);

  // ── Schedule cycles ───────────────────────────────────────────────────────
  useEffect(() => {
    const schedule = () => {
      nextCycleAt.current   = Date.now() + CYCLE_MS;
      cycleTimer.current    = setTimeout(async () => {
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
      if (cycleTimer.current)   clearTimeout(cycleTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerCycle = useCallback(async () => {
    if (cycleTimer.current) clearTimeout(cycleTimer.current);
    await runCycle();
    nextCycleAt.current = Date.now() + CYCLE_MS;
    cycleTimer.current  = setTimeout(triggerCycle, CYCLE_MS);
  }, [runCycle]);

  const clearHistory = useCallback(() => {
    setDecisionHistory([]);
    setCurrentDecision(null);
  }, []);

  const pendingCount = pendingApprovals.filter(a => a.status === 'PENDING').length;

  return (
    <AiEngineContext.Provider value={{
      currentDecision, decisionHistory, stats,
      running, autoExecute, setAutoExecute,
      triggerCycle, clearHistory, nextCycleMs,
      pendingApprovals, approveLiveOrder, rejectLiveOrder, pendingCount,
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
