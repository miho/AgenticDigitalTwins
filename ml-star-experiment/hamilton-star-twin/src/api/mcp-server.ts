/**
 * MCP tool registry (Step 3.5)
 *
 * Defines every "tool" the twin exposes to LLM agents — with JSON schema
 * describing their inputs and explicit handlers. The registry is used by
 * both:
 *   - the HTTP bridge at /api/mcp/list + /api/mcp/call (this file
 *     ships today; LLMs with HTTP tool-use call it directly), and
 *   - an optional stdio MCP transport (deferred; the registry's tool
 *     shape is already MCP-compatible, so wiring it up later is a small
 *     self-contained addition).
 *
 * Shape of a tool:
 *   {
 *     name: string,                      // dot-namespaced, e.g. "twin.sendCommand"
 *     description: string,               // human-readable; also sent to the LLM
 *     inputSchema: JSONSchema,           // argument shape
 *     handler: (args) => unknown,        // async allowed
 *   }
 *
 * Namespaces:
 *   twin.*       — live-twin operations (send commands, snapshot, restore).
 *   analysis.*   — recorded-trace navigation, what-if fork, flagged events.
 *   report.*     — reporting (stub until Phase 4/5).
 */

import type { DigitalTwinAPI } from "../twin/api";
import type { TraceReplayService } from "../services/trace-replay-service";
import { autoClassify, getFlagged, getSummary } from "../twin/lifecycle-classifier";
import type { TwinTimelineEvent } from "../twin/timeline";
import type { CommandResult } from "../twin/digital-twin";
import type { AssessmentEvent } from "../twin/assessment";
import {
  protocolSummary,
  wellReport,
  assessmentCsv,
  timingReport,
  diffReport,
} from "../services/report-generator";
import { parseHxCfg } from "../services/venus-import/hxcfg-parser";
import { buildVenusConfig, parseHxCfgSections } from "../twin/venus-config";
import { importVenusLayout } from "../services/venus-import/venus-deck-importer";
import { createModuleRegistry } from "../twin/module-registry";
import { C0AS_PARAMS, C0DS_PARAMS } from "../twin/pip-command-catalog";
import { DEFAULT_LABWARE_CATALOG, findCatalogEntry, listCatalogTypes } from "../twin/labware-catalog";
import { DEFAULT_CARRIER_CATALOG, findCarrierCatalogEntry, listCarrierCatalogTypes } from "../twin/carrier-catalog";
import * as fs from "fs";

/** One MCP tool. `inputSchema` is JSON-schema-compatible. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** What /api/mcp/list returns — a discoverable tool catalogue. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpDeps {
  api: DigitalTwinAPI;
  getActiveDeviceId: () => string;
  traceReplay: TraceReplayService;
  /** Optional — when present, `deck.loadLayout` broadcasts `deck-loaded`
   *  on the shared SSE stream so the renderer re-fetches and redraws.
   *  Matches the REST `/api/deck/load` behaviour. #60. */
  broker?: { broadcast: (event: string, data: unknown) => void };
}

/** Build the registry from its deps. One registry per HTTP server. */
export function createMcpRegistry(deps: McpDeps): McpRegistry {
  return new McpRegistry(buildTools(deps));
}

export class McpRegistry {
  private tools: Map<string, McpTool> = new Map();

  constructor(tools: McpTool[]) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  /** Discoverable catalogue — no handler functions leaked. */
  list(): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = [];
    for (const t of this.tools.values()) {
      out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
    return out;
  }

  /** Call a tool by name. Throws if unknown. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`MCP tool not found: ${name}`);
    return tool.handler(args);
  }
}

// --- Tool definitions -------------------------------------------------

function buildTools(deps: McpDeps): McpTool[] {
  const { api, getActiveDeviceId, traceReplay } = deps;

  return [
    // ===== twin.* =========================================================

    {
      name: "twin.sendCommand",
      description: "Execute a raw Hamilton firmware command on the live twin. Returns the CommandResult including response, correlationId, and any deck interactions or assessments. The call resolves AFTER the physical motion duration has elapsed (the motion envelope is emitted at t=0 for visual clients, but state mutations commit at end-of-motion) so mid-motion state queries see the pre-command snapshot. When simSpeed is omitted the server-wide default from twin.getSettings is used; when fastInit is on, init commands (C0VI/C0DI/C0EI/C0FI/C0II/C0JI) always run instantly regardless of simSpeed.",
      inputSchema: {
        type: "object",
        required: ["raw"],
        properties: {
          raw: { type: "string", description: "Raw FW command string, e.g. 'C0ASid0001xp01000yp02000av00500'" },
          stepId: { type: "number", description: "Optional stepId to tag the command with (links it to a composite VENUS step)" },
          simSpeed: { type: "number", description: "Physical-time multiplier override. Omit to use the server-wide default (twin.getSettings). 1=real-time, 0.5=2× faster, 0=instant (skip motion delay)." },
        },
      },
      handler: async (args) => {
        const raw = String(args.raw);
        const opts: { simSpeed?: number; stepId?: number } = {};
        if (typeof args.simSpeed === "number") opts.simSpeed = args.simSpeed;
        if (typeof args.stepId === "number") opts.stepId = args.stepId;
        return await api.sendCommandDeferred(getActiveDeviceId(), raw, opts);
      },
    },

    {
      name: "twin.getSettings",
      description: "Return the server-wide simulation settings: `simSpeed` (default physical-time multiplier every transport falls back to) and `fastInit` (when true, init commands run instantly regardless of simSpeed). Dashboard header controls + protocol editor + this MCP tool all share the same store.",
      inputSchema: { type: "object", properties: {} },
      handler: () => api.getSettings(),
    },

    {
      name: "twin.setSettings",
      description: "Partial update to the server-wide simulation settings. Pass only the fields you want to change. Returns the new full settings. All connected clients receive a `settings-changed` SSE event so their UI resyncs.",
      inputSchema: {
        type: "object",
        properties: {
          simSpeed: { type: "number", description: "Default physical-time multiplier. 0=instant, 0.5=2× faster, 1=real-time, 2=half-speed." },
          fastInit: { type: "boolean", description: "When true, init commands (C0VI/C0DI/C0EI/C0FI/C0II/C0JI) bypass the motion delay even at simSpeed=1." },
        },
      },
      handler: (args) => {
        const patch: { simSpeed?: number; fastInit?: boolean } = {};
        if (typeof args.simSpeed === "number") patch.simSpeed = args.simSpeed;
        if (typeof args.fastInit === "boolean") patch.fastInit = args.fastInit;
        return api.setSettings(patch);
      },
    },

    {
      name: "twin.getState",
      description: "Return the full DeviceState of the live twin — modules, deck snapshot, deck tracking, liquid tracking, recent assessments. Big payload; prefer the twin.get* slicer tools for targeted queries.",
      inputSchema: { type: "object", properties: {} },
      handler: () => api.getState(getActiveDeviceId()),
    },

    {
      name: "twin.getModules",
      description: "Module name → current SCXML states. Much smaller than twin.getState when you only need 'what state is each module in'. Set nonDefaultOnly to skip modules that are idle/ready.",
      inputSchema: {
        type: "object",
        properties: {
          nonDefaultOnly: { type: "boolean", description: "Skip modules whose leaf state is idle/ready/off/standby (default false)" },
        },
      },
      handler: (args) => {
        const state = api.getState(getActiveDeviceId());
        const nonDefault = Boolean(args.nonDefaultOnly);
        const out: Record<string, { states: string[] }> = {};
        for (const [name, m] of Object.entries(state.modules)) {
          if (nonDefault && isDefaultModuleState(m.states)) continue;
          out[name] = { states: m.states };
        }
        return out;
      },
    },

    {
      name: "twin.getDeck",
      description: "Compact deck view — each carrier with track, type, and per-position labware. Plates report occupied/total + sample wells; tip racks report tipsUsed/total. Drops DeckSnapshot geometry. Set occupiedOnly to hide empty carriers and null positions; set sampleWells to cap or suppress per-plate sample lists (default 3).",
      inputSchema: {
        type: "object",
        properties: {
          occupiedOnly: { type: "boolean", description: "Hide empty carriers and null positions (default false)" },
          sampleWells: { type: "number", description: "Per-plate non-empty well samples to include (default 3; 0 disables)" },
        },
      },
      handler: (args) => {
        const state = api.getState(getActiveDeviceId());
        const occupiedOnly = Boolean(args.occupiedOnly);
        const sampleCap = args.sampleWells === undefined ? 3 : Math.max(0, Number(args.sampleWells));
        const carriers = state.deck.carriers.map((c) => {
          const labware = c.labware.map((lw, pos) =>
            lw ? summarizeLabware(c.id, pos, lw, state.deckTracker.wellVolumes, state.deckTracker.tipUsage, state.liquidTracking.wellContents, sampleCap) : null,
          );
          return {
            id: c.id,
            type: c.type,
            track: c.track,
            widthTracks: c.widthTracks,
            barcode: c.barcode,
            labware: occupiedOnly ? labware.filter((l) => l !== null) : labware,
          };
        });
        return {
          platform: state.deck.platform,
          totalTracks: state.deck.totalTracks,
          carriers: occupiedOnly ? carriers.filter((c) => c.labware.length > 0) : carriers,
          tipWaste: state.deck.tipWaste,
        };
      },
    },

    {
      name: "twin.getWells",
      description: "Well-level state (volume + liquid identity) filtered by carrier, labware barcode, track, or labware type. Defaults nonEmptyOnly:true and limit:100 to stay compact; set limit:0 for unlimited.",
      inputSchema: {
        type: "object",
        properties: {
          barcode: { type: "string", description: "Match labware barcode" },
          carrierId: { type: "string", description: "Match carrier ID" },
          track: { type: "number", description: "Match carrier starting track" },
          labwareType: { type: "string", description: "Match labware type (e.g. 'Cos_96_Rd')" },
          nonEmptyOnly: { type: "boolean", description: "Only wells with volume > 0 (default true)" },
          limit: { type: "number", description: "Max wells to return (default 100; 0 = unlimited)" },
        },
      },
      handler: (args) => {
        const state = api.getState(getActiveDeviceId());
        const nonEmptyOnly = args.nonEmptyOnly === undefined ? true : Boolean(args.nonEmptyOnly);
        const rawLimit = Number(args.limit ?? 100);
        const limit = rawLimit === 0 ? Infinity : rawLimit;
        const barcode = args.barcode ? String(args.barcode) : undefined;
        const carrierId = args.carrierId ? String(args.carrierId) : undefined;
        const track = args.track === undefined ? undefined : Number(args.track);
        const labwareType = args.labwareType ? String(args.labwareType) : undefined;

        const wells: unknown[] = [];
        let truncated = false;
        outer: for (const c of state.deck.carriers) {
          if (carrierId && c.id !== carrierId) continue;
          if (track !== undefined && c.track !== track) continue;
          for (let pos = 0; pos < c.labware.length; pos++) {
            const lw = c.labware[pos];
            if (!lw) continue;
            if (barcode && lw.barcode !== barcode) continue;
            if (labwareType && lw.type !== labwareType) continue;
            for (let idx = 0; idx < lw.wellCount; idx++) {
              const key = `${c.id}:${pos}:${idx}`;
              const vol = state.deckTracker.wellVolumes[key] ?? 0;
              if (nonEmptyOnly && vol <= 0) continue;
              const contents = state.liquidTracking.wellContents[key];
              wells.push({
                key,
                label: wellLabel(idx, lw.columns),
                carrierId: c.id,
                position: pos,
                labwareType: lw.type,
                barcode: lw.barcode,
                volume: vol,
                liquid: contents?.liquidType,
                liquidClass: contents?.liquidClass,
              });
              if (wells.length >= limit) { truncated = true; break outer; }
            }
          }
        }
        return { count: wells.length, truncated, wells };
      },
    },

    {
      name: "twin.getChannels",
      description: "Per-channel PIP state (tip fitted, current liquid contents, contamination). Just the channel array — no deck payload.",
      inputSchema: { type: "object", properties: {} },
      handler: () => api.getState(getActiveDeviceId()).liquidTracking.channels,
    },

    {
      name: "twin.getAssessments",
      description: "Recent physics/assessment events (TADM, LLD, contamination, collision, …) with optional filters. Most recent first; default limit 50.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "number", description: "Only events with timestamp > since (ms since epoch)" },
          severity: { type: "string", enum: ["info", "warning", "error"], description: "Filter by severity" },
          category: { type: "string", description: "Filter by category (e.g. 'tadm', 'lld', 'contamination')" },
          limit: { type: "number", description: "Max events to return (default 50)" },
        },
      },
      handler: (args) => {
        const evs = api.getState(getActiveDeviceId()).assessments;
        const since = args.since === undefined ? undefined : Number(args.since);
        const severity = args.severity ? String(args.severity) : undefined;
        const category = args.category ? String(args.category) : undefined;
        const limit = Number(args.limit ?? 50);
        let out: AssessmentEvent[] = evs;
        if (since !== undefined) out = out.filter((a) => a.timestamp > since);
        if (severity) out = out.filter((a) => a.severity === severity);
        if (category) out = out.filter((a) => a.category === category);
        out = out.slice(-limit).reverse();
        return { count: out.length, events: out };
      },
    },

    {
      name: "twin.executeStep",
      description: "Execute a named VENUS step (e.g. 'tipPickUp', 'aspirate', 'easyTransfer') with parameters. Returns a StepResult with sub-command list.",
      inputSchema: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", description: "Step type name" },
          params: { type: "object", description: "Step-specific parameters" },
        },
      },
      handler: (args) => api.executeStep(
        getActiveDeviceId(),
        String(args.type),
        (args.params as Record<string, unknown>) || {},
      ),
    },

    {
      name: "twin.snapshot",
      description: "Capture the live twin's current dynamic state as a JSON-safe TwinState. Pair with twin.restore to save/load.",
      inputSchema: { type: "object", properties: {} },
      handler: () => api.saveSession(getActiveDeviceId()).state,
    },

    {
      name: "twin.restore",
      description: "Apply a TwinState to the live twin, replacing its current state. The config must match (create a new device for a different platform).",
      inputSchema: {
        type: "object",
        required: ["session"],
        properties: {
          session: { type: "object", description: "Full TwinSession (format: hamilton-twin-session)" },
        },
      },
      handler: (args) => {
        api.loadSession(getActiveDeviceId(), args.session as any);
        return { restored: true };
      },
    },

    // ===== analysis.* =====================================================

    {
      name: "analysis.load",
      description: "Load a recorded TwinTrace into the analysis service — either from a filesystem path or from an already-parsed trace object. Returns the trace info.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to a .twintrace.json file" },
          trace: { type: "object", description: "Parsed TwinTrace object (alternative to path)" },
          name: { type: "string", description: "Optional display name" },
        },
      },
      handler: (args) => {
        if (args.path) traceReplay.loadFromFile(String(args.path));
        else if (args.trace) traceReplay.load(args.trace as any, (args.name as string) ?? null);
        else throw new Error("analysis.load requires either 'path' or 'trace'");
        return traceReplay.getInfo();
      },
    },

    {
      name: "analysis.jump",
      description: "Jump the replay cursor to a specific event index (0..totalEvents). Returns the new position.",
      inputSchema: {
        type: "object",
        required: ["eventId"],
        properties: {
          eventId: { type: "number", description: "Timeline index. 0 = before any events, N = after all N events." },
        },
      },
      handler: (args) => traceReplay.jump(Number(args.eventId)),
    },

    {
      name: "analysis.whatIf",
      description: "Fork the trace at eventId, run an alternative command on the fork, and return the fork's id, command result, and diff against the original trace at the branch point.",
      inputSchema: {
        type: "object",
        required: ["atEventId", "rawCommand"],
        properties: {
          atEventId: { type: "number" },
          rawCommand: { type: "string", description: "Raw FW command to run on the fork" },
        },
      },
      handler: (args) => {
        const handle = traceReplay.fork(Number(args.atEventId));
        const result = traceReplay.forkCommand(handle.forkId, String(args.rawCommand));
        const diff = traceReplay.diffFork(handle.forkId);
        return { forkId: handle.forkId, branchedAtIndex: handle.branchedAtIndex, result, diff };
      },
    },

    {
      name: "analysis.inspectWell",
      description: "Return per-well history for the currently loaded trace: volume over time, liquid contents, and the timeline events that affected the well.",
      inputSchema: {
        type: "object",
        required: ["carrierId", "position", "wellIndex"],
        properties: {
          carrierId: { type: "string" },
          position: { type: "number" },
          wellIndex: { type: "number" },
        },
      },
      handler: (args) => {
        const key = `${args.carrierId}:${args.position}:${args.wellIndex}`;
        const events = traceReplay.getAllEvents().filter((e) => eventTouchesWell(e, key));
        const volumeSeries: Array<{ eventId: number; volume: number }> = [];
        // Sample volumes at event boundaries by re-computing state at each.
        // Cheap given snapshots — but we don't want N snapshots for big
        // traces. Limit the series to events that actually touch the well.
        for (const e of events) {
          const idx = traceReplay.getAllEvents().findIndex((x) => x.id === e.id);
          if (idx < 0) continue;
          const state = traceReplay.getStateAt(idx + 1);
          const vol = (state.tracking.wellVolumes as any)?.[key] ?? 0;
          volumeSeries.push({ eventId: e.id, volume: vol });
        }
        // Current (latest) state.
        const latestState = traceReplay.getStateAt(traceReplay.getInfo().totalEvents);
        return {
          wellKey: key,
          currentVolume: (latestState.tracking.wellVolumes as any)?.[key] ?? 0,
          currentLiquid: (latestState.liquid.wellContents as any)?.[key] ?? null,
          events,
          volumeSeries,
        };
      },
    },

    {
      name: "analysis.findIssues",
      description: "Run the lifecycle classifier and return every event currently marked 'flagged' on the loaded trace.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const events = traceReplay.getAllEvents();
        autoClassify(events);
        return getFlagged(events);
      },
    },

    {
      name: "analysis.summary",
      description: "Return lifecycle counts for the loaded trace (total/active/expected/flagged/suppressed/resolved).",
      inputSchema: { type: "object", properties: {} },
      handler: () => getSummary(traceReplay.getAllEvents()),
    },

    // ===== report.* (Phase 4 Step 4.A) ===================================

    {
      name: "report.summary",
      description: "Protocol summary report for the currently loaded trace: duration, command/step counts, assessment breakdown, flagged count.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const trace = requireTrace(traceReplay);
        return protocolSummary(trace);
      },
    },

    {
      name: "report.well",
      description: "Per-well history for the currently loaded trace: final volume/liquid and the timeline operations that touched the well.",
      inputSchema: {
        type: "object",
        required: ["carrierId", "position", "wellIndex"],
        properties: {
          carrierId: { type: "string" },
          position: { type: "number" },
          wellIndex: { type: "number" },
        },
      },
      handler: (args) => {
        const trace = requireTrace(traceReplay);
        const key = `${args.carrierId}:${args.position}:${args.wellIndex}`;
        return wellReport(trace, key);
      },
    },

    {
      name: "report.assessmentsCsv",
      description: "Every assessment event on the currently loaded trace, rendered as CSV (stable header, RFC-4180 quoting).",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const trace = requireTrace(traceReplay);
        return { csv: assessmentCsv(trace) };
      },
    },

    {
      name: "report.timing",
      description: "Per-command and per-step timing breakdown for the currently loaded trace (estimated time + wall clock).",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const trace = requireTrace(traceReplay);
        return timingReport(trace);
      },
    },

    {
      name: "deck.importVenusLayout",
      description: "Import a VENUS .lay file to build a Deck for a NEW device. Returns the new deviceId, metadata, placements, and any warnings (unknown carriers/labware that were skipped).",
      inputSchema: {
        type: "object",
        properties: {
          lay: { type: "string", description: "Raw .lay file contents. Alternative to `path`." },
          path: { type: "string", description: "Absolute path to a .lay file on disk. Alternative to `lay`." },
          name: { type: "string", description: "Optional display name for the new device." },
        },
      },
      handler: (args) => {
        let layPayload: string | Buffer;
        if (typeof args.lay === "string" && args.lay.length > 0) layPayload = args.lay as string;
        else if (typeof args.path === "string" && args.path.length > 0) layPayload = fs.readFileSync(args.path as string);
        else throw new Error("deck.importVenusLayout requires 'lay' or 'path'");
        const doc = parseHxCfg(layPayload);
        const { deck, placements, warnings, metadata } = importVenusLayout(doc);
        const deviceId = api.createDevice({ name: (args.name as string) ?? metadata.activeLayer ?? "imported", deck });
        return { deviceId, metadata, placements, warnings };
      },
    },

    {
      name: "deck.loadLayout",
      description: "Hot-swap the ACTIVE device's deck with a layout parsed from a VENUS .lay file. Preserves SCXML state and bridge connections — the twin keeps talking to VENUS without reconnection. Returns placements, warnings, and metadata; no new deviceId (use deck.importVenusLayout for that).",
      inputSchema: {
        type: "object",
        properties: {
          lay: { type: "string", description: "Raw .lay file contents. Alternative to `path`." },
          path: { type: "string", description: "Absolute path to a .lay file on disk. Alternative to `lay`. When provided, subsequent `reset` calls re-read the file so the layout survives resets." },
        },
      },
      handler: (args) => {
        let layPayload: string | Buffer;
        let sourcePath: string | null = null;
        if (typeof args.lay === "string" && args.lay.length > 0) layPayload = args.lay as string;
        else if (typeof args.path === "string" && args.path.length > 0) {
          sourcePath = args.path as string;
          layPayload = fs.readFileSync(sourcePath);
        } else throw new Error("deck.loadLayout requires 'lay' or 'path'");
        const doc = parseHxCfg(layPayload);
        const { deck, placements, warnings, metadata } = importVenusLayout(doc);
        const factory = sourcePath
          ? () => importVenusLayout(parseHxCfg(fs.readFileSync(sourcePath!))).deck
          : undefined;
        api.setDeck(getActiveDeviceId(), deck, factory);
        // #60 — tell the renderer to re-fetch /deck + redraw. The REST
        // path does the same; keeping parity across transports means a
        // user driving deck.loadLayout from MCP sees their layout
        // without reloading the page.
        deps.broker?.broadcast("deck-loaded", {
          deviceId: getActiveDeviceId(),
          source: sourcePath ? "file" : "inline",
          path: sourcePath,
          metadata,
          placements,
          warnings,
        });
        return { metadata, placements, warnings, source: sourcePath ? "file" : "inline", path: sourcePath };
      },
    },

    {
      name: "venus.loadConfig",
      description: "Hot-swap the VENUS instrument configuration (ML_STAR.cfg) on the ACTIVE device so its C0QM / C0RM / C0RI / C0RF / C0RU responses match a specific VENUS install. Opt-in only — no auto-detect. Returns the new moduleBits / totalTracks / serial that clients can assert on.",
      inputSchema: {
        type: "object",
        properties: {
          cfg: { type: "string", description: "Raw .cfg file contents. Alternative to `path`." },
          path: { type: "string", description: "Absolute path to an ML_STAR.cfg on disk. Alternative to `cfg`." },
        },
      },
      handler: (args) => {
        let cfgText: string;
        let sourcePath: string | null = null;
        if (typeof args.cfg === "string" && args.cfg.length > 0) {
          cfgText = args.cfg as string;
        } else if (typeof args.path === "string" && args.path.length > 0) {
          sourcePath = args.path as string;
          cfgText = fs.readFileSync(sourcePath, "utf-8");
        } else {
          throw new Error("venus.loadConfig requires 'cfg' or 'path'");
        }
        const cfgSections = parseHxCfgSections(cfgText);
        const deviceId = getActiveDeviceId();
        const current = api.getVenusConfig(deviceId);
        const merged = buildVenusConfig({ cfgSections, overrides: current });
        api.setVenusConfig(deviceId, merged);
        deps.broker?.broadcast("venus-config-loaded", {
          deviceId, source: sourcePath ? "file" : "inline", path: sourcePath,
          moduleBits: merged.moduleBits, totalTracks: merged.totalTracks, serial: merged.serial,
        });
        return {
          moduleBits: merged.moduleBits,
          moduleBitsHex: merged.moduleBits.toString(16).padStart(6, "0"),
          totalTracks: merged.totalTracks,
          serial: merged.serial,
          source: sourcePath ? "file" : "inline",
          path: sourcePath,
        };
      },
    },

    {
      name: "report.diff",
      description: "Structured diff report for a what-if fork, translating a ForkDiff into tabular rows + summary counts.",
      inputSchema: {
        type: "object",
        required: ["forkId"],
        properties: {
          forkId: { type: "string" },
        },
      },
      handler: (args) => {
        const diff = traceReplay.diffFork(String(args.forkId));
        return diffReport(diff);
      },
    },

    // ===== docs.* — self-describing catalogue for agents =================
    //
    // An LLM first talking to the twin asks "what commands can I send?
    // what modules are there? what labware?" — these tools answer
    // those without the agent having to parse source files. Every
    // discovery tool returns plain JSON suitable for including in a
    // prompt.

    {
      name: "docs.overview",
      description: "Return a terse overview of the twin: instrument name, module list, FW-event count, step-type count, labware-catalog + carrier-catalog sizes, and the URLs of the main REST endpoints an agent can hit. Use this FIRST if you're a new agent introducing yourself to the twin.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const mods = createModuleRegistry();
        const allEvents = new Set<string>();
        for (const m of mods) for (const e of m.events) allEvents.add(e);
        return {
          instrument: "Hamilton Microlab STAR",
          description: "FW-level digital twin. Accepts the same C0.. firmware commands the physical instrument does (VENUS-compatible via BDZ TCP bridge on port 34567).",
          modules: mods.map(m => ({ id: m.id, name: m.name, eventCount: m.events.length })),
          fwEventCount: allEvents.size,
          stepTypes: api.listStepTypes(),
          labwareCatalogEntries: listCatalogTypes().length,
          carrierCatalogEntries: listCarrierCatalogTypes().length,
          restEndpoints: {
            command: "POST /command { raw: string, simSpeed?: number }",
            state: "GET /state",
            tracking: "GET /tracking",
            step: "POST /step { type: string, params: {...} }",
            reset: "POST /reset",
            deckLoad: "POST /api/deck/load { path: string }",
            sse: "GET /sse  (command-result, state-changed, assessment, motion events)",
          },
          discoveryTools: [
            "docs.listModules", "docs.listFwCommands", "docs.describeFwCommand",
            "docs.listStepTypes", "docs.describeStepType",
            "docs.listLabware", "docs.describeLabware",
            "docs.listCarriers", "docs.describeCarrier",
          ],
        };
      },
    },

    {
      name: "docs.listModules",
      description: "List the twin's SCXML state-machine modules with the full set of firmware events each one handles. Each module's `events` field is the authoritative mapping from C0.. event codes to owning state machine.",
      inputSchema: { type: "object", properties: {} },
      handler: () => createModuleRegistry().map(m => ({
        id: m.id, name: m.name, events: [...m.events],
      })),
    },

    {
      name: "docs.listFwCommands",
      description: "Flat list of every firmware event the twin recognises, tagged with its owning module. This is the universe of `raw` strings that `twin.sendCommand` can accept (plus per-command params). Sorted by event code.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const mods = createModuleRegistry();
        const rows: { event: string; module: string; hasDetailedParamSpec: boolean }[] = [];
        const detailed = new Set(["C0AS", "C0DS"]);
        for (const m of mods) {
          for (const e of m.events) {
            rows.push({ event: e, module: m.id, hasDetailedParamSpec: detailed.has(e) });
          }
        }
        rows.sort((a, b) => a.event.localeCompare(b.event));
        return rows;
      },
    },

    {
      name: "docs.describeFwCommand",
      description: "Detailed parameter spec for a specific firmware command. For C0AS (aspirate) and C0DS (dispense) this returns the full VENUS-sourced catalogue — wire key, VENUS field name, description, scope (per-channel vs global), wire-width, source-ref, trace example, and which subsystem consumes the value (timing / physics / state / echo-only). Other commands return the owning module + event code only (param spec not yet catalogued outside the PIP family).",
      inputSchema: {
        type: "object",
        required: ["event"],
        properties: {
          event: { type: "string", description: "FW event code, e.g. 'C0AS', 'C0TP'" },
        },
      },
      handler: (args) => {
        const event = String(args.event).toUpperCase();
        const mods = createModuleRegistry();
        const owner = mods.find(m => m.events.includes(event));
        const base = {
          event,
          module: owner?.id ?? null,
          moduleName: owner?.name ?? null,
        };
        if (event === "C0AS") return { ...base, params: C0AS_PARAMS, note: "Real-trace example available via docs.describeFwCommand(C0AS)." };
        if (event === "C0DS") return { ...base, params: C0DS_PARAMS };
        return { ...base, params: null, note: "Detailed parameter catalogue not yet authored for this event. Inspect the module's SCXML in src/state-machines/modules/ or send a probe command to observe the datamodel write." };
      },
    },

    {
      name: "docs.listStepTypes",
      description: "List every high-level step type the twin's /step endpoint (and `twin.executeStep`) can execute. Each step decomposes into multiple FW commands; use this to pick the right semantic action rather than hand-crafting raw C0.. strings.",
      inputSchema: { type: "object", properties: {} },
      handler: () => api.listStepTypes(),
    },

    {
      name: "docs.listLabware",
      description: "Enumerate the labware catalogue: plates, tip racks, troughs, etc. Each entry carries dimensions (well pitch, offsets), dead volume, max volume, and well geometry (shape, diameters, depth). Use this to figure out what 'type' strings `fill`/`placeLabware` steps accept and what the physical properties are for validation.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional category filter, e.g. 'plate96', 'tips', 'trough'." },
        },
      },
      handler: (args) => {
        const cat = args.category ? String(args.category) : null;
        const rows = DEFAULT_LABWARE_CATALOG.filter(e => !cat || e.category === cat).map(e => ({
          type: e.type, category: e.category, description: e.description,
          rows: e.rows, columns: e.columns, wellCount: e.wellCount,
          wellPitch_01mm: e.wellPitch, height_01mm: e.height,
          deadVolume_01ul: (e as any).deadVolume, maxVolume_01ul: (e as any).maxVolume,
        }));
        return rows;
      },
    },

    {
      name: "docs.describeLabware",
      description: "Full catalogue entry for a single labware type — every field the catalogue holds (including well-shape geometry, cornerRadius, hasConicalBottom, etc.). Returns null if not found; call docs.listLabware first to see available types.",
      inputSchema: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string" } },
      },
      handler: (args) => findCatalogEntry(String(args.type)) ?? null,
    },

    {
      name: "docs.listCarriers",
      description: "Enumerate the carrier catalogue — plate carriers, tip carriers, MFX / reagent carriers, waste blocks — with track footprint, per-site Y offsets, and physical height. Use to understand which `type` strings the twin's placement / import logic accepts.",
      inputSchema: { type: "object", properties: {} },
      handler: () => DEFAULT_CARRIER_CATALOG.map(c => ({
        type: c.type, positions: c.positions, widthTracks: c.widthTracks,
        siteYOffsets_01mm: c.siteYOffsets ? [...c.siteYOffsets] : undefined,
        yDim_01mm: c.yDim,
      })),
    },

    {
      name: "docs.describeCarrier",
      description: "Full catalogue entry for a single carrier type. Returns null if not found; call docs.listCarriers for available types.",
      inputSchema: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string" } },
      },
      handler: (args) => findCarrierCatalogEntry(String(args.type)) ?? null,
    },
  ];
}

/** Shared guard so every report.* tool fails with the same useful message. */
function requireTrace(traceReplay: TraceReplayService) {
  const t = traceReplay.getTrace();
  if (!t) throw new Error("no trace loaded — call analysis.load first");
  return t;
}

// --- helpers ----------------------------------------------------------

/** Hamilton well index → label. Row-major: index 0 = A1, 1 = A2, … */
function wellLabel(index: number, columns: number): string {
  const row = Math.floor(index / columns);
  const col = index % columns;
  return String.fromCharCode(65 + row) + (col + 1);
}

/** Compact labware summary the LLM can read at a glance. Plates report
 *  occupied/total + a few sample wells; tip racks report tipsUsed/total
 *  ("full" = all tips present, "empty" = all used). Keys in wellVolumes /
 *  tipUsage are `${carrierId}:${position}:${wellIndex}`. */
function summarizeLabware(
  carrierId: string,
  position: number,
  lw: { type: string; wellCount: number; rows: number; columns: number; barcode?: string },
  wellVolumes: Record<string, number>,
  tipUsage: Record<string, boolean>,
  wellContents: Record<string, { liquidType: string; liquidClass?: string }>,
  sampleCap: number,
): Record<string, unknown> {
  const prefix = `${carrierId}:${position}:`;
  const isTipRack = findCatalogEntry(lw.type)?.category === "tip_rack";

  const out: Record<string, unknown> = {
    position,
    type: lw.type,
    barcode: lw.barcode,
    rows: lw.rows,
    columns: lw.columns,
    wellCount: lw.wellCount,
  };

  if (isTipRack) {
    // Tip racks start full (all tips present). tipUsage only gets entries
    // for positions that have been picked/ejected at least once, so "no
    // entry" == "tip still present".
    let tipsUsed = 0;
    for (const [k, used] of Object.entries(tipUsage)) {
      if (!k.startsWith(prefix)) continue;
      if (used) tipsUsed++;
    }
    out.tipsUsed = tipsUsed;
    out.fill = tipsUsed === 0 ? "full" : tipsUsed >= lw.wellCount ? "empty" : "partial";
  } else {
    let occupied = 0;
    const sampleWells: Array<[string, { vol: number; liquid?: string }]> = [];
    for (const [k, v] of Object.entries(wellVolumes)) {
      if (!k.startsWith(prefix)) continue;
      if (v > 0) {
        occupied++;
        if (sampleCap > 0 && sampleWells.length < sampleCap) {
          const idx = Number(k.slice(prefix.length));
          const contents = wellContents[k];
          sampleWells.push([
            wellLabel(idx, lw.columns),
            { vol: v, liquid: contents?.liquidType },
          ]);
        }
      }
    }
    out.occupied = occupied;
    out.fill = fillLevel(occupied, lw.wellCount);
    if (sampleWells.length > 0) {
      out.samples = Object.fromEntries(sampleWells);
    }
  }
  return out;
}

/** Count wells with volume > 0 under one labware slot. Kept separate because
 *  twin.getWells needs just the count without building samples. */
function countOccupiedWells(
  wellVolumes: Record<string, number>,
  carrierId: string,
  position: number,
): number {
  const prefix = `${carrierId}:${position}:`;
  let n = 0;
  for (const [k, v] of Object.entries(wellVolumes)) {
    if (k.startsWith(prefix) && v > 0) n++;
  }
  return n;
}

function fillLevel(occupied: number, total: number): "empty" | "partial" | "full" {
  if (occupied === 0) return "empty";
  if (occupied >= total) return "full";
  return "partial";
}

/** A module is "default" when its leaf (deepest) SCXML state is an idle
 *  synonym — useful for `twin.getModules({nonDefaultOnly:true})`. */
function isDefaultModuleState(states: string[]): boolean {
  if (states.length === 0) return true;
  const leaf = states[states.length - 1].toLowerCase();
  return leaf === "idle" || leaf === "ready" || leaf === "off" || leaf === "standby" || leaf === "unpowered";
}

function eventTouchesWell(e: TwinTimelineEvent, wellKey: string): boolean {
  if (e.kind === "deck_interaction") {
    const p = e.payload as any;
    const r = p.resolution;
    if (r?.matched) {
      return `${r.carrierId}:${r.position}:${r.wellIndex}` === wellKey;
    }
  }
  if (e.kind === "assessment") {
    const a = e.payload as AssessmentEvent;
    const d = a.data;
    if (d && d.carrierId !== undefined && d.position !== undefined && d.wellIndex !== undefined) {
      return `${d.carrierId}:${d.position}:${d.wellIndex}` === wellKey;
    }
  }
  if (e.kind === "command") {
    const c = e.payload as CommandResult;
    if (c.deckInteraction?.resolution?.matched) {
      const r = c.deckInteraction.resolution;
      return `${r.carrierId}:${r.position}:${r.wellIndex}` === wellKey;
    }
  }
  return false;
}
