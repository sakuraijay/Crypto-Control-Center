import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiUrl } from '@/lib/apiUrl';
import type { VirtualActivity } from '@/lib/virtualActivityPresentation';

export interface VirtualPaper400Snapshot {
  ok: boolean;
  mode: 'VIRTUAL_PAPER_400';
  realFundsUsed: false;
  session: { status: 'ACTIVE' | 'STOPPED' | 'MISSING' | 'INVALID' };
  runtimeFresh: boolean;
  activity?: VirtualActivity | null;
  activityFresh?: boolean;
  tradingModeSelection?: { version: string; mode: 'INTRADAY' | 'SWING'; sessionId: string; updatedAt: string } | null;
  tradingModeOptions?: Record<'INTRADAY' | 'SWING', { label: string; minTargetRoePct: number; maxTargetRoePct: number;
    targetRoePct: number | null; stopRoePct: number; maxHoldHours: number; exitBasis?: string }>;
  runtime: null | {
    calendar?: { version: 'paper-calendar/v1'; status: 'AVAILABLE' | 'UNAVAILABLE'; timezone: 'Asia/Manila'; coverageStart: string | null; throughDate: string | null; observedAt: string | null; days: { date: string; netPnlUsd: number; grossPnlUsd: number; costUsd: number; entries: number; completedTrades: number; settlements: number }[] };
    tradingMode?: { mode: 'INTRADAY' | 'SWING'; targetRoePct: number | null; stopRoePct: number; maxHoldHours: number } | null;
    policy?: { version: string; appliedAt: string; symbols: string[]; riskPerTradePct: number; minLeverage?: number; maxLeverage: number; cooldownMinutes: number; maxDailyEntries?: number; dailyProfitCapPct?: number; minimumNetRewardRisk?: number } | null;
    comparison?: {
      version?: string; status: string; candidates?: number; completedPairs?: number;
      baseline?: { trades?: number; netPnlUsd?: number | null; costUsd?: number | null; expectancyUsd?: number | null; winRate?: number | null };
      filtered?: { trades?: number; netPnlUsd?: number | null; costUsd?: number | null; expectancyUsd?: number | null; winRate?: number | null };
    } | null;
    continuousComparison?: ({
      version: string; status: 'COLLECTING'; pages: number; candidates: number;
      policyVersions?: { legacy: string; adaptive: string };
      accepted: { legacyV7: number; adaptiveV8?: number; adaptiveV9?: number };
      costEvidenceAvailable: { legacyV7: number; adaptiveV8?: number; adaptiveV9?: number };
      costEvidenceUnavailable: { legacyV7: number; adaptiveV8?: number; adaptiveV9?: number };
      pendingTimeWindow: number; outcomeUnknown: number;
      maxPotentialMaturityAt: string | null;
      outcomes: {
        status: 'NOT_EVALUATED_NO_CLOSED_CANDLE_REPLAY'; matured: number;
        pendingTimeWindow: number; outcomeUnknown: number;
        opportunityArms: number;
        netPnlUsd: null; expectancyUsd: null; winRate: null;
      };
      semantics?: string; selectionBias?: string;
      outOfSampleStrategyValidated?: false; automaticPromotion?: false;
    } | { status: 'UNAVAILABLE'; reason: string }) | null;
    tradingDiagnostics?: {
      status: 'OBSERVED' | 'UNAVAILABLE';
      observedAt?: string;
      minutesWithoutNewEntry?: number;
      adaptiveEvaluations?: {
        status: 'OBSERVED' | 'EMPTY';
        windowBasis: string;
        candidates: number;
        eligible: number;
        rejected: number;
        signal: { candidates: number; eligible: number; rejected: number; reasons: { reason: string; count: number }[] };
        safety: { candidates: number; eligible: number; rejected: number; reasons: { reason: string; count: number }[] };
        legacy: { candidates: number; eligible: number; rejected: number; reasons: { reason: string; count: number }[] };
        byPolicy: { version: string; candidates: number; eligible: number; rejected: number }[];
        rejectionReasons: { reason: string; count: number }[];
        conditions: { name: string; observed: number; missing: number; passed: number; failed: number;
          mean: number | null; minimum: number | null; maximum: number | null; meanThreshold: number | null }[];
        nextEvaluationAt: string | null;
      };
    } | { status: 'UNAVAILABLE'; reason: string; historyReconstructed: false };
    entryEvaluations?: { id: string; symbol: string; policyVersion: string; closedAt: number; evaluatedAt: number;
      evidence?: { candidateId: string; source: string; referencePrice: number; currentEntryPrice: number | null;
        executionEntryPrice: number | null; direction: 'LONG' | 'SHORT'; observedStopPrice: number | null;
        observedTargetPrice: number | null; actualStopDistanceFraction: number | null;
        stopBounds: { minimum: number; maximum: number }; candidateReason: string; selectedSetup: string | null;
        selectedScore: number; stopFailure: string | null;
        signalConditions: { setup: string; side: 'LONG' | 'SHORT' | null; score: number; threshold: number;
          eligible: boolean; reason: string; targetPrice: number | null; targetBasis: string | null }[] };
      eligible: boolean; reason: string; kind: 'SIGNAL' | 'SAFETY'; conditions: {
        name: string; value: number | null; operator: string; threshold: number | null; passed: boolean | null;
      }[] }[];
    diagnostics?: { symbol: string; reason: string; details?: string[] }[];
    analysis?: { symbol: string; reason: string }[];
    journal?: { id: string; symbol: string; side: string; openedAt: string | null; closedAt: string;
      entryEvidence?:import('../virtualTradeEvidencePresentation').TradeEntryEvidence|null;
      entryNotionalUsd?:string|null;settledNotionalUsd?:string|null;leverage?:string|null;collateralUsd?:string|null;holdingMinutes?:number|null;
      entryPrice: string | null; exitPrice: string; stopPrice: string | null; targetPrice: string | null;
      strategy: string | null; reasons: string[]; closeReason: string; grossPnlUsd: string; netPnlUsd: string;
      entryCostUsd: string | null; exitCostUsd: string | null; holdingCostUsd: string | null;
      plannedRiskUsd: number | null; netR: number | null; closeKind: string }[];
    status: string; reason: string | null; at: string;
    account: { dailyBudget?: { version: string; basis: 'FUNDED_PRINCIPAL'; referenceCapitalUsd: number; profitTargetMinPct: number; profitCapPct: number; lossLimitPct: number; profitTargetMinUsd: number; profitCapUsd: number; lossLimitUsd: number; remainingLossBudgetUsd: number } | null; equityUsd: number | null; unrealizedNetPnlUsd: number | null;
      ledger: { initialEquityUsd?: number; netContributionsUsd?: number; fundedCapitalUsd?: number; realizedEquityUsd: number; realizedNetPnlUsd: number; settlementCount: number };
      held: { id: string; symbol: string; side: string; sizeUsd: string; entryPrice: string;
        stopPrice: string; takeProfitPrice: string | null }[] };
  };
}


export function virtualSnapshotFresh(data: VirtualPaper400Snapshot | null, now = Date.now()): boolean {
  const at = Date.parse(data?.runtime?.at ?? '');
  return data?.runtimeFresh === true && Number.isFinite(at) && now >= at && now - at <= 120_000;
}

export function virtualSessionLabel(data: VirtualPaper400Snapshot | null, fresh: boolean): string {
  if (!data) return '서버 상태 미확인';
  if (data.session.status === 'STOPPED') return '신규 진입 중지';
  if (data.session.status === 'MISSING') return '시작 전';
  if (data.session.status !== 'ACTIVE' || !fresh) return '서버 실행 확인 대기';
  const idleMinutes = data.runtime?.tradingDiagnostics?.status === 'OBSERVED'
    ? data.runtime.tradingDiagnostics.minutesWithoutNewEntry : undefined;
  if (data.runtime?.status === 'NO_TRADE' && idleMinutes !== undefined && idleMinutes >= 1440)
    return '자동매매 활성 · 24시간 이상 신규 진입 없음';
  if (data.runtime?.status === 'NO_TRADE') return '자동매매 활성 · 조건 대기';
  if (data.runtime?.status === 'BLOCKED') return '자동매매 활성 · 신규 진입 차단';
  return '자동매매 활성 · ' + (data.runtime?.status ?? '판단 확인 중');
}

type ContextValue = { data: VirtualPaper400Snapshot | null; error: string | null;
  fresh: boolean; now: number; status: string; refresh: (signal?: AbortSignal) => Promise<void> };
const VirtualPaper400Context = createContext<ContextValue | null>(null);
export function VirtualPaper400Provider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<VirtualPaper400Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const latest = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++latest.current;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 8_000);
    try {
      const response = await fetch(apiUrl('data/virtual-paper-400-session'), { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok || result.mode !== 'VIRTUAL_PAPER_400' || result.realFundsUsed !== false
        || !['ACTIVE', 'STOPPED', 'MISSING'].includes(result.session?.status)
        || (result.runtimeFresh === true && (!result.runtime?.account?.ledger
          || !Array.isArray(result.runtime.account.held)))) throw new Error('Invalid virtual snapshot');
      if (!signal?.aborted && request === latest.current) { setData(result); setError(null); setNow(Date.now()); }
    } catch {
      if (!signal?.aborted && request === latest.current) {
        setData(null); setError('서버 연결을 확인해 주세요. 잔액·실행 상태 미확인.');
      }
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 10_000);
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { controller.abort(); clearTimeout(timer); clearInterval(clock); latest.current++; };
  }, [refresh]);
  const fresh = !error && virtualSnapshotFresh(data, now);
  return <VirtualPaper400Context.Provider value={{ data, error, fresh, now, status: virtualSessionLabel(data, fresh), refresh }}>
    {children}
  </VirtualPaper400Context.Provider>;
}
export function useVirtualPaper400() {
  const value = useContext(VirtualPaper400Context);
  if (!value) throw new Error('VirtualPaper400Provider is required');
  return value;
}
