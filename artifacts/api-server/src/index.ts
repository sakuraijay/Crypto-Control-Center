import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "@workspace/db";
import { startRpcHealthMonitor } from "./workers/internalExecutor";
import { workerManager } from "./workers/aiWorker";

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
