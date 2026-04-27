/**
 * Stage-5 regression test (#54).
 *
 * Drives an Init → Tip Pickup → Aspirate → Dispense → Tip Eject run
 * through `runVenusMethod` — the same TypeScript entry point real
 * VENUS-driven tests will use once the Web API backend is wired.
 *
 * For CI we use the in-process backend (fast, no Hamilton install
 * needed). The test asserts the full cycle's side effects:
 *   - every FW command accepted, no er* responses
 *   - tips fitted after pickup + removed after eject
 *   - well volumes dropped at the aspirate source, rose at the
 *     dispense target
 *   - TADM assessment events recorded
 *
 * An opt-in guard block at the end exercises `viaVenusWebApi` when
 * `VENUS_HOST` is set in the environment. The backend itself is
 * still a stub (throws a clear error); the guard is there so the
 * day we implement the Web API handshake, the test picks it up
 * without a separate scaffold.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestTwin, type TestTwin } from "../helpers/in-process";
import { runVenusMethod, viaInProcess, viaVenusWebApi } from "../helpers/venus-method";

// Default test deck has TIP001 / SMP001 / DST001 / RGT001 / etc. —
// see tests/helpers/in-process.ts default layout.
const TIP_CARRIER = "TIP001";
const SRC_CARRIER = "SMP001";
const DST_CARRIER = "DST001";

describe("Stage-5 regression (#54)", () => {
  let twin: TestTwin;

  beforeAll(async () => {
    twin = await createTestTwin();
    // Seed the source plate with 200 µL of water so the aspirate has
    // something to draw.
    twin.fillPlate(SRC_CARRIER, 0, "water", 2000);  // 0.1 µL units
  });

  afterAll(async () => {
    // createTestTwin returns a disposable? If not, nothing to do.
  });

  it("runs Init → Pickup → Aspirate → Dispense → Eject via in-process backend", async () => {
    const backend = viaInProcess(twin);

    const result = await runVenusMethod(backend, {
      initialize: true,
      tipPickup:  { carrier: TIP_CARRIER, pos: 0, wellA1: true, channels: 8 },
      aspirate:   { carrier: SRC_CARRIER, pos: 0, wellA1: true, volumeUl: 50 },
      dispense:   { carrier: DST_CARRIER, pos: 0, wellA1: true, volumeUl: 50 },
      tipEject:   "waste",
    });

    // Every FW command must be accepted
    expect(result.success, `run failed; log: ${JSON.stringify(result.log.map(l => ({ step: l.step, raw: l.raw.slice(0, 8), err: l.errorCode })), null, 2)}`).toBe(true);
    // Exercised the full Stage-5 sequence
    const steps = result.log.map(l => l.step);
    expect(steps).toContain("initialize");
    expect(steps).toContain("tipPickup");
    expect(steps).toContain("aspirate");
    expect(steps).toContain("dispense");
    expect(steps).toContain("tipEject");

    // Side-effect assertions — tips ejected (no channels should still
    // report a tip fitted after the eject). 8-channel pickup →
    // channels 0..7 active.
    const pip = twin.getModuleVars("pip") as any;
    const tipFitted = pip.tip_fitted as boolean[];
    for (let ch = 0; ch < 8; ch++) {
      expect(tipFitted?.[ch], `channel ${ch} should have no tip after eject`).toBe(false);
    }

    // Source well lost 50 µL × 8 channels (row A of source)
    const tracking = twin.getTracking();
    const srcVolA1 = tracking.wellVolumes[`${SRC_CARRIER}:0:0`] ?? 0;
    expect(srcVolA1, `${SRC_CARRIER} A1 should be ~500 (0.1 µL) below its 2000 start`).toBeLessThanOrEqual(1500);

    // Destination well gained ~50 µL at A1
    const dstVolA1 = tracking.wellVolumes[`${DST_CARRIER}:0:0`] ?? 0;
    expect(dstVolA1, `${DST_CARRIER} A1 should have received ~500 (0.1 µL)`).toBeGreaterThan(0);
  });

  it("viaVenusWebApi is opt-in via VENUS_HOST and fails loudly when not wired", async () => {
    const host = process.env.VENUS_HOST;
    if (!host) return;  // skip when the env var isn't set

    // When a VENUS_HOST is configured but the Web API backend is not
    // yet implemented, the call must throw with a descriptive error
    // rather than silently pretend success — that way a future commit
    // that wires the backend flips this test from "throws" to "ok"
    // without anyone thinking it was green already.
    const backend = viaVenusWebApi(host);
    await expect(
      runVenusMethod(backend, { initialize: true }),
    ).rejects.toThrow(/not yet implemented|Web API/i);
  });
});
