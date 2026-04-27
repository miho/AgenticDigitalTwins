/**
 * Unit tests for src/twin/venus-config.ts.
 *
 * Two main things being locked down here:
 *
 *  1. The HxCfgFil section parser round-trips the real `ML_STAR.cfg`
 *     the production VENUS install ships with, including comment
 *     stripping and multi-section separation.
 *
 *  2. The FW-payload encoders emit the exact bytes the Phase 5/6
 *     work pinned against real ComTrace recordings. If anyone ever
 *     tweaks a field by accident, these tests fire before VENUS does.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import {
  DEFAULT_CONFIG,
  MODULE_BITS,
  buildVenusConfig,
  encodeC0QM,
  encodeC0RF,
  encodeC0RI,
  encodeC0RM,
  encodeC0RU,
  extractCfgValues,
  inferFromDeck,
  parseHxCfgSections,
} from "../../src/twin/venus-config";
import { Deck } from "../../src/twin/deck";

const VENUS_ROOT = path.join(__dirname, "../../../VENUS-2026-04-13");
const ML_STAR_CFG = path.join(VENUS_ROOT, "Star/src/HxGruCommand/Config/ML_STAR.cfg");

describe("parseHxCfgSections", () => {
  it("splits sections by DataDef header and keeps dotted keys", () => {
    const content = [
      "* header comment — skip",
      "DataDef,Example,1,default,",
      "{",
      '  Key1, "val1",',
      '  Nested.Key, "nested val",',
      '  Indexed.1.K, "idx"',
      "};",
      "",
      "DataDef,Other,1,default,",
      "{",
      '  Only, "here"',
      "};",
    ].join("\n");

    const sections = parseHxCfgSections(content);
    expect(sections.has("Example:default")).toBe(true);
    expect(sections.has("Other:default")).toBe(true);

    const ex = sections.get("Example:default")!;
    expect(ex.get("Key1")).toBe("val1");
    expect(ex.get("Nested.Key")).toBe("nested val");
    expect(ex.get("Indexed.1.K")).toBe("idx");

    const other = sections.get("Other:default")!;
    expect(other.get("Only")).toBe("here");
    expect(other.has("Key1")).toBe(false);
  });

  it("strips `*` line comments and ignores stray braces", () => {
    const content = [
      "DataDef,S,1,default,",
      "{",
      '  Live, "yes",   * trailing comment',
      '*  Dead, "no",',
      "};",
    ].join("\n");
    const sections = parseHxCfgSections(content);
    const s = sections.get("S:default")!;
    expect(s.get("Live")).toBe("yes");
    expect(s.has("Dead")).toBe(false);
  });

  it("parses the production ML_STAR.cfg without exploding", () => {
    if (!fs.existsSync(ML_STAR_CFG)) {
      // Repo checkout without VENUS source — skip rather than fail.
      return;
    }
    const content = fs.readFileSync(ML_STAR_CFG, "utf-8");
    const sections = parseHxCfgSections(content);
    // Should have picked up the well-known DataDefs at the top.
    expect(sections.has("MLSTARInstrument:default")).toBe(true);
    expect(sections.has("HxTcpIpBdzComm:default")).toBe(true);
    expect(sections.has("FDxProtocol:default")).toBe(true);

    const bdz = sections.get("HxTcpIpBdzComm:default")!;
    expect(bdz.get("ModuleId")).toBe("1");
    expect(bdz.get("DeviceId")).toBe("0");
  });
});

describe("extractCfgValues", () => {
  it("leaves fields undefined when cfg is silent", () => {
    const sections = parseHxCfgSections("DataDef,Nothing,1,default,\n{\n};");
    expect(extractCfgValues(sections)).toEqual({});
  });

  it("does not pick up the default ModuleId=\"1\" as a serial", () => {
    // The real ML_STAR.cfg ships with placeholder "1" — that must not
    // override the twin's real serial, which comes from discovery.
    const sections = parseHxCfgSections([
      "DataDef,HxTcpIpBdzComm,1,default,",
      "{",
      '  ModuleId, "1"',
      "};",
    ].join("\n"));
    expect(extractCfgValues(sections).serial).toBeUndefined();
  });

  it("treats a non-default ModuleId as a serial override", () => {
    const sections = parseHxCfgSections([
      "DataDef,HxTcpIpBdzComm,1,default,",
      "{",
      '  ModuleId, "559I_XYZ"',
      "};",
    ].join("\n"));
    expect(extractCfgValues(sections).serial).toBe("559I_XYZ");
  });
});

describe("inferFromDeck", () => {
  it("sets only the tracks field for a fresh-empty STAR deck", () => {
    const deck = new Deck("STAR");
    const inferred = inferFromDeck(deck);
    expect(inferred.totalTracks).toBe(54);
    expect(inferred.moduleBits).toBeUndefined();
    expect(inferred.statusBits).toBeUndefined();
  });

  it("sets the core96Head bit when a 96-head waste is on-deck", () => {
    const deck = new Deck("STAR");
    deck.loadCarrier({
      id: "tc1",
      type: "WasteBlock",
      track: 45,
      widthTracks: 3,
      positions: 1,
      labware: [{
        type: "Core96Waste",
        wellCount: 96,
        rows: 8, columns: 12, wellPitch: 90,
        offsetX: 0, offsetY: 0, height: 100, wellDepth: 0,
      }],
    });
    const inferred = inferFromDeck(deck);
    expect(inferred.moduleBits).toBeDefined();
    expect(inferred.moduleBits! & MODULE_BITS.core96Head).toBe(MODULE_BITS.core96Head);
    // Default bits remain set.
    expect(inferred.moduleBits! & MODULE_BITS.newLeftXDrive).toBe(MODULE_BITS.newLeftXDrive);
    expect(inferred.moduleBits! & MODULE_BITS.iswapGripperSize).toBe(MODULE_BITS.iswapGripperSize);
  });

  it("STARlet deck propagates the 30-track count", () => {
    const deck = new Deck("STARlet");
    expect(inferFromDeck(deck).totalTracks).toBe(30);
  });
});

describe("buildVenusConfig precedence", () => {
  it("overrides win over cfg-file, which wins over deck inference, which wins over defaults", () => {
    const deck = new Deck("STAR");
    const cfgSections = parseHxCfgSections([
      "DataDef,HxTcpIpBdzComm,1,default,",
      "{",
      '  ModuleId, "FROM_CFG"',
      "};",
    ].join("\n"));

    const cfgOnly = buildVenusConfig({ deck, cfgSections });
    expect(cfgOnly.serial).toBe("FROM_CFG");
    expect(cfgOnly.totalTracks).toBe(54);

    const overridden = buildVenusConfig({
      deck,
      cfgSections,
      overrides: { serial: "FROM_OVERRIDE", totalTracks: 42 },
    });
    expect(overridden.serial).toBe("FROM_OVERRIDE");
    expect(overridden.totalTracks).toBe(42);
  });
});

describe("encoders (wire-format lock)", () => {
  it("encodeC0QM matches the 54-track default reference string", () => {
    expect(encodeC0QM(DEFAULT_CONFIG)).toBe(
      "ka010301xt54xa54xw13400xl07xr00xm03600xx11400ys090xu3540xv3700yu0060kl360kc0yx0060ke00003000xn00xo00ym6065kr0km360",
    );
  });

  it("encodeC0RM matches the default 8-channel status block", () => {
    expect(encodeC0RM(DEFAULT_CONFIG)).toBe(
      "kb0Fkp08 C00000 X00000 P10000 P20000 P30000 P40000 P50000 P60000 P70000 P80000 I00000 R00000 H00000 SL0008",
    );
  });

  it("encodeC0RI matches the default 559I identity", () => {
    expect(encodeC0RI(DEFAULT_CONFIG)).toBe("si2022-05-31sn559I");
  });

  it("encodeC0RF returns the default firmware banner", () => {
    expect(encodeC0RF(DEFAULT_CONFIG)).toBe("7.6S 35 2025-10-22 (GRU C0)");
  });

  it("encodeC0RU matches the single-arm 54-track reference", () => {
    expect(encodeC0RU(DEFAULT_CONFIG)).toBe("00950 13400 30000 30000");
  });

  it("encodeC0QM reflects the core96Head bit when deck inference flips it", () => {
    const deck = new Deck("STAR");
    deck.loadCarrier({
      id: "tc96",
      type: "WasteBlock",
      track: 45,
      widthTracks: 3,
      positions: 1,
      labware: [{
        type: "MPH96Waste",
        wellCount: 96, rows: 8, columns: 12, wellPitch: 90,
        offsetX: 0, offsetY: 0, height: 100, wellDepth: 0,
      }],
    });
    const cfg = buildVenusConfig({ deck });
    const wire = encodeC0QM(cfg);
    // 0x010303 = default (0x010301) | core96Head (0x02)
    expect(wire.startsWith("ka010303")).toBe(true);
  });
});
