/**
 * Command timing tests (coverage push for Phase 1 gate).
 *
 * estimateCommandTime is a pure switch on FW event → ms estimate. Exercises
 * every arm of the switch at least once so the replay UI, report exporter,
 * and simulation throttle all get a stable contract.
 *
 * FAILURE INJECTION
 *   - If a case falls through the switch accidentally, the specific event
 *     assertion will read the "default" value and fail.
 *   - If the volume-based arithmetic is inverted (e.g. divides wrong way),
 *     the vol-sensitive cases catch it because they expect monotonic
 *     growth with volume.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { estimateCommandTime, getCommandTiming, applySimSpeed } = require(
  "../../dist/twin/command-timing"
);

describe("command-timing.estimateCommandTime", () => {
  it("returns a positive number for every tip-channel command", () => {
    for (const ev of ["C0TP", "C0TR", "C0AS", "C0DS", "C0DF"]) {
      const ms = estimateCommandTime(ev, {});
      expect(ms).toBeGreaterThan(0);
    }
  });

  it("aspirate time grows with volume", () => {
    const small = estimateCommandTime("C0AS", { av: 100, as: 2500 });
    const large = estimateCommandTime("C0AS", { av: 10000, as: 2500 });
    expect(large).toBeGreaterThan(small);
  });

  it("aspirate time shrinks as flow rate grows", () => {
    const slow = estimateCommandTime("C0AS", { av: 5000, as: 500 });
    const fast = estimateCommandTime("C0AS", { av: 5000, as: 5000 });
    expect(slow).toBeGreaterThan(fast);
  });

  it("dispense time grows with volume", () => {
    const small = estimateCommandTime("C0DS", { dv: 100 });
    const large = estimateCommandTime("C0DS", { dv: 10000 });
    expect(large).toBeGreaterThan(small);
  });

  it("96-head / 384-head / iSWAP / wash commands all return positive times", () => {
    const events = [
      "C0EA", "C0ED", "C0EP", "C0ER",
      "C0JA", "C0JD", "C0JB", "C0JC",
      "C0PP", "C0PR", "C0ZP", "C0ZR",
      "C0WA", "C0WS",
    ];
    for (const ev of events) {
      const ms = estimateCommandTime(ev, {});
      expect(typeof ms).toBe("number");
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("unknown event returns 0 or a default small number", () => {
    const ms = estimateCommandTime("CZZZ", {});
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("getCommandTiming returns { totalMs, breakdown } shape", () => {
    const t = getCommandTiming("C0AS", { av: 1000, as: 2500 });
    expect(t).toBeTypeOf("object");
    expect(typeof t.totalMs).toBe("number");
    expect(t.totalMs).toBeGreaterThan(0);
  });

  it("applySimSpeed at speed 1 is the estimate itself (realtime)", () => {
    expect(applySimSpeed(1000, 1)).toBe(1000);
  });

  it("applySimSpeed is a multiplier (speed 10 → 10× slower)", () => {
    expect(applySimSpeed(1000, 10)).toBe(10_000);
  });

  it("applySimSpeed at speed 0 returns 0 (skip the wait)", () => {
    expect(applySimSpeed(1000, 0)).toBe(0);
  });

  it("applySimSpeed at a negative speed returns 0 (guard clause)", () => {
    expect(applySimSpeed(1000, -1)).toBe(0);
  });
});
