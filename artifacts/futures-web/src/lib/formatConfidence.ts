/**
 * formatConfidence — 6E-2 §7: 신뢰도 표시 정규화.
 *
 * 서버(/api/executor/status lastCycleResult.confidence)는 0~100 스케일을 반환한다.
 * 과거 UI가 ×100을 중복 적용해 84 → 8400%로 표시되던 버그의 재발을 막기 위해
 * 이 헬퍼만 사용한다. 규칙:
 *  - null/undefined → '—'
 *  - 유한수가 아니거나 0~100 범위 밖 → 'N/A' (임의 clamp 금지 — 정책: 표시 거부)
 *  - 0~100 → 반올림 후 그대로 % (0.7 → 1% — 0~1 스케일로 재해석하지 않는다)
 */
export function formatConfidencePct(value: number | null | undefined): string {
  if (value == null) return '—';
  if (!Number.isFinite(value)) return 'N/A';
  if (value < 0 || value > 100) return 'N/A';
  return `${Math.round(value)}%`;
}
