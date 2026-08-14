import { useState } from 'react';
import { useAppContext, useAuthContext, useTradingContext, useVpsContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ShieldAlert, Server, Lock, AlertTriangle, AlertOctagon, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function Settings() {
  const { engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency } = useAppContext();
  const { logout } = useAuthContext();
  const { clearAllPositions, positions } = useTradingContext();
  const { config, status, errorMsg, latencyMs, saveConfig, testConnection, disconnect } = useVpsContext();

  const [closeAllPhase, setCloseAllPhase] = useState<0 | 1 | 2>(0);
  const [testing, setTesting] = useState(false);

  // Local VPS form state
  const [vpsHost, setVpsHost] = useState(config.host);
  const [vpsPort, setVpsPort] = useState(config.port);
  const [vpsKeyName, setVpsKeyName] = useState(config.apiKeyName);
  const [vpsSSL, setVpsSSL] = useState(config.useSSL);
  const [vpsFormDirty, setVpsFormDirty] = useState(false);

  const isEmergency = engineState === 'EMERGENCY_STOP';

  const handleVpsTest = async () => {
    saveConfig({ host: vpsHost, port: vpsPort, apiKeyName: vpsKeyName, useSSL: vpsSSL });
    setVpsFormDirty(false);
    setTesting(true);
    await testConnection();
    setTesting(false);
  };

  const StatusDot = () => {
    const colors: Record<string, string> = {
      connected: 'bg-[var(--color-long)] shadow-[0_0_8px_rgba(0,200,83,0.5)]',
      connecting: 'bg-[var(--color-warning)] animate-pulse',
      error: 'bg-[var(--color-short)]',
      disconnected: 'bg-muted-foreground',
    };
    return <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', colors[status] ?? 'bg-muted-foreground')} />;
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

      {/* ── Engine Mode ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Server className="w-5 h-5 text-primary" /> Engine Mode
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-5 bg-card/50">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium">Trading Mode</div>
            <div className="flex items-center gap-3">
              <div className={cn('w-3 h-3 rounded-full', engineState === 'PAPER_TRADING' ? 'bg-accent shadow-[0_0_10px_rgba(240,185,11,0.5)]' : 'bg-muted')} />
              <span className="font-bold">{isEmergency ? 'EMERGENCY STOP' : 'PAPER TRADING'}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {isEmergency ? 'All trading halted. Reset to resume.' : 'Mock execution only — no real orders placed.'}
            </p>
          </Card>
          <Card className="p-5 bg-card/50 opacity-60">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium flex justify-between">
              Live Execution VPS <Lock className="w-4 h-4" />
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-muted" />
              <span className="font-bold text-muted-foreground">OFFLINE</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Connect to VPS below to unlock live trading.</p>
          </Card>
        </div>
      </section>

      {/* ── VPS Configuration ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Server className="w-5 h-5 text-primary" /> VPS Execution Service
        </h2>

        {/* Status bar */}
        <div className={cn('flex items-center gap-3 px-4 py-3 rounded-lg border text-sm', {
          'border-[var(--color-long)]/30 bg-[var(--color-long)]/5': status === 'connected',
          'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5': status === 'connecting',
          'border-destructive/30 bg-destructive/5': status === 'error',
          'border-border bg-card/50': status === 'disconnected',
        })}>
          <StatusDot />
          <span className="font-semibold uppercase tracking-wider text-xs">
            {status === 'connected' ? `Connected` : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Connection Failed' : 'Disconnected'}
          </span>
          {status === 'connected' && latencyMs && (
            <span className="text-muted-foreground text-xs ml-1">· {latencyMs}ms</span>
          )}
          {errorMsg && <span className="text-destructive text-xs ml-2">{errorMsg}</span>}
          {status === 'connected' && (
            <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>

        <Card className="p-5 flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertOctagon className="w-3.5 h-3.5 text-[var(--color-warning)]" />
            API keys and credentials are configured on the VPS — never entered here. This UI stores only connection metadata.
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

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">API Key Name / Label</label>
            <Input
              value={vpsKeyName}
              onChange={e => { setVpsKeyName(e.target.value); setVpsFormDirty(true); }}
              placeholder="e.g. futures-bot-key (label only, never the actual key)"
              className="font-mono text-sm"
            />
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={vpsSSL} onCheckedChange={v => { setVpsSSL(v); setVpsFormDirty(true); }} />
            <span className="text-sm text-foreground">Use SSL / TLS</span>
            <span className="text-xs text-muted-foreground">Recommended for production</span>
          </div>

          <div className="flex gap-3 pt-1">
            {vpsFormDirty && (
              <Button variant="outline" size="sm" onClick={() => {
                saveConfig({ host: vpsHost, port: vpsPort, apiKeyName: vpsKeyName, useSSL: vpsSSL });
                setVpsFormDirty(false);
              }}>
                Save
              </Button>
            )}
            <Button
              size="sm"
              variant={status === 'connected' ? 'outline' : 'default'}
              onClick={handleVpsTest}
              disabled={testing || !vpsHost.trim()}
              className="flex items-center gap-2"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : status === 'connected' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {testing ? 'Testing…' : status === 'connected' ? 'Re-test' : 'Test Connection'}
            </Button>
          </div>
        </Card>
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
