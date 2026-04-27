/**
 * Analysis REST API contract tests (Step 3.4).
 *
 * One test per endpoint. Fixture: a freshly created TwinSession-style
 * recording produced from an in-process twin (Phase 1's TraceRecorder),
 * then POSTed to /api/analysis/load so the server-side service has a
 * trace to navigate.
 *
 * FAILURE INJECTION
 *   - If /api/analysis/load doesn't actually call traceReplay.load, every
 *     subsequent endpoint returns `loaded: false` and the first step
 *     assertion fails.
 *   - If /api/analysis/jump returns the spine id instead of the timeline
 *     index, position.eventId won't match the expected index.
 *   - If the per-fork route regex mismatches, /fork/:id/command returns
 *     404 instead of a CommandResult.
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
  const rec = new TraceRecorder(internal, { snapshotEveryNEvents: 5 });
  rec.start();
  const tipPos = twin.wellXY("TIP001", 0, 0);
  twin.fillPlate("SMP001", 0, "Water", 2000);
  twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
  const srcPos = twin.wellXY("SMP001", 0, 0);
  twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
  const dstPos = twin.wellXY("SMP001", 0, 5);
  twin.sendCommand(`C0DSid0102xp${dstPos.xp}yp${dstPos.yp}dv01000dm0tm255`);
  for (let i = 0; i < 5; i++) twin.sendCommand(`C0RFid${200 + i}`);
  const trace = rec.stop();
  twin.destroy();
  return trace;
}

let srv: TestServer;
let trace: any;

beforeAll(async () => {
  srv = await createTestServer();
  trace = buildTrace();
  // Load it once — subsequent tests operate on the loaded state.
  await srv.post("/api/analysis/load", { trace, name: "contract-test" });
});

afterAll(async () => {
  await srv?.close();
});

describe("POST /api/analysis/load", () => {
  it("accepts a trace and returns loaded:true info", async () => {
    const info = await srv.post("/api/analysis/load", { trace, name: "t2" });
    expect(info.loaded).toBe(true);
    expect(info.totalEvents).toBe(trace.timeline.length);
    expect(info.traceName).toBe("t2");
    expect(info.eventId).toBe(0);
  });

  it("400s on missing payload", async () => {
    const r = await fetch(`${srv.baseUrl}/api/analysis/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(400);
  });
});

describe("GET /api/analysis/info", () => {
  it("returns loaded status + metadata", async () => {
    const info = await srv.get("/api/analysis/info");
    expect(info.loaded).toBe(true);
    expect(info.metadata).toBeDefined();
    expect(info.metadata.commandCount).toBeGreaterThan(0);
  });
});

describe("GET /api/analysis/position", () => {
  it("returns { eventId, totalEvents, currentEvent, revision }", async () => {
    const pos = await srv.get("/api/analysis/position");
    expect(pos).toHaveProperty("eventId");
    expect(pos).toHaveProperty("totalEvents");
    expect(pos).toHaveProperty("currentEvent");
    expect(pos).toHaveProperty("revision");
  });
});

describe("POST /api/analysis/jump", () => {
  it("jumps to the requested index and reports new position", async () => {
    const pos = await srv.post("/api/analysis/jump", { eventId: 3 });
    expect(pos.eventId).toBe(3);
    expect(pos.currentEvent).not.toBeNull();
  });

  it("clamps out-of-range jumps", async () => {
    const pos = await srv.post("/api/analysis/jump", { eventId: 99_999 });
    expect(pos.eventId).toBe(trace.timeline.length);
  });
});

describe("POST /api/analysis/step", () => {
  it("step forward/backward moves the cursor by 1", async () => {
    await srv.post("/api/analysis/jump", { eventId: 2 });
    const fwd = await srv.post("/api/analysis/step", { direction: "forward" });
    expect(fwd.eventId).toBe(3);
    const back = await srv.post("/api/analysis/step", { direction: "backward" });
    expect(back.eventId).toBe(2);
  });
});

describe("POST /api/analysis/seek", () => {
  it("seek by commandContains finds the matching command", async () => {
    await srv.post("/api/analysis/jump", { eventId: 0 });
    const pos = await srv.post("/api/analysis/seek", {
      kind: "command",
      commandContains: "C0AS",
    });
    expect(pos.currentEvent.kind).toBe("command");
    const raw = pos.currentEvent.payload.rawCommand;
    expect(raw).toContain("C0AS");
  });
});

describe("GET /api/analysis/state", () => {
  it("returns the computed TwinState at the current position", async () => {
    await srv.post("/api/analysis/jump", { eventId: 4 });
    const state = await srv.get("/api/analysis/state");
    expect(state).toHaveProperty("modules");
    expect(state).toHaveProperty("tracking");
    expect(state).toHaveProperty("liquid");
  });
});

describe("GET /api/analysis/events", () => {
  it("returns the [from, to) slice", async () => {
    const events = await srv.get("/api/analysis/events?from=2&to=5");
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(3);
  });

  it("filters by lifecycle when ?lifecycle=flagged", async () => {
    await srv.post("/api/analysis/classify");  // auto-classify first
    const events = await srv.get("/api/analysis/events?lifecycle=flagged");
    expect(Array.isArray(events)).toBe(true);
    for (const e of events) expect(e.lifecycle).toBe("flagged");
  });
});

describe("POST /api/analysis/classify", () => {
  it("auto-classify returns a lifecycle summary", async () => {
    const summary = await srv.post("/api/analysis/classify", {});
    expect(summary).toHaveProperty("total");
    expect(summary).toHaveProperty("active");
    expect(summary).toHaveProperty("flagged");
  });

  it("per-event override sets the lifecycle", async () => {
    const events = await srv.get("/api/analysis/events?from=0&to=1");
    const target = events[0];
    const r = await srv.post("/api/analysis/classify", {
      eventId: target.id,
      lifecycle: "expected",
    });
    expect(r).toEqual({ ok: true });
    const after = await srv.get(`/api/analysis/events?from=0&to=${trace.timeline.length}`);
    const updated = after.find((e: any) => e.id === target.id);
    expect(updated.lifecycle).toBe("expected");
  });
});

describe("GET /api/analysis/flagged and /summary", () => {
  it("flagged returns only flagged events", async () => {
    const flagged = await srv.get("/api/analysis/flagged");
    expect(Array.isArray(flagged)).toBe(true);
    for (const e of flagged) expect(e.lifecycle).toBe("flagged");
  });

  it("summary returns counts per lifecycle", async () => {
    const s = await srv.get("/api/analysis/summary");
    expect(typeof s.total).toBe("number");
    expect(typeof s.active).toBe("number");
    expect(typeof s.flagged).toBe("number");
  });
});

describe("POST /api/analysis/play + pause + speed", () => {
  it("speed endpoint clamps to [10, 2000]", async () => {
    const low = await srv.post("/api/analysis/speed", { speed: 5 });
    expect(low.speed).toBe(10);
    const high = await srv.post("/api/analysis/speed", { speed: 99999 });
    expect(high.speed).toBe(2000);
  });

  it("pause is idempotent and returns playing:false", async () => {
    const r = await srv.post("/api/analysis/pause", {});
    expect(r.playing).toBe(false);
  });
});

describe("What-if fork routes", () => {
  let forkId: string;

  it("POST /api/analysis/fork returns a fork handle", async () => {
    const h = await srv.post("/api/analysis/fork", { atEventId: trace.timeline.length });
    expect(h.forkId).toMatch(/^fork_/);
    expect(h.branchedAtIndex).toBe(trace.timeline.length);
    forkId = h.forkId;
  });

  it("GET /api/analysis/forks lists active forks", async () => {
    const list = await srv.get("/api/analysis/forks");
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((f: any) => f.forkId === forkId)).toBe(true);
  });

  it("POST /api/analysis/fork/:id/command runs a command on the fork", async () => {
    const r = await srv.post(`/api/analysis/fork/${forkId}/command`, { raw: "C0RFid9999" });
    expect(typeof r.accepted).toBe("boolean");
    expect(r).toHaveProperty("rawCommand");
  });

  it("GET /api/analysis/fork/:id/state returns the fork's TwinState", async () => {
    const s = await srv.get(`/api/analysis/fork/${forkId}/state`);
    expect(s).toHaveProperty("modules");
    expect(s).toHaveProperty("tracking");
  });

  it("GET /api/analysis/fork/:id/diff returns a ForkDiff", async () => {
    const d = await srv.get(`/api/analysis/fork/${forkId}/diff`);
    expect(d.forkId).toBe(forkId);
    expect(Array.isArray(d.wellVolumes)).toBe(true);
    expect(Array.isArray(d.moduleStates)).toBe(true);
    expect(d.tipUsage).toBeDefined();
    expect(typeof d.forkCommandCount).toBe("number");
  });

  it("DELETE /api/analysis/fork/:id removes the fork", async () => {
    const r = await fetch(`${srv.baseUrl}/api/analysis/fork/${forkId}`, { method: "DELETE" });
    expect(r.ok).toBe(true);
    const list = await srv.get("/api/analysis/forks");
    expect(list.some((f: any) => f.forkId === forkId)).toBe(false);
  });
});
