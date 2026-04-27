/**
 * Physics Plugin Interface
 *
 * Defines how physics simulation code hooks into the SCXML executor
 * lifecycle. Each module can have one plugin attached.
 *
 * The plugin receives callbacks at key points:
 *   - Before an event is sent (can modify data)
 *   - After a transition completes (can send follow-up events)
 *   - On state entry (can schedule timed events)
 *   - For delay calculation (determines async timing)
 */

import { AssessmentEvent } from "./assessment";

/** Info about a transition that just fired */
export interface TransitionInfo {
  source: string;
  targets: string[];
  event: string;
  activeStates: string[];
}

/** Info about a state that was entered */
export interface StateEntryInfo {
  stateId: string;
  activeStates: string[];
}

/**
 * Interface for physics plugins.
 *
 * All methods are optional. Implement only what you need.
 * The executor calls these via the trace listener mechanism.
 */
/** Result of physics validation — if errorCode is set, command is rejected */
export interface PhysicsValidation {
  valid: boolean;
  errorCode?: number;       // FW error code (e.g. 22 = no element, 6 = too little liquid)
  errorDescription?: string;
}

export interface PhysicsPlugin {
  /** Unique identifier for this plugin */
  readonly id: string;

  /**
   * Called once when the plugin is attached to an executor.
   * Use this to store references and set up initial state.
   */
  onAttach?(executor: any, moduleId: string): void;

  /**
   * Validate a command against the physical state of the deck.
   * Called BEFORE the SCXML processes the event.
   *
   * If this returns { valid: false, errorCode }, the command is rejected
   * without touching the SCXML — simulating sensor-based error detection
   * (e.g. capacitive tip detection, liquid level sensing).
   *
   * @param event - FW event code (C0TP, C0AS, etc.)
   * @param data - Parsed command parameters
   * @param deckTracker - Access to deck state for physical validation
   * @returns Validation result, or undefined to skip validation
   */
  validateCommand?(event: string, data: Record<string, unknown>, deckTracker: any, datamodel?: Record<string, unknown>): PhysicsValidation | undefined;

  /**
   * Called before an event is sent to the state machine.
   * Can modify or augment the event data (e.g. inject calculated delays,
   * apply liquid class corrections to volumes).
   *
   * Return the (possibly modified) data object.
   */
  onBeforeEvent?(event: string, data: Record<string, unknown>): Record<string, unknown>;

  /**
   * Called after a transition completes.
   * Can send follow-up events to the executor (e.g. "tadm.ok", "lld.detected").
   */
  onAfterTransition?(info: TransitionInfo): void;

  /**
   * Called when a state is entered.
   * Useful for starting timers or scheduling delayed events.
   */
  onStateEnter?(info: StateEntryInfo): void;

  /**
   * Calculate the delay (in ms) for an async operation.
   * Called by the digital twin when a state entry needs a timed completion.
   *
   * @param operation - The operation type (e.g. "move", "wash", "heat")
   * @param params - Relevant parameters (distance, speed, cycles, etc.)
   * @returns Delay in milliseconds, or undefined to use the default
   */
  calculateDelay?(operation: string, params: Record<string, unknown>): number | undefined;

  /**
   * Assess the physical consequences of an accepted command.
   * Called AFTER the command is accepted and SCXML transition has fired.
   *
   * Returns zero or more assessment observations (TADM, LLD, contamination, etc.).
   * Assessments NEVER reject commands — they only observe and report.
   *
   * @param event - FW event code (C0AS, C0DS, C0TP, etc.)
   * @param data - Parsed command parameters (post-processing)
   * @param deckTracker - Access to deck state for physical assessment
   * @returns Array of assessment events, or empty array
   */
  assess?(event: string, data: Record<string, unknown>, deckTracker: any): AssessmentEvent[];

  /**
   * Estimate execution time for a command based on physical parameters.
   *
   * Three accuracy tiers:
   *   - "computed": Calculated from FW params + current state (axis speeds, flow rates, distances)
   *   - "hybrid": Partially computed, partially estimated (e.g. known flow rate + estimated Z travel)
   *   - "estimate": Best guess based on command type (no physics computation)
   *
   * @param event - FW event code
   * @param data - Parsed command parameters
   * @returns Timing estimate with accuracy tier, or undefined if this plugin doesn't handle the event
   */
  estimateTime?(event: string, data: Record<string, unknown>): CommandTiming | undefined;

  // ==========================================================================
  // Snapshot / restore (digital-twin Phase 1 #43)
  // Opt-in: only plugins that hold internal state beyond what's in the SCXML
  // datamodel need to implement these. Most plugins derive state from the
  // executor's datamodel and can omit both methods.
  // ==========================================================================

  /**
   * Return plugin-specific state for serialization. The result must be
   * JSON-safe (no Maps, Sets, functions, or circular references).
   *
   * Examples of state that belongs here:
   *   - Accumulated statistics (e.g. cached TADM trend buffers).
   *   - Cached calculations that survive across commands.
   *   - Plugin-internal counters.
   *
   * Plugins that derive all their state from the SCXML datamodel should
   * NOT implement this method — returning nothing is the correct behavior.
   */
  getPluginState?(): Record<string, unknown>;

  /**
   * Restore plugin state from a previous serialization. Replaces the
   * plugin's internal state wholesale. Must be idempotent: calling
   * restorePluginState with the same snapshot twice produces the same
   * plugin state.
   */
  restorePluginState?(state: Record<string, unknown>): void;
}

/** Result of a physics-based timing estimation */
export interface CommandTiming {
  /** Total estimated time in milliseconds */
  totalMs: number;
  /** Accuracy tier */
  accuracy: "computed" | "hybrid" | "estimate";
  /** Breakdown of time components (for display) */
  breakdown?: Array<{
    phase: string;      // e.g. "X travel", "aspirate", "Z descend", "settle"
    ms: number;
    detail?: string;    // e.g. "245mm at 800mm/s"
  }>;
}

/**
 * Create a trace listener that delegates to a PhysicsPlugin.
 *
 * This bridges the SCXML trace listener API (method-based callbacks)
 * to the cleaner PhysicsPlugin interface.
 *
 * Uses Proxy for forward-compatibility with any trace methods.
 */
export function createPluginTraceListener(
  plugin: PhysicsPlugin,
  executor: any,
  moduleId: string
): any {
  // Call onAttach if provided
  if (plugin.onAttach) {
    plugin.onAttach(executor, moduleId);
  }

  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "onTransitionExecute" && plugin.onAfterTransition) {
        return (sourceId: string, targetIds: string[], event: string, _cond: string, _ts: number) => {
          const activeStates: string[] = Array.from(executor.getActiveStateIds()) as string[];
          plugin.onAfterTransition!({
            source: sourceId,
            targets: targetIds || [],
            event: event || "",
            activeStates,
          });
        };
      }

      if (prop === "onStateEnter" && plugin.onStateEnter) {
        return (stateId: string, activeStates: string[], _ts: number) => {
          plugin.onStateEnter!({
            stateId,
            activeStates: activeStates || [],
          });
        };
      }

      if (prop === "onLog") {
        return () => {}; // Logs handled separately by digital-twin.ts
      }

      return () => {}; // noop for all other trace methods
    }
  });
}
