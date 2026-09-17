import { generateKeyPairSync } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitHubAppConfig, GitHubAppConfigurationError } from "./config.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), realpath: vi.fn() }));

// Ephemeral test material, never written to disk or associated with a GitHub App.
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const root = resolve("test-workspace");
const keyPath = resolve("test-secrets/app.pem");
const environment = { VOXOPS_GITHUB_APP_ID: "123", VOXOPS_GITHUB_PRIVATE_KEY_PATH: keyPath };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(realpath).mockImplementation(async (path) => String(path));
  vi.mocked(readFile).mockResolvedValue(pem);
});

describe("GitHub App startup configuration", () => {
  it.each([{}, { VOXOPS_GITHUB_APP_ID: "", VOXOPS_GITHUB_PRIVATE_KEY_PATH: "" }])(
    "allows anonymous startup with no credentials",
    async (env) => {
      expect(await loadGitHubAppConfig(env, root)).toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { VOXOPS_GITHUB_APP_ID: "123" },
    { VOXOPS_GITHUB_PRIVATE_KEY_PATH: keyPath },
    { ...environment, VOXOPS_GITHUB_APP_ID: "not-an-id" },
    { ...environment, VOXOPS_GITHUB_APP_ID: "0" },
    { ...environment, VOXOPS_GITHUB_PRIVATE_KEY_PATH: "relative.pem" },
    { ...environment, VOXOPS_GITHUB_PRIVATE_KEY_PATH: resolve("secret.txt") },
  ])("rejects incomplete or malformed configuration before reading files", async (env) => {
    await expect(loadGitHubAppConfig(env, root)).rejects.toBeInstanceOf(
      GitHubAppConfigurationError,
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("loads and validates an external RSA PEM", async () => {
    const config = await loadGitHubAppConfig(environment, root);
    expect(config?.appId).toBe("123");
    expect(config?.privateKey === pem).toBe(true);
    expect(readFile).toHaveBeenCalledWith(keyPath, "utf8");
  });

  it("rejects a path or symlink that resolves inside the repository", async () => {
    vi.mocked(realpath)
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(resolve(root, "inside.pem"));
    await expect(loadGitHubAppConfig(environment, root)).rejects.toThrow(
      "must be outside the repository",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(["resolve", "read"])("sanitizes a file %s failure", async (stage) => {
    const error = new Error(`sensitive filesystem path: ${keyPath}`);
    if (stage === "resolve") vi.mocked(realpath).mockRejectedValue(error);
    else vi.mocked(readFile).mockRejectedValue(error);
    await expect(loadGitHubAppConfig(environment, root)).rejects.toThrow(
      "Cannot read the configured GitHub App private key file.",
    );
  });

  it("rejects malformed key material without including its value", async () => {
    vi.mocked(readFile).mockResolvedValue("sensitive-invalid-key-material");
    await expect(loadGitHubAppConfig(environment, root)).rejects.toThrow(
      "The GitHub App private key must be a valid unencrypted RSA PEM.",
    );
  });
});
