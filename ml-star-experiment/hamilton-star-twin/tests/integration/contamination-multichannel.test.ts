/**
 * Regression: an N-channel aspirate/dispense command must surface one
 * `contamination` assessment per channel, not just one total.
 *
 * The bug: `pip-physics.assess` used `getRecentContamination(1)` which
 * pulled only the last log entry. With tm=255 (8 channels) and all 8
 * channels contacting a new mixture, 8 entries were pushed but only
 * the highest-index channel (CH8) was emitted as an assessment — the
 * other 7 silently vanished. Serial-dilution runs lit up only CH8.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestTwin, type TestTwin } from "../helpers/in-process";

describe("multi-channel contamination surfacing", () => {
  let twin: TestTwin;
  beforeAll(() => { twin = createTestTwin(); });
  afterAll(() => { twin.destroy(); });

  it("8-channel aspirate with contamination emits one assessment per channel", () => {
    // Seed col 0 of SMP001 with Stock so channels 0..7 aspirate Stock first.
    twin.api.fillLabwareSubset(twin.deviceId, "SMP001", 0,
      { columns: [0] }, "Stock", 2000);
    // Seed col 1 of SMP001 with a different liquid (Diluent) — when
    // channels later aspirate col 1 while holding Stock residue, every
    // channel should flag contamination.
    twin.api.fillLabwareSubset(twin.deviceId, "SMP001", 0,
      { columns: [1] }, "Diluent", 2000);

    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(
      `C0TPid0001xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm255tt04`,
    );

    // Step 1: 8-channel aspirate from SMP col 1 (Stock).
    const src = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(
      `C0ASid0002xp${String(src.xp).padStart(5, "0")}yp${String(src.yp).padStart(5, "0")}av01000tm255lm0`,
    );

    // Dispense into col 1 (Diluent) of same plate so col 1 becomes a
    // Stock+Diluent mixture.
    const dst = twin.wellXY("SMP001", 0, 1);
    twin.sendCommand(
      `C0DSid0003xp${String(dst.xp).padStart(5, "0")}yp${String(dst.yp).padStart(5, "0")}dv01000tm255dm2`,
    );

    // Step 2: 8-channel aspirate FROM the mixture with tips still
    // carrying Stock residue. Each of the 8 channels should trigger a
    // separate contamination assessment.
    const r = twin.sendCommand(
      `C0ASid0004xp${String(dst.xp).padStart(5, "0")}yp${String(dst.yp).padStart(5, "0")}av00500tm255lm0`,
    );
    expect(r.accepted).toBe(true);

    const assessments = (r as any).assessments ?? [];
    const contamEvents = assessments.filter((a: any) => a.category === "contamination");
    expect(
      contamEvents.length,
      `expected 8 per-channel contamination events, got ${contamEvents.length}: ${JSON.stringify(contamEvents.map((e: any) => ({ch: e.channel, desc: e.description})))}`,
    ).toBe(8);

    const channels = contamEvents.map((e: any) => e.channel).sort((a: number, b: number) => a - b);
    expect(channels).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
