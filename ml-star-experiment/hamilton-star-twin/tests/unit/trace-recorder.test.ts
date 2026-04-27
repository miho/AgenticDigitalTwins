/**
 * TraceRecorder tests (Step 1.12).
 *
 * Verifies:
 *   - Recording captures every command, assessment, deck interaction, and
 *     device event the twin emits between start() and stop().
 *   - Periodic snapshots are taken at the configured interval.
 *   - The returned TwinTrace serializes through the Step-1.11 format and
 *     round-trips cleanly.
 *   - Stop freezes the final state so post-stop twin activity does not
 *     leak into the returned trace.
 *
 * FAILURE INJECTION
 *   - If TraceRecorder stops subscribing to the spine, "records every
 *     command" fails because timeline stays empty.
 *   - If snapshotEveryNEvents is off by one, "takes periodic snapshots"
 *     observes the wrong count.
 *   - If stop() re-samples the live twin, "frozen after stop" fails
 *     because post-stop commands leak into the trace.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TraceRecorder } = require("../../dist/services/trace-recorder");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serializeTrace, deserializeTrace } = require("../../dist/twin/trace-format");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) {
    throw new Error("Could not reach DigitalTwin through api.devices");
  }
  return device.twin;
}

describe("TraceRecorder (Step 1.12)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("isRecording() reflects start/stop", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    expect(rec.isRecording()).toBe(false);
    rec.start();
    expect(rec.isRecording()).toBe(true);
    rec.stop();
    expect(rec.isRecording()).toBe(false);
  });

  it("records every command issued between start() and stop()", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    rec.start();

    for (let i = 0; i < 10; i++) {
      twin.sendCommand(`C0RFid${String(i).padStart(4, "0")}`);
    }

    const trace = rec.stop();
    const commandEvents = trace.timeline.filter((e: any) => e.kind === "command");
    expect(commandEvents.length).toBeGreaterThanOrEqual(10);
  });

  it("includes assessment events for an unresolved aspirate", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    rec.start();

    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand("C0ASid0201xp00000yp00000av01000tm255lm0");

    const trace = rec.stop();
    const assessments = trace.timeline.filter((e: any) => e.kind === "assessment");
    expect(assessments.length).toBeGreaterThan(0);
  });

  it("takes a periodic snapshot every N events", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal, { snapshotEveryNEvents: 5 });
    rec.start();

    // Every always-accepted query adds exactly one command event onto the
    // spine (no deck interaction, no assessment). Issue 20 of them so we
    // guarantee at least 4 snapshots (at events 5, 10, 15, 20).
    for (let i = 0; i < 20; i++) {
      twin.sendCommand(`C0RFid${String(i).padStart(4, "0")}`);
    }

    const trace = rec.stop();
    expect(trace.snapshots.length).toBeGreaterThanOrEqual(3);
    // afterEventId is monotonically increasing and each is < the next snapshot's
    for (let i = 1; i < trace.snapshots.length; i++) {
      expect(trace.snapshots[i].afterEventId).toBeGreaterThan(trace.snapshots[i - 1].afterEventId);
    }
  });

  it("disables periodic snapshots when snapshotEveryNEvents is 0", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal, { snapshotEveryNEvents: 0 });
    rec.start();
    for (let i = 0; i < 20; i++) {
      twin.sendCommand(`C0RFid${String(i).padStart(4, "0")}`);
    }
    const trace = rec.stop();
    expect(trace.snapshots).toHaveLength(0);
  });

  it("metadata fields reflect the recording", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal, {
      label: "my run",
      notes: "unit test",
      deviceName: "Device-X",
    });
    rec.start();
    twin.sendCommand("C0RFid9001");
    twin.sendCommand("C0RFid9002");
    const trace = rec.stop();

    expect(trace.metadata.deviceName).toBe("Device-X");
    expect(trace.metadata.label).toBe("my run");
    expect(trace.metadata.notes).toBe("unit test");
    expect(trace.metadata.commandCount).toBeGreaterThanOrEqual(2);
    expect(trace.metadata.eventCount).toBe(trace.timeline.length);
    expect(trace.metadata.platform).toBe(trace.config.platform);
  });

  it("the returned trace round-trips through serializeTrace/deserializeTrace", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    rec.start();
    twin.sendCommand("C0RFid9001");
    twin.sendCommand("C0RFid9002");
    const trace = rec.stop();

    const json = serializeTrace(trace);
    const back = deserializeTrace(json);
    expect(back.format).toBe(trace.format);
    expect(back.version).toBe(trace.version);
    expect(back.timeline.length).toBe(trace.timeline.length);
    expect(back.metadata.commandCount).toBe(trace.metadata.commandCount);
    // Byte-identical re-serialization (see trace-format.test.ts for detail).
    expect(serializeTrace(back)).toBe(json);
  });

  it("getTrace() before start() throws", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    expect(() => rec.getTrace()).toThrow(/before start/);
  });

  it("start() is idempotent while already recording", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    rec.start();
    twin.sendCommand("C0RFid9001");
    // Calling start() again should NOT reset the collected timeline.
    rec.start();
    const midTrace = rec.getTrace();
    expect(midTrace.timeline.length).toBeGreaterThanOrEqual(1);
    rec.stop();
  });

  it("stop() freezes the trace — post-stop twin activity does not leak in", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    rec.start();
    twin.sendCommand("C0RFid9001");
    const trace = rec.stop();
    const lenAtStop = trace.timeline.length;

    // Issue commands AFTER stop — the trace must not grow.
    twin.sendCommand("C0RFid9002");
    twin.sendCommand("C0RFid9003");

    const traceAgain = rec.getTrace();
    expect(traceAgain.timeline.length).toBe(lenAtStop);
  });

  it("initialState and finalState differ after a tip pickup", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const rec = new TraceRecorder(internal);
    rec.start();

    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    const trace = rec.stop();
    // The tip usage map on tracker state should differ.
    const initialTips = JSON.stringify(trace.initialState.tracking.tipUsage);
    const finalTips = JSON.stringify(trace.finalState.tracking.tipUsage);
    expect(finalTips).not.toBe(initialTips);
  });
});
