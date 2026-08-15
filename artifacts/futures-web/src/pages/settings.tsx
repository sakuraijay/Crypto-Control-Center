import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppContext, useAuthContext, useTradingContext, useWallet } from '@/lib/context';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { useStrategyContext } from '@/lib/context/StrategyContext';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  ShieldAlert, Server, Lock, AlertTriangle, AlertOctagon, Info,
  CheckCircle2, XCircle, Cpu, Loader2, Wallet, Key, FlaskConical,
  ChevronRight, AlertCircle, RefreshCw, Bell, BellOff, ExternalLink,
  WifiOff, Send, Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
// sendTestNotification is handled by AiEngineContext to keep permission state in sync.

// ── Executor status hook (fetches /api/executor/status with 30s auto-refresh) ──

interface WorkerCycleResult {
  cycleNumber: number;
  at: string;
  operatingState: string;
  primarySymbol: string | null;
  confidence: number;
  analysesCount: number;
  approvalCreated: boolean;
  error?: string;
}

interface RiskLimitsSnapshot {
  tradingCapital?: number;
  maxDrawdownPercent?: number;
  weeklyLossLimitUSDT?: number;
  rolling24hLossLimitUSDT?: number;
  maxTradesPerHour?: number;
  cooldownMinutes?: number;
  maxLeverage?: number;
  dailyLossLimitUSDT?: number;
  [key: string]: number | undefined;
}

interface ExecutorHealth {
  gmxConnected: boolean;
  rpcUrl?: string;
  networkChainId?: number;
  deploymentMode?: 'reserved_vm' | 'development';
  uptimeSeconds?: number;
  // AI Worker cycle fields
  workerRunning?: boolean;
  cycleCount?: number;
  lastCycleAt?: string | null;
  lastCycleResult?: WorkerCycleResult | null;
  equityHwm?: number | null;
  lastLimitsUsed?: RiskLimitsSnapshot | null;
}

const AUTO_REFRESH_MS = 30_000;
const OFFLINE_THRESHOLD = 2; // consecutive failures before offline banner

function useExecutorHealth() {
  const [health, setHealth]                     = useState<ExecutorHealth | null>(null);
  const [loading, setLoading]                   = useState(true);
  const [lastSuccessAt, setLastSuccessAt]       = useState<Date | null>(null);
  const [consecutiveFailures, setConsecFails]   = useState(0);
  const timerRef                                = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/executor/status');
      if (res.ok) {
        const data = await res.json() as ExecutorHealth;
        setHealth(data);
        setLastSuccessAt(new Date());
        setConsecFails(0);
      } else {
        setConsecFails(c => c + 1);
      }
    } catch {
      setConsecFails(c => c + 1);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => { void refresh(); }, AUTO_REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  return { health, loading, refresh, lastSuccessAt, consecutiveFailures };
}

// ── useNow — 1-second ticker for elapsed-time display ─────────────────────────

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ── Elapsed seconds pretty-printer ───────────────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
}

// ── Main settings page ────────────────────────────────────────────────────────

export default function Settings() {
  const { engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency } = useAppContext();
  const { logout } = useAuthContext();
  const { clearAllPositions, positions, closedTrades, consecutiveLosses } = useTradingContext();
  const { health, loading: healthLoading, refresh: refreshHealth, lastSuccessAt, consecutiveFailures } = useExecutorHealth();
  const wallet = useWallet();
  const { notificationPermission, requestNotificationPermission, sendTestNotification, weeklyRealizedPnl } = useAiEngine();
  const now = useNow();

  const { subaccountConfig, updateSubaccountConfig, limits } = useStrategyContext();

  const [closeAllPhase, setCloseAllPhase] = useState<0 | 1 | 2>(0);
  const [testNotifState, setTestNotifState] = useState<'idle' | 'sending' | 'sent' | 'denied' | 'unsupported'>('idle');
  const [switchingNet, setSwitchingNet] = useState(false);
  const [subDraftMaxActions, setSubDraftMaxActions] = useState(subaccountConfig.maxActions);
  const [subDraftExpiresIn, setSubDraftExpiresIn]   = useState(subaccountConfig.expiresInDays);
  const [subSaved, setSubSaved] = useState(false);

  const isEmergency = engineState === 'EMERGENCY_STOP';
  const isOffline   = consecutiveFailures >= OFFLINE_THRESHOLD;
  const isStale     = consecutiveFailures >= 1 && consecutiveFailures < OFFLINE_THRESHOLD;

  // ── PAPER 리스크 지표 (브라우저 상태 기준) ─────────────────────────────────
  const dailyPnl = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return closedTrades
      .filter(t => new Date(t.timestamp) >= todayStart)
      .reduce((s, t) => s + (t.pnl ?? 0), 0);
  }, [closedTrades]);

  const rolling24hPnl = useMemo(() => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return closedTrades
      .filter(t => new Date(t.timestamp).getTime() >= since)
      .reduce((s, t) => s + (t.pnl ?? 0), 0);
  }, [closedTrades]);

  const totalExposure = useMemo(
    () => positions.reduce((s, p) => s + (p.sizeInUsd ?? 0), 0),
    [positions],
  );

  /** Attempt wallet_switchEthereumChain → Arbitrum One (0xa4b1 = 42161) */
  const handleSwitchToArbitrum = async () => {
    const eth = (window as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) return;
    setSwitchingNet(true);
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xa4b1' }],
      });
    } catch (e) {
      // 4902 = chain not yet added — prompt to add
      if ((e as { code?: number }).code === 4902) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xa4b1',
              chainName: 'Arbitrum One',
              nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://arb1.arbitrum.io/rpc'],
              blockExplorerUrls: ['https://arbiscan.io'],
            }],
          });
        } catch { /* user rejected */ }
      }
    } finally {
      setSwitchingNet(false);
      // 체인 상태 즉시 재확인 — chainChanged 이벤트 지연으로 wrong_network 배지가 고착되는 문제 방지
      await wallet.refreshChainStatus();
    }
  };

  const handleSaveSubaccountConfig = () => {
    updateSubaccountConfig({
      maxActions:    subDraftMaxActions,
      expiresInDays: subDraftExpiresIn,
      status:        'ready',
    });
    setSubSaved(true);
    setTimeout(() => setSubSaved(false), 3_000);
  };

  const handleTestNotif = async () => {
    setTestNotifState('sending');
    const result = await sendTestNotification();
    setTestNotifState(result);
    // Reset badge after 4 s
    setTimeout(() => setTestNotifState('idle'), 4_000);
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

      {/* ── GMX 계정 연결 준비 단계 ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Wallet className="w-5 h-5 text-primary" /> GMX 계정 연결 준비
        </h2>
        <p className="text-xs text-muted-foreground -mt-2">
          실제 GMX 계정 조회 및 자동매매를 위해서는 아래 4단계를 순서대로 완료해야 합니다.
          현재는{' '}
          <strong className="text-foreground">
            {wallet.status === 'connected' && wallet.isArbitrum ? '2단계 완료' : '1단계만 완료'}
          </strong>된 상태입니다.
          메인 지갑 개인키·시드문구는 절대 서버에 입력하지 마세요.
        </p>

        <div className="flex flex-col gap-3">

          {/* Step 1 — RPC (완료) */}
          <div className="flex items-start gap-4 p-4 rounded-lg border border-[var(--color-long)]/30 bg-[var(--color-long)]/5">
            <div className="flex items-center justify-center w-7 h-7 rounded-full border-2 border-[var(--color-long)] text-[var(--color-long)] font-bold text-xs shrink-0 mt-0.5">
              ✓
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-sm text-[var(--color-long)]">1단계 — Arbitrum RPC 연결 (완료)</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30 font-bold">ACTIVE</span>
              </div>
              <p className="text-xs text-muted-foreground">
                GMX 공개 시장 데이터, 실시간 가격, 24h 변동률을 수신 중입니다.
                <strong className="text-foreground"> 계정 인증 없이 사용 가능한 공개 데이터입니다.</strong>
              </p>
            </div>
          </div>

          {/* Step 2 — 브라우저 지갑 */}
          {(() => {
            const isConnected  = wallet.status === 'connected' && wallet.isArbitrum;
            const isWrongNet   = wallet.status === 'wrong_network';
            const isConnecting = wallet.status === 'connecting';
            const hasProvider  = wallet.status !== 'no_provider';

            /** 4-sub-state index: 0=no wallet, 1=detected·unconnected, 2=wrong network, 3=connected+arbitrum */
            const subState =
              isConnected ? 3 :
              isWrongNet  ? 2 :
              hasProvider ? 1 : 0;

            const borderColor = isConnected
              ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5'
              : isWrongNet
                ? 'border-amber-500/30 bg-amber-500/5'
                : 'border-border bg-card/30';
            const circleColor = isConnected
              ? 'border-[var(--color-long)] text-[var(--color-long)]'
              : 'border-border text-muted-foreground';

            const subLabels = ['지갑 없음', '감지됨·미연결', 'Wrong network', 'Arbitrum ✓'] as const;

            return (
              <div className={cn('flex items-start gap-4 p-4 rounded-lg border', borderColor)}>
                <div className={cn('flex items-center justify-center w-7 h-7 rounded-full border-2 font-bold text-xs shrink-0 mt-0.5', circleColor)}>
                  {isConnected ? '✓' : '2'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={cn('font-semibold text-sm', isConnected && 'text-[var(--color-long)]')}>
                      브라우저 지갑 연결
                    </span>
                    {isConnected ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30 font-bold">CONNECTED</span>
                    ) : isWrongNet ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-amber-500/10 text-amber-400 border-amber-500/30 font-bold">WRONG NETWORK</span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border font-bold">NOT CONNECTED</span>
                    )}
                  </div>

                  {/* Sub-state stepper strip ① ② ③ ④ */}
                  <div className="flex items-center gap-1 mb-3">
                    {subLabels.map((label, i) => {
                      const done    = i < subState;
                      const current = i === subState;
                      return (
                        <div key={i} className="flex items-center gap-1">
                          <div className={cn(
                            'flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border transition-colors',
                            done    ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/10 text-[var(--color-long)]' :
                            current ? (isWrongNet ? 'border-amber-500/40 bg-amber-500/10 text-amber-400' : 'border-primary/40 bg-primary/10 text-primary') :
                                      'border-border/40 text-muted-foreground/40',
                          )}>
                            {done ? '✓' : `${i + 1}`}
                            <span className={cn('hidden sm:inline', !current && !done && 'opacity-40')}>{label}</span>
                          </div>
                          {i < 3 && (
                            <div className={cn('w-3 h-px shrink-0', done ? 'bg-[var(--color-long)]/40' : 'bg-border/30')} />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {isConnected ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-muted-foreground">주소</span>
                        <span className="font-mono text-foreground">
                          {wallet.address!.slice(0, 8)}…{wallet.address!.slice(-6)}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-muted-foreground">ETH</span>
                        <span className="font-mono text-foreground">{wallet.ethBalance ?? '—'}</span>
                        <span className="text-muted-foreground ml-2">USDC</span>
                        <span className="font-mono text-foreground">{wallet.usdcBalance ?? '—'}</span>
                      </div>
                      <div className="flex gap-2 mt-1">
                        <Button size="sm" variant="ghost" onClick={wallet.refreshBalances} className="h-7 text-xs">
                          <RefreshCw className="w-3 h-3 mr-1.5" /> 잔고 새로고침
                        </Button>
                        <Button size="sm" variant="ghost" onClick={wallet.disconnect} className="h-7 text-xs text-muted-foreground">
                          연결 해제
                        </Button>
                      </div>
                    </div>
                  ) : isWrongNet ? (
                    <div>
                      <p className="text-xs text-amber-400/90 mb-3 leading-relaxed">
                        <AlertCircle className="inline w-3 h-3 mr-1" />
                        MetaMask가 Arbitrum One (Chain 42161) 이외의 네트워크에 연결되어 있습니다.
                        아래 버튼을 눌러 자동으로 전환하거나, MetaMask에서 직접 Arbitrum One으로 변경하세요.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleSwitchToArbitrum}
                          disabled={switchingNet}
                          className="h-7 text-xs border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                        >
                          {switchingNet
                            ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />전환 중…</>
                            : <><RefreshCw className="w-3 h-3 mr-1.5" />Arbitrum으로 전환</>
                          }
                        </Button>
                        <Button size="sm" variant="ghost" onClick={wallet.disconnect} className="h-7 text-xs text-muted-foreground">
                          연결 해제
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">
                        MetaMask 등 브라우저 지갑으로 내 GMX 계정 주소를 연결합니다.
                        <strong className="text-foreground"> read-only 조회 전용 — 서명·개인키 접근 없음.</strong>
                        {' '}개인키·시드문구는 브라우저 지갑 내부에 보관되며 서버로 전송되지 않습니다.
                      </p>
                      {wallet.status === 'no_provider' ? (
                        <p className="text-xs text-amber-400 mb-2">
                          <AlertCircle className="inline w-3 h-3 mr-1" />
                          MetaMask 또는 EIP-1193 호환 지갑이 설치되어 있지 않습니다.{' '}
                          <a href="https://metamask.io" target="_blank" rel="noopener noreferrer"
                            className="underline hover:text-amber-300">metamask.io에서 설치</a>
                        </p>
                      ) : wallet.error ? (
                        <p className="text-xs text-destructive mb-2">
                          <AlertCircle className="inline w-3 h-3 mr-1" />
                          {wallet.error}
                        </p>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={wallet.connect}
                        disabled={isConnecting || wallet.status === 'no_provider'}
                        className="h-7 text-xs"
                      >
                        {isConnecting
                          ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />연결 중…</>
                          : <><Wallet className="w-3 h-3 mr-1.5" />지갑 연결 (Read-only)</>
                        }
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Step 3 — Read-only 계정 조회 */}
          <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-card/30 opacity-60">
            <div className="flex items-center justify-center w-7 h-7 rounded-full border-2 border-border text-muted-foreground font-bold text-xs shrink-0 mt-0.5">
              3
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-sm">Read-only 계정 조회</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border font-bold">2단계 완료 후</span>
              </div>
              <p className="text-xs text-muted-foreground">
                실제 GMX 포지션·잔고·거래 내역을 조회합니다.
                서명 없이 온체인 데이터만 읽습니다 — 주문을 낼 수 없습니다.
              </p>
            </div>
          </div>

          {/* Step 4 — Delegated Subaccount */}
          <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-card/30 opacity-60">
            <div className="flex items-center justify-center w-7 h-7 rounded-full border-2 border-border text-muted-foreground font-bold text-xs shrink-0 mt-0.5">
              4
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-sm">GMX Delegated Subaccount 승인</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border font-bold">NOT AUTHORIZED</span>
              </div>
              <p className="text-xs text-muted-foreground">
                메인 지갑에서 제한된 One-Click 거래 권한을 별도 서브계정에 위임합니다.
                <strong className="text-foreground"> 메인 지갑 자금에 대한 전체 권한이 아닌, GMX 계약이 허용하는 제한된 실행 권한입니다.</strong>
                서브계정 주소만 서버에 저장 가능하며, 서명키·개인키는 절대 서버에 저장하지 않습니다.
                이 단계 완료 후 LIVE 모드 승인 시 실제 주문 전송이 가능합니다.
              </p>
              <div className="flex items-center gap-1.5 mt-2 text-[10px] text-amber-400/80">
                <ChevronRight className="w-3 h-3" />
                3단계 완료 + 별도 보안 검토 후 활성화 예정
              </div>
            </div>
          </div>

        </div>

        {/* Security note */}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs text-amber-300/80">
          <Key className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
          <span>
            <strong className="text-amber-400">보안 원칙:</strong>{' '}
            메인 지갑 개인키·니모닉·시드문구를 이 서버(Replit)에 절대 입력하지 마세요.
            Replit은 AI 의사결정·오퍼레이터 승인 게이트·리스크 모니터링 전용으로만 사용합니다.
            실제 서명은 항상 브라우저 지갑(사용자 기기)에서만 이루어집니다.
          </span>
        </div>
      </section>

      {/* ── LIVE 실행 준비 ── */}
      <section className="flex flex-col gap-4">
        {/* Section header + status badge */}
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <h2 className="font-semibold flex items-center gap-2 text-lg flex-1">
            <Lock className="w-5 h-5 text-muted-foreground" /> LIVE 실행 준비
          </h2>
          <span className={cn(
            'text-[10px] font-bold px-2 py-1 rounded-full border',
            subaccountConfig.status === 'ready'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
              : 'border-border bg-secondary text-muted-foreground',
          )}>
            {subaccountConfig.status === 'ready' ? '위임 준비 완료 — 아직 미실행' : '준비 단계 — LIVE 실행 잠김'}
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          실제 GMX V2 주문을 활성화하려면 아래 4단계를 완료해야 합니다.
          개인키·서명키를 서버에 저장하지 않고, 브라우저 지갑으로 제한 권한을 위임하는 방식입니다.
          <strong className="text-foreground"> 위임이 완료되고 코드 수준 잠금이 해제될 때까지 LIVE 실행은 불가능합니다.</strong>
        </p>

        {/* 4-step checklist */}
        <div className="flex flex-col gap-2">

          {/* ① 지갑 연결 */}
          {(() => {
            const done = wallet.status === 'connected';
            return (
              <div className={cn(
                'flex items-start gap-3 p-3 rounded-lg border text-xs',
                done ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5' : 'border-border bg-card/30',
              )}>
                <div className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 border-2',
                  done ? 'border-[var(--color-long)] text-[var(--color-long)]' : 'border-border text-muted-foreground',
                )}>
                  {done ? '✓' : '1'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn('font-semibold mb-0.5', done && 'text-[var(--color-long)]')}>지갑 연결</div>
                  <p className="text-muted-foreground">
                    {done
                      ? `MetaMask 연결됨 — ${wallet.address!.slice(0, 6)}…${wallet.address!.slice(-4)}`
                      : 'MetaMask 등 EIP-1193 호환 지갑을 연결하세요 (위 "GMX 계정 연결 준비" 2단계).'}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* ② Arbitrum One 전환 */}
          {(() => {
            const done = wallet.isArbitrum;
            const isWrong = wallet.status === 'wrong_network';
            return (
              <div className={cn(
                'flex items-start gap-3 p-3 rounded-lg border text-xs',
                done ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5'
                  : isWrong ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-border bg-card/30',
              )}>
                <div className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 border-2',
                  done ? 'border-[var(--color-long)] text-[var(--color-long)]' : 'border-border text-muted-foreground',
                )}>
                  {done ? '✓' : '2'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn('font-semibold mb-0.5', done && 'text-[var(--color-long)]')}>Arbitrum One 전환</div>
                  <p className="text-muted-foreground">
                    {done
                      ? 'Arbitrum One (Chain 42161) 연결됨'
                      : isWrong
                        ? 'MetaMask에서 Arbitrum One (Chain 42161)으로 전환하세요.'
                        : '지갑 연결 후 Arbitrum One으로 전환하세요.'}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* ③ 서브계정 권한 설정 저장 */}
          {(() => {
            const done = subaccountConfig.status !== 'not_configured';
            return (
              <div className={cn(
                'flex items-start gap-3 p-3 rounded-lg border text-xs',
                done ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-card/30',
              )}>
                <div className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 border-2',
                  done ? 'border-amber-500 text-amber-400' : 'border-border text-muted-foreground',
                )}>
                  {done ? '✓' : '3'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn('font-semibold mb-0.5', done && 'text-amber-400')}>서브계정 권한 설정 저장</div>
                  <p className="text-muted-foreground">
                    {done
                      ? `설정 저장됨 — maxActions: ${subaccountConfig.maxActions}, 만료: ${subaccountConfig.expiresInDays}일. 실제 위임 트랜잭션은 아직 실행되지 않았습니다.`
                      : '아래 폼에서 서브계정 파라미터를 설정하고 저장하세요. 설정만 저장되며 실제 트랜잭션은 없습니다.'}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* ④ 최종 활성화 (코드 수준 잠금) */}
          <div className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card/20 text-xs opacity-70">
            <div className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 border-2 border-border text-muted-foreground">
              🔒
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold mb-0.5 flex items-center gap-2">
                최종 활성화
                <span className="text-[9px] px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground/60 font-mono normal-case">LOCKED</span>
              </div>
              <p className="text-muted-foreground leading-relaxed">
                GMX SubaccountRouter.addSubaccount() 온체인 트랜잭션 서명 후 코드 수준 잠금(LIVE_EXECUTION_LOCKED)을 별도 해제합니다.
                현재 항상 dry-run 반환 — 3단계 완료 + 별도 보안 검토 후 활성화 예정.
              </p>
            </div>
          </div>

        </div>

        {/* Subaccount config form — only when wallet connected + Arbitrum */}
        {wallet.status === 'connected' && wallet.isArbitrum ? (
          <Card className="p-4 flex flex-col gap-4 border-border/60">

            {/* "설정만 저장" info banner */}
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs text-amber-300/80">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
              <span>
                <strong className="text-amber-400">설정만 저장됩니다.</strong>{' '}
                실제 권한 위임(GMX SubaccountRouter 트랜잭션)은 이 단계에서 실행되지 않습니다.
                이 설정은 향후 delegateSubaccount 트랜잭션 파라미터로 사용될 예정입니다.
              </span>
            </div>

            {/* maxActions */}
            <div>
              <div className="text-xs font-medium text-foreground mb-2">
                최대 액션 수 <span className="font-mono text-primary">maxActions</span>
                <span className="text-muted-foreground ml-2 font-normal">— 서브계정 허용 실행 횟수 상한</span>
              </div>
              <div className="flex gap-2">
                {([50, 100, 200, 500] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setSubDraftMaxActions(v)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-mono rounded border transition-colors',
                      subDraftMaxActions === v
                        ? 'border-primary bg-primary/10 text-primary font-bold'
                        : 'border-border text-muted-foreground hover:border-primary/40 bg-card/50',
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* expiresInDays */}
            <div>
              <div className="text-xs font-medium text-foreground mb-2">
                권한 만료 기간 <span className="font-mono text-primary">expiresInDays</span>
                <span className="text-muted-foreground ml-2 font-normal">— 위임 권한 자동 만료 일수</span>
              </div>
              <div className="flex gap-2">
                {([7, 30, 90] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setSubDraftExpiresIn(v)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-mono rounded border transition-colors',
                      subDraftExpiresIn === v
                        ? 'border-primary bg-primary/10 text-primary font-bold'
                        : 'border-border text-muted-foreground hover:border-primary/40 bg-card/50',
                    )}
                  >
                    {v}일
                  </button>
                ))}
              </div>
            </div>

            {/* Save button + status */}
            <div className="flex items-center gap-3 pt-1 border-t border-border/40">
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveSubaccountConfig}
                className="h-8 text-xs"
              >
                {subSaved
                  ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-[var(--color-long)]" />저장 완료</>
                  : <><Key className="w-3.5 h-3.5 mr-1.5" />설정 저장 (위임 준비 완료로 변경)</>
                }
              </Button>
              {subaccountConfig.status === 'ready' && !subSaved && (
                <span className="text-[11px] text-amber-400/80 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  위임 준비 완료 — 위임 트랜잭션 미실행
                </span>
              )}
            </div>

          </Card>
        ) : (
          <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3 shrink-0" />
            서브계정 설정 폼은 지갑 연결 + Arbitrum One 전환 후 표시됩니다.
          </p>
        )}

      </section>

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

        {/* ── Offline banner (2+ consecutive failures) ── */}
        {isOffline && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-amber-500/50 bg-amber-500/8">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0 animate-pulse" />
            <div className="flex-1 text-xs">
              <span className="font-bold text-amber-400">Executor 오프라인</span>
              <span className="text-amber-300/80 ml-2">
                {consecutiveFailures}회 연속 응답 없음
                {lastSuccessAt ? ` — 마지막 성공: ${formatElapsed(now - lastSuccessAt.getTime())}` : ''}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={refreshHealth} disabled={healthLoading}
              className="h-7 text-xs text-amber-400 hover:text-amber-300 shrink-0">
              {healthLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </Button>
          </div>
        )}

        <Card className={cn(
          'p-4 flex flex-col gap-3 border transition-colors',
          isOffline ? 'border-amber-500/40 bg-amber-500/5'
          : isStale  ? 'border-amber-500/20'
          :            'border-border',
        )}>
          {/* Header row — auto-refresh label + manual refresh button */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Execution Engine</span>
              {/* Last-success timestamp (always visible once we have one) */}
              {lastSuccessAt ? (
                <span className={cn(
                  'text-[10px] font-mono',
                  isOffline || isStale ? 'text-amber-400' : 'text-muted-foreground',
                )}>
                  {format(lastSuccessAt, 'HH:mm:ss')} ({formatElapsed(now - lastSuccessAt.getTime())})
                </span>
              ) : null}
              {/* Auto-refresh chip */}
              <span className="text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground/60">
                30초 자동갱신
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={refreshHealth} disabled={healthLoading} className="h-7 text-xs">
              {healthLoading
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <><RefreshCw className="w-3 h-3 mr-1" />지금 갱신</>}
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
                Arbitrum RPC {health.gmxConnected ? '연결됨 (시장 데이터)' : '연결 없음'}
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
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                wallet.status === 'connected' && wallet.isArbitrum
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : wallet.status === 'wrong_network'
                    ? 'border-amber-500/30 bg-amber-500/5 text-amber-400'
                    : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {wallet.status === 'connected' && wallet.isArbitrum
                  ? <CheckCircle2 className="w-3.5 h-3.5" />
                  : <Wallet className="w-3.5 h-3.5" />}
                {wallet.status === 'connected' && wallet.isArbitrum
                  ? `지갑 ${wallet.address!.slice(0, 6)}…${wallet.address!.slice(-4)}`
                  : wallet.status === 'wrong_network'
                    ? '잘못된 네트워크'
                    : '지갑 미연결'}
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/50 text-muted-foreground text-[11px] font-medium">
                <Key className="w-3.5 h-3.5" /> 서브계정 미인증
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/5 text-blue-400 text-[11px] font-medium">
                <FlaskConical className="w-3.5 h-3.5" /> 실행: PAPER ONLY
              </div>
            </div>
          ) : healthLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 상태 로딩 중…
            </div>
          ) : (
            <div className={cn(
              'flex items-center gap-2 text-xs',
              isOffline ? 'text-amber-400' : 'text-muted-foreground',
            )}>
              {isOffline
                ? <><WifiOff className="w-3.5 h-3.5" /> Executor 응답 없음 — 네트워크 또는 서버 상태를 확인하세요</>
                : 'Executor status unavailable'}
            </div>
          )}

          {/* Consecutive-failure warning row */}
          {isStale && !isOffline && (
            <div className="flex items-center gap-2 text-[11px] text-amber-400/80 border-t border-amber-500/20 pt-2 mt-1">
              <AlertCircle className="w-3 h-3 shrink-0" />
              마지막 갱신 실패 — 자동으로 재시도 중입니다
            </div>
          )}
        </Card>
      </section>

      {/* ── AI Worker 사이클 상태 ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Activity className="w-5 h-5 text-primary" /> AI Worker 사이클 상태
        </h2>
        <Card className="p-4 flex flex-col gap-4">
          {health ? (
            <>
              {/* 상태 요약 행 */}
              <div className="flex flex-wrap gap-2">
                {/* Worker 실행 여부 */}
                <div className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                  health.workerRunning
                    ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                    : 'border-border bg-card/50 text-muted-foreground',
                )}>
                  {health.workerRunning
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 사이클 실행 중</>
                    : <><CheckCircle2 className="w-3.5 h-3.5" /> 대기 중</>}
                </div>

                {/* 총 사이클 수 */}
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/50 text-muted-foreground text-[11px] font-medium">
                  총 {health.cycleCount ?? 0}회 완료
                </div>

                {/* 마지막 결정 */}
                {health.lastCycleResult && (
                  <>
                    <div className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold',
                      health.lastCycleResult.operatingState === 'LONG'
                        ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                        : health.lastCycleResult.operatingState === 'SHORT'
                          ? 'border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)]'
                          : 'border-border bg-card/50 text-muted-foreground',
                    )}>
                      {health.lastCycleResult.operatingState}
                      {health.lastCycleResult.primarySymbol && (
                        <span className="font-mono ml-1">{health.lastCycleResult.primarySymbol}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/50 text-muted-foreground text-[11px] font-medium">
                      신뢰도 {Math.round(health.lastCycleResult.confidence * 100)}%
                    </div>
                    {health.lastCycleResult.error && (
                      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-400 text-[11px] font-medium max-w-xs truncate" title={health.lastCycleResult.error}>
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        {health.lastCycleResult.error}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 타임스탬프 */}
              {health.lastCycleAt && (
                <p className="text-[10px] text-muted-foreground font-mono">
                  마지막 사이클:{' '}
                  {format(new Date(health.lastCycleAt), 'yyyy-MM-dd HH:mm:ss')}
                  {' '}({formatElapsed(now - new Date(health.lastCycleAt).getTime())})
                </p>
              )}

              {/* Equity HWM */}
              {(health as { equityHwm?: number | null }).equityHwm != null && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground border-t border-border/60 pt-3">
                  <span className="font-semibold text-foreground">Equity HWM</span>
                  <span className="font-mono">
                    ${(health as { equityHwm: number }).equityHwm.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-muted-foreground/60 text-[10px]">(서버 시작 이후 최고점)</span>
                </div>
              )}

              {/* 핵심 Risk Limits (마지막 사이클 기준) */}
              {(health as { lastLimitsUsed?: object | null }).lastLimitsUsed && (() => {
                const lim = (health as { lastLimitsUsed: Record<string, number> }).lastLimitsUsed;
                return (
                  <div className="border-t border-border/60 pt-3 flex flex-col gap-2">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      마지막 사이클 적용 한도
                    </p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                      {[
                        ['트레이딩 자본', `$${(lim.tradingCapital ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`],
                        ['최대 드로다운', `${lim.maxDrawdownPercent ?? 0}%`],
                        ['일일 손실 한도', `$${lim.dailyLossLimitUSDT ?? 0}`],
                        ['주간 손실 한도', `$${lim.weeklyLossLimitUSDT ?? 0}`],
                        ['Rolling 24h 손실', `$${lim.rolling24hLossLimitUSDT ?? 0}`],
                        ['시간당 최대 거래', `${lim.maxTradesPerHour ?? 0}건`],
                        ['쿨다운', `${lim.cooldownMinutes ?? 0}분`],
                        ['최대 레버리지', `${lim.maxLeverage ?? 0}x`],
                      ].map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-2">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-mono text-foreground font-semibold">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          ) : healthLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 상태 로딩 중…
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Executor에서 AI Worker 상태를 불러올 수 없습니다.</p>
          )}
        </Card>
      </section>

      {/* ── 브라우저 알림 ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Bell className="w-5 h-5 text-primary" /> 브라우저 알림
        </h2>
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">LIVE 승인 알림</span>
            {/* Current permission badge */}
            {notificationPermission === 'granted' && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]">
                <CheckCircle2 className="w-3.5 h-3.5" /> 허용됨
              </span>
            )}
            {notificationPermission === 'denied' && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)]">
                <BellOff className="w-3.5 h-3.5" /> 차단됨
              </span>
            )}
            {notificationPermission === 'default' && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-border bg-card/50 text-muted-foreground">
                <Bell className="w-3.5 h-3.5" /> 미설정
              </span>
            )}
            {notificationPermission === 'unsupported' && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-border bg-card/50 text-muted-foreground">
                <XCircle className="w-3.5 h-3.5" /> 미지원
              </span>
            )}
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            LIVE 승인 요청이 도착하면 브라우저 데스크탑 알림이 발화됩니다.
            탭이 백그라운드이거나 다른 창이 활성화되어 있어도 알림이 전달됩니다.
          </p>

          {/* Permission-specific actions */}
          {notificationPermission === 'default' && (
            <div className="flex flex-col gap-2 pt-1">
              <p className="text-xs text-foreground/80">
                아직 알림 권한을 허용하지 않았습니다.
                아래 버튼을 클릭하면 브라우저가 권한을 요청합니다.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-fit h-8 text-xs gap-1.5"
                onClick={requestNotificationPermission}
              >
                <Bell className="w-3.5 h-3.5" />
                알림 권한 허용하기
              </Button>
            </div>
          )}

          {notificationPermission === 'denied' && (
            <div className="flex flex-col gap-2 pt-1">
              <p className="text-xs text-[var(--color-short)]/80">
                알림이 브라우저에서 차단되어 있습니다.
                대시보드에 대체 배너가 표시되지만 탭이 비활성일 때는 놓칠 수 있습니다.
              </p>
              <a
                href="https://support.google.com/chrome/answer/3220216"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline w-fit"
              >
                <ExternalLink className="w-3 h-3" />
                Chrome 알림 설정 안내 (사이트 권한 재설정)
              </a>
              <p className="text-[10px] text-muted-foreground">
                Chrome: 주소창 왼쪽 자물쇠 아이콘 → 사이트 설정 → 알림 → 허용
              </p>
            </div>
          )}

          {notificationPermission === 'granted' && (
            <p className="text-xs text-[var(--color-long)]/80">
              LIVE 승인 요청 시 데스크탑 알림이 자동으로 발화됩니다.
              알림을 끄려면 브라우저 주소창 자물쇠 아이콘 → 알림 → 차단을 선택하세요.
            </p>
          )}

          {notificationPermission === 'unsupported' && (
            <p className="text-xs text-muted-foreground">
              이 브라우저는 Notification API를 지원하지 않습니다.
              대시보드 배너가 대체 알림 역할을 합니다.
              Chrome 또는 Edge 사용을 권장합니다.
            </p>
          )}

          {/* ── Test notification button — always visible except 'unsupported' ── */}
          {notificationPermission !== 'unsupported' && (
            <div className="flex items-center gap-3 pt-2 border-t border-border/60">
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  'h-8 text-xs gap-1.5 transition-colors',
                  testNotifState === 'sent'    && 'border-[var(--color-long)]/50 text-[var(--color-long)]',
                  testNotifState === 'denied'  && 'border-[var(--color-short)]/50 text-[var(--color-short)]',
                  testNotifState === 'sending' && 'opacity-60',
                )}
                onClick={handleTestNotif}
                disabled={testNotifState === 'sending' || notificationPermission === 'denied'}
              >
                {testNotifState === 'sending' ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 전송 중…</>
                ) : testNotifState === 'sent' ? (
                  <><CheckCircle2 className="w-3.5 h-3.5" /> 알림 전송됨</>
                ) : testNotifState === 'denied' ? (
                  <><XCircle className="w-3.5 h-3.5" /> 권한 없음</>
                ) : (
                  <><Send className="w-3.5 h-3.5" /> 테스트 알림 전송</>
                )}
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {notificationPermission === 'denied'
                  ? '브라우저 설정에서 권한을 허용한 뒤 사용 가능합니다'
                  : notificationPermission === 'default'
                    ? '클릭 시 권한 요청 후 즉시 테스트 알림을 발송합니다'
                    : '즉시 데스크탑 알림을 발송해 동작 여부를 확인합니다'}
              </span>
            </div>
          )}
        </Card>
      </section>

      {/* ── 리스크 사용량 현황 ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <Activity className="w-5 h-5 text-primary" /> 리스크 사용량 현황
          <span className="ml-auto text-[10px] font-normal text-muted-foreground px-2 py-0.5 rounded-full border border-border bg-secondary/50">
            PAPER 전용
          </span>
        </h2>
        <Card className="p-4 border-border">
          <div className="grid grid-cols-2 gap-4">
            {/* Daily loss */}
            {(() => {
              const val = dailyPnl;
              const lim = limits.dailyLossLimitUSDT;
              const pct = lim > 0 ? Math.abs(Math.min(0, val)) / lim : 0;
              const barColor = pct >= 1 ? 'bg-red-500' : pct >= 0.75 ? 'bg-amber-500' : 'bg-primary';
              const valColor = val < 0 ? (pct >= 1 ? 'text-red-400' : pct >= 0.75 ? 'text-amber-400' : 'text-muted-foreground') : 'text-[var(--color-long)]';
              return (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">일일 손실</span>
                    <span className={cn('font-mono font-semibold', valColor)}>
                      {val >= 0 ? '+' : ''}{val.toFixed(0)} USDT
                    </span>
                  </div>
                  <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
                  </div>
                  <div className="text-[9px] text-muted-foreground">한도: ${lim.toLocaleString()} · {(pct * 100).toFixed(0)}% 사용</div>
                </div>
              );
            })()}

            {/* Weekly loss */}
            {(() => {
              const val = weeklyRealizedPnl;
              const lim = limits.weeklyLossLimitUSDT;
              const pct = lim > 0 ? Math.abs(Math.min(0, val)) / lim : 0;
              const barColor = pct >= 1 ? 'bg-red-500' : pct >= 0.75 ? 'bg-amber-500' : 'bg-primary';
              const valColor = val < 0 ? (pct >= 1 ? 'text-red-400' : pct >= 0.75 ? 'text-amber-400' : 'text-muted-foreground') : 'text-[var(--color-long)]';
              return (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">주간 손실</span>
                    <span className={cn('font-mono font-semibold', valColor)}>
                      {val >= 0 ? '+' : ''}{val.toFixed(0)} USDT
                    </span>
                  </div>
                  <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
                  </div>
                  <div className="text-[9px] text-muted-foreground">한도: ${lim.toLocaleString()} · {(pct * 100).toFixed(0)}% 사용</div>
                </div>
              );
            })()}

            {/* Rolling 24h */}
            {(() => {
              const val = rolling24hPnl;
              const lim = limits.rolling24hLossLimitUSDT;
              if (!lim) {
                return (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Rolling 24h 손실</span>
                      <span className="font-mono font-semibold text-muted-foreground/60">{val >= 0 ? '+' : ''}{val.toFixed(0)} USDT</span>
                    </div>
                    <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full w-0 rounded-full bg-muted-foreground/30" />
                    </div>
                    <div className="text-[9px] text-muted-foreground/60">비활성화 (Strategy에서 설정)</div>
                  </div>
                );
              }
              const pct = Math.abs(Math.min(0, val)) / lim;
              const barColor = pct >= 1 ? 'bg-red-500' : pct >= 0.75 ? 'bg-amber-500' : 'bg-primary';
              const valColor = val < 0 ? (pct >= 1 ? 'text-red-400' : pct >= 0.75 ? 'text-amber-400' : 'text-muted-foreground') : 'text-[var(--color-long)]';
              return (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Rolling 24h 손실</span>
                    <span className={cn('font-mono font-semibold', valColor)}>{val >= 0 ? '+' : ''}{val.toFixed(0)} USDT</span>
                  </div>
                  <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
                  </div>
                  <div className="text-[9px] text-muted-foreground">한도: ${lim.toLocaleString()} · {(pct * 100).toFixed(0)}% 사용</div>
                </div>
              );
            })()}

            {/* Total exposure */}
            {(() => {
              const val = totalExposure;
              const lim = limits.maxTotalExposureUSDT;
              const pct = lim > 0 ? val / lim : 0;
              const barColor = pct >= 1 ? 'bg-red-500' : pct >= 0.8 ? 'bg-amber-500' : 'bg-primary';
              const valColor = pct >= 1 ? 'text-red-400' : pct >= 0.8 ? 'text-amber-400' : 'text-muted-foreground';
              return (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">총 포지션 노출</span>
                    <span className={cn('font-mono font-semibold', valColor)}>${val.toFixed(0)}</span>
                  </div>
                  <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
                  </div>
                  <div className="text-[9px] text-muted-foreground">한도: ${lim.toLocaleString()} · {(pct * 100).toFixed(0)}% 사용</div>
                </div>
              );
            })()}

            {/* Consecutive losses */}
            {(() => {
              const val = consecutiveLosses;
              const lim = limits.consecutiveLossLimit;
              const pct = lim > 0 ? val / lim : 0;
              const barColor = pct >= 1 ? 'bg-red-500' : pct >= 0.6 ? 'bg-amber-500' : 'bg-primary';
              const valColor = pct >= 1 ? 'text-red-400' : pct >= 0.6 ? 'text-amber-400' : 'text-muted-foreground';
              return (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">연속 손실</span>
                    <span className={cn('font-mono font-semibold', valColor)}>{val}회</span>
                  </div>
                  <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
                  </div>
                  <div className="text-[9px] text-muted-foreground">한도: {lim}회 · {(pct * 100).toFixed(0)}% 사용</div>
                </div>
              );
            })()}
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
