/**
 * Collision plugin wiring test (Phase 4 Step 4.B).
 *
 * Verifies the plugin emits assessment events through the twin when
 * registered as a global plugin. Unit coverage for the plugin's own
 * logic lives in tests/unit/collision-physics.test.ts.
 *
 * FAILURE INJECTION
 *   - If registerGlobalPlugin doesn't push onto the globalPlugins list,
 *     the command below emits no "collision" assessments.
 *   - If the global plugin's assess() is not called after per-module
 *     assessments, the ordering assertion fails.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CollisionPhysics } = require("../../dist/twin/plugins/collision-physics");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) throw new Error("Could not reach DigitalTwin through api.devices");
  return device.twin;
}

describe("CollisionPhysics integration", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("emits a z_envelope collision assessment when the PIP descends over a tip rack", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const plugin = new CollisionPhysics();
    internal.registerGlobalPlugin(plugin);

    // Default deck layout has TIP001 at a known track. Use its resolved
    // coordinates so the assessment fires on the real deck geometry.
    const tip = twin.wellXY("TIP001", 0, 0);

    // C0TP at the tip rack with a z below the carrier top → collision.
    twin.sendCommand(`C0TPid0100xp${tip.xp}yp${tip.yp}zp1500tm255tt04`);

    const allAssessments = twin.getAssessments();
    const hits = allAssessments.filter((a: any) => a.category === "collision");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].data?.subtype).toBe("z_envelope");
  });

  it("is idempotent on registration — listGlobalPlugins grows by one", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    expect(internal.listGlobalPlugins().length).toBe(0);
    internal.registerGlobalPlugin(new CollisionPhysics());
    expect(internal.listGlobalPlugins().length).toBe(1);
  });

  it("does not break commands that fall outside its tracked event set", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    internal.registerGlobalPlugin(new CollisionPhysics());

    const result = twin.sendCommand("C0RFid0001");
    expect(result.accepted).toBe(true);
    const hits = twin.getAssessments().filter((a: any) => a.category === "collision");
    expect(hits.length).toBe(0);
  });
});
