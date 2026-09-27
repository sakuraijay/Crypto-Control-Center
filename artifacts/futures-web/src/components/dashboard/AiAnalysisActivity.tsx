import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { ACTIVITY_LABELS, activityPresentation, activityReason, type ActivityPhase } from '@/lib/virtualActivityPresentation';
import { timestamp } from '@/lib/virtual400Presentation';

const steps: { phase: ActivityPhase; label: string }[] = [
  { phase: 'CHECKING_ACCOUNT', label: '계정·보호 확인' }, { phase: 'CHECKING_COSTS', label: '거래 비용 확인' },
  { phase: 'ANALYZING_MARKETS', label: '확정 캔들·전략 분석' }, { phase: 'CHECKING_ENTRY', label: '위험·진입 판단' },
];
export function AiAnalysisActivity() {
  const { data, fresh, now } = useVirtualPaper400();
  const view = activityPresentation(data, fresh, now);
  const observed = new Set(view.activity?.events.map(e => e.phase) ?? []);
  return <section className="ccc-panel ccc-ai-activity" aria-label="AI 분석 활동">
    <header className="ccc-ai-activity-heading"><div><p className="ccc-eyebrow">AI ACTIVITY</p><h2>AI 분석 활동</h2></div>
      <span role="status" className={`ccc-ai-state is-${view.tone}`}><i aria-hidden="true" />{view.headline}</span></header>
    <p className="ccc-ai-summary">{view.reason}</p>
    <ol className="ccc-ai-stages" aria-label="이번 서버 주기에서 관측한 단계">{steps.map(step => {
      const current = view.live && view.phase === step.phase;
      return <li key={step.phase} className={current ? 'is-current' : observed.has(step.phase) ? 'is-observed' : ''}
        aria-current={current ? 'step' : undefined}><span>{step.label}</span>
        <small>{current ? '진행 중' : observed.has(step.phase) ? '관측됨' : '미관측'}</small></li>;
    })}</ol>
    {view.symbols.length > 0 ? <div className="ccc-ai-symbols">{view.symbols.map(symbol => {
      const result = view.results.find(row => row.symbol === symbol);
      const active = view.live && view.activity?.symbols.includes(symbol);
      return <article key={symbol}><strong>{symbol}</strong><span className={active ? 'ccc-positive' : ''}>
        {active && view.phase ? ACTIVITY_LABELS[view.phase] : result?.evaluated ? '최근 분석 결과' : '분석 확인 대기'}</span>
        {result && <p>{activityReason(result.reason)}</p>}
      </article>;
    })}</div> : <p className="ccc-ai-unavailable">현재 분석 종목은 최신 서버 활동이 확인되면 표시합니다.</p>}
    <footer className="ccc-ai-meta"><span>확정 캔들 기반 전략 엔진 · 서버 관측</span>
      <span>활동 갱신 {timestamp(view.updatedAt)}{view.updatedAt ? ' PHT' : ''}</span>
      <span>마지막 분석 완료 {timestamp(view.activity?.analysisCompletedAt)}{view.activity?.analysisCompletedAt ? ' PHT' : ''}</span></footer>
    {!!view.activity?.events.length && <details className="ccc-ai-events"><summary>이번 주기 활동 기록 · #{view.activity.cycleNumber}</summary>
      <ol>{view.activity.events.map((event, i) => <li key={`${event.at}-${i}`}><time>{timestamp(event.at)}</time><span>{ACTIVITY_LABELS[event.phase]}</span></li>)}</ol>
    </details>}
  </section>;
}
