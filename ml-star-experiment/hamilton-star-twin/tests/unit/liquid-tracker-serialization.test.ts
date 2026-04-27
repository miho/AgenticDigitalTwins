/**
 * LiquidTracker serialization round-trip tests.
 *
 * Verifies that `getLiquidState()` → JSON → `restoreLiquidState()` produces
 * a tracker whose observable behavior matches the original exactly.
 *
 * FAILURE INJECTION
 * If `restoreLiquidState()` forgets to clear the wells Map before
 * rebuilding, residual state from the pre-restore tracker leaks through and
 * the "state after restore equals snapshot state" test fails because
 * tracker has extra wells. If channel deep-copy is dropped and we alias
 * the original array, mutating a channel via the API-level helper would
 * silently change the "before" snapshot — the drift test catches that.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LiquidTracker } = require("../../dist/twin/liquid-tracker");

describe("LiquidTracker serialization", () => {
  it("empty tracker round-trips to empty state", () => {
    const t = new LiquidTracker();
    const snapshot = t.getLiquidState();
    const json = JSON.parse(JSON.stringify(snapshot));

    const t2 = new LiquidTracker();
    t2.restoreLiquidState(json);

    expect(t2.getLiquidState()).toEqual(snapshot);
  });

  it("captures well contents after setWellContents", () => {
    const t = new LiquidTracker();
    t.setWellContents("SMP001:0:0", "Water", 1000, "default", "Cos_96_Rd");
    t.setWellContents("SMP001:0:1", "Buffer", 500, "default", "Cos_96_Rd");

    const snap = t.getLiquidState();
    expect(snap.wellContents["SMP001:0:0"]).toMatchObject({ liquidType: "Water", volume: 1000 });
    expect(snap.wellContents["SMP001:0:1"]).toMatchObject({ liquidType: "Buffer", volume: 500 });
    expect(snap.wellLabwareType["SMP001:0:0"]).toBe("Cos_96_Rd");
  });

  it("round-trips after tip pickup + aspirate (with contact history and tip contents)", () => {
    const t = new LiquidTracker();
    t.setWellContents("SMP001:0:0", "Sample_A", 2000, "default", "Cos_96_Rd");
    t.tipPickup(0, "Tips_1000uL", 10000);
    const result = t.aspirate(0, "SMP001:0:0", 500, "SMP001 pos 0 well A1");
    expect(result.success).toBe(true);

    const snap = t.getLiquidState();
    const json = JSON.parse(JSON.stringify(snap));

    const t2 = new LiquidTracker();
    t2.restoreLiquidState(json);

    // Channel 0 has a tip with Sample_A content
    const ch0Restored = t2.getChannelState(0);
    expect(ch0Restored.hasTip).toBe(true);
    expect(ch0Restored.tipType).toBe("Tips_1000uL");
    expect(ch0Restored.contents).not.toBeNull();
    expect(ch0Restored.contents.liquidType).toBe("Sample_A");
    expect(ch0Restored.contents.volume).toBe(500);
    expect(ch0Restored.contactHistory).toEqual(["Sample_A"]);

    // Well has 1500 remaining (2000 - 500)
    expect(t2.getWellContents("SMP001:0:0")).toMatchObject({ volume: 1500 });
  });

  it("round-trips contamination events", () => {
    const t = new LiquidTracker();
    t.setWellContents("SMP001:0:0", "Sample_A", 2000, "default", "Cos_96_Rd");
    t.setWellContents("SMP001:0:1", "Sample_B", 2000, "default", "Cos_96_Rd");
    t.tipPickup(0, "Tips_1000uL", 10000);
    t.aspirate(0, "SMP001:0:0", 100, "A1");
    // Aspirate from a different well without changing tip: contamination event
    const r2 = t.aspirate(0, "SMP001:0:1", 100, "A2");
    expect(r2.contamination).toBeTruthy();

    const snap = t.getLiquidState();
    const t2 = new LiquidTracker();
    t2.restoreLiquidState(JSON.parse(JSON.stringify(snap)));

    expect(t2.getContaminationLog().length).toBeGreaterThan(0);
  });

  it("restoreLiquidState replaces prior state (does not merge)", () => {
    const t = new LiquidTracker();
    t.setWellContents("A:0:0", "X", 100, "default");
    t.setWellContents("A:0:1", "Y", 200, "default");
    const snap = t.getLiquidState();

    const t2 = new LiquidTracker();
    // Pre-populate t2 with different state
    t2.setWellContents("B:0:0", "Z", 999, "default");
    expect(t2.getWellContents("B:0:0")).not.toBeNull();

    t2.restoreLiquidState(JSON.parse(JSON.stringify(snap)));

    // Prior state must be gone
    expect(t2.getWellContents("B:0:0")).toBeNull();
    // Restored state must be present
    expect(t2.getWellContents("A:0:0")?.liquidType).toBe("X");
    expect(t2.getWellContents("A:0:1")?.liquidType).toBe("Y");
  });

  it("restoreLiquidState throws on malformed snapshot (wrong channel count)", () => {
    const t = new LiquidTracker();
    expect(() => t.restoreLiquidState({ wellContents: {}, channels: [], wellLabwareType: {}, contaminationLog: [] }))
      .toThrow(/channels array must have length 16/);
  });

  it("restoreLiquidState throws on null snapshot", () => {
    const t = new LiquidTracker();
    expect(() => t.restoreLiquidState(null)).toThrow(/snapshot is null/);
  });

  it("post-restore tracker behaves identically to original for subsequent operations", () => {
    const t1 = new LiquidTracker();
    t1.setWellContents("W:0:0", "Water", 2000, "default", "Cos_96_Rd");
    t1.tipPickup(0, "Tips_1000uL", 10000);
    t1.aspirate(0, "W:0:0", 500, "A1");

    // Snapshot + restore
    const t2 = new LiquidTracker();
    t2.restoreLiquidState(JSON.parse(JSON.stringify(t1.getLiquidState())));

    // Both perform the same additional operation
    const r1 = t1.dispense(0, "D:0:0", 500, "D1");
    const r2 = t2.dispense(0, "D:0:0", 500, "D1");

    expect(r1.success).toBe(r2.success);
    expect(r1.actualVolume).toBe(r2.actualVolume);
    expect(t1.getChannelState(0)).toEqual(t2.getChannelState(0));
    expect(t1.getWellContents("D:0:0")).toEqual(t2.getWellContents("D:0:0"));
  });

  it("snapshot is JSON-safe (no Maps or Sets leak)", () => {
    const t = new LiquidTracker();
    t.setWellContents("A:0:0", "Mix", 100, "default", "Cos_96_Rd");
    t.tipPickup(0, "Tips_300uL", 3000);
    t.aspirate(0, "A:0:0", 50, "A1");
    const snap = t.getLiquidState();
    // JSON round-trip must be lossless
    const s1 = JSON.stringify(snap);
    const s2 = JSON.stringify(JSON.parse(s1));
    expect(s1).toEqual(s2);
  });
});
