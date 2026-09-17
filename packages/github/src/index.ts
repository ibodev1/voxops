import { Octokit } from "@octokit/rest";
import {
  RepositoryRefSchema,
  RepositoryStatusSchema,
  type RepositoryRef,
  type RepositoryStatus,
} from "@voxops/contracts";

const octokit = new Octokit({ userAgent: "VoxOps" });

export type GitHubRepositoryErrorKind = "not_found" | "rate_limited" | "upstream";

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

  return new GitHubRepositoryError("upstream");
}

export async function getRepositoryStatus(input: RepositoryRef): Promise<RepositoryStatus> {
  const { owner, repo } = RepositoryRefSchema.parse(input);

  const { data: repository } = await octokit.rest.repos
    .get({ owner, repo })
    .catch((error: unknown) => {
      throw mapGitHubError(error, true);
    });

  // The unauthenticated slice never returns private repository information.
  if (repository.private) {
    throw new GitHubRepositoryError("not_found");
  }

  const { data: commit } = await octokit.rest.repos
    .getCommit({ owner, repo, ref: repository.default_branch })
    .catch((error: unknown) => {
      throw mapGitHubError(error, false);
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
