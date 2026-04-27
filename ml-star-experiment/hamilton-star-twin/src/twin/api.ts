/**
 * Digital Twin Core API
 *
 * Clean interface to the Hamilton STAR device simulator.
 * Decoupled from any transport (Electron IPC, REST, MCP).
 * Supports multiple device instances.
 *
 * Usage:
 *   const api = new DigitalTwinAPI();
 *   const deviceId = api.createDevice("STAR", { name: "My STAR" });
 *   const result = api.sendCommand(deviceId, "C0ASid0001xp2518yp745av1000");
 *   const state = api.getState(deviceId);
 */

import { DigitalTwin, CommandResult, SystemState } from "./digital-twin";
import { Deck, DeckSnapshot, Carrier, LabwareItem, loadLabwareDefinition } from "./deck";
import { DeckInteraction } from "./deck-tracker";
import { LiquidContents, ChannelState, ContaminationEvent } from "./liquid-tracker";
import { AssessmentEvent, AssessmentCategory } from "./assessment";
import { StepExecutor, StepResult } from "./venus-steps";
import type { TwinConfig, TwinState, TwinSession } from "./twin-config";

// ============================================================================
// Types
// ============================================================================

/** Configuration for creating a new device */
export interface DeviceConfig {
  name?: string;
  platform?: "STAR" | "STARlet";
  /** Pre-built Deck instance (e.g. from VENUS .lay import). Takes priority over deckLayout. */
  deck?: Deck;
  /** Custom deck layout (carriers + labware). If omitted, uses default layout. */
  deckLayout?: CarrierConfig[];
}

/** Carrier configuration for deck setup */
export interface CarrierConfig {
  type: string;        // e.g. "PLT_CAR_L5MD"
  track: number;       // Starting track (1-based)
  id?: string;         // Custom ID (auto-generated if omitted)
  labware?: LabwareConfig[];  // Labware at each position
}

/** Labware configuration */
export interface LabwareConfig {
  position: number;    // Position on carrier (0-based)
  type: string;        // Labware type name or path to JSON definition
  barcode?: string;
}

/** Device info returned by listDevices */
export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
}

/** Full device state snapshot */
export interface DeviceState {
  deviceId: string;
  deviceName: string;
  modules: SystemState["modules"];
  deck: DeckSnapshot;
  deckTracker: {
    wellVolumes: Record<string, number>;
    tipUsage: Record<string, boolean>;
    recentInteractions: DeckInteraction[];
  };
  /** Liquid identity tracking state */
  liquidTracking: {
    wellContents: Record<string, LiquidContents>;
    channels: ChannelState[];
    contamination: ContaminationEvent[];
    hasContamination: boolean;
  };
  /** Recent assessment events (physics observations) */
  assessments: AssessmentEvent[];
  timestamp: number;
}

/** Event emitted by the twin */
export interface TwinEvent {
  deviceId: string;
  type: "state_change" | "command_result" | "error" | "deck_interaction" | "assessment" | "device_event" | "step_result" | "motion" | "settings_change";
  data: unknown;
  timestamp: number;
}

export type TwinEventListener = (event: TwinEvent) => void;

/**
 * Server-wide simulation settings. Shared across all devices on this
 * DigitalTwinAPI instance and all transports (REST `/command`, REST
 * `/step`, VENUS TCP bridge, MCP). Callers that pass a per-command
 * `simSpeed` override still win — these are the fallback when the
 * caller omits it.
 */
export interface TwinSettings {
  /**
   * Default physical-time multiplier applied when a caller doesn't pass
   * one explicitly. Follows the `applySimSpeed` convention:
   *   0   → instant (skip motion delay)
   *   0.5 → 2× faster than real time
   *   1   → real-time (default)
   *   2   → half speed
   */
  simSpeed: number;
  /**
   * When true, init commands (C0VI/C0DI/C0EI/C0FI/C0II/C0JI) execute
   * with no wall-clock delay regardless of `simSpeed` — lets a user
   * watch protocol execution at real time without sitting through the
   * ~70 s of cumulative init homing every time they reset.
   */
  fastInit: boolean;
}

/** FW events treated as init by the fastInit flag. */
const INIT_EVENTS = new Set(["C0VI", "C0DI", "C0EI", "C0FI", "C0II", "C0JI"]);

/** True if `raw` is one of the module-init firmware commands. */
export function isInitCommand(raw: string): boolean {
  if (!raw || raw.length < 4) return false;
  return INIT_EVENTS.has(raw.substring(0, 4));
}

/**
 * Resolve the effective simSpeed for a given command given an
 * optional per-call override + the server-wide settings. Init
 * commands collapse to 0 when `settings.fastInit` is on.
 *
 * Null/undefined override → use global; otherwise the explicit
 * override wins (including 0 for "instant this one command").
 */
export function resolveEffectiveSimSpeed(
  rawCommand: string,
  override: number | undefined,
  settings: TwinSettings,
): number {
  if (settings.fastInit && isInitCommand(rawCommand)) return 0;
  if (typeof override === "number") return override;
  return settings.simSpeed;
}

/**
 * Defaults for a fresh server / test run:
 *   simSpeed = 1   → motion plays at real STAR timing (CNC retract→XY→descend
 *                    envelopes still observable; don't drop this below 1
 *                    unless the user opts in via /settings or the header
 *                    dropdown).
 *   fastInit = true → the 70-ish seconds of system/PIP/96-head/iSWAP/autoload
 *                    homing are skipped. A user clicking "Init All" or a
 *                    VENUS method sending C0VI..C0II gets READY immediately
 *                    instead of staring at "sys_initializing" for a minute.
 *                    If someone wants to observe the real init timing they
 *                    flip the Fast Init checkbox off.
 */
const DEFAULT_SETTINGS: TwinSettings = { simSpeed: 1, fastInit: true };

// ============================================================================
// API Implementation
// ============================================================================

export class DigitalTwinAPI {
  private devices: Map<string, { twin: DigitalTwin; info: DeviceInfo }> = new Map();
  private deviceCounter: number = 0;
  private eventListeners: TwinEventListener[] = [];
  private settings: TwinSettings = { ...DEFAULT_SETTINGS };

  // --------------------------------------------------------------------------
  // Device management
  // --------------------------------------------------------------------------

  /** Create a new device instance */
  createDevice(config?: DeviceConfig): string {
    this.deviceCounter++;
    const id = `device_${this.deviceCounter}`;
    const name = config?.name || `STAR #${this.deviceCounter}`;

    const twin = new DigitalTwin(config?.deck);

    // Register state change listener
    twin.onStateChange((state) => {
      this.emit({ deviceId: id, type: "state_change", data: state, timestamp: Date.now() });
    });

    // Register device event listener (unsolicited FW events)
    twin.onDeviceEvent((deviceEvent) => {
      this.emit({ deviceId: id, type: "device_event", data: deviceEvent, timestamp: Date.now() });
    });

    // Register assessment listener (physics observations)
    twin.getAssessmentStore().onAssessment((assessment) => {
      this.emit({ deviceId: id, type: "assessment", data: assessment, timestamp: Date.now() });
    });

    // Register motion listener so the renderer can interpolate arm trajectory
    // during the travel (instead of the old snap-at-end behavior).
    twin.onMotion((envelope) => {
      this.emit({ deviceId: id, type: "motion", data: envelope, timestamp: Date.now() });
    });

    const info: DeviceInfo = {
      id,
      name,
      platform: config?.platform || "STAR",
      createdAt: Date.now(),
    };

    this.devices.set(id, { twin, info });
    return id;
  }

  /** Remove a device instance */
  destroyDevice(deviceId: string): boolean {
    return this.devices.delete(deviceId);
  }

  /** List all device instances */
  listDevices(): DeviceInfo[] {
    return Array.from(this.devices.values()).map((d) => d.info);
  }

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  /**
   * Peek at the motion envelope a command would emit, push it to the
   * renderer listeners at t=0, and return the physical duration. The
   * deferred `/command` path uses this to start the animation
   * immediately while scheduling the actual state mutation
   * (SCXML transition, deckTracker, assess, broadcast) at
   * t=durationMs — so an API consumer querying deck state mid-motion
   * sees the OLD volumes / positions, matching the user-visible
   * timeline of a real instrument (user request 2026-04-19). */
  prepareAndEmitMotionEnvelope(deviceId: string, rawCommand: string): { durationMs: number } {
    const twin = this.getTwin(deviceId);
    const { durationMs } = twin.prepareAndEmitMotionEnvelope(rawCommand);
    return { durationMs };
  }

  /**
   * Deferred sendCommand: emits the motion envelope at t=0 and waits
   * for the physical duration to elapse before running the actual
   * state-mutation phase. Returns a Promise that resolves with the
   * CommandResult once the state has committed.
   *
   * This is the right choice for any path that represents the twin as
   * a LIVE instrument (HTTP `/command`, VENUS TCP bridge, MCP). A
   * consumer polling `/api/state` mid-motion sees the pre-command
   * volumes / positions — matching what a real STAR reports while the
   * arm is still travelling.
   *
   * `simSpeed` follows the existing `applySimSpeed` convention
   * (multiplier: 0.5 = "2× Speed" = half the real wall-clock). If
   * `simSpeed === 0` ("Instant" mode) or no envelope is emitted, the
   * call falls through to synchronous `sendCommand` behaviour. Tests
   * that need deterministic synchronous execution keep calling
   * `sendCommand` directly. User request 2026-04-19.
   */
  sendCommandDeferred(deviceId: string, rawCommand: string, options?: { simSpeed?: number; stepId?: number }): Promise<CommandResult> {
    const peek = this.prepareAndEmitMotionEnvelope(deviceId, rawCommand);
    // Resolve per-call override against the global settings. `fastInit`
    // collapses init commands to simSpeed=0 so the user can watch
    // protocols play at real time without sitting through homing every
    // reset.
    const resolved = resolveEffectiveSimSpeed(rawCommand, options?.simSpeed, this.settings);
    const s = resolved > 0 ? resolved : 0;
    const delayMs = peek.durationMs > 0 && s > 0
      ? Math.max(0, Math.round(peek.durationMs * s))
      : 0;
    const shouldFlushInit = this.settings.fastInit && isInitCommand(rawCommand);
    return new Promise<CommandResult>((resolve) => {
      const commit = () => {
        const result = this.sendCommand(deviceId, rawCommand, {
          suppressMotionEnvelope: peek.durationMs > 0 && s > 0,
          stepId: options?.stepId,
        });
        if (peek.durationMs > 0) {
          (result as any).motionDurationMs = peek.durationMs;
          (result as any).simulatedDelayMs = delayMs;
        }
        // fastInit: the init-complete SCXML transitions are scheduled
        // via `<send delay=Xs>` inside the master state machine, so the
        // command returning fast doesn't finish the init — the modules
        // linger in `sys_initializing` / `not_initialized` until those
        // delayed events fire. Flushing pending events forces them to
        // run NOW so the modules land in `sys_initialized` by the time
        // we resolve. Matches what `autoInit: true` does at server
        // startup (server-setup.ts line 200).
        if (shouldFlushInit) {
          this.flushPendingEvents(deviceId);
        }
        resolve(result);
      };
      if (delayMs > 0) setTimeout(commit, delayMs);
      else commit();
    });
  }

  /** Send a raw FW command string to a device */
  sendCommand(deviceId: string, rawCommand: string, options?: { suppressMotionEnvelope?: boolean; stepId?: number }): CommandResult {
    const twin = this.getTwin(deviceId);
    const result = twin.sendCommand(rawCommand, options);

    this.emit({
      deviceId,
      type: "command_result",
      data: { command: rawCommand, result },
      timestamp: Date.now(),
    });

    if (result.deckInteraction) {
      this.emit({
        deviceId,
        type: "deck_interaction",
        data: result.deckInteraction,
        timestamp: Date.now(),
      });
    }

    return result;
  }

  /** Flush all pending delayed events (for synchronous replay) */
  flushPendingEvents(deviceId: string): void {
    this.getTwin(deviceId).flushPendingEvents();
  }

  /** Send a completion/internal event (move.done, wash.done, etc.) */
  sendCompletion(deviceId: string, eventName: string): SystemState {
    const twin = this.getTwin(deviceId);
    return twin.sendCompletion(eventName);
  }

  // --------------------------------------------------------------------------
  // Settings (server-wide simulation defaults)
  // --------------------------------------------------------------------------

  /** Current simulation settings (simSpeed + fastInit). */
  getSettings(): TwinSettings {
    return { ...this.settings };
  }

  /**
   * Partial update — pass only the fields that should change. Emits a
   * `settings_change` event so SSE / MCP subscribers can resync. Returns
   * the new full settings.
   */
  setSettings(patch: Partial<TwinSettings>): TwinSettings {
    if (typeof patch.simSpeed === "number" && Number.isFinite(patch.simSpeed) && patch.simSpeed >= 0) {
      this.settings.simSpeed = patch.simSpeed;
    }
    if (typeof patch.fastInit === "boolean") {
      this.settings.fastInit = patch.fastInit;
    }
    const snapshot = { ...this.settings };
    this.emit({ deviceId: "", type: "settings_change", data: snapshot, timestamp: Date.now() });
    return snapshot;
  }

  // --------------------------------------------------------------------------
  // State queries
  // --------------------------------------------------------------------------

  /** Get full device state snapshot */
  getState(deviceId: string): DeviceState {
    const device = this.getDevice(deviceId);
    const twin = device.twin;
    const tracker = (twin as any).deckTracker;  // Access internal tracker

    const liquidTracker = tracker?.liquidTracker;
    return {
      deviceId,
      deviceName: device.info.name,
      modules: twin.getSystemState().modules,
      deck: twin.getDeckSnapshot(),
      deckTracker: {
        wellVolumes: tracker?.getWellVolumeSnapshot?.() || {},
        tipUsage: tracker?.getTipUsageSnapshot?.() || {},
        recentInteractions: tracker?.getRecentInteractions?.(20) || [],
      },
      liquidTracking: {
        wellContents: liquidTracker?.getWellSnapshot?.() || {},
        channels: liquidTracker?.getChannelSnapshot?.() || [],
        contamination: liquidTracker?.getRecentContamination?.(20) || [],
        hasContamination: liquidTracker?.hasContamination?.() || false,
      },
      assessments: twin.getAssessmentStore().getRecent(20),
      timestamp: Date.now(),
    };
  }

  /** Get module states only */
  getModuleStates(deviceId: string): Record<string, string[]> {
    return this.getTwin(deviceId).getAllActiveStates();
  }

  /** Get module variables */
  getModuleVariables(deviceId: string): Record<string, Record<string, unknown>> {
    return this.getTwin(deviceId).getAllVariables();
  }

  /** Get deck snapshot */
  getDeck(deviceId: string): DeckSnapshot {
    return this.getTwin(deviceId).getDeckSnapshot();
  }

  /** Hot-swap the deck on an existing device. See `DigitalTwin.setDeck`. */
  setDeck(deviceId: string, deck: import("./deck").Deck, factory?: () => import("./deck").Deck): void {
    this.getTwin(deviceId).setDeck(deck, factory);
  }

  /** Get command history */
  getHistory(deviceId: string): Array<{ command: string; result: CommandResult; timestamp: number }> {
    return this.getTwin(deviceId).getHistory();
  }

  /** Reset a device to initial state */
  resetDevice(deviceId: string): DeviceState {
    const twin = this.getTwin(deviceId);
    twin.reset();
    return this.getState(deviceId);
  }

  // --------------------------------------------------------------------------
  // Front-cover state (VENUS polls via C0QC)
  // --------------------------------------------------------------------------

  /** True when the simulated front cover is open. */
  isCoverOpen(deviceId: string): boolean {
    return this.getTwin(deviceId).isCoverOpen();
  }

  /**
   * Open or close the simulated front cover. VENUS's next C0QC probe
   * sees the new state and either blocks (open) or resumes (closed).
   */
  setCoverOpen(deviceId: string, open: boolean): boolean {
    this.getTwin(deviceId).setCoverOpen(open);
    return this.getTwin(deviceId).isCoverOpen();
  }

  /** Current VENUS-facing FW-identity + module-presence config. */
  getVenusConfig(deviceId: string): import("./venus-config").VenusConfig {
    return this.getTwin(deviceId).getVenusConfig();
  }

  /** Update the VENUS-facing FW config. Typically called once at startup
   *  to apply `--venus-cfg` + `--serial` overrides. */
  setVenusConfig(
    deviceId: string,
    cfg: Partial<import("./venus-config").VenusConfig>,
  ): import("./venus-config").VenusConfig {
    const twin = this.getTwin(deviceId);
    twin.setVenusConfig(cfg);
    return twin.getVenusConfig();
  }

  // --------------------------------------------------------------------------
  // Session save/load (Step 1.7)
  // --------------------------------------------------------------------------

  /**
   * Capture the current device as a self-contained TwinSession. The
   * returned object is JSON-serializable and can be handed to loadSession
   * on this or another machine to reproduce the exact twin state.
   */
  saveSession(deviceId: string, options?: { name?: string; description?: string }): TwinSession {
    const device = this.getDevice(deviceId);
    const twin = device.twin;
    const session: TwinSession = {
      format: "hamilton-twin-session",
      version: 1,
      metadata: {
        name: options?.name ?? device.info.name,
        savedAt: new Date().toISOString(),
        twinVersion: "0.2.0",
        description: options?.description,
      },
      config: twin.getConfig(),
      state: twin.snapshot(),
    };
    return session;
  }

  /**
   * Apply a TwinSession to the target device, replacing its configuration
   * and dynamic state. The device's platform must match the session's
   * platform (creating a new device is the right answer for a different
   * platform).
   */
  loadSession(deviceId: string, session: TwinSession): DeviceState {
    if (!session || typeof session !== "object") {
      throw new Error("loadSession: session is null or not an object");
    }
    if (session.format !== "hamilton-twin-session") {
      throw new Error(`loadSession: unexpected format "${session.format}"`);
    }
    if (session.version !== 1) {
      throw new Error(`loadSession: version ${session.version} not supported`);
    }
    const twin = this.getTwin(deviceId);
    twin.loadConfig(session.config);
    twin.restore(session.state);
    return this.getState(deviceId);
  }

  // --------------------------------------------------------------------------
  // Device events (unsolicited FW events)
  // --------------------------------------------------------------------------

  /** Get the device event log */
  getDeviceEventLog(deviceId: string): any[] {
    return this.getTwin(deviceId).getDeviceEvents().getEventLog();
  }

  // --------------------------------------------------------------------------
  // Assessment queries
  // --------------------------------------------------------------------------

  /** Get recent assessment events */
  getAssessments(deviceId: string, options?: { category?: AssessmentCategory; channel?: number; count?: number }): AssessmentEvent[] {
    const store = this.getTwin(deviceId).getAssessmentStore();
    let events = options?.count ? store.getRecent(options.count) : store.getRecent(50);
    if (options?.category) events = events.filter((e) => e.category === options.category);
    if (options?.channel !== undefined) events = events.filter((e) => e.channel === options.channel);
    return events;
  }

  /** Simulate a device event (for testing) */
  simulateDeviceEvent(deviceId: string, eventType: string, data?: Record<string, unknown>): void {
    const emitter = this.getTwin(deviceId).getDeviceEvents();
    switch (eventType) {
      case "cover.opened": emitter.simulateCoverOpen(); break;
      case "cover.closed": emitter.simulateCoverClose(); break;
      case "emergency.stop": emitter.simulateEmergencyStop(); break;
      case "carrier.removed": emitter.simulateCarrierRemoved(data?.track as number || 1); break;
      case "wash.fluid_empty": emitter.simulateWashFluidEmpty(data?.station as number || 1); break;
      case "temperature.out_of_range":
        emitter.simulateTemperatureAlert(
          data?.zone as number || 1,
          data?.currentTemp as number || 500,
          data?.targetTemp as number || 370
        ); break;
      default:
        emitter.emit("custom", "unknown", `Custom event: ${eventType}`, data);
    }
  }

  // --------------------------------------------------------------------------
  // Deck inspection
  // --------------------------------------------------------------------------

  /** Inspect a specific carrier on the deck */
  inspectCarrier(deviceId: string, carrierId: string): Carrier | null {
    const twin = this.getTwin(deviceId);
    return twin.getDeck().getCarrier(carrierId);
  }

  /**
   * Load labware from a JSON definition and place it on a carrier.
   * The JSON must conform to the labware schema (labware/schema.json).
   */
  loadLabware(
    deviceId: string,
    carrierId: string,
    position: number,
    labwareJson: unknown
  ): boolean {
    const twin = this.getTwin(deviceId);
    const labware = loadLabwareDefinition(labwareJson);
    return twin.getDeck().placeLabware(carrierId, position, labware);
  }

  /** Inspect what's at a specific deck coordinate */
  inspectPosition(deviceId: string, x: number, y: number): {
    resolution: any;
    wellVolume?: number;
    tipUsed?: boolean;
  } {
    const twin = this.getTwin(deviceId);
    const tracker = (twin as any).deckTracker;
    const resolution = tracker.resolvePosition(x, y);

    let wellVolume: number | undefined;
    let tipUsed: boolean | undefined;

    if (resolution.matched) {
      wellVolume = tracker.getWellVolume(resolution.carrierId, resolution.position, resolution.wellIndex);
      tipUsed = tracker.isTipUsed(resolution.carrierId, resolution.position, resolution.wellIndex);
    }

    return { resolution, wellVolume, tipUsed };
  }

  /**
   * Pre-fill wells on a labware with liquid (for setting up initial deck state).
   * Call this after loading labware to establish what liquid is in each well.
   */
  fillLabwareWithLiquid(
    deviceId: string,
    carrierId: string,
    position: number,
    liquidType: string,
    volume: number,
    liquidClass: string = "default"
  ): boolean {
    const twin = this.getTwin(deviceId);
    const carrier = twin.getDeck().getCarrier(carrierId);
    if (!carrier) return false;
    const labware = carrier.labware[position];
    if (!labware) return false;

    const tracker = (twin as any).deckTracker as import("./deck-tracker").DeckTracker;
    tracker.liquidTracker.fillLabware(carrierId, position, labware.type, labware.wellCount, liquidType, volume, liquidClass);
    // Also set well volumes in deck tracker (used by aspirate/dispense tracking)
    for (let w = 0; w < labware.wellCount; w++) {
      tracker.setWellVolume(carrierId, position, w, volume);
    }
    return true;
  }

  /** Pre-fill a subset of wells on a labware. Target is either:
   *    - { all: true }              → every well
   *    - { columns: number[] }      → all rows of these column indices
   *    - { rows: number[] }         → all columns of these row indices
   *    - { wellIndices: number[] }  → explicit linear indices
   *  Column/row combinations AND wellIndices can be combined; the union is used.
   *  Returns { success, wellCount }.  */
  fillLabwareSubset(
    deviceId: string,
    carrierId: string,
    position: number,
    target: { all?: boolean; columns?: number[]; rows?: number[]; wellIndices?: number[] },
    liquidType: string,
    volume: number,
    liquidClass: string = "default"
  ): { success: boolean; wellCount: number; error?: string } {
    const twin = this.getTwin(deviceId);
    const carrier = twin.getDeck().getCarrier(carrierId);
    if (!carrier) return { success: false, wellCount: 0, error: `carrier ${carrierId} not found` };
    const labware = carrier.labware[position];
    if (!labware) return { success: false, wellCount: 0, error: `no labware at ${carrierId}:${position}` };

    const cols = labware.columns ?? (labware.wellCount > 96 ? 24 : 12);
    const rows = labware.rows ?? Math.ceil(labware.wellCount / cols);

    const indices = new Set<number>();
    if (target.all) {
      for (let i = 0; i < labware.wellCount; i++) indices.add(i);
    }
    if (target.columns) {
      for (const c of target.columns) {
        if (c < 0 || c >= cols) continue;
        for (let r = 0; r < rows; r++) indices.add(r * cols + c);
      }
    }
    if (target.rows) {
      for (const r of target.rows) {
        if (r < 0 || r >= rows) continue;
        for (let c = 0; c < cols; c++) indices.add(r * cols + c);
      }
    }
    if (target.wellIndices) {
      for (const i of target.wellIndices) if (i >= 0 && i < labware.wellCount) indices.add(i);
    }

    const tracker = (twin as any).deckTracker as import("./deck-tracker").DeckTracker;
    const wellIndices = Array.from(indices);
    tracker.liquidTracker.fillWellRange(carrierId, position, labware.type, wellIndices, liquidType, volume, liquidClass);
    for (const w of wellIndices) tracker.setWellVolume(carrierId, position, w, volume);
    return { success: true, wellCount: wellIndices.length };
  }

  /** Get liquid contents of a specific well */
  getWellLiquid(deviceId: string, carrierId: string, position: number, wellIndex: number): LiquidContents | null {
    const twin = this.getTwin(deviceId);
    const tracker = (twin as any).deckTracker as import("./deck-tracker").DeckTracker;
    const key = `${carrierId}:${position}:${wellIndex}`;
    return tracker.liquidTracker.getWellContents(key);
  }

  /** Get PIP channel state (tip, liquid, contamination) */
  getChannelState(deviceId: string, channel: number): ChannelState | null {
    const twin = this.getTwin(deviceId);
    const tracker = (twin as any).deckTracker as import("./deck-tracker").DeckTracker;
    return tracker.liquidTracker.getChannelState(channel);
  }

  /** Get all contamination events */
  getContamination(deviceId: string): ContaminationEvent[] {
    const twin = this.getTwin(deviceId);
    const tracker = (twin as any).deckTracker as import("./deck-tracker").DeckTracker;
    return tracker.liquidTracker.getContaminationLog();
  }

  /** Get deck tracking state (tip usage + well volumes + unresolved + liquids) for rendering */
  getDeckTracking(deviceId: string): {
    tipUsage: Record<string, boolean>;
    wellVolumes: Record<string, number>;
    wellContents: Record<string, LiquidContents>;
    channels: ChannelState[];
    unresolved: any[];
    unresolvedCount: number;
    hasContamination: boolean;
  } {
    const twin = this.getTwin(deviceId);
    const tracker = (twin as any).deckTracker as import("./deck-tracker").DeckTracker;
    return {
      tipUsage: tracker.getTipUsageSnapshot(),
      wellVolumes: tracker.getWellVolumeSnapshot(),
      wellContents: tracker.liquidTracker.getWellSnapshot(),
      channels: tracker.liquidTracker.getChannelSnapshot(),
      unresolved: tracker.getUnresolvedInteractions(),
      unresolvedCount: tracker.getUnresolvedCount(),
      hasContamination: tracker.liquidTracker.hasContamination(),
    };
  }

  // --------------------------------------------------------------------------
  // VENUS Steps
  // --------------------------------------------------------------------------

  /** Execute a VENUS step (single or composite) */
  executeStep(deviceId: string, stepType: string, params: Record<string, any>): StepResult {
    const twin = this.getTwin(deviceId);
    const executor = new StepExecutor(twin);
    const result = executor.executeStep(stepType, params);

    this.emit({
      deviceId,
      type: "step_result",
      data: { stepType, params, result },
      timestamp: Date.now(),
    });

    return result;
  }

  /** List all supported VENUS step types */
  listStepTypes(): string[] {
    return StepExecutor.listStepTypes();
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  /** Register an event listener */
  onEvent(listener: TwinEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private getDevice(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);
    return device;
  }

  private getTwin(deviceId: string): DigitalTwin {
    return this.getDevice(deviceId).twin;
  }

  /** Get the physics plugin for a module that handles a given FW event */
  getPlugin(deviceId: string, event: string): any {
    const twin = this.getTwin(deviceId);
    return (twin as any).getPluginForEvent?.(event);
  }

  private emit(event: TwinEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        // Don't let listener errors break the twin
      }
    }
  }
}
