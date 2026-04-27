/**
 * Physical volume model — tip tracks liquid + trailing air, dispense pops air
 * first, FW plunger always moves the full requested volume.
 *
 * The real ML STAR's positive-displacement plunger moves a fixed amount of
 * *something* per command. If the source runs dry mid-stroke, the remainder
 * enters as air through the tip opening. That air ends up at the bottom of
 * the tip (nearest the opening), so it's the first thing dispensed on the
 * next C0DS — and only what actually reaches the destination well is liquid.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { LiquidTracker } from "../../src/twin/liquid-tracker";

describe("physical volume model: tip liquid + air", () => {
  let t: LiquidTracker;
  const SRC = "SMP001:0:0";
  const DST = "SMP001:0:1";
  const LW = "Cos_96_Rd";
  const CH = 0;

  beforeEach(() => {
    t = new LiquidTracker();
    t.tipPickup(CH, "Tips_1000uL", 10_000);
  });

  // Cos_96_Rd dead volume is 200 (0.1 µL) = 20 µL. Source has 600 (60 µL),
  // so 400 (40 µL) is available above dead volume. Asp 1000 (100 µL) → tip
  // gets 400 liquid + 600 air.
  it("aspirate under a dry source pulls air for the remainder", () => {
    t.addLiquidToWell(SRC, "Sample", 600, "default", LW);
    const asp = t.aspirate(CH, SRC, 1_000, "A1");
    expect(asp.actualVolume).toBe(1_000);
    expect(asp.liquidActual).toBe(400);
    expect(asp.airActual).toBe(600);
    const ch = t.getChannelState(CH)!;
    expect(ch.contents?.liquidVolume).toBe(400);
    expect(ch.contents?.airVolume).toBe(600);
    expect(ch.contents?.volume).toBe(1_000);
  });

  it("dispense ejects trailing air FIRST, then liquid", () => {
    t.addLiquidToWell(SRC, "Sample", 600, "default", LW);
    t.aspirate(CH, SRC, 1_000, "A1");       // tip = 400 liquid + 600 air

    const disp = t.dispense(CH, DST, 1_000, "B1");
    expect(disp.actualVolume).toBe(1_000);
    expect(disp.airActual).toBe(600);       // air spat out first
    expect(disp.liquidActual).toBe(400);    // then all the liquid

    const dst = t.getWellContents(DST)!;
    expect(dst.volume).toBe(400);
    expect(dst.components?.get("Sample")).toBe(400);
  });

  it("partial dispense is 100% air when the bottom layer is all air", () => {
    t.addLiquidToWell(SRC, "Sample", 600, "default", LW);
    t.aspirate(CH, SRC, 1_000, "A1");       // tip = 400 liquid + 600 air

    // Ask for 500 — all of it comes from the air layer at the bottom.
    const disp = t.dispense(CH, DST, 500, "B1");
    expect(disp.airActual).toBe(500);
    expect(disp.liquidActual).toBe(0);

    const dst = t.getWellContents(DST);
    expect(dst).toBeNull();                 // no liquid was actually deposited
    const ch = t.getChannelState(CH)!;
    expect(ch.contents?.airVolume).toBe(100);
    expect(ch.contents?.liquidVolume).toBe(400);
  });

  it("clean aspirate (no underflow) has zero air", () => {
    t.addLiquidToWell(SRC, "Water", 10_000, "default", LW);
    const asp = t.aspirate(CH, SRC, 1_000, "A1");
    expect(asp.liquidActual).toBe(1_000);
    expect(asp.airActual).toBe(0);
    const ch = t.getChannelState(CH)!;
    expect(ch.contents?.airVolume ?? 0).toBe(0);
  });
});
