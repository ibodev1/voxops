import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StrategyOptions } from "@octokit/auth-app";
import type { Octokit } from "@octokit/rest";
import { createGitHubRepositoryClient } from "./index.js";

const octokit = vi.hoisted(() => ({
  get: vi.fn(),
  getCommit: vi.fn(),
  getRepoInstallation: vi.fn(),
  authenticatedGet: vi.fn(),
  authenticatedGetCommit: vi.fn(),
  listIssues: vi.fn(),
  listPulls: vi.fn(),
  listRuns: vi.fn(),
  authenticatedListIssues: vi.fn(),
  authenticatedListPulls: vi.fn(),
  authenticatedListRuns: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({ createAppAuth: () => octokit.auth }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest;
    constructor(options: { auth?: { installationId?: number }; authStrategy?: object }) {
      this.rest = options.auth?.installationId
        ? {
            repos: { get: octokit.authenticatedGet, getCommit: octokit.authenticatedGetCommit },
            issues: { listForRepo: octokit.authenticatedListIssues },
            pulls: { list: octokit.authenticatedListPulls },
            actions: { listWorkflowRunsForRepo: octokit.authenticatedListRuns },
          }
        : options.authStrategy
          ? { apps: { getRepoInstallation: octokit.getRepoInstallation } }
          : {
              repos: octokit,
              issues: { listForRepo: octokit.listIssues },
              pulls: { list: octokit.listPulls },
              actions: { listWorkflowRunsForRepo: octokit.listRuns },
            };
    }
  },
}));

const { getRepositoryStatus } = createGitHubRepositoryClient();
const appConfig = { appId: "123", privateKey: "mock-private-key" };

const repository = {
  owner: { login: "octocat" },
  name: "Hello-World",
  full_name: "octocat/Hello-World",
  description: "A sample repository",
  default_branch: "main",
  private: false,
  archived: false,
  html_url: "https://github.com/octocat/Hello-World",
  pushed_at: "2026-09-16T12:00:00Z",
};

const commit = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  commit: {
    message: "Update README\n\nMore detail",
    author: { name: "Example Author" },
    committer: { date: "2026-09-16T11:59:00Z" },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  octokit.get.mockResolvedValue({ data: repository });
  octokit.getCommit.mockResolvedValue({ data: commit });
  octokit.getRepoInstallation.mockResolvedValue({ data: { id: 42 } });
  octokit.authenticatedGet.mockResolvedValue({ data: { ...repository, private: true } });
  octokit.authenticatedGetCommit.mockResolvedValue({ data: commit });
  octokit.listIssues.mockResolvedValue({ data: [] });
  octokit.listPulls.mockResolvedValue({ data: [] });
  octokit.listRuns.mockResolvedValue({ data: { workflow_runs: [] } });
  octokit.authenticatedListIssues.mockResolvedValue({ data: [] });
  octokit.authenticatedListPulls.mockResolvedValue({ data: [] });
  octokit.authenticatedListRuns.mockResolvedValue({ data: { workflow_runs: [] } });
  octokit.auth.mockImplementation(
    async (options: { factory: (config: StrategyOptions) => Octokit }) =>
      options.factory({ ...appConfig, installationId: 42 }),
  );
});

describe("GitHub App repository access", () => {
  it("hides loss of installation access between metadata and commit requests", async () => {
    octokit.authenticatedGetCommit.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    await expect(
      createGitHubRepositoryClient(appConfig).getRepositoryStatus({
        owner: "octocat",
        repo: "Hello-World",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
  it("resolves the repository installation and uses its client for private metadata and commits", async () => {
    const client = createGitHubRepositoryClient(appConfig);
    const ref = { owner: "octocat", repo: "Hello-World" };
    const status = await client.getRepositoryStatus(ref);

    expect(octokit.getRepoInstallation).toHaveBeenCalledWith(ref);
    expect(octokit.auth).toHaveBeenCalledWith(
      expect.objectContaining({ type: "installation", installationId: 42 }),
    );
    expect(octokit.authenticatedGet).toHaveBeenCalledWith(ref);
    expect(octokit.authenticatedGetCommit).toHaveBeenCalledWith({ ...ref, ref: "main" });
    expect(status.private).toBe(true);
    expect(status.latestCommit.sha).toBe(commit.sha);
    expect(octokit.get).not.toHaveBeenCalled();
  });

  it("still reads a public repository when the app is not installed on it", async () => {
    octokit.getRepoInstallation.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const status = await createGitHubRepositoryClient(appConfig).getRepositoryStatus({
      owner: "octocat",
      repo: "Hello-World",
    });
    expect(status.private).toBe(false);
    expect(octokit.auth).not.toHaveBeenCalled();
  });

  it("does not distinguish a private inaccessible repository from a missing repository", async () => {
    const missing = Object.assign(new Error("Not Found"), { status: 404 });
    octokit.getRepoInstallation.mockRejectedValue(missing);
    octokit.get.mockRejectedValue(missing);
    await expect(
      createGitHubRepositoryClient(appConfig).getRepositoryStatus({
        owner: "octocat",
        repo: "missing",
      }),
    ).rejects.toMatchObject({ kind: "not_found", message: "not_found" });
  });

  it("hides installation permission failures", async () => {
    octokit.authenticatedGet.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );
    await expect(
      createGitHubRepositoryClient(appConfig).getRepositoryStatus({
        owner: "octocat",
        repo: "Hello-World",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it.each(["discovery", "installation"])(
    "sanitizes authentication failure during %s",
    async (stage) => {
      const error = Object.assign(new Error("sensitive-token private-key /secret/path"), {
        status: 401,
      });
      if (stage === "discovery") octokit.getRepoInstallation.mockRejectedValue(error);
      else octokit.authenticatedGet.mockRejectedValue(error);
      await expect(
        createGitHubRepositoryClient(appConfig).getRepositoryStatus({
          owner: "octocat",
          repo: "Hello-World",
        }),
      ).rejects.toMatchObject({ kind: "authentication", message: "authentication" });
    },
  );

  it("keeps rate limiting distinct from access denial", async () => {
    octokit.getRepoInstallation.mockRejectedValue(
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
    );
    await expect(
      createGitHubRepositoryClient(appConfig).getRepositoryStatus({
        owner: "octocat",
        repo: "Hello-World",
      }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("validates input before resolving an installation", async () => {
    await expect(
      createGitHubRepositoryClient(appConfig).getRepositoryStatus({
        owner: "bad/owner",
        repo: "Hello-World",
      }),
    ).rejects.toThrow();
    expect(octokit.getRepoInstallation).not.toHaveBeenCalled();
  });
});

describe("getRepositoryStatus", () => {
  it("maps repository metadata and the head commit of the default branch", async () => {
    const status = await getRepositoryStatus({ owner: "octocat", repo: "Hello-World" });

    expect(octokit.get).toHaveBeenCalledWith({ owner: "octocat", repo: "Hello-World" });
    expect(octokit.getCommit).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "Hello-World",
      ref: "main",
    });
    expect(status).toEqual({
      owner: "octocat",
      name: "Hello-World",
      fullName: "octocat/Hello-World",
      description: "A sample repository",
      defaultBranch: "main",
      private: false,
      archived: false,
      url: "https://github.com/octocat/Hello-World",
      pushedAt: "2026-09-16T12:00:00Z",
      latestCommit: {
        sha: commit.sha,
        message: "Update README\n\nMore detail",
        authorName: "Example Author",
        committedAt: "2026-09-16T11:59:00Z",
      },
    });
  });

  it("preserves nullable GitHub fields", async () => {
    octokit.get.mockResolvedValue({
      data: { ...repository, description: null, pushed_at: null },
    });
    octokit.getCommit.mockResolvedValue({
      data: { ...commit, commit: { message: "Initial", author: null, committer: null } },
    });

    const status = await getRepositoryStatus({ owner: "octocat", repo: "Hello-World" });

    expect(status.description).toBeNull();
    expect(status.pushedAt).toBeNull();
    expect(status.latestCommit.authorName).toBeNull();
    expect(status.latestCommit.committedAt).toBeNull();
  });

  it("rejects invalid repository input before calling GitHub", async () => {
    await expect(
      getRepositoryStatus({ owner: "bad/owner", repo: "Hello-World" }),
    ).rejects.toThrow();
    expect(octokit.get).not.toHaveBeenCalled();
  });

  it("maps a missing repository to a typed error", async () => {
    octokit.get.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    await expect(getRepositoryStatus({ owner: "octocat", repo: "missing" })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("does not expose private repository metadata", async () => {
    octokit.get.mockResolvedValue({ data: { ...repository, private: true } });

    await expect(
      getRepositoryStatus({ owner: "octocat", repo: "Hello-World" }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(octokit.getCommit).not.toHaveBeenCalled();
  });

  it("maps GitHub rate limits", async () => {
    octokit.get.mockRejectedValue(
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
    );

    await expect(
      getRepositoryStatus({ owner: "octocat", repo: "Hello-World" }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("maps unexpected GitHub errors without exposing them", async () => {
    octokit.getCommit.mockRejectedValue(new Error("network details"));

    await expect(
      getRepositoryStatus({ owner: "octocat", repo: "Hello-World" }),
    ).rejects.toMatchObject({
      kind: "upstream",
      message: "upstream",
    });
  });

  it("rejects malformed mapped GitHub data", async () => {
    octokit.getCommit.mockResolvedValue({ data: { ...commit, sha: "not-a-sha" } });

    await expect(
      getRepositoryStatus({ owner: "octocat", repo: "Hello-World" }),
    ).rejects.toMatchObject({ kind: "upstream" });
  });
});

const ref = { owner: "octocat", repo: "Hello-World" };
const issue = {
  number: 12,
  title: "Fix the build",
  state: "open",
  html_url: "https://github.com/octocat/Hello-World/issues/12",
  user: { login: "octocat" },
  labels: ["urgent", { name: "bug" }, { name: null }],
  created_at: "2026-09-16T10:00:00Z",
  updated_at: "2026-09-16T11:00:00Z",
};
const pull = {
  number: 7,
  title: "Improve CI",
  state: "open",
  html_url: "https://github.com/octocat/Hello-World/pull/7",
  user: { login: "contributor" },
  draft: true,
  head: { ref: "ci-fix" },
  base: { ref: "main" },
  created_at: "2026-09-16T10:00:00Z",
  updated_at: "2026-09-16T11:00:00Z",
};
const run = {
  id: 42,
  name: "CI",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: "a".repeat(40),
  html_url: "https://github.com/octocat/Hello-World/actions/runs/42",
  created_at: "2026-09-16T10:00:00Z",
  updated_at: "2026-09-16T11:00:00Z",
};

describe("read-only developer context", () => {
  it("maps open issues, filters pull requests, and handles label shapes", async () => {
    octokit.listIssues.mockResolvedValue({
      data: [{ ...issue, pull_request: { url: "private" } }, issue, { ...issue, number: 13 }],
    });
    const result = await createGitHubRepositoryClient().listOpenIssues({ ...ref, limit: 1 });
    expect(octokit.listIssues).toHaveBeenCalledWith({ ...ref, state: "open", per_page: 100 });
    expect(result).toEqual({
      repository: "octocat/Hello-World",
      issues: [
        {
          number: 12,
          title: "Fix the build",
          state: "open",
          url: issue.html_url,
          authorLogin: "octocat",
          labels: ["urgent", "bug"],
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        },
      ],
    });
  });

  it("returns an empty issue list", async () => {
    expect(await createGitHubRepositoryClient().listOpenIssues(ref)).toEqual({
      repository: "octocat/Hello-World",
      issues: [],
    });
  });

  it("maps open pull requests, drafts, and branches", async () => {
    octokit.listPulls.mockResolvedValue({ data: [pull, { ...pull, number: 8, state: "closed" }] });
    const result = await createGitHubRepositoryClient().listPullRequests({ ...ref, limit: 5 });
    expect(octokit.listPulls).toHaveBeenCalledWith({ ...ref, state: "open", per_page: 5 });
    expect(result.pullRequests).toEqual([
      {
        number: 7,
        title: "Improve CI",
        url: pull.html_url,
        authorLogin: "contributor",
        draft: true,
        sourceBranch: "ci-fix",
        targetBranch: "main",
        createdAt: pull.created_at,
        updatedAt: pull.updated_at,
      },
    ]);
  });

  it("returns an empty pull request list", async () => {
    expect(await createGitHubRepositoryClient().listPullRequests(ref)).toEqual({
      repository: "octocat/Hello-World",
      pullRequests: [],
    });
  });

  it("maps successful, failed, and in-progress workflow runs", async () => {
    octokit.listRuns.mockResolvedValue({
      data: {
        workflow_runs: [
          run,
          { ...run, id: 43, conclusion: "failure" },
          { ...run, id: 44, status: "in_progress", conclusion: null, head_branch: null },
        ],
      },
    });
    const result = await createGitHubRepositoryClient().listWorkflowRuns(ref);
    expect(octokit.listRuns).toHaveBeenCalledWith({ ...ref, per_page: 10 });
    expect(
      result.workflowRuns.map(({ id, status, conclusion, branch }) => ({
        id,
        status,
        conclusion,
        branch,
      })),
    ).toEqual([
      { id: 42, status: "completed", conclusion: "success", branch: "main" },
      { id: 43, status: "completed", conclusion: "failure", branch: "main" },
      { id: 44, status: "in_progress", conclusion: null, branch: null },
    ]);
    expect(result.workflowRuns[0]).toMatchObject({
      workflowName: "CI",
      event: "push",
      commitSha: "a".repeat(40),
      url: run.html_url,
    });
  });

  it("returns an empty workflow run list", async () => {
    expect(await createGitHubRepositoryClient().listWorkflowRuns(ref)).toEqual({
      repository: "octocat/Hello-World",
      workflowRuns: [],
    });
  });

  it.each(["listOpenIssues", "listPullRequests", "listWorkflowRuns"] as const)(
    "rejects invalid limits before calling GitHub through %s",
    async (operation) => {
      for (const limit of [0, 26, 1.5]) {
        await expect(
          createGitHubRepositoryClient()[operation]({ ...ref, limit }),
        ).rejects.toThrow();
      }
      expect(octokit.getRepoInstallation).not.toHaveBeenCalled();
      expect(octokit.listIssues).not.toHaveBeenCalled();
      expect(octokit.listPulls).not.toHaveBeenCalled();
      expect(octokit.listRuns).not.toHaveBeenCalled();
    },
  );

  it("uses the repository installation for private list operations", async () => {
    const client = createGitHubRepositoryClient(appConfig);
    await client.listOpenIssues(ref);
    await client.listPullRequests(ref);
    await client.listWorkflowRuns(ref);
    expect(octokit.getRepoInstallation).toHaveBeenCalledTimes(3);
    expect(octokit.authenticatedListIssues).toHaveBeenCalledOnce();
    expect(octokit.authenticatedListPulls).toHaveBeenCalledOnce();
    expect(octokit.authenticatedListRuns).toHaveBeenCalledOnce();
    expect(octokit.listIssues).not.toHaveBeenCalled();
  });

  it("sanitizes unavailable Actions and malformed upstream data", async () => {
    octokit.listRuns.mockRejectedValue(Object.assign(new Error("secret-token"), { status: 404 }));
    await expect(createGitHubRepositoryClient().listWorkflowRuns(ref)).rejects.toMatchObject({
      kind: "not_found",
      message: "not_found",
    });
    octokit.listRuns.mockResolvedValue({
      data: { workflow_runs: [{ ...run, head_sha: "invalid" }] },
    });
    await expect(createGitHubRepositoryClient().listWorkflowRuns(ref)).rejects.toMatchObject({
      kind: "upstream",
      message: "upstream",
    });
  });
});
