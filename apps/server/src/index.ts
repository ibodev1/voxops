import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { createConfiguredGitHubClient } from "./runtime.js";
import { createApp } from "./app.js";

const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

try {
  const github = createConfiguredGitHubClient(
    process.env,
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const app = createApp(github);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(`VoxOps server listening on http://127.0.0.1:${port}`);
} catch {
  console.error("Unable to start the VoxOps server.");
  process.exitCode = 1;
}
