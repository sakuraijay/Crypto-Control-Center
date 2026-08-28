/**
 * Beta RC 상태 카드 — 읽기 전용 관제 표시 (실행 능력 없음).
 *
 * 표시 항목:
 *  - 서버 PAPER 실행기: 미청산 포지션·pendingClose·unresolved·마지막 OPEN 시도(차단 사유)·마지막 청산
 *  - Intel(SHADOW): 사이클 신선도·dataQuality·blockedReason/noTradeReasons
 *  - Calibration: CALIBRATED 버킷 수 / 전체 버킷 수
 *  - LIVE 안전 잠금: liveExecutionLocked·delegated signer·order submission (executor status 파생)
 *
 * 데이터 소스는 전부 기존 read-only GET 엔드포인트 — 새 서버 능력 추가 없음.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { apiUrl } from '@/lib/apiUrl';
import { ShieldCheck, ShieldAlert, Activity, Loader2 } from 'lucide-react';

const REFRESH_MS = 30_000;

interface ServerPaperExecView {
  openPosition: { symbol: string; side: 'LONG' | 'SHORT'; sizeInUsd: number; entryPriceUsd: number; leverage: number } | null;
  pendingClose: { reason: string; requestedAt: string } | null;
  lastTickAt: string | null;
  lastTickStale: boolean;
  lastOpenAttempt: { at: string; ok: boolean; reason: string | null } | null;
  lastCloseAction: { at: string; kind: string; reason: string; ok: boolean; detail: string | null } | null;
  unresolved: string | null;
}

interface ExecutorStatusView {
  engineMode?: string;
  liveExecutionLocked?: boolean;
  liveTestMode?: boolean;
  serverPaperExec?: ServerPaperExecView | null;
  operationalDiagnostics?: OperationalDiagnosticsView;
}

type DiagnosticStatus = 'MATCH' | 'DRIFT' | 'UNAVAILABLE';
interface DiagnosticItemView {
  configured: boolean | string | null;
  effective: boolean | string | null;
  status: DiagnosticStatus;
  driftReason: string | null;
}
interface OperationalDiagnosticsView {
  flags: Record<string, DiagnosticItemView>;
  provenance: {
    status: DiagnosticStatus;
    driftReason: string | null;
    sameCommit: boolean | null;
    sameProductTree: boolean | null;
  };
}

const FLAG_LABELS: Record<string, string> = {
  engineMode: 'Engine mode',
  autoWorkerLiveEnabled: 'AUTO Worker LIVE',
  liveTestExecutionLocked: 'LIVE execution lock',
  delegatedSignerEnabled: 'Delegated signer',
  gmxOrderSubmissionEnabled: 'GMX order submission',
  relaySubmissionEnabled: 'Relay submission',
  relaySubmitNetworkEnabled: 'Relay submit network',
  relayMode: 'Relay mode',
};

function displayValue(value: boolean | string | null): string {
  if (value === null) return 'UNAVAILABLE';
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
}

interface IntelStatusView {
  available: boolean;
  mode?: string;
  stale?: boolean;
  at?: string;
  dataQuality?: string;
  degraded?: boolean;
  degradedReason?: string | null;
  blockedReason?: string | null;
  noTradeReasons?: string[];
  reason?: string;
}

interface CalibrationView {
  requiredSamplesPerBucket?: number;
  buckets?: Array<{ status?: string; calibrationStatus?: string }>;
}

function useBetaRcStatus() {
  const [executor, setExecutor] = useState<ExecutorStatusView | null>(null);
  const [intel, setIntel] = useState<IntelStatusView | null>(null);
  const [calib, setCalib] = useState<CalibrationView | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [e, i, c] = await Promise.all([
        fetch(apiUrl('executor/status'), { signal: AbortSignal.timeout(8_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(apiUrl('market-intelligence/status'), { signal: AbortSignal.timeout(8_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(apiUrl('shadow/calibration'), { signal: AbortSignal.timeout(8_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      setExecutor(e as ExecutorStatusView | null);
      setIntel(i as IntelStatusView | null);
      setCalib(c as CalibrationView | null);
      setFailed(e === null && i === null);
      setFetchedAt(new Date());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => void refresh(), REFRESH_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  return { executor, intel, calib, fetchedAt, failed };
}

function Chip({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium',
      warn ? 'border-amber-500/40 bg-amber-500/8 text-amber-400'
        : ok ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
        : 'border-[var(--color-short)]/40 bg-[var(--color-short)]/5 text-[var(--color-short)]',
    )}>
      {children}
    </span>
  );
}

export function BetaRcStatusCard() {
  const { executor, intel, calib, fetchedAt, failed } = useBetaRcStatus();
  const sp = executor?.serverPaperExec ?? null;

  const buckets = calib?.buckets ?? [];
  const calibrated = buckets.filter(b => (b.status ?? b.calibrationStatus) === 'CALIBRATED').length;

  const executorUnknown = executor == null;
  const liveLocked = executor?.liveExecutionLocked !== false;
  const intelStale = intel?.available === true ? intel.stale === true : true;
  const diagnostics = executor?.operationalDiagnostics;
  const diagnosticFlags = diagnostics ? Object.entries(diagnostics.flags) : [];
  const hasDrift = diagnosticFlags.some(([, value]) => value.status !== 'MATCH')
    || diagnostics?.provenance.status !== 'MATCH';

  return (
    <Card className="p-4 flex flex-col gap-3 border border-border" data-testid="beta-rc-status-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Beta RC 상태</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground/60">읽기 전용 · 30초 갱신</span>
        </div>
        {fetchedAt
          ? <span className="text-[10px] font-mono text-muted-foreground">{fetchedAt.toLocaleTimeString()}</span>
          : <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>

      {/* configured / effective 운영 drift + build provenance */}
      <div className={cn(
        'flex flex-col gap-2 rounded border p-3 text-[11px]',
        !diagnostics || hasDrift
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5',
      )} data-testid="operational-diagnostics">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">운영 Drift · Provenance</span>
          <Chip ok={!!diagnostics && !hasDrift} warn={!diagnostics || hasDrift}>
            {!diagnostics ? 'UNAVAILABLE (fail-closed)'
              : hasDrift ? 'DRIFT / UNAVAILABLE (fail-closed)' : 'MATCH'}
          </Chip>
        </div>
        {!diagnostics ? (
          <span className="text-amber-400">
            비교 증거 없음 — configured/effective 또는 배포 source 일치를 추정하지 않습니다.
          </span>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
              {diagnosticFlags.map(([key, value]) => (
                <Fragment key={key}>
                  <span className={value.status === 'MATCH' ? 'text-muted-foreground' : 'text-amber-400'}>
                    {FLAG_LABELS[key] ?? key}
                  </span>
                  <span className="font-mono text-right">
                    {displayValue(value.configured)} / {displayValue(value.effective)}
                    {value.status !== 'MATCH' && ` · ${value.driftReason ?? value.status}`}
                  </span>
                </Fragment>
              ))}
            </div>
            <div className={diagnostics.provenance.status === 'MATCH'
              ? 'text-muted-foreground' : 'text-amber-400'}>
              Workspace / deployed release provenance: {diagnostics.provenance.status}
              {' · '}commit {diagnostics.provenance.sameCommit === null
                ? 'N/A' : diagnostics.provenance.sameCommit ? 'same' : 'different'}
              {' · '}tree {diagnostics.provenance.sameProductTree === null
                ? 'N/A' : diagnostics.provenance.sameProductTree ? 'same' : 'different'}
              {diagnostics.provenance.driftReason && ` · ${diagnostics.provenance.driftReason}`}
            </div>
            <div className="text-[10px] text-muted-foreground">
              값 순서: configured / effective / drift reason
            </div>
          </>
        )}
      </div>

      {failed && (
        <div className="text-[11px] text-amber-400">상태 조회 실패 — 서버 응답 없음 (표시 불가, 값 추정 안 함)</div>
      )}

      {/* LIVE 안전 잠금 */}
      <div className="flex flex-wrap gap-1.5">
        {executorUnknown ? (
          <Chip warn><ShieldAlert className="w-3 h-3" />Executor 상태 불명 — 잠금 여부 확인 불가</Chip>
        ) : (
          <>
            <Chip ok={liveLocked} warn={false}>
              {liveLocked ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
              LIVE {liveLocked ? '잠금' : '잠금 해제됨'}
            </Chip>
            <Chip ok>{executor.engineMode ?? '모드 불명'}</Chip>
            <Chip ok={executor.liveTestMode !== true} warn={executor.liveTestMode === true}>
              LIVE TEST {executor.liveTestMode === true ? 'ON' : 'OFF'}
            </Chip>
          </>
        )}
      </div>

      {/* 서버 PAPER 실행기 */}
      <div className="flex flex-col gap-1 text-[11px]">
        <span className="font-semibold text-muted-foreground">서버 PAPER 실행기</span>
        {sp ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Chip ok={!sp.unresolved} warn={!!sp.unresolved}>
                {sp.unresolved ? `UNRESOLVED: ${sp.unresolved}` : '상태 정상'}
              </Chip>
              <Chip ok={!sp.lastTickStale} warn={sp.lastTickStale}>
                틱 {sp.lastTickStale ? 'stale 시세 — 관리 보류' : '정상'}
              </Chip>
              {sp.pendingClose && <Chip warn>전량 청산 대기: {sp.pendingClose.reason}</Chip>}
            </div>
            <div className="text-muted-foreground">
              포지션: {sp.openPosition
                ? `${sp.openPosition.symbol} ${sp.openPosition.side} $${sp.openPosition.sizeInUsd.toFixed(0)} @${sp.openPosition.entryPriceUsd} ${sp.openPosition.leverage}x`
                : '없음 (CASH)'}
            </div>
            {sp.lastOpenAttempt && !sp.lastOpenAttempt.ok && sp.lastOpenAttempt.reason && (
              <div className="text-amber-400/90">최근 진입 차단: {sp.lastOpenAttempt.reason}</div>
            )}
            {sp.lastCloseAction && (
              <div className="text-muted-foreground">
                최근 청산: {sp.lastCloseAction.kind}/{sp.lastCloseAction.reason} — {sp.lastCloseAction.ok ? '성공' : `실패 (${sp.lastCloseAction.detail ?? '사유 불명'})`}
              </div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">스냅샷 없음 (PAPER 모드 아님 또는 서버 미응답)</span>
        )}
      </div>

      {/* Intel + Calibration */}
      <div className="flex flex-col gap-1 text-[11px]">
        <span className="font-semibold text-muted-foreground">Intel (SHADOW 전용)</span>
        <div className="flex flex-wrap gap-1.5">
          <Chip ok={!intelStale} warn={intelStale}>
            데이터 {intel?.available ? (intelStale ? 'STALE' : `신선 (${intel?.at ? new Date(intel.at).toLocaleTimeString() : '-'})`) : '기록 없음'}
          </Chip>
          {intel?.dataQuality && <Chip ok={intel.dataQuality === 'OK'} warn={intel.dataQuality !== 'OK'}>품질 {intel.dataQuality}</Chip>}
          <Chip ok={calibrated > 0} warn={calibrated === 0}>
            Calibration {calibrated}/{buckets.length} 버킷
          </Chip>
        </div>
        {intel?.blockedReason && <div className="text-amber-400/90">차단 사유: {intel.blockedReason}</div>}
        {intel?.degradedReason && <div className="text-amber-400/90">저하 사유: {intel.degradedReason}</div>}
        {intel?.noTradeReasons && intel.noTradeReasons.length > 0 && (
          <div className="text-muted-foreground truncate">NO_TRADE: {intel.noTradeReasons.slice(0, 3).join(' · ')}</div>
        )}
      </div>
    </Card>
  );
}

export default BetaRcStatusCard;
