/**
 * Test-server helper smoke test (Step 2.5).
 *
 * Verifies that `createTestServer()` actually spins up a working HTTP
 * twin on a random port — the primitive the integration tests will use
 * going forward. Also verifies the close() tear-down actually releases
 * the port (otherwise we'd leak one per test run).
 *
 * FAILURE INJECTION
 *   - If the server binds a fixed port instead of 0, the "two servers on
 *     distinct ports" test fails because the second listen() errors out.
 *   - If close() doesn't close the HTTP server, subsequent fetches keep
 *     succeeding and the "server stops accepting requests after close"
 *     test fails.
 */
import { describe, it, expect } from "vitest";
import { createTestServer } from "../helpers/test-server";

describe("createTestServer (Step 2.5)", () => {
  it("brings up a fresh server on a random port and answers /state", async () => {
    const srv = await createTestServer();
    try {
      expect(srv.port).toBeGreaterThan(0);
      expect(srv.baseUrl).toBe(`http://127.0.0.1:${srv.port}`);
      const state = await srv.get("/state");
      expect(state).toHaveProperty("modules");
      expect(state).toHaveProperty("deck");
    } finally {
      await srv.close();
    }
  });

  it("two servers run concurrently on different ports", async () => {
    const a = await createTestServer();
    const b = await createTestServer();
    try {
      expect(a.port).not.toBe(b.port);
      // Each server responds independently.
      const sa = await a.get("/state");
      const sb = await b.get("/state");
      expect(sa.modules).toBeDefined();
      expect(sb.modules).toBeDefined();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("post() sends commands and returns the twin's response", async () => {
    const srv = await createTestServer();
    try {
      const result = await srv.post("/command", { raw: "C0RFid9001" });
      expect(result.accepted).toBe(true);
      expect(typeof result.correlationId).toBe("number");
    } finally {
      await srv.close();
    }
  });

  it("server stops accepting requests after close()", async () => {
    const srv = await createTestServer();
    // Sanity check it works first.
    await srv.get("/state");
    await srv.close();
    // Subsequent fetches must fail (connection refused).
    await expect(srv.get("/state")).rejects.toThrow();
  });
});
