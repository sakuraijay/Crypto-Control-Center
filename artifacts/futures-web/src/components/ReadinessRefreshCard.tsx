/**
 * ReadinessRefreshCard — 6E-2 §3: Relay Readiness 읽기 전용 검증 카드.
 *
 * 오직 POST /api/executor/relay/readiness/refresh 만 호출한다.
 * 서명·주문·nonce 생성·task 생성을 절대 수행하지 않으며,
 * PIN은 컴포넌트 메모리에만 존재하고 요청 직후 즉시 삭제된다 (저장/로그 금지).
 */

import { useCallback, useState } from 'react';
import { RadioTower, Loader2, CheckCircle2, XCircle, ShieldAlert, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { postReadinessRefresh, type ReadinessRefreshView } from '@/lib/relayStatus';

const API_BASE = `${import.meta.env.BASE_URL}api/`;

export function ReadinessRefreshCard() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReadinessRefreshView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranAtMs, setRanAtMs] = useState<number | null>(null);

  const handleRefresh = useCallback(async () => {
    const p = pin.trim();
    setPin('');            // §3 — PIN 즉시 삭제 (요청 성공/실패 무관)
    setError(null);
    setResult(null);
    if (p.length < 6) { setError('운영자 PIN(6자 이상)을 입력하세요.'); return; }
    setBusy(true);
    const r = await postReadinessRefresh({ apiBase: API_BASE, pin: p });
    setBusy(false);
    setRanAtMs(Date.now());
    if (r.kind === 'auth') { setError('운영자 인증 실패 (HTTP 401/403) — PIN을 확인하세요. 환경변수 미설정이 아닙니다.'); return; }
    if (r.kind === 'not_configured') { setError('OPERATOR_MASTER_PIN이 서버에 설정되지 않았습니다 (HTTP 503) — 인증 실패와 다른 상태입니다.'); return; }
    if (r.kind === 'error') { setError(r.message); return; }
    setResult(r.refresh);
  }, [pin]);

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card/30" data-testid="card-readiness-refresh">
      <div className="flex items-center gap-2 flex-wrap">
        <RadioTower className="w-4 h-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Relay Readiness — 읽기 전용 검증</span>
        {result && (
          <span className={cn(
            'text-[9px] px-1.5 py-0.5 rounded-full border font-bold',
            result.ok
              ? 'border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-400',
          )} data-testid="badge-readiness-result">
            {result.ok ? '전 항목 확인됨' : '일부 확인 실패 (fail-closed)'}
          </span>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        canonical 승인·배포 코드·nonce/task 상태를 <strong className="text-foreground">읽기 전용</strong>으로 재검증합니다.
        이 버튼은 <strong className="text-foreground">서명·주문·nonce 생성·task 생성을 수행하지 않습니다.</strong>
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="운영자 PIN"
          autoComplete="off"
          className="h-8 px-2 rounded border border-border bg-background text-xs w-36"
          data-testid="input-readiness-pin"
        />
        <button
          onClick={() => void handleRefresh()}
          disabled={busy || pin.trim().length < 6}
          className={cn('h-8 px-3 rounded text-xs font-semibold border',
            !busy && pin.trim().length >= 6
              ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
              : 'border-border bg-secondary text-muted-foreground cursor-not-allowed')}
          data-testid="button-readiness-refresh"
        >
          {busy ? <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> 검증 중…</span> : '읽기 전용 상태 검증'}
        </button>
        {ranAtMs && !busy && (
          <span className="text-[10px] text-muted-foreground font-mono">
            {new Date(ranAtMs).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)] text-[10px]" data-testid="text-readiness-error">
          <ShieldAlert className="w-3 h-3 shrink-0" />
          {error}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-2">
          {result.basis.length > 0 && (
            <div className="p-2 rounded border border-[var(--color-long)]/20 bg-[var(--color-long)]/5 text-[10px]">
              <div className="font-semibold text-[var(--color-long)] mb-1 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> 확인된 항목
              </div>
              <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground" data-testid="list-readiness-basis">
                {result.basis.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
          {result.failures.length > 0 && (
            <div className="p-2 rounded border border-amber-500/25 bg-amber-500/5 text-[10px]">
              <div className="font-semibold text-amber-400 mb-1 flex items-center gap-1">
                <XCircle className="w-3 h-3" /> 확인 실패 (fail-closed — activation 차단 근거)
              </div>
              <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground" data-testid="list-readiness-failures">
                {result.failures.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {result.atMs && (
            <span className="text-[10px] text-muted-foreground font-mono">
              서버 기록 시각: {new Date(result.atMs).toLocaleString()}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <Lock className="w-3 h-3 shrink-0" />
        PIN은 이 화면 메모리에만 사용되고 요청 즉시 삭제됩니다 — 저장·로그되지 않습니다. LIVE 잠금 해제와 무관합니다.
      </div>
    </div>
  );
}
