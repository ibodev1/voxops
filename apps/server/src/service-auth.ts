import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import {
  verifyBearerToken,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import { createServiceAuthCredentialLoader } from "./service-auth-config.js";

export interface ServiceAuthOptions {
  runtime: "local" | "lambda";
  environment: Readonly<Record<string, string | undefined>>;
}

const scope = "mcp:service";
const lifetime = 3600;
const discoveryMethods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "server/discover",
]);
const methodSchema = z.object({ method: z.string() });
const lambdaBindingSchema = z.object({
  event: z.object({ version: z.literal("2.0") }),
  requestContext: z.object({ domainName: z.string().regex(/^[a-zA-Z0-9.-]+$/) }),
});

function errorResponse(error: string, status: 400 | 401 | 403 | 503): Response {
  // Alexa does not support WWW-Authenticate challenges, including scope step-up.
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

function canonicalOrigin(context: Context, runtime: ServiceAuthOptions["runtime"]): string {
  const url = new URL(context.req.url);
  if (runtime === "lambda") {
    const binding = lambdaBindingSchema.parse(context.env);
    // Hono constructs the HTTPS URL from this AWS-supplied field, not forwarded headers.
    if (url.origin !== `https://${binding.requestContext.domainName}`)
      throw new Error("Invalid origin");
  } else if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Invalid local origin");
  }
  return url.origin;
}

function equalCredential(actual: string, expected: string): boolean {
  // Hash to fixed-size buffers so length mismatches take the same comparison path.
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function basicCredentials(
  header: string | undefined,
): { clientId: string; clientSecret: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? "");
  if (!match?.[1] || match[1].length > 4096) return undefined;
  try {
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.toString("base64") !== match[1]) return undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const colon = decoded.indexOf(":");
    if (colon < 1) return undefined;
    // RFC 6749 client_secret_basic encodes each component as form data before Base64.
    const decode = (value: string): string => decodeURIComponent(value.replaceAll("+", " "));
    return {
      clientId: decode(decoded.slice(0, colon)),
      clientSecret: decode(decoded.slice(colon + 1)),
    };
  } catch {
    return undefined;
  }
}

export function createServiceAuthApp(mcp: McpHttpHandler, options: ServiceAuthOptions): Hono {
  const app = new Hono();
  const load = createServiceAuthCredentialLoader(options.environment);
  const paths = [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/oauth/token",
    "/mcp",
  ];
  for (const path of paths) {
    app.use(path, async (context, next) => {
      let origin: string;
      try {
        origin = canonicalOrigin(context, options.runtime);
      } catch {
        return errorResponse("access_denied", 403);
      }
      const suppliedOrigin = context.req.header("origin");
      if (
        (suppliedOrigin !== undefined && suppliedOrigin !== origin) ||
        context.req.header("host") !== new URL(origin).host
      ) {
        return errorResponse("access_denied", 403);
      }
      return next();
    });
  }
  app.use(
    "/oauth/token",
    bodyLimit({ maxSize: 8192, onError: () => errorResponse("invalid_request", 400) }),
  );
  app.use(
    "/mcp",
    bodyLimit({ maxSize: 65536, onError: () => errorResponse("invalid_request", 400) }),
  );

  function metadata(context: Context) {
    const origin = canonicalOrigin(context, options.runtime);
    return {
      issuer: origin,
      token_endpoint: `${origin}/oauth/token`,
      grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      scopes_supported: [scope],
      response_types_supported: [],
    };
  }
  app.get("/.well-known/oauth-authorization-server", (context) => context.json(metadata(context)));
  // The installed SDK's builder requires an authorization_endpoint, which Tier 1 does not have.
  app.get("/.well-known/oauth-protected-resource", (context) =>
    context.json({
      resource: `${canonicalOrigin(context, options.runtime)}/mcp`,
      authorization_servers: [canonicalOrigin(context, options.runtime)],
      scopes_supported: [scope],
    } satisfies OAuthProtectedResourceMetadata),
  );

  app.post("/oauth/token", async (context) => {
    const origin = canonicalOrigin(context, options.runtime);
    if (
      new URL(context.req.url).search ||
      context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
    ) {
      return errorResponse("invalid_request", 400);
    }
    const supplied = basicCredentials(context.req.header("authorization"));
    if (!supplied) return errorResponse("invalid_client", 401);
    try {
      const credentials = await load();
      const idMatches = equalCredential(supplied.clientId, credentials.clientId);
      const secretMatches = equalCredential(supplied.clientSecret, credentials.clientSecret);
      if (!idMatches || !secretMatches) return errorResponse("invalid_client", 401);
      const form = new URLSearchParams(await context.req.text());
      const keys = ["grant_type", "scope", "resource"];
      if (
        [...form.keys()].some((key) => !keys.includes(key)) ||
        keys.some((key) => form.getAll(key).length !== 1 || !form.get(key))
      ) {
        return errorResponse("invalid_request", 400);
      }
      if (form.get("grant_type") !== "client_credentials")
        return errorResponse("unsupported_grant_type", 400);
      if (form.get("scope") !== scope) return errorResponse("invalid_scope", 400);
      if (form.get("resource") !== `${origin}/mcp`) return errorResponse("access_denied", 403);
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ scope, client_id: credentials.clientId })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(origin)
        .setSubject(`service:${credentials.clientId}`)
        .setAudience(`${origin}/mcp`)
        .setIssuedAt(now)
        .setExpirationTime(now + lifetime)
        .sign(Buffer.from(credentials.tokenSigningSecret, "base64"));
      return context.json(
        { access_token: token, token_type: "Bearer", expires_in: lifetime, scope },
        200,
        { "Cache-Control": "no-store", Pragma: "no-cache" },
      );
    } catch {
      return errorResponse("temporarily_unavailable", 503);
    }
  });

  app.post("/mcp", async (context) => {
    const origin = canonicalOrigin(context, options.runtime);
    let authInfo: AuthInfo;
    try {
      // Reject query tokens and ambiguous/combined Authorization headers.
      if (
        new URL(context.req.url).search ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(
          context.req.header("authorization") ?? "",
        )
      ) {
        return errorResponse("invalid_token", 401);
      }
      authInfo = await verifyBearerToken(context.req.header("authorization"), {
        requiredScopes: [scope],
        verifier: {
          async verifyAccessToken(token): Promise<AuthInfo> {
            const credentials = await load();
            const { payload } = await jwtVerify(
              token,
              Buffer.from(credentials.tokenSigningSecret, "base64"),
              {
                algorithms: ["HS256"],
                typ: "JWT",
                issuer: origin,
                audience: `${origin}/mcp`,
                maxTokenAge: lifetime,
                requiredClaims: ["iss", "sub", "aud", "iat", "exp", "scope", "client_id"],
              },
            );
            if (
              payload.aud !== `${origin}/mcp` ||
              payload.client_id !== credentials.clientId ||
              payload.sub !== `service:${credentials.clientId}` ||
              !Number.isInteger(payload.iat) ||
              !Number.isInteger(payload.exp) ||
              payload.exp! - payload.iat! > lifetime ||
              payload.exp! <= payload.iat!
            ) {
              throw new Error("Invalid service token");
            }
            if (payload.scope !== scope)
              throw new OAuthError(OAuthErrorCode.InsufficientScope, "Service scope required");
            return {
              token,
              clientId: credentials.clientId,
              scopes: [scope],
              expiresAt: payload.exp!,
              resource: new URL(`${origin}/mcp`),
            };
          },
        },
      });
    } catch (error) {
      return error instanceof OAuthError && error.code === OAuthErrorCode.InsufficientScope
        ? errorResponse("insufficient_scope", 403)
        : errorResponse("invalid_token", 401);
    }
    // Only inspect the cloned top-level method. The SDK still parses and dispatches the original.
    let method: string;
    try {
      const parsed = methodSchema.safeParse(await context.req.raw.clone().json());
      if (!parsed.success) return errorResponse("invalid_request", 400);
      method = parsed.data.method;
    } catch {
      return errorResponse("invalid_request", 400);
    }
    if (method === "tools/call")
      return Response.json(
        {
          error: "user_authorization_required",
          message: "User authorization is required to execute VoxOps tools.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    if (!discoveryMethods.has(method)) return errorResponse("access_denied", 403);
    return mcp.fetch(context.req.raw, { authInfo });
  });
  return app;
}
