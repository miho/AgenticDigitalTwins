/**
 * Smoke tests for the in-process test twin helper.
 *
 * These tests prove that `createTestTwin()` works: a unit test can
 * instantiate a twin, send commands, and query state without an HTTP server.
 *
 * FAILURE INJECTION
 * If DigitalTwinAPI.createDevice() or resetDevice() silently fails to reach
 * sys_ready, the "initAll reaches sys_ready" assertion here fires immediately.
 * If flushPendingEvents() stops flushing, initAll() throws.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("createTestTwin", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("creates a twin with a default deck and reaches sys_ready after initAll", () => {
    twin = createTestTwin();
    const state = twin.getState();
    expect(state.modules.master.states).toContain("sys_ready");
    expect(state.modules.master.variables.instrument_initialized).toBe(true);
  });

  it("exposes the default deck with expected carriers", () => {
    twin = createTestTwin();
    const deck = twin.getState().deck;
    const carrierIds = deck.carriers.map((c) => c.id).sort();
    // Default layout in createDefaultDeckLayout should include these.
    expect(carrierIds).toEqual(
      expect.arrayContaining(["TIP001", "SMP001", "DST001"])
    );
  });

  it("sendCommand executes synchronously and returns a CommandResult", () => {
    twin = createTestTwin();
    const pos = twin.wellXY("TIP001", 0, 0);
    const r = twin.sendCommand(`C0TPid0001xp${pos.xp}yp${pos.yp}tm255tt04`);
    expect(r.accepted).toBe(true);
    expect(r.errorCode).toBe(0);
    // Physical outcome: 8 tips fitted in PIP
    const pip = twin.getModuleVars("pip");
    expect(pip.tip_fitted).toEqual([
      true, true, true, true, true, true, true, true,
      false, false, false, false, false, false, false, false,
    ]);
  });

  it("fillPlate sets initial volumes tracked by the tracker", () => {
    twin = createTestTwin();
    expect(twin.fillPlate("SMP001", 0, "Water", 2000)).toBe(true);
    // Check every well in col 0 has 2000 (0.1uL = 200uL)
    const col0 = twin.getColumnVolumes("SMP001", 0, 0);
    expect(col0).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]);
  });

  it("aspirate decrements source volumes by exactly the aspirate amount (physical outcome)", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tip = twin.wellXY("TIP001", 0, 0);
    const src = twin.wellXY("SMP001", 0, 0);

    twin.sendCommand(`C0TPid0100xp${tip.xp}yp${tip.yp}tm255tt04`);
    const volBefore = twin.getColumnVolumes("SMP001", 0, 0);

    const r = twin.sendCommand(`C0ASid0101xp${src.xp}yp${src.yp}av01000tm255lm0`);
    expect(r.accepted).toBe(true);
    expect(r.errorCode).toBe(0);

    const volAfter = twin.getColumnVolumes("SMP001", 0, 0);
    // 8 channels aspirated 1000 (0.1uL = 100uL) from col 0 rows A-H
    for (let row = 0; row < 8; row++) {
      expect(volAfter[row]).toBe(volBefore[row] - 1000);
    }
  });

  it("reset() clears tracker state and initAll() re-reaches sys_ready", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    expect(twin.getWellVolume("SMP001", 0, 0)).toBe(2000);

    twin.reset();
    // After reset, wells have no tracked volume until re-filled.
    expect(twin.getWellVolume("SMP001", 0, 0)).toBe(0);

    twin.initAll();
    expect(twin.getModuleStates("master")).toContain("sys_ready");
  });

  it("destroy() removes the device from the API", () => {
    twin = createTestTwin();
    const id = twin.deviceId;
    expect(twin.api.listDevices().map((d) => d.id)).toContain(id);
    twin.destroy();
    expect(twin.api.listDevices().map((d) => d.id)).not.toContain(id);
    twin = null; // prevent afterEach double-destroy
  });

  it("each createTestTwin() returns an isolated twin (no shared state)", () => {
    const a = createTestTwin();
    const b = createTestTwin();
    try {
      a.fillPlate("SMP001", 0, "Water", 2000);
      expect(a.getWellVolume("SMP001", 0, 0)).toBe(2000);
      expect(b.getWellVolume("SMP001", 0, 0)).toBe(0);
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
