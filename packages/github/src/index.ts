import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { GitHubAppConfig } from "./config.js";
import {
  RepositoryRefSchema,
  RepositoryStatusSchema,
  RepositoryListInputSchema,
  OpenIssuesResultSchema,
  PullRequestsResultSchema,
  WorkflowRunsResultSchema,
  type RepositoryRef,
  type RepositoryStatus,
  type RepositoryListInput,
  type OpenIssuesResult,
  type PullRequestsResult,
  type WorkflowRunsResult,
} from "@voxops/contracts";

export {
  loadGitHubAppConfig,
  GitHubAppConfigurationError,
  type GitHubAppConfig,
} from "./config.js";

export type GitHubRepositoryErrorKind =
  | "not_found"
  | "authentication"
  | "rate_limited"
  | "upstream";

export interface GitHubRepositoryClient {
  getRepositoryStatus(input: RepositoryRef): Promise<RepositoryStatus>;
  listOpenIssues(input: RepositoryListInput): Promise<OpenIssuesResult>;
  listPullRequests(input: RepositoryListInput): Promise<PullRequestsResult>;
  listWorkflowRuns(input: RepositoryListInput): Promise<WorkflowRunsResult>;
}

// SDK diagnostics can contain request context; expose only our sanitized errors.
const clientOptions = {
  userAgent: "VoxOps",
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

export function createGitHubRepositoryClient(config?: GitHubAppConfig): GitHubRepositoryClient {
  const anonymous = new Octokit(clientOptions);
  const appAuth = config ? createAppAuth({ ...config, log: clientOptions.log }) : undefined;
  const appOctokit = appAuth
    ? new Octokit({ ...clientOptions, authStrategy: () => appAuth })
    : undefined;

  async function repositoryClient(
    ref: RepositoryRef,
  ): Promise<{ octokit: Octokit; allowPrivate: boolean }> {
    if (!appOctokit || !appAuth) return { octokit: anonymous, allowPrivate: false };
    const installation = await appOctokit.rest.apps
      .getRepoInstallation(ref)
      .catch((error: unknown) => {
        // An absent installation also covers private repositories this app cannot see.
        if (error instanceof Error && "status" in error && error.status === 404) return undefined;
        throw mapGitHubError(error, true);
      });
    if (!installation) return { octokit: anonymous, allowPrivate: false };

    try {
      const octokit = await appAuth({
        type: "installation",
        installationId: installation.data.id,
        factory: (options) =>
          new Octokit({ ...clientOptions, authStrategy: createAppAuth, auth: options }),
      });
      return { octokit, allowPrivate: true };
    } catch (error) {
      throw mapGitHubError(error, true);
    }
  }

  return {
    async getRepositoryStatus(input: RepositoryRef): Promise<RepositoryStatus> {
      const ref = RepositoryRefSchema.parse(input);
      const { octokit, allowPrivate } = await repositoryClient(ref);
      return readRepositoryStatus(octokit, ref, allowPrivate);
    },
    async listOpenIssues(input: RepositoryListInput): Promise<OpenIssuesResult> {
      const { owner, repo, limit } = RepositoryListInputSchema.parse(input);
      const { octokit } = await repositoryClient({ owner, repo });
      const { data } = await octokit.rest.issues
        .listForRepo({ owner, repo, state: "open", per_page: 100 })
        .catch((error: unknown) => {
          throw mapGitHubError(error, true);
        });
      try {
        return OpenIssuesResultSchema.parse({
          repository: `${owner}/${repo}`,
          issues: data
            .filter((issue) => !issue.pull_request && issue.state === "open")
            .slice(0, limit)
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: "open",
              url: issue.html_url,
              authorLogin: issue.user?.login ?? null,
              labels: issue.labels.flatMap((label) =>
                typeof label === "string" ? [label] : label.name ? [label.name] : [],
              ),
              createdAt: issue.created_at,
              updatedAt: issue.updated_at,
            })),
        });
      } catch {
        throw new GitHubRepositoryError("upstream");
      }
    },
    async listPullRequests(input: RepositoryListInput): Promise<PullRequestsResult> {
      const { owner, repo, limit } = RepositoryListInputSchema.parse(input);
      const { octokit } = await repositoryClient({ owner, repo });
      const { data } = await octokit.rest.pulls
        .list({ owner, repo, state: "open", per_page: limit })
        .catch((error: unknown) => {
          throw mapGitHubError(error, true);
        });
      try {
        return PullRequestsResultSchema.parse({
          repository: `${owner}/${repo}`,
          pullRequests: data
            .filter((pull) => pull.state === "open")
            .slice(0, limit)
            .map((pull) => ({
              number: pull.number,
              title: pull.title,
              url: pull.html_url,
              authorLogin: pull.user?.login ?? null,
              draft: pull.draft ?? false,
              sourceBranch: pull.head.ref,
              targetBranch: pull.base.ref,
              createdAt: pull.created_at,
              updatedAt: pull.updated_at,
            })),
        });
      } catch {
        throw new GitHubRepositoryError("upstream");
      }
    },
    async listWorkflowRuns(input: RepositoryListInput): Promise<WorkflowRunsResult> {
      const { owner, repo, limit } = RepositoryListInputSchema.parse(input);
      const { octokit } = await repositoryClient({ owner, repo });
      const { data } = await octokit.rest.actions
        .listWorkflowRunsForRepo({ owner, repo, per_page: limit })
        .catch((error: unknown) => {
          throw mapGitHubError(error, true);
        });
      try {
        return WorkflowRunsResultSchema.parse({
          repository: `${owner}/${repo}`,
          workflowRuns: data.workflow_runs.slice(0, limit).map((run) => ({
            id: run.id,
            workflowName: run.name ?? "Unnamed workflow",
            event: run.event,
            status: run.status ?? "unknown",
            conclusion: run.conclusion,
            branch: run.head_branch,
            commitSha: run.head_sha,
            url: run.html_url,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
          })),
        });
      } catch {
        throw new GitHubRepositoryError("upstream");
      }
    },
  };
}

export class GitHubRepositoryError extends Error {
  constructor(public readonly kind: GitHubRepositoryErrorKind) {
    super(kind);
    this.name = "GitHubRepositoryError";
  }
}

function mapGitHubError(error: unknown, repositoryLookup: boolean): GitHubRepositoryError {
  const status = error instanceof Error && "status" in error ? error.status : undefined;

  if (repositoryLookup && status === 404) {
    return new GitHubRepositoryError("not_found");
  }

  if (
    status === 429 ||
    (status === 403 && error instanceof Error && /rate limit/i.test(error.message))
  ) {
    return new GitHubRepositoryError("rate_limited");
  }

  if (status === 401) return new GitHubRepositoryError("authentication");
  if (status === 403) return new GitHubRepositoryError("not_found");

  return new GitHubRepositoryError("upstream");
}

async function readRepositoryStatus(
  octokit: Octokit,
  { owner, repo }: RepositoryRef,
  allowPrivate: boolean,
): Promise<RepositoryStatus> {
  const { data: repository } = await octokit.rest.repos
    .get({ owner, repo })
    .catch((error: unknown) => {
      throw mapGitHubError(error, true);
    });

  if (repository.private && !allowPrivate) {
    throw new GitHubRepositoryError("not_found");
  }

  const { data: commit } = await octokit.rest.repos
    .getCommit({ owner, repo, ref: repository.default_branch })
    .catch((error: unknown) => {
      // A missing private commit can also mean installation access was revoked.
      throw mapGitHubError(error, allowPrivate);
    });

  try {
    return RepositoryStatusSchema.parse({
      owner: repository.owner?.login,
      name: repository.name,
      fullName: repository.full_name,
      description: repository.description,
      defaultBranch: repository.default_branch,
      private: repository.private,
      archived: repository.archived,
      url: repository.html_url,
      pushedAt: repository.pushed_at,
      latestCommit: {
        sha: commit.sha,
        message: commit.commit.message,
        authorName: commit.commit.author?.name ?? null,
        committedAt: commit.commit.committer?.date ?? null,
      },
    });
  } catch {
    throw new GitHubRepositoryError("upstream");
  }
}
