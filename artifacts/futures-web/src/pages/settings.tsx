import { useState } from 'react';
import { useAppContext, useAuthContext, useTradingContext, useVpsContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  ShieldAlert, Server, Lock, AlertTriangle, AlertOctagon,
  Wifi, WifiOff, Loader2, Info, CheckCircle2, XCircle,
  Globe, Cpu, ChevronDown, ChevronUp,
} from 'lucide-react';
import { VpsStatusPanel } from '@/components/vps/VpsStatusPanel';
import { cn } from '@/lib/utils';

export default function Settings() {
  const { engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency } = useAppContext();
  const { logout } = useAuthContext();
  const { clearAllPositions, positions } = useTradingContext();
  const {
    config, connectionStatus, connectionError, health, saveConfig, testConnection, disconnect,
    executorMode, setExecutorMode,
    internalReady, internalSignerConfigured, internalDeploymentMode,
  } = useVpsContext();

  const [closeAllPhase, setCloseAllPhase] = useState<0 | 1 | 2>(0);
  const [testing, setTesting] = useState(false);
  const [showAdvancedVps, setShowAdvancedVps] = useState(executorMode === 'external');

  // Local VPS form state (external mode)
  const [vpsHost, setVpsHost] = useState(config.host);
  const [vpsPort, setVpsPort] = useState(config.port);
  const [vpsSSL, setVpsSSL] = useState(config.useSSL);
  const [vpsFormDirty, setVpsFormDirty] = useState(false);

  const isEmergency = engineState === 'EMERGENCY_STOP';

  const handleVpsTest = async () => {
    saveConfig({ host: vpsHost, port: vpsPort, useSSL: vpsSSL, executorMode });
    setVpsFormDirty(false);
    setTesting(true);
    await testConnection();
    setTesting(false);
  };

  const StatusDot = () => {
    const colors: Record<string, string> = {
      connected:    'bg-[var(--color-long)] shadow-[0_0_8px_rgba(0,200,83,0.5)]',
      connecting:   'bg-[var(--color-warning)] animate-pulse',
      error:        'bg-[var(--color-short)]',
      disconnected: 'bg-muted-foreground',
    };
    return <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', colors[connectionStatus] ?? 'bg-muted-foreground')} />;
  };

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-8 max-w-4xl">

      {/* Emergency banner */}
      {isEmergency && (
        <div className="flex items-center gap-3 p-4 rounded-lg border border-destructive bg-destructive/10">
          <AlertOctagon className="w-5 h-5 text-destructive shrink-0" />
          <span className="text-destructive font-semibold text-sm flex-1">
            EMERGENCY STOP ACTIVE — All trading is halted.
          </span>
          <Button size="sm" variant="outline"
            className="border-[var(--color-warning)] text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10"
            onClick={resetFromEmergency}>
            Reset to Paper Trading
          </Button>
        </div>
      )}

      {/* ── 아키텍처 원칙 안내 ── */}
      <div className="flex flex-col gap-2 px-4 py-3 rounded-lg border border-primary/20 bg-primary/5 text-xs">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
          <div className="leading-relaxed text-foreground/90">
            <strong className="text-foreground">Replit = 모니터링·승인·제어 클라이언트</strong>
            {' '}— 가격 수집, AI 의사결정, 오퍼레이터 승인 게이트, 리스크 모니터링을 담당합니다.
            실제 GMX 주문 서명 및 온체인 전송은 외부 24/7 VPS에서만 수행합니다.
          </div>
        </div>
        <div className="flex items-start gap-2 pl-6 text-muted-foreground">
          <span className="text-[var(--color-short)] font-bold shrink-0">❌</span>
          <span>Replit Secrets에 GMX 개인키·시드문구·서브계정 signer key를 절대 저장하지 마세요.</span>
        </div>
        <div className="flex items-start gap-2 pl-6 text-muted-foreground">
          <span className="text-[var(--color-long)] font-bold shrink-0">✅</span>
          <span>GMX_WALLET_ADDRESS, GMX_SUBACCOUNT_ADDRESS (공개 주소만) — 상태 표시 전용으로 저장 가능.</span>
        </div>
        <div className="flex items-start gap-2 pl-6 text-muted-foreground">
          <span className="text-[var(--color-long)] font-bold shrink-0">✅</span>
          <span>GMX_RPC_URL — RPC 헬스 모니터링 전용. 외부 VPS Settings에서 호스트를 설정하면 LIVE 주문이 VPS로 전달됩니다.</span>
        </div>
      </div>

      {/* ── Engine Mode ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Server className="w-5 h-5 text-primary" /> Engine Mode
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-5 bg-card/50">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium">Local Mode</div>
            <div className="flex items-center gap-3">
              <div className={cn('w-3 h-3 rounded-full', engineState === 'PAPER_TRADING' ? 'bg-accent shadow-[0_0_10px_rgba(240,185,11,0.5)]' : 'bg-muted')} />
              <span className="font-bold">{isEmergency ? 'EMERGENCY STOP' : 'PAPER TRADING'}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {isEmergency ? 'All trading halted. Reset to resume.' : 'Mock execution only — no real orders placed.'}
            </p>
          </Card>
          <Card className="p-5 bg-card/50">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium flex justify-between">
              Live Execution (Executor) <Lock className="w-4 h-4" />
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-muted" />
              <span className="font-bold text-muted-foreground">APPROVAL REQUIRED</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Live orders require operator approval (LIVE mode) and a configured GMX One-Click subaccount.
            </p>
          </Card>
        </div>
      </section>

      {/* ── Executor Mode Selector ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-base">
          <Cpu className="w-4 h-4 text-primary" /> Execution Target
        </h2>

        {/* Mode toggle */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => { setExecutorMode('internal'); setShowAdvancedVps(false); }}
            className={cn(
              'flex flex-col items-start gap-1.5 p-4 rounded-lg border text-left transition-all',
              executorMode === 'internal'
                ? 'border-primary/50 bg-primary/5'
                : 'border-border bg-card/30 opacity-60 hover:opacity-80',
            )}
          >
            <div className="flex items-center gap-2">
              <Cpu className={cn('w-4 h-4', executorMode === 'internal' ? 'text-primary' : 'text-muted-foreground')} />
              <span className="text-sm font-bold">Replit 모니터</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-semibold">기본값</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Replit이 AI 의사결정·승인 게이트·리스크 모니터를 담당합니다.
              실제 GMX 실행은 외부 VPS에서 수행됩니다.
            </p>
          </button>

          <button
            onClick={() => { setExecutorMode('external'); setShowAdvancedVps(true); }}
            className={cn(
              'flex flex-col items-start gap-1.5 p-4 rounded-lg border text-left transition-all',
              executorMode === 'external'
                ? 'border-amber-500/50 bg-amber-500/5'
                : 'border-border bg-card/30 opacity-60 hover:opacity-80',
            )}
          >
            <div className="flex items-center gap-2">
              <Globe className={cn('w-4 h-4', executorMode === 'external' ? 'text-amber-400' : 'text-muted-foreground')} />
              <span className="text-sm font-bold">External VPS</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-border text-muted-foreground font-semibold">ADVANCED</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              User-managed server holds the GMX subaccount key. Requires host/port configuration.
            </p>
          </button>
        </div>

        {/* Internal executor readiness badges */}
        {executorMode === 'internal' && (
          <div className="flex flex-wrap gap-2">
            <div className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
              connectionStatus === 'connected'
                ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                : connectionStatus === 'error'
                  ? 'border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)]'
                  : 'border-border bg-card/50 text-muted-foreground',
            )}>
              {connectionStatus === 'connected'
                ? <CheckCircle2 className="w-3.5 h-3.5" />
                : connectionStatus === 'error'
                  ? <XCircle className="w-3.5 h-3.5" />
                  : <Loader2 className="w-3.5 h-3.5 animate-spin" />
              }
              Executor {connectionStatus === 'connected' ? 'Online' : connectionStatus === 'error' ? 'Unreachable' : 'Connecting'}
            </div>

            {/* 모니터 역할 명시 — Signer 배지 없음 (Replit은 키 미보관) */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/30 bg-primary/5 text-primary text-[11px] font-medium">
              <Cpu className="w-3.5 h-3.5" />
              모니터링 전용 — 실행은 외부 VPS 담당
            </div>

            <div className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
              health.gmxConnected
                ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                : 'border-border bg-card/50 text-muted-foreground',
            )}>
              {health.gmxConnected
                ? <CheckCircle2 className="w-3.5 h-3.5" />
                : <XCircle className="w-3.5 h-3.5" />
              }
              GMX RPC {health.gmxConnected ? '연결됨' : '연결 없음'}
            </div>

            {internalDeploymentMode && (
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                internalDeploymentMode === 'reserved_vm'
                  ? 'border-primary/30 bg-primary/5 text-primary'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                <Server className="w-3.5 h-3.5" />
                {internalDeploymentMode === 'reserved_vm' ? 'Reserved VM (always-on)' : 'Development (may sleep)'}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Execution Engine Status Panel ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Server className="w-5 h-5 text-primary" /> Execution Engine Status
        </h2>
        <VpsStatusPanel showConfigLink={false} />
      </section>

      {/* ── External VPS Connection Settings (Advanced) ── */}
      <section className="flex flex-col gap-2">
        <button
          onClick={() => setShowAdvancedVps(v => !v)}
          className="flex items-center gap-2 w-full text-left py-2 border-b border-border group"
        >
          <Globe className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          <span className="font-semibold text-base text-muted-foreground group-hover:text-foreground transition-colors">
            External VPS Settings
            <span className="ml-2 text-xs font-normal">(Advanced — optional)</span>
          </span>
          {showAdvancedVps
            ? <ChevronUp className="w-4 h-4 ml-auto text-muted-foreground" />
            : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />
          }
        </button>

        {showAdvancedVps && (
          <div className="flex flex-col gap-4 pt-2 pl-1">
            {executorMode === 'external' && (
              /* Status bar — only shown when external mode active */
              <div className={cn('flex items-center gap-3 px-4 py-3 rounded-lg border text-sm', {
                'border-[var(--color-long)]/30 bg-[var(--color-long)]/5': connectionStatus === 'connected',
                'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5': connectionStatus === 'connecting',
                'border-destructive/30 bg-destructive/5': connectionStatus === 'error',
                'border-border bg-card/50': connectionStatus === 'disconnected',
              })}>
                <StatusDot />
                <span className="font-semibold uppercase tracking-wider text-xs">
                  {connectionStatus === 'connected' ? 'Connected' :
                   connectionStatus === 'connecting' ? 'Connecting…' :
                   connectionStatus === 'error' ? 'Connection Failed' : 'Disconnected'}
                </span>
                {connectionStatus === 'connected' && health.heartbeatLatencyMs != null && (
                  <span className="text-muted-foreground text-xs ml-1">· {health.heartbeatLatencyMs}ms</span>
                )}
                {connectionError && <span className="text-destructive text-xs ml-2">{connectionError}</span>}
                {connectionStatus === 'connected' && (
                  <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={disconnect}>
                    Disconnect
                  </Button>
                )}
              </div>
            )}

            <Card className="p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlertOctagon className="w-3.5 h-3.5 text-[var(--color-warning)]" />
                API keys and credentials are configured on the VPS — never entered here. This stores only connection metadata.
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Host / IP Address</label>
                  <Input
                    value={vpsHost}
                    onChange={e => { setVpsHost(e.target.value); setVpsFormDirty(true); }}
                    placeholder="e.g. 192.168.1.100 or my-vps.example.com"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Port</label>
                  <Input
                    value={vpsPort}
                    onChange={e => { setVpsPort(e.target.value); setVpsFormDirty(true); }}
                    placeholder="8080"
                    className="font-mono text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Switch checked={vpsSSL} onCheckedChange={v => { setVpsSSL(v); setVpsFormDirty(true); }} />
                <span className="text-sm text-foreground">Use SSL / TLS</span>
                <span className="text-xs text-muted-foreground">Recommended for production</span>
              </div>

              <div className="flex gap-3 pt-1">
                {vpsFormDirty && (
                  <Button variant="outline" size="sm" onClick={() => {
                    saveConfig({ host: vpsHost, port: vpsPort, useSSL: vpsSSL, executorMode });
                    setVpsFormDirty(false);
                  }}>
                    Save
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={connectionStatus === 'connected' ? 'outline' : 'default'}
                  onClick={handleVpsTest}
                  disabled={testing || !vpsHost.trim()}
                  className="flex items-center gap-2"
                >
                  {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : connectionStatus === 'connected' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                  {testing ? 'Testing…' : connectionStatus === 'connected' ? 'Re-test' : 'Test Connection'}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </section>

      {/* ── Emergency Controls ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg text-destructive">
          <ShieldAlert className="w-5 h-5" /> Emergency Controls
        </h2>
        <Card className="p-0 overflow-hidden divide-y divide-border border-destructive/20">
          <div className="p-5 flex items-center justify-between">
            <div>
              <div className="font-bold text-sm mb-1">Stop New Orders</div>
              <div className="text-xs text-muted-foreground">Prevents the engine from opening new positions.</div>
            </div>
            <Switch checked={stopNewOrders} onCheckedChange={toggleStopNewOrders} className="scale-110" />
          </div>

          <div className="p-5 flex items-center justify-between bg-destructive/5">
            <div>
              <div className="font-bold text-sm mb-1 text-destructive">Close All Positions</div>
              <div className="text-xs text-muted-foreground">
                Market close <strong className="text-foreground">{positions.length}</strong> positions at current price.
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setCloseAllPhase(1)} disabled={positions.length === 0}>
              Close All at Market
            </Button>
          </div>

          <div className="p-5 flex items-center justify-between bg-destructive/10">
            <div>
              <div className="font-bold text-sm mb-1 text-destructive flex items-center gap-1.5">
                <AlertOctagon className="w-4 h-4" /> TRIGGER EMERGENCY STOP
              </div>
              <div className="text-xs text-muted-foreground">Halts engine, blocks orders, locks terminal until reset.</div>
            </div>
            {isEmergency ? (
              <Button variant="outline" size="sm"
                className="border-[var(--color-warning)] text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10"
                onClick={resetFromEmergency}>
                Reset Engine
              </Button>
            ) : (
              <Button variant="destructive" size="sm" className="font-bold tracking-widest" onClick={triggerEmergencyStop}>
                EMERGENCY STOP
              </Button>
            )}
          </div>
        </Card>

        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs text-amber-300/80">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
          <span>
            Emergency Stop applies to this app's local engine only. If the Executor is armed for unattended trading,
            use the Disarm button in the Execution Engine Status panel above to stop autonomous activity.
          </span>
        </div>
      </section>

      {/* ── Lock ── */}
      <Button variant="outline" className="w-full h-12 text-base font-bold text-muted-foreground border-dashed hover:text-foreground hover:bg-muted/50" onClick={logout}>
        <Lock className="w-4 h-4 mr-2" /> Lock Terminal
      </Button>

      {/* Double-confirm: Close All */}
      <Dialog open={closeAllPhase > 0} onOpenChange={open => !open && setCloseAllPhase(0)}>
        <DialogContent className={closeAllPhase === 2 ? 'border-destructive border-2' : 'border-border'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {closeAllPhase === 1 ? 'Confirm Close All' : 'FINAL WARNING'}
            </DialogTitle>
            <DialogDescription className="text-sm pt-2">
              {closeAllPhase === 1
                ? `Close all ${positions.length} open positions at market price?`
                : <strong className="text-foreground">This cannot be undone. All positions will be liquidated immediately.</strong>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseAllPhase(0)}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              if (closeAllPhase === 1) { setCloseAllPhase(2); }
              else { clearAllPositions(); setCloseAllPhase(0); }
            }}>
              {closeAllPhase === 1 ? 'Yes, Close All' : 'EXECUTE CLOSE ALL'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
