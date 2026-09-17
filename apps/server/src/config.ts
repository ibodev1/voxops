import { createPrivateKey } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import {
  GitHubAppConfigurationError,
  loadGitHubAppConfig,
  type GitHubAppConfig,
} from "@voxops/github";

const secretSchema = z.strictObject({
  appId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number.isSafeInteger(Number(value))),
  privateKey: z.string().min(1),
});

export function createGitHubCredentialLoader(
  environment: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): () => Promise<GitHubAppConfig | undefined> {
  let pending: Promise<GitHubAppConfig | undefined> | undefined;

  async function load(): Promise<GitHubAppConfig | undefined> {
    const secretId = environment.VOXOPS_GITHUB_SECRET_ID?.trim();
    const appId = environment.VOXOPS_GITHUB_APP_ID?.trim();
    const keyPath = environment.VOXOPS_GITHUB_PRIVATE_KEY_PATH?.trim();
    if (secretId && (appId || keyPath)) {
      throw new GitHubAppConfigurationError(
        "Configure either local GitHub App credentials or VOXOPS_GITHUB_SECRET_ID, not both.",
      );
    }
    if (!secretId) return loadGitHubAppConfig(environment, repositoryRoot);

    const client = new SecretsManagerClient({ maxAttempts: 2 });
    try {
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!result.SecretString) throw new Error("Missing SecretString");
      const config = secretSchema.parse(JSON.parse(result.SecretString));
      if (
        !config.privateKey.includes("-----BEGIN ") ||
        createPrivateKey(config.privateKey).asymmetricKeyType !== "rsa"
      ) {
        throw new Error("Invalid RSA key");
      }
      return config;
    } catch {
      // Do not retain SDK causes, JSON input, schema diagnostics, or key-parser messages.
      throw new GitHubAppConfigurationError(
        "Unable to load valid GitHub App credentials from Secrets Manager.",
      );
    } finally {
      client.destroy();
    }
  }

  return () => {
    // Share concurrent loads and successful results; allow a later request to retry failures.
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
