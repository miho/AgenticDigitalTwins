/**
 * Deck config serialization round-trip tests.
 *
 * Verifies that `Deck.getConfig()` produces a TwinConfig whose
 * `Deck.restoreFromConfig()` counterpart reconstructs an equivalent deck.
 * The original deck and the restored deck must be observationally
 * indistinguishable for the purposes of coordinate resolution, carrier
 * lookup, and labware geometry.
 *
 * FAILURE INJECTION
 * If `restoreFromConfig()` forgets to clear the trackMap, a second restore
 * would fail because tracks are already occupied — the "round-trip on a
 * pre-populated deck" test catches that. If the config omits labware
 * geometry fields, wellToPosition() after restore returns a different
 * coordinate than the original — the "well coordinates preserved" test
 * fails.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Deck, createDefaultDeckLayout } = require("../../dist/twin/deck");

describe("Deck config serialization", () => {
  it("a fresh Deck exports an empty config with only platform + tip waste", () => {
    const deck = new Deck("STAR");
    const cfg = deck.getConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.platform).toBe("STAR");
    expect(cfg.carriers).toEqual([]);
    expect(cfg.tipWaste.track).toBeGreaterThan(0);
    expect(cfg.tipWaste.capacity).toBeGreaterThan(0);
  });

  it("createDefaultDeckLayout produces a self-contained config", () => {
    const deck = createDefaultDeckLayout();
    const cfg = deck.getConfig();
    expect(cfg.carriers.length).toBeGreaterThan(0);
    // Every placed labware must carry its definition inline
    for (const c of cfg.carriers) {
      for (const l of c.labware) {
        expect(l.definition).toBeTruthy();
        expect(l.definition.type).toBe(l.definition.type);  // sanity
        expect(typeof l.definition.wellCount).toBe("number");
        expect(typeof l.definition.wellShape).toBe("string");
        expect(typeof l.definition.wellDepth).toBe("number");
      }
    }
  });

  it("config round-trips through JSON (no Maps or Sets leak)", () => {
    const deck = createDefaultDeckLayout();
    const cfg = deck.getConfig();
    const s1 = JSON.stringify(cfg);
    const s2 = JSON.stringify(JSON.parse(s1));
    expect(s1).toEqual(s2);
  });

  it("restoreFromConfig rebuilds identical carrier placements", () => {
    const deck = createDefaultDeckLayout();
    const cfg = deck.getConfig();

    const deck2 = new Deck("STAR");
    deck2.restoreFromConfig(JSON.parse(JSON.stringify(cfg)));

    const origSnap = deck.getSnapshot();
    const restSnap = deck2.getSnapshot();

    expect(restSnap.platform).toBe(origSnap.platform);
    expect(restSnap.totalTracks).toBe(origSnap.totalTracks);
    expect(restSnap.carriers.length).toBe(origSnap.carriers.length);

    // Carrier identity (id, type, track, positions) preserved
    const origCarriers = origSnap.carriers.sort((a: any, b: any) => a.id.localeCompare(b.id));
    const restCarriers = restSnap.carriers.sort((a: any, b: any) => a.id.localeCompare(b.id));
    for (let i = 0; i < origCarriers.length; i++) {
      expect(restCarriers[i].id).toBe(origCarriers[i].id);
      expect(restCarriers[i].type).toBe(origCarriers[i].type);
      expect(restCarriers[i].track).toBe(origCarriers[i].track);
      expect(restCarriers[i].positions).toBe(origCarriers[i].positions);
    }
  });

  it("well coordinates are preserved after config round-trip", () => {
    const deck = createDefaultDeckLayout();
    const cfg = deck.getConfig();

    const deck2 = new Deck("STAR");
    deck2.restoreFromConfig(JSON.parse(JSON.stringify(cfg)));

    // Coordinate resolution for a canonical well must be bit-identical.
    const addr = { carrierId: "SMP001", position: 0, row: 0, column: 0 };
    const origPos = deck.wellToPosition(addr);
    const restPos = deck2.wellToPosition(addr);
    expect(restPos).toEqual(origPos);

    // And for a far-corner well
    const addr2 = { carrierId: "SMP001", position: 0, row: 7, column: 11 };
    expect(deck2.wellToPosition(addr2)).toEqual(deck.wellToPosition(addr2));
  });

  it("restoreFromConfig refuses a cross-platform config", () => {
    const deck = new Deck("STAR");
    const badConfig = { version: 1, platform: "STARlet", carriers: [], tipWaste: { track: 52, widthTracks: 3, capacity: 960 } };
    expect(() => deck.restoreFromConfig(badConfig)).toThrow(/platform mismatch/);
  });

  it("restoreFromConfig refuses unknown version", () => {
    const deck = new Deck("STAR");
    expect(() => deck.restoreFromConfig({ version: 99, platform: "STAR", carriers: [], tipWaste: { track: 52, widthTracks: 3, capacity: 960 } }))
      .toThrow(/unsupported config version 99/);
  });

  it("restoreFromConfig wipes pre-existing carriers before loading new ones", () => {
    const deck = createDefaultDeckLayout();
    // Restore a minimal config — all prior carriers must be gone.
    const minimal = { version: 1, platform: "STAR", carriers: [], tipWaste: { track: 52, widthTracks: 3, capacity: 960 } };
    deck.restoreFromConfig(minimal);

    expect(deck.getAllCarriers().length).toBe(0);
    expect(deck.getSnapshot().carriers.length).toBe(0);
  });

  it("round-trip preserves tip-waste capacity (but not dynamic tipCount)", () => {
    const deck = createDefaultDeckLayout();
    deck.tipWaste.tipCount = 50;  // dynamic state
    const cfg = deck.getConfig();

    const deck2 = new Deck("STAR");
    deck2.restoreFromConfig(JSON.parse(JSON.stringify(cfg)));

    expect(deck2.tipWaste.capacity).toBe(deck.tipWaste.capacity);
    // tipCount is NOT part of config — it resets to 0
    expect(deck2.tipWaste.tipCount).toBe(0);
  });

  it("labware definitions in config include full well geometry (not just type names)", () => {
    const deck = createDefaultDeckLayout();
    const cfg = deck.getConfig();
    const smp001 = cfg.carriers.find((c: any) => c.id === "SMP001");
    expect(smp001).toBeTruthy();
    const first = smp001.labware.find((l: any) => l.definition.type === "Cos_96_Rd");
    expect(first).toBeTruthy();
    expect(first.definition.wellShape).toBe("round");
    expect(first.definition.diameterTop === undefined || first.definition.wellDiameterTop).toBeTruthy();
    expect(first.definition.wellDiameterTop).toBeGreaterThan(0);
    expect(first.definition.wellDepth).toBeGreaterThan(0);
    expect(first.definition.deadVolume).toBeGreaterThan(0);
  });
});
