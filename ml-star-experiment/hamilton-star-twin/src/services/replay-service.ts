/**
 * ReplayService (Step 2.3)
 *
 * Owns everything about replaying a loaded FW-command trace against the
 * live twin: the command buffer, the current position, the play/pause
 * timer, and the playback speed. Phase 2 preserves the existing
 * re-simulation behaviour from main.ts — meaning we re-send each FW
 * command to the twin and flush pending delayed events between commands.
 * Phase 3 replaces this with true state replay against a `TwinTrace`.
 *
 * Callers wire up the broker separately; this service emits lifecycle
 * events via `onStep`, `onDone`, `onReset` callbacks rather than owning an
 * SSE connection. That keeps the service testable without an HTTP server
 * and keeps the broker/transport concern in one place.
 */

import * as fs from "fs";
import * as path from "path";

/** One FW command pulled from a trace file. */
export interface ReplayCommand {
  time: string;
  raw: string;
}

/** High-level summary — what /replay/info returns. */
export interface ReplayInfo {
  loaded: boolean;
  total: number;
  current: number;
  playing: boolean;
  speed: number;
  traceName: string | null;
}

/** Result of a single step — what /replay/step returns when a command ran. */
export interface ReplayStepResult<R = unknown> {
  index: number;
  total: number;
  result: R;
}

/** Dependencies injected by the caller. */
export interface ReplayDeps<R = unknown> {
  /** Execute one FW command on the twin and return its result. */
  sendCommand: (raw: string) => R;
  /** Ensure any scheduled delayed events fire before the next command. */
  flushPending: () => void;
  /** Reset the twin to its initial state AND re-init (caller owns the init recipe). */
  resetAndInit: () => void;
}

/** Subscribe to replay lifecycle events — used by the REST/SSE layer. */
export interface ReplayListeners<R = unknown> {
  onStep?: (step: ReplayStepResult<R> & { raw: string }) => void;
  onDone?: (info: { total: number }) => void;
  onReset?: () => void;
}

/** Bounds clamp for the playback-speed slider (ms between commands). */
const SPEED_MIN_MS = 10;
const SPEED_MAX_MS = 2000;
const DEFAULT_SPEED_MS = 150;

export class ReplayService<R = unknown> {
  private commands: ReplayCommand[] = [];
  private traceName: string | null = null;
  private currentIndex = 0;
  private speedMs = DEFAULT_SPEED_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deps: ReplayDeps<R>;
  private listeners: ReplayListeners<R> = {};

  constructor(deps: ReplayDeps<R>) {
    this.deps = deps;
  }

  /**
   * Wire up lifecycle callbacks. Called by the HTTP layer so it can
   * forward step/done events onto the SSE broker.
   */
  setListeners(listeners: ReplayListeners<R>): void {
    this.listeners = listeners;
  }

  /**
   * Load a trace from disk. Matches the existing main.ts format: each line
   * like `< HH:MM:SS.mmm some-prefix: C0ASid0001...`. Invalid lines are
   * ignored silently, matching the prior behaviour.
   */
  loadFromFile(tracePath: string): void {
    const text = fs.readFileSync(tracePath, "utf-8").replace(/\r/g, "");
    this.loadFromText(text, path.basename(tracePath));
  }

  /**
   * Load a trace from already-read text. Separate entry point so tests
   * don't need a filesystem round-trip.
   */
  loadFromText(text: string, nameHint: string | null = null): void {
    const cmds: ReplayCommand[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^<\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+\S+:\s+(.+)$/);
      if (match) cmds.push({ time: match[1], raw: match[2].trim() });
    }
    this.commands = cmds;
    this.traceName = nameHint;
    this.currentIndex = 0;
    this.cancelTimer();
  }

  /** Current status — what /replay/info returns. */
  getInfo(): ReplayInfo {
    return {
      loaded: this.commands.length > 0,
      total: this.commands.length,
      current: this.currentIndex,
      playing: this.timer !== null,
      speed: this.speedMs,
      traceName: this.traceName,
    };
  }

  /**
   * Advance one command. Returns either a step result or a `done` marker
   * when the cursor is past the last command.
   */
  step(): ReplayStepResult<R> | { done: true; index: number; total: number } {
    if (this.currentIndex >= this.commands.length) {
      return { done: true, index: this.currentIndex, total: this.commands.length };
    }
    const cmd = this.commands[this.currentIndex];
    this.deps.flushPending();
    const result = this.deps.sendCommand(cmd.raw);
    this.currentIndex++;
    const step: ReplayStepResult<R> = {
      index: this.currentIndex,
      total: this.commands.length,
      result,
    };
    this.listeners.onStep?.({ ...step, raw: cmd.raw });
    return step;
  }

  /**
   * Start continuous playback. If already playing, cancels the current
   * timer and restarts (so the speed update takes effect immediately).
   */
  play(speedMs?: number): void {
    if (speedMs !== undefined) this.setSpeed(speedMs);
    this.cancelTimer();
    this.scheduleNextStep();
  }

  /** Pause playback without resetting the cursor. Safe to call idempotently. */
  pause(): void {
    this.cancelTimer();
  }

  /**
   * Reset: stop playback, rewind the cursor, reset-and-init the twin, and
   * fire onReset so listeners can broadcast the state change.
   */
  reset(): void {
    this.cancelTimer();
    this.currentIndex = 0;
    this.deps.resetAndInit();
    this.listeners.onReset?.();
  }

  /** Update the playback speed (ms between commands). Clamped to [10, 2000]. */
  setSpeed(speedMs: number): number {
    this.speedMs = Math.max(SPEED_MIN_MS, Math.min(SPEED_MAX_MS, speedMs));
    return this.speedMs;
  }

  /** Is playback currently running? */
  isPlaying(): boolean {
    return this.timer !== null;
  }

  /** Clean up any outstanding timer — used by test teardown and shutdown. */
  dispose(): void {
    this.cancelTimer();
    this.listeners = {};
  }

  private scheduleNextStep(): void {
    const runStep = () => {
      if (this.currentIndex >= this.commands.length) {
        this.timer = null;
        this.listeners.onDone?.({ total: this.commands.length });
        return;
      }
      this.step();
      this.timer = setTimeout(runStep, this.speedMs);
    };
    runStep();
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
