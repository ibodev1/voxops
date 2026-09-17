import { createPrivateKey } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  appId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number.isSafeInteger(Number(value))),
  privateKeyPath: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isAbsolute(value) && !value.includes("\0") && extname(value).toLowerCase() === ".pem",
    ),
});

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

export class GitHubAppConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppConfigurationError";
  }
}

export async function loadGitHubAppConfig(
  environment: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): Promise<GitHubAppConfig | undefined> {
  const appId = environment.VOXOPS_GITHUB_APP_ID?.trim();
  const privateKeyPath = environment.VOXOPS_GITHUB_PRIVATE_KEY_PATH?.trim();
  if (!appId && !privateKeyPath) return undefined;

  const parsed = environmentSchema.safeParse({ appId, privateKeyPath });
  if (!parsed.success) {
    throw new GitHubAppConfigurationError(
      "Set VOXOPS_GITHUB_APP_ID to a positive integer and VOXOPS_GITHUB_PRIVATE_KEY_PATH to an absolute .pem path outside the repository.",
    );
  }

  let privateKey: string;
  try {
    const root = await realpath(repositoryRoot);
    const keyPath = await realpath(parsed.data.privateKeyPath);
    const fromRoot = relative(root, keyPath);
    // Resolve symlinks before enforcing the outside-repository requirement.
    if (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)) {
      throw new GitHubAppConfigurationError(
        "The GitHub App private key must be outside the repository.",
      );
    }
    privateKey = await readFile(keyPath, "utf8");
  } catch (error) {
    if (error instanceof GitHubAppConfigurationError) throw error;
    throw new GitHubAppConfigurationError(
      "Cannot read the configured GitHub App private key file.",
    );
  }

  try {
    if (
      !privateKey.includes("-----BEGIN ") ||
      createPrivateKey(privateKey).asymmetricKeyType !== "rsa"
    ) {
      throw new Error("Invalid key");
    }
  } catch {
    throw new GitHubAppConfigurationError(
      "The GitHub App private key must be a valid unencrypted RSA PEM.",
    );
  }

  return { appId: parsed.data.appId, privateKey };
}
