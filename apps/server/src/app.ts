import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { GitHubRepositoryClient } from "@voxops/github";
import { createMcpServer } from "./mcp.js";
import { DemoChatRequestSchema, runDemoChat } from "./demo-agent.js";

export function createApp(github: GitHubRepositoryClient, runtime: "local" | "lambda" = "local") {
  const mcp = createMcpHandler(() => createMcpServer(github));
  async function demoChat(context: Context) {
    if (!context.req.header("content-type")?.startsWith("application/json")) {
      return context.json({ error: "json_required" }, 415);
    }
    const body = await context.req.text();
    if (new TextEncoder().encode(body).length > 4096) {
      return context.json({ error: "request_too_large" }, 413);
    }
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }
    const parsed = DemoChatRequestSchema.safeParse(input);
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const mcpUrl =
      process.env.VOXOPS_MCP_REMOTE_URL?.trim() ||
      (runtime === "local" ? `http://127.0.0.1:${process.env.PORT ?? "3000"}/mcp` : "");
    if (!mcpUrl) return context.json({ error: "demo_unavailable" }, 503);
    try {
      const bedrock = new BedrockRuntimeClient({
        region: process.env.AWS_REGION ?? "eu-central-1",
        maxAttempts: 1,
      });
      const result = await runDemoChat(parsed.data.messages, new URL(mcpUrl), (request) =>
        bedrock.send(new ConverseCommand(request)),
      );
      return context.json(result);
    } catch {
      return context.json({ error: "demo_unavailable" }, 502);
    }
  }
  if (runtime === "local") {
    const app = createMcpHonoApp();
    app.get("/health", (context) => context.json({ status: "ok" }));
    app.all("/mcp", (context: Context) =>
      mcp.fetch(context.req.raw, { parsedBody: context.get("parsedBody") }),
    );
    app.post("/api/demo/chat", demoChat);
    return app;
  }
  const app = new Hono();
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.post("/mcp", (context) => mcp.fetch(context.req.raw));
  app.post("/api/demo/chat", demoChat);
  return app;
}
