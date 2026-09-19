import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type Activity = {
  name: string;
  durationMs: number;
  status: "running" | "ok" | "error";
  result?: Record<string, unknown>;
};
type Turn = { role: "user" | "assistant"; content: string; activity?: Activity[] };
type RepositoryContext = {
  status?: Record<string, unknown>;
  issues?: Record<string, unknown>;
  pulls?: Record<string, unknown>;
  workflows?: Record<string, unknown>;
};

const prompts = [
  { label: "What's happening with VoxOps?", question: "What's happening with VoxOps?" },
  { label: "Are there any open issues?", question: "Are there any open issues?" },
  { label: "Show me the open pull requests.", question: "Show me the open pull requests." },
  { label: "Recent workflows?", question: "How are the recent workflows doing?" },
];
const toolNames = new Set([
  "get_repository_status",
  "list_open_issues",
  "list_pull_requests",
  "list_workflow_runs",
]);
const transport = new DefaultChatTransport({
  api: "/api/demo/chat",
  prepareSendMessagesRequest: ({ messages }) => {
    const recent = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
          .slice(0, 400),
      }))
      .filter((message) => message.content.trim())
      .slice(-7);
    while (recent.reduce((length, message) => length + message.content.length, 0) > 2400)
      recent.splice(0, 2);
    return { body: { messages: recent } };
  },
});

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function activityFromParts(parts: UIMessage["parts"]): Activity[] {
  const activity: Activity[] = [];
  for (const part of parts) {
    const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
    if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") continue;
    if (!toolNames.has(name) || !("state" in part)) continue;
    const output = "output" in part ? asObject(part.output) : undefined;
    const detail = asObject(output?.result);
    const status =
      part.state === "output-available"
        ? output?.status === "ok"
          ? "ok"
          : "error"
        : part.state === "output-error" || part.state === "output-denied"
          ? "error"
          : "running";
    activity.push({
      name,
      durationMs: typeof output?.durationMs === "number" ? output.durationMs : 0,
      status,
      ...(detail ? { result: detail } : {}),
    });
  }
  return activity;
}

export function turnsFromMessages(messages: UIMessage[]): Turn[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      ...(message.role === "assistant" ? { activity: activityFromParts(message.parts) } : {}),
    }));
}

const markdownComponents: Components = {
  a({ children, href, title }) {
    const external = !!href && /^(https?:)?\/\//i.test(href);
    return (
      <a
        href={href}
        title={title}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="markdown-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
};

export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function MessageBody({ role, content }: Pick<Turn, "role" | "content">) {
  return role === "assistant" ? <AssistantMarkdown content={content} /> : <p>{content}</p>;
}

function contextFromActivity(previous: RepositoryContext, activity: Activity[]): RepositoryContext {
  const next = { ...previous };
  for (const item of activity) {
    if (item.status !== "ok" || !item.result) continue;
    if (item.name === "get_repository_status") next.status = item.result;
    if (item.name === "list_open_issues") next.issues = item.result;
    if (item.name === "list_pull_requests") next.pulls = item.result;
    if (item.name === "list_workflow_runs") next.workflows = item.result;
  }
  return next;
}

function ToolActivity({ items }: { items: Activity[] }) {
  if (!items.length) return null;
  return (
    <div className="tool-activity" aria-label="MCP tool activity">
      {items.map((item, index) => (
        <details className="tool-row" key={`${item.name}-${index}`}>
          <summary>
            <span className={`tool-state ${item.status}`} aria-hidden="true">
              {item.status === "ok" ? "✓" : item.status === "running" ? "…" : "!"}
            </span>
            <span className="tool-name">{item.name}</span>
            <span className="tool-duration">
              {item.status === "running" ? "Checking repository…" : `${item.durationMs} ms`}
            </span>
            <span className="tool-detail-label">Details</span>
          </summary>
          <div className="tool-detail-content">
            <span>
              {item.status === "ok"
                ? "Live MCP result"
                : item.status === "running"
                  ? "Checking repository…"
                  : "The MCP read did not complete."}
            </span>
            {item.result && <pre>{JSON.stringify(item.result, null, 2).slice(0, 1800)}</pre>}
          </div>
        </details>
      ))}
    </div>
  );
}

function ContextPanel({ context }: { context: RepositoryContext }) {
  const defaultBranch = text(context.status?.defaultBranch);
  const archived = context.status?.archived;
  const commit = asObject(context.status?.latestCommit);
  const commitMessage = text(commit?.message)?.split("\n")[0];
  const commitSha = text(commit?.sha)?.slice(0, 7);
  const issueCount = Array.isArray(context.issues?.issues)
    ? context.issues.issues.length
    : undefined;
  const pullCount = Array.isArray(context.pulls?.pullRequests)
    ? context.pulls.pullRequests.length
    : undefined;
  const runs = Array.isArray(context.workflows?.workflowRuns)
    ? context.workflows.workflowRuns
    : undefined;
  const latestRun = runs ? asObject(runs[0]) : undefined;
  const conclusion = text(latestRun?.conclusion) ?? text(latestRun?.status);
  const hasContext =
    !!defaultBranch ||
    typeof archived === "boolean" ||
    !!commitMessage ||
    issueCount !== undefined ||
    pullCount !== undefined ||
    runs !== undefined;
  return (
    <aside className="context-panel" aria-label="Live repository context">
      <span className="eyebrow">LIVE REPOSITORY CONTEXT</span>
      <div className="repo-identity">
        <span className="repo-owner">ibodev1 /</span>
        <strong>voxops</strong>
      </div>
      {!hasContext && (
        <p className="context-empty">
          Repository context will appear after the first live response.
        </p>
      )}
      {(defaultBranch || typeof archived === "boolean") && (
        <div className="context-section">
          <span className="context-label">REPOSITORY</span>
          {defaultBranch && (
            <div className="context-line">
              <span>Default branch</span>
              <strong>{defaultBranch}</strong>
            </div>
          )}
          {typeof archived === "boolean" && (
            <div className="context-line">
              <span>State</span>
              <strong>{archived ? "Archived" : "Active"}</strong>
            </div>
          )}
        </div>
      )}
      {(commitMessage || commitSha) && (
        <div className="context-section">
          <span className="context-label">LATEST COMMIT</span>
          {commitMessage && <p className="commit-message">{commitMessage}</p>}
          {commitSha && <span className="commit-sha">{commitSha}</span>}
        </div>
      )}
      {(issueCount !== undefined || pullCount !== undefined) && (
        <div className="context-section context-counts">
          {issueCount !== undefined && (
            <div>
              <span className="context-label">OPEN ISSUES SHOWN</span>
              <strong>{issueCount}</strong>
            </div>
          )}
          {pullCount !== undefined && (
            <div>
              <span className="context-label">OPEN PRS SHOWN</span>
              <strong>{pullCount}</strong>
            </div>
          )}
        </div>
      )}
      {runs && (runs.length === 0 || conclusion) && (
        <div className="context-section workflow-section">
          <span className="context-label">RECENT WORKFLOW</span>
          <strong className={conclusion === "failure" ? "workflow-failure" : ""}>
            {conclusion ?? "No recent runs"}
          </strong>
          {text(latestRun?.workflowName) && <span>{text(latestRun?.workflowName)}</span>}
        </div>
      )}
    </aside>
  );
}

export function App() {
  const { messages, sendMessage, regenerate, status, error, clearError } = useChat({ transport });
  const turns = useMemo(() => turnsFromMessages(messages), [messages]);
  const loading = status === "streaming" || status === "submitted";
  const [draft, setDraft] = useState("");
  const context = useMemo(
    () =>
      turns.reduce(
        (current, turn) => contextFromActivity(current, turn.activity ?? []),
        {} as RepositoryContext,
      ),
    [turns],
  );
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, loading, error]);

  async function ask(question: string) {
    const content = question.trim();
    if (!content || loading) return;
    setDraft("");
    clearError();
    await sendMessage({ text: content });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(draft);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask(draft);
    }
  }

  const retryQuestion = turns.some((turn) => turn.role === "user");
  return (
    <div className="app-shell min-h-screen">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div>
            <strong>VoxOps</strong>
            <span>DEVELOPER OPERATIONS</span>
          </div>
        </div>
        <div className="header-right">
          <span className="header-label">ALEXA+ EXPERIENCE SIMULATOR</span>
          <span className="read-only-tag">PUBLIC · READ ONLY</span>
        </div>
      </header>

      <main className="workspace">
        <section className="conversation-panel" aria-label="Conversation">
          <div className="conversation-head">
            <div>
              <span className="eyebrow">CONVERSATION</span>
              <h1>Ask VoxOps about the repository.</h1>
            </div>
          </div>
          <div className="conversation-scroll" aria-live="polite">
            <div className="welcome-message">
              <span className="speaker">VOXOPS</span>
              <p>Ask about the latest commit, open work, or recent workflows in ibodev1/voxops.</p>
            </div>
            {turns.map((turn, index) => (
              <article className={`message message-${turn.role}`} key={index}>
                <span className="speaker">{turn.role === "user" ? "YOU" : "VOXOPS"}</span>
                <MessageBody role={turn.role} content={turn.content} />
                {turn.activity && <ToolActivity items={turn.activity} />}
              </article>
            ))}
            {loading && (
              <div className="loading-message" role="status">
                <span className="pulse-dot" /> Checking the live MCP server and composing an answer…
              </div>
            )}
            {error && (
              <div className="error-message" role="alert">
                <span>The live answer is unavailable right now.</span>
                {retryQuestion && (
                  <button type="button" onClick={() => void regenerate()}>
                    Retry ↗
                  </button>
                )}
              </div>
            )}
            <div ref={bottom} />
          </div>
          <div className="conversation-bottom">
            {turns.length === 0 && (
              <div className="suggested-prompts" aria-label="Suggested prompts">
                {prompts.map((prompt) => (
                  <button
                    type="button"
                    key={prompt.question}
                    aria-label={prompt.question}
                    onClick={() => void ask(prompt.question)}
                    disabled={loading}
                  >
                    {prompt.label}
                  </button>
                ))}
              </div>
            )}
            <form onSubmit={submit} className="composer">
              <label htmlFor="question" className="sr-only">
                Ask VoxOps
              </label>
              <textarea
                id="question"
                value={draft}
                maxLength={400}
                rows={2}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Ask about VoxOps…"
                disabled={loading}
              />
              <button type="submit" disabled={loading || !draft.trim()} aria-label="Send message">
                <span aria-hidden="true">↗</span>
                <span>Send</span>
              </button>
            </form>
            <div className="composer-meta">
              <span>Enter to send · Shift + Enter for a new line</span>
              <span>Powered by live VoxOps MCP</span>
            </div>
          </div>
        </section>
        <ContextPanel context={context} />
      </main>
      <footer className="app-footer">
        <span>Simulated Alexa+ experience powered by the live VoxOps MCP server.</span>
      </footer>
    </div>
  );
}
