import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { RepositoryListInputSchema, RepositoryRefSchema } from "@voxops/contracts";
import { GitHubRepositoryError, type GitHubRepositoryClient } from "@voxops/github";
import { createMcpServer } from "./mcp.js";
import { createServiceAuthApp, type ServiceAuthOptions } from "./service-auth.js";

export function createApp(
  github: GitHubRepositoryClient,
  options: ServiceAuthOptions = { runtime: "local", environment: {} },
): Hono {
  const app = createMcpHonoApp();
  const mcp = createMcpHandler(() => createMcpServer(github));

  if (options.runtime === "local") {
    if (options.environment.VOXOPS_ALEXA_AUTH_SECRET_ID?.trim()) {
      app.route("/", createServiceAuthApp(mcp, options));
    } else {
      app.all("/mcp", (context: Context) =>
        mcp.fetch(context.req.raw, { parsedBody: context.get("parsedBody") }),
      );
    }
  }

  app.get("/api/repositories/:owner/:repo/status", async (context) => {
    const parsed = RepositoryRefSchema.safeParse(context.req.param());
    if (!parsed.success) {
      return context.json({ error: "invalid_repository_ref" }, 400);
    }

    try {
      const status = await github.getRepositoryStatus(parsed.data);
      return context.json(status);
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  });

  app.get("/api/repositories/:owner/:repo/issues", async (context) => {
    const input = parseListRequest(context);
    if ("error" in input) return context.json({ error: input.error }, 400);
    try {
      return context.json(await github.listOpenIssues(input.data));
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  });

  app.get("/api/repositories/:owner/:repo/pull-requests", async (context) => {
    const input = parseListRequest(context);
    if ("error" in input) return context.json({ error: input.error }, 400);
    try {
      return context.json(await github.listPullRequests(input.data));
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  });

  app.get("/api/repositories/:owner/:repo/workflow-runs", async (context) => {
    const input = parseListRequest(context);
    if ("error" in input) return context.json({ error: input.error }, 400);
    try {
      return context.json(await github.listWorkflowRuns(input.data));
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  });

  // Public health must accept API Gateway's Host without relaxing the capability guards.
  const entry = new Hono();
  entry.get("/health", (context) => context.json({ status: "ok" }));
  if (options.runtime === "lambda") entry.route("/", createServiceAuthApp(mcp, options));
  entry.route("/", app);
  return entry;
}

function parseListRequest(context: Context) {
  const ref = RepositoryRefSchema.safeParse(context.req.param());
  if (!ref.success) return { error: "invalid_repository_ref" as const };
  const queryLimit = context.req.query("limit");
  const parsed = RepositoryListInputSchema.safeParse({
    ...ref.data,
    limit: queryLimit === undefined ? undefined : Number(queryLimit),
  });
  return parsed.success ? { data: parsed.data } : { error: "invalid_limit" as const };
}

function repositoryErrorResponse(error: unknown): Response {
  if (error instanceof GitHubRepositoryError) {
    switch (error.kind) {
      case "not_found":
        return Response.json({ error: "repository_not_found" }, { status: 404 });
      case "rate_limited":
        return Response.json({ error: "github_rate_limited" }, { status: 503 });
      case "authentication":
        return Response.json({ error: "github_authentication_failed" }, { status: 503 });
      case "upstream":
        return Response.json({ error: "github_upstream_error" }, { status: 502 });
    }
  }
  return Response.json({ error: "internal_error" }, { status: 500 });
}
