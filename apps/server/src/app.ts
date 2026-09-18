import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import type { GitHubRepositoryClient } from "@voxops/github";
import { createMcpServer } from "./mcp.js";

export function createApp(github: GitHubRepositoryClient, runtime: "local" | "lambda" = "local") {
  const mcp = createMcpHandler(() => createMcpServer(github));
  if (runtime === "local") {
    const app = createMcpHonoApp();
    app.get("/health", (context) => context.json({ status: "ok" }));
    app.all("/mcp", (context: Context) =>
      mcp.fetch(context.req.raw, { parsedBody: context.get("parsedBody") }),
    );
    return app;
  }
  const app = new Hono();
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.post("/mcp", (context) => mcp.fetch(context.req.raw));
  return app;
}
