/**
 * C0TP "tip presence detection" validation.
 *
 * Real Hamilton firmware has capacitive Tip Presence Detection (TPD). If a
 * pickup command targets a well that doesn't physically hold a tip — whether
 * because it was never there or because a previous C0TP already consumed it —
 * the hardware reports error 75 ("tip pick-up fail, tip not fetched"). The
 * twin must mirror this or silent "pick up nothing" succeeds and the state
 * desyncs (tip_fitted[ch]=true in SCXML while deck tracker shows no tip
 * available).
 *
 * FAILURE INJECTION
 *   - If pip-physics only checks `labwareType.includes("Tip")` and skips
 *     `isTipUsed`, the "pickup from used well" test expects errorCode=75
 *     but gets `accepted=true`.
 *   - If error 75 is raised but misses mention the offending channel, the
 *     description regex fails and tells the maintainer where to look.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("C0TP tip-presence detection (TPD)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;
  afterEach(() => { twin?.destroy(); twin = null; });

  it("rejects a pickup from a well that was already consumed", () => {
    twin = createTestTwin();
    // First pickup: succeed and consume 8 tips from col 1 of TIP001.
    const col1A1 = twin.wellXY("TIP001", 0, 0, 0);
    const first = twin.sendCommand(
      `C0TPid0101xp${col1A1.xp}yp${col1A1.yp}tm255tt04tp2264tz2164th2450td1`
    );
    expect(first.accepted).toBe(true);
    expect(first.errorCode).toBe(0);

    // Eject to waste (not back to the rack, which would re-mark the wells
    // as available under the #14 return-to-rack logic). Firing C0TR with
    // no xp/yp routes to the default waste path.
    const ej = twin.sendCommand(`C0TRid0102tm255`);
    expect(ej.accepted).toBe(true);

    // Second pickup from the SAME column — wells are empty now.
    const second = twin.sendCommand(
      `C0TPid0103xp${col1A1.xp}yp${col1A1.yp}tm255tt04tp2264tz2164th2450td1`
    );
    expect(second.accepted).toBe(false);
    expect(second.errorCode).toBe(75);
    expect(second.errorDescription).toMatch(/TPD|no tip|already used/i);
  });

  it("rejects a partial-mask pickup if even one target well is empty", () => {
    twin = createTestTwin();
    // Consume only channel 1 (well A of col 1) with mask=1.
    const col1A1 = twin.wellXY("TIP001", 0, 0, 0);
    const first = twin.sendCommand(
      `C0TPid0201xp${col1A1.xp}yp${col1A1.yp}tm01tt04tp2264tz2164th2450td1`
    );
    expect(first.accepted).toBe(true);

    // Eject channel 1's tip to waste (no xp/yp → waste path).
    twin.sendCommand(`C0TRid0202tm01`);

    const second = twin.sendCommand(
      `C0TPid0203xp${col1A1.xp}yp${col1A1.yp}tm255tt04tp2264tz2164th2450td1`
    );
    expect(second.accepted).toBe(false);
    expect(second.errorCode).toBe(75);
    // Error message should identify channel 1 as the empty one.
    expect(second.errorDescription).toMatch(/ch1/);
  });
});
