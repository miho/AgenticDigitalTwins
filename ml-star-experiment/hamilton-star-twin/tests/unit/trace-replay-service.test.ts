/**
 * TraceReplayService tests (Step 3.1).
 *
 * The headline property: for any eventId N and any trace T,
 * `replay.jump(N); replay.step('forward')` should produce the same state
 * as `replay.jump(N+1)` directly. That's the invariant state replay hinges
 * on — without it, the UI scrubber and what-if fork would both give wrong
 * answers.
 *
 * Supporting tests:
 *   - Position bookkeeping (eventId, totalEvents, revision).
 *   - Seek by kind / severity / correlationId / commandContains.
 *   - Speed clamp, play/pause lifecycle with fake timers.
 *   - Loading from JSON string, from file.
 *   - getStateAt(N) = state after processing every command with id ≤ N.
 *
 * FAILURE INJECTION
 *   - If computeStateAt skips the re-execution step, jump(N).state will
 *     equal initialState for all N — the "state changes after aspirate"
 *     test fails.
 *   - If seek respects `fromEventId` but not `direction`, the "seek
 *     backward" test finds the wrong event.
 *   - If the service forgets to bump revision on jump, SSE clients that
 *     drop stale pushes (based on revision) lose updates.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TraceReplayService } = require("../../dist/services/trace-replay-service");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TraceRecorder } = require("../../dist/services/trace-recorder");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serializeTrace } = require("../../dist/twin/trace-format");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) throw new Error("Could not reach DigitalTwin through api.devices");
  return device.twin;
}

/**
 * Build a known trace by issuing a few commands against a fresh twin
 * while a recorder captures. Returns the trace plus the twin's wellXY
 * helper so tests can craft matching commands.
 */
function buildTrace(options: { snapshotEveryN?: number } = {}): any {
  const twin = createTestTwin();
  const internal = getInternalTwin(twin.api, twin.deviceId);
  const rec = new TraceRecorder(internal, {
    snapshotEveryNEvents: options.snapshotEveryN ?? 5,
    deviceName: "test",
  });
  rec.start();

  const tipPos = twin.wellXY("TIP001", 0, 0);
  twin.fillPlate("SMP001", 0, "Water", 2000);
  // Run a deterministic protocol: pickup → aspirate → dispense somewhere.
  twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04tp2264th2450td1`);
  const srcPos = twin.wellXY("SMP001", 0, 0);
  twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0zp01500th2450`);
  const dstPos = twin.wellXY("SMP001", 0, 5);  // different column
  twin.sendCommand(`C0DSid0102xp${dstPos.xp}yp${dstPos.yp}dv01000dm0tm255zp01500th2450`);
  // A handful more no-op queries to grow the timeline.
  for (let i = 0; i < 8; i++) twin.sendCommand(`C0RFid${200 + i}`);

  const trace = rec.stop();
  twin.destroy();
  return trace;
}

describe("TraceReplayService (Step 3.1)", () => {
  let trace: any;
  let rs: any;

  afterEach(() => {
    rs?.dispose();
    rs = null;
  });

  describe("loading", () => {
    it("load() sets position to 0 and records trace metadata", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace, "test-trace.twintrace.json");
      const info = rs.getInfo();
      expect(info.loaded).toBe(true);
      expect(info.eventId).toBe(0);
      expect(info.totalEvents).toBe(trace.timeline.length);
      expect(info.traceName).toBe("test-trace.twintrace.json");
      expect(info.metadata.commandCount).toBeGreaterThan(0);
    });

    it("loadFromJson round-trips serializeTrace output", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      const json = serializeTrace(trace);
      rs.loadFromJson(json, "roundtrip");
      expect(rs.getInfo().loaded).toBe(true);
      expect(rs.getInfo().totalEvents).toBe(trace.timeline.length);
    });

    it("getInfo before load returns loaded=false with zero totals", () => {
      rs = new TraceReplayService();
      const info = rs.getInfo();
      expect(info.loaded).toBe(false);
      expect(info.totalEvents).toBe(0);
      expect(info.metadata).toBeNull();
    });

    it("jump/step/seek before load throw", () => {
      rs = new TraceReplayService();
      expect(() => rs.jump(1)).toThrow(/no trace loaded/);
      expect(() => rs.step()).toThrow(/no trace loaded/);
      expect(() => rs.seek({})).toThrow(/no trace loaded/);
      expect(() => rs.getState()).toThrow(/no trace loaded/);
    });
  });

  describe("position bookkeeping", () => {
    it("jump clamps to [0, totalEvents]", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      expect(rs.jump(-5).eventId).toBe(0);
      expect(rs.jump(99999).eventId).toBe(trace.timeline.length);
    });

    it("step forward/backward advances by one", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      expect(rs.step("forward").eventId).toBe(1);
      expect(rs.step("forward").eventId).toBe(2);
      expect(rs.step("backward").eventId).toBe(1);
    });

    it("revision increments on each position change", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const r0 = rs.getPosition().revision;
      rs.jump(5);
      const r1 = rs.getPosition().revision;
      rs.step("forward");
      const r2 = rs.getPosition().revision;
      expect(r1).toBeGreaterThan(r0);
      expect(r2).toBeGreaterThan(r1);
    });

    it("currentEvent is null at position 0, present at N > 0", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      expect(rs.getPosition().currentEvent).toBeNull();
      rs.jump(3);
      // At position 3, currentEvent is the 3rd event (index 2) on the timeline.
      expect(rs.getPosition().currentEvent?.id).toBe(trace.timeline[2].id);
    });
  });

  describe("seek", () => {
    it("seek by kind finds the next matching event", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const pos = rs.seek({ kind: "command" });
      expect(pos.eventId).toBeGreaterThan(0);
      expect(pos.currentEvent?.kind).toBe("command");
    });

    it("seek backward finds the previous matching event", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      rs.jump(trace.timeline.length);
      const pos = rs.seek({ kind: "command", direction: "backward" });
      expect(pos.currentEvent?.kind).toBe("command");
    });

    it("seek by commandContains finds the right command", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const pos = rs.seek({ kind: "command", commandContains: "C0AS" });
      expect(pos.currentEvent?.kind).toBe("command");
      const raw = (pos.currentEvent as any).payload.rawCommand;
      expect(raw).toContain("C0AS");
    });

    it("seek with no match leaves position unchanged", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      rs.jump(3);
      const before = rs.getPosition().eventId;
      const after = rs.seek({ commandContains: "NEVER" }).eventId;
      expect(after).toBe(before);
    });
  });

  describe("state replay — the load-bearing invariant", () => {
    it("getStateAt(0) equals the trace's initialState", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const s = rs.getStateAt(0);
      expect(JSON.stringify(s)).toBe(JSON.stringify(trace.initialState));
    });

    it("getStateAt(last) matches the trace's finalState (observable subset)", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const last = trace.timeline.length;
      const s = rs.getStateAt(last);
      // Compare the observable, deterministic parts — timestamps and
      // ephemeral fields (e.g. scheduledEvents' remainingMs) naturally
      // diverge because re-execution happens on a fresh clock.
      expect(JSON.stringify(s.tracking.wellVolumes)).toBe(
        JSON.stringify(trace.finalState.tracking.wellVolumes),
      );
      expect(Object.keys(s.liquid.wellContents).sort()).toEqual(
        Object.keys(trace.finalState.liquid.wellContents).sort(),
      );
    });

    it("property: jump(N); step('forward') produces the same well-volume state as jump(N+1)", () => {
      // Small-scale property test: walk every N from 0 to total-1 and
      // verify consecutive stepping matches direct jumping.
      trace = buildTrace({ snapshotEveryN: 4 });
      rs = new TraceReplayService();
      rs.load(trace);
      const total = trace.timeline.length;
      for (let n = 0; n < total; n++) {
        rs.jump(n);
        const sA = rs.getState();
        const nextAfterStep = rs.step("forward");
        const sStep = rs.getState();
        rs.jump(n + 1);
        const sDirect = rs.getState();
        expect(nextAfterStep.eventId).toBe(n + 1);
        // Compare the deterministic, observable subset.
        expect(JSON.stringify(sStep.tracking.wellVolumes)).toBe(
          JSON.stringify(sDirect.tracking.wellVolumes),
        );
        expect(JSON.stringify(sStep.liquid.wellContents)).toBe(
          JSON.stringify(sDirect.liquid.wellContents),
        );
        // Also: starting state at n is deterministic across jumps.
        rs.jump(n);
        const sAgain = rs.getState();
        expect(JSON.stringify(sAgain.tracking.wellVolumes)).toBe(
          JSON.stringify(sA.tracking.wellVolumes),
        );
      }
    });

    it("well volume drops after an aspirate in the replay", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      // Find the aspirate's timeline INDEX (not its spine event id).
      const aspIdx = trace.timeline.findIndex((e: any) =>
        e.kind === "command" && (e.payload.rawCommand ?? "").startsWith("C0AS"),
      );
      expect(aspIdx).toBeGreaterThanOrEqual(0);

      const before = rs.getStateAt(aspIdx).tracking.wellVolumes;   // state before processing timeline[aspIdx]
      const after = rs.getStateAt(aspIdx + 1).tracking.wellVolumes; // state after
      const changedKeys = Object.keys(after).filter(
        (k) => (before[k] ?? 0) !== (after[k] ?? 0),
      );
      expect(changedKeys.length).toBeGreaterThan(0);
    });
  });

  describe("speed + play/pause lifecycle", () => {
    it("setSpeed clamps to [10, 2000]", () => {
      rs = new TraceReplayService();
      expect(rs.setSpeed(5)).toBe(10);
      expect(rs.setSpeed(99999)).toBe(2000);
      expect(rs.setSpeed(500)).toBe(500);
    });

    it("play advances using fake timers; pause stops it", () => {
      vi.useFakeTimers();
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      rs.play(100);
      // First step is synchronous (inside play); subsequent ones time-gated.
      expect(rs.getPosition().eventId).toBeGreaterThanOrEqual(1);
      vi.advanceTimersByTime(500);
      expect(rs.getPosition().eventId).toBeGreaterThanOrEqual(4);
      const midEvent = rs.getPosition().eventId;
      rs.pause();
      vi.advanceTimersByTime(1000);
      expect(rs.getPosition().eventId).toBe(midEvent);
      rs.dispose();
      vi.useRealTimers();
    });

    it("onDone fires when play walks past the end", () => {
      vi.useFakeTimers();
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      rs.jump(trace.timeline.length - 1);

      const doneEvents: any[] = [];
      rs.setListeners({ onDone: (d: any) => doneEvents.push(d) });

      rs.play(50);
      vi.advanceTimersByTime(500);
      expect(doneEvents.length).toBeGreaterThan(0);
      expect(doneEvents[0].total).toBe(trace.timeline.length);
      rs.dispose();
      vi.useRealTimers();
    });
  });

  describe("event access", () => {
    it("getEventsInRange returns the half-open slice by index", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const slice = rs.getEventsInRange(2, 5);
      expect(slice.length).toBe(3);
      expect(slice[0]).toBe(trace.timeline[2]);
      expect(slice[2]).toBe(trace.timeline[4]);
    });

    it("getEvent returns the event at a 1-based position, or null", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const first = rs.getEvent(1);
      expect(first).toBe(trace.timeline[0]);
      const last = rs.getEvent(trace.timeline.length);
      expect(last).toBe(trace.timeline[trace.timeline.length - 1]);
      expect(rs.getEvent(999_999)).toBeNull();
      expect(rs.getEvent(0)).toBeNull();  // 1-based
    });
  });

  describe("listeners", () => {
    it("onPositionChanged fires on load + jump + step", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      const events: any[] = [];
      rs.setListeners({ onPositionChanged: (p: any) => events.push(p.eventId) });
      rs.load(trace);
      rs.jump(4);
      rs.step("forward");
      rs.step("backward");
      expect(events).toEqual([0, 4, 5, 4]);
    });
  });

  describe("what-if forks (Step 3.2)", () => {
    it("fork returns a handle with branchedAtIndex", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const handle = rs.fork(5);
      expect(handle.forkId).toMatch(/^fork_/);
      expect(handle.branchedAtIndex).toBe(5);
      expect(rs.listForks()).toHaveLength(1);
    });

    it("fork clamps the branch index to [0, totalEvents]", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      expect(rs.fork(-5).branchedAtIndex).toBe(0);
      expect(rs.fork(99999).branchedAtIndex).toBe(trace.timeline.length);
    });

    it("forkCommand executes on the fork; original trace unaffected", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      // Fork right after all the setup so the fork starts with tips fitted
      // and SMP001 well A1 holding liquid (same as original at that point).
      const handle = rs.fork(trace.timeline.length);

      const originalStateBefore = rs.getStateAt(trace.timeline.length);
      const result = rs.forkCommand(handle.forkId, "C0RFid1111");
      expect(result.accepted).toBe(true);

      // Original trace re-materialized should be unchanged.
      const originalStateAfter = rs.getStateAt(trace.timeline.length);
      expect(JSON.stringify(originalStateAfter.tracking.wellVolumes)).toBe(
        JSON.stringify(originalStateBefore.tracking.wellVolumes),
      );
    });

    it("diffFork on a fresh fork shows no differences", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const handle = rs.fork(5);
      const diff = rs.diffFork(handle.forkId);
      expect(diff.forkId).toBe(handle.forkId);
      expect(diff.branchedAtIndex).toBe(5);
      expect(diff.wellVolumes).toEqual([]);
      expect(diff.moduleStates).toEqual([]);
      expect(diff.tipUsage.addedInFork).toEqual([]);
      expect(diff.tipUsage.removedInFork).toEqual([]);
      expect(diff.forkCommandCount).toBe(0);
    });

    it("diffFork after an aspirate on the fork shows the well-volume delta", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);

      // Fork after the initial aspirate but before the dispense in our
      // fixture; we want to deviate from the trace's path.
      const handle = rs.fork(trace.timeline.length);

      // Send an aspirate on the fork that isn't in the original trace.
      // Use a well that wasn't aspirated from in the trace.
      const twin = createTestTwin({ autoInit: false });
      const srcPos = twin.wellXY("SMP001", 0, 3);  // different column
      twin.destroy();
      rs.forkCommand(handle.forkId, `C0ASid7777xp${srcPos.xp}yp${srcPos.yp}av00500tm255lm0zp01500th2450`);

      const diff = rs.diffFork(handle.forkId);
      expect(diff.forkCommandCount).toBe(1);
      // Expect at least one well volume to differ — the aspirate was a
      // real operation on a plate that had liquid (from fillPlate in the
      // fixture).
      expect(diff.wellVolumes.length).toBeGreaterThan(0);
    });

    it("discardFork drops the fork; subsequent operations on it throw", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const handle = rs.fork(3);
      expect(rs.listForks()).toHaveLength(1);
      rs.discardFork(handle.forkId);
      expect(rs.listForks()).toHaveLength(0);
      expect(() => rs.forkCommand(handle.forkId, "C0RFid0000")).toThrow(/unknown fork/);
      expect(() => rs.diffFork(handle.forkId)).toThrow(/unknown fork/);
    });

    it("multiple forks are independent", () => {
      trace = buildTrace();
      rs = new TraceReplayService();
      rs.load(trace);
      const a = rs.fork(trace.timeline.length);
      const b = rs.fork(trace.timeline.length);
      rs.forkCommand(a.forkId, "C0RFid0001");
      rs.forkCommand(a.forkId, "C0RFid0002");
      rs.forkCommand(b.forkId, "C0RFid0003");
      expect(rs.diffFork(a.forkId).forkCommandCount).toBe(2);
      expect(rs.diffFork(b.forkId).forkCommandCount).toBe(1);
    });
  });
});
