/**
 * C0TP per-channel pickup validation (ghost-head regression fix).
 *
 * Real Hamilton hardware rejects a tip-pickup if any active channel's
 * per-channel Y lands outside a tip rack — the tip sensors don't get
 * confirmation and the instrument errors out. Before this fix, the
 * twin's pip-physics plugin only checked the primary (x, y) and happily
 * accepted misaligned pickups, leading to a state desync between the
 * SCXML (`tip_fitted[ch] = true` for every channel in the mask) and
 * the deck tracker (only some channels actually found wells).
 *
 * FAILURE INJECTION
 *   - If the validator reverts to checking only `(x, y)`, the
 *     "misaligned arm rejects" test passes the command through.
 *   - If expandMask is off-by-one, a mask of 255 → 8 channels tested;
 *     the "mask 255 at correct A1 accepts 8 channels" test verifies
 *     all 8 channels are examined.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("C0TP per-channel mask validation", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;
  afterEach(() => { twin?.destroy(); twin = null; });

  it("accepts a correctly-aligned pickup for all 8 channels (mask 255)", () => {
    twin = createTestTwin();
    // Compute the exact A1 coord of TIP001 pos 0 via the deck API.
    const tipA1 = twin.wellXY("TIP001", 0, 0, 0);
    const raw = `C0TPid0101xp${tipA1.xp}yp${tipA1.yp}tm255tt04tp2264tz2164th2450td1`;
    const r = twin.sendCommand(raw);
    expect(r.accepted).toBe(true);
    expect(r.errorCode).toBe(0);
    // Deck tracker should mark all 8 rows of column 1 as used.
    const tracking = twin.getTracking();
    const usedInCol1 = Object.keys(tracking.tipUsage ?? {})
      .filter((k) => k.startsWith("TIP001:0:") && (Number(k.split(":")[2]) % 12) === 0);
    expect(usedInCol1).toHaveLength(8);
  });

  it("rejects a misaligned pickup where only 7 channels hit the rack", () => {
    twin = createTestTwin();
    const tipA1 = twin.wellXY("TIP001", 0, 0, 0);
    // Shift Y down by ~10 mm so channel 7 lands outside the rack.
    const yMisaligned = Number(tipA1.yp) - 100;
    const raw = `C0TPid0102xp${tipA1.xp}yp${String(yMisaligned).padStart(5, "0")}tm255tt04tp2264tz2164th2450td1`;
    const r = twin.sendCommand(raw);
    expect(r.accepted).toBe(false);
    expect(r.errorCode).toBe(22);
    expect(r.errorDescription).toMatch(/channel.+outside/i);
    // Nothing should be marked used — the whole command failed.
    const tracking = twin.getTracking();
    const used = Object.keys(tracking.tipUsage ?? {}).filter((k) => k.startsWith("TIP001:0:"));
    expect(used).toHaveLength(0);
  });

  it("mask 1 at A1 picks exactly one tip", () => {
    twin = createTestTwin();
    const tipA1 = twin.wellXY("TIP001", 0, 0, 0);
    const raw = `C0TPid0103xp${tipA1.xp}yp${tipA1.yp}tm1tt04tp2264tz2164th2450td1`;
    const r = twin.sendCommand(raw);
    expect(r.accepted).toBe(true);
    expect(r.errorCode).toBe(0);
    const tracking = twin.getTracking();
    const used = Object.keys(tracking.tipUsage ?? {}).filter((k) => k.startsWith("TIP001:0:"));
    expect(used).toEqual(["TIP001:0:0"]);
  });

  it("rejects a single-channel pickup that targets empty deck space", () => {
    twin = createTestTwin();
    const raw = `C0TPid0104xp09999yp09999tm1tt04tp2264tz2164th2450td1`;
    const r = twin.sendCommand(raw);
    expect(r.accepted).toBe(false);
    expect(r.errorCode).toBe(22);
  });

  it("rejects a pickup targeting a sample plate (not a tip rack)", () => {
    twin = createTestTwin();
    const smpA1 = twin.wellXY("SMP001", 0, 0, 0);
    const raw = `C0TPid0105xp${smpA1.xp}yp${smpA1.yp}tm1tt04tp2264tz2164th2450td1`;
    const r = twin.sendCommand(raw);
    expect(r.accepted).toBe(false);
    expect(r.errorCode).toBe(22);
    expect(r.errorDescription).toMatch(/not a tip rack/);
  });
});
