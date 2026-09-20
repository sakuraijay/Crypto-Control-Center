import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/apiUrl';

interface Snapshot {
  ok: boolean;
  mode: 'VIRTUAL_PAPER_400';
  realFundsUsed: false;
  session: { status: 'ACTIVE' | 'STOPPED' | 'MISSING' | 'INVALID' };
  runtimeFresh: boolean;
  runtime: null | {
    policy?: { version: string; appliedAt: string; symbols: string[]; riskPerTradePct: number; maxLeverage: number; cooldownMinutes: number } | null;
    diagnostics?: { symbol: string; reason: string; details?: string[] }[];
    analysis?: { symbol: string; reason: string }[];
    journal?: { id: string; symbol: string; side: string; openedAt: string; closedAt: string;
      entryPrice: string; exitPrice: string; stopPrice: string; targetPrice: string | null;
      strategy: string | null; reasons: string[]; closeReason: string; grossPnlUsd: string; netPnlUsd: string;
      entryCostUsd: string | null; exitCostUsd: string | null; holdingCostUsd: string | null;
      plannedRiskUsd: number | null; netR: number | null; closeKind: string }[];
    status: string; reason: string | null; at: string;
    account: { equityUsd: number | null; unrealizedNetPnlUsd: number | null;
      ledger: { realizedEquityUsd: number; realizedNetPnlUsd: number; settlementCount: number };
      held: { id: string; symbol: string; side: string; sizeUsd: string; entryPrice: string;
        stopPrice: string; takeProfitPrice: string | null }[] };
  };
}

export function VirtualPaper400Card() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(apiUrl('data/virtual-paper-400-session'), { signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok || result.mode !== 'VIRTUAL_PAPER_400' || result.realFundsUsed !== false) {
        throw new Error('가상 계정 상태를 확인할 수 없습니다.');
      }
      if (!result.session || !['ACTIVE', 'STOPPED', 'MISSING'].includes(result.session.status)
        || (result.runtimeFresh === true && (!result.runtime?.account?.ledger
          || !Array.isArray(result.runtime.account.held)))) {
        throw new Error('가상 계정 증거 형식 오류');
      }
      if (!signal?.aborted) { setData(result); setError(null); }
    } catch {
      if (!signal?.aborted) { setData(null); setError('서버 연결을 확인해 주세요. 잔액·실행 상태 미확인.'); }
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  async function act(action: 'START' | 'STOP') {
    setBusy(true); setError(null);
    const enteredPin = pin; setPin('');
    try {
      const response = await fetch(apiUrl('data/virtual-paper-400-session'), { method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-operator-pin': enteredPin },
        body: JSON.stringify({ action }) });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(response.status === 401 ? '운영자 PIN을 확인해 주세요.' : '요청이 적용되지 않았습니다. 서버 상태를 확인해 주세요.');
      }
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '요청 실패'); }
    finally { setBusy(false); }
  }
  const fresh = !error && data?.runtimeFresh === true;
  const account = fresh ? data?.runtime?.account : null;
  const money = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} USDC` : '미확인';
  const status = data?.session.status === 'STOPPED' ? '신규 진입 중지'
    : data?.session.status === 'MISSING' ? '시작 전'
    : !fresh ? '서버 실행 확인 대기'
    : data?.runtime?.status === 'NO_TRADE' ? '관찰 중 · 신규 진입 없음'
    : data?.runtime?.status === 'BLOCKED' ? '위험 조건으로 진입 차단'
    : data?.runtime?.status ?? '미확인';
  return <Card className="p-5 border-amber-500/40 bg-amber-500/5" aria-label="Virtual 400 paper account">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">VIRTUAL 400 USDC / PAPER</h2>
        <p className="text-xs text-muted-foreground mt-1">초기 가상자본 400 USDC · 실자금 사용 없음 · 비용과 체결은 SIMULATED / ESTIMATED</p></div>
      <span className="text-sm text-amber-500">{status}</span>
    </div>
    {fresh && data?.runtime?.policy && <p className="text-xs mt-4" data-testid="virtual-active-policy">
      적극적 가상 매매 · {data.runtime.policy.symbols.join(' / ')} · 위험 예산 {data.runtime.policy.riskPerTradePct}%
      {' '}· 최대 {data.runtime.policy.maxLeverage}x · 진입 간격 {data.runtime.policy.cooldownMinutes}분
      <span className="block text-muted-foreground">{data.runtime.policy.version} · 적용 {new Date(data.runtime.policy.appliedAt).toLocaleString()}</span>
    </p>}
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4 my-5 text-sm">
      {[
        ['가상 정산 잔액', money(account?.ledger.realizedEquityUsd)],
        ['비용 차감 실현 손익', money(account?.ledger.realizedNetPnlUsd)],
        ['가상 평가자산', money(account?.equityUsd)],
        ['미실현 순손익 추정', money(account?.unrealizedNetPnlUsd)],
        ['정산 횟수', account ? String(account.ledger.settlementCount) : '미확인'],
      ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground text-xs">{label}</dt>
        <dd className="font-mono mt-1">{value}</dd></div>)}
    </dl>
    {account?.held.map(row => <p className="text-sm font-mono mb-2" key={row.id}>
      {row.symbol} {row.side} · {row.sizeUsd} USD · SL {row.stopPrice} · TP {row.takeProfitPrice ?? '없음'}
    </p>)}
    {fresh && data?.runtime?.reason && <p className="text-xs text-muted-foreground mb-3">{data.runtime.reason}</p>}
    {fresh && <details className="text-xs mb-4"><summary className="cursor-pointer">종목별 신호·진입 판단</summary>
      {[...(data?.runtime?.analysis ?? []), ...(data?.runtime?.diagnostics ?? [])].map((row, index) =>
        <p className="mt-2 break-words" key={index}>{row.symbol}: {row.reason}</p>)}
    </details>}
    {fresh && !!data?.runtime?.journal?.length && <details className="text-xs mb-4" open>
      <summary className="cursor-pointer">최근 가상 정산 · 비용은 추정치</summary>
      {data.runtime.journal.map(row => <div key={row.id} className="border-t mt-3 pt-3 space-y-1">
        <p>{row.symbol} {row.side} · {row.strategy ?? '전략 증거 미확인'} · {row.closeKind}</p>
        <p>{new Date(row.openedAt).toLocaleString()} → {new Date(row.closedAt).toLocaleString()}</p>
        <p>진입 {row.entryPrice} → 청산 {row.exitPrice} · SL {row.stopPrice} · TP {row.targetPrice ?? '없음'}</p>
        <p>총손익 {row.grossPnlUsd} · 순손익 {row.netPnlUsd} USDC · {row.netR?.toFixed(2) ?? '미확인'} R</p>
        <p>비용: 진입 {row.entryCostUsd ?? '미확인'} / 청산 {row.exitCostUsd ?? '미확인'} / 보유 {row.holdingCostUsd ?? '미확인'} USDC</p>
        <p>사전 위험 추정 {money(row.plannedRiskUsd)} · 청산 사유 {row.closeReason}</p>
        <p className="text-muted-foreground">{row.reasons.join(' · ') || '진입 근거 미확인'}</p>
      </div>)}
    </details>}
    <div className="flex flex-wrap gap-2 items-center">
      <label className="text-xs">서버 운영자 PIN <input type="password" autoComplete="off" value={pin}
        onChange={event => setPin(event.target.value)} className="ml-2 rounded border bg-background px-2 py-2 w-32" /></label>
      <Button disabled={busy || !pin || data?.session.status === 'ACTIVE'} onClick={() => void act('START')}>가상매매 시작</Button>
      <Button variant="outline" disabled={busy || !pin || data?.session.status !== 'ACTIVE'} onClick={() => void act('STOP')}>신규 진입 중지</Button>
    </div>
    <p className="text-xs text-muted-foreground mt-3">중지 후에도 기존 포지션의 손절·익절 보호는 계속됩니다. 재시작해도 손익 기록은 유지됩니다.</p>
    {error && <p role="alert" className="text-sm text-red-500 mt-3">{error}</p>}
  </Card>;
}
