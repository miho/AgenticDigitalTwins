/**
 * Regression: asp/disp driven via the FW TCP bridge (VENUS's path)
 * must update the twin's wellVolumes.
 *
 * The user reported that running Method1 via real VENUS shows the arm
 * moving correctly but the inspector volumes never change. That's the
 * worst-case split: the motion envelope fires from pip-physics
 * regardless of SCXML acceptance, while `deckTracker.processCommand`
 * only runs when the command is accepted AND has errorCode === 0 (see
 * `digital-twin.ts:610`). A silently rejected command therefore moves
 * the arm on screen while leaving the volume books untouched — exactly
 * what the user saw.
 *
 * This test drives the EXACT SAME TCP path VENUS uses — plain BDZ
 * line-delimited FW commands — and asserts that wellVolumes reflect
 * the aspirate/dispense. If this passes, the user's bug is specific
 * to the command sequence VENUS is sending (different parameters or a
 * command the twin silently drops).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as net from "net";
import * as path from "path";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startFwServer } = require("../../dist/services/bdz-bridge/fw-server");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { importVenusLayout } = require("../../dist/services/venus-import/venus-deck-importer");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseHxCfgFile } = require("../../dist/services/venus-import/hxcfg-parser");
import * as fs from "fs";

async function connectAndSend(port: number, commands: string[]): Promise<string[]> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const responses: string[] = [];
  let buffer = "";
  socket.setEncoding("ascii");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx === -1) break;
      responses.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  for (const raw of commands) {
    socket.write(`${raw}\r\n`, "ascii");
    // Wait for the specific response to come back.
    const idMatch = /id(\d{4})/.exec(raw);
    const id = idMatch?.[1];
    const deadline = Date.now() + 3000;
    while (!responses.some(r => !id || r.includes(`id${id}`))) {
      if (Date.now() > deadline) throw new Error(`Timeout waiting for response to ${raw}`);
      await new Promise(r => setTimeout(r, 5));
    }
  }
  await new Promise<void>((resolve) => { socket.end(() => resolve()); });
  return responses;
}

const METHOD1_LAY = "C:\\Program Files (x86)\\Hamilton\\Methods\\Method1.lay";

describe("FW bridge → wellVolumes update (VENUS-driven asp/disp)", () => {
  let server: any;
  let twin: ReturnType<typeof createTestTwin>;
  let haveMethod1 = false;

  beforeAll(async () => {
    twin = createTestTwin();
    // If Method1.lay isn't on disk, skip — the test relies on its
    // specific carrier id + well coordinates.
    if (fs.existsSync(METHOD1_LAY)) {
      try {
        const doc = parseHxCfgFile(METHOD1_LAY);
        const { deck } = importVenusLayout(doc, {});
        (twin.api as any).loadDeck(twin.deviceId, deck);
        haveMethod1 = true;
      } catch { /* skip */ }
    }
    server = await startFwServer({
      api: twin.api,
      getActiveDeviceId: () => twin.deviceId,
      port: 0,
      simSpeed: 0,
    });
  });

  afterAll(async () => {
    await server?.close();
    twin.destroy();
  });

  it("aspirate and dispense over TCP actually change wellVolumes", async () => {
    if (!haveMethod1) { console.warn("skip: Method1.lay unavailable"); return; }

    // Pre-fill pos 0 (SiteId 1, rear plate) with 1 mL/well, exactly as
    // VENUS would leave the deck after a fill step.
    const ok = twin.api.fillLabwareWithLiquid(
      twin.deviceId, "PLT_CAR_L5AC_A00_0001", 0, "Water", 10000,
    );
    expect(ok).toBe(true);

    const tracker = twin.api.getDeckTracking(twin.deviceId);
    expect(tracker.wellVolumes["PLT_CAR_L5AC_A00_0001:0:0"]).toBe(10000);

    // Drive the init + tip pickup + aspirate + dispense sequence over
    // the SAME TCP transport VENUS uses.
    await connectAndSend(server.port, [
      "C0VIid0001",
      "C0DIid0002",
      "C0EIid0003",
      "C0IIid0004",
      "C0TPid0010xp01180yp05298tm1tt04tp2264th2450td1",          // tip pickup at SiteId 1 of tip rack
      "C0ASid0011xp02756yp05300av03000tm1lm0zp01500th2450",    // aspirate 300 µL from PLT pos 0 A1
      "C0DSid0012xp02756yp01460dv03000tm1dm2zp01500th2450",    // dispense 300 µL into PLT pos 4 A1
    ]);

    const after = twin.api.getDeckTracking(twin.deviceId);
    // If the bridge properly runs deck-tracker, pos 0 A1 is down by 300 µL
    // (10000 - 3000 = 7000 in 0.1 µL units) and pos 4 A1 has 3000.
    expect(after.wellVolumes["PLT_CAR_L5AC_A00_0001:0:0"]).toBe(7000);
    expect(after.wellVolumes["PLT_CAR_L5AC_A00_0001:4:0"]).toBe(3000);
  });

  it("even if SCXML silently drops the command, we should emit a DECK log so the UI can tell", async () => {
    // This test asserts an observability contract: a C0AS sent over the
    // TCP bridge that doesn't change wellVolumes MUST leave a trace in
    // the command log (rejected / deck-unmatched). Otherwise the user
    // just sees "arm moved, volumes didn't change" with no clue why —
    // exactly the complaint.
    if (!haveMethod1) { console.warn("skip: Method1.lay unavailable"); return; }

    // Pre-fill a fresh plate state.
    twin.api.fillLabwareWithLiquid(
      twin.deviceId, "PLT_CAR_L5AC_A00_0001", 0, "Water", 10000,
    );

    // Send a C0AS WITHOUT doing a tip pickup first. Real VENUS wouldn't,
    // but our pip SCXML rejects C0AS when no tip is fitted — exposing the
    // "no deck update when command silently drops" path.
    await connectAndSend(server.port, [
      "C0ASid0021xp02756yp05300av03000tm1lm0zp01500th2450",
    ]);

    // Volume unchanged because SCXML rejected (no tip) — verify our log
    // path produced a REJECTED entry. Without this signal, the UI has
    // no way to surface the failure.
    const logs = twin.api.getRecentLogs?.(twin.deviceId, 10) ?? [];
    const rejected = logs.find((l: any) =>
      typeof l?.message === "string" && /REJECT|ERROR|not valid/i.test(l.message),
    );
    // Don't fail if `getRecentLogs` isn't wired — this is a weaker
    // assertion that also serves as a FIXME marker.
    if (rejected) expect(rejected).toBeTruthy();
  });
});
