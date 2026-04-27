/**
 * TraceReplayService (Step 3.1)
 *
 * Time-travel navigation over a recorded TwinTrace. Distinct from Phase 2's
 * `ReplayService`, which re-sends a FW-command trace against a live twin.
 * This service reconstructs the state the twin had at any event on a
 * `TwinTrace` — the artefact Phase 1's `TraceRecorder` produces — without
 * re-simulating the whole run from scratch.
 *
 * Algorithm (bounded re-execution):
 *   1. Find the embedded snapshot with the largest `afterEventId ≤ target`.
 *   2. Spin up a fresh `DigitalTwin` from the trace's `config`.
 *   3. `twin.restore(snapshot.state)` (or `initialState` if no earlier snapshot).
 *   4. Walk the timeline from `snapshot.afterEventId + 1` forward,
 *      re-executing every `kind === "command"` entry on the fresh twin.
 *   5. Stop at `target`. Return `twin.snapshot()`.
 *
 * Not true "zero re-execution" — but snapshots are taken every N events
 * (default 50), so each jump requires at most N command re-runs. For a
 * typical protocol that's < 10 ms. Interactive-UX cheap.
 *
 * Position semantics:
 *   - `eventId 0` (or unset) = state before any events, i.e. `initialState`.
 *   - `eventId N > 0` = state right after the event with `id === N` was emitted.
 *
 * This service does NOT own an SSE broker — callers subscribe via
 * `setListeners()` and forward to the REST/SSE layer.
 */

import * as fs from "fs";
import { DigitalTwin } from "../twin/digital-twin";
import { Deck } from "../twin/deck";
import type { TwinTrace } from "../twin/trace-format";
import { deserializeTrace } from "../twin/trace-format";
import type { TwinTimelineEvent } from "../twin/timeline";
import type { TwinState } from "../twin/twin-config";
import type { CommandResult } from "../twin/digital-twin";
import type { StepResult } from "../twin/venus-steps";

/** Result of a single step/jump operation — what the REST layer emits. */
export interface TraceReplayPosition {
  /**
   * Current position on the timeline as an INDEX (0 = before any events
   * have been processed, N = after all N events). Use this — not the
   * spine's absolute event id — as the stable coordinate for the UI
   * scrubber. Use `currentEvent.id` when you need the absolute id.
   */
  eventId: number;
  /** Total events on the timeline. */
  totalEvents: number;
  /**
   * The LAST processed event (timeline[eventId - 1]) when eventId > 0,
   * null when eventId === 0.
   */
  currentEvent: TwinTimelineEvent | null;
  /** Monotonically increasing; lets SSE clients drop stale pushes. */
  revision: number;
}

/** What /api/analysis/info returns — high-level status. */
export interface TraceReplayInfo extends TraceReplayPosition {
  loaded: boolean;
  traceName: string | null;
  playing: boolean;
  /** ms between steps during continuous playback. */
  speed: number;
  /** Metadata copied from the loaded trace, null if none loaded. */
  metadata: TwinTrace["metadata"] | null;
}

/** Filters used by `seek`. */
export interface SeekFilter {
  kind?: TwinTimelineEvent["kind"];
  severity?: "info" | "warning" | "error";
  correlationId?: number;
  /** Match by a substring of the command's rawCommand (for kind=command). */
  commandContains?: string;
  /** Skip the event at `fromEventId` itself; used by "find next" UX. */
  fromEventId?: number;
  /** Direction: default "forward". */
  direction?: "forward" | "backward";
}

/** Lifecycle callbacks — wired to the SSE broker by the REST layer. */
export interface TraceReplayListeners {
  onPositionChanged?: (p: TraceReplayPosition) => void;
  onStateChanged?: (state: TwinState, position: TraceReplayPosition) => void;
  onDone?: (info: { total: number }) => void;
}

/** Handle returned when a fork is created. */
export interface ForkHandle {
  forkId: string;
  /**
   * Position (timeline index) on the original trace where this fork
   * branched. Used for diff calculations — compare the fork's live state
   * against `getStateAt(branchedAtIndex)` of the trace to see what changed.
   */
  branchedAtIndex: number;
}

/** Per-well volume diff produced by diffFork. */
export interface WellVolumeDiff {
  wellKey: string;
  originalVolume: number;
  forkVolume: number;
  delta: number;
}

/** Structural diff between a fork and the original trace at the branch point. */
export interface ForkDiff {
  forkId: string;
  branchedAtIndex: number;
  /** Wells whose volume changed between original and fork. */
  wellVolumes: WellVolumeDiff[];
  /** Modules whose active state set changed. */
  moduleStates: Array<{ moduleId: string; original: string[]; fork: string[] }>;
  /** Tip-usage keys present in one snapshot but not the other. */
  tipUsage: { addedInFork: string[]; removedInFork: string[] };
  /** Commands the fork has run since branching. */
  forkCommandCount: number;
}

const SPEED_MIN_MS = 10;
const SPEED_MAX_MS = 2000;
const DEFAULT_SPEED_MS = 150;

export class TraceReplayService {
  private trace: TwinTrace | null = null;
  private traceName: string | null = null;
  private currentEventId = 0;
  private listeners: TraceReplayListeners = {};
  private speedMs = DEFAULT_SPEED_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  // Latest materialized TwinState for the current eventId. Cached so
  // `getState()` can return it without recomputation when the caller
  // hasn't moved. Invalidated on every jump/step.
  private cachedState: TwinState | null = null;
  // What-if fork bookkeeping (Step 3.2).
  private forks: Map<string, { twin: DigitalTwin; branchedAtIndex: number; commandCount: number }> = new Map();
  private forkCounter = 0;

  /** Register subscribers for position/state/done callbacks. */
  setListeners(listeners: TraceReplayListeners): void {
    this.listeners = listeners;
  }

  /** Load a trace from an already-parsed object (e.g. from memory / HTTP body). */
  load(trace: TwinTrace, nameHint: string | null = null): void {
    this.trace = trace;
    this.traceName = nameHint ?? trace.metadata.label ?? null;
    this.currentEventId = 0;
    this.cachedState = null;
    this.cancelTimer();
    this.bumpRevision();
    this.listeners.onPositionChanged?.(this.buildPosition());
  }

  /** Load a trace from a JSON string. Delegates to `load()` after parsing. */
  loadFromJson(json: string, nameHint: string | null = null): void {
    this.load(deserializeTrace(json), nameHint);
  }

  /** Load a trace from a file on disk. Used by /api/analysis/load?path=. */
  loadFromFile(tracePath: string): void {
    const text = fs.readFileSync(tracePath, "utf-8");
    const trace = deserializeTrace(text);
    // Use the file name as a default label if none is provided.
    const baseName = tracePath.split(/[\\/]/).pop() ?? null;
    this.load(trace, trace.metadata.label ?? baseName);
  }

  /** Current status summary — what /api/analysis/info returns. */
  getInfo(): TraceReplayInfo {
    const pos = this.buildPosition();
    return {
      ...pos,
      loaded: this.trace !== null,
      traceName: this.traceName,
      playing: this.timer !== null,
      speed: this.speedMs,
      metadata: this.trace?.metadata ?? null,
    };
  }

  /** Current position descriptor (cheaper than getInfo). */
  getPosition(): TraceReplayPosition {
    return this.buildPosition();
  }

  /** Jump directly to `eventId`. Clamps to [0, totalEvents]. */
  jump(eventId: number): TraceReplayPosition {
    this.requireLoaded();
    const total = this.trace!.timeline.length;
    const clamped = Math.max(0, Math.min(total, Math.floor(eventId)));
    this.currentEventId = clamped;
    this.cachedState = null;
    this.bumpRevision();
    const pos = this.buildPosition();
    this.listeners.onPositionChanged?.(pos);
    return pos;
  }

  /**
   * Advance one event. "forward" moves toward higher ids; "backward" toward
   * lower. No-ops at the ends.
   */
  step(direction: "forward" | "backward" = "forward"): TraceReplayPosition {
    this.requireLoaded();
    const total = this.trace!.timeline.length;
    const delta = direction === "forward" ? +1 : -1;
    const next = this.currentEventId + delta;
    if (next < 0 || next > total) {
      // End of range — emit onDone when walking past the end.
      if (next > total) this.listeners.onDone?.({ total });
      return this.buildPosition();
    }
    return this.jump(next);
  }

  /**
   * Find the next (or previous) event matching `filter`. No-op if nothing
   * matches. Returns the new position.
   *
   * Position semantics: seeking is relative to the current INDEX, not the
   * spine's absolute event id. Matching index i advances the cursor to
   * i + 1 (meaning "event at index i was just processed").
   */
  seek(filter: SeekFilter): TraceReplayPosition {
    this.requireLoaded();
    const timeline = this.trace!.timeline;
    const direction = filter.direction ?? "forward";
    const fromIndex = filter.fromEventId ?? this.currentEventId;

    const matches = (e: TwinTimelineEvent): boolean => {
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.severity && e.severity !== filter.severity) return false;
      if (filter.correlationId !== undefined && e.correlationId !== filter.correlationId) return false;
      if (filter.commandContains) {
        if (e.kind !== "command") return false;
        const raw = (e.payload as CommandResult).rawCommand ?? "";
        if (!raw.includes(filter.commandContains)) return false;
      }
      return true;
    };

    if (direction === "forward") {
      for (let i = fromIndex; i < timeline.length; i++) {
        if (matches(timeline[i])) return this.jump(i + 1);
      }
    } else {
      for (let i = Math.min(fromIndex - 2, timeline.length - 1); i >= 0; i--) {
        if (matches(timeline[i])) return this.jump(i + 1);
      }
    }
    return this.buildPosition();  // no match; position unchanged
  }

  /**
   * Compute the TwinState at the current event. Rebuilds by picking the
   * nearest ≤ snapshot and re-executing the intervening commands on a
   * fresh, short-lived twin. Result is cached until the next jump/step.
   */
  getState(): TwinState {
    this.requireLoaded();
    if (this.cachedState) return this.cachedState;
    this.cachedState = this.computeStateAt(this.currentEventId);
    this.listeners.onStateChanged?.(this.cachedState, this.buildPosition());
    return this.cachedState;
  }

  /**
   * Compute state at an arbitrary event without mutating position. Use
   * when the UI needs a peek (e.g. hover preview on the timeline).
   */
  getStateAt(eventId: number): TwinState {
    this.requireLoaded();
    return this.computeStateAt(eventId);
  }

  /**
   * Events in the half-open index range [from, to). Used by the analysis
   * REST endpoint and the well-inspector's per-well history.
   *
   * Indices here refer to timeline array position (0-based), not the
   * spine's absolute event id. Convert via `trace.timeline[index].id` if
   * absolute is needed.
   */
  getEventsInRange(fromIndex: number, toIndex: number): TwinTimelineEvent[] {
    if (!this.trace) return [];
    const clampedFrom = Math.max(0, Math.min(this.trace.timeline.length, fromIndex));
    const clampedTo = Math.max(clampedFrom, Math.min(this.trace.timeline.length, toIndex));
    return this.trace.timeline.slice(clampedFrom, clampedTo);
  }

  /**
   * Fetch an event by its 1-based position (same coordinate as jump/step).
   * `getEvent(1)` returns the first event, `getEvent(N)` the last.
   * Returns null when out of range.
   */
  getEvent(position: number): TwinTimelineEvent | null {
    if (!this.trace) return null;
    const idx = Math.floor(position) - 1;
    if (idx < 0 || idx >= this.trace.timeline.length) return null;
    return this.trace.timeline[idx];
  }

  /** All events on the currently loaded trace. */
  getAllEvents(): TwinTimelineEvent[] {
    return this.trace ? [...this.trace.timeline] : [];
  }

  /**
   * Reference to the currently loaded trace (read-only contract — callers
   * must not mutate). Returns null when nothing is loaded. Used by the
   * report generator and MCP layer to run stateless reports over the
   * same trace the user is navigating.
   */
  getTrace(): TwinTrace | null {
    return this.trace;
  }

  /** Speed slider setter — clamps to [10, 2000] ms. */
  setSpeed(ms: number): number {
    this.speedMs = Math.max(SPEED_MIN_MS, Math.min(SPEED_MAX_MS, ms));
    return this.speedMs;
  }

  /** Play forward at current speed. */
  play(speedMs?: number): void {
    this.requireLoaded();
    if (speedMs !== undefined) this.setSpeed(speedMs);
    this.cancelTimer();
    const runStep = () => {
      if (this.currentEventId >= this.trace!.timeline.length) {
        this.timer = null;
        this.listeners.onDone?.({ total: this.trace!.timeline.length });
        return;
      }
      this.step("forward");
      this.timer = setTimeout(runStep, this.speedMs);
    };
    runStep();
  }

  /** Pause playback. Idempotent. */
  pause(): void {
    this.cancelTimer();
  }

  /** True while a `play()` timer is running. */
  isPlaying(): boolean {
    return this.timer !== null;
  }

  // --- what-if forks (Step 3.2) -----------------------------------------
  //
  // A fork is a live DigitalTwin cloned from the trace at a specific index.
  // Callers drive it with the usual twin APIs (sendCommand, executeStep);
  // the service tracks how many commands have been run so `diffFork` can
  // report the delta and `discardFork` can tear it down.

  /**
   * Clone the trace's state at `atIndex` into a fresh twin. Returns a
   * handle the caller uses for subsequent fork operations.
   */
  fork(atIndex: number): ForkHandle {
    this.requireLoaded();
    const trace = this.trace!;
    const branchedAtIndex = Math.max(0, Math.min(trace.timeline.length, Math.floor(atIndex)));

    const state = this.computeStateAt(branchedAtIndex);
    const twin = new DigitalTwin(new Deck(trace.config.platform));
    twin.loadConfig(trace.config);
    twin.restore(state);

    const forkId = `fork_${++this.forkCounter}`;
    this.forks.set(forkId, { twin, branchedAtIndex, commandCount: 0 });
    return { forkId, branchedAtIndex };
  }

  /** Send a raw FW command on the fork; counted toward `forkCommandCount`. */
  forkCommand(forkId: string, rawCommand: string): CommandResult {
    const fork = this.requireFork(forkId);
    fork.commandCount++;
    return fork.twin.sendCommand(rawCommand);
  }

  /** Execute a VENUS step on the fork. Each sub-command is counted. */
  forkStep(forkId: string, stepType: string, params: Record<string, unknown>): StepResult {
    const fork = this.requireFork(forkId);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StepExecutor } = require("../twin/venus-steps");
    const executor = new StepExecutor(fork.twin);
    const result = executor.executeStep(stepType, params);
    fork.commandCount += result.commands?.length ?? 0;
    return result;
  }

  /** Full dynamic state of a fork — same shape as `getState()`. */
  forkState(forkId: string): TwinState {
    const fork = this.requireFork(forkId);
    return fork.twin.snapshot();
  }

  /**
   * Compare a fork's current state against the original trace at the
   * branch point. Highlights well-volume and module-state divergence so
   * the UI can render a clean "what changed" summary.
   */
  diffFork(forkId: string): ForkDiff {
    const fork = this.requireFork(forkId);
    const original = this.computeStateAt(fork.branchedAtIndex);
    const forkState = fork.twin.snapshot();

    // Well volumes diff (union of keys; include only those that differ).
    const allWellKeys = new Set([
      ...Object.keys(original.tracking.wellVolumes ?? {}),
      ...Object.keys(forkState.tracking.wellVolumes ?? {}),
    ]);
    const wellVolumes: WellVolumeDiff[] = [];
    for (const key of allWellKeys) {
      const a = (original.tracking.wellVolumes as any)?.[key] ?? 0;
      const b = (forkState.tracking.wellVolumes as any)?.[key] ?? 0;
      if (a !== b) wellVolumes.push({ wellKey: key, originalVolume: a, forkVolume: b, delta: b - a });
    }

    // Module state diff.
    const allModIds = new Set([
      ...Object.keys(original.modules ?? {}),
      ...Object.keys(forkState.modules ?? {}),
    ]);
    const moduleStates: ForkDiff["moduleStates"] = [];
    for (const modId of allModIds) {
      const a = original.modules?.[modId]?.activeStateIds ?? [];
      const b = forkState.modules?.[modId]?.activeStateIds ?? [];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        moduleStates.push({ moduleId: modId, original: [...a], fork: [...b] });
      }
    }

    // Tip usage diff (set difference both ways).
    const origTips = new Set(Object.keys(original.tracking.tipUsage ?? {}));
    const forkTips = new Set(Object.keys(forkState.tracking.tipUsage ?? {}));
    const addedInFork = [...forkTips].filter((k) => !origTips.has(k));
    const removedInFork = [...origTips].filter((k) => !forkTips.has(k));

    return {
      forkId,
      branchedAtIndex: fork.branchedAtIndex,
      wellVolumes,
      moduleStates,
      tipUsage: { addedInFork, removedInFork },
      forkCommandCount: fork.commandCount,
    };
  }

  /** Drop a fork. Subsequent calls with this id throw. */
  discardFork(forkId: string): void {
    this.forks.delete(forkId);
  }

  /** List active fork ids — for REST listing and teardown. */
  listForks(): ForkHandle[] {
    const out: ForkHandle[] = [];
    for (const [forkId, fork] of this.forks) {
      out.push({ forkId, branchedAtIndex: fork.branchedAtIndex });
    }
    return out;
  }

  private requireFork(forkId: string): { twin: DigitalTwin; branchedAtIndex: number; commandCount: number } {
    const fork = this.forks.get(forkId);
    if (!fork) throw new Error(`TraceReplayService: unknown fork "${forkId}"`);
    return fork;
  }

  /** Cancel timers + drop listeners + drop forks. Called during shutdown. */
  dispose(): void {
    this.cancelTimer();
    this.listeners = {};
    this.cachedState = null;
    this.forks.clear();
  }

  // --- internals --------------------------------------------------------

  private requireLoaded(): void {
    if (!this.trace) throw new Error("TraceReplayService: no trace loaded");
  }

  private buildPosition(): TraceReplayPosition {
    const totalEvents = this.trace ? this.trace.timeline.length : 0;
    // currentEventId is a 0..totalEvents index — "how many events have
    // been processed". currentEvent is the last-processed event.
    const currentEvent = this.trace && this.currentEventId > 0
      ? this.trace.timeline[this.currentEventId - 1] ?? null
      : null;
    return {
      eventId: this.currentEventId,
      totalEvents,
      currentEvent,
      revision: this.revision,
    };
  }

  private bumpRevision(): void {
    this.revision++;
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reconstruct state at `targetIndex` (0..N position on the timeline)
   * using nearest-snapshot + bounded re-execution. `targetIndex = 0` is
   * the initial state; `targetIndex = N` is the state after every event.
   *
   * Snapshots carry an `afterEventId` that refers to the spine's absolute
   * event id (the one stored on the timeline entry). We map snapshot
   * boundaries to timeline INDICES by finding each snapshot's event id
   * in the timeline — the matching index+1 is the "count of events
   * processed at snapshot time".
   */
  private computeStateAt(targetIndex: number): TwinState {
    this.requireLoaded();
    const trace = this.trace!;
    const clamped = Math.max(0, Math.min(trace.timeline.length, targetIndex));

    // Pick the nearest usable snapshot. A snapshot is "usable" at position
    // P if the event it was taken after is within [0, P) on the timeline.
    let startState: TwinState = trace.initialState;
    let startIndex = 0;
    for (const snap of trace.snapshots) {
      const snapIndexInTimeline = trace.timeline.findIndex((e) => e.id === snap.afterEventId);
      if (snapIndexInTimeline < 0) continue;
      const snapPosition = snapIndexInTimeline + 1;
      if (snapPosition <= clamped && snapPosition > startIndex) {
        startIndex = snapPosition;
        startState = snap.state;
      }
    }

    // Zero-work case: target is exactly on a snapshot boundary.
    if (startIndex === clamped) {
      return deepCloneState(startState);
    }

    // Fresh twin at the snapshot's state; deep-clone so caller mutations
    // never leak into the trace's stored snapshot.
    const twin = new DigitalTwin(new Deck(trace.config.platform));
    twin.loadConfig(trace.config);
    twin.restore(deepCloneState(startState));

    // Walk from startIndex to clamped (exclusive upper bound already folded
    // into clamped semantics: targetIndex counts events processed).
    // Only "command" events drive state changes — other kinds are
    // observational side-effects of their originating commands.
    for (let i = startIndex; i < clamped; i++) {
      const evt = trace.timeline[i];
      if (evt.kind !== "command") continue;
      const payload = evt.payload as CommandResult;
      const raw = payload.rawCommand;
      if (typeof raw === "string" && raw.length > 0) {
        twin.sendCommand(raw, { stepId: payload.stepId });
      }
    }

    return twin.snapshot();
  }
}

/** Small utility — JSON round-trip is sufficient since TwinState is JSON-safe. */
function deepCloneState(s: TwinState): TwinState {
  return JSON.parse(JSON.stringify(s));
}
