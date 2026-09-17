import {
  createGitHubRepositoryClient,
  GitHubRepositoryError,
  type GitHubRepositoryClient,
} from "@voxops/github";
import { createGitHubCredentialLoader } from "./config.js";

export function createConfiguredGitHubClient(
  environment: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): GitHubRepositoryClient {
  const loadCredentials = createGitHubCredentialLoader(environment, repositoryRoot);
  let pending: Promise<GitHubRepositoryClient> | undefined;
  function client(): Promise<GitHubRepositoryClient> {
    pending ??= loadCredentials()
      .then(createGitHubRepositoryClient)
      .catch(() => {
        pending = undefined;
        throw new GitHubRepositoryError("authentication");
      });
    return pending;
  }
  return {
    getRepositoryStatus: async (input) => (await client()).getRepositoryStatus(input),
    listOpenIssues: async (input) => (await client()).listOpenIssues(input),
    listPullRequests: async (input) => (await client()).listPullRequests(input),
    listWorkflowRuns: async (input) => (await client()).listWorkflowRuns(input),
  };
}
