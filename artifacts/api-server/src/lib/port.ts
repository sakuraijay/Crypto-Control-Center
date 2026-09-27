/**
 * PORT 환경변수 파싱 — 순수 함수 (서버 시작·DB·RPC·worker와 무관, 격리 테스트 가능)
 *
 * 규칙: 1~65535 범위의 정수만 허용.
 * 오류 메시지에는 Secret이나 불필요한 환경변수 정보를 포함하지 않는다.
 */
export function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === "") {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const trimmed = rawPort.trim();
  const port = Number(trimmed);

  if (!Number.isFinite(port)) {
    throw new Error(`Invalid PORT value: not a number.`);
  }
  if (!Number.isInteger(port)) {
    throw new Error(`Invalid PORT value: must be an integer.`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: must be between 1 and 65535.`);
  }

  return port;
}
