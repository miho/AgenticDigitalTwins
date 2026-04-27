/**
 * Advanced-physics plugin tests (Phase 4 Step 4.C).
 *
 * Each observation (foam / drip / meniscus) is exercised with a
 * positive, a negative, and a boundary case per the phase-plan gate.
 *
 * FAILURE INJECTION
 *   - If checkFoam forgets to multiply by FOAM_SPEED_RATIO, the boundary
 *     test "exactly at threshold" fires a spurious event.
 *   - If checkDrip compares `ta` against the tunable with >=, a ta value
 *     exactly equal to DRIP_MIN_TRANSPORT_AIR wrongly emits.
 *   - If checkMeniscus uses the wrong unit scale, the tolerance check
 *     comparing 2.0mm ↔ 20 (0.1mm) disagrees on the boundary.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  AdvancedPhysics,
  FOAM_SPEED_RATIO,
  MENISCUS_MISMATCH_TOLERANCE,
  DRIP_MIN_TRANSPORT_AIR,
  DEFAULT_LIQUID_CLASS,
} = require("../../dist/twin/plugins/advanced-physics");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getLiquidClass } = require("../../dist/twin/liquid-classes");

function lc() {
  const out = getLiquidClass(DEFAULT_LIQUID_CLASS);
  if (!out) throw new Error(`liquid class ${DEFAULT_LIQUID_CLASS} missing from catalogue`);
  return out;
}

describe("AdvancedPhysics (Phase 4 Step 4.C)", () => {
  describe("Foam", () => {
    it("emits a foam warning when dispense speed exceeds ratio × class default", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const data = { ds: Math.ceil(klass.dispense.speed * FOAM_SPEED_RATIO + 100) };
      const events = plugin.assess("C0DS", data);
      const foam = events.find((e: any) => e.category === "foam");
      expect(foam).toBeTruthy();
      expect(foam.severity).toBe("warning");
    });

    it("does not emit a foam warning at normal dispense speed", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const events = plugin.assess("C0DS", { ds: klass.dispense.speed });
      expect(events.find((e: any) => e.category === "foam")).toBeUndefined();
    });

    it("boundary: exactly at the threshold emits nothing (inclusive below)", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const events = plugin.assess("C0DS", { ds: Math.floor(klass.dispense.speed * FOAM_SPEED_RATIO) });
      expect(events.find((e: any) => e.category === "foam")).toBeUndefined();
    });
  });

  describe("Drip", () => {
    it("emits a drip warning when transport air is absent", () => {
      const plugin = new AdvancedPhysics();
      const events = plugin.assess("C0AS", { ip: 20, ta: 0 });
      const drip = events.find((e: any) => e.category === "drip");
      expect(drip).toBeTruthy();
      expect(drip.severity).toBe("warning");
    });

    it("does not emit a drip warning when transport air meets the minimum", () => {
      const plugin = new AdvancedPhysics();
      const events = plugin.assess("C0AS", { ip: 20, ta: DRIP_MIN_TRANSPORT_AIR });
      expect(events.find((e: any) => e.category === "drip")).toBeUndefined();
    });

    it("boundary: one unit below the minimum still fires", () => {
      const plugin = new AdvancedPhysics();
      const events = plugin.assess("C0AS", { ip: 20, ta: DRIP_MIN_TRANSPORT_AIR - 1 });
      expect(events.find((e: any) => e.category === "drip")).toBeTruthy();
    });
  });

  describe("Meniscus", () => {
    it("warns when submerge depth is well below the class default", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const def_01mm = Math.round((klass.aspiration.submergeDepth ?? 2.0) * 10);
      const ip = Math.floor(def_01mm * (1 - MENISCUS_MISMATCH_TOLERANCE) - 1);
      const events = plugin.assess("C0AS", { ip, ta: 100 });
      const men = events.find((e: any) => e.category === "meniscus");
      expect(men).toBeTruthy();
      expect(men.severity).toBe("warning");
    });

    it("does not warn when submerge depth matches the class default", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const ip = Math.round((klass.aspiration.submergeDepth ?? 2.0) * 10);
      const events = plugin.assess("C0AS", { ip, ta: 100 });
      expect(events.find((e: any) => e.category === "meniscus")).toBeUndefined();
    });

    it("boundary: at the outer tolerance edge no warning fires", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const def_01mm = Math.round((klass.aspiration.submergeDepth ?? 2.0) * 10);
      const ip = Math.round(def_01mm * (1 + MENISCUS_MISMATCH_TOLERANCE));
      const events = plugin.assess("C0AS", { ip, ta: 100 });
      expect(events.find((e: any) => e.category === "meniscus")).toBeUndefined();
    });

    it("flags deep submerge at `info` severity", () => {
      const plugin = new AdvancedPhysics();
      const klass = lc();
      const def_01mm = Math.round((klass.aspiration.submergeDepth ?? 2.0) * 10);
      const ip = Math.ceil(def_01mm * (1 + MENISCUS_MISMATCH_TOLERANCE) + 10);
      const events = plugin.assess("C0AS", { ip, ta: 100 });
      const men = events.find((e: any) => e.category === "meniscus");
      expect(men).toBeTruthy();
      expect(men.severity).toBe("info");
    });
  });

  describe("Dispatch", () => {
    it("returns an empty array for unhandled events", () => {
      const plugin = new AdvancedPhysics();
      const events = plugin.assess("C0RF", {});
      expect(events).toEqual([]);
    });

    it("respects a custom liquid-class resolver", () => {
      const plugin = new AdvancedPhysics({ resolveLiquidClass: () => "__nonexistent__" });
      // Unknown class → no observations rather than a crash.
      const events = plugin.assess("C0DS", { ds: 100000 });
      expect(events).toEqual([]);
    });
  });
});
