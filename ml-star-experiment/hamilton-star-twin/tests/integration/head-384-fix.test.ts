/**
 * Phase 3: 384-Head History Fix + 96/384 TADM Curves
 *
 * Tests:
 * - 384-head deep history preserves tip state after move
 * - 96-head and 384-head aspirate/dispense produce TADM curve data
 * - 384-head rejects volume > 50uL
 */

// FAILURE INJECTION
// If the TADM curve generator shortens the curve below 10 points or drops
// the upperBand/lowerBand arrays, the 96-head-aspirate-TADM test fails at
// the curve-length and band-parity assertions. If peakPressure becomes 0
// or negative for aspirates, the test fails the `> 10` magnitude check.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  resetAndInit, sendCommand, sendCompletion, getModuleVars, getModuleStates,
  getAssessments, isServerUp, clearDeckCache, flush,
} from "./helpers";

describe("Phase 3: 384-Head + TADM", () => {
  beforeAll(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin server not running on localhost:8222");
  });

  beforeEach(async () => {
    clearDeckCache();
    await resetAndInit();
  });

  // ── 384-Head History Pseudo-State ──────────────────────────────────

  describe("384-Head move preserves tip state (deep history)", () => {

    it("tips survive a move (pickup → move → flush → tips still fitted)", async () => {
      // Init 384-head
      await sendCommand("C0JIid0300xs05000yk2500");
      await flush("move384.done", 100);

      // Pickup tips
      const r1 = await sendCommand("C0JBid0301xs05000yk2500tt01");
      expect(r1.accepted).toBe(true);

      const vars1 = await getModuleVars("h384");
      expect(vars1.tips_fitted).toBe(true);

      // Move the 384-head (this exits idle384 → moving384)
      const r2 = await sendCommand("C0ENid0302xs06000yh3000");
      expect(r2.accepted).toBe(true);

      // Flush the move completion
      await flush("move384.done", 100);

      // After move: tips_fitted MUST still be true (deep history restores)
      const vars2 = await getModuleVars("h384");
      expect(vars2.tips_fitted).toBe(true);
      expect(vars2.pos_x).toBeGreaterThan(0);
    });

    it("volume survives a move (aspirate → move → flush → volume preserved)", async () => {
      await sendCommand("C0JIid0310xs05000yk2500");
      await flush("move384.done", 100);

      // Pickup + aspirate
      await sendCommand("C0JBid0311xs05000yk2500tt01");
      const r = await sendCommand("C0JAid0312af00200");  // 20uL
      expect(r.accepted).toBe(true);

      const vars1 = await getModuleVars("h384");
      expect(vars1.volume_01ul).toBe(200);

      // Move
      await sendCommand("C0ENid0313xs07000yh3500");
      await flush("move384.done", 100);

      // Volume must be preserved
      const vars2 = await getModuleVars("h384");
      expect(vars2.volume_01ul).toBe(200);
      expect(vars2.tips_fitted).toBe(true);
    });

    it("full aspirate-move-dispense sequence works", async () => {
      await sendCommand("C0JIid0320xs05000yk2500");
      await flush("move384.done", 100);

      // Pickup → aspirate → move → dispense → eject
      await sendCommand("C0JBid0321xs05000yk2500tt01");
      await sendCommand("C0JAid0322af00300");  // 30uL

      // Move to dispense position
      await sendCommand("C0ENid0323xs07000yh3500");
      await flush("move384.done", 100);

      // Dispense (should work because tips+volume preserved by history)
      const r = await sendCommand("C0JDid0324df00300");
      expect(r.accepted).toBe(true);

      const vars = await getModuleVars("h384");
      expect(vars.volume_01ul).toBe(0);  // All dispensed

      // Eject
      const r2 = await sendCommand("C0JCid0325");
      expect(r2.accepted).toBe(true);
      expect((await getModuleVars("h384")).tips_fitted).toBe(false);
    });
  });

  // ── 384-Head Volume Validation ─────────────────────────────────────

  describe("384-head volume validation", () => {
    it("rejects aspirate volume > 50uL", async () => {
      await sendCommand("C0JIid0330xs05000yk2500");
      await flush("move384.done", 100);
      await sendCommand("C0JBid0331xs05000yk2500tt01");

      // 60uL = 600 in 0.1uL → exceeds 500 (50uL) limit
      const r = await sendCommand("C0JAid0332af00600");
      expect(r.accepted).toBe(false);
    });
  });

  // ── 96-Head TADM Curves ────────────────────────────────────────────

  describe("96-head TADM curve generation", () => {

    it("96-head aspirate produces TADM curve data in assessment", async () => {
      // 96-head: move to tip rack, pickup, aspirate
      // Use tip rack coordinates (TIP001 is at track 1-6, position 0)
      const tipX = "01033";  // TIP001 area
      const tipY = "01475";  // Site 0 + offset
      await sendCommand(`C0EMid0340xs${tipX}yh${tipY}`);
      await flush("move96.done", 100);
      await sendCommand(`C0EPid0341xs${tipX}yh${tipY}tt01`);
      await sendCommand("C0EAid0342af01000");  // 100uL

      const assessments = await getAssessments(10);
      const tadmEvents = assessments.filter((a: any) =>
        a.category === "tadm" && a.module === "h96" && a.command === "C0EA"
      );
      expect(tadmEvents.length).toBeGreaterThan(0);

      // TADM data must be a valid curve — not just "defined" (an empty {} would pass toBeDefined).
      const tadm = tadmEvents[0].tadm;
      expect(tadm).not.toBeNull();
      expect(tadm.curve).toBeInstanceOf(Array);
      expect(tadm.curve.length).toBeGreaterThanOrEqual(10);
      // Each curve point must have numeric time and pressure
      for (const pt of tadm.curve.slice(0, 3)) {
        expect(typeof pt.time).toBe("number");
        expect(typeof pt.pressure).toBe("number");
      }
      // Peak pressure for an aspirate is a positive magnitude
      expect(typeof tadm.peakPressure).toBe("number");
      expect(tadm.peakPressure).toBeGreaterThan(10);  // meaningful magnitude
      expect(tadm.operation).toBe("aspirate");
      // Tolerance band arrays must be sized same as the curve
      expect(tadm.upperBand).toBeInstanceOf(Array);
      expect(tadm.upperBand.length).toBe(tadm.curve.length);
      expect(tadm.lowerBand).toBeInstanceOf(Array);
      expect(tadm.lowerBand.length).toBe(tadm.curve.length);
    });

    it("96-head dispense produces TADM curve data", async () => {
      const tipX = "01033";
      const tipY = "01475";
      await sendCommand(`C0EMid0350xs${tipX}yh${tipY}`);
      await flush("move96.done", 100);
      await sendCommand(`C0EPid0351xs${tipX}yh${tipY}tt01`);
      await sendCommand("C0EAid0352af01000");

      // Move and dispense
      await sendCommand("C0EMid0353xs03000yh3000");
      await flush("move96.done", 100);
      await sendCommand("C0EDid0354df01000");

      const assessments = await getAssessments(20);
      const dispTadm = assessments.filter((a: any) =>
        a.category === "tadm" && a.module === "h96" && a.command === "C0ED"
      );
      expect(dispTadm.length).toBeGreaterThan(0);
      expect(dispTadm[0].tadm?.operation).toBe("dispense");
    });
  });

  // ── 384-Head TADM Curves ───────────────────────────────────────────

  describe("384-head TADM curve generation", () => {

    it("384-head aspirate produces TADM curve data", async () => {
      await sendCommand("C0JIid0360xs05000yk2500");
      await flush("move384.done", 100);
      await sendCommand("C0JBid0361xs05000yk2500tt01");
      await sendCommand("C0JAid0362af00200");  // 20uL

      const assessments = await getAssessments(10);
      const tadmEvents = assessments.filter((a: any) =>
        a.category === "tadm" && a.module === "h384" && a.command === "C0JA"
      );
      expect(tadmEvents.length).toBeGreaterThan(0);

      // Full TADM contract — not just "defined"
      const tadm = tadmEvents[0].tadm;
      expect(tadm).not.toBeNull();
      expect(tadm.curve).toBeInstanceOf(Array);
      expect(tadm.curve.length).toBeGreaterThanOrEqual(10);
      for (const pt of tadm.curve.slice(0, 3)) {
        expect(typeof pt.time).toBe("number");
        expect(typeof pt.pressure).toBe("number");
      }
      expect(typeof tadm.peakPressure).toBe("number");
      expect(tadm.peakPressure).toBeGreaterThan(10);
      expect(tadm.operation).toBe("aspirate");
    });
  });
});
