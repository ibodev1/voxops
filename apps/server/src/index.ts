import { serve } from "@hono/node-server";
import { createGitHubRepositoryClient } from "@voxops/github";
import { createApp } from "./app.js";
import { DemoChatRequestSchema, streamDemoChat } from "./demo-agent.js";

const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

try {
  const github = createGitHubRepositoryClient(process.env.VOXOPS_PUBLIC_REPOSITORIES ?? "");
  const app = createApp(github);
  // Local-only adapter keeps the development UI on the same streaming agent.
  app.post("/api/demo/chat", async (context) => {
    if (!context.req.header("content-type")?.startsWith("application/json"))
      return context.json({ error: "json_required" }, 415);
    const body = await context.req.text();
    if (Buffer.byteLength(body) > 4096) return context.json({ error: "request_too_large" }, 413);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }
    const parsed = DemoChatRequestSchema.safeParse(input);
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    try {
      const mcpUrl = process.env.VOXOPS_MCP_REMOTE_URL?.trim() ?? `http://127.0.0.1:${port}/mcp`;
      return await streamDemoChat(parsed.data.messages, new URL(mcpUrl));
    } catch {
      return context.json({ error: "demo_unavailable" }, 502);
    }
  });
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(`VoxOps server listening on http://127.0.0.1:${port}`);
} catch {
  console.error("Unable to start the VoxOps server.");
  process.exitCode = 1;
}
