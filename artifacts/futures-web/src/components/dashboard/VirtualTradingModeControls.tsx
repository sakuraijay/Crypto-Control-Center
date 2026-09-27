import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { apiUrl } from '@/lib/apiUrl';

type Mode = 'INTRADAY' | 'SWING';
export function VirtualTradingModeControls() {
  const { data, refresh } = useVirtualPaper400();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Mode | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = data?.tradingModeSelection;
  const options = data?.tradingModeOptions;
  const selected = selection && options?.[selection.mode];
  function begin() {
    setDraft(selection?.mode ?? null); setExpected(selection?.updatedAt ?? null);
    setPin(''); setError(null); setOpen(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pin || !draft || busy || !data) return;
    setBusy(true); setError(null); const enteredPin = pin; setPin('');
    try {
      const response = await fetch(apiUrl('data/virtual-paper-400-trading-mode'), { method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-operator-pin': enteredPin },
        body: JSON.stringify({ mode: draft, expectedUpdatedAt: expected }) });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (response.status === 409) { await refresh(); throw new Error('서버 설정이 변경되었습니다. 창을 닫고 다시 선택해 주세요.'); }
        throw new Error(response.status === 401 ? '운영자 PIN을 확인해 주세요.' : '설정이 저장되지 않았습니다. 서버 상태를 확인해 주세요.');
      }
      await refresh(); setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '저장 실패'); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 space-y-3" aria-label="가상 매매 방식">
    <p className="text-sm">다음 진입: <strong>{selected?.label ?? '서버 설정 확인 대기'}</strong>
      {selected && <span className="block mt-1 text-xs text-muted-foreground">{selected.exitBasis === 'PAPER_EXPERIMENT_PRICE_TARGET' ? '적극적 PAPER 시험 · 손실 포함 기록' : selected.exitBasis === 'STRATEGY_PRICE_TARGET' ? '익절: 전략 가격' : `시험 익절 ${selected.targetRoePct}%`} · 증거금 손절 상한 {selected.stopRoePct}% · 최대 {selected.maxHoldHours}시간</span>}</p>
    <Button variant="outline" className="w-full" onClick={begin} disabled={!options || !data || !['ACTIVE','STOPPED'].includes(data.session.status)}>매매 방식 선택</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) setPin(''); } }}>
      <DialogContent className="ccc-dialog sm:max-w-[620px]">
        <DialogHeader><DialogTitle>매매 방식 선택</DialogTitle><DialogDescription>
          {selected?.exitBasis === 'PAPER_EXPERIMENT_PRICE_TARGET' ? '적극적 PAPER 시험 · 실제 시세로 손실까지 기록합니다. 검증된 전략 수익이나 수익 보장이 아닙니다.' : 'PAPER · 계좌 일수익 목표 5–10%는 미검증 목표입니다. 거래별 익절은 전략 가격, 손절률은 포지션 증거금 기준입니다.'}
        </DialogDescription></DialogHeader>
        <form onSubmit={event => void submit(event)} className="space-y-4">
          <fieldset disabled={busy} className="space-y-3"><legend className="sr-only">단타 또는 중기 스윙</legend>
            {(['INTRADAY','SWING'] as const).map(mode => options?.[mode] && <label key={mode}
              className={`flex gap-3 items-center rounded-lg border p-4 cursor-pointer ${draft === mode ? 'border-primary bg-primary/10' : 'border-border'}`}>
              <input type="radio" name="tradingMode" value={mode} checked={draft === mode} onChange={() => setDraft(mode)} />
              <span><strong>{options[mode].label} · 최대 {options[mode].maxHoldHours < 1 ? `${options[mode].maxHoldHours*60}분` : `${options[mode].maxHoldHours}시간`}</strong>
                <span className="block text-sm text-muted-foreground">{options[mode].exitBasis === 'PAPER_EXPERIMENT_PRICE_TARGET' ? '미검증 모멘텀 시험 · 가격 목표 익절' : options[mode].exitBasis === 'STRATEGY_PRICE_TARGET' ? '전략 가격 익절 · 비용 반영 순손익비 1.5 이상' : `시험 익절 ${options[mode].targetRoePct}%`} / 증거금 손절 상한 {options[mode].stopRoePct}%</span></span>
            </label>)}
          </fieldset>
          <div className="ccc-callout">저장한 선택은 다음 신규 진입부터 적용됩니다. 기존 포지션은 진입 당시 설정으로 보호합니다. 스윙도 손절·익절은 1일 전에 작동할 수 있습니다. 계좌 위험 한도가 우선하며, 급변·체결 비용으로 손실이 초과될 수 있습니다.</div>
          <label className="ccc-field-label">서버 운영자 PIN<input type="password" autoComplete="off" value={pin} onChange={event => setPin(event.target.value)} className="ccc-input mt-2" /></label>
          {error && <p role="alert" className="ccc-negative text-sm">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setPin(''); }}>취소</Button>
            <Button type="submit" disabled={!pin || !draft || busy || !data}>{busy ? '저장 중…' : '다음 진입에 적용'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
