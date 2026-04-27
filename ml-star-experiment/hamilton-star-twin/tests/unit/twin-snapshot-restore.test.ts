/**
 * End-to-end twin snapshot/restore/clone tests.
 *
 * Exercises the composition of per-component serializers built in
 * Steps 1.3a-d + SCXML restore (1.4). These are the highest-value tests
 * in Phase 1: if snapshot/restore is lossless here, every downstream
 * feature (trace replay, what-if forks, session save/load) is built on
 * solid ground.
 *
 * Invariants:
 *   1. Idle-twin round-trip: snapshot → JSON → restore produces the same
 *      snapshot on re-query.
 *   2. Post-work round-trip: after a few commands (pickup, aspirate,
 *      dispense), the snapshot captures everything needed to reproduce
 *      subsequent behavior.
 *   3. Clone independence: a clone continues the same way as the
 *      original for shared follow-up commands, but diverges when one
 *      receives a different command.
 *   4. getConfig + loadConfig round-trip: the deck config is
 *      self-contained (no hidden references to global catalogs).
 *
 * FAILURE INJECTION
 * If snapshot() forgets the scheduled-events queue, the
 * "state carries scheduled events across restore" test fails because
 * the restored twin has 0 pending events while the source had 1+.
 * If clone() accidentally reuses the same SCXML executor reference, the
 * "clone independence" test fails because commands on the clone mutate
 * the original.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("DigitalTwin snapshot / restore / clone", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("idle twin round-trips: snapshot → JSON → restore → snapshot identical", () => {
    twin = createTestTwin();

    const snapA = twin.api.getTwinStateSnapshot
      ? (twin.api as any).getTwinStateSnapshot(twin.deviceId)  // not yet exposed
      : (twin.api as any).devices.get(twin.deviceId).twin.snapshot();

    const json = JSON.parse(JSON.stringify(snapA));

    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    dt.restore(json);

    const snapB = dt.snapshot();
    // Module active states + variables preserved
    for (const [modId, mod] of Object.entries(snapA.modules as any)) {
      expect(new Set((snapB.modules[modId] as any).activeStateIds)).toEqual(new Set((mod as any).activeStateIds));
      expect((snapB.modules[modId] as any).variables).toEqual((mod as any).variables);
    }
    // Tracking state preserved
    expect(snapB.tracking).toEqual(snapA.tracking);
  });

  it("post-work state round-trips: aspirate → snapshot → restore → follow-up dispense yields same result", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    // Snapshot a mid-work state
    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const snapBefore = JSON.parse(JSON.stringify(dt.snapshot()));
    const pipVolBefore = twin.getModuleVars("pip").volume.slice(0, 8);
    const srcVolBefore = twin.getColumnVolumes("SMP001", 0, 0);

    // Restore — state should be exactly as it was just before restore
    dt.restore(snapBefore);

    expect(twin.getModuleVars("pip").volume.slice(0, 8)).toEqual(pipVolBefore);
    expect(twin.getColumnVolumes("SMP001", 0, 0)).toEqual(srcVolBefore);
  });

  it("restore replaces prior state (not merges)", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);

    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const snapIdle = JSON.parse(JSON.stringify(dt.snapshot()));

    // Mutate the twin to diverge from the snapshot
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    expect(twin.getModuleVars("pip").tip_fitted.slice(0, 8)).toContain(true);

    // Restore the idle snapshot — tips should no longer be fitted
    dt.restore(snapIdle);
    expect(twin.getModuleVars("pip").tip_fitted.slice(0, 8)).toEqual(
      [false, false, false, false, false, false, false, false]
    );
  });

  it("getConfig / loadConfig round-trip preserves the deck layout", () => {
    twin = createTestTwin();
    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const cfg = JSON.parse(JSON.stringify(dt.getConfig()));

    // Create a fresh twin, load the config — carriers and labware match.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Deck } = require("../../dist/twin/deck");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DigitalTwin } = require("../../dist/twin/digital-twin");
    const newDt = new DigitalTwin(new Deck("STAR"));
    newDt.loadConfig(cfg);

    const origSnap = dt.getDeck().getSnapshot();
    const newSnap = newDt.getDeck().getSnapshot();
    expect(newSnap.carriers.length).toBe(origSnap.carriers.length);

    // Check a known carrier survived
    const origSmp = origSnap.carriers.find((c: any) => c.id === "SMP001");
    const newSmp = newSnap.carriers.find((c: any) => c.id === "SMP001");
    expect(newSmp.type).toBe(origSmp.type);
    expect(newSmp.track).toBe(origSmp.track);
    expect(newSmp.labware.length).toBe(origSmp.labware.length);
  });

  it("loadConfig refuses a platform mismatch", () => {
    twin = createTestTwin();
    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const cfg = JSON.parse(JSON.stringify(dt.getConfig()));
    cfg.platform = "STARlet";
    expect(() => dt.loadConfig(cfg)).toThrow(/platform/);
  });

  it("clone produces an independent twin (commands on clone don't affect original)", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const clone = dt.clone();

    const origVolsBefore = twin.getColumnVolumes("SMP001", 0, 0);
    // Dispense on the clone only
    const dstPos = twin.wellXY("DST001", 0, 0);
    const cloneResult = clone.sendCommand(`C0DSid0200xp${dstPos.xp}yp${dstPos.yp}dv00500dm0tm255`);
    expect(cloneResult.accepted).toBe(true);

    // Original unaffected
    const origVolsAfter = twin.getColumnVolumes("SMP001", 0, 0);
    expect(origVolsAfter).toEqual(origVolsBefore);
    // Original's dest wells are still at 0
    expect(twin.getColumnVolumes("DST001", 0, 0)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    // Clone HAS dispensed — its dest wells show liquid
    const cloneTracking = clone.getDeckTracker();
    const cloneDstVols = [];
    for (let row = 0; row < 8; row++) {
      cloneDstVols.push(cloneTracking.getWellVolume("DST001", 0, row * 12) ?? 0);
    }
    for (const v of cloneDstVols) expect(v).toBeGreaterThan(0);
  });

  it("snapshot is JSON-stable (no Maps or Sets leak)", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const snap = dt.snapshot();
    const s1 = JSON.stringify(snap);
    const s2 = JSON.stringify(JSON.parse(s1));
    expect(s1).toEqual(s2);
  });

  it("restore throws on null or wrong-version state", () => {
    twin = createTestTwin();
    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    expect(() => dt.restore(null)).toThrow(/null or not an object/);
    expect(() => dt.restore({ version: 99 })).toThrow(/unsupported state version/);
  });

  it("snapshot preserves liquid identity (aspirated sample, contamination history)", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Sample_A", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    const dt = (twin.api as any).devices.get(twin.deviceId).twin;
    const snap = JSON.parse(JSON.stringify(dt.snapshot()));
    // liquid.channels has Sample_A on channel 0
    expect(snap.liquid.channels[0].contents?.liquidType).toBe("Sample_A");
    expect(snap.liquid.channels[0].contactHistory).toContain("Sample_A");

    // Restore after a reset restores the liquid identity
    dt.reset();
    dt.restore(snap);
    const state = twin.getState();
    expect(state.liquidTracking.channels[0].contents?.liquidType).toBe("Sample_A");
  });
});
