/**
 * SignerProvisionCard — Canary P0: LIVE 잠금을 풀지 않고 서버 delegated signer를
 * 명시적 1회 생성/조회하는 운영자 프로비저닝 카드.
 *
 * 오직 POST /api/executor/signer/provision 만 호출한다.
 * 서명·주문 준비/제출·Owner Approval·nonce/task/intent 생성·자금 이동을
 * 절대 수행하지 않으며, PIN은 컴포넌트 메모리에만 존재하고 요청 직전 즉시
 * 삭제된다 (저장·로그·자동 재시도 없음). 성공 시 공개주소만 표시한다.
 */

import { useCallback, useState } from 'react';
import { KeyRound, Loader2, CheckCircle2, ShieldAlert, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiUrl } from '@/lib/apiUrl';

interface ProvisionView {
  created: boolean;
  signerAddress: string;
  liveExecutionLocked: boolean;
}

export function SignerProvisionCard() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleProvision = useCallback(async () => {
    const p = pin.trim();
    setPin('');            // PIN 즉시 삭제 (요청 성공/실패 무관 — 자동 재시도 없음)
    setError(null);
    if (p.length < 6) { setError('운영자 PIN(6자 이상)을 입력하세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(apiUrl('executor/signer/provision'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-operator-pin': p },
        body: JSON.stringify({}),
      });
      const data: unknown = await res.json().catch(() => null);
      const d = (data ?? {}) as { ok?: boolean; error?: string; created?: boolean; signerAddress?: string; liveExecutionLocked?: boolean };
      if (res.status === 401) { setError('운영자 인증 실패 — PIN을 확인하세요.'); return; }
      if (res.status === 503) { setError('OPERATOR_MASTER_PIN이 서버에 설정되지 않았습니다 (fail-closed).'); return; }
      if (!res.ok || !d.ok || typeof d.signerAddress !== 'string') {
        setError(d.error ?? `프로비저닝 실패 (HTTP ${res.status})`);
        return;
      }
      setResult({
        created: d.created === true,
        signerAddress: d.signerAddress,
        liveExecutionLocked: d.liveExecutionLocked !== false,
      });
    } catch {
      setError('네트워크 오류 — 프로비저닝 결과를 확인하지 못했습니다. 다시 시도 전 signer 상태를 먼저 조회하세요.');
    } finally {
      setBusy(false);
    }
  }, [pin]);

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card/30" data-testid="card-signer-provision">
      <div className="flex items-center gap-2 flex-wrap">
        <KeyRound className="w-4 h-4 text-muted-foreground" />
        <span className="font-semibold text-sm">서버 Signer 프로비저닝 — 공개주소 1회 생성/조회</span>
        {result && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-bold border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]" data-testid="badge-provision-result">
            {result.created ? '신규 생성됨' : '기존 signer 확인됨'}
          </span>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Owner Approval에 필요한 delegated signer <strong className="text-foreground">공개주소</strong>를
        LIVE 잠금을 풀지 않은 상태에서 확보합니다. 이 버튼은{' '}
        <strong className="text-foreground">서명·주문 준비/제출·Owner Approval·자금 이동을 수행하지 않습니다.</strong>{' '}
        기존 signer가 있으면 새 키를 만들지 않고 동일 주소만 반환합니다.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="운영자 PIN"
          autoComplete="off"
          className="h-8 px-2 rounded border border-border bg-background text-xs w-36"
          data-testid="input-provision-pin"
        />
        <button
          onClick={() => void handleProvision()}
          disabled={busy || pin.trim().length < 6}
          className={cn('h-8 px-3 rounded text-xs font-semibold border',
            !busy && pin.trim().length >= 6
              ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
              : 'border-border bg-secondary text-muted-foreground cursor-not-allowed')}
          data-testid="button-signer-provision"
        >
          {busy
            ? <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> 처리 중…</span>
            : 'Signer 생성/조회'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)] text-[10px]" data-testid="text-provision-error">
          <ShieldAlert className="w-3 h-3 shrink-0" />
          {error}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-1.5 p-2 rounded border border-[var(--color-long)]/20 bg-[var(--color-long)]/5 text-[10px]" data-testid="text-provision-address">
          <div className="font-semibold text-[var(--color-long)] flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Signer 공개주소
          </div>
          <span className="font-mono break-all text-foreground">{result.signerAddress}</span>
          <div className="flex items-center gap-1 text-amber-400/90 font-semibold">
            <Lock className="w-3 h-3 shrink-0" /> LIVE 실행은 여전히 잠겨 있습니다 — 이 작업은 키 생성/조회만 수행했습니다.
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <Lock className="w-3 h-3 shrink-0" />
        PIN은 요청 직전 메모리에서 삭제되며 저장·로그·자동 재시도가 없습니다. 응답에는 공개주소만 포함됩니다.
      </div>
    </div>
  );
}
