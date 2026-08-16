import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { isReady } from "./lib/readiness";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 기본 주소 → 대시보드 리다이렉트 (Reserved VM 공개 주소의 "/"가
// Not Found 링크 목록 대신 futures-web 대시보드로 연결되도록).
// /api·정적 asset·SPA fallback과 충돌하지 않도록 정확히 "/"만 처리.
app.get("/", (_req, res) => {
  res.redirect(302, "/futures-web/");
});

// 준비(readiness) 게이트: 마이그레이션 완료 전에는 healthz를 제외한
// API 요청에 503을 반환한다. 포트는 즉시 열리므로 헬스체크·업타임
// 모니터는 연결 거부 대신 정상 응답을 받는다.
app.use("/api", (req, res, next) => {
  if (!isReady() && req.path !== "/healthz") {
    res.status(503).json({ error: "Server starting — migrations in progress" });
    return;
  }
  next();
});

app.use("/api", router);

export default app;
