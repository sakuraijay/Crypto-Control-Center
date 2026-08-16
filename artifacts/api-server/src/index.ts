import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "@workspace/db";
import { startRpcHealthMonitor } from "./workers/internalExecutor";
import { workerManager } from "./workers/aiWorker";
import { initializeDelegatedSigner, isDelegatedSignerEnabled } from "./lib/delegatedSigner";
import { reconcileOnRestart, loadEmergencyStopFromDb } from "./workers/liveTestExecutor";
import { resolveStaticDir, assertStaticDirReady, attachStaticServing } from "./lib/staticSite";
import { parsePort } from "./lib/port";
import { markNotReady, markReady } from "./lib/readiness";

// PORT 검증: 1~65535 정수만 허용 (순수 함수 — port.test.ts에서 격리 검증)
const port = parsePort(process.env["PORT"]);

// 프로덕션(Reserved VM 단일 프로세스): 빌드된 프런트엔드 정적 파일 + SPA fallback 제공.
// API 라우터는 app.ts에서 이미 마운트되어 있으므로 항상 우선 처리된다.
// index.html이 없으면 명확한 오류와 함께 즉시 종료 (fail-fast).
if (process.env["NODE_ENV"] === "production") {
  const staticDir = resolveStaticDir();
  try {
    assertStaticDirReady(staticDir);
  } catch (err) {
    logger.error({ err, staticDir }, "Frontend build output missing — aborting startup");
    throw err;
  }
  attachStaticServing(app, staticDir);
  logger.info({ staticDir }, "Static frontend serving enabled (production)");
}

// Start internal executor RPC health monitor (non-blocking)
startRpcHealthMonitor();

let httpServer: ReturnType<typeof app.listen> | null = null;

// 포트를 즉시 연다 — 마이그레이션이 끝나기 전에도 헬스체크·업타임 모니터가
// 연결 거부(다운타임) 대신 응답을 받도록. 준비 전 API 요청은 app.ts의
// readiness 게이트가 503으로 응답하고, /api/healthz는 항상 200을 반환한다.
markNotReady();
httpServer = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening (readiness gate active until migrations finish)");

  // Run database migrations, then open the API and start background services.
  // Each migration file uses IF NOT EXISTS guards — safe to run on every start.
  runMigrations()
    .then(() => {
      markReady();
      logger.info("Migrations complete — API ready");

      // Delegated signer: DELEGATED_SIGNER_ENABLED=true(정확히 'true')일 때만
      // 키 복원/신규 생성 시도. 기본값(미설정)에서는 DB 접근·키 생성·SESSION_SECRET
      // 요구 전부 없음 — "disabled" 로그만 남긴다 (최초 PAPER Publish 안전 기본값).
      if (isDelegatedSignerEnabled()) {
        initializeDelegatedSigner()
          .then(() => logger.info("Delegated signer initialized"))
          .catch((e: Error) => logger.warn({ err: e }, "Delegated signer init failed (fail-closed — signer 비활성 유지)"));
      } else {
        logger.info("Delegated signer disabled (DELEGATED_SIGNER_ENABLED != 'true')");
      }

      // Emergency Stop 상태 복원 + SUBMITTED 주문 reconciliation
      loadEmergencyStopFromDb().catch(() => {});
      reconcileOnRestart().catch(() => {});

      // Start the 24/7 AI Worker after migrations complete
      // so the worker can read/write DB.
      void workerManager.start();
    })
    .catch((err2) => {
      logger.error({ err: err2 }, "Database migration failed — aborting startup");
      process.exit(1);
    });
});

// Graceful shutdown — stop AI worker, close HTTP server, then exit.
// Must call process.exit() explicitly because installing a SIGTERM handler
// overrides Node's default exit-on-SIGTERM behaviour.
function shutdown(signal: string) {
  logger.info({ signal }, "Shutdown signal received — stopping services");
  workerManager.stop();
  if (httpServer) {
    httpServer.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    // Force exit if server.close() takes too long (e.g. keep-alive connections)
    setTimeout(() => process.exit(0), 5_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
