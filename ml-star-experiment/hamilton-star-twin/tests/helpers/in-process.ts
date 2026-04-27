/**
 * In-process test helpers for unit tests.
 *
 * Creates a DigitalTwinAPI instance directly (no HTTP server, no Electron).
 * Unit tests use this to exercise the twin synchronously and deterministically.
 *
 * Imports from `dist/` (the built CJS output) because the generated SCXML
 * modules in src/state-machines/modules/*.js are authored as CJS (require())
 * but their sibling package.json declares "type": "module", so they only work
 * after the build step at scripts/convert-modules.js. The dist output is what
 * Electron actually runs, so testing against it is the stronger contract.
 *
 * Prerequisite: `npm run build` must have run at least once.
 *
 * For HTTP-based integration tests, use `./test-server.ts` instead.
 *
 * @see tests/TESTING-GUIDE.md for authoring guidelines.
 */
// Import from the TypeScript sources for type information (these are type-only imports)
import type { DigitalTwinAPI as DigitalTwinAPIType, DeviceConfig } from "../../src/twin/api";
import type { CommandResult, SystemState } from "../../src/twin/digital-twin";
import type { AssessmentEvent, AssessmentCategory } from "../../src/twin/assessment";
import type { LiquidContents, ChannelState } from "../../src/twin/liquid-tracker";

// Runtime import from the built dist (SCXML modules only work there).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DigitalTwinAPI } = require("../../dist/twin/api");

export interface TestTwin {
  /** The device ID used by the underlying API. Hidden from most tests. */
  readonly deviceId: string;

  /** The raw API (escape hatch for advanced tests). */
  readonly api: DigitalTwinAPIType;

  /** Send a raw FW command and return the result synchronously. */
  sendCommand(raw: string): CommandResult;

  /** Dispatch a delayed completion event (e.g. "move.done"). */
  sendCompletion(event: string): SystemState;

  /** Flush all pending delayed events (forces delayed timers to fire immediately). */
  flushPending(): void;

  /** Reset the device to a fresh state. */
  reset(): void;

  /** Initialize the twin (C0VI, C0DI, C0EI, C0II). Returns after master is sys_ready. */
  initAll(): void;

  /** Reset and initialize in one call. */
  resetAndInit(): void;

  // -- State queries --

  /** Full state snapshot via the API. */
  getState(): ReturnType<DigitalTwinAPIType["getState"]>;

  /** Active state IDs for a specific module. */
  getModuleStates(moduleId: string): string[];

  /** Datamodel variables for a specific module. */
  getModuleVars(moduleId: string): Record<string, unknown>;

  /** Deck tracking snapshot (well volumes, tip usage, channels, unresolved). */
  getTracking(): ReturnType<DigitalTwinAPIType["getDeckTracking"]>;

  /** Assessment events (optionally filtered). */
  getAssessments(options?: { category?: AssessmentCategory; channel?: number; count?: number }): AssessmentEvent[];

  // -- Deck queries --

  /** Resolve a well address to FW coordinates. */
  wellXY(carrierId: string, position: number, column: number, row?: number): { x: number; y: number; xp: string; yp: string };

  /** Get well volume in 0.1 µL. */
  getWellVolume(carrierId: string, position: number, wellIndex: number): number;

  /** Get all well volumes for a given column (default 8 rows for 96-well). */
  getColumnVolumes(carrierId: string, position: number, col: number, rows?: number, cols?: number): number[];

  /** Get liquid contents for a well (identity + volume + class). */
  getWellLiquid(carrierId: string, position: number, wellIndex: number): LiquidContents | null;

  /** Get per-channel state for a PIP channel. */
  getChannelState(channel: number): ChannelState | null;

  // -- Setup helpers --

  /** Pre-fill a labware with liquid (for setting up initial deck state). */
  fillPlate(carrierId: string, position: number, liquidType: string, volume: number, liquidClass?: string): boolean;

  // -- Event subscriptions --

  /** Register a listener for all twin events (command results, assessments, state changes). */
  onEvent(listener: (event: any) => void): () => void;

  /** Cleanup: destroy the device and clear listeners. */
  destroy(): void;
}

export interface CreateTestTwinOptions extends Omit<DeviceConfig, "name"> {
  /** If true (default), automatically initialize modules after creation. */
  autoInit?: boolean;
}

/**
 * Create a fresh DigitalTwinAPI with a single device, pre-initialized.
 *
 * Example:
 * ```
 * const twin = createTestTwin();
 * const r = twin.sendCommand("C0TPid0001xp01033yp01375tm255tt04");
 * expect(r.accepted).toBe(true);
 * ```
 */
export function createTestTwin(options: CreateTestTwinOptions = {}): TestTwin {
  const { autoInit = true, ...deviceConfig } = options;
  const api = new DigitalTwinAPI();
  const deviceId = api.createDevice({ name: "TestTwin", ...deviceConfig });
  let eventListenerDisposers: Array<() => void> = [];

  const sendCommand = (raw: string): CommandResult => api.sendCommand(deviceId, raw);

  const sendCompletion = (event: string): SystemState => api.sendCompletion(deviceId, event);

  const flushPending = (): void => api.flushPendingEvents(deviceId);

  const reset = (): void => {
    api.resetDevice(deviceId);
  };

  const initAll = (): void => {
    // Send the four init commands. sendCommand is synchronous; delayed events
    // scheduled during init are flushed below.
    sendCommand("C0VIid9001");
    sendCommand("C0DIid9002");
    sendCommand("C0EIid9003");
    sendCommand("C0IIid9004");
    // Flush all scheduled delayed events (e.g. master sys_initializing -> sys_ready)
    flushPending();
    // Verify sys_ready was reached. This is a test helper, so we assert here.
    const state = api.getState(deviceId);
    const masterStates = state.modules.master?.states || [];
    if (!masterStates.includes("sys_ready")) {
      throw new Error(
        `Twin initAll did not reach master.sys_ready; active states = ${JSON.stringify(masterStates)}`
      );
    }
  };

  const resetAndInit = (): void => {
    reset();
    if (autoInit) initAll();
  };

  const wellXY = (carrierId: string, position: number, column: number, row: number = 0) => {
    // Route through Deck.wellToPosition so the test helper shares the
    // one canonical formula (#consolidation). Avoids drift between
    // here, deck.ts, deck-tracker, venus-layout and the renderer.
    const dev: any = (api as any).devices.get(deviceId);
    const wp = dev.twin.deck.wellToPosition({ carrierId, position, row, column });
    if (!wp) throw new Error(`No labware at ${carrierId} pos ${position}`);
    return {
      x: wp.x,
      y: wp.y,
      xp: String(wp.x).padStart(5, "0"),
      yp: String(wp.y).padStart(5, "0"),
    };
  };

  const getWellVolume = (carrierId: string, position: number, wellIndex: number): number => {
    const tracking = api.getDeckTracking(deviceId);
    return tracking.wellVolumes?.[`${carrierId}:${position}:${wellIndex}`] ?? 0;
  };

  const getColumnVolumes = (
    carrierId: string,
    position: number,
    col: number,
    rows: number = 8,
    cols: number = 12
  ): number[] => {
    const tracking = api.getDeckTracking(deviceId);
    const vols: number[] = [];
    for (let row = 0; row < rows; row++) {
      const key = `${carrierId}:${position}:${row * cols + col}`;
      vols.push(tracking.wellVolumes?.[key] ?? 0);
    }
    return vols;
  };

  const twin: TestTwin = {
    deviceId,
    api,
    sendCommand,
    sendCompletion,
    flushPending,
    reset,
    initAll,
    resetAndInit,
    getState: () => api.getState(deviceId),
    getModuleStates: (moduleId) => api.getState(deviceId).modules[moduleId]?.states || [],
    getModuleVars: (moduleId) => api.getState(deviceId).modules[moduleId]?.variables || {},
    getTracking: () => api.getDeckTracking(deviceId),
    getAssessments: (opts) => api.getAssessments(deviceId, opts),
    wellXY,
    getWellVolume,
    getColumnVolumes,
    getWellLiquid: (carrierId, position, wellIndex) => api.getWellLiquid(deviceId, carrierId, position, wellIndex),
    getChannelState: (channel) => api.getChannelState(deviceId, channel),
    fillPlate: (carrierId, position, liquidType, volume, liquidClass = "default") =>
      api.fillLabwareWithLiquid(deviceId, carrierId, position, liquidType, volume, liquidClass),
    onEvent: (listener) => {
      const dispose = api.onEvent((evt) => {
        if (evt.deviceId === deviceId) listener(evt);
      });
      eventListenerDisposers.push(dispose);
      return dispose;
    },
    destroy: () => {
      for (const dispose of eventListenerDisposers) dispose();
      eventListenerDisposers = [];
      api.destroyDevice(deviceId);
    },
  };

  if (autoInit) {
    initAll();
  }

  return twin;
}
