import { expect, it } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { thinkingFilter } from "./thinking-filter.js";

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

async function visibleText(chunks: string[]): Promise<string> {
  const output = await filtered(
    chunks.map((text) => ({ type: "text-delta" as const, id: "answer", text })),
  );
  return output
    .filter((part) => part.type === "text-delta")
    .map((part) => part.text)
    .join("");
}

it("removes complete, nested, and split literal thinking blocks", async () => {
  expect(
    await visibleText([
      "The repo ",
      "<thi",
      "nking>private <thinking>nested</thinking> trace</thi",
      "nking>is active.",
    ]),
  ).toBe("The repo is active.");
});

it.each([
  ["an opening tag", ["Visible ", "<thinking>"]],
  ["thinking content", ["Visible <thinking>private trace"]],
  ["a partial closing tag", ["Visible <thinking>private trace</think"]],
  ["a partial opening tag", ["Visible <think"]],
])("closes cleanly when the stream ends during %s", async (_label, chunks) => {
  expect(await visibleText(chunks)).toBe("Visible ");
});

it("suppresses a stray closing delimiter without failing the stream", async () => {
  expect(await visibleText(["Visible </thinking>answer"])).toBe("Visible answer");
});

it("does not alter normal model text", async () => {
  expect(await visibleText(["The repo ", "is active."])).toBe("The repo is active.");
});

it("passes reasoning parts through for the UI protocol to omit", async () => {
  const reasoning = { type: "reasoning-delta" as const, id: "reason", text: "private" };
  expect(await filtered([reasoning])).toEqual([reasoning]);
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
  expect(await filtered([parts[0]!], true)).toEqual([]);
});
