/**
 * CanaryAllowanceCard — Controlled Canary 전용 USDC allowance 승인 카드 (#124-B).
 *
 * 흐름: 서버 authoritative 파라미터 조회(verified 교차검증) → 현재 allowance read-only 표시
 * → 검토 화면(token/spender/amount/chain) → MetaMask approve 1회(정확히 15 USDC)
 * → receipt success + allowance readback ≥15 확인 후에만 완료 표시.
 * 실패/취소/receipt 불명확 = fail-closed, 자동 retry 0회. unlimited approval 절대 금지.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Coins, Loader2, CheckCircle2, XCircle, ShieldAlert, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWallet } from '@/lib/context';
import { apiUrl } from '@/lib/apiUrl';
import {
  canAttemptCanaryApprove, buildCanaryApproveCalldata, isExactCanaryApproveCalldata,
  evaluateApproveCompletion, formatAllowanceUnits, CANARY_APPROVE_AMOUNT_UNITS,
  type CanaryAllowanceServerInfo,
} from '@/lib/canaryAllowance';

type Phase = 'idle' | 'review' | 'submitting' | 'confirming' | 'complete' | 'failed';

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

async function fetchServerInfo(): Promise<CanaryAllowanceServerInfo | null> {
  try {
    const res = await fetch(apiUrl('executor/allowance/canary'));
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('application/json')) return null;
    return await res.json() as CanaryAllowanceServerInfo;
  } catch {
    return null;
  }
}

export function CanaryAllowanceCard() {
  const wallet = useWallet();
  const [server, setServer] = useState<CanaryAllowanceServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const busyRef = useRef(false); // 중복 클릭 방어 (state 갱신 지연 대비)

  const refresh = useCallback(async () => {
    setLoading(true);
    setServer(await fetchServerInfo());
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const busy = phase === 'submitting' || phase === 'confirming';
  const gate = canAttemptCanaryApprove({
    server,
    walletStatus: wallet.status,
    walletAddress: wallet.address,
    walletChainId: wallet.chainId,
    isArbitrum: wallet.isArbitrum,
    busy,
  });

  const alreadyApproved = (() => {
    if (!server?.allowanceUnits) return false;
    try { return BigInt(server.allowanceUnits) >= CANARY_APPROVE_AMOUNT_UNITS; } catch { return false; }
  })();

  // 메인 지갑 ETH 부족 안내 (approve tx 가스는 main wallet이 지불)
  const mainEthLow = wallet.status === 'connected' && wallet.ethBalance !== null && Number(wallet.ethBalance) < 0.0003;

  const handleApprove = useCallback(async () => {
    if (busyRef.current) return; // 중복 클릭 차단
    setMessage(null);
    if (!gate.ok) { setMessage({ tone: 'error', text: gate.reasons.join(' · ') }); return; }
    const s = server!;
    const spender = s.spenderAddress!;
    const data = buildCanaryApproveCalldata(spender);
    if (!data || !isExactCanaryApproveCalldata(data, spender)) {
      setPhase('failed');
      setMessage({ tone: 'error', text: 'approve calldata 검증 실패 — 차단 (fail-closed)' });
      return;
    }
    const ethereum = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!ethereum) { setMessage({ tone: 'error', text: 'MetaMask provider를 찾을 수 없습니다.' }); return; }

    busyRef.current = true;
    setPhase('submitting');
    let hash: string;
    try {
      hash = await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: wallet.address, to: s.usdcAddress, data, value: '0x0' }],
      }) as string;
    } catch (err) {
      busyRef.current = false;
      setPhase('failed');
      const code = (err as { code?: number })?.code;
      setMessage({
        tone: code === 4001 ? 'warn' : 'error',
        text: code === 4001
          ? '서명이 취소되었습니다 — 아무것도 승인되지 않았습니다. (자동 재시도 없음)'
          : 'approve 트랜잭션 전송 실패 — fail-closed. 자동 재시도하지 않습니다.',
      });
      return;
    }
    setTxHash(hash);
    setPhase('confirming');

    // receipt 폴링 (최대 24회 × 5초 = 2분) — 재전송/재시도 아님, 동일 tx 조회만
    let receiptStatus: string | null = null;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const receipt = await ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as { status?: string } | null;
        if (receipt && typeof receipt.status === 'string') { receiptStatus = receipt.status; break; }
      } catch { /* 조회 오류 → 다음 폴링 (전송 재시도 아님) */ }
    }

    // allowance readback (서버 read-only 재조회)
    const after = await fetchServerInfo();
    setServer(after);
    const verdict = evaluateApproveCompletion({
      receiptStatus,
      allowanceReadbackUnits: after?.allowanceUnits ?? null,
    });
    busyRef.current = false;
    if (verdict === 'complete') {
      setPhase('complete');
      setMessage({ tone: 'ok', text: `완료 — receipt success + allowance readback ≥ 15 USDC 확인됨. (tx: ${hash.slice(0, 10)}…)` });
    } else {
      setPhase('failed');
      setMessage({
        tone: 'error',
        text: receiptStatus === null
          ? 'receipt를 확정하지 못했습니다 — 완료로 표시하지 않습니다 (fail-closed). Arbiscan에서 tx를 직접 확인하세요. 자동 재시도 없음.'
          : receiptStatus !== '0x1'
            ? 'approve 트랜잭션이 revert되었습니다 — 완료 아님 (fail-closed). 자동 재시도 없음.'
            : 'allowance readback이 15 USDC 미만입니다 — 완료 아님 (fail-closed). 자동 재시도 없음.',
      });
    }
  }, [gate, server, wallet.address]);

  const toneCls = {
    ok:    'border-[var(--color-long)]/40 bg-[var(--color-long)]/10 text-[var(--color-long)]',
    warn:  'border-amber-500/40 bg-amber-500/10 text-amber-400',
    error: 'border-[var(--color-short)]/40 bg-[var(--color-short)]/10 text-[var(--color-short)]',
  } as const;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="card-canary-allowance">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Canary USDC Allowance (정확히 15 USDC)</h3>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading || busy}
          className="text-muted-foreground hover:text-foreground disabled:opacity-40"
          data-testid="button-refresh-canary-allowance"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 서버 파라미터 확인 중…</div>
      ) : !server?.ok ? (
        <div className="text-xs text-[var(--color-short)]">서버 canary allowance 파라미터 조회 실패 — approve 차단 (fail-closed)</div>
      ) : (
        <>
          {!server.verified && (
            <div className="flex items-start gap-2 rounded border border-[var(--color-short)]/40 bg-[var(--color-short)]/10 p-2 text-xs text-[var(--color-short)]" data-testid="text-canary-unverified">
              <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>교차검증(verified) 미통과 — approve 비활성: {server.reasons.join(' · ')}</div>
            </div>
          )}
          <dl className="grid grid-cols-1 gap-1.5 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">체인</dt><dd className="font-mono">Arbitrum One (42161)</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Token (USDC)</dt><dd className="font-mono break-all" data-testid="text-canary-usdc">{server.usdcAddress}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Spender (SyntheticsRouter)</dt><dd className="font-mono break-all" data-testid="text-canary-spender">{server.spenderAddress ?? '미검증'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">승인 금액</dt><dd className="font-mono">정확히 15.00 USDC (unlimited 금지)</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">현재 allowance</dt><dd className="font-mono" data-testid="text-canary-allowance">{formatAllowanceUnits(server.allowanceUnits)}</dd></div>
          </dl>

          {alreadyApproved && phase !== 'complete' && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-long)]"><CheckCircle2 className="h-3.5 w-3.5" /> 현재 allowance가 이미 15 USDC 이상입니다 — 추가 approve 불필요.</div>
          )}
          {mainEthLow && (
            <div className="text-xs text-amber-400">메인 지갑 ETH 잔고가 낮습니다 — approve 트랜잭션 가스(소액의 Arbitrum ETH)가 필요합니다. 충전 후 진행하세요. (delegated signer에는 ETH가 필요 없습니다 — GMX API v2 signer gas: 0 ETH)</div>
          )}

          {phase === 'idle' || phase === 'failed' ? (
            <button
              onClick={() => { setMessage(null); setPhase('review'); }}
              disabled={!gate.ok || alreadyApproved}
              className="w-full rounded bg-secondary px-3 py-2 text-xs font-medium hover:bg-secondary/80 disabled:opacity-40"
              data-testid="button-review-canary-approve"
            >
              승인 검토 (Review)
            </button>
          ) : null}

          {!gate.ok && (phase === 'idle' || phase === 'failed') && (
            <ul className="list-disc pl-4 text-[11px] text-muted-foreground space-y-0.5">
              {gate.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}

          {phase === 'review' && (
            <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
              <p className="text-xs font-medium text-amber-400">MetaMask 팝업에서 아래 값이 정확히 일치하는지 확인 후 승인하세요:</p>
              <ul className="text-[11px] font-mono space-y-0.5">
                <li>chain: Arbitrum One (42161)</li>
                <li>to (USDC): {server.usdcAddress}</li>
                <li>approve spender: {server.spenderAddress}</li>
                <li>amount: 15.00 USDC — unlimited/max이면 절대 승인 금지</li>
              </ul>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleApprove()}
                  disabled={busy}
                  className="flex-1 rounded bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
                  data-testid="button-send-canary-approve"
                >
                  MetaMask로 approve 전송 (1회)
                </button>
                <button
                  onClick={() => setPhase('idle')}
                  disabled={busy}
                  className="rounded bg-secondary px-3 py-2 text-xs disabled:opacity-40"
                  data-testid="button-cancel-canary-approve"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'submitting' ? 'MetaMask 승인 대기 중… (팝업 확인)' : `receipt 확인 중… ${txHash ? `(${txHash.slice(0, 10)}…)` : ''}`}
            </div>
          )}

          {phase === 'complete' && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-long)]" data-testid="text-canary-complete"><CheckCircle2 className="h-4 w-4" /> Allowance 준비 완료 (receipt + readback 검증됨)</div>
          )}
          {phase === 'failed' && message === null && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-short)]"><XCircle className="h-4 w-4" /> 실패 — fail-closed</div>
          )}
        </>
      )}

      {message && <div className={cn('rounded border p-2 text-xs', toneCls[message.tone])} data-testid="text-canary-message">{message.text}</div>}
    </div>
  );
}
