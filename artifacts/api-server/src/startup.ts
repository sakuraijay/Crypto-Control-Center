/**
 * 본체 서버 기동 — index.ts(부트스트랩)에서 포트가 열린 뒤 동적 import로 로드된다.
 *
 * #121: 무거운 import(라우트·SDK·worker)를 이 모듈로 격리해, 로드 중에도
 * 부트스트랩 핸들러가 503 JSON을 반환하도록 했다. 이 파일의 내용과 순서는
 * 기존 index.ts 본체와 동일하다: 정적 서빙 부착 → RPC 모니터 →
 * (포트는 이미 열림) → migration → markReady → signer 게이트 → reconciliation
 * → Worker 시작. Worker 시작 순서·migration fail-closed·잠금 로직 불변.
 */
import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "@workspace/db";
import { startRpcHealthMonitor } from "./workers/internalExecutor";
import { workerManager } from "./workers/aiWorker";
import {
  initializeDelegatedSigner,
  isDelegatedSignerEnabled,
  isManualCanarySignerRestoreAllowed,
  isSignerStorageAccessAllowed,
  restoreExistingManualCanarySigner,
} from "./lib/delegatedSigner";
import { reconcileOnRestart, loadEmergencyStopFromDb, startPeriodicIntentReconciliation } from "./workers/liveTestExecutor";
import { resolveStaticDir, assertStaticDirReady, attachStaticServing } from "./lib/staticSite";
import { markReady } from "./lib/readiness";
import { reconcileGmxApiTasksOnStartup, startPeriodicGmxApiReconciliation } from "./lib/gmxApiStatusReconciler";
import { reconcileGmxPrepareStagesOnStartup } from "./lib/gmxApiPrepareStartup";
import { runStartupRelayReconciliation, isRelayReadonlyNetworkEnabled } from "./lib/relayActivationStatus";
import { countBlockingIntentsOrNull } from "./lib/executionIntents";
import { countOpenRelayTasksOrNull } from "./lib/relayLifecycle";
import { countUnboundNoncesOrNull } from "./lib/relayNonce";
import { getActiveRevokeSession } from "./lib/revokeSession";
import type { Delegate } from "./lib/bootstrapServer";

export interface StartupHooks {
  /** 부트스트랩 서버 — graceful shutdown 시 close()에 사용 */
  httpServer: Server;
  /** Express app으로 요청 위임 전환 (이후 기존 라우팅 계약 그대로) */
  setDelegate: (d: Delegate) => void;
  /** 종료 신호가 이미 접수됐는지 (부트스트랩 단계 신호 포함) */
  isShuttingDown: () => boolean;
}

export function startServer({ httpServer, setDelegate, isShuttingDown }: StartupHooks): void {
  // 프로덕션(Reserved VM 단일 프로세스): 빌드된 프런트엔드 정적 파일 + SPA fallback 제공.
  // API 라우터는 app.ts에서 이미 마운트되어 있으므로 항상 우선 처리된다.
  // index.html이 없으면 명확한 오류와 함께 즉시 종료 (fail-fast — 기존 계약 유지).
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

  // 본체 로드 완료 — 이제 모든 요청은 Express app이 처리한다.
  // (migration 완료 전에는 app.ts의 readiness 게이트가 /api에 503,
  //  /healthz에 503 JSON을 반환한다 — 기존 동작 그대로.)
  setDelegate(app as unknown as Delegate);
  logger.info("Application loaded — requests delegated to Express (readiness gate active until migrations finish)");

  // Run database migrations, then open the API and start background services.
  // Each migration file uses IF NOT EXISTS guards — safe to run on every start.
  runMigrations()
    .then(() => {
      // 종료 신호가 이미 들어온 경우: ready 전환·백그라운드 서비스 기동 생략
      // (server.close() 드레인 중 worker/signer가 새로 시작되는 race 방지)
      if (isShuttingDown()) {
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
      const manualCanaryRestore = isManualCanarySignerRestoreAllowed(process.env);
      if (isDelegatedSignerEnabled() && signerStorage.allowed) {
        initializeDelegatedSigner()
          .then(() => logger.info("Delegated signer initialized"))
          .catch((e: Error) => logger.warn({ err: e }, "Delegated signer init failed (fail-closed — signer 비활성 유지)"));
      } else if (isDelegatedSignerEnabled() && manualCanaryRestore.allowed) {
        restoreExistingManualCanarySigner()
          .then(() => logger.info("Manual Canary existing signer restored"))
          .catch((e: Error) => logger.warn({ err: e }, "Manual Canary signer restore failed (fail-closed — signer 비활성 유지)"));
      } else if (isDelegatedSignerEnabled()) {
        logger.info(
          `Delegated signer init skipped — legacy=${signerStorage.missing.join(', ')}; ` +
          `manualCanary=${manualCanaryRestore.missing.join(', ')}`,
        );
      } else {
        logger.info("Delegated signer disabled (DELEGATED_SIGNER_ENABLED != 'true')");
      }

      // Emergency Stop 상태 복원 + SUBMITTED 주문 reconciliation
      loadEmergencyStopFromDb().catch(() => {});
      reconcileOnRestart().catch(() => {});
      // 차단 intent 온체인 재판정 (차단 intent 없으면 no-op — PAPER 무영향)
      startPeriodicIntentReconciliation();

      // 6G-2 §9 — GMX API v2 relay task reconciliation (readonly 플래그 꺼짐 = 외부 호출 0회)
      // 6G-3 §4 — prepare 단계 durable 상태 reconciliation (GMX POST·서명 0회)
      reconcileGmxPrepareStagesOnStartup().catch(() => {});
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

  // Graceful shutdown 본체 — 부트스트랩(index.ts)의 신호 핸들러가 이 함수를 호출한다.
  void httpServer; // close는 index.ts에서 수행 (단일 소유)
}

/** index.ts가 신호 수신 시 호출 — worker 정지 등 본체 자원 정리 */
export function stopServices(): void {
  workerManager.stop();
}
