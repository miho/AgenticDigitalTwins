/**
 * Battle tests — exhaustive testing of ghost-head command workflows.
 *
 * These tests simulate EXACTLY what the UI does: pick up tips with a channel mask,
 * aspirate from filled plates, dispense to empty plates, eject tips.
 *
 * Every test verifies:
 *   1. Command accepted (no error)
 *   2. SCXML state transitions correct
 *   3. PIP channel variables correct (tip_fitted, volume, active_tip_count)
 *   4. Deck tracking volumes correct (well volumes up/down)
 *   5. Assessment events generated where expected
 *
 * Prerequisites: twin must be running at http://localhost:8222/
 */

// FAILURE INJECTION
// If the twin's "no tip fitted" rejection leaks through and allows aspirate
// or dispense to mutate well volumes, the rejection tests fail because
// volAfter !== volBefore. If error code 8 is replaced with a different
// code, the tests fail because they pin the specific code.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isServerUp, resetAndInit, getState, getTracking, getAssessments,
  sendCommand, fillPlate, getModuleVars, getModuleStates,
  getWellVolume, getColumnVolumes,
  wellXY, pad5, clearDeckCache,
} from "./helpers";

// ── Helpers ────────────────────────────────────────────────────────────

/** Assert PIP tip state for specific channels */
async function assertTipState(
  expectedFitted: Record<number, boolean>,
  expectedTipCount: number,
): Promise<void> {
  const pip = await getModuleVars("pip");
  for (const [ch, fitted] of Object.entries(expectedFitted)) {
    expect(pip.tip_fitted[Number(ch)], `tip_fitted[${ch}]`).toBe(fitted);
  }
  expect(pip.active_tip_count).toBe(expectedTipCount);
}

/** Assert PIP channel volumes */
async function assertChannelVolumes(
  expected: Record<number, number>,
): Promise<void> {
  const pip = await getModuleVars("pip");
  for (const [ch, vol] of Object.entries(expected)) {
    expect(pip.volume[Number(ch)], `volume[${ch}]`).toBe(vol);
  }
}

/** Assert deck well volumes for a column */
async function assertColumnVolumes(
  carrierId: string, position: number, col: number,
  expected: number[],
): Promise<void> {
  const vols = await getColumnVolumes(carrierId, position, col);
  for (let row = 0; row < expected.length; row++) {
    expect(vols[row], `${carrierId}:${position} row ${row} col ${col}`).toBe(expected[row]);
  }
}

describe("Ghost-head command battle tests", () => {
  beforeEach(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin not running at http://localhost:8222/");
    await resetAndInit();
    clearDeckCache();
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 1: Tip Pickup — all mask variants
  // ══════════════════════════════════════════════════════════════════════

  describe("Tip pickup masks", () => {
    it("tm=255 picks up all 8 channels", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const r = await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
      await assertTipState({ 0: true, 1: true, 7: true }, 8);
    });

    it("tm=1 picks up channel 1 only", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const r = await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm1tt04`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
      await assertTipState({ 0: true, 1: false, 7: false }, 1);
    });

    it("tm=15 picks up channels 1-4", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const r = await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm15tt04`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
      await assertTipState({ 0: true, 1: true, 2: true, 3: true, 4: false, 7: false }, 4);
    });

    it("tm=240 picks up channels 5-8", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const r = await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm240tt04`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
      await assertTipState({ 0: false, 3: false, 4: true, 5: true, 6: true, 7: true }, 4);
    });

    it("tm=170 picks up channels 2,4,6,8 (alternating)", async () => {
      // 170 = 10101010 binary
      const tip = await wellXY("TIP001", 0, 0);
      const r = await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm170tt04`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
      await assertTipState({ 0: false, 1: true, 2: false, 3: true, 4: false, 5: true, 6: false, 7: true }, 4);
    });

    it("tm=128 picks up channel 8 only", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const r = await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm128tt04`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
      await assertTipState({ 0: false, 6: false, 7: true }, 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 2: Aspirate — all mask variants with deck tracking
  // ══════════════════════════════════════════════════════════════════════

  describe("Aspirate with channel masks", () => {
    it("tm=255: aspirate 100uL from all 8 wells", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      const r = await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      // PIP channels all have volume
      await assertChannelVolumes({ 0: 1000, 3: 1000, 7: 1000 });
      // Source wells reduced
      await assertColumnVolumes("SMP001", 0, 0, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    });

    it("tm=240: aspirate only from rows E-H", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm240tt04`);
      const r = await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm240lm0`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      // Only channels 4-7 have volume (SCXML uses tip_fitted)
      await assertChannelVolumes({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 1000, 5: 1000, 6: 1000, 7: 1000 });
      // Source: rows A-D untouched, E-H aspirated
      await assertColumnVolumes("SMP001", 0, 0, [2000, 2000, 2000, 2000, 1000, 1000, 1000, 1000]);
    });

    it("tm=15: aspirate only from rows A-D", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm15tt04`);
      const r = await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm15lm0`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      await assertChannelVolumes({ 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 0, 5: 0, 6: 0, 7: 0 });
      await assertColumnVolumes("SMP001", 0, 0, [1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000]);
    });

    it("tm=1: single channel aspirate", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm1tt04`);
      const r = await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm1lm0`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      await assertChannelVolumes({ 0: 1000 });
      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[0]).toBe(1000);
      expect(srcVols[1]).toBe(2000); // untouched
    });

    it("tm=128: channel 8 only aspirate", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm128tt04`);
      const r = await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm128lm0`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      await assertChannelVolumes({ 0: 0, 6: 0, 7: 1000 });
      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[0]).toBe(2000); // untouched
      expect(srcVols[7]).toBe(1000); // aspirated (Row H)
    });

    it("aspirate from column 1 (not just column 0)", async () => {
      const tip1 = await wellXY("TIP001", 0, 1);
      const src1 = await wellXY("SMP001", 0, 1);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip1.xp}yp${tip1.yp}tm255tt04`);
      const r = await sendCommand(`C0ASid0002xp${src1.xp}yp${src1.yp}av01000tm255lm0`);
      expect(r.accepted).toBe(true);

      const col0 = await getColumnVolumes("SMP001", 0, 0);
      const col1 = await getColumnVolumes("SMP001", 0, 1);
      // Column 0 untouched
      expect(col0[0]).toBe(2000);
      // Column 1 aspirated
      expect(col1[0]).toBe(1000);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 3: Dispense — matching mask verification
  // ══════════════════════════════════════════════════════════════════════

  describe("Dispense with channel masks", () => {
    it("tm=255: dispense to destination, all 8 wells gain volume", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      const r = await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      await assertColumnVolumes("DST001", 0, 0, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    });

    it("tm=240: dispense only to rows E-H", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm240tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm240lm0`);
      const r = await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv01000dm0tm240`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      await assertColumnVolumes("DST001", 0, 0, [0, 0, 0, 0, 1000, 1000, 1000, 1000]);
    });

    it("tm=15: dispense only to rows A-D", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm15tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm15lm0`);
      const r = await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv01000dm0tm15`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);

      await assertColumnVolumes("DST001", 0, 0, [1000, 1000, 1000, 1000, 0, 0, 0, 0]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 4: Full transfer — volume conservation for every mask
  // ══════════════════════════════════════════════════════════════════════

  describe("Volume conservation", () => {
    for (const [label, mask, channels] of [
      ["all 8", 255, [0,1,2,3,4,5,6,7]],
      ["1-4",    15, [0,1,2,3]],
      ["5-8",   240, [4,5,6,7]],
      ["ch 1",    1, [0]],
      ["ch 8",  128, [7]],
      ["2,4,6,8", 170, [1,3,5,7]],
    ] as [string, number, number[]][]) {
      it(`${label} (tm=${mask}): source + destination = initial`, async () => {
        const tip = await wellXY("TIP001", 0, 0);
        const src = await wellXY("SMP001", 0, 0);
        const dst = await wellXY("DST001", 0, 0);

        await fillPlate("SMP001", 0, "Sample", 2000);
        await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm${mask}tt04`);
        await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm${mask}lm0`);
        await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv01000dm0tm${mask}`);
        await sendCommand(`C0TRid0004tm${mask}`);

        const srcVols = await getColumnVolumes("SMP001", 0, 0);
        const dstVols = await getColumnVolumes("DST001", 0, 0);

        for (let row = 0; row < 8; row++) {
          if (channels.includes(row)) {
            expect(srcVols[row], `src row ${row}`).toBe(1000);
            expect(dstVols[row], `dst row ${row}`).toBe(1000);
            expect(srcVols[row] + dstVols[row], `conservation row ${row}`).toBe(2000);
          } else {
            expect(srcVols[row], `src row ${row} untouched`).toBe(2000);
            expect(dstVols[row], `dst row ${row} untouched`).toBe(0);
          }
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 5: Error cases — commands that SHOULD fail
  // ══════════════════════════════════════════════════════════════════════

  describe("Error cases", () => {
    it("aspirate without tips → error 08", async () => {
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      const volBefore = await getColumnVolumes("SMP001", 0, 0);

      const r = await sendCommand(`C0ASid0001xp${src.xp}yp${src.yp}av01000tm255lm0`);
      expect(r.errorCode).toBe(8);  // 8 = no tip fitted

      // Source volumes unchanged — rejection means no physical aspirate.
      const volAfter = await getColumnVolumes("SMP001", 0, 0);
      expect(volAfter).toEqual(volBefore);
    });

    it("dispense without tips → error 08", async () => {
      const dst = await wellXY("DST001", 0, 0);
      const volBefore = await getColumnVolumes("DST001", 0, 0);

      const r = await sendCommand(`C0DSid0001xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      expect(r.errorCode).toBe(8);  // 8 = no tip fitted

      // Destination volumes unchanged — rejection means no physical dispense.
      const volAfter = await getColumnVolumes("DST001", 0, 0);
      expect(volAfter).toEqual(volBefore);
    });

    it("tip pickup when tips already fitted on same channels → error 07", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      const r = await sendCommand(`C0TPid0002xp${tip.xp}yp${tip.yp}tm255tt04`);
      expect(r.errorCode).toBe(7);
    });

    it("aspirate from empty plate → accepted but no well volume change", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      // Don't fill the plate — wells are all 0
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      const r = await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      expect(r.accepted).toBe(true); // SCXML accepts (adds volume to channels)
      // But well volumes stay at 0
      await assertColumnVolumes("SMP001", 0, 0, [0, 0, 0, 0, 0, 0, 0, 0]);
      // PIP channels DO have volume (SCXML tracks independently)
      await assertChannelVolumes({ 0: 1000, 7: 1000 });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 6: Sequential operations — multiple aspirates, partial dispense
  // ══════════════════════════════════════════════════════════════════════

  describe("Sequential operations", () => {
    it("double aspirate accumulates volume", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 5000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      await sendCommand(`C0ASid0003xp${src.xp}yp${src.yp}av01000tm255lm0`);

      await assertChannelVolumes({ 0: 2000, 7: 2000 });
      await assertColumnVolumes("SMP001", 0, 0, [3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000]);
    });

    it("partial dispense leaves remainder in channels", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      // Dispense only 500 (partial, dm=2)
      const r = await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv00500dm2tm255`);
      expect(r.accepted).toBe(true);

      // Channels should have 500 remaining
      await assertChannelVolumes({ 0: 500, 7: 500 });
      // Destination gets 500
      await assertColumnVolumes("DST001", 0, 0, [500, 500, 500, 500, 500, 500, 500, 500]);
    });

    it("aspirate from col 0, dispense to col 1 (cross-column transfer)", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst1 = await wellXY("DST001", 0, 1);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm240tt04`); // ch 5-8
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm240lm0`); // from SMP001 col 0
      await sendCommand(`C0DSid0003xp${dst1.xp}yp${dst1.yp}dv01000dm0tm240`); // to DST001 col 1

      const srcCol0 = await getColumnVolumes("SMP001", 0, 0);
      const dstCol1 = await getColumnVolumes("DST001", 0, 1);
      const dstCol0 = await getColumnVolumes("DST001", 0, 0);

      // Source col 0 rows E-H reduced
      expect(srcCol0[4]).toBe(1000);
      expect(srcCol0[7]).toBe(1000);
      // Destination col 1 rows E-H filled
      expect(dstCol1[4]).toBe(1000);
      expect(dstCol1[7]).toBe(1000);
      // Destination col 0 untouched
      expect(dstCol0[0]).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 7: Tip eject and re-pickup
  // ══════════════════════════════════════════════════════════════════════

  describe("Tip eject and re-pickup", () => {
    it("eject clears all channels", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      await assertTipState({ 0: true, 7: true }, 8);

      await sendCommand(`C0TRid0002tm255`);
      await assertTipState({ 0: false, 7: false }, 0);
    });

    it("pickup → eject → pickup again succeeds", async () => {
      const tip0 = await wellXY("TIP001", 0, 0);
      const tip1 = await wellXY("TIP001", 0, 1);
      await sendCommand(`C0TPid0001xp${tip0.xp}yp${tip0.yp}tm15tt04`);
      await assertTipState({ 0: true, 3: true, 4: false }, 4);

      await sendCommand(`C0TRid0002tm15`);
      await assertTipState({ 0: false, 3: false }, 0);

      // Pick up from different column with different mask
      await sendCommand(`C0TPid0003xp${tip1.xp}yp${tip1.yp}tm240tt04`);
      await assertTipState({ 0: false, 3: false, 4: true, 7: true }, 4);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 8: Assessment events — TADM generated for aspirate/dispense
  // ══════════════════════════════════════════════════════════════════════

  describe("Assessment events", () => {
    it("aspirate generates TADM event", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm240tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm240lm0`);

      const events = await getAssessments();
      const tadm = events.filter((e: any) => e.category === "tadm" && e.command === "C0AS");
      expect(tadm.length).toBeGreaterThan(0);
    });

    it("dispense generates TADM event", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);

      const events = await getAssessments();
      const tadm = events.filter((e: any) => e.category === "tadm" && e.command === "C0DS");
      expect(tadm.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION 9: State machine transitions
  // ══════════════════════════════════════════════════════════════════════

  describe("PIP state transitions", () => {
    it("no_tip → tip_empty → tip_loaded → tip_empty", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);

      let states = await getModuleStates("pip");
      expect(states).toContain("no_tip");

      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      states = await getModuleStates("pip");
      expect(states).toContain("tip_empty");

      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      states = await getModuleStates("pip");
      expect(states).toContain("tip_loaded");

      await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      states = await getModuleStates("pip");
      expect(states).toContain("tip_empty");
    });

    it("tip_loaded stays loaded after partial dispense (dm=2)", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample", 2000);
      await sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0002xp${src.xp}yp${src.yp}av01000tm255lm0`);
      await sendCommand(`C0DSid0003xp${dst.xp}yp${dst.yp}dv00500dm2tm255`);

      const states = await getModuleStates("pip");
      expect(states).toContain("tip_loaded");
    });
  });
});
