import { amount, timestamp } from '@/lib/virtual400Presentation';
import { patternName, timeframeName } from '@/lib/virtualTradeEvidencePresentation';
import type { PatternEntryEvidence, AuxiliaryEntryCondition } from '@/lib/patternEntryEvidence';

function patternTime(value: number): string {
  return Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime())
    ? `${timestamp(new Date(value).toISOString(), true)} PHT` : '미확인';
}

export function PatternEntryRecord({ entry, conditions = [] }: {
  entry: PatternEntryEvidence; conditions?: AuxiliaryEntryCondition[];
}) {
  return <div className="ccc-callout" data-testid="pattern-leading-entry">
    <strong>진입 주도 패턴: {patternName(entry.patternId)} · {timeframeName(entry.timeframe)} · {entry.direction}</strong>
    <p>패턴 ID: <code>{entry.patternId}</code> · 확정 완료봉: {patternTime(entry.confirmedAt)}</p>
    <p>형성 기준: {patternTime(entry.formationAt)} · 진입 트리거 {amount(entry.triggerPrice, false, 6)}</p>
    <p>관측 손절 {amount(entry.stopPrice, false, 6)} · {entry.targetPrice === null
      ? '관측 목표 없음 · 손절 또는 최대 보유시간으로 청산'
      : `관측 목표 ${amount(entry.targetPrice, false, 6)}`}
      {' · '}최대 보유 {amount(entry.maxHoldMs / 3_600_000)}시간</p>
    <p>동일 방향 지지: {entry.supportingPatternIds.map(patternName).join(' · ') || '없음'}</p>
    <p>반대 방향 근거: {entry.conflictingPatternIds.map(patternName).join(' · ') || '기록 없음'}</p>
    <details className="mt-2"><summary>확정·무효화 규칙과 보조 평가</summary>
      <p>확정: {entry.auxiliary.confirmation}</p><p>진입: {entry.auxiliary.entry}</p>
      <p>무효화: {entry.auxiliary.invalidation}</p><p>청산: {entry.auxiliary.exit}</p>
      {conditions.map((c, i) => <p key={`${c.name}:${i}`}>
        {c.name}: {amount(c.value, false, 5)} · 참고 기준 {c.operator} {amount(c.threshold, false, 5)}
        {' · '}{c.passed === null ? '미측정' : c.passed ? '보조 기준 충족' : '보조 기준 미충족'}
        {' '}(진입 거부 조건 아님)
      </p>)}
      {!conditions.length && <p>추가 보조 조건 측정값은 이 기록에 없습니다.</p>}
      <p className="text-xs">사건 ID: {entry.eventId}</p>
    </details>
    <p className="mt-2 text-xs">저장된 진입 근거입니다. 도형으로 승률·기대수익을 만들지 않으며, 보조 점수와 실행 안전 조건은 별개입니다.</p>
  </div>;
}