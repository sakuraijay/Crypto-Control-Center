import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertCircle, Check, ChevronRight, CircleDollarSign,
  Database, Loader2, LockKeyhole, RefreshCw, ShieldCheck, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useGmxAccount } from '@/lib/context/GmxAccountContext';
import { useAuthContext } from '@/lib/context/AuthContext';
import { useStrategyContext } from '@/lib/context/StrategyContext';
import { useWallet } from '@/lib/context/WalletContext';
import { useExecutorOnlineStatus } from '@/hooks/useExecutorHealth';
import { deriveOnboardingReadiness } from '@/lib/onboardingReadiness';
import { cn } from '@/lib/utils';
import { apiUrl } from '@/lib/apiUrl';
import { parseObservedUsdcBalance } from '@/lib/paperTestAllocation';

const STORAGE_KEY = 'ccc_zero_config_onboarding_v1';

interface PaperTestAllocationPlan {
  totalAllocationUsd: number;
  reservePercent: number;
  reserveUsd: number;
  deployableUsd: number;
  walletEligibilityMinimumUsdc: number;
  futureActiveCapitalPolicyCandidate: {
    baseRiskPerTradeUsd: number;
    maxRiskPerTradeUsd: number;
    hardStopEquityUsd: number;
    maxLeverage: number;
    recommendedMaxMarginPerTradeUsd: number;
  };
  applied: false;
  executionAuthorized: false;
  autoActivationAllowed: false;
  runtimeDbHwmUnchanged: true;
}

function effectiveBoolean(
  value: { effective?: boolean; status?: string } | undefined,
): boolean | null {
  return value?.status === 'MATCH' && typeof value.effective === 'boolean'
    ? value.effective
    : null;
}

function StatusRow({
  ready,
  checking = false,
  label,
  detail,
}: {
  ready: boolean;
  checking?: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-border/70 bg-secondary/30 px-3 py-2.5"
      data-testid={`status-autopilot-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
        ready
          ? 'border-[var(--color-long)]/50 bg-[var(--color-long)]/10 text-[var(--color-long)]'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-400',
      )}>
        {checking
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : ready
            ? <Check className="h-3 w-3" />
            : <AlertCircle className="h-3 w-3" />}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-foreground">{label}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

export function OnboardingOverlay() {
  const { isAuthenticated } = useAuthContext();
  const wallet = useWallet();
  const gmx = useGmxAccount();
  const executor = useExecutorOnlineStatus();
  const { limits, indicators } = useStrategyContext();
  const [acknowledgedAddress, setAcknowledgedAddress] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [switchingNetwork, setSwitchingNetwork] = useState(false);
  const [paperTestPlan, setPaperTestPlan] = useState<PaperTestAllocationPlan | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void fetch(apiUrl('/risk/policy'))
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { paperTestAllocationPlan?: PaperTestAllocationPlan };
        if (!cancelled && body.paperTestAllocationPlan?.applied === false
          && body.paperTestAllocationPlan.executionAuthorized === false
          && body.paperTestAllocationPlan.autoActivationAllowed === false
          && body.paperTestAllocationPlan.runtimeDbHwmUnchanged === true) {
          setPaperTestPlan(body.paperTestAllocationPlan);
        }
      })
      .catch(() => {
        if (!cancelled) setPaperTestPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const flags = executor.snapshot?.operationalDiagnostics?.flags;
  const readiness = deriveOnboardingReadiness({
    walletStatus: wallet.status,
    isArbitrum: wallet.isArbitrum,
    gmxStatus: gmx.status,
    gmxApiConsistency: gmx.apiConsistency,
    balancesLoaded: wallet.ethBalance !== null && wallet.usdcBalance !== null,
    executor: {
      observed: executor.lastSuccessAt !== null && executor.snapshot !== null,
      offline: executor.isOffline || executor.isStale,
      ready: executor.snapshot?.ready === true,
      engineMode: executor.snapshot?.engineMode ?? null,
      rpcConfigured: executor.snapshot?.rpcConfigured === true,
      gmxConnected: executor.snapshot?.gmxConnected === true,
      networkChainId: executor.snapshot?.networkChainId ?? null,
      autoWorkerLiveEnabled: effectiveBoolean(flags?.autoWorkerLiveEnabled),
      relaySubmissionEnabled: effectiveBoolean(flags?.relaySubmissionEnabled),
      relaySubmitNetworkEnabled: effectiveBoolean(flags?.relaySubmitNetworkEnabled),
      relayMode: flags?.relayMode?.status === 'MATCH'
        ? flags.relayMode.effective ?? null
        : null,
    },
    dismissedInStorage: wallet.address !== null
      && acknowledgedAddress === wallet.address.toLowerCase(),
  });

  const deployableCapital = useMemo(
    () => limits.tradingCapital * (1 - limits.reserveCashPct / 100),
    [limits.reserveCashPct, limits.tradingCapital],
  );
  const walletUsdc = parseObservedUsdcBalance(wallet.usdcBalance);
  const showPaperTestPlan = paperTestPlan !== null
    && walletUsdc !== null
    && Number.isFinite(walletUsdc)
    && walletUsdc >= paperTestPlan.walletEligibilityMinimumUsdc;

  const switchToArbitrum = async () => {
    const provider = (window as {
      ethereum?: {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
    }).ethereum;
    if (!provider) return;
    setSwitchingNetwork(true);
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xa4b1' }],
      });
    } catch (error) {
      if ((error as { code?: number }).code === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xa4b1',
              chainName: 'Arbitrum One',
              nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://arb1.arbitrum.io/rpc'],
              blockExplorerUrls: ['https://arbiscan.io'],
            }],
          });
        } catch {
          // A rejected wallet confirmation is never treated as consent.
        }
      }
    } finally {
      setSwitchingNetwork(false);
      await wallet.refreshChainStatus();
    }
  };

  const enterPaperMode = () => {
    if (!readiness.isFullyReady) return;
    if (!wallet.address) return;
    const address = wallet.address.toLowerCase();
    try {
      localStorage.setItem(STORAGE_KEY, address);
    } catch {
      // The current session may continue without manufacturing persisted readiness.
    }
    setAcknowledgedAddress(address);
  };

  if (!isAuthenticated) return null;
  if (!readiness.shouldShowOnboarding) return null;

  const isChecking = readiness.phase === 'checking';
  const enabledIndicatorCount = indicators.filter((indicator) => indicator.enabled).length;

  return (
    <div
      className="fixed inset-0 z-[150] overflow-y-auto bg-background/95 backdrop-blur-xl"
      data-testid="overlay-zero-config-autopilot"
    >
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[8%] top-[12%] h-80 w-80 rounded-full bg-primary/10 blur-[110px]" />
        <div className="absolute bottom-[8%] right-[8%] h-72 w-72 rounded-full bg-accent/5 blur-[120px]" />
      </div>

      <main className="relative mx-auto flex min-h-full w-full max-w-5xl items-center px-4 py-8 sm:px-6">
        <section className="grid w-full overflow-hidden rounded-2xl border border-border bg-card shadow-2xl lg:grid-cols-[1.05fr_0.95fr]">
          <div className="flex flex-col justify-between border-b border-border p-6 sm:p-8 lg:border-b-0 lg:border-r">
            <div>
              <div className="mb-8 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-primary">Zero-Config Autopilot</div>
                  <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">지갑만 연결하면 준비는 자동입니다</h1>
                </div>
              </div>

              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                주소와 잔액을 읽고, Arbitrum·GMX·RPC·PAPER 엔진과 안전 잠금을 자동 점검합니다.
                개인키를 요구하거나 거래를 승인하지 않으며, 실제 자금은 움직이지 않습니다.
              </p>

              <div className="mt-8">
                {readiness.phase === 'connect_wallet' && (
                  <div className="rounded-xl border border-primary/25 bg-primary/5 p-5">
                    <Wallet className="mb-4 h-7 w-7 text-primary" />
                    <h2 className="text-base font-semibold">먼저 지갑을 연결해 주세요</h2>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      공개 주소와 잔액만 읽습니다. 서명, 승인, 주문, 자금 이동은 요청하지 않습니다.
                    </p>
                    <Button
                      className="mt-5 w-full sm:w-auto"
                      disabled={wallet.status === 'connecting' || wallet.status === 'no_provider'}
                      onClick={() => void wallet.connect()}
                      data-testid="button-connect-wallet"
                    >
                      {wallet.status === 'connecting'
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Wallet className="mr-2 h-4 w-4" />}
                      {wallet.status === 'no_provider' ? '호환 지갑이 필요합니다' : '지갑 연결'}
                    </Button>
                  </div>
                )}

                {readiness.phase === 'switch_network' && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
                    <RefreshCw className="mb-4 h-7 w-7 text-amber-400" />
                    <h2 className="text-base font-semibold">Arbitrum One 확인이 필요합니다</h2>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      네트워크 변경은 지갑이 사용자 확인을 요구합니다. 확인하지 않으면 아무것도 변경되지 않습니다.
                    </p>
                    <Button
                      className="mt-5 w-full sm:w-auto"
                      disabled={switchingNetwork}
                      onClick={() => void switchToArbitrum()}
                      data-testid="button-switch-network"
                    >
                      {switchingNetwork
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <RefreshCw className="mr-2 h-4 w-4" />}
                      Arbitrum으로 전환
                    </Button>
                  </div>
                )}

                {(readiness.phase === 'checking' || readiness.phase === 'blocked') && (
                  <div className="rounded-xl border border-border bg-secondary/25 p-5">
                    {isChecking
                      ? <Loader2 className="mb-4 h-7 w-7 animate-spin text-primary" />
                      : <AlertCircle className="mb-4 h-7 w-7 text-amber-400" />}
                    <h2 className="text-base font-semibold">
                      {isChecking ? '안전한 PAPER 환경을 자동 점검 중입니다' : '연결 상태를 확인하고 있습니다'}
                    </h2>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {isChecking
                        ? '별도 설정은 필요하지 않습니다. 모든 확인은 조회 전용입니다.'
                        : '준비되지 않은 항목은 자동으로 통과시키지 않습니다. 연결이 복구되면 다시 판정합니다.'}
                    </p>
                  </div>
                )}

                {readiness.phase === 'ready' && (
                  <div className="rounded-xl border border-[var(--color-long)]/30 bg-[var(--color-long)]/5 p-5">
                    <ShieldCheck className="mb-4 h-7 w-7 text-[var(--color-long)]" />
                    <h2 className="text-base font-semibold">PAPER Autopilot 준비 완료</h2>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      실제 주문 없이 시뮬레이션과 모니터링을 시작할 수 있습니다. LIVE는 계속 잠겨 있습니다.
                    </p>
                    <Button
                      className="mt-5 w-full sm:w-auto"
                      onClick={enterPaperMode}
                      data-testid="button-enter-paper"
                    >
                      PAPER 대시보드 시작
                      <ChevronRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <p className="mt-8 flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              온체인 서명, Owner Approval, subaccount authorization, LIVE 해제는 자동화하지 않습니다.
              필요한 경우 별도의 명시적 확인 한 단계로만 요청합니다.
            </p>
          </div>

          <div className="p-6 sm:p-8">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">자동 준비 진단</div>
                <div className="mt-1 text-[11px] text-muted-foreground">실제 응답이 확인된 항목만 완료 처리합니다</div>
              </div>
              <span className="rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-[10px] font-bold text-primary">
                PAPER ONLY
              </span>
            </div>

            <div className="space-y-2">
              <StatusRow
                ready={readiness.isWalletReady && readiness.areBalancesReady}
                checking={wallet.status === 'connecting'}
                label="지갑 · 주소 · 잔액"
                detail={wallet.address
                  ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)} · ETH/USDC 조회 ${readiness.areBalancesReady ? '완료' : '대기'}`
                  : '지갑 연결 대기'}
              />
              <StatusRow
                ready={readiness.isChainReady}
                label="네트워크"
                detail={readiness.isChainReady ? 'Arbitrum One · Chain 42161' : 'Arbitrum One 확인 필요'}
              />
              <StatusRow
                ready={readiness.isDataReady}
                checking={gmx.status === 'idle' || gmx.status === 'loading'}
                label="GMX · 데이터 · RPC"
                detail={readiness.isDataReady
                  ? `RPC/API 일치 · 현재 포지션 ${gmx.positions.length}개`
                  : 'RPC와 공식 GMX API 일치 여부 확인 중'}
              />
              <StatusRow
                ready={readiness.isEngineReady}
                checking={executor.lastSuccessAt === null}
                label="PAPER 엔진"
                detail={readiness.isEngineReady ? '서버 연결 정상 · PAPER 모드 확인' : '서버 PAPER 상태 확인 중'}
              />
              <StatusRow
                ready={readiness.areSafetyDefaultsReady}
                checking={executor.lastSuccessAt === null}
                label="안전 잠금"
                detail={readiness.areSafetyDefaultsReady
                  ? 'AUTO LIVE 꺼짐 · Relay 꺼짐 · LIVE 미승인'
                  : '안전 플래그 확인 중 또는 기준 불일치'}
              />
            </div>

            <div className="mt-6 rounded-xl border border-border bg-background/40 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <CircleDollarSign className="h-4 w-4 text-accent" />
                자동 선택된 안전 기본값
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[11px]">
                <div>
                  <dt className="text-muted-foreground">운용 자본</dt>
                  <dd className="mt-0.5 font-mono text-foreground">${limits.tradingCapital.toLocaleString()} PAPER</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">보호 예비금</dt>
                  <dd className="mt-0.5 font-mono text-foreground">{limits.reserveCashPct}% · ${deployableCapital.toLocaleString()} 운용</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">리스크</dt>
                  <dd className="mt-0.5 font-mono text-foreground">{limits.maxLeverage}x · 최대 {limits.maxSimultaneousPositions} 포지션</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">전략</dt>
                  <dd className="mt-0.5 font-mono text-foreground">검증 필터 {enabledIndicatorCount}개</dd>
                </div>
              </dl>
            </div>

            <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                <Database className="h-4 w-4" />
                Cost · Stop · Canary
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                PAPER에서는 실행 권한으로 평가하지 않습니다. 비용 상한, 보호 Stop, Canary는 LIVE 준비 시
                최신 증거와 사용자 승인을 다시 확인하며 지금은 잠금 상태입니다.
              </p>
            </div>

            {showPaperTestPlan && (
              <div className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4" data-testid="onboarding-paper-test-allocation">
                <div className="flex items-center gap-2 text-xs font-semibold text-sky-300">
                  <CircleDollarSign className="h-4 w-4" />
                  PAPER TEST ALLOCATION · proposed/approved plan
                </div>
                <p className="mt-2 text-[11px] text-foreground">
                  ${paperTestPlan.totalAllocationUsd} total = ${paperTestPlan.deployableUsd} deployable
                  {' '}+ ${paperTestPlan.reserveUsd} reserve ({paperTestPlan.reservePercent}%)
                </p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  향후 후보: risk ${paperTestPlan.futureActiveCapitalPolicyCandidate.baseRiskPerTradeUsd}
                  /${paperTestPlan.futureActiveCapitalPolicyCandidate.maxRiskPerTradeUsd}
                  {' '}· Hard Stop ${paperTestPlan.futureActiveCapitalPolicyCandidate.hardStopEquityUsd}
                  {' '}· {paperTestPlan.futureActiveCapitalPolicyCandidate.maxLeverage}x
                  {' '}· max margin ${paperTestPlan.futureActiveCapitalPolicyCandidate.recommendedMaxMarginPerTradeUsd}
                </p>
                <p className="mt-2 text-[10px] font-semibold text-sky-300">
                  미적용 · runtime/DB/HWM unchanged · 자동 activation/실행 권한 없음
                </p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}