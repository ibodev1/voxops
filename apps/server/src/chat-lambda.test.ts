import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ streamDemoChat: vi.fn() }));
vi.mock("./demo-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./demo-agent.js")>()),
  streamDemoChat: agent.streamDemoChat,
}));

type Metadata = { statusCode: number; headers: Record<string, string> };
const request = (body: string) => ({
  path: "/api/demo/chat",
  httpMethod: "POST",
  headers: { "content-type": "application/json" },
  body,
});
const valid = JSON.stringify({ messages: [{ role: "user", content: "status" }] });

function output() {
  let metadata: Metadata | undefined;
  const chunks: string[] = [];
  let firstChunk: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    firstChunk = resolve;
  });
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      firstChunk?.();
      callback();
    },
  });
  vi.stubGlobal("awslambda", {
    streamifyResponse: (handler: unknown) => handler,
    HttpResponseStream: {
      from: (target: Writable, value: Metadata) => {
        metadata = value;
        return target;
      },
    },
  });
  return {
    stream,
    chunks,
    first,
    get metadata() {
      return metadata;
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("VOXOPS_MCP_REMOTE_URL", "https://example.test/mcp");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ["wrong route", { ...request(valid), path: "/other" }, 404],
  ["wrong method", { ...request(valid), httpMethod: "GET" }, 404],
  ["wrong content type", { ...request(valid), headers: { "content-type": "text/plain" } }, 415],
  ["large request", request("x".repeat(4097)), 413],
  ["bad JSON", request("{"), 400],
  ["bad history", request(JSON.stringify({ messages: [] })), 400],
] as const)("rejects %s before model access", async (_name, event, status) => {
  const sink = output();
  const { handler } = await import("./chat-lambda.js");
  await handler(event, sink.stream);
  expect(sink.metadata?.statusCode).toBe(status);
  expect(agent.streamDemoChat).not.toHaveBeenCalled();
});

it("forwards the first SSE chunk before the model stream finishes", async () => {
  const sink = output();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  agent.streamDemoChat.mockResolvedValue(new Response(body));
  const { handler } = await import("./chat-lambda.js");
  let finished = false;
  const invocation = handler(request(valid), sink.stream).then(() => {
    finished = true;
  });
  controller!.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"first"}\n\n'));
  await sink.first;
  expect(finished).toBe(false);
  expect(sink.chunks.join("")).toContain("first");
  expect(sink.metadata).toMatchObject({
    statusCode: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
  controller!.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"second"}\n\n'));
  controller!.close();
  await invocation;
  expect(sink.chunks.join("")).toContain("second");
});

it("returns a safe response when the agent fails before streaming", async () => {
  const sink = output();
  agent.streamDemoChat.mockRejectedValue(new Error("private Bedrock failure"));
  const { handler } = await import("./chat-lambda.js");
  await handler(request(valid), sink.stream);
  expect(sink.metadata?.statusCode).toBe(502);
  expect(sink.chunks.join("")).toBe('{"error":"demo_unavailable"}');
});

it("does not append a second JSON response after a stream has begun", async () => {
  const sink = output();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  agent.streamDemoChat.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
    ),
  );
  const { handler } = await import("./chat-lambda.js");
  const invocation = handler(request(valid), sink.stream);
  controller!.enqueue(new TextEncoder().encode("data: first\n\n"));
  await sink.first;
  controller!.error(new Error("private network failure"));
  await invocation;
  expect(sink.metadata?.statusCode).toBe(200);
  expect(sink.chunks.join("")).toBe("data: first\n\n");
  expect(sink.chunks.join("")).not.toContain("private network failure");
});
