import type { ToolRegistration } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { McpClient } from "../src/mcp/client.ts";
import {
  finalizeMcpServer,
  parseMcpHeadersText,
  sanitizeMcpServers,
  type McpServerConfig,
} from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { createMcpTool, mcpToolName } from "../src/mcp/tools.ts";
import { runTool, type ToolOutput } from "./toolHarness.ts";

const SERVER: McpServerConfig = {
  id: "docs",
  name: "Docs",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer token" },
  enabled: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(result: ToolOutput): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

type Call = { body: Record<string, unknown>; headers: Headers };

/** A stand-in server: SSE on initialize, JSON afterwards, and the session id it hands out. */
function fakeServer(options: { failList?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ body, headers: new Headers(init?.headers) });
    if (body.method === "initialize")
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" } },
        })}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
        },
      );
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      if (options.failList) return jsonResponse({ error: "nope" }, 500);
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "weather",
              description: "Read the weather",
              inputSchema: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        },
      });
    }
    if (body.method === "tools/call")
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            { type: "text", text: "Sunny" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      });
    return new Response("unexpected", { status: 400 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("MCP server settings keep valid URLs, headers and unique ids", () => {
  const servers = sanitizeMcpServers([
    { name: "Docs", url: "https://example.com/mcp/", headers: { Authorization: "Bearer a" } },
    { name: "Docs", url: "ftp://example.com" },
    { name: "Docs again", url: "https://example.com/mcp" },
    { name: "Broken", url: "not a url" },
  ]);
  expect(servers.map((server) => server.id)).toEqual(["docs", "docs-again"]);
  expect(servers[0]?.url).toBe("https://example.com/mcp");
  expect(servers[0]?.headers).toEqual({ Authorization: "Bearer a" });
  expect(servers[0]?.enabled).toBe(true);
});

test("header text must be a JSON object of one-line values", () => {
  expect(parseMcpHeadersText("")).toEqual({});
  expect(parseMcpHeadersText('{"X-Key": "v"}')).toEqual({ "X-Key": "v" });
  expect(() => parseMcpHeadersText("[1]")).toThrow(/JSON object/);
  expect(() => parseMcpHeadersText('{"X-Key": "a\\nb"}')).toThrow(/rejected/);
});

test("a saved MCP server keeps its id and settings", () => {
  const existing = sanitizeMcpServers([SERVER]);
  const saved = finalizeMcpServer(
    { id: "docs", name: "Docs", url: "https://example.com/mcp", headers: '{"X-Team": "a"}' },
    existing,
  );
  expect(saved).toMatchObject({ id: "docs", enabled: true, headers: { "X-Team": "a" } });
  expect(() => finalizeMcpServer({ name: "", url: SERVER.url }, existing)).toThrow(/name/);
});

test("the client initializes over SSE and keeps the session id", async () => {
  const { calls, fetchImpl } = fakeServer();
  const client = new McpClient(SERVER, fetchImpl);
  await client.connect();
  const tools = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["weather"]);
  expect(client.serverInfo?.name).toBe("fake");

  const list = calls.find((call) => call.body.method === "tools/list");
  expect(list?.headers.get("mcp-session-id")).toBe("session-1");
  expect(list?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  expect(list?.headers.get("authorization")).toBe("Bearer token");
  expect(calls[1]?.body.method).toBe("notifications/initialized");
});

test("an MCP tool returns text and images and keeps the server name", async () => {
  const { fetchImpl } = fakeServer();
  const client = new McpClient(SERVER, fetchImpl);
  await client.connect();
  const [definition] = await client.listTools();
  const tool = createMcpTool(client, SERVER, definition!);
  expect(tool.name).toBe("mcp_docs_weather");
  expect(tool.description).toContain("Read the weather");

  const result = await runTool(tool, { city: "Paris" });
  expect(result.content[0]).toEqual({ type: "text", text: "Sunny" });
  expect(result.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  expect(result.details).toMatchObject({ server: "Docs", tool: "weather" });
});

test("MCP failures reach the model as readable errors", async () => {
  const { fetchImpl } = fakeServer({ failList: true });
  const client = new McpClient(SERVER, fetchImpl);
  await client.connect();
  await expect(client.listTools()).rejects.toThrow(/HTTP 500/);
});

test("MCP tool names stay inside provider limits", () => {
  const name = mcpToolName("docs", "Search Files With A Very Long Descriptive Tool Name Indeed");
  expect(name.length).toBeLessThanOrEqual(64);
  expect(name).toMatch(/^[a-z0-9_]+$/);
});

test("the manager registers tools per server and drops them on removal", async () => {
  const registered = new Map<string, unknown>();
  const manager = new McpManager({
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
    createClient: () => ({
      connect: async () => {},
      listTools: async () => [
        { name: "search", description: "Search docs", inputSchema: { type: "object" } },
      ],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }),
  });
  await manager.sync([SERVER]);
  expect([...registered.keys()]).toEqual(["read_mcp", "mcp_docs_search"]);
  expect(manager.statuses()).toEqual([
    {
      id: "docs",
      name: "Docs",
      url: "https://example.com/mcp",
      enabled: true,
      state: "ready",
      toolCount: 1,
      tools: ["mcp_docs_search"],
    },
  ]);

  await manager.sync([]);
  expect([...registered.keys()]).toEqual(["read_mcp"]);
  expect(manager.statuses()).toEqual([]);
});

test("read_mcp tells the model which servers and tools are available", async () => {
  const registered = new Map<string, ToolRegistration>();
  const manager = new McpManager({
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
    createClient: () => ({
      connect: async () => {},
      listTools: async () => [
        { name: "search", description: "Search docs", inputSchema: { type: "object" } },
      ],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }),
  });
  const readMcp = registered.get("read_mcp");
  expect(readMcp).toBeDefined();

  const empty = await runTool(readMcp!, {});
  expect(text(empty)).toContain("No MCP servers are configured");

  await manager.sync([SERVER]);
  const connected = await runTool(readMcp!, {});
  expect(text(connected)).toContain("Docs (docs), ready, 1 tool");
  expect(text(connected)).toContain("mcp_docs_search");
  expect(text(connected)).toContain("tool_search");
  expect(connected.details).toEqual({ servers: 1, ready: 1 });

  await manager.sync([{ ...SERVER, enabled: false }]);
  expect(text(await runTool(readMcp!, {}))).toContain("Docs (docs), off");
  await manager.dispose();
  expect(registered.size).toBe(0);
});

test("a server that cannot connect reports why and offers nothing", async () => {
  const registered = new Map<string, unknown>();
  const manager = new McpManager({
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
    createClient: () => ({
      connect: async () => {
        throw new Error('MCP server "Docs" answered HTTP 401.');
      },
      listTools: async () => [],
      callTool: async () => ({}),
      close: async () => {},
    }),
  });
  await manager.sync([SERVER]);
  expect([...registered.keys()]).toEqual(["read_mcp"]);
  expect(manager.statuses()[0]).toMatchObject({
    state: "error",
    toolCount: 0,
    tools: [],
    error: 'MCP server "Docs" answered HTTP 401.',
  });
});

test("a disabled server is listed but never connected", async () => {
  let connections = 0;
  const manager = new McpManager({
    register: () => () => {},
    createClient: () => {
      connections += 1;
      return {
        connect: async () => {},
        listTools: async () => [],
        callTool: async () => ({}),
        close: async () => {},
      };
    },
  });
  await manager.sync([{ ...SERVER, enabled: false }]);
  expect(connections).toBe(0);
  expect(manager.statuses()[0]?.state).toBe("disabled");
});
