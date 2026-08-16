import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "@workspace/db";
import { startRpcHealthMonitor } from "./workers/internalExecutor";
import { workerManager } from "./workers/aiWorker";
import { initializeDelegatedSigner } from "./lib/delegatedSigner";
import { reconcileOnRestart, loadEmergencyStopFromDb } from "./workers/liveTestExecutor";
import { resolveStaticDir, assertStaticDirReady, attachStaticServing } from "./lib/staticSite";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

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

// Run database migrations before accepting requests.
// Each migration file uses IF NOT EXISTS guards — safe to run on every start.
runMigrations()
  .then(() => {
    httpServer = app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");

      // Delegated signer: 키 복원(재시작) 또는 신규 생성. SESSION_SECRET 필요.
      // LIVE TEST 모드가 아니어도 주소를 미리 생성해두면 배포 후 즉시 확인 가능.
      initializeDelegatedSigner()
        .then(() => logger.info("Delegated signer initialized"))
        .catch((e: Error) => logger.warn({ err: e }, "Delegated signer init failed (non-fatal)"));

      // Emergency Stop 상태 복원 + SUBMITTED 주문 reconciliation
      loadEmergencyStopFromDb().catch(() => {});
      reconcileOnRestart().catch(() => {});

      // Start the 24/7 AI Worker after the server is up.
      // Migration must complete first so the worker can read/write DB.
      void workerManager.start();
    });
  })
  .catch((err) => {
    logger.error({ err }, "Database migration failed — aborting startup");
    process.exit(1);
  });

// Graceful shutdown — stop AI worker, close HTTP server, then exit.
// Must call process.exit() explicitly because installing a SIGTERM handler
// overrides Node's default exit-on-SIGTERM behaviour.
let httpServer: ReturnType<typeof app.listen> | null = null;

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
