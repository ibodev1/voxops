import { McpServer } from "@modelcontextprotocol/server";
import {
  RepositoryRefSchema,
  RepositoryStatusSchema,
  RepositoryListInputSchema,
  OpenIssuesResultSchema,
  PullRequestsResultSchema,
  WorkflowRunsResultSchema,
  type RepositoryStatus,
  type OpenIssuesResult,
  type PullRequestsResult,
  type WorkflowRunsResult,
} from "@voxops/contracts";
import { GitHubRepositoryError, type GitHubRepositoryClient } from "@voxops/github";

export function formatRepositoryStatus(status: RepositoryStatus): string {
  return [
    `Repository ${status.fullName}`,
    `Default branch: ${status.defaultBranch}`,
    `Latest commit: ${status.latestCommit.sha.slice(0, 7)} — ${status.latestCommit.message.split("\n")[0]}`,
    `Last pushed: ${status.pushedAt ?? "unknown"}`,
    `Private: ${status.private ? "yes" : "no"}`,
    `Archived: ${status.archived ? "yes" : "no"}`,
  ].join("\n");
}

export function formatOpenIssues(result: OpenIssuesResult): string {
  if (!result.issues.length) return `No open issues found for ${result.repository}.`;
  return [
    `Open issues for ${result.repository}: ${result.issues.length}`,
    ...result.issues.map((issue) => `#${issue.number} ${issue.title}`),
  ].join("\n");
}

export function formatPullRequests(result: PullRequestsResult): string {
  if (!result.pullRequests.length) return `No open pull requests found for ${result.repository}.`;
  return [
    `Open pull requests for ${result.repository}: ${result.pullRequests.length}`,
    ...result.pullRequests.map(
      (pull) => `#${pull.number} ${pull.title}${pull.draft ? " (draft)" : ""}`,
    ),
  ].join("\n");
}

export function formatWorkflowRuns(result: WorkflowRunsResult): string {
  if (!result.workflowRuns.length) return `No recent workflow runs found for ${result.repository}.`;
  return [
    `Recent workflow runs for ${result.repository}:`,
    ...result.workflowRuns.map(
      (run) =>
        `${run.workflowName} — ${run.branch ?? "unknown branch"} — ${run.conclusion ?? run.status}`,
    ),
  ].join("\n");
}

function toolFailure(error: unknown, fallback = "Repository data is unavailable.") {
  const message =
    error instanceof GitHubRepositoryError
      ? {
          not_found: "Repository not found or inaccessible.",
          authentication: "GitHub App authentication failed.",
          rate_limited: "GitHub rate limit reached. Try again later.",
          upstream: "GitHub is unavailable.",
        }[error.kind]
      : fallback;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createMcpServer(github: GitHubRepositoryClient): McpServer {
  const server = new McpServer({ name: "voxops", version: "0.1.0" });

  server.registerTool(
    "get_repository_status",
    {
      title: "Get repository status",
      description:
        "Get metadata, default branch, latest commit, and repository state for one GitHub repository accessible to VoxOps.",
      inputSchema: RepositoryRefSchema,
      outputSchema: RepositoryStatusSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (ref) => {
      try {
        const status = await github.getRepositoryStatus(ref);
        return {
          content: [{ type: "text" as const, text: formatRepositoryStatus(status) }],
          structuredContent: status,
        };
      } catch (error) {
        return toolFailure(error, "Repository status is unavailable.");
      }
    },
  );

  server.registerTool(
    "list_open_issues",
    {
      title: "List open issues",
      description:
        "Use to find unresolved GitHub issues currently open in a repository. Excludes pull requests.",
      inputSchema: RepositoryListInputSchema,
      outputSchema: OpenIssuesResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const result = await github.listOpenIssues(input);
        return {
          content: [{ type: "text" as const, text: formatOpenIssues(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_pull_requests",
    {
      title: "List open pull requests",
      description:
        "Use to inspect currently open pull requests and their source and target branches.",
      inputSchema: RepositoryListInputSchema,
      outputSchema: PullRequestsResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const result = await github.listPullRequests(input);
        return {
          content: [{ type: "text" as const, text: formatPullRequests(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_workflow_runs",
    {
      title: "List recent workflow runs",
      description:
        "Use to inspect recent GitHub Actions, CI, build, test, or deployment workflow activity.",
      inputSchema: RepositoryListInputSchema,
      outputSchema: WorkflowRunsResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const result = await github.listWorkflowRuns(input);
        return {
          content: [{ type: "text" as const, text: formatWorkflowRuns(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}
