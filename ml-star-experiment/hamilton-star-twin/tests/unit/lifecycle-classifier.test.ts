/**
 * Event lifecycle classifier tests (Step 3.3).
 *
 * Exercises each rule in isolation with hand-built timelines so failures
 * point at one specific rule. Also verifies idempotency — running
 * autoClassify twice must produce the same result, so callers can
 * re-classify after appending new events without double-counting.
 *
 * FAILURE INJECTION
 *   - If `classifyInitial` forgets error-severity → flagged, the
 *     "error assessments start flagged" test fails.
 *   - If `resolveContaminationByTipEject` walks backward instead of
 *     forward, "subsequent C0TR resolves" misses the tip eject.
 *   - If `suppressQueryUnresolveds` doesn't check targetModule, it'll
 *     mark real out-of-deck errors as suppressed.
 *   - If `autoClassify` isn't idempotent, running it twice flips states.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { autoClassify, classify, classifyInitial, getFlagged, getSummary } = require(
  "../../dist/twin/lifecycle-classifier",
);

function makeAssessment(overrides: any = {}): any {
  return {
    id: 1,
    timestamp: 0,
    kind: "assessment",
    correlationId: 100,
    payload: {
      id: 1,
      timestamp: 0,
      category: "tadm",
      severity: "info",
      module: "pip",
      command: "C0AS",
      description: "stub",
      ...overrides.payload,
    },
    severity: overrides.payload?.severity ?? "info",
    ...overrides,
  };
}

function makeCommand(overrides: any = {}): any {
  return {
    id: 2,
    timestamp: 0,
    kind: "command",
    correlationId: 100,
    payload: {
      rawCommand: "C0RFid9001",
      response: "C0RF@00",
      targetModule: "system",
      activeStates: {},
      variables: {},
      logs: [],
      accepted: true,
      errorCode: 0,
      errorDescription: "",
      correlationId: 100,
      ...overrides.payload,
    },
    ...overrides,
  };
}

describe("lifecycle classifier (Step 3.3)", () => {
  describe("classifyInitial", () => {
    it("error assessments start as 'flagged'", () => {
      const e = makeAssessment({ payload: { severity: "error", category: "tip_crash" } });
      expect(classifyInitial(e)).toBe("flagged");
    });

    it("warning assessments start as 'flagged'", () => {
      const e = makeAssessment({ payload: { severity: "warning", category: "contamination" } });
      expect(classifyInitial(e)).toBe("flagged");
    });

    it("info assessments start as 'active'", () => {
      const e = makeAssessment({ payload: { severity: "info", category: "tadm" } });
      expect(classifyInitial(e)).toBe("active");
    });

    it("successful commands start as 'active'", () => {
      const e = makeCommand();
      expect(classifyInitial(e)).toBe("active");
    });

    it("failed commands (errorCode != 0) start as 'flagged'", () => {
      const e = makeCommand({ payload: { errorCode: 8, accepted: false } });
      expect(classifyInitial(e)).toBe("flagged");
    });
  });

  describe("autoClassify", () => {
    it("contamination-flagged event is resolved by subsequent C0TR", () => {
      const timeline = [
        makeAssessment({
          id: 1,
          correlationId: 100,
          severity: "warning",
          payload: { category: "contamination", severity: "warning", channel: 2 },
        }),
        // Later: tip eject. Resolves the contamination.
        makeCommand({
          id: 2,
          correlationId: 200,
          payload: { rawCommand: "C0TRid0002tm04", errorCode: 0 },
        }),
      ];
      autoClassify(timeline);
      expect(timeline[0].lifecycle).toBe("resolved");
    });

    it("contamination stays flagged when no C0TR follows", () => {
      const timeline = [
        makeAssessment({
          id: 1,
          severity: "warning",
          payload: { category: "contamination", severity: "warning" },
        }),
        makeCommand({ id: 2, payload: { rawCommand: "C0RFid9001" } }),
      ];
      autoClassify(timeline);
      expect(timeline[0].lifecycle).toBe("flagged");
    });

    it("unresolved_position on a query command becomes 'suppressed'", () => {
      // Classifier looks up the triggering command by correlationId;
      // the command is a query (targetModule === "system"), so the
      // unresolved should be demoted to noise.
      const timeline = [
        makeCommand({
          id: 1,
          correlationId: 50,
          payload: { rawCommand: "C0RFid0001", targetModule: "system" },
        }),
        makeAssessment({
          id: 2,
          correlationId: 50,
          severity: "error",
          payload: { category: "unresolved_position", severity: "error" },
        }),
      ];
      autoClassify(timeline);
      expect(timeline[1].lifecycle).toBe("suppressed");
    });

    it("unresolved_position on a real positional command stays 'flagged'", () => {
      const timeline = [
        makeCommand({
          id: 1,
          correlationId: 51,
          payload: {
            rawCommand: "C0ASid0100xp00000yp00000av01000tm001lm0",
            targetModule: "PIP",
          },
        }),
        makeAssessment({
          id: 2,
          correlationId: 51,
          severity: "error",
          payload: { category: "unresolved_position", severity: "error" },
        }),
      ];
      autoClassify(timeline);
      expect(timeline[1].lifecycle).toBe("flagged");
    });

    it("is idempotent — running twice produces the same output", () => {
      const timeline = [
        makeAssessment({ id: 1, severity: "warning",
          payload: { category: "contamination", severity: "warning" } }),
        makeCommand({ id: 2, payload: { rawCommand: "C0TRid0002tm04" } }),
        makeAssessment({ id: 3, severity: "info",
          payload: { category: "tadm", severity: "info" } }),
      ];
      autoClassify(timeline);
      const first = timeline.map((e: any) => e.lifecycle);
      autoClassify(timeline);
      const second = timeline.map((e: any) => e.lifecycle);
      expect(second).toEqual(first);
    });
  });

  describe("classify (operator override)", () => {
    it("sets lifecycle to an explicit value", () => {
      const e = makeAssessment();
      classify(e, "expected");
      expect(e.lifecycle).toBe("expected");
    });
  });

  describe("getFlagged + getSummary", () => {
    it("getFlagged returns only flagged entries", () => {
      const timeline = [
        makeAssessment({ id: 1, severity: "error",
          payload: { category: "tip_crash", severity: "error" } }),
        makeAssessment({ id: 2, severity: "info",
          payload: { category: "tadm", severity: "info" } }),
        makeCommand({ id: 3 }),
      ];
      autoClassify(timeline);
      const flagged = getFlagged(timeline);
      expect(flagged).toHaveLength(1);
      expect(flagged[0].id).toBe(1);
    });

    it("getSummary counts by lifecycle", () => {
      const timeline = [
        makeAssessment({ id: 1, severity: "warning",
          payload: { category: "contamination", severity: "warning" } }),
        makeCommand({ id: 2, payload: { rawCommand: "C0TRid0002tm04" } }),
        makeAssessment({ id: 3, severity: "error",
          payload: { category: "tip_crash", severity: "error" } }),
        makeCommand({ id: 4 }),
      ];
      autoClassify(timeline);
      const s = getSummary(timeline);
      expect(s.total).toBe(4);
      expect(s.flagged).toBe(1);       // the tip_crash
      expect(s.resolved).toBe(1);      // the contamination (resolved by C0TR)
      expect(s.active).toBe(2);        // the two commands
    });
  });
});
