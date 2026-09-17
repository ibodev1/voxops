import { Hono } from "hono";
import { RepositoryRefSchema } from "@voxops/contracts";
import { getRepositoryStatus, GitHubRepositoryError } from "@voxops/github";

export const app = new Hono();

app.get("/health", (context) => context.json({ status: "ok" }));

app.get("/api/repositories/:owner/:repo/status", async (context) => {
  const parsed = RepositoryRefSchema.safeParse(context.req.param());
  if (!parsed.success) {
    return context.json({ error: "invalid_repository_ref" }, 400);
  }

  try {
    const status = await getRepositoryStatus(parsed.data);
    return context.json(status);
  } catch (error) {
    if (error instanceof GitHubRepositoryError) {
      switch (error.kind) {
        case "not_found":
          return context.json({ error: "repository_not_found" }, 404);
        case "rate_limited":
          return context.json({ error: "github_rate_limited" }, 503);
        case "upstream":
          return context.json({ error: "github_upstream_error" }, 502);
      }
    }

    return context.json({ error: "internal_error" }, 500);
  }
});
