/**
 * Event Spine (Step 1.10)
 *
 * A single ordered, append-only timeline aggregating every twin event:
 * commands, deck interactions, assessments, device events, composite
 * step boundaries, and scheduled-event completions. Existing per-type
 * stores (CommandHistory, DeckTracker.interactions, AssessmentStore,
 * DeviceEventEmitter.eventLog) continue to work as specialized views;
 * the EventSpine is their shared projection for replay and trace export.
 *
 * Design:
 *   - Strictly append-only from the twin's perspective. Never mutate an
 *     entry after adding.
 *   - Global monotonically increasing id assigned by the spine itself.
 *   - Index-friendly: by kind, severity, correlationId, stepId, well key,
 *     and time range. Indexes are built lazily; for the small-to-medium
 *     recordings the twin produces, linear scans are fast enough.
 *   - JSON-safe payloads — the spine ships inside a TwinTrace (Step 1.11).
 */

import type { CommandResult } from "./digital-twin";
import type { DeckInteraction } from "./deck-tracker";
import type { AssessmentEvent, AssessmentSeverity } from "./assessment";
import type { DeviceEvent } from "./device-events";

/** Kinds of events the spine can carry. */
export type TwinTimelineEventKind =
  | "command"
  | "deck_interaction"
  | "assessment"
  | "device_event"
  | "step"
  | "completion";

/**
 * Lifecycle classification for a timeline event (Step 3.3).
 *
 *   - `active`     — default; the event has just occurred and hasn't been
 *                    triaged yet. Most commands and observational events.
 *   - `expected`   — this event was anticipated by the operator / protocol
 *                    and needs no attention.
 *   - `flagged`    — something worth a human look. Set by the classifier
 *                    or explicitly by the operator.
 *   - `suppressed` — noisy but benign. Hidden from default views.
 *   - `resolved`   — was flagged, but a subsequent event (e.g. tip eject
 *                    after contamination) cleared the concern.
 */
export type TwinEventLifecycle =
  | "active"
  | "expected"
  | "flagged"
  | "suppressed"
  | "resolved";

/** Shape of a single entry on the spine. */
export interface TwinTimelineEvent {
  /** Global id assigned by the spine (distinct from correlationId). */
  id: number;
  /** Millisecond timestamp at time of add() — set by the spine. */
  timestamp: number;
  /** Which kind of event this entry describes. */
  kind: TwinTimelineEventKind;
  /** ID of the originating FW command, if applicable. */
  correlationId?: number;
  /** ID of the composite VENUS step, if applicable. */
  stepId?: number;
  /** Severity — copied from the payload for fast filtering. */
  severity?: AssessmentSeverity;
  /** Raw payload. Type depends on `kind`. */
  payload:
    | CommandResult
    | DeckInteraction
    | AssessmentEvent
    | DeviceEvent
    | TwinStepBoundary
    | TwinCompletion;
  /**
   * Lifecycle classification (Step 3.3). Written after the event lands —
   * usually by the classifier, occasionally by an operator action. Omit
   * for "active" (default) so serialized traces don't balloon with the
   * most common case.
   */
  lifecycle?: TwinEventLifecycle;
}

/** Boundary marker for composite-step lifecycle on the spine. */
export interface TwinStepBoundary {
  stepId: number;
  phase: "start" | "end";
  stepType: string;
  /** Present on "end" — true iff every sub-command succeeded. */
  success?: boolean;
}

/** Marker for a delayed scheduled-event completion (e.g. move.done). */
export interface TwinCompletion {
  moduleId: string;
  eventName: string;
}

/**
 * Partial input to add(): the spine assigns `id` and `timestamp`.
 * Callers supply everything else.
 */
export type TwinTimelineEventInput = Omit<TwinTimelineEvent, "id" | "timestamp">;

/**
 * Ordered, append-only timeline for all twin events.
 *
 * One instance per DigitalTwin. The twin calls add() from each emit site;
 * consumers (TraceRecorder, UI panels, MCP analysis tools) either query
 * via the provided getters or subscribe via onEvent().
 */
export class EventSpine {
  private events: TwinTimelineEvent[] = [];
  private nextId = 1;
  private listeners: Array<(event: TwinTimelineEvent) => void> = [];

  /**
   * Append an event to the spine. The spine assigns `id` and `timestamp`.
   * Returns the stored event with those fields populated.
   */
  add(input: TwinTimelineEventInput): TwinTimelineEvent {
    const event: TwinTimelineEvent = {
      ...input,
      id: this.nextId++,
      timestamp: Date.now(),
    };
    this.events.push(event);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* don't break the twin */ }
    }
    return event;
  }

  /** Number of events on the spine. */
  size(): number {
    return this.events.length;
  }

  /** Shallow-copy of every event on the spine, in insertion order. */
  getAll(): TwinTimelineEvent[] {
    return [...this.events];
  }

  /** All events that carry the given correlationId. */
  getByCorrelation(correlationId: number): TwinTimelineEvent[] {
    return this.events.filter((e) => e.correlationId === correlationId);
  }

  /** All events that carry the given stepId. */
  getByStep(stepId: number): TwinTimelineEvent[] {
    return this.events.filter((e) => e.stepId === stepId);
  }

  /** All events of the given kind. */
  getByKind(kind: TwinTimelineEventKind): TwinTimelineEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /** All events at the given severity (info/warning/error). */
  getBySeverity(severity: AssessmentSeverity): TwinTimelineEvent[] {
    return this.events.filter((e) => e.severity === severity);
  }

  /**
   * Events whose payload references the given well key
   * (format: "<carrierId>:<position>:<wellIndex>").
   *
   * Matches against:
   *   - deck_interaction — resolution.{carrierId,position,wellIndex}
   *   - assessment — data.{carrierId,position,wellIndex} when present
   */
  getByWell(wellKey: string): TwinTimelineEvent[] {
    return this.events.filter((e) => this.matchesWell(e, wellKey));
  }

  /**
   * Events whose timestamp falls within [t0, t1] inclusive.
   * Used for replay window queries.
   */
  getInRange(t0: number, t1: number): TwinTimelineEvent[] {
    return this.events.filter((e) => e.timestamp >= t0 && e.timestamp <= t1);
  }

  /**
   * Subscribe to new events. Returns an unsubscribe function. Listener
   * errors are swallowed to keep the twin alive — don't throw from here.
   */
  onEvent(listener: (event: TwinTimelineEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Remove every event and reset the id counter. */
  clear(): void {
    this.events = [];
    this.nextId = 1;
  }

  private matchesWell(event: TwinTimelineEvent, wellKey: string): boolean {
    // wellKey format is "<carrierId>:<position>:<wellIndex>"
    const parts = wellKey.split(":");
    if (parts.length !== 3) return false;
    const [carrierId, positionStr, wellIndexStr] = parts;
    const position = Number(positionStr);
    const wellIndex = Number(wellIndexStr);

    if (event.kind === "deck_interaction") {
      const p = event.payload as DeckInteraction;
      const r = p.resolution;
      return (
        r.matched === true &&
        r.carrierId === carrierId &&
        r.position === position &&
        r.wellIndex === wellIndex
      );
    }
    if (event.kind === "assessment") {
      const p = event.payload as AssessmentEvent;
      const data = p.data || {};
      return (
        data.carrierId === carrierId &&
        data.position === position &&
        data.wellIndex === wellIndex
      );
    }
    return false;
  }
}
