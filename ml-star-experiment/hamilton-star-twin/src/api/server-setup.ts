/**
 * Shared server setup (Step 2.4)
 *
 * Wires the twin API + SSE broker + replay service + REST handler into a
 * single composed unit. Used by both the Electron main entry point and
 * the headless Node entry point, so they can't drift.
 *
 * The function creates fresh instances every call — callers that run
 * multiple twins (tests) get isolated state; the production entry points
 * call it exactly once on startup.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { DigitalTwinAPI } from "../twin/api";
import { Deck } from "../twin/deck";
import { importVenusLayout, defaultLabwareSearchPaths } from "../twin/venus-layout";
import { buildVenusConfig, parseHxCfgSections } from "../twin/venus-config";
import { SseBroker } from "./sse-broker";
import { ReplayService } from "../services/replay-service";
import { TraceReplayService } from "../services/trace-replay-service";
import { createRestHandler } from "./rest-api";
import { FwServer } from "../services/bdz-bridge/fw-server";
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_FW_PORT,
  DEFAULT_HAMSMART_PORT,
  DiscoveryIdentity,
  DiscoveryServiceHandle,
  defaultIdentity,
  startDiscoveryService,
} from "../services/bdz-bridge/discovery-server";

export interface ServerSetupOptions {
  /** Absolute path to a VENUS .lay file. Loaded if provided. */
  layoutPath?: string | null;
  /** Absolute path to the VENUS install root (for labware resolution). */
  venusRoot?: string | null;
  /** Absolute path to a VENUS `ML_STAR.cfg`. Parsed at startup; fields
   *  the twin advertises over FW (C0QM/C0RM/C0RI) pick up values from
   *  here on top of what's inferred from the deck. */
  venusCfgPath?: string | null;
  /** Explicit VENUS-config overrides applied after deck inference and
   *  cfg-file parsing. Usually populated from CLI flags (`--serial`,
   *  `--firmware`, etc.). */
  venusConfigOverrides?: Partial<import("../twin/venus-config").VenusConfig>;
  /** Absolute path to a trace file to pre-load for replay. */
  tracePath?: string | null;
  /** Absolute path to static assets to serve. Pass null for pure-API mode. */
  staticDir?: string | null;
  /**
   * Device name stored in device info. Defaults to "STAR Primary". Tests
   * override to keep different device instances distinguishable.
   */
  deviceName?: string;
  /**
   * Auto-run C0VI/C0DI/C0EI/C0II after device creation. Default
   * **false** — a real STAR boots into `not_initialized`, and VENUS
   * (or the UI's "Init All" button) is expected to drive the init
   * cycle. Starting the twin pre-initialized makes VENUS's C0VI/C0II
   * calls return error 15 "Not allowed parameter combination".
   * Tests that assume a ready twin pass `autoInit: true`.
   */
  autoInit?: boolean;
  /**
   * Optional logger. Defaults to console.log; tests pass a no-op.
   */
  log?: (msg: string) => void;
  /**
   * VENUS bridge — enables the FDx TCP server + BDZ discovery service
   * so a real VENUS install can connect to the twin. Off by default so
   * `npm test` and casual headless runs don't bind to privileged-ish
   * network ports or answer broadcasts.
   */
  venusBridge?: VenusBridgeOptions | null;
}

/**
 * VENUS-compatible bridge configuration. When passed, setupServer starts
 * both the FDx TCP server (the payload channel) and the BDZ discovery
 * service (UDP responder + TCP hamsmart enumerator) so the twin shows
 * up in VENUS's instrument picker and accepts FDx commands.
 */
export interface VenusBridgeOptions {
  /** TCP port the FDx server binds to. Defaults to 9999. */
  fwPort?: number;
  /** Bind host for all three listeners. Defaults to 0.0.0.0 so remote
   *  VENUS instances can reach the twin. */
  host?: string;
  /**
   * Simulation speed passed through to FwServer. 1 = real hardware
   * timing, 100 = 100× faster, 0 = no delay. See bdz-bridge/fw-server.ts.
   */
  simSpeed?: number;
  /** UDP port for HAMILTON_BROADCAST. Defaults to 34569. */
  discoveryPort?: number;
  /** TCP port for R_GETDEVICELIST. Defaults to 34567. */
  hamSmartPort?: number;
  /** Set to false to skip the discovery half entirely (FW server still runs). */
  discovery?: boolean;
  /** Override fields VENUS shows in the instrument picker. */
  identity?: Partial<DiscoveryIdentity>;
}

export interface ServerSetup {
  api: DigitalTwinAPI;
  activeDeviceId: string;
  broker: SseBroker;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replay: ReplayService<any>;
  /** Phase 3 trace replay + fork service (new, distinct from `replay`). */
  traceReplay: TraceReplayService;
  /** Top-level request handler — pass to http.createServer. */
  handler: http.RequestListener;
  /** FDx TCP server when the VENUS bridge is enabled, else null. */
  fwServer: FwServer | null;
  /** Discovery service handle when enabled, else null. */
  discovery: DiscoveryServiceHandle | null;
  /**
   * Tear down all timers, SSE connections, and VENUS-bridge listeners.
   * The caller owns the HTTP server and closes it separately.
   */
  dispose: () => Promise<void>;
}

/** The four init commands the twin needs after construction. */
const INIT_COMMANDS = ["C0VIid9999", "C0DIid9998", "C0EIid9997", "C0IIid9996"];

/**
 * Build a full service composition. Returns everything the HTTP layer
 * needs plus a dispose() to tear it down.
 *
 * Note: when `venusBridge` is set, setupServer returns synchronously
 * with `fwServer`/`discovery` initialised to null; the actual TCP/UDP
 * listeners bind asynchronously and are filled in on the returned
 * handle once they're ready. Callers that must wait for the bridge to
 * be live should `await setup.venusBridgeReady` (undefined when the
 * bridge is disabled).
 */
export function setupServer(options: ServerSetupOptions = {}): ServerSetup & { venusBridgeReady?: Promise<void> } {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const api = new DigitalTwinAPI();

  // Optional VENUS layout
  let deck: Deck | undefined;
  if (options.layoutPath) {
    try {
      const searchPaths = options.venusRoot ? defaultLabwareSearchPaths(options.venusRoot) : [];
      searchPaths.unshift(path.dirname(options.layoutPath));
      const result = importVenusLayout(options.layoutPath, searchPaths);
      deck = result.deck;
      log(`Layout loaded: ${path.basename(options.layoutPath)} — ${result.carriers} carriers, ${result.labware} labware`);
    } catch (e: any) {
      log(`Failed to load layout: ${e.message}`);
    }
  }

  const activeDeviceId = api.createDevice({ name: options.deviceName ?? "STAR Primary", deck });

  // VENUS config — layer cfg-file values + explicit overrides on top of
  // the deck-derived defaults the twin already built in its constructor.
  // Runs even when `venusCfgPath` is absent so CLI overrides alone
  // (e.g. `--serial`) still take effect. Config is opt-in (explicit
  // `--venus-cfg` or the File-menu loader) — we don't auto-assume the
  // locally-installed ML_STAR.cfg is the one the user wants to match,
  // since dev / QA machines often have a different cfg than the STAR
  // being driven.
  if (options.venusCfgPath || options.venusConfigOverrides) {
    try {
      let cfgSections: Map<string, Map<string, string>> | undefined;
      if (options.venusCfgPath) {
        if (!fs.existsSync(options.venusCfgPath)) {
          log(`VENUS config not found: ${options.venusCfgPath}`);
        } else {
          cfgSections = parseHxCfgSections(fs.readFileSync(options.venusCfgPath, "utf-8"));
        }
      }
      // Start from the twin's current (deck-derived) config and layer
      // cfg-file + overrides on top.
      const current = api.getVenusConfig(activeDeviceId);
      const merged = buildVenusConfig({
        cfgSections,
        overrides: { ...current, ...options.venusConfigOverrides },
      });
      api.setVenusConfig(activeDeviceId, merged);
      if (options.venusCfgPath) {
        log(`VENUS cfg loaded: ${path.basename(options.venusCfgPath)} (ka=0x${merged.moduleBits.toString(16)} xt=${merged.totalTracks} sn=${merged.serial})`);
      }
    } catch (e: any) {
      log(`Failed to apply VENUS config: ${e.message}`);
    }
  }

  // Default: do NOT pre-initialize. A real STAR boots into
  // `not_initialized` and VENUS / the UI's "Init All" button is
  // expected to drive init. Tests can opt in with `autoInit: true`.
  if (options.autoInit === true) {
    for (const cmd of INIT_COMMANDS) api.sendCommand(activeDeviceId, cmd);
    api.flushPendingEvents(activeDeviceId);
  }

  const broker = new SseBroker();
  const replay = new ReplayService({
    sendCommand: (raw: string) => api.sendCommand(activeDeviceId, raw),
    flushPending: () => api.flushPendingEvents(activeDeviceId),
    resetAndInit: () => {
      api.resetDevice(activeDeviceId);
      for (const cmd of INIT_COMMANDS) api.sendCommand(activeDeviceId, cmd);
      api.flushPendingEvents(activeDeviceId);
    },
  });

  // Pre-load the trace if a path was supplied. Keeps the old behaviour
  // where passing --trace on the CLI makes the trace available at startup.
  if (options.tracePath) {
    try {
      if (fs.existsSync(options.tracePath)) {
        replay.loadFromFile(options.tracePath);
        log(`Trace loaded: ${path.basename(options.tracePath)} — ${replay.getInfo().total} commands`);
      } else {
        log(`Trace file not found: ${options.tracePath}`);
      }
    } catch (e: any) {
      log(`Failed to load trace: ${e.message}`);
    }
  }

  // Forward async twin events onto the SSE broker so live clients see
  // state/assessment/device-event pushes without polling.
  api.onEvent((event) => {
    // Server-wide events (settings_change) have no deviceId — let them
    // through regardless of which device is active.
    if (event.type === "settings_change") {
      broker.broadcast("settings-changed", event.data);
      return;
    }
    if (event.deviceId !== activeDeviceId) return;
    if (event.type === "state_change") {
      broker.broadcast("state-changed", api.getState(activeDeviceId));
    }
    if (event.type === "assessment") {
      broker.broadcast("assessment", event.data);
    }
    if (event.type === "device_event") {
      broker.broadcast("device-event", event.data);
    }
    if (event.type === "motion") {
      // Arm motion envelope — renderer interpolates during the travel so the
      // arm doesn't snap to its final position at the end of the command.
      broker.broadcast("motion", event.data);
    }
  });

  const traceReplay = new TraceReplayService();

  const handler = createRestHandler({
    api,
    getActiveDeviceId: () => activeDeviceId,
    broker,
    replay,
    traceReplay,
    staticDir: options.staticDir ?? null,
  });

  // --- VENUS bridge wiring ---------------------------------------------
  // `venusBridge` is opt-in. When set, we start the FDx payload server
  // and (unless explicitly disabled) the BDZ discovery service. Both
  // listeners bind asynchronously; the handle exposes a
  // `venusBridgeReady` promise so callers that need the bridge live
  // (e.g. the headless CLI printing the port) can await it.
  const bridge = { fwServer: null as FwServer | null, discovery: null as DiscoveryServiceHandle | null };
  let venusBridgeReady: Promise<void> | undefined;
  if (options.venusBridge) {
    venusBridgeReady = startVenusBridge(api, () => activeDeviceId, options.venusBridge, log, broker)
      .then((started) => {
        bridge.fwServer = started.fwServer;
        bridge.discovery = started.discovery;
      })
      .catch((err) => {
        log(`VENUS bridge failed to start: ${err?.message ?? err}`);
      });
  }

  const dispose = async () => {
    replay.dispose();
    traceReplay.dispose();
    broker.closeAll();
    const closers: Promise<unknown>[] = [];
    if (bridge.fwServer) closers.push(bridge.fwServer.close());
    if (bridge.discovery) closers.push(bridge.discovery.close());
    if (closers.length > 0) await Promise.allSettled(closers);
  };

  const setup: ServerSetup & { venusBridgeReady?: Promise<void> } = {
    api,
    activeDeviceId,
    broker,
    replay,
    traceReplay,
    handler,
    get fwServer() { return bridge.fwServer; },
    get discovery() { return bridge.discovery; },
    dispose,
  };
  if (venusBridgeReady) setup.venusBridgeReady = venusBridgeReady;
  return setup;
}

/**
 * Bring up the FDx server + discovery service. Returned pair is
 * attached to the ServerSetup once both listeners are bound.
 */
async function startVenusBridge(
  api: DigitalTwinAPI,
  getActiveDeviceId: () => string,
  cfg: VenusBridgeOptions,
  log: (msg: string) => void,
  broker: SseBroker,
): Promise<{ fwServer: FwServer; discovery: DiscoveryServiceHandle | null }> {
  const host = cfg.host ?? "0.0.0.0";
  const fwPort = cfg.fwPort ?? DEFAULT_FW_PORT;

  const fwServer = new FwServer({
    api,
    getActiveDeviceId,
    host,
    port: fwPort,
    simSpeed: cfg.simSpeed ?? 1,
    log: (msg) => log(msg),
    // Mirror every VENUS-driven command onto the same SSE channels the
    // UI uses for the built-in command panel, so the renderer's log
    // view reflects real-VENUS traffic.
    onCommand: ({ raw, result }) => {
      broker.broadcast("command-result", { raw, result });
      const id = getActiveDeviceId();
      broker.broadcast("state-changed", api.getState(id));
      broker.broadcast("tracking-changed", api.getDeckTracking(id));
    },
  });
  await fwServer.start();

  let discovery: DiscoveryServiceHandle | null = null;
  if (cfg.discovery !== false) {
    const identity = defaultIdentity({
      hamSmartPort: cfg.hamSmartPort ?? DEFAULT_HAMSMART_PORT,
      fwPort: fwServer.port,
      ...cfg.identity,
    });
    try {
      discovery = await startDiscoveryService({
        identity,
        discoveryPort: cfg.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
        hamSmartPort: identity.hamSmartPort,
        host,
        log: (msg) => log(msg),
      });
      const resolvedHamSmart = discovery.identity.hamSmartPort;
      const resolvedDiscoveryPort = discovery.udp.boundPort;
      log(
        `Discovery advertising "${discovery.identity.instrumentId}" as ${discovery.identity.moduleType}` +
        ` (serial ${discovery.identity.moduleId}) on UDP ${resolvedDiscoveryPort}` +
        ` + TCP ${resolvedHamSmart} → FW ${fwServer.port}`,
      );
    } catch (err: any) {
      log(`Discovery failed to start (FW server still running): ${err?.message ?? err}`);
    }
  }

  return { fwServer, discovery };
}

/**
 * Start an HTTP server on `port`, handling EADDRINUSE by incrementing the
 * port until a free one is found (matching the pre-extraction behaviour).
 * Returns the resolved server plus the port that was ultimately bound.
 */
export function startHttpServer(
  handler: http.RequestListener,
  port: number,
  onListen?: (resolvedPort: number) => void
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    let attemptPort = port;
    const server = http.createServer(handler);

    server.on("error", (err: any) => {
      // Only bump on EADDRINUSE when the caller asked for a specific port;
      // if they asked for port 0, the OS picks and no collision retry is needed.
      if (err.code === "EADDRINUSE" && port !== 0) {
        attemptPort += 1;
        server.listen(attemptPort, "127.0.0.1");
      } else {
        reject(err);
      }
    });

    server.listen(attemptPort, "127.0.0.1", () => {
      // When attemptPort was 0, the OS picked a real port. Read the actual
      // bound port off the server address — previously we returned 0.
      const addr = server.address();
      const resolvedPort = typeof addr === "object" && addr !== null
        ? addr.port
        : attemptPort;
      onListen?.(resolvedPort);
      resolve({ server, port: resolvedPort });
    });
  });
}
