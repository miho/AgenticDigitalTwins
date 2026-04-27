/**
 * Motion envelope emission — pins the server-side contract so the renderer can
 * rely on envelopes for motion-producing commands.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";
import type { MotionEnvelope } from "../../src/twin/digital-twin";

describe("motion envelopes", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;
  let envelopes: MotionEnvelope[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    twin = createTestTwin();
    envelopes = [];
    const api = twin.api as any;
    const device = api.devices.get(twin.deviceId);
    unsubscribe = device.twin.onMotion((env: MotionEnvelope) => { envelopes.push(env); });
  });

  afterEach(() => {
    unsubscribe?.();
    twin?.destroy();
    twin = null;
  });

  it("emits an envelope for C0TP (tip pickup) with real start/end/duration", () => {
    const tipPos = twin!.wellXY("TIP001", 0, 0);
    // Before the FW command, ensure pos_x is nonzero so we actually have a
    // distance to travel. Send an init move first.
    twin!.sendCommand(`C0JMid0001xp${String(500).padStart(5, "0")}`);
    envelopes = [];

    twin!.sendCommand(`C0TPid0002xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm255tt04tp2264th2450td1`);

    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    const env = envelopes[envelopes.length - 1];
    expect(env.arm).toBe("pip");
    expect(env.command).toBe("C0TP");
    expect(env.endX).toBe(Number(tipPos.xp));
    expect(env.startX).not.toBe(env.endX);
    expect(env.durationMs).toBeGreaterThan(0);
    expect(env.startTime).toBeGreaterThan(0);
  });

  it("does NOT emit an envelope when the command has no position delta", () => {
    // Move to X=500 first; the next C0AS without a new xp shouldn't emit a
    // new envelope (arm didn't physically travel).
    twin!.sendCommand(`C0JMid0001xp${String(500).padStart(5, "0")}`);
    envelopes = [];

    // Aspirate with explicit zero position — no motion.
    twin!.sendCommand(`C0ASid0002xp00000yp00000av01000tm255`);

    // Either zero envelopes, or none with a nonzero travel.
    for (const env of envelopes) {
      const travelled = Math.abs(env.endX - env.startX) + Math.abs(env.endY - env.startY);
      if (travelled >= 1) {
        console.error("unexpected envelope:", JSON.stringify(env));
      }
      expect(travelled).toBeLessThan(1);
    }
  });

  it("envelope duration reflects trapezoidal move time (longer travel → longer duration)", () => {
    twin!.sendCommand(`C0JMid0001xp00100`);
    envelopes = [];

    twin!.sendCommand(`C0JMid0002xp01000`);   // short hop
    const short = envelopes[envelopes.length - 1];
    envelopes = [];

    twin!.sendCommand(`C0JMid0003xp20000`);   // big traverse
    const long = envelopes[envelopes.length - 1];

    expect(short.durationMs).toBeGreaterThan(0);
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
  });

  it("envelope startY reconstructs arm-wide Y from masked pos_y array", () => {
    // Scenario: after a masked command leaves pos_y[0] at 0 but pos_y[2]
    // at the channel-2 Y, the next envelope's startY must report the
    // arm-wide ch0-equivalent (pos_y[2] + 2*90), not the stale
    // pos_y[0] = 0. Otherwise the arm visibly snaps back to Y=0 at
    // the moment the envelope activates.
    const tip = twin!.wellXY("TIP001", 0, 0, 0);
    twin!.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04tp2264tz2164th2450td1`);
    twin!.flushPending();
    twin!.fillPlate("SMP001", 0, "water", 15000);
    const a = twin!.wellXY("SMP001", 0, 0, 0);
    const b = twin!.wellXY("SMP001", 2, 0, 0);

    const ypA = `0 0 ${a.yp} 0 0 0 0 0`;
    const resA = twin!.sendCommand(`C0ASid0002xp${a.xp}yp${ypA}av01000tm04lm0zp01500th2450`);
    expect(resA.accepted).toBe(true);
    twin!.flushPending();
    envelopes = [];

    twin!.sendCommand(`C0ASid0003xp${b.xp}yp${b.yp}av01000tm01lm0zp01500th2450`);
    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    const env = envelopes[envelopes.length - 1];
    expect(env.arm).toBe("pip");
    expect(env.startY).toBe(Number(a.yp) + 2 * 90);
  });

  it("envelope endY reads the per-channel yp array for non-ch0 masks", () => {
    // Scenario: VENUS sends a C0AS with `yp0 0 1500 0 ...tm04`. Pre-fix,
    // parseFwCommand puts only the first array value in data.yp (= 0),
    // so `coord(data.yp, fallback)` produced endY = startY and the
    // envelope reported NO Y motion. The SCXML then rewrote pos_y anyway,
    // updateDeckArm resolved a new targetPipY, and the arm drifted there
    // AFTER the envelope ended — a visible post-envelope jump. The fix
    // consults `_yp_array` and puts that Y move inside the envelope.
    const tip = twin!.wellXY("TIP001", 0, 0, 0);
    twin!.sendCommand(`C0TPid0001xp${tip.xp}yp${tip.yp}tm255tt04tp2264tz2164th2450td1`);
    twin!.flushPending();
    twin!.fillPlate("SMP001", 0, "water", 15000);
    const a = twin!.wellXY("SMP001", 0, 0, 0);
    envelopes = [];

    const ypArr = `0 0 ${a.yp} 0 0 0 0 0`;
    twin!.sendCommand(`C0ASid0002xp${a.xp}yp${ypArr}av01000tm04lm0zp01500th2450`);

    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    const env = envelopes[envelopes.length - 1];
    // endY must reconstruct ch0-equivalent (a.yp + 2*90), not fall back
    // to startY with no motion. Sanity: this is non-zero and matches
    // what updateDeckArm will set as targetPipY after the commit.
    expect(env.endY).toBe(Number(a.yp) + 2 * 90);
  });
});
