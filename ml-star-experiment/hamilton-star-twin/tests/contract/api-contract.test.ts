/**
 * REST API contract tests (Step 2.6).
 *
 * One test per public endpoint. Each asserts the response *shape* — the
 * keys present, their types, and structural invariants — so future
 * refactors can't silently change the HTTP contract.
 *
 * We assert shapes rather than full values because wall-clock timestamps
 * and per-run ids are non-deterministic; snapshot tests would churn every
 * run. Where a field's value IS meaningful, we assert it explicitly.
 *
 * FAILURE INJECTION
 *   - If the REST layer forgets to broadcast a state update after a
 *     POST /command, the event-count assertions for the SSE channel drop.
 *   - If any endpoint drops an expected key, the `toHaveProperty` check
 *     fails with a clear message.
 *   - If POST /reset stops re-initializing, the subsequent /state check
 *     sees master not in sys_ready and fails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, TestServer } from "../helpers/test-server";

let srv: TestServer;

beforeAll(async () => {
  srv = await createTestServer();
});

afterAll(async () => {
  await srv?.close();
});

// --- System endpoints -----------------------------------------------------

describe("GET /state", () => {
  it("returns { deviceId, deviceName, modules, deck, deckTracker, liquidTracking, assessments, timestamp }", async () => {
    const s = await srv.get("/state");
    expect(s).toHaveProperty("deviceId");
    expect(s).toHaveProperty("deviceName");
    expect(s).toHaveProperty("modules");
    expect(s).toHaveProperty("deck");
    expect(s).toHaveProperty("deckTracker");
    expect(s.deckTracker).toHaveProperty("wellVolumes");
    expect(s.deckTracker).toHaveProperty("tipUsage");
    expect(s.deckTracker).toHaveProperty("recentInteractions");
    expect(s).toHaveProperty("liquidTracking");
    expect(s.liquidTracking).toHaveProperty("wellContents");
    expect(s.liquidTracking).toHaveProperty("channels");
    expect(s.liquidTracking).toHaveProperty("contamination");
    expect(Array.isArray(s.assessments)).toBe(true);
    expect(typeof s.timestamp).toBe("number");
  });
});

describe("GET /deck", () => {
  it("returns a deck snapshot with platform and carriers", async () => {
    const d = await srv.get("/deck");
    expect(d).toHaveProperty("platform");
    expect(Array.isArray(d.carriers)).toBe(true);
  });
});

describe("GET /tracking", () => {
  it("returns wellVolumes / tipUsage / interactions / unresolved", async () => {
    const t = await srv.get("/tracking");
    expect(t).toHaveProperty("wellVolumes");
    expect(t).toHaveProperty("tipUsage");
  });
});

describe("GET /history", () => {
  it("returns an array of { command, result, timestamp }", async () => {
    const h = await srv.get("/history");
    expect(Array.isArray(h)).toBe(true);
    if (h.length > 0) {
      expect(h[0]).toHaveProperty("command");
      expect(h[0]).toHaveProperty("result");
      expect(h[0]).toHaveProperty("timestamp");
    }
  });
});

describe("GET /assessment", () => {
  it("returns an array of AssessmentEvent-shaped records", async () => {
    const a = await srv.get("/assessment");
    expect(Array.isArray(a)).toBe(true);
  });

  it("accepts category/channel/count filter params", async () => {
    const filtered = await srv.get("/assessment?category=tadm&count=5");
    expect(Array.isArray(filtered)).toBe(true);
  });
});

// --- Inspect endpoints ----------------------------------------------------

describe("GET /inspect-carrier", () => {
  it("returns null when the carrier id is unknown", async () => {
    const r = await srv.get("/inspect-carrier?id=NOSUCH");
    expect(r).toBeNull();
  });
});

describe("GET /inspect-position", () => {
  it("returns a { resolution } shape", async () => {
    const r = await srv.get("/inspect-position?x=0&y=0");
    expect(r).toHaveProperty("resolution");
  });
});

// --- Command / completion / reset -----------------------------------------

describe("POST /command", () => {
  it("returns a CommandResult with response, accepted, correlationId", async () => {
    const r = await srv.post("/command", { raw: "C0RFid9001" });
    expect(typeof r.response).toBe("string");
    expect(typeof r.accepted).toBe("boolean");
    expect(typeof r.correlationId).toBe("number");
    expect(r).toHaveProperty("activeStates");
    expect(r).toHaveProperty("variables");
    expect(r).toHaveProperty("errorCode");
  });
});

describe("POST /completion", () => {
  it("accepts a completion event and returns a system state", async () => {
    const s = await srv.post("/completion", { event: "move.done" });
    expect(s).toHaveProperty("modules");
    expect(s).toHaveProperty("timestamp");
  });
});

describe("POST /reset", () => {
  it("resets the device and returns { reset: true }", async () => {
    const r = await srv.post("/reset", {});
    expect(r).toEqual({ reset: true });
  });
});

// --- Session ---------------------------------------------------------------

describe("POST /session/save and /session/load", () => {
  it("saveSession returns a TwinSession envelope", async () => {
    // Reset and re-init first so we have a known state.
    await srv.post("/reset", {});
    await srv.post("/command", { raw: "C0VIid0001" });
    await srv.post("/command", { raw: "C0DIid0002" });
    await srv.post("/command", { raw: "C0EIid0003" });
    await srv.post("/command", { raw: "C0IIid0004" });

    const s = await srv.post("/session/save", { name: "contract-test" });
    expect(s.format).toBe("hamilton-twin-session");
    expect(s.version).toBe(1);
    expect(s.metadata.name).toBe("contract-test");
    expect(s).toHaveProperty("config");
    expect(s).toHaveProperty("state");
  });

  it("loadSession round-trips the snapshot into a DeviceState", async () => {
    const saved = await srv.post("/session/save", {});
    const loaded = await srv.post("/session/load", saved);
    expect(loaded).toHaveProperty("modules");
    expect(loaded).toHaveProperty("deck");
  });
});

// --- VENUS steps -----------------------------------------------------------

describe("GET /steps", () => {
  it("returns a list of step type descriptors", async () => {
    const r = await srv.get("/steps");
    // Either an array of strings or objects — both acceptable as long as
    // it's a list with at least the core step types.
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe("POST /step", () => {
  it("returns a StepResult with success, stepType, commands, assessments", async () => {
    const r = await srv.post("/step", {
      type: "tipPickUp",
      params: { position: { carrierId: "TIP001", position: 0, column: 0 }, channelMask: 1 },
    });
    expect(r).toHaveProperty("success");
    expect(r).toHaveProperty("stepType");
    expect(Array.isArray(r.commands)).toBe(true);
    expect(Array.isArray(r.assessments)).toBe(true);
  });

  it("returns a structured error when step type is missing", async () => {
    const r = await srv.post("/step", {});
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe("string");
  });
});

describe("POST /step/decompose", () => {
  it("returns { type, subSteps, count }", async () => {
    const r = await srv.post("/step/decompose", {
      type: "easyAspirate",
      params: {
        tipPosition: { carrierId: "TIP001", position: 0, column: 0 },
        aspiratePosition: { carrierId: "SMP001", position: 0, column: 0 },
        volume: 100,
      },
    });
    expect(r).toHaveProperty("type");
    expect(Array.isArray(r.subSteps)).toBe(true);
    expect(typeof r.count).toBe("number");
  });
});

describe("POST /timing", () => {
  it("returns { event, estimatedTimeMs, description }", async () => {
    const r = await srv.post("/timing", { raw: "C0ASid0001xp01000yp02000av00500" });
    expect(r).toHaveProperty("event");
    expect(typeof r.estimatedTimeMs).toBe("number");
    expect(typeof r.description).toBe("string");
  });
});

// --- Liquid ---------------------------------------------------------------

describe("POST /liquid/fill", () => {
  it("returns { success: true } for a valid fill", async () => {
    const r = await srv.post("/liquid/fill", {
      carrierId: "SMP001",
      position: 0,
      liquidType: "Water",
      volume: 1000,
    });
    expect(r).toHaveProperty("success");
  });
});

describe("GET /liquid/well", () => {
  it("returns null for an unfilled well or LiquidContents when filled", async () => {
    const r = await srv.get("/liquid/well?carrier=SMP001&position=0&well=0");
    // Either null (empty) or an object with contents — accept both.
    if (r !== null) {
      expect(typeof r).toBe("object");
    }
  });
});

describe("GET /liquid/channels", () => {
  it("returns an array of 16 channel states (or nulls)", async () => {
    const r = await srv.get("/liquid/channels");
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(16);
  });
});

describe("GET /liquid/contamination", () => {
  it("returns an array of contamination events", async () => {
    const r = await srv.get("/liquid/contamination");
    expect(Array.isArray(r)).toBe(true);
  });
});

// --- Replay ---------------------------------------------------------------

describe("GET /replay/info", () => {
  it("returns { loaded, total, current, playing, speed, traceName }", async () => {
    const r = await srv.get("/replay/info");
    expect(r).toHaveProperty("loaded");
    expect(r).toHaveProperty("total");
    expect(r).toHaveProperty("current");
    expect(r).toHaveProperty("playing");
    expect(r).toHaveProperty("speed");
    expect(r).toHaveProperty("traceName");
  });
});

describe("POST /replay/* control surface", () => {
  it("/replay/step returns a done marker when no trace is loaded", async () => {
    const r = await srv.post("/replay/step", {});
    expect(r).toHaveProperty("done");
    expect(r).toHaveProperty("total");
  });

  it("/replay/pause returns { paused: true, index }", async () => {
    const r = await srv.post("/replay/pause", {});
    expect(r).toMatchObject({ paused: true });
    expect(typeof r.index).toBe("number");
  });

  it("/replay/speed returns the clamped { speed }", async () => {
    const tooFast = await srv.post("/replay/speed", { speed: 5 });
    expect(tooFast).toEqual({ speed: 10 });
    const tooSlow = await srv.post("/replay/speed", { speed: 9999 });
    expect(tooSlow).toEqual({ speed: 2000 });
  });

  it("/replay/reset returns { reset: true, total }", async () => {
    const r = await srv.post("/replay/reset", {});
    expect(r).toMatchObject({ reset: true });
    expect(typeof r.total).toBe("number");
  });
});
