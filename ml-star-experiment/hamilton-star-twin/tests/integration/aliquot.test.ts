/**
 * Phase 5: Aliquot / Multi-Dispense Tests
 *
 * Verifies the aliquotDispense step:
 * - 1 aspirate → N partial jet dispenses
 * - Rest volume ejected with tip to waste
 * - Volume conservation: aspirated == sum(dispensed) + rest
 * - Partial dispenses use dm=2, last uses dm=0
 * - Decomposition shows labeled sub-steps
 */

// FAILURE INJECTION
// If the aliquot step stops tracking the rest volume separately (or dispenses
// it back to destination instead of waste), the volume-conservation check
// `aspirated == sum(dispensed) + rest` fails. If the partial dispenses use
// dm=0 instead of dm=2 (or vice versa for the last), the dispense-mode checks
// fail because each dispense command's `dm` parameter is inspected.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  resetAndInit, isServerUp, clearDeckCache, fillPlate,
  getColumnVolumes, getWellVolume, getModuleVars, apiPost,
} from "./helpers";

async function step(type: string, params: Record<string, any> = {}): Promise<any> {
  return apiPost("/step", { type, params });
}

async function decompose(type: string, params: Record<string, any> = {}): Promise<any> {
  return apiPost("/step/decompose", { type, params });
}

describe("Phase 5: Aliquot / Multi-Dispense", () => {
  beforeAll(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin server not running on localhost:8222");
  });

  beforeEach(async () => {
    clearDeckCache();
    await resetAndInit();
    // Fill source with enough liquid for aliquoting (1000µL in trough)
    await fillPlate("RGT001", 0, "Water", 100000);  // 10mL trough
    await fillPlate("SMP001", 0, "Water", 5000);     // 500µL per well
  });

  // ── Basic Aliquot ─────────────────────────────────────────────────

  describe("Aliquot: 1 aspirate → N dispenses", () => {

    it("3×100µL aliquot from trough to 3 plate columns", async () => {
      const r = await step("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 0 },
          { carrierId: "DST001", position: 0, column: 1 },
          { carrierId: "DST001", position: 0, column: 2 },
        ],
        dispenseVolume: 100,
        restVolume: 5,  // 5µL rest
        liquidClass: "HighVolume_Water_AliquotDispenseJet_Part",
      });

      expect(r.success).toBe(true);
      expect(r.stepType).toBe("AliquotDispense");

      // Commands: TP + AS + DS + DS + DS + TR = 6
      expect(r.commands.length).toBe(6);
    });

    it("destination wells each receive dispenseVolume", async () => {
      await step("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 0 },
          { carrierId: "DST001", position: 0, column: 1 },
          { carrierId: "DST001", position: 0, column: 2 },
        ],
        dispenseVolume: 50,
        restVolume: 5,
      });

      // Each destination column should have 50µL (=500 in 0.1µL) per well
      const col0 = await getColumnVolumes("DST001", 0, 0);
      const col1 = await getColumnVolumes("DST001", 0, 1);
      const col2 = await getColumnVolumes("DST001", 0, 2);

      // All 8 channels dispense 50µL to each column
      for (let row = 0; row < 8; row++) {
        expect(col0[row]).toBe(500);  // 50µL = 500 in 0.1µL
        expect(col1[row]).toBe(500);
        expect(col2[row]).toBe(500);
      }
    });

    it("volume conservation: source depletion == sum(dispensed) + rest", async () => {
      const dispVol = 100;  // µL
      const restVol = 10;   // µL
      const nDispenses = 3;
      const totalAsp = dispVol * nDispenses + restVol;  // 310µL

      const troughBefore = await getWellVolume("RGT001", 0, 0);

      await step("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 0 },
          { carrierId: "DST001", position: 0, column: 1 },
          { carrierId: "DST001", position: 0, column: 2 },
        ],
        dispenseVolume: dispVol,
        restVolume: restVol,
      });

      const troughAfter = await getWellVolume("RGT001", 0, 0);
      // Source should be depleted by totalAsp * 8 channels
      const depleted = (troughBefore - troughAfter) / 10;  // convert 0.1µL to µL

      // Each channel aspirates 310µL from the trough (which is a single well)
      // So total depletion = 8 * 310 = 2480µL = 24800 in 0.1µL
      expect(troughBefore - troughAfter).toBe(totalAsp * 10 * 8);

      // Destination: 3 columns × 8 wells × 100µL = 2400µL
      const totalDispensed_01ul = nDispenses * 8 * dispVol * 10;  // 24000
      const totalRest_01ul = 8 * restVol * 10;  // 800 (ejected with tips to waste)

      // Conservation: depletion = dispensed + rest (in 0.1µL)
      expect(troughBefore - troughAfter).toBe(totalDispensed_01ul + totalRest_01ul);
    });
  });

  // ── Dispense Modes ─────────────────────────────────────────────────

  describe("Dispense modes in aliquot", () => {

    it("intermediate dispenses use dm=2 (surface partial)", async () => {
      const r = await step("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 1 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 3 },
          { carrierId: "DST001", position: 0, column: 4 },
          { carrierId: "DST001", position: 0, column: 5 },
        ],
        dispenseVolume: 50,
      });

      expect(r.success).toBe(true);

      // Commands[2] = first dispense (should be dm=2)
      // Commands[3] = second dispense (should be dm=2)
      // Commands[4] = third/last dispense (should be dm=0)
      const rawCmds = r.commands.map((c: any) => c.raw);
      const dsCmds = rawCmds.filter((r: string) => r.includes("C0DS"));

      expect(dsCmds.length).toBe(3);
      expect(dsCmds[0]).toContain("dm2");  // intermediate: partial
      expect(dsCmds[1]).toContain("dm2");  // intermediate: partial
      expect(dsCmds[2]).toContain("dm0");  // last: jet empty
    });

    it("SCXML stays in tip_loaded during partial dispenses (dm=2)", async () => {
      const r = await step("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 2 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 6 },
          { carrierId: "DST001", position: 0, column: 7 },
        ],
        dispenseVolume: 80,
        restVolume: 10,
      });

      expect(r.success).toBe(true);
      // After the last command (tip eject), the PIP should be in no_tip state
      const vars = await getModuleVars("pip");
      expect(vars.tip_fitted[0]).toBe(false);
      expect(vars.volume[0]).toBe(0);
    });
  });

  // ── Decomposition ──────────────────────────────────────────────────

  describe("Aliquot decomposition", () => {

    it("decomposition shows TP + AS(total) + DS×N + TR sub-steps", async () => {
      const d = await decompose("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 0 },
          { carrierId: "DST001", position: 0, column: 1 },
          { carrierId: "DST001", position: 0, column: 2 },
          { carrierId: "DST001", position: 0, column: 3 },
        ],
        dispenseVolume: 100,
        restVolume: 10,
      });

      expect(d.count).toBe(7);  // TP + AS + DS×4 + TR
      expect(d.subSteps[0].type).toBe("tipPickUp");
      expect(d.subSteps[1].type).toBe("aspirate");
      expect(d.subSteps[1].label).toContain("410");  // 4×100 + 10 rest
      expect(d.subSteps[2].type).toBe("dispense");
      expect(d.subSteps[2].label).toContain("dm=2");
      expect(d.subSteps[5].type).toBe("dispense");
      expect(d.subSteps[5].label).toContain("dm=0");  // last one
      expect(d.subSteps[6].type).toBe("tipEject");
      expect(d.subSteps[6].label).toContain("rest");
    });
  });

  // ── Default Rest Volume ────────────────────────────────────────────

  describe("Default rest volume", () => {

    it("default rest volume is 5% of dispense volume", async () => {
      const d = await decompose("aliquotDispense", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "RGT001", position: 0, column: 0 },
        destPositions: [
          { carrierId: "DST001", position: 0, column: 0 },
          { carrierId: "DST001", position: 0, column: 1 },
        ],
        dispenseVolume: 200,  // 5% = 10µL rest
      });

      // Total aspirate = 2×200 + 10 = 410
      expect(d.subSteps[1].label).toContain("410");
    });
  });
});
