import { useCallback, useEffect, useState } from 'react';
import { Activity, CircleDollarSign, Landmark, ShieldAlert, WalletCards } from 'lucide-react';
import { cn } from '@/lib/utils';

type SnapshotTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

type RiskPayload = {
  capital?: {
    plannedSeedCapitalUsd?: unknown;
    activeTradingCapitalUsd?: unknown;
    currentRiskEquityUsd?: unknown;
    semantics?: { alignment?: unknown };
  };
  state?: {
    riskOperatingState?: unknown;
    historicalHardStopTriggerReason?: unknown;
  };
};

type ExecutorPayload = {
  ok?: boolean;
  dailyPnlUsd?: unknown;
  periodPnlUpdatedAt?: unknown;
};

type GmxPositionsPayload = {
  positions?: unknown;
  source?: unknown;
  apiCrosscheck?: { consistency?: unknown };
};

interface OperatorSnapshot {
  plannedSeedUsd: number | null;
  activeCapitalUsd: number | null;
  activeAlignment: string | null;
  riskEquityUsd: number | null;
  riskState: string | null;
  historicalHardStop: boolean;
  dailyPnlUsd: number | null;
  dailyPnlFresh: boolean;
  gmxPositionCount: number | null;
  gmxConsistency: string | null;
  updatedAt: number | null;
}

const EMPTY: OperatorSnapshot = {
  plannedSeedUsd: null,
  activeCapitalUsd: null,
  activeAlignment: null,
  riskEquityUsd: null,
  riskState: null,
  historicalHardStop: false,
  dailyPnlUsd: null,
  dailyPnlFresh: false,
  gmxPositionCount: null,
  gmxConsistency: null,
  updatedAt: null,
};

const POLL_MS = 30_000;
const PERIOD_STALE_MS = 5 * 60_000;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatUsd(value: number | null, signed = false): string {
  if (value === null) return 'Unavailable';
  const prefix = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : '';
  return `${prefix}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const TONE: Record<SnapshotTone, { dot: string; value: string }> = {
  neutral: { dot: 'bg-[#8b7cff]', value: 'text-foreground' },
  primary: { dot: 'bg-[#37d0ff]', value: 'text-foreground' },
  success: { dot: 'bg-[#37d99a]', value: 'text-[#37d99a]' },
  warning: { dot: 'bg-[#ffb648]', value: 'text-[#ffb648]' },
  danger:  { dot: 'bg-[#ff5c76]', value: 'text-[#ff5c76]' },
};

function SnapshotCard({
  label,
  value,
  sub,
  tone = 'neutral',
  icon: Icon,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: SnapshotTone;
  icon: typeof Activity;
  testId: string;
}) {
  return (
    <div
      className="min-w-0 rounded-xl border border-[#1b2636] bg-[#0d131e] p-3.5 shadow-sm"
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE[tone].dot)} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {label}
          </span>
        </div>
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#5f6b7a]" />
      </div>
      <div className={cn('mt-2 truncate font-mono text-xl font-bold', TONE[tone].value)}>
        {value}
      </div>
      <div className="mt-1 truncate text-[10px] text-[#5f6b7a]" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function riskTone(state: string | null): SnapshotTone {
  if (!state) return 'warning';
  if (state === 'HARD_STOPPED' || state === 'UNRESOLVED') return 'danger';
  if (state.includes('LOCKED')) return 'warning';
  return 'success';
}

function pnlTone(value: number | null, fresh: boolean): SnapshotTone {
  if (!fresh || value === null) return 'warning';
  if (value < 0) return 'danger';
  if (value > 0) return 'success';
  return 'neutral';
}

function gmxTone(consistency: string | null, count: number | null): SnapshotTone {
  if (count === null) return 'warning';
  if (consistency === 'mismatch' || consistency === 'rpc-unavailable') return 'danger';
  if (consistency === 'matched') return 'success';
  return 'primary';
}

export function OperatorSnapshotStrip() {
  const [snapshot, setSnapshot] = useState<OperatorSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);

  const poll = useCallback(async () => {
    const [riskResult, executorResult, gmxResult] = await Promise.allSettled([
      readJson<RiskPayload>('/api/risk/policy'),
      readJson<ExecutorPayload>('/api/executor/status'),
      readJson<GmxPositionsPayload>('/api/gmx/positions'),
    ]);

    const next: OperatorSnapshot = { ...EMPTY, updatedAt: Date.now() };

    if (riskResult.status === 'fulfilled') {
      const risk = riskResult.value;
      next.plannedSeedUsd = finiteNumber(risk.capital?.plannedSeedCapitalUsd);
      next.activeCapitalUsd = finiteNumber(risk.capital?.activeTradingCapitalUsd);
      next.riskEquityUsd = finiteNumber(risk.capital?.currentRiskEquityUsd);
      next.activeAlignment = typeof risk.capital?.semantics?.alignment === 'string'
        ? risk.capital.semantics.alignment
        : null;
      next.riskState = typeof risk.state?.riskOperatingState === 'string'
        ? risk.state.riskOperatingState
        : null;
      next.historicalHardStop = typeof risk.state?.historicalHardStopTriggerReason === 'string'
        && risk.state.historicalHardStopTriggerReason.trim().length > 0;
    }

    if (executorResult.status === 'fulfilled' && executorResult.value.ok !== false) {
      const executor = executorResult.value;
      next.dailyPnlUsd = finiteNumber(executor.dailyPnlUsd);
      const updatedAt = typeof executor.periodPnlUpdatedAt === 'string'
        ? Date.parse(executor.periodPnlUpdatedAt)
        : NaN;
      next.dailyPnlFresh = next.dailyPnlUsd !== null
        && Number.isFinite(updatedAt)
        && Date.now() - updatedAt <= PERIOD_STALE_MS;
    }

    if (gmxResult.status === 'fulfilled' && gmxResult.value.source === 'rpc') {
      const positions = Array.isArray(gmxResult.value.positions) ? gmxResult.value.positions : null;
      next.gmxPositionCount = positions?.length ?? null;
      next.gmxConsistency = typeof gmxResult.value.apiCrosscheck?.consistency === 'string'
        ? gmxResult.value.apiCrosscheck.consistency
        : null;
    }

    setSnapshot(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const plannedSub = 'Plan only · never treated as wallet balance';
  const activeSub = snapshot.activeAlignment
    ? `Approved stage · ${snapshot.activeAlignment}`
    : 'Approved stage · manual promotion only';
  const riskSub = snapshot.riskState
    ? `${snapshot.riskState}${snapshot.historicalHardStop ? ' · historical trigger retained' : ''}`
    : 'Risk state unavailable · fail-closed';
  const dailySub = snapshot.dailyPnlFresh
    ? 'PAPER equity delta · server period baseline'
    : 'PAPER PnL unavailable or stale';
  const gmxSub = snapshot.gmxPositionCount === null
    ? 'RPC position read unavailable'
    : snapshot.gmxConsistency === 'matched'
      ? 'RPC/API count cross-check matched'
      : snapshot.gmxConsistency === 'mismatch'
        ? 'RPC/API count mismatch · review required'
        : 'RPC authoritative · API parity unavailable';

  return (
    <section aria-label="Capital and runtime snapshot" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4 px-0.5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5f6b7a]">
            Capital & Runtime Snapshot
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Planned seed, active capital, risk equity and wallet-derived GMX state stay semantically separate.
          </div>
        </div>
        <span className="shrink-0 text-[9px] font-mono text-[#5f6b7a]">
          {loading ? 'LOADING' : snapshot.updatedAt ? `UPDATED ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : 'UNAVAILABLE'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <SnapshotCard
          label="Planned Seed"
          value={snapshot.plannedSeedUsd === null ? 'Unavailable' : `$${snapshot.plannedSeedUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
          sub={plannedSub}
          tone="neutral"
          icon={Landmark}
          testId="operator-planned-seed"
        />
        <SnapshotCard
          label="Active Capital"
          value={snapshot.activeCapitalUsd === null ? 'Unavailable' : `$${snapshot.activeCapitalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
          sub={activeSub}
          tone="primary"
          icon={WalletCards}
          testId="operator-active-capital"
        />
        <SnapshotCard
          label="Risk Equity"
          value={formatUsd(snapshot.riskEquityUsd)}
          sub={riskSub}
          tone={riskTone(snapshot.riskState)}
          icon={ShieldAlert}
          testId="operator-risk-equity"
        />
        <SnapshotCard
          label="Daily PnL"
          value={snapshot.dailyPnlFresh ? formatUsd(snapshot.dailyPnlUsd, true) : 'Unavailable'}
          sub={dailySub}
          tone={pnlTone(snapshot.dailyPnlUsd, snapshot.dailyPnlFresh)}
          icon={CircleDollarSign}
          testId="operator-daily-pnl"
        />
        <SnapshotCard
          label="GMX Positions"
          value={snapshot.gmxPositionCount === null ? 'Unavailable' : String(snapshot.gmxPositionCount)}
          sub={gmxSub}
          tone={gmxTone(snapshot.gmxConsistency, snapshot.gmxPositionCount)}
          icon={Activity}
          testId="operator-gmx-positions"
        />
      </div>
    </section>
  );
}
