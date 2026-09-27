// ── RPC 오류 로그 새니타이즈 (db-free 모듈) ──────────────────────────────────
// viem HTTP/RPC 예외 메시지·details에는 요청 URL이 포함될 수 있어, 토큰이 든
// GMX_RPC_URL이 로그로 유출될 수 있다. 오류 객체 원문을 절대 로그하지 말고
// 이 헬퍼로 URL을 제거한 분류·메시지만 남긴다.
//
// intentReconciler에서 분리한 이유: intentReconciler는 lib/db(DATABASE_URL 필수)를
// 끌어오므로, DB가 없는 환경(CI 단위테스트)에서 순수 모듈(gmxDataStore 등)이
// 이 헬퍼만 필요할 때 import 체인이 깨진다.
export function sanitizeRpcError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? 'Error';
  const rawMsg = e instanceof Error ? e.message : String(e);
  // URL 전체 제거 (쿼리·경로에 토큰이 들어갈 수 있음)
  const noUrls = rawMsg.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, '[URL 제거됨]');
  // 방어적 이중 차단: 환경변수 값 자체가 남아 있으면 통째로 마스킹
  const secret = process.env.GMX_RPC_URL?.trim();
  const masked = secret && noUrls.includes(secret) ? noUrls.split(secret).join('[REDACTED]') : noUrls;
  return `${name}: ${masked.slice(0, 300)}`;
}
