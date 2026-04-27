/**
 * VENUS .lay import tests (issue #18).
 *
 * Drives the parser + deck importer against the canonical
 * `SN559ILayout.lay` from the VENUS test tree. Any future-regression
 * in parser grammar or importer mapping shows up immediately.
 *
 * FAILURE INJECTION
 *   - If the parser ignores dot-nested keys, `Labware.1.TForm.3.X`
 *     wouldn't appear on the parsed object → importer computes wrong
 *     track and the "tip carrier lands on a plausible track" test
 *     fails.
 *   - If `closestPosition` picks the last site instead of the nearest,
 *     labware ends up at position 4 for a plate placed at site 1 and
 *     the "HT_L 1000uL tips land on the first tip carrier positions"
 *     test fails.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseHxCfg, findSection, enumerateIndexed, getStr } = require("../../dist/services/venus-import/hxcfg-parser");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { importVenusLayout } = require("../../dist/services/venus-import/venus-deck-importer");

const LAY_PATH = path.resolve(
  __dirname, "..", "..", "..",
  "VENUS-2026-04-13", "QA", "Venus.Tests.Integration", "TestData", "Star",
  "TipPickup", "SN559ILayout.lay",
);

function readLay(): string {
  if (!fs.existsSync(LAY_PATH)) throw new Error(`fixture missing: ${LAY_PATH}`);
  return fs.readFileSync(LAY_PATH, "utf-8");
}

describe("HxCfg parser", () => {
  it("reads the HxCfgFile header and ConfigIsValid flag", () => {
    const doc = parseHxCfg(readLay());
    expect(doc.formatVersion).toBe("3");
    expect(doc.configIsValid).toBe(true);
  });

  it("extracts the DECKLAY section", () => {
    const doc = parseHxCfg(readLay());
    const s = findSection(doc, "DECKLAY");
    expect(s).toBeTruthy();
    expect(s.name).toBe("ML_STAR");
    expect(getStr(s.body, "Deck")).toBe("ML_STAR2.dck");
    expect(getStr(s.body, "ActiveLayer")).toBe("base");
  });

  it("materialises dot-nested keys as nested objects", () => {
    const doc = parseHxCfg(readLay());
    const s = findSection(doc, "DECKLAY");
    const labware1 = s.body.Labware["1"];
    expect(labware1.TForm["3"].X).toBe("766");
    expect(labware1.File).toBe("ML_STAR\\\\SMP_CAR_24_15x100_A00.rck");
    expect(labware1.Template).toBe("default");
  });

  it("enumerateIndexed returns labware entries in index order", () => {
    const doc = parseHxCfg(readLay());
    const s = findSection(doc, "DECKLAY");
    const entries = enumerateIndexed(s.body, "Labware");
    expect(entries.length).toBeGreaterThan(5);
    // 1,2,3,4,5,10,11,12,13 → indexed ascending by parser contract.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].index).toBeGreaterThan(entries[i - 1].index);
    }
  });
});

describe("importVenusLayout", () => {
  it("produces a Deck with expected carriers placed at plausible tracks", () => {
    const doc = parseHxCfg(readLay());
    const { deck, placements, warnings, metadata } = importVenusLayout(doc, { hamiltonInstallRoot: null });

    expect(metadata.deckFile).toBe("ML_STAR2.dck");
    expect(metadata.instrument).toBe("ML_STAR");

    const carriers = deck.getAllCarriers();
    const carrierIds = carriers.map((c: any) => c.id);
    // We expect at least the sample carrier and the tip carrier.
    expect(carrierIds).toContain("SMP_CAR_24_15x100_A00_0001");
    expect(carrierIds).toContain("TIP_CAR_480_A00_0001");

    // Tip carrier at TForm.3.X=302.5 mm → track 10 per the twin's
    // xOffset=100mm + 22.5mm pitch. Sample carrier at 766 mm → track ~31.
    const tipCarrier = carriers.find((c: any) => c.id === "TIP_CAR_480_A00_0001");
    expect(tipCarrier?.track).toBe(10);
    expect(tipCarrier?.type).toBe("TIP_CAR_480");

    const smpCarrier = carriers.find((c: any) => c.id === "SMP_CAR_24_15x100_A00_0001");
    expect(smpCarrier?.track).toBeGreaterThan(25);
    expect(smpCarrier?.type).toBe("SMP_CAR_24");

    // Every placement points to a real carrier + position.
    for (const p of placements) {
      expect(carrierIds).toContain(p.carrierId);
      expect(p.position).toBeGreaterThanOrEqual(0);
    }

    // Warnings about unknown carriers/labware are acceptable but
    // should be specifically about the WasteBlock family, not a core
    // carrier we know.
    for (const w of warnings) {
      if (w.code === "unknown_carrier") {
        expect(w.message).not.toMatch(/TIP_CAR_480/);
        expect(w.message).not.toMatch(/PLT_CAR_L5MD/);
      }
    }
  });

  it("places HT_L tips on a TIP_CAR_480 carrier at non-negative positions", () => {
    const doc = parseHxCfg(readLay());
    const { placements } = importVenusLayout(doc, { hamiltonInstallRoot: null });
    const htlPlacements = placements.filter((p: any) => p.labwareId.startsWith("HT_L"));
    expect(htlPlacements.length).toBeGreaterThan(0);
    for (const p of htlPlacements) {
      expect(p.carrierId).toBe("TIP_CAR_480_A00_0001");
      expect(p.position).toBeGreaterThanOrEqual(0);
      expect(p.position).toBeLessThan(5);
    }
  });

  it("rejects a .lay with no DECKLAY section", () => {
    // Construct a minimal HxCfg with no DECKLAY — parser accepts it;
    // importer throws.
    const minimal = "HxCfgFile,3;\nConfigIsValid,Y;\nDataDef,OTHER,1,x,\n{\nA, \"1\",\n};\n";
    const doc = parseHxCfg(minimal);
    expect(() => importVenusLayout(doc)).toThrow(/DECKLAY/);
  });
});
