import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "@workspace/db";
import { startRpcHealthMonitor } from "./workers/internalExecutor";
import { workerManager } from "./workers/aiWorker";
import { initializeDelegatedSigner, isDelegatedSignerEnabled, isSignerStorageAccessAllowed } from "./lib/delegatedSigner";
import { reconcileOnRestart, loadEmergencyStopFromDb, startPeriodicIntentReconciliation } from "./workers/liveTestExecutor";
import { resolveStaticDir, assertStaticDirReady, attachStaticServing } from "./lib/staticSite";
import { parsePort } from "./lib/port";
import { markNotReady, markReady } from "./lib/readiness";
import { reconcileGmxApiTasksOnStartup, startPeriodicGmxApiReconciliation } from "./lib/gmxApiStatusReconciler";
import { runStartupRelayReconciliation, isRelayReadonlyNetworkEnabled } from "./lib/relayActivationStatus";
import { countBlockingIntentsOrNull } from "./lib/executionIntents";
import { countOpenRelayTasksOrNull } from "./lib/relayLifecycle";
import { countUnboundNoncesOrNull } from "./lib/relayNonce";
import { getActiveRevokeSession } from "./lib/revokeSession";

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
      // 종료 신호가 이미 들어온 경우: ready 전환·백그라운드 서비스 기동 생략
      // (server.close() 드레인 중 worker/signer가 새로 시작되는 race 방지)
      if (shuttingDown) {
        logger.info("Shutdown in progress — skipping post-migration startup");
        return;
      }
      markReady();
      logger.info("Migrations complete — API ready");

      // Delegated signer: DELEGATED_SIGNER_ENABLED=true(정확히 'true')일 때만
      // 키 복원/신규 생성 시도. 기본값(미설정)에서는 DB 접근·키 생성·SESSION_SECRET
      // 요구 전부 없음 — "disabled" 로그만 남긴다 (최초 PAPER Publish 안전 기본값).
      // 추가 구조적 게이트(5단계 리뷰 반영): signer는 relay 제출 전용이므로
      // GMX_RELAY_NETWORK_ENABLED가 꺼진 배포에서는 flag가 켜져 있어도
      // 키 복원·생성(=signer 저장소 접근)을 시작하지 않는다.
      // 6단계 §4: signer 저장소 접근은 read-only+submit network+submission+
      // mode LIVE+enabled+PAPER 아님+LIVE 잠금 해제 전부 충족 시에만 시작.
      // (initializeDelegatedSigner 내부에도 동일 게이트가 있어 이중 방어)
      const signerStorage = isSignerStorageAccessAllowed(process.env);
      if (isDelegatedSignerEnabled() && signerStorage.allowed) {
        initializeDelegatedSigner()
          .then(() => logger.info("Delegated signer initialized"))
          .catch((e: Error) => logger.warn({ err: e }, "Delegated signer init failed (fail-closed — signer 비활성 유지)"));
      } else if (isDelegatedSignerEnabled()) {
        logger.info(`Delegated signer init skipped — signer 저장소 접근 조건 미충족: ${signerStorage.missing.join(', ')}`);
      } else {
        logger.info("Delegated signer disabled (DELEGATED_SIGNER_ENABLED != 'true')");
      }

      // Emergency Stop 상태 복원 + SUBMITTED 주문 reconciliation
      loadEmergencyStopFromDb().catch(() => {});
      reconcileOnRestart().catch(() => {});
      // 차단 intent 온체인 재판정 (차단 intent 없으면 no-op — PAPER 무영향)
      startPeriodicIntentReconciliation();

      // 6G-2 §9 — GMX API v2 relay task reconciliation (readonly 플래그 꺼짐 = 외부 호출 0회)
      reconcileGmxApiTasksOnStartup().catch(() => {});
      startPeriodicGmxApiReconciliation();

      // Relay startup reconciliation (5단계 §8) — migration 이후 순서 고정.
      // 어떤 실패도 서버·Worker를 중단시키지 않는다. canonical readback은
      // 네트워크 비활성 단계라 "미수행"으로 기록되어 reconciliationComplete는
      // fail-closed로 false를 유지한다 (LIVE 제출 차단 유지).
      runStartupRelayReconciliation({
        migrationsComplete: () => true, // runMigrations() 성공 이후에만 도달
        countBlockingIntents: countBlockingIntentsOrNull,
        countOpenRelayTasks: countOpenRelayTasksOrNull,
        countUnboundNonces: countUnboundNoncesOrNull,
        hasActiveRevoke: async () => {
          try { return !!(await getActiveRevokeSession()); } catch { return null; }
        },
        canonicalReadback: async () => ({
          performed: false, ok: false,
          reason: isRelayReadonlyNetworkEnabled(process.env)
            ? 'canonical authorization readback 미수행 — startup 자동 조회는 수행하지 않음 (명시적 readiness refresh 경로로만 갱신)'
            : 'canonical authorization readback 미수행 — 읽기 전용 relay 네트워크 비활성(GMX_RELAY_READONLY_NETWORK_ENABLED 미설정, 구조적 차단)',
        }),
        nowMs: () => Date.now(),
      }).then((s) => {
        logger.info({ complete: s.complete, reasons: s.reasons }, "Relay startup reconciliation recorded");
      }).catch(() => {});

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
let shuttingDown = false;

function shutdown(signal: string) {
  shuttingDown = true;
  markNotReady();
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
