/** Stored server evidence, never client-generated order authority. */
export interface PatternEntryEvidence {
  eventId: string;
  durableFormationId: string;
  symbol: string;
  patternId: string;
  timeframe: '15m' | '1h' | '4h';
  direction: 'LONG' | 'SHORT';
  formationAt: number;
  confirmedAt: number;
  triggerPrice: number;
  referencePrice: number;
  stopPrice: number;
  targetPrice: number | null;
  targetBasis: string | null;
  expiresAt: number;
  maxHoldMs: number;
  supportingPatternIds: string[];
  conflictingPatternIds: string[];
  auxiliary: {
    formation: string; confirmation: string; entry: string; invalidation: string;
    exit: string; observedTarget: string | null;
  };
  auxiliaryConditions?: AuxiliaryEntryCondition[];
}
export interface PatternEntrySnapshot {
  version: string;
  evaluatedAt?: number | null;
  candidates: PatternEntryEvidence[];
  waiting: {
    symbol: string; eventId: string; patternId: string; timeframe: string;
    formationAt: number; reason: string; upperTrigger: number | null; lowerTrigger: number | null;
  }[];
  conflicts: {
    symbol: string; eventId: string; timeframe: string; formationAt: number;
    reason: string; longPatternIds: string[]; shortPatternIds: string[];
  }[];
}
export interface AuxiliaryEntryCondition {
  name: string; value: number | null; operator: string; threshold: number | null;
  passed: boolean | null; role: 'AUXILIARY';
}
export function patternEntryReason(reason: string): string {
  const labels: Record<string, string> = {
    'Neutral formation awaits a completed close above its high or below its low.': '중립 형태입니다. 후속 완료봉 종가의 상방·하방 돌파 전까지 방향과 진입을 정하지 않습니다.',
    'First breakout direction is frozen; observed formation stop was subsequently invalidated.': '첫 확인 방향은 유지하지만 관측 손절이 이후 무효화되어 이 사건의 진입을 보류합니다. 반대 방향으로 재사용하지 않습니다.',
    'First breakout direction is frozen; entry window expired.': '첫 확인 방향의 진입 유효시간이 끝났습니다. 같은 사건을 새 확인으로 연장하지 않습니다.',
    'No valid observed formation invalidation stop on the protective side of the completed reference close.': '관측된 무효화·손절이 진입 방향의 보호 쪽에 유효하지 않습니다. 손절을 뒤집거나 만들어 통과시키지 않습니다.',
    'Opposite completed pattern evidence on the same timeframe; directional entry withheld.': '동일 시간대의 완료 패턴 방향이 충돌하여 진입을 보류합니다.',
    'CONFLICT: opposite-side completed pattern evidence; no side selected.': '반대 방향 완료 패턴이 함께 확인되어 방향을 선택하지 않았습니다.',
    CROSS_TIMEFRAME_OPPOSING_EVIDENCE_WITHHELD: '시간대 간 완료 패턴의 방향이 충돌하여 이 종목의 진입을 보류합니다.',
    UNSUPPORTED_ENTRY_TIMEFRAME: '이 시간대는 새 PAPER 진입에 사용하지 않습니다. 15분·1시간·4시간만 허용합니다.',
  };
  return labels[reason] ?? (reason.startsWith('Opposite issued pattern directions across ')
    ? '서로 다른 시간대의 완료 패턴 방향이 충돌합니다. 충돌이 해소되기 전에는 어느 쪽도 주문하지 않습니다.'
    : reason);
}