/**
 * RelayStatusCard — GMX delegated trading 3단계 Gelato relay DRY-RUN 상태 UI.
 *
 * 표시: relay 모드(DRY-RUN 전용/비활성), 게이트 차단 사유, canonical 상태,
 * fee quote(mock), 최근 relay task 이력, revoke(owner 서명) 흐름.
 *
 * UI 계약: DRY_RUN_VALIDATED·TASK_ACCEPTED를 성공처럼 표시하지 않는다.
 * 이 카드에서 실행되는 어떤 동작도 온체인 제출·LIVE 실행을 유발하지 않는다.
 */

import { useCallback, useState } from 'react';
import { Radio, RefreshCw, Loader2, ShieldAlert, CheckCircle2, PenLine, Lock, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWallet } from '@/lib/context';
import { canRequestOwnerSignature, mapSignError, formatUnixSeconds } from '@/lib/subaccountApproval';
import {
  fetchRelayStatus, postRevokePrepare, postRevokeSignature, postRevokeCancel, postRevokeDryRun,
  fetchUnresolvedTasks, postUnresolvedRecheck, fetchActivationStatus,
  mapRelayModeToView, mapRelayTaskStatusToView, formatWeiToEth,
  type RelayStatusResponse, type DryRunView, type UnresolvedTaskView, type ActivationStatusResponse,
  type ReadinessSnapshotView,
} from '@/lib/relayStatus';


type RevokePhase = 'idle' | 'preparing' | 'awaiting_signature' | 'submitting';

export interface RelayStatusCardProps {
  /**
   * 6E-10 §3·§5 — 상위(Settings)에서 전달되는, 인증된 Readiness POST 응답의
   * 서버 저장 스냅샷. PIN은 절대 전달되지 않는다. 없으면 "확인 불가" 표시
   * (초기 false값을 실제 상태처럼 표시하지 않는다 — fail-closed).
   */
  snapshot?: ReadinessSnapshotView | null;
}

const toneCls = {
  ok:    'border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]',
  warn:  'border-amber-500/40 bg-amber-500/10 text-amber-400',
  error: 'border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)]',
  muted: 'border-border bg-secondary text-muted-foreground',
} as const;

export function RelayStatusCard({ snapshot = null }: RelayStatusCardProps = {}) {
  const wallet = useWallet();
  const [status, setStatus] = useState<RelayStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<RevokePhase>('idle');
  const [prepared, setPrepared] = useState<{ sessionId: string; typedData: unknown; summary?: Record<string, string> } | null>(null);
  const [dryRun, setDryRun] = useState<DryRunView | null>(null);
  const [unresolved, setUnresolved] = useState<UnresolvedTaskView[]>([]);
  const [activation, setActivation] = useState<ActivationStatusResponse | null>(null);
  const [recheckBusy, setRecheckBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    // status 엔드포인트도 운영자 인증 필요 — PIN 없이는 조회하지 않음.
    // 6E-10 §6 — PIN 미입력 시 버튼이 disabled되므로 이 분기는 방어용이며,
    // 도달하면 명시적 안내를 표시한다 (무반응 금지).
    const p = pin.trim();
    if (p.length < 6) {
      setMessage({ tone: 'warn', text: '상태 조회에는 운영자 PIN(6자 이상)이 필요합니다 — 상태 갱신은 위 Readiness 카드에서 수행하세요.' });
      return;
    }
    setLoading(true);
    const [s, u, a] = await Promise.all([
      fetchRelayStatus(p),
      fetchUnresolvedTasks(p),
      fetchActivationStatus(p),
    ]);
    setStatus(s.kind === 'ok' ? s.data : null);
    setUnresolved(u.kind === 'ok' ? u.data : []);
    setActivation(a.kind === 'ok' ? a.data : null);
    // 6E-10 §7 — 401/503/네트워크 오류를 silent null로 삼키지 않고 구분 표시
    const failure = [s, u, a].find((r) => r.kind !== 'ok') as { kind: string; message: string } | undefined;
    if (failure) setMessage({ tone: failure.kind === 'OPERATOR_AUTH_REQUIRED' ? 'error' : 'warn', text: failure.message });
    setLoading(false);
  }, [pin]);

  const handleRecheck = useCallback(async (taskId: string) => {
    setRecheckBusy(taskId);
    const r = await postUnresolvedRecheck({ pin: pin.trim(), taskId });
    setRecheckBusy(null);
    if (!r.ok) { setMessage({ tone: 'error', text: r.error ?? '재조회 실패' }); return; }
    setMessage({
      tone: r.rechecked ? 'ok' : 'warn',
      text: r.rechecked ? '증거를 재수집했습니다 — 상태는 증거 기반으로만 전이됩니다.' : (r.reason ?? '재수집 불가 — 상태 유지'),
    });
    void refresh();
  }, [pin, refresh]);

  // 6E-10 §3 — mount 시 자동 GET 없음 (인증 필요 + polling 금지).
  // 상태는 상위에서 전달된 인증된 snapshot 또는 명시적 조회로만 채워진다.

  const modeView = status
    ? mapRelayModeToView(status.mode)
    : snapshot
      ? mapRelayModeToView(snapshot.statusFlags.relayMode)
      : { label: '확인 불가 (인증 필요)', tone: 'muted' as const };
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
    const r = await postRevokePrepare({ pin: pin.trim() });
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
    const r = await postRevokeSignature({ pin: pin.trim(), sessionId: prepared.sessionId, signature });
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
    const r = await postRevokeCancel({ pin: pin.trim(), sessionId });
    setPhase('idle');
    setPrepared(null);
    setMessage(r.ok ? { tone: 'ok', text: 'revoke 세션이 취소되었습니다.' } : { tone: 'error', text: r.error ?? '취소 실패' });
    void refresh();
  }, [prepared, status, pin, refresh]);

  const handleRevokeDryRun = useCallback(async () => {
    if (!pinOk) { setMessage({ tone: 'error', text: '운영자 PIN(6자 이상)을 입력하세요.' }); return; }
    setMessage(null);
    const r = await postRevokeDryRun({ pin: pin.trim() });
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
        {/* 6E-10 §6 — PIN 미입력 시 disabled + 사유 표시 (클릭 무반응 금지) */}
        <div className="ml-auto flex items-center gap-1.5">
          {!pinOk && (
            <span className="text-[9px] text-muted-foreground/70" data-testid="text-refresh-relay-hint">
              상태 갱신은 위 Readiness 카드에서 수행 (직접 조회는 아래 Revoke PIN 입력 후)
            </span>
          )}
          <button
            onClick={() => void refresh()}
            disabled={!pinOk || loading}
            className={cn('p-1 rounded', pinOk && !loading ? 'hover:bg-secondary' : 'opacity-40 cursor-not-allowed')}
            title={pinOk ? '새로고침 (운영자 인증 조회)' : '운영자 PIN(6자 이상) 입력 시에만 조회 가능 — 상태 갱신은 위 Readiness 카드에서 수행'}
            data-testid="button-refresh-relay"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Gelato relay 제출 경로의 검증 전용 상태입니다. LIVE 제출은 이번 단계에서 구조적으로 비활성이며,
        어떤 dry-run 결과도 실제 주문·서명 제출을 의미하지 않습니다.
      </p>

      {/* mode / gate — 6E-10 §5: 인증되지 않은 초기값을 실제 상태처럼 표시하지 않는다 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">제출 기능</span>
        <span data-testid="text-submission-enabled">{status
          ? (status.submissionEnabled ? '환경변수 활성 (DRY-RUN 한정)' : '비활성 (서버 확인됨)')
          : snapshot
            ? (snapshot.statusFlags.submissionDisabled ? '비활성 (인증된 snapshot)' : '환경변수 활성 (DRY-RUN 한정)')
            : '확인 불가 — 운영자 인증 후 Readiness 검증 필요'}</span>
        <span className="text-muted-foreground">LIVE 제출</span>
        <span className="text-[var(--color-short)]" data-testid="text-live-disabled">구조적으로 비활성 (이번 단계)</span>
        <span className="text-muted-foreground">Canonical 확인</span>
        <span data-testid="text-canonical">{status
          ? (status.canonical.confirmed
              ? `확인됨 (nonce ${status.canonical.approvalNonce ?? '—'}, 잔여 ${status.canonical.remaining ?? '—'})`
              : (status.canonical.reason ?? '미확인'))
          : snapshot?.canonical
            ? (snapshot.canonical.confirmed
                ? `확인됨 (nonce ${snapshot.canonical.approvalNonce ?? '—'}, 잔여 ${snapshot.canonical.remaining ?? '—'})`
                : (snapshot.canonical.reason ?? '미확인 (fail-closed)'))
            : '확인 불가 — 최근 인증된 snapshot 없음'}</span>
        {quote && (<>
          <span className="text-muted-foreground">Fee quote (mock)</span>
          <span data-testid="text-fee-quote">
            {formatWeiToEth(quote.feeAmount)} · {quote.valid ? '검증 통과' : `거부: ${quote.invalidReason}`}
          </span>
        </>)}
      </div>

      {/* 6E-10 §5 — 인증된 Readiness snapshot 렌더 (Readiness 카드와 동일 데이터) */}
      {snapshot ? (
        <div className="flex flex-col gap-1.5 p-3 rounded border border-border bg-secondary/30" data-testid="block-readiness-snapshot">
          <div className="text-[11px] font-semibold text-muted-foreground">
            인증된 Readiness Snapshot — {new Date(snapshot.atMs).toLocaleString()}
          </div>
          <div className="text-[10px] text-muted-foreground" data-testid="text-snapshot-refresh">
            Readiness 갱신: {snapshot.lastReadinessRefresh.attempted && snapshot.lastReadinessRefresh.atMs
              ? `${new Date(snapshot.lastReadinessRefresh.atMs).toLocaleString()} — ${snapshot.lastReadinessRefresh.ok ? '성공' : '실패 (fail-closed)'}`
              : '미수행 (fail-closed)'}
          </div>
          {snapshot.lastReadinessRefresh.failures.length > 0 && (
            <ul className="list-disc pl-5 space-y-0.5 text-[10px] text-amber-400/90" data-testid="list-snapshot-failures">
              {snapshot.lastReadinessRefresh.failures.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          <div className="text-[10px] text-muted-foreground" data-testid="text-snapshot-deployment">
            배포 검증 (저장 스냅샷 — 추가 외부 호출 없음): {snapshot.deploymentVerification.attempted
              ? (snapshot.deploymentVerification.ok ? '전체 통과' : '실패 포함 (fail-closed)')
              : '미수행 (fail-closed)'}
            {` — 통과 ${snapshot.deploymentVerification.basis.length}건`}
            {snapshot.deploymentVerification.failures.length > 0 ? `, 실패 ${snapshot.deploymentVerification.failures.length}건` : ''}
            <ul className="list-disc pl-5 space-y-0.5 mt-0.5" data-testid="list-snapshot-deployment-items">
              {snapshot.deploymentVerification.basis.map((b, i) => <li key={`b${i}`}>{b}</li>)}
              {snapshot.deploymentVerification.failures.map((x, i) => <li key={`f${i}`} className="text-amber-400/90">{x}</li>)}
            </ul>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]" data-testid="grid-snapshot-flags">
            <span className="text-muted-foreground">Read-only 네트워크</span>
            <span>{snapshot.statusFlags.readonlyNetworkDisabled ? '비활성 (인증된 snapshot)' : '활성 (조회 전용)'}</span>
            <span className="text-muted-foreground">Submit 네트워크</span>
            <span>{snapshot.statusFlags.submitNetworkDisabled ? '비활성 (인증된 snapshot)' : '활성'}</span>
            <span className="text-muted-foreground">Relay 모드</span>
            <span>{snapshot.statusFlags.relayMode}</span>
            <span className="text-muted-foreground">Delegated signer</span>
            <span>{snapshot.statusFlags.signerDisabled ? '비활성 (예상된 fail-closed — 시스템 고장 아님)' : '활성'}</span>
            <span className="text-muted-foreground">LIVE 잠금</span>
            <span>{snapshot.statusFlags.liveLocked ? '유지 중 (LIVE_TEST_EXECUTION_LOCKED)' : '해제됨'}</span>
            {snapshot.statusFlags.gelatoApiConfigured !== undefined && (<>
              <span className="text-muted-foreground">Gelato API key</span>
              <span data-testid="text-snapshot-gelato-key">{snapshot.statusFlags.gelatoApiConfigured ? '설정됨 (값 미노출)' : '미설정 — 외부 호출 0회 (fail-closed)'}</span>
            </>)}
            {snapshot.statusFlags.transportContract && (<>
              <span className="text-muted-foreground">Transport</span>
              <span data-testid="text-snapshot-transport">{snapshot.statusFlags.transportContract}</span>
            </>)}
            {snapshot.statusFlags.feeEstimate && (<>
              <span className="text-muted-foreground">GMX fee estimate</span>
              <span data-testid="text-snapshot-fee-estimate">{snapshot.statusFlags.feeEstimate.status === 'fresh'
                ? `입력 확보 (${snapshot.statusFlags.feeEstimate.atMs ? new Date(snapshot.statusFlags.feeEstimate.atMs).toLocaleString() : '—'})`
                : '미확보 (fail-closed — 제출 불가)'}</span>
            </>)}
            {snapshot.statusFlags.sponsorBalance && (<>
              <span className="text-muted-foreground">Sponsor balance</span>
              <span data-testid="text-snapshot-sponsor-balance">{snapshot.statusFlags.sponsorBalance.status === 'verified'
                ? '확인됨 (> 0)'
                : snapshot.statusFlags.sponsorBalance.status === 'insufficient'
                  ? '잔액 0 — 충전 필요 (fail-closed)'
                  : '미확인 (fail-closed)'}</span>
            </>)}
          </div>
          <div className={cn('mt-1 px-2.5 py-1.5 rounded border text-[10px] font-semibold', toneCls.muted)} data-testid="text-snapshot-canary">
            LIVE 적격 여부: 준비 미완료 (fail-closed) — snapshot은 DB 파생 게이트를 포함하지 않으므로 적격으로 표시되지 않습니다
          </div>
        </div>
      ) : !activation && (
        <div className="flex flex-col gap-1 p-3 rounded border border-border bg-secondary/30 text-[10px] text-muted-foreground" data-testid="block-no-snapshot">
          <span data-testid="text-no-snapshot-1">확인 불가 — 운영자 인증 후 Readiness 검증 필요</span>
          <span data-testid="text-no-snapshot-2">최근 인증된 snapshot 없음 — 위 Readiness 카드에서 읽기 전용 검증을 수행하세요 (페이지 새로고침 시 snapshot은 사라집니다)</span>
          <span className="font-semibold" data-testid="text-no-snapshot-3">LIVE 적격 여부: 확인 불가 (fail-closed)</span>
        </div>
      )}

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
                  ? `${new Date(refresh.atMs).toLocaleString()} — ${refresh.ok ? '성공' : '실패(fail-closed)'}`
                  : '미수행 (명시적 refresh 필요)'}
              </div>
            )}
            {refresh && refresh.attempted && !refresh.ok && refresh.failures.length > 0 && (
              <ul className="list-disc pl-5 space-y-0.5 text-[10px] text-amber-400/90" data-testid="list-refresh-failures">
                {refresh.failures.map((fl, i) => <li key={i}>{fl}</li>)}
              </ul>
            )}
            {f.deploymentVerification && f.deploymentVerification.attempted && (
              <div className="text-[10px] text-muted-foreground" data-testid="text-deployment-verification">
                배포 검증 (저장 스냅샷 — 추가 외부 호출 없음): {f.deploymentVerification.ok ? '전체 통과' : '실패 포함'}
                {' — 통과 '}{f.deploymentVerification.basis.length}건
                {f.deploymentVerification.failures.length > 0 ? `, 실패 ${f.deploymentVerification.failures.length}건` : ''}
                <ul className="list-disc pl-5 space-y-0.5 mt-0.5">
                  {f.deploymentVerification.basis.map((b, i) => <li key={`b${i}`}>{b}</li>)}
                  {f.deploymentVerification.failures.map((x, i) => <li key={`f${i}`} className="text-amber-400/90">{x}</li>)}
                </ul>
              </div>
            )}
            {f.transportContract && (
              <div className="text-[10px] text-muted-foreground" data-testid="text-transport-status">
                Transport: {f.transportContract}
                {f.gelatoApiConfigured !== undefined && ` · Gelato API key ${f.gelatoApiConfigured ? '설정됨 (값 미노출)' : '미설정 (외부 호출 0회)'}`}
              </div>
            )}
            {f.feeEstimate && (
              <div className="text-[10px] text-muted-foreground" data-testid="text-fee-estimate">
                GMX fee estimate: {f.feeEstimate.status === 'fresh' ? '입력 확보 (eth_gasPrice + multiplierFactor)' : '미확보 (fail-closed — 제출 불가)'}
                {f.feeEstimate.failures.length > 0 && (
                  <ul className="list-disc pl-5 space-y-0.5 mt-0.5 text-amber-400/90">
                    {f.feeEstimate.failures.map((x, i) => <li key={i}>{x}</li>)}
                  </ul>
                )}
              </div>
            )}
            {f.sponsorBalance && (
              <div className="text-[10px] text-muted-foreground" data-testid="text-sponsor-balance">
                Sponsor balance: {f.sponsorBalance.status === 'verified' ? '확인됨 (> 0)'
                  : f.sponsorBalance.status === 'insufficient' ? '잔액 0 — 1Balance 충전 필요 (fail-closed)'
                  : '미확인 (fail-closed)'}
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
