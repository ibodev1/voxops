import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { GitHubAppConfig } from "./config.js";
import {
  RepositoryRefSchema,
  RepositoryStatusSchema,
  type RepositoryRef,
  type RepositoryStatus,
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

  return {
    async getRepositoryStatus(input: RepositoryRef): Promise<RepositoryStatus> {
      const ref = RepositoryRefSchema.parse(input);
      if (!appOctokit || !appAuth) return readRepositoryStatus(anonymous, ref, false);

      const installation = await appOctokit.rest.apps
        .getRepoInstallation(ref)
        .catch((error: unknown) => {
          // An absent installation also covers private repositories this app cannot see.
          if (error instanceof Error && "status" in error && error.status === 404) return undefined;
          throw mapGitHubError(error, true);
        });
      if (!installation) return readRepositoryStatus(anonymous, ref, false);

      try {
        const authenticated = await appAuth({
          type: "installation",
          installationId: installation.data.id,
          factory: (options) =>
            new Octokit({ ...clientOptions, authStrategy: createAppAuth, auth: options }),
        });
        return await readRepositoryStatus(authenticated, ref, true);
      } catch (error) {
        if (error instanceof GitHubRepositoryError) throw error;
        throw mapGitHubError(error, true);
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
