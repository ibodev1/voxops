import { readFileSync } from "node:fs";
import type { LambdaEvent } from "hono/aws-lambda";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type HttpV2Event = Extract<LambdaEvent, { rawPath: string }>;
const health: HttpV2Event = JSON.parse(
  readFileSync(new URL("../../../scripts/aws/events/health.json", import.meta.url), "utf8"),
);

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

it("returns the MCP transport 405 for GET and rejects a foreign Origin", async () => {
  const { handler } = await import("./lambda.js");
  const event: HttpV2Event = {
    ...health,
    rawPath: "/mcp",
    routeKey: "GET /mcp",
    headers: { host: "voxops.example", accept: "text/event-stream" },
    requestContext: {
      ...health.requestContext,
      domainName: "voxops.example",
      routeKey: "GET /mcp",
      http: { ...health.requestContext.http, method: "GET", path: "/mcp" },
    },
  };
  expect((await handler(event)).statusCode).toBe(405);
  expect(
    (await handler({ ...event, headers: { ...event.headers, origin: "https://evil.example" } }))
      .statusCode,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  "/api/demo/chat",
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
