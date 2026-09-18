import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

type Activity = {
  name: string;
  durationMs: number;
  status: "ok" | "error";
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
const apiBase =
  import.meta.env.VITE_VOXOPS_API_URL?.trim().replace(/\/$/, "") ||
  (import.meta.env.DEV ? "" : undefined);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function activityFromResponse(value: unknown): Activity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const activity: Activity[] = [];
  for (const entry of value) {
    const item = asObject(entry);
    const detail = asObject(item?.result);
    if (
      !item ||
      typeof item.name !== "string" ||
      !toolNames.has(item.name) ||
      typeof item.durationMs !== "number" ||
      !Number.isFinite(item.durationMs) ||
      (item.status !== "ok" && item.status !== "error") ||
      (item.result !== undefined && !detail)
    )
      return undefined;
    activity.push({
      name: item.name,
      durationMs: item.durationMs,
      status: item.status,
      ...(detail ? { result: detail } : {}),
    });
  }
  return activity;
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
              {item.status === "ok" ? "✓" : "!"}
            </span>
            <span className="tool-name">{item.name}</span>
            <span className="tool-duration">{item.durationMs} ms</span>
            <span className="tool-detail-label">Details</span>
          </summary>
          <div className="tool-detail-content">
            <span>
              {item.status === "ok" ? "Live MCP result" : "The MCP read did not complete."}
            </span>
            {item.result && <pre>{JSON.stringify(item.result, null, 2).slice(0, 1800)}</pre>}
          </div>
        </details>
      ))}
    </div>
  );
}

function ContextPanel({
  context,
  hasLiveData,
}: {
  context: RepositoryContext;
  hasLiveData: boolean;
}) {
  const commit = asObject(context.status?.latestCommit);
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
  return (
    <aside className="context-panel" aria-label="Live repository context">
      <div className="panel-heading">
        <span className="eyebrow">LIVE REPOSITORY CONTEXT</span>
        <span
          className={`context-indicator ${hasLiveData ? "active" : ""}`}
          aria-label={hasLiveData ? "Live data loaded" : "Awaiting live data"}
        />
      </div>
      <div className="repo-identity">
        <span className="repo-owner">ibodev1 /</span>
        <strong>voxops</strong>
        <p>Public repository · read-only access</p>
      </div>
      <div className="context-section">
        <span className="context-label">REPOSITORY</span>
        <div className="context-line">
          <span>Default branch</span>
          <strong>{text(context.status?.defaultBranch) ?? "—"}</strong>
        </div>
        <div className="context-line">
          <span>State</span>
          <strong>
            {context.status ? (context.status.archived ? "Archived" : "Active") : "—"}
          </strong>
        </div>
      </div>
      <div className="context-section">
        <span className="context-label">LATEST COMMIT</span>
        <p className="commit-message">
          {text(commit?.message)?.split("\n")[0] ??
            "Ask about the repository to load a live commit."}
        </p>
        <span className="commit-sha">{text(commit?.sha)?.slice(0, 7) ?? "Not checked yet"}</span>
      </div>
      <div className="context-section context-counts">
        <div>
          <span className="context-label">OPEN ISSUES SHOWN</span>
          <strong>{issueCount ?? "—"}</strong>
        </div>
        <div>
          <span className="context-label">OPEN PRS SHOWN</span>
          <strong>{pullCount ?? "—"}</strong>
        </div>
      </div>
      <div className="context-section workflow-section">
        <span className="context-label">RECENT WORKFLOW</span>
        <strong className={conclusion === "failure" ? "workflow-failure" : ""}>
          {conclusion ?? (runs ? "No recent runs" : "Not checked yet")}
        </strong>
        {latestRun && <span>{text(latestRun.workflowName) ?? "Workflow"}</span>}
      </div>
      <div className="panel-foot">Values appear here only after a live MCP tool response.</div>
    </aside>
  );
}

export function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<RepositoryContext>({});
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, loading, error]);

  async function ask(question: string, retry = false) {
    const content = question.trim();
    if (!content || loading) return;
    const updated: Turn[] = retry ? turns : [...turns, { role: "user", content }];
    if (!retry) setTurns(updated);
    setDraft("");
    setError(null);
    setLoading(true);
    try {
      if (apiBase === undefined) throw new Error("Demo backend is not configured.");
      const recent = updated.slice(-7).map(({ role, content }) => ({ role, content }));
      while (recent.reduce((length, message) => length + message.content.length, 0) > 2400) {
        recent.splice(0, 2);
      }
      const response = await fetch(`${apiBase}/api/demo/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: recent }),
      });
      if (!response.ok) throw new Error("The live answer is unavailable right now.");
      const data: unknown = await response.json();
      const result = asObject(data);
      const activity = activityFromResponse(result?.activity);
      if (!result || typeof result.message !== "string" || !result.message.trim() || !activity) {
        throw new Error("The live answer is unavailable right now.");
      }
      setTurns([...updated, { role: "assistant", content: result.message, activity }]);
      setContext((current) => contextFromActivity(current, activity));
    } catch {
      setError("The live answer is unavailable right now.");
    } finally {
      setLoading(false);
    }
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

  const retryQuestion = turns.at(-1)?.role === "user" ? turns.at(-1)?.content : undefined;
  const hasLiveData = Object.values(context).some(Boolean);

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
              <span className="eyebrow">CONVERSATION / 01</span>
              <h1>Ask the repository.</h1>
            </div>
            <span className="conversation-note">Live answers through MCP</span>
          </div>
          <div className="conversation-scroll" aria-live="polite">
            <div className="welcome-message">
              <span className="speaker">VOXOPS</span>
              <p>
                I can read the public VoxOps repository and turn its current state into a clear
                update. What would you like to know?
              </p>
            </div>
            {turns.map((turn, index) => (
              <article className={`message message-${turn.role}`} key={index}>
                <span className="speaker">{turn.role === "user" ? "YOU" : "VOXOPS"}</span>
                <p>{turn.content}</p>
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
                <span>{error}</span>
                {retryQuestion && (
                  <button type="button" onClick={() => void ask(retryQuestion, true)}>
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
                    <span aria-hidden="true">↗</span>
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
        <ContextPanel context={context} hasLiveData={hasLiveData} />
      </main>
      <footer className="app-footer">
        <span>Simulated Alexa+ experience powered by the live VoxOps MCP server.</span>
        <span>NO ACCOUNT LINKING · NO WRITE ACTIONS</span>
      </footer>
    </div>
  );
}
