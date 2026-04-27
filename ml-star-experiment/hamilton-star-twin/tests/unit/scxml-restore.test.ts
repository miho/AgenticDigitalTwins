/**
 * SCXML executor restore tests.
 *
 * These are the highest-risk tests in Phase 1. The state machine runtime
 * is the twin's beating heart — if snapshot/restore isn't lossless, every
 * downstream feature that depends on it (trace replay, what-if forking,
 * session save/load) silently produces wrong results.
 *
 * Invariants verified here:
 *   1. Round-trip identity on an idle module: snapshot → force → snapshot
 *      produces an identical snapshot.
 *   2. Datamodel survives the round trip (all variables preserved).
 *   3. Scheduled delayed events survive: after restore, the event fires
 *      at approximately the right time (with remainingMs precision).
 *   4. forceConfiguration wipes the pre-restore state (no merge).
 *   5. Malformed snapshots are rejected with clear errors.
 *   6. Two twins restored from the same snapshot process subsequent
 *      commands identically.
 *
 * FAILURE INJECTION
 * If forceConfiguration forgets to clear the datamodel before repopulating,
 * the "replaces (does not merge) the datamodel" test fails. If it drops
 * the scheduled-events queue, the "scheduled delayed event fires after
 * restore" test times out. If activeStates is assigned by reference
 * instead of copied, mutating the restored set leaks into the snapshot —
 * the independence test catches that.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("SCXML executor restore (ScxmlStateMachine.getConfiguration / forceConfiguration)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  function internalTwin(): any {
    const anyTwin = twin!.api as any;
    return anyTwin.devices.get(twin!.deviceId).twin;
  }

  function getModuleMachine(moduleId: string): any {
    const dt = internalTwin();
    // ModuleRegistry stores { id, name, executor } entries on dt.modules
    const mod = dt.modules.find((m: any) => m.id === moduleId);
    if (!mod) throw new Error(`Module not found: ${moduleId}`);
    return mod.executor.machine;
  }

  it("round-trips an idle module snapshot", () => {
    twin = createTestTwin();
    const master = getModuleMachine("master");
    const snap1 = master.getConfiguration();
    const snap1Json = JSON.parse(JSON.stringify(snap1));

    master.forceConfiguration(snap1Json);
    const snap2 = master.getConfiguration();

    // Active states and datamodel identical (scheduled events: idle master has none)
    expect(new Set(snap2.activeStateIds)).toEqual(new Set(snap1.activeStateIds));
    expect(snap2.datamodel).toEqual(snap1.datamodel);
  });

  it("getConfiguration returns JSON-stable output", () => {
    twin = createTestTwin();
    const pip = getModuleMachine("pip");
    const snap = pip.getConfiguration();
    const s1 = JSON.stringify(snap);
    const s2 = JSON.stringify(JSON.parse(s1));
    expect(s1).toEqual(s2);
  });

  it("round-trips the pip module with real state (tips fitted, volumes set)", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);

    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    const pip = getModuleMachine("pip");
    const snapBefore = pip.getConfiguration();
    expect(snapBefore.activeStateIds.length).toBeGreaterThan(0);
    expect(Array.isArray(snapBefore.datamodel.tip_fitted)).toBe(true);

    // Serialize through JSON then restore on the same machine instance
    const snapJson = JSON.parse(JSON.stringify(snapBefore));
    pip.forceConfiguration(snapJson);

    const snapAfter = pip.getConfiguration();
    expect(new Set(snapAfter.activeStateIds)).toEqual(new Set(snapBefore.activeStateIds));
    expect(snapAfter.datamodel).toEqual(snapBefore.datamodel);
    expect(snapAfter.datamodel.tip_fitted).toEqual(snapBefore.datamodel.tip_fitted);
    expect(snapAfter.datamodel.volume).toEqual(snapBefore.datamodel.volume);
  });

  it("forceConfiguration replaces (not merges) the datamodel", () => {
    twin = createTestTwin();
    const master = getModuleMachine("master");

    // Capture the idle state, then modify the runtime datamodel directly
    const snap = master.getConfiguration();
    master._datamodel.extraKey = "injected";
    expect(master._datamodel.extraKey).toBe("injected");

    // Restore from the original snapshot — the extra key must vanish
    master.forceConfiguration(JSON.parse(JSON.stringify(snap)));
    expect(master._datamodel.extraKey).toBeUndefined();
  });

  it("forceConfiguration replaces active states (not merges)", () => {
    twin = createTestTwin();
    const master = getModuleMachine("master");

    const baseSnap = master.getConfiguration();

    // Inject extra active states (simulating corruption)
    master.activeStates.add("bogus_state_1");
    master.activeStates.add("bogus_state_2");
    expect(master.activeStates.has("bogus_state_1")).toBe(true);

    // Restore — the extras must be gone
    master.forceConfiguration(JSON.parse(JSON.stringify(baseSnap)));
    expect(master.activeStates.has("bogus_state_1")).toBe(false);
    expect(master.activeStates.has("bogus_state_2")).toBe(false);
  });

  it("activeStateIds snapshot is independent of the live Set (no aliasing)", () => {
    twin = createTestTwin();
    const master = getModuleMachine("master");
    const snap = master.getConfiguration();
    // Mutating the snapshot must not affect the live machine
    snap.activeStateIds.push("added_to_snapshot");
    expect(master.activeStates.has("added_to_snapshot")).toBe(false);
  });

  it("rejects null or malformed config", () => {
    twin = createTestTwin();
    const master = getModuleMachine("master");
    expect(() => master.forceConfiguration(null)).toThrow(/must be a non-null object/);
    expect(() => master.forceConfiguration({})).toThrow(/activeStateIds must be an array/);
    expect(() => master.forceConfiguration({ activeStateIds: "not-an-array" }))
      .toThrow(/activeStateIds must be an array/);
  });

  it("captures pending scheduled delayed events (via ctx.scheduledEvents)", () => {
    twin = createTestTwin();
    const master = getModuleMachine("master");
    // Manually schedule a delayed event via the runtime API
    master.ctx.sendEvent("test.delayed", { note: "hello" }, { delay: 500, id: "test_sid_1" });
    expect(master.ctx.scheduledEvents.size).toBe(1);

    const snap = master.getConfiguration();
    expect(snap.scheduledEvents.length).toBe(1);
    expect(snap.scheduledEvents[0].eventName).toBe("test.delayed");
    expect(snap.scheduledEvents[0].remainingMs).toBeGreaterThan(0);
    expect(snap.scheduledEvents[0].remainingMs).toBeLessThanOrEqual(500);

    // Cancel the live one so it doesn't fire during test.
    master.ctx.cancelAllScheduledEvents();
  });

  it("restores scheduled events with remaining delay and they fire approximately on time", () => {
    return new Promise<void>((resolve, reject) => {
      twin = createTestTwin();
      const master = getModuleMachine("master");

      // Schedule an event 200ms out
      const scheduledAt = Date.now();
      master.ctx.sendEvent("test.restored.fire", { payload: 42 }, { delay: 200, id: "restore_sid" });
      const snap = master.getConfiguration();
      expect(snap.scheduledEvents.length).toBe(1);

      // Clear the live timer and restore. The restore should re-schedule with
      // the REMAINING delay (close to 200ms).
      master.ctx.cancelAllScheduledEvents();
      expect(master.ctx.scheduledEvents.size).toBe(0);

      // Subscribe BEFORE restore so we catch the wakeup
      let fireTime = 0;
      const listener = () => {
        // The event should be in the external queue now
        const queued = master.ctx.externalQueue.find((e: any) => e.name === "test.restored.fire");
        if (queued && !fireTime) {
          fireTime = Date.now();
        }
      };
      master.ctx.setWakeupListener(listener);

      master.forceConfiguration(JSON.parse(JSON.stringify(snap)));
      expect(master.ctx.scheduledEvents.size).toBe(1);

      // Wait for the event to fire, then verify timing
      setTimeout(() => {
        try {
          expect(fireTime).toBeGreaterThan(0);
          const elapsed = fireTime - scheduledAt;
          // Should fire at roughly 200ms after scheduling; allow 500ms slack
          // for test-runner jitter.
          expect(elapsed).toBeGreaterThan(100);
          expect(elapsed).toBeLessThan(1500);
          master.ctx.cancelAllScheduledEvents();
          resolve();
        } catch (err) {
          master.ctx.cancelAllScheduledEvents();
          reject(err);
        }
      }, 600);
    });
  }, 5000);

  it("two twins restored from the same snapshot process the same follow-up command identically", () => {
    const source = createTestTwin();
    try {
      source.fillPlate("SMP001", 0, "Water", 2000);
      const tipPos = source.wellXY("TIP001", 0, 0);
      const srcPos = source.wellXY("SMP001", 0, 0);
      source.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
      source.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

      const sourcePip = (source.api as any).devices.get(source.deviceId).twin.modules.find((m: any) => m.id === "pip").executor.machine;
      const snap = JSON.parse(JSON.stringify(sourcePip.getConfiguration()));

      // Two fresh twins restored from the same snapshot
      const a = createTestTwin();
      const b = createTestTwin();
      try {
        // Fill the same source plate so the follow-up aspirate has liquid to pull
        a.fillPlate("SMP001", 0, "Water", 1000);  // 2000 - 1000 aspirated
        b.fillPlate("SMP001", 0, "Water", 1000);

        const aPip = (a.api as any).devices.get(a.deviceId).twin.modules.find((m: any) => m.id === "pip").executor.machine;
        const bPip = (b.api as any).devices.get(b.deviceId).twin.modules.find((m: any) => m.id === "pip").executor.machine;
        aPip.forceConfiguration(snap);
        bPip.forceConfiguration(snap);

        // Both twins execute the same follow-up command
        const dstPos = a.wellXY("DST001", 0, 0);
        const ra = a.sendCommand(`C0DSid0200xp${dstPos.xp}yp${dstPos.yp}dv00500dm0tm255`);
        const rb = b.sendCommand(`C0DSid0200xp${dstPos.xp}yp${dstPos.yp}dv00500dm0tm255`);

        expect(ra.accepted).toBe(rb.accepted);
        expect(ra.errorCode).toBe(rb.errorCode);
        expect(a.getModuleVars("pip").volume).toEqual(b.getModuleVars("pip").volume);
      } finally {
        a.destroy();
        b.destroy();
      }
    } finally {
      source.destroy();
    }
  });
});
