/**
 * C0AS / C0DS real-trace fidelity.
 *
 * Pins the twin against two real VENUS ComTrace recordings, one aspirate
 * and one dispense, both from the CapacitiveLLD Stage-5 trace. The goal
 * is to catch silent regressions where:
 *
 *  - fw-protocol stops parsing a key VENUS sends (renamed handler,
 *    regex drift, &-boundary off-by-one).
 *  - The twin stops accepting the command (SCXML transition lost, state
 *    machine regressed, module-registry drift).
 *  - The catalog falls out of sync with reality (field added/removed
 *    upstream without a documentation update).
 *
 * The catalog (`src/twin/pip-command-catalog.ts`) is the single source of
 * truth for which params VENUS sends; the traces below are verbatim.
 */
import { describe, it, expect } from "vitest";
import { parseFwCommand } from "../../src/twin/fw-protocol";
import {
  C0AS_PARAMS,
  C0DS_PARAMS,
  REAL_C0AS_TRACE,
  REAL_C0DS_TRACE,
  findC0ASParam,
  findC0DSParam,
} from "../../src/twin/pip-command-catalog";
import { estimateCommandTime } from "../../src/twin/command-timing";

describe("C0AS real-trace fidelity", () => {
  it("parser extracts every key listed in C0AS_PARAMS from the real trace", () => {
    const parsed = parseFwCommand(REAL_C0AS_TRACE);

    expect(parsed.event).toBe("C0AS");
    expect(parsed.orderId).toBe(264);

    const missing: string[] = [];
    for (const spec of C0AS_PARAMS) {
      if (!(spec.key in parsed.params)) missing.push(spec.key);
    }
    expect(missing).toEqual([]);
  });

  it("per-channel yp parses as an 8-value array with the real-trace values", () => {
    const parsed = parseFwCommand(REAL_C0AS_TRACE);
    expect(parsed.arrayParams?.yp).toEqual([3380, 3290, 3200, 3110, 3020, 2930, 2840, 2750]);
  });

  it("traceExample values round-trip — parsed int equals parseInt(traceExample)", () => {
    const parsed = parseFwCommand(REAL_C0AS_TRACE);
    const mismatches: string[] = [];
    for (const spec of C0AS_PARAMS) {
      // yp, xp, tm etc. may parse into arrayParams if multi-valued.
      const actual = parsed.params[spec.key];
      const expected = parseInt(spec.traceExample, 10);
      // yp in the catalog tracks channel 0 — skip; array asserted above.
      if (spec.key === "yp") continue;
      if (actual !== expected) mismatches.push(`${spec.key}: catalog=${spec.traceExample} parsed=${actual}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("no extra keys appear in the trace beyond the catalog — catalog is exhaustive", () => {
    const parsed = parseFwCommand(REAL_C0AS_TRACE);
    const cataloged = new Set(C0AS_PARAMS.map((p) => p.key));
    const extras = Object.keys(parsed.params).filter((k) => !cataloged.has(k));
    expect(extras).toEqual([]);
  });

  it("C0AS timing honors wt (settling) and po (pull-out air retract)", () => {
    const parsed = parseFwCommand(REAL_C0AS_TRACE);
    // Longer settle + bigger retract ⇒ longer total.
    const slow = estimateCommandTime("C0AS", { ...parsed.params, wt: 100, po: 1000 });
    const fast = estimateCommandTime("C0AS", { ...parsed.params, wt: 10, po: 0 });
    // wt diff: (100-10)*100ms = 9000ms; po diff: 100mm/300mm·s = ~333ms
    expect(slow).toBeGreaterThan(fast + 9000);
  });

  it("findC0ASParam lookup works for every catalog entry", () => {
    for (const spec of C0AS_PARAMS) {
      expect(findC0ASParam(spec.key)).toBe(spec);
    }
    expect(findC0ASParam("zz")).toBeUndefined();
  });
});

describe("C0DS real-trace fidelity", () => {
  it("parser extracts every key listed in C0DS_PARAMS from the real trace", () => {
    const parsed = parseFwCommand(REAL_C0DS_TRACE);

    expect(parsed.event).toBe("C0DS");
    expect(parsed.orderId).toBe(266);

    const missing: string[] = [];
    for (const spec of C0DS_PARAMS) {
      if (!(spec.key in parsed.params)) missing.push(spec.key);
    }
    expect(missing).toEqual([]);
  });

  it("per-channel yp parses as an 8-value array with the real-trace values", () => {
    const parsed = parseFwCommand(REAL_C0DS_TRACE);
    expect(parsed.arrayParams?.yp).toEqual([5400, 5200, 5000, 4800, 4600, 4400, 4200, 4000]);
  });

  it("traceExample values round-trip — parsed int equals parseInt(traceExample)", () => {
    const parsed = parseFwCommand(REAL_C0DS_TRACE);
    const mismatches: string[] = [];
    for (const spec of C0DS_PARAMS) {
      const actual = parsed.params[spec.key];
      const expected = parseInt(spec.traceExample, 10);
      if (spec.key === "yp") continue;
      if (actual !== expected) mismatches.push(`${spec.key}: catalog=${spec.traceExample} parsed=${actual}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("no extra keys appear in the trace beyond the catalog — catalog is exhaustive", () => {
    const parsed = parseFwCommand(REAL_C0DS_TRACE);
    const cataloged = new Set(C0DS_PARAMS.map((p) => p.key));
    const extras = Object.keys(parsed.params).filter((k) => !cataloged.has(k));
    expect(extras).toEqual([]);
  });

  it("C0DS timing honors po (pull-out air retract) even when wt=0", () => {
    const parsed = parseFwCommand(REAL_C0DS_TRACE);
    const withPo = estimateCommandTime("C0DS", parsed.params);
    const withoutPo = estimateCommandTime("C0DS", { ...parsed.params, po: 0 });
    // po=50 = 5mm @ 300mm/s = ~17ms. Small but present.
    expect(withPo).toBeGreaterThan(withoutPo);
  });

  it("findC0DSParam lookup works for every catalog entry", () => {
    for (const spec of C0DS_PARAMS) {
      expect(findC0DSParam(spec.key)).toBe(spec);
    }
    expect(findC0DSParam("zz")).toBeUndefined();
  });
});

describe("C0AS / C0DS catalog invariants", () => {
  it("every catalog entry has a 2-letter lowercase key", () => {
    for (const spec of [...C0AS_PARAMS, ...C0DS_PARAMS]) {
      expect(spec.key).toMatch(/^[a-z]{2}$/);
    }
  });

  it("every catalog entry has a non-empty source reference to AtsMc*.cpp", () => {
    for (const spec of [...C0AS_PARAMS, ...C0DS_PARAMS]) {
      expect(spec.sourceRef).toMatch(/^AtsMc(Aspirate|Dispense)\.cpp:\d+$/);
    }
  });

  it("every catalog entry has at least one consumer role", () => {
    for (const spec of [...C0AS_PARAMS, ...C0DS_PARAMS]) {
      expect(spec.consumedBy.length).toBeGreaterThan(0);
    }
  });

  it("catalog has no duplicate keys within a single command", () => {
    const asKeys = C0AS_PARAMS.map((p) => p.key);
    const dsKeys = C0DS_PARAMS.map((p) => p.key);
    expect(new Set(asKeys).size).toBe(asKeys.length);
    expect(new Set(dsKeys).size).toBe(dsKeys.length);
  });
});
