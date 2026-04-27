/**
 * Test-server helper (Step 2.5)
 *
 * Spawns an in-process headless twin on a random port for tests that need
 * the HTTP surface. Much lighter than the Electron app and avoids
 * collisions on the production :8222.
 *
 * Usage:
 *   const srv = await createTestServer();
 *   const res = await fetch(`${srv.baseUrl}/state`);
 *   await srv.close();
 *
 * Random port picks: the OS assigns one via `port: 0`. The helper
 * remembers the resolved port in `srv.port` and `srv.baseUrl`.
 *
 * The built headless server (`dist/headless/server.js`) is required at
 * runtime so we exercise the same code path the production binary does.
 * Prerequisite: `npm run build` must have run at least once, same as the
 * in-process helper.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startHeadlessServer } = require("../../dist/headless/server");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createFallbackDeckLayout } = require("../../dist/twin/deck");

export interface TestServer {
  /** Resolved port the HTTP server is listening on. */
  readonly port: number;
  /** Convenience: `http://localhost:<port>`. */
  readonly baseUrl: string;
  /** GET helper returning parsed JSON. Throws on non-2xx. */
  get(path: string): Promise<any>;
  /** POST helper returning parsed JSON. Body is JSON.stringify'd. */
  post(path: string, body?: unknown): Promise<any>;
  /** Tear down HTTP server, SSE broker, and timers. */
  close(): Promise<void>;
}

export interface CreateTestServerOptions {
  layoutPath?: string | null;
  venusRoot?: string | null;
  tracePath?: string | null;
  staticDir?: string | null;
  /** Default true — most tests assert against a ready twin. */
  autoInit?: boolean;
}

/**
 * Bring up a fresh headless server on a random port. Resolves once the
 * server is listening; return value includes a `close()` to tear it down.
 */
export async function createTestServer(
  options: CreateTestServerOptions = {}
): Promise<TestServer> {
  // Pin the predictable-IDs fallback deck (TIP001/SMP001/...) when the
  // caller didn't request a specific layout. Without this, the headless
  // server's `setupServer` lets the twin call `createDefaultDeckLayout()`
  // which prefers the baked Method1.lay from a Hamilton install — those
  // carrier IDs are auto-generated and don't match what tests assert
  // against (e.g. `wellXY("SMP001", ...)`).
  const fallbackDeck = options.layoutPath ? undefined : createFallbackDeckLayout();
  const srv = await startHeadlessServer({
    port: 0, // 0 → OS picks a free port
    staticDir: options.staticDir ?? null,
    layoutPath: options.layoutPath,
    venusRoot: options.venusRoot,
    tracePath: options.tracePath,
    autoInit: options.autoInit !== false,
    deck: fallbackDeck,
  });

  // Use 127.0.0.1 explicitly — on Windows, `localhost` resolves to ::1
  // (IPv6) first, and Node's default listen() on port 0 may bind to the
  // IPv4 interface only, producing EADDRNOTAVAIL on fetch.
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  async function get(urlPath: string): Promise<any> {
    const r = await fetch(`${baseUrl}${urlPath}`);
    if (!r.ok) throw new Error(`GET ${urlPath} → ${r.status} ${await r.text()}`);
    return r.json();
  }

  async function post(urlPath: string, body: unknown = {}): Promise<any> {
    const r = await fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${urlPath} → ${r.status} ${await r.text()}`);
    return r.json();
  }

  return {
    port: srv.port,
    baseUrl,
    get,
    post,
    close: () => srv.close(),
  };
}
