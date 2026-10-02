import type { VirtualPaper400Snapshot } from './context/VirtualPaper400Context';
import { explainReason } from './virtual400Presentation';

export const ACTIVITY_LABELS = {
  CHECKING_ACCOUNT: '계정·보호 상태 확인 중', CHECKING_COSTS: '거래 비용 확인 중',
  ANALYZING_MARKETS: '확정 캔들·전략 분석 중', CHECKING_ENTRY: '위험·진입 조건 검증 중',
  EXECUTING_PAPER: '가상 주문·보호 처리 중', RECONCILING: '체결·정산 기록 확인 중',
  WAITING: '다음 분석 주기 대기', BLOCKED: '진입 차단 사유 확인', STOPPED: '신규 진입 중지',
  ERROR: '분석 주기 오류',
} as const;
export type ActivityPhase = keyof typeof ACTIVITY_LABELS;
export interface VirtualActivity {
  schemaVersion: 'virtual-activity/v1'; source: 'SERVER_STRATEGY_ENGINE'; sessionId: string;
  cycleNumber: number; startedAt: string; updatedAt: string; phase: ActivityPhase; symbols: string[];
  outcome: string | null; reason: string | null; analysisCompletedAt: string | null;
  results: { symbol: string; reason: string; evaluated: boolean }[];
  events: { phase: ActivityPhase; at: string; symbols: string[] }[];
}
const isPhase = (v: unknown): v is ActivityPhase => typeof v === 'string' && Object.hasOwn(ACTIVITY_LABELS, v);
const symbolList = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.filter((s): s is string => typeof s === 'string' && ['BTC','ETH','SOL'].includes(s)))] : [];
export function freshVirtualActivity(data: VirtualPaper400Snapshot | null, now: number): VirtualActivity | null {
  const a = data?.activity;
  if (!a || data?.activityFresh !== true || a.schemaVersion !== 'virtual-activity/v1'
    || a.source !== 'SERVER_STRATEGY_ENGINE' || !isPhase(a.phase)
    || !Number.isSafeInteger(a.cycleNumber) || a.cycleNumber < 0) return null;
  const start = Date.parse(a.startedAt), at = Date.parse(a.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(at) || start > at || at > now || now - at > 120_000) return null;
  return { ...a, symbols: symbolList(a.symbols),
    results: Array.isArray(a.results) ? a.results.filter(r => r && symbolList([r.symbol]).length
      && typeof r.reason === 'string' && typeof r.evaluated === 'boolean').slice(0, 3) : [],
    events: Array.isArray(a.events) ? a.events.filter(e => e && isPhase(e.phase)
      && Date.parse(e.at) >= start && Date.parse(e.at) <= at).slice(-12) : [],
    reason: typeof a.reason === 'string' ? a.reason : null,
    analysisCompletedAt: a.analysisCompletedAt && Date.parse(a.analysisCompletedAt) >= start
      && Date.parse(a.analysisCompletedAt) <= at ? a.analysisCompletedAt : null };
}
export function activityReason(reason: string | null | undefined): string {
  if (reason === 'CYCLE_FAILED') return '이번 분석 주기를 완료하지 못했습니다. 다음 서버 상태를 확인해 주세요.';
  if (reason?.includes('TRANSITION')) return '시장 국면 전환 중 · 신규 전략 조건 대기';
  if (reason?.includes('ANALYSIS_NOT_EVALUATED')) return '시장 데이터 또는 분석 실행 조건 확인 대기';
  return explainReason(reason);
}
export function activityPresentation(data: VirtualPaper400Snapshot | null, runtimeFresh: boolean, now: number) {
  const activity = freshVirtualActivity(data, now);
  const state = data?.session.status;
  const terminal = ['WAITING','BLOCKED','STOPPED','ERROR'].includes(activity?.phase ?? '');
  const live = state === 'ACTIVE' && !!activity && !terminal;
  const phase = state === 'STOPPED' ? 'STOPPED' : activity?.phase ?? null;
  const headline = state === 'STOPPED' ? ACTIVITY_LABELS.STOPPED : state === 'MISSING' ? '가상 매매 시작 전'
    : activity ? ACTIVITY_LABELS[activity.phase] : '최신 분석 활동 확인 대기';
  const reason = state === 'STOPPED' ? '기존 포지션 보호는 계속되며 신규 진입 분석은 중지됩니다.'
    : state === 'MISSING' ? '가상 매매를 시작하면 서버의 분석 활동을 표시합니다.'
    : !activity ? '서버의 최신 활동을 확인하고 있습니다. 이전 기록을 현재 분석으로 표시하지 않습니다.'
    : live ? ({ CHECKING_ACCOUNT: '저장된 계정·위험 제한과 기존 포지션을 확인합니다.',
        CHECKING_COSTS: '감시 종목의 매수·매도 방향별 거래 비용을 확인합니다.',
        ANALYZING_MARKETS: '15분·1시간·4시간 확정 캔들과 시장 국면·전략 조건을 평가합니다.',
        CHECKING_ENTRY: '전략 신호의 위험·신뢰도·가격·비용 기준을 검증합니다.',
        EXECUTING_PAPER: '가상 주문 또는 기존 포지션의 보호 처리를 진행합니다.',
        RECONCILING: '서버의 체결·손익 정산 기록을 다시 확인합니다.' }[activity.phase as Exclude<ActivityPhase,'WAITING'|'BLOCKED'|'STOPPED'|'ERROR'>])
    : activity.reason ? activityReason(activity.reason)
    : activity.outcome === 'OPENED' ? '가상 진입 처리가 완료됐습니다. 보유 포지션을 확인해 주세요.'
    : activity.outcome === 'CLOSED' || activity.outcome === 'REDUCED' ? '가상 포지션 관리와 기록 확인이 완료됐습니다.'
    : '이번 서버 주기가 끝났습니다. 다음 분석을 기다립니다.';
  // Old server versions may supply completed analysis only. Label it as history,
  // never pretend it is an in-progress event or run a client-side scan animation.
  const historical = !data?.activity && runtimeFresh && Array.isArray(data?.runtime?.analysis)
    ? data.runtime.analysis.filter(r => r && symbolList([r.symbol]).length && typeof r.reason === 'string')
      .slice(0, 3).map(r => ({ ...r, evaluated: true })) : [];
  const results = activity?.results ?? historical;
  const symbols = [...new Set([...(live ? activity.symbols : []), ...results.map(r => r.symbol)])];
  return { activity, phase, headline, reason, live, results, symbols,
    updatedAt: activity?.updatedAt ?? (historical.length ? data?.runtime?.at : null),
    tone: activity?.phase === 'ERROR' ? 'error' : live ? 'live' : 'quiet' };
}
