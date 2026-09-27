/**
 * 6I-1 §12 — 영속화 수치 직렬화 (db-free 순수 모듈 — 테스트에서 직접 import 가능).
 * 경계 초과 값은 null(UNAVAILABLE)로 강등한다 — 반올림·클램프로 가짜 값을 만들지 않는다.
 * maxAbs = 10^(precision-scale) (해당 컬럼이 표현 가능한 정수부 상한).
 */
export const boundedNum = (v: number | null | undefined, maxAbs: number, scale: number): string | null => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const s = v.toFixed(scale);
  // 반올림 결과가 경계를 넘으면 null 강등 (경계값 반올림 overflow 방지)
  if (Math.abs(Number(s)) >= maxAbs) return null;
  return s;
};
