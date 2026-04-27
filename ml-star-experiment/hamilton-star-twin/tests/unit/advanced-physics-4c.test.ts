/**
 * Phase 4.C remaining: layered channels + clot TADM + liquid-following.
 *
 * Each observation gets a positive / negative / boundary triple.
 *
 * FAILURE INJECTION
 *   - If `popVolume` drains the bottom first, the multi-layer test
 *     sees a liquid layer returned when we only removed air.
 *   - If clot perturbation doesn't dip below tolerance at peak, the
 *     TADM clot fixture reports `passed: true` and the test fails.
 *   - If checkLiquidFollow returns the severity inversely, the
 *     high-depletion fast-aspirate case fires `info` instead of
 *     `warning` and the test rejects it.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  AdvancedPhysics,
  LIQUID_FOLLOW_QUALITY_WARN,
  DEFAULT_LIQUID_CLASS,
} = require("../../dist/twin/plugins/advanced-physics");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateAspirateCurve } = require("../../dist/twin/tadm");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getLiquidClass } = require("../../dist/twin/liquid-classes");

describe("ChannelLayer stack", () => {
  it("push adds layers in order; the top layer is last-in", () => {
    const plugin = new AdvancedPhysics();
    plugin.pushLayer(0, { kind: "air", volume: 50 });
    plugin.pushLayer(0, { kind: "liquid", volume: 200, liquidType: "water" });
    const stack = plugin.getLayerStack(0);
    expect(stack).toHaveLength(2);
    expect(stack[0].kind).toBe("air");
    expect(stack[stack.length - 1].kind).toBe("liquid");
  });

  it("popVolume removes from the top, spanning layers as needed", () => {
    const plugin = new AdvancedPhysics();
    plugin.pushLayer(0, { kind: "liquid", volume: 100, liquidType: "water" });
    plugin.pushLayer(0, { kind: "air", volume: 30 });
    const removed = plugin.popVolume(0, 50);
    expect(removed[0].kind).toBe("air");
    expect(removed[0].volume).toBe(30);
    expect(removed[1].kind).toBe("liquid");
    expect(removed[1].volume).toBe(20);
    const after = plugin.getLayerStack(0);
    expect(after).toHaveLength(1);
    expect(after[0].kind).toBe("liquid");
    expect(after[0].volume).toBe(80);
  });

  it("dispensing with an air layer on top emits an air_gap_disorder warning", () => {
    const plugin = new AdvancedPhysics();
    // Channel 0: air on top of liquid.
    plugin.pushLayer(0, { kind: "liquid", volume: 500, liquidType: "water" });
    plugin.pushLayer(0, { kind: "air", volume: 50 });
    const events = plugin.assess("C0DS", { tm: 1, ds: 100 });
    const warn = events.find((e) => e.category === "air_gap_disorder");
    expect(warn).toBeTruthy();
    expect(warn.data.channel).toBe(0);
  });

  it("dispensing with liquid on top emits no air_gap_disorder", () => {
    const plugin = new AdvancedPhysics();
    plugin.pushLayer(0, { kind: "liquid", volume: 500, liquidType: "water" });
    const events = plugin.assess("C0DS", { tm: 1, ds: 100 });
    expect(events.find((e) => e.category === "air_gap_disorder")).toBeUndefined();
  });
});

describe("TADM clot perturbation", () => {
  it("clean aspirate has passed=true and no perturbation", () => {
    const r = generateAspirateCurve(1000, 500, 1.0);
    expect(r.passed).toBe(true);
    expect(r.perturbation).toBeUndefined();
  });

  it("clot perturbation fails the tolerance check with perturbation=clot", () => {
    const r = generateAspirateCurve(1000, 500, 1.0, 50, 50, { perturbation: "clot" });
    expect(r.perturbation).toBe("clot");
    expect(r.passed).toBe(false);
    expect(typeof r.violationIndex).toBe("number");
  });

  it("clot peak pressure is substantially larger than clean baseline", () => {
    const clean = generateAspirateCurve(1000, 500, 1.0);
    const clot = generateAspirateCurve(1000, 500, 1.0, 50, 50, { perturbation: "clot" });
    expect(clot.peakPressure).toBeGreaterThan(clean.peakPressure);
  });

  it("plugin surfaces a 'clot' assessment when _tadm carries the perturbation", () => {
    const plugin = new AdvancedPhysics();
    const tadm = generateAspirateCurve(1000, 500, 1.0, 50, 50, { perturbation: "clot" });
    const events = plugin.assess("C0AS", { _tadm: tadm });
    const clot = events.find((e) => e.category === "clot");
    expect(clot).toBeTruthy();
    expect(clot.severity).toBe("error");
  });
});

describe("Liquid-following quality", () => {
  function lc() {
    const k = getLiquidClass(DEFAULT_LIQUID_CLASS);
    if (!k) throw new Error("liquid class missing");
    return k;
  }

  it("low depletion + default speed → info-level quality trace", () => {
    const plugin = new AdvancedPhysics();
    const klass = lc();
    const events = plugin.assess("C0AS", {
      av: 100,
      as: klass.aspiration.speed,
      _wellVolume: 2000,
      lf: 1,
    });
    const follow = events.find((e) => e.category === "liquid_follow");
    expect(follow).toBeTruthy();
    expect(follow.severity).toBe("info");
    expect(follow.data.score).toBeGreaterThanOrEqual(LIQUID_FOLLOW_QUALITY_WARN);
  });

  it("high depletion + 2× speed → warning-level quality", () => {
    const plugin = new AdvancedPhysics();
    const klass = lc();
    const events = plugin.assess("C0AS", {
      av: 900,
      as: klass.aspiration.speed * 2,
      _wellVolume: 1000,
      lf: 1,
    });
    const follow = events.find((e) => e.category === "liquid_follow");
    expect(follow).toBeTruthy();
    expect(follow.severity).toBe("warning");
    expect(follow.data.score).toBeLessThan(LIQUID_FOLLOW_QUALITY_WARN);
  });

  it("boundary at threshold emits info (inclusive)", () => {
    const plugin = new AdvancedPhysics();
    const klass = lc();
    // Craft av/wellVolume such that score lands near threshold.
    const events = plugin.assess("C0AS", {
      av: 150,
      as: klass.aspiration.speed,
      _wellVolume: 1000,
      lf: 1,
    });
    const follow = events.find((e) => e.category === "liquid_follow");
    expect(follow).toBeTruthy();
    expect(follow.severity).toBe("info");
  });

  it("no quality trace when liquid following is OFF (lf=0)", () => {
    const plugin = new AdvancedPhysics();
    const klass = lc();
    const events = plugin.assess("C0AS", {
      av: 100,
      as: klass.aspiration.speed,
      _wellVolume: 2000,
      lf: 0,
    });
    expect(events.find((e) => e.category === "liquid_follow")).toBeUndefined();
  });
});
