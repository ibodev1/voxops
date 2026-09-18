import { readFileSync } from "node:fs";
import type { LambdaEvent } from "hono/aws-lambda";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type HttpV2Event = Extract<LambdaEvent, { rawPath: string }>;
const health: HttpV2Event = JSON.parse(
  readFileSync(new URL("../../../scripts/aws/events/health.json", import.meta.url), "utf8"),
);
function chatEvent(body: string, contentType = "application/json"): HttpV2Event {
  const path = "/api/demo/chat";
  return {
    ...health,
    rawPath: path,
    routeKey: "POST /api/demo/chat",
    headers: { host: "voxops.example", "content-type": contentType },
    body,
    requestContext: {
      ...health.requestContext,
      domainName: "voxops.example",
      routeKey: "POST /api/demo/chat",
      http: { ...health.requestContext.http, method: "POST", path },
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VOXOPS_PUBLIC_REPOSITORIES", "ibodev1/voxops");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("serves health through the real Lambda v2 adapter without GitHub access", async () => {
  const { handler } = await import("./lambda.js");
  const response = await handler({
    ...health,
    headers: { host: "voxops.example" },
    requestContext: { ...health.requestContext, domainName: "voxops.example" },
  });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  expect(fetch).not.toHaveBeenCalled();
});

it("allows unauthenticated remote MCP discovery through the real Lambda v2 adapter", async () => {
  const { handler } = await import("./lambda.js");
  const response = await handler({
    ...health,
    rawPath: "/mcp",
    routeKey: "POST /mcp",
    headers: {
      host: "voxops.example",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    requestContext: {
      ...health.requestContext,
      domainName: "voxops.example",
      routeKey: "POST /mcp",
      http: { ...health.requestContext.http, method: "POST", path: "/mcp" },
    },
  });
  expect(response.statusCode).toBe(200);
  const wire = response.isBase64Encoded
    ? Buffer.from(response.body, "base64").toString("utf8")
    : response.body;
  const data = wire.startsWith("event:")
    ? wire
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : wire;
  const body = JSON.parse(data ?? "");
  expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "get_repository_status",
    "list_open_issues",
    "list_pull_requests",
    "list_workflow_runs",
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["wrong content type", "{}", "text/plain", 415],
  ["invalid JSON", "{", "application/json", 400],
  ["empty request", JSON.stringify({ messages: [] }), "application/json", 400],
  [
    "extra field",
    JSON.stringify({ messages: [{ role: "user", content: "status" }], debug: true }),
    "application/json",
    400,
  ],
  ["oversized body", "x".repeat(4097), "application/json", 413],
] as const)("rejects %s before model or MCP access", async (_case, body, contentType, status) => {
  const { handler } = await import("./lambda.js");
  const response = await handler(chatEvent(body, contentType));
  expect(response.statusCode).toBe(status);
  expect(fetch).not.toHaveBeenCalled();
});

it("returns a sanitized gateway response when the demo agent fails", async () => {
  vi.stubEnv("VOXOPS_MCP_REMOTE_URL", "https://example.test/mcp");
  vi.doMock("./demo-agent.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./demo-agent.js")>()),
    runDemoChat: vi.fn().mockRejectedValue(new Error("Bedrock internal detail")),
  }));
  try {
    const { handler } = await import("./lambda.js");
    const response = await handler(
      chatEvent(JSON.stringify({ messages: [{ role: "user", content: "status" }] })),
    );
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: "demo_unavailable" });
    expect(response.body).not.toContain("Bedrock internal detail");
  } finally {
    vi.doUnmock("./demo-agent.js");
  }
});

it.each([
  "/oauth/token",
  "/.well-known/oauth-authorization-server",
  "/api/repositories/ibodev1/voxops/status",
])("does not implement removed route %s", async (path) => {
  const { handler } = await import("./lambda.js");
  const response = await handler({
    ...health,
    rawPath: path,
    headers: { host: "voxops.example" },
    requestContext: {
      ...health.requestContext,
      domainName: "voxops.example",
      http: { ...health.requestContext.http, path },
    },
  });
  expect(response.statusCode).toBe(404);
});
