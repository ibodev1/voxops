import { beforeEach, expect, it, vi } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { DemoChatRequestSchema, streamDemoChat, thinkingFilter, TOOL_NAMES } from "./demo-agent.js";

const mcp = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));
const sdk = vi.hoisted(() => ({ streamText: vi.fn(), toUIMessageStream: vi.fn() }));
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
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: sdk.streamText,
  toUIMessageStream: sdk.toUIMessageStream,
}));

const history = [{ role: "user" as const, content: "What's happening with VoxOps?" }];

beforeEach(() => {
  vi.resetAllMocks();
  mcp.listTools.mockResolvedValue({
    tools: TOOL_NAMES.map((name) => ({ name, description: `Live ${name}` })),
  });
  mcp.callTool.mockResolvedValue({ structuredContent: { fullName: "ibodev1/voxops" } });
  sdk.streamText.mockReturnValue({ stream: new ReadableStream() });
  sdk.toUIMessageStream.mockReturnValue(new ReadableStream());
});

it("validates bounded alternating history before inference", () => {
  expect(DemoChatRequestSchema.safeParse({ messages: history }).success).toBe(true);
  for (const request of [
    { messages: [] },
    { messages: [{ role: "user", content: " " }] },
    { messages: [{ role: "user", content: "x".repeat(401) }] },
    { messages: [history[0], history[0]] },
    { messages: history, debug: true },
  ])
    expect(DemoChatRequestSchema.safeParse(request).success).toBe(false);
});

it("exposes exactly four discovered read tools and executes through the MCP client", async () => {
  await streamDemoChat(history, new URL("https://example.test/mcp"));
  const options = sdk.streamText.mock.calls[0]![0] as Parameters<typeof import("ai").streamText>[0];
  expect(Object.keys(options.tools ?? {}).sort()).toEqual([...TOOL_NAMES].sort());
  expect((options.model as { modelId: string }).modelId).toBe("eu.amazon.nova-micro-v1:0");
  const status = options.tools?.get_repository_status;
  if (!status) throw new Error("Expected repository status tool");
  expect(status.description).toBe("Live get_repository_status");
  const schema = (status.inputSchema as { jsonSchema: Record<string, unknown> }).jsonSchema;
  expect(Object.keys(schema).sort()).toEqual(["properties", "required", "type"]);
  expect(schema.required).toEqual(["owner", "repo"]);
  expect(status.execute).toBeTypeOf("function");
  const result = await status.execute?.({ owner: "ibodev1", repo: "voxops" }, {} as never);
  expect(mcp.callTool).toHaveBeenCalledWith({
    name: "get_repository_status",
    arguments: { owner: "ibodev1", repo: "voxops" },
  });
  expect(result).toMatchObject({ status: "ok", result: { fullName: "ibodev1/voxops" } });
  for (let index = 0; index < 5; index++)
    await status.execute?.({ owner: "ibodev1", repo: "voxops" }, {} as never);
  const limited = await status.execute?.({ owner: "ibodev1", repo: "voxops" }, {} as never);
  expect(limited).toMatchObject({ status: "error", message: "Repository lookup limit reached." });
  expect(mcp.callTool).toHaveBeenCalledTimes(6);
  expect(options.prepareStep?.({ stepNumber: 0 } as never)).toMatchObject({
    toolChoice: "required",
  });
  expect(options.prepareStep?.({ stepNumber: 3 } as never)).toMatchObject({ activeTools: [] });
  const bound = options.stopWhen;
  expect(typeof bound).toBe("function");
  if (typeof bound === "function") {
    expect(bound({ steps: Array.from({ length: 3 }, () => ({})) } as never)).toBe(false);
    expect(bound({ steps: Array.from({ length: 4 }, () => ({})) } as never)).toBe(true);
  }
  expect(sdk.toUIMessageStream.mock.calls[0]![0]).toMatchObject({
    sendReasoning: false,
  });
  expect(sdk.toUIMessageStream.mock.calls[0]![0].onError(new Error("secret"))).toBe(
    "The live answer is unavailable right now.",
  );
});

it("rejects missing MCP capabilities before streaming", async () => {
  mcp.listTools.mockResolvedValue({ tools: [{ name: "get_repository_status" }] });
  await expect(streamDemoChat(history, new URL("https://example.test/mcp"))).rejects.toThrow(
    "MCP tools unavailable",
  );
  expect(sdk.streamText).not.toHaveBeenCalled();
  expect(mcp.close).toHaveBeenCalledOnce();
});

async function filtered(
  parts: TextStreamPart<ToolSet>[],
  requireTool = false,
): Promise<TextStreamPart<ToolSet>[]> {
  const output: TextStreamPart<ToolSet>[] = [];
  const input = new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  for await (const part of input.pipeThrough(
    thinkingFilter<ToolSet>(requireTool)({ tools: {}, stopStream() {} }),
  ))
    output.push(part);
  return output;
}

it("streams visible text while removing split and nested literal thinking blocks", async () => {
  const chunks = [
    "The repo ",
    "<thi",
    "nking>private <thinking>nested</thinking> trace</thi",
    "nking>is active.",
  ];
  const parts = chunks.map((text) => ({ type: "text-delta" as const, id: "answer", text }));
  const output = await filtered(parts);
  expect(
    output
      .filter((part) => part.type === "text-delta")
      .map((part) => part.text)
      .join(""),
  ).toBe("The repo is active.");
  expect(output.length).toBeGreaterThan(1);
});

it("does not touch reasoning parts and fails closed for an unclosed thinking block", async () => {
  const reasoning = { type: "reasoning-delta" as const, id: "reason", text: "private" };
  expect(await filtered([reasoning])).toEqual([reasoning]);
  await expect(
    filtered([{ type: "text-delta", id: "answer", text: "Visible <thinking>private" }]),
  ).rejects.toThrow("Incomplete model thinking block");
});

it("withholds model text until a real tool result has arrived", async () => {
  const toolResult = {
    type: "tool-result",
    toolCallId: "call-1",
    toolName: "get_repository_status",
    input: { owner: "ibodev1", repo: "voxops" },
    output: { status: "ok" },
  } as TextStreamPart<ToolSet>;
  const parts: TextStreamPart<ToolSet>[] = [
    { type: "text-delta", id: "prelude", text: "Unverified prelude" },
    toolResult,
    { type: "text-delta", id: "answer", text: "Verified answer" },
  ];
  const result = await filtered(parts, true);
  expect(result.filter((part) => part.type === "text-delta").map((part) => part.text)).toEqual([
    "Verified answer",
  ]);
  await expect(filtered([parts[0]!], true)).rejects.toThrow("Ungrounded model response");
});
