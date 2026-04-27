#!/usr/bin/env node
/**
 * Hamilton STAR Digital Twin MCP Bridge
 *
 * Thin stdio→HTTP proxy. Does NOT own a twin. Every tool call is forwarded
 * to a running twin's REST surface at /api/mcp/list and /api/mcp/call, so
 * stdio-only MCP clients (Claude Desktop, Claude Code, LM Studio, Codex)
 * end up driving the same twin you can see in Electron or the headless
 * method editor.
 *
 * Twin selection:
 *   - HAMILTON_TWIN_URL env pins the twin (wins over discovery).
 *   - Otherwise probe localhost on the twin's port-fallback range at
 *     startup and pick the first one that answers /api/mcp/list.
 *   - The `connect_twin` tool switches the active twin at runtime.
 *
 * Usage:
 *   node dist/index.js                          # default discovery
 *   HAMILTON_TWIN_URL=http://host:8222 node dist/index.js
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Twin listens on 8222 by default, with port fallback if busy.
const PROBE_PORTS = [8222, 8223, 8224, 8225, 8226];
const PROBE_TIMEOUT_MS = 750;
const CALL_TIMEOUT_MS = 60_000;

interface TwinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ReachableTwin {
  url: string;
  toolCount: number;
}

let activeTwin: string | null = null;

function candidateUrls(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (u: string | undefined) => {
    if (!u) return;
    const trimmed = u.replace(/\/$/, "");
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  add(process.env.HAMILTON_TWIN_URL);
  for (const p of PROBE_PORTS) add(`http://localhost:${p}`);
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeTwin(url: string): Promise<ReachableTwin | null> {
  try {
    const r = await fetchWithTimeout(`${url}/api/mcp/list`, {}, PROBE_TIMEOUT_MS);
    if (!r.ok) return null;
    const tools = (await r.json()) as unknown;
    const count = Array.isArray(tools) ? tools.length : 0;
    return { url, toolCount: count };
  } catch {
    return null;
  }
}

async function discoverTwins(): Promise<ReachableTwin[]> {
  const results = await Promise.all(candidateUrls().map(probeTwin));
  return results.filter((x): x is ReachableTwin => x !== null);
}

async function listTwinTools(url: string): Promise<TwinTool[]> {
  const r = await fetchWithTimeout(`${url}/api/mcp/list`, {}, PROBE_TIMEOUT_MS);
  if (!r.ok) throw new Error(`twin /api/mcp/list returned ${r.status}`);
  const tools = (await r.json()) as TwinTool[];
  return Array.isArray(tools) ? tools : [];
}

async function callTwinTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetchWithTimeout(
    `${url}/api/mcp/call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    },
    CALL_TIMEOUT_MS,
  );
  const body = (await r.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!r.ok || !body || body.error !== undefined) {
    const msg = body?.error ?? `HTTP ${r.status}`;
    throw new Error(`twin tool ${name}: ${msg}`);
  }
  return body.result;
}

// ---------------------------------------------------------------------------
// Meta-tools — served by the bridge itself.
// ---------------------------------------------------------------------------

const META_TOOLS: TwinTool[] = [
  {
    name: "list_twins",
    description:
      "Discover running Hamilton STAR digital twins on localhost (HAMILTON_TWIN_URL + ports 8222-8226). Returns each reachable twin's URL and tool count. Use this when you don't know which twin to drive.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "connect_twin",
    description:
      "Point this bridge at a specific twin. Subsequent tool calls forward there. Pass e.g. 'http://localhost:8222'. Rejects a URL whose /api/mcp/list doesn't answer.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Twin base URL, e.g. http://localhost:8222" },
      },
    },
  },
  {
    name: "current_twin",
    description: "Return the currently connected twin URL (or null if none).",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function handleMetaTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "list_twins": {
      const twins = await discoverTwins();
      return textResult({ twins, active: activeTwin });
    }
    case "current_twin": {
      return textResult({ url: activeTwin });
    }
    case "connect_twin": {
      const url = String(args.url ?? "").replace(/\/$/, "");
      if (!url) return errorResult("connect_twin: missing 'url'");
      const probe = await probeTwin(url);
      if (!probe) return errorResult(`connect_twin: no twin answered at ${url}`);
      activeTwin = url;
      return textResult({ connected: url, toolCount: probe.toolCount });
    }
    default:
      return errorResult(`unknown meta tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server wiring.
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "hamilton-star-twin-bridge", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: TwinTool[] = [...META_TOOLS];
  if (activeTwin) {
    try {
      const twinTools = await listTwinTools(activeTwin);
      tools.push(...twinTools);
    } catch (err: any) {
      // Twin went away — surface an error tool so the agent sees the cause.
      console.error(`[hamilton-star-mcp] active twin ${activeTwin} unreachable: ${err?.message ?? err}`);
      activeTwin = null;
    }
  }
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (META_TOOLS.some((t) => t.name === name)) {
      return await handleMetaTool(name, args);
    }
    if (!activeTwin) {
      return errorResult(
        "No twin connected. Call list_twins to see reachable ones, then connect_twin with a URL. " +
          "Start the Electron app or `run-editor.bat` if nothing is listed.",
      );
    }
    const result = await callTwinTool(activeTwin, name, args);
    return textResult(result);
  } catch (err: any) {
    return errorResult(`Error: ${err?.message ?? String(err)}`);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

async function main() {
  const twins = await discoverTwins();
  if (twins.length > 0) {
    activeTwin = twins[0].url;
    console.error(
      `[hamilton-star-mcp] connected to ${activeTwin} (${twins[0].toolCount} tools). ` +
        `${twins.length > 1 ? `Other twins: ${twins.slice(1).map((t) => t.url).join(", ")}. ` : ""}` +
        `Use list_twins / connect_twin to switch.`,
    );
  } else {
    console.error(
      `[hamilton-star-mcp] no twin reachable yet. Tried: ${candidateUrls().join(", ")}. ` +
        `Start Electron or run-editor.bat, then call connect_twin.`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[hamilton-star-mcp] stdio bridge ready");
}

main().catch((err) => {
  console.error(`[hamilton-star-mcp] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
