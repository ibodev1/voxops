import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { afterEach, expect, it, vi } from "vitest";
import { createServiceAuthCredentialLoader } from "./service-auth-config.js";

// Obvious synthetic bytes, never associated with a deployed client.
const credentials = {
  clientId: "test-client",
  clientSecret: Buffer.alloc(32, 1).toString("base64"),
  tokenSigningSecret: Buffer.alloc(32, 2).toString("base64"),
};
const env = { VOXOPS_ALEXA_AUTH_SECRET_ID: "test-service-secret" };
afterEach(() => vi.restoreAllMocks());

it("loads SecretString lazily, shares concurrent loads, and caches successful results", async () => {
  const send = vi
    .spyOn(SecretsManagerClient.prototype, "send")
    .mockImplementation(async () => ({ SecretString: JSON.stringify(credentials), $metadata: {} }));
  const load = createServiceAuthCredentialLoader(env);
  expect(send).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([load(), load()]);
  expect(first).toEqual(credentials);
  expect(second).toBe(first);
  expect(await load()).toBe(first);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetSecretValueCommand);
  expect(send.mock.calls[0]?.[0].input).toEqual({ SecretId: "test-service-secret" });
});

it.each([
  ["missing SecretString", undefined],
  ["malformed JSON", "sensitive-invalid-json"],
  [
    "missing clientId",
    JSON.stringify({
      clientSecret: credentials.clientSecret,
      tokenSigningSecret: credentials.tokenSigningSecret,
    }),
  ],
  [
    "missing clientSecret",
    JSON.stringify({
      clientId: credentials.clientId,
      tokenSigningSecret: credentials.tokenSigningSecret,
    }),
  ],
  [
    "missing signing secret",
    JSON.stringify({ clientId: credentials.clientId, clientSecret: credentials.clientSecret }),
  ],
  ["empty clientId", JSON.stringify({ ...credentials, clientId: "" })],
  [
    "short clientSecret",
    JSON.stringify({ ...credentials, clientSecret: Buffer.alloc(31).toString("base64") }),
  ],
  ["short signing secret", JSON.stringify({ ...credentials, tokenSigningSecret: "short" })],
  [
    "noncanonical base64",
    JSON.stringify({ ...credentials, clientSecret: credentials.clientSecret + "\n" }),
  ],
  ["reused key", JSON.stringify({ ...credentials, tokenSigningSecret: credentials.clientSecret })],
])("rejects %s without secret diagnostics", async (_label, SecretString) => {
  vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(async () => ({
    SecretString,
    $metadata: {},
  }));
  const error = await createServiceAuthCredentialLoader(env)().catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Service authentication is unavailable.");
  expect((error as Error).cause).toBeUndefined();
});

it("sanitizes SDK failure and retries on a later request", async () => {
  const send = vi
    .spyOn(SecretsManagerClient.prototype, "send")
    .mockRejectedValueOnce(new Error("sensitive AWS diagnostics"));
  const load = createServiceAuthCredentialLoader(env);
  await expect(load()).rejects.toThrow("Service authentication is unavailable.");
  send.mockImplementation(async () => ({
    SecretString: JSON.stringify(credentials),
    $metadata: {},
  }));
  expect(await load()).toEqual(credentials);
  expect(send).toHaveBeenCalledTimes(2);
});

it("fails closed without configuration and makes no AWS call", async () => {
  const send = vi
    .spyOn(SecretsManagerClient.prototype, "send")
    .mockRejectedValue(new Error("No AWS"));
  await expect(createServiceAuthCredentialLoader({})()).rejects.toThrow(
    "Service authentication is unavailable.",
  );
  expect(send).not.toHaveBeenCalled();
});
