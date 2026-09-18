import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { DemoChatRequestSchema, runDemoChat } from "./demo-agent.js";

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

const names = [
  "get_repository_status",
  "list_open_issues",
  "list_pull_requests",
  "list_workflow_runs",
];
const endpoint = new URL("https://example.test/mcp");
const history = [{ role: "user" as const, content: "What's happening with VoxOps?" }];
const toolUse = (
  name: string,
  input: Record<string, unknown> = { owner: "ibodev1", repo: "voxops" },
) =>
  ({
    output: {
      message: { role: "assistant", content: [{ toolUse: { toolUseId: "call-1", name, input } }] },
    },
    stopReason: "tool_use",
  }) as ConverseCommandOutput;
const answer = (text = "The repository is active.") =>
  ({
    output: { message: { role: "assistant", content: [{ text }] } },
    stopReason: "end_turn",
  }) as ConverseCommandOutput;

beforeEach(() => {
  vi.resetAllMocks();
  mcp.listTools.mockResolvedValue({
    tools: names.map((name) => ({
      name,
      description: `Live ${name}`,
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    })),
  });
  mcp.callTool.mockResolvedValue({
    content: [{ type: "text", text: "Repository ibodev1/voxops" }],
    structuredContent: { fullName: "ibodev1/voxops", archived: false },
  });
});

it("rejects empty, oversized, extra-field, and malformed histories before inference", () => {
  const valid = { messages: history };
  expect(DemoChatRequestSchema.safeParse(valid).success).toBe(true);
  for (const request of [
    { messages: [] },
    { messages: [{ role: "user", content: " " }] },
    { messages: [{ role: "user", content: "x".repeat(401) }] },
    { messages: Array.from({ length: 9 }, () => history[0]) },
    {
      messages: Array.from({ length: 7 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(400),
      })),
    },
    { messages: [{ role: "assistant", content: "hello" }] },
    { messages: [history[0], history[0]] },
    { ...valid, debug: true },
  ])
    expect(DemoChatRequestSchema.safeParse(request).success).toBe(false);
});

it("maps Bedrock tool use to the discovered MCP capability and forwards the result", async () => {
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValueOnce(toolUse("get_repository_status"))
    .mockResolvedValueOnce(answer());
  const result = await runDemoChat(history, endpoint, converse);
  expect(mcp.connect).toHaveBeenCalledOnce();
  expect(mcp.callTool).toHaveBeenCalledWith({
    name: "get_repository_status",
    arguments: { owner: "ibodev1", repo: "voxops" },
  });
  expect(result).toMatchObject({
    message: "The repository is active.",
    activity: [
      {
        name: "get_repository_status",
        status: "ok",
        result: { fullName: "ibodev1/voxops" },
      },
    ],
  });
  expect(converse.mock.calls[0]![0].modelId).toBe("eu.amazon.nova-micro-v1:0");
  expect(converse.mock.calls[0]![0].toolConfig?.toolChoice).toEqual({ any: {} });
  expect(converse.mock.calls[0]![0].toolConfig?.tools).toHaveLength(4);
  expect(converse.mock.calls[1]![0].messages?.at(-1)).toMatchObject({
    role: "user",
    content: [
      {
        toolResult: {
          status: "success",
          content: [{ text: '{"fullName":"ibodev1/voxops","archived":false}' }],
        },
      },
    ],
  });
  expect(mcp.close).toHaveBeenCalledOnce();
});

it("removes Nova thinking blocks only from the final model answer", async () => {
  const literalHistory = [{ role: "user" as const, content: "What does <thinking> mean?" }];
  const final = {
    output: {
      message: {
        role: "assistant",
        content: [
          { text: "<thinking>private plan" },
          { text: "private trace</thinking>The repository is active." },
          { text: "<thinking>more private reasoning</thinking>CI is green." },
        ],
      },
    },
    stopReason: "end_turn",
  } as ConverseCommandOutput;
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValueOnce(toolUse("get_repository_status"))
    .mockResolvedValueOnce(final);
  const result = await runDemoChat(literalHistory, endpoint, converse);
  expect(result.message).toBe("The repository is active.\nCI is green.");
  expect(JSON.stringify(result)).not.toMatch(
    /thinking|private plan|private trace|private reasoning/,
  );
  expect(result.activity).toMatchObject([
    { name: "get_repository_status", status: "ok", result: { fullName: "ibodev1/voxops" } },
  ]);
  expect(converse.mock.calls[0]![0].messages?.[0]?.content).toEqual([
    { text: "What does <thinking> mean?" },
  ]);
});

it("fails safely if a Nova thinking block is left open", async () => {
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValueOnce(toolUse("get_repository_status"))
    .mockResolvedValueOnce(answer("<thinking>private trace"));
  await expect(runDemoChat(history, endpoint, converse)).rejects.toThrow(
    "Malformed Bedrock thinking block",
  );
  expect(mcp.close).toHaveBeenCalledOnce();
});

it("bounds repeated tool requests at three rounds", async () => {
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValue(toolUse("list_open_issues"));
  const result = await runDemoChat(history, endpoint, converse);
  expect(converse).toHaveBeenCalledTimes(4);
  expect(mcp.callTool).toHaveBeenCalledTimes(3);
  expect(result.message).toMatch(/lookup limit/);
});

it("never invokes an unsupported MCP tool even if Bedrock requests it", async () => {
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValueOnce(toolUse("delete_repository"))
    .mockResolvedValueOnce(answer("That tool is unavailable."));
  await expect(runDemoChat(history, endpoint, converse)).rejects.toThrow(
    "Ungrounded Bedrock response",
  );
  expect(mcp.callTool).not.toHaveBeenCalled();
  expect(converse.mock.calls[1]![0].messages?.at(-1)).toMatchObject({
    content: [{ toolResult: { status: "error", content: [{ text: "Unsupported tool." }] } }],
  });
});

it("reports MCP failures safely and does not forward error payloads to the browser", async () => {
  mcp.callTool.mockResolvedValue({
    isError: true,
    content: [{ type: "text", text: "internal upstream detail" }],
    structuredContent: { secret: "hidden" },
  });
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValueOnce(toolUse("list_open_issues"))
    .mockResolvedValueOnce(answer("Repository data is unavailable."));
  const result = await runDemoChat(history, endpoint, converse);
  expect(result.activity).toMatchObject([{ name: "list_open_issues", status: "error" }]);
  expect(result.activity[0]).not.toHaveProperty("result");
  expect(JSON.stringify(converse.mock.calls[1]![0])).not.toMatch(/hidden|internal upstream detail/);
});

it("passes a nonallowlisted repository through MCP enforcement and returns only a generic failure", async () => {
  mcp.callTool.mockResolvedValue({
    isError: true,
    content: [{ type: "text", text: "Repository is not on the public allowlist." }],
  });
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockResolvedValueOnce(toolUse("get_repository_status", { owner: "outsider", repo: "private" }))
    .mockResolvedValueOnce(answer("That repository is unavailable."));
  const result = await runDemoChat(history, endpoint, converse);
  expect(mcp.callTool).toHaveBeenCalledWith({
    name: "get_repository_status",
    arguments: { owner: "outsider", repo: "private" },
  });
  expect(result.activity[0]).toMatchObject({ status: "error" });
  expect(converse.mock.calls[1]![0].messages?.at(-1)).toMatchObject({
    content: [
      { toolResult: { status: "error", content: [{ text: "Repository data is unavailable." }] } },
    ],
  });
});

it("closes the MCP client on Bedrock and MCP discovery failures", async () => {
  const converse = vi
    .fn<(input: ConverseCommandInput) => Promise<ConverseCommandOutput>>()
    .mockRejectedValue(new Error("Bedrock internal detail"));
  await expect(runDemoChat(history, endpoint, converse)).rejects.toThrow("Bedrock internal detail");
  expect(mcp.close).toHaveBeenCalledOnce();
  mcp.close.mockClear();
  mcp.listTools.mockRejectedValue(new Error("MCP internal detail"));
  await expect(runDemoChat(history, endpoint, converse)).rejects.toThrow("MCP internal detail");
  expect(mcp.close).toHaveBeenCalledOnce();
});
