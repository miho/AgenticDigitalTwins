/**
 * Unresolved → Assessment bridge tests (issue #34).
 *
 * Verifies that FW commands targeting positions that DON'T resolve to a
 * known deck object generate an AssessmentEvent with category
 * "unresolved_position" at appropriate severity. The existing DeckTracker
 * classification logic is reused; this layer translates those records
 * into events on the unified assessment stream.
 *
 * FAILURE INJECTION
 * If the unresolved classifier stops emitting events, the "aspirate at
 * origin produces error-severity unresolved_position assessment" test
 * fails because the assessment-store count doesn't change. If the
 * severity mapping confuses aspirate (error) with dispense (warning),
 * the severity assertions catch it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("Unresolved position → assessment bridge (#34)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("aspirate at unresolved coordinates emits an unresolved_position error assessment", () => {
    twin = createTestTwin();
    // Fit tips first so aspirate isn't rejected for "no tip" before physics check.
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    const beforeCount = twin.getAssessments({ category: "unresolved_position" }).length;

    // Aspirate at coordinates that don't match any labware (far off-deck).
    // 00000/00000 is the deck origin — no labware is there in the default layout.
    twin.sendCommand("C0ASid0200xp00000yp00000av01000tm255lm0");

    const afterEvents = twin.getAssessments({ category: "unresolved_position" });
    expect(afterEvents.length).toBeGreaterThan(beforeCount);

    const latest = afterEvents[afterEvents.length - 1];
    expect(latest.category).toBe("unresolved_position");
    expect(latest.severity).toBe("error");
    expect(latest.command).toBe("C0AS");
    expect(latest.description).toMatch(/unresolved/i);
    expect(latest.data).toMatchObject({ matched: false });
  });

  it("dispense at unresolved coordinates emits a warning (not error)", () => {
    twin = createTestTwin();
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    // Aspirate something first so the channel has liquid to dispense.
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    // Dispense to (0, 0) — no deck object.
    twin.sendCommand("C0DSid0201xp00000yp00000dv01000dm0tm255");

    const evts = twin.getAssessments({ category: "unresolved_position" });
    const dispenseEvts = evts.filter((e: any) => e.command === "C0DS");
    expect(dispenseEvts.length).toBeGreaterThan(0);
    expect(dispenseEvts[dispenseEvts.length - 1].severity).toBe("warning");
  });

  it("aspirate targeting a tip rack emits an error (wrong target type)", () => {
    twin = createTestTwin();
    // NOTE: we need a different tip rack than the one we aspirate from, so
    // that the PIP has tips. Use column 0 for pickup, column 1 for the
    // erroneous aspirate (also a tip-rack position).
    const tip0 = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tip0.xp}yp${tip0.yp}tm255tt04`);
    const tip1 = twin.wellXY("TIP001", 0, 1);

    // Aspirate at the tip-rack coordinate — matched=true but labwareType includes "Tip".
    twin.sendCommand(`C0ASid0201xp${tip1.xp}yp${tip1.yp}av00500tm255lm0`);

    const evts = twin.getAssessments({ category: "unresolved_position" });
    const tipRackErrors = evts.filter((e: any) =>
      e.command === "C0AS" && e.data?.matched === true && (e.data?.labwareType || "").includes("Tip")
    );
    expect(tipRackErrors.length).toBeGreaterThan(0);
    expect(tipRackErrors[tipRackErrors.length - 1].severity).toBe("error");
  });

  it("tip pickup from a non-tip-rack emits an error", () => {
    twin = createTestTwin();
    // Target a sample plate (not tip rack) for a C0TP — wrong target type.
    const smpPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${smpPos.xp}yp${smpPos.yp}tm255tt04`);

    const evts = twin.getAssessments({ category: "unresolved_position" });
    const wrongPickup = evts.filter((e: any) => e.command === "C0TP");
    expect(wrongPickup.length).toBeGreaterThan(0);
    expect(wrongPickup[wrongPickup.length - 1].severity).toBe("error");
    expect(wrongPickup[wrongPickup.length - 1].description).toMatch(/non-tip/i);
  });

  it("non-positional commands (queries) do NOT emit unresolved_position events", () => {
    twin = createTestTwin();
    const before = twin.getAssessments({ category: "unresolved_position" }).length;

    // Send query/status commands that don't involve a deck position.
    twin.sendCommand("C0RFid9001");   // firmware version query
    twin.sendCommand("C0QBid9002");   // busy query

    const after = twin.getAssessments({ category: "unresolved_position" }).length;
    expect(after).toBe(before);
  });

  it("resolved positional commands do NOT emit unresolved_position events", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);

    const before = twin.getAssessments({ category: "unresolved_position" }).length;

    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
    twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);

    const after = twin.getAssessments({ category: "unresolved_position" }).length;
    expect(after).toBe(before);  // no unresolved events for well-aimed commands
  });
});
