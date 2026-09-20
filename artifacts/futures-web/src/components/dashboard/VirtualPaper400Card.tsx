import { useState } from 'react';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/apiUrl';

export function VirtualPaper400Card() {
  const { data, error: loadError, fresh, status, refresh } = useVirtualPaper400();
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
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
  const account = fresh ? data?.runtime?.account : null;
  const money = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} USDC` : '미확인';
  return <Card className="p-5 border-amber-500/40 bg-amber-500/5" aria-label="Virtual 400 paper account">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">가상 자동매매 · 400 USDC / PAPER</h2>
        <p className="text-xs text-muted-foreground mt-1">초기 가상자본 400 USDC · 실자금 사용 없음 · 비용과 체결은 SIMULATED / ESTIMATED</p></div>
      <span className="text-sm text-amber-500">{status}</span>
    </div>
    <p className="text-xs text-muted-foreground mt-3">설정과 실행 상태는 서버에 저장됩니다. 활성 세션은 웹페이지를 닫아도 서버에서 판단·매매·포지션 보호를 계속합니다.</p>
    {fresh && <p className="text-xs mt-2">마지막 서버 판단: {new Date(data!.runtime!.at).toLocaleString()} · 화면 갱신 10초</p>}
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
    {fresh && <details className="text-xs mb-4" open><summary className="cursor-pointer">종목별 신호·진입 판단</summary>
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
      <Button disabled={busy || !pin || !data || data.session.status === 'ACTIVE'} onClick={() => void act('START')}>가상매매 시작</Button>
      <Button variant="outline" disabled={busy || !pin || data?.session.status !== 'ACTIVE'} onClick={() => void act('STOP')}>신규 진입 중지</Button>
    </div>
    <p className="text-xs text-muted-foreground mt-3">중지 후에도 기존 포지션의 손절·익절 보호는 계속됩니다. 재시작해도 손익 기록은 유지됩니다.</p>
    {(error || loadError) && <p role="alert" className="text-sm text-red-500 mt-3">{error || loadError}</p>}
  </Card>;
}
