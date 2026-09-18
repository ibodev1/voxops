import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { createGitHubRepositoryClient } from "@voxops/github";

export const handler = handle(
  createApp(createGitHubRepositoryClient(process.env.VOXOPS_PUBLIC_REPOSITORIES ?? ""), "lambda"),
);
