/**
 * VENUS deck import REST contract (issue #18).
 *
 * POST /api/deck/import-lay — either `{ lay }` or `{ path }` →
 * creates a new device whose deck mirrors the VENUS layout.
 *
 * FAILURE INJECTION
 *   - If the route drops the warnings array on success, the warnings
 *     assertion fails.
 *   - If the handler swaps `lay` and `path`, the path-based test
 *     returns a parse error for the filesystem path string.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { createTestServer, TestServer } from "../helpers/test-server";

const LAY_PATH = path.resolve(
  __dirname, "..", "..", "..",
  "VENUS-2026-04-13", "QA", "Venus.Tests.Integration", "TestData", "Star",
  "TipPickup", "SN559ILayout.lay",
);

let srv: TestServer;
let layText: string;

beforeAll(async () => {
  srv = await createTestServer();
  layText = fs.readFileSync(LAY_PATH, "utf-8");
});

afterAll(async () => {
  await srv?.close();
});

describe("POST /api/deck/import-lay", () => {
  it("accepts the raw .lay text and returns a deviceId", async () => {
    const r = await srv.post("/api/deck/import-lay", { lay: layText });
    expect(typeof r.deviceId).toBe("string");
    expect(r.metadata.instrument).toBe("ML_STAR");
    expect(Array.isArray(r.placements)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
    // Known carriers should end up with at least one placement each.
    const carrierIds = new Set(r.placements.map((p: any) => p.carrierId));
    expect(carrierIds.has("TIP_CAR_480_A00_0001")).toBe(true);
  });

  it("accepts a filesystem path", async () => {
    const r = await srv.post("/api/deck/import-lay", { path: LAY_PATH });
    expect(typeof r.deviceId).toBe("string");
    expect(r.metadata.deckFile).toBe("ML_STAR2.dck");
  });

  it("400s on empty body", async () => {
    const resp = await fetch(`${srv.baseUrl}/api/deck/import-lay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(400);
  });
});
