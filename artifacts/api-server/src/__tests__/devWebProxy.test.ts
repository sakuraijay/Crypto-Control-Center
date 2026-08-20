import express from "express";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { attachDevWebProxy } from "../lib/devWebProxy";

const servers: Server[] = [];

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP address unavailable");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("Development Futures Web proxy", () => {
  it("forwards /futures-web/ unchanged and leaves /api isolated", async () => {
    const upstream = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url, host: req.headers.host }));
    });
    await listen(upstream, 25285);

    const app = express();
    app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
    const proxyServer = createServer(app);
    const handle = attachDevWebProxy(app, proxyServer, { NODE_ENV: "development" });
    const port = await listen(proxyServer);

    const webResponse = await fetch(`http://127.0.0.1:${port}/futures-web/dashboard?tab=risk`);
    expect(webResponse.status).toBe(200);
    expect(await webResponse.json()).toEqual({
      url: "/futures-web/dashboard?tab=risk",
      host: "127.0.0.1:25285",
    });

    const apiResponse = await fetch(`http://127.0.0.1:${port}/api/healthz`);
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toEqual({ status: "ok" });
    handle.close();
  });

  it("is disabled in production", async () => {
    const app = express();
    const proxyServer = createServer(app);
    const handle = attachDevWebProxy(app, proxyServer, { NODE_ENV: "production" });
    const port = await listen(proxyServer);

    expect(handle.enabled).toBe(false);
    const response = await fetch(`http://127.0.0.1:${port}/futures-web/`);
    expect(response.status).toBe(404);
  });

  it("returns a bounded 502 when the Vite server is unavailable", async () => {
    const app = express();
    const proxyServer = createServer(app);
    attachDevWebProxy(app, proxyServer, { NODE_ENV: "development" });
    const port = await listen(proxyServer);

    const response = await fetch(`http://127.0.0.1:${port}/futures-web/`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ retryable: true });
  });

  it("proxies the Vite WebSocket upgrade path", async () => {
    const upstream = createServer();
    upstream.on("upgrade", (req, socket) => {
      expect(req.url).toBe("/futures-web/@vite/client");
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n\r\nproxy-ok",
      );
    });
    await listen(upstream, 25285);

    const app = express();
    const proxyServer = createServer(app);
    attachDevWebProxy(app, proxyServer, { NODE_ENV: "development" });
    const port = await listen(proxyServer);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(
          "GET /futures-web/@vite/client HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n",
        );
      });
      let body = "";
      socket.on("data", (chunk) => { body += chunk.toString(); });
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });

    expect(response).toContain("101 Switching Protocols");
    expect(response).toContain("proxy-ok");
  });
});
