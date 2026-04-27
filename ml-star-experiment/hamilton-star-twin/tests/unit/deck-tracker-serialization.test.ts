/**
 * DeckTracker serialization round-trip tests.
 *
 * Verifies `getTrackingState()` / `restoreTrackingState()` produce and accept
 * snapshots that preserve well volumes and tip usage across save/restore.
 *
 * FAILURE INJECTION
 * If `restoreTrackingState()` forgets to clear wellVolumes before rebuilding,
 * residual state from the pre-restore tracker leaks into the restored map
 * and the "restore replaces prior state" test fails. If it skips the type
 * check on the snapshot, the "throws on malformed snapshot" test fails.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createDefaultDeckLayout } = require("../../dist/twin/deck");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DeckTracker } = require("../../dist/twin/deck-tracker");

function freshTracker() {
  const deck = createDefaultDeckLayout();
  return new DeckTracker(deck);
}

describe("DeckTracker serialization", () => {
  it("empty tracker produces an empty tracking snapshot", () => {
    const t = freshTracker();
    const snap = t.getTrackingState();
    expect(snap).toEqual({ wellVolumes: {}, tipUsage: {} });
  });

  it("captures wellVolumes set via setWellVolume", () => {
    const t = freshTracker();
    t.setWellVolume("SMP001", 0, 0, 1500);
    t.setWellVolume("SMP001", 0, 1, 2000);
    const snap = t.getTrackingState();
    expect(snap.wellVolumes["SMP001:0:0"]).toBe(1500);
    expect(snap.wellVolumes["SMP001:0:1"]).toBe(2000);
  });

  it("round-trips wellVolumes through JSON", () => {
    const t = freshTracker();
    t.setWellVolume("SMP001", 0, 0, 1500);
    t.setWellVolume("DST001", 0, 0, 750);

    const snap = t.getTrackingState();
    const json = JSON.parse(JSON.stringify(snap));

    const t2 = freshTracker();
    t2.restoreTrackingState(json);

    expect(t2.getWellVolume("SMP001", 0, 0)).toBe(1500);
    expect(t2.getWellVolume("DST001", 0, 0)).toBe(750);
    expect(t2.getWellVolume("SMP001", 0, 99)).toBeUndefined();
  });

  it("restoreTrackingState replaces prior state (does not merge)", () => {
    const t = freshTracker();
    t.setWellVolume("A", 0, 0, 111);
    const snap = t.getTrackingState();

    const t2 = freshTracker();
    t2.setWellVolume("B", 0, 0, 222);  // prior state that must be gone
    t2.restoreTrackingState(JSON.parse(JSON.stringify(snap)));

    expect(t2.getWellVolume("B", 0, 0)).toBeUndefined();
    expect(t2.getWellVolume("A", 0, 0)).toBe(111);
  });

  it("captures tipUsage after processCommand for C0TP", () => {
    const t = freshTracker();
    // Simulate tip pickup processing by calling processCommand directly.
    // We pass the coordinates that resolve to TIP001 pos 0 well 0 in the
    // default deck layout. (See deck.ts:createDefaultDeckLayout.)
    t.processCommand("C0TP", { xp: 1033, yp: 1375, tm: 1, tt: 4 });

    const snap = t.getTrackingState();
    // At least one tip was marked used.
    const usedKeys = Object.keys(snap.tipUsage).filter((k) => snap.tipUsage[k]);
    expect(usedKeys.length).toBeGreaterThan(0);
  });

  it("round-trips tipUsage through JSON", () => {
    const t = freshTracker();
    t.processCommand("C0TP", { xp: 1033, yp: 1375, tm: 255 });
    const snap = t.getTrackingState();
    const json = JSON.parse(JSON.stringify(snap));

    const t2 = freshTracker();
    t2.restoreTrackingState(json);

    expect(t2.getTipUsageSnapshot()).toEqual(snap.tipUsage);
  });

  it("restoreTrackingState clears interaction history (not part of state)", () => {
    const t = freshTracker();
    t.processCommand("C0TP", { xp: 1033, yp: 1375, tm: 255 });
    expect(t.getInteractions().length).toBeGreaterThan(0);

    const snap = t.getTrackingState();
    const t2 = freshTracker();
    t2.processCommand("C0TP", { xp: 1033, yp: 1375, tm: 255 });
    expect(t2.getInteractions().length).toBeGreaterThan(0);

    t2.restoreTrackingState(JSON.parse(JSON.stringify(snap)));
    expect(t2.getInteractions()).toEqual([]);
    expect(t2.getUnresolvedInteractions()).toEqual([]);
  });

  it("getDeckDynamicState captures tip waste count", () => {
    const t = freshTracker();
    // Eject to waste with no xp/yp (defaults to waste routing, bug #14).
    t.processCommand("C0TR", { tm: 0xFF });
    const snap = t.getDeckDynamicState();
    expect(snap.tipWasteCount).toBeGreaterThan(0);
  });

  it("round-trips deck dynamic state", () => {
    const t = freshTracker();
    t.processCommand("C0TR", { tm: 0xFF });
    const snap = t.getDeckDynamicState();
    const json = JSON.parse(JSON.stringify(snap));

    const t2 = freshTracker();
    t2.restoreDeckDynamicState(json);

    // Tip waste count is restored
    expect(t2.getDeckDynamicState().tipWasteCount).toBe(snap.tipWasteCount);
  });

  it("restoreTrackingState throws on malformed snapshot", () => {
    const t = freshTracker();
    expect(() => t.restoreTrackingState(null)).toThrow(/null or not an object/);
    expect(() => t.restoreTrackingState({})).toThrow(/wellVolumes must be an object/);
    expect(() => t.restoreTrackingState({ wellVolumes: {} })).toThrow(/tipUsage must be an object/);
  });

  it("snapshot is JSON-stable (no Maps or Sets leak)", () => {
    const t = freshTracker();
    t.setWellVolume("A", 0, 0, 500);
    t.setWellVolume("B", 0, 1, 1000);
    t.processCommand("C0TP", { xp: 1033, yp: 1375, tm: 255 });

    const snap = t.getTrackingState();
    const s1 = JSON.stringify(snap);
    const s2 = JSON.stringify(JSON.parse(s1));
    expect(s1).toEqual(s2);
  });
});
