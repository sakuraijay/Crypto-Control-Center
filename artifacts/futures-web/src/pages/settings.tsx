import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { useAppContext, useAuthContext, useTradingContext, useWallet } from '@/lib/context';
import { SubaccountApprovalCard } from '@/components/SubaccountApprovalCard';
import { RelayStatusCard } from '@/components/RelayStatusCard';
import { ReadinessRefreshCard } from '@/components/ReadinessRefreshCard';
import { formatConfidencePct } from '@/lib/formatConfidence';
import { deriveLiveTestDisplay } from '@/lib/liveTestDisplay';
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
  WifiOff, Send, Activity, Database, Eye, Zap,
} from 'lucide-react';
import { useGmxAccount } from '@/lib/context/GmxAccountContext';
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
  // LIVE TEST MODE
  liveTestMode?: boolean;
  liveTestVetoReason?: string | null;
  liveTestAccumLossUsd?: number;
  liveTestDbOk?: boolean;
  /** True when GMX_RPC_URL env var is set server-side */
  rpcConfigured?: boolean;
  /** ISO timestamp of the last RPC health check (null = never checked) */
  lastRpcCheckAt?: string | null;
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

// ── useWalletDiagnostic — polls GET /api/wallet/diagnostic every 30 s ─────────

interface WalletDiagSnapshot {
  walletConnected:    boolean;
  addressFingerprint: string | null;
  chainId:            number | null;
  isArbitrum:         boolean;
  usdcFetchOk:        boolean;
  ethFetchOk:         boolean;
  subgraphOk:         boolean;
  positionCount:      number;
  lastRefreshAt:      string;
  receivedAt:         string;
  stale:              boolean;
}

interface WalletDiagResponse {
  present: boolean;
  stale:   boolean;
  ageMs:   number;
  snapshot: WalletDiagSnapshot | null;
}

function useWalletDiagnostic() {
  const [data, setData]       = useState<WalletDiagResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/wallet/diagnostic');
      if (res.ok) setData(await res.json() as WalletDiagResponse);
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), AUTO_REFRESH_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refresh]);

  return { data, loading, refresh };
}

// ── Main settings page ────────────────────────────────────────────────────────

export default function Settings() {
  const { engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency } = useAppContext();
  const { logout } = useAuthContext();
  const { clearAllPositions, positions, closedTrades, consecutiveLosses } = useTradingContext();
  const { health, loading: healthLoading, refresh: refreshHealth, lastSuccessAt, consecutiveFailures } = useExecutorHealth();
  const { data: diagData, loading: diagLoading, refresh: refreshDiag } = useWalletDiagnostic();
  const wallet = useWallet();
  const gmx    = useGmxAccount();
  const { notificationPermission, requestNotificationPermission, sendTestNotification, weeklyRealizedPnl } = useAiEngine();
  const now = useNow();

  const { limits, syncStatus, updateLiveTestConfig, updateLimit } = useStrategyContext();

  const [closeAllPhase, setCloseAllPhase] = useState<0 | 1 | 2>(0);
  const [testNotifState, setTestNotifState] = useState<'idle' | 'sending' | 'sent' | 'denied' | 'unsupported'>('idle');
  const [switchingNet, setSwitchingNet] = useState(false);
  // LIVE TEST MODE draft state
  const [ltBudgetDraft, setLtBudgetDraft]   = useState(() => limits.testBudgetUsd   ?? 100);
  const [ltMaxLossDraft, setLtMaxLossDraft] = useState(() => limits.testMaxLossUsd  ?? 50);
  const [ltMaxLevDraft, setLtMaxLevDraft]   = useState(() => limits.testMaxLeverage ?? 2);

  // §6 — LIVE TEST 표시 상태는 서버 /api/executor/status가 authoritative
  const liveTestDisplay = useMemo(() => deriveLiveTestDisplay({
    serverLiveTestMode: health?.liveTestMode,
    serverStatusKnown: lastSuccessAt != null && health != null,
    localLiveTestMode: limits.liveTestMode ?? false,
  }), [health, lastSuccessAt, limits.liveTestMode]);
  // ── 핵심 리스크 한도 draft 상태 ──────────────────────────────────────────
  const [drawdownDraft,  setDrawdownDraft]  = useState(() => limits.maxDrawdownPercent  ?? 15);
  const [dailyLossDraft, setDailyLossDraft] = useState(() => limits.dailyLossLimitUSDT ?? 500);
  // ── 알림 서버 로그 + VAPID / Web Push 상태 ──────────────────────────────────
  const [notifLog, setNotifLog] = useState<Array<{ ts: string; channel: string; status: string; msg: string }>>([]);
  const [vapidReady,      setVapidReady]      = useState<boolean | null>(null); // null = loading
  const [pushSubscribed,  setPushSubscribed]  = useState(false);
  const [pushSubscribing, setPushSubscribing] = useState(false);

  const refreshNotifStatus = useCallback(() => {
    fetch('/api/notifications/status')
      .then(r => r.ok ? r.json() : null)
      .then((d: {
        log?: Array<{ ts: string; channel: string; status: string; msg: string }>;
        vapidConfigured?: boolean;
        subscribed?: boolean;
      } | null) => {
        if (!d) return;
        if (Array.isArray(d.log)) setNotifLog(d.log.slice(0, 5));
        if (typeof d.vapidConfigured === 'boolean') setVapidReady(d.vapidConfigured);
        if (typeof d.subscribed     === 'boolean') setPushSubscribed(d.subscribed);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshNotifStatus(); }, [testNotifState, refreshNotifStatus]);

  // ── Web Push subscribe / unsubscribe (mirrors AiEngineContext.tryRegisterPush) ──
  const handlePushSubscribe = useCallback(async () => {
    if (!vapidReady || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    setPushSubscribing(true);
    try {
      const keyResp = await fetch('/api/notifications/vapid-key');
      if (!keyResp.ok) return;
      const { publicKey } = await keyResp.json() as { publicKey: string };
      if (!publicKey) return;

      const reg = await navigator.serviceWorker.register('/futures-web/sw.js', { scope: '/futures-web/' });
      await navigator.serviceWorker.ready;

      const existing = await reg.pushManager.getSubscription();
      const sub = existing ?? await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: (() => {
          const padding = '='.repeat((4 - publicKey.length % 4) % 4);
          const b64     = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
          const raw     = window.atob(b64);
          return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
        })(),
      });
      await fetch('/api/notifications/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      refreshNotifStatus();
    } catch (err) {
      console.warn('[Push] 구독 실패:', (err as Error).message);
    } finally {
      setPushSubscribing(false);
    }
  }, [vapidReady, refreshNotifStatus]);

  const handlePushUnsubscribe = useCallback(async () => {
    setPushSubscribing(true);
    try {
      // Unsubscribe from PushManager
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration('/futures-web/');
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
        }
      }
      // Remove from server
      await fetch('/api/notifications/subscribe', { method: 'DELETE' });
      refreshNotifStatus();
    } catch (err) {
      console.warn('[Push] 구독 해제 실패:', (err as Error).message);
    } finally {
      setPushSubscribing(false);
    }
  }, [refreshNotifStatus]);

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

          {/* Step 3 — Read-only 계정 조회 (동적) */}
          {(() => {
            const walletReady = wallet.status === 'connected' && wallet.isArbitrum;
            const gmxOk      = gmx.status === 'ok' || gmx.status === 'unavailable';
            const gmxLoading = gmx.status === 'loading';
            const gmxErr     = gmx.status === 'error';
            const totalExp   = gmx.positions.reduce((s, p) => s + p.sizeUsd, 0);

            const borderCls = !walletReady
              ? 'border-border bg-card/30'
              : gmxErr
                ? 'border-[var(--color-short)]/30 bg-[var(--color-short)]/5'
                : gmxOk
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5'
                  : 'border-border bg-card/30';
            const circleCls = !walletReady
              ? 'border-border text-muted-foreground'
              : gmxOk
                ? 'border-[var(--color-long)] text-[var(--color-long)]'
                : 'border-border text-muted-foreground';

            const badgeText = !walletReady
              ? '2단계 완료 후'
              : gmxLoading ? '조회 중…'
              : gmxErr     ? '조회 오류'
              : gmx.status === 'unavailable' ? 'LIVE READ-ONLY (포지션 없음)'
              : 'LIVE READ-ONLY';
            const badgeCls = !walletReady
              ? 'bg-secondary text-muted-foreground border-border'
              : gmxErr
                ? 'bg-[var(--color-short)]/10 text-[var(--color-short)] border-[var(--color-short)]/30'
                : gmxOk
                  ? 'bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30'
                  : 'bg-primary/10 text-primary border-primary/30';

            return (
              <div className={cn('flex items-start gap-4 p-4 rounded-lg border transition-colors', borderCls, !walletReady && 'opacity-60')}>
                <div className={cn('flex items-center justify-center w-7 h-7 rounded-full border-2 font-bold text-xs shrink-0 mt-0.5', circleCls)}>
                  {walletReady && gmxOk ? '✓' : '3'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={cn('font-semibold text-sm', walletReady && gmxOk && 'text-[var(--color-long)]')}>
                      Read-only 계정 조회
                    </span>
                    <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-bold', badgeCls)}>
                      {badgeText}
                    </span>
                  </div>

                  {walletReady ? (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs text-muted-foreground">
                        실제 GMX 온체인 데이터 — Arbitrum RPC (GMX V2 PositionReader) 30초 주기 폴링.
                        <strong className="text-foreground"> 서명 없이 조회 전용. PAPER 대시보드 데이터와 절대 혼합되지 않습니다.</strong>
                      </p>

                      {/* ── 진단 그리드 ── */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {/* 지갑 주소 */}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Wallet className="w-3 h-3" /> 지갑 주소
                          </div>
                          <span className="font-mono font-semibold text-foreground truncate">
                            {wallet.address ? `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}` : '—'}
                          </span>
                          <span className="text-[10px] text-[var(--color-long)]">Read-only · 서명 없음</span>
                        </div>

                        {/* USDC 잔고 */}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Database className="w-3 h-3" /> USDC 잔고
                          </div>
                          <span className="font-mono font-semibold text-foreground">
                            {wallet.usdcBalance != null ? `$${wallet.usdcBalance}` : '—'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">Arbitrum Native USDC</span>
                        </div>

                        {/* ETH 잔고 */}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Zap className="w-3 h-3" /> ETH 잔고
                          </div>
                          <span className="font-mono font-semibold text-foreground">
                            {wallet.ethBalance != null ? `${wallet.ethBalance}` : '—'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">가스비 예비</span>
                        </div>

                        {/* GMX 포지션 수 */}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Eye className="w-3 h-3" /> GMX 포지션
                          </div>
                          <span className="font-semibold text-foreground">{gmx.positions.length}개</span>
                          <span className="text-[10px] text-muted-foreground">
                            총 노출 ${totalExp.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                          </span>
                        </div>

                        {/* 마지막 갱신 */}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Activity className="w-3 h-3" /> 마지막 갱신
                          </div>
                          <span className="font-semibold text-foreground">
                            {gmx.lastSuccessUpdated
                              ? formatElapsed(now - gmx.lastSuccessUpdated.getTime())
                              : gmxLoading ? '조회 중…' : '—'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">폴링 주기: 30초</span>
                        </div>

                        {/* 데이터 소스 상태 */}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60 text-[11px]">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Server className="w-3 h-3" /> 데이터 소스
                          </div>
                          <span className={cn(
                            'font-semibold',
                            gmxOk  ? 'text-[var(--color-long)]'  :
                            gmxErr ? 'text-[var(--color-short)]' :
                            'text-muted-foreground',
                          )}>
                            {gmx.status === 'idle'        ? '대기'
                            : gmx.status === 'loading'    ? '조회 중'
                            : gmx.status === 'ok'         ? '정상'
                            : gmx.status === 'unavailable'? '포지션 없음'
                            :                               '오류'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">Arbitrum RPC</span>
                        </div>
                      </div>

                      {/* 오류 메시지 */}
                      {gmx.error && (
                        <div className="flex items-start gap-1.5 text-xs text-[var(--color-short)]">
                          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                          {gmx.error}
                        </div>
                      )}

                      {/* 하단: 보안 고지 + 수동 재조회 버튼 */}
                      <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-2">
                        <p className="text-[10px] text-muted-foreground/50 flex items-center gap-1 min-w-0">
                          <Database className="w-2.5 h-2.5 shrink-0" />
                          조회 전용 — 서명·주문·자금 이동 없음. PAPER 데이터와 혼합 없음.
                        </p>
                        <Button
                          size="sm"
                          variant={gmxErr ? 'outline' : 'ghost'}
                          className={cn(
                            'h-6 text-[10px] gap-1 shrink-0',
                            gmxErr && 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10',
                          )}
                          onClick={() => gmx.refresh()}
                          disabled={gmxLoading}
                        >
                          <RefreshCw className={cn('w-2.5 h-2.5', gmxLoading && 'animate-spin')} />
                          재조회
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      실제 GMX 포지션·잔고를 조회합니다. 서명 없이 온체인 데이터만 읽습니다 — 주문을 낼 수 없습니다.
                    </p>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Step 4 — GMX Delegated Trading (서버 고정 규칙, 6E-2 §4) */}
          <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-card/30">
            <div className="flex items-center justify-center w-7 h-7 rounded-full border-2 border-border text-muted-foreground font-bold text-xs shrink-0 mt-0.5">
              4
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="font-semibold text-sm">GMX Delegated Trading (Owner Approval)</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-bold bg-secondary text-muted-foreground border-border">
                  서버 고정 파라미터
                </span>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                메인 지갑에서 제한된 주문 실행 권한을 서버 delegated signer에 위임합니다.
                <strong className="text-foreground"> 승인 파라미터는 서버가 canonical 값으로 고정 생성하며, UI에서는 변경할 수 없습니다.</strong>
                {' '}아래 Owner Approval 카드의 Prepare가 반환한 값을 검토·확인한 뒤에만 서명합니다.
              </p>

              {/* 최신 서버 규칙 표기 (§4) */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-[10px]" data-testid="text-server-approval-rules">
                <span className="text-muted-foreground">최대 실행 횟수 (maxAllowedCount)</span>
                <span className="font-mono">기본 2회 (허용 범위 1~10회)</span>
                <span className="text-muted-foreground">승인 만료 (expiresAt)</span>
                <span className="font-mono">최대 1시간</span>
                <span className="text-muted-foreground">서명 유효기한 (deadline)</span>
                <span className="font-mono">10분</span>
                <span className="text-muted-foreground">파라미터 결정 주체</span>
                <span>서버 (canonical nonce·주소 고정) — UI는 검토·표시만</span>
              </div>

              {/* 항상 표시: 보안 경고 */}
              <div className="flex items-center gap-1.5 mt-3 px-2.5 py-1.5 rounded border border-[var(--color-short)]/20 bg-[var(--color-short)]/5 text-[10px] text-[var(--color-short)]/80">
                <ShieldAlert className="w-3 h-3 shrink-0" />
                메인 지갑 개인키·시드문구를 이 앱 또는 Replit에 절대 입력하지 마세요.
                Owner 서명은 항상 브라우저 지갑(사용자 기기)에서만 이루어집니다.
              </div>
            </div>
          </div>

          {/* Step 4b — MetaMask owner approval (2단계) */}
          <SubaccountApprovalCard />
          <ReadinessRefreshCard />
          <RelayStatusCard />

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
        {/* Section header + status badge — 상태는 서버 subaccount-auth가 authoritative (Owner Approval 카드 참조) */}
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <h2 className="font-semibold flex items-center gap-2 text-lg flex-1">
            <Lock className="w-5 h-5 text-muted-foreground" /> LIVE 실행 준비
          </h2>
          <span className="text-[10px] font-bold px-2 py-1 rounded-full border border-border bg-secondary text-muted-foreground">
            LIVE 실행 잠김 (구조적 비활성)
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          실제 GMX V2 주문 준비는 위 "GMX 계정 연결 준비" 섹션의 Owner Approval 카드에서 진행합니다.
          승인 파라미터(실행 횟수·만료·deadline)는 서버가 canonical 값으로 고정하며 브라우저에 저장되지 않습니다.
          <strong className="text-foreground"> 코드 수준 잠금이 해제될 때까지 LIVE 실행은 구조적으로 불가능합니다.</strong>
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

          {/* ③ Owner Approval (서버 고정 파라미터) */}
          <div className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card/30 text-xs">
            <div className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 border-2 border-border text-muted-foreground">
              3
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold mb-0.5">Owner Approval 서명 (MetaMask)</div>
              <p className="text-muted-foreground">
                위 Owner Approval 카드에서 Prepare → 서버가 반환한 파라미터(최대 2회 실행·1시간 만료·10분 deadline) 검토 → 서명.
                파라미터는 서버가 고정하며 UI에서 조정할 수 없습니다.
              </p>
            </div>
          </div>

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
                온체인 등록·LIVE 실행은 코드 수준 잠금(LIVE_EXECUTION_LOCKED)·환경변수 게이트로 구조적으로 비활성 상태입니다.
                별도 보안 검토 후에만 해제됩니다.
              </p>
            </div>
          </div>

        </div>

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

      {/* ── LIVE TEST MODE ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <h2 className="font-semibold flex items-center gap-2 text-lg flex-1">
            <FlaskConical className="w-5 h-5 text-amber-400" /> LIVE TEST MODE
          </h2>
          {liveTestDisplay.checked ? (
            <span className="text-[10px] font-bold px-2 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-400">
              활성 — 소액 검증 중 (서버 기준)
            </span>
          ) : (
            <span className="text-[10px] font-bold px-2 py-1 rounded-full border border-border bg-secondary text-muted-foreground">
              비활성 (서버 기준)
            </span>
          )}
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground -mt-2 leading-relaxed">
          실제 주문 실행 전에 AI 엔진-승인 흐름 전체를 검증하는 중간 레이어입니다.
          기존 Risk Engine 제한보다 항상 더 엄격한 TEST 전용 하드캡이 적용되며,
          하드캡 위반 시 즉시 차단됩니다.
          <strong className="text-foreground"> 실제 실행은 LIVE_EXECUTION_LOCKED=true로 여전히 잠겨있습니다.</strong>
        </p>

        <Card className="p-5 flex flex-col gap-5 border-amber-500/20 bg-amber-500/5">

          {/* 활성화 토글 — 표시 상태는 항상 서버 /api/executor/status 기준 (§6) */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-foreground">LIVE TEST MODE 활성화</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                활성 시 AI 사이클이 LIVE 결정을 생성할 때 아래 하드캡을 먼저 검사합니다.
                표시 상태는 서버(/api/executor/status)가 결정하며, 브라우저 저장값으로 복원되지 않습니다.
              </p>
            </div>
            <Switch
              checked={liveTestDisplay.checked}
              disabled={liveTestDisplay.toggleDisabled}
              data-testid="switch-live-test-mode"
              onCheckedChange={v => {
                // 요청만 전송 — 실제 표시 상태는 다음 서버 status 갱신이 결정 (낙관적 갱신 없음)
                updateLiveTestConfig({
                  liveTestMode: v,
                  testBudgetUsd:   ltBudgetDraft,
                  testMaxLossUsd:  ltMaxLossDraft,
                  testMaxLeverage: ltMaxLevDraft,
                });
                void refreshHealth();
              }}
            />
          </div>

          {liveTestDisplay.hint && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-[11px] text-amber-300/80" data-testid="text-live-test-hint">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
              {liveTestDisplay.hint}
            </div>
          )}

          {/* 파라미터 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            {/* testBudgetUsd */}
            <div>
              <div className="text-xs font-medium text-foreground mb-1.5">
                테스트 예산 <span className="text-muted-foreground font-normal">(USD)</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={10}
                  max={wallet.usdcBalance ? Math.max(10, parseFloat(wallet.usdcBalance) - 1) : 10000}
                  step={10}
                  value={ltBudgetDraft}
                  onChange={e => {
                    const v = Math.max(10, Number(e.target.value));
                    setLtBudgetDraft(v);
                    // auto-adjust maxLoss if needed
                    if (ltMaxLossDraft > v * 0.5) setLtMaxLossDraft(Math.floor(v * 0.5));
                  }}
                  onBlur={() => updateLiveTestConfig({ testBudgetUsd: ltBudgetDraft, testMaxLossUsd: ltMaxLossDraft })}
                  className="w-28 h-8 px-2.5 rounded border border-border bg-card text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                />
                <span className="text-xs text-muted-foreground">
                  {wallet.usdcBalance ? `/ USDC 잔고 $${wallet.usdcBalance}` : '지갑 미연결'}
                </span>
              </div>
            </div>

            {/* testMaxLossUsd */}
            <div>
              <div className="text-xs font-medium text-foreground mb-1.5">
                최대 누적 손실 한도 <span className="text-muted-foreground font-normal">(USD)</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={Math.floor(ltBudgetDraft * 0.5)}
                  step={5}
                  value={ltMaxLossDraft}
                  onChange={e => setLtMaxLossDraft(Math.min(Math.floor(ltBudgetDraft * 0.5), Math.max(1, Number(e.target.value))))}
                  onBlur={() => updateLiveTestConfig({ testMaxLossUsd: ltMaxLossDraft })}
                  className="w-28 h-8 px-2.5 rounded border border-border bg-card text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                />
                <span className="text-xs text-muted-foreground">
                  (예산의 {ltBudgetDraft > 0 ? Math.round((ltMaxLossDraft / ltBudgetDraft) * 100) : 0}%)
                </span>
              </div>
            </div>

            {/* testMaxLeverage */}
            <div>
              <div className="text-xs font-medium text-foreground mb-1.5">
                최대 레버리지
              </div>
              <div className="flex gap-2">
                {([1, 2] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => {
                      setLtMaxLevDraft(v);
                      updateLiveTestConfig({ testMaxLeverage: v });
                    }}
                    className={cn(
                      'px-3 py-1.5 text-xs font-mono rounded border transition-colors',
                      ltMaxLevDraft === v
                        ? 'border-amber-500/60 bg-amber-500/10 text-amber-400 font-bold'
                        : 'border-border text-muted-foreground hover:border-amber-500/30 bg-card/50',
                    )}
                  >
                    {v}x
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground self-center">(최대 2×)</span>
              </div>
            </div>

            {/* testMaxPositions — always 1, read-only */}
            <div>
              <div className="text-xs font-medium text-foreground mb-1.5">
                최대 포지션 수
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded border border-border/60 bg-secondary/50">
                  <Lock className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs font-mono text-muted-foreground">1개 (고정)</span>
                </div>
                <span className="text-[10px] text-muted-foreground">LIVE TEST 전용 하드캡</span>
              </div>
            </div>

          </div>

          {/* 현황 — 서버 기준 활성일 때만 표시 */}
          {liveTestDisplay.checked && (
            <div className="border-t border-amber-500/20 pt-4">
              <div className="text-xs font-semibold text-foreground mb-3 flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-amber-400" />
                LIVE TEST 현황
              </div>
              <div className="flex flex-col gap-2">

                {/* 차단 이유 */}
                {health?.liveTestVetoReason ? (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-xs">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--color-short)]" />
                    <div>
                      <div className="font-semibold text-[var(--color-short)] mb-0.5">마지막 차단 이유</div>
                      <div className="text-muted-foreground">{health.liveTestVetoReason}</div>
                    </div>
                  </div>
                ) : (
                  <div className="px-3 py-2 rounded-lg border border-border bg-card/60 text-xs text-muted-foreground">
                    차단 이력 없음 — 하드캡이 정상 범위 내에서 작동 중입니다.
                  </div>
                )}

                {/* 누적 손실 현황 */}
                <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs">
                  <span className="text-amber-400/80 font-medium">누적 테스트 손실</span>
                  {health?.liveTestDbOk === false ? (
                    <span className="text-[var(--color-short)] font-bold">DB 오류 — fail-closed</span>
                  ) : (
                    <span className="text-foreground font-mono font-bold">
                      ${(health?.liveTestAccumLossUsd ?? 0).toFixed(2)}
                      {' '}
                      <span className="text-muted-foreground font-normal font-sans">
                        / ${limits.testMaxLossUsd ?? 50} 한도
                      </span>
                    </span>
                  )}
                </div>
                <div className="px-3 py-2 rounded-lg border border-amber-500/10 bg-amber-500/3 text-[10px] text-amber-400/60">
                  ⓘ test_mode=true CLOSE 거래의 손실 합계 — DB에서 매 사이클 재계산되므로 재시작 후에도 자동 복원됩니다.
                </div>

              </div>
            </div>
          )}

          {/* 하드캡 목록 */}
          <div className="border-t border-amber-500/20 pt-4">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">하드캡 조건 (모두 충족 필요)</div>
            <div className="flex flex-col gap-1">
              {[
                `사용 예산 < $${ltBudgetDraft} (테스트 예산 초과 시 차단)`,
                `누적 손실 < $${ltMaxLossDraft} (초과 시 즉시 비상정지)`,
                `동시 포지션 ≤ 1개 (초과 시 신규 진입 차단)`,
                `레버리지 ≤ ${ltMaxLevDraft}× (초과 시 자동 축소)`,
                `서브그래프 연결 필요 (미연결 시 fail-closed)`,
                `기존 PendingLiveApproval 오퍼레이터 승인 게이트 유지`,
              ].map((rule, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                  <span className="text-amber-400 shrink-0 mt-0.5">•</span>
                  <span>{rule}</span>
                </div>
              ))}
            </div>
          </div>

        </Card>


      </section>

      {/* ── 핵심 리스크 한도 ── */}
      <section className="flex flex-col gap-4">
        <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-lg">
          <ShieldAlert className="w-5 h-5 text-primary" /> 핵심 리스크 한도
        </h2>
        <Card className="p-5 flex flex-col gap-5">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Strategy 페이지와 공유하는 핵심 리스크 한도입니다. 변경하면 즉시 DB에 저장되고
            새로고침·재시작 후에도 복원됩니다. DB에 값이 없으면 AI Worker 내장 기본값(%)이 자동 적용됩니다.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* maxDrawdownPercent */}
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">
                최대 드로다운 비율
                <span className="text-muted-foreground font-normal ml-1">(1~50 %)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1} max={50} step={1}
                  value={drawdownDraft}
                  onChange={e => setDrawdownDraft(Math.min(50, Math.max(1, Number(e.target.value))))}
                  onBlur={() => updateLimit('maxDrawdownPercent', drawdownDraft)}
                  className="w-24 h-8 px-2.5 rounded border border-border bg-card text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                <span className="text-[10px] text-muted-foreground">
                  DB: {limits.maxDrawdownPercent != null ? `${limits.maxDrawdownPercent}%` : '(기본 15%)'}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                자본 고점(HWM) 대비 손실이 이 비율을 초과하면 AI 사이클이 자동 정지됩니다.
              </p>
            </div>

            {/* dailyLossLimitUSDT */}
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">
                일일 최대 손실 한도
                <span className="text-muted-foreground font-normal ml-1">(USDT)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={10} max={100000} step={10}
                  value={dailyLossDraft}
                  onChange={e => setDailyLossDraft(Math.min(100_000, Math.max(10, Number(e.target.value))))}
                  onBlur={() => updateLimit('dailyLossLimitUSDT', dailyLossDraft)}
                  className="w-28 h-8 px-2.5 rounded border border-border bg-card text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                <span className="text-[10px] text-muted-foreground">
                  DB: {limits.dailyLossLimitUSDT != null ? `$${limits.dailyLossLimitUSDT.toLocaleString()}` : '(기본 $500)'}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                오늘 손실 합계가 이 한도를 초과하면 당일 신규 주문이 차단됩니다.
              </p>
            </div>
          </div>

          {/* Sync hint */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground border-t border-border/50 pt-3">
            <Database className="w-3 h-3 shrink-0" />
            <span>입력 필드에서 포커스 해제(Tab·클릭아웃)하면 DB에 저장됩니다 · 변경 이력 최근 10회 보관
              <span className="ml-2 text-[9px] opacity-60">(worker_state.limitsChangelog)</span>
            </span>
            {syncStatus === 'saving' && <Loader2 className="w-3 h-3 animate-spin ml-auto text-primary" />}
            {syncStatus === 'saved'  && <CheckCircle2 className="w-3 h-3 ml-auto text-[var(--color-long)]" />}
          </div>
        </Card>
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
              {/* GMX RPC URL 설정 여부 — URL 값은 절대 표시하지 않음 */}
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                health.rpcConfigured
                  ? 'border-primary/30 bg-primary/5 text-primary'
                  : 'border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)]',
              )}>
                {health.rpcConfigured
                  ? <CheckCircle2 className="w-3.5 h-3.5" />
                  : <AlertTriangle className="w-3.5 h-3.5" />}
                GMX_RPC_URL {health.rpcConfigured ? '설정됨' : '미설정 — LIVE TEST 차단'}
              </div>
              {/* Arbitrum RPC 연결 상태 */}
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium',
                health.gmxConnected
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {health.gmxConnected ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                Arbitrum RPC {health.gmxConnected ? '연결됨' : '연결 없음'}
                {health.lastRpcCheckAt && (
                  <span className="opacity-60 ml-1 font-normal">
                    · {formatElapsed(now - new Date(health.lastRpcCheckAt).getTime())}
                  </span>
                )}
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
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/50 text-muted-foreground text-[11px] font-medium" data-testid="text-cycle-confidence">
                      신뢰도 {formatConfidencePct(health.lastCycleResult.confidence)}
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

                // ── 불일치 감지: Worker가 마지막으로 적용한 값 vs 현재 UI 설정 ──────
                type MismatchRow = { label: string; worker: string; ui: string };
                const mismatches: MismatchRow[] = [];
                const checkNum = (key: keyof typeof limits, label: string, fmt: (v: number) => string, tol = 1) => {
                  const w = lim[key] ?? 0;
                  const u = Number((limits as unknown as Record<string, unknown>)[key] ?? 0);
                  if (Math.abs(w - u) > tol) mismatches.push({ label, worker: fmt(w), ui: fmt(u) });
                };
                checkNum('tradingCapital',   '트레이딩 자본',     v => `$${v.toLocaleString('en-US',{maximumFractionDigits:0})}`, 1);
                checkNum('maxDrawdownPercent','최대 드로다운',      v => `${v}%`, 0.01);
                checkNum('dailyLossLimitUSDT','일일 손실 한도',    v => `$${v}`, 1);
                checkNum('maxLeverage',       '최대 레버리지',     v => `${v}x`, 0.01);
                checkNum('maxTradesPerHour',  '시간당 최대 거래', v => `${v}건`, 0);
                checkNum('cooldownMinutes',   '쿨다운',           v => `${v}분`, 0);

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

                    {/* 불일치 경고 */}
                    {mismatches.length > 0 && (
                      <div className="mt-1 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          UI 설정과 Worker 마지막 적용값이 다릅니다 — 다음 사이클에서 자동 적용됩니다.
                        </div>
                        <div className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 text-[10px] pl-5">
                          <span className="text-muted-foreground font-semibold">항목</span>
                          <span className="text-muted-foreground font-semibold">Worker 적용값</span>
                          <span className="text-amber-300/80 font-semibold">현재 UI 설정</span>
                          {mismatches.map(m => (
                            <Fragment key={m.label}>
                              <span className="text-muted-foreground">{m.label}</span>
                              <span className="font-mono text-muted-foreground">{m.worker}</span>
                              <span className="font-mono text-amber-400 font-semibold">{m.ui}</span>
                            </Fragment>
                          ))}
                        </div>
                      </div>
                    )}
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

          {/* ── Web Push (VAPID) 구독 관리 ── */}
          <div className="border-t border-border/50 pt-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-primary" /> Web Push (VAPID)
                </span>
                <span className="text-[11px] text-muted-foreground">브라우저 닫힌 상태에서도 LIVE 승인 알림 수신</span>
              </div>
              {/* VAPID 서버 키 상태 배지 */}
              {vapidReady === null ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              ) : vapidReady ? (
                <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md border border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]">
                  <CheckCircle2 className="w-3 h-3" /> 서버 키 설정됨
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md border border-amber-500/30 bg-amber-500/5 text-amber-400">
                  <AlertCircle className="w-3 h-3" /> VAPID 미설정
                </span>
              )}
            </div>

            {/* 구독 상태 + 버튼 */}
            {!vapidReady && vapidReady !== null && (
              <p className="text-[11px] text-muted-foreground bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
                Web Push를 활성화하려면 서버에{' '}
                <code className="font-mono text-[10px] text-amber-300">VAPID_PUBLIC_KEY</code>·<code className="font-mono text-[10px] text-amber-300">VAPID_PRIVATE_KEY</code>{' '}
                환경 변수를 설정하세요.{' '}
                <span className="opacity-70">생성: <code className="font-mono text-[10px]">npx web-push generate-vapid-keys</code></span>
              </p>
            )}
            {vapidReady && (
              <div className="flex items-center justify-between gap-3">
                <span className={`text-[11px] font-semibold flex items-center gap-1 ${pushSubscribed ? 'text-[var(--color-long)]' : 'text-muted-foreground'}`}>
                  {pushSubscribed
                    ? <><CheckCircle2 className="w-3 h-3" /> 구독 중 — 서버 Push 활성</>
                    : <><XCircle className="w-3 h-3" /> 미구독</>}
                </span>
                {notificationPermission !== 'granted' ? (
                  <span className="text-[10px] text-amber-400">먼저 브라우저 알림 권한을 허용하세요</span>
                ) : pushSubscribed ? (
                  <Button
                    size="sm" variant="outline"
                    className="h-7 text-[11px] border-[var(--color-short)]/30 text-[var(--color-short)] hover:bg-[var(--color-short)]/5"
                    onClick={handlePushUnsubscribe} disabled={pushSubscribing}
                  >
                    {pushSubscribing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    구독 해제
                  </Button>
                ) : (
                  <Button
                    size="sm" variant="outline"
                    className="h-7 text-[11px] border-primary/30 text-primary hover:bg-primary/5"
                    onClick={handlePushSubscribe} disabled={pushSubscribing}
                  >
                    {pushSubscribing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Push 구독
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* ── 서버 알림 이력 ── */}
          {notifLog.length > 0 && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Database className="w-3 h-3" /> 서버 기록 (최근 {notifLog.length}건)
              </div>
              <div className="flex flex-col gap-1">
                {notifLog.map((e, i) => {
                  const statusColor =
                    e.status === 'sent'        ? 'text-[var(--color-long)]' :
                    e.status === 'denied'      ? 'text-[var(--color-short)]' :
                    e.status === 'unsupported' ? 'text-amber-400' :
                                                 'text-muted-foreground';
                  const statusLabel =
                    e.status === 'sent'        ? '✅ 전송됨' :
                    e.status === 'denied'      ? '🚫 권한 없음' :
                    e.status === 'unsupported' ? '⚠️ 미지원' : '오류';
                  const elapsed = formatElapsed(now - new Date(e.ts).getTime());
                  return (
                    <div key={i} className="flex items-center gap-2 text-[10px] px-2.5 py-1.5 rounded border border-border/50 bg-card/50">
                      <span className={cn('font-semibold shrink-0', statusColor)}>{statusLabel}</span>
                      <span className="text-muted-foreground truncate flex-1">{e.msg}</span>
                      <span className="text-muted-foreground shrink-0 opacity-60">{elapsed}</span>
                    </div>
                  );
                })}
              </div>
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

      {/* ── 운영자 검증 체크리스트 ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-1 flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Read-Only 연결 검증
        </h2>
        <Card className="overflow-hidden">
          {(
            [
              {
                label: 'MetaMask 설치됨',
                pass: !!(window as any).ethereum,
                note: !!(window as any).ethereum ? '감지됨' : '미설치',
              },
              {
                label: '주소 연결됨',
                pass: wallet.status === 'connected' || wallet.status === 'wrong_network',
                note: wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : '미연결',
              },
              {
                label: 'Arbitrum One 네트워크',
                pass: !!wallet.isArbitrum,
                note: wallet.chainId ? `Chain ${wallet.chainId}` : '감지 안됨',
              },
              {
                label: 'USDC 잔고 조회됨',
                pass: wallet.usdcBalance !== null,
                note: wallet.usdcBalance !== null
                  ? `$${parseFloat(wallet.usdcBalance).toFixed(2)}`
                  : '조회 실패',
              },
              {
                label: 'GMX 서브그래프 연결됨',
                pass: gmx.status === 'ok',
                note: gmx.status === 'loading' ? '조회 중…'
                    : gmx.status === 'unavailable' ? '연결 불가'
                    : '연결됨',
              },
              {
                label: 'AI Worker 실행 중',
                pass: health?.workerRunning === true,
                note: health
                  ? (health.workerRunning ? '실행 중' : '중단됨')
                  : 'API 응답 없음',
              },
              {
                label: 'Strategy 서버 동기화',
                pass: syncStatus === 'saved' || syncStatus === 'idle',
                note: syncStatus === 'saving' ? '저장 중…'
                    : syncStatus === 'error'   ? '동기화 실패'
                    : '동기화됨',
              },
              {
                label: 'LIVE 실행 잠금',
                pass: true,
                note: 'LIVE_EXECUTION_LOCKED = true',
              },
            ] as { label: string; pass: boolean; note: string }[]
          ).map((item, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center justify-between px-4 py-2.5 text-xs',
                i > 0 && 'border-t border-border/40',
              )}
            >
              <div className="flex items-center gap-2.5">
                {item.pass
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-long)] shrink-0" />
                  : <XCircle    className="w-3.5 h-3.5 text-[var(--color-short)] shrink-0" />
                }
                <span className={item.pass ? 'text-foreground' : 'text-muted-foreground'}>
                  {item.label}
                </span>
              </div>
              <span className={cn(
                'text-[10px] font-mono',
                item.pass
                  ? 'text-[var(--color-long)]/70'
                  : 'text-[var(--color-short)]/70',
              )}>
                {item.note}
              </span>
            </div>
          ))}
        </Card>
      </section>

      {/* ── Server Wallet Diagnostic ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-1 flex items-center gap-2">
          <Server className="w-3.5 h-3.5" />
          Server Wallet Diagnostic
          <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground/50">
            서버 메모리 전용 · 재시작 시 초기화 · 잔고 미전송
          </span>
        </h2>
        <Card className="overflow-hidden">
          {/* Header: stale indicator + manual refresh */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40 bg-muted/10">
            <div className="flex items-center gap-2 text-xs">
              {diagData?.present ? (
                diagData.stale
                  ? <span className="flex items-center gap-1.5 text-amber-400"><AlertCircle className="w-3.5 h-3.5" />Stale — 90초 이상 갱신 없음</span>
                  : <span className="flex items-center gap-1.5 text-[var(--color-long)]"><CheckCircle2 className="w-3.5 h-3.5" />Active</span>
              ) : (
                <span className="text-muted-foreground/50 text-[11px]">스냅샷 없음 — 지갑 연결 후 자동 수신</span>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={refreshDiag} disabled={diagLoading} className="h-7 text-xs gap-1">
              <RefreshCw className={cn('w-3 h-3', diagLoading && 'animate-spin')} />
              Refresh
            </Button>
          </div>

          {/* Diagnostic rows */}
          {diagData?.snapshot ? (() => {
            const s = diagData.snapshot;
            const rows: { label: string; pass: boolean; note: string }[] = [
              { label: 'Connected',       pass: s.walletConnected, note: s.addressFingerprint ?? '—' },
              { label: 'Arbitrum 42161',  pass: s.isArbitrum,      note: s.chainId != null ? `Chain ${s.chainId}` : '—' },
              { label: 'USDC read OK',    pass: s.usdcFetchOk,     note: s.usdcFetchOk ? '조회 성공' : '조회 실패' },
              { label: 'ETH read OK',     pass: s.ethFetchOk,      note: s.ethFetchOk  ? '조회 성공' : '조회 실패' },
              { label: 'GMX subgraph OK', pass: s.subgraphOk,      note: s.subgraphOk  ? '연결됨'   : '연결 불가' },
              { label: 'Position count',  pass: true,              note: String(s.positionCount) },
              {
                label: 'Last seen',
                pass:  !diagData.stale,
                note:  diagData.ageMs != null ? formatElapsed(diagData.ageMs) : '—',
              },
            ];
            return rows.map((item, i) => (
              <div key={i} className={cn('flex items-center justify-between px-4 py-2.5 text-xs border-t border-border/40')}>
                <div className="flex items-center gap-2.5">
                  {item.pass
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-long)] shrink-0" />
                    : <XCircle      className="w-3.5 h-3.5 text-[var(--color-short)] shrink-0" />}
                  <span className={item.pass ? 'text-foreground' : 'text-muted-foreground'}>{item.label}</span>
                </div>
                <span className={cn('text-[10px] font-mono', item.pass ? 'text-[var(--color-long)]/70' : 'text-[var(--color-short)]/70')}>
                  {item.note}
                </span>
              </div>
            ));
          })() : (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground/50">
              지갑을 연결하면 첫 30초 갱신 시 진단 데이터가 표시됩니다.
            </div>
          )}
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
