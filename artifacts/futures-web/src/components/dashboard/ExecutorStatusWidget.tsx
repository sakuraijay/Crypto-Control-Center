/**
 * ExecutorStatusWidget — compact execution engine status for the dashboard right column.
 *
 * Shows the essential executor health at a glance without the full VpsStatusPanel.
 * Full details (health telemetry, subaccount panel) live on the Settings page.
 */

import { useState } from 'react';
import { Link } from 'wouter';
import {
  Server, CheckCircle2, XCircle, Zap, ShieldOff, Loader2,
  AlertTriangle, Wifi, WifiOff, ExternalLink, Cpu, Globe,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useVpsContext, VPS_STATE_LABELS, formatUptime } from '@/lib/context/VpsContext';
import { cn } from '@/lib/utils';

const STATE_DOT: Record<string, string> = {
  OFF:         'bg-muted-foreground',
  ARMED:       'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)] animate-pulse',
  RECONCILING: 'bg-amber-400 animate-pulse',
  RUNNING:     'bg-[var(--color-long)] shadow-[0_0_8px_rgba(0,200,83,0.5)]',
  RISK_LOCKED: 'bg-[var(--color-short)] animate-pulse',
};

const STATE_BADGE: Record<string, string> = {
  OFF:         'bg-muted text-muted-foreground border-border',
  ARMED:       'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  RECONCILING: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  RUNNING:     'bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30',
  RISK_LOCKED: 'bg-[var(--color-short)]/10 text-[var(--color-short)] border-[var(--color-short)]/30',
};

export function ExecutorStatusWidget() {
  const {
    vpsState, connectionStatus, connectionError,
    health, unattendedArmed,
    armUnattended, disarmUnattended, testConnection,
    executorMode, internalSignerConfigured, internalDeploymentMode,
  } = useVpsContext();

  const [armDialog, setArmDialog] = useState(false);
  const [disarmDialog, setDisarmDialog] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [testing, setTesting] = useState(false);

  const handleArm = async () => {
    setActionLoading(true);
    setActionError('');
    const r = await armUnattended();
    setActionLoading(false);
    if (r.ok) setArmDialog(false);
    else setActionError(r.error ?? 'Unknown error');
  };

  const handleDisarm = async () => {
    setActionLoading(true);
    setActionError('');
    const r = await disarmUnattended();
    setActionLoading(false);
    if (r.ok) setDisarmDialog(false);
    else setActionError(r.error ?? 'Unknown error');
  };

  const handleRefresh = async () => {
    setTesting(true);
    await testConnection();
    setTesting(false);
  };

  const isConnected  = connectionStatus === 'connected';
  // Treat 'disconnected' (initial state before first poll) the same as 'connecting'
  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'disconnected';
  const ModeIcon     = executorMode === 'internal' ? Cpu : Globe;

  return (
    <Card className={cn(
      'overflow-hidden border',
      vpsState === 'ARMED' || vpsState === 'RUNNING'
        ? 'border-cyan-500/20'
        : vpsState === 'RISK_LOCKED'
          ? 'border-[var(--color-short)]/30'
          : 'border-border',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card/50 border-b border-border">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Execution Engine</span>
          <span className={cn(
            'text-[9px] px-1.5 py-0.5 rounded-full border font-bold tracking-wider flex items-center gap-1',
            executorMode === 'internal'
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-amber-500/10 text-amber-400 border-amber-500/30',
          )}>
            <ModeIcon className="w-2.5 h-2.5" />
            {executorMode === 'internal' ? 'INTERNAL' : 'EXTERNAL VPS'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {health.uptimeSeconds != null && (
            <span className="text-[10px] text-muted-foreground font-mono">
              up {formatUptime(health.uptimeSeconds)}
            </span>
          )}
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold tracking-wider',
            STATE_BADGE[vpsState] ?? STATE_BADGE.OFF,
          )}>
            <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATE_DOT[vpsState] ?? STATE_DOT.OFF)} />
            {VPS_STATE_LABELS[vpsState] ?? vpsState}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">

        {/* Connection status row */}
        <div className="flex items-center gap-2 text-xs">
          {isConnected
            ? <Wifi className="w-3.5 h-3.5 text-[var(--color-long)]" />
            : isConnecting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              : <WifiOff className="w-3.5 h-3.5 text-[var(--color-short)]" />
          }
          <span className={cn(
            'font-semibold',
            isConnected ? 'text-[var(--color-long)]' : isConnecting ? 'text-muted-foreground' : 'text-[var(--color-short)]',
          )}>
            {isConnected ? 'Online' : isConnecting ? 'Connecting…' : 'Unreachable'}
          </span>
          {connectionError && (
            <span className="text-[var(--color-short)] text-[10px] truncate">{connectionError}</span>
          )}
          <button
            onClick={handleRefresh}
            disabled={testing}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : '↻ Refresh'}
          </button>
        </div>

        {/* Readiness badges */}
        <div className="grid grid-cols-2 gap-1.5">
          {executorMode === 'internal' && (
            <>
              <div className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium',
                internalSignerConfigured
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : 'border-amber-500/30 bg-amber-500/5 text-amber-400',
              )}>
                {internalSignerConfigured
                  ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                  : <AlertTriangle className="w-3 h-3 shrink-0" />
                }
                {internalSignerConfigured ? 'Signer Ready' : 'Simulation'}
              </div>

              <div className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium',
                health.gmxConnected
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {health.gmxConnected
                  ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                  : <XCircle className="w-3 h-3 shrink-0" />
                }
                GMX {health.gmxConnected ? 'Live' : 'Offline'}
              </div>

              <div className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium',
                internalDeploymentMode === 'reserved_vm'
                  ? 'border-primary/30 bg-primary/5 text-primary'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                <Server className="w-3 h-3 shrink-0" />
                {internalDeploymentMode === 'reserved_vm' ? 'Reserved VM' : 'Dev Mode'}
              </div>

              {health.riskLock ? (
                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)] text-[10px] font-medium">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Risk Locked
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-[var(--color-long)]/20 bg-[var(--color-long)]/5 text-[var(--color-long)] text-[10px] font-medium">
                  <CheckCircle2 className="w-3 h-3 shrink-0" />
                  Risk Clear
                </div>
              )}
            </>
          )}

          {executorMode === 'external' && (
            <>
              <div className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium',
                health.gmxConnected
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {health.gmxConnected ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <XCircle className="w-3 h-3 shrink-0" />}
                GMX {health.gmxConnected ? 'Connected' : 'Disconnected'}
              </div>
              {health.subaccountAddress ? (
                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)] text-[10px] font-medium">
                  <CheckCircle2 className="w-3 h-3 shrink-0" />
                  Subaccount Active
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-border bg-card/50 text-muted-foreground text-[10px] font-medium">
                  <XCircle className="w-3 h-3 shrink-0" />
                  No Subaccount
                </div>
              )}
            </>
          )}
        </div>

        {/* ARM / DISARM */}
        {!unattendedArmed ? (
          <Button
            size="sm"
            className="w-full font-bold tracking-wider h-8"
            style={{ background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)', color: '#000' }}
            onClick={() => setArmDialog(true)}
            disabled={!isConnected}
          >
            <Zap className="w-3.5 h-3.5 mr-1.5" />
            ARM AUTONOMOUS TRADING
          </Button>
        ) : (
          <Button
            size="sm" variant="outline"
            className="w-full font-bold text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/10 h-8"
            onClick={() => setDisarmDialog(true)}
          >
            <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
            DISARM — Stop Autonomous
          </Button>
        )}

        {/* Link to full settings */}
        <Link
          href="/settings"
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors w-fit"
        >
          <ExternalLink className="w-3 h-3" />
          Full executor config in Settings
        </Link>
      </div>

      {/* ARM dialog */}
      <Dialog open={armDialog} onOpenChange={o => { if (!o) { setArmDialog(false); setActionError(''); } }}>
        <DialogContent className="border-cyan-500/30">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-cyan-400">
              <Zap className="w-5 h-5" /> ARM Autonomous Trading
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm pt-2">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    <li>The Executor will operate <strong>24/7</strong>, including while you sleep.</li>
                    <li>If configured for <strong>live trading</strong>, real GMX V2 orders will be placed on Arbitrum One.</li>
                    <li>Risk controls (daily loss, drawdown, consecutive losses) remain active.</li>
                    <li><strong>Live trading requires GMX_SIGNER_KEY to be configured.</strong></li>
                  </ul>
                </div>
                {actionError && <div className="text-[var(--color-short)] text-xs">{actionError}</div>}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setArmDialog(false); setActionError(''); }}>Cancel</Button>
            <Button onClick={handleArm} disabled={actionLoading}
              className="font-bold tracking-wider"
              style={{ background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)', color: '#000' }}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
              Confirm — ARM
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DISARM dialog */}
      <Dialog open={disarmDialog} onOpenChange={o => { if (!o) { setDisarmDialog(false); setActionError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff className="w-5 h-5" /> Disarm Autonomous Trading
            </DialogTitle>
            <DialogDescription className="text-sm pt-2">
              The Executor will stop opening new autonomous positions. Existing positions continue
              with their TP/SL orders active until manually closed or triggered.
              {actionError && <div className="text-[var(--color-short)] mt-2">{actionError}</div>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDisarmDialog(false); setActionError(''); }}>Cancel</Button>
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
