/**
 * 프로덕션 정적 파일 제공 + SPA fallback (Reserved VM 단일 프로세스 배포용)
 *
 * - futures-web 빌드 산출물(artifacts/futures-web/dist/public)을 제공
 * - API 라우트(/api)는 app.ts에서 먼저 마운트되므로 항상 우선 처리됨
 * - 존재하지 않는 /api/* 는 JSON 404 (index.html로 fallback 금지)
 * - 그 외 GET 경로는 SPA fallback으로 index.html 반환
 * - path traversal: express.static과 res.sendFile(root 고정)이 차단
 *
 * 테스트를 위해 정적 디렉터리는 주입 가능(STATIC_DIR 환경변수 또는 인자).
 */
import path from "node:path";
import fs from "node:fs";
import express, { type Express } from "express";

/** 정적 파일 디렉터리 결정. 저장소 루트(cwd) 기준, STATIC_DIR로 재정의 가능. */
export function resolveStaticDir(): string {
  const override = process.env["STATIC_DIR"];
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), "artifacts/futures-web/dist/public");
}

/**
 * 프로덕션 시작 전 산출물 존재 검증.
 * index.html이 없으면 원인을 명확히 알리는 오류를 던진다 (즉시 종료용).
 */
export function assertStaticDirReady(staticDir: string): void {
  const indexHtml = path.join(staticDir, "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `Frontend build output missing: ${indexHtml} not found. ` +
        `Run "pnpm run build:deploy" before starting the production server.`,
    );
  }
}

/**
 * 정적 파일 미들웨어 + /api JSON 404 + SPA fallback을 앱에 부착.
 * 반드시 API 라우터(app.use("/api", router)) 마운트 이후에 호출할 것.
 */
export function attachStaticServing(app: Express, staticDir: string): void {
  const root = path.resolve(staticDir);
  const indexHtml = path.join(root, "index.html");

  // 1) 정적 asset (JS/CSS/이미지 등) — express.static이 Content-Type 및
  //    path traversal 방어를 처리한다.
  app.use(express.static(root, { index: "index.html" }));

  // 2) 존재하지 않는 /api/* — SPA fallback 대상이 아님. JSON 404 유지.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // 3) SPA fallback — Express 5에서는 "*" 와일드카드가 금지되므로 정규식 사용.
  //    sendFile은 root 옵션으로 고정 경로만 제공 (traversal 불가).
  app.get(/^\/.*/, (_req, res) => {
    res.sendFile("index.html", { root });
  });
}
