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

  const tools = (await client.listTools()).tools;
  if (tools.length !== 1 || tools[0]?.name !== "get_repository_status") {
    throw new Error("Repository status tool is unavailable");
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

  console.log(
    `MCP smoke passed: connected, listed get_repository_status, and read ${status.fullName} (${status.private ? "private" : "public"}, ${status.defaultBranch}).`,
  );
} catch {
  console.error("MCP smoke failed. Check the local server and GitHub App configuration.");
  process.exitCode = 1;
} finally {
  await client.close();
}
