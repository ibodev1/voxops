import { McpServer } from "@modelcontextprotocol/server";
import {
  RepositoryRefSchema,
  RepositoryStatusSchema,
  type RepositoryStatus,
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
        const message =
          error instanceof GitHubRepositoryError
            ? {
                not_found: "Repository not found or inaccessible.",
                authentication: "GitHub App authentication failed.",
                rate_limited: "GitHub rate limit reached. Try again later.",
                upstream: "GitHub is unavailable.",
              }[error.kind]
            : "Repository status is unavailable.";
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );

  return server;
}
