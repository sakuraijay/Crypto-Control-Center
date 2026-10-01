import express, { type RequestHandler } from "express";
import request from "supertest";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPatternImageAnalyzeRouter } from "../routes/pattern-image-analyze";
import { requireOperatorAuth } from "../lib/operatorAuthGuard";
import app from "../app";
import { isReady, markNotReady, markReady } from "../lib/readiness";

const TEST_OPERATOR_PIN = "TEST-PIN-ONLY-123";

function makeApp(options: {
  auth?: RequestHandler;
  isReady?: () => boolean;
} = {}) {
  const app = express();
  app.use("/api/pattern-image/analyze", createPatternImageAnalyzeRouter(options));
  return app;
}

function validBody() {
  return {
    images: [
      {
        timeframe: "15m",
        symbol: "BTC/USD",
        exchange: "Test Exchange",
        mimeType: "image/png",
        size: 1024,
        width: 1280,
        height: 720,
      },
    ],
  };
}

function setTestPin() {
  const previous = process.env.OPERATOR_MASTER_PIN;
  process.env.OPERATOR_MASTER_PIN = TEST_OPERATOR_PIN;
  return () => {
    if (previous === undefined) delete process.env.OPERATOR_MASTER_PIN;
    else process.env.OPERATOR_MASTER_PIN = previous;
  };
}

function authorizedPost(app: ReturnType<typeof makeApp>) {
  return request(app)
    .post("/api/pattern-image/analyze")
    .set("x-operator-pin", TEST_OPERATOR_PIN)
    .send(validBody());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pattern-image/analyze", () => {
  it("requires the actual operator auth middleware and accepts only a test fixture PIN", async () => {
    const restorePin = setTestPin();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const app = makeApp({ auth: requireOperatorAuth, isReady: () => true });
      const denied = await request(app)
        .post("/api/pattern-image/analyze")
        .set("x-operator-pin", "wrong-test-pin")
        .send(validBody());
      expect(denied.status).toBe(401);
      expect(denied.headers["cache-control"]).toBe("no-store");

      const accepted = await authorizedPost(app);
      expect(accepted.status).toBe(503);
      expect(accepted.body).toEqual({
        ok: false,
        code: "IMAGE_ANALYSIS_NOT_CONFIGURED",
        error: "이미지 분석 제공자가 아직 설정되지 않았습니다.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restorePin();
    }
  });

  it("rejects malformed JSON with a bounded safe error", async () => {
    const app = makeApp({ auth: (_req, _res, next) => next(), isReady: () => true });
    const response = await request(app)
      .post("/api/pattern-image/analyze")
      .set("content-type", "application/json")
      .send('{"images":[');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("요청 본문 JSON을 읽을 수 없습니다.");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects bodies larger than 4KB", async () => {
    const app = makeApp({ auth: (_req, _res, next) => next(), isReady: () => true });
    const response = await request(app)
      .post("/api/pattern-image/analyze")
      .send({ images: [], padding: "x".repeat(5_000) });
    expect(response.status).toBe(413);
    expect(response.body.error).toBe("요청 본문이 허용된 크기(4KB)를 초과했습니다.");
  });

  it("rejects compressed JSON with a fixed 415 response", async () => {
    const app = makeApp({ auth: (_req, _res, next) => next(), isReady: () => true });
    const compressed = gzipSync(Buffer.from(JSON.stringify(validBody())));
    const response = await request(app)
      .post("/api/pattern-image/analyze")
      .set("content-type", "application/json")
      .set("content-encoding", "gzip")
      .send(compressed);
    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      ok: false,
      error: "요청 본문 인코딩을 지원하지 않습니다.",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    ["raw image bytes", { ...validBody(), bytes: "not-allowed" }],
    ["base64 image data", { ...validBody(), images: [{ ...validBody().images[0], data: "aGVsbG8=" }] }],
    ["unknown metadata", { ...validBody(), extra: true }],
    ["duplicate timeframes", {
      images: [validBody().images[0], { ...validBody().images[0], symbol: "ETH/USD" }],
    }],
  ])("rejects %s without exposing submitted metadata", async (_name, body) => {
    const app = makeApp({ auth: (_req, _res, next) => next(), isReady: () => true });
    const response = await request(app).post("/api/pattern-image/analyze").send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("요청 본문은 허용된 이미지 메타데이터 형식이어야 합니다.");
  });

  it("counts invalid auth attempts toward the per-IP limit and provides Retry-After", async () => {
    const restorePin = setTestPin();
    try {
      const app = makeApp({ auth: requireOperatorAuth, isReady: () => true });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const denied = await request(app)
          .post("/api/pattern-image/analyze")
          .set("x-operator-pin", "wrong-test-pin")
          .send(validBody());
        expect(denied.status).toBe(401);
      }
      const limited = await authorizedPost(app);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
      expect(limited.headers["cache-control"]).toBe("no-store");
    } finally {
      restorePin();
    }
  });

  it("checks readiness independently after authentication", async () => {
    const app = makeApp({ auth: (_req, _res, next) => next(), isReady: () => false });
    const response = await request(app).post("/api/pattern-image/analyze").send(validBody());
    expect(response.status).toBe(503);
    expect(response.body.code).not.toBe("IMAGE_ANALYSIS_NOT_CONFIGURED");

    const malformed = await request(app)
      .post("/api/pattern-image/analyze")
      .set("content-type", "application/json")
      .send('{"images":[');
    expect(malformed.status).toBe(503);

    const oversized = await request(app)
      .post("/api/pattern-image/analyze")
      .send({ images: [], padding: "x".repeat(5_000) });
    expect(oversized.status).toBe(503);
  });

  it("checks readiness before parsing and mounts the local parser before app-wide JSON", async () => {
    const restorePin = setTestPin();
    const wasReady = isReady();
    markNotReady();
    try {
      const readinessResponse = await request(app)
        .post("/api/pattern-image/analyze")
        .set("x-operator-pin", TEST_OPERATOR_PIN)
        .send(validBody());
      expect(readinessResponse.status).toBe(503);
      expect(readinessResponse.body).toEqual({
        error: "Server starting — migrations in progress",
      });

      const malformedWhileUnready = await request(app)
        .post("/api/pattern-image/analyze")
        .set("x-operator-pin", TEST_OPERATOR_PIN)
        .set("content-type", "application/json")
        .send('{"images":[');
      expect(malformedWhileUnready.status).toBe(503);

      const oversizedWhileUnready = await request(app)
        .post("/api/pattern-image/analyze")
        .set("x-operator-pin", TEST_OPERATOR_PIN)
        .send({ images: [], padding: "x".repeat(5_000) });
      expect(oversizedWhileUnready.status).toBe(503);

      // Once ready, a body beyond the dedicated 4KB cap but below the global
      // parser's default proves the local parser still runs before global JSON.
      markReady();
      const parserResponse = await request(app)
        .post("/api/pattern-image/analyze")
        .set("x-operator-pin", TEST_OPERATOR_PIN)
        .send({ ...validBody(), padding: "x".repeat(5_000) });
      expect(parserResponse.status).toBe(413);
      expect(parserResponse.body.error).toBe("요청 본문이 허용된 크기(4KB)를 초과했습니다.");
      expect(parserResponse.headers["cache-control"]).toBe("no-store");
    } finally {
      restorePin();
      if (wasReady) markReady();
      else markNotReady();
    }
  });
});