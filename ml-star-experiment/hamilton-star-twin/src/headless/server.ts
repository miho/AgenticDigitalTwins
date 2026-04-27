/**
 * Headless twin server (Step 2.4)
 *
 * Pure Node entry point — no Electron dependency. Starts the same HTTP
 * surface the Electron app exposes, but skips window creation. Used for:
 *   - `npm run server` (production headless mode)
 *   - `tests/helpers/test-server.ts` (integration tests on a random port)
 *   - Docker / CI deployments that don't want a GUI stack
 *
 * CLI flags (same as the Electron entry):
 *   --layout <path>        Pre-load a VENUS .lay file
 *   --venus-root <path>    Search root for referenced labware
 *   --venus-cfg <path>     Parse an ML_STAR.cfg at startup so the twin
 *                          adopts its instrument identity + module bits
 *                          (xt/xa tracks, ka, xw, bdc_modulenumber, …).
 *   --trace <path>         Pre-load a trace file for /replay/*
 *   --port <n>             HTTP port (default 8222; falls back if busy)
 *   --no-static            Skip static file serving (pure API mode)
 *
 * VENUS bridge flags:
 *   --venus-bridge         Start FW TCP server + BDZ discovery
 *   --fw-port <n>          FW command TCP port (default 9999, same
 *                          port VENUS calls its FDx device-controller
 *                          port — accepts `--fdx-port` as alias)
 *   --bridge-host <host>   Bind address for bridge + discovery (default 0.0.0.0)
 *   --no-discovery         Disable UDP+TCP discovery (FW still runs)
 *   --sim-speed <n>        Command-timing multiplier (1=real, 0=instant)
 *   --instrument <name>    bdc_systemid shown in VENUS picker
 *   --serial <n>           bdc_modulenumber
 *   --twin-ip <ip>         bdc_ipaddress override (else autodetect)
 */

import * as path from "path";
import { setupServer, startHttpServer, VenusBridgeOptions } from "../api/server-setup";
import type { Deck } from "../twin/deck";

export interface HeadlessOptions {
  layoutPath?: string | null;
  venusRoot?: string | null;
  /** Path to an ML_STAR.cfg to read for VENUS identity + module bits. */
  venusCfgPath?: string | null;
  tracePath?: string | null;
  port?: number;
  /** Absolute path to static renderer assets. Null or undefined → none. */
  staticDir?: string | null;
  /** VENUS bridge config — omit to disable the bridge. */
  venusBridge?: VenusBridgeOptions | null;
  /** Pre-initialize the twin at startup. Defaults to `false`, matching
   *  the real STAR boot state (VENUS drives init, or the UI's "Init
   *  All" button does it). Tests opt in with `autoInit: true`. */
  autoInit?: boolean;
  /** Pre-built deck. Used by tests to pin the predictable-IDs fallback
   *  deck so they don't bind to whatever Hamilton install the dev
   *  machine has on disk. Ignored when `layoutPath` is set. */
  deck?: Deck;
}

export interface HeadlessServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Programmatic entry — preferred from tests. Returns once the server is
 * listening with the resolved port and a close() handle.
 */
export async function startHeadlessServer(options: HeadlessOptions = {}): Promise<HeadlessServer> {
  const setup = setupServer({
    layoutPath: options.layoutPath,
    venusRoot: options.venusRoot,
    venusCfgPath: options.venusCfgPath,
    tracePath: options.tracePath,
    staticDir: options.staticDir,
    venusBridge: options.venusBridge ?? null,
    autoInit: options.autoInit,
    deck: options.deck,
  });

  const { server, port } = await startHttpServer(
    setup.handler,
    options.port ?? 8222,
    (resolved) => {
      console.log(`Hamilton STAR Digital Twin (headless): http://localhost:${resolved}/`);
    }
  );

  // If the VENUS bridge is enabled, wait for it to bind before returning.
  // Callers (tests, real users) then know the FDx port is live.
  if (setup.venusBridgeReady) {
    await setup.venusBridgeReady;
  }

  return {
    port,
    async close() {
      await setup.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function parseCli(argv: string[]): HeadlessOptions {
  const opts: HeadlessOptions = {};
  const args = argv.slice(2);
  let skipStatic = false;
  let bridgeEnabled = false;
  const bridge: VenusBridgeOptions = {};
  const identity: NonNullable<VenusBridgeOptions["identity"]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--layout" && args[i + 1]) { opts.layoutPath = args[++i]; continue; }
    if (a === "--venus-root" && args[i + 1]) { opts.venusRoot = args[++i]; continue; }
    if (a === "--venus-cfg" && args[i + 1]) { opts.venusCfgPath = args[++i]; continue; }
    if (a === "--trace" && args[i + 1]) { opts.tracePath = args[++i]; continue; }
    if (a === "--port" && args[i + 1]) { opts.port = Number(args[++i]); continue; }
    if (a === "--no-static") { skipStatic = true; continue; }

    // VENUS bridge flags
    if (a === "--venus-bridge") { bridgeEnabled = true; continue; }
    if (a === "--no-discovery") { bridgeEnabled = true; bridge.discovery = false; continue; }
    if ((a === "--fw-port" || a === "--fdx-port") && args[i + 1]) { bridgeEnabled = true; bridge.fwPort = Number(args[++i]); continue; }
    if (a === "--bridge-host" && args[i + 1]) { bridgeEnabled = true; bridge.host = args[++i]; continue; }
    if (a === "--sim-speed" && args[i + 1]) { bridgeEnabled = true; bridge.simSpeed = Number(args[++i]); continue; }
    if (a === "--discovery-port" && args[i + 1]) { bridgeEnabled = true; bridge.discoveryPort = Number(args[++i]); continue; }
    if (a === "--hamsmart-port" && args[i + 1]) { bridgeEnabled = true; bridge.hamSmartPort = Number(args[++i]); continue; }
    if (a === "--instrument" && args[i + 1]) { bridgeEnabled = true; identity.instrumentId = args[++i]; continue; }
    if (a === "--serial" && args[i + 1]) { bridgeEnabled = true; identity.moduleId = args[++i]; continue; }
    if (a === "--twin-ip" && args[i + 1]) { bridgeEnabled = true; identity.ipAddress = args[++i]; continue; }
  }
  if (!skipStatic) {
    // Default: serve the renderer directory that ships alongside this file.
    // When built, this lands at dist/headless/server.js, so the renderer is
    // at ../renderer relative to this file.
    opts.staticDir = path.join(__dirname, "..", "renderer");
  }
  if (bridgeEnabled) {
    if (Object.keys(identity).length > 0) bridge.identity = identity;
    opts.venusBridge = bridge;
  }
  return opts;
}

// --- CLI entry ---
// When executed directly (`node dist/headless/server.js`), start the server.
// When imported from another module (tests), do nothing — callers drive
// the server through `startHeadlessServer(...)`.
if (require.main === module) {
  startHeadlessServer(parseCli(process.argv)).catch((err) => {
    console.error("Headless server failed to start:", err);
    process.exit(1);
  });
}
