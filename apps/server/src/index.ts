import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import {
  createGitHubRepositoryClient,
  loadGitHubAppConfig,
  GitHubAppConfigurationError,
} from "@voxops/github";
import { createApp } from "./app.js";

const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

try {
  const config = await loadGitHubAppConfig(
    process.env,
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const app = createApp(createGitHubRepositoryClient(config));
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(`VoxOps server listening on http://127.0.0.1:${port}`);
} catch (error) {
  console.error(
    error instanceof GitHubAppConfigurationError
      ? error.message
      : "Unable to start the VoxOps server.",
  );
  process.exitCode = 1;
}
