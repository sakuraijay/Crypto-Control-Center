/**
 * VpsStatusPanel — web
 *
 * Shows live VPS system-health telemetry and arm/disarm controls.
 * Designed for the Dashboard and Settings pages.
 *
 * Architecture note:
 *   The VPS is the always-on trading authority. This panel is a monitoring
 *   surface only — it does not execute trades itself.
 */

import { useState } from 'react';
import { useVpsContext, VpsEngineState, OperatingMode, timeAgo, formatUptime, VPS_STATE_LABELS } from '@/lib/context/VpsContext';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Server, Wifi, WifiOff, Loader2, AlertTriangle, ShieldCheck, ShieldOff,
  Radio, Activity, Clock, RefreshCw, Zap, CheckCircle2, XCircle,
  Brain, UserCog, ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link } from 'wouter';

// ── Operating mode display config ─────────────────────────────────────────────

const MODE_CFG: Record<OperatingMode, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub: string;
  cls: string;
  textCls: string;
}> = {
  AUTONOMOUS_AI: {
    icon:    Brain,
    label:   'AUTONOMOUS AI',
    sub:     'AI is independently selecting symbols, deciding direction, sizing positions and managing TP/SL 24/7',
    cls:     'border-[var(--color-long)]/40 bg-[var(--color-long)]/5',
    textCls: 'text-[var(--color-long)]',
  },
  MANUAL_OVERRIDE: {
    icon:    UserCog,
    label:   'MANUAL OVERRIDE',
    sub:     'AI is paused — trades are placed manually. Arm the VPS to enable autonomous operation.',
    cls:     'border-amber-500/30 bg-amber-500/5',
    textCls: 'text-amber-400',
  },
  RISK_LOCKED: {
    icon:    ShieldAlert,
    label:   'RISK LOCKED',
    sub:     'Deterministic risk controls have vetoed all trading activity. Manual intervention required.',
    cls:     'border-[var(--color-short)]/40 bg-[var(--color-short)]/5',
    textCls: 'text-[var(--color-short)]',
  },
};

// ── State colours ─────────────────────────────────────────────────────────────

const STATE_CLASSES: Record<VpsEngineState, { dot: string; badge: string; border: string }> = {
  OFF: {
    dot:    'bg-muted-foreground',
    badge:  'bg-muted text-muted-foreground border-border',
    border: 'border-border',
  },
  ARMED: {
    dot:    'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)] animate-pulse',
    badge:  'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    border: 'border-cyan-500/20',
  },
  RECONCILING: {
    dot:    'bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.5)]',
    badge:  'bg-amber-500/10 text-amber-400 border-amber-500/30',
    border: 'border-amber-500/20',
  },
  RUNNING: {
    dot:    'bg-[var(--color-long)] shadow-[0_0_8px_rgba(0,200,83,0.5)]',
    badge:  'bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30',
    border: 'border-[var(--color-long)]/20',
  },
  RISK_LOCKED: {
    dot:    'bg-[var(--color-short)] shadow-[0_0_10px_rgba(246,70,93,0.7)] animate-pulse',
    badge:  'bg-[var(--color-short)]/10 text-[var(--color-short)] border-[var(--color-short)]/30',
    border: 'border-[var(--color-short)]/40',
  },
};

// ── Small helpers ─────────────────────────────────────────────────────────────

function HealthRow({ label, value, icon: Icon, fresh }: {
  label: string; value: string;
  icon?: React.ComponentType<{ className?: string }>;
  fresh?: boolean | null;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
      </div>
      <span className={cn(
        'text-xs font-mono',
        fresh === true ? 'text-[var(--color-long)]' : fresh === false ? 'text-[var(--color-short)]' : 'text-foreground',
      )}>
        {value}
      </span>
    </div>
  );
}

function StatusDot({ state }: { state: VpsEngineState }) {
  return (
    <div className={cn('w-2 h-2 rounded-full shrink-0', STATE_CLASSES[state].dot)} />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface VpsStatusPanelProps {
  /** When true shows the full form link — set false when already on Settings page */
  showConfigLink?: boolean;
  className?: string;
}

export function VpsStatusPanel({ showConfigLink = true, className }: VpsStatusPanelProps) {
  const {
    config, vpsState, operatingMode, connectionStatus, connectionError,
    unattendedArmed, health, aiStats,
    testConnection, armUnattended, disarmUnattended,
  } = useVpsContext();

  const [testing, setTesting] = useState(false);
  const [armDialog, setArmDialog] = useState(false);
  const [disarmDialog, setDisarmDialog] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const cls = STATE_CLASSES[vpsState];
  const configured = Boolean(config.host.trim());

  const handleTest = async () => {
    setTesting(true);
    await testConnection();
    setTesting(false);
  };

  const handleArm = async () => {
    setActionLoading(true);
    setActionError('');
    const result = await armUnattended();
    setActionLoading(false);
    if (result.ok) {
      setArmDialog(false);
    } else {
      setActionError(result.error ?? 'Unknown error');
    }
  };

  const handleDisarm = async () => {
    setActionLoading(true);
    setActionError('');
    const result = await disarmUnattended();
    setActionLoading(false);
    if (result.ok) {
      setDisarmDialog(false);
    } else {
      setActionError(result.error ?? 'Unknown error');
    }
  };

  // Freshness: data considered stale if > 30 s old
  const fresh = (iso: string | null) => {
    if (!iso) return null;
    return Date.now() - new Date(iso).getTime() < 30_000;
  };

  return (
    <Card className={cn('overflow-hidden', cls.border, 'border', className)}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 bg-card/50 border-b border-border">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">VPS Trading Engine</span>
          {health.strategyVersion && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {health.strategyVersion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {health.uptimeSeconds != null && (
            <span className="text-[10px] text-muted-foreground font-mono">
              up {formatUptime(health.uptimeSeconds)}
            </span>
          )}
          <div className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-wider',
            cls.badge,
          )}>
            <StatusDot state={vpsState} />
            {VPS_STATE_LABELS[vpsState]}
          </div>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4">

        {/* ── Operating Mode Banner ────────────────────────────── */}
        {(() => {
          const m = MODE_CFG[operatingMode];
          const ModeIcon = m.icon;
          return (
            <div className={cn('flex items-start gap-3 p-3 rounded-lg border', m.cls)}>
              <div className="p-1.5 rounded-md bg-background/30 mt-0.5">
                <ModeIcon className={cn('w-4 h-4', m.textCls)} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={cn('text-[11px] font-bold tracking-wider', m.textCls)}>{m.label}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{m.sub}</div>
                {operatingMode === 'AUTONOMOUS_AI' && aiStats.today > 0 && (
                  <div className="flex gap-3 mt-2 text-[10px]">
                    <span className="text-[var(--color-long)]">{aiStats.todayFilled} filled today</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{aiStats.todayVetoed} vetoed</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{Math.round(aiStats.avgConfidence * 100)}% avg confidence</span>
                  </div>
                )}
              </div>
              {operatingMode === 'AUTONOMOUS_AI' && (
                <Link href="/ai-log" className="text-[10px] text-[var(--color-long)] hover:underline whitespace-nowrap shrink-0">
                  View Log →
                </Link>
              )}
            </div>
          );
        })()}

        {/* ── Connection bar ───────────────────────────────────── */}
        {configured ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {connectionStatus === 'connected'
              ? <Wifi className="w-3.5 h-3.5 text-[var(--color-long)]" />
              : connectionStatus === 'connecting'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <WifiOff className="w-3.5 h-3.5 text-[var(--color-short)]" />
            }
            <span className="font-mono truncate">{config.host}:{config.port}</span>
            {health.heartbeatLatencyMs != null && (
              <span className="text-[var(--color-long)]">· {health.heartbeatLatencyMs}ms</span>
            )}
            {connectionError && (
              <span className="text-[var(--color-short)] ml-1">{connectionError}</span>
            )}
            <Button
              variant="ghost" size="sm"
              className="ml-auto h-6 text-[10px] px-2"
              onClick={handleTest} disabled={testing}
            >
              {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {testing ? 'Polling…' : 'Refresh'}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <WifiOff className="w-3.5 h-3.5" />
            <span>VPS not configured.</span>
            {showConfigLink && (
              <Link href="/settings" className="text-primary hover:underline">
                Configure in Settings →
              </Link>
            )}
          </div>
        )}

        {/* ── System health grid ───────────────────────────────── */}
        {configured && (
          <div className="grid grid-cols-2 gap-x-6 bg-secondary/30 rounded-lg px-4 py-3">
            <div>
              <HealthRow label="Heartbeat"     value={timeAgo(health.lastHeartbeat)}     icon={Radio}     fresh={fresh(health.lastHeartbeat)} />
              <HealthRow label="User Stream"   value={timeAgo(health.lastUserStream)}    icon={Activity}  fresh={fresh(health.lastUserStream)} />
              <HealthRow label="Last Restart"  value={timeAgo(health.lastRestart)}       icon={RefreshCw} />
            </div>
            <div>
              <HealthRow label="Market Data"   value={timeAgo(health.lastMarketUpdate)}  icon={Zap}       fresh={fresh(health.lastMarketUpdate)} />
              <HealthRow label="Strategy Cycle" value={timeAgo(health.lastStrategyCycle)} icon={Clock}    fresh={fresh(health.lastStrategyCycle)} />
              <HealthRow
                label="Reconciliation"
                value={
                  health.reconciliation.status === 'complete'
                    ? `✓ ${health.reconciliation.matchedPositions}/${health.reconciliation.totalPositions}`
                    : health.reconciliation.status === 'in_progress'
                      ? 'In progress…'
                      : health.reconciliation.status === 'failed'
                        ? `✗ failed`
                        : '—'
                }
                fresh={health.reconciliation.status === 'complete' || null}
              />
            </div>
          </div>
        )}

        {/* ── GMX connection status ────────────────────────────── */}
        {configured && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-2 text-xs">
              {health.gmxConnected
                ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-long)]" />
                : <XCircle className="w-3.5 h-3.5 text-[var(--color-short)]" />
              }
              <span className={health.gmxConnected ? 'text-[var(--color-long)]' : 'text-muted-foreground'}>
                GMX: {health.gmxConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {health.riskLock
                ? <AlertTriangle className="w-3.5 h-3.5 text-[var(--color-short)]" />
                : <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-long)]" />
              }
              <span className={health.riskLock ? 'text-[var(--color-short)]' : 'text-muted-foreground'}>
                {health.riskLock ? `Risk lock: ${health.riskLock.reason}` : 'Risk lock: None'}
              </span>
            </div>
            {health.walletAddress && (
              <div className="flex items-center gap-2 text-xs col-span-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="font-mono text-[10px] text-muted-foreground truncate">
                  Wallet: {health.walletAddress.slice(0, 6)}…{health.walletAddress.slice(-4)}
                </span>
                {health.subaccountAddress && (
                  <span className="font-mono text-[10px] text-muted-foreground ml-2 truncate">
                    Sub: {health.subaccountAddress.slice(0, 6)}…{health.subaccountAddress.slice(-4)}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── RISK LOCKED banner ───────────────────────────────── */}
        {vpsState === 'RISK_LOCKED' && health.riskLock && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--color-short)]/40 bg-[var(--color-short)]/5 text-xs">
            <AlertTriangle className="w-4 h-4 text-[var(--color-short)] shrink-0" />
            <div>
              <div className="font-bold text-[var(--color-short)]">VPS Risk Lock Active</div>
              <div className="text-muted-foreground">
                Reason: <span className="font-mono">{health.riskLock.reason}</span>
                {' · '}{timeAgo(health.riskLock.since)}
              </div>
            </div>
          </div>
        )}

        {/* ── Arm / Disarm ─────────────────────────────────────── */}
        <div className="flex flex-col gap-2 pt-1">
          {!unattendedArmed ? (
            <Button
              size="sm"
              className="w-full font-bold tracking-wider"
              style={{ background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)' }}
              onClick={() => setArmDialog(true)}
              disabled={!configured || connectionStatus !== 'connected'}
            >
              <Zap className="w-3.5 h-3.5 mr-1.5" />
              ARM UNATTENDED TRADING
            </Button>
          ) : (
            <Button
              size="sm" variant="outline"
              className="w-full font-bold text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/10"
              onClick={() => setDisarmDialog(true)}
            >
              <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
              DISARM — Stop Autonomous Operation
            </Button>
          )}

          {/* Warning note */}
          <div className="flex items-start gap-2 text-[10px] text-muted-foreground leading-relaxed">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5 text-amber-400" />
            <span>
              {unattendedArmed
                ? "VPS is armed for autonomous trading. Positions will be managed 24/7 regardless of this app's state."
                : "Live unattended trading requires an external VPS with a GMX One-Click subaccount. The VPS holds only the delegated subaccount key, never your primary wallet. Not enabled by default. Paper mode is always safe."}
            </span>
          </div>
        </div>
      </div>

      {/* ── ARM confirmation dialog ───────────────────────────── */}
      <Dialog open={armDialog} onOpenChange={open => { if (!open) { setArmDialog(false); setActionError(''); } }}>
        <DialogContent className="border-cyan-500/30">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-cyan-400">
              <Zap className="w-5 h-5" /> ARM Unattended Trading
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm pt-2">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold mb-1">Read before arming</div>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      <li>The VPS will operate autonomously <strong>24/7</strong>, including while you sleep.</li>
                      <li>If the VPS is configured for <strong>live trading</strong>, real orders will be placed on GMX V2 (Arbitrum One).</li>
                      <li>The VPS uses a delegated subaccount key (One-Click Trading) — never your primary wallet.</li>
                      <li>Risk controls (daily loss, drawdown, exposure limits) remain active at all times.</li>
                      <li><strong>Live trading is NOT enabled by default.</strong> Paper mode is always safe.</li>
                    </ul>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-long)]" />
                  VPS: <span className="font-mono">{config.host}:{config.port}</span>
                </div>
                {actionError && (
                  <div className="text-[var(--color-short)] text-xs">{actionError}</div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setArmDialog(false); setActionError(''); }}>
              Cancel
            </Button>
            <Button
              onClick={handleArm} disabled={actionLoading}
              className="font-bold tracking-wider"
              style={{ background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)', color: '#000' }}
            >
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
              Confirm — ARM
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DISARM confirmation dialog ─────────────────────────── */}
      <Dialog open={disarmDialog} onOpenChange={open => { if (!open) { setDisarmDialog(false); setActionError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff className="w-5 h-5" /> Disarm Unattended Trading
            </DialogTitle>
            <DialogDescription className="text-sm pt-2">
              The VPS will stop opening new autonomous positions. Existing positions will continue
              with their TP/SL orders active until manually closed or triggered.
              {actionError && <div className="text-[var(--color-short)] mt-2">{actionError}</div>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDisarmDialog(false); setActionError(''); }}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDisarm} disabled={actionLoading}>
              {actionLoading && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Disarm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
