import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GitHubRepositoryError, type GitHubRepositoryClient } from "@voxops/github";
import { createApp } from "./app.js";
import { formatRepositoryStatus } from "./mcp.js";

const getRepositoryStatus = vi.fn<GitHubRepositoryClient["getRepositoryStatus"]>();
const app = createApp({ getRepositoryStatus });
const status = {
  owner: "example",
  name: "private",
  fullName: "example/private",
  description: null,
  defaultBranch: "main",
  private: true,
  archived: false,
  url: "https://github.com/example/private",
  pushedAt: "2026-09-17T00:00:00Z",
  latestCommit: {
    sha: "a".repeat(40),
    message: "Fix auth\n\nMore detail",
    authorName: "Example Author",
    committedAt: "2026-09-17T00:00:00Z",
  },
};

let client: Client;

beforeEach(async () => {
  vi.resetAllMocks();
  getRepositoryStatus.mockResolvedValue(status);
  client = new Client(
    { name: "voxops-test", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      request.headers.set("host", "127.0.0.1");
      return app.fetch(request);
    },
  });
  await client.connect(transport);
});

afterEach(async () => client.close());

describe("MCP Streamable HTTP endpoint", () => {
  it("connects and lists exactly one read-only repository tool", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "voxops", version: "0.1.0" });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "get_repository_status",
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it("returns private repository status as text and structured content", async () => {
    const result = await client.callTool({
      name: "get_repository_status",
      arguments: { owner: "example", repo: "private" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(status);
    expect(result.content).toEqual([{ type: "text", text: formatRepositoryStatus(status) }]);
    expect(getRepositoryStatus).toHaveBeenCalledWith({ owner: "example", repo: "private" });
  });

  it("also serves a 2025-era Streamable HTTP client", async () => {
    const legacy = new Client({ name: "legacy-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        request.headers.set("host", "127.0.0.1");
        return app.fetch(request);
      },
    });
    try {
      await legacy.connect(transport);
      expect(legacy.getDiscoverResult()).toBeUndefined();
      expect((await legacy.listTools()).tools.map((tool) => tool.name)).toEqual([
        "get_repository_status",
      ]);
      const result = await legacy.callTool({
        name: "get_repository_status",
        arguments: { owner: "example", repo: "private" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(status);
    } finally {
      await legacy.close();
    }
  });

  it.each([
    { owner: "bad/owner", repo: "private" },
    { owner: "example", repo: "bad!repo" },
  ])("rejects invalid repository input before calling GitHub", async (args) => {
    const result = await client.callTool({ name: "get_repository_status", arguments: args });
    expect(result.isError).toBe(true);
    expect(getRepositoryStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", "Repository not found or inaccessible."],
    ["authentication", "GitHub App authentication failed."],
    ["rate_limited", "GitHub rate limit reached. Try again later."],
    ["upstream", "GitHub is unavailable."],
  ] as const)("maps %s to a safe tool failure", async (kind, message) => {
    const error = new GitHubRepositoryError(kind);
    error.message = "secret-token /sensitive/private-key.pem";
    getRepositoryStatus.mockRejectedValue(error);
    const result = await client.callTool({
      name: "get_repository_status",
      arguments: { owner: "example", repo: "private" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: message }]);
    expect(JSON.stringify(result)).not.toMatch(/secret-token|private-key\.pem/);
  });

  it("sanitizes unexpected failures", async () => {
    getRepositoryStatus.mockRejectedValue(new Error("secret-token /sensitive/private-key.pem"));
    const result = await client.callTool({
      name: "get_repository_status",
      arguments: { owner: "example", repo: "private" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Repository status is unavailable." }]);
  });

  it("rejects a non-local Host or Origin", async () => {
    for (const headers of [
      { host: "evil.example" },
      { host: "127.0.0.1", origin: "http://evil.example" },
    ]) {
      const response = await app.fetch(new Request("http://127.0.0.1/mcp", { headers }));
      expect(response.status).toBe(403);
    }
  });
});

it("formats nullable dates and multiline commit messages deterministically", () => {
  expect(formatRepositoryStatus({ ...status, pushedAt: null, archived: true })).toBe(
    [
      "Repository example/private",
      "Default branch: main",
      "Latest commit: aaaaaaa — Fix auth",
      "Last pushed: unknown",
      "Private: yes",
      "Archived: yes",
    ].join("\n"),
  );
});
