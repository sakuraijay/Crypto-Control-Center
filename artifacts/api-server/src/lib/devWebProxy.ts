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
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = 25285;
const HTTP_TIMEOUT_MS = 10_000;

export interface DevWebProxyHandle {
  enabled: boolean;
  close: () => void;
}

function matchesWebPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?", 1)[0];
  return path === WEB_PREFIX || path.startsWith(`${WEB_PREFIX}/`);
}

function targetHostHeader(): string {
  return `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
}

function forwardedHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = value;
  }
  headers.host = targetHostHeader();
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = "http";
  if (req.socket.remoteAddress) headers["x-forwarded-for"] = req.socket.remoteAddress;
  delete headers.connection;
  return headers;
}

export function createDevWebProxyMiddleware(): RequestHandler {
  return (req, res, next) => {
    const upstreamPath = req.originalUrl || req.url;
    if (!matchesWebPath(upstreamPath)) {
      next();
      return;
    }

    const upstream = requestUpstream({
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: upstreamPath,
      headers: forwardedHeaders(req),
      timeout: HTTP_TIMEOUT_MS,
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

function websocketHeaders(req: IncomingMessage): string {
  const lines: string[] = [];
  const raw = req.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (!name || value === undefined || name.toLowerCase() === "host") continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: ${targetHostHeader()}`);
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

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!matchesWebPath(req.url)) {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }

  const upstream = connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
  let connected = false;
  upstream.once("connect", () => {
    connected = true;
    const requestLine = `${req.method ?? "GET"} ${req.url} HTTP/${req.httpVersion}`;
    upstream.write(`${requestLine}\r\n${websocketHeaders(req)}\r\n\r\n`);
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
): DevWebProxyHandle {
  if (env["NODE_ENV"] === "production") {
    return { enabled: false, close: () => {} };
  }

  app.use(createDevWebProxyMiddleware());
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    proxyUpgrade(req, socket, head);
  };
  httpServer.on("upgrade", onUpgrade);
  logger.info({ target: `http://${targetHostHeader()}${WEB_PREFIX}/` }, "Futures Web development proxy enabled");

  return {
    enabled: true,
    close: () => httpServer.off("upgrade", onUpgrade),
  };
}
