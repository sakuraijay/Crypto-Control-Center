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
import { useVpsContext } from './VpsContext';

// ── Constants ─────────────────────────────────────────────────────────────────

const CYCLE_MS = 60_000;
const MAX_BUFFER = 200;
const CORE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'ARB', 'LINK'];
/** Prune expired approvals older than this (keep for audit) */
const APPROVAL_HISTORY_KEEP_MS = 24 * 60 * 60 * 1000;

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

  // ── Market rankings ──────────────────────────────────────────────────────
  /** Ranked list of all analysed GMX markets from the latest cycle */
  marketRankings: MarketRanking[];

  // ── System health / pause ────────────────────────────────────────────────
  /** True when the engine is paused due to VPS/connectivity issues */
  systemPaused: boolean;
  pauseReason: string | null;

  // ── Daily benchmark ──────────────────────────────────────────────────────
  /** Target account size used for benchmark display only */
  benchmarkAccountSize: number;
  /** Daily profit target range (min/max) for display only — NOT a guarantee */
  benchmarkDailyMin: number;
  benchmarkDailyMax: number;

  // ── Live approval gate ───────────────────────────────────────────────────
  /** All approvals (pending + historical) */
  pendingApprovals: PendingLiveApproval[];
  /** Approve a queued live order → forward to VPS */
  approveLiveOrder: (id: string) => Promise<void>;
  /** Reject a queued live order → discard */
  rejectLiveOrder: (id: string, reason?: string) => void;
  /** Count of currently pending (not yet approved/rejected/expired) */
  pendingCount: number;
  /** Load the next page (200 rows) of older decisions from the server. Returns false when exhausted. */
  loadMoreHistory: () => Promise<boolean>;
}

const AiEngineContext = createContext<AiEngineContextType | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function AiEngineProvider({ children }: { children: ReactNode }) {
  const { account, positions, placeOrder, clearAllPositions, consecutiveLosses } = useTradingContext();
  const { engineState, setEngineState } = useAppContext();
  const { limits } = useStrategyContext();
  const { watchlist } = useWatchlistContext();
  const { connectionStatus, config: vpsConfig, executorMode } = useVpsContext();
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
  const [systemPaused, setSystemPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState<string | null>(null);

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
  const nextCycleAt      = useRef<number>(Date.now() + CYCLE_MS);
  const seenApprovalIds  = useRef<Set<string>>(new Set());
  const dbPage           = useRef(1); // page 0 loaded on mount

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
          // Full-fidelity replay: if full JSON was persisted, deserialise it directly
          if (row.fullJson) {
            try {
              const parsed = JSON.parse(row.fullJson) as AiEngineDecision;
              return { ...parsed, id: String(row.id) };
            } catch { /* fall through to minimal conversion */ }
          }
          // Minimal conversion from scalar DB columns (older rows / VPS-originated)
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

  // ── Toast alert when a new LIVE approval enters the queue ─────────────────
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
      toast({
        title:       '⚡ LIVE Trade Approval Required',
        description: `${state} ${sym}/USD${size} — expires in ${expiresMins}m · Approve on Dashboard`,
        variant:     'destructive',
        duration:    15_000,
      });
    }
  }, [pendingApprovals, toast]);

  // ── Daily / weekly loss limit → RISK_LOCKED ───────────────────────────────
  useEffect(() => {
    if (engineState === 'EMERGENCY_STOP' || engineState === 'RISK_LOCKED') return;

    const dailyLoss = account.realizedPnlToday;
    const dailyLimit = limits.dailyLossLimitUSDT;
    const weeklyLimit = limits.weeklyLossLimitUSDT ?? 0;
    const consecLimit = limits.consecutiveLossLimit ?? 3;

    const hitDaily  = dailyLimit  > 0 && dailyLoss  < 0 && Math.abs(dailyLoss)  >= dailyLimit;
    const hitWeekly = weeklyLimit > 0 && dailyLoss  < 0 && Math.abs(dailyLoss)  >= weeklyLimit;
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
      setPendingApprovals(prev => prev.map(a => {
        if (a.status === 'PENDING' && new Date(a.expiresAt).getTime() <= now) {
          return { ...a, status: 'EXPIRED' as ApprovalStatus };
        }
        return a;
      }).filter(a =>
        // Keep pending/recent; prune old history
        a.status === 'PENDING' ||
        new Date(a.createdAt).getTime() > now - APPROVAL_HISTORY_KEEP_MS
      ));
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
          // Full decision JSON — enables lossless replay after page refresh
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

  // ── Forward approved order to Executor (internal or external VPS) ────────────
  const forwardToVps = useCallback(async (
    decision: AiEngineDecision,
    snapshot?: { host: string; port: string; useSSL: boolean },
  ): Promise<{ ok: boolean; error?: string }> => {
    const mode = executorMode ?? 'internal';
    let url: string;

    if (mode === 'internal') {
      // Internal Replit Executor — no host/port needed
      url = '/api-server/api/executor/execute';
    } else {
      // External VPS mode — use snapshotted or current config
      // (snapshot captures config at queue time so a host change mid-approval doesn't mis-route)
      const target = snapshot ?? { host: vpsConfig.host ?? '', port: vpsConfig.port ?? '8080', useSSL: vpsConfig.useSSL ?? false };
      if (!target.host?.trim()) return { ok: false, error: 'External VPS not configured — set host in Settings → Advanced' };
      const params = new URLSearchParams({
        host: target.host,
        port: target.port || '8080',
        ssl:  String(target.useSSL ?? false),
      });
      url = `/api-server/api/vps/execute?${params}`;
    }
    const body = JSON.stringify({
      decisionId:      decision.id,
      operatingState:  decision.operatingState,
      symbol:          decision.primarySymbol,
      executionType:   decision.executionType,
      sizeUsd:         decision.sizeUsd,
      leverage:        decision.leverage,
      tpPrice:         decision.tpPrice,
      slPrice:         decision.slPrice,
      trailingStopPct: decision.trailingStopPct,
      hedgeParams:     decision.hedgeParams,
      cycleNumber:     decision.cycleNumber,
    });
    const headers = { 'Content-Type': 'application/json' } as const;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          // Retry once on 5xx
          if (res.status >= 500 && attempt === 0) {
            await new Promise(r => setTimeout(r, 2_000));
            continue;
          }
          return { ok: false, error: `Executor responded ${res.status}${detail ? ': ' + detail.slice(0, 120) : ''}` };
        }
        return { ok: true };
      } catch (e) {
        if (attempt === 0) { await new Promise(r => setTimeout(r, 2_000)); continue; }
        return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
      }
    }
    return { ok: false, error: 'Executor unreachable after retry' };
  }, [vpsConfig, executorMode]);

  // ── Approve a live order ────────────────────────────────────────────────────
  const approveLiveOrder = useCallback(async (id: string) => {
    const approval = pendingApprovals.find(a => a.id === id);
    if (!approval || approval.status !== 'PENDING') return;

    // Mark approved immediately (optimistic)
    setPendingApprovals(prev => prev.map(a =>
      a.id === id ? { ...a, status: 'APPROVED' as ApprovalStatus, approvedAt: new Date().toISOString() } : a
    ));

    // Forward to VPS — use snapshotted config to prevent mis-routing on host change
    const result = await forwardToVps(approval.decision, approval.vpsSnapshot);
    setPendingApprovals(prev => prev.map(a =>
      a.id === id ? { ...a, vpsForwarded: result.ok, vpsError: result.error } : a
    ));
  }, [pendingApprovals, forwardToVps]);

  // ── Reject a live order ─────────────────────────────────────────────────────
  const rejectLiveOrder = useCallback((id: string, reason?: string) => {
    setPendingApprovals(prev => prev.map(a =>
      a.id === id && a.status === 'PENDING'
        ? { ...a, status: 'REJECTED' as ApprovalStatus, rejectedAt: new Date().toISOString(), rejectionReason: reason }
        : a
    ));
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

      const isLiveTrade = engineState === 'LIVE_TRADING';
      const isPaperTrade = !isLiveTrade && engineState !== 'EMERGENCY_STOP' && engineState !== 'RISK_LOCKED';
      const isVpsConnected = connectionStatus === 'connected';
      const isActionable =
        rawDecision.riskApproved &&
        rawDecision.operatingState !== 'CASH' &&
        rawDecision.executionType !== 'hold' &&
        !!rawDecision.sizeUsd && rawDecision.sizeUsd > 0 &&
        !!rawDecision.primarySymbol;

      // ── Update market rankings every cycle ─────────────────────────────
      setMarketRankings(rawDecision.marketRankings ?? []);

      let paperExecuted = false;
      let paperOrderId: string | undefined;
      let pausedReason: string | undefined;

      if (isActionable) {
        if (isLiveTrade) {
          // ── LIVE: fail-closed when VPS is not reachable ──────────────
          if (!isVpsConnected) {
            pausedReason = 'VPS disconnected — no live orders queued until connection restored';
            setSystemPaused(true);
            setPauseReason(pausedReason);
            console.warn(`[AiEngine] LIVE mode fail-closed — ${pausedReason}`);
          } else {
            setSystemPaused(false);
            setPauseReason(null);
            // ── Queue for operator approval ─────────────────────────────
            const now = new Date().toISOString();
            const approval: PendingLiveApproval = {
              id: uuid(),
              decision: { ...rawDecision, id: uuid(), createdAt: now, paperExecuted: false } as AiEngineDecision,
              createdAt: now,
              expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
              status: 'PENDING',
              // Snapshot VPS config at queue time — prevents mis-routing if operator changes host while approval is pending
              vpsSnapshot: {
                host:   vpsConfig.host   ?? '',
                port:   vpsConfig.port   ?? '8080',
                useSSL: vpsConfig.useSSL ?? false,
              },
            };
            setPendingApprovals(prev => [...prev, approval]);
          }

        } else if (isPaperTrade && autoExecute) {
          // ── PAPER: auto-execute locally (VPS down doesn't block paper) ──
          if (!isVpsConnected) {
            console.info('[AiEngine] VPS disconnected — paper trade running locally only');
          }
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
        // ── CASH decision with open positions → exit all to USDC ──────────
        console.info('[AiEngine] CASH state with open positions — closing all (paper)');
        clearAllPositions();
      }

      const decision: AiEngineDecision = {
        id: uuid(),
        createdAt: new Date().toISOString(),
        paperExecuted,
        paperOrderId,
        pausedReason,
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
    connectionStatus, autoExecute, placeOrder, clearAllPositions,
    updateStats, persistDecision,
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

  return (
    <AiEngineContext.Provider value={{
      currentDecision, decisionHistory, stats,
      running, autoExecute, setAutoExecute,
      triggerCycle, clearHistory, nextCycleMs,
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
