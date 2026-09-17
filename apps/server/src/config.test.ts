import { generateKeyPairSync } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubAppConfigurationError } from "@voxops/github";
import { createGitHubCredentialLoader } from "./config.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), realpath: vi.fn() }));
const send = vi.hoisted(() =>
  vi.fn<
    (
      command: GetSecretValueCommand,
    ) => Promise<Pick<GetSecretValueCommandOutput, "SecretString" | "SecretBinary">>
  >(),
);
vi.mock("@aws-sdk/client-secrets-manager", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-secrets-manager")>();
  return {
    ...sdk,
    SecretsManagerClient: class {
      send = send;
      destroy(): void {}
    },
  };
});
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const credentials = { appId: "123", privateKey };
const environment = { VOXOPS_GITHUB_SECRET_ID: "voxops/dev/github-app" };
const root = resolve("test-workspace");
const failure = "Unable to load valid GitHub App credentials from Secrets Manager.";

beforeEach(() => {
  send.mockReset();
  send.mockRejectedValue(new Error("Unexpected AWS request"));
  vi.mocked(readFile).mockReset().mockResolvedValue(privateKey);
  vi.mocked(realpath)
    .mockReset()
    .mockImplementation(async (path) => String(path));
});
afterEach(() => vi.unstubAllGlobals());

it("loads a validated SecretString lazily and caches concurrent and warm requests", async () => {
  send.mockResolvedValue({ SecretString: JSON.stringify(credentials) });
  const load = createGitHubCredentialLoader(environment, root);
  expect(send).not.toHaveBeenCalled();
  const [first, concurrent] = await Promise.all([load(), load()]);
  expect(first?.appId).toBe("123");
  expect(first?.privateKey === privateKey).toBe(true);
  expect(concurrent).toBe(first);
  expect(await load()).toBe(first);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetSecretValueCommand);
  expect(send.mock.calls[0]?.[0].input).toEqual({ SecretId: environment.VOXOPS_GITHUB_SECRET_ID });
  expect(readFile).not.toHaveBeenCalled();
});

it.each([
  ["malformed JSON", { SecretString: "sensitive-malformed-json" }],
  ["missing SecretString", {}],
  ["binary only", { SecretBinary: new Uint8Array([1, 2]) }],
  ["missing appId", { SecretString: JSON.stringify({ privateKey: "sensitive-key" }) }],
  ["missing privateKey", { SecretString: JSON.stringify({ appId: "123" }) }],
  ["invalid appId", { SecretString: JSON.stringify({ ...credentials, appId: "0" }) }],
  ["invalid RSA", { SecretString: JSON.stringify({ appId: "123", privateKey: "sensitive-key" }) }],
])("sanitizes %s without retaining causes or input", async (_label, response) => {
  send.mockResolvedValue(response);
  const load = createGitHubCredentialLoader(environment, root);
  try {
    await load();
    expect.fail("Expected invalid credentials to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubAppConfigurationError);
    expect((error as Error).message).toBe(failure);
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("sensitive");
  }
});

it("sanitizes SDK failures and retries after a failed load", async () => {
  send.mockRejectedValueOnce(new Error("sensitive SDK credentials and request details"));
  const load = createGitHubCredentialLoader(environment, root);
  await expect(load()).rejects.toThrow(failure);
  send.mockResolvedValueOnce({ SecretString: JSON.stringify(credentials) });
  expect((await load())?.appId).toBe("123");
  expect(send).toHaveBeenCalledTimes(2);
});

it.each([
  { ...environment, VOXOPS_GITHUB_APP_ID: "123" },
  { ...environment, VOXOPS_GITHUB_PRIVATE_KEY_PATH: "external.pem" },
  { VOXOPS_GITHUB_APP_ID: "123" },
  { VOXOPS_GITHUB_PRIVATE_KEY_PATH: "external.pem" },
])("rejects mixed or incomplete modes without AWS or file access", async (env) => {
  await expect(createGitHubCredentialLoader(env, root)()).rejects.toBeInstanceOf(
    GitHubAppConfigurationError,
  );
  expect(send).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});

it("preserves the external PEM local mode", async () => {
  const keyPath = resolve("test-secrets/app.pem");
  const load = createGitHubCredentialLoader(
    { VOXOPS_GITHUB_APP_ID: "123", VOXOPS_GITHUB_PRIVATE_KEY_PATH: keyPath },
    root,
  );
  const config = await load();
  expect(config?.appId).toBe("123");
  expect(config?.privateKey === privateKey).toBe(true);
  expect(readFile).toHaveBeenCalledWith(keyPath, "utf8");
  expect(send).not.toHaveBeenCalled();
});

it("preserves anonymous local mode without AWS or filesystem access", async () => {
  expect(await createGitHubCredentialLoader({}, root)()).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});
