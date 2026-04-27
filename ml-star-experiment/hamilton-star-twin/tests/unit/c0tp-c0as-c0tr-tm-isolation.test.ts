/**
 * Per-channel state isolation for C0TP / C0AS / C0DS / C0TR.
 *
 * Real Hamilton firmware applies a command ONLY to channels specified in its
 * tip-mask (tm). Channels outside the mask must keep their existing state —
 * tip_fitted, tip_type, volume, pos_y, pos_z. Before this fix, several SCXML
 * scripts iterated `for (i=0..15) if (tip_fitted[i])` and unconditionally
 * overwrote channel state regardless of the mask, meaning a partial op
 * "reset" disabled channels.
 *
 * Concrete broken paths (each one a test below):
 *   1. Pickup subset (tm=1) then aspirate subset (tm=2) overwrites ch0 volume.
 *   2. Partial eject (tm=1) drops ALL 8 tips from ch0..ch7.
 *   3. Pickup subset adds to active_tip_count correctly.
 *   4. Pickup onto already-fitted channels is rejected (error 07), not
 *      silently overwritten.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("Per-channel isolation across tm-masked ops", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;
  afterEach(() => { twin?.destroy(); twin = null; });

  it("aspirate tm=2 leaves ch0 volume untouched", () => {
    twin = createTestTwin();
    // Pick up all 8 tips
    const tip = twin.wellXY("TIP001", 0, 0, 0);
    twin.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04tp2264tz2164th2450td1`);
    // Fill SMP plate
    twin.fillPlate("SMP001", 0, "water", 15000);
    const smp = twin.wellXY("SMP001", 0, 0, 0);
    // Aspirate 500 on ch0 (tm=1)
    twin.sendCommand(`C0ASid0002xp${smp.xp}yp${smp.yp}av00500tm01lm0zp01500th2450`);
    const s1 = twin.getState();
    const vol_after_ch0 = s1.modules.pip!.variables.volume as number[];
    expect(vol_after_ch0[0]).toBe(500);
    expect(vol_after_ch0[1]).toBe(0);  // ch1 untouched

    // Aspirate 300 on ch1 (tm=2) — ch0 should stay at 500, not be overwritten
    twin.sendCommand(`C0ASid0003xp${smp.xp}yp${smp.yp}av00300tm02lm0zp01500th2450`);
    const s2 = twin.getState();
    const vol_after_ch1 = s2.modules.pip!.variables.volume as number[];
    expect(vol_after_ch1[0]).toBe(500);   // ← before fix: gets overwritten with 300
    expect(vol_after_ch1[1]).toBe(300);
  });

  it("dispense tm=2 leaves ch0 volume untouched", () => {
    twin = createTestTwin();
    const tip = twin.wellXY("TIP001", 0, 0, 0);
    twin.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04tp2264tz2164th2450td1`);
    twin.fillPlate("SMP001", 0, "water", 15000);
    const smp = twin.wellXY("SMP001", 0, 0, 0);
    twin.sendCommand(`C0ASid0002xp${smp.xp}yp${smp.yp}av01000tm03lm0zp01500th2450`);  // ch0+ch1 both get 1000
    twin.sendCommand(`C0DSid0003xp${smp.xp}yp${smp.yp}dv00400dm0tm02zp01500th2450`);  // dispense only ch1
    const s = twin.getState();
    const vol = s.modules.pip!.variables.volume as number[];
    expect(vol[0]).toBe(1000);  // ch0 untouched
    expect(vol[1]).toBe(600);   // ch1 decremented
  });

  it("partial eject (tm=1) keeps other channels' tips", () => {
    twin = createTestTwin();
    const tip = twin.wellXY("TIP001", 0, 0, 0);
    twin.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04tp2264tz2164th2450td1`);
    const sBefore = twin.getState();
    expect((sBefore.modules.pip!.variables.tip_fitted as boolean[]).slice(0, 8))
      .toEqual([true, true, true, true, true, true, true, true]);

    // Eject only ch0 (tm=1) at waste
    twin.sendCommand(`C0TRid0002tm01tz1985th2450`);
    const s = twin.getState();
    const fitted = s.modules.pip!.variables.tip_fitted as boolean[];
    expect(fitted[0]).toBe(false);  // ch0 ejected
    expect(fitted.slice(1, 8)).toEqual([true, true, true, true, true, true, true]);  // rest still fitted
  });

  it("pickup subset then add more: total count reflects all fitted", () => {
    twin = createTestTwin();
    const tip = twin.wellXY("TIP001", 0, 0, 0);
    // First pickup: ch0+ch1 (tm=3)
    twin.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm03tt04tp2264tz2164th2450td1`);
    const s1 = twin.getState();
    expect(s1.modules.pip!.variables.active_tip_count).toBe(2);

    // Second pickup: ch2+ch3 (tm=12) at different col (so wells are fresh)
    const tipCol2 = twin.wellXY("TIP001", 0, 1, 0);  // column 1 row A
    twin.sendCommand(`C0TPid0002xp${tipCol2.xp}yp${tipCol2.yp}tm12tt04tp2264tz2164th2450td1`);
    const s2 = twin.getState();
    expect(s2.modules.pip!.variables.active_tip_count).toBe(4);  // ← before fix: 2 (just this mask)
  });

  it("pickup rejects if any masked channel already has a tip (error 07)", () => {
    twin = createTestTwin();
    const tip = twin.wellXY("TIP001", 0, 0, 0);
    twin.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm01tt04tp2264tz2164th2450td1`);  // ch0 only
    // Second pickup with tm=3 (ch0+ch1); ch0 already has a tip → error 07
    const tipCol2 = twin.wellXY("TIP001", 0, 1, 0);  // column 1 row A
    const r = twin.sendCommand(`C0TPid0002xp${tipCol2.xp}yp${tipCol2.yp}tm03tt04tp2264tz2164th2450td1`);
    expect(r.accepted).toBe(false);
    expect(r.errorCode).toBe(7);
  });
});
