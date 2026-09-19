import { beforeEach, expect, it, vi } from "vitest";
import { connectMcpTools, TOOL_NAMES } from "./mcp-tools.js";

const mcp = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    connect = mcp.connect;
    listTools = mcp.listTools;
    callTool = mcp.callTool;
    close = mcp.close;
  },
  StreamableHTTPClientTransport: class {
    constructor(readonly url: URL) {}
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mcp.listTools.mockResolvedValue({
    tools: [
      ...TOOL_NAMES.map((name) => ({ name, description: `Live ${name}` })),
      { name: "dangerous_write", description: "Must never reach the model" },
    ],
  });
  mcp.callTool.mockResolvedValue({ structuredContent: { fullName: "ibodev1/voxops" } });
});

it("adapts exactly the four allowed tools with minimal validated schemas", async () => {
  const connection = await connectMcpTools(new URL("https://example.test/mcp"));
  expect(Object.keys(connection.tools).sort()).toEqual([...TOOL_NAMES].sort());

  const status = connection.tools.get_repository_status;
  expect(status.description).toBe("Live get_repository_status");
  const schema = (status.inputSchema as { jsonSchema: Record<string, unknown> }).jsonSchema;
  expect(Object.keys(schema).sort()).toEqual(["properties", "required", "type"]);
  expect(schema.required).toEqual(["owner", "repo"]);
  if (!status.execute) throw new Error("Expected repository status executor");

  const result = await status.execute({ owner: "ibodev1", repo: "voxops" }, {} as never);
  expect(mcp.callTool).toHaveBeenCalledWith({
    name: "get_repository_status",
    arguments: { owner: "ibodev1", repo: "voxops" },
  });
  expect(result).toMatchObject({ status: "ok", result: { fullName: "ibodev1/voxops" } });

  for (let index = 0; index < 5; index++)
    await status.execute({ owner: "ibodev1", repo: "voxops" }, {} as never);
  expect(await status.execute({ owner: "ibodev1", repo: "voxops" }, {} as never)).toMatchObject({
    status: "error",
    message: "Repository lookup limit reached.",
  });
  expect(mcp.callTool).toHaveBeenCalledTimes(6);

  await connection.close();
  expect(mcp.close).toHaveBeenCalledOnce();
});

it("bounds tool results and hides MCP failures", async () => {
  const connection = await connectMcpTools(new URL("https://example.test/mcp"));
  const issues = connection.tools.list_open_issues;
  if (!issues.execute) throw new Error("Expected issue list executor");

  mcp.callTool.mockResolvedValueOnce({ structuredContent: { data: "x".repeat(5001) } });
  expect(await issues.execute({ owner: "ibodev1", repo: "voxops" }, {} as never)).toMatchObject({
    status: "ok",
    message: "Repository data exceeds the response limit.",
  });

  mcp.callTool.mockRejectedValueOnce(new Error("private provider error"));
  expect(await issues.execute({ owner: "ibodev1", repo: "voxops" }, {} as never)).toMatchObject({
    status: "error",
    message: "Repository data is unavailable.",
  });
});

it("closes the client when the exact tool set is unavailable", async () => {
  mcp.listTools.mockResolvedValue({ tools: [{ name: "get_repository_status" }] });
  await expect(connectMcpTools(new URL("https://example.test/mcp"))).rejects.toThrow(
    "MCP tools unavailable",
  );
  expect(mcp.close).toHaveBeenCalledOnce();
});
