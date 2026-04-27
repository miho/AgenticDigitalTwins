/**
 * Hamilton STAR Digital Twin
 *
 * Executor-per-module architecture:
 * Each hardware module has its own SCXML state machine wrapped in a
 * ContinuousExecutor. A command router dispatches FW events to the
 * correct module executor. Physics plugins can be attached per module.
 */

import { parseFwCommand, formatFwResponse, errorFormatFor, FwCommand } from "./fw-protocol";
import { estimateCommandTime } from "./command-timing";
import { createModuleRegistry, buildEventMap, ModuleEntry } from "./module-registry";
import { PhysicsPlugin, createPluginTraceListener } from "./plugin-interface";
import { PipPhysicsPlugin } from "./plugins/pip-physics";
import { CoRe96HeadPhysicsPlugin } from "./plugins/h96-physics";
import { ISwapPhysicsPlugin } from "./plugins/iswap-physics";
import { TemperaturePhysicsPlugin } from "./plugins/temperature-physics";
import { CoRe384HeadPhysicsPlugin } from "./plugins/h384-physics";
import { HHSPhysicsPlugin } from "./plugins/hhs-physics";
import { WashPhysicsPlugin } from "./plugins/wash-physics";
import { Deck, DeckSnapshot, createDefaultDeckLayout } from "./deck";
import {
  VenusConfig,
  buildVenusConfig,
  encodeC0QM,
  encodeC0RM,
  encodeC0RI,
  encodeC0RF,
  encodeC0RU,
} from "./venus-config";
import { DeckTracker, DeckInteraction, DeckResolution } from "./deck-tracker";
import { DeviceEventEmitter, DeviceEvent, DeviceEventListener } from "./device-events";
import { AssessmentStore, AssessmentEvent } from "./assessment";
import { EventSpine } from "./timeline";
import spec from "./hamilton-star-digital-twin.json";

/** Result of processing a single command */
export interface CommandResult {
  /** The raw FW command string that was sent. Needed by the replay
   *  service (Step 3.1) to re-execute commands when jumping between
   *  trace snapshots. */
  rawCommand: string;
  response: string;
  targetModule: string;
  activeStates: Record<string, string[]>;
  variables: Record<string, Record<string, unknown>>;
  logs: string[];
  accepted: boolean;
  errorCode: number;
  errorDescription: string;
  /** Deck interaction: what physical object was affected (if any) */
  deckInteraction?: DeckInteraction;
  /** Assessment observations from physics plugins */
  assessments?: AssessmentEvent[];
  /** Monotonically increasing ID assigned by the twin to this command.
   *  Every event emitted as a consequence of this command carries the
   *  same id in its `correlationId` field. */
  correlationId: number;
  /** If this command ran inside an executeStep() call, the step's id. */
  stepId?: number;
}

/** Options for sendCommand to link it to a higher-level step. */
export interface SendCommandOptions {
  /** Tag every event emitted by this command with the given stepId. */
  stepId?: number;
  /**
   * Skip motion-envelope emission from inside sendCommand. Set by the
   * `/command` deferred path — where the envelope has already been
   * emitted at t=0 by `prepareAndEmitMotionEnvelope`, and running
   * `sendCommand` at t=delayMs to commit the state should NOT re-emit
   * a duplicate envelope from the now-post-move datamodel. Tests and
   * the bridge path leave this unset (false), so the long-standing
   * immediate behaviour is untouched.
   */
  suppressMotionEnvelope?: boolean;
}

/**
 * Motion envelope — describes one arm's continuous trajectory from `start` to
 * `end`, lasting `durationMs` wall clock starting at `startTime`. Emitted by
 * the twin as soon as a motion-producing FW event is accepted (before the
 * state change lands) so the renderer can interpolate arm position during the
 * travel instead of snapping at the end.
 *
 * Coordinates are in 0.1 mm (the twin's native unit). `startTime` is
 * `Date.now()` at emit. At `performance.now() − (startTime − now0) ≥ durationMs`
 * the move is complete and the renderer should pin to (endX, endY).
 */
export interface MotionEnvelope {
  arm: "pip" | "iswap" | "h96" | "h384" | "autoload";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Z axis (0.1mm). 0 = retracted / traverse. Present for arms that
   *  carry a vertical drive (pip/iswap/h96/h384); omitted for autoload
   *  which only slides X on the front rail. */
  startZ?: number;
  endZ?: number;
  /** Optional Z waypoint for commands that dive into a well and come
   *  back — C0AS / C0DS enter the liquid at `zp`, run the plunger,
   *  then retract. When set, the renderer interpolates in three
   *  phases: descend (startZ → dwellZ), hold (dwellZ during the
   *  plunger-stroke window), retract (dwellZ → endZ). Omitted for
   *  pure-translation moves (C0JM, C0TP, C0TR) which can use linear
   *  start→end interpolation. #62 part 2. */
  dwellZ?: number;
  /**
   * Safe traversal height (0.1 mm). When present AND the envelope
   * carries meaningful XY travel, the sampler does CNC-style motion:
   *   phase 1: retract Z to traverseZ (if below it)
   *   phase 2: travel XY at traverseZ — Z held high
   *   phase 3: descend Z to endZ (or dwellZ for aspirate/dispense)
   *   phase 4: hold (dwell commands only)
   *   phase 5: retract Z to endZ (dwell commands with XY travel)
   * This is what a real STAR does and why channels don't smash
   * through labware mid-traverse. Populated by extractMotionEnvelope
   * from the module datamodel (`z_traverse`, `zh`, etc.). Omitting it
   * falls back to linear interpolation for back-compat with any
   * envelope producer that hasn't been taught the CNC contract yet.
   */
  traverseZ?: number;
  /**
   * Per-channel Y targets (0.1 mm, length = channel_count). When present
   * the sampler interpolates each channel's Y independently instead of
   * collapsing the arm to a single scalar. VENUS sends `yp` as a space-
   * separated array on C0TP/C0TR/C0AS/C0DS; parseFwCommand stores it as
   * `_yp_array` — we forward it to the renderer through this field so
   * the 2D arm and 3D pins land at the actual commanded Y for each
   * channel (one channel in plate A, another in plate B is a real
   * motion).
   *
   * Channels whose PIP mask bit is 0 aren't moved by the command — their
   * entry here mirrors the current `pos_y[ch]` so sampling doesn't snap
   * them. When the array is absent, the envelope is arm-wide (all
   * channels share startY/endY).
   */
  startY_ch?: number[];
  endY_ch?: number[];
  /**
   * Per-channel Z targets (0.1 mm). Same shape + fallback rules as
   * startY_ch/endY_ch. Enables independent channel descent — e.g., 8
   * channels aspirating from wells of different depths.
   */
  startZ_ch?: number[];
  endZ_ch?: number[];
  /** Per-channel dwell Z (aspirate/dispense depth). Mirrors dwellZ
   *  semantics at the per-channel granularity. */
  dwellZ_ch?: number[];
  /** iSWAP plate orientation (degrees). 0 = landscape, 90 = portrait
   *  — real Hamilton's C0PP carries the `gr` flag (0/1); we translate
   *  it to degrees so the renderer can interpolate smoothly. */
  startRotation?: number;
  endRotation?: number;
  /** iSWAP gripper Y-span (0.1mm jaw-to-jaw distance). Tracked so the
   *  renderer can animate the jaws opening/closing during C0PP / C0PR. */
  startGripWidth?: number;
  endGripWidth?: number;
  /** iSWAP-held plate footprint (0.1mm). Resolved from the labware at
   *  the pickup coords on C0PP so the renderer can draw the actual
   *  plate instead of the ANSI/SBS default. Omitted when no plate is
   *  resolvable — renderer falls back to the SBS 1278×855 standard. */
  startPlateWidth?: number;
  endPlateWidth?: number;
  startPlateHeight?: number;
  endPlateHeight?: number;
  startTime: number;   // ms since epoch
  durationMs: number;
  /** FW event that triggered the motion, for debugging / overlays. */
  command: string;
}

export type MotionListener = (envelope: MotionEnvelope) => void;

/** Snapshot of the full system state */
export interface SystemState {
  modules: Record<string, {
    states: string[];
    variables: Record<string, unknown>;
  }>;
  timestamp: number;
}

/** Log entry */
export interface LogEntry {
  label: string;
  message: string;
  module: string;
  timestamp: number;
}

export type StateChangeListener = (state: SystemState) => void;

/**
 * The Digital Twin.
 *
 * Usage:
 *   const twin = new DigitalTwin();
 *   const result = twin.sendCommand("C0ASid0001tm1av1000");
 */
export class DigitalTwin {
  private modules: ModuleEntry[];
  private eventMap: Map<string, ModuleEntry>;
  private plugins: Map<string, PhysicsPlugin> = new Map();
  /**
   * Global plugins — `assess()` runs on every accepted command regardless
   * of which module the command targets. Used for cross-module concerns
   * like collision detection where the plugin has to see PIP, 96-Head,
   * and iSWAP commands all in one place. Only the `assess` hook is
   * dispatched globally; per-module hooks like `validateCommand` /
   * `onBeforeEvent` remain scoped to registered modules.
   */
  private globalPlugins: PhysicsPlugin[] = [];
  private deck: Deck;
  private deckTracker: DeckTracker;
  private deviceEvents: DeviceEventEmitter;
  private assessmentStore: AssessmentStore;
  private eventSpine: EventSpine;
  private listeners: StateChangeListener[] = [];
  private motionListeners: MotionListener[] = [];
  private logs: LogEntry[] = [];
  private transitionFired: boolean = false;
  private errorCodes: Record<string, string>;
  private commandHistory: Array<{ command: string; result: CommandResult; timestamp: number }> = [];
  private deckFactory: (() => Deck) | null = null;
  // Monotonically increasing counters used to correlate every event emitted
  // as a consequence of a command or composite step. See Step 1.9.
  private correlationCounter = 0;
  private stepCounter = 0;
  /**
   * Front-cover open/closed state. Mirrors the physical cover sensor.
   * VENUS polls via `C0QC` and refuses to run anything while open. The
   * real instrument reports `qc0` when closed and `qc1` when open —
   * see VENUS-2026-04-13/Star/src/HxAtsInstrument/Code/
   *   AtsMcRequestCoverPosition.cpp:100 (the `coverOpen` >0 parse).
   * Default is closed so a fresh twin lets VENUS start methods; the
   * user can flip it via `setCoverOpen()` (UI / REST) to exercise
   * error recovery paths.
   */
  private coverOpen = false;

  /** VENUS-facing FW-identity + module-presence config. Derived from the
   *  deck at construction; callers can override via `setVenusConfig()`
   *  (e.g. to apply `--venus-cfg` or `--serial` CLI values). */
  private venusConfig: VenusConfig;

  constructor(deck?: Deck) {
    this.modules = createModuleRegistry();
    this.eventMap = buildEventMap(this.modules);
    this.errorCodes = (spec as any).error_codes || {};
    this.deck = deck ?? createDefaultDeckLayout();
    // Store the deck factory for reset (recreate from scratch)
    this.deckFactory = deck ? null : createDefaultDeckLayout;
    this.deckTracker = new DeckTracker(this.deck);
    this.venusConfig = buildVenusConfig({ deck: this.deck });
    this.deviceEvents = new DeviceEventEmitter();
    this.assessmentStore = new AssessmentStore();
    this.eventSpine = new EventSpine();
    // Mirror device events onto the spine so consumers have a single
    // source of truth. The emitter's own log continues to work unchanged.
    this.deviceEvents.onDeviceEvent((evt) => {
      this.eventSpine.add({
        kind: "device_event",
        correlationId: evt.correlationId,
        stepId: evt.stepId,
        payload: evt,
      });
    });
    this.attachPlugins();

    // Attach a SINGLE combined trace listener per module.
    // addTraceListener overwrites (not appends), so we must merge
    // log capture, transition detection, and physics plugin callbacks.
    for (const mod of this.modules) {
      const self = this;
      const modId = mod.id;
      const plugin = this.plugins.get(modId);

      const listener = new Proxy({}, {
        get(_target, prop) {
          if (prop === "onLog") {
            return (label: string, message: string) => {
              self.logs.push({ label, message, module: modId, timestamp: Date.now() });
            };
          }
          if (prop === "onTransitionExecute") {
            return (sourceId: string, targetIds: string[], event: string, _cond: string, _ts: number) => {
              self.transitionFired = true;
              // Forward to physics plugin
              if (plugin?.onAfterTransition) {
                const activeStates: string[] = Array.from(mod.executor.getActiveStateIds()) as string[];
                plugin.onAfterTransition({
                  source: sourceId,
                  targets: targetIds || [],
                  event: event || "",
                  activeStates,
                });
              }
            };
          }
          if (prop === "onStateEnter" && plugin?.onStateEnter) {
            return (stateId: string, activeStates: string[], _ts: number) => {
              plugin.onStateEnter!({ stateId, activeStates: activeStates || [] });
            };
          }
          return () => {};
        }
      });
      mod.executor.addTraceListener(listener);

      // State change callback — fires when delayed events (move.done, wash.done)
      // complete asynchronously. This pushes UI updates for timed operations.
      if (mod.executor.machine && mod.executor.machine.onStateChange) {
        mod.executor.machine.onStateChange(() => {
          self.notifyListeners();
        });
      }
    }
  }

  /**
   * Sub-device prefix routing.
   * Real Hamilton FW uses per-device prefixes (P1-PG for PIP channels,
   * H0 for 96-head, X0/I0 for iSWAP, R0 for gripper, PX for pump, etc.).
   * These are mostly diagnostic queries that don't change state.
   */
  private static SUB_DEVICE_MAP: Record<string, { module: string; description: string }> = {
    P1: { module: "pip", description: "PIP Channel 1" },
    P2: { module: "pip", description: "PIP Channel 2" },
    P3: { module: "pip", description: "PIP Channel 3" },
    P4: { module: "pip", description: "PIP Channel 4" },
    P5: { module: "pip", description: "PIP Channel 5" },
    P6: { module: "pip", description: "PIP Channel 6" },
    P7: { module: "pip", description: "PIP Channel 7" },
    P8: { module: "pip", description: "PIP Channel 8" },
    P9: { module: "pip", description: "PIP Channel 9" },
    PA: { module: "pip", description: "PIP Channel 10" },
    PB: { module: "pip", description: "PIP Channel 11" },
    PC: { module: "pip", description: "PIP Channel 12" },
    PD: { module: "pip", description: "PIP Channel 13" },
    PE: { module: "pip", description: "PIP Channel 14" },
    PF: { module: "pip", description: "PIP Channel 15" },
    PG: { module: "pip", description: "PIP Channel 16" },
    PX: { module: "pip", description: "Pump Unit" },
    H0: { module: "h96", description: "CoRe 96 Head" },
    D0: { module: "h384", description: "CoRe 384 Head" },
    X0: { module: "iswap", description: "iSWAP X-axis" },
    I0: { module: "iswap", description: "iSWAP Arm" },
    R0: { module: "gripper", description: "CO-RE Gripper" },
    W1: { module: "wash", description: "Washer 1" },
    W2: { module: "wash", description: "Washer 2" },
  };

  /**
   * Per-sub-device RF (firmware-version) strings. Exact shapes taken
   * from real VENUS ComTrace recordings — VENUS checks firmware
   * compatibility on every module, so these have to match the format
   * real hardware produces. We keep the instrument's own version/date
   * and only identify ourselves via the component name where VENUS
   * already ignores the parens group.
   */
  private static SUB_DEVICE_RF: Record<string, string> = {
    // PIP channels all run the same firmware — trace line 12-27.
    P1: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P2: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P3: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P4: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P5: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P6: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P7: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    P8: "rf6.0S 07 2024-12-18 (PipChannelRpc)",
    // Heads / iSWAP / gripper — trace lines 28-35.
    H0: "rf5.0S m 2025-05-26 (H0 XE167)",
    I0: "rf5.0S 16 2025-01-31 (ML STAR I0)",
    X0: "rf1.4S 2012-04-25",
    R0: "rf4.1S 2011-12-19",
  };

  /**
   * Canned responses for sub-device diagnostic QUERY commands. Only
   * genuine read-back commands belong here — write/ack commands are
   * expected to return the bare `er00` shape and MUST NOT appear in
   * this table (e.g. AF = "Set pipetting monitoring mode", a write
   * that real traces reply to with just `PXAFid####er00` — see
   *   VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/
   *   TipPickup/TipPickup1ml_ComTrace.trc:PXAFid0235
   * ).
   */
  private static SUB_DEVICE_RESPONSES: Record<string, string> = {
    RJ: "jd2025-01-01js1",
    RV: "na0000003000nb0000003000nc0000000700nd0000001000",
    VW: "vw1 2 1 1",
    QG: "qg2",
  };

  /**
   * Compose the sub-device response body for `<module><code>`. Returns
   * an empty string if the command has no canned response — the outer
   * code then emits just `id####` with no data, which is the real-VENUS
   * behaviour for unrecognised sub-device queries.
   */
  private static resolveSubDeviceResponse(module: string, code: string): string {
    if (code === "RF") {
      return DigitalTwin.SUB_DEVICE_RF[module] ?? "rf1.0S 2025-01-01 (DigitalTwin)";
    }
    return DigitalTwin.SUB_DEVICE_RESPONSES[code] ?? "";
  }

  /**
   * Allocate a new stepId. Callers (e.g. StepExecutor) should obtain one at
   * the start of a composite step and pass it to every sendCommand() they
   * issue within that step. See Step 1.9.
   */
  nextStepId(): number {
    return ++this.stepCounter;
  }

  /** Send a raw FW command string */
  sendCommand(rawCommand: string, options?: SendCommandOptions): CommandResult {
    const cmd = parseFwCommand(rawCommand);
    this.logs = [];
    this.transitionFired = false;
    const correlationId = ++this.correlationCounter;
    const stepId = options?.stepId;

    // Sub-device prefix handling: P1-PG, H0, X0, I0, R0, PX, W1, W2, D0
    const subDevice = DigitalTwin.SUB_DEVICE_MAP[cmd.module];
    if (subDevice && !this.eventMap.has(cmd.event)) {
      const cannedData = DigitalTwin.resolveSubDeviceResponse(cmd.module, cmd.code);
      const responseData = cannedData || "";
      // Real VENUS traces follow two sub-device response shapes
      // (see `VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/
      //  Star/**/TipPickup1ml_ComTrace.trc`):
      //   - Query commands (RF/RJ/RV/…) → `<M><C>id<N><data>`  (no er)
      //       e.g. `P1RFid0107rf6.0S …`, `P1RJid0108jd2025-01-01js1`
      //   - Write/ack commands (AF/ZI/…) → `<M><C>id<N>er00`   (bare er)
      //       e.g. `PXAFid0235er00`
      // Pre-phase-5 we used the no-er shape for all sub-device replies,
      // which made VENUS reject every write ack (PXAF → greyed-out
      // Control Panel). Pick the shape based on whether we have canned
      // data to emit.
      const idStr = String(cmd.orderId).padStart(4, "0");
      const response = responseData
        ? `${cmd.module}${cmd.code}id${idStr}${responseData}`
        : `${cmd.module}${cmd.code}id${idStr}er00`;
      this.logs.push({
        label: "FW",
        message: `${subDevice.description}: ${cmd.code} → ${responseData || "ok"}`,
        module: subDevice.module,
        timestamp: Date.now(),
      });
      const result: CommandResult = {
        rawCommand,
        response,
        targetModule: subDevice.description,
        activeStates: this.getAllActiveStates(),
        variables: this.getAllVariables(),
        logs: this.logs.map((l) => `[${l.module}] ${l.label}: ${l.message}`),
        accepted: true,
        errorCode: 0,
        errorDescription: "",
        correlationId,
        stepId,
      };
      this.commandHistory.push({ command: rawCommand, result, timestamp: Date.now() });
      this.eventSpine.add({ kind: "command", correlationId, stepId, payload: result });
      return result;
    }

    // Always-accepted commands: queries, config writes, status checks.
    // These must NOT go through the SCXML (which might have transitions
    // that inadvertently change state for query commands like C0RT).
    if (this.isAlwaysAcceptedCommand(cmd.event)) {
      const responseData = this.generateResponseData(cmd.event, cmd.params);
      const response = formatFwResponse(cmd.module, cmd.code, cmd.orderId, 0, 0, responseData, errorFormatFor(cmd.module, cmd.code));
      this.logs.push({
        label: "FW",
        message: `${cmd.event} (query/config — always accepted)`,
        module: "master",
        timestamp: Date.now(),
      });
      const result: CommandResult = {
        rawCommand,
        response,
        targetModule: "system",
        activeStates: this.getAllActiveStates(),
        variables: this.getAllVariables(),
        logs: this.logs.map((l) => `[${l.module}] ${l.label}: ${l.message}`),
        accepted: true,
        errorCode: 0,
        errorDescription: "",
        correlationId,
        stepId,
      };
      this.commandHistory.push({ command: rawCommand, result, timestamp: Date.now() });
      this.eventSpine.add({ kind: "command", correlationId, stepId, payload: result });
      return result;
    }

    // Find the target module
    const target = this.eventMap.get(cmd.event);

    if (!target) {
      // No module handles this event
      const response = formatFwResponse(cmd.module, cmd.code, cmd.orderId, 15, 0, undefined, errorFormatFor(cmd.module, cmd.code));
      const result: CommandResult = {
        rawCommand,
        response,
        targetModule: "unknown",
        activeStates: this.getAllActiveStates(),
        variables: this.getAllVariables(),
        logs: [`REJECTED: No module handles event ${cmd.event}`],
        accepted: false,
        errorCode: 15,
        errorDescription: "Not allowed parameter combination",
        correlationId,
        stepId,
      };
      this.commandHistory.push({ command: rawCommand, result, timestamp: Date.now() });
      this.eventSpine.add({ kind: "command", correlationId, stepId, severity: "error", payload: result });
      return result;
    }

    // Snapshot before
    const statesBefore: string[] = Array.from(target.executor.getActiveStateIds()) as string[];
    const varsBefore = JSON.stringify(this.getModuleVariables(target));

    // Let the physics plugin preprocess the event data
    // Include per-channel array params (e.g. yp=[1375,1285,...]) alongside scalar params
    let eventData: Record<string, unknown> = { ...cmd.params };
    if (cmd.arrayParams) {
      for (const [key, arr] of Object.entries(cmd.arrayParams)) {
        eventData[`_${key}_array`] = arr;
      }
    }
    const plugin = this.getPlugin(target.id);

    // Emit an unresolved-position assessment early (#34) so it fires even
    // when physics validation below rejects the command. The assessment is
    // observational — independent of command acceptance — and has the same
    // value whether or not the rejection path short-circuits.
    const earlyUnresolved = this.maybeEmitUnresolvedFromParams(cmd.event, eventData, target.id, correlationId, stepId);
    if (earlyUnresolved) {
      this.eventSpine.add({
        kind: "assessment",
        correlationId,
        stepId,
        severity: earlyUnresolved.severity,
        payload: earlyUnresolved,
      });
    }

    // Physics validation: check physical constraints BEFORE SCXML.
    // We also hand the plugin the module's current datamodel so it can see
    // per-channel state (tip_fitted, volume, …) — needed for error 07
    // ("tip already fitted") and similar per-channel guards that can't be
    // expressed from deckTracker alone.
    if (plugin?.validateCommand) {
      const dm = (target.executor as any)?.machine?._datamodel ?? {};
      const validation = plugin.validateCommand(cmd.event, eventData, this.deckTracker, dm);
      if (validation && !validation.valid) {
        const response = formatFwResponse(cmd.module, cmd.code, cmd.orderId, validation.errorCode || 99, 0, undefined, errorFormatFor(cmd.module, cmd.code));
        const result: CommandResult = {
          rawCommand,
          response,
          targetModule: target.id,
          activeStates: this.getAllActiveStates(),
          variables: this.getAllVariables(),
          logs: [`[${target.id}] PHYSICS: ${validation.errorDescription || `error ${validation.errorCode}`}`],
          accepted: false,
          errorCode: validation.errorCode || 99,
          errorDescription: validation.errorDescription || "",
          // Include the early unresolved-position assessment so consumers
          // see it alongside the physics rejection.
          assessments: earlyUnresolved ? [earlyUnresolved] : undefined,
          correlationId,
          stepId,
        };
        this.commandHistory.push({ command: rawCommand, result, timestamp: Date.now() });
        this.eventSpine.add({ kind: "command", correlationId, stepId, severity: "error", payload: result });
        return result;
      }
    }

    if (plugin?.onBeforeEvent) {
      eventData = plugin.onBeforeEvent(cmd.event, eventData);
    }

    // Master-owned X-axis moves have no physics plugin to stamp
    // `_delay`, so `extractMotionEnvelope` would read durationMs=0 and
    // skip the envelope. Fill `_delay` from the static timing estimate
    // so the renderer interpolates the ghost arm across its travel.
    if (target.id === "master" && !eventData._delay && /^C0(KX|KR|JX|JS)$/.test(cmd.event)) {
      const ms = estimateCommandTime(cmd.event, eventData);
      if (ms > 0) eventData._delay = `${ms}ms`;
    }

    // AutoLoad carriage moves (C0CL/C0CR) — same story: no physics
    // plugin stamps `_delay`, but the SCXML loading/unloading states
    // need it for their onentry `<send delay=...>` timers and the
    // motion envelope extraction reads it for durationMs.
    if (target.id === "autoload" && !eventData._delay && /^C0(CL|CR)$/.test(cmd.event)) {
      const ms = estimateCommandTime(cmd.event, eventData);
      if (ms > 0) eventData._delay = `${ms}ms`;
    }

    // Emit a motion envelope for commands that actually move an arm.
    // We read the pre-move position from the datamodel, target from event
    // data, and duration from the `_delay` the physics plugin just computed.
    // Emitted *before* executor.send so the envelope reaches the client
    // with genuine lead time for in-flight interpolation. Rejection is
    // surfaced separately via the command-log entries below
    // (REJECTED / PHYSICS / DECK — see the accepted/errorCode handling
    // that follows).
    //
    // `suppressMotionEnvelope` is set by the REST /command deferred path
    // where the envelope was already emitted at t=0 via
    // `prepareAndEmitMotionEnvelope`, and this sendCommand call is the
    // delayed commit — emitting again here would reset the animation
    // just as it was finishing.
    const preMoveDm = this.getModuleVariables(target);
    if (!options?.suppressMotionEnvelope) {
      const envelope = this.extractMotionEnvelope(cmd.event, target.id, eventData, preMoveDm);
      if (envelope) this.emitMotion(envelope);
    }

    // Send to the executor
    target.executor.send(cmd.event, eventData);

    // Cross-module sync: master-owned X-axis moves carry the PIP arm
    // (and iSWAP arm on the right side) physically on the real STAR.
    // Mirror master's left_arm_x / right_arm_x into the child modules
    // so the renderer's ghost arm — which reads pip.pos_x / iswap.pos_x —
    // tracks C0KX/C0KR issued by VENUS or any external caller.
    if (target.id === "master" && /^C0(KX|KR|JX|JS)$/.test(cmd.event)) {
      const xs = typeof eventData.xs === "number" ? eventData.xs : Number(eventData.xs) || 0;
      if (xs > 0) {
        const childId = (cmd.event === "C0KR" || cmd.event === "C0JS") ? "iswap" : "pip";
        const child = this.modules.find((m) => m.id === childId);
        const childDm = (child?.executor as any)?.machine?._datamodel;
        if (childDm) childDm.pos_x = xs;
      }
    }

    // Snapshot after
    const statesAfter: string[] = Array.from(target.executor.getActiveStateIds()) as string[];
    const varsAfter = JSON.stringify(this.getModuleVariables(target));

    // Detect acceptance
    const statesChanged = JSON.stringify(statesBefore) !== JSON.stringify(statesAfter);
    const varsChanged = varsBefore !== varsAfter;
    let accepted = statesChanged || varsChanged || this.transitionFired || this.logs.length > 0;

    // Detect error
    let errorCode = 0;
    let errorDescription = "";

    // Check if module is now in an error state
    const inError = statesAfter.some((s: string) => s.includes("error"));
    if (inError) {
      const vars = this.getModuleVariables(target);
      errorCode = typeof vars["last_error"] === "number" ? vars["last_error"] as number : 99;
      errorDescription = this.getErrorDescription(errorCode);
    }

    // If command was silently dropped by SCXML, it's a rejection
    if (!accepted) {
      errorCode = this.inferRejectionError(cmd.event, statesBefore);
      errorDescription = this.getErrorDescription(errorCode);
      this.logs.push({
        label: "REJECTED",
        message: `${cmd.event} not valid in [${this.describeState(target, statesBefore)}]`,
        module: target.id,
        timestamp: Date.now(),
      });
    }

    // Track deck interaction (resolve coordinates to deck objects)
    let deckInteraction: DeckInteraction | undefined;
    if (accepted && errorCode === 0) {
      deckInteraction = this.deckTracker.processCommand(cmd.event, eventData);
      deckInteraction.correlationId = correlationId;
      if (stepId !== undefined) deckInteraction.stepId = stepId;
      this.eventSpine.add({
        kind: "deck_interaction",
        correlationId,
        stepId,
        payload: deckInteraction,
      });
      if (deckInteraction.effect) {
        this.logs.push({
          label: "DECK",
          message: deckInteraction.effect,
          module: target.id,
          timestamp: Date.now(),
        });
      } else if (!deckInteraction.resolution.matched && (cmd.event === "C0AS" || cmd.event === "C0DS" || cmd.event === "C0TP")) {
        this.logs.push({
          label: "DECK",
          message: `${deckInteraction.resolution.description} — deck tracking unavailable`,
          module: target.id,
          timestamp: Date.now(),
        });
      }
    }

    // Assessment: collect physics observations (never rejects)
    let assessments: AssessmentEvent[] = [];
    if (accepted && errorCode === 0) {
      // Per-module plugin first, then any global assessors.
      const chain: Array<PhysicsPlugin | undefined> = [plugin, ...this.globalPlugins];
      for (const p of chain) {
        if (!p?.assess) continue;
        const rawAssessments = p.assess(cmd.event, eventData, this.deckTracker);
        for (const a of rawAssessments) {
          const stored = this.assessmentStore.add({ ...a, correlationId, stepId });
          assessments.push(stored);
          this.eventSpine.add({
            kind: "assessment",
            correlationId,
            stepId,
            severity: stored.severity,
            payload: stored,
          });
        }
      }
    }

    // Attach the early unresolved-position assessment (#34) to the
    // returned assessments so callers see it in the command result.
    if (earlyUnresolved) assessments.push(earlyUnresolved);

    const responseData = (accepted && errorCode === 0) ? this.generateResponseData(cmd.event, eventData) : undefined;
    const response = formatFwResponse(cmd.module, cmd.code, cmd.orderId, errorCode, 0, responseData, errorFormatFor(cmd.module, cmd.code));
    const result: CommandResult = {
      rawCommand,
      response,
      targetModule: target.name,
      activeStates: this.getAllActiveStates(),
      variables: this.getAllVariables(),
      logs: this.logs.map((l) => `[${l.module}] ${l.label}: ${l.message}`),
      accepted,
      errorCode,
      errorDescription,
      deckInteraction,
      assessments: assessments.length > 0 ? assessments : undefined,
      correlationId,
      stepId,
    };

    this.commandHistory.push({ command: rawCommand, result, timestamp: Date.now() });
    this.eventSpine.add({
      kind: "command",
      correlationId,
      stepId,
      severity: errorCode !== 0 ? "error" : undefined,
      payload: result,
    });
    this.notifyListeners();
    return result;
  }

  /** Send a completion/internal event (e.g. "wash.done", "move.done") */
  sendCompletion(eventName: string): SystemState {
    const target = this.eventMap.get(eventName);
    if (target) {
      target.executor.send(eventName);
      this.eventSpine.add({
        kind: "completion",
        payload: { moduleId: target.id, eventName },
      });
    }
    this.notifyListeners();
    return this.getSystemState();
  }

  /** Get full system state snapshot */
  getSystemState(): SystemState {
    const modules: SystemState["modules"] = {};
    for (const mod of this.modules) {
      modules[mod.id] = {
        states: Array.from(mod.executor.getActiveStateIds()),
        variables: this.getModuleVariables(mod),
      };
    }
    return { modules, timestamp: Date.now() };
  }

  /** Get active states grouped by module ID */
  getAllActiveStates(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const mod of this.modules) {
      result[mod.id] = Array.from(mod.executor.getActiveStateIds()) as string[];
    }
    return result;
  }

  /** Get variables grouped by module ID */
  getAllVariables(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const mod of this.modules) {
      result[mod.id] = this.getModuleVariables(mod);
    }
    return result;
  }

  /** Get module display names keyed by ID */
  getModuleNames(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const mod of this.modules) {
      result[mod.id] = mod.name;
    }
    return result;
  }

  /** Get command history */
  getHistory(): Array<{ command: string; result: CommandResult; timestamp: number }> {
    return [...this.commandHistory];
  }

  /** Get the deck model */
  getDeck(): Deck {
    return this.deck;
  }

  /** Get the deck tracker (well volumes, labware info, position resolution) */
  getDeckTracker(): DeckTracker {
    return this.deckTracker;
  }

  /** Get deck snapshot for UI rendering */
  getDeckSnapshot(): DeckSnapshot {
    return this.deck.getSnapshot();
  }

  /** Get the device event emitter (for event emission and listening) */
  getDeviceEvents(): DeviceEventEmitter {
    return this.deviceEvents;
  }

  /** Get the assessment store (for querying physics observations) */
  getAssessmentStore(): AssessmentStore {
    return this.assessmentStore;
  }

  /** Get the event spine (Step 1.10) — unified ordered timeline of all events. */
  getEventSpine(): EventSpine {
    return this.eventSpine;
  }

  /** Register a device event listener */
  onDeviceEvent(listener: DeviceEventListener): () => void {
    return this.deviceEvents.onDeviceEvent(listener);
  }

  /** Register a state change listener */
  onStateChange(listener: StateChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * Peek at a command without committing it, emit the motion envelope,
   * and report the physical duration. Used by the REST `/command`
   * deferred path so the renderer can start animating at t=0 while the
   * actual state-mutation (SCXML transition, deckTracker, assess,
   * broadcast) is scheduled at t=durationMs — matching the user-visible
   * timeline of a real instrument, where well volumes / tip contents /
   * positions only change after the physical motion has finished.
   *
   * Returns 0 for commands that don't animate (init, queries, writes),
   * in which case the caller should just run sendCommand synchronously.
   *
   * Safe to call repeatedly on the SAME raw command: the only side
   * effect is `emitMotion`, which fans out to motion listeners. The
   * datamodel, deckTracker, and assessment store are untouched.
   */
  prepareAndEmitMotionEnvelope(rawCommand: string): { envelope: MotionEnvelope | null; durationMs: number } {
    const cmd = parseFwCommand(rawCommand);
    const target = this.eventMap.get(cmd.event);
    if (!target) return { envelope: null, durationMs: 0 };

    // Build the event-data the way sendCommand does. `onBeforeEvent`
    // stamps `_delay`, which is what extractMotionEnvelope reads for
    // `durationMs`.
    let eventData: Record<string, unknown> = { ...cmd.params };
    if (cmd.arrayParams) {
      for (const [key, arr] of Object.entries(cmd.arrayParams)) {
        eventData[`_${key}_array`] = arr;
      }
    }
    const plugin = this.getPlugin(target.id);
    if (plugin?.onBeforeEvent) {
      try { eventData = plugin.onBeforeEvent(cmd.event, eventData); }
      catch { /* fall through — extract with whatever we have */ }
    }
    // Master / autoload events rely on static timing estimates (no
    // physics plugin). Mirror sendCommand's fallback.
    if (target.id === "master" && !eventData._delay && /^C0(KX|KR|JX|JS)$/.test(cmd.event)) {
      const ms = estimateCommandTime(cmd.event, eventData);
      if (ms > 0) eventData._delay = `${ms}ms`;
    }
    if (target.id === "autoload" && !eventData._delay && /^C0(CL|CR)$/.test(cmd.event)) {
      const ms = estimateCommandTime(cmd.event, eventData);
      if (ms > 0) eventData._delay = `${ms}ms`;
    }

    const preMoveDm = this.getModuleVariables(target);
    const envelope = this.extractMotionEnvelope(cmd.event, target.id, eventData, preMoveDm);
    const durationMs = envelope?.durationMs ?? this.parseDelayMs(eventData._delay);
    if (envelope) this.emitMotion(envelope);
    return { envelope, durationMs };
  }

  /** Parse `_delay` (set by physics plugins in onBeforeEvent) into milliseconds.
   *  Accepts "Nms", "Ns", or numbers. Returns 0 for anything unparseable. */
  private parseDelayMs(raw: unknown): number {
    if (raw == null) return 0;
    if (typeof raw === "number") return Math.max(0, raw);
    const s = String(raw).trim();
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(ms|s)?$/i);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return 0;
    return (m[2]?.toLowerCase() === "s") ? n * 1000 : n;
  }

  /** Reconstruct the arm-wide Y coordinate (the "ch0-equivalent") from a
   *  per-channel pos_y array. Channels are rigidly 9 mm apart (= 90 in
   *  0.1 mm units — see feedback_pip_channel_pitch_fixed.md), and only
   *  masked channels get updated (feedback_partial_mask_pos_y.md), so
   *  `pos_y[0]` can lag behind a non-zero pos_y[j]. Mirrors the fallback
   *  in arm.ts updateDeckArm so envelope starts and the renderer's
   *  resting arm position agree. Returns 0 on empty / non-array inputs. */
  private static armYFromArray(py: unknown): number {
    if (Array.isArray(py)) {
      const first = Number(py[0]);
      if (first) return first;
      for (let j = 1; j < py.length; j++) {
        const v = Number(py[j]);
        if (v) return v + j * 90;
      }
      return 0;
    }
    const n = Number(py);
    return Number.isFinite(n) ? n : 0;
  }

  /** Arm-wide Z = deepest (lowest physically) channel. In Hamilton
   *  convention pos_z is the tip's height above the deck — bigger =
   *  higher/safer, smaller = lower/in-well — so "deepest" means the
   *  MIN pos_z, not the max. Channels with pos_z=0 (uninitialised, or
   *  on a deck where pos_z=0 doesn't reach deck) are ignored so we
   *  don't collapse to 0 whenever one channel hasn't been commanded.
   *  Used by extractMotionEnvelope to pick the arm-wide startZ/endZ
   *  that represent the lowest active channel's position. */
  private static armZFromArray(pz: unknown): number {
    if (Array.isArray(pz)) {
      let best: number | null = null;
      for (const z of pz) {
        const n = Number(z);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (best === null || n < best) best = n;
      }
      return best ?? 0;
    }
    const n = Number(pz);
    return Number.isFinite(n) ? n : 0;
  }

  /** Inspect a command + its physics-decorated event data + the pre-move
   *  datamodel to produce a motion envelope describing the arm's trajectory.
   *  Returns null for commands that don't move the arm or if the start/end
   *  positions are identical (within 1 unit = 0.1 mm). */
  private extractMotionEnvelope(
    event: string,
    moduleId: string,
    data: Record<string, unknown>,
    dm: Record<string, unknown>,
  ): MotionEnvelope | null {
    const durationMs = this.parseDelayMs(data._delay);
    if (durationMs <= 0) return null;

    const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

    let arm: MotionEnvelope["arm"] | null = null;
    let startX = 0, startY = 0, endX = 0, endY = 0;
    // Optional axes merged into the envelope at return. Keeping them in
    // named buckets — instead of free-floating variables — avoids
    // accidentally leaking a previous case's values into the current
    // switch arm.
    let extraZ: { startZ: number; endZ: number; dwellZ?: number } | null = null;
    let extraRotation: { startRotation: number; endRotation: number } | null = null;
    let extraGrip: { startGripWidth: number; endGripWidth: number } | null = null;
    let extraPlate: { width: number; height: number } | null = null;
    // Per-channel arrays + CNC traverse Z. Populated for the PIP arm
    // case so the renderer can drive each of the 16 channels
    // independently and retract to safe Z before XY travel. Left null
    // for iSWAP / 96-head / 384-head / autoload — those arms are single
    // bodies (they don't have per-channel drives) and the existing
    // linear sampler is correct for them.
    let extraChannels: {
      startY_ch: number[];
      endY_ch: number[];
      startZ_ch: number[];
      endZ_ch: number[];
      dwellZ_ch?: number[];
    } | null = null;
    let extraTraverseZ: number | null = null;
    // C0AS/C0DS aspirate/dispense have a plunger stroke but usually
    // land at the same Z they started at (the arm descended into the
    // well during C0JM, the physics module runs the plunger, then
    // retracts). Flag so we emit the envelope even when dx/dy/dz ≈ 0
    // — otherwise the user never sees the wall-clock aspirate time.
    let isPlungerStroke = false;

    // Coordinates are in 0.1 mm; Hamilton treats 0 as "no position specified"
    // (the command stays where it is). Use `||` rather than `??` so 0 falls
    // through to the current/start position.
    const coord = (v: unknown, fallback: number): number => num(v) || fallback;

    switch (moduleId) {
      case "master": {
        // Master-owned X-axis moves: C0KX (left arm X), C0KR (right arm
        // X), C0JX/C0JS (absolute X). Real STAR's X drive physically
        // carries the PIP arm, so visualise them on the pip track.
        // `xs` is the target X (0.1 mm); Y is not part of these cmds.
        if (!/^C0(KX|KR|JX|JS)$/.test(event)) return null;
        const isRight = event === "C0KR" || event === "C0JS";
        arm = isRight ? "iswap" : "pip";
        startX = num(isRight ? dm.right_arm_x : dm.left_arm_x);
        endX = coord(data.xs, startX);
        startY = endY = 0; // Y not touched by these commands
        break;
      }
      case "pip": {
        // Motion-producing PIP commands: C0JM (move), C0TP (pickup), C0TR
        // (eject), C0AS (aspirate), C0DS (dispense), C0DF (fly-dispense).
        if (!/^C0(JM|TP|TR|AS|DS|DF)$/.test(event)) return null;
        arm = "pip";
        startX = num(dm.pos_x);
        // pos_y / pos_z are per-channel arrays where only channels in the
        // command mask get updated — pos_y[0] can be stale after a non-ch0
        // mask. Reconstruct the arm-wide "ch0-equivalent" the same way
        // arm.ts updateDeckArm does (pos_y[j] + j*90). Without this,
        // envelope.startY reported stale pos_y[0] and the arm visibly
        // snapped back to that value at the start of the next envelope.
        // See feedback_partial_mask_pos_y.md.
        startY = DigitalTwin.armYFromArray(dm.pos_y);
        const startZCh0 = DigitalTwin.armZFromArray(dm.pos_z);
        endX = coord(data.xp, coord(data.xs, startX));
        // endY — VENUS typically sends `yp` as a space-separated per-channel
        // array (stored in `_yp_array` after parseFwCommand). parseFwCommand
        // also fills the scalar `data.yp` with the FIRST array value for
        // back-compat, which is 0 whenever ch0 is outside the mask. Without
        // consulting the array here, `coord(data.yp, ...)` would return the
        // startY fallback and the envelope would report NO Y travel — even
        // though the SCXML is about to rewrite pos_y and updateDeckArm will
        // resolve a new resting Y. The renderer would then legacy-ease from
        // the old animPipY toward the new targetPipY AFTER the envelope
        // finishes, producing a visible post-envelope drift (user report
        // 2026-04-20). Consulting `_yp_array` puts that Y move INSIDE the
        // envelope where it belongs.
        endY = DigitalTwin.armYFromArray(data._yp_array) || coord(data.yp, coord(data.yh, startY));

        // Per-channel arrays. Each channel has its own Y-drive and its
        // own Z-drive on a real STAR, so "one channel in plate A,
        // another in plate B" is a valid motion. We capture the start
        // snapshot from the datamodel (stable for channels not in the
        // mask) and the end targets from the command's `_yp_array` /
        // `_zp_array`. Channels whose target comes back as 0 keep their
        // current position so unmasked channels stay put in the
        // renderer instead of snapping to origin.
        const channelCount = Array.isArray(dm.pos_y) ? (dm.pos_y as unknown[]).length : 16;
        const startYs = Array.isArray(dm.pos_y) ? [...(dm.pos_y as number[])] : new Array(channelCount).fill(startY);
        const startZs = Array.isArray(dm.pos_z) ? [...(dm.pos_z as number[])] : new Array(channelCount).fill(startZCh0);
        const ypArr = Array.isArray(data._yp_array) ? (data._yp_array as number[]) : undefined;
        const zpArr = Array.isArray(data._zp_array) ? (data._zp_array as number[]) : undefined;
        const endYs = new Array<number>(channelCount);
        for (let i = 0; i < channelCount; i++) {
          const v = ypArr ? Number(ypArr[i]) : NaN;
          endYs[i] = Number.isFinite(v) && v > 0 ? v : startYs[i];
        }
        // Traverse height — CNC-style motion sampler retracts Z to this
        // height before XY travel and descends after. Prefer the per-
        // command `th` (VENUS always sends it), fall back to the module
        // datamodel's z_traverse (145 mm default), fall back to the
        // current Z if neither is available (degenerates to linear).
        const traverseZ = coord(data.th, coord(data.zt, num(dm.z_traverse) || startZCh0));

        if (event === "C0AS" || event === "C0DS" || event === "C0DF") {
          // Aspirate/dispense: `zp` is the target liquid-surface depth.
          // The arm descends to zp, runs the plunger, and retracts to
          // where it started. Emit start/end = current Z and carry zp as
          // a dwell waypoint so the renderer shows a proper Z-bob
          // instead of snapping the aspirate to a single XY frame. #62.
          // `zp` can also arrive as a per-channel array; fall back to
          // deepest when the scalar form is absent/zero.
          const dwellZ = DigitalTwin.armZFromArray(data._zp_array) || coord(data.zp, startZCh0);
          extraZ = { startZ: startZCh0, endZ: startZCh0, dwellZ };
          // Per-channel dwell (different wells may have different depths).
          const endZs = [...startZs];
          const dwellZs = new Array<number>(channelCount);
          for (let i = 0; i < channelCount; i++) {
            const v = zpArr ? Number(zpArr[i]) : NaN;
            dwellZs[i] = Number.isFinite(v) && v > 0 ? v : dwellZ;
          }
          extraChannels = { startY_ch: startYs, endY_ch: endYs, startZ_ch: startZs, endZ_ch: endZs, dwellZ_ch: dwellZs };
          isPlungerStroke = true;
        } else if (event === "C0TP" || event === "C0TR") {
          // Tip pickup (C0TP) / eject (C0TR): the arm descends to the
          // pickup/eject Z, clamps or releases the tip, then retracts
          // to `th` (traversal height). Real FW param names:
          //   C0TP:  `tp` = pickup Z   `th` = post-retract Z
          //   C0TR:  `tz` = eject Z    `th` = post-retract Z
          // Emit descend → dwell → retract as a single envelope so the
          // 3D/2D renderers animate the full trajectory. Matches the
          // plunger-stroke shape used for C0AS/C0DS.
          const actionZ =
            DigitalTwin.armZFromArray(data._zp_array)
            || coord(data.tp, coord(data.tz, coord(data.zp, 0)));
          const retractZ = coord(data.th, coord(data.zt, actionZ));
          extraZ = { startZ: startZCh0, endZ: retractZ, dwellZ: actionZ };
          const endZs = new Array<number>(channelCount).fill(retractZ);
          const dwellZs = new Array<number>(channelCount);
          for (let i = 0; i < channelCount; i++) {
            const v = zpArr ? Number(zpArr[i]) : NaN;
            dwellZs[i] = Number.isFinite(v) && v > 0 ? v : actionZ;
          }
          extraChannels = { startY_ch: startYs, endY_ch: endYs, startZ_ch: startZs, endZ_ch: endZs, dwellZ_ch: dwellZs };
        } else {
          // Pure XY travel (C0JM): no dwell. `zt` and `th` are *traverse*
          // heights (safe Z for XY transit) not end-Z — the SCXML doesn't
          // rewrite pos_z unless an explicit `zp` is present, so the
          // channel's resting Z stays at startZ. Earlier we defaulted
          // endZ = zt which caused a visible snap-back at envelope end
          // (arm descended 1450 → 1189) when the post-command state
          // update arrived with unchanged pos_z. Now zp wins if present,
          // else endZ = startZ — the CNC sampler will still retract to
          // traverseZ during XY travel using the traverseZ field.
          const endZ = DigitalTwin.armZFromArray(data._zp_array) || coord(data.zp, startZCh0);
          extraZ = { startZ: startZCh0, endZ };
          const endZs = new Array<number>(channelCount);
          for (let i = 0; i < channelCount; i++) {
            const v = zpArr ? Number(zpArr[i]) : NaN;
            endZs[i] = Number.isFinite(v) && v > 0 ? v : startZs[i];
          }
          extraChannels = { startY_ch: startYs, endY_ch: endYs, startZ_ch: startZs, endZ_ch: endZs };
        }
        extraTraverseZ = traverseZ;
        break;
      }
      case "iswap": {
        // Real Hamilton FW params (C0PP get / C0PR put / C0PM move):
        //   xs = X, yj = Y (arm extension), zj = Z (grip / plate height),
        //   th = traverse height, gr = grip direction (0=landscape,
        //   1=portrait), gw/gb/go = gripper width / base / open.
        if (!/^C0(PP|PR|PM|PG)$/.test(event)) return null;
        arm = "iswap";
        startX = num(dm.pos_x);
        startY = num(dm.pos_y);
        const startZVal = num(dm.pos_z);
        // C0PG parks the iSWAP — target returns to the park coordinate
        // stored on the datamodel itself (the SCXML doesn't carry it
        // in the command data). Default to current so an unknown park
        // pose results in a zero-length envelope (skipped below).
        endX = coord(data.xs, startX);
        endY = coord(data.yj, startY);
        const endZVal = coord(data.zj, coord(data.th, startZVal));
        extraZ = { startZ: startZVal, endZ: endZVal };
        // iSWAP traverse — `th` is the safe plate-carry Z the CNC
        // sampler retracts to before XY, then descends to endZ.
        extraTraverseZ = coord(data.th, Math.max(startZVal, endZVal));
        // Orientation change: 0→landscape, 1→portrait (translated to 0°/90°).
        if (data.gr !== undefined) {
          const startRot = num(dm.plate_rotation_deg);
          const endRot = num(data.gr) ? 90 : 0;
          extraRotation = { startRotation: startRot, endRotation: endRot };
        }
        // Gripper width change (C0PP opens, C0PR closes).
        if (data.gw !== undefined || data.gb !== undefined) {
          const startGrip = num(dm.grip_width_01mm);
          // `gb` (4d) is the grip-base width in 0.1mm; `gw` (1d) is a
          // width-selector enum. Prefer gb if both are present.
          const endGrip = num(data.gb) || num(data.gw) * 100 || startGrip;
          extraGrip = { startGripWidth: startGrip, endGripWidth: endGrip };
        }
        // Held-plate footprint — resolved on C0PP from the labware
        // sitting at the pickup coords. Allows the renderer to draw
        // the actual plate (e.g. a deep-well block or archive rack)
        // instead of the ANSI/SBS default of 1278×855.
        if (event === "C0PP") {
          const dims = this.resolvePlateDimsAt(endX, endY);
          if (dims) extraPlate = dims;
        }
        break;
      }
      case "h96": {
        // Real FW params: xs (X), yh (Y), za (Z deposit), zh (Z traverse),
        // ze (Z end). The arm pos_z datamodel variable tracks the
        // head's actual Z after the move completes.
        if (!/^C0(EM|EP|ER|EA|ED)$/.test(event)) return null;
        arm = "h96";
        startX = num(dm.pos_x);
        startY = num(dm.pos_y);
        const startZVal = num(dm.pos_z);
        endX = coord(data.xs, startX);
        endY = coord(data.yh, startY);
        // Z endpoint differs per command: EA/ED use `za` (deposit),
        // EP/ER use `za`, EM uses `za` with zh as traverse. Falling
        // through `za → zh → current` handles all five.
        const endZVal = coord(data.za, coord(data.zh, startZVal));
        extraZ = { startZ: startZVal, endZ: endZVal };
        // 96-head traverse — `zh` is the explicit traverse Z in the
        // FW catalog; fall back to max(start, end) so the CNC sampler
        // at least doesn't descend below either endpoint during XY.
        extraTraverseZ = coord(data.zh, Math.max(startZVal, endZVal));
        break;
      }
      case "h384": {
        // Real FW params for C0EN (384 move): xs (X), yk (Y), je (Z),
        // zf (traverse). C0JA/JB/JC/JD (aspirate/dispense on-the-fly)
        // reuse xs/xd/yk/zf. Fall back to the datamodel pos_* when a
        // param is absent so a partial move stays in bounds.
        if (!/^C0(EN|JB|JC|JA|JD)$/.test(event)) return null;
        arm = "h384";
        startX = num(dm.pos_x);
        startY = num(dm.pos_y);
        const startZVal = num(dm.pos_z);
        endX = coord(data.xs, startX);
        endY = coord(data.yk, startY);
        const endZVal = coord(data.je, coord(data.zf, startZVal));
        extraZ = { startZ: startZVal, endZ: endZVal };
        extraTraverseZ = coord(data.zf, Math.max(startZVal, endZVal));
        break;
      }
      case "autoload": {
        // AutoLoad carriage X-motion on C0CL (load) / C0CR (unload).
        // Real carriage slides along the front rail to the target
        // track's X, so emit an envelope with trackToX()-derived
        // endpoints. Y stays at the front-rail "home row" so the
        // renderer can draw it on the deck's front strip.
        if (!/^C0(CL|CR)$/.test(event)) return null;
        arm = "autoload";
        const fromTrack = num(dm.pos_track);
        const toTrack = event === "C0CR" ? 0 : num(data.pq) || 1;
        startX = fromTrack > 0 ? this.deck.trackToX(fromTrack) : this.deck.trackToX(1);
        endX = toTrack > 0 ? this.deck.trackToX(toTrack) : this.deck.trackToX(1);
        // Front rail sits at deck Y=0 (viewport draws a small strip
        // above Y_FRONT_EDGE=630). Both ends share the same Y so the
        // envelope represents pure lateral motion.
        startY = endY = 0;
        break;
      }
      default:
        return null;
    }

    if (!arm) return null;
    // Skip envelopes where no axis moves measurably (< 0.1 mm on every
    // tracked axis). Aspirating at the current position, or a repeated
    // query against unchanged state, has no trajectory worth animating.
    // Exception: plunger-stroke commands (C0AS/C0DS) always emit — the
    // dwellZ waypoint carries the descend/hold/retract animation even
    // when start == end on the arm position axes.
    const dx = Math.abs(endX - startX);
    const dy = Math.abs(endY - startY);
    const dz = extraZ ? Math.abs(extraZ.endZ - extraZ.startZ) : 0;
    const dwell = extraZ?.dwellZ !== undefined ? Math.abs(extraZ.dwellZ - extraZ.startZ) : 0;
    const dRot = extraRotation ? Math.abs(extraRotation.endRotation - extraRotation.startRotation) : 0;
    const dGrip = extraGrip ? Math.abs(extraGrip.endGripWidth - extraGrip.startGripWidth) : 0;
    if (!isPlungerStroke && dx < 1 && dy < 1 && dz < 1 && dwell < 1 && dRot < 1 && dGrip < 1) return null;

    return {
      arm, startX, startY, endX, endY,
      ...(extraZ ?? {}),
      ...(extraRotation ?? {}),
      ...(extraGrip ?? {}),
      ...(extraPlate ? {
        startPlateWidth: extraPlate.width, endPlateWidth: extraPlate.width,
        startPlateHeight: extraPlate.height, endPlateHeight: extraPlate.height,
      } : {}),
      ...(extraTraverseZ !== null ? { traverseZ: extraTraverseZ } : {}),
      ...(extraChannels ?? {}),
      durationMs, startTime: Date.now(), command: event,
    };
  }

  /** Resolve the physical footprint of the labware at a given deck (x, y).
   *  Used by extractMotionEnvelope for C0PP so the renderer can draw the
   *  iSWAP-held plate at its real dimensions. Anchors at each labware's
   *  well-grid centroid and accepts a match within its rack footprint.
   *
   *  Returns the rack footprint (rackDx × rackDy, 0.1 mm) when the .rck
   *  geometry is known, else null. */
  private resolvePlateDimsAt(x: number, y: number): { width: number; height: number } | null {
    let best: { dist: number; width: number; height: number } | null = null;
    for (const carrier of this.deck.getAllCarriers()) {
      for (let pos = 0; pos < carrier.labware.length; pos++) {
        const lw = carrier.labware[pos];
        if (!lw || !lw.rackDx || !lw.rackDy) continue;
        // Well-grid centroid is reliably at labware anchor + ((cols-1)/2,
        // (rows-1)/2) * pitch. deck.wellToPosition gives us A1 in deck
        // coords, applying carrier offsets correctly.
        const a1 = this.deck.wellToPosition({ carrierId: carrier.id, position: pos, row: 0, column: 0 });
        if (!a1) continue;
        const cx = a1.x + ((lw.columns - 1) / 2) * lw.wellPitch;
        const cy = a1.y - ((lw.rows - 1) / 2) * lw.wellPitch;
        const dx = cx - x;
        const dy = cy - y;
        // Accept if the probe sits within the labware's physical footprint
        // plus 5 mm slack — covers VENUS's tolerance on C0PP xs/yj.
        const reachX = lw.rackDx / 2 + 50;
        const reachY = lw.rackDy / 2 + 50;
        if (Math.abs(dx) > reachX || Math.abs(dy) > reachY) continue;
        const d2 = dx * dx + dy * dy;
        if (!best || d2 < best.dist) {
          best = { dist: d2, width: lw.rackDx, height: lw.rackDy };
        }
      }
    }
    return best ? { width: best.width, height: best.height } : null;
  }

  /** Register a motion envelope listener. Returns an unsubscribe function.
   *  Fired once per motion-producing FW command, right before the state
   *  change is applied, so the client has the start/end/duration in advance. */
  onMotion(listener: MotionListener): () => void {
    this.motionListeners.push(listener);
    return () => {
      this.motionListeners = this.motionListeners.filter((l) => l !== listener);
    };
  }

  private emitMotion(env: MotionEnvelope): void {
    for (const l of this.motionListeners) {
      try { l(env); } catch { /* isolate listener errors */ }
    }
  }

  // ==========================================================================
  // Snapshot / restore / clone (Phase 1 #43)
  //
  // These four methods compose the per-component serializers built in
  // Steps 1.3a-d + the SCXML executor restore from Step 1.4.
  //
  //   getConfig()   → static world (platform, carriers, labware with geometry)
  //   snapshot()    → dynamic state (SCXML + tracking + liquid + plugins)
  //   restore(s)    → apply a snapshot to this instance
  //   loadConfig(c) → rebuild deck+trackers from a config (usually called
  //                   right after construction to set up the world)
  //   clone()       → new instance with same config + current state
  //
  // Use cases:
  //   Session save/load  → getConfig() + snapshot() combined into a
  //                         TwinSession; reverse at load.
  //   Trace snapshots    → snapshot() periodically (config in trace header).
  //   What-if forking    → clone() at any trace point, run alt commands.
  // ==========================================================================

  /**
   * Export the static world configuration (platform, carriers, labware
   * definitions, tip waste). Fully self-contained — no external lookups
   * needed to reconstruct an equivalent deck.
   */
  getConfig(): import("./twin-config").TwinConfig {
    return this.deck.getConfig();
  }

  /**
   * Rebuild the deck from a TwinConfig. Wipes all tracking state. Use this
   * immediately after `new DigitalTwin()` to replace the default deck with
   * a specific layout. Does NOT restore dynamic state — call `restore()`
   * separately if you have a state snapshot.
   */
  loadConfig(config: import("./twin-config").TwinConfig): void {
    // Platform mismatches are fatal — the Deck constructor fixes platform
    // at construction, so a different platform config cannot be applied to
    // an existing instance. Callers must create a new DigitalTwin with the
    // correct platform first.
    if (config.platform !== this.deck.platform) {
      throw new Error(
        `loadConfig: config is for platform "${config.platform}" but this twin is "${this.deck.platform}". ` +
        `Create a new DigitalTwin(new Deck("${config.platform}")) instead.`
      );
    }
    this.deck.restoreFromConfig(config);
    // Reset all tracking state (tracker now references the new deck
    // layout). DeckTracker was constructed with `this.deck` and holds
    // a reference, so in-place restore is safe.
    this.deckTracker.resetTracking();
    // Re-derive VENUS-facing FW values from the new deck (module bits
    // infer from carriers/labware). Any user overrides applied via
    // setVenusConfig() before this call are lost.
    this.venusConfig = buildVenusConfig({ deck: this.deck });
  }

  /**
   * Current VENUS-facing FW identity + module-presence config.
   * Read-only — use `setVenusConfig()` to update.
   */
  getVenusConfig(): VenusConfig {
    return this.venusConfig;
  }

  /**
   * Override the VENUS-facing FW config. Typically called once at
   * startup by `server-setup` after it has loaded `--venus-cfg` /
   * `--serial` / other CLI options, so C0QM/C0RM/C0RI/C0RF/C0RU pick
   * up the user's instrument identity instead of the default STAR.
   *
   * Passing a Partial merges on top of the existing config; pass a
   * fully-formed VenusConfig to replace outright.
   */
  setVenusConfig(cfg: Partial<VenusConfig> | VenusConfig): void {
    this.venusConfig = { ...this.venusConfig, ...cfg };
  }

  /**
   * Hot-swap the active deck on a running twin — no restart, no
   * module re-initialization. Intended for the File-menu / REST /
   * MCP "Load deck layout" surface.
   *
   * Replaces the deck reference, rebuilds the deck tracker (which
   * held a reference to the old deck), and re-derives `venusConfig`
   * so module-bits (`ka`) and track counts (`xt`) advertised to
   * VENUS reflect what's newly on the deck. SCXML state machines are
   * untouched — a twin that was `sys_ready` stays `sys_ready`.
   *
   * The deck factory is replaced with a closure returning the new
   * deck so subsequent `reset()` calls keep the loaded layout rather
   * than reverting to the default. Tip usage, well volumes, and
   * liquid tracking are cleared because the old deck's state is
   * physically meaningless against the new one.
   *
   * Callers that want reset to fully reload from source (re-parse a
   * .lay file each time) can pass a `factory` — e.g. `() =>
   * importVenusLayout(parseHxCfg(fs.readFileSync(path))).deck`.
   */
  setDeck(newDeck: Deck, factory?: () => Deck): void {
    this.deck = newDeck;
    this.deckFactory = factory ?? (() => newDeck);
    this.deckTracker = new DeckTracker(this.deck);
    this.venusConfig = buildVenusConfig({ deck: this.deck });
    this.notifyListeners();
  }

  /**
   * Capture the complete dynamic state of the twin into a JSON-safe
   * snapshot. Combined with `getConfig()`, the result fully determines
   * the twin's observable behavior going forward.
   */
  snapshot(): import("./twin-config").TwinState {
    // 1. Per-module SCXML state + scheduled events
    const moduleSnapshots: Record<string, import("./twin-config").ModuleStateSnapshot> = {};
    const allScheduled: import("./twin-config").ScheduledEventSnapshot[] = [];
    for (const mod of this.modules) {
      const config = mod.executor.machine.getConfiguration();
      moduleSnapshots[mod.id] = {
        activeStateIds: config.activeStateIds,
        variables: config.datamodel,
      };
      for (const se of (config.scheduledEvents || []) as any[]) {
        allScheduled.push({
          moduleId: mod.id,
          eventName: se.eventName,
          eventData: se.eventData,
          remainingMs: se.remainingMs,
          sendId: se.sendId,
        });
      }
    }

    // 2. Tracking + liquid + deck dynamic
    const tracking = this.deckTracker.getTrackingState();
    const liquid = this.deckTracker.liquidTracker.getLiquidState();
    const deck = this.deckTracker.getDeckDynamicState();

    // 3. Per-plugin opt-in state
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const [modId, plugin] of this.plugins.entries()) {
      if (typeof plugin.getPluginState === "function") {
        const state = plugin.getPluginState();
        if (state && Object.keys(state).length > 0) plugins[modId] = state;
      }
    }

    return {
      version: 1,
      timestamp: Date.now(),
      modules: moduleSnapshots,
      scheduledEvents: allScheduled,
      tracking,
      liquid,
      deck,
      plugins,
    };
  }

  /**
   * Restore the twin from a state snapshot. Does NOT rebuild the deck
   * layout — call `loadConfig()` first if the snapshot comes from a
   * different configuration.
   */
  restore(state: import("./twin-config").TwinState): void {
    if (!state || typeof state !== "object") {
      throw new Error("restore: state is null or not an object");
    }
    if (state.version !== 1) {
      throw new Error(`restore: unsupported state version ${state.version}`);
    }

    // 1. Restore tracker state first — SCXML restore may emit events that
    //    read from tracking, so tracking must be populated before.
    this.deckTracker.restoreTrackingState(state.tracking);
    this.deckTracker.liquidTracker.restoreLiquidState(state.liquid);
    this.deckTracker.restoreDeckDynamicState(state.deck);

    // 2. Restore per-module SCXML state. Distribute scheduled events back
    //    to their owning modules as we go.
    const scheduledByModule: Record<string, any[]> = {};
    for (const se of state.scheduledEvents || []) {
      if (!scheduledByModule[se.moduleId]) scheduledByModule[se.moduleId] = [];
      scheduledByModule[se.moduleId].push({
        sendId: se.sendId,
        remainingMs: se.remainingMs,
        eventName: se.eventName,
        eventData: se.eventData,
        eventType: "external",
      });
    }

    for (const mod of this.modules) {
      const snap = state.modules[mod.id];
      if (!snap) continue;  // module not present in snapshot; leave as-is
      mod.executor.machine.forceConfiguration({
        activeStateIds: snap.activeStateIds,
        datamodel: snap.variables,
        scheduledEvents: scheduledByModule[mod.id] || [],
      });
    }

    // 3. Restore per-plugin state where applicable.
    for (const [modId, pluginState] of Object.entries(state.plugins || {})) {
      const plugin = this.plugins.get(modId);
      if (plugin && typeof plugin.restorePluginState === "function") {
        plugin.restorePluginState(pluginState);
      }
    }

    // 4. Clear session-scoped history (not part of state snapshot).
    this.commandHistory = [];
    this.logs = [];
    this.eventSpine.clear();
    this.notifyListeners();
  }

  /**
   * Create a new DigitalTwin instance with the same configuration and
   * current state as this one. Useful for what-if branching: the clone
   * is a fully live twin, independent from the original.
   *
   * Implementation: snapshot + new instance + restore. The new twin runs
   * its own SCXML executors; the original is untouched.
   */
  clone(): DigitalTwin {
    const config = this.getConfig();
    const state = JSON.parse(JSON.stringify(this.snapshot())) as import("./twin-config").TwinState;

    // Build a new deck matching this platform, then load the config.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Deck } = require("./deck");
    const newDeck = new Deck(this.deck.platform);
    const clone = new DigitalTwin(newDeck);
    clone.loadConfig(config);
    clone.restore(state);
    // loadConfig rebuilds venusConfig from the deck alone, which drops
    // any user-supplied overrides (serial, firmware version, etc.).
    // Copy the live config onto the clone so what-if branches report
    // the same instrument identity.
    clone.setVenusConfig(this.venusConfig);
    return clone;
  }

  /** Get error description by code */
  getErrorDescription(code: number): string {
    const key = String(code).padStart(2, "0");
    return this.errorCodes[key] || `Unknown error ${code}`;
  }

  /**
   * Flush all pending delayed events across all modules.
   * Moves all scheduled SCXML events to "due" and processes them immediately.
   * Essential for synchronous trace replay where we can't wait for real timers.
   */
  flushPendingEvents(): void {
    for (const mod of this.modules) {
      const machine = mod.executor.machine;
      if (!machine) continue;

      // Access the runtime context's scheduled events
      const ctx = machine.ctx || machine._context;
      if (!ctx?.scheduledEvents) continue;

      // Force all scheduled events to be due NOW
      let iterations = 0;
      while (ctx.scheduledEvents.size > 0 && iterations < 50) {
        for (const [, entry] of ctx.scheduledEvents) {
          entry.time = 0;
          if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        }
        ctx.processDueEvents();
        // Process the queue
        mod.executor.pumpEvents();
        iterations++;
      }
    }
  }

  /** Reset all modules */
  reset(): SystemState {
    // Stop all executors
    for (const mod of this.modules) {
      mod.executor.stop();
    }
    // Recreate everything
    this.modules = createModuleRegistry();
    this.eventMap = buildEventMap(this.modules);
    this.commandHistory = [];
    this.logs = [];
    this.assessmentStore.clear();
    this.eventSpine.clear();
    this.correlationCounter = 0;
    this.stepCounter = 0;
    // Recreate deck from scratch (clears any dynamically loaded carriers)
    if (this.deckFactory) {
      this.deck = this.deckFactory();
    }
    // Reset deck tracker (clears well volumes, tip usage, liquid tracking)
    this.deckTracker = new DeckTracker(this.deck);

    // Re-attach plugins and combined trace listeners (same pattern as constructor)
    this.attachPlugins();
    for (const mod of this.modules) {
      const self = this;
      const modId = mod.id;
      const plugin = this.plugins.get(modId);

      const listener = new Proxy({}, {
        get(_target, prop) {
          if (prop === "onLog") {
            return (label: string, message: string) => {
              self.logs.push({ label, message, module: modId, timestamp: Date.now() });
            };
          }
          if (prop === "onTransitionExecute") {
            return (sourceId: string, targetIds: string[], event: string, _cond: string, _ts: number) => {
              self.transitionFired = true;
              if (plugin?.onAfterTransition) {
                const activeStates: string[] = Array.from(mod.executor.getActiveStateIds()) as string[];
                plugin.onAfterTransition({ source: sourceId, targets: targetIds || [], event: event || "", activeStates });
              }
            };
          }
          if (prop === "onStateEnter" && plugin?.onStateEnter) {
            return (stateId: string, activeStates: string[], _ts: number) => {
              plugin.onStateEnter!({ stateId, activeStates: activeStates || [] });
            };
          }
          return () => {};
        }
      });
      mod.executor.addTraceListener(listener);
    }

    this.notifyListeners();
    return this.getSystemState();
  }

  // ---- Private helpers ----

  /**
   * Ad-hoc resolve the FW-parameter X/Y and emit an unresolved_position
   * assessment if appropriate. Called before physics validation so the
   * assessment fires even when the command is rejected.
   */
  private maybeEmitUnresolvedFromParams(
    event: string,
    eventData: Record<string, unknown>,
    moduleId: string,
    correlationId?: number,
    stepId?: number
  ): AssessmentEvent | null {
    // Skip commands with no coordinate parameters at all (queries, init, status).
    // Note: we check for the presence of xp/yp/xs/yh/yj params, NOT whether
    // they are zero — an explicit xp00000 at the deck origin IS a positional
    // command worth assessing (it doesn't match any labware).
    const hasXparam = eventData.xp !== undefined || eventData.xs !== undefined;
    const hasYparam = eventData.yp !== undefined || eventData.yh !== undefined || eventData.yj !== undefined;
    if (!hasXparam && !hasYparam) return null;
    const x = (eventData.xp as number) ?? (eventData.xs as number) ?? 0;
    const y = (eventData.yp as number) ?? (eventData.yh as number) ?? (eventData.yj as number) ?? 0;
    const interaction: DeckInteraction = {
      timestamp: Date.now(),
      command: event,
      x,
      y,
      resolution: this.deckTracker.resolvePosition(x, y),
      correlationId,
      stepId,
    };
    return this.emitUnresolvedAssessment(event, interaction, moduleId, correlationId, stepId);
  }

  /**
   * Emit an AssessmentEvent for unresolved FW coordinates (#34).
   * Returns the stored event, or null if the interaction is fully resolved.
   *
   * The DeckTracker's classification logic (deck-tracker.ts:390-418) already
   * tags mismatches as unresolved; this method translates them into typed
   * assessment observations so consumers (UI panel, SSE, MCP, reports)
   * see them through one channel.
   */
  private emitUnresolvedAssessment(
    event: string,
    interaction: DeckInteraction,
    moduleId: string,
    correlationId?: number,
    stepId?: number
  ): AssessmentEvent | null {
    const res = interaction.resolution;

    // Determine severity + description based on the event and match kind.
    // Only emit for commands that *need* a position — movement-only commands
    // legitimately hit unresolved coordinates (e.g. arm idling above deck).
    const positionalCommands = new Set([
      "C0AS", "C0DS", "C0DF",  // PIP aspirate / dispense
      "C0TP", "C0TR",           // PIP tip pickup / eject
      "C0EA", "C0ED", "C0EP", "C0ER",  // 96-head
      "C0JA", "C0JD", "C0JB", "C0JC",  // 384-head
      "C0PP", "C0PR",           // iSWAP
      "C0ZP", "C0ZR",           // CO-RE gripper
    ]);
    if (!positionalCommands.has(event)) return null;

    let severity: "info" | "warning" | "error" | null = null;
    let description = "";

    if (!res.matched) {
      // Coordinate didn't resolve to any labware. Severity varies by operation.
      if (event === "C0AS" || event === "C0JA" || event === "C0EA") {
        severity = "error";
        description = `Aspirate at unresolved coordinates (${res.description})`;
      } else if (event === "C0DS" || event === "C0DF" || event === "C0JD" || event === "C0ED") {
        severity = "warning";
        description = `Dispense at unresolved coordinates (${res.description})`;
      } else if (event === "C0TP" || event === "C0EP" || event === "C0JB") {
        severity = "error";
        description = `Tip pickup at unresolved coordinates (${res.description})`;
      } else if (event === "C0PP" || event === "C0ZP") {
        severity = "warning";
        description = `Plate pickup at unresolved coordinates (${res.description})`;
      } else {
        severity = "info";
        description = `${event} at unresolved coordinates (${res.description})`;
      }
    } else if (res.labwareType?.includes("Tip")) {
      // Matched a tip rack, but the command is aspirate/dispense: wrong target type.
      if (event === "C0AS" || event === "C0DS" || event === "C0DF" ||
          event === "C0JA" || event === "C0JD" ||
          event === "C0EA" || event === "C0ED") {
        severity = "error";
        description = `${event} targeted a tip rack (${res.description})`;
      }
    } else if ((event === "C0TP" || event === "C0EP" || event === "C0JB") &&
               res.labwareType && !res.labwareType.includes("Tip")) {
      // Tip pickup aimed at non-tip labware.
      severity = "error";
      description = `Tip pickup from non-tip-rack (${res.description})`;
    }

    if (severity === null) return null;

    return this.assessmentStore.add({
      category: "unresolved_position",
      severity,
      module: moduleId,
      command: event,
      description,
      data: {
        x: interaction.x,
        y: interaction.y,
        matched: res.matched,
        labwareType: res.labwareType,
        carrierId: res.carrierId,
        position: res.position,
      },
      correlationId,
      stepId,
    });
  }

  private getModuleVariables(mod: ModuleEntry): Record<string, unknown> {
    const machine = mod.executor.machine;
    if (machine && machine._datamodel) {
      return { ...machine._datamodel };
    }
    return {};
  }

  /**
   * Commands that the real FW always accepts regardless of system state.
   * These are queries, config writes, status requests, and setup commands
   * that VENUS sends before C0VI (system init).
   */
  private static ALWAYS_ACCEPTED = new Set([
    // System queries
    "C0RQ", "C0RF", "C0QB", "C0QM", "C0RM", "C0QW", "C0RI", "C0RS", "C0RV",
    "C0SR", "C0RU", "C0QT", "C0RO", "C0RJ", "C0UJ", "C0VD", "C0RK", "C0QV",
    // Config writes
    "C0TT", "C0ST", "C0SS", "C0SL", "C0WL", "C0WJ",
    "C0AM", "C0NS", "C0HD", "C0AZ", "C0AB", "C0AW",
    "C0SI", "C0AV", "C0AT", "C0AK", "C0DD", "C0XK",
    "C0AG", "C0AF", "C0AD", "C0AN", "C0AJ", "C0AE", "C0IP", "C0AO", "C0BT", "C0AU",
    // Cover/door
    "C0CO", "C0HO", "C0CD", "C0CE", "C0QC",
    // Port/loading
    "C0OS", "C0OR", "C0AC", "C0RW", "C0CP", "C0CB", "C0CU", "C0DR",
    // Position queries
    "C0RX", "C0QX", "C0BA", "C0BB", "C0BC",
    // Download
    "C0AP", "C0DE", "C0DP",
    // Service
    "C0GO", "C0AH", "C0AL", "C0RH", "C0AI", "C0AA",
    // PIP queries
    "C0QS", "C0FS", "C0VE", "C0RT", "C0RL", "C0RY", "C0RB", "C0RZ", "C0RD",
    // 96-head queries
    "C0QH", "C0QI", "C0VC", "C0VB",
    // iSWAP queries
    "C0RG", "C0QP", "C0QG", "C0PC",
    // AutoLoad queries
    "C0RC", "C0QA", "C0CQ", "C0VL",
    // Wash queries
    "C0QF",
    // 384-head queries
    "C0QJ", "C0QK", "C0QY",
    // Other completions that may fire anytime
    "C0ZA", "C0EV", "C0IV", "C0JE",
    // AutoLoad maintenance / query — real FW accepts any time.
    // C0CL/C0CR go through SCXML so the loading/unloading transitions
    // fire and the carriage-position model (pos_track / target_track)
    // stays accurate for the renderer's motion envelope.
    "C0CI", "C0CW", "C0CT",
    // NOTE: C0VI/C0DI/C0EI/C0II/C0FI are handled by master.scxml —
    // transitions in sys_off (→ sys_initializing) and self-loops
    // in sys_initializing + sys_ready make them idempotent. Do NOT
    // add them here or SCXML will never see them.
  ]);

  private isAlwaysAcceptedCommand(event: string): boolean {
    return DigitalTwin.ALWAYS_ACCEPTED.has(event);
  }

  private inferRejectionError(event: string, states: string[]): number {
    const needsTip = ["C0AS", "C0DS", "C0DF", "C0LW"];
    if (needsTip.includes(event) && states.some((s) => s === "no_tip" || s === "not_initialized")) {
      return 8; // No tip
    }
    const needs96Tips = ["C0EA", "C0ED", "C0EG"];
    if (needs96Tips.includes(event) && states.some((s) => s === "no_tips" || s === "not_initialized")) {
      return 8;
    }
    if (event === "C0PR" && states.some((s) => s === "empty" || s === "parked")) {
      return 22; // No element
    }
    if (states.some((s) => s === "not_initialized")) {
      return 3; // Command not completed (not initialized)
    }
    return 15; // Not allowed
  }

  private describeState(mod: ModuleEntry, states: string[]): string {
    // Return the most specific (leaf) state
    const leafStates = states.filter((s) =>
      s !== "operational" && s !== "idle" && s !== "tip_fitted" && s !== "tips_on" && s !== "ready"
    );
    return leafStates.length > 0 ? leafStates.join(", ") : states.join(", ");
  }

  /** Create and register physics plugins (trace listeners are added in constructor) */
  private attachPlugins(): void {
    const pluginMap: Record<string, PhysicsPlugin> = {
      pip: new PipPhysicsPlugin(),
      h96: new CoRe96HeadPhysicsPlugin(),
      h384: new CoRe384HeadPhysicsPlugin(),
      iswap: new ISwapPhysicsPlugin(),
      temp: new TemperaturePhysicsPlugin(),
      hhs: new HHSPhysicsPlugin(),
      wash: new WashPhysicsPlugin(),
    };

    for (const [modId, plugin] of Object.entries(pluginMap)) {
      const mod = this.modules.find((m) => m.id === modId);
      if (mod) {
        // Call onAttach if provided
        if (plugin.onAttach) plugin.onAttach(mod.executor, modId);
        this.plugins.set(modId, plugin);
      }
    }
  }

  /** Get the plugin for a module (if any) */
  private getPlugin(moduleId: string): PhysicsPlugin | undefined {
    return this.plugins.get(moduleId);
  }

  /** Get the plugin that handles a specific FW event (for timing queries) */
  getPluginForEvent(event: string): PhysicsPlugin | undefined {
    const target = this.eventMap.get(event);
    if (!target) return undefined;
    return this.plugins.get(target.id);
  }

  /**
   * Register an external physics plugin for a module.
   * If a plugin already exists for the module, it is replaced.
   * This is the extension point for custom modules.
   */
  registerPlugin(moduleId: string, plugin: PhysicsPlugin): void {
    const mod = this.modules.find((m) => m.id === moduleId);
    if (mod) {
      if (plugin.onAttach) plugin.onAttach(mod.executor, moduleId);
      this.plugins.set(moduleId, plugin);
    }
  }

  /**
   * Register a plugin whose `assess()` hook runs on every accepted
   * command regardless of target module. Intended for cross-module
   * concerns (collision detection, supervisory assessments). Other
   * hooks (`validateCommand`, `onBeforeEvent`, …) are NOT dispatched
   * globally — those belong to per-module plugins.
   */
  registerGlobalPlugin(plugin: PhysicsPlugin): void {
    this.globalPlugins.push(plugin);
  }

  /** Current list of registered global plugins (for introspection / tests). */
  listGlobalPlugins(): PhysicsPlugin[] {
    return [...this.globalPlugins];
  }

  /**
   * Register an external hardware module with its SCXML executor.
   * Allows adding custom modules without editing module-registry.ts.
   */
  registerModule(entry: { id: string; name: string; executor: any; events: string[]; plugin?: PhysicsPlugin }): void {
    // Add to modules list
    this.modules.push({ id: entry.id, name: entry.name, executor: entry.executor, events: entry.events });
    // Map events
    for (const event of entry.events) {
      this.eventMap.set(event, { id: entry.id, name: entry.name, executor: entry.executor, events: entry.events });
    }
    // Register plugin if provided
    if (entry.plugin) {
      this.registerPlugin(entry.id, entry.plugin);
    }
  }

  /** List all registered module IDs */
  listModules(): string[] {
    return this.modules.map(m => m.id);
  }

  /** List all registered plugin IDs */
  listPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Generate realistic FW response data from the current state.
   * Returns key-value pairs to append to the response string.
   */
  private generateResponseData(event: string, params: Record<string, unknown>): Record<string, string> | undefined {
    const pipMod = this.modules.find((m) => m.id === "pip");
    const pipDm = pipMod?.executor?.machine?._datamodel;
    const tempMod = this.modules.find((m) => m.id === "temp");
    const tempDm = tempMod?.executor?.machine?._datamodel;

    switch (event) {
      case "C0TP": {
        // Tip pickup: return sensor clamp values per channel (sx) and grip values (sg)
        const fitted = pipDm?.tip_fitted as boolean[] || [];
        const sx = fitted.map((_: boolean, i: number) => fitted[i] ? String(450 + Math.round(Math.random() * 30)) : "000").join(" ");
        const sg = fitted.map((_: boolean, i: number) => fitted[i] ? String(440 + Math.round(Math.random() * 40)) : "000").join(" ");
        return { sx, sg };
      }

      case "C0QS": {
        // Query channel tip-present status. Real 8-channel traces
        // return exactly 8 space-separated flags (see
        //   VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/
        //     Star/TipPickup/TipPickup1ml_ComTrace.trc:C0QSid0236 →
        //     "qs0 0 0 0 0 0 0 0"
        // ). VENUS's parser reads `currentNbrOfPipettingChannels`
        // tokens; emitting 16 for an 8-channel twin confuses the
        // channel state machine.
        const fitted = pipDm?.tip_fitted as boolean[] || new Array(16).fill(false);
        const activeChannels = 8; // matches `kp08` in C0RM
        const qs = fitted.slice(0, activeChannels).map((f: boolean) => f ? "1" : "0").join(" ");
        return { qs };
      }

      case "C0RJ": {
        // Query channel valid state — VENUS greys out the Control
        // Panel unless every active channel reports `tq1`.
        // Real trace: `C0RJid0237er00/00tq1 1 1 1 1 1 1 1`
        // (see AtsMcGetChnValidState.cpp:123 parser, reads one
        //  digit per channel separated by spaces).
        const activeChannels = 8;
        const tq = new Array(activeChannels).fill("1").join(" ");
        return { tq };
      }

      case "C0RT": {
        // Read temperature: per-channel readings (PIP Z positions as
        // proxy). Mirror real 8-channel traces — one token per active
        // channel, not 16.
        const posZ = pipDm?.pos_z as number[] || new Array(16).fill(0);
        const activeChannels = 8;
        const rt = posZ.slice(0, activeChannels).map((z: number) => String(z)).join(" ");
        return { rt };
      }

      case "C0RL": {
        // Read last-liquid-level: per-channel liquid-surface Z, signed
        // 5-digit zero-padded ("lh+00042 +00055 …"). Field name and
        // format confirmed against
        // `ML_STAR_Simulator.cfg:1191` — NOT `rl` (that's pre-5.5).
        const surfaceZ = pipDm?.liquid_surface_z as number[] || new Array(16).fill(0);
        const lh = surfaceZ.map((z: number) => signedPad5(z)).join(" ");
        return { lh };
      }

      case "C0RF": {
        // Firmware version — VENUS init path reads this on every
        // master channel and every sub-device to verify compat.
        // Format: "rf<major>.<minor><letter> <build> YYYY-MM-DD (<component>)".
        return { rf: encodeC0RF(this.venusConfig) };
      }

      case "C0RI": {
        // Instrument info — production date + serial number. Used by
        // VENUS service tooling. Format: "si<YYYY-MM-DD>sn<serial>".
        return { "": encodeC0RI(this.venusConfig) };
      }

      case "C0RM": {
        // Machine status block — reports which sub-devices are
        // initialised and their readiness bitmasks. Shape derived
        // from `ML_STAR_Simulator.cfg:1175` + real trace line 9.
        // For the twin we report everything idle/ready.
        return { "": encodeC0RM(this.venusConfig) };
      }

      case "C0TR": {
        // Tip eject: per-channel tip presence (0 after eject)
        const rt = new Array(16).fill("0").join(" ");
        return { rt };
      }

      case "C0QM": {
        // Machine config — packed parameters matching real instrument.
        // Derived from `venusConfig` so the advertised ka/xt/xa/xw
        // match the loaded deck (see twin/venus-config.ts for the
        // bit layout + deck inference rules). VENUS cross-checks
        // these on discovery — mismatched core96Head raises "Default
        // waste for C0-RE 96 Head is missing" at Command.cpp:1857.
        return { "": encodeC0QM(this.venusConfig) };
      }

      case "C0HC":
      case "C0HI": {
        // Temperature set — return current temp
        const ct = tempDm?.current_temp_01c || 220;
        return { rt: String(ct) };
      }

      case "C0RQ": return { rq: "0000" };
      case "C0QB": return { qb: "1" };
      // Arm X-drive range — VENUS Control Panel's "Move Pipetting
      // arm" slider reads this to size its min/max. Right-arm min==max
      // signals "no right arm" (single-arm STAR). Format matches
      // AtsMcRequestDrivesXRange.cpp:92 parser: exactly 4 × 5-digit
      // values space-separated.
      case "C0RU": return { ru: encodeC0RU(this.venusConfig) };
      // Cover-position query. VENUS's semantics are inverted from
      // the obvious read: `qc1` means "cover present / OK" (OnOffType
      // `On`) and `qc0` means "cover not ready" (`Off`). The parser
      // stores the value as `coverState`, and RunLockFrontCover.cpp:125
      // raises the "Cover not closed" dialog when `coverState == Off`.
      // So closed → `qc1`, open → `qc0`.
      case "C0QC": return { qc: this.coverOpen ? "0" : "1" };

      default:
        return undefined;
    }
  }

  // --- Cover (front-panel door) state ----------------------------------

  /** True when the front cover is physically open (VENUS blocks motion). */
  isCoverOpen(): boolean {
    return this.coverOpen;
  }

  /**
   * Set the cover open/closed state. Emits a state-change so the UI
   * updates. When the cover is opened while VENUS is running a method,
   * VENUS will see the next C0QC probe return `qc1` and halt.
   */
  setCoverOpen(open: boolean): void {
    if (this.coverOpen === open) return;
    this.coverOpen = open;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    const state = this.getSystemState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

/**
 * Format a signed integer as `+NNNN` / `-NNNN` (4-digit magnitude,
 * zero-padded, with a leading sign). Matches the wire format used by
 * C0RL for liquid-surface Z readback (`lh+0042 +0055 …`).
 */
function signedPad5(v: number): string {
  const sign = v < 0 ? "-" : "+";
  const mag = Math.abs(Math.trunc(v)).toString().padStart(4, "0");
  return `${sign}${mag}`;
}
