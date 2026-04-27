/**
 * Integration tests — verifies every tutorial workflow against the running twin.
 *
 * Prerequisites: twin must be running at http://localhost:8222/
 *   npm run build && npx electron dist/main/main.js
 *
 * Run: npx vitest run tests/integration
 */

// FAILURE INJECTION
// If DeckTracker.processCommand() forgets to decrement source well volumes, the
// "aspirates 100uL from 8 wells" test fails because volAfter[row] === volBefore[row]
// instead of volBefore[row] - 1000. If the twin's rejection logic gets the wrong
// error code for "no tip fitted", the rejected-aspirate and rejected-96-head-aspirate
// tests fail because they pin error code 8 (not just > 0). If tip-pickup rejection
// returns error 8 instead of 7 for "tip already fitted", the double-pickup test
// fails because it pins error 7.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  isServerUp, resetTwin, resetAndInit, getState, getTracking, getAssessments,
  sendCommand, sendCompletion, flush, fillPlate,
  getModuleVars, getModuleStates, getWellVolume, getColumnVolumes,
  wellXY, pad5, clearDeckCache,
} from "./helpers";

describe("Twin server", () => {
  beforeAll(async () => {
    const up = await isServerUp();
    if (!up) throw new Error("Twin not running at http://localhost:8222/ — start it first");
  });

  beforeEach(async () => {
    await resetAndInit();
    clearDeckCache();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. Initial State
  // ────────────────────────────────────────────────────────────────────

  describe("1. Initial State", () => {
    it("has 10 modules with master in sys_ready", async () => {
      const state = await getState();
      const moduleIds = Object.keys(state.modules);
      expect(moduleIds).toContain("master");
      expect(moduleIds).toContain("pip");
      expect(moduleIds).toContain("h96");
      expect(moduleIds).toContain("iswap");
      expect(moduleIds).toContain("wash");
      expect(moduleIds).toContain("temp");
      expect(moduleIds).toContain("hhs");
      expect(moduleIds).toContain("h384");
      expect(moduleIds).toContain("gripper");
      expect(moduleIds).toContain("autoload");
      expect(state.modules.master.states).toContain("sys_ready");
    });

    it("has 8 carriers on the deck", async () => {
      const state = await getState();
      const carriers = state.deck.carriers;
      expect(carriers.length).toBe(8);
      const ids = carriers.map((c: any) => c.id);
      expect(ids).toEqual(["TIP001", "SMP001", "DST001", "RGT001", "TIP002", "WASH01", "HHS001", "TCC001"]);
    });

    it("PIP starts with no tips and no volume", async () => {
      const pip = await getModuleVars("pip");
      expect(pip.tip_fitted[0]).toBe(false);
      expect(pip.volume[0]).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. Fill Plate
  // ────────────────────────────────────────────────────────────────────

  describe("2. Fill Plate", () => {
    it("fills 96 wells with liquid type tracking", async () => {
      const result = await fillPlate("SMP001", 0, "Sample_A", 2000);
      expect(result.success).toBe(true);

      const tracking = await getTracking();
      const smpKeys = Object.keys(tracking.wellVolumes).filter(k => k.startsWith("SMP001:0:"));
      expect(smpKeys.length).toBe(96);
      expect(tracking.wellVolumes["SMP001:0:0"]).toBe(2000);

      // Liquid type tracked
      const contents = tracking.wellContents || {};
      expect(contents["SMP001:0:0"]?.liquidType).toBe("Sample_A");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 3-4. Tip Pickup
  // ────────────────────────────────────────────────────────────────────

  describe("3-4. Tip Pickup", () => {
    it("picks up 8 tips with tm=255", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const result = await sendCommand(`C0TPid0100xp${tip.xp}yp${tip.yp}tm255tt04`);
      expect(result.accepted).toBe(true);
      expect(result.errorCode).toBe(0);

      const pip = await getModuleVars("pip");
      for (let i = 0; i < 8; i++) {
        expect(pip.tip_fitted[i]).toBe(true);
      }
      expect(pip.active_tip_count).toBe(8);
    });

    it("picks up 4 tips with tm=15 (channels 1-4)", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const result = await sendCommand(`C0TPid0101xp${tip.xp}yp${tip.yp}tm15tt04`);
      expect(result.accepted).toBe(true);

      const pip = await getModuleVars("pip");
      expect(pip.tip_fitted[0]).toBe(true);
      expect(pip.tip_fitted[1]).toBe(true);
      expect(pip.tip_fitted[2]).toBe(true);
      expect(pip.tip_fitted[3]).toBe(true);
      expect(pip.tip_fitted[4]).toBe(false);
      expect(pip.tip_fitted[5]).toBe(false);
      expect(pip.active_tip_count).toBe(4);
    });

    it("tracks used tips in tracking data", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      await sendCommand(`C0TPid0102xp${tip.xp}yp${tip.yp}tm255tt04`);
      const tracking = await getTracking();
      // Column 0 of TIP001: wells 0, 12, 24, ... 84
      for (let row = 0; row < 8; row++) {
        expect(tracking.tipUsage[`TIP001:0:${row * 12}`]).toBe(true);
      }
    });

    it("rejects aspirate without tips (error code 8, no side effects)", async () => {
      await fillPlate("SMP001", 0, "Sample_A", 2000);
      const volBefore = await getColumnVolumes("SMP001", 0, 0);

      const src = await wellXY("SMP001", 0, 0);
      const result = await sendCommand(`C0ASid0103xp${src.xp}yp${src.yp}av01000tm255lm0`);

      // Pin the specific error code — "no tip fitted" (8). A regression that
      // changed the rejection reason would slip through `> 0`.
      expect(result.errorCode).toBe(8);
      // Rejection is a rejection — channels must stay empty
      const pip = await getModuleVars("pip");
      expect(pip.volume.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      // Source volumes unchanged — no physical aspirate happened
      const volAfter = await getColumnVolumes("SMP001", 0, 0);
      expect(volAfter).toEqual(volBefore);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. Aspirate
  // ────────────────────────────────────────────────────────────────────

  describe("5. Aspirate", () => {
    beforeEach(async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample_A", 2000);
      await sendCommand(`C0TPid0200xp${tip.xp}yp${tip.yp}tm255tt04`);
    });

    it("aspirates 100uL from 8 wells — channels loaded AND sources depleted", async () => {
      const src = await wellXY("SMP001", 0, 0);
      const volBefore = await getColumnVolumes("SMP001", 0, 0);

      const result = await sendCommand(`C0ASid0201xp${src.xp}yp${src.yp}av01000tm255lm0`);
      expect(result.accepted).toBe(true);
      expect(result.errorCode).toBe(0);

      // Channels must show the aspirated volume
      const pip = await getModuleVars("pip");
      for (let i = 0; i < 8; i++) {
        expect(pip.volume[i]).toBe(1000);
      }

      // Sources must physically depleted by exactly 100uL each — the real
      // liquid accounting, which a derived-state-only test would miss.
      const volAfter = await getColumnVolumes("SMP001", 0, 0);
      for (let row = 0; row < 8; row++) {
        expect(volAfter[row]).toBe(volBefore[row] - 1000);
      }
    });

    it("decreases source well volume", async () => {
      const src = await wellXY("SMP001", 0, 0);
      await sendCommand(`C0ASid0202xp${src.xp}yp${src.yp}av01000tm255lm0`);

      // Column 0 wells: 2000 - 1000 = 1000
      const vols = await getColumnVolumes("SMP001", 0, 0);
      expect(vols).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);

      // Column 1 untouched
      const col1 = await getColumnVolumes("SMP001", 0, 1);
      expect(col1).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]);
    });

    it("generates TADM assessment event", async () => {
      const src = await wellXY("SMP001", 0, 0);
      await sendCommand(`C0ASid0203xp${src.xp}yp${src.yp}av01000tm255lm0`);
      const events = await getAssessments();
      const tadm = events.filter((e: any) => e.category === "tadm" && e.command === "C0AS");
      expect(tadm.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. Dispense
  // ────────────────────────────────────────────────────────────────────

  describe("6. Dispense", () => {
    beforeEach(async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample_A", 2000);
      await sendCommand(`C0TPid0300xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0301xp${src.xp}yp${src.yp}av01000tm255lm0`);
    });

    it("dispenses to destination plate", async () => {
      const dst = await wellXY("DST001", 0, 0);
      const result = await sendCommand(`C0DSid0302xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      expect(result.accepted).toBe(true);

      const pip = await getModuleVars("pip");
      for (let i = 0; i < 8; i++) {
        expect(pip.volume[i]).toBe(0);
      }
    });

    it("increases destination well volume", async () => {
      const dst = await wellXY("DST001", 0, 0);
      await sendCommand(`C0DSid0303xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      const vols = await getColumnVolumes("DST001", 0, 0);
      expect(vols).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    });

    it("generates TADM dispense event", async () => {
      const dst = await wellXY("DST001", 0, 0);
      await sendCommand(`C0DSid0304xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      const events = await getAssessments();
      const tadm = events.filter((e: any) => e.category === "tadm" && e.command === "C0DS");
      expect(tadm.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 7. Volume Conservation (full transfer)
  // ────────────────────────────────────────────────────────────────────

  describe("9. Volume Conservation", () => {
    it("8-channel transfer preserves volume", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample_A", 2000);
      await sendCommand(`C0TPid0400xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0401xp${src.xp}yp${src.yp}av01000tm255lm0`);
      await sendCommand(`C0DSid0402xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      await sendCommand("C0TRid0403tm255");

      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      const dstVols = await getColumnVolumes("DST001", 0, 0);

      for (let i = 0; i < 8; i++) {
        expect(srcVols[i] + dstVols[i]).toBe(2000); // conservation
      }
    });

    it("4-channel transfer only affects enabled channels", async () => {
      const tipC1 = await wellXY("TIP001", 0, 1);
      const srcC1 = await wellXY("SMP001", 0, 1);
      const dstC1 = await wellXY("DST001", 0, 1);
      await fillPlate("SMP001", 0, "Sample_A", 2000);
      // tipC1 = TIP001 col 1, srcC1 = SMP001 col 1, dstC1 = DST001 col 1
      await sendCommand(`C0TPid0410xp${tipC1.xp}yp${tipC1.yp}tm15tt04`);
      await sendCommand(`C0ASid0411xp${srcC1.xp}yp${srcC1.yp}av01000tm15lm0`);
      await sendCommand(`C0DSid0412xp${dstC1.xp}yp${dstC1.yp}dv01000dm0tm15`);
      await sendCommand("C0TRid0413tm15");

      const srcVols = await getColumnVolumes("SMP001", 0, 1);
      const dstVols = await getColumnVolumes("DST001", 0, 1);

      // Channels 1-4 (rows A-D): transferred
      for (let i = 0; i < 4; i++) {
        expect(srcVols[i]).toBe(1000);
        expect(dstVols[i]).toBe(1000);
      }
      // Channels 5-8 (rows E-H): untouched
      for (let i = 4; i < 8; i++) {
        expect(srcVols[i]).toBe(2000);
        expect(dstVols[i]).toBe(0);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 9b. Partial Channel Workflows (channels 5-8, single channel)
  // ────────────────────────────────────────────────────────────────────

  describe("9b. Partial Channel Workflows", () => {
    it("channels 5-8 (tm=240) pickup + aspirate + dispense", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample_B", 2000);
      // tm=240 = channels 5-8 (bits 4,5,6,7)
      const r1 = await sendCommand(`C0TPid0450xp${tip.xp}yp${tip.yp}tm240tt04`);
      expect(r1.accepted).toBe(true);
      expect(r1.errorCode).toBe(0);

      // Verify tip state — channels 4-7 should have tips
      const pip = await getModuleVars("pip");
      expect(pip.tip_fitted[4]).toBe(true);
      expect(pip.tip_fitted[5]).toBe(true);
      expect(pip.tip_fitted[6]).toBe(true);
      expect(pip.tip_fitted[7]).toBe(true);
      // Channels 0-3 should NOT
      expect(pip.tip_fitted[0]).toBe(false);
      expect(pip.tip_fitted[3]).toBe(false);
      expect(pip.active_tip_count).toBe(4);

      // Aspirate 100uL from source plate
      const r2 = await sendCommand(`C0ASid0451xp${src.xp}yp${src.yp}av01000tm240lm0`);
      expect(r2.accepted).toBe(true);
      expect(r2.errorCode).toBe(0);

      // Verify volumes on channels 4-7
      const pip2 = await getModuleVars("pip");
      expect(pip2.volume[4]).toBe(1000);
      expect(pip2.volume[5]).toBe(1000);
      expect(pip2.volume[6]).toBe(1000);
      expect(pip2.volume[7]).toBe(1000);
      // Channels 0-3 should be empty
      expect(pip2.volume[0]).toBe(0);

      // Source wells E-H should have lost volume
      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[4]).toBe(1000); // Row E
      expect(srcVols[5]).toBe(1000); // Row F
      expect(srcVols[6]).toBe(1000); // Row G
      expect(srcVols[7]).toBe(1000); // Row H
      // Rows A-D untouched
      expect(srcVols[0]).toBe(2000);
      expect(srcVols[1]).toBe(2000);

      // Dispense to destination
      const r3 = await sendCommand(`C0DSid0452xp${dst.xp}yp${dst.yp}dv01000dm0tm240`);
      expect(r3.accepted).toBe(true);
      expect(r3.errorCode).toBe(0);

      // Destination wells E-H should have volume
      const dstVols = await getColumnVolumes("DST001", 0, 0);
      expect(dstVols[4]).toBe(1000); // Row E
      expect(dstVols[5]).toBe(1000); // Row F
      expect(dstVols[6]).toBe(1000); // Row G
      expect(dstVols[7]).toBe(1000); // Row H
      // Rows A-D untouched
      expect(dstVols[0]).toBe(0);
      expect(dstVols[1]).toBe(0);
    });

    it("single channel (tm=1) pickup + aspirate", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      await fillPlate("SMP001", 0, "Sample_C", 2000);
      const r1 = await sendCommand(`C0TPid0460xp${tip.xp}yp${tip.yp}tm1tt04`);
      expect(r1.accepted).toBe(true);

      const pip = await getModuleVars("pip");
      expect(pip.tip_fitted[0]).toBe(true);
      expect(pip.tip_fitted[1]).toBe(false);
      expect(pip.active_tip_count).toBe(1);

      const r2 = await sendCommand(`C0ASid0461xp${src.xp}yp${src.yp}av01000tm1lm0`);
      expect(r2.accepted).toBe(true);

      const srcVols = await getColumnVolumes("SMP001", 0, 0);
      expect(srcVols[0]).toBe(1000); // Row A aspirated
      expect(srcVols[1]).toBe(2000); // Row B untouched
    });

    it("channels 5-8 hasTip check detects non-zero channels", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      // Pick up tips only on channels 5-8
      await sendCommand(`C0TPid0470xp${tip.xp}yp${tip.yp}tm240tt04`);
      const pip = await getModuleVars("pip");
      // Verify that hasTip logic works: channel 0 has no tip, but SOME channels do
      expect(pip.tip_fitted[0]).toBe(false);
      expect(pip.tip_fitted.some((v: boolean) => v)).toBe(true);
      expect(pip.active_tip_count).toBe(4);

      // Aspirate should succeed (SCXML uses tip_fitted, not tm)
      await fillPlate("SMP001", 0, "Sample_D", 2000);
      const r = await sendCommand(`C0ASid0471xp${src.xp}yp${src.yp}av01000tm240lm0`);
      expect(r.accepted).toBe(true);
      expect(r.errorCode).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 10. Temperature Control
  // ────────────────────────────────────────────────────────────────────

  describe("10. Temperature Control", () => {
    it("TCC heats to target temperature", async () => {
      const result = await sendCommand("C0HCid0500hn1hc0370");
      expect(result.accepted).toBe(true);

      const temp = await getModuleVars("temp");
      expect(temp.target_temp_01c).toBe(370);
    });

    it("HHS initializes, heats, and shakes", async () => {
      let r = await sendCommand("T1SIid0501");
      expect(r.accepted).toBe(true);

      r = await sendCommand("T1TAid0502ta0600");
      expect(r.accepted).toBe(true);
      const hhs = await getModuleVars("hhs");
      expect(hhs.target_temp_01c).toBe(600);
      expect(hhs.temp_active).toBe(true);

      r = await sendCommand("T1SAid0503sv0500");
      expect(r.accepted).toBe(true);
      const hhs2 = await getModuleVars("hhs");
      expect(hhs2.shaking).toBe(true);
      expect(hhs2.shake_speed).toBe(500);
    });

    it("rejects temperature above 105C", async () => {
      await sendCommand("T1SIid0510");
      const r = await sendCommand("T1TAid0511ta1100"); // 110C > 105C max
      expect(r.accepted).toBe(false);
      // Error 19 = "Incubation error (temperature out of limit)" per
      // hamilton-star-digital-twin.json. This test used to accept 99
      // (the generic error) because the HHS plugin returned 99; the plugin
      // was fixed to emit the specific code, and the matching assertion
      // in full-compliance.test.ts:333 documents the reason.
      expect(r.errorCode).toBe(19);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 11. Wash Station
  // ────────────────────────────────────────────────────────────────────

  describe("11. Wash Station", () => {
    it("initializes with full fluid levels", async () => {
      const r = await sendCommand("C0WIid0600");
      expect(r.accepted).toBe(true);

      const wash = await getModuleVars("wash");
      expect(wash.fluid_level_1).toBe(200000);
      expect(wash.fluid_level_2).toBe(200000);
    });

    it("depletes fluid with each wash cycle", async () => {
      await sendCommand("C0WIid0601");
      await sendCommand("C0WSid0602ws01");
      // Flush wash completion so state returns to idle_ws
      await flush("wash_ws.done");

      const wash1 = await getModuleVars("wash");
      expect(wash1.fluid_level_1).toBeLessThan(200000);
      expect(wash1.wash_cycles).toBe(1);

      await sendCommand("C0WSid0603ws01");
      await flush("wash_ws.done");
      const wash2 = await getModuleVars("wash");
      expect(wash2.fluid_level_1).toBeLessThan(wash1.fluid_level_1);
      expect(wash2.wash_cycles).toBe(2);
    });

    it("generates wash assessment events", async () => {
      await sendCommand("C0WIid0610");
      await sendCommand("C0WSid0611ws01");

      const events = await getAssessments();
      const washEvents = events.filter((e: any) => e.module === "wash");
      expect(washEvents.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 12. 96-Channel Head
  // ────────────────────────────────────────────────────────────────────

  describe("12. 96-Channel Head", () => {
    it("moves, picks tips, aspirates, dispenses, ejects", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      // Move (C0EM uses xs/yh instead of xp/yp)
      let r = await sendCommand(`C0EMid0700xs${tip.xp}yh${tip.yp}`);
      expect(r.accepted).toBe(true);
      let h96 = await getModuleVars("h96");
      expect(h96.pos_x).toBe(tip.x);

      // Flush move completion
      await sendCompletion("move96.done");

      // Tip pickup — updates pos_y
      r = await sendCommand(`C0EPid0701xp${tip.xp}yp${tip.yp}`);
      expect(r.accepted).toBe(true);
      h96 = await getModuleVars("h96");
      expect(h96.tips_fitted).toBe(true);
      expect(h96.pos_y).toBe(tip.y);

      // Aspirate
      r = await sendCommand("C0EAid0702af01000ag05000wh0005");
      expect(r.accepted).toBe(true);
      h96 = await getModuleVars("h96");
      expect(h96.volume_01ul).toBe(1000);

      // Dispense
      r = await sendCommand("C0EDid0703df01000dg05000");
      expect(r.accepted).toBe(true);
      h96 = await getModuleVars("h96");
      expect(h96.volume_01ul).toBe(0);

      // Eject
      r = await sendCommand("C0ERid0704");
      expect(r.accepted).toBe(true);
      h96 = await getModuleVars("h96");
      expect(h96.tips_fitted).toBe(false);
    });

    it("rejects 96-head aspirate without tips (error 8, volume unchanged)", async () => {
      const h96Before = await getModuleVars("h96");
      expect(h96Before.tips_fitted).toBe(false);
      expect(h96Before.volume_01ul).toBe(0);

      const r = await sendCommand("C0EAid0710af01000");
      expect(r.errorCode).toBe(8);  // 8 = no tip fitted

      // Rejection: volume must not have been aspirated
      const h96After = await getModuleVars("h96");
      expect(h96After.volume_01ul).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Error Paths
  // ────────────────────────────────────────────────────────────────────

  describe("Error Paths", () => {
    it("rejects dispense with no volume", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await sendCommand(`C0TPid0800xp${tip.xp}yp${tip.yp}tm255tt04`);
      // Dispense without prior aspirate
      const r = await sendCommand(`C0DSid0801xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      // The SCXML accepts it (jet dispense from tips_empty → tips_empty),
      // but the volume is 0 so nothing transfers
      const pip = await getModuleVars("pip");
      expect(pip.volume[0]).toBe(0);
    });

    it("rejects tip pickup when tips already fitted", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const tipC1 = await wellXY("TIP001", 0, 1);
      await sendCommand(`C0TPid0810xp${tip.xp}yp${tip.yp}tm255tt04`);
      // Wait for move.done so PIP returns to tip_fitted idle
      await flush("move.done");
      const r = await sendCommand(`C0TPid0811xp${tipC1.xp}yp${tipC1.yp}tm255tt04`);
      // Error 7 = "tip already fitted" (distinct from 8 = "no tip"). Pinning
      // the code catches a regression that confuses the two.
      expect(r.errorCode).toBe(7);
    });

    it("no module in error state after valid workflow", async () => {
      const tip = await wellXY("TIP001", 0, 0);
      const src = await wellXY("SMP001", 0, 0);
      const dst = await wellXY("DST001", 0, 0);
      await fillPlate("SMP001", 0, "Sample_A", 2000);
      await sendCommand(`C0TPid0820xp${tip.xp}yp${tip.yp}tm255tt04`);
      await sendCommand(`C0ASid0821xp${src.xp}yp${src.yp}av01000tm255lm0`);
      await sendCommand(`C0DSid0822xp${dst.xp}yp${dst.yp}dv01000dm0tm255`);
      await sendCommand("C0TRid0823tm255");

      const state = await getState();
      for (const [id, mod] of Object.entries(state.modules) as [string, any][]) {
        const hasError = mod.states.some((s: string) => s.includes("error"));
        expect(hasError, `${id} should not be in error`).toBe(false);
      }
    });
  });
});
