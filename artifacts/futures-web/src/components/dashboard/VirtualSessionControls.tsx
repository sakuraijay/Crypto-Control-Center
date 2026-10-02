import { useState } from 'react';
import { Pause, Play, ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { apiUrl } from '@/lib/apiUrl';

export function VirtualSessionControls() {
  const { data, refresh } = useVirtualPaper400();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'START' | 'STOP'>('STOP');
  const active = data?.session.status === 'ACTIVE';
  const begin = () => { setAction(active ? 'STOP' : 'START'); setPin(''); setError(null); setOpen(true); };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !pin || !data || (action === 'START' && active) || (action === 'STOP' && !active)) return;
    setBusy(true); setError(null); const enteredPin = pin; setPin('');
    try {
      const response = await fetch(apiUrl('data/virtual-paper-400-session'), { method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-operator-pin': enteredPin }, body: JSON.stringify({ action }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(response.status === 401 ? '운영자 PIN을 확인해 주세요.' : '요청이 적용되지 않았습니다. 서버 상태를 확인해 주세요.');
      await refresh(); setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '요청 실패'); }
    finally { setBusy(false); }
  }
  return <>
    <Button className="ccc-session-action" variant={active ? 'outline' : 'default'} disabled={!data || busy} onClick={begin}>
      {active ? <Pause /> : <Play />} {active ? '신규 진입 중지' : '가상매매 시작'}
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) setPin(''); } }}>
      <DialogContent className="ccc-dialog">
        <div className="ccc-dialog-icon"><ShieldCheck size={24} /></div>
        <DialogHeader><DialogTitle>{action === 'STOP' ? '신규 진입을 중지할까요?' : '가상 자동매매 시작'}</DialogTitle>
          <DialogDescription>Virtual 400 가상 계정에만 적용됩니다. 실자금은 사용하지 않습니다.</DialogDescription></DialogHeader>
        <div className="ccc-callout">{action === 'STOP' ? '새로운 포지션 진입만 중지합니다. 기존 포지션의 손절·익절 보호는 계속됩니다.' : '서버에 저장된 설정으로 시작합니다. 기존 손익과 거래 기록은 그대로 유지됩니다.'}</div>
        <form onSubmit={event => void submit(event)} className="space-y-5">
          <label className="ccc-field-label">서버 운영자 PIN<input type="password" autoComplete="off" value={pin} onChange={event => setPin(event.target.value)} className="ccc-input mt-2" /></label>
          {error && <p role="alert" className="ccc-negative text-sm">{error}</p>}
          <div className="flex justify-end gap-2"><Button variant="ghost" type="button" disabled={busy} onClick={() => { setOpen(false); setPin(''); }}>취소</Button>
            <Button type="submit" disabled={busy || !pin || !data || (action === 'START' && active) || (action === 'STOP' && !active)}>
              {busy && <Loader2 className="animate-spin" />}{action === 'STOP' ? '중지 적용' : '시작 적용'}
            </Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
