/**
 * RiskPolicyCard — Planned/Active/Reserve를 분리한 운용 정책 표시.
 *
 * 데이터 소스: GET /api/risk/policy (서버 코드 상수 — UI에서 변경 불가).
 * API 실패 시 "Unavailable" + 거래 차단(fail-closed) 안내를 표시하고
 * 가짜 기본값을 렌더링하지 않는다.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Loader2, RefreshCw, Clock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/apiUrl';

interface RiskPolicyResponse {
  paperTestAllocationPlan: {
    totalAllocationUsd: number;
    reservePercent: number;
    reserveUsd: number;
    deployableUsd: number;
    futureActiveCapitalPolicyCandidate: {
      baseRiskPerTradeUsd: number;
      maxRiskPerTradeUsd: number;
      hardStopEquityUsd: number;
      maxLeverage: number;
      recommendedMaxMarginPerTradeUsd: number;
    };
    applied: false;
    executionAuthorized: false;
    runtimeDbHwmUnchanged: true;
  };
  capital: {
    plannedSeedCapitalUsd: number;
    activeTradingCapitalUsd: number;
    reserveCapitalPercent: number;
    reserveCapitalUsd: number;
    deployableActiveCapitalUsd: number;
    riskSizingCapitalUsd: number;
    riskSizingReserveUsd: number;
    riskSizingReservePercent: number;
    currentRiskEquityUsd: number | null;
    equityHwmUsd: number | null;
    onchainBalanceUsd: number | null;
    onchainBalanceAuthoritative: boolean;
    monthlyNetReturnReferenceRangePercent: readonly [number, number];
  };
  policy: {
    initialCapitalUsd: number;
    maxRiskCapitalUsd: number;
    primaryProfitTargetPercent: number;
    absoluteProfitCapPercent: number;
    protectedProfitFloorPercent: number;
    baseRiskPerTradePercent: number;
    maxRiskPerTradePercent: number;
    defensiveModeLossPercent: number;
    dailyMaxLossPercent: number;
    weeklyMaxLossPercent: number;
    hardStopEquityUsd: number;
    baseMaxLeverage: number;
    conditionalMaxLeverage: number;
    conditional5xEnabled: boolean;
    maxConcurrentPositions: number;
    maxDailyEntries: number;
    maxConsecutiveLosses: number;
    tradingTimezone: string;
  };
  canary: {
    canaryMaxCapitalAtRiskUsd: number;
    canaryMaxCumulativeLossUsd: number;
    canaryMaxLeverage: number;
  };
  autoPromotionAllowed: boolean;
  derived: {
    primaryProfitTargetUsd: number;
    absoluteProfitCapUsd: number;
    dailyMaxLossUsd: number;
    protectedProfitFloorUsd: number;
    defensiveModeLossUsd: number;
    weeklyMaxLossUsd: number;
    baseRiskPerTradeUsd: number;
    absoluteMaxRiskPerTradeUsd: number;
  };
  state: {
    riskOperatingState: string | null;
    riskEntryAllowed: boolean;
    riskBlockReasons: string[];
    currentHardStopPolicyEquityUsd: number;
    historicalHardStopTriggerReason: string | null;
    riskDbOk: boolean;
    dailyEntryCount: number | null;
    consecutiveLossCount: number | null;
  };
  manila: { msUntilNextDay: number };
}

const STATE_COLORS: Record<string, string> = {
  NORMAL: 'text-[var(--color-long)]',
  DEFENSIVE: 'text-amber-400',
  PROFIT_PROTECTED: 'text-sky-400',
  PROFIT_TARGET_LOCKED: 'text-sky-400',
  PROFIT_CAP_LOCKED: 'text-sky-400',
  DAILY_LOSS_LOCKED: 'text-red-400',
  WEEKLY_LOSS_LOCKED: 'text-red-400',
  CONSECUTIVE_LOSS_LOCKED: 'text-red-400',
  HARD_STOPPED: 'text-red-500',
  UNRESOLVED: 'text-red-500',
};

function fmtCountdown(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}시간 ${m}분`;
}

export function RiskPolicyCard() {
  const [data, setData] = useState<RiskPolicyResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/risk/policy'));
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json() as RiskPolicyResponse);
      setError(false);
    } catch {
      setData(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return (
      <Card className="p-5 border-red-500/40">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert className="w-4 h-4 text-red-400" />
          <h3 className="text-sm font-semibold">운용 정책 (Risk Policy)</h3>
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" onClick={() => void load()}>
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
        <p className="text-xs text-red-400 font-semibold">Unavailable — 정책 조회 실패</p>
        <p className="text-[10px] text-muted-foreground mt-1">
          RiskEngine은 fail-closed로 동작합니다: 정책·상태 미확인 시 신규 진입이 차단됩니다.
        </p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 운용 정책 로드 중…
        </div>
      </Card>
    );
  }

  const { policy: p, capital, derived: d, state: s, canary, manila, paperTestAllocationPlan: testPlan } = data;
  const stateLabel = s.riskOperatingState ?? '미평가';
  const stateColor = STATE_COLORS[s.riskOperatingState ?? ''] ?? 'text-muted-foreground';

  const rows: Array<[string, string]> = [
    ['Planned Seed', `$${capital.plannedSeedCapitalUsd.toLocaleString()} (계획 기준 · 입금/승격 권한 아님)`],
    ['PAPER Test Allocation', `$${testPlan.totalAllocationUsd} total = $${testPlan.deployableUsd} deployable + $${testPlan.reserveUsd} reserve (${testPlan.reservePercent}%) · proposed/approved plan`],
    ['400 후보 Risk / Hard Stop', `$${testPlan.futureActiveCapitalPolicyCandidate.baseRiskPerTradeUsd} 기본 · $${testPlan.futureActiveCapitalPolicyCandidate.maxRiskPerTradeUsd} 최대 · equity $${testPlan.futureActiveCapitalPolicyCandidate.hardStopEquityUsd} · margin $${testPlan.futureActiveCapitalPolicyCandidate.recommendedMaxMarginPerTradeUsd}`],
    ['400 적용 상태', '미적용 · runtime/DB/HWM unchanged · 실행 권한 없음'],
    ['Approved Active / Reserve', `$${capital.activeTradingCapitalUsd.toLocaleString()} / $${capital.reserveCapitalUsd.toLocaleString()} (${capital.reserveCapitalPercent}%)`],
    ['Current Risk Sizing / Reserve', `$${capital.riskSizingCapitalUsd.toLocaleString()} / $${capital.riskSizingReserveUsd.toLocaleString()} (${capital.riskSizingReservePercent}%) · 승인 단계 이하`],
    ['Current Equity / HWM', `${capital.currentRiskEquityUsd === null ? 'Unavailable' : `$${capital.currentRiskEquityUsd.toLocaleString()}`} / ${capital.equityHwmUsd === null ? 'Unavailable' : `$${capital.equityHwmUsd.toLocaleString()}`} · RiskEngine 관측 상태`],
    ['On-chain balance', capital.onchainBalanceAuthoritative ? `$${capital.onchainBalanceUsd?.toLocaleString()}` : '별도 GMX RPC 카드에서 확인'],
    ['단계', '$1,000 → $2,500 → $5,000 → $10,000 · 증거+사용자 승인 필수'],
    ['일일 과열 경계 (+5%)', `$${d.primaryProfitTargetUsd.toFixed(0)} — 신규 진입 억제, 수익 목표 아님`],
    ['일일 절대 과열 상한 (+10%)', `$${d.absoluteProfitCapUsd.toFixed(0)} — 전량 청산 + 당일 잠금`],
    ['월 순수익 참고치', `${capital.monthlyNetReturnReferenceRangePercent[0]}~${capital.monthlyNetReturnReferenceRangePercent[1]}% — 보장/강제 목표 아님`],
    ['이익 보호 floor (+3.5%)', `$${d.protectedProfitFloorUsd.toFixed(0)} — 후퇴 시 전량 종료`],
    ['거래당 위험', `$${d.baseRiskPerTradeUsd.toFixed(2)} 기본 · $${d.absoluteMaxRiskPerTradeUsd.toFixed(2)} 최대 (${p.baseRiskPerTradePercent}%/${p.maxRiskPerTradePercent}%)`],
    ['Defensive Mode (-0.5%)', `-$${d.defensiveModeLossUsd.toFixed(0)} — size 50% · 2x · 잔여 1회`],
    ['일일 손실 한도 (-1%)', `-$${d.dailyMaxLossUsd.toFixed(0)} — 당일 거래 종료`],
    ['주간 손실 한도 (-8%)', `-$${d.weeklyMaxLossUsd.toFixed(0)} — 주간 잠금 (일일 reset 무관)`],
    ['현재 Hard Stop 정책 기준', `equity ≤ $${s.currentHardStopPolicyEquityUsd} — 현재 authoritative 기준 · 자동 해제 없음`],
    ['레버리지', `기본 ${p.baseMaxLeverage}x — 조건부 ${p.conditionalMaxLeverage}x ${p.conditional5xEnabled ? '활성' : '비활성'}`],
    ['동시 포지션 / 일일 진입', `${p.maxConcurrentPositions}개 / ${p.maxDailyEntries}회`],
    ['연속 손실 중단', `${p.maxConsecutiveLosses}회`],
    ['금지 사항', '마틴게일 · 물타기 · 추격 진입 · 자동 복리'],
    ['거래일 기준', `${p.tradingTimezone} 00:00 (주간: 월요일)`],
    ['LIVE Canary 한도', `자본 ≤ $${canary.canaryMaxCapitalAtRiskUsd} · 누적손실 ≤ $${canary.canaryMaxCumulativeLossUsd} · ${canary.canaryMaxLeverage}x · 수동 승인`],
    ['자동 승급', data.autoPromotionAllowed ? '허용' : '금지 (운영자 명시 승인 필요)'],
  ];

  return (
    <Card className="p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">자본·위험 정책 — Planned $10,000 / Active $1,000</h3>
        <span className={`ml-auto text-xs font-bold font-mono ${stateColor}`}>{stateLabel}</span>
      </div>

      {!s.riskEntryAllowed && s.riskBlockReasons.length > 0 && (
        <div className="text-[10px] rounded border border-amber-500/40 bg-amber-500/8 p-2 text-amber-300">
          진입 차단: {s.riskBlockReasons.join(' · ')}
        </div>
      )}
      {s.historicalHardStopTriggerReason && (
        <div className="text-[10px] rounded border border-red-500/40 bg-red-500/8 p-2 text-red-300">
          <span className="font-semibold">과거 HARD_STOP 발동 스냅샷:</span>{' '}
          {s.historicalHardStopTriggerReason}
          <span className="block mt-1 text-muted-foreground">
            상태 발생 당시 기록이며 현재 정책 기준은 아래 별도 행을 따릅니다.
          </span>
        </div>
      )}
      {!s.riskDbOk && (
        <div className="text-[10px] rounded border border-red-500/40 bg-red-500/8 p-2 text-red-400 font-semibold">
          RiskEngine 상태 영속화 실패 — fail-closed로 신규 진입 차단 중
        </div>
      )}

      <div className="grid grid-cols-1 gap-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-[11px] border-b border-border/30 pb-1">
            <span className="text-muted-foreground shrink-0">{k}</span>
            <span className="text-right font-mono">{v}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground pt-1">
        <Clock className="w-3 h-3" />
        <span>다음 Manila 거래일까지 {fmtCountdown(manila.msUntilNextDay)}</span>
        <span className="ml-auto">
          오늘 진입 {s.dailyEntryCount ?? '–'}/{p.maxDailyEntries} · 연속손실 {s.consecutiveLossCount ?? '–'}/{p.maxConsecutiveLosses}
        </span>
      </div>
    </Card>
  );
}
