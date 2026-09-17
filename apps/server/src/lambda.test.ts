import { readFileSync } from "node:fs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { LambdaEvent } from "hono/aws-lambda";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createConfiguredGitHubClient } from "./runtime.js";

type HttpV2Event = Extract<LambdaEvent, { rawPath: string }>;
const health: HttpV2Event = JSON.parse(
  readFileSync(new URL("../../../scripts/aws/events/health.json", import.meta.url), "utf8"),
);
const repository: HttpV2Event = JSON.parse(
  readFileSync(
    new URL("../../../scripts/aws/events/repository-status.json", import.meta.url),
    "utf8",
  ),
);

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VOXOPS_GITHUB_SECRET_ID", "voxops/dev/github-app");
  vi.stubEnv("VOXOPS_GITHUB_APP_ID", "");
  vi.stubEnv("VOXOPS_GITHUB_PRIVATE_KEY_PATH", "");
  vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(
    new Error("sensitive SDK error"),
  );
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("imports the real Lambda handler and serves the v2 health fixture without credentials", async () => {
  const { handler } = await import("./lambda.js");
  expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
  const response = await handler(health);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("returns a sanitized HTTP error through the real Lambda adapter and retries failed loads", async () => {
  const { handler } = await import("./lambda.js");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await handler(repository);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "github_authentication_failed" });
  }
  expect(SecretsManagerClient.prototype.send).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the existing localhost Host guard in the Lambda adapter", async () => {
  const { handler } = await import("./lambda.js");
  const response = await handler({ ...health, headers: { host: "untrusted.example" } });
  expect(response.statusCode).toBe(403);
  expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
});

it("keeps MCP discovery credential-free and sanitizes credential failures for all tools", async () => {
  const app = createApp(createConfiguredGitHubClient(process.env, process.cwd()));
  const client = new Client({ name: "lambda-credentials-test", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
        fetch: async (url, init) => {
          const request = new Request(url, init);
          request.headers.set("host", "127.0.0.1");
          return app.fetch(request);
        },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
    for (const tool of tools) {
      const result = await client.callTool({
        name: tool.name,
        arguments: { owner: "example", repo: "private" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "GitHub App authentication failed." }]);
    }
    expect(SecretsManagerClient.prototype.send).toHaveBeenCalledTimes(4);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});
