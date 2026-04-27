/**
 * Labware catalog consistency tests.
 *
 * The catalog (labware-catalog.ts) is the sole source of truth for
 * labware geometry + dead volume + well shape. `WELL_GEOMETRIES` and
 * `DEAD_VOLUMES` tables have been retired. These tests enforce:
 *
 *   1. Dead-volume values for canonical Hamilton types match the values
 *      real methods + assessments expect.
 *   2. `getWellGeometry()` returns the catalog-backed geometry for every
 *      catalog type.
 *   3. Heuristic fallback still fires for unknown types.
 */
import { describe, it, expect } from "vitest";

// Require from dist (same pattern as in-process-helper.test.ts — SCXML
// runtime modules only resolve cleanly from the built CJS output).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getWellGeometry } = require("../../dist/twin/well-geometry");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findCatalogEntry, wellGeometryOf, catalogDeadVolume, listCatalogTypes, DEFAULT_DEAD_VOLUME } =
  require("../../dist/twin/labware-catalog");

/** Dead-volume baseline — values sourced from the real Hamilton .ctr
 *  files shipped with VENUS 6.0.2 (see tests/unit/ctr-bakeout.test.ts)
 *  where available, otherwise tuned manually. If the catalog drifts
 *  from these, the drift is almost certainly a regression. */
const EXPECTED_DEAD_VOLUMES: Record<string, number> = {
  "Cos_96_Rd": 200,
  "Cos_96_Fl": 100,
  "Cos_384_Sq": 50,
  "Cos_384_Rd": 101,     // .ctr-derived cone-bottom dead volume
  "Trough_100ml": 5000,
  "Trough_300ml": 10000,
  "Eppendorf_1.5": 200,
  "Falcon_15": 1000,
  "Falcon_50": 2000,
};

describe("Labware catalog consistency", () => {
  it("catalog dead-volume values match the baseline every consumer expects", () => {
    const mismatches: Array<{ type: string; expected: number; got: number }> = [];
    for (const [type, expected] of Object.entries(EXPECTED_DEAD_VOLUMES)) {
      const got = catalogDeadVolume(type);
      if (got !== expected) mismatches.push({ type, expected, got });
    }
    expect(mismatches).toEqual([]);
  });

  it("getWellGeometry() returns the catalog-backed geometry for every catalog type", () => {
    for (const type of listCatalogTypes() as string[]) {
      const entry = findCatalogEntry(type);
      const viaCatalog = wellGeometryOf(entry);
      const viaApi = getWellGeometry(type);
      expect(viaApi).toEqual(viaCatalog);
    }
  });

  it("getWellGeometry() falls back to a sane default for unknown types", () => {
    const unknown = getWellGeometry("totally_made_up_labware_Rd");
    // Heuristic "Rd" → round-bottom 96-well default.
    expect(unknown.shape).toBe("round");
    expect(unknown.diameterTop).toBeGreaterThan(0);
  });

  it("catalogDeadVolume() uses DEFAULT_DEAD_VOLUME for types not in catalog", () => {
    expect(catalogDeadVolume("UnknownLabwareXYZ123")).toBe(DEFAULT_DEAD_VOLUME);
  });

  it("catalogDeadVolume() prefix-matches when exact type is absent (legacy parity)", () => {
    // A suffixed type should still inherit its parent's dead volume.
    // e.g. "Cos_96_Rd_blue" → matches "Cos_96_Rd" via prefix.
    expect(catalogDeadVolume("Cos_96_Rd_blue")).toBe(200);
  });

  it("catalog has no duplicate type keys", () => {
    const types = listCatalogTypes();
    expect(new Set(types).size).toBe(types.length);
  });

  it("every catalog entry has coherent rows × columns = wellCount", () => {
    for (const type of listCatalogTypes() as string[]) {
      const entry = findCatalogEntry(type);
      expect(entry.rows * entry.columns).toBe(entry.wellCount);
    }
  });
});
