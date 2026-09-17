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
  auth: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({ createAppAuth: () => octokit.auth }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest;
    constructor(options: { auth?: { installationId?: number }; authStrategy?: object }) {
      this.rest = options.auth?.installationId
        ? { repos: { get: octokit.authenticatedGet, getCommit: octokit.authenticatedGetCommit } }
        : options.authStrategy
          ? { apps: { getRepoInstallation: octokit.getRepoInstallation } }
          : { repos: octokit };
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
