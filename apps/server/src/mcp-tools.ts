import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RepositoryListInputSchema, RepositoryRefSchema } from "@voxops/contracts";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

export const TOOL_NAMES = [
  "get_repository_status",
  "list_open_issues",
  "list_pull_requests",
  "list_workflow_runs",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];
type McpToolResult = {
  content: unknown;
  isError?: boolean | undefined;
  structuredContent?: unknown;
};

function novaToolSchema<SCHEMA extends z.ZodType>(schema: SCHEMA) {
  const converted = z.toJSONSchema(schema);
  return jsonSchema<z.output<SCHEMA>>(
    {
      type: "object",
      properties: converted.properties,
      required: ["owner", "repo"],
    },
    {
      validate: (value) => {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? { success: true, value: parsed.data }
          : { success: false, error: new Error("Invalid tool arguments") };
      },
    },
  );
}

// Nova accepts this minimal root schema. MCP still validates the complete Zod schema.
const refSchema = novaToolSchema(RepositoryRefSchema);
const listSchema = novaToolSchema(RepositoryListInputSchema);

function toSafeToolResult(result: McpToolResult, durationMs: number) {
  if (result.isError)
    return { status: "error" as const, durationMs, message: "Repository data is unavailable." };

  const structured =
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : undefined;
  const data = structured ?? result.content;
  if (JSON.stringify(data).length > 5000)
    return {
      status: "ok" as const,
      durationMs,
      message: "Repository data exceeds the response limit.",
    };
  return { status: "ok" as const, durationMs, result: data };
}

export async function connectMcpTools(mcpUrl: URL) {
  const client = new Client(
    { name: "voxops-demo", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    const discovered = (await client.listTools()).tools;
    const allowed = discovered.filter((entry) => TOOL_NAMES.some((name) => name === entry.name));
    if (
      allowed.length !== TOOL_NAMES.length ||
      new Set(allowed.map((entry) => entry.name)).size !== 4
    )
      throw new Error("MCP tools unavailable");

    let calls = 0;
    const makeTool = (name: ToolName, inputSchema: typeof refSchema | typeof listSchema) =>
      tool({
        description: allowed.find((entry) => entry.name === name)?.description ?? name,
        inputSchema,
        execute: async (input) => {
          if (++calls > 6)
            return {
              status: "error" as const,
              durationMs: 0,
              message: "Repository lookup limit reached.",
            };
          const started = performance.now();
          try {
            const result = await client.callTool({ name, arguments: input });
            return toSafeToolResult(result, Math.round(performance.now() - started));
          } catch {
            return {
              status: "error" as const,
              durationMs: Math.round(performance.now() - started),
              message: "Repository data is unavailable.",
            };
          }
        },
      });

    return {
      tools: {
        get_repository_status: makeTool("get_repository_status", refSchema),
        list_open_issues: makeTool("list_open_issues", listSchema),
        list_pull_requests: makeTool("list_pull_requests", listSchema),
        list_workflow_runs: makeTool("list_workflow_runs", listSchema),
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
