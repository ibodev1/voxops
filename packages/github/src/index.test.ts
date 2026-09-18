import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubRepositoryClient } from "./index.js";

const github = vi.hoisted(() => ({
  get: vi.fn(),
  getCommit: vi.fn(),
  listIssues: vi.fn(),
  listPulls: vi.fn(),
  listRuns: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      repos: { get: github.get, getCommit: github.getCommit },
      issues: { listForRepo: github.listIssues },
      pulls: { list: github.listPulls },
      actions: { listWorkflowRunsForRepo: github.listRuns },
    };
  },
}));

const ref = { owner: "octocat", repo: "Hello-World" };
const metadata = {
  owner: { login: ref.owner },
  name: ref.repo,
  full_name: "octocat/Hello-World",
  description: null,
  default_branch: "main",
  private: false,
  archived: false,
  html_url: "https://github.com/octocat/Hello-World",
  pushed_at: null,
};
const commit = {
  sha: "a".repeat(40),
  commit: { message: "Initial commit", author: null, committer: null },
};
const issue = {
  number: 4,
  title: "Fix CI",
  state: "open",
  html_url: "https://github.com/octocat/Hello-World/issues/4",
  user: { login: "octocat" },
  labels: ["bug"],
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};
const pull = {
  number: 5,
  title: "Improve CI",
  state: "open",
  html_url: "https://github.com/octocat/Hello-World/pull/5",
  user: { login: "octocat" },
  draft: false,
  head: { ref: "fix" },
  base: { ref: "main" },
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};
const run = {
  id: 6,
  name: "CI",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: "a".repeat(40),
  html_url: "https://github.com/octocat/Hello-World/actions/runs/6",
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  github.get.mockResolvedValue({ data: metadata });
  github.getCommit.mockResolvedValue({ data: commit });
  github.listIssues.mockResolvedValue({ data: [issue, { ...issue, pull_request: {} }] });
  github.listPulls.mockResolvedValue({ data: [pull] });
  github.listRuns.mockResolvedValue({ data: { workflow_runs: [run] } });
});

describe("anonymous public repository policy", () => {
  it("requires a valid nonempty allowlist at startup", () => {
    for (const value of ["", "octocat", "octocat/../bad", "octocat/repo/extra"]) {
      expect(() => createGitHubRepositoryClient(value)).toThrow(/VOXOPS_PUBLIC_REPOSITORIES/);
    }
  });

  it("accepts a configured public repository and maps all four reads", async () => {
    const client = createGitHubRepositoryClient(
      "octocat/Hello-World, modelcontextprotocol/typescript-sdk",
    );
    expect(await client.getRepositoryStatus(ref)).toMatchObject({
      fullName: "octocat/Hello-World",
      private: false,
      latestCommit: { sha: commit.sha },
    });
    expect((await client.listOpenIssues(ref)).issues).toMatchObject([{ number: 4 }]);
    expect((await client.listPullRequests(ref)).pullRequests).toMatchObject([{ number: 5 }]);
    expect((await client.listWorkflowRuns(ref)).workflowRuns).toMatchObject([{ id: 6 }]);
    expect(github.get).toHaveBeenCalledTimes(4);
    expect(github.listIssues).toHaveBeenCalledWith({ ...ref, state: "open", per_page: 100 });
  });

  it.each([
    "getRepositoryStatus",
    "listOpenIssues",
    "listPullRequests",
    "listWorkflowRuns",
  ] as const)("denies nonallowlisted calls before GitHub through %s", async (operation) => {
    const client = createGitHubRepositoryClient("octocat/other");
    await expect(client[operation](ref)).rejects.toMatchObject({ kind: "not_allowed" });
    expect(github.get).not.toHaveBeenCalled();
  });

  it.each([
    "getRepositoryStatus",
    "listOpenIssues",
    "listPullRequests",
    "listWorkflowRuns",
  ] as const)("rejects a private response before secondary reads through %s", async (operation) => {
    github.get.mockResolvedValue({ data: { ...metadata, private: true } });
    const client = createGitHubRepositoryClient("octocat/Hello-World");
    await expect(client[operation](ref)).rejects.toMatchObject({ kind: "not_found" });
    expect(github.getCommit).not.toHaveBeenCalled();
    expect(github.listIssues).not.toHaveBeenCalled();
    expect(github.listPulls).not.toHaveBeenCalled();
    expect(github.listRuns).not.toHaveBeenCalled();
  });

  it("validates input before GitHub access and matches allowlist case insensitively", async () => {
    const client = createGitHubRepositoryClient("OCTOCAT/hello-world");
    await expect(
      client.getRepositoryStatus({ owner: "bad/owner", repo: ref.repo }),
    ).rejects.toThrow();
    expect(github.get).not.toHaveBeenCalled();
    await expect(client.getRepositoryStatus(ref)).resolves.toMatchObject({ private: false });
  });

  it("sanitizes rate limits and upstream failures", async () => {
    const client = createGitHubRepositoryClient("octocat/Hello-World");
    github.get.mockRejectedValue(
      Object.assign(new Error("API rate limit exceeded: token"), { status: 403 }),
    );
    await expect(client.getRepositoryStatus(ref)).rejects.toMatchObject({
      kind: "rate_limited",
      message: "rate_limited",
    });
    github.get.mockResolvedValue({ data: metadata });
    github.listRuns.mockRejectedValue(new Error("sensitive upstream detail"));
    await expect(client.listWorkflowRuns(ref)).rejects.toMatchObject({
      kind: "upstream",
      message: "upstream",
    });
  });
});
