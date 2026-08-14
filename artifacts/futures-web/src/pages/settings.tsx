import { useState } from 'react';
import { useAppContext, useAuthContext, useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ShieldAlert, Server, Lock, AlertTriangle, AlertOctagon } from 'lucide-react';

export default function Settings() {
  const { engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop } = useAppContext();
  const { logout } = useAuthContext();
  const { clearAllPositions, positions } = useTradingContext();

  const [closeAllPhase, setCloseAllPhase] = useState<0 | 1 | 2>(0);

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-8 max-w-4xl">
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Server className="w-5 h-5 text-primary" /> Engine Mode & Connection
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-6 bg-card/50">
            <div className="text-sm text-muted-foreground uppercase tracking-wider mb-2 font-medium">Trading Mode</div>
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full \${engineState === 'PAPER_TRADING' ? 'bg-accent shadow-[0_0_10px_rgba(240,185,11,0.5)]' : 'bg-muted'}`} />
              <span className="font-bold text-lg">PAPER TRADING</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Mock execution using live Binance Futures websockets.</p>
          </Card>
          
          <Card className="p-6 bg-card/50 opacity-60">
            <div className="text-sm text-muted-foreground uppercase tracking-wider mb-2 font-medium flex justify-between">
              Live Execution VPS
              <Lock className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-muted" />
              <span className="font-bold text-lg text-muted-foreground">OFFLINE</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Connect to a private VPS required for live trading.</p>
          </Card>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg text-destructive">
          <ShieldAlert className="w-5 h-5" /> Emergency Controls
        </h2>
        <Card className="p-0 overflow-hidden divide-y divide-border border-destructive/20">
          <div className="p-6 flex items-center justify-between">
            <div>
              <div className="font-bold text-base mb-1">Stop New Orders</div>
              <div className="text-sm text-muted-foreground">Prevents strategy from opening new positions. Open positions are unaffected.</div>
            </div>
            <Switch checked={stopNewOrders} onCheckedChange={toggleStopNewOrders} className="scale-125" />
          </div>

          <div className="p-6 flex items-center justify-between bg-destructive/5">
            <div>
              <div className="font-bold text-base mb-1 text-destructive flex items-center gap-2">
                Close All Positions
              </div>
              <div className="text-sm text-muted-foreground">Market close all <strong className="text-foreground">{positions.length}</strong> currently open positions immediately.</div>
            </div>
            <Button 
              variant="destructive" 
              onClick={() => setCloseAllPhase(1)}
              disabled={positions.length === 0}
            >
              Close All at Market
            </Button>
          </div>

          <div className="p-6 flex items-center justify-between bg-destructive/10">
            <div>
              <div className="font-bold text-base mb-1 text-destructive flex items-center gap-2">
                <AlertOctagon className="w-5 h-5" /> TRIGGER EMERGENCY STOP
              </div>
              <div className="text-sm text-muted-foreground">Halts engine, blocks all orders, locks terminal. Requires manual reset.</div>
            </div>
            <Button variant="destructive" className="font-bold tracking-widest" onClick={triggerEmergencyStop}>
              EMERGENCY STOP
            </Button>
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-4 mt-8">
        <Button variant="outline" className="w-full h-14 text-lg font-bold text-muted-foreground border-dashed hover:text-foreground hover:bg-muted/50" onClick={logout}>
          <Lock className="w-5 h-5 mr-2" /> Lock Terminal
        </Button>
      </section>

      {/* Double Confirm Dialog */}
      <Dialog open={closeAllPhase > 0} onOpenChange={(open) => !open && setCloseAllPhase(0)}>
        <DialogContent className={closeAllPhase === 2 ? "border-destructive border-2" : "border-border"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-6 h-6" /> 
              {closeAllPhase === 1 ? "Confirm Close All" : "FINAL WARNING: Close All Positions"}
            </DialogTitle>
            <DialogDescription className="text-base pt-4">
              {closeAllPhase === 1 ? (
                <>You are about to market close all <strong>{positions.length}</strong> open positions. Are you sure you want to proceed?</>
              ) : (
                <strong className="text-foreground">This action cannot be undone. All active positions will be liquidated at current market price immediately. Execute?</strong>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setCloseAllPhase(0)}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              if (closeAllPhase === 1) {
                setCloseAllPhase(2);
              } else {
                clearAllPositions();
                setCloseAllPhase(0);
              }
            }}>
              {closeAllPhase === 1 ? "Yes, Close All" : "EXECUTE CLOSE ALL"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
