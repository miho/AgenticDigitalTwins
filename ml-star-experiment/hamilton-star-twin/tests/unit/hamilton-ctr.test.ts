/**
 * Unit tests for the .ctr (container) parser + its wiring into the
 * venus-deck-importer. Guards #55 part A: well depth / conical-bottom
 * flag / max-volume estimates must flow from the Hamilton install
 * into LabwareItem so the liquid tracker + inspector use real
 * geometry rather than the hand-curated catalog defaults.
 *
 * These tests are soft-gated behind the Hamilton install — they skip
 * cleanly on CI runners that don't have Config/ + Labware/ under
 * `C:/Program Files (x86)/Hamilton/`. When the install IS present,
 * they pin specific numeric expectations against a well-known .ctr
 * (Cos_96_DW_1mL: 40 mm depth, conical bottom).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { readContainerDefinition } from "../../src/services/venus-import/hamilton-config-loader";
import { parseHxCfg } from "../../src/services/venus-import/hxcfg-parser";
import { importVenusLayout } from "../../src/services/venus-import/venus-deck-importer";

const HAMILTON_ROOT = "C:/Program Files (x86)/Hamilton";
const COS_96_DW = `${HAMILTON_ROOT}/Labware/CORNING-COSTAR/Cos_96_DW_1mL.ctr`;
const METHOD1_LAY = `${HAMILTON_ROOT}/Methods/Method1.lay`;

function hamiltonInstallPresent(): boolean {
  return fs.existsSync(COS_96_DW);
}

describe("Hamilton .ctr parser (#55 part A)", () => {
  it("parses Cos_96_DW_1mL.ctr — 40 mm deep, conical bottom, ~1 mL cylindrical max", () => {
    if (!hamiltonInstallPresent()) return;  // skip on CI

    const ctr = readContainerDefinition(COS_96_DW);
    expect(ctr.depth).toBe(40);
    expect(ctr.hasConicalBottom).toBe(true);
    // Dim.Dx = Dim.Dy = 6.5 mm → circular cross-section
    // max ≈ π(3.25)² × 40 ≈ 1327 µL. Allow slack for derivation tweaks.
    expect(ctr.maxVolumeUl).toBeGreaterThan(1200);
    expect(ctr.maxVolumeUl).toBeLessThan(1500);
    // Dead volume (cone area × cone height) — cone height 2.5 mm,
    // area ≈ π(3.25)² = 33.2 mm² → ~83 µL. Allow slack.
    expect(ctr.deadVolumeUl).toBeGreaterThan(50);
    expect(ctr.deadVolumeUl).toBeLessThan(150);
  });

  it("flows .ctr geometry into LabwareItem when importing a .lay", () => {
    if (!hamiltonInstallPresent() || !fs.existsSync(METHOD1_LAY)) return;

    const doc = parseHxCfg(fs.readFileSync(METHOD1_LAY));
    const { deck } = importVenusLayout(doc);
    const snap = deck.getSnapshot();
    // Method1.lay → PLT_CAR_L5AC with Cos_96_DW_1mL plates at sites 0 & 4.
    const plateCarrier = snap.carriers.find(c => c.type === "PLT_CAR_L5AC_A00");
    expect(plateCarrier, "PLT_CAR_L5AC_A00 carrier expected in Method1.lay").toBeDefined();
    const plateLabware = plateCarrier!.labware.find(lw => lw !== null && lw.wellCount === 96);
    expect(plateLabware, "96-well plate labware expected").toBeTruthy();
    // wellDepth stored as 0.1 mm
    expect(plateLabware!.wellDepth).toBe(400);  // 40 mm
    expect(plateLabware!.hasConicalBottom).toBe(true);
    expect(plateLabware!.maxVolume, "maxVolume populated from .ctr").toBeGreaterThan(0);
  });

  it("imports the WasteBlock carrier past the nominal track grid (Method1.lay)", () => {
    if (!hamiltonInstallPresent() || !fs.existsSync(METHOD1_LAY)) return;

    // Method1.lay puts a WasteBlock at TForm.3.X=1318 mm — past the
    // 54-track nominal grid. Before the margin-tracks fix the carrier
    // was silently dropped and VENUS's C0TR (tip eject, xp=13400 =
    // 1340 mm, which is on the WasteBlock rail) landed on "no
    // carrier". Regression guard for both: the margin-tracks relax
    // in Deck.loadCarrier AND the `ceil(dx/22.5)` widthTracks that
    // makes a 30-mm carrier cover 2 tracks so its child labware fits
    // within the computed X range.
    const doc = parseHxCfg(fs.readFileSync(METHOD1_LAY));
    const { deck } = importVenusLayout(doc);
    const snap = deck.getSnapshot();
    const waste = snap.carriers.find(c => c.id === "WasteBlock");
    expect(waste, "WasteBlock carrier must be imported, not silently dropped").toBeDefined();
    // Its xMax must cover the VENUS-issued eject X (1340 mm) within
    // the resolver's 50-unit tolerance — i.e. xMax + 50 ≥ 13400.
    expect(waste!.xMax + 50).toBeGreaterThanOrEqual(13400);
  });

  it("skips .ctr gracefully when no file sits alongside the .rck", () => {
    if (!hamiltonInstallPresent() || !fs.existsSync(METHOD1_LAY)) return;

    // Import doesn't throw, and labware without a resolved .ctr
    // simply reports `undefined` for the new optional geometry fields
    // rather than crashing the import.
    const doc = parseHxCfg(fs.readFileSync(METHOD1_LAY));
    const { deck, warnings } = importVenusLayout(doc);
    const snap = deck.getSnapshot();
    expect(snap.carriers.length).toBeGreaterThan(0);
    // No warnings about .ctr — same-stem lookup either succeeds or is
    // silently skipped.
    const ctrWarn = warnings.find(w => w.message.includes(".ctr"));
    expect(ctrWarn, "no .ctr warning on a well-formed Hamilton install").toBeUndefined();
  });
});
