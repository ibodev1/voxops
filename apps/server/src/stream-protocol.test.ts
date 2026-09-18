import {
  createUIMessageStreamResponse,
  toUIMessageStream,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { expect, it } from "vitest";
import { thinkingFilter } from "./demo-agent.js";

it("uses AI SDK SSE with incremental text and tool events but no reasoning", async () => {
  const parts: TextStreamPart<ToolSet>[] = [
    { type: "start" },
    { type: "reasoning-start", id: "private" },
    { type: "reasoning-delta", id: "private", text: "private reasoning" },
    { type: "reasoning-end", id: "private" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_repository_status",
      input: { owner: "ibodev1", repo: "voxops" },
    } as TextStreamPart<ToolSet>,
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "get_repository_status",
      input: { owner: "ibodev1", repo: "voxops" },
      output: { status: "ok", durationMs: 420 },
    } as TextStreamPart<ToolSet>,
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", text: "The repo " },
    { type: "text-delta", id: "answer", text: "<thin" },
    { type: "text-delta", id: "answer", text: "king>private trace</thinking>is " },
    { type: "text-delta", id: "answer", text: "active." },
    { type: "text-end", id: "answer" },
  ];
  const source = new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const response = createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: source.pipeThrough(thinkingFilter<ToolSet>()({ tools: {}, stopStream() {} })),
      sendReasoning: false,
      onError: () => "The live answer is unavailable right now.",
    }),
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const wire = await response.text();
  expect(wire).toContain('"type":"tool-input-available"');
  expect(wire).toContain('"type":"tool-output-available"');
  expect(wire).toContain('"delta":"The repo "');
  expect(wire).toContain('"delta":"is "');
  expect(wire).toContain('"delta":"active."');
  expect(wire).not.toMatch(/private reasoning|private trace|<thinking>|reasoning-delta/);
});

it("redacts provider errors in the public SSE protocol", async () => {
  const source = new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      controller.enqueue({ type: "start" });
      controller.enqueue({ type: "error", error: new Error("private AWS exception detail") });
      controller.close();
    },
  });
  const response = createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: source,
      sendReasoning: false,
      onError: () => "The live answer is unavailable right now.",
    }),
  });
  const wire = await response.text();
  expect(wire).toContain("The live answer is unavailable right now.");
  expect(wire).not.toContain("private AWS exception detail");
});
