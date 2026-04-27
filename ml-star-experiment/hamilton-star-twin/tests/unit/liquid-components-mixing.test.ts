/**
 * Liquid components-map invariants across fill / aspirate / dispense.
 *
 * These tests pin the fix for the compound-name bug — previously each aspirate
 * from a mixture stored the source's whole `liquidType` summary string as a
 * single key in the destination's components map, so after N transfers the
 * label grew like "Diluent + Diluent + Diluent + Sample". Now aspirate and
 * dispense split each transfer *per component* proportional to the source.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { LiquidTracker } from "../../src/twin/liquid-tracker";

describe("liquid components mixing", () => {
  let t: LiquidTracker;
  const KEY_SRC = "SMP001:0:0";
  const KEY_DST = "SMP001:0:1";
  const LW = "Cos_96_Rd";
  const CH = 0;

  beforeEach(() => {
    t = new LiquidTracker();
    t.tipPickup(CH, "Tips_1000uL", 10_000);  // 1000 µL tip
  });

  it("addLiquidToWell dedupes same-name fills", () => {
    t.addLiquidToWell(KEY_SRC, "Water", 500, "default", LW);
    t.addLiquidToWell(KEY_SRC, "Water", 300, "default", LW);
    const well = t.getWellContents(KEY_SRC)!;
    expect(well.volume).toBe(800);
    expect(well.liquidType).toBe("Water");
    expect([...(well.components ?? new Map())]).toEqual([["Water", 800]]);
  });

  it("addLiquidToWell produces a components map with distinct entries per liquid", () => {
    t.addLiquidToWell(KEY_SRC, "Water", 500, "default", LW);
    t.addLiquidToWell(KEY_SRC, "Sample", 100, "default", LW);
    const well = t.getWellContents(KEY_SRC)!;
    expect(well.volume).toBe(600);
    expect(well.components?.get("Water")).toBe(500);
    expect(well.components?.get("Sample")).toBe(100);
    expect(well.liquidType).toBe("Water + Sample");
  });

  it("aspirate-then-dispense from a mixture does NOT introduce a compound key", () => {
    // Source: 1500 µL Water + 500 µL Sample (enough above dead volume).
    t.addLiquidToWell(KEY_SRC, "Water",  15_000, "default", LW);
    t.addLiquidToWell(KEY_SRC, "Sample",  5_000, "default", LW);

    const asp = t.aspirate(CH, KEY_SRC, 1_000, "A1");
    expect(asp.success).toBe(true);
    expect(asp.actualVolume).toBe(1_000);

    // Dispense into an empty well.
    const disp = t.dispense(CH, KEY_DST, 1_000, "B1");
    expect(disp.success).toBe(true);

    const dst = t.getWellContents(KEY_DST)!;
    // The bug: old code stored "Water + Sample" as a single component key on
    // the destination. The fix: per-component transfer, so the destination
    // has two separate keys with the right proportion (1500:500 = 3:1).
    expect(dst.components?.size).toBe(2);
    expect(dst.components?.has("Water + Sample")).toBe(false);
    expect(dst.components?.get("Water")).toBeCloseTo(750, 1);
    expect(dst.components?.get("Sample")).toBeCloseTo(250, 1);
    expect(dst.liquidType).toBe("Water + Sample");
  });

  it("repeated transfers from the same mixture never grow the label", () => {
    // Source with mixture; transfer 50 µL into dst over and over. The label
    // must stay "Water + Sample", not "Water + Sample + Water + Sample + ...".
    t.addLiquidToWell(KEY_SRC, "Water",  1_000, "default", LW);
    t.addLiquidToWell(KEY_SRC, "Sample", 1_000, "default", LW);

    for (let i = 0; i < 5; i++) {
      t.aspirate(CH, KEY_SRC, 50, "src");
      t.dispense(CH, KEY_DST, 50, "dst");
    }

    const dst = t.getWellContents(KEY_DST)!;
    expect(dst.components?.size).toBe(2);
    expect(dst.liquidType.split(" + ").length).toBe(2);
    // Sum of component volumes should equal well.volume.
    let sum = 0;
    for (const v of dst.components!.values()) sum += v;
    expect(sum).toBeCloseTo(dst.volume, 1);
  });

  it("serial-dilution style chain preserves exactly 2 components per step", () => {
    // Set up the user's scenario: col 1 = Sample 100, col 2 = Diluent 100,
    // col 3 = Diluent 100, col 4 = Diluent 100. Simulate one-to-next transfers.
    const cols = ["SMP001:0:0", "SMP001:0:1", "SMP001:0:2", "SMP001:0:3"];
    t.addLiquidToWell(cols[0], "Sample",  1_000, "default", LW);
    t.addLiquidToWell(cols[1], "Diluent", 1_000, "default", LW);
    t.addLiquidToWell(cols[2], "Diluent", 1_000, "default", LW);
    t.addLiquidToWell(cols[3], "Diluent", 1_000, "default", LW);

    for (let i = 0; i < cols.length - 1; i++) {
      t.aspirate(CH, cols[i],     500, `src${i}`);
      t.dispense(CH, cols[i + 1], 500, `dst${i}`);
    }

    // Each destination beyond col 1 should have at most 2 liquids: Diluent
    // and Sample. No compound keys like "Diluent + Sample" or
    // "Diluent + Diluent + Sample" stored as a single entry.
    for (const c of cols.slice(1)) {
      const w = t.getWellContents(c)!;
      const keys = [...(w.components?.keys() ?? [])];
      expect(keys.every(k => !k.includes("+"))).toBe(true);
      expect(keys.length).toBeLessThanOrEqual(2);
    }
  });
});
