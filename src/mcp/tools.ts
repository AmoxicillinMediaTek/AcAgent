import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { McpCallResult, McpContentBlock, McpToolDefinition } from "./client";
import type { McpServerConfig } from "./config";
import type { McpServerStatus } from "./manager";

export const READ_MCP_TOOL_NAME = "read_mcp";

type McpToolDetails = { server: string; tool: string; isError: boolean };
type ReadMcpDetails = { servers: number; ready: number };

/** The one client call a tool makes; the manager passes its client through this shape. */
export type McpToolCaller = {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
};

/**
 * The name the model sees. Providers limit tool names to `[a-zA-Z0-9_-]` and about 64 characters,
 * and a prefix keeps MCP tools apart from the built-ins and from one another across servers.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`.slice(0, 64);
}

export function createMcpTool(
  client: McpToolCaller,
  server: McpServerConfig,
  tool: McpToolDefinition,
  name = mcpToolName(server.id, tool.name),
): ToolRegistration {
  const summary = tool.description?.trim() || `${tool.name}.`;
  return defineTool({
    name,
    description: `${summary} Calls the "${tool.name}" tool of the MCP server "${server.name}".`,
    parameters: parameterSchema(tool.inputSchema),
    executionMode: "parallel",
    execute: async (args, _api, context): Promise<ToolExecutionResult<McpToolDetails>> => {
      const result = await client.callTool(
        tool.name,
        (args ?? {}) as Record<string, unknown>,
        context.abortSignal,
      );
      return toolResult(result, server.name, tool.name);
    },
  });
}

export function createReadMcpTool(read: () => McpServerStatus[]): ToolRegistration {
  return defineTool({
    name: READ_MCP_TOOL_NAME,
    description:
      "List the configured MCP servers with their state and the tools each one offers. MCP tools " +
      "start with mcp_ and are deferred: load one with tool_search before calling it.",
    parameters: Type.Object({}),
    executionMode: "parallel",
    replay: "safe",
    execute: async (): Promise<ToolExecutionResult<ReadMcpDetails>> => {
      const servers = read();
      const ready = servers.filter((server) => server.state === "ready").length;
      return {
        output: [{ type: "text", text: describeServers(servers) }],
        details: { servers: servers.length, ready },
      };
    },
  });
}

function describeServers(servers: readonly McpServerStatus[]): string {
  if (!servers.length)
    return 'No MCP servers are configured. The user adds one under "MCP servers" in the composer chip.';
  const lines: string[] = [];
  for (const server of servers) {
    const state =
      server.state === "ready"
        ? `ready, ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
        : server.state === "disabled"
          ? "off"
          : server.state;
    lines.push(`- ${server.name} (${server.id}), ${state}`);
    if (server.state === "ready") {
      if (server.tools.length) lines.push(`  ${server.tools.join(", ")}`);
      else lines.push("  It offers no tools.");
    }
    if (server.state === "error")
      lines.push(`  ${server.error ?? "It did not connect."} (${server.url})`);
  }
  if (servers.some((server) => server.state === "ready"))
    lines.push("Load an mcp_ tool with tool_search before calling it.");
  return lines.join("\n");
}

function parameterSchema(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return { type: "object", properties: {} } as TSchema;
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return { type: "object", ...rest } as TSchema;
}

function toolResult(
  result: McpCallResult,
  serverName: string,
  toolName: string,
): ToolExecutionResult<McpToolDetails> {
  const output: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const block of result.content ?? []) {
    const part = contentPart(block);
    if (part) output.push(part);
  }
  if (!output.length && result.structuredContent !== undefined)
    output.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  if (!output.length)
    output.push({
      type: "text",
      text: result.isError
        ? "The tool reported an error with no details."
        : "The tool returned no content.",
    });
  return {
    output,
    isError: result.isError === true,
    details: { server: serverName, tool: toolName, isError: result.isError === true },
  };
}

function contentPart(
  block: McpContentBlock,
): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | undefined {
  if (!block || typeof block !== "object") return undefined;
  if (block.type === "text")
    return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string" &&
    block.mimeType.startsWith("image/")
  )
    return { type: "image", data: block.data, mimeType: block.mimeType };
  if (block.type === "resource") return { type: "text", text: describeResource(block.resource) };
  if (block.type === "audio")
    return { type: "text", text: `[Audio content (${block.mimeType ?? "unknown type"})]` };
  if (typeof block.text === "string") return { type: "text", text: block.text };
  return { type: "text", text: `[${block.type ?? "unknown"} content]` };
}

function describeResource(resource: McpContentBlock["resource"]): string {
  if (!resource) return "[Resource content]";
  if (typeof resource.text === "string") return resource.text;
  const uri = resource.uri ?? "unknown URI";
  const type = resource.mimeType ? ` (${resource.mimeType})` : "";
  return `[Embedded resource: ${uri}${type}]`;
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "x";
}
