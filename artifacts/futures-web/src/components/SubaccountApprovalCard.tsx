/**
 * SubaccountApprovalCard — GMX delegated trading 2단계 MetaMask owner approval UI.
 *
 * 흐름: 상태 조회 → 권한 요약 확인 → PIN 입력 → Prepare(서버가 canonical nonce로
 * typed data 생성) → 필드 검토 → MetaMask eth_signTypedData_v4 → 서명 제출.
 * 서명 취소는 오류가 아니며, revoke는 이 단계에서 비활성(온체인 제출 기능 없음).
 * 이 카드가 성공해도 LIVE 잠금은 절대 해제되지 않는다.
 */

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, RefreshCw, Loader2, PenLine, CheckCircle2, XCircle, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWallet } from '@/lib/context';
import {
  fetchSubaccountAuthDetailed, mapAuthFetchToDisplayState, postPrepareApproval, postApprovalSignature,
  mapAuthStateToView, canRequestOwnerSignature, canPrepareApproval, mapSignError, formatUnixSeconds,
  APPROVAL_GRANTS, APPROVAL_DENIALS,
  type SubaccountAuthResponse, type PrepareResponse,
} from '@/lib/subaccountApproval';


type Phase = 'idle' | 'preparing' | 'awaiting_signature' | 'submitting' | 'done';

export function SubaccountApprovalCard() {
  const wallet = useWallet();
  const [auth, setAuth] = useState<SubaccountAuthResponse | null>(null);
  // §2 — fetch 실패 종류별 표시 상태 ('OPERATOR_AUTH_REQUIRED'|'NOT_CONFIGURED'|'ERROR'|'UNVERIFIED'|null)
  const [fetchErrorState, setFetchErrorState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [prepared, setPrepared] = useState<PrepareResponse | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await fetchSubaccountAuthDetailed();
    if (r.kind === 'ok') {
      setAuth(r.data);
      setFetchErrorState(null);
    } else {
      setAuth(null);
      setFetchErrorState(mapAuthFetchToDisplayState(r));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const displayState = fetchErrorState ?? auth?.displayState ?? (auth ? auth.state : 'UNVERIFIED');
  const view = mapAuthStateToView(displayState);
  const guard = canRequestOwnerSignature({
    walletStatus: wallet.status,
    isArbitrum: wallet.isArbitrum,
    walletAddress: wallet.address,
    mainAccount: auth?.mainAccount ?? null,
  });
  // §5 — Prepare는 모든 조건 충족 전 비활성 (PIN만으로 진행 불가, fail-closed)
  const prepareGate = canPrepareApproval({ guard, auth, fetchErrorState });

  const handlePrepare = useCallback(async () => {
    setMessage(null);
    if (!prepareGate.ok) { setMessage({ tone: 'error', text: prepareGate.reasons.join(' · ') }); return; }
    if (pin.trim().length < 6) { setMessage({ tone: 'error', text: '운영자 PIN(6자 이상)을 입력하세요.' }); return; }
    setPhase('preparing');
    const r = await postPrepareApproval({ pin: pin.trim(), walletAddress: wallet.address! });
    if (!r.ok || !r.sessionId || !r.typedData) {
      setPhase('idle');
      setMessage({ tone: 'error', text: r.error ?? 'prepare 실패' });
      return;
    }
    setPrepared(r);
    setPhase('awaiting_signature');
    setMessage({ tone: 'warn', text: '아래 승인 내용을 확인한 뒤 MetaMask에서 서명하세요. 서명 전까지는 아무것도 저장되지 않습니다.' });
  }, [guard, pin, wallet.address]);

  const handleSign = useCallback(async () => {
    if (!prepared?.sessionId || !prepared.typedData) return;
    const g = canRequestOwnerSignature({
      walletStatus: wallet.status, isArbitrum: wallet.isArbitrum,
      walletAddress: wallet.address, mainAccount: auth?.mainAccount ?? null,
    });
    if (!g.ok) { setMessage({ tone: 'error', text: g.reason }); return; }
    const ethereum = (window as unknown as { ethereum?: { request: (a: { method: string; params: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!ethereum) { setMessage({ tone: 'error', text: 'MetaMask provider를 찾을 수 없습니다.' }); return; }
    setMessage(null);
    let signature: string;
    try {
      signature = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [wallet.address, JSON.stringify(prepared.typedData)],
      }) as string;
    } catch (err) {
      const m = mapSignError(err);
      setMessage({ tone: m.cancelled ? 'warn' : 'error', text: m.message });
      return;
    }
    setPhase('submitting');
    const r = await postApprovalSignature({ pin: pin.trim(), sessionId: prepared.sessionId, signature });
    if (!r.ok) {
      setPhase('awaiting_signature');
      setMessage({ tone: 'error', text: r.error ?? '서명 저장 실패' });
      return;
    }
    setPhase('done');
    setPrepared(null);
    setPin('');
    setMessage({ tone: 'ok', text: '서명이 안전하게 저장되었습니다 (OWNER_SIGNATURE_READY). 온체인 등록 전이므로 LIVE 실행은 계속 잠겨 있습니다.' });
    void refresh();
  }, [prepared, wallet, auth, pin, refresh]);

  const toneCls = {
    ok:    'border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]',
    warn:  'border-amber-500/40 bg-amber-500/10 text-amber-400',
    error: 'border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)]',
    muted: 'border-border bg-secondary text-muted-foreground',
  } as const;

  const summary = prepared?.summary;
  const oc = auth?.onchain ?? null;

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card/30" data-testid="card-subaccount-approval">
      {/* header */}
      <div className="flex items-center gap-2 flex-wrap">
        <ShieldCheck className="w-4 h-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Owner Approval (MetaMask 서명)</span>
        <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-bold', toneCls[view.tone])} data-testid="badge-approval-state">
          {view.label}
        </span>
        <button onClick={() => void refresh()} className="ml-auto p-1 rounded hover:bg-secondary" title="새로고침" data-testid="button-refresh-auth">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{view.description}</p>

      {/* 온체인/구성 요약 — fetch 실패 시 '미설정'으로 오표시하지 않는다 (§2) */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">Main wallet</span>
        <span className="font-mono truncate" data-testid="text-main-account">
          {fetchErrorState ? '확인 불가 (조회 실패)' : auth?.mainAccount ?? '미설정'}
        </span>
        <span className="text-muted-foreground">Subaccount (signer)</span>
        <span className="font-mono truncate">
          {fetchErrorState ? '확인 불가 (조회 실패)' : auth?.signerAddress ?? '미초기화'}
        </span>
        <span className="text-muted-foreground">Relay router</span>
        <span className="font-mono truncate">
          {fetchErrorState ? '확인 불가 (조회 실패)' : auth?.relayRouter ?? '미구성'}
        </span>
        <span className="text-muted-foreground">Chain</span>
        <span>Arbitrum One (42161)</span>
        {oc && (<>
          <span className="text-muted-foreground">온체인 만료</span>
          <span>{formatUnixSeconds(oc.expiresAt)}</span>
          <span className="text-muted-foreground">실행 횟수</span>
          <span>{oc.usedCount} / {oc.maxAllowedCount} (잔여 {oc.remaining})</span>
          <span className="text-muted-foreground">Approval nonce</span>
          <span className="font-mono">{oc.approvalNonce}</span>
          <span className="text-muted-foreground">Integration ID</span>
          <span className="font-mono truncate">{oc.integrationId}</span>
        </>)}
        {auth?.onchainError && (<>
          <span className="text-muted-foreground">온체인 조회</span>
          <span className="text-[var(--color-short)]">{auth.onchainError}</span>
        </>)}
        {auth?.readySession && (<>
          <span className="text-muted-foreground">저장된 서명</span>
          <span data-testid="text-ready-session">만료 {formatUnixSeconds(auth.readySession.expiresAt)} · 최대 {auth.readySession.maxAllowedCount}회 · nonce {auth.readySession.approvalNonce}</span>
        </>)}
      </div>

      {/* 권한 요약 */}
      <div className="grid sm:grid-cols-2 gap-2 text-[10px]">
        <div className="p-2 rounded border border-[var(--color-long)]/20 bg-[var(--color-long)]/5">
          <div className="font-semibold text-[var(--color-long)] mb-1 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> 이 서명으로 허용되는 것</div>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {APPROVAL_GRANTS.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </div>
        <div className="p-2 rounded border border-[var(--color-short)]/20 bg-[var(--color-short)]/5">
          <div className="font-semibold text-[var(--color-short)] mb-1 flex items-center gap-1"><XCircle className="w-3 h-3" /> 불가능한 것</div>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {APPROVAL_DENIALS.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </div>
      </div>

      {/* prepare / sign */}
      {phase !== 'awaiting_signature' && phase !== 'submitting' && (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="운영자 PIN"
            className="h-8 px-2 rounded border border-border bg-background text-xs w-36"
            data-testid="input-operator-pin"
          />
          <button
            onClick={() => void handlePrepare()}
            disabled={phase === 'preparing' || !prepareGate.ok}
            className={cn('h-8 px-3 rounded text-xs font-semibold border',
              prepareGate.ok ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20' : 'border-border bg-secondary text-muted-foreground cursor-not-allowed')}
            data-testid="button-prepare-approval"
          >
            {phase === 'preparing' ? '준비 중…' : '승인 준비 (Prepare)'}
          </button>
          {!prepareGate.ok && (
            <span className="text-[10px] text-muted-foreground" data-testid="text-prepare-blocked">
              {prepareGate.reasons[0]}{prepareGate.reasons.length > 1 ? ` 외 ${prepareGate.reasons.length - 1}건` : ''}
            </span>
          )}
          <button disabled className="h-8 px-3 rounded text-xs border border-border bg-secondary text-muted-foreground cursor-not-allowed" title="온체인 revoke는 다음 단계에서 지원됩니다" data-testid="button-revoke-disabled">
            Revoke (비활성)
          </button>
        </div>
      )}

      {(phase === 'awaiting_signature' || phase === 'submitting') && summary && (
        <div className="flex flex-col gap-2 p-3 rounded border border-amber-500/30 bg-amber-500/5">
          <div className="text-[11px] font-semibold text-amber-400 flex items-center gap-1"><PenLine className="w-3 h-3" /> 서명할 승인 내용</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
            <span className="text-muted-foreground">Subaccount</span><span className="font-mono truncate">{String(summary.subaccount)}</span>
            <span className="text-muted-foreground">만료(expiresAt)</span><span>{formatUnixSeconds(String(summary.expiresAt))}</span>
            <span className="text-muted-foreground">최대 실행 횟수</span><span>{String(summary.maxAllowedCount)}</span>
            <span className="text-muted-foreground">Nonce</span><span className="font-mono">{String(summary.nonce)}</span>
            <span className="text-muted-foreground">서명 유효기한(deadline)</span><span>{formatUnixSeconds(String(summary.deadline))}</span>
            <span className="text-muted-foreground">Router</span><span className="font-mono truncate">{String(summary.verifyingContract)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void handleSign()} disabled={phase === 'submitting'}
              className="h-8 px-3 rounded text-xs font-semibold border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
              data-testid="button-sign-approval">
              {phase === 'submitting' ? '저장 중…' : 'MetaMask로 서명'}
            </button>
            <button onClick={() => { setPhase('idle'); setPrepared(null); setMessage(null); }}
              className="h-8 px-3 rounded text-xs border border-border bg-secondary text-muted-foreground"
              data-testid="button-cancel-approval">
              취소
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className={cn('flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[10px]', toneCls[message.tone])} data-testid="text-approval-message">
          {message.tone === 'ok' ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <ShieldAlert className="w-3 h-3 shrink-0" />}
          {message.text}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <Lock className="w-3 h-3 shrink-0" />
        이 서명은 서버에 암호화되어 저장될 뿐, 온체인 제출·LIVE 잠금 해제는 수행하지 않습니다. 개인키·시드문구는 절대 입력하지 마세요.
      </div>
    </div>
  );
}
