import { beforeEach, expect, it, vi } from "vitest";
import { DemoChatRequestSchema, streamDemoChat } from "./demo-agent.js";

const mcp = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn() }));
const sdk = vi.hoisted(() => ({ streamText: vi.fn(), toUIMessageStream: vi.fn() }));
const tools = {
  get_repository_status: {},
  list_open_issues: {},
  list_pull_requests: {},
  list_workflow_runs: {},
};

vi.mock("./mcp-tools.js", () => ({ connectMcpTools: mcp.connect }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: sdk.streamText,
  toUIMessageStream: sdk.toUIMessageStream,
}));

const history = [{ role: "user" as const, content: "What's happening with VoxOps?" }];

beforeEach(() => {
  vi.resetAllMocks();
  mcp.connect.mockResolvedValue({ tools, close: mcp.close });
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

it("configures a grounded, bounded stream and closes MCP when it ends", async () => {
  const mcpUrl = new URL("https://example.test/mcp");
  await streamDemoChat(history, mcpUrl);
  expect(mcp.connect).toHaveBeenCalledWith(mcpUrl);

  const options = sdk.streamText.mock.calls[0]![0] as Parameters<typeof import("ai").streamText>[0];
  expect(options.tools).toBe(tools);
  expect((options.model as { modelId: string }).modelId).toBe("eu.amazon.nova-micro-v1:0");
  expect(options.prepareStep?.({ stepNumber: 0 } as never)).toMatchObject({
    toolChoice: "required",
  });
  expect(options.prepareStep?.({ stepNumber: 3 } as never)).toMatchObject({ activeTools: [] });
  expect(typeof options.stopWhen).toBe("function");
  if (typeof options.stopWhen === "function") {
    expect(options.stopWhen({ steps: Array.from({ length: 3 }, () => ({})) } as never)).toBe(false);
    expect(options.stopWhen({ steps: Array.from({ length: 4 }, () => ({})) } as never)).toBe(true);
  }
  expect(options.maxOutputTokens).toBe(350);
  expect(options.maxRetries).toBe(0);
  expect(options.system).toContain("Lead with the most important result");
  expect(options.system).toContain("most relevant 1-3 items");
  expect(options.system).toContain("Do not reproduce every tool field");

  const ui = sdk.toUIMessageStream.mock.calls[0]![0];
  expect(ui).toMatchObject({ tools, sendReasoning: false });
  expect(ui.onError(new Error("secret"))).toBe("The live answer is unavailable right now.");
  await ui.onEnd({} as never);
  expect(mcp.close).toHaveBeenCalledOnce();
});

it("closes MCP when stream setup fails", async () => {
  sdk.streamText.mockImplementationOnce(() => {
    throw new Error("setup failed");
  });
  await expect(streamDemoChat(history, new URL("https://example.test/mcp"))).rejects.toThrow(
    "setup failed",
  );
  expect(mcp.close).toHaveBeenCalledOnce();
});
