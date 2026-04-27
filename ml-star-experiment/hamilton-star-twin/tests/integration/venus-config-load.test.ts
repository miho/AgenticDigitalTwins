/**
 * POST /api/venus-config/load regression test.
 *
 * The twin's C0QM / C0RM / C0RI / C0RF / C0RU responses are driven
 * by a VenusConfig. Default is a minimal `ka010301` which mismatches
 * any VENUS install that advertises extra modules (96-head, 384-head,
 * iSWAP waste, …) and triggers VENUS's "Initialization Error:
 * instrument configuration described in the instrument configuration
 * file does not match the configuration reported by the instrument"
 * halt.
 *
 * The File menu / REST endpoint / MCP tool all let the user load
 * an explicit ML_STAR.cfg. This test pins the REST contract:
 *   - POST /api/venus-config/load { path } accepts an explicit file.
 *   - The response exposes moduleBits + serial so the UI can report.
 *   - A follow-up C0QM reflects whatever the cfg asked for.
 *
 * Gated behind `fs.existsSync` on the Hamilton install so CI runners
 * without it skip cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import { createTestServer, TestServer } from "../helpers/test-server";

const ML_STAR_CFG = "C:/Program Files (x86)/Hamilton/Config/ML_STAR.cfg";

describe("POST /api/venus-config/load (#28)", () => {
  let srv: TestServer;

  beforeAll(async () => {
    srv = await createTestServer({});
  });

  afterAll(async () => {
    await srv?.close();
  });

  it("accepts an explicit path, returns merged config, subsequent C0QM reflects it", async () => {
    if (!fs.existsSync(ML_STAR_CFG)) return;  // skip on CI

    const r = await fetch(`${srv.baseUrl}/api/venus-config/load`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: ML_STAR_CFG }),
    });
    expect(r.ok, `load failed: ${r.status}`).toBe(true);
    const body = await r.json() as any;
    expect(body.moduleBitsHex).toMatch(/^[0-9a-f]{6}$/);
    expect(body.totalTracks).toBeGreaterThan(0);
    expect(body.source).toBe("file");
    expect(body.path).toBe(ML_STAR_CFG);

    // C0QM uses the merged config
    const cmd = await fetch(`${srv.baseUrl}/command`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: "C0QMid0001" }),
    });
    const cmdBody = await cmd.json() as any;
    expect(cmdBody.response).toContain(`ka${body.moduleBitsHex}`);
    expect(cmdBody.response).toContain(`xt${body.totalTracks}`);
  });

  it("rejects a bad body with a clear error", async () => {
    const r = await fetch(`${srv.baseUrl}/api/venus-config/load`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.error).toMatch(/cfg.*path|path.*cfg|expects/i);
  });

  it("accepts inline cfg text", async () => {
    // A minimal sectioned HxCfgFil snippet — just enough to trigger
    // the parser. Values don't have to be realistic; we only assert
    // the round-trip.
    const cfg = `DataDef,Stub,1,default,{\n  serial, "TEST-1234",\n  xt, "30",\n  xa, "30",\n};`;
    const r = await fetch(`${srv.baseUrl}/api/venus-config/load`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cfg }),
    });
    expect(r.ok, `inline load failed: ${r.status}`).toBe(true);
    const body = await r.json() as any;
    expect(body.source).toBe("inline");
    expect(body.path).toBeNull();
  });
});
