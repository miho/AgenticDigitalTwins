/**
 * ReportGenerator tests (Step 4.A).
 *
 * Verifies every report entry point produces deterministic output for a
 * fixed trace. The tests double as golden-file anchors — intentional
 * output changes mean updating these expectations (and documenting why).
 *
 * FAILURE INJECTION
 *   - If protocolSummary drops an assessment kind from byCategory, the
 *     "categorises assessments" test fails.
 *   - If wellReport skips a matched deck interaction, "tracks operations
 *     touching a well" reports a shorter operations list.
 *   - If assessmentCsv forgets to escape a comma in a description, the
 *     row count check will see too many columns in the escape test.
 *   - If timingReport sums estimated times across the wrong event kind,
 *     totalEstimatedMs drifts from the per-command rollup sum.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TraceRecorder } = require("../../dist/services/trace-recorder");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  protocolSummary,
  renderProtocolSummaryText,
  renderProtocolSummaryHtml,
  wellReport,
  assessmentCsv,
  ASSESSMENT_CSV_HEADER,
  timingReport,
  diffReport,
} = require("../../dist/services/report-generator");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) throw new Error("Could not reach DigitalTwin through api.devices");
  return device.twin;
}

describe("ReportGenerator (Step 4.A)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  // --- protocolSummary -------------------------------------------------

  describe("protocolSummary", () => {
    it("reports the basic metadata from a recorded trace", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId), {
        label: "smoke",
      });
      rec.start();
      twin.sendCommand("C0RFid0001");
      twin.sendCommand("C0RFid0002");
      const trace = rec.stop();

      const summary = protocolSummary(trace);
      expect(summary.label).toBe("smoke");
      expect(summary.platform).toBe(trace.config.platform);
      expect(summary.commandCount).toBe(trace.metadata.commandCount);
      expect(summary.eventCount).toBe(trace.metadata.eventCount);
      expect(summary.acceptedCommandCount + summary.rejectedCommandCount).toBe(summary.commandCount);
    });

    it("categorises assessments by category and severity", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      // Aspirate at unresolved coordinates → assessment(s).
      twin.sendCommand("C0ASid0001xp00000yp00000av01000tm255lm0");
      const trace = rec.stop();

      const summary = protocolSummary(trace);
      const totalFromCategories = Object.values(summary.assessmentCounts.byCategory).reduce(
        (a: number, b) => a + (b as number),
        0,
      );
      expect(totalFromCategories).toBe(summary.assessmentCounts.total);
      const totalFromSeverity = summary.assessmentCounts.bySeverity.info +
        summary.assessmentCounts.bySeverity.warning +
        summary.assessmentCounts.bySeverity.error;
      expect(totalFromSeverity).toBe(summary.assessmentCounts.total);
    });

    it("deterministic across two calls on the same trace", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      twin.sendCommand("C0RFid0001");
      twin.sendCommand("C0RFid0002");
      const trace = rec.stop();

      const a = protocolSummary(trace);
      const b = protocolSummary(trace);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it("text renderer includes device name and event count", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId), { deviceName: "DX" });
      rec.start();
      twin.sendCommand("C0RFid0001");
      const trace = rec.stop();
      const text = renderProtocolSummaryText(protocolSummary(trace));
      expect(text).toMatch(/DX/);
      expect(text).toMatch(/Events/);
    });

    it("html renderer escapes angle brackets in the label", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId), {
        label: "<script>alert(1)</script>",
      });
      rec.start();
      twin.sendCommand("C0RFid0001");
      const trace = rec.stop();
      const html = renderProtocolSummaryHtml(protocolSummary(trace));
      expect(html).not.toMatch(/<script>/);
      expect(html).toMatch(/&lt;script&gt;/);
    });
  });

  // --- wellReport ------------------------------------------------------

  describe("wellReport", () => {
    it("tracks operations touching a well after a fill + aspirate sequence", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();

      // Pick up tip.
      const tip = twin.wellXY("TIP001", 0, 0);
      twin.sendCommand(`C0TPid0100xp${tip.xp}yp${tip.yp}tm255tt04`);

      // Fill a well so aspirate has liquid to pull from.
      twin.fillPlate("SMP001", 0, "water", 2000);

      // Aspirate from well A1 of SMP001 position 0.
      const smp = twin.wellXY("SMP001", 0, 0);
      twin.sendCommand(`C0ASid0201xp${smp.xp}yp${smp.yp}av00500tm001lm0`);

      const trace = rec.stop();
      const key = "SMP001:0:0";
      const r = wellReport(trace, key);

      expect(r.wellKey).toBe(key);
      expect(r.carrierId).toBe("SMP001");
      expect(r.position).toBe(0);
      expect(r.wellIndex).toBe(0);
      expect(r.operations.length).toBeGreaterThan(0);
      // At least one aspirate command should have surfaced as an op.
      const cmdOps = r.operations.filter((o: any) => o.kind === "command");
      expect(cmdOps.length).toBeGreaterThan(0);
    });

    it("reports finalVolume and finalLiquid from finalState", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      twin.fillPlate("SMP001", 0, "water", 1000);
      twin.sendCommand("C0RFid0001"); // no-op query so we have timeline content
      const trace = rec.stop();

      const r = wellReport(trace, "SMP001:0:0");
      expect(r.finalVolume).toBe(1000);
      expect(r.finalLiquid?.liquidType).toBe("water");
    });
  });

  // --- assessmentCsv ---------------------------------------------------

  describe("assessmentCsv", () => {
    it("emits the stable header row even with an empty timeline", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      const trace = rec.stop();

      const csv = assessmentCsv(trace);
      const firstLine = csv.split("\n")[0];
      expect(firstLine).toBe(ASSESSMENT_CSV_HEADER.join(","));
    });

    it("produces one row per assessment event", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      // Trigger unresolved-position assessment + subsequent assessments.
      twin.sendCommand("C0ASid0001xp00000yp00000av01000tm255lm0");
      const trace = rec.stop();

      const csv = assessmentCsv(trace);
      const dataLines = csv.split("\n").slice(1).filter((l: string) => l.length > 0);
      const assessmentEvents = trace.timeline.filter((e: any) => e.kind === "assessment");
      expect(dataLines.length).toBe(assessmentEvents.length);
    });

    it("escapes commas and quotes in descriptions (no extra columns leaked)", () => {
      // Build a synthetic trace-like object with a crafted description so
      // we don't depend on the assessment engine producing a particular
      // punctuation-heavy string.
      const synthetic = {
        format: "hamilton-twin-trace",
        version: 1,
        metadata: { deviceName: "T", platform: "star", startTime: 0, endTime: 0, commandCount: 0, eventCount: 1 },
        config: { platform: "star" },
        initialState: { modules: {}, liquid: { wellContents: {}, channels: [], wellLabwareType: {}, contaminationLog: [] }, tracking: { wellVolumes: {}, tipUsage: {} } },
        timeline: [{
          id: 1,
          timestamp: 0,
          kind: "assessment",
          severity: "warning",
          payload: {
            id: 1,
            timestamp: 0,
            category: "tadm",
            severity: "warning",
            module: "PIP",
            command: "C0AS",
            description: 'has "quoted" text, and a comma',
          },
        }],
        snapshots: [],
        finalState: { modules: {}, liquid: { wellContents: {}, channels: [], wellLabwareType: {}, contaminationLog: [] }, tracking: { wellVolumes: {}, tipUsage: {} } },
      };
      const csv = assessmentCsv(synthetic);
      const lines = csv.split("\n");
      expect(lines.length).toBe(2);
      // Use a CSV-aware split that treats quoted fields correctly.
      const fields = splitCsvLine(lines[1]);
      expect(fields.length).toBe(ASSESSMENT_CSV_HEADER.length);
      expect(fields[7]).toBe('has "quoted" text, and a comma');
    });
  });

  // --- timingReport ----------------------------------------------------

  describe("timingReport", () => {
    it("sums per-command breakdown to total estimated", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      for (let i = 0; i < 5; i++) {
        twin.sendCommand(`C0RFid${String(i).padStart(4, "0")}`);
      }
      const trace = rec.stop();

      const r = timingReport(trace);
      const rollup = Object.values(r.commandBreakdown).reduce(
        (acc: number, slot) => acc + (slot as any).estimatedMs,
        0,
      );
      expect(rollup).toBe(r.totalEstimatedMs);
      expect(r.commands.length).toBe(trace.timeline.filter((e: any) => e.kind === "command").length);
    });

    it("computes totalWallClockMs from metadata.startTime/endTime", () => {
      twin = createTestTwin();
      const rec = new TraceRecorder(getInternalTwin(twin.api, twin.deviceId));
      rec.start();
      twin.sendCommand("C0RFid0001");
      const trace = rec.stop();

      const r = timingReport(trace);
      expect(r.totalWallClockMs).toBeGreaterThanOrEqual(0);
      expect(r.totalWallClockMs).toBe(Math.max(0, trace.metadata.endTime - trace.metadata.startTime));
    });
  });

  // --- diffReport ------------------------------------------------------

  describe("diffReport", () => {
    it("translates a ForkDiff into a tabular report with summary counts", () => {
      const diff = {
        forkId: "fork_1",
        branchedAtIndex: 42,
        wellVolumes: [
          { wellKey: "SMP001:0:0", originalVolume: 1000, forkVolume: 500, delta: -500 },
          { wellKey: "SMP001:0:1", originalVolume: 0, forkVolume: 500, delta: 500 },
        ],
        moduleStates: [
          { moduleId: "pip", original: ["ready"], fork: ["ready", "aspirating"] },
        ],
        tipUsage: {
          addedInFork: ["TIP001:0:0"],
          removedInFork: [],
        },
        forkCommandCount: 3,
      };

      const r = diffReport(diff);
      expect(r.forkId).toBe("fork_1");
      expect(r.summary.wellsChanged).toBe(2);
      expect(r.summary.modulesChanged).toBe(1);
      expect(r.summary.tipsAdded).toBe(1);
      expect(r.summary.forkCommandCount).toBe(3);
      // One row per diff entry (2 wells + 1 module + 1 tip added).
      expect(r.rows.length).toBe(4);
    });
  });
});

/**
 * Minimal CSV line splitter for the one test that exercises quoted
 * fields. Handles the subset of RFC-4180 we emit: double-quoted fields,
 * "" as an escaped quote, comma separators, no embedded newlines.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let field = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        field += line[i++];
      }
      out.push(field);
      if (line[i] === ",") i++;
    } else {
      let field = "";
      while (i < line.length && line[i] !== ",") field += line[i++];
      out.push(field);
      if (line[i] === ",") i++;
    }
  }
  return out;
}
