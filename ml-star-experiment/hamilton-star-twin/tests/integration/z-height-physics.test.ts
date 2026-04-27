/**
 * Phase 2: Z-Height Physics Integration Tests
 *
 * Verifies SubmergeDepth, FluidHeight, and LiquidFollowing parameters
 * produce correct Z positions and physical effects in the digital twin.
 *
 * Prerequisites: twin must be running at http://localhost:8222/
 */

// FAILURE INJECTION
// If the zp annotation source mistakenly returns "default" or "" instead of
// "computed"/"user", the zp-annotation-source tests fail at the
// `.source.toBe(...)` assertions. If the zp value is returned as a number
// instead of a 5-digit-padded string, the regex match fails.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  resetAndInit, sendCommand, getModuleVars, getAssessments,
  apiPost, isServerUp, wellXY, pad5, clearDeckCache, flush, fillPlate,
  getWellVolume,
} from "./helpers";

/** Execute a VENUS step via the /step endpoint */
async function step(type: string, params: Record<string, any> = {}): Promise<any> {
  return apiPost("/step", { type, params });
}

// ── Common deck addresses ───────────────────────────────────────────────

const TIPS_COL0 = { carrierId: "TIP001", position: 0, column: 0 };
const TIPS_COL1 = { carrierId: "TIP001", position: 0, column: 1 };
const TIPS_COL2 = { carrierId: "TIP001", position: 0, column: 2 };
const TIPS_COL3 = { carrierId: "TIP001", position: 0, column: 3 };
const TIPS_COL4 = { carrierId: "TIP001", position: 0, column: 4 };
const TIPS_COL5 = { carrierId: "TIP001", position: 0, column: 5 };
const TIPS_COL6 = { carrierId: "TIP001", position: 0, column: 6 };
const TIPS_COL7 = { carrierId: "TIP001", position: 0, column: 7 };
const TIPS_COL8 = { carrierId: "TIP001", position: 0, column: 8 };
const TIPS_COL9 = { carrierId: "TIP001", position: 0, column: 9 };
const TIPS_COL10 = { carrierId: "TIP001", position: 0, column: 10 };
const SRC_COL0 = { carrierId: "SMP001", position: 0, column: 0 };
const SRC_COL1 = { carrierId: "SMP001", position: 0, column: 1 };
const SRC_COL2 = { carrierId: "SMP001", position: 0, column: 2 };
const SRC_COL3 = { carrierId: "SMP001", position: 0, column: 3 };
const SRC_COL4 = { carrierId: "SMP001", position: 0, column: 4 };
const SRC_COL5 = { carrierId: "SMP001", position: 0, column: 5 };
const DST_COL0 = { carrierId: "DST001", position: 0, column: 0 };
const DST_COL1 = { carrierId: "DST001", position: 0, column: 1 };
const DST_COL2 = { carrierId: "DST001", position: 0, column: 2 };
const DST_COL3 = { carrierId: "DST001", position: 0, column: 3 };

describe("Phase 2: Z-Height Physics", () => {
  beforeAll(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin server not running on localhost:8222");
  });

  beforeEach(async () => {
    clearDeckCache();
    await resetAndInit();
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2A: Aspirate Z Parameters
  // ══════════════════════════════════════════════════════════════════════

  describe("Aspirate Z parameters in FW command", () => {

    it("aspirate sends zp param in FW command", async () => {
      // Fill well with liquid so Z can be computed from volume
      await fillPlate("SMP001", 0, "Water", 2000);  // 200uL per well

      // Pick up tips first
      const tipResult = await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });
      expect(tipResult.success).toBe(true);

      // Aspirate with defaults — should have zp in command string
      const r = await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      expect(r.commands.length).toBeGreaterThanOrEqual(1);

      // The FW command raw string should contain zp parameter
      const aspCmd = r.commands[r.commands.length - 1];
      expect(aspCmd.raw).toMatch(/zp\d{5}/);
    });

    it("aspirate sends th (traverse height) param in FW command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL1, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL1,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      expect(aspCmd.raw).toMatch(/th\d{5}/);
    });

    it("aspirate sends ip (submerge depth) param in FW command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL2, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL2,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      expect(aspCmd.raw).toMatch(/ip\d{5}/);
    });

    it("aspirate sends lf (liquid following) param in FW command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL3, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL3,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      // lf1 for liquid following ON (default)
      expect(aspCmd.raw).toMatch(/lf[01]/);
    });

    it("aspirate with submergeDepth=5mm produces lower tipZ than default 2mm", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);

      // First: aspirate with default submerge (2mm)
      await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });
      const r1 = await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
        submergeDepth: 2.0,
      });
      expect(r1.success).toBe(true);
      const cmd1 = r1.commands[r1.commands.length - 1];
      const zp1Match = cmd1.raw.match(/zp(\d{5})/);
      expect(zp1Match).not.toBeNull();
      const zp1 = parseInt(zp1Match![1], 10);

      // Reset, refill, and aspirate with deeper submerge
      await resetAndInit();
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL1, channelMask: 1 });
      const r2 = await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
        submergeDepth: 5.0,
      });
      expect(r2.success).toBe(true);
      const cmd2 = r2.commands[r2.commands.length - 1];
      const zp2Match = cmd2.raw.match(/zp(\d{5})/);
      expect(zp2Match).not.toBeNull();
      const zp2 = parseInt(zp2Match![1], 10);

      // Deeper submerge should give a LOWER Z value (closer to bottom)
      expect(zp2).toBeLessThan(zp1);
    });

    it("aspirate with fixedHeight sets Z from well bottom", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL4, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL4,
        volume: 50,
        channelMask: 1,
        fixedHeight: 5.0,  // 5mm from well bottom
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      const zpMatch = aspCmd.raw.match(/zp(\d{5})/);
      expect(zpMatch).not.toBeNull();

      // The Z value should reflect the fixed height calculation:
      // wellBottomZ + fixedHeight*10 = (144 - 112) + 50 = 82 (0.1mm)
      // Actual value depends on labware height, but should be > 0
      const zpVal = parseInt(zpMatch![1], 10);
      expect(zpVal).toBeGreaterThan(0);
      expect(zpVal).toBeLessThan(1500);  // Should be within reasonable range
    });

    it("aspirate with liquidFollowing=false sends lf0 in command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL5, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL5,
        volume: 50,
        channelMask: 1,
        liquidFollowing: false,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      expect(aspCmd.raw).toContain("lf0");
    });

    it("aspirate with liquidFollowing=true (default) sends lf1 in command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL6, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
        // liquidFollowing defaults to true from LC
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      expect(aspCmd.raw).toContain("lf1");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2B: Dispense Z Parameters
  // ══════════════════════════════════════════════════════════════════════

  describe("Dispense Z parameters in FW command", () => {

    it("dispense with fixedHeight includes zp in command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);

      // Pick up tips, aspirate, then dispense
      await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });
      await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
      });

      const r = await step("dispense", {
        position: DST_COL0,
        volume: 50,
        channelMask: 1,
        fixedHeight: 5.0,  // 5mm from well bottom
      });
      expect(r.success).toBe(true);
      const dspCmd = r.commands[r.commands.length - 1];
      expect(dspCmd.raw).toMatch(/zp\d{5}/);
    });

    it("dispense default includes zp from liquid class (10mm)", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL1, channelMask: 1 });
      await step("aspirate", { position: SRC_COL1, volume: 50, channelMask: 1 });

      // Dispense with no fixedHeight — should use LC default (10mm)
      const r = await step("dispense", {
        position: DST_COL1,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const dspCmd = r.commands[r.commands.length - 1];
      expect(dspCmd.raw).toMatch(/zp\d{5}/);
      expect(dspCmd.raw).toMatch(/th\d{5}/);
    });

    it("dispense with touchOff sends to param in command", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL2, channelMask: 1 });
      await step("aspirate", { position: SRC_COL2, volume: 50, channelMask: 1 });

      const r = await step("dispense", {
        position: DST_COL2,
        volume: 50,
        channelMask: 1,
        touchOff: true,
      });
      expect(r.success).toBe(true);
      const dspCmd = r.commands[r.commands.length - 1];
      expect(dspCmd.raw).toContain("to1");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2C: Assessment Z Telemetry
  // ══════════════════════════════════════════════════════════════════════

  describe("Assessment Z telemetry", () => {

    it("assessment contains Z telemetry data on aspirate", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL0,
        volume: 100,
        channelMask: 1,
      });
      expect(r.success).toBe(true);

      // Check assessments for Z telemetry
      const assessments = await getAssessments(20);
      const zTelemetry = assessments.filter((a: any) =>
        a.command === "C0AS" && a.data?.tipZ_01mm !== undefined
      );
      expect(zTelemetry.length).toBeGreaterThan(0);
      const tel = zTelemetry[0];
      expect(tel.data.tipZ_01mm).toBeGreaterThan(0);
      expect(tel.data.submergeDepth_mm).toBeGreaterThanOrEqual(0);
      expect(typeof tel.data.liquidFollowing).toBe("boolean");
    });

    it("assessment Z telemetry includes crashMargin", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL1, channelMask: 1 });

      await step("aspirate", {
        position: SRC_COL1,
        volume: 50,
        channelMask: 1,
      });

      const assessments = await getAssessments(20);
      const zTelemetry = assessments.filter((a: any) =>
        a.command === "C0AS" && a.data?.crashMargin_01mm !== undefined
      );
      expect(zTelemetry.length).toBeGreaterThan(0);
      // Crash margin should be positive (tip is above well bottom)
      expect(zTelemetry[0].data.crashMargin_01mm).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2D: Volume Conservation with Z Parameters
  // ══════════════════════════════════════════════════════════════════════

  describe("Volume conservation with Z params", () => {

    it("full TP+AS+DS+TR cycle still conserves volume", async () => {
      // Fill source plate with known volume
      await fillPlate("SMP001", 0, "Water", 1000);  // 100uL per well

      // Get initial volume
      const volBefore = await getWellVolume("SMP001", 0, 0);
      expect(volBefore).toBe(1000);  // 100uL in 0.1uL

      // Do a full transfer: TipPickUp + Aspirate + Dispense + TipEject
      const r = await step("easyTransfer", {
        tipPosition: TIPS_COL0,
        sourcePosition: SRC_COL0,
        destPosition: DST_COL0,
        volume: 50,  // 50uL
        channelMask: 1,
      });
      expect(r.success).toBe(true);

      // Source should have lost volume, dest should have gained
      const srcAfter = await getWellVolume("SMP001", 0, 0);
      const dstAfter = await getWellVolume("DST001", 0, 0);

      // Volume removed from source (accounting for correction, should be ~500 in 0.1uL)
      expect(srcAfter).toBeLessThan(volBefore);
      expect(srcAfter).toBeGreaterThanOrEqual(0);

      // Destination should have gained approximately the transferred volume
      expect(dstAfter).toBeGreaterThan(0);

      // Total volume should be approximately conserved
      // (correction curves may add a small delta, so use tolerance)
      const totalAfter = srcAfter + dstAfter;
      expect(totalAfter).toBeGreaterThan(volBefore * 0.9);
      expect(totalAfter).toBeLessThan(volBefore * 1.1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2E: Liquid Following Physics
  // ══════════════════════════════════════════════════════════════════════

  describe("Liquid following physics", () => {

    it("liquid following ON: large aspirate no air warning", async () => {
      // Fill well with moderate volume
      await fillPlate("SMP001", 0, "Water", 2000);  // 200uL
      await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });

      // Aspirate 150uL with liquid following ON — tip tracks surface, no air
      const r = await step("aspirate", {
        position: SRC_COL0,
        volume: 150,
        channelMask: 1,
        liquidFollowing: true,
      });
      expect(r.success).toBe(true);

      // Should NOT have a "Liquid following OFF" air risk warning
      const assessments = await getAssessments(20);
      const airRisk = assessments.filter((a: any) =>
        a.command === "C0AS" &&
        a.category === "empty_aspiration" &&
        a.description?.includes("Liquid following OFF")
      );
      expect(airRisk.length).toBe(0);
    });

    it("liquid following OFF: large aspirate gets air risk warning", async () => {
      // Fill well with 1000uL (10000 in 0.1uL)
      await fillPlate("SMP001", 0, "Water", 10000);  // 1000uL per well

      await step("tipPickUp", { position: TIPS_COL1, channelMask: 1 });

      // Aspirate 900uL with liquid following OFF
      // For a 96-well plate with ~6.9mm diameter:
      //   cross section = pi * 3.45^2 = ~37.4 mm^2
      //   900uL / 37.4 mm^2 = ~24mm surface drop
      // This is a massive drop — the surface will fall well below the tip
      const r = await step("aspirate", {
        position: SRC_COL1,
        volume: 900,
        channelMask: 1,
        liquidFollowing: false,
        lldMode: 1,  // cLLD to trigger LLD detection for physics
      });
      // Command should still succeed (FW doesn't reject based on physics)
      expect(r.success).toBe(true);

      // Check assessments for the liquid following air risk
      const assessments = await getAssessments(30);
      const airRisk = assessments.filter((a: any) =>
        a.command === "C0AS" &&
        a.category === "empty_aspiration" &&
        a.description?.includes("Liquid following OFF")
      );
      // This warning should fire because the surface drops below the tip
      expect(airRisk.length).toBeGreaterThan(0);
      if (airRisk.length > 0) {
        expect(airRisk[0].data?.liquidFollowing).toBe(false);
        expect(airRisk[0].data?.surfaceDrop_mm).toBeGreaterThan(5);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2F: Annotation Correctness
  // ══════════════════════════════════════════════════════════════════════

  describe("Annotations for Z parameters", () => {

    it("aspirate annotations include zp, th, ip, lf keys", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];

      // Check annotations exist for Z params
      const annotations = aspCmd.annotations || [];
      const keys = annotations.map((a: any) => a.key);
      expect(keys).toContain("zp");
      expect(keys).toContain("th");
      expect(keys).toContain("ip");
      expect(keys).toContain("lf");
    });

    it("aspirate zp annotation source is 'computed' when calculated from volume", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL2, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL2,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      const zpAnnotation = aspCmd.annotations?.find((a: any) => a.key === "zp");
      // Verify annotation has a concrete value + source, not just "defined".
      // toBeDefined() would pass for {} — we need the actual zp value shape.
      expect(zpAnnotation).not.toBeUndefined();
      expect(typeof zpAnnotation!.value).toBe("string");
      expect(zpAnnotation!.value).toMatch(/^\d{5}$/);  // 5-digit zero-padded FW value
      expect(zpAnnotation!.source).toBe("computed");
    });

    it("aspirate zp annotation source is 'user' when fixedHeight given", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL3, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL3,
        volume: 50,
        channelMask: 1,
        fixedHeight: 5.0,
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];
      const zpAnnotation = aspCmd.annotations?.find((a: any) => a.key === "zp");
      expect(zpAnnotation).not.toBeUndefined();
      expect(typeof zpAnnotation!.value).toBe("string");
      expect(zpAnnotation!.value).toMatch(/^\d{5}$/);
      expect(zpAnnotation!.source).toBe("user");
    });

    it("dispense annotations include zp and th when labware found", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL4, channelMask: 1 });
      await step("aspirate", { position: SRC_COL4, volume: 50, channelMask: 1 });

      const r = await step("dispense", {
        position: DST_COL0,
        volume: 50,
        channelMask: 1,
      });
      expect(r.success).toBe(true);
      const dspCmd = r.commands[r.commands.length - 1];
      const annotations = dspCmd.annotations || [];
      const keys = annotations.map((a: any) => a.key);
      expect(keys).toContain("zp");
      expect(keys).toContain("th");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2G: Edge Cases
  // ══════════════════════════════════════════════════════════════════════

  describe("Edge cases", () => {

    it("aspirate from empty well uses fallback Z", async () => {
      // Do NOT fill plate — wells are empty
      await step("tipPickUp", { position: TIPS_COL0, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL0,
        volume: 50,
        channelMask: 1,
      });
      // Command should succeed at FW level (real HW also aspirates from empty wells)
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];

      // Should still have a zp param (fallback Z close to bottom)
      const zpMatch = aspCmd.raw.match(/zp(\d{5})/);
      expect(zpMatch).not.toBeNull();
      const zpVal = parseInt(zpMatch![1], 10);
      // Fallback: 2mm above well bottom = wellBottomZ + 20
      expect(zpVal).toBeGreaterThan(0);
    });

    it("aspirate with custom traverseHeight overrides default 145mm", async () => {
      await fillPlate("SMP001", 0, "Water", 2000);
      await step("tipPickUp", { position: TIPS_COL5, channelMask: 1 });

      const r = await step("aspirate", {
        position: SRC_COL5,
        volume: 50,
        channelMask: 1,
        traverseHeight: 120,  // 120mm instead of 145mm
      });
      expect(r.success).toBe(true);
      const aspCmd = r.commands[r.commands.length - 1];

      // th should be 1200 (120mm * 10)
      const thMatch = aspCmd.raw.match(/th(\d{5})/);
      expect(thMatch).not.toBeNull();
      const thVal = parseInt(thMatch![1], 10);
      expect(thVal).toBe(1200);
    });

    it("raw FW command with zp still validates (existing tests unbroken)", async () => {
      // Verify that the raw command path still works when zp is present
      await fillPlate("SMP001", 0, "Water", 2000);
      const tipPos = await wellXY("TIP001", 0, 0);
      await sendCommand(`C0TPid0500xp${tipPos.xp}yp${tipPos.yp}tm1tt04`);

      const aspPos = await wellXY("SMP001", 0, 0);
      // Send raw command with zp parameter
      const r = await sendCommand(`C0ASid0501tm1xp${aspPos.xp}yp${aspPos.yp}zp00080av01000as2500ta050ba0400lm0wt05`);
      expect(r.accepted).toBe(true);
    });
  });
});
