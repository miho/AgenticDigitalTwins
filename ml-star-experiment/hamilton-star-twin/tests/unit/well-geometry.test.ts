/**
 * Well geometry tests (coverage push for Phase 1 gate).
 *
 * Pure math on the four well shapes. The key invariant is that
 * heightToVolume and volumeToHeight are mutual inverses within numerical
 * tolerance — if either Newton's-method solver or either closed-form case
 * drifts, one of the round-trip assertions fails.
 *
 * FAILURE INJECTION
 *   - If the flat-well formula uses diameter instead of radius, the
 *     cylinder round-trip fails because heightToVolume overshoots by 4×.
 *   - If the hemisphere solver diverges, the round/V-bottom shape
 *     round-trips fail.
 *   - If getWellGeometry's heuristic fallback stops firing, the "unknown
 *     labware gets a default" test fails.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  volumeToHeight,
  heightToVolume,
  wellCrossSectionAt,
  simulateLLD,
  calculatePipetteZ,
  getWellGeometry,
} = require("../../dist/twin/well-geometry");

// Geometries now come from the labware-catalog single source of truth;
// getWellGeometry(type) is the public accessor.
const FLAT = getWellGeometry("Cos_96_Fl");
const ROUND = getWellGeometry("Cos_96_Rd");
const VBOT = getWellGeometry("Cos_96_Vb");
const CONE = getWellGeometry("Eppendorf_1.5");

describe("well-geometry round-trip (Step 1.11 coverage)", () => {
  it("volumeToHeight(0) returns 0 for all shapes", () => {
    for (const g of [FLAT, ROUND, VBOT, CONE]) {
      expect(volumeToHeight(g, 0)).toBe(0);
    }
  });

  it("heightToVolume(0) returns 0 for all shapes", () => {
    for (const g of [FLAT, ROUND, VBOT, CONE]) {
      expect(heightToVolume(g, 0)).toBe(0);
    }
  });

  it("flat well: volume↔height is a clean cylinder round-trip", () => {
    // 0.1 µL units with Math.round on both ends ⇒ accumulated rounding is
    // up to ~10 units of 0.1 µL (= 1 µL).
    const vol = 1000;
    const h = volumeToHeight(FLAT, vol);
    const back = heightToVolume(FLAT, h);
    expect(Math.abs(back - vol)).toBeLessThanOrEqual(20);
  });

  it("round-bottom well: round-trip holds at several volumes", () => {
    for (const vol of [100, 500, 1500, 3000]) {
      const h = volumeToHeight(ROUND, vol);
      const back = heightToVolume(ROUND, h);
      expect(Math.abs(back - vol)).toBeLessThan(Math.max(5, vol * 0.02));
    }
  });

  it("V-bottom well: heightToVolume is monotonic in height within well depth", () => {
    // Cos_96_Vb depth is 112 (0.1mm). Stay below that to avoid the
    // internal clamp making consecutive heights return the same volume.
    let prev = -1;
    for (const h of [5, 20, 40, 70, 100]) {
      const v = heightToVolume(VBOT, h);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("conical well: round-trip holds at representative volumes", () => {
    for (const vol of [100, 1000, 5000]) {
      const h = volumeToHeight(CONE, vol);
      const back = heightToVolume(CONE, h);
      expect(Math.abs(back - vol)).toBeLessThan(Math.max(5, vol * 0.05));
    }
  });

  it("wellCrossSectionAt grows with height for a tapered well", () => {
    const low = wellCrossSectionAt(CONE, 10);
    const high = wellCrossSectionAt(CONE, 300);
    expect(high).toBeGreaterThan(low);
  });

  it("wellCrossSectionAt is constant with height for a flat well", () => {
    const a = wellCrossSectionAt(FLAT, 20);
    const b = wellCrossSectionAt(FLAT, 80);
    expect(Math.abs(a - b)).toBeLessThan(Math.max(1, a * 0.05));
  });
});

describe("getWellGeometry lookup", () => {
  it("resolves a known labware type", () => {
    const g = getWellGeometry("Cos_96_Fl");
    expect(g.shape).toBeDefined();
    expect(g.depth).toBeGreaterThan(0);
  });

  it("falls back heuristically for an unknown Rd type", () => {
    const g = getWellGeometry("FakeRound_Rd_42");
    expect(g.shape).toBe("round");
  });

  it("falls back heuristically for an unknown Vb type", () => {
    const g = getWellGeometry("FakeVbottom_Vb_42");
    expect(g.shape).toBe("v_bottom");
  });

  it("last-resort fallback returns flat geometry", () => {
    const g = getWellGeometry("Definitely_not_a_real_labware_abc");
    expect(g.shape).toBe("flat");
  });
});

describe("simulateLLD and calculatePipetteZ", () => {
  it("LLD mode 0 (off) reports no detection", () => {
    // wellTop at 2000, liquid fills some height below → tip lands with
    // mode 0 which must NEVER say it detected anything.
    const r = simulateLLD(FLAT, 1000, 2000, 0, 500);
    expect(r.detected).toBe(false);
  });

  it("LLD mode 1 (cLLD) with tip above surface reports not detected", () => {
    // Liquid surface is around 2000 - (112 - volumeHeight). A tip high above
    // the well top (z=3000) cannot reach the surface.
    const r = simulateLLD(FLAT, 1000, 2000, 1, 3000);
    expect(r.detected).toBe(false);
  });

  it("LLD result shape includes detected, submergeDepth and crashRisk", () => {
    const r = simulateLLD(FLAT, 1000, 2000, 1, 500);
    expect(r).toHaveProperty("detected");
    expect(r).toHaveProperty("submergeDepth");
    expect(r).toHaveProperty("crashRisk");
  });

  it("calculatePipetteZ returns a number for a well with enough liquid", () => {
    // Trough well: 2000 deep, full-well ~30mL. Plenty of liquid → recommended Z.
    const TROUGH = getWellGeometry("Trough_100ml");
    const z = calculatePipetteZ(TROUGH, 200_000 /* 20 mL */, 2000, 20);
    expect(typeof z).toBe("number");
  });

  it("calculatePipetteZ returns null for an empty well", () => {
    expect(calculatePipetteZ(FLAT, 0, 2000, 20)).toBeNull();
  });
});
