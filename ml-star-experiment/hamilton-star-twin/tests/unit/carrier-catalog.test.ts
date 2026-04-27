/**
 * Carrier catalog contract.
 *
 * The catalog is the single source of truth for carrier geometry
 * (deck.ts's `CARRIER_TEMPLATES` + venus-steps' `loadCarrier` +
 * venus-deck-importer's fallback all route through it). These tests
 * pin the contract.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  DEFAULT_CARRIER_CATALOG,
  findCarrierCatalogEntry,
  carrierFromCatalog,
  listCarrierCatalogTypes,
} = require("../../dist/twin/carrier-catalog");

describe("carrier catalog", () => {
  it("exposes the Hamilton carriers the default deck needs", () => {
    const needed = [
      "PLT_CAR_L5MD", "TIP_CAR_480", "RGT_CAR_3R",
      "WASH_STATION", "HHS_CAR", "TCC_CAR",
    ];
    for (const type of needed) {
      expect(findCarrierCatalogEntry(type)).toBeDefined();
    }
  });

  it("every entry has coherent positions vs siteYOffsets", () => {
    for (const entry of DEFAULT_CARRIER_CATALOG) {
      if (entry.siteYOffsets !== undefined) {
        expect(entry.siteYOffsets.length).toBe(entry.positions);
      }
      expect(entry.positions).toBeGreaterThan(0);
      expect(entry.widthTracks).toBeGreaterThan(0);
      expect(entry.yDim).toBeGreaterThan(0);
    }
  });

  it("carrierFromCatalog builds a valid Carrier with empty labware slots", () => {
    const c = carrierFromCatalog("PLT_CAR_L5MD", 7, "SMP001");
    expect(c.id).toBe("SMP001");
    expect(c.type).toBe("PLT_CAR_L5MD");
    expect(c.track).toBe(7);
    expect(c.widthTracks).toBe(6);
    expect(c.positions).toBe(5);
    expect(c.labware).toHaveLength(5);
    expect(c.labware.every((l: unknown) => l === null)).toBe(true);
    // siteYOffsets[0] = largest Y = rear of carrier = position 0 in
    // VENUS's SiteId-1-at-top convention (rear-first ordering).
    expect(c.siteYOffsets).toEqual([3925, 2965, 2005, 1045, 85]);
    expect(c.yDim).toBe(4970);
  });

  it("carrierFromCatalog clones siteYOffsets so callers can mutate safely", () => {
    const a = carrierFromCatalog("TIP_CAR_480", 1, "A");
    const b = carrierFromCatalog("TIP_CAR_480", 7, "B");
    a.siteYOffsets[0] = 99999;
    expect(b.siteYOffsets[0]).not.toBe(99999);
  });

  it("carrierFromCatalog throws on unknown types (loud typos, not silent empties)", () => {
    expect(() => carrierFromCatalog("NOPE_NOT_A_CARRIER", 1, "X"))
      .toThrow(/not in catalog/);
  });

  it("SMP_CAR_24 has no siteYOffsets — even-distribution fallback applies", () => {
    const c = carrierFromCatalog("SMP_CAR_24", 1, "S1");
    expect(c.siteYOffsets).toBeUndefined();
    expect(c.positions).toBe(24);
  });

  it("listCarrierCatalogTypes returns a sorted unique set", () => {
    const types = listCarrierCatalogTypes();
    expect(types).toEqual([...types].sort());
    expect(new Set(types).size).toBe(types.length);
  });
});
