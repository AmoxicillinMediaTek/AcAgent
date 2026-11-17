/** One Model Context Protocol server the agent may call tools on. */
export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
};

export type McpServerDraft = {
  id?: string;
  name: string;
  url: string;
  headers?: string | Record<string, string>;
  enabled?: boolean;
};

export const MAX_MCP_SERVERS = 20;

const SERVER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 4_096;
const MAX_URL = 500;

export function slugifyMcpServerId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!slug) return "server";
  return /^[a-z]/.test(slug) ? slug : `s-${slug}`.slice(0, 32);
}

export function allocateMcpServerId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugifyMcpServerId(name);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique MCP server id.");
}

/** Keeps http(s) URLs usable as-is; MCP endpoints often carry a path such as `/mcp`. */
export function normalizeMcpUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (!parsed.hostname) return undefined;
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "") || undefined;
}

export function sanitizeMcpHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  let count = 0;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_HEADERS) break;
    if (!HEADER_NAME.test(name) || typeof raw !== "string") continue;
    const header = raw.trim();
    if (!header || header.length > MAX_HEADER_VALUE || /[\r\n]/.test(header)) continue;
    headers[name] = header;
    count += 1;
  }
  return headers;
}

/** Headers as typed in the settings form: a JSON object, or blank for none. */
export function parseMcpHeadersText(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Headers must be a JSON object, for example {"Authorization": "Bearer …"}.');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error('Headers must be a JSON object, for example {"Authorization": "Bearer …"}.');
  const headers = sanitizeMcpHeaders(parsed);
  if (Object.keys(headers).length !== Object.keys(parsed).length)
    throw new Error(
      "Some headers were rejected: names may only use letters, digits and dashes, values one line each.",
    );
  return headers;
}

export function sanitizeMcpServer(
  value: unknown,
  taken: Iterable<string> = [],
): McpServerConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim().slice(0, 80) : "";
  const url = typeof record.url === "string" ? normalizeMcpUrl(record.url) : undefined;
  if (!name || !url) return undefined;
  const existingId = typeof record.id === "string" ? record.id.trim().toLowerCase() : undefined;
  if (existingId && !SERVER_ID.test(existingId)) return undefined;
  const id =
    existingId && ![...taken].includes(existingId) ? existingId : allocateMcpServerId(name, taken);
  return {
    id,
    name,
    url,
    headers: sanitizeMcpHeaders(record.headers),
    enabled: record.enabled !== false,
  };
}

export function sanitizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const servers: McpServerConfig[] = [];
  const taken: string[] = [];
  for (const item of value) {
    if (servers.length >= MAX_MCP_SERVERS) break;
    const server = sanitizeMcpServer(item, taken);
    if (!server) continue;
    taken.push(server.id);
    servers.push(server);
  }
  return servers;
}

export function finalizeMcpServer(
  draft: McpServerDraft,
  existing: readonly McpServerConfig[],
): McpServerConfig {
  const name = draft.name.trim().slice(0, 80);
  if (!name) throw new Error("Enter a name for this MCP server.");
  const url = normalizeMcpUrl(draft.url);
  if (!url) throw new Error("Enter the server's http(s) URL, for example https://example.com/mcp");
  const current = draft.id ? existing.find((server) => server.id === draft.id) : undefined;
  if (draft.id && !current) throw new Error("That MCP server no longer exists.");
  const taken = existing.filter((server) => server.id !== draft.id).map((server) => server.id);
  const id = current?.id ?? allocateMcpServerId(name, taken);
  const headers =
    typeof draft.headers === "string"
      ? parseMcpHeadersText(draft.headers)
      : sanitizeMcpHeaders(draft.headers ?? current?.headers ?? {});
  return {
    id,
    name,
    url,
    headers,
    enabled: draft.enabled ?? current?.enabled ?? true,
  };
}

export function upsertMcpServer(
  existing: readonly McpServerConfig[],
  server: McpServerConfig,
): McpServerConfig[] {
  const next = existing.filter((item) => item.id !== server.id);
  next.unshift(server);
  return next.slice(0, MAX_MCP_SERVERS);
}

export function sameMcpServer(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.url === b.url &&
    a.enabled === b.enabled &&
    sameHeaders(a.headers, b.headers)
  );
}

function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every((name) => a[name] === b[name]);
}
