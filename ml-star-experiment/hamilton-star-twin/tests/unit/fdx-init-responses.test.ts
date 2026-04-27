/**
 * VENUS init-path response format tests (Phase 5 Step 5.5).
 *
 * Every expectation here is anchored to a line in the real VENUS
 * ComTrace recording at
 *   VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/TipPickup/
 *   TipPickup1ml_ComTrace.trc
 * The first 30 commands of that trace are the VENUS init sequence
 * the bridge MUST serve correctly for real VENUS to complete
 * handshaking.
 *
 * FAILURE INJECTION
 *   - If C0RQ picks up the `er00/00` prefix, the RQ test sees a
 *     string that starts with `C0RQid####er00/00` instead of
 *     `C0RQid####rq…`.
 *   - If C0RL reverts the field name to `rl`, the LLD test fails the
 *     substring check for `lh`.
 *   - If sub-device P1RF mistakenly emits an `er00` prefix, the
 *     sub-device test sees an extra segment in the response.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("FDx init-path response formats (Step 5.5)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("C0RQ omits the er prefix and emits bare rq####", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0RQid0101");
    expect(r.response).toMatch(/^C0RQid0101rq\d{4}$/);
  });

  it("C0QB returns er00/00 + qb1", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0QBid0102");
    expect(r.response).toBe("C0QBid0102er00/00qb1");
  });

  it("C0RI returns er00/00 + si<date>sn<serial>", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0RIid0103");
    expect(r.response).toMatch(/^C0RIid0103er00\/00si\d{4}-\d{2}-\d{2}sn[A-Z0-9]+$/);
  });

  it("C0QM returns er00/00 + packed machine params", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0QMid0104");
    expect(r.response.startsWith("C0QMid0104er00/00ka")).toBe(true);
    expect(r.response).toMatch(/xt\d+xa\d+/);
  });

  it("C0RM returns er00/00 + machine-status block", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0RMid0105");
    expect(r.response.startsWith("C0RMid0105er00/00kb")).toBe(true);
    expect(r.response).toMatch(/kp08 C0\d{4} .*P10000 P20000/);
  });

  it("C0RF returns er00/00 + rf version string", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0RFid0106");
    expect(r.response).toMatch(/^C0RFid0106er00\/00rf[0-9]+\.[0-9]+[A-Z].*\(GRU C0\)$/);
  });

  it("C0RL returns er00/00 + lh<signed 4-digit × 16> — NOT rl", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("C0RLid0200");
    expect(r.response.startsWith("C0RLid0200er00/00lh")).toBe(true);
    // 16 channels expected; each token is `[+-]NNNN`, separated by space.
    const lhPart = r.response.replace(/^C0RLid0200er00\/00lh/, "");
    const tokens = lhPart.split(" ");
    expect(tokens.length).toBe(16);
    for (const t of tokens) expect(t).toMatch(/^[+-]\d{4}$/);
  });

  it("sub-device P1RF returns id#### + rf<...> WITHOUT an er prefix", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("P1RFid0107");
    // Real-trace shape: P1RFid0107rf6.0S 07 2024-12-18 (PipChannelRpc)
    expect(r.response).toMatch(/^P1RFid0107rf[0-9]+\.[0-9]+[A-Z].*\(PipChannelRpc\)$/);
    expect(r.response).not.toContain("er00");
  });

  it("sub-device H0RF uses the H0-specific version string", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("H0RFid0130");
    expect(r.response).toMatch(/H0RFid0130rf[0-9]+\.[0-9]+[A-Z].*\(H0 XE167\)$/);
  });

  it("sub-device X0RF returns its own version string", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("X0RFid0124");
    expect(r.response).toMatch(/X0RFid0124rf[0-9]+\.[0-9]+S /);
  });

  it("sub-device P1RJ returns jd<date>js<status>", () => {
    twin = createTestTwin();
    const r = twin.sendCommand("P1RJid0108");
    expect(r.response).toMatch(/^P1RJid0108jd\d{4}-\d{2}-\d{2}js[01]$/);
  });

  // Replay the exact init sequence VENUS sends and confirm every
  // response round-trips the expected shape.
  it("replays the full VENUS init sequence without a malformed response", () => {
    twin = createTestTwin();
    const sequence: Array<{ cmd: string; matcher: RegExp }> = [
      { cmd: "C0RQid0101", matcher: /^C0RQid0101rq\d{4}$/ },
      { cmd: "C0QBid0102", matcher: /^C0QBid0102er00\/00qb1$/ },
      { cmd: "C0RIid0103", matcher: /^C0RIid0103er00\/00si/ },
      { cmd: "C0QMid0104", matcher: /^C0QMid0104er00\/00ka/ },
      { cmd: "C0RMid0105", matcher: /^C0RMid0105er00\/00kb/ },
      { cmd: "C0RFid0106", matcher: /^C0RFid0106er00\/00rf/ },
      { cmd: "P1RFid0107", matcher: /^P1RFid0107rf/ },
      { cmd: "P1RJid0108", matcher: /^P1RJid0108jd/ },
      { cmd: "H0RFid0130", matcher: /^H0RFid0130rf/ },
      { cmd: "X0RFid0124", matcher: /^X0RFid0124rf/ },
      { cmd: "I0RFid0126", matcher: /^I0RFid0126rf/ },
    ];
    for (const { cmd, matcher } of sequence) {
      const r = twin.sendCommand(cmd);
      expect(r.response).toMatch(matcher);
    }
  });
});
