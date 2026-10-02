import { amount } from '@/lib/virtual400Presentation';
import { patternName, timeframeName } from '@/lib/virtualTradeEvidencePresentation';
import { patternEntryReason, type PatternEntrySnapshot } from '@/lib/patternEntryEvidence';
import { PatternEntryRecord } from './PatternEntryRecord';

export function PatternEntryDiagnostics({ snapshot, fresh, now = Date.now() }: {
  snapshot?: PatternEntrySnapshot | null; fresh: boolean; now?: number;
}) {
  const observed = snapshot?.evaluatedAt;
  const current = fresh && !!snapshot && Number.isFinite(observed) &&
    now >= observed! && now - observed! <= 120_000;
  return <section className="ccc-panel" aria-label="패턴 주도 진입 상태" data-testid="pattern-entry-diagnostics">
    <div className="ccc-panel-heading"><div><p className="ccc-eyebrow">PATTERN ENTRY STRATEGIES</p>
      <h2>38개 패턴 · 독립 진입 판단</h2></div><span className="ccc-caption">완료봉 · 확정 pivot · 수익성 미검증</span></div>
    <p className="ccc-diagnostics-note">새 진입 정책: virtual400-daily/v10 · paper-pattern-entry/v10. 각 패턴은 진입 주도 후보를 만들며, 이전 정책의 패턴 기록은 순위 참고 자료입니다. 과거 참고 기록이나 이미지 분석을 새 주문 근거로 바꾸지 않습니다. 아래 서버 증거가 없으면 정책 적용·진입 여부도 확인 대기로 표시합니다.</p>
    {!current || !snapshot ? <div className="ccc-empty-row"><div><strong>패턴 진입 자료 확인 대기</strong>
      <p>신선한 새 정책 평가가 없으므로 대기·후보·진입 횟수를 추정하지 않습니다. 과거 기록은 재작성하지 않습니다.</p></div></div> : <>
      <div className="ccc-diagnostics-summary">
        <div><span>이번 평가 · 확인된 패턴 후보</span><strong>{snapshot.candidates.length}</strong></div>
        <div><span>방향·확정·손절 확인 대기</span><strong>{snapshot.waiting.length}</strong></div>
        <div><span>양방향 충돌</span><strong>{snapshot.conflicts.length}</strong></div>
      </div>
      <p className="ccc-diagnostics-note">{snapshot.version} · 후보 수는 주문 수가 아닙니다. 추세·모멘텀·국면·변동성·비용 후 손익비는 보조 정보입니다. 유효 시세·실제 추정 비용·손절·손실 예산·단일 포지션·중복 방지는 실행 전에 확인합니다.</p>
      {snapshot.candidates.slice(0, 12).map(entry => <div key={entry.eventId} className="mt-3">
        <strong>{entry.symbol}</strong><PatternEntryRecord entry={entry} conditions={entry.auxiliaryConditions} /></div>)}
      {snapshot.candidates.length > 12 && <p>후보 {snapshot.candidates.length}개 중 12개 표시</p>}
      {snapshot.waiting.slice(0, 24).map(row => <div key={row.eventId} className="ccc-callout mt-2">
        <strong>{row.symbol} · {timeframeName(row.timeframe)} · {patternName(row.patternId)} · 확인 대기</strong>
        <p>{patternEntryReason(row.reason)}</p>
        {(row.upperTrigger !== null || row.lowerTrigger !== null) && <p>상방 종가 돌파 {amount(row.upperTrigger, false, 6)} · 하방 종가 돌파 {amount(row.lowerTrigger, false, 6)} · 확인 전 방향·주문 없음</p>}
      </div>)}
      {snapshot.waiting.length > 24 && <p>대기 {snapshot.waiting.length}개 중 24개 표시</p>}
      {snapshot.conflicts.map(row => <div key={row.eventId} className="ccc-callout mt-2">
        <strong>{row.symbol} · {timeframeName(row.timeframe)} · 방향 충돌</strong>
        <p>LONG: {row.longPatternIds.map(patternName).join(' · ')} / SHORT: {row.shortPatternIds.map(patternName).join(' · ')}</p>
        <p>{patternEntryReason(row.reason)}</p>
      </div>)}
      {!snapshot.candidates.length && !snapshot.waiting.length && !snapshot.conflicts.length && <p className="ccc-callout">이번 자료에서 확인된 패턴 사건이 없습니다. 없는 방향·손절·기대수익을 만들지 않습니다.</p>}
    </>}
  </section>;
}