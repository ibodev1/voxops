import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { createConfiguredGitHubClient } from "./runtime.js";

export const handler = handle(
  createApp(createConfiguredGitHubClient(process.env, process.cwd()), {
    runtime: "lambda",
    environment: process.env,
  }),
);
