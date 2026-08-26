/**
 * GmxApiStatusCard — 공식 GMX API v2 실행 경로 상태 카드 (6G-2 §11).
 *
 * 계약:
 *  - 모든 값은 서버 파생 스냅샷 기준(브라우저에서 상태를 지어내지 않음).
 *  - 조회 실패를 "미설정"으로 표시하지 않음 — 401/403/503/network/error 구분.
 *  - submission flag false = "구조적으로 비활성" 표시.
 *  - readyForControlledCanary는 서버 값 그대로 (전 조건 미확인 = false).
 *  - main wallet private key 관련 UI 0건. legacy relay 벤더 문구 0건.
 *  - PIN은 요청에만 사용, 저장·전달·표시 금지.
 */

import { useCallback, useState } from 'react';
import { Radio, RefreshCw, Loader2, ShieldAlert, Lock, Ban, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fetchGmxApiStatus, postGmxApiReadinessRefresh,
  type GmxApiStatusView, type GmxApiFetchResult,
} from '@/lib/gmxApiStatus';

const toneCls = {
  ok:    'border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]',
  warn:  'border-amber-500/40 bg-amber-500/10 text-amber-400',
  error: 'border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)]',
  muted: 'border-border bg-secondary text-muted-foreground',
} as const;

type Tone = keyof typeof toneCls;

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium', toneCls[tone])}>
      {children}
    </span>
  );
}

function Row({ label, tone, value }: { label: string; tone: Tone; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 border-b border-border/40 last:border-b-0">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Badge tone={tone}>{value}</Badge>
    </div>
  );
}

/** boolean|null → 표시 (null = 조회 실패 — "미설정"으로 위장 금지) */
function triState(v: boolean | null, okWhen: boolean, okLabel: string, badLabel: string): { tone: Tone; text: string } {
  if (v === null) return { tone: 'warn', text: '조회 실패' };
  return v === okWhen ? { tone: 'ok', text: okLabel } : { tone: 'error', text: badLabel };
}

function fmtEpochMs(atMs: number | null): string {
  if (!atMs) return '—';
  try { return new Date(atMs).toLocaleString(); } catch { return '—'; }
}

function fmtExpires(expiresAt: string | number | null): string {
  if (expiresAt == null) return '—';
  const n = Number(expiresAt);
  if (!Number.isFinite(n) || n <= 0) return '—';
  try { return new Date(n * 1000).toLocaleString(); } catch { return '—'; }
}

function evidenceTone(state: 'not_evaluated' | 'verified' | 'stale' | 'failed'): Tone {
  if (state === 'verified') return 'ok';
  if (state === 'failed') return 'error';
  if (state === 'stale') return 'warn';
  return 'muted';
}

function evidenceLabel(state: 'not_evaluated' | 'verified' | 'stale' | 'failed'): string {
  if (state === 'verified') return 'VERIFIED';
  if (state === 'failed') return 'FAILED';
  if (state === 'stale') return 'STALE';
  return 'NOT EVALUATED';
}

function fmtAge(ageMs: number | null): string {
  if (ageMs === null) return '—';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}초`;
  return `${Math.round(ageMs / 60_000)}분`;
}

function fmtUsd(value: number | null, digits = 6): string {
  return value === null || !Number.isFinite(value) ? '—' : `$${value.toFixed(digits)}`;
}

function fmtPct(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;
}

type PaperReadinessView = NonNullable<GmxApiStatusView['paperRuntimeReadiness']>;
type PaperCostView = PaperReadinessView['costs']['BTC'];
type StopReadinessEvidenceView = NonNullable<NonNullable<GmxApiStatusView['stopCapability']>['readinessEvidence']>;
type PaperRelayEvidenceView = NonNullable<GmxApiStatusView['paperRelayEvidence']>;

export function PaperRelayEvidence({ evidence }: { evidence: PaperRelayEvidenceView }) {
  const entries = [...evidence.executionOnly, ...evidence.storedSafety];
  return (
    <div
      className="sm:col-span-2 space-y-2 rounded border border-sky-500/30 bg-sky-500/5 p-2"
      data-testid="paper-relay-evidence"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-sky-300">PAPER Relay Evidence</p>
          <p className="text-[10px] text-sky-200">
            실행 전용 canonical·action budget·reconciliation은 PAPER에서 평가하지 않습니다.
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {evidence.scope} · {evidence.boundary} · executionAuthorized false
          </p>
        </div>
        <Badge tone="warn">READ-ONLY / NOT EXECUTION AUTHORIZATION</Badge>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="rounded border border-border/60 bg-background/50 p-2"
            data-testid={`paper-relay-evidence-${entry.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[10px]">{entry.id}</span>
              <Badge tone={evidenceTone(entry.status)}>
                {evidenceLabel(entry.status)}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {entry.fresh ? 'FRESH' : 'NOT FRESH'} · age {fmtAge(entry.ageMs)}
              {' · '}failureId {entry.failureId ?? '—'}
            </p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1" data-testid="paper-relay-failure-ids">
        {evidence.failureIds.length === 0
          ? <Badge tone="ok">저장 안전 결함 없음</Badge>
          : evidence.failureIds.map((id) => <Badge key={id} tone="error">{id}</Badge>)}
      </div>
    </div>
  );
}

export function PaperStopReadinessEvidence({ evidence }: { evidence: StopReadinessEvidenceView }) {
  return (
    <div
      className="sm:col-span-2 w-full space-y-2 rounded border border-sky-500/30 bg-sky-500/5 p-2"
      data-testid="paper-stop-readiness-evidence"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-sky-300">PAPER Stop Readiness Evidence</p>
          <p className="text-[10px] text-sky-200">
            진단 전용·읽기 전용 · status는 권한 아님 · 실행 승인 아님
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {evidence.scope} · {evidence.boundary} · executionAuthorized {String(evidence.executionAuthorized)}
          </p>
        </div>
        <Badge tone="warn">READ-ONLY / NOT EXECUTION AUTHORIZATION</Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
        <Row
          label="Readiness complete"
          tone={evidence.readinessComplete ? 'ok' : 'error'}
          value={String(evidence.readinessComplete)}
        />
        <Row
          label="Freshness / generation"
          tone={evidence.fresh ? 'ok' : 'warn'}
          value={`${evidence.fresh ? 'FRESH' : 'STALE'} · generation ${evidence.generation ?? '—'}`}
        />
        <Row label="Evaluated" tone="muted" value={fmtEpochMs(evidence.evaluatedAtMs)} />
        <Row label="Expires" tone={evidence.fresh ? 'muted' : 'warn'} value={fmtEpochMs(evidence.expiresAtMs)} />
      </div>

      <div className="space-y-1">
        <p className="text-[10px] font-semibold text-muted-foreground">Missing condition IDs</p>
        <div className="flex flex-wrap gap-1" data-testid="paper-stop-readiness-missing-ids">
          {evidence.missingConditionIds.length === 0
            ? <span className="text-[10px] text-muted-foreground">없음</span>
            : evidence.missingConditionIds.map((id) => <Badge key={id} tone="warn">{id}</Badge>)}
        </div>
      </div>

      {evidence.reasons.length > 0 && (
        <div className="space-y-0.5" data-testid="paper-stop-readiness-reasons">
          {evidence.reasons.map((reason) => (
            <p key={reason} className="text-[10px] text-amber-300">• {reason}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {evidence.conditions.map((condition) => (
          <div
            key={condition.id}
            className="rounded border border-border/60 bg-background/50 p-2 space-y-1"
            data-testid={`paper-stop-readiness-condition-${condition.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold">{condition.label} · {condition.id}</span>
              <Badge tone={evidenceTone(condition.status)}>{evidenceLabel(condition.status)}</Badge>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">
              category {condition.category} · source {condition.source ?? '—'}
            </p>
            <p className="text-[10px] text-muted-foreground">
              observed {fmtEpochMs(condition.observedAtMs)} · age {fmtAge(condition.ageMs)}
              {' · '}{condition.fresh ? 'FRESH' : 'NOT FRESH'}
            </p>
            {(condition.failureId || condition.detail) && (
              <p className="text-[10px] text-amber-300">
                failureId {condition.failureId ?? '—'} · detail {condition.detail ?? '—'}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PaperCostDiagnostics({ symbol, cost }: { symbol: 'BTC' | 'ETH'; cost: PaperCostView }) {
  const diagnostics = cost.diagnostics;
  if (!diagnostics) return null;
  const firstFailure = diagnostics.firstFailure ?? diagnostics.failures[0] ?? null;
  const firstFailureText = firstFailure
    ? [
      `첫 실패 ${firstFailure.component}←${firstFailure.sourceId}/${firstFailure.failureClass}`,
      firstFailure.httpStatus === null ? null : `HTTP ${firstFailure.httpStatus}`,
      firstFailure.peerPath.length > 0
        ? firstFailure.peerPath.join('→')
        : firstFailure.peerHost,
    ].filter(Boolean).join(' · ')
    : '성분 실패 없음';
  const sourceTraceText = (diagnostics.sourceTraces ?? [])
    .map((trace) => {
      const path = trace.attempts
        .map((attempt) =>
          `${attempt.peerHost}:${attempt.failureClass ?? 'ok'}${attempt.httpStatus === null ? '' : `/HTTP${attempt.httpStatus}`}`)
        .join('→');
      return `${trace.sourceId}[${path || '호출 없음'}]`;
    })
    .join(' · ');
  return (
    <div className="font-mono text-[10px] text-muted-foreground leading-relaxed"
      data-testid={`paper-cost-${symbol.toLowerCase()}-diagnostics`}>
      <p>{firstFailureText}</p>
      {sourceTraceText && <p>{sourceTraceText}</p>}
      <p>
        시도 {diagnostics.attemptCount} · retry {diagnostics.retryCount ?? 0} · failover {diagnostics.failoverCount}
        {' · '}마지막 시도 {fmtEpochMs(diagnostics.lastAttemptAtMs)}
        {' · '}성공 {fmtEpochMs(diagnostics.lastSuccessAtMs)}
        {' · '}실패 {fmtEpochMs(diagnostics.lastFailureAtMs)}
      </p>
    </div>
  );
}

export function PaperCostDetails({
  symbol,
  cost,
}: {
  symbol: 'BTC' | 'ETH';
  cost: PaperCostView;
}) {
  const overCap = cost.withinCap === false;
  const usable = cost.state === 'verified'
    && cost.fresh
    && cost.effectiveRoundTripCostUsd !== null;

  if (!usable) {
    return (
      <>
        <p className="text-[10px] text-amber-300" data-testid={`paper-cost-${symbol.toLowerCase()}-blocked`}>
          {cost.blockReason ?? cost.failureId ?? `${symbol} 비용 snapshot 사용 불가`}
        </p>
        <PaperCostDiagnostics symbol={symbol} cost={cost} />
      </>
    );
  }

  return (
    <>
      <p className={cn('font-mono text-[12px]', overCap ? 'text-red-300' : 'text-foreground')}>
        총 {fmtUsd(cost.effectiveRoundTripCostUsd)} · notional 대비 {fmtPct(cost.totalCostRatePct)}
        {' · '}cap {fmtUsd(cost.capUsd)} · 초과 {fmtUsd(cost.capExcessUsd)}
      </p>
      <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
        거래수수료 {fmtUsd(cost.tradingFeesUsd)} · 가스 {fmtUsd(cost.executionFeeUsd)}
        {' · '}price impact {fmtUsd(cost.priceImpactTotalUsd)}
        {' · '}funding/borrowing {fmtUsd(cost.carryCostUsd)}
        {' · '}기타/보수 조정 {fmtUsd(cost.otherCostUsd)}
      </p>
      <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
        raw: entry {fmtUsd(cost.positionFeeUsd)} · exit {fmtUsd(cost.estimatedExitFeeUsd)}
        {' · '}entry impact {fmtUsd(cost.estimatedPriceImpactUsd)}
        {' · '}exit impact {fmtUsd(cost.estimatedExitPriceImpactUsd)}
        {' · '}funding {fmtUsd(cost.fundingFeeUsd)}
        {' · '}borrowing {fmtUsd(cost.borrowingFeeUsd)}
      </p>
      <p className="text-[10px] text-muted-foreground">
        cap 충족 필요 절감 {fmtUsd(cost.requiredCostReductionUsd)} ({fmtPct(cost.requiredCostReductionPct)})
        {' · '}비용 회수 최소 gross move/edge {fmtUsd(cost.breakEvenGrossMoveUsd)} ({fmtPct(cost.breakEvenGrossMovePct)})
      </p>
      <p className="text-[10px] text-muted-foreground">
        source {cost.source ?? '—'} · fetched {cost.fetchedAt ?? '—'} · observed {fmtEpochMs(cost.observedAtMs)} · age {fmtAge(cost.ageMs)}
      </p>
      <PaperCostDiagnostics symbol={symbol} cost={cost} />
      {cost.blockReason && <p className="text-[10px] text-red-300">{cost.blockReason}</p>}
    </>
  );
}

export function GmxApiStatusCard() {
  const [pin, setPin] = useState('');
  const [status, setStatus] = useState<GmxApiStatusView | null>(null);
  const [loading, setLoading] = useState<'idle' | 'status' | 'refresh'>('idle');
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);

  const applyResult = useCallback((r: GmxApiFetchResult) => {
    if (r.kind === 'ok') {
      setStatus(r.data);
      setMessage(null);
    } else {
      // 조회 실패 ≠ 미설정 — 기존 스냅샷은 유지하고 실패 사유를 구분 표시
      setMessage({ tone: r.kind === 'OPERATOR_AUTH_REQUIRED' || r.kind === 'FORBIDDEN' ? 'error' : 'warn', text: r.message });
    }
  }, []);

  const load = useCallback(async () => {
    if (pin.trim().length < 6) {
      setMessage({ tone: 'warn', text: '조회에는 운영자 PIN(6자 이상)이 필요합니다.' });
      return;
    }
    setLoading('status');
    applyResult(await fetchGmxApiStatus(pin.trim()));
    setLoading('idle');
  }, [pin, applyResult]);

  const refresh = useCallback(async () => {
    if (pin.trim().length < 6) {
      setMessage({ tone: 'warn', text: 'Readiness 갱신에는 운영자 PIN(6자 이상)이 필요합니다.' });
      return;
    }
    setLoading('refresh');
    applyResult(await postGmxApiReadinessRefresh(pin.trim()));
    setLoading('idle');
  }, [pin, applyResult]);

  const s = status;
  const signerReady = s ? s.signerEnabled && s.signerInitialized : null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="gmx-api-status-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">GMX API v2 Official</h3>
            <p className="text-[11px] text-muted-foreground">공식 GMX API 주문 실행 경로 상태 (서버 기준)</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="운영자 PIN"
            className="w-28 h-7 px-2 rounded border border-border bg-background text-xs"
            data-testid="gmx-api-pin-input"
          />
          <button
            onClick={load}
            disabled={loading !== 'idle' || pin.trim().length < 6}
            className="inline-flex items-center gap-1 h-7 px-2 rounded border border-border bg-secondary text-xs disabled:opacity-50"
            data-testid="gmx-api-load-button"
          >
            {loading === 'status' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            조회
          </button>
          <button
            onClick={refresh}
            disabled={loading !== 'idle' || pin.trim().length < 6}
            className="inline-flex items-center gap-1 h-7 px-2 rounded border border-border bg-secondary text-xs disabled:opacity-50"
            data-testid="gmx-api-refresh-button"
          >
            {loading === 'refresh' ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Readiness 갱신
          </button>
        </div>
      </div>

      {message && (
        <div className={cn('px-2.5 py-1.5 rounded border text-[11px]', toneCls[message.tone])} data-testid="gmx-api-message">
          {message.text}
        </div>
      )}

      {!s ? (
        <p className="text-[11px] text-muted-foreground" data-testid="gmx-api-empty">
          아직 조회 전입니다 — PIN 입력 후 조회하세요. (조회 전 값은 표시하지 않습니다)
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6" data-testid="gmx-api-rows">
          <Row label="Transport" tone="muted" value={s.transportGen} />
          <Row label="Legacy 직접 제출" tone={s.legacyDisabled ? 'ok' : 'error'} value={s.legacyDisabled ? 'LEGACY_DISABLED' : '활성(비정상)'} />
          <Row label="Read-only flag" tone={s.readonlyEnabled ? 'ok' : 'muted'} value={s.readonlyEnabled ? '활성' : '비활성'} />
          <Row label="Order submission flag" tone={s.submissionEnabled ? 'warn' : 'muted'}
            value={s.submissionEnabled ? '활성' : '구조적으로 비활성'} />
          <Row label="Peer A / Peer B" tone="muted" value={s.peers.length > 0 ? s.peers.join(' · ') : '—'} />
          <Row label="운영 모드 / LIVE 잠금" tone={s.liveTestExecutionLocked ? 'ok' : 'warn'}
            value={s.liveTestExecutionLocked ? <><Lock className="w-3 h-3" /> LOCKED</> : 'UNLOCKED'} />
          <Row label="Emergency Stop" tone={s.emergencyStopActive ? 'error' : 'ok'}
            value={s.emergencyStopActive ? <><Ban className="w-3 h-3" /> 활성</> : '비활성'} />
          <Row label="Delegated signer" tone={signerReady ? 'warn' : 'muted'}
            value={s.signerEnabled ? (s.signerInitialized ? 'initialized' : 'enabled·미초기화') : '비활성'} />
          {s.paperRelayEvidence && <PaperRelayEvidence evidence={s.paperRelayEvidence} />}
          {!s.paperRelayEvidence && (
            <>
              <Row label="Owner Approval 세션" tone={triState(s.approvalSessionReady, true, 'OWNER_SIGNATURE_READY', '없음').tone}
                value={triState(s.approvalSessionReady, true, 'OWNER_SIGNATURE_READY', '없음').text} />
              <Row label="Canonical verified" tone={s.canonical.authorized ? 'ok' : 'error'}
                value={s.canonical.authorized ? '검증됨' : '미검증'} />
              <Row label="Remaining actions" tone={s.canonical.approvalRemainingOk ? 'ok' : 'warn'}
                value={s.canonical.remaining ?? '—'} />
              <Row label="Approval expiresAt" tone="muted" value={fmtExpires(s.canonical.expiresAt)} />
            </>
          )}
          <Row label="Active revoke" tone={triState(s.activeRevokeInProgress, false, '없음', '진행 중').tone}
            value={triState(s.activeRevokeInProgress, false, '없음', '진행 중').text} />
          <Row label="Blocking intents" tone={s.blockingIntentCount === null ? 'warn' : s.blockingIntentCount === 0 ? 'ok' : 'error'}
            value={s.blockingIntentCount === null ? '조회 실패' : String(s.blockingIntentCount)} />
          <Row label="Open tasks / Unresolved" tone={s.unresolvedTaskCount === null ? 'warn' : s.unresolvedTaskCount === 0 ? 'ok' : 'error'}
            value={`${s.openRelayTaskCount ?? '조회 실패'} / ${s.unresolvedTaskCount ?? '조회 실패'}`} />
          {!s.paperRelayEvidence && (
            <Row label="Reconciliation" tone={s.reconciled ? 'ok' : 'error'} value={s.reconciled ? '완료' : '미완료 — 신규 주문 차단'} />
          )}
          <Row label="GMX 실행 구성" tone={s.gmxConfigOk ? 'ok' : 'error'} value={s.gmxConfigOk ? 'OK' : '미완비'} />
          <Row label="Deployment 검증" tone={s.deploymentVerification.ok ? 'ok' : s.deploymentVerification.attempted ? 'error' : 'muted'}
            value={s.deploymentVerification.ok ? `OK (${s.manifestVersion})` : s.deploymentVerification.attempted ? '실패' : '미시도'} />
          <Row label="Fee estimate" tone={s.feeEstimate.fresh ? 'ok' : 'muted'}
            value={s.feeEstimate.fresh ? '최근 10분 내 OK' : s.feeEstimate.attempted ? '오래됨/실패' : '미시도'} />
          <Row label="마지막 Readiness 갱신" tone="muted" value={fmtEpochMs(s.lastReadinessRefresh.atMs)} />
          <Row label="최근 requestId/status" tone="muted"
            value={s.recentGmxTasks && s.recentGmxTasks.length > 0
              ? `${s.recentGmxTasks[0].hasRequestId ? 'requestId 확보' : 'requestId 없음'} · ${s.recentGmxTasks[0].gmxApiStatus ?? s.recentGmxTasks[0].status}`
              : '기록 없음'} />
          <Row label="readyForControlledCanary" tone={s.readyForControlledCanary ? 'warn' : 'muted'}
            value={String(s.readyForControlledCanary)} />
          <Row label="Prepare 단계 (REQ/PREP/SUBM)"
            tone={s.prepareStageCounts === null ? 'warn'
              : Object.values(s.prepareStageCounts).reduce((a, b) => a + b, 0) > 0 ? 'error' : 'ok'}
            value={s.prepareStageCounts === null ? '조회 실패'
              : `${s.prepareStageCounts.PREPARE_REQUESTED ?? 0} / ${s.prepareStageCounts.API_PREPARED ?? 0} / ${s.prepareStageCounts.SUBMITTING ?? 0}`} />
          <Row label="가장 오래된 blocking task" tone="muted"
            value={s.oldestBlockingTaskAt ? new Date(s.oldestBlockingTaskAt).toLocaleString() : '없음'} />
          {!s.paperRelayEvidence && (
            <Row label="Prepare startup reconciliation"
              tone={s.prepareStartupReconciliation.attempted && s.prepareStartupReconciliation.ok ? 'ok' : 'error'}
              value={s.prepareStartupReconciliation.attempted
                ? (s.prepareStartupReconciliation.ok
                  ? `완료 (stale ${s.prepareStartupReconciliation.stalePreparedFailed} · 불명 ${s.prepareStartupReconciliation.requestedToUnresolved} · 보류 ${s.prepareStartupReconciliation.apiPreparedHeld})`
                  : '실패 — LIVE 차단')
                : '미시도 — LIVE 차단'} />
          )}
          {/* ── 6H-2B §12 — stop 실행 능력·보호 주문·action 예산 (조회 전용) ── */}
          <Row label="LIVE Stop 실행 능력"
            tone={s.stopCapability?.available ? 'ok' : 'muted'}
            value={s.stopCapability
              ? `${s.stopCapability.available ? '가능' : '불가'} · ${s.stopCapability.paperMode ? '현재 PAPER' : '현재 LIVE'} · status는 권한 아님`
              : String(s.stopExecutionAvailable ?? false)} />
          {s.stopCapability && (
            <>
              <Row label="Stop 평가 시각 / 경계" tone="muted"
                value={`${fmtEpochMs(s.stopCapability.evaluatedAt ? Date.parse(s.stopCapability.evaluatedAt) : null)} · ${s.stopCapability.boundary}`} />
              <Row label="Stop 스키마 pin" tone="muted"
                value={`${s.stopCapability.schemaPin.sdk} · StopLossDecrease=${s.stopCapability.schemaPin.stopLossDecrease}`} />
              <div className="sm:col-span-2 space-y-1 py-1" data-testid="stop-capability-reasons">
                <p className="text-[10px] font-semibold text-muted-foreground">
                  Stop capability 판정 근거 ({s.stopCapability.scope})
                </p>
                {s.stopCapability.reasons.length === 0 ? (
                  <p className="text-[10px] text-emerald-300">
                    모든 Stop 실행 전제조건 충족 · 단, 이 읽기 전용 status 자체는 실행 승인이 아닙니다.
                  </p>
                ) : (
                  s.stopCapability.reasons.map((reason) => (
                    <p key={reason} className="text-[10px] text-amber-300">• {reason}</p>
                  ))
                )}
              </div>
              {s.stopCapability.readinessEvidence && (
                <PaperStopReadinessEvidence evidence={s.stopCapability.readinessEvidence} />
              )}
            </>
          )}
          <Row label="보호 주문 (차단/전체)"
            tone={s.blockingProtectionCount === null || s.blockingProtectionCount === undefined ? 'warn'
              : s.blockingProtectionCount > 0 ? 'error' : 'ok'}
            value={s.blockingProtectionCount === null || s.blockingProtectionCount === undefined
              ? '조회 실패'
              : `${s.blockingProtectionCount} / ${Object.values(s.protectionCounts ?? {}).reduce((a, b) => a + b, 0)}`} />
          <Row label="Stale stop / 비상종료 진행"
            tone={(s.staleStopCount ?? 1) > 0 || (s.emergencyCloseInProgressCount ?? 0) > 0 ? 'warn' : 'ok'}
            value={`${s.staleStopCount ?? '조회 실패'} / ${s.emergencyCloseInProgressCount ?? '조회 실패'}`} />
          {s.actionBudget && !s.paperRelayEvidence && (
            <Row label="Action 예산 (잔여/필요)"
              tone={s.actionBudget.sufficient ? 'ok' : 'error'}
              value={s.actionBudget.remainingActions === null
                ? `조회 실패 — ${s.actionBudget.reasons[0] ?? ''}`
                : `${s.actionBudget.remainingActions} / ${s.actionBudget.requiredActions}${s.actionBudget.sufficient ? '' : ' — 부족 (자동 확대 금지)'}`} />
          )}
          {s.actionBudget && !s.paperRelayEvidence && (
            <Row label="Action 예산 세부 (예약/진행중/부족)"
              tone={(s.actionBudget.budgetShortfall ?? 1) > 0 ? 'error' : 'ok'}
              value={`예약 ${s.actionBudget.reservedEmergencyActions ?? '—'} · 진행중 ${s.actionBudget.inFlightReservedActions ?? '조회실패'} · 부족 ${s.actionBudget.budgetShortfall ?? '조회실패'}`} />
          )}
          {/* ── 6H-2D §6 — autoCancel 정책·예산 버전 ── */}
          {s.actionBudget?.autoCancelPolicy && !s.paperRelayEvidence && (
            <Row label="autoCancel 정책 (§2)" tone="muted"
              value={`${s.actionBudget.autoCancelPolicy} · 기준 ${s.actionBudget.version ?? '—'} · 최악 경로 「${s.actionBudget.worstCasePath ?? '—'}」 · 권장 Owner count ${s.actionBudget.recommendedOwnerApprovalCount ?? '—'}`} />
          )}
          {/* ── 6H-2C §10 — decimals·증거 수집기·reconciliation ── */}
          <Row label="Decimals 소스 (검증 캐시)"
            tone={(s.decimalsCache?.length ?? 0) > 0 && s.decimalsCache!.every(d => !d.stale) ? 'ok' : 'muted'}
            value={(s.decimalsCache?.length ?? 0) === 0
              ? '검증 이력 없음 (실행 전 SDK+온체인 교차검증 필요)'
              : s.decimalsCache!.map(d => `${d.decimals} (${d.source}, ${Math.round(d.ageMs / 60000)}분 전${d.stale ? ' · stale' : ''})`).join(' · ')} />
          <Row label="가격 변환 자기검증" tone={s.priceConversionVerified ? 'ok' : 'error'}
            value={s.priceConversionVerified ? '골든 값 대조 통과' : '실패 — stop 제출 차단'} />
          <Row label="증거 수집기 (§4)"
            tone={s.evidenceCollector?.emitterConfigured && s.evidenceCollector?.rpcConfigured ? 'ok' : 'muted'}
            value={s.evidenceCollector
              ? `emitter ${s.evidenceCollector.emitterConfigured ? 'OK' : '미설정'} · RPC ${s.evidenceCollector.rpcConfigured ? 'OK' : '미설정'}`
              : '조회 실패'} />
          {s.protectionReconciliation && !s.paperRelayEvidence && (
            <Row label="보호 reconciliation (§5)"
              tone={s.protectionReconciliation.complete && !s.protectionReconciliation.blockNewOpens ? 'ok' : 'warn'}
              value={`${s.protectionReconciliation.lastRunAtMs ? new Date(s.protectionReconciliation.lastRunAtMs).toLocaleTimeString() : '미실행'} · ${s.protectionReconciliation.complete ? '완료' : '미완료'}${s.protectionReconciliation.blockNewOpens ? ' · OPEN 차단' : ''} · 무stop ${s.protectionReconciliation.uncoveredCount ?? '—'} / 고아 ${s.protectionReconciliation.staleActiveCount ?? '—'} / 초과 ${s.protectionReconciliation.oversizedCount ?? '—'} / 다중 ${s.protectionReconciliation.multipleActiveCount ?? '—'}`} />
          )}
          {/* ── 6H-2D §5·§9 — ambiguous 증거·finality ── */}
          {s.protectionReconciliation && !s.paperRelayEvidence && (
            <Row label="모호 증거 / finality (§5)"
              tone={(s.protectionReconciliation.ambiguousCount ?? 0) > 0 ? 'error' : 'ok'}
              value={`ambiguous ${s.protectionReconciliation.ambiguousCount ?? '—'}건${(s.protectionReconciliation.ambiguousReasons?.length ?? 0) > 0 ? ` (${s.protectionReconciliation.ambiguousReasons!.slice(0, 2).join('; ')})` : ''} · 확정 깊이 ${s.protectionReconciliation.confirmationDepth ?? '—'}블록 · 실행 ${s.protectionReconciliation.lastSource ?? '—'}`} />
          )}
          <Row label="Stop 미확보 포지션"
            tone={(s.uncoveredStopCount ?? 1) > 0 ? 'error' : 'ok'}
            value={s.uncoveredStopCount === null || s.uncoveredStopCount === undefined ? '조회 실패' : String(s.uncoveredStopCount)} />
          {s.executionEligibleCostMaxAgeMs !== undefined && (
            <Row label="실행 적격 비용 창" tone="muted" value={`${Math.round(s.executionEligibleCostMaxAgeMs / 1000)}초 (표시 cache와 별도)`} />
          )}
        </div>
      )}

      {/* PAPER runtime diagnostics — execution authorization cache와 구조적으로 분리 */}
      {s?.paperRuntimeReadiness && (
        <div
          className="space-y-3 rounded-md border border-sky-500/30 bg-sky-500/5 p-3"
          data-testid="paper-runtime-readiness"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold text-sky-300">PAPER Runtime Readiness Evidence</p>
              <p className="text-[10px] text-muted-foreground">
                서버 background cache · 외부 호출은 scheduler만 수행 · GET status는 저장값만 표시
              </p>
              <p className="text-[10px] text-sky-200">
                PAPER evidence는 LIVE Stop capability를 설명만 하며, LIVE 권한·signer·submission을 활성화하지 않습니다.
              </p>
            </div>
            <Badge tone="warn">READ-ONLY / NOT EXECUTION AUTHORIZATION</Badge>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <Row
              label="PAPER / Read-only"
              tone={s.paperRuntimeReadiness.paperMode && s.paperRuntimeReadiness.readonlyEnabled ? 'ok' : 'error'}
              value={`${s.paperRuntimeReadiness.paperMode ? 'PAPER' : 'NOT PAPER'} · ${s.paperRuntimeReadiness.readonlyEnabled ? 'READ-ONLY ON' : 'READ-ONLY OFF'}`}
            />
            <Row
              label="Background scheduler"
              tone={s.paperRuntimeReadiness.scheduler.running ? 'ok' : 'muted'}
              value={`${s.paperRuntimeReadiness.scheduler.running ? 'RUNNING' : 'STOPPED'} · ${s.paperRuntimeReadiness.scheduler.inFlight ? 'IN-FLIGHT' : 'IDLE'} · 마지막 ${fmtEpochMs(s.paperRuntimeReadiness.scheduler.lastCompletedAtMs)}`}
            />
            <Row
              label="Scheduler next / failure"
              tone={s.paperRuntimeReadiness.scheduler.lastFailureId ? 'warn' : 'muted'}
              value={`다음 ${fmtEpochMs(s.paperRuntimeReadiness.scheduler.nextRefreshAtMs)} · ${s.paperRuntimeReadiness.scheduler.lastFailureId ?? 'failure 없음'}`}
            />
            <Row
              label="Deployment evidence"
              tone={evidenceTone(s.paperRuntimeReadiness.deployment.state)}
              value={`${evidenceLabel(s.paperRuntimeReadiness.deployment.state)} · age ${fmtAge(s.paperRuntimeReadiness.deployment.ageMs)}${s.paperRuntimeReadiness.deployment.failureId ? ` · ${s.paperRuntimeReadiness.deployment.failureId}` : ''}`}
            />
            <Row
              label="Arbitrum RPC evidence"
              tone={evidenceTone(s.paperRuntimeReadiness.rpc.state)}
              value={`${evidenceLabel(s.paperRuntimeReadiness.rpc.state)} · chain ${s.paperRuntimeReadiness.rpc.chainId ?? '—'} · age ${fmtAge(s.paperRuntimeReadiness.rpc.ageMs)}${s.paperRuntimeReadiness.rpc.failureId ? ` · ${s.paperRuntimeReadiness.rpc.failureId}` : ''}`}
            />
            {(['BTC', 'ETH'] as const).map((symbol) => {
              const decimals = s.paperRuntimeReadiness!.decimals[symbol];
              return (
                <Row
                  key={`paper-decimals-${symbol}`}
                  label={`${symbol} index decimals`}
                  tone={evidenceTone(decimals.state)}
                  value={`${decimals.decimals ?? '—'} · ${decimals.source ?? evidenceLabel(decimals.state)} · age ${fmtAge(decimals.ageMs)}${decimals.failureId ? ` · ${decimals.failureId}` : ''}`}
                />
              );
            })}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
            {(['BTC', 'ETH'] as const).map((symbol) => {
              const cost = s.paperRuntimeReadiness!.costs[symbol];
              const overCap = cost.withinCap === false;
              return (
                <div
                  key={`paper-cost-${symbol}`}
                  className="rounded border border-border/60 bg-background/50 p-2 space-y-1"
                  data-testid={`paper-cost-${symbol.toLowerCase()}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold">
                      {symbol} LONG · ${cost.notionalUsd} · {cost.holdingHours}h
                    </span>
                    <Badge tone={cost.state !== 'verified' ? evidenceTone(cost.state) : overCap ? 'error' : 'ok'}>
                      {cost.state !== 'verified'
                        ? evidenceLabel(cost.state)
                        : cost.withinCap
                          ? 'WITHIN CAP'
                          : 'BLOCKED · CAP EXCEEDED'}
                    </Badge>
                  </div>
                  <PaperCostDetails symbol={symbol} cost={cost} />
                </div>
              );
            })}
          </div>

          <p className="text-[10px] text-muted-foreground">
            경제성 진단 입력은 LONG · $20 · 1h 관측 시나리오입니다. 비용 상한은 서버 고정 $0.40이며,
            이 화면은 통과 가능한 주문 크기를 제안하거나 상한을 완화하지 않습니다.
          </p>

          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground">Blocker IDs</p>
            <div className="flex flex-wrap gap-1" data-testid="paper-runtime-blocker-ids">
              {s.paperRuntimeReadiness.blockerIds.map((id) => (
                <Badge key={id} tone="warn">{id}</Badge>
              ))}
            </div>
          </div>

          <div className="space-y-1" data-testid="paper-runtime-holds">
            <p className="text-[10px] font-semibold text-muted-foreground">Manual-action HOLD · requested 2026-08-20T13:59:15Z</p>
            {s.paperRuntimeReadiness.manualActionHolds.map((hold) => (
              <div key={hold.id} className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px]">
                <span className="font-mono text-amber-300">{hold.id}</span>
                <span className="text-muted-foreground"> · 필요: {hold.requiredAction} · 재개: {hold.resumeCondition}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── CLOSE 정산 증거 (Settlement Evidence) — 읽기 전용 관측 ── */}
      {s && (
        <div className="space-y-1" data-testid="gmx-api-settlement-evidence">
          <p className="text-[11px] font-semibold text-muted-foreground">Settlement Evidence</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            {!s.paperRelayEvidence && <Row
              label="CLOSE 정산 reconciliation"
              tone={
                s.settlementReconcile === null
                  ? 'warn'
                  : s.settlementReconcile.incomplete
                    ? 'error'
                    : 'ok'
              }
              value={
                s.settlementReconcile === null
                  ? '미실행/조회 불가'
                  : s.settlementReconcile.incomplete
                    ? `미완료 — ${s.settlementReconcile.unsettledCount}건 중 ${s.settlementReconcile.settledNow}건 정산`
                    : `완료 (${s.settlementReconcile.unsettledCount}건)`
              }
            />}
            {!s.paperRelayEvidence && s.settlementReconcile !== null && s.settlementReconcile.incomplete && s.settlementReconcile.reasons.length > 0 && (
              <Row
                label="정산 차단 사유 (첫 번째)"
                tone="error"
                value={s.settlementReconcile.reasons[0]
                  .replace(/^LIVE_SETTLEMENT_INCOMPLETE:\s*/i, '')
                  .slice(0, 80)}
              />
            )}
            <Row
              label="미정산 LIVE 거래"
              tone={
                s.unsettledLiveTradeCount === null
                  ? 'warn'
                  : s.unsettledLiveTradeCount > 0
                    ? 'error'
                    : 'ok'
              }
              value={s.unsettledLiveTradeCount === null ? '조회 실패' : String(s.unsettledLiveTradeCount)}
            />
            <Row
              label="Legacy zero-fee 거래"
              tone={
                s.legacyZeroFeeCount === null
                  ? 'warn'
                  : s.legacyZeroFeeCount > 0
                    ? 'error'
                    : 'ok'
              }
              value={s.legacyZeroFeeCount === null ? '조회 실패' : String(s.legacyZeroFeeCount)}
            />
          </div>
        </div>
      )}

      {s && !s.paperRelayEvidence && s.blockedReasons.length > 0 && (
        <div className="px-2.5 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-400 space-y-0.5"
          data-testid="gmx-api-blocked-reasons">
          <p className="font-medium">신규 주문 차단 사유</p>
          <ul className="list-disc list-inside">
            {s.blockedReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {s && (
        <div className="text-[10px] text-muted-foreground space-y-0.5" data-testid="gmx-api-notices">
          {s.notices.map((n, i) => <p key={i}>{n}</p>)}
        </div>
      )}

      <div className="flex items-start gap-2 text-[10px] text-muted-foreground">
        <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" />
        <span>
          이 카드는 조회 전용입니다 — 주문 생성·서명·제출을 유발하지 않습니다.
          메인 지갑 개인키는 어떤 경우에도 서버·앱에 입력하지 않습니다.
        </span>
      </div>
    </div>
  );
}
