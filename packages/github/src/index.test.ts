import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRepositoryStatus } from "./index.js";

const octokit = vi.hoisted(() => ({
  get: vi.fn(),
  getCommit: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = { repos: octokit };
  },
}));

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
