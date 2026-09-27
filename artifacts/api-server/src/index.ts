/**
 * 부트스트랩 엔트리 (#121) — 최소 의존성만 로드하고 포트를 즉시 연다.
 *
 * 무거운 모듈(라우트·SDK·worker)이 로드되는 콜드스타트 창(수십 초) 동안
 * 포트가 닫혀 있으면 플랫폼 프록시가 HTTP 500을 노출한다. 이를 막기 위해:
 *   1) node:http + 순수 유틸만 import → 즉시 listen
 *   2) 본체(./startup)를 동적 import — 로드 완료까지 모든 요청은 503 JSON
 *   3) 본체 로드 후 Express app으로 위임 — 기존 라우팅·readiness 계약 그대로
 *
 * 기존 순서 불변: 정적 서빙 → migration → markReady → signer 게이트 →
 * reconciliation → Worker 시작 (전부 ./startup 안, 순서 동일).
 * 본체 로드 실패는 fail-fast(exit 1) — 조용한 503 지속 금지.
 */
import http from "node:http";
import { parsePort } from "./lib/port";
import { markNotReady } from "./lib/readiness";
import { createBootstrapControl } from "./lib/bootstrapServer";

// PORT 검증: 1~65535 정수만 허용 (순수 함수 — port.test.ts에서 격리 검증)
const port = parsePort(process.env["PORT"]);

const control = createBootstrapControl();
markNotReady();

let shuttingDown = false;
let stopServices: (() => void) | null = null;

const httpServer = http.createServer(control.handler);

httpServer.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: "Bootstrap listening — loading application (503 until loaded)", port }));

  import("./startup")
    .then((m) => {
      stopServices = m.stopServices;
      if (shuttingDown) {
        // 로드 중 종료 신호 수신 — 본체 기동 생략 (worker/signer 시작 race 방지)
        return;
      }
      m.startServer({
        httpServer,
        setDelegate: control.setDelegate,
        isShuttingDown: () => shuttingDown,
      });
    })
    .catch((err) => {
      // 본체 로드 실패 = 배포 결함 — 조용한 503 유지 대신 즉시 종료 (fail-fast)
      // eslint-disable-next-line no-console
      console.error("Application load failed — aborting startup", err);
      process.exit(1);
    });
});

httpServer.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("Error listening on port", err);
  process.exit(1);
});

// Graceful shutdown — stop AI worker, close HTTP server, then exit.
// Must call process.exit() explicitly because installing a SIGTERM handler
// overrides Node's default exit-on-SIGTERM behaviour.
function shutdown(signal: string) {
  shuttingDown = true;
  markNotReady();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: "Shutdown signal received — stopping services", signal }));
  try {
    stopServices?.();
  } catch {
    /* 종료 경로 — 정리 실패는 무시하고 진행 */
  }
  httpServer.close(() => {
    process.exit(0);
  });
  // Force exit if server.close() takes too long (e.g. keep-alive connections)
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
