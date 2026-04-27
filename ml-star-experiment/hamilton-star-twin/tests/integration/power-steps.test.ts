/**
 * Power Step & Transport Integration Tests
 *
 * Tests the high-level VENUS steps that loop over columns or coordinate
 * multiple modules. Verifies volume conservation, tip consumption,
 * state transitions, and assessment generation.
 *
 * Prerequisites: twin must be running at http://localhost:8222/
 */

// FAILURE INJECTION
// If the command-timing module returns an unknown accuracy tier (not
// "computed", "hybrid", or "estimate"), the per-command timing assertion
// fails at the toContain() check. If the timing breakdown is returned as
// {} instead of an array of phase entries, the "timing breakdown includes
// phase details" test fails at the instanceof(Array) and length checks.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isServerUp, resetAndInit, getState, getTracking,
  sendCommand, fillPlate, getModuleVars, getModuleStates,
  getColumnVolumes, apiPost, apiGet, wellXY, clearDeckCache,
} from "./helpers";

// ── Step helpers ────────────────────────────────────────────────────────

async function step(type: string, params: Record<string, any> = {}): Promise<any> {
  return apiPost("/step", { type, params });
}

async function decompose(type: string, params: Record<string, any> = {}): Promise<any> {
  return apiPost("/step/decompose", { type, params });
}

// ── Constants ───────────────────────────────────────────────────────────

const VOL = 100;  // µL per transfer

describe("Power Steps & Transport", () => {
  beforeEach(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin not running at http://localhost:8222/");
    await resetAndInit();
    clearDeckCache();
  });

  // ══════════════════════════════════════════════════════════════════════
  // TransferSamples — full plate column-by-column
  // ══════════════════════════════════════════════════════════════════════

  describe("TransferSamples", () => {
    it("transfers 3 columns with volume conservation", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);

      const r = await step("transferSamples", {
        tipCarrier: "TIP001", tipPosition: 0,
        sourceCarrier: "SMP001", sourcePosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: VOL, columns: 3, channelMask: 255,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("TransferSamples");
      // 3 columns × 4 commands (tip+asp+disp+eject) = 12
      expect(r.commands.length).toBe(12);

      // Verify volume conservation for each transferred column
      for (let col = 0; col < 3; col++) {
        const src = await getColumnVolumes("SMP001", 0, col);
        const dst = await getColumnVolumes("DST001", 0, col);
        for (let row = 0; row < 8; row++) {
          expect(src[row] + dst[row], `col ${col} row ${row} conservation`).toBe(2000);
          expect(src[row], `col ${col} row ${row} src`).toBe(1000);  // 200-100=100µL
          expect(dst[row], `col ${col} row ${row} dst`).toBe(1000);  // 100µL transferred
        }
      }

      // Columns 3+ should be untouched
      const src3 = await getColumnVolumes("SMP001", 0, 3);
      expect(src3[0]).toBe(2000);
      const dst3 = await getColumnVolumes("DST001", 0, 3);
      expect(dst3[0]).toBe(0);
    });

    it("tips ejected after each column (no tip reuse)", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      await step("transferSamples", {
        tipCarrier: "TIP001", tipPosition: 0,
        sourceCarrier: "SMP001", sourcePosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: VOL, columns: 2,
      });

      // PIP should have no tips (ejected after last column)
      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(0);

      // Tips used: 2 columns × 8 channels = 16 tips from col 0 and col 1
      const tracking = await getTracking();
      let tipsUsed = 0;
      for (const [key, used] of Object.entries(tracking.tipUsage)) {
        if (key.startsWith("TIP001:0:") && used) tipsUsed++;
      }
      expect(tipsUsed).toBe(16);
    });

    it("decomposition shows 4 sub-steps per column", async () => {
      const d = await decompose("transferSamples", {
        tipCarrier: "TIP001", tipPosition: 0,
        sourceCarrier: "SMP001", sourcePosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: VOL, columns: 4,
      });
      expect(d.count).toBe(16);  // 4 columns × 4 steps
      expect(d.subSteps[0].label).toContain("col 0");
      expect(d.subSteps[0].type).toBe("tipPickUp");
      expect(d.subSteps[4].label).toContain("col 1");
    });

    it("with channel mask 15 (channels 1-4 only)", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await step("transferSamples", {
        tipCarrier: "TIP001", tipPosition: 0,
        sourceCarrier: "SMP001", sourcePosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: VOL, columns: 1, channelMask: 15,
      });
      expect(r.success).toBe(true);

      const src = await getColumnVolumes("SMP001", 0, 0);
      const dst = await getColumnVolumes("DST001", 0, 0);
      // Rows A-D transferred (channels 0-3)
      for (let row = 0; row < 4; row++) {
        expect(src[row], `row ${row} src`).toBe(1000);
        expect(dst[row], `row ${row} dst`).toBe(1000);
      }
      // Rows E-H untouched (channels 4-7 not in mask)
      for (let row = 4; row < 8; row++) {
        expect(src[row], `row ${row} src`).toBe(2000);
        expect(dst[row], `row ${row} dst`).toBe(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // AddReagent — trough to plate, column by column
  // ══════════════════════════════════════════════════════════════════════

  describe("AddReagent", () => {
    it("adds 50µL reagent to 3 plate columns from trough", async () => {
      // Fill trough with reagent (large volume, single well)
      await fillPlate("RGT001", 0, "Reagent_A", 100000);  // 10mL

      const r = await step("addReagent", {
        tipCarrier: "TIP001", tipPosition: 0,
        reagentCarrier: "RGT001", reagentPosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: 50, columns: 3,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("AddReagent");
      // 3 columns × 4 commands = 12
      expect(r.commands.length).toBe(12);

      // Each destination column should have 50µL (500 in 0.1µL) per well
      for (let col = 0; col < 3; col++) {
        const dst = await getColumnVolumes("DST001", 0, col);
        for (let row = 0; row < 8; row++) {
          expect(dst[row], `col ${col} row ${row}`).toBe(500);
        }
      }

      // Column 3 untouched
      const dst3 = await getColumnVolumes("DST001", 0, 3);
      expect(dst3[0]).toBe(0);
    });

    it("trough volume decreases with each aspirate", async () => {
      await fillPlate("RGT001", 0, "Reagent", 100000);
      await step("addReagent", {
        tipCarrier: "TIP001", tipPosition: 0,
        reagentCarrier: "RGT001", reagentPosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: 50, columns: 2,
      });

      // Trough: 10mL - (2 cols × 8 ch × 50µL) = 10000µL - 800µL = 9200µL = 92000 in 0.1µL
      const tracking = await getTracking();
      const troughVol = tracking.wellVolumes["RGT001:0:0"] ?? 0;
      expect(troughVol).toBe(100000 - 2 * 8 * 500);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SerialDilution — column-to-column cascade with mixing
  // ══════════════════════════════════════════════════════════════════════

  describe("SerialDilution", () => {
    it("performs 3-step serial dilution", async () => {
      // Fill plate with 300µL per well (fillPlate fills ALL 96 wells)
      await fillPlate("SMP001", 0, "Concentrate", 3000);

      const r = await step("serialDilution", {
        tipCarrier: "TIP001", tipPosition: 0,
        plateCarrier: "SMP001", platePosition: 0,
        volume: VOL,        // transfer 100µL each step
        numDilutions: 3,    // col 0→1, col 1→2, col 2→3
        mixCycles: 2,
      });
      expect(r.success).toBe(true);
      expect(r.stepType).toBe("SerialDilution");
      // 3 dilutions × 4 commands = 12
      expect(r.commands.length).toBe(12);

      // All wells start at 3000 (300µL). Serial dilution transfers 100µL (1000) each step:
      // Col 0: 3000 - 1000 = 2000 (aspirated, not replenished)
      // Col 1: 3000 + 1000 - 1000 = 3000 (receives from col 0, loses to col 2)
      // Col 2: 3000 + 1000 - 1000 = 3000 (receives from col 1, loses to col 3)
      // Col 3: 3000 + 1000 = 4000 (receives from col 2, end of cascade)
      const col0 = await getColumnVolumes("SMP001", 0, 0);
      const col1 = await getColumnVolumes("SMP001", 0, 1);
      const col2 = await getColumnVolumes("SMP001", 0, 2);
      const col3 = await getColumnVolumes("SMP001", 0, 3);
      const col4 = await getColumnVolumes("SMP001", 0, 4);

      expect(col0[0]).toBe(2000);  // 300 - 100 = 200µL
      expect(col1[0]).toBe(3000);  // 300 + 100 - 100 = 300µL (net zero)
      expect(col2[0]).toBe(3000);  // same — cascade passes through
      expect(col3[0]).toBe(4000);  // 300 + 100 = 400µL (end of cascade)
      expect(col4[0]).toBe(3000);  // untouched

      // Volume conservation: col0 lost 100µL, col3 gained 100µL
      // Total across cols 0-3: 2000 + 3000 + 3000 + 4000 = 12000 = 4 × 3000
      expect(col0[0] + col1[0] + col2[0] + col3[0]).toBe(4 * 3000);
    });

    it("decomposition shows labeled dilution steps", async () => {
      const d = await decompose("serialDilution", {
        tipCarrier: "TIP001", tipPosition: 0,
        plateCarrier: "SMP001", platePosition: 0,
        volume: VOL, numDilutions: 2,
      });
      expect(d.count).toBe(8);  // 2 dilutions × 4 steps
      expect(d.subSteps[0].label).toContain("dil 1");
      expect(d.subSteps[4].label).toContain("dil 2");
    });

    it("uses fresh tips for each dilution step", async () => {
      await fillPlate("SMP001", 0, "Sample", 3000);
      await step("serialDilution", {
        tipCarrier: "TIP001", tipPosition: 0,
        plateCarrier: "SMP001", platePosition: 0,
        volume: VOL, numDilutions: 4,
      });

      // 4 dilutions × 8 channels = 32 tips used
      const tracking = await getTracking();
      let tipsUsed = 0;
      for (const [key, used] of Object.entries(tracking.tipUsage)) {
        if (key.startsWith("TIP001:0:") && used) tipsUsed++;
      }
      expect(tipsUsed).toBe(32);

      // PIP should have no tips after completion
      const pip = await getModuleVars("pip");
      expect(pip.active_tip_count).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Timing & Assessment
  // ══════════════════════════════════════════════════════════════════════

  describe("Timing estimates", () => {
    it("transferSamples has timing breakdown per command", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await step("transferSamples", {
        tipCarrier: "TIP001", tipPosition: 0,
        sourceCarrier: "SMP001", sourcePosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: VOL, columns: 1,
      });
      expect(r.totalEstimatedTimeMs).toBeGreaterThan(0);
      // Each command should have timing, with accuracy pinned to a known tier
      // (a bare toBeDefined() passes for accuracy = "" or undefined; this
      // pins it to the documented values).
      for (const cmd of r.commands) {
        expect(cmd.estimatedTimeMs).toBeGreaterThan(0);
        expect(["computed", "hybrid", "estimate"]).toContain(cmd.timingAccuracy);
      }
    });

    it("all PIP commands get computed/hybrid timing", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await step("easyTransfer", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "SMP001", position: 0, column: 0 },
        destPosition: { carrierId: "DST001", position: 0, column: 0 },
        volume: VOL,
      });
      for (const cmd of r.commands) {
        // PIP commands should be computed or hybrid (not estimate)
        expect(["computed", "hybrid"]).toContain(cmd.timingAccuracy);
      }
    });

    it("timing breakdown includes phase details", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await step("easyTransfer", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        sourcePosition: { carrierId: "SMP001", position: 0, column: 0 },
        destPosition: { carrierId: "DST001", position: 0, column: 0 },
        volume: VOL,
      });
      // The aspirate command must exist AND have a populated breakdown.
      // `toBeDefined()` would pass even with an empty object or 0-length array.
      const aspCmd = r.commands.find((c: any) => c.raw.startsWith("C0AS"));
      expect(aspCmd).not.toBeUndefined();
      expect(aspCmd.timingBreakdown).toBeInstanceOf(Array);
      expect(aspCmd.timingBreakdown.length).toBeGreaterThanOrEqual(2);
      // Each phase entry has a string phase name and numeric ms
      for (const phase of aspCmd.timingBreakdown) {
        expect(typeof phase.phase).toBe("string");
        expect(typeof phase.ms).toBe("number");
        expect(phase.ms).toBeGreaterThanOrEqual(0);
      }
      const phases = aspCmd.timingBreakdown.map((b: any) => b.phase);
      expect(phases).toContain("aspirate");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Assessment events from power steps
  // ══════════════════════════════════════════════════════════════════════

  describe("Assessment events", () => {
    it("transferSamples generates TADM events", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await step("transferSamples", {
        tipCarrier: "TIP001", tipPosition: 0,
        sourceCarrier: "SMP001", sourcePosition: 0,
        destCarrier: "DST001", destPosition: 0,
        volume: VOL, columns: 2,
      });
      expect(r.assessments.length).toBeGreaterThan(0);
      const tadm = r.assessments.filter((a: any) => a.category === "tadm");
      // 2 columns × 2 (aspirate + dispense) = 4 TADM events
      expect(tadm.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Plugin extensibility verification
  // ══════════════════════════════════════════════════════════════════════

  describe("Plugin extensibility", () => {
    it("lists all registered modules", async () => {
      const state = await getState();
      const moduleIds = Object.keys(state.modules);
      expect(moduleIds).toContain("pip");
      expect(moduleIds).toContain("h96");
      expect(moduleIds).toContain("iswap");
      expect(moduleIds).toContain("wash");
      expect(moduleIds).toContain("temp");
      expect(moduleIds).toContain("hhs");
      expect(moduleIds).toContain("h384");
      expect(moduleIds).toContain("gripper");
      expect(moduleIds).toContain("autoload");
      expect(moduleIds).toContain("master");
      expect(moduleIds.length).toBe(10);
    });

    it("step types list includes all categories", async () => {
      const types = await apiGet("/steps");
      expect(types.length).toBeGreaterThanOrEqual(29);
      // Single steps
      expect(types).toContain("aspirate");
      expect(types).toContain("getPlate");
      expect(types).toContain("gripperGetTool");
      // Easy steps
      expect(types).toContain("easyTransfer");
      expect(types).toContain("easyTransport");
      // Power steps
      expect(types).toContain("transferSamples");
      expect(types).toContain("addReagent");
      expect(types).toContain("serialDilution");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Temperature step
  // ══════════════════════════════════════════════════════════════════════

  describe("Temperature steps", () => {
    it("setTemperature changes TCC target", async () => {
      const r = await step("setTemperature", { temperature: 37, heaterNumber: 1 });
      expect(r.success).toBe(true);
      const temp = await getModuleVars("temp");
      expect(temp.target_temp_01c).toBe(370);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 96-Head Easy Steps
  // ══════════════════════════════════════════════════════════════════════

  describe("96-Head Easy Steps", () => {
    it("easy96Aspirate: move + pickup + move + aspirate", async () => {
      await fillPlate("SMP001", 0, "Sample", 2000);
      const r = await step("easy96Aspirate", {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        aspiratePosition: { carrierId: "SMP001", position: 0, column: 0 },
        volume: VOL,
      });
      expect(r.success).toBe(true);
      expect(r.commands.length).toBeGreaterThanOrEqual(4);

      const h96 = await getModuleVars("h96");
      expect(h96.tips_fitted).toBe(true);
      expect(h96.volume_01ul).toBe(1000);
    });
  });
});
