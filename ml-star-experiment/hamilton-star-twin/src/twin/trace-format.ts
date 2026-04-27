/**
 * TwinTrace format (Step 1.11)
 *
 * Canonical JSON format for recording the execution of a digital twin
 * protocol. Combines:
 *   - The static world (TwinConfig) at recording start
 *   - The initial TwinState snapshot
 *   - An ordered timeline of every event (commands, assessments, deck
 *     interactions, device events, step boundaries, completions)
 *   - Periodic full state snapshots for O(1) replay jumps
 *   - The final TwinState at recording stop
 *   - Metadata summarizing the run
 *
 * Files written in this format have extension `.twintrace.json`. They are
 * self-contained: given a TwinTrace and a TwinConfig-compatible platform
 * implementation, a fresh DigitalTwin can be brought to any point in the
 * recording with one restore() + a bounded walk of the timeline.
 *
 * Stability rules:
 *   - `format` and `version` fields are load-bearing. Bumps to `version`
 *     must ship with a forward-compatible deserializer or a migration.
 *   - Key order inside serialized JSON is stable to enable byte-identical
 *     re-serialization — downstream tools depend on this when diffing
 *     traces or verifying integrity.
 */

import type { TwinConfig, TwinState } from "./twin-config";
import type { TwinTimelineEvent } from "./timeline";

/** Fixed format tag for file-type sniffing and integrity checks. */
export const TRACE_FORMAT_TAG = "hamilton-twin-trace" as const;
/** Current on-disk schema version. Bump on incompatible shape changes. */
export const TRACE_FORMAT_VERSION = 1 as const;

/** Summary information about the run; useful for listings and filters. */
export interface TwinTraceMetadata {
  /** User-visible name of the device at record time. */
  deviceName: string;
  /** Platform shortname (e.g. "star", "starlet"). Copied from TwinConfig. */
  platform: string;
  /** Unix-ms timestamp of the first event on the timeline. */
  startTime: number;
  /** Unix-ms timestamp of the last event on the timeline. */
  endTime: number;
  /** Count of kind="command" entries on the timeline. */
  commandCount: number;
  /** Total count of entries on the timeline. */
  eventCount: number;
  /** Optional human-supplied label for the run. */
  label?: string;
  /** Optional free-form notes from the operator. */
  notes?: string;
}

/** One periodic snapshot embedded in the trace. */
export interface TwinTraceSnapshot {
  /**
   * The event id (on the timeline) AFTER which this snapshot was taken.
   * Replay: to reach state-at-event-N, load the snapshot with the
   * largest afterEventId ≤ N and walk the timeline forward.
   */
  afterEventId: number;
  /** Full dynamic state — what snapshot() on the twin returned. */
  state: TwinState;
}

/** Complete trace envelope. */
export interface TwinTrace {
  format: typeof TRACE_FORMAT_TAG;
  version: typeof TRACE_FORMAT_VERSION;
  metadata: TwinTraceMetadata;
  config: TwinConfig;
  initialState: TwinState;
  timeline: TwinTimelineEvent[];
  snapshots: TwinTraceSnapshot[];
  finalState: TwinState;
}

/**
 * Serialize a TwinTrace with stable key order so re-serialization is
 * byte-identical. JSON.stringify respects insertion order of plain objects,
 * so we deep-clone-with-canonical-order on the way out.
 */
export function serializeTrace(trace: TwinTrace): string {
  return JSON.stringify(canonicalize(trace));
}

/**
 * Parse a JSON string into a TwinTrace. Throws if the format tag or
 * version don't match — callers should upgrade the trace through an
 * explicit migration rather than silently accept an old shape.
 */
export function deserializeTrace(json: string): TwinTrace {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("deserializeTrace: root is not an object");
  }
  if (parsed.format !== TRACE_FORMAT_TAG) {
    throw new Error(
      `deserializeTrace: unexpected format tag "${parsed.format}" (want "${TRACE_FORMAT_TAG}")`
    );
  }
  if (parsed.version !== TRACE_FORMAT_VERSION) {
    throw new Error(
      `deserializeTrace: version ${parsed.version} not supported (want ${TRACE_FORMAT_VERSION})`
    );
  }
  // Shape spot-checks so malformed files fail fast with a useful message.
  for (const field of ["metadata", "config", "initialState", "timeline", "snapshots", "finalState"] as const) {
    if (!(field in parsed)) {
      throw new Error(`deserializeTrace: missing required field "${field}"`);
    }
  }
  if (!Array.isArray(parsed.timeline)) {
    throw new Error("deserializeTrace: timeline must be an array");
  }
  if (!Array.isArray(parsed.snapshots)) {
    throw new Error("deserializeTrace: snapshots must be an array");
  }
  return parsed as TwinTrace;
}

/**
 * Return a new object whose keys are in the declared order below. Plain
 * objects are recursed; arrays keep their existing order (arrays are
 * ordered by definition); primitives pass through. We don't sort arbitrary
 * keys alphabetically — timeline payloads contain user-supplied records
 * (labware definitions, liquid types) whose natural insertion order is
 * meaningful for debuggability. Instead we canonicalize only the few
 * structural keys whose order we care about.
 */
function canonicalize(trace: TwinTrace): TwinTrace {
  return {
    format: trace.format,
    version: trace.version,
    metadata: canonicalizeMetadata(trace.metadata),
    config: trace.config,
    initialState: trace.initialState,
    timeline: trace.timeline,
    snapshots: trace.snapshots,
    finalState: trace.finalState,
  };
}

function canonicalizeMetadata(m: TwinTraceMetadata): TwinTraceMetadata {
  const canonical: TwinTraceMetadata = {
    deviceName: m.deviceName,
    platform: m.platform,
    startTime: m.startTime,
    endTime: m.endTime,
    commandCount: m.commandCount,
    eventCount: m.eventCount,
  };
  if (m.label !== undefined) canonical.label = m.label;
  if (m.notes !== undefined) canonical.notes = m.notes;
  return canonical;
}
