import { Octokit } from "@octokit/rest";
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

export type GitHubRepositoryErrorKind = "not_found" | "not_allowed" | "rate_limited" | "upstream";

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

export function createGitHubRepositoryClient(allowlist: string): GitHubRepositoryClient {
  const anonymous = new Octokit(clientOptions);
  const allowed = new Set(
    allowlist.split(",").map((entry) => {
      const [owner, repo, extra] = entry.trim().split("/");
      if (extra !== undefined || !RepositoryRefSchema.safeParse({ owner, repo }).success) {
        throw new Error("VOXOPS_PUBLIC_REPOSITORIES must contain owner/repo entries");
      }
      return `${owner}/${repo}`.toLowerCase();
    }),
  );

  async function publicRepository(ref: RepositoryRef) {
    if (!allowed.has(`${ref.owner}/${ref.repo}`.toLowerCase())) {
      throw new GitHubRepositoryError("not_allowed");
    }
    const { data } = await anonymous.rest.repos.get(ref).catch((error: unknown) => {
      throw mapGitHubError(error);
    });
    if (data.private !== false || (data.visibility && data.visibility !== "public")) {
      throw new GitHubRepositoryError("not_found");
    }
    return data;
  }

  return {
    async getRepositoryStatus(input: RepositoryRef): Promise<RepositoryStatus> {
      const ref = RepositoryRefSchema.parse(input);
      const repository = await publicRepository(ref);
      return readRepositoryStatus(anonymous, ref, repository);
    },
    async listOpenIssues(input: RepositoryListInput): Promise<OpenIssuesResult> {
      const { owner, repo, limit } = RepositoryListInputSchema.parse(input);
      await publicRepository({ owner, repo });
      const { data } = await anonymous.rest.issues
        .listForRepo({ owner, repo, state: "open", per_page: 100 })
        .catch((error: unknown) => {
          throw mapGitHubError(error);
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
      await publicRepository({ owner, repo });
      const { data } = await anonymous.rest.pulls
        .list({ owner, repo, state: "open", per_page: limit })
        .catch((error: unknown) => {
          throw mapGitHubError(error);
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
      await publicRepository({ owner, repo });
      const { data } = await anonymous.rest.actions
        .listWorkflowRunsForRepo({ owner, repo, per_page: limit })
        .catch((error: unknown) => {
          throw mapGitHubError(error);
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

function mapGitHubError(error: unknown): GitHubRepositoryError {
  const status = error instanceof Error && "status" in error ? error.status : undefined;

  if (status === 404) {
    return new GitHubRepositoryError("not_found");
  }

  if (
    status === 429 ||
    (status === 403 && error instanceof Error && /rate limit/i.test(error.message))
  ) {
    return new GitHubRepositoryError("rate_limited");
  }

  if (status === 403) return new GitHubRepositoryError("not_found");

  return new GitHubRepositoryError("upstream");
}

async function readRepositoryStatus(
  octokit: Octokit,
  { owner, repo }: RepositoryRef,
  repository: Awaited<ReturnType<Octokit["rest"]["repos"]["get"]>>["data"],
): Promise<RepositoryStatus> {
  const { data: commit } = await octokit.rest.repos
    .getCommit({ owner, repo, ref: repository.default_branch })
    .catch((error: unknown) => {
      throw mapGitHubError(error);
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
