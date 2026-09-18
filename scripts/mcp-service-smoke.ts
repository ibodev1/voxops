import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// No credential CLI arguments: use short-lived process environment values from the runbook.
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "all";
  if (!["all", "token", "discovery", "deny"].includes(mode)) throw new Error("Invalid mode");
  const origin = new URL(process.env.VOXOPS_REMOTE_ORIGIN ?? "");
  const clientId = process.env.VOXOPS_ALEXA_CLIENT_ID;
  const clientSecret = process.env.VOXOPS_ALEXA_CLIENT_SECRET;
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    !clientId ||
    !clientSecret
  )
    throw new Error("Invalid configuration");
  const resource = new URL("/mcp", origin);
  const tokenResponse = await fetch(new URL("/oauth/token", origin), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "mcp:service",
      resource: resource.href,
    }),
  });
  const token: unknown = await tokenResponse.json();
  if (
    tokenResponse.status !== 200 ||
    tokenResponse.headers.get("cache-control") !== "no-store" ||
    tokenResponse.headers.get("pragma") !== "no-cache" ||
    typeof token !== "object" ||
    token === null ||
    !("access_token" in token) ||
    typeof token.access_token !== "string" ||
    !("token_type" in token) ||
    token.token_type !== "Bearer" ||
    !("expires_in" in token) ||
    token.expires_in !== 3600 ||
    !("scope" in token) ||
    token.scope !== "mcp:service" ||
    Object.keys(token).sort().join(",") !== "access_token,expires_in,scope,token_type"
  )
    throw new Error("Token check failed");
  console.log("Token endpoint: HTTP 200; mcp:service; expires in 3600 seconds; no-store.");
  if (mode === "token") return;

  let checkingDenial = false;
  let denied = false;
  const client = new Client({ name: "voxops-service-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(resource, {
    requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
    fetch: async (url, init) => {
      if (new URL(url instanceof Request ? url.url : url).href !== resource.href)
        throw new Error("Unexpected MCP destination");
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (checkingDenial) {
        const body: unknown = await response.clone().json();
        denied =
          response.status === 403 &&
          !response.headers.has("www-authenticate") &&
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          body.error === "user_authorization_required";
      }
      return response;
    },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const expected = [
      "get_repository_status",
      "list_open_issues",
      "list_pull_requests",
      "list_workflow_runs",
    ];
    if (
      tools
        .map((tool) => tool.name)
        .sort()
        .join(",") !== expected.join(",")
    )
      throw new Error("Tool discovery check failed");
    console.log("MCP initialize/discovery and tools/list: passed; four tools.");
    if (mode === "discovery") return;
    checkingDenial = true;
    try {
      await client.callTool({
        name: "get_repository_status",
        arguments: { owner: "example", repo: "private" },
      });
    } catch {
      // The transport throws on HTTP 403; assert the actual response, not merely an exception.
    }
    if (!denied) throw new Error("Tool execution was not denied as expected");
    console.log("tools/call: HTTP 403 user_authorization_required; no WWW-Authenticate.");
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch {
  // SDK and fetch exceptions can carry request details. Never print their contents.
  console.error(
    "Service smoke test failed. Check configuration, deployment and status-only access logs.",
  );
  process.exitCode = 1;
}
