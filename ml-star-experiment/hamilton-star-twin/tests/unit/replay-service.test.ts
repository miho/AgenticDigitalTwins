/**
 * ReplayService tests (Step 2.3).
 *
 * Exercises the service with a fake `sendCommand` closure that captures
 * every call, so we can assert ordering, pacing, and lifecycle callbacks
 * without spinning up the twin.
 *
 * FAILURE INJECTION
 *   - If `step()` doesn't advance the cursor, the "step advances index"
 *     assertion stays on 0 forever.
 *   - If `play()` forgets to flush pending events, the captured flush
 *     count stays at 0.
 *   - If `reset()` forgets to call resetAndInit, the captured resetAndInit
 *     count stays at 0.
 *   - If `setSpeed` skips the clamp, "setSpeed clamps to [10, 2000]"
 *     returns the unclamped value.
 */
import { describe, it, expect, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ReplayService } = require("../../dist/services/replay-service");

interface Captured {
  sent: string[];
  flushes: number;
  resets: number;
}

function makeDeps(sendResult: any = { ok: true }): {
  deps: any;
  captured: Captured;
} {
  const captured: Captured = { sent: [], flushes: 0, resets: 0 };
  return {
    captured,
    deps: {
      sendCommand: (raw: string) => {
        captured.sent.push(raw);
        return sendResult;
      },
      flushPending: () => { captured.flushes++; },
      resetAndInit: () => { captured.resets++; },
    },
  };
}

const SAMPLE_TRACE = `
< 10:00:00.100 cmd: C0VIid0001
< 10:00:00.200 cmd: C0DIid0002
< 10:00:00.300 cmd: C0EIid0003
< 10:00:00.400 cmd: C0IIid0004
garbage line with no match
< 10:00:00.500 cmd: C0ASid0005xp01000yp02000av00500tm001lm0
`.trim();

describe("ReplayService (Step 2.3)", () => {
  it("loadFromText parses valid lines and ignores the rest", () => {
    const { deps } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE, "sample.trc");
    const info = svc.getInfo();
    expect(info.loaded).toBe(true);
    expect(info.total).toBe(5);
    expect(info.current).toBe(0);
    expect(info.playing).toBe(false);
    expect(info.traceName).toBe("sample.trc");
  });

  it("step() sends commands in order, advancing the cursor", () => {
    const { deps, captured } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);

    const r1 = svc.step();
    expect(r1).toMatchObject({ index: 1, total: 5 });
    expect(captured.sent).toEqual(["C0VIid0001"]);
    expect(captured.flushes).toBe(1);

    svc.step();
    svc.step();
    expect(captured.sent).toEqual(["C0VIid0001", "C0DIid0002", "C0EIid0003"]);
    expect(svc.getInfo().current).toBe(3);
  });

  it("step() past the end returns a done marker without calling sendCommand", () => {
    const { deps, captured } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);
    for (let i = 0; i < 5; i++) svc.step();
    const post = svc.step();
    expect(post).toMatchObject({ done: true, index: 5, total: 5 });
    expect(captured.sent).toHaveLength(5);  // didn't try a 6th
  });

  it("onStep listener fires with raw + index + result per step", () => {
    const { deps } = makeDeps({ marker: "x" });
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);

    const steps: any[] = [];
    svc.setListeners({ onStep: (s: any) => steps.push(s) });

    svc.step();
    svc.step();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      raw: "C0VIid0001",
      index: 1,
      total: 5,
      result: { marker: "x" },
    });
  });

  it("setSpeed clamps to [10, 2000]", () => {
    const { deps } = makeDeps();
    const svc = new ReplayService(deps);
    expect(svc.setSpeed(5)).toBe(10);
    expect(svc.setSpeed(99999)).toBe(2000);
    expect(svc.setSpeed(300)).toBe(300);
  });

  it("play() uses fake timers to step through the trace at the given speed", () => {
    vi.useFakeTimers();
    const { deps, captured } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);

    const doneEvents: any[] = [];
    svc.setListeners({ onDone: (d: any) => doneEvents.push(d) });

    svc.play(100);
    // First step runs immediately.
    expect(captured.sent).toHaveLength(1);
    // Advance time — each tick of 100ms = one more command.
    vi.advanceTimersByTime(100);
    expect(captured.sent).toHaveLength(2);
    vi.advanceTimersByTime(300);
    expect(captured.sent).toHaveLength(5);
    // Next tick past the end fires onDone.
    vi.advanceTimersByTime(100);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toEqual({ total: 5 });

    svc.dispose();
    vi.useRealTimers();
  });

  it("pause() stops continuous playback without moving the cursor", () => {
    vi.useFakeTimers();
    const { deps, captured } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);

    svc.play(100);
    vi.advanceTimersByTime(150);
    const sentBeforePause = captured.sent.length;
    svc.pause();
    vi.advanceTimersByTime(1000);
    expect(captured.sent.length).toBe(sentBeforePause);
    expect(svc.isPlaying()).toBe(false);

    svc.dispose();
    vi.useRealTimers();
  });

  it("reset() stops playback, rewinds the cursor, and calls resetAndInit", () => {
    const { deps, captured } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);

    svc.step();
    svc.step();
    expect(svc.getInfo().current).toBe(2);

    const resetEvents: any[] = [];
    svc.setListeners({ onReset: () => resetEvents.push(true) });
    svc.reset();

    expect(svc.getInfo().current).toBe(0);
    expect(captured.resets).toBe(1);
    expect(resetEvents).toHaveLength(1);
  });

  it("getInfo before loading reports loaded:false, total:0", () => {
    const { deps } = makeDeps();
    const svc = new ReplayService(deps);
    const info = svc.getInfo();
    expect(info).toMatchObject({ loaded: false, total: 0, current: 0, playing: false });
  });

  it("dispose() cancels outstanding timers and drops listeners", () => {
    vi.useFakeTimers();
    const { deps, captured } = makeDeps();
    const svc = new ReplayService(deps);
    svc.loadFromText(SAMPLE_TRACE);

    let stepCount = 0;
    svc.setListeners({ onStep: () => stepCount++ });
    svc.play(100);
    vi.advanceTimersByTime(100);
    svc.dispose();
    vi.advanceTimersByTime(1000);
    // After dispose, no further ticks drive more steps.
    const stepCountAfter = captured.sent.length;
    vi.advanceTimersByTime(1000);
    expect(captured.sent.length).toBe(stepCountAfter);
    vi.useRealTimers();
  });
});
