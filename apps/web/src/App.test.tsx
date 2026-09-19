import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown, MessageBody, turnsFromMessages } from "./App.js";

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

it("renders assistant emphasis and GFM without changing user text", () => {
  const assistant = renderToStaticMarkup(
    <MessageBody role="assistant" content={"**Workflow:** CI\n\n- completed\n- ~~cancelled~~"} />,
  );
  expect(assistant).toContain("<strong>Workflow:</strong>");
  expect(assistant).toContain("<ul>");
  expect(assistant).toContain("<del>cancelled</del>");

  const user = renderToStaticMarkup(<MessageBody role="user" content="**keep this literal**" />);
  expect(user).toBe("<p>**keep this literal**</p>");
});

it("opens external Markdown links safely", () => {
  const html = renderToStaticMarkup(
    <AssistantMarkdown content="[Repository](https://github.com/ibodev1/voxops)" />,
  );
  expect(html).toContain('href="https://github.com/ibodev1/voxops"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
});

it("does not render raw HTML or usable javascript links", () => {
  const html = renderToStaticMarkup(
    <AssistantMarkdown
      content={
        '<script>alert("xss")</script>\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))'
      }
    />,
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:");
});
