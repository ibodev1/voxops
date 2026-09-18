import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { GitHubRepositoryClient } from "@voxops/github";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const origin = "https://voxops.example";
const resource = `${origin}/mcp`;
const credentials = {
  clientId: "test-client",
  clientSecret: Buffer.alloc(32, 1).toString("base64"),
  tokenSigningSecret: Buffer.alloc(32, 2).toString("base64"),
};
const key = Buffer.from(credentials.tokenSigningSecret, "base64");
const basic = (id = credentials.clientId, secret = credentials.clientSecret): string =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
const github: GitHubRepositoryClient = {
  getRepositoryStatus: vi.fn(),
  listOpenIssues: vi.fn(),
  listPullRequests: vi.fn(),
  listWorkflowRuns: vi.fn(),
};
let app: ReturnType<typeof createApp>;
const binding = { event: { version: "2.0" }, requestContext: { domainName: "voxops.example" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(async () => ({
    SecretString: JSON.stringify(credentials),
    $metadata: {},
  }));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network allowed")));
  app = createApp(github, {
    runtime: "lambda",
    environment: { VOXOPS_ALEXA_AUTH_SECRET_ID: "test-service-secret" },
  });
});
afterEach(() => {
  for (const operation of Object.values(github)) expect(operation).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "voxops.example");
  return Promise.resolve(app.fetch(new Request(`${origin}${path}`, { ...init, headers }), binding));
}
function tokenRequest(
  overrides: Record<string, string> = {},
  authorization = basic(),
): Promise<Response> {
  return request("/oauth/token", {
    method: "POST",
    headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "mcp:service",
      resource,
      ...overrides,
    }),
  });
}
async function accessToken(): Promise<string> {
  const response = await tokenRequest();
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
function rpc(
  method: string,
  token?: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...extra }),
  });
}
function signedToken(overrides: JWTPayload = {}, algorithm = "HS256"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: origin,
    aud: resource,
    sub: `service:${credentials.clientId}`,
    client_id: credentials.clientId,
    scope: "mcp:service",
    iat: now,
    exp: now + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .sign(key);
}

it("issues only a one-hour service access token with validated claims and no cache", async () => {
  const response = await tokenRequest();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "scope", "token_type"]);
  expect(body).toMatchObject({ token_type: "Bearer", scope: "mcp:service", expires_in: 3600 });
  const { payload } = await jwtVerify(body.access_token, key, {
    algorithms: ["HS256"],
    issuer: origin,
    audience: resource,
  });
  expect(payload).toMatchObject({
    iss: origin,
    aud: resource,
    sub: "service:test-client",
    client_id: "test-client",
    scope: "mcp:service",
  });
  expect(payload.exp! - payload.iat!).toBe(3600);
  expect(Object.keys(payload).sort()).toEqual([
    "aud",
    "client_id",
    "exp",
    "iat",
    "iss",
    "scope",
    "sub",
  ]);
});

it.each([
  basic("wrong"),
  basic(undefined, "wrong"),
  "Basic invalid!",
  "Basic Zm9v",
  "Bearer not-basic",
  "",
])("rejects invalid client authentication uniformly", async (authorization) => {
  const response = await tokenRequest({}, authorization);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "invalid_client" });
  expect(response.headers.has("www-authenticate")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it.each([
  [{ grant_type: "authorization_code" }, 400, "unsupported_grant_type"],
  [{ grant_type: "refresh_token" }, 400, "unsupported_grant_type"],
  [{ scope: "mcp:tools" }, 400, "invalid_scope"],
  [{ scope: "mcp:resources" }, 400, "invalid_scope"],
  [{ scope: "mcp:service mcp:tools" }, 400, "invalid_scope"],
  [{ resource: "" }, 400, "invalid_request"],
  [{ resource: `${resource}/` }, 403, "access_denied"],
  [{ resource: "https://other.example/mcp" }, 403, "access_denied"],
  [{ client_secret: "body-credential" }, 400, "invalid_request"],
] as const)("rejects invalid token parameters %j", async (parameters, status, error) => {
  const response = await tokenRequest(parameters);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
});

it("rejects wrong media types, query credentials and duplicate form parameters", async () => {
  for (const [path, contentType, body] of [
    ["/oauth/token", "application/json", "{}"],
    ["/oauth/token?client_secret=not-accepted", "application/x-www-form-urlencoded", ""],
    [
      "/oauth/token",
      "application/x-www-form-urlencoded",
      `grant_type=client_credentials&scope=mcp:service&resource=${encodeURIComponent(resource)}&resource=other`,
    ],
  ]) {
    const response = await request(path!, {
      method: "POST",
      headers: { authorization: basic(), "content-type": contentType! },
      body: body!,
    });
    expect(response.status).toBe(400);
  }
});

it("sanitizes unavailable secrets at both token issuance and MCP verification", async () => {
  vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(
    new Error("sensitive SDK diagnostics"),
  );
  const response = await tokenRequest();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
  expect((await rpc("tools/list", await signedToken())).status).toBe(401);
});

it("publishes accurate credential-free metadata with the trusted origin", async () => {
  const headers = {
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "http",
    forwarded: "host=attacker.example;proto=http",
  };
  const as = await request("/.well-known/oauth-authorization-server", { headers });
  expect(await as.json()).toEqual({
    issuer: origin,
    token_endpoint: `${origin}/oauth/token`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    scopes_supported: ["mcp:service"],
    response_types_supported: [],
  });
  const prm = await request("/.well-known/oauth-protected-resource", { headers });
  expect(await prm.json()).toEqual({
    resource,
    authorization_servers: [origin],
    scopes_supported: ["mcp:service"],
  });
  expect(prm.headers.has("access-control-allow-origin")).toBe(false);
  expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
});

it("returns a challenge-free 401 for absent, malformed and query-only tokens", async () => {
  for (const path of ["/mcp", "/mcp?access_token=query-token"]) {
    const response = await request(path, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.has("www-authenticate")).toBe(false);
  }
  const response = await rpc("tools/list", "not-a-jwt");
  expect(response.status).toBe(401);
});

it.each([
  [{ exp: 1 }, 401],
  [{ iss: "https://other.example" }, 401],
  [{ aud: "https://other.example/mcp" }, 401],
  [{ aud: [resource, "https://other.example/mcp"] }, 401],
  [{ scope: "mcp:tools" }, 403],
  [{ scope: "mcp:service mcp:tools" }, 403],
  [{ client_id: "wrong" }, 401],
  [{ sub: "user:test-client" }, 401],
  [{ iat: Math.floor(Date.now() / 1000) + 120 }, 401],
  [{ exp: Math.floor(Date.now() / 1000) + 7200 }, 401],
] satisfies Array<[JWTPayload, number]>)(
  "rejects invalid JWT claims %j",
  async (claims, status) => {
    const response = await rpc("tools/list", await signedToken(claims));
    expect(response.status).toBe(status);
    expect(response.headers.has("www-authenticate")).toBe(false);
  },
);

it("rejects tampered signatures and unapproved algorithms", async () => {
  const token = await signedToken();
  const parts = token.split(".");
  parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
  expect((await rpc("tools/list", parts.join("."))).status).toBe(401);
  expect((await rpc("tools/list", await signedToken({}, "HS384"))).status).toBe(401);
});

it.each(["iss", "sub", "aud", "iat", "exp", "scope", "client_id"])(
  "rejects a missing required %s claim",
  async (claim) => {
    expect((await rpc("tools/list", await signedToken({ [claim]: undefined }))).status).toBe(401);
  },
);

it("rejects oversized requests without accessing secrets", async () => {
  for (const [path, size] of [
    ["/oauth/token", 8193],
    ["/mcp", 65537],
  ] as const) {
    const response = await request(path, { method: "POST", body: "x".repeat(size) });
    expect(response.status).toBe(400);
  }
  expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
});

it("keeps configured local MCP authenticated and LAN hosts forbidden", async () => {
  const local = createApp(github, {
    runtime: "local",
    environment: { VOXOPS_ALEXA_AUTH_SECRET_ID: "test-secret" },
  });
  for (const host of ["127.0.0.1", "192.168.1.10"]) {
    const response = await local.request(`http://${host}/mcp`, {
      method: "POST",
      headers: { host },
      body: "{}",
    });
    expect(response.status).toBe(host === "127.0.0.1" ? 401 : 403);
  }
  expect(SecretsManagerClient.prototype.send).not.toHaveBeenCalled();
});

it("allows legacy initialize/notification/ping and denies every GitHub tool with HTTP 403", async () => {
  const token = await accessToken();
  expect(
    (
      await rpc("initialize", token, {
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      })
    ).status,
  ).toBe(200);
  expect((await rpc("notifications/initialized", token, { id: undefined })).status).toBe(202);
  expect((await rpc("ping", token)).status).toBe(200);
  for (const name of [
    "get_repository_status",
    "list_open_issues",
    "list_pull_requests",
    "list_workflow_runs",
  ]) {
    const response = await rpc("tools/call", token, {
      params: { name, arguments: { owner: "example", repo: "private" } },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "user_authorization_required",
      message: "User authorization is required to execute VoxOps tools.",
    });
    expect(response.headers.has("www-authenticate")).toBe(false);
  }
});

it("supports current SDK client discovery and listing without GET or tool execution", async () => {
  const token = await accessToken();
  const client = new Client({ name: "service-discovery-test", version: "1" });
  const statuses: number[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const input = new Request(url, init);
      expect(input.method).toBe("POST");
      input.headers.set("host", "voxops.example");
      const response = await app.fetch(input, binding);
      statuses.push(response.status);
      return response;
    },
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "get_repository_status",
      "list_open_issues",
      "list_pull_requests",
      "list_workflow_runs",
    ]);
    await expect(
      client.callTool({
        name: "get_repository_status",
        arguments: { owner: "example", repo: "private" },
      }),
    ).rejects.toThrow();
    expect(statuses.at(-1)).toBe(403);
  } finally {
    await client.close();
  }
});

it("rejects batches, malformed JSON, unlisted methods and cross-origin requests", async () => {
  const token = await accessToken();
  for (const body of ["[{}]", "not-json", JSON.stringify({ method: "resources/read" })]) {
    const response = await request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect([400, 403]).toContain(response.status);
  }
  expect(
    (
      await request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "https://other.example" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});

it("fails closed in Lambda when configuration is missing even with loopback request identity", async () => {
  const remote = createApp(github, { runtime: "lambda", environment: {} });
  const response = await remote.fetch(
    new Request("https://127.0.0.1/mcp", {
      method: "POST",
      headers: { host: "127.0.0.1" },
      body: "{}",
    }),
    { event: { version: "2.0" }, requestContext: { domainName: "127.0.0.1" } },
  );
  expect(response.status).toBe(401);
  expect(response.headers.has("www-authenticate")).toBe(false);
  const valid = await signedToken();
  const withToken = await remote.fetch(
    new Request(resource, {
      method: "POST",
      headers: { host: "voxops.example", authorization: `Bearer ${valid}` },
      body: "{}",
    }),
    binding,
  );
  expect(withToken.status).toBe(401);
});
