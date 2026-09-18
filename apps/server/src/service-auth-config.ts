import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

// Canonical Base64 represents at least 32 random bytes; generation entropy is an operator duty.
const randomSecret = z
  .string()
  .max(256)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length >= 32 && bytes.toString("base64") === value;
  });
const credentialsSchema = z
  .strictObject({
    clientId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    clientSecret: randomSecret,
    tokenSigningSecret: randomSecret,
  })
  .refine((value) => value.clientSecret !== value.tokenSigningSecret);

export type AlexaServiceAuthCredentials = z.infer<typeof credentialsSchema>;

export function createServiceAuthCredentialLoader(
  environment: Readonly<Record<string, string | undefined>>,
): () => Promise<AlexaServiceAuthCredentials> {
  let pending: Promise<AlexaServiceAuthCredentials> | undefined;
  async function load(): Promise<AlexaServiceAuthCredentials> {
    const secretId = environment.VOXOPS_ALEXA_AUTH_SECRET_ID?.trim();
    if (!secretId) throw new Error("Service authentication is unavailable.");
    const client = new SecretsManagerClient({ maxAttempts: 2 });
    try {
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!result.SecretString) throw new Error("Missing SecretString");
      return credentialsSchema.parse(JSON.parse(result.SecretString));
    } catch {
      throw new Error("Service authentication is unavailable.");
    } finally {
      client.destroy();
    }
  }
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
