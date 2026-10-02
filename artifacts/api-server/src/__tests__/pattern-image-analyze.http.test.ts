import express from "express";
import request from "supertest";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPatternImageAnalyzeRouter } from "../routes/pattern-image-analyze";
import app from "../app";
import { isReady, markNotReady, markReady } from "../lib/readiness";

const TEST_OPERATOR_PIN = "TEST-ONLY-OPERATOR-PIN";

function makeApp(options: { isReady?: () => boolean } = {}) {
  const testApp = express();
  testApp.use("/api/pattern-image/analyze", createPatternImageAnalyzeRouter(options));
  return testApp;
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/pattern-image/analyze", () => {
  it("accepts valid metadata without a PIN, ignores an extraneous wrong PIN, and never calls a provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const testApp = makeApp({ isReady: () => true });
    const response = await request(testApp)
      .post("/api/pattern-image/analyze")
      .set("x-operator-pin", "wrong-extraneous-pin")
      .send(validBody());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      code: "IMAGE_ANALYSIS_NOT_CONFIGURED",
      error: "이미지 분석 제공자가 아직 설정되지 않았습니다.",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a bounded safe error", async () => {
    const response = await request(makeApp({ isReady: () => true }))
      .post("/api/pattern-image/analyze")
      .set("content-type", "application/json")
      .send('{"images":[');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("요청 본문 JSON을 읽을 수 없습니다.");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects bodies larger than 4KB", async () => {
    const response = await request(makeApp({ isReady: () => true }))
      .post("/api/pattern-image/analyze")
      .send({ images: [], padding: "x".repeat(5_000) });
    expect(response.status).toBe(413);
    expect(response.body.error).toBe("요청 본문이 허용된 크기(4KB)를 초과했습니다.");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects compressed JSON without attempting to inflate it", async () => {
    const compressed = gzipSync(Buffer.from(JSON.stringify(validBody())));
    const response = await request(makeApp({ isReady: () => true }))
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

  it("rejects unsupported request content types", async () => {
    const response = await request(makeApp({ isReady: () => true }))
      .post("/api/pattern-image/analyze")
      .set("content-type", "text/plain")
      .send(JSON.stringify(validBody()));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("요청 본문은 허용된 이미지 메타데이터 형식이어야 합니다.");
  });

  it.each([
    ["raw image bytes", { ...validBody(), bytes: "not-allowed" }],
    ["base64 image data", { ...validBody(), images: [{ ...validBody().images[0], data: "aGVsbG8=" }] }],
    ["unknown metadata", { ...validBody(), extra: true }],
    ["duplicate timeframes", {
      images: [validBody().images[0], { ...validBody().images[0], symbol: "ETH/USD" }],
    }],
    ["unsupported MIME type", {
      images: [{ ...validBody().images[0], mimeType: "image/gif" }],
    }],
    ["too-small width", {
      images: [{ ...validBody().images[0], width: 639 }],
    }],
    ["too-large height", {
      images: [{ ...validBody().images[0], height: 4097 }],
    }],
    ["negative byte size", {
      images: [{ ...validBody().images[0], size: -1 }],
    }],
    ["unsafe symbol", {
      images: [{ ...validBody().images[0], symbol: "<script>alert(1)</script>" }],
    }],
    ["excessive image count", {
      images: [
        validBody().images[0],
        { ...validBody().images[0], timeframe: "1h" },
        { ...validBody().images[0], timeframe: "4h" },
        { ...validBody().images[0], timeframe: "15m" },
      ],
    }],
  ])("rejects %s without exposing submitted metadata", async (_name, body) => {
    const response = await request(makeApp({ isReady: () => true }))
      .post("/api/pattern-image/analyze")
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("요청 본문은 허용된 이미지 메타데이터 형식이어야 합니다.");
    expect(JSON.stringify(response.body)).not.toContain("<script>");
  });

  it("counts invalid requests toward the per-IP limit and provides Retry-After", async () => {
    const testApp = makeApp({ isReady: () => true });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const invalid = await request(testApp)
        .post("/api/pattern-image/analyze")
        .send({ invalid: true });
      expect(invalid.status).toBe(400);
    }

    const limited = await request(testApp)
      .post("/api/pattern-image/analyze")
      .send(validBody());
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
    expect(limited.headers["cache-control"]).toBe("no-store");
  });

  it("checks readiness before parsing and mounting uses the local 4KB parser before app-wide JSON", async () => {
    const wasReady = isReady();
    markNotReady();
    try {
      const readinessResponse = await request(app)
        .post("/api/pattern-image/analyze")
        .send(validBody());
      expect(readinessResponse.status).toBe(503);
      expect(readinessResponse.body).toEqual({
        error: "Server starting — migrations in progress",
      });

      const malformedWhileUnready = await request(app)
        .post("/api/pattern-image/analyze")
        .set("content-type", "application/json")
        .send('{"images":[');
      expect(malformedWhileUnready.status).toBe(503);

      const oversizedWhileUnready = await request(app)
        .post("/api/pattern-image/analyze")
        .send({ images: [], padding: "x".repeat(5_000) });
      expect(oversizedWhileUnready.status).toBe(503);

      markReady();
      const parserResponse = await request(app)
        .post("/api/pattern-image/analyze")
        .send({ ...validBody(), padding: "x".repeat(5_000) });
      expect(parserResponse.status).toBe(413);
      expect(parserResponse.body.error).toBe("요청 본문이 허용된 크기(4KB)를 초과했습니다.");
      expect(parserResponse.headers["cache-control"]).toBe("no-store");
    } finally {
      if (wasReady) markReady();
      else markNotReady();
    }
  });

  it("mounts the image helper in the real app without PIN while sensitive routes retain their real auth guard", async () => {
    const wasReady = isReady();
    vi.stubEnv("OPERATOR_MASTER_PIN", TEST_OPERATOR_PIN);
    markReady();
    try {
      const imageResponse = await request(app)
        .post("/api/pattern-image/analyze")
        .send(validBody());
      expect(imageResponse.status).toBe(503);
      expect(imageResponse.body.code).toBe("IMAGE_ANALYSIS_NOT_CONFIGURED");
      expect(imageResponse.headers["cache-control"]).toBe("no-store");

      const guardedRequests = [
        request(app).get("/api/executor/canary/status"),
        request(app).get("/api/executor/relay/status"),
        request(app).put("/api/data/worker-policy-context").send({}),
        request(app).put("/api/data/risk-profile").send({}),
        request(app).post("/api/executor/emergency-stop").send({}),
      ];
      const guardedResponses = await Promise.all(guardedRequests);
      for (const guardedResponse of guardedResponses) {
        expect(guardedResponse.status).toBe(401);
        expect(guardedResponse.body.error).toBe("운영자 인증 실패");
      }
    } finally {
      if (wasReady) markReady();
      else markNotReady();
    }
  });
});