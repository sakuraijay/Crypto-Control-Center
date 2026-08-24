import {
  request as requestUpstream,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { Express, RequestHandler } from "express";
import { logger } from "./logger";

const WEB_PREFIX = "/futures-web";
const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_UPSTREAM_PORT = 25285;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface DevWebProxyOptions {
  targetHost?: string;
  targetPort?: number;
  timeoutMs?: number;
}

interface DevWebProxyTarget {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface DevWebProxyHandle {
  enabled: boolean;
  close: () => void;
}

function matchesWebPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?", 1)[0];
  return path === WEB_PREFIX || path.startsWith(`${WEB_PREFIX}/`);
}

function resolveTarget(options: DevWebProxyOptions): DevWebProxyTarget {
  return {
    host: options.targetHost ?? DEFAULT_UPSTREAM_HOST,
    port: options.targetPort ?? DEFAULT_UPSTREAM_PORT,
    timeoutMs: options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
  };
}

function targetHostHeader(target: DevWebProxyTarget): string {
  return `${target.host}:${target.port}`;
}

function forwardedHeaders(req: IncomingMessage, target: DevWebProxyTarget): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = value;
  }
  headers.host = targetHostHeader(target);
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = "http";
  if (req.socket.remoteAddress) headers["x-forwarded-for"] = req.socket.remoteAddress;
  delete headers.connection;
  return headers;
}

export function createDevWebProxyMiddleware(options: DevWebProxyOptions = {}): RequestHandler {
  const target = resolveTarget(options);
  return (req, res, next) => {
    const upstreamPath = req.originalUrl || req.url;
    if (!matchesWebPath(upstreamPath)) {
      next();
      return;
    }

    const upstream = requestUpstream({
      hostname: target.host,
      port: target.port,
      method: req.method,
      path: upstreamPath,
      headers: forwardedHeaders(req, target),
      timeout: target.timeoutMs,
    }, (upstreamResponse) => {
      res.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined) res.setHeader(name, value);
      }
      upstreamResponse.pipe(res);
    });

    upstream.on("timeout", () => {
      upstream.destroy(new Error("Futures Web development server timed out"));
    });
    upstream.on("error", (err) => {
      logger.warn({ err, upstreamPath }, "Futures Web development proxy unavailable");
      if (!res.headersSent) {
        res.status(502).json({
          error: "Futures Web development server unavailable",
          retryable: true,
        });
      } else {
        res.destroy(err);
      }
    });

    req.pipe(upstream);
  };
}

function websocketHeaders(req: IncomingMessage, target: DevWebProxyTarget): string {
  const lines: string[] = [];
  const raw = req.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (!name || value === undefined || name.toLowerCase() === "host") continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: ${targetHostHeader(target)}`);
  if (req.headers.host) lines.push(`X-Forwarded-Host: ${req.headers.host}`);
  if (req.socket.remoteAddress) lines.push(`X-Forwarded-For: ${req.socket.remoteAddress}`);
  lines.push("X-Forwarded-Proto: http");
  return lines.join("\r\n");
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  }
}

function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: DevWebProxyTarget,
): void {
  if (!matchesWebPath(req.url)) {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }

  const upstream = connect({ host: target.host, port: target.port });
  let connected = false;
  upstream.once("connect", () => {
    connected = true;
    const requestLine = `${req.method ?? "GET"} ${req.url} HTTP/${req.httpVersion}`;
    upstream.write(`${requestLine}\r\n${websocketHeaders(req, target)}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error", (err) => {
    logger.warn({ err, url: req.url }, "Futures Web development WebSocket proxy unavailable");
    if (!connected) rejectUpgrade(socket, 502, "Bad Gateway");
    else socket.destroy(err);
  });
  socket.once("error", () => upstream.destroy());
}

export function attachDevWebProxy(
  app: Express,
  httpServer: Server,
  env: NodeJS.ProcessEnv = process.env,
  options: DevWebProxyOptions = {},
): DevWebProxyHandle {
  if (env["NODE_ENV"] === "production") {
    return { enabled: false, close: () => {} };
  }

  const target = resolveTarget(options);
  app.use(createDevWebProxyMiddleware(options));
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    proxyUpgrade(req, socket, head, target);
  };
  httpServer.on("upgrade", onUpgrade);
  logger.info(
    { target: `http://${targetHostHeader(target)}${WEB_PREFIX}/` },
    "Futures Web development proxy enabled",
  );

  return {
    enabled: true,
    close: () => httpServer.off("upgrade", onUpgrade),
  };
}
