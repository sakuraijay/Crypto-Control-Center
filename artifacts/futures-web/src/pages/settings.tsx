import { useState, useEffect } from 'react';
import { useAppContext, useAuthContext, useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ShieldAlert, Server, Lock, AlertTriangle, AlertOctagon, Info, CheckCircle2, XCircle, Cpu, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Executor status hook (fetches /api/executor/status directly) ───────────────

interface ExecutorHealth {
  gmxConnected: boolean;
  rpcUrl?: string;
  networkChainId?: number;
  deploymentMode?: 'reserved_vm' | 'development';
  uptimeSeconds?: number;
}

function useExecutorHealth() {
  const [health, setHealth] = useState<ExecutorHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api-server/api/executor/status');
      if (res.ok) setHealth(await res.json());
    } catch { /* non-fatal */ }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  return { health, loading, refresh };
}

// ── Main settings page ─────────────────────────────────────────────────────────

export default function Settings() {
  const { engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency } = useAppContext();
  const { logout } = useAuthContext();
  const { clearAllPositions, positions } = useTradingContext();
  const { health, loading: healthLoading, refresh: refreshHealth } = useExecutorHealth();

  const [closeAllPhase, setCloseAllPhase] = useState<0 | 1 | 2>(0);

  const isEmergency = engineState === 'EMERGENCY_STOP';

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

      {/* ── 아키텍처 안내 ── */}
      <div className="flex flex-col gap-2 px-4 py-3 rounded-lg border border-primary/20 bg-primary/5 text-xs">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
          <div className="leading-relaxed text-foreground/90">
            <strong className="text-foreground">Replit = AI 의사결정 · 오퍼레이터 승인 게이트 · 리스크 모니터링</strong>
            {' '}— 이 플랫폼에서 가격 수집, AI 사이클, LIVE 주문 승인 검토, 리스크 제어를 모두 처리합니다.
            실제 GMX 주문 서명 및 온체인 전송은 GMX One-Click 서브계정 설정을 완료한 후 진행됩니다.
          </div>
        </div>
        <div className="flex items-start gap-2 pl-6 text-muted-foreground">
          <span className="text-[var(--color-short)] font-bold shrink-0">❌</span>
          <span>GMX 개인키·시드문구·서브계정 signer key를 절대 여기에 저장하지 마세요.</span>
        </div>
        <div className="flex items-start gap-2 pl-6 text-muted-foreground">
          <span className="text-[var(--color-long)] font-bold shrink-0">✅</span>
          <span>GMX_WALLET_ADDRESS, GMX_SUBACCOUNT_ADDRESS (공개 주소만) — 상태 표시 전용으로만 저장 가능.</span>
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
              Live Execution <Lock className="w-4 h-4" />
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

      {/* ── System Status ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Cpu className="w-5 h-5 text-primary" /> System Status
        </h2>
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Execution Engine</span>
            <Button size="sm" variant="ghost" onClick={refreshHealth} disabled={healthLoading} className="h-7 text-xs">
              {healthLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : '↻ Refresh'}
            </Button>
          </div>
          {health ? (
            <div className="flex flex-wrap gap-2">
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                health.gmxConnected
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {health.gmxConnected ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                GMX RPC {health.gmxConnected ? '연결됨' : '연결 없음'}
              </div>
              {health.deploymentMode && (
                <div className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                  health.deploymentMode === 'reserved_vm'
                    ? 'border-primary/30 bg-primary/5 text-primary'
                    : 'border-border bg-card/50 text-muted-foreground',
                )}>
                  <Server className="w-3.5 h-3.5" />
                  {health.deploymentMode === 'reserved_vm' ? 'Reserved VM (always-on)' : 'Development (may sleep)'}
                </div>
              )}
              {health.networkChainId && (
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/50 text-muted-foreground text-[11px] font-medium">
                  Chain {health.networkChainId}
                </div>
              )}
            </div>
          ) : healthLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 상태 로딩 중…
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Executor status unavailable</div>
          )}
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

        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs text-amber-300/80">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
          <span>
            Emergency Stop halts the AI engine on this device immediately. Any in-progress paper orders are cancelled.
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
