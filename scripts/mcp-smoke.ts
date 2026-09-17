import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const usePrivate = Boolean(
  process.env.VOXOPS_GITHUB_APP_ID && process.env.VOXOPS_GITHUB_PRIVATE_KEY_PATH,
);
const ref = usePrivate
  ? { owner: "ibodev1", repo: "voxops" }
  : { owner: "modelcontextprotocol", repo: "typescript-sdk" };
const port = process.env.PORT ?? "3000";
const client = new Client(
  { name: "voxops-smoke", version: "0.1.0" },
  { versionNegotiation: { mode: "auto" } },
);

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  if (client.getServerVersion()?.name !== "voxops") throw new Error("Unexpected MCP server");

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const expected = [
    "get_repository_status",
    "list_open_issues",
    "list_pull_requests",
    "list_workflow_runs",
  ];
  if (tools.length !== expected.length || expected.some((name) => !tools.includes(name))) {
    throw new Error("Expected MCP tools are unavailable");
  }

  const result = await client.callTool({ name: "get_repository_status", arguments: ref });
  const text = result.content.find((item) => item.type === "text");
  const status = result.structuredContent;
  if (
    result.isError ||
    text?.type !== "text" ||
    !text.text.includes(`Repository ${ref.owner}/${ref.repo}`) ||
    !status ||
    typeof status !== "object" ||
    Array.isArray(status) ||
    !("fullName" in status) ||
    !("defaultBranch" in status) ||
    !("private" in status) ||
    !("latestCommit" in status) ||
    status.fullName !== `${ref.owner}/${ref.repo}` ||
    typeof status.defaultBranch !== "string" ||
    typeof status.private !== "boolean" ||
    typeof status.latestCommit !== "object"
  ) {
    throw new Error("Repository status result is incomplete");
  }

  const counts: string[] = [];
  for (const [name, field] of [
    ["list_open_issues", "issues"],
    ["list_pull_requests", "pullRequests"],
    ["list_workflow_runs", "workflowRuns"],
  ] as const) {
    const listed = await client.callTool({ name, arguments: ref });
    const text = listed.content.find((item) => item.type === "text");
    const data = listed.structuredContent;
    const items =
      data && typeof data === "object" && !Array.isArray(data) && field in data
        ? (data as Record<string, unknown>)[field]
        : undefined;
    if (
      listed.isError ||
      text?.type !== "text" ||
      !text.text.includes(`${ref.owner}/${ref.repo}`) ||
      !Array.isArray(items)
    ) {
      throw new Error(`${name} result is incomplete`);
    }
    counts.push(`${name}: ${items.length}`);
  }

  console.log(
    `MCP smoke passed for ${status.fullName} (${status.private ? "private" : "public"}).`,
  );
  console.log(counts.join(", "));
} catch {
  console.error("MCP smoke failed. Check the local server and GitHub App configuration.");
  process.exitCode = 1;
} finally {
  await client.close();
}
