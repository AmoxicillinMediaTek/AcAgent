import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolExposure } from "../tools/toolSearch";
import { McpClient, type McpCallResult, type McpToolDefinition } from "./client";
import { sameMcpServer, type McpServerConfig } from "./config";
import { createMcpTool, createReadMcpTool, mcpToolName } from "./tools";

export type McpServerState = "disabled" | "connecting" | "ready" | "error";

export type McpServerStatus = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  state: McpServerState;
  toolCount: number;
  /** Names the model calls them by, once the server answered `tools/list`. */
  tools: string[];
  error?: string;
};

/** The part of `McpClient` the manager needs, so tests can stand in for a server. */
export type McpClientLike = {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
};

export type McpManagerOptions = {
  register: (tool: ToolRegistration, options?: { exposure?: ToolExposure }) => () => void;
  onChange?: (statuses: McpServerStatus[]) => void;
  createClient?: (config: McpServerConfig) => McpClientLike;
};

type Connection = {
  config: McpServerConfig;
  client: McpClientLike;
  disposers: Array<() => void>;
};

/**
 * Keeps one connection per enabled server in step with the settings. Tools are registered through
 * `register`, so they appear in running chats as soon as a server answers `tools/list`.
 */
export class McpManager {
  #options: McpManagerOptions;
  #connections = new Map<string, Connection>();
  #statuses = new Map<string, McpServerStatus>();
  #order: string[] = [];
  #queue: Promise<void> = Promise.resolve();
  #lastEmitted = "";
  #disposed = false;
  #disposeReadTool?: () => void;

  constructor(options: McpManagerOptions) {
    this.#options = options;
    try {
      this.#disposeReadTool = options.register(createReadMcpTool(() => this.statuses()));
    } catch {
      // A name clash only costs the model its direct view of MCP state.
    }
  }

  /** Connects new servers, reconnects changed ones, and disconnects the rest. Calls queue up. */
  sync(configs: readonly McpServerConfig[]): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const run = this.#queue.then(() => this.#sync(configs));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Drops a connection so the next sync tries the server again, for example after an error. */
  retry(id: string, configs: readonly McpServerConfig[]): Promise<void> {
    this.#drop(id);
    this.#statuses.delete(id);
    return this.sync(configs);
  }

  statuses(): McpServerStatus[] {
    return this.#order
      .map((id) => this.#statuses.get(id))
      .filter((status): status is McpServerStatus => Boolean(status));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposeReadTool?.();
    this.#disposeReadTool = undefined;
    const run = this.#queue.then(() => {
      for (const id of this.#connections.keys()) this.#drop(id);
      this.#statuses.clear();
      this.#order = [];
      this.#emit();
    });
    this.#queue = run.catch(() => undefined);
    await run;
  }

  async #sync(configs: readonly McpServerConfig[]): Promise<void> {
    this.#order = configs.map((config) => config.id);
    for (const id of this.#statuses.keys())
      if (!this.#order.includes(id)) this.#statuses.delete(id);

    for (const [id, connection] of this.#connections) {
      const config = configs.find((item) => item.id === id);
      if (!config || !config.enabled || !sameMcpServer(connection.config, config)) this.#drop(id);
    }

    for (const config of configs) {
      if (this.#connections.has(config.id)) continue;
      this.#statuses.set(config.id, {
        id: config.id,
        name: config.name,
        url: config.url,
        enabled: config.enabled,
        state: config.enabled ? "connecting" : "disabled",
        toolCount: 0,
        tools: [],
      });
    }
    this.#emit();

    for (const config of configs) {
      if (!config.enabled || this.#connections.has(config.id)) continue;
      await this.#connect(config);
    }
    this.#emit();
  }

  async #connect(config: McpServerConfig): Promise<void> {
    const client = this.#options.createClient?.(config) ?? new McpClient(config);
    try {
      await client.connect();
      const tools = await client.listTools();
      const used = new Set<string>();
      const disposers: Array<() => void> = [];
      const names: string[] = [];
      for (const tool of tools) {
        const name = uniqueToolName(config.id, tool.name, used);
        if (!name) continue;
        try {
          disposers.push(
            this.#options.register(createMcpTool(client, config, tool, name), {
              exposure: "deferred",
            }),
          );
          names.push(name);
        } catch {
          // Another extension already owns that name; the rest of the server's tools still load.
        }
      }
      this.#connections.set(config.id, { config, client, disposers });
      this.#statuses.set(config.id, {
        id: config.id,
        name: config.name,
        url: config.url,
        enabled: true,
        state: "ready",
        toolCount: names.length,
        tools: names,
      });
    } catch (error) {
      void client.close();
      this.#statuses.set(config.id, {
        id: config.id,
        name: config.name,
        url: config.url,
        enabled: true,
        state: "error",
        toolCount: 0,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #drop(id: string): void {
    const connection = this.#connections.get(id);
    if (!connection) return;
    this.#connections.delete(id);
    for (const dispose of connection.disposers) dispose();
    void connection.client.close();
  }

  #emit(): void {
    const statuses = this.statuses();
    const serialized = JSON.stringify(statuses);
    if (serialized === this.#lastEmitted) return;
    this.#lastEmitted = serialized;
    this.#options.onChange?.(statuses);
  }
}

/** Sanitized names can collide (`a b` and `a_b`); a numeric suffix keeps them distinct. */
function uniqueToolName(serverId: string, toolName: string, used: Set<string>): string | undefined {
  const base = mcpToolName(serverId, toolName);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  return undefined;
}
