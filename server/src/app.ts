/**
 * One HTTP server for everything: the built client, the Discord token
 * exchange and the Colyseus websocket. A Discord Activity is served through
 * Discord's proxy from a single mapped origin, so nothing here may assume a
 * second host or port.
 */
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import fs from "fs";
import http from "http";
import path from "path";
import { ROOM_NAME } from "../../shared/src/protocol";
import { GameRoom } from "./GameRoom";

export interface Running {
  port: number;
  stop(): Promise<void>;
}

export async function startServer(port: number): Promise<Running> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4kb" }));

  // Inside Discord every request arrives as /.proxy/...; depending on the URL
  // mapping the prefix may or may not be stripped before it reaches us.
  app.use((req, _res, next) => {
    if (req.url.startsWith("/.proxy/")) req.url = req.url.slice(7);
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // OAuth code -> access token. The secret never leaves the server.
  app.post("/api/token", async (req, res) => {
    const code = req.body?.code;
    const id = process.env.DISCORD_CLIENT_ID ?? process.env.VITE_DISCORD_CLIENT_ID;
    const secret = process.env.DISCORD_CLIENT_SECRET;
    if (typeof code !== "string" || code.length < 4 || code.length > 256) {
      res.status(400).json({ error: "bad_code" });
      return;
    }
    if (!id || !secret) {
      res.status(503).json({ error: "discord_not_configured" });
      return;
    }
    try {
      const r = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "authorization_code", code }),
      });
      const body = (await r.json()) as { access_token?: unknown };
      if (!r.ok || typeof body.access_token !== "string") {
        res.status(502).json({ error: "exchange_failed" });
        return;
      }
      res.json({ access_token: body.access_token });
    } catch {
      res.status(502).json({ error: "exchange_failed" });
    }
  });

  // Resolved from cwd so the same code works from tsx (src) and node (dist).
  const dist = path.resolve(process.cwd(), "client", "dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist, { maxAge: "1h", setHeaders: (res, p) => p.endsWith(".html") && res.setHeader("Cache-Control", "no-cache") }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/matchmake")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("Server is up. Client not built: run `npm run build`, or use `npm run dev` and open the Vite URL.");
    });
  }

  const server = http.createServer(app);
  const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
  // One table per Discord Activity instance (or per ?room= code in a browser).
  gameServer.define(ROOM_NAME, GameRoom).filterBy(["instanceId"]);
  await gameServer.listen(port);
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: bound,
    stop: () => gameServer.gracefullyShutdown(false),
  };
}
