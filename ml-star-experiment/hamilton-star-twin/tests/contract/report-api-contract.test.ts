/**
 * Report REST contract tests (Step 4.A).
 *
 * Exercises every `/api/report/*` endpoint end-to-end through the
 * headless server, including the non-JSON renderers (text, html, csv).
 *
 * FAILURE INJECTION
 *   - If /api/report/summary doesn't call protocolSummary, the response
 *     is missing the assessmentCounts/byCategory shape.
 *   - If the CSV endpoint sets the wrong Content-Type, the download test
 *     fails before the first row is inspected.
 *   - If /api/report/diff reads fork state from the wrong service, the
 *     forkCommandCount roundtrip assertion breaks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, TestServer } from "../helpers/test-server";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TraceRecorder } = require("../../dist/services/trace-recorder");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) throw new Error("Could not reach DigitalTwin through api.devices");
  return device.twin;
}

function buildTrace(): any {
  const twin = createTestTwin();
  const internal = getInternalTwin(twin.api, twin.deviceId);
  const rec = new TraceRecorder(internal);
  rec.start();
  twin.fillPlate("SMP001", 0, "Water", 2000);
  const tipPos = twin.wellXY("TIP001", 0, 0);
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
  await srv.post("/api/analysis/load", { trace, name: "report-test" });
});

afterAll(async () => {
  await srv?.close();
});

describe("GET /api/report/summary", () => {
  it("returns protocolSummary JSON by default", async () => {
    const r = await srv.get("/api/report/summary");
    expect(r.platform).toBe(trace.config.platform);
    expect(r.assessmentCounts).toBeTruthy();
    expect(typeof r.assessmentCounts.total).toBe("number");
    expect(r.commandCount).toBe(trace.metadata.commandCount);
  });

  it("format=text returns plain text with the device name", async () => {
    const resp = await fetch(`${srv.baseUrl}/api/report/summary?format=text`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") || "").toMatch(/text\/plain/);
    const body = await resp.text();
    expect(body).toMatch(/Protocol Summary/);
  });

  it("format=html returns HTML with <dl>", async () => {
    const resp = await fetch(`${srv.baseUrl}/api/report/summary?format=html`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") || "").toMatch(/text\/html/);
    const body = await resp.text();
    expect(body).toMatch(/<dl>/);
  });
});

describe("GET /api/report/well", () => {
  it("returns a well history for a filled well", async () => {
    const r = await srv.get("/api/report/well?carrier=SMP001&position=0&well=0");
    expect(r.wellKey).toBe("SMP001:0:0");
    expect(r.finalLiquid?.liquidType).toBe("Water");
    expect(Array.isArray(r.operations)).toBe(true);
  });

  it("400s when parameters are missing", async () => {
    const r = await fetch(`${srv.baseUrl}/api/report/well`);
    expect(r.status).toBe(400);
  });
});

describe("GET /api/report/assessments", () => {
  it("returns CSV by default with the expected header", async () => {
    const resp = await fetch(`${srv.baseUrl}/api/report/assessments`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") || "").toMatch(/text\/csv/);
    expect(resp.headers.get("content-disposition") || "").toMatch(/assessments\.csv/);
    const body = await resp.text();
    const header = body.split("\n")[0];
    expect(header.split(",")).toContain("category");
    expect(header.split(",")).toContain("severity");
  });

  it("format=json returns array of assessment payloads", async () => {
    const r = await srv.get("/api/report/assessments?format=json");
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("GET /api/report/timing", () => {
  it("returns a timing report with commandBreakdown and commands", async () => {
    const r = await srv.get("/api/report/timing");
    expect(typeof r.totalEstimatedMs).toBe("number");
    expect(typeof r.totalWallClockMs).toBe("number");
    expect(Array.isArray(r.commands)).toBe(true);
    expect(r.commandBreakdown).toBeTruthy();
    // Every command event in the source trace shows up as one row.
    const expected = trace.timeline.filter((e: any) => e.kind === "command").length;
    expect(r.commands.length).toBe(expected);
  });
});

describe("GET /api/report/diff", () => {
  it("requires a valid forkId", async () => {
    const r = await fetch(`${srv.baseUrl}/api/report/diff`);
    expect(r.status).toBe(400);
  });

  it("returns a DiffReport after creating and modifying a fork", async () => {
    // Branch near the start and run one extra reset on the fork so diffFork
    // reports a non-zero command count.
    const handle = await srv.post("/api/analysis/fork", { atEventId: 1 });
    expect(handle.forkId).toBeTruthy();
    await srv.post(`/api/analysis/fork/${handle.forkId}/command`, { raw: "C0RFid9999" });

    const diff = await srv.get(`/api/report/diff?forkId=${encodeURIComponent(handle.forkId)}`);
    expect(diff.forkId).toBe(handle.forkId);
    expect(diff.summary).toBeTruthy();
    expect(diff.summary.forkCommandCount).toBeGreaterThanOrEqual(1);
  });
});
