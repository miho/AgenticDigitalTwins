/**
 * Collision-physics plugin tests (Phase 4 Step 4.B).
 *
 * Exercises the plugin directly with a minimal mock DeckTracker so the
 * tests are self-contained — the plugin is pure logic modulo the deck
 * carrier lookup. A separate integration test verifies wiring through
 * DigitalTwin.registerGlobalPlugin.
 *
 * FAILURE INJECTION
 *   - If checkZEnvelope's X-range check is inverted, the negative-boundary
 *     test (arm outside the carrier's X range) emits a spurious event.
 *   - If checkArmOverlap skips the "other arm is on deck" guard, every
 *     PIP command emits a false positive because head96 starts at x=0.
 *   - If assess() forgets to call updatePose before running checks, the
 *     mutual-exclusion test never triggers because the pose doesn't
 *     reflect the just-issued command.
 */

import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CollisionPhysics, COLLISION_ARM_MIN_X_GAP } = require("../../dist/twin/plugins/collision-physics");

interface MockCarrier {
  id: string;
  xMin: number;
  xMax: number;
}

/**
 * Minimum stub that satisfies the plugin's DeckTracker access pattern:
 * `deckTracker.deck.getAllCarriers()` + `deckTracker.deck.getCarrierXRange(id)`.
 * Carries no real deck state — the plugin's Z-envelope check only
 * consults the X range and a fixed default zTop.
 */
function mockDeckTracker(carriers: MockCarrier[]): any {
  const byId = new Map(carriers.map((c) => [c.id, c]));
  return {
    deck: {
      getAllCarriers: () => carriers,
      getCarrierXRange: (id: string) => {
        const c = byId.get(id);
        return c ? { xMin: c.xMin, xMax: c.xMax } : null;
      },
    },
  };
}

describe("CollisionPhysics (Phase 4 Step 4.B)", () => {
  describe("Z envelope", () => {
    it("flags when an arm descends above a tall carrier at the committed X", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([{ id: "TIP001", xMin: 1000, xMax: 2000 }]);
      // C0TP at x=1500 (inside TIP001's range), descending.
      const events = plugin.assess("C0TP", { xp: 1500, yp: 1000, zp: 1500 }, deck);
      expect(events.length).toBe(1);
      expect(events[0].category).toBe("collision");
      expect(events[0].severity).toBe("error");
      expect(events[0].data.subtype).toBe("z_envelope");
      expect(events[0].data.carrierId).toBe("TIP001");
    });

    it("does not flag when the arm is outside the carrier's X range", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([{ id: "TIP001", xMin: 1000, xMax: 2000 }]);
      const events = plugin.assess("C0TP", { xp: 5000, yp: 1000, zp: 1500 }, deck);
      const zEvents = events.filter((e: any) => e.data.subtype === "z_envelope");
      expect(zEvents.length).toBe(0);
    });

    it("does not flag when the arm stays at traverse height", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([{ id: "TIP001", xMin: 1000, xMax: 2000 }]);
      // C0JM keeps z at traverse (zBelowTraverse = 0).
      const events = plugin.assess("C0JM", { xp: 1500, yp: 1000 }, deck);
      const zEvents = events.filter((e: any) => e.data.subtype === "z_envelope");
      expect(zEvents.length).toBe(0);
    });
  });

  describe("Multi-arm mutual exclusion", () => {
    it("flags when PIP moves within the gap of the 96-Head", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      // Park the 96-Head at x=2000 first.
      plugin.assess("I1PI", { xp: 2000, yp: 1000, zp: 100 }, deck);
      // Now move PIP to x=2200 — within COLLISION_ARM_MIN_X_GAP of the head.
      const events = plugin.assess("C0TP", { xp: 2200, yp: 1000, zp: 100 }, deck);
      const overlap = events.find((e: any) => e.data.subtype === "arm_overlap");
      expect(overlap).toBeTruthy();
      expect(overlap.data.actualGap).toBe(Math.abs(2200 - 2000));
      expect(overlap.data.minGap).toBe(COLLISION_ARM_MIN_X_GAP);
    });

    it("does not flag when the arms are separated beyond the gap", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      plugin.assess("I1PI", { xp: 2000, yp: 1000, zp: 100 }, deck);
      // Move PIP far away.
      const events = plugin.assess("C0TP", { xp: 6000, yp: 1000, zp: 100 }, deck);
      const overlap = events.find((e: any) => e.data.subtype === "arm_overlap");
      expect(overlap).toBeUndefined();
    });

    it("does not false-positive when the other arm has never been placed", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      const events = plugin.assess("C0TP", { xp: 100, yp: 1000, zp: 100 }, deck);
      const overlap = events.find((e: any) => e.data.subtype === "arm_overlap");
      expect(overlap).toBeUndefined();
    });
  });

  describe("iSWAP sweep", () => {
    it("warns when an iSWAP transport crosses a parked PIP", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      // Park PIP at x=3000.
      plugin.assess("C0JM", { xp: 3000, yp: 1000 }, deck);
      // iSWAP starts at x=0 (initial), move to x=5000 → sweep [0..5000] crosses pip.
      const events = plugin.assess("I5MV", { xp: 5000, yp: 1000 }, deck);
      const sweep = events.find((e: any) => e.data.subtype === "iswap_sweep");
      expect(sweep).toBeTruthy();
      expect(sweep.data.other).toBe("pip");
      expect(sweep.severity).toBe("warning");
    });

    it("does not warn when the iSWAP sweep misses every arm", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      plugin.assess("C0JM", { xp: 500, yp: 1000 }, deck);
      plugin.assess("I1PI", { xp: 700, yp: 1000, zp: 100 }, deck);
      // iSWAP moves across x 1500 → 3000, both arms parked at 500 / 700.
      plugin.assess("I5MV", { xp: 1500, yp: 1000 }, deck);
      const events = plugin.assess("I5MV", { xp: 3000, yp: 1000 }, deck);
      const sweep = events.find((e: any) => e.data.subtype === "iswap_sweep");
      expect(sweep).toBeUndefined();
    });
  });

  describe("State", () => {
    it("exposes arm poses via getArmState", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      plugin.assess("C0TP", { xp: 1234, yp: 5678, zp: 100 }, deck);
      const s = plugin.getArmState();
      expect(s.pip.x).toBe(1234);
      expect(s.pip.y).toBe(5678);
      expect(s.pip.zBelowTraverse).toBe(100);
    });

    it("round-trips through getPluginState / restorePluginState", () => {
      const a = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      a.assess("C0TP", { xp: 1000, yp: 1000, zp: 50 }, deck);
      const snap = a.getPluginState();

      const b = new CollisionPhysics();
      b.restorePluginState(snap);
      expect(b.getArmState()).toEqual(a.getArmState());
    });

    it("operator-added tall carriers survive deck refreshes", () => {
      const plugin = new CollisionPhysics();
      plugin.addTallCarrier({ carrierId: "CUSTOM_A", xMin: 100, xMax: 900, zTop: 1500 });
      const deck = mockDeckTracker([{ id: "TIP001", xMin: 1000, xMax: 2000 }]);
      // Run an assess so refreshTallCarriers() is invoked.
      plugin.assess("C0JM", { xp: 5000, yp: 0 }, deck);
      // CUSTOM_A should still be present — it wasn't derived from the deck.
      const events = plugin.assess("C0TP", { xp: 500, yp: 0, zp: 2000 }, deck);
      const hit = events.find((e: any) => e.data.carrierId === "CUSTOM_A");
      expect(hit).toBeTruthy();
    });
  });

  describe("Event dispatch", () => {
    it("returns no assessments for commands the plugin doesn't track", () => {
      const plugin = new CollisionPhysics();
      const deck = mockDeckTracker([]);
      const events = plugin.assess("C0RF", {}, deck);
      expect(events).toEqual([]);
    });
  });
});
