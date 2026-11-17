import plugin from "../../plugin.json";
import { nativeFetch } from "../platform/nativeHttp";
import type { McpServerConfig } from "./config";

/** A tool as `tools/list` describes it. `inputSchema` is plain JSON Schema. */
export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/** One block of a tool result. MCP servers may send text, images, audio, or resources. */
export type McpContentBlock = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
};

export type McpCallResult = {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
};

type JsonRpcResponse = {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type InitializeResult = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
};

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "acagent", version: plugin.version };
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 300_000;
const LIST_PAGES = 50;

/**
 * Minimal Model Context Protocol client over the Streamable HTTP transport: POST JSON-RPC,
 * accepting a JSON or an SSE response, with the session id the server hands out on `initialize`.
 * Streamable HTTP only; stdio servers need a process this WebView does not have.
 * shortcut: no legacy HTTP+SSE (2024-11-05) transport, add it if a server you need predates Streamable HTTP.
 */
export class McpClient {
  readonly config: McpServerConfig;
  serverInfo?: InitializeResult["serverInfo"];
  #fetch: typeof fetch;
  #sessionId?: string;
  #protocolVersion?: string;
  #nextId = 1;

  constructor(config: McpServerConfig, fetchImpl: typeof fetch = nativeFetch) {
    this.config = config;
    this.#fetch = fetchImpl;
  }

  get label(): string {
    return `MCP server "${this.config.name}"`;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const result = await this.#request<InitializeResult>(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      signal,
      CONNECT_TIMEOUT_MS,
    );
    this.#protocolVersion =
      typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
    this.serverInfo = result.serverInfo;
    await this.#notify("notifications/initialized", undefined, signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES; page++) {
      const result = await this.#request<{ tools?: McpToolDefinition[]; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : {},
        signal,
        CONNECT_TIMEOUT_MS,
      );
      for (const tool of result.tools ?? []) {
        if (!tool || typeof tool.name !== "string" || !tool.name || seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    return await this.#request<McpCallResult>(
      "tools/call",
      { name, arguments: args },
      signal,
      CALL_TIMEOUT_MS,
    );
  }

  /** Best effort: tell the server the session is over, so it can drop anything it kept for it. */
  async close(): Promise<void> {
    const sessionId = this.#sessionId;
    this.#sessionId = undefined;
    if (!sessionId) return;
    try {
      const headers = this.#headers();
      headers.set("Mcp-Session-Id", sessionId);
      await this.#fetch(this.config.url, { method: "DELETE", headers });
    } catch {
      // The session ends on the server's own timeout either way.
    }
  }

  async #notify(
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#post(
      { jsonrpc: "2.0", method, params },
      signal,
      CONNECT_TIMEOUT_MS,
    );
    await response.text().catch(() => "");
  }

  async #request<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, signal, timeoutMs);
    const message = await readMessage(response, id, this.label);
    if (message.error) {
      const detail = message.error.message?.trim() || "unknown error";
      throw new Error(`${this.label} rejected ${method}: ${detail}`);
    }
    return (message.result ?? {}) as T;
  }

  async #post(
    message: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const request = withTimeout(signal, timeoutMs);
    try {
      const response = await this.#fetch(this.config.url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(message),
        signal: request.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.#sessionId = sessionId;
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(httpError(this.label, response.status, detail));
      }
      return response;
    } catch (error) {
      throw request.failure(error) ?? error;
    } finally {
      request.done();
    }
  }

  #headers(): Headers {
    const headers = new Headers(this.config.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (this.#sessionId) headers.set("Mcp-Session-Id", this.#sessionId);
    if (this.#protocolVersion) headers.set("MCP-Protocol-Version", this.#protocolVersion);
    return headers;
  }
}

/** Ties a request's timeout to the tool call's abort signal without needing AbortSignal.any. */
function withTimeout(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
    /** A timeout becomes a readable error; the caller's own abort stays an AbortError. */
    failure: (error: unknown): Error | undefined => {
      if (parent?.aborted) return new DOMException("The operation was aborted.", "AbortError");
      if (!timedOut) return undefined;
      const seconds = Math.round(timeoutMs / 1000);
      return new Error(`The MCP server did not answer within ${seconds} seconds.`, {
        cause: error,
      });
    },
  };
}

async function readMessage(
  response: Response,
  id: number,
  label: string,
): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    for (const data of sseMessages(text)) {
      const found = pickMessage(safeParse(data), id);
      if (found) return found;
    }
    throw new Error(`${label} closed the stream without answering the request.`);
  }
  if (!text.trim()) throw new Error(`${label} returned an empty response.`);
  const payload = safeParse(text);
  if (payload === undefined) throw new Error(`${label} returned invalid JSON: ${snippet(text)}`);
  const found = pickMessage(payload, id);
  if (!found) throw new Error(`${label} answered a different request.`);
  return found;
}

function pickMessage(payload: unknown, id: number): JsonRpcResponse | undefined {
  const candidates = Array.isArray(payload) ? payload : [payload];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const message = item as JsonRpcResponse;
    if (message.id !== id && message.id !== String(id)) continue;
    if (message.error || message.result !== undefined) return message;
  }
  return undefined;
}

/** `data:` payloads of an SSE body, each already joined into one string. */
function sseMessages(text: string): string[] {
  const messages: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) messages.push(data);
  }
  return messages;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function httpError(label: string, status: number, detail: string): string {
  const body = snippet(detail);
  const suffix = body ? `: ${body}` : ".";
  if (status === 401 || status === 403)
    return `${label} refused the request with HTTP ${status}${suffix} Check the server's headers, such as its Authorization token.`;
  if (status === 404)
    return `${label} answered HTTP 404${suffix} Check the URL path, which is often /mcp.`;
  return `${label} answered HTTP ${status}${suffix}`;
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
