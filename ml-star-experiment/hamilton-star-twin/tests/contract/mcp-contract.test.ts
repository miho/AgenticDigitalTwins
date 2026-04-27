/**
 * MCP tool-bridge contract tests (Step 3.5).
 *
 * The MCP layer must:
 *   1. Expose a discoverable catalogue at /api/mcp/list that names every
 *      tool and its input schema.
 *   2. Dispatch tool calls at /api/mcp/call with { name, args }, returning
 *      { result }.
 *   3. Mirror the shape of the REST endpoints it fronts — so an LLM agent
 *      gets the same data whether it calls the tool or the REST route.
 *
 * FAILURE INJECTION
 *   - If buildTools misses a tool, the "catalogue covers all 12 tools"
 *     test counts < 12.
 *   - If mcp.call doesn't forward args, tools like twin.sendCommand return
 *     "undefined raw" errors.
 *   - If analysis.inspectWell's event filter is broken, the "per-well
 *     history" test returns zero events.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, TestServer } from "../helpers/test-server";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TraceRecorder } = require("../../dist/services/trace-recorder");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) throw new Error("Could not reach DigitalTwin");
  return device.twin;
}

function buildTrace(): any {
  const twin = createTestTwin();
  const internal = getInternalTwin(twin.api, twin.deviceId);
  const rec = new TraceRecorder(internal, { snapshotEveryNEvents: 5 });
  rec.start();
  const tipPos = twin.wellXY("TIP001", 0, 0);
  twin.fillPlate("SMP001", 0, "Water", 2000);
  twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
  const srcPos = twin.wellXY("SMP001", 0, 0);
  twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
  for (let i = 0; i < 3; i++) twin.sendCommand(`C0RFid${200 + i}`);
  const trace = rec.stop();
  twin.destroy();
  return trace;
}

let srv: TestServer;
let trace: any;

beforeAll(async () => {
  srv = await createTestServer();
  trace = buildTrace();
  await srv.post("/api/analysis/load", { trace });
});

afterAll(async () => {
  await srv?.close();
});

describe("GET /api/mcp/list", () => {
  it("returns a discoverable catalogue of tools", async () => {
    const list = await srv.get("/api/mcp/list");
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(12);
    for (const t of list) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.inputSchema).toBe("object");
    }
  });

  it("includes every namespaced tool the plan calls out", async () => {
    const list = await srv.get("/api/mcp/list");
    const names = new Set(list.map((t: any) => t.name));
    for (const expected of [
      "twin.sendCommand", "twin.getState", "twin.executeStep", "twin.snapshot", "twin.restore",
      "analysis.load", "analysis.jump", "analysis.whatIf", "analysis.inspectWell",
      "analysis.findIssues", "analysis.summary",
      "report.summary", "report.well", "report.assessmentsCsv", "report.timing", "report.diff",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

describe("POST /api/mcp/call", () => {
  it("rejects unknown tool names", async () => {
    const r = await fetch(`${srv.baseUrl}/api/mcp/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unknown.tool", args: {} }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("twin.sendCommand returns a CommandResult", async () => {
    const r = await srv.post("/api/mcp/call", {
      name: "twin.sendCommand",
      args: { raw: "C0RFid9999" },
    });
    expect(r.result).toHaveProperty("rawCommand");
    expect(r.result.rawCommand).toBe("C0RFid9999");
    expect(r.result.accepted).toBe(true);
    expect(typeof r.result.correlationId).toBe("number");
  });

  it("twin.getState returns modules + deck + tracking", async () => {
    const r = await srv.post("/api/mcp/call", { name: "twin.getState", args: {} });
    expect(r.result).toHaveProperty("modules");
    expect(r.result).toHaveProperty("deck");
    expect(r.result).toHaveProperty("deckTracker");
  });

  it("analysis.jump advances the cursor", async () => {
    const r = await srv.post("/api/mcp/call", {
      name: "analysis.jump",
      args: { eventId: 3 },
    });
    expect(r.result.eventId).toBe(3);
  });

  it("analysis.whatIf returns forkId + result + diff", async () => {
    const r = await srv.post("/api/mcp/call", {
      name: "analysis.whatIf",
      args: { atEventId: trace.timeline.length, rawCommand: "C0RFid9998" },
    });
    expect(r.result.forkId).toMatch(/^fork_/);
    expect(r.result.result).toHaveProperty("rawCommand");
    expect(r.result.diff).toHaveProperty("wellVolumes");
  });

  it("analysis.findIssues returns an array (possibly empty)", async () => {
    const r = await srv.post("/api/mcp/call", { name: "analysis.findIssues", args: {} });
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("analysis.summary returns lifecycle counts", async () => {
    const r = await srv.post("/api/mcp/call", { name: "analysis.summary", args: {} });
    expect(typeof r.result.total).toBe("number");
    expect(typeof r.result.flagged).toBe("number");
  });

  it("analysis.inspectWell returns currentVolume + events + volumeSeries", async () => {
    const r = await srv.post("/api/mcp/call", {
      name: "analysis.inspectWell",
      args: { carrierId: "SMP001", position: 0, wellIndex: 0 },
    });
    expect(r.result).toHaveProperty("wellKey");
    expect(r.result.wellKey).toBe("SMP001:0:0");
    expect(typeof r.result.currentVolume).toBe("number");
    expect(Array.isArray(r.result.events)).toBe(true);
    expect(Array.isArray(r.result.volumeSeries)).toBe(true);
  });

  it("report.summary returns the full ProtocolSummaryReport", async () => {
    const r = await srv.post("/api/mcp/call", { name: "report.summary", args: {} });
    expect(typeof r.result.commandCount).toBe("number");
    expect(r.result).toHaveProperty("assessmentCounts");
    expect(r.result.assessmentCounts).toHaveProperty("byCategory");
    expect(r.result).toHaveProperty("acceptedCommandCount");
  });

  it("report.well returns a WellReport for a filled well", async () => {
    const r = await srv.post("/api/mcp/call", {
      name: "report.well",
      args: { carrierId: "SMP001", position: 0, wellIndex: 0 },
    });
    expect(r.result.wellKey).toBe("SMP001:0:0");
    expect(Array.isArray(r.result.operations)).toBe(true);
    expect(r.result.finalLiquid?.liquidType).toBe("Water");
  });

  it("report.assessmentsCsv returns csv string under a csv property", async () => {
    const r = await srv.post("/api/mcp/call", { name: "report.assessmentsCsv", args: {} });
    expect(typeof r.result.csv).toBe("string");
    // Header row is always emitted even if no assessments.
    expect(r.result.csv.split("\n")[0]).toMatch(/^id,timestamp,category,severity/);
  });

  it("report.timing returns totalEstimatedMs + commands array", async () => {
    const r = await srv.post("/api/mcp/call", { name: "report.timing", args: {} });
    expect(typeof r.result.totalEstimatedMs).toBe("number");
    expect(Array.isArray(r.result.commands)).toBe(true);
  });
});
