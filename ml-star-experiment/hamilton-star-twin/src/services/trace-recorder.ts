/**
 * TraceRecorder service (Step 1.12)
 *
 * Attaches to a live DigitalTwin and captures its execution into a
 * TwinTrace. The recorder subscribes to the twin's event spine so every
 * command, assessment, deck interaction, device event, step boundary and
 * completion is recorded in one ordered stream.
 *
 * To make replay O(1) at any point, the recorder also takes a full
 * twin.snapshot() every N events (default 50). Jumping to event M during
 * replay: pick the latest snapshot whose afterEventId ≤ M, restore it,
 * walk forward through the intervening timeline events.
 *
 * Lifecycle:
 *   new TraceRecorder(twin)
 *   recorder.start()          — captures initial config + state, begins
 *                               subscribing. Idempotent after stop().
 *   recorder.getTrace()       — snapshot of the trace so far (valid any
 *                               time after start(), including while still
 *                               recording).
 *   recorder.stop()           — detach listeners, capture final state, and
 *                               return the completed TwinTrace.
 *
 * This service is deliberately thin: no UI concerns, no persistence — it
 * just builds the TwinTrace object. Callers pipe the result wherever they
 * need (file, HTTP, MCP response).
 */

import type { DigitalTwin } from "../twin/digital-twin";
import type { TwinTrace, TwinTraceMetadata, TwinTraceSnapshot } from "../twin/trace-format";
import type { TwinTimelineEvent } from "../twin/timeline";
import { TRACE_FORMAT_TAG, TRACE_FORMAT_VERSION } from "../twin/trace-format";

export interface TraceRecorderOptions {
  /**
   * Number of events between periodic state snapshots. Default 50.
   * Smaller = faster replay jumps, larger trace file. Set to 0 to
   * disable periodic snapshots (only initial + final are captured).
   */
  snapshotEveryNEvents?: number;
  /** Optional human-readable label stored in metadata. */
  label?: string;
  /** Optional free-form notes stored in metadata. */
  notes?: string;
  /** Override the device name recorded in metadata. Defaults to "twin". */
  deviceName?: string;
}

const DEFAULT_SNAPSHOT_INTERVAL = 50;

export class TraceRecorder {
  private twin: DigitalTwin;
  private options: Required<Pick<TraceRecorderOptions, "snapshotEveryNEvents">> & TraceRecorderOptions;
  private recording = false;
  private timeline: TwinTimelineEvent[] = [];
  private snapshots: TwinTraceSnapshot[] = [];
  private initialState: any = null;
  private initialConfig: any = null;
  /**
   * When recording, `null` — getTrace() asks the live twin for its
   * current state. After stop(), this holds the frozen final state that
   * was captured at the stop moment.
   */
  private frozenFinalState: any = null;
  private startTime = 0;
  private unsubscribe: (() => void) | null = null;
  private eventsSinceSnapshot = 0;

  constructor(twin: DigitalTwin, options: TraceRecorderOptions = {}) {
    this.twin = twin;
    this.options = {
      snapshotEveryNEvents: options.snapshotEveryNEvents ?? DEFAULT_SNAPSHOT_INTERVAL,
      ...options,
    };
  }

  /**
   * Begin recording. Captures the current config + state as the initial
   * snapshot and subscribes to the twin's event spine. Calling start()
   * on an already-recording recorder is a no-op.
   */
  start(): void {
    if (this.recording) return;
    this.timeline = [];
    this.snapshots = [];
    this.eventsSinceSnapshot = 0;
    this.frozenFinalState = null;
    this.initialConfig = this.twin.getConfig();
    this.initialState = this.twin.snapshot();
    this.startTime = Date.now();
    this.recording = true;

    const spine = this.twin.getEventSpine();
    this.unsubscribe = spine.onEvent((event) => this.onSpineEvent(event));
  }

  /**
   * Stop recording. Captures the final state, detaches from the spine,
   * and returns the completed TwinTrace. Safe to call multiple times;
   * subsequent calls just re-return the last completed trace.
   */
  stop(): TwinTrace {
    if (this.recording) {
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
      // Freeze the twin's state at this exact moment — subsequent twin
      // activity must not leak into getTrace() output after stop().
      this.frozenFinalState = this.twin.snapshot();
      this.recording = false;
    }
    return this.getTrace();
  }

  /**
   * Snapshot of the current trace. Valid any time after start() — while
   * still recording, the returned object is a frozen view of the events
   * captured so far (the recorder keeps accumulating internally).
   */
  getTrace(): TwinTrace {
    if (!this.initialConfig || !this.initialState) {
      throw new Error("TraceRecorder.getTrace called before start()");
    }
    const finalState = this.recording
      ? this.twin.snapshot()
      : this.frozenFinalState ?? this.initialState;
    const timeline = [...this.timeline];
    const snapshots = [...this.snapshots];
    const startTime = timeline.length > 0 ? timeline[0].timestamp : this.startTime;
    const endTime = timeline.length > 0
      ? timeline[timeline.length - 1].timestamp
      : startTime;
    const metadata: TwinTraceMetadata = {
      deviceName: this.options.deviceName ?? "twin",
      platform: this.initialConfig.platform,
      startTime,
      endTime,
      commandCount: timeline.filter((e) => e.kind === "command").length,
      eventCount: timeline.length,
    };
    if (this.options.label !== undefined) metadata.label = this.options.label;
    if (this.options.notes !== undefined) metadata.notes = this.options.notes;
    return {
      format: TRACE_FORMAT_TAG,
      version: TRACE_FORMAT_VERSION,
      metadata,
      config: this.initialConfig,
      initialState: this.initialState,
      timeline,
      snapshots,
      finalState,
    };
  }

  /** True between start() and stop(). */
  isRecording(): boolean {
    return this.recording;
  }

  private onSpineEvent(event: TwinTimelineEvent): void {
    if (!this.recording) return;
    this.timeline.push(event);
    this.eventsSinceSnapshot++;
    const interval = this.options.snapshotEveryNEvents;
    if (interval > 0 && this.eventsSinceSnapshot >= interval) {
      this.snapshots.push({
        afterEventId: event.id,
        state: this.twin.snapshot(),
      });
      this.eventsSinceSnapshot = 0;
    }
  }

}
