import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import { turnsFromMessages } from "./App.js";

it("renders only text parts while keeping live tool activity separate", () => {
  const messages: UIMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "Repository status?" }] },
    {
      id: "assistant",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "private chain of thought" },
        {
          type: "tool-get_repository_status",
          toolCallId: "call-1",
          state: "input-available",
          input: { owner: "ibodev1", repo: "voxops" },
        },
        { type: "text", text: "The repository is active." },
      ],
    },
  ];
  const turns = turnsFromMessages(messages);
  expect(turns[1]?.content).toBe("The repository is active.");
  expect(JSON.stringify(turns)).not.toContain("private chain of thought");
  expect(turns[1]?.activity).toMatchObject([{ name: "get_repository_status", status: "running" }]);
});
