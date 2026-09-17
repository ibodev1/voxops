import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubRepositoryError, type GitHubRepositoryClient } from "@voxops/github";
import { createApp } from "./app.js";

const getRepositoryStatus = vi.fn<GitHubRepositoryClient["getRepositoryStatus"]>();
const app = createApp({ getRepositoryStatus });
const request = (path: string) => app.request(path, { headers: { host: "127.0.0.1" } });

const status = {
  owner: "octocat",
  name: "Hello-World",
  fullName: "octocat/Hello-World",
  description: null,
  defaultBranch: "main",
  private: false,
  archived: false,
  url: "https://github.com/octocat/Hello-World",
  pushedAt: "2026-09-16T12:00:00Z",
  latestCommit: {
    sha: "0123456789abcdef0123456789abcdef01234567",
    message: "Initial commit",
    authorName: "Example Author",
    committedAt: "2026-09-16T11:59:00Z",
  },
};

beforeEach(() => vi.resetAllMocks());

describe("HTTP API", () => {
  it("responds to health checks", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns repository status as JSON", async () => {
    vi.mocked(getRepositoryStatus).mockResolvedValue(status);

    const response = await request("/api/repositories/octocat/Hello-World/status");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(status);
    expect(getRepositoryStatus).toHaveBeenCalledWith({ owner: "octocat", repo: "Hello-World" });
  });

  it.each(["/api/repositories/bad!/Hello-World/status", "/api/repositories/octocat/bad!/status"])(
    "rejects an invalid repository reference: %s",
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_repository_ref" });
      expect(getRepositoryStatus).not.toHaveBeenCalled();
    },
  );

  it("maps a missing repository to 404", async () => {
    vi.mocked(getRepositoryStatus).mockRejectedValue(new GitHubRepositoryError("not_found"));

    const response = await request("/api/repositories/octocat/missing/status");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "repository_not_found" });
  });

  it("maps rate limiting to 503", async () => {
    vi.mocked(getRepositoryStatus).mockRejectedValue(new GitHubRepositoryError("rate_limited"));

    const response = await request("/api/repositories/octocat/Hello-World/status");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "github_rate_limited" });
  });

  it("maps unexpected GitHub failures to 502", async () => {
    vi.mocked(getRepositoryStatus).mockRejectedValue(new GitHubRepositoryError("upstream"));

    const response = await request("/api/repositories/octocat/Hello-World/status");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "github_upstream_error" });
  });

  it("returns authorized private repository status", async () => {
    getRepositoryStatus.mockResolvedValue({ ...status, private: true });
    const response = await request("/api/repositories/octocat/Hello-World/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...status, private: true });
  });

  it("maps server-side GitHub authentication failures to a sanitized 503", async () => {
    const error = new GitHubRepositoryError("authentication");
    error.message = "secret-token secret-jwt mock-private-key /sensitive/key.pem";
    getRepositoryStatus.mockRejectedValue(error);
    const response = await request("/api/repositories/octocat/Hello-World/status");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "github_authentication_failed" });
  });

  it("does not expose unexpected error details", async () => {
    getRepositoryStatus.mockRejectedValue(new Error("secret-token /sensitive/key.pem"));
    const response = await request("/api/repositories/octocat/Hello-World/status");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
