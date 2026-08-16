/**
 * RelayStatusCard — GMX delegated trading 3단계 Gelato relay DRY-RUN 상태 UI.
 *
 * 표시: relay 모드(DRY-RUN 전용/비활성), 게이트 차단 사유, canonical 상태,
 * fee quote(mock), 최근 relay task 이력, revoke(owner 서명) 흐름.
 *
 * UI 계약: DRY_RUN_VALIDATED·TASK_ACCEPTED를 성공처럼 표시하지 않는다.
 * 이 카드에서 실행되는 어떤 동작도 온체인 제출·LIVE 실행을 유발하지 않는다.
 */

import { useCallback, useEffect, useState } from 'react';
import { Radio, RefreshCw, Loader2, ShieldAlert, CheckCircle2, PenLine, Lock, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWallet } from '@/lib/context';
import { canRequestOwnerSignature, mapSignError, formatUnixSeconds } from '@/lib/subaccountApproval';
import {
  fetchRelayStatus, postRevokePrepare, postRevokeSignature, postRevokeCancel, postRevokeDryRun,
  fetchUnresolvedTasks, postUnresolvedRecheck, fetchActivationStatus,
  mapRelayModeToView, mapRelayTaskStatusToView, formatWeiToEth,
  type RelayStatusResponse, type DryRunView, type UnresolvedTaskView, type ActivationStatusResponse,
} from '@/lib/relayStatus';

const API_BASE = `${import.meta.env.BASE_URL}api/`;

type RevokePhase = 'idle' | 'preparing' | 'awaiting_signature' | 'submitting';

const toneCls = {
  ok:    'border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]',
  warn:  'border-amber-500/40 bg-amber-500/10 text-amber-400',
  error: 'border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)]',
  muted: 'border-border bg-secondary text-muted-foreground',
} as const;

export function RelayStatusCard() {
  const wallet = useWallet();
  const [status, setStatus] = useState<RelayStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<RevokePhase>('idle');
  const [prepared, setPrepared] = useState<{ sessionId: string; typedData: unknown; summary?: Record<string, string> } | null>(null);
  const [dryRun, setDryRun] = useState<DryRunView | null>(null);
  const [unresolved, setUnresolved] = useState<UnresolvedTaskView[]>([]);
  const [activation, setActivation] = useState<ActivationStatusResponse | null>(null);
  const [recheckBusy, setRecheckBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    // status 엔드포인트도 운영자 인증 필요 — PIN 없이는 조회하지 않음
    const p = pin.trim();
    if (p.length < 6) { setStatus(null); setUnresolved([]); setActivation(null); setLoading(false); return; }
    setLoading(true);
    const [s, u, a] = await Promise.all([
      fetchRelayStatus(API_BASE, p),
      fetchUnresolvedTasks(API_BASE, p),
      fetchActivationStatus(API_BASE, p),
    ]);
    setStatus(s);
    setUnresolved(u ?? []);
    setActivation(a);
    setLoading(false);
  }, [pin]);

  const handleRecheck = useCallback(async (taskId: string) => {
    setRecheckBusy(taskId);
    const r = await postUnresolvedRecheck({ apiBase: API_BASE, pin: pin.trim(), taskId });
    setRecheckBusy(null);
    if (!r.ok) { setMessage({ tone: 'error', text: r.error ?? '재조회 실패' }); return; }
    setMessage({
      tone: r.rechecked ? 'ok' : 'warn',
      text: r.rechecked ? '증거를 재수집했습니다 — 상태는 증거 기반으로만 전이됩니다.' : (r.reason ?? '재수집 불가 — 상태 유지'),
    });
    void refresh();
  }, [pin, refresh]);

  useEffect(() => { void refresh(); }, [refresh]);

  const modeView = mapRelayModeToView(status?.mode ?? 'DISABLED');
  const guard = canRequestOwnerSignature({
    walletStatus: wallet.status,
    isArbitrum: wallet.isArbitrum,
    walletAddress: wallet.address,
    mainAccount: null, // 아래에서 canonical 미확인 시에도 prepare는 서버가 검증
  });
  const pinOk = pin.trim().length >= 6;

  const handleRevokePrepare = useCallback(async () => {
    setMessage(null);
    if (!pinOk) { setMessage({ tone: 'error', text: '운영자 PIN(6자 이상)을 입력하세요.' }); return; }
    setPhase('preparing');
    const r = await postRevokePrepare({ apiBase: API_BASE, pin: pin.trim() });
    if (!r.ok || !r.sessionId || !r.typedData) {
      setPhase('idle');
      setMessage({ tone: 'error', text: r.error ?? 'revoke prepare 실패' });
      return;
    }
    setPrepared({ sessionId: r.sessionId, typedData: r.typedData, summary: r.summary });
    setPhase('awaiting_signature');
    setMessage({ tone: 'warn', text: 'RemoveSubaccount 내용을 확인한 뒤 메인 지갑(MetaMask)으로 서명하세요. 서명해도 온체인 제출은 되지 않습니다(DRY-RUN 단계).' });
    void refresh();
  }, [pin, pinOk, refresh]);

  const handleRevokeSign = useCallback(async () => {
    if (!prepared) return;
    if (wallet.status !== 'connected' || !wallet.isArbitrum || !wallet.address) {
      setMessage({ tone: 'error', text: 'Arbitrum One에 연결된 메인 지갑이 필요합니다.' });
      return;
    }
    const ethereum = (window as unknown as { ethereum?: { request: (a: { method: string; params: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!ethereum) { setMessage({ tone: 'error', text: 'MetaMask provider를 찾을 수 없습니다.' }); return; }
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
    const r = await postRevokeSignature({ apiBase: API_BASE, pin: pin.trim(), sessionId: prepared.sessionId, signature });
    if (!r.ok) {
      setPhase('awaiting_signature');
      setMessage({ tone: 'error', text: r.error ?? '서명 저장 실패' });
      return;
    }
    setPhase('idle');
    setPrepared(null);
    setMessage({ tone: 'ok', text: 'revoke 서명이 저장되었습니다 (OWNER_SIGNATURE_READY). 온체인 제출은 이번 단계에서 수행되지 않으며, revoke 세션이 활성인 동안 신규 주문 relay는 차단됩니다.' });
    void refresh();
  }, [prepared, wallet, pin, refresh]);

  const handleRevokeCancel = useCallback(async () => {
    const sessionId = prepared?.sessionId ?? status?.revokeSession?.sessionId;
    if (!sessionId) { setPhase('idle'); setPrepared(null); return; }
    const r = await postRevokeCancel({ apiBase: API_BASE, pin: pin.trim(), sessionId });
    setPhase('idle');
    setPrepared(null);
    setMessage(r.ok ? { tone: 'ok', text: 'revoke 세션이 취소되었습니다.' } : { tone: 'error', text: r.error ?? '취소 실패' });
    void refresh();
  }, [prepared, status, pin, refresh]);

  const handleRevokeDryRun = useCallback(async () => {
    if (!pinOk) { setMessage({ tone: 'error', text: '운영자 PIN(6자 이상)을 입력하세요.' }); return; }
    setMessage(null);
    const r = await postRevokeDryRun({ apiBase: API_BASE, pin: pin.trim() });
    if (!r.ok || !r.dryRun) { setMessage({ tone: 'error', text: r.error ?? 'dry-run 실패' }); return; }
    setDryRun(r.dryRun);
  }, [pin, pinOk]);

  const revoke = status?.revokeSession ?? null;
  const quote = status?.feeQuote ?? null;

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card/30" data-testid="card-relay-status">
      {/* header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Radio className="w-4 h-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Gelato Relay (DRY-RUN 전용)</span>
        <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-bold', toneCls[modeView.tone])} data-testid="badge-relay-mode">
          {modeView.label}
        </span>
        <button onClick={() => void refresh()} className="ml-auto p-1 rounded hover:bg-secondary" title="새로고침" data-testid="button-refresh-relay">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Gelato relay 제출 경로의 검증 전용 상태입니다. LIVE 제출은 이번 단계에서 구조적으로 비활성이며,
        어떤 dry-run 결과도 실제 주문·서명 제출을 의미하지 않습니다.
      </p>

      {/* mode / gate */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">제출 기능</span>
        <span data-testid="text-submission-enabled">{status?.submissionEnabled ? '환경변수 활성 (DRY-RUN 한정)' : '비활성 (기본)'}</span>
        <span className="text-muted-foreground">LIVE 제출</span>
        <span className="text-[var(--color-short)]" data-testid="text-live-disabled">구조적으로 비활성 (이번 단계)</span>
        <span className="text-muted-foreground">Canonical 확인</span>
        <span data-testid="text-canonical">{status?.canonical.confirmed
          ? `확인됨 (nonce ${status.canonical.approvalNonce ?? '—'}, 잔여 ${status.canonical.remaining ?? '—'})`
          : (status?.canonical.reason ?? '미확인')}</span>
        {quote && (<>
          <span className="text-muted-foreground">Fee quote (mock)</span>
          <span data-testid="text-fee-quote">
            {formatWeiToEth(quote.feeAmount)} · {quote.valid ? '검증 통과' : `거부: ${quote.invalidReason}`}
          </span>
        </>)}
      </div>

      {status && status.gate.blockReasons.length > 0 && (
        <div className="p-2 rounded border border-border bg-secondary/50 text-[10px]" data-testid="list-gate-reasons">
          <div className="font-semibold text-muted-foreground mb-1 flex items-center gap-1"><Ban className="w-3 h-3" /> 차단 사유</div>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {status.gate.blockReasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* revoke 흐름 */}
      <div className="flex flex-col gap-2 p-3 rounded border border-border bg-secondary/30">
        <div className="text-[11px] font-semibold flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Subaccount Revoke (owner 서명)</div>
        {revoke ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]" data-testid="text-revoke-session">
            <span className="text-muted-foreground">세션 상태</span>
            <span className={cn(revoke.status === 'OWNER_SIGNATURE_READY' ? 'text-amber-400' : 'text-muted-foreground')}>
              {revoke.status === 'OWNER_SIGNATURE_READY' ? '서명 저장됨 (제출 전)' : revoke.status}
            </span>
            <span className="text-muted-foreground">Subaccount</span><span className="font-mono truncate">{revoke.subaccount}</span>
            <span className="text-muted-foreground">서명 유효기한</span><span>{formatUnixSeconds(revoke.deadline)}</span>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">활성 revoke 세션 없음. revoke를 준비하면 신규 주문 relay가 차단됩니다.</p>
        )}

        {phase !== 'awaiting_signature' && phase !== 'submitting' && (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="password" value={pin} onChange={(e) => setPin(e.target.value)}
              placeholder="운영자 PIN"
              className="h-8 px-2 rounded border border-border bg-background text-xs w-36"
              data-testid="input-relay-pin"
            />
            <button onClick={() => void handleRevokePrepare()} disabled={phase === 'preparing'}
              className="h-8 px-3 rounded text-xs font-semibold border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
              data-testid="button-revoke-prepare">
              {phase === 'preparing' ? '준비 중…' : 'Revoke 준비'}
            </button>
            <button onClick={() => void handleRevokeDryRun()}
              className="h-8 px-3 rounded text-xs border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
              data-testid="button-revoke-dryrun">
              Revoke Dry-run
            </button>
            {revoke && (
              <button onClick={() => void handleRevokeCancel()}
                className="h-8 px-3 rounded text-xs border border-border bg-secondary text-muted-foreground"
                data-testid="button-revoke-cancel">
                세션 취소
              </button>
            )}
            {!guard.ok && <span className="text-[10px] text-muted-foreground">{guard.reason !== '서버에 main wallet(GMX_WALLET_ADDRESS)이 설정되지 않았습니다.' ? guard.reason : ''}</span>}
          </div>
        )}

        {(phase === 'awaiting_signature' || phase === 'submitting') && prepared && (
          <div className="flex flex-col gap-2 p-2 rounded border border-amber-500/30 bg-amber-500/5">
            <div className="text-[11px] font-semibold text-amber-400 flex items-center gap-1"><PenLine className="w-3 h-3" /> 서명할 RemoveSubaccount 내용</div>
            {prepared.summary && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                <span className="text-muted-foreground">Subaccount</span><span className="font-mono truncate">{prepared.summary.subaccount}</span>
                <span className="text-muted-foreground">Fee (mock)</span><span>{formatWeiToEth(prepared.summary.feeAmount)}</span>
                <span className="text-muted-foreground">서명 유효기한</span><span>{formatUnixSeconds(prepared.summary.deadline)}</span>
                <span className="text-muted-foreground">Router</span><span className="font-mono truncate">{prepared.summary.verifyingContract}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => void handleRevokeSign()} disabled={phase === 'submitting'}
                className="h-8 px-3 rounded text-xs font-semibold border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                data-testid="button-revoke-sign">
                {phase === 'submitting' ? '저장 중…' : 'MetaMask로 서명'}
              </button>
              <button onClick={() => void handleRevokeCancel()}
                className="h-8 px-3 rounded text-xs border border-border bg-secondary text-muted-foreground"
                data-testid="button-revoke-abort">
                취소
              </button>
            </div>
          </div>
        )}
      </div>

      {/* revoke dry-run 결과 */}
      {dryRun && (
        <div className="p-2 rounded border border-border bg-secondary/30 text-[10px]" data-testid="text-revoke-dryrun-result">
          <div className="font-semibold mb-1">Revoke Dry-run 결과 (제출 아님)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span className="text-muted-foreground">검증</span>
            <span className={dryRun.ok ? 'text-amber-400' : 'text-[var(--color-short)]'}>
              {dryRun.ok ? '통과 — 제출은 비활성' : '차단됨'}
            </span>
            <span className="text-muted-foreground">Calldata hash</span><span className="font-mono truncate">{dryRun.calldataHash ?? '—'}</span>
            <span className="text-muted-foreground">서명 주체</span><span>{dryRun.signerRole === 'OWNER' ? 'Owner (메인 지갑)' : dryRun.signerRole ?? '—'}</span>
          </div>
          {dryRun.blockReasons.length > 0 && (
            <ul className="list-disc pl-4 mt-1 space-y-0.5 text-muted-foreground">
              {dryRun.blockReasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Activation 체크리스트 (5단계 §9) — 표시 전용, 어떤 부작용도 없음 */}
      {activation?.statusFlags && (() => {
        const f = activation.statusFlags;
        const rows: Array<{ key: string; label: string; blocked: boolean; detail?: string | null }> = [
          { key: 'code', label: '코드 준비 (Code ready)', blocked: !f.codeReady },
          { key: 'ro-network', label: 'Read-only 네트워크 (조회 전용)', blocked: f.readonlyNetworkDisabled, detail: f.readonlyNetworkDisabled ? 'GMX_RELAY_READONLY_NETWORK_ENABLED 미설정' : null },
          { key: 'submit-network', label: 'Submit 네트워크 (제출 transport)', blocked: f.submitNetworkDisabled, detail: f.submitNetworkDisabled ? 'GMX_RELAY_NETWORK_ENABLED 미설정' : null },
          { key: 'submission', label: 'Submission 기능 승인', blocked: f.submissionDisabled, detail: f.submissionDisabled ? 'GMX_RELAY_SUBMISSION_ENABLED 미설정' : null },
          { key: 'mode', label: `Relay 모드: ${f.relayMode}`, blocked: f.relayMode !== 'LIVE', detail: f.relayMode !== 'LIVE' ? '실제 제출은 LIVE 모드에서만' : null },
          { key: 'signer', label: 'Delegated signer 활성', blocked: f.signerDisabled },
          { key: 'canonical', label: 'Canonical 승인 검증', blocked: f.canonicalUnverified, detail: f.canonicalReason },
          { key: 'recon', label: 'Reconciliation 완료', blocked: f.reconciliationIncomplete, detail: f.reconciliationReasons[0] ?? null },
          { key: 'quote', label: 'Live fee quote 신선', blocked: f.liveQuoteMissing, detail: f.liveQuoteReasons[0] ?? null },
          { key: 'revoke', label: 'Revoke 미진행', blocked: f.revokeActive, detail: f.revokeActive ? '활성 revoke 세션 — 신규 주문 차단' : null },
          { key: 'unresolved', label: 'UNRESOLVED 없음', blocked: f.unresolvedPresent, detail: f.unresolvedPresent ? `${f.unresolvedCount}건 조사 필요` : null },
          { key: 'lock', label: 'LIVE 잠금 해제', blocked: f.liveLocked, detail: f.liveLocked ? 'LIVE_TEST_EXECUTION_LOCKED — 유지 중' : null },
        ];
        const refresh = f.lastReadinessRefresh;
        return (
          <div className="flex flex-col gap-1.5 p-3 rounded border border-border bg-secondary/30" data-testid="list-activation-checklist">
            <div className="text-[11px] font-semibold text-muted-foreground">Activation 체크리스트 (진단 전용)</div>
            {refresh && (
              <div className="text-[10px] text-muted-foreground" data-testid="text-readiness-refresh">
                Readiness 갱신: {refresh.attempted && refresh.atMs
                  ? `${new Date(refresh.atMs).toLocaleString()} — ${refresh.ok ? '성공' : `실패(fail-closed): ${refresh.failures[0] ?? ''}`}`
                  : '미수행 (명시적 refresh 필요)'}
              </div>
            )}
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-2 text-[10px]">
                <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-bold shrink-0', r.blocked ? toneCls.muted : toneCls.ok)}>
                  {r.blocked ? '차단' : 'OK'}
                </span>
                <span>{r.label}</span>
                {r.detail && <span className="text-muted-foreground/70 truncate">— {r.detail}</span>}
              </div>
            ))}
            <div className={cn('mt-1 px-2.5 py-1.5 rounded border text-[10px] font-semibold',
              f.readyForControlledCanary ? toneCls.warn : toneCls.muted)}
              data-testid="text-canary-readiness">
              {f.readyForControlledCanary
                ? 'Ready for controlled canary — 모든 전제 조건 충족 (표시 전용, 자동 제출 없음)'
                : '통제된 canary 준비 미완료 — 상단 차단 항목 해소 필요'}
            </div>
          </div>
        );
      })()}

      {/* 최근 task */}
      {status && status.recentTasks.length > 0 && (
        <div className="flex flex-col gap-1 text-[10px]" data-testid="list-relay-tasks">
          <div className="font-semibold text-muted-foreground">최근 Relay Task</div>
          {status.recentTasks.slice(0, 8).map((t) => {
            const v = mapRelayTaskStatusToView(t.status);
            return (
              <div key={t.id} className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-muted-foreground">{t.kind}</span>
                <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-bold', toneCls[v.tone])}>{v.label}</span>
                <span className="text-muted-foreground">{new Date(t.createdAt).toLocaleString()}</span>
                {t.errorClass && <span className="text-[var(--color-short)]">{t.errorClass}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* UNRESOLVED 조사 (4단계) — 증거 재수집만 가능, 강제 종결·재제출 없음 */}
      {unresolved.length > 0 && (
        <div className="flex flex-col gap-2 p-3 rounded border border-[var(--color-short)]/40 bg-[var(--color-short)]/5" data-testid="list-unresolved-tasks">
          <div className="text-[11px] font-semibold text-[var(--color-short)] flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> UNRESOLVED 조사 필요 ({unresolved.length}건) — 해소 전 신규 제출 차단
          </div>
          {unresolved.map((t) => (
            <div key={t.id} className="flex flex-col gap-1 p-2 rounded border border-border bg-background/50 text-[10px]">
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <span className="text-muted-foreground">Intent/Task</span>
                <span className="font-mono truncate">{t.id}{t.relayTaskId ? ` / ${t.relayTaskId}` : ''}</span>
                <span className="text-muted-foreground">Purpose</span><span>{t.kind}</span>
                <span className="text-muted-foreground">시각</span>
                <span>{new Date(t.createdAt).toLocaleString()} → {new Date(t.updatedAt).toLocaleString()}</span>
                <span className="text-muted-foreground">txHash</span><span className="font-mono truncate">{t.txHash ?? '미확보'}</span>
                <span className="text-muted-foreground">orderKey</span><span className="font-mono truncate">{t.orderKey ?? '미확보'}</span>
                <span className="text-muted-foreground">마지막 판정</span><span>{t.resolutionBasis ?? '—'}</span>
                <span className="text-muted-foreground">오류 분류</span><span>{t.errorClass ?? '—'}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-1">
                <button
                  onClick={() => void handleRecheck(t.id)}
                  disabled={recheckBusy === t.id}
                  className="h-7 px-2.5 rounded text-[10px] border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                  data-testid={`button-recheck-${t.id}`}
                >
                  {recheckBusy === t.id ? '재조회 중…' : '증거 재수집'}
                </button>
                {t.links.arbiscanTx && (
                  <a href={t.links.arbiscanTx} target="_blank" rel="noreferrer" className="underline text-muted-foreground">Arbiscan</a>
                )}
                {t.links.gelatoTask && (
                  <a href={t.links.gelatoTask} target="_blank" rel="noreferrer" className="underline text-muted-foreground">Gelato Task</a>
                )}
                <span className="text-muted-foreground/70">강제 종결·재제출·삭제 불가 — 온체인/Task 증거로만 전이</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {message && (
        <div className={cn('flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[10px]', toneCls[message.tone])} data-testid="text-relay-message">
          {message.tone === 'ok' ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <ShieldAlert className="w-3 h-3 shrink-0" />}
          {message.text}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <Lock className="w-3 h-3 shrink-0" />
        이 카드의 모든 동작은 검증 전용입니다. 온체인 제출·자금 이동·LIVE 잠금 해제는 수행되지 않습니다.
      </div>
    </div>
  );
}
