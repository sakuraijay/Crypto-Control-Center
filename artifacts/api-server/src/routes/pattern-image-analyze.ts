import express, { Router, type IRouter, type RequestHandler } from "express";
import { isReady } from "../lib/readiness";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 8;
const MAX_RATE_LIMIT_ENTRIES = 4_096;
const CLEANUP_ENTRIES_PER_REQUEST = 64;

const BODY_FIELDS = ["images"];
const IMAGE_FIELDS = ["timeframe", "symbol", "exchange", "mimeType", "size", "width", "height"];
const TIMEFRAMES = new Set(["15m", "1h", "4h"]);
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,39}$/;
const EXCHANGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isTrimmedSafeString(
  value: unknown,
  maximumLength: number,
  pattern: RegExp,
): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= maximumLength && pattern.test(trimmed);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isValidAnalyzeBody(value: unknown): boolean {
  if (!isRecord(value) || !hasExactlyFields(value, BODY_FIELDS)) return false;
  const images = value.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > 3) return false;

  const timeframes = new Set<string>();
  for (const image of images) {
    if (!isRecord(image) || !hasExactlyFields(image, IMAGE_FIELDS)) return false;
    if (typeof image.timeframe !== "string" || !TIMEFRAMES.has(image.timeframe)) return false;
    if (timeframes.has(image.timeframe)) return false;
    timeframes.add(image.timeframe);
    if (!isTrimmedSafeString(image.symbol, 40, SYMBOL_PATTERN)) return false;
    if (!isTrimmedSafeString(image.exchange, 80, EXCHANGE_PATTERN)) return false;
    if (typeof image.mimeType !== "string" || !MIME_TYPES.has(image.mimeType)) return false;
    if (!isBoundedInteger(image.size, 1, 8 * 1024 * 1024)) return false;
    if (!isBoundedInteger(image.width, 640, 4096)) return false;
    if (!isBoundedInteger(image.height, 360, 4096)) return false;
  }
  return true;
}

type RateEntry = { count: number; expiresAt: number };

export interface PatternImageRouterOptions {
  isReady?: () => boolean;
}

function getClientKey(ip: string | undefined): string {
  return (ip || "unknown").slice(0, 128);
}

export function createPatternImageAnalyzeRouter(
  options: PatternImageRouterOptions = {},
): IRouter {
  const router: IRouter = Router();
  const rateEntries = new Map<string, RateEntry>();
  const ready = options.isReady ?? isReady;

  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };

  const rateLimit: RequestHandler = (req, res, next) => {
    const now = Date.now();

    // Opportunistically rotate through a bounded number of entries; no timer or
    // unbounded sweep is needed to reclaim expired client records.
    const cleanupCount = Math.min(CLEANUP_ENTRIES_PER_REQUEST, rateEntries.size);
    const iterator = rateEntries.keys();
    for (let index = 0; index < cleanupCount; index += 1) {
      const key = iterator.next().value as string | undefined;
      if (key === undefined) break;
      const entry = rateEntries.get(key);
      if (!entry) continue;
      rateEntries.delete(key);
      if (entry.expiresAt > now) rateEntries.set(key, entry);
    }

    const key = getClientKey(req.ip);
    let entry = rateEntries.get(key);
    if (entry && entry.expiresAt <= now) {
      rateEntries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (rateEntries.size >= MAX_RATE_LIMIT_ENTRIES) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ ok: false, error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
        return;
      }
      entry = { count: 0, expiresAt: now + RATE_WINDOW_MS };
      rateEntries.set(key, entry);
    }

    if (entry.count >= RATE_LIMIT) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.expiresAt - now) / 1000))));
      res.status(429).json({ ok: false, error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
      return;
    }

    entry.count += 1;
    next();
  };

  const parseJson = express.json({ limit: "4kb", strict: true, inflate: false });
  const readinessGate: RequestHandler = (_req, res, next) => {
    if (!ready()) {
      res.status(503).json({ error: "Server starting — migrations in progress" });
      return;
    }
    next();
  };

  router.post("/", noStore, rateLimit, readinessGate, parseJson, (req, res) => {
    if (!isValidAnalyzeBody(req.body)) {
      res.status(400).json({
        ok: false,
        error: "요청 본문은 허용된 이미지 메타데이터 형식이어야 합니다.",
      });
      return;
    }

    // No provider is configured. This endpoint deliberately accepts metadata
    // only and never forwards, stores, or logs request contents.
    res.status(503).json({
      ok: false,
      code: "IMAGE_ANALYSIS_NOT_CONFIGURED",
      error: "이미지 분석 제공자가 아직 설정되지 않았습니다.",
    });
  });

  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const parserError = error as { type?: string; status?: number };
    if (parserError.type === "entity.too.large" || parserError.status === 413) {
      res.setHeader("Cache-Control", "no-store");
      res.status(413).json({ ok: false, error: "요청 본문이 허용된 크기(4KB)를 초과했습니다." });
      return;
    }
    if (
      parserError.status === 415
      || parserError.type === "encoding.unsupported"
      || parserError.type === "charset.unsupported"
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.status(415).json({ ok: false, error: "요청 본문 인코딩을 지원하지 않습니다." });
      return;
    }
    if (parserError.type === "entity.parse.failed" || parserError.status === 400) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({ ok: false, error: "요청 본문 JSON을 읽을 수 없습니다." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ ok: false, error: "요청 본문이 올바르지 않습니다." });
  });

  return router;
}

const patternImageAnalyzeRouter = createPatternImageAnalyzeRouter();

export default patternImageAnalyzeRouter;