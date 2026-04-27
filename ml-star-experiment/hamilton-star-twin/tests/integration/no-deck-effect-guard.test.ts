/**
 * "No deck effect" assessment guard.
 *
 * The user's bug: arm visually moves over a plate, TADM shows PASS,
 * inspector shows no volume change, UI gives zero feedback explaining
 * why. Every accepted C0AS/C0DS that produces no deck-state change —
 * because volume param is zero OR the xp/yp don't resolve to any
 * labware — MUST emit a loud, visible assessment ("no_deck_effect")
 * and a descriptive DECK log entry.
 *
 * This test fails if any code path lets a zero-volume or unresolved
 * aspirate/dispense through silently.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("no_deck_effect guard — C0AS/C0DS must never silently no-op", () => {
  let twin: ReturnType<typeof createTestTwin>;

  beforeAll(() => { twin = createTestTwin(); });
  afterAll(() => { twin.destroy(); });

  it("C0AS with av=0 emits a no_deck_effect assessment AND a DECK log", () => {
    // Fabricate a tip pickup so the pip state machine accepts C0AS.
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0001xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm1tt04tp2264th2450td1`);

    const plate = twin.wellXY("SMP001", 0, 0);
    const result = twin.sendCommand(
      `C0ASid0002xp${String(plate.xp).padStart(5, "0")}yp${String(plate.yp).padStart(5, "0")}av00000tm1lm0zp01500th2450`,
    );
    expect(result.accepted).toBe(true);
    const assessments = (result as any).assessments ?? [];
    const zeroVol = assessments.find((a: any) => a.category === "no_deck_effect");
    expect(zeroVol).toBeDefined();
    expect(zeroVol.description).toMatch(/zero-volume|av=0/i);
    // And the deck-interaction log must also surface "NO-OP".
    const logs = (result.logs as string[] ?? []).join("\n");
    expect(logs).toMatch(/NO-OP|zero volume/i);
  });

  it("C0DS with dv=0 emits a no_deck_effect assessment AND a DECK log", () => {
    const tipPos = twin.wellXY("TIP001", 0, 1);
    twin.sendCommand(`C0TPid0003xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm1tt04tp2264th2450td1`);

    const plate = twin.wellXY("SMP001", 0, 0);
    const result = twin.sendCommand(
      `C0DSid0004xp${String(plate.xp).padStart(5, "0")}yp${String(plate.yp).padStart(5, "0")}dv00000tm1dm2zp01500th2450`,
    );
    expect(result.accepted).toBe(true);
    const assessments = (result as any).assessments ?? [];
    const zeroVol = assessments.find((a: any) => a.category === "no_deck_effect");
    expect(zeroVol).toBeDefined();
    expect(zeroVol.description).toMatch(/zero-volume|dv=0/i);
    const logs = (result.logs as string[] ?? []).join("\n");
    expect(logs).toMatch(/NO-OP|zero volume/i);
  });

  it("C0AS with real volume but unresolved xp/yp emits a no_deck_effect assessment", () => {
    const tipPos = twin.wellXY("TIP001", 0, 2);
    twin.sendCommand(`C0TPid0005xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm1tt04tp2264th2450td1`);

    // Way off-deck coordinates — nothing should resolve here.
    const result = twin.sendCommand(`C0ASid0006xp40000yp30000av01000tm1lm0zp01500th2450`);
    expect(result.accepted).toBe(true);
    const assessments = (result as any).assessments ?? [];
    const unresolved = assessments.find((a: any) => a.category === "no_deck_effect");
    expect(unresolved).toBeDefined();
    expect(unresolved.description).toMatch(/no labware under coordinates|UNMATCHED/i);
    const logs = (result.logs as string[] ?? []).join("\n");
    expect(logs).toMatch(/UNMATCHED|no labware/i);
  });

  it("C0DS with real volume but unresolved xp/yp emits a no_deck_effect assessment", () => {
    const tipPos = twin.wellXY("TIP001", 0, 3);
    twin.sendCommand(`C0TPid0007xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm1tt04tp2264th2450td1`);

    const result = twin.sendCommand(`C0DSid0008xp40000yp30000dv01000tm1dm2zp01500th2450`);
    expect(result.accepted).toBe(true);
    const assessments = (result as any).assessments ?? [];
    const unresolved = assessments.find((a: any) => a.category === "no_deck_effect");
    expect(unresolved).toBeDefined();
    expect(unresolved.description).toMatch(/no labware under coordinates|UNMATCHED/i);
    const logs = (result.logs as string[] ?? []).join("\n");
    expect(logs).toMatch(/UNMATCHED|no labware/i);
  });

  it("normal C0AS that DOES touch a well does NOT emit no_deck_effect", () => {
    const fill = twin.api.fillLabwareWithLiquid(twin.deviceId, "SMP001", 0, "Water", 5000);
    expect(fill).toBe(true);
    const tipPos = twin.wellXY("TIP001", 0, 4);
    twin.sendCommand(`C0TPid0009xp${String(tipPos.xp).padStart(5, "0")}yp${String(tipPos.yp).padStart(5, "0")}tm1tt04tp2264th2450td1`);

    const plate = twin.wellXY("SMP001", 0, 0);
    const result = twin.sendCommand(
      `C0ASid0010xp${String(plate.xp).padStart(5, "0")}yp${String(plate.yp).padStart(5, "0")}av01000tm1lm0zp01500th2450`,
    );
    expect(result.accepted).toBe(true);
    const assessments = (result as any).assessments ?? [];
    const noEffect = assessments.find((a: any) => a.category === "no_deck_effect");
    expect(noEffect).toBeUndefined();
  });
});
