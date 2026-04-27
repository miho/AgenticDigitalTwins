/**
 * iSWAP plate-dims resolution on C0PP.
 *
 * When the iSWAP picks up a plate (C0PP xs/yj), the motion envelope
 * should carry the *actual* plate footprint resolved from the labware
 * underneath the gripper. Falling back to the ANSI/SBS default means
 * the renderer draws e.g. a Cos_1536 plate as a 96-well rectangle —
 * technically the same SBS outline, but a non-SBS deep-well block or
 * archive rack breaks visibly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";
import type { MotionEnvelope } from "../../src/twin/digital-twin";

describe("iSWAP plate-dims resolution", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;
  let envelopes: MotionEnvelope[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    twin = createTestTwin();
    envelopes = [];
    const api = twin.api as any;
    const device = api.devices.get(twin.deviceId);
    unsubscribe = device.twin.onMotion((env: MotionEnvelope) => { envelopes.push(env); });
    // iSWAP init isn't part of createTestTwin's default init chain
    // (C0VI/C0DI/C0EI/C0II). Send C0FI to reach `parked`, then C0FY to
    // drop into `ready.empty` where C0PP is accepted.
    twin.sendCommand("C0FIid0000");
    twin.sendCommand("C0FYid0001");
  });

  afterEach(() => {
    unsubscribe?.();
    twin?.destroy();
    twin = null;
  });

  it("C0PP envelope carries rackDx/rackDy when the held labware has a .rck footprint", () => {
    // Inject a labware with explicit rackDx/rackDy on SMP001 pos 0 so
    // the test runs the populated-path regardless of what the default
    // catalog happens to set.
    const api = twin!.api as any;
    const dev = api.devices.get(twin!.deviceId);
    const carrier = dev.twin.deck.getCarrier("SMP001");
    carrier.labware[0] = {
      type: "Custom_DeepWell_96",
      wellCount: 96,
      rows: 8,
      columns: 12,
      wellPitch: 90,
      offsetX: 145,
      offsetY: 745,
      height: 412,         // 41.2 mm deep-well is taller than a 96-well plate
      wellDepth: 380,
      rackDx: 1277,        // 127.7 mm — SBS long edge
      rackDy: 854,         // 85.4 mm  — SBS short edge
    };

    const smp = twin!.wellXY("SMP001", 0, 0);
    envelopes = [];

    const r = twin!.sendCommand(
      `C0PPid0010xs${smp.xp}yj${smp.yp}zj01000th02000gb0820go01300gr0`,
    );
    expect(r.accepted).toBe(true);

    const iswapEnv = envelopes.find((e) => e.arm === "iswap" && e.command === "C0PP");
    expect(iswapEnv).toBeDefined();
    expect(iswapEnv!.startPlateWidth).toBe(1277);
    expect(iswapEnv!.endPlateWidth).toBe(1277);
    expect(iswapEnv!.startPlateHeight).toBe(854);
    expect(iswapEnv!.endPlateHeight).toBe(854);
  });

  it("C0PP with no labware nearby omits plate dims (renderer falls back to SBS default)", () => {
    // Far off-deck — no labware at (X=30000, Y=0). Plate dims should
    // stay absent on the envelope.
    envelopes = [];
    twin!.sendCommand("C0PPid0011xs30000yj00100zj01000th02000gb0820go01300gr0");

    const iswapEnv = envelopes.find((e) => e.arm === "iswap" && e.command === "C0PP");
    if (iswapEnv) {
      expect(iswapEnv.startPlateWidth).toBeUndefined();
      expect(iswapEnv.endPlateWidth).toBeUndefined();
    }
  });

  it("C0PR (release) does NOT include plate dims — released plate is no longer held", () => {
    // Pick up then put back.
    const smp = twin!.wellXY("SMP001", 0, 0);
    twin!.sendCommand(`C0PPid0020xs${smp.xp}yj${smp.yp}zj01000th02000gb0820go01300gr0`);
    envelopes = [];
    twin!.sendCommand(`C0PRid0021xs${smp.xp}yj${smp.yp}zj01000th02000go01300`);

    const releaseEnv = envelopes.find((e) => e.arm === "iswap" && e.command === "C0PR");
    // Release envelope (if emitted) shouldn't carry plate dims — the
    // held plate is gone.
    if (releaseEnv) {
      expect(releaseEnv.startPlateWidth).toBeUndefined();
    }
  });
});
