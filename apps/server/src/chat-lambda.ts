import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DemoChatRequestSchema, streamDemoChat } from "./demo-agent.js";

type RestEvent = {
  path?: string;
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
};

declare const awslambda: {
  streamifyResponse: (
    handler: (event: RestEvent, stream: Writable) => Promise<void>,
  ) => (event: RestEvent, stream: Writable) => Promise<void>;
  HttpResponseStream: {
    from: (
      stream: Writable,
      metadata: { statusCode: number; headers: Record<string, string> },
    ) => Writable;
  };
};

function writeJson(stream: Writable, statusCode: number, error: string): void {
  const response = awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
  response.end(JSON.stringify({ error }));
}

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  if (event.path !== "/api/demo/chat" || event.httpMethod !== "POST") {
    writeJson(stream, 404, "not_found");
    return;
  }
  if (
    !Object.entries(event.headers ?? {}).some(
      ([key, value]) =>
        key.toLowerCase() === "content-type" && value?.startsWith("application/json"),
    )
  ) {
    writeJson(stream, 415, "json_required");
    return;
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  if (Buffer.byteLength(body) > 4096) {
    writeJson(stream, 413, "request_too_large");
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    writeJson(stream, 400, "invalid_request");
    return;
  }
  const parsed = DemoChatRequestSchema.safeParse(input);
  if (!parsed.success) {
    writeJson(stream, 400, "invalid_request");
    return;
  }
  const mcpUrl = process.env.VOXOPS_MCP_REMOTE_URL?.trim();
  if (!mcpUrl) {
    writeJson(stream, 503, "demo_unavailable");
    return;
  }
  let started = false;
  try {
    const response = await streamDemoChat(parsed.data.messages, new URL(mcpUrl));
    if (!response.body) throw new Error("Empty model stream");
    const output = awslambda.HttpResponseStream.from(stream, {
      statusCode: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
    started = true;
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      output,
    );
  } catch {
    if (!started) writeJson(stream, 502, "demo_unavailable");
  }
});
