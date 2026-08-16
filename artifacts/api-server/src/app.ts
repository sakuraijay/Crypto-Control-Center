import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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

app.use("/api", router);

export default app;
