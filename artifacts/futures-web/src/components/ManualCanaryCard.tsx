/**
 * ManualCanaryCard — #135 Manual Controlled Canary (운영자 1회 수동 실행) 카드.
 *
 * 흐름: PIN + BTC/ETH·LONG/SHORT 선택 → 1단계 preflight(read-only, 실패 전체 표시)
 *       → confirm 문구 직접 입력 → 2단계 실행(서버가 직전 전 조건 재평가)
 *       → 단계 표시(OPEN → stop ACTIVE → Close → CONFIRMED → readback).
 *
 * 하드캡은 서버 강제 — 이 카드는 캡을 읽기 전용으로 표시만 하며 확대 입력이 없다.
 * 현재 Production은 PAPER + LIVE 잠금 상태 — 실행해도 시뮬레이션(실제 주문 0건)으로
 * 구분 표시된다. PIN은 헤더로만 전송하고 저장하지 않는다.
 */
import { useCallback, useState } from 'react';
import { Bird, Loader2, RefreshCw, ShieldAlert, CheckCircle2, XCircle, CircleDashed, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import {
  fetchCanaryPreflight, fetchCanaryStatus, normalizeCanaryBlockers,
  postCanaryExecute, postCanaryClose, stageTone,
  CANARY_CONFIRM_OPEN, CANARY_CONFIRM_CLOSE,
  type CanaryPreflightResponse, type CanaryStatusResponse, type CanaryExecuteResponse,
  type CanaryBlocker,
} from '@/lib/manualCanary';
import { BlockerGroupSection } from '@/components/BlockerGroupSection';

const SYMBOLS = ['BTC', 'ETH'] as const;
const DIRECTIONS = ['LONG', 'SHORT'] as const;

const STAGE_LABELS: { key: keyof CanaryStatusResponse['stages']; label: string }[] = [
  { key: 'open', label: 'OPEN' },
  { key: 'stop', label: 'Stop ACTIVE' },
  { key: 'close', label: 'Close' },
  { key: 'confirmed', label: 'CONFIRMED' },
  { key: 'readback', label: 'Readback' },
];

function ToneIcon({ tone }: { tone: 'ok' | 'warn' | 'error' | 'idle' }) {
  if (tone === 'ok') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
  if (tone === 'error') return <XCircle className="w-3.5 h-3.5 text-red-400" />;
  if (tone === 'warn') return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
  return <CircleDashed className="w-3.5 h-3.5 text-muted-foreground" />;
}

export function ManualCanaryCard() {
  const [pin, setPin] = useState('');
  const [symbol, setSymbol] = useState<(typeof SYMBOLS)[number]>('BTC');
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>('LONG');
  const [busy, setBusy] = useState<null | 'preflight' | 'execute' | 'close' | 'emergency' | 'status'>(null);
  const [preflight, setPreflight] = useState<CanaryPreflightResponse | null>(null);
  const [status, setStatus] = useState<CanaryStatusResponse | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [closeConfirmText, setCloseConfirmText] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [lastResult, setLastResult] = useState<CanaryExecuteResponse | null>(null);
  const [blockers, setBlockers] = useState<CanaryBlocker[] | null>(null);

  const pinReady = pin.length >= 4;

  const refreshStatus = useCallback(async (p: string) => {
    const r = await fetchCanaryStatus(p);
    if (r.kind === 'ok') {
      setStatus(r.data);
      setBlockers(normalizeCanaryBlockers(r.data.blockers));
    }
  }, []);

  const onPreflight = async () => {
    if (!pinReady || busy) return;
    setBusy('preflight');
    setMessage(null);
    setLastResult(null);
    setPreflight(null);
    const r = await fetchCanaryPreflight(pin, symbol, direction);
    if (r.kind === 'auth') setMessage({ tone: 'error', text: '운영자 인증 실패 — PIN 확인' });
    else if (r.kind === 'error') setMessage({ tone: 'error', text: r.message });
    else {
      setPreflight(r.data);
      setMessage(r.data.ok
        ? { tone: 'ok', text: 'Preflight 통과 — 120초 내 confirm 문구 입력 후 실행 가능 (실행 직전 서버가 전 조건을 재평가합니다)' }
        : { tone: 'error', text: `Preflight 실패 ${r.data.items.filter(i => !i.ok).length}건 — 아래 전체 항목 확인` });
    }
    await refreshStatus(pin);
    setBusy(null);
  };

  const onExecute = async () => {
    if (!preflight?.ok || !preflight.preflightId || confirmText !== CANARY_CONFIRM_OPEN || busy) return;
    setBusy('execute');
    setMessage(null);
    const r = await postCanaryExecute(pin, {
      preflightId: preflight.preflightId, confirm: confirmText, symbol, direction,
    });
    if (r.kind === 'auth') setMessage({ tone: 'error', text: '운영자 인증 실패' });
    else if (r.kind === 'error') setMessage({ tone: 'error', text: r.message });
    else {
      setLastResult(r.data);
      const d = r.data;
      setMessage(
        d.phase === 'SUBMITTED' ? { tone: 'ok', text: 'OPEN 제출됨 — 온체인 CONFIRMED·stop ACTIVE 증거를 아래 단계에서 확인하세요' }
        : d.phase === 'SIMULATED' ? { tone: 'warn', text: '시뮬레이션 — LIVE 잠금 상태, 실제 주문 0건' }
        : { tone: 'error', text: d.reason ?? '거부됨' });
    }
    setConfirmText('');
    setPreflight(null); // 1회성 — 재실행은 preflight부터
    await refreshStatus(pin);
    setBusy(null);
  };

  const onClose = async (emergency: boolean) => {
    if (closeConfirmText !== CANARY_CONFIRM_CLOSE || busy) return;
    setBusy(emergency ? 'emergency' : 'close');
    setMessage(null);
    const r = await postCanaryClose(pin, emergency
      ? { confirm: closeConfirmText, mode: 'emergency' }
      : { confirm: closeConfirmText });
    if (r.kind === 'auth') setMessage({ tone: 'error', text: '운영자 인증 실패' });
    else if (r.kind === 'error') setMessage({ tone: 'error', text: r.message });
    else {
      setLastResult(r.data);
      const d = r.data;
      setMessage(
        d.phase === 'SUBMITTED' ? { tone: 'ok', text: emergency ? 'Emergency close 제출됨' : 'Close 제출됨 — CONFIRMED·readback 대기' }
        : d.phase === 'SIMULATED' ? { tone: 'warn', text: '시뮬레이션 — 실제 주문 0건' }
        : { tone: 'error', text: d.reason ?? '거부됨' });
    }
    setCloseConfirmText('');
    await refreshStatus(pin);
    setBusy(null);
  };

  const caps = status?.caps ?? preflight?.caps ?? null;

  return (
    <Card className="p-5 flex flex-col gap-4 border-orange-500/25 bg-orange-500/5" data-testid="card-manual-canary">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bird className="w-4 h-4 text-orange-400" />
          <h3 className="text-sm font-semibold">Controlled Canary — 수동 1회</h3>
        </div>
        <button
          className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={!pinReady || busy !== null}
          onClick={() => { setBusy('status'); void refreshStatus(pin).finally(() => setBusy(null)); }}
          data-testid="button-canary-status-refresh"
        >
          {busy === 'status' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          상태
        </button>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        자동 Worker와 구조적으로 분리된 운영자 전용 1회 실행 경로입니다. 하드캡은 서버가 강제하며
        UI에서 확대할 수 없습니다. 현재 Production은 PAPER·LIVE 잠금 상태 — 실행 시 시뮬레이션
        (실제 주문 0건)으로 표시됩니다. 실제 실행은 별도 운영자 승인·설정 변경 후에만 가능합니다.
      </p>

      {/* 하드캡 읽기 전용 표시 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        {[
          ['담보', `≤ $${caps?.maxCollateralUsd ?? 10}`],
          ['레버리지', `≤ ${caps?.maxLeverage ?? 2}x`],
          ['동시 포지션', `${caps?.maxOpenPositions ?? 1}개`],
          ['누적 손실', `< $${caps?.maxAccumLossUsd ?? 3}`],
          ['일일 횟수', `${caps?.maxOrdersPerDay ?? 1}회`],
          ['왕복 비용', `≤ $${caps?.maxRoundTripCostUsd ?? 0.4}`],
          ['가격 드리프트', `≤ ${((caps?.maxPriceDriftFraction ?? 0.005) * 100).toFixed(1)}%`],
          ['시장', (caps?.allowedSymbols ?? ['BTC', 'ETH']).join('/')],
        ].map(([k, v]) => (
          <div key={k} className="rounded bg-background/60 border border-border/50 px-2 py-1 flex justify-between gap-1">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-mono">{v}</span>
          </div>
        ))}
      </div>

      {/* 선택 + PIN */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md overflow-hidden border border-border/60">
          {SYMBOLS.map(s => (
            <button key={s} onClick={() => setSymbol(s)} data-testid={`button-canary-symbol-${s}`}
              className={cn('px-3 py-1.5 text-xs font-mono', symbol === s ? 'bg-primary text-primary-foreground' : 'bg-background/50 text-muted-foreground')}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex rounded-md overflow-hidden border border-border/60">
          {DIRECTIONS.map(d => (
            <button key={d} onClick={() => setDirection(d)} data-testid={`button-canary-direction-${d}`}
              className={cn('px-3 py-1.5 text-xs font-mono',
                direction === d
                  ? d === 'LONG' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                  : 'bg-background/50 text-muted-foreground')}>
              {d}
            </button>
          ))}
        </div>
        <input
          type="password" value={pin} onChange={e => setPin(e.target.value)}
          placeholder="운영자 PIN" autoComplete="off" data-testid="input-canary-pin"
          className="w-32 px-2 py-1.5 text-xs rounded-md bg-background/70 border border-border/60 font-mono"
        />
        <button
          onClick={() => void onPreflight()} disabled={!pinReady || busy !== null}
          data-testid="button-canary-preflight"
          className="px-3 py-1.5 text-xs rounded-md bg-secondary hover:bg-secondary/80 disabled:opacity-40 flex items-center gap-1.5"
        >
          {busy === 'preflight' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldAlert className="w-3 h-3" />}
          1단계 Preflight (read-only)
        </button>
      </div>

      {message && (
        <div className={cn('text-xs rounded-md px-3 py-2 border',
          message.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : message.tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300')} data-testid="text-canary-message">
          {message.text}
        </div>
      )}

      {/* Preflight 결과 — 전체 항목 표시 (부분 은닉 금지) */}
      {preflight && (
        <div className="flex flex-col gap-1 max-h-56 overflow-y-auto rounded-md border border-border/50 bg-background/40 p-2">
          {preflight.items.map(item => (
            <div key={item.id} className="flex items-start gap-2 text-[11px]" data-testid={`row-canary-check-${item.id}`}>
              {item.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" /> : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-px" />}
              <span className="text-muted-foreground min-w-40">{item.label}</span>
              <span className={cn('font-mono break-all', item.ok ? 'text-foreground/80' : 'text-red-300')}>{item.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* 차단 그룹 섹션 */}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] text-muted-foreground font-medium">
          차단 항목 그룹 · 상태 새로고침에 포함
        </span>
        <BlockerGroupSection blockers={blockers} />
      </div>

      {/* 2단계 — confirm 문구 + 실행 */}
      {preflight?.ok && preflight.preflightId && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={confirmText} onChange={e => setConfirmText(e.target.value)}
            placeholder={`"${CANARY_CONFIRM_OPEN}" 입력`} autoComplete="off"
            data-testid="input-canary-confirm-open"
            className="flex-1 min-w-52 px-2 py-1.5 text-xs rounded-md bg-background/70 border border-border/60 font-mono"
          />
          <button
            onClick={() => void onExecute()}
            disabled={confirmText !== CANARY_CONFIRM_OPEN || busy !== null}
            data-testid="button-canary-execute"
            className="px-3 py-1.5 text-xs rounded-md bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy === 'execute' && <Loader2 className="w-3 h-3 animate-spin" />}
            2단계 실행 (직전 재평가)
          </button>
        </div>
      )}

      {/* 실행 직전 재평가 실패 목록 */}
      {lastResult && lastResult.failures.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-red-500/30 bg-red-500/5 p-2">
          <span className="text-[11px] text-red-300 font-medium">실행 직전 재평가 실패 — 제출 0회</span>
          {lastResult.failures.map(f => (
            <div key={f.id} className="flex items-start gap-2 text-[11px]">
              <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-px" />
              <span className="text-muted-foreground min-w-40">{f.label}</span>
              <span className="font-mono text-red-300 break-all">{f.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* 단계 표시 */}
      {status && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {STAGE_LABELS.map(({ key, label }) => {
              const st = status.stages[key];
              const tone = stageTone(st.status);
              return (
                <div key={key} data-testid={`badge-canary-stage-${key}`}
                  className={cn('flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px]',
                    tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10'
                    : tone === 'error' ? 'border-red-500/30 bg-red-500/10'
                    : tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10'
                    : 'border-border/50 bg-background/40')}>
                  <ToneIcon tone={tone} />
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground font-mono">{st.status}</span>
                </div>
              );
            })}
          </div>
          {status.daily?.openIntentId && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={closeConfirmText} onChange={e => setCloseConfirmText(e.target.value)}
                placeholder={`"${CANARY_CONFIRM_CLOSE}" 입력`} autoComplete="off"
                data-testid="input-canary-confirm-close"
                className="flex-1 min-w-52 px-2 py-1.5 text-xs rounded-md bg-background/70 border border-border/60 font-mono"
              />
              <button
                onClick={() => void onClose(false)}
                disabled={closeConfirmText !== CANARY_CONFIRM_CLOSE || busy !== null}
                data-testid="button-canary-close"
                className="px-3 py-1.5 text-xs rounded-md bg-secondary hover:bg-secondary/80 disabled:opacity-40"
              >
                {busy === 'close' ? '제출 중…' : 'Close (stop ACTIVE 증거 필요)'}
              </button>
              <button
                onClick={() => void onClose(true)}
                disabled={closeConfirmText !== CANARY_CONFIRM_CLOSE || busy !== null || status.daily.emergencyCloseUsed}
                data-testid="button-canary-emergency-close"
                className="px-3 py-1.5 text-xs rounded-md bg-red-700 hover:bg-red-600 text-white disabled:opacity-40"
              >
                {busy === 'emergency' ? '제출 중…' : status.daily.emergencyCloseUsed ? 'Emergency 사용됨 (1회)' : 'Emergency Close'}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
