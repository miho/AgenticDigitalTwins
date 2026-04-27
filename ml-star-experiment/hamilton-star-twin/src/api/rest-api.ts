/**
 * REST API (Step 2.1)
 *
 * All HTTP routes the twin exposes. Built as a request handler factory so
 * both the Electron main process and the headless server share the exact
 * same endpoints — and tests can exercise them via either entry point.
 *
 * Factoring:
 *   createRestHandler(deps) → (req, res) => void
 *
 * Deps are explicit so the dependency graph stays unidirectional and tests
 * can swap any piece:
 *   - `api`                 — DigitalTwinAPI instance
 *   - `getActiveDeviceId`   — closure returning the current device id
 *   - `broker`              — SseBroker for live push
 *   - `replay`              — ReplayService for /replay/* routes
 *   - `staticDir`           — optional directory for serving the renderer UI
 *                             (null in headless mode → 404 for asset requests)
 *
 * Response shapes are preserved byte-for-byte from the pre-extraction
 * main.ts so the existing integration-test suite continues to pass.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type { DigitalTwinAPI } from "../twin/api";
import type { SseBroker } from "./sse-broker";
// ReplayService's generic parameter is irrelevant to the HTTP layer —
// the REST handler just forwards whatever the twin returns to the client.
import type { ReplayService } from "../services/replay-service";
import type { TraceReplayService, SeekFilter } from "../services/trace-replay-service";
import { autoClassify, getFlagged, getSummary, classify as classifyEvent } from "../twin/lifecycle-classifier";
import type { TwinEventLifecycle } from "../twin/timeline";
import { createMcpRegistry, McpRegistry } from "./mcp-server";
import {
  protocolSummary,
  renderProtocolSummaryHtml,
  renderProtocolSummaryText,
  wellReport,
  assessmentCsv,
  timingReport,
  diffReport,
} from "../services/report-generator";
import type { TwinTrace } from "../twin/trace-format";
import { parseHxCfg } from "../services/venus-import/hxcfg-parser";
import { importVenusLayout } from "../services/venus-import/venus-deck-importer";
import { buildVenusConfig, parseHxCfgSections } from "../twin/venus-config";
import { resolveHxxPath, loadHxxAsGlb, listInstalledHxx, HxxNotFoundError } from "../services/labware/hxx-loader";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReplay = ReplayService<any>;

/** What createRestHandler needs from its environment. */
export interface RestDeps {
  api: DigitalTwinAPI;
  getActiveDeviceId: () => string;
  broker: SseBroker;
  replay: AnyReplay;
  traceReplay: TraceReplayService;
  /** Absolute path to static renderer assets. Null to disable static serving. */
  staticDir?: string | null;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Build the top-level HTTP request handler. Pass the return value to
 * `http.createServer(...)` or equivalent.
 */
export function createRestHandler(deps: RestDeps): http.RequestListener {
  const { api, getActiveDeviceId, broker, replay, traceReplay, staticDir = null } = deps;

  // MCP tool registry — HTTP bridge at /api/mcp/list and /api/mcp/call.
  // Passing `broker` lets `deck.loadLayout` broadcast `deck-loaded` on
  // the same SSE stream the REST path uses (#60) — without it, MCP
  // hot-swaps silently updated the server while the renderer kept
  // showing the old layout.
  const mcp: McpRegistry = createMcpRegistry({ api, getActiveDeviceId, traceReplay, broker });

  // Hook the replay service's lifecycle callbacks up to the broker so
  // step / done / reset events flow out on the same SSE connection as
  // everything else. Safe to call multiple times — setListeners replaces.
  replay.setListeners({
    onStep: (s) => {
      broker.broadcast("command-result", {
        raw: s.raw,
        result: s.result,
        index: s.index,
        total: s.total,
      });
      broadcastStateUpdate();
    },
    onDone: (d) => broker.broadcast("replay-done", d),
    onReset: () => broadcastStateUpdate(),
  });

  // Phase 3 trace-replay service — distinct from the FW-command replay
  // above. Its events flow on SSE as `analysis-*` so the UI can tell
  // them apart from live-trace replays.
  traceReplay.setListeners({
    onPositionChanged: (p) => broker.broadcast("analysis-position-changed", p),
    onStateChanged: (state, position) => broker.broadcast("analysis-state-changed", { state, position }),
    onDone: (d) => broker.broadcast("analysis-done", d),
  });

  function broadcastStateUpdate(): void {
    const id = getActiveDeviceId();
    broker.broadcast("state-changed", api.getState(id));
    broker.broadcast("tracking-changed", api.getDeckTracking(id));
  }

  return function handler(req, res) {
    // Base URL is only used to parse pathname + search; its value is
    // irrelevant once we pull those fields out.
    const url = new URL(req.url || "/", "http://localhost/");
    const route = url.pathname;
    const activeDeviceId = getActiveDeviceId();

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      // --- SSE endpoint ---
      if (route === "/events") {
        const detach = broker.attachClient(res);
        req.on("close", detach);
        return;
      }

      // --- Command / completion / reset ---
      // `/command` models REAL physical time: the motion envelope
      // emission + animation start happens at t=0, but the state-
      // mutation phase (SCXML transition, deckTracker update,
      // assessment, SSE broadcast, HTTP response) is DEFERRED to
      // `t=durationMs * simSpeed` so a consumer polling `/api/state`
      // mid-motion sees the pre-move well volumes / tip contents /
      // positions — matching what a real STAR would report while the
      // arm is still travelling. `simSpeed` still scales wall-clock
      // (0.5 = "2× Speed" = half the real time); the renderer's arm
      // animation applies the same multiplier so the state commit
      // lines up with the visual end of the move. User report
      // 2026-04-19.
      if (route === "/command" && req.method === "POST") {
        readBody(req, (body) => {
          const { raw, simSpeed } = JSON.parse(body);
          api.sendCommandDeferred(activeDeviceId, raw, { simSpeed }).then((result) => {
            broker.broadcast("command-result", { raw, result });
            broadcastStateUpdate();
            jsonResponse(res, result);
          });
        });
        return;
      }

      if (route === "/completion" && req.method === "POST") {
        readBody(req, (body) => {
          const { event } = JSON.parse(body);
          const state = api.sendCompletion(activeDeviceId, event);
          broker.broadcast("completion", { event });
          broadcastStateUpdate();
          jsonResponse(res, state);
        });
        return;
      }

      if (route === "/reset" && req.method === "POST") {
        api.resetDevice(activeDeviceId);
        broker.broadcast("reset", {});
        broadcastStateUpdate();
        jsonResponse(res, { reset: true });
        return;
      }

      // --- Global simulation settings (simSpeed + fastInit) ----------
      // Server-wide defaults every transport falls back to when the
      // caller omits simSpeed. Changes are broadcast on SSE so all
      // connected clients (dashboard header + protocol editor) resync.
      if (route === "/settings" && req.method === "GET") {
        jsonResponse(res, api.getSettings());
        return;
      }
      if (route === "/settings" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const patch = body ? JSON.parse(body) : {};
            // setSettings fires a `settings_change` twin event; server-setup
            // forwards it onto the SSE broker as `settings-changed`, so we
            // don't re-broadcast here.
            const next = api.setSettings(patch);
            jsonResponse(res, next);
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // --- Front cover (open/close) ---
      // Mirrors the physical cover sensor so users can exercise
      // VENUS's "Cover not closed" error path without unplugging
      // anything. GET reads, POST sets.
      if (route === "/cover" && req.method === "GET") {
        jsonResponse(res, { open: api.isCoverOpen(activeDeviceId) });
        return;
      }
      if (route === "/cover" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { open } = JSON.parse(body);
            const now = api.setCoverOpen(activeDeviceId, !!open);
            broker.broadcast("cover-changed", { open: now });
            jsonResponse(res, { open: now });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // --- Session save/load ---
      if (route === "/session/save" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const opts = body ? JSON.parse(body) : {};
            const session = api.saveSession(activeDeviceId, opts);
            jsonResponse(res, session);
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/session/load" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const session = JSON.parse(body);
            const state = api.loadSession(activeDeviceId, session);
            broker.broadcast("session-loaded", { name: session?.metadata?.name });
            broadcastStateUpdate();
            jsonResponse(res, state);
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // --- Trace replay ---
      if (route === "/replay/info") {
        jsonResponse(res, replay.getInfo());
        return;
      }

      if (route === "/replay/step" && req.method === "POST") {
        const stepResult = replay.step();
        jsonResponse(res, stepResult);
        return;
      }

      if (route === "/replay/play" && req.method === "POST") {
        readBody(req, (body) => {
          let speed: number | undefined;
          try {
            const opts = body ? JSON.parse(body) : {};
            if (opts.speed) speed = opts.speed;
          } catch { /* ignore malformed body */ }
          replay.play(speed);
          jsonResponse(res, { playing: true, speed: replay.getInfo().speed });
        });
        return;
      }

      if (route === "/replay/pause" && req.method === "POST") {
        replay.pause();
        jsonResponse(res, { paused: true, index: replay.getInfo().current });
        return;
      }

      if (route === "/replay/reset" && req.method === "POST") {
        replay.reset();
        broadcastStateUpdate();
        jsonResponse(res, { reset: true, total: replay.getInfo().total });
        return;
      }

      if (route === "/replay/speed" && req.method === "POST") {
        readBody(req, (body) => {
          const { speed } = JSON.parse(body);
          const clamped = replay.setSpeed(speed);
          jsonResponse(res, { speed: clamped });
        });
        return;
      }

      // --- State / deck / tracking / history ---
      if (route === "/state") { jsonResponse(res, api.getState(activeDeviceId)); return; }
      if (route === "/deck") { jsonResponse(res, api.getDeck(activeDeviceId)); return; }
      if (route === "/tracking") { jsonResponse(res, api.getDeckTracking(activeDeviceId)); return; }
      if (route === "/history") { jsonResponse(res, api.getHistory(activeDeviceId)); return; }

      if (route === "/assessment") {
        const category = url.searchParams.get("category") as any;
        const channel = url.searchParams.has("channel") ? Number(url.searchParams.get("channel")) : undefined;
        const count = url.searchParams.has("count") ? Number(url.searchParams.get("count")) : undefined;
        jsonResponse(res, api.getAssessments(activeDeviceId, { category, channel, count }));
        return;
      }

      if (route === "/inspect-carrier" && url.searchParams.has("id")) {
        jsonResponse(res, api.inspectCarrier(activeDeviceId, url.searchParams.get("id")!));
        return;
      }

      if (route === "/inspect-position" && url.searchParams.has("x")) {
        const x = Number(url.searchParams.get("x"));
        const y = Number(url.searchParams.get("y") || 0);
        jsonResponse(res, api.inspectPosition(activeDeviceId, x, y));
        return;
      }

      // --- VENUS Step endpoints ---
      if (route === "/step" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { type, params, simSpeed } = JSON.parse(body);
            if (!type) {
              jsonResponse(res, { success: false, error: "Missing step type", stepType: "unknown", commands: [], assessments: [] });
              return;
            }
            const result = api.executeStep(activeDeviceId, type, params || {});

            if (result.commands) {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getCommandTiming } = require("../twin/command-timing");
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { parseFwCommand } = require("../twin/fw-protocol");
              let totalTime = 0;
              for (const cmd of result.commands) {
                try {
                  const parsed = parseFwCommand(cmd.raw);
                  const plugin = (api as any).getPlugin ? (api as any).getPlugin(activeDeviceId, parsed.event) : undefined;
                  const timing = getCommandTiming(parsed.event, parsed.params, plugin);
                  (cmd as any).estimatedTimeMs = timing.totalMs;
                  (cmd as any).timingAccuracy = timing.accuracy;
                  (cmd as any).timingBreakdown = timing.breakdown;
                  totalTime += timing.totalMs;
                } catch { /* ignore parse errors for timing */ }
              }
              (result as any).totalEstimatedTimeMs = totalTime;
            }

            broker.broadcast("step-result", { type, result });
            broadcastStateUpdate();

            // Fall back to the server-wide simSpeed when the caller
            // didn't pass one — matches the /command contract so the
            // dashboard header dropdown governs both transports.
            const effectiveSpeed = typeof simSpeed === "number" ? simSpeed : api.getSettings().simSpeed;
            if (effectiveSpeed > 0 && (result as any).totalEstimatedTimeMs) {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { applySimSpeed } = require("../twin/command-timing");
              const delay = applySimSpeed((result as any).totalEstimatedTimeMs, effectiveSpeed);
              (result as any).simulatedDelayMs = delay;
              setTimeout(() => jsonResponse(res, result), delay);
            } else {
              jsonResponse(res, result);
            }
          } catch (err: any) {
            jsonResponse(res, { success: false, error: err.message || String(err), stepType: "unknown", commands: [], assessments: [] });
          }
        });
        return;
      }

      if (route === "/steps") {
        jsonResponse(res, api.listStepTypes());
        return;
      }

      if (route === "/timing" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { raw } = JSON.parse(body);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { parseFwCommand } = require("../twin/fw-protocol");
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { estimateCommandTime } = require("../twin/command-timing");
            const cmd = parseFwCommand(raw);
            const est = estimateCommandTime(cmd.event, cmd.params);
            jsonResponse(res, { event: cmd.event, estimatedTimeMs: est, description: `~${(est / 1000).toFixed(1)}s` });
          } catch (err: any) {
            jsonResponse(res, { error: err.message });
          }
        });
        return;
      }

      if (route === "/step/decompose" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { type, params } = JSON.parse(body);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { StepExecutor } = require("../twin/venus-steps");
            const subSteps = StepExecutor.decomposeStep(type, params || {});
            jsonResponse(res, { type, subSteps, count: subSteps.length });
          } catch (err: any) {
            jsonResponse(res, { error: err.message, subSteps: [], count: 0 });
          }
        });
        return;
      }

      // --- Liquid tracking ---
      if (route === "/liquid/fill" && req.method === "POST") {
        readBody(req, (body) => {
          const { carrierId, position, liquidType, volume, liquidClass } = JSON.parse(body);
          const ok = api.fillLabwareWithLiquid(activeDeviceId, carrierId, position, liquidType, volume, liquidClass);
          broadcastStateUpdate();
          jsonResponse(res, { success: ok });
        });
        return;
      }

      if (route === "/liquid/well" && url.searchParams.has("carrier")) {
        const carrierId = url.searchParams.get("carrier")!;
        const position = Number(url.searchParams.get("position") || 0);
        const wellIndex = Number(url.searchParams.get("well") || 0);
        jsonResponse(res, api.getWellLiquid(activeDeviceId, carrierId, position, wellIndex));
        return;
      }

      if (route === "/liquid/channels") {
        const channels = [];
        for (let i = 0; i < 16; i++) channels.push(api.getChannelState(activeDeviceId, i));
        jsonResponse(res, channels);
        return;
      }

      if (route === "/liquid/contamination") {
        jsonResponse(res, api.getContamination(activeDeviceId));
        return;
      }

      // --- Analysis REST API (Phase 3 Step 3.4) ----------------------
      // Loads + navigates a recorded TwinTrace. Forked live-twin
      // instances live in the service's memory and stay there until
      // explicitly discarded.

      if (route === "/api/analysis/load" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            if (parsed.path) {
              traceReplay.loadFromFile(parsed.path);
            } else if (parsed.trace) {
              traceReplay.load(parsed.trace, parsed.name ?? null);
            } else if (typeof parsed === "object" && parsed.format === "hamilton-twin-trace") {
              // Convenience: raw trace object posted as the body.
              traceReplay.load(parsed, parsed.metadata?.label ?? null);
            } else {
              throw new Error("POST /api/analysis/load expects { path } or { trace, name? }");
            }
            jsonResponse(res, traceReplay.getInfo());
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/info") {
        jsonResponse(res, traceReplay.getInfo());
        return;
      }

      if (route === "/api/analysis/position") {
        jsonResponse(res, traceReplay.getPosition());
        return;
      }

      if (route === "/api/analysis/step" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { direction = "forward" } = body ? JSON.parse(body) : {};
            jsonResponse(res, traceReplay.step(direction));
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/jump" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { eventId } = body ? JSON.parse(body) : {};
            jsonResponse(res, traceReplay.jump(Number(eventId)));
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/seek" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const filter: SeekFilter = body ? JSON.parse(body) : {};
            jsonResponse(res, traceReplay.seek(filter));
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/state") {
        try {
          jsonResponse(res, traceReplay.getState());
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      if (route === "/api/analysis/events") {
        try {
          const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : 0;
          const to = url.searchParams.has("to") ? Number(url.searchParams.get("to")) : traceReplay.getInfo().totalEvents;
          const lifecycle = url.searchParams.get("lifecycle") as TwinEventLifecycle | null;
          let events = traceReplay.getEventsInRange(from, to);
          if (lifecycle) events = events.filter((e) => (e.lifecycle ?? "active") === lifecycle);
          jsonResponse(res, events);
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      if (route === "/api/analysis/classify" && req.method === "POST") {
        // Auto-classify the whole loaded trace, or override a single event
        // (body shape differentiates which).
        readBody(req, (body) => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            if (parsed.eventId !== undefined && parsed.lifecycle) {
              const events = traceReplay.getAllEvents();
              const e = events.find((x) => x.id === parsed.eventId);
              if (!e) throw new Error(`event ${parsed.eventId} not found`);
              classifyEvent(e, parsed.lifecycle);
              jsonResponse(res, { ok: true });
            } else {
              autoClassify(traceReplay.getAllEvents());
              jsonResponse(res, getSummary(traceReplay.getAllEvents()));
            }
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/flagged") {
        jsonResponse(res, getFlagged(traceReplay.getAllEvents()));
        return;
      }

      if (route === "/api/analysis/summary") {
        jsonResponse(res, getSummary(traceReplay.getAllEvents()));
        return;
      }

      if (route === "/api/analysis/play" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { speed } = body ? JSON.parse(body) : {};
            traceReplay.play(speed);
            jsonResponse(res, { playing: true, speed: traceReplay.getInfo().speed });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/pause" && req.method === "POST") {
        traceReplay.pause();
        jsonResponse(res, { playing: false });
        return;
      }

      if (route === "/api/analysis/speed" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { speed } = body ? JSON.parse(body) : {};
            const clamped = traceReplay.setSpeed(Number(speed));
            jsonResponse(res, { speed: clamped });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // --- What-if forks ---

      if (route === "/api/analysis/fork" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const { atEventId } = body ? JSON.parse(body) : {};
            jsonResponse(res, traceReplay.fork(Number(atEventId)));
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      if (route === "/api/analysis/forks") {
        jsonResponse(res, traceReplay.listForks());
        return;
      }

      // Per-fork routes: /api/analysis/fork/:id/...
      const forkMatch = route.match(/^\/api\/analysis\/fork\/([^/]+)(?:\/(command|step|state|diff))?$/);
      if (forkMatch) {
        const forkId = decodeURIComponent(forkMatch[1]);
        const action = forkMatch[2];
        try {
          if (!action && req.method === "DELETE") {
            traceReplay.discardFork(forkId);
            jsonResponse(res, { forkId, discarded: true });
            return;
          }
          if (action === "state" && req.method === "GET") {
            jsonResponse(res, traceReplay.forkState(forkId));
            return;
          }
          if (action === "diff" && req.method === "GET") {
            jsonResponse(res, traceReplay.diffFork(forkId));
            return;
          }
          if (action === "command" && req.method === "POST") {
            readBody(req, (body) => {
              try {
                const { raw } = JSON.parse(body);
                jsonResponse(res, traceReplay.forkCommand(forkId, raw));
              } catch (err: any) {
                jsonResponse(res, { error: err?.message || String(err) }, 400);
              }
            });
            return;
          }
          if (action === "step" && req.method === "POST") {
            readBody(req, (body) => {
              try {
                const { type, params } = JSON.parse(body);
                jsonResponse(res, traceReplay.forkStep(forkId, type, params || {}));
              } catch (err: any) {
                jsonResponse(res, { error: err?.message || String(err) }, 400);
              }
            });
            return;
          }
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
          return;
        }
      }

      // --- VENUS deck import (#18) -----------------------------------
      //
      // POST a `.lay` file text (or a filesystem path) and get back a
      // new device id whose deck was built from the VENUS layout.
      // Replaces the active device for subsequent commands.

      if (route === "/api/deck/import-lay" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            let layPayload: string | Buffer;
            if (typeof parsed.lay === "string" && parsed.lay.length > 0) {
              layPayload = parsed.lay;
            } else if (typeof parsed.path === "string" && parsed.path.length > 0) {
              // Read as raw bytes so the parser can detect binary vs text.
              layPayload = fs.readFileSync(parsed.path);
            } else {
              throw new Error("import-lay expects { lay } or { path }");
            }
            const doc = parseHxCfg(layPayload);
            const { deck, placements, warnings, metadata } = importVenusLayout(doc);
            const deviceName = parsed.name ?? metadata.activeLayer ?? "imported";
            const newId = api.createDevice({ name: deviceName, deck });
            broker.broadcast("device-created", { deviceId: newId, source: "lay-import" });
            jsonResponse(res, {
              deviceId: newId,
              metadata,
              placements,
              warnings,
            });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // Hot-swap variant: replaces the active device's deck in place so
      // SCXML state + bridge connections survive. Accepts the same body
      // shape as /api/deck/import-lay ({lay} or {path}). Returns the
      // placements + warnings + metadata from the importer without
      // creating a new deviceId.
      if (route === "/api/deck/load" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            let layPayload: string | Buffer;
            let sourcePath: string | null = null;
            if (typeof parsed.lay === "string" && parsed.lay.length > 0) {
              layPayload = parsed.lay;
            } else if (typeof parsed.path === "string" && parsed.path.length > 0) {
              sourcePath = parsed.path;
              // Buffer, not utf-8 string — VENUS saves .lay as a binary
              // MFC archive by default. parseHxCfg sniffs the format.
              layPayload = fs.readFileSync(parsed.path);
            } else {
              throw new Error("/api/deck/load expects { lay } or { path }");
            }
            const doc = parseHxCfg(layPayload);
            const { deck, placements, warnings, metadata } = importVenusLayout(doc);
            // If loaded from a file, make the factory re-read the file on
            // reset so state stays clean but the layout persists across
            // resets. For inline `lay`, the factory returns the same deck
            // instance (the caller kept the authoritative source).
            const factory = sourcePath
              ? () => importVenusLayout(parseHxCfg(fs.readFileSync(sourcePath!))).deck
              : undefined;
            api.setDeck(getActiveDeviceId(), deck, factory);
            broker.broadcast("deck-loaded", {
              deviceId: getActiveDeviceId(),
              source: sourcePath ? "file" : "inline",
              path: sourcePath,
              metadata,
              placements,
              warnings,
            });
            jsonResponse(res, { metadata, placements, warnings });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // Hot-swap the VENUS cfg on a running twin so its C0QM / C0RM /
      // C0RI / C0RF / C0RU advertise the module set the user's real
      // VENUS expects. Opt-in only — we never infer which cfg to use;
      // the caller names it explicitly. Body forms:
      //   { cfg: "<raw file text>" }        — inline
      //   { path: "C:/.../ML_STAR.cfg" }    — read from disk
      if (route === "/api/venus-config/load" && req.method === "POST") {
        readBody(req, (body) => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            let cfgText: string;
            let sourcePath: string | null = null;
            if (typeof parsed.cfg === "string" && parsed.cfg.length > 0) {
              cfgText = parsed.cfg;
            } else if (typeof parsed.path === "string" && parsed.path.length > 0) {
              sourcePath = parsed.path;
              cfgText = fs.readFileSync(parsed.path, "utf-8");
            } else {
              throw new Error("/api/venus-config/load expects { cfg } or { path }");
            }
            const cfgSections = parseHxCfgSections(cfgText);
            const deviceId = getActiveDeviceId();
            const current = api.getVenusConfig(deviceId);
            const merged = buildVenusConfig({ cfgSections, overrides: current });
            api.setVenusConfig(deviceId, merged);
            broker.broadcast("venus-config-loaded", {
              deviceId,
              source: sourcePath ? "file" : "inline",
              path: sourcePath,
              moduleBits: merged.moduleBits,
              totalTracks: merged.totalTracks,
              serial: merged.serial,
            });
            jsonResponse(res, {
              moduleBits: merged.moduleBits,
              moduleBitsHex: merged.moduleBits.toString(16).padStart(6, "0"),
              totalTracks: merged.totalTracks,
              serial: merged.serial,
              source: sourcePath ? "file" : "inline",
              path: sourcePath,
            });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // --- Report generation (Phase 4 Step 4.A) ----------------------
      //
      // Reports are pure functions over the currently loaded trace —
      // load via /api/analysis/load first. GET returns the structured
      // report; the `format` query param picks an alternate render
      // (text / html for summary, csv for assessments). Diff reports
      // take a forkId whose fork must already exist on traceReplay.

      if (route === "/api/report/summary") {
        try {
          const trace = requireLoadedTrace(traceReplay);
          const report = protocolSummary(trace);
          const fmt = url.searchParams.get("format");
          if (fmt === "text") {
            textResponse(res, renderProtocolSummaryText(report));
          } else if (fmt === "html") {
            htmlResponse(res, renderProtocolSummaryHtml(report));
          } else {
            jsonResponse(res, report);
          }
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      if (route === "/api/report/well") {
        try {
          const trace = requireLoadedTrace(traceReplay);
          const carrierId = url.searchParams.get("carrier");
          const position = url.searchParams.get("position");
          const wellIndex = url.searchParams.get("well");
          if (!carrierId || position === null || wellIndex === null) {
            throw new Error("report/well requires carrier, position, and well");
          }
          const wellKey = `${carrierId}:${Number(position)}:${Number(wellIndex)}`;
          jsonResponse(res, wellReport(trace, wellKey));
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      if (route === "/api/report/assessments") {
        try {
          const trace = requireLoadedTrace(traceReplay);
          const fmt = url.searchParams.get("format") ?? "csv";
          if (fmt === "csv") {
            csvResponse(res, assessmentCsv(trace), "assessments.csv");
          } else {
            // JSON: just the assessment entries on the timeline.
            const rows = trace.timeline.filter((e) => e.kind === "assessment").map((e) => e.payload);
            jsonResponse(res, rows);
          }
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      if (route === "/api/report/timing") {
        try {
          const trace = requireLoadedTrace(traceReplay);
          jsonResponse(res, timingReport(trace));
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      if (route === "/api/report/diff" && req.method === "GET") {
        try {
          const forkId = url.searchParams.get("forkId");
          if (!forkId) throw new Error("report/diff requires forkId");
          jsonResponse(res, diffReport(traceReplay.diffFork(forkId)));
        } catch (err: any) {
          jsonResponse(res, { error: err?.message || String(err) }, 400);
        }
        return;
      }

      // --- MCP tool bridge (Phase 3 Step 3.5) ------------------------
      //
      // LLM agents that speak HTTP tool-use (Claude API, etc.) list the
      // catalogue once and call individual tools by name. A stdio MCP
      // transport (the classic MCP flow) can be added later without
      // touching the tool logic — the registry is transport-agnostic.

      if (route === "/api/mcp/list") {
        jsonResponse(res, mcp.list());
        return;
      }

      if (route === "/api/mcp/call" && req.method === "POST") {
        readBody(req, async (body) => {
          try {
            const { name, args } = JSON.parse(body);
            const result = await mcp.call(String(name), (args as Record<string, unknown>) || {});
            jsonResponse(res, { result });
          } catch (err: any) {
            jsonResponse(res, { error: err?.message || String(err) }, 400);
          }
        });
        return;
      }

      // --- Labware 3D (.hxx → GLB) -----------------------------------
      //
      // Hamilton ships specialty labware (waste tubs, verification
      // needles, teaching blocks, CORE-head slide wastes, BVS
      // manifolds, …) as compressed DirectX .x meshes in .hxx
      // containers under the install's Labware/ tree. The 3D view
      // can render these more accurately than the procedural rack
      // we derive from .rck dimensions alone; this endpoint streams
      // the converted GLB on demand, cached by (path, mtime).
      //
      //   GET /api/labware/3d/manifest           → list of repo-relative .hxx paths
      //   GET /api/labware/3d/<repo-path>.glb    → GLB for that .hxx (e.g.
      //                                            /api/labware/3d/ML_STAR/CORE/Waste2.glb)
      if (route === "/api/labware/3d/manifest") {
        jsonResponse(res, { labware: listInstalledHxx() });
        return;
      }
      if (route.startsWith("/api/labware/3d/") && route.endsWith(".glb")) {
        const rel = route.slice("/api/labware/3d/".length, -".glb".length) + ".hxx";
        // Block `..` in the URL — the resolver is already constrained
        // to the install root but defence in depth is cheap.
        if (rel.includes("..")) { res.writeHead(400); res.end("bad path"); return; }
        const abs = resolveHxxPath(rel);
        if (!abs) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Labware not found: ${rel}` }));
          return;
        }
        try {
          const glb = loadHxxAsGlb(abs);
          res.writeHead(200, {
            "Content-Type": "model/gltf-binary",
            "Content-Length": String(glb.byteLength),
            "Cache-Control": "public, max-age=3600",
          });
          res.end(glb);
        } catch (err: any) {
          const status = err instanceof HxxNotFoundError ? 404 : 500;
          res.writeHead(status);
          res.end(JSON.stringify({ error: err?.message || String(err) }));
        }
        return;
      }

      // --- Static files (optional) ---
      if (staticDir) {
        const filePath = route === "/" ? "/index.html"
          : route === "/protocol" ? "/protocol-editor.html"
          : route === "/3d" ? "/3d.html"
          : route;
        const fullPath = path.join(staticDir, filePath);

        // Security: don't serve outside staticDir
        if (!fullPath.startsWith(staticDir)) { res.writeHead(403); res.end(); return; }

        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const ext = path.extname(fullPath);
          res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
          fs.createReadStream(fullPath).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

function readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk; });
  req.on("end", () => cb(body));
}

function jsonResponse(res: http.ServerResponse, data: any, statusCode: number = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function textResponse(res: http.ServerResponse, body: string, statusCode: number = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function htmlResponse(res: http.ServerResponse, body: string, statusCode: number = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function csvResponse(res: http.ServerResponse, body: string, filename: string, statusCode: number = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.end(body);
}

/**
 * Pull the trace currently loaded into the TraceReplayService. Reports
 * are pure functions over a loaded trace — if nothing is loaded we throw
 * so the REST layer emits a useful error rather than a silent 500.
 */
function requireLoadedTrace(traceReplay: TraceReplayService): TwinTrace {
  const trace = traceReplay.getTrace();
  if (!trace) throw new Error("no trace loaded — POST /api/analysis/load first");
  return trace;
}
