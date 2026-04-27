/**
 * Session save/load tests (Step 1.7, issue #43 wrap-up).
 *
 * DigitalTwinAPI.saveSession returns a JSON-safe TwinSession; loadSession
 * consumes one and applies it to a device. Together with the per-component
 * serializers landed in Steps 1.3-1.6, this is what powers the
 * POST /api/session/save and POST /api/session/load REST endpoints.
 *
 * The test exercises the round-trip through the API layer (not the REST
 * layer): fill in some state → save → reset → load → verify. This is the
 * strongest contract the unit-test layer can express without spinning up
 * an Electron server (that's Phase 2's test-server helper territory).
 *
 * FAILURE INJECTION
 *   - If saveSession forgets to include state, the "well volumes restored"
 *     assertion fails because the reset wipes the tracker.
 *   - If loadSession forgets to call twin.restore(), tips-in-use state
 *     does not survive the round-trip.
 *   - If the format/version check is wrong, the malformed-session tests
 *     fail loudly.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("Session save/load (Step 1.7)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("save → reset → load round-trip restores well volumes", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 5000);
    const beforeVol = twin.getWellVolume("SMP001", 0, 0);
    expect(beforeVol).toBe(5000);

    // Save.
    const session = twin.api.saveSession(twin.deviceId);
    expect(session.format).toBe("hamilton-twin-session");
    expect(session.version).toBe(1);

    // Destructive reset — wipes all tracking state.
    twin.reset();
    expect(twin.getWellVolume("SMP001", 0, 0)).toBe(0);

    // Load.
    twin.api.loadSession(twin.deviceId, session);
    expect(twin.getWellVolume("SMP001", 0, 0)).toBe(5000);
  });

  it("session round-trips cleanly through JSON", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Buffer", 2000);

    const session = twin.api.saveSession(twin.deviceId, {
      name: "TestRun",
      description: "unit test session",
    });
    const json = JSON.stringify(session);
    const decoded = JSON.parse(json);

    expect(decoded.metadata.name).toBe("TestRun");
    expect(decoded.metadata.description).toBe("unit test session");
    expect(decoded.metadata.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    twin.reset();
    twin.api.loadSession(twin.deviceId, decoded);
    expect(twin.getWellVolume("SMP001", 0, 0)).toBe(2000);
  });

  it("save after a tip pickup preserves the tip-used flag across load", () => {
    twin = createTestTwin();
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    const tipUsageBefore = twin.getTracking().tipUsage;
    const usedCount = Object.keys(tipUsageBefore).length;
    expect(usedCount).toBeGreaterThan(0);

    const session = twin.api.saveSession(twin.deviceId);
    twin.reset();
    expect(Object.keys(twin.getTracking().tipUsage).length).toBe(0);

    twin.api.loadSession(twin.deviceId, session);
    const tipUsageAfter = twin.getTracking().tipUsage;
    expect(Object.keys(tipUsageAfter).length).toBe(usedCount);
  });

  it("saveSession accepts an explicit name and description", () => {
    twin = createTestTwin();
    const session = twin.api.saveSession(twin.deviceId, {
      name: "MyRun",
      description: "with description",
    });
    expect(session.metadata.name).toBe("MyRun");
    expect(session.metadata.description).toBe("with description");
  });

  it("loadSession rejects a null/non-object argument", () => {
    twin = createTestTwin();
    expect(() => twin!.api.loadSession(twin!.deviceId, null as any)).toThrow(/null or not an object/);
  });

  it("loadSession rejects a wrong format tag", () => {
    twin = createTestTwin();
    const bad = { format: "some-other-format", version: 1, metadata: {}, config: {}, state: {} };
    expect(() => twin!.api.loadSession(twin!.deviceId, bad as any)).toThrow(/format/);
  });

  it("loadSession rejects an unsupported version", () => {
    twin = createTestTwin();
    const bad = { format: "hamilton-twin-session", version: 999, metadata: {}, config: {}, state: {} };
    expect(() => twin!.api.loadSession(twin!.deviceId, bad as any)).toThrow(/version 999/);
  });

  it("SCXML module states are preserved across save/load", () => {
    twin = createTestTwin();
    // initAll brings master to sys_ready; save that state.
    const stateBefore = twin.getModuleStates("master");
    expect(stateBefore).toContain("sys_ready");

    const session = twin.api.saveSession(twin.deviceId);
    twin.reset();
    // After reset (no auto-init on load path), master must not be sys_ready.
    const stateAfterReset = twin.getModuleStates("master");
    expect(stateAfterReset).not.toContain("sys_ready");

    twin.api.loadSession(twin.deviceId, session);
    const stateAfterLoad = twin.getModuleStates("master");
    expect(stateAfterLoad).toContain("sys_ready");
  });
});
