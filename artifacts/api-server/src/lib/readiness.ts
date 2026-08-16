/**
 * 앱 준비 상태(readiness) 플래그.
 *
 * 배포/재시작 시 마이그레이션이 끝나기 전에도 포트를 즉시 열어
 * 업타임 모니터·헬스체크가 다운타임으로 기록하지 않게 한다.
 * 준비 전에는 /api/healthz를 제외한 API 요청에 503을 반환한다.
 *
 * 기본값은 ready=true — supertest처럼 index.ts를 거치지 않고 app을
 * 직접 사용하는 테스트가 게이트에 걸리지 않도록 하기 위함이다.
 * 실제 서버 기동 경로(index.ts)에서만 markNotReady() → markReady()를 호출한다.
 */
let ready = true;

export function markNotReady(): void {
  ready = false;
}

export function markReady(): void {
  ready = true;
}

export function isReady(): boolean {
  return ready;
}
