import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(`VoxOps server listening on http://127.0.0.1:${port}`);
