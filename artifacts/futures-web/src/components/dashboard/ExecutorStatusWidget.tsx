/**
 * ExecutorStatusWidget — 대시보드 우측 열용 실행 엔진 상태 위젯 (컴팩트)
 *
 * 역할:
 *   - Replit 모니터링 상태 (RPC 헬스, 배포 모드, 가동 시간)
 *   - 외부 VPS 연결 상태 (외부 모드 선택 시)
 *   - ARM / DISARM 빠른 작동 버튼
 *   - 아키텍처 원칙 명시: Replit = 모니터링·제어, 외부 VPS = 실행 권한자
 *
 * 보안 원칙:
 *   - Replit에는 GMX 개인키·시드문구·signer key가 저장되지 않습니다.
 *   - LIVE 실행은 항상 외부 VPS /execute로 라우팅됩니다.
 */

import { useState } from 'react';
import { Link } from 'wouter';
import {
  Server, CheckCircle2, XCircle, Zap, ShieldOff, Loader2,
  AlertTriangle, Wifi, WifiOff, ExternalLink, Cpu, Globe,
  Eye, Clock,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useVpsContext, VPS_STATE_LABELS, formatUptime } from '@/lib/context/VpsContext';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const STATE_DOT: Record<string, string> = {
  OFF:         'bg-muted-foreground',
  ARMED:       'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)] animate-pulse',
  RECONCILING: 'bg-amber-400 animate-pulse',
  RUNNING:     'bg-[var(--color-long)] shadow-[0_0_8px_rgba(0,200,83,0.5)]',
  RISK_LOCKED: 'bg-[var(--color-short)] animate-pulse',
};

const STATE_BADGE: Record<string, string> = {
  OFF:         'bg-muted text-muted-foreground border-border',
  ARMED:       'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  RECONCILING: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  RUNNING:     'bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30',
  RISK_LOCKED: 'bg-[var(--color-short)]/10 text-[var(--color-short)] border-[var(--color-short)]/30',
};

export function ExecutorStatusWidget() {
  const {
    vpsState, connectionStatus, connectionError,
    health, unattendedArmed,
    armUnattended, disarmUnattended, testConnection,
    executorMode, internalDeploymentMode,
  } = useVpsContext();

  const [armDialog, setArmDialog]     = useState(false);
  const [disarmDialog, setDisarmDialog] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [testing, setTesting]         = useState(false);

  const handleArm = async () => {
    setActionLoading(true);
    setActionError('');
    const r = await armUnattended();
    setActionLoading(false);
    if (r.ok) setArmDialog(false);
    else setActionError(r.error ?? '알 수 없는 오류');
  };

  const handleDisarm = async () => {
    setActionLoading(true);
    setActionError('');
    const r = await disarmUnattended();
    setActionLoading(false);
    if (r.ok) setDisarmDialog(false);
    else setActionError(r.error ?? '알 수 없는 오류');
  };

  const handleRefresh = async () => {
    setTesting(true);
    await testConnection();
    setTesting(false);
  };

  const isConnected  = connectionStatus === 'connected';
  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'disconnected';
  const ModeIcon     = executorMode === 'internal' ? Cpu : Globe;

  const lastRecon = health.reconciliation?.lastAt;

  return (
    <Card className={cn(
      'overflow-hidden border',
      vpsState === 'ARMED' || vpsState === 'RUNNING'
        ? 'border-cyan-500/20'
        : vpsState === 'RISK_LOCKED'
          ? 'border-[var(--color-short)]/30'
          : 'border-border',
    )}>
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card/50 border-b border-border">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">실행 엔진</span>
          <span className={cn(
            'text-[9px] px-1.5 py-0.5 rounded-full border font-bold tracking-wider flex items-center gap-1',
            executorMode === 'internal'
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-amber-500/10 text-amber-400 border-amber-500/30',
          )}>
            <ModeIcon className="w-2.5 h-2.5" />
            {executorMode === 'internal' ? 'REPLIT' : 'EXTERNAL VPS'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {health.uptimeSeconds != null && (
            <span className="text-[10px] text-muted-foreground font-mono">
              ↑ {formatUptime(health.uptimeSeconds)}
            </span>
          )}
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold tracking-wider',
            STATE_BADGE[vpsState] ?? STATE_BADGE.OFF,
          )}>
            <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATE_DOT[vpsState] ?? STATE_DOT.OFF)} />
            {VPS_STATE_LABELS[vpsState] ?? vpsState}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">

        {/* 연결 상태 행 */}
        <div className="flex items-center gap-2 text-xs">
          {isConnected
            ? <Wifi className="w-3.5 h-3.5 text-[var(--color-long)]" />
            : isConnecting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              : <WifiOff className="w-3.5 h-3.5 text-[var(--color-short)]" />
          }
          <span className={cn(
            'font-semibold',
            isConnected ? 'text-[var(--color-long)]' : isConnecting ? 'text-muted-foreground' : 'text-[var(--color-short)]',
          )}>
            {isConnected ? '연결됨' : isConnecting ? '연결 중…' : '연결 불가'}
          </span>
          {connectionError && !isConnecting && (
            <span className="text-[var(--color-short)] text-[10px] truncate">{connectionError}</span>
          )}
          <button
            onClick={handleRefresh}
            disabled={testing}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : '↻ 새로 고침'}
          </button>
        </div>

        {/* 상태 배지 */}
        <div className="grid grid-cols-2 gap-1.5">
          {/* Replit 역할 명시 */}
          <div className="col-span-2 flex items-center gap-1.5 px-2 py-1.5 rounded border border-primary/20 bg-primary/5 text-primary text-[10px] font-medium">
            <Eye className="w-3 h-3 shrink-0" />
            모니터링·승인·제어 전용 (실행 = 외부 VPS)
          </div>

          {/* GMX RPC 헬스 */}
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium',
            health.gmxConnected
              ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
              : 'border-border bg-card/50 text-muted-foreground',
          )}>
            {health.gmxConnected
              ? <CheckCircle2 className="w-3 h-3 shrink-0" />
              : <XCircle className="w-3 h-3 shrink-0" />
            }
            GMX RPC {health.gmxConnected ? '정상' : '오프라인'}
          </div>

          {/* 배포 모드 */}
          {executorMode === 'internal' && (
            <div className={cn(
              'flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium',
              internalDeploymentMode === 'reserved_vm'
                ? 'border-primary/30 bg-primary/5 text-primary'
                : 'border-border bg-card/50 text-muted-foreground',
            )}>
              <Server className="w-3 h-3 shrink-0" />
              {internalDeploymentMode === 'reserved_vm' ? 'Reserved VM' : '개발 모드'}
            </div>
          )}

          {/* 리스크 잠금 */}
          {health.riskLock ? (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)] text-[10px] font-medium">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              리스크 잠금
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-[var(--color-long)]/20 bg-[var(--color-long)]/5 text-[var(--color-long)] text-[10px] font-medium">
              <CheckCircle2 className="w-3 h-3 shrink-0" />
              리스크 정상
            </div>
          )}

          {/* GMX 지갑 주소 (공개 주소만 표시) */}
          {health.walletAddress && (
            <div className="col-span-2 flex items-center gap-1.5 px-2 py-1.5 rounded border border-border bg-card/30 text-muted-foreground text-[10px]">
              <CheckCircle2 className="w-3 h-3 shrink-0 text-[var(--color-long)]" />
              <span className="font-mono truncate">{health.walletAddress}</span>
            </div>
          )}

          {/* 서브계정 주소 */}
          {health.subaccountAddress && (
            <div className="col-span-2 flex items-center gap-1.5 px-2 py-1.5 rounded border border-border bg-card/30 text-muted-foreground text-[10px]">
              <CheckCircle2 className="w-3 h-3 shrink-0 text-cyan-400" />
              <span className="text-[9px] text-cyan-400 font-bold mr-1">SUB</span>
              <span className="font-mono truncate">{health.subaccountAddress}</span>
            </div>
          )}

          {/* 마지막 화해(Reconciliation) 시간 */}
          {lastRecon && (
            <div className="col-span-2 flex items-center gap-1.5 px-2 py-1.5 rounded border border-border bg-card/30 text-muted-foreground text-[10px]">
              <Clock className="w-3 h-3 shrink-0" />
              마지막 화해: {format(new Date(lastRecon), 'HH:mm:ss')}
            </div>
          )}
        </div>

        {/* ARM / DISARM */}
        {!unattendedArmed ? (
          <Button
            size="sm"
            className="w-full font-bold tracking-wider h-8"
            style={{ background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)', color: '#000' }}
            onClick={() => setArmDialog(true)}
            disabled={!isConnected}
          >
            <Zap className="w-3.5 h-3.5 mr-1.5" />
            자율 거래 ARM
          </Button>
        ) : (
          <Button
            size="sm" variant="outline"
            className="w-full font-bold text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/10 h-8"
            onClick={() => setDisarmDialog(true)}
          >
            <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
            DISARM — 자율 거래 중지
          </Button>
        )}

        {/* 설정 링크 */}
        <Link
          href="/settings"
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors w-fit"
        >
          <ExternalLink className="w-3 h-3" />
          Settings에서 전체 실행 엔진 구성
        </Link>
      </div>

      {/* ARM 확인 다이얼로그 */}
      <Dialog open={armDialog} onOpenChange={o => { if (!o) { setArmDialog(false); setActionError(''); } }}>
        <DialogContent className="border-cyan-500/30">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-cyan-400">
              <Zap className="w-5 h-5" /> 자율 거래 ARM
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm pt-2">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    <li>외부 VPS가 <strong>24/7</strong> 자율 거래를 수행합니다.</li>
                    <li>LIVE 모드에서 실제 GMX V2 주문이 Arbitrum One에 전송됩니다.</li>
                    <li>리스크 컨트롤 (일일 손실, 드로우다운, 연속 손실)은 항상 활성화됩니다.</li>
                    <li><strong>실제 실행에는 외부 VPS에 GMX 서브계정 키 설정이 필요합니다.</strong></li>
                  </ul>
                </div>
                {actionError && <div className="text-[var(--color-short)] text-xs">{actionError}</div>}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setArmDialog(false); setActionError(''); }}>취소</Button>
            <Button onClick={handleArm} disabled={actionLoading}
              className="font-bold tracking-wider"
              style={{ background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)', color: '#000' }}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
              확인 — ARM
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DISARM 확인 다이얼로그 */}
      <Dialog open={disarmDialog} onOpenChange={o => { if (!o) { setDisarmDialog(false); setActionError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff className="w-5 h-5" /> 자율 거래 DISARM
            </DialogTitle>
            <DialogDescription className="text-sm pt-2">
              실행 엔진이 새 자율 포지션 개설을 중단합니다. 기존 포지션은 TP/SL 주문이 활성화된 상태로 유지됩니다.
              {actionError && <div className="text-[var(--color-short)] mt-2">{actionError}</div>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDisarmDialog(false); setActionError(''); }}>취소</Button>
            <Button variant="destructive" onClick={handleDisarm} disabled={actionLoading}>
              {actionLoading && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              DISARM
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
