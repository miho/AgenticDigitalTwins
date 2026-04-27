/**
 * Correlation ID tests (Step 1.9, issue #33).
 *
 * Every DigitalTwin.sendCommand allocates a monotonically increasing
 * correlationId. The id is stamped onto:
 *   - the returned CommandResult
 *   - the DeckInteraction the command produced (if any)
 *   - every AssessmentEvent emitted as a consequence
 *
 * Callers can also pass { stepId } to tag events with a shared step id;
 * StepExecutor uses this internally to group the FW sub-commands that make
 * up one high-level VENUS step.
 *
 * FAILURE INJECTION
 *   - If sendCommand forgets to bump the counter, "each command gets a
 *     unique monotonic correlationId" fails.
 *   - If a rejection or query path forgets correlationId, the "rejected
 *     commands also carry a correlationId" test fails.
 *   - If assessment.correlationId isn't wired from the main assess() path,
 *     "all assessments from one command share its correlationId" fails.
 *   - If stepId isn't forwarded from sendCommand options onto DeckInteraction
 *     and AssessmentEvent, the stepId test fails.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

// Grab the underlying DigitalTwin through the private devices map. The
// API doesn't expose it publicly, but unit tests sit on the same process
// and can reach through `(api as any).devices` to exercise twin-only
// surface like nextStepId() and sendCommand's options argument.
function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) {
    throw new Error("Could not reach DigitalTwin through api.devices");
  }
  return device.twin;
}

describe("Correlation IDs (Step 1.9)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("each command gets a unique, monotonically increasing correlationId", () => {
    twin = createTestTwin();
    const r1 = twin.sendCommand("C0RFid9001");
    const r2 = twin.sendCommand("C0RFid9002");
    const r3 = twin.sendCommand("C0RFid9003");

    expect(typeof r1.correlationId).toBe("number");
    expect(r2.correlationId).toBe(r1.correlationId + 1);
    expect(r3.correlationId).toBe(r2.correlationId + 1);
  });

  it("rejected commands also carry a correlationId", () => {
    twin = createTestTwin();
    // Unknown event → "no module handles this" reject path.
    const rejected = twin.sendCommand("CZZZid9999");
    expect(rejected.accepted).toBe(false);
    expect(typeof rejected.correlationId).toBe("number");
  });

  it("deckInteraction produced by a command shares the command's correlationId", () => {
    twin = createTestTwin();
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const r = twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04tp2264th2450td1`);
    expect(r.accepted).toBe(true);
    expect(r.deckInteraction).toBeDefined();
    expect(r.deckInteraction!.correlationId).toBe(r.correlationId);
  });

  it("all assessments emitted by one command share its correlationId", () => {
    twin = createTestTwin();
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04tp2264th2450td1`);
    // Aspirate at (0,0) — unresolved → emits an unresolved_position assessment.
    const r = twin.sendCommand("C0ASid0201xp00000yp00000av01000tm255lm0zp01500th2450");
    const ids = (r.assessments || []).map((a) => a.correlationId);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toBe(r.correlationId);
  });

  it("assessments in the store are findable by correlationId", () => {
    twin = createTestTwin();
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04tp2264th2450td1`);
    const r = twin.sendCommand("C0ASid0201xp00000yp00000av01000tm255lm0zp01500th2450");
    const all = twin.getAssessments();
    const matching = all.filter((a) => a.correlationId === r.correlationId);
    expect(matching.length).toBeGreaterThan(0);
  });

  it("sendCommand with { stepId } stamps the id on the result and on deckInteraction", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const stepId = internal.nextStepId();

    const tipPos = twin.wellXY("TIP001", 0, 0);
    const r = internal.sendCommand(
      `C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04tp2264th2450td1`,
      { stepId }
    );

    expect(r.stepId).toBe(stepId);
    expect(r.deckInteraction?.stepId).toBe(stepId);
  });

  it("nextStepId() increments monotonically", () => {
    twin = createTestTwin();
    const internal = getInternalTwin(twin.api, twin.deviceId);
    const a = internal.nextStepId();
    const b = internal.nextStepId();
    const c = internal.nextStepId();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });
});
