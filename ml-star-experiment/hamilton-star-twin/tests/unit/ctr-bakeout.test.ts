/**
 * .ctr → catalog bakeout parity.
 *
 * The labware-catalog entries have wellDepth / maxVolume / hasConicalBottom
 * sourced from real Hamilton `.ctr` container-geometry files in the VENUS
 * source tree. This test re-parses each source file and asserts the catalog
 * agrees — so when a future dev edits a catalog entry, silent drift from
 * the ground truth fails loud here.
 *
 * When the VENUS vendor tree isn't on disk (fresh clone without
 * VENUS-2026-04-13/), the test reports the skip but doesn't fail — catalog
 * values are still known-correct from the last bakeout.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readContainerDefinition } = require("../../dist/services/venus-import/hamilton-config-loader");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findCatalogEntry } = require("../../dist/twin/labware-catalog");

const VENDOR = path.resolve(
  __dirname,
  "..", "..", "..",
  "VENUS-2026-04-13", "Vector", "src", "HxLabwrCatManager",
  "Code", "HxLabwrCatSerDe.Test", "Labware",
);

/** catalog type name → .ctr path (relative to VENDOR). */
const BAKEOUT: Record<string, string> = {
  "Cos_96_Rd":      "Corning-Costar/Cos_96_Rd.ctr",
  "Cos_96_Fl":      "Corning-Costar/Cos_96_Fl.ctr",
  "Cos_96_Vb":      "Corning-Costar/Cos_96_Vb.ctr",
  "Cos_384_Sq":     "Corning-Costar/Cos_384_Sq.ctr",
  "Cos_384_Rd":     "Corning-Costar/Cos_384_Sq_Rd.ctr",
  "Cos_96_DW_1mL":  "Corning-Costar/Cos_96_DW_1mL.ctr",
  "Cos_96_DW_2mL":  "Corning-Costar/Cos_96_DW_2mL.ctr",
};

const hasVendor = fs.existsSync(VENDOR);

describe(".ctr → catalog bakeout", () => {
  if (!hasVendor) {
    it.skip("VENUS vendor tree missing — catalog values taken on faith until the next bakeout", () => {});
    return;
  }

  for (const [catalogType, rel] of Object.entries(BAKEOUT)) {
    it(`${catalogType} catalog entry matches its .ctr source`, () => {
      const full = path.join(VENDOR, rel);
      expect(fs.existsSync(full)).toBe(true);
      const ctr = readContainerDefinition(full);
      const entry = findCatalogEntry(catalogType);
      expect(entry).toBeDefined();

      // Depth — 0.1 mm. Allow ±1 unit of rounding noise.
      const expectedDepth = Math.round(ctr.depth * 10);
      expect(Math.abs(entry.wellDepth - expectedDepth)).toBeLessThanOrEqual(1);

      // hasConicalBottom must agree exactly.
      expect(entry.hasConicalBottom ?? false).toBe(ctr.hasConicalBottom);

      // maxVolume — only assert when the catalog records one.
      if (entry.maxVolume !== undefined) {
        const expectedMax = Math.round(ctr.maxVolumeUl * 10);
        const tolerance = Math.max(20, expectedMax * 0.02);  // 2 % / 2 µL
        expect(Math.abs(entry.maxVolume - expectedMax)).toBeLessThanOrEqual(tolerance);
      }
    });
  }
});
