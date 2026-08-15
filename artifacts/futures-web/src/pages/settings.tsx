import { useState, useEffect } from 'react';
import { useAppContext, useAuthContext, useTradingContext, useWallet } from '@/lib/context';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ShieldAlert, Server, Lock, AlertTriangle, AlertOctagon, Info, CheckCircle2, XCircle, Cpu, Loader2, Wallet, Key, FlaskConical, ChevronRight, AlertCircle, RefreshCw, Bell, BellOff, ExternalLink } from 'lucide-react';
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
      const res = await fetch('/api/executor/status');
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
  const wallet = useWallet();
  const { notificationPermission, requestNotificationPermission } = useAiEngine();

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
            const isConnected = wallet.status === 'connected' && wallet.isArbitrum;
            const isWrongNet  = wallet.status === 'wrong_network';
            const isConnecting = wallet.status === 'connecting';
            const borderColor = isConnected
              ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5'
              : isWrongNet
                ? 'border-amber-500/30 bg-amber-500/5'
                : 'border-border bg-card/30';
            const circleColor = isConnected
              ? 'border-[var(--color-long)] text-[var(--color-long)]'
              : 'border-border text-muted-foreground';

            return (
              <div className={cn('flex items-start gap-4 p-4 rounded-lg border', borderColor)}>
                <div className={cn('flex items-center justify-center w-7 h-7 rounded-full border-2 font-bold text-xs shrink-0 mt-0.5', circleColor)}>
                  {isConnected ? '✓' : '2'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
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

                  {isConnected ? (
                    /* ── 연결됨 — 주소 + 잔고 표시 ── */
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
                  ) : (
                    /* ── 미연결 / 오류 ── */
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">
                        MetaMask 등 브라우저 지갑으로 내 GMX 계정 주소를 연결합니다.
                        <strong className="text-foreground"> read-only 조회 전용 — 서명·개인키 접근 없음.</strong>
                        {' '}개인키·시드문구는 브라우저 지갑 내부에 보관되며 서버로 전송되지 않습니다.
                      </p>
                      {wallet.status === 'no_provider' ? (
                        <p className="text-xs text-amber-400 mb-2">
                          <AlertCircle className="inline w-3 h-3 mr-1" />
                          MetaMask 또는 EIP-1193 호환 지갑이 설치되어 있지 않습니다.
                        </p>
                      ) : isWrongNet ? (
                        <p className="text-xs text-amber-400 mb-2">
                          <AlertCircle className="inline w-3 h-3 mr-1" />
                          Arbitrum One(Chain 42161)으로 네트워크를 전환해주세요.
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
            <div className="text-xs text-muted-foreground">Executor status unavailable</div>
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
