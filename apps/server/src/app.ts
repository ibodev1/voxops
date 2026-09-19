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
  const remoteMcp = async (context: Context): Promise<Response> => {
    const origin = context.req.header("origin");
    if (origin && origin !== new URL(context.req.url).origin) return context.body(null, 403);
    return mcp.fetch(context.req.raw);
  };
  app.get("/mcp", remoteMcp);
  app.post("/mcp", remoteMcp);
  return app;
}
