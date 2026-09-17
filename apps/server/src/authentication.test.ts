import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubRepositoryClient } from "@voxops/github";
import { createApp } from "./app.js";

afterEach(() => vi.unstubAllGlobals());

it("uses App authentication for discovery, installation authentication for reads, and reuses the SDK token cache", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  let tokenRequests = 0;
  let discoveries = 0;
  let repositoryReads = 0;

  // Intercept every request before it leaves the process; unexpected routes fail.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/repos/example/private/installation") {
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")?.startsWith("bearer ")).toBe(true);
        discoveries++;
        return Response.json({ id: 42 });
      }
      if (path === "/app/installations/42/access_tokens") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")?.startsWith("bearer ")).toBe(true);
        tokenRequests++;
        return Response.json(
          {
            token: "installation-test-token",
            expires_at: "2099-01-01T00:00:00Z",
            permissions: { metadata: "read", contents: "read" },
            repository_selection: "selected",
          },
          { status: 201 },
        );
      }
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization") === "token installation-test-token").toBe(true);
      if (path === "/repos/example/private") {
        repositoryReads++;
        return Response.json({
          owner: { login: "example" },
          name: "private",
          full_name: "example/private",
          description: null,
          default_branch: "main",
          private: true,
          archived: false,
          html_url: "https://github.com/example/private",
          pushed_at: "2026-09-17T00:00:00Z",
        });
      }
      if (path === "/repos/example/private/commits/main") {
        return Response.json({
          sha: "a".repeat(40),
          commit: { message: "Test commit", author: null, committer: null },
        });
      }
      throw new Error("Unexpected mocked GitHub route");
    }),
  );

  const app = createApp(createGitHubRepositoryClient({ appId: "123", privateKey }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request("/api/repositories/example/private/status", {
      headers: { host: "127.0.0.1" },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ fullName: "example/private", private: true });
    expect(body.includes("installation-test-token")).toBe(false);
    expect(body.includes(privateKey)).toBe(false);
  }
  expect(discoveries).toBe(2);
  expect(repositoryReads).toBe(2);
  expect(tokenRequests).toBe(1);
});
