/**
 * TwinTrace format tests (Step 1.11).
 *
 * Verifies:
 *   - Round-trip: serialize → deserialize → serialize produces byte-identical
 *     output (so diff tools and hashes are stable).
 *   - Version mismatches are rejected at load time instead of silently
 *     producing broken replays.
 *   - Shape validation catches obvious corruption.
 *
 * FAILURE INJECTION
 *   - If canonicalize stops fixing key order, the byte-identity assertion
 *     fails because JSON.stringify's natural order differs between the
 *     original object and the parsed-back one.
 *   - If deserializeTrace accepts a wrong format tag or version, the
 *     rejection tests fail loudly.
 */
import { describe, it, expect } from "vitest";

// Runtime import from dist to match the rest of the harness.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  serializeTrace,
  deserializeTrace,
  TRACE_FORMAT_TAG,
  TRACE_FORMAT_VERSION,
} = require("../../dist/twin/trace-format");

function makeTrace(overrides: Partial<any> = {}): any {
  // Minimal but structurally valid trace for round-trip testing.
  return {
    format: TRACE_FORMAT_TAG,
    version: TRACE_FORMAT_VERSION,
    metadata: {
      deviceName: "TestDevice",
      platform: "star",
      startTime: 1_000_000,
      endTime: 1_000_500,
      commandCount: 2,
      eventCount: 4,
      label: "unit test",
    },
    config: {
      platform: "star",
      carriers: [],
      tipWaste: { track: 1, tipCount: 0 },
    },
    initialState: {
      version: 1,
      timestamp: 1_000_000,
      modules: {},
      scheduledEvents: [],
      tracking: { wellVolumes: {}, tipUsage: {}, gripped: null, interactions: [] },
      liquid: { wells: {}, channels: [], contaminationLog: [], labwareTypes: {} },
      deck: {},
      plugins: {},
    },
    timeline: [
      { id: 1, timestamp: 1_000_100, kind: "command", correlationId: 1, payload: { response: "ok" } },
      { id: 2, timestamp: 1_000_200, kind: "assessment", correlationId: 1, severity: "warning", payload: { id: 1, description: "x" } },
    ],
    snapshots: [
      { afterEventId: 1, state: {
        version: 1, timestamp: 1_000_150, modules: {}, scheduledEvents: [],
        tracking: { wellVolumes: {}, tipUsage: {}, gripped: null, interactions: [] },
        liquid: { wells: {}, channels: [], contaminationLog: [], labwareTypes: {} },
        deck: {}, plugins: {},
      }},
    ],
    finalState: {
      version: 1, timestamp: 1_000_500, modules: {}, scheduledEvents: [],
      tracking: { wellVolumes: {}, tipUsage: {}, gripped: null, interactions: [] },
      liquid: { wells: {}, channels: [], contaminationLog: [], labwareTypes: {} },
      deck: {}, plugins: {},
    },
    ...overrides,
  };
}

describe("TwinTrace format (Step 1.11)", () => {
  it("serialize → deserialize round-trip preserves structure", () => {
    const trace = makeTrace();
    const json = serializeTrace(trace);
    const back = deserializeTrace(json);
    expect(back.format).toBe(TRACE_FORMAT_TAG);
    expect(back.version).toBe(TRACE_FORMAT_VERSION);
    expect(back.metadata.deviceName).toBe("TestDevice");
    expect(back.timeline).toHaveLength(2);
    expect(back.snapshots).toHaveLength(1);
  });

  it("re-serializing a parsed trace produces byte-identical JSON", () => {
    const trace = makeTrace();
    const json1 = serializeTrace(trace);
    const json2 = serializeTrace(deserializeTrace(json1));
    expect(json2).toBe(json1);
  });

  it("rejects the wrong format tag", () => {
    const trace = makeTrace({ format: "some-other-trace" });
    const json = JSON.stringify(trace);
    expect(() => deserializeTrace(json)).toThrow(/format tag/);
  });

  it("rejects an unsupported version", () => {
    const trace = makeTrace({ version: 999 });
    const json = JSON.stringify(trace);
    expect(() => deserializeTrace(json)).toThrow(/version 999/);
  });

  it("rejects JSON that isn't a trace object at all", () => {
    expect(() => deserializeTrace("null")).toThrow();
    expect(() => deserializeTrace("42")).toThrow();
    expect(() => deserializeTrace("\"oops\"")).toThrow();
  });

  it("rejects a trace missing required fields", () => {
    const trace = makeTrace();
    delete trace.timeline;
    const json = JSON.stringify(trace);
    expect(() => deserializeTrace(json)).toThrow(/timeline/);
  });

  it("rejects a trace where timeline is not an array", () => {
    const trace = makeTrace({ timeline: "oops" });
    const json = JSON.stringify(trace);
    expect(() => deserializeTrace(json)).toThrow(/timeline must be an array/);
  });

  it("metadata label and notes round-trip only when present", () => {
    const withLabel = serializeTrace(makeTrace({ metadata: {
      deviceName: "D", platform: "star", startTime: 0, endTime: 0,
      commandCount: 0, eventCount: 0, label: "L", notes: "N",
    } }));
    expect(withLabel).toContain("\"label\":\"L\"");
    expect(withLabel).toContain("\"notes\":\"N\"");

    const withoutExtras = serializeTrace(makeTrace({ metadata: {
      deviceName: "D", platform: "star", startTime: 0, endTime: 0,
      commandCount: 0, eventCount: 0,
    } }));
    expect(withoutExtras).not.toContain("\"label\"");
    expect(withoutExtras).not.toContain("\"notes\"");
  });

  it("format and version are stable constants", () => {
    expect(TRACE_FORMAT_TAG).toBe("hamilton-twin-trace");
    expect(TRACE_FORMAT_VERSION).toBe(1);
  });
});
