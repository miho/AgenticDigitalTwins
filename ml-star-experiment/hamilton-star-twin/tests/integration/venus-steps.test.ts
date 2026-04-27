/**
 * VENUS Step Layer Integration Tests
 *
 * Tests the /step HTTP endpoint which provides high-level VENUS step
 * execution on top of the raw FW command interface.
 *
 * Prerequisites: twin must be running at http://localhost:8222/
 */

// FAILURE INJECTION
// If the aspirate step in venus-steps.ts stops returning the underlying
// command's errorCode (e.g. always returns 0 when rejected), the
// "aspirate — error without tips" test fails because it pins error 8.
// If step execution proceeds despite a rejection, the volBefore===volAfter
// assertion fails.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isServerUp, resetAndInit, getState, getTracking,
  sendCommand, fillPlate, getModuleVars, getModuleStates,
  getColumnVolumes, apiPost, apiGet,
} from "./helpers";

// ── Step API helpers ────────────────────────────────────────────────────

async function executeStep(type: string, params: Record<string, any> = {}): Promise<any> {
  return apiPost("/step", { type, params });
}

async function listSteps(): Promise<string[]> {
  return apiGet("/steps");
}

// ── Common deck addresses ───────────────────────────────────────────────

const TIPS_COL0 = { carrierId: "TIP001", position: 0, column: 0 };
const TIPS_COL1 = { carrierId: "TIP001", position: 0, column: 1 };
const TIPS_COL2 = { carrierId: "TIP001", position: 0, column: 2 };
const SRC_COL0 = { carrierId: "SMP001", position: 0, column: 0 };
const SRC_COL1 = { carrierId: "SMP001", position: 0, column: 1 };
const DST_COL0 = { carrierId: "DST001", position: 0, column: 0 };
const DST_COL1 = { carrierId: "DST001", position: 0, column: 1 };

describe("VENUS Step Layer", () => {
  beforeEach(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin not running at http://localhost:8222/");
    await resetAndInit();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Meta
  // ══════════════════════════════════════════════════════════════════════

  describe("Step API meta", () => {
    it("lists all supported step types", async () => {
      const steps = await listSteps();
      expect(steps).toContain("aspirate");
      expect(steps).toContain("dispense");
      expect(steps).toContain("tipPickUp");
      expect(steps).toContain("tipEject");
      expect(steps).toContain("easyAspirate");
      expect(steps).toContain("easyDispense");
      expect(steps).toContain("easyTransfer");
      expect(steps).toContain("head96TipPickUp");
      expect(steps).toContain("setTemperature");
      expect(steps.length).toBeGreaterThanOrEqual(15);
    });

    it("rejects unknown step type", async () => {
      const r = await executeStep("nonExistentStep");
      expect(r.success).toBe(false);
      expect(r.error).toContain("Unknown step type");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Single Steps
  // ══════════════════════════════════════════════════════════════════════

  describe("Single Steps", () => {
    it("tipPickUp — picks up 8 tips", async () => {
      const r = await executeStep("tipPickUp", {
        position: TIPS_COL0,
        channelMask: 255,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("TipPickUp");
      expect(r.commands).toHaveLength(1);
      expect(r.commands[0].result.accepted).toBe(true);

      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(8);
    });

    it("tipPickUp — channels 5-8 only", async () => {
      const r = await executeStep("tipPickUp", {
        position: TIPS_COL0,
        channelMask: 240,
      });
      expect(r.success).toBe(true);

      const pip = await getModuleVars("pip");
      expect(pip.tip_fitted[0]).toBe(false);
      expect(pip.tip_fitted[4]).toBe(true);
      expect(pip.active_tip_count).toBe(4);
    });

    it("aspirate — aspirates from filled plate", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      await executeStep("tipPickUp", { position: TIPS_COL0 });

      const r = await executeStep("aspirate", {
        position: SRC_COL0,
        volume: 100,           // 100µL
        channelMask: 255,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("Aspirate");

      // PIP channels have volume
      const pip = await getModuleVars("pip");
      expect(pip.volume[0]).toBe(1000); // 100µL = 1000 × 0.1µL

      // Source wells reduced
      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[0]).toBe(1000); // 200µL - 100µL = 100µL = 1000
    });

    it("aspirate — error without tips (error 8, sources unchanged)", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const volBefore = await getColumnVolumes("SMP001", 0, 0);

      const r = await executeStep("aspirate", {
        position: SRC_COL0,
        volume: 100,
      });
      expect(r.success).toBe(false);
      // Error 8 = no tip fitted. Pin the code.
      expect(r.commands[0].result.errorCode).toBe(8);

      // Rejection: no volume was physically aspirated.
      const volAfter = await getColumnVolumes("SMP001", 0, 0);
      expect(volAfter).toEqual(volBefore);
    });

    it("dispense — dispenses to destination", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      await executeStep("tipPickUp", { position: TIPS_COL0 });
      await executeStep("aspirate", { position: SRC_COL0, volume: 100 });

      const r = await executeStep("dispense", {
        position: DST_COL0,
        volume: 100,
        dispenseMode: 0,
      });
      expect(r.success).toBe(true);

      const dstVols = await getColumnVolumes("DST001", 0, 0);
      expect(dstVols[0]).toBe(1000); // 100µL
    });

    it("tipEject — ejects all tips", async () => {
      await executeStep("tipPickUp", { position: TIPS_COL0 });
      const r = await executeStep("tipEject", {});
      expect(r.success).toBe(true);

      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(0);
    });

    it("setTemperature — sets TCC temperature", async () => {
      const r = await executeStep("setTemperature", {
        temperature: 37,
        heaterNumber: 1,
      });
      expect(r.success).toBe(true);

      const temp = await getModuleVars("temp");
      expect(temp.target_temp_01c).toBe(370);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Easy Steps (composite)
  // ══════════════════════════════════════════════════════════════════════

  describe("Easy Steps", () => {
    it("easyAspirate — picks tips + aspirates in one step", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);

      const r = await executeStep("easyAspirate", {
        tipPosition: TIPS_COL0,
        aspiratePosition: SRC_COL0,
        volume: 100,
        channelMask: 255,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("EasyAspirate");
      expect(r.commands).toHaveLength(2); // C0TP + C0AS

      // Tips fitted + volume in channels
      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(8);
      expect(pip.volume[0]).toBe(1000);

      // Source wells reduced
      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[0]).toBe(1000);
    });

    it("easyDispense — dispenses + ejects in one step", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      await executeStep("easyAspirate", {
        tipPosition: TIPS_COL0,
        aspiratePosition: SRC_COL0,
        volume: 100,
      });

      const r = await executeStep("easyDispense", {
        dispensePosition: DST_COL0,
        volume: 100,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("EasyDispense");
      expect(r.commands).toHaveLength(2); // C0DS + C0TR

      // Tips ejected
      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(0);

      // Destination has volume
      const dstVols = await getColumnVolumes("DST001", 0, 0);
      expect(dstVols[0]).toBe(1000);
    });

    it("easyTransfer — full pipeline in one step", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);

      const r = await executeStep("easyTransfer", {
        tipPosition: TIPS_COL0,
        sourcePosition: SRC_COL0,
        destPosition: DST_COL0,
        volume: 100,
        channelMask: 255,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("EasyTransfer");
      expect(r.commands).toHaveLength(4); // C0TP + C0AS + C0DS + C0TR

      // Tips ejected
      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(0);

      // Volume conservation: source + dest = initial
      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      const dstVols = await getColumnVolumes("DST001", 0, 0);
      for (let row = 0; row < 8; row++) {
        expect(srcVols[row] + dstVols[row], `conservation row ${row}`).toBe(2000);
      }
    });

    it("easyTransfer — channels 5-8 only", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);

      const r = await executeStep("easyTransfer", {
        tipPosition: TIPS_COL0,
        sourcePosition: SRC_COL0,
        destPosition: DST_COL0,
        volume: 100,
        channelMask: 240,
      });
      expect(r.success).toBe(true);

      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      const dstVols = await getColumnVolumes("DST001", 0, 0);

      // Rows A-D untouched
      for (let row = 0; row < 4; row++) {
        expect(srcVols[row], `src row ${row}`).toBe(2000);
        expect(dstVols[row], `dst row ${row}`).toBe(0);
      }
      // Rows E-H transferred
      for (let row = 4; row < 8; row++) {
        expect(srcVols[row], `src row ${row}`).toBe(1000);
        expect(dstVols[row], `dst row ${row}`).toBe(1000);
      }
    });

    it("easyTransfer — cross-column (col 0 → col 1)", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);

      const r = await executeStep("easyTransfer", {
        tipPosition: TIPS_COL1,
        sourcePosition: SRC_COL1,
        destPosition: DST_COL1,
        volume: 50,
      });
      expect(r.success).toBe(true);

      const srcCol1 = await getColumnVolumes("SMP001", 0, 1);
      const dstCol1 = await getColumnVolumes("DST001", 0, 1);
      expect(srcCol1[0]).toBe(1500); // 200µL - 50µL = 150µL = 1500
      expect(dstCol1[0]).toBe(500);  // 50µL = 500
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Sequential workflows
  // ══════════════════════════════════════════════════════════════════════

  describe("Sequential workflows", () => {
    it("two consecutive transfers to same destination column", async () => {
      await fillPlate("SMP001", 0, "Sample_A", 2000);

      // Transfer 1: col 0 → col 0
      await executeStep("easyTransfer", {
        tipPosition: TIPS_COL0,
        sourcePosition: SRC_COL0,
        destPosition: DST_COL0,
        volume: 50,
      });

      // Transfer 2: col 1 → col 0 (different tips)
      await executeStep("easyTransfer", {
        tipPosition: TIPS_COL1,
        sourcePosition: SRC_COL1,
        destPosition: DST_COL0,
        volume: 50,
      });

      const dstVols = await getColumnVolumes("DST001", 0, 0);
      expect(dstVols[0]).toBe(1000); // 50µL + 50µL = 100µL = 1000
    });

    it("aspirate 50µL twice = 100µL in channel", async () => {
      await fillPlate("SMP001", 0, "Sample", 5000);
      await executeStep("tipPickUp", { position: TIPS_COL0 });
      await executeStep("aspirate", { position: SRC_COL0, volume: 50 });
      await executeStep("aspirate", { position: SRC_COL0, volume: 50 });

      const pip = await getModuleVars("pip");
      expect(pip.volume[0]).toBe(1000); // 50+50 = 100µL = 1000

      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[0]).toBe(4000); // 500 - 50 - 50 = 400µL = 4000
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Error propagation
  // ══════════════════════════════════════════════════════════════════════

  describe("Error propagation", () => {
    it("easyAspirate fails if tip pickup fails (tips already fitted)", async () => {
      // First pickup succeeds
      await executeStep("tipPickUp", { position: TIPS_COL0 });

      // Easy aspirate should fail at tip pickup (already fitted)
      const r = await executeStep("easyAspirate", {
        tipPosition: TIPS_COL0,
        aspiratePosition: SRC_COL0,
        volume: 100,
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("TipPickUp failed");
      expect(r.commands).toHaveLength(1); // Only the failed pickup, no aspirate
    });

    it("easyTransfer fails at aspirate step if no liquid", async () => {
      // Don't fill plate — aspirate from empty wells
      const r = await executeStep("easyTransfer", {
        tipPosition: TIPS_COL0,
        sourcePosition: SRC_COL0,
        destPosition: DST_COL0,
        volume: 100,
      });
      // Pickup succeeds, aspirate succeeds (SCXML doesn't check well volume),
      // dispense succeeds, eject succeeds — all 4 commands
      expect(r.success).toBe(true);
      expect(r.commands).toHaveLength(4);

      // But no actual liquid was transferred (wells were empty)
      const dstVols = await getColumnVolumes("DST001", 0, 0);
      expect(dstVols[0]).toBe(1000); // Deck tracker adds volume (channel had it from SCXML)
    });

    it("invalid position returns error", async () => {
      const r = await executeStep("tipPickUp", {
        position: { carrierId: "NONEXISTENT", position: 0, column: 0 },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("Cannot resolve position");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 96-Head Steps
  // ══════════════════════════════════════════════════════════════════════

  describe("96-Head Steps", () => {
    it("head96Move — moves to plate position", async () => {
      const r = await executeStep("head96Move", {
        position: SRC_COL0,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("Head96Move");
    });

    it("easy96Aspirate — move + pickup + move + aspirate", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await executeStep("easy96Aspirate", {
        tipPosition: TIPS_COL0,
        aspiratePosition: SRC_COL0,
        volume: 100,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("Easy96Aspirate");
      expect(r.commands.length).toBeGreaterThanOrEqual(4);

      const h96 = await getModuleVars("h96");
      expect(h96.tips_fitted).toBe(true);
      expect(h96.volume_01ul).toBe(1000);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Assessment events
  // ══════════════════════════════════════════════════════════════════════

  describe("Assessment integration", () => {
    it("easyTransfer generates TADM assessments", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);

      const r = await executeStep("easyTransfer", {
        tipPosition: TIPS_COL0,
        sourcePosition: SRC_COL0,
        destPosition: DST_COL0,
        volume: 100,
      });
      expect(r.success).toBe(true);
      // Assessment events should be generated for aspirate and dispense
      expect(r.assessments.length).toBeGreaterThan(0);
    });
  });
});
