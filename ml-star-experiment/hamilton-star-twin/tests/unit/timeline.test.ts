/**
 * EventSpine tests (Step 1.10).
 *
 * The EventSpine is the twin's unified ordered timeline. Every command,
 * assessment, deck interaction, device event, and completion is appended
 * to it with a globally monotonic id. Consumers (TraceRecorder, replay UI,
 * MCP analysis) query through kind / severity / correlation / well / range
 * filters.
 *
 * FAILURE INJECTION
 *   - If sendCommand forgets to push onto the spine, "spine receives a
 *     command event per sendCommand" fails because size() stays flat.
 *   - If assessment push uses a wrong kind string, the kind filter returns
 *     nothing and "assessments are queryable by kind" fails.
 *   - If correlation is left off the spine entry, "events from one command
 *     share a correlationId on the spine" fails.
 *   - If clear() doesn't reset nextId, insertion-order ids become
 *     non-monotonic across a reset and "clear resets ids" fails.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

// Runtime import — EventSpine is a pure class, imported from dist for parity
// with the rest of the test harness.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EventSpine } = require("../../dist/twin/timeline");

function getInternalTwin(api: any, deviceId: string): any {
  const device = api.devices?.get ? api.devices.get(deviceId) : undefined;
  if (!device?.twin) {
    throw new Error("Could not reach DigitalTwin through api.devices");
  }
  return device.twin;
}

describe("EventSpine (Step 1.10)", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  // --- pure-class tests (no twin needed) ---------------------------------

  describe("pure class", () => {
    it("assigns monotonically increasing ids starting at 1", () => {
      const spine = new EventSpine();
      const a = spine.add({ kind: "command", payload: { x: 1 } });
      const b = spine.add({ kind: "command", payload: { x: 2 } });
      const c = spine.add({ kind: "command", payload: { x: 3 } });
      expect(a.id).toBe(1);
      expect(b.id).toBe(2);
      expect(c.id).toBe(3);
    });

    it("size() and getAll() reflect additions", () => {
      const spine = new EventSpine();
      expect(spine.size()).toBe(0);
      spine.add({ kind: "command", payload: {} });
      spine.add({ kind: "assessment", severity: "warning", payload: {} });
      expect(spine.size()).toBe(2);
      expect(spine.getAll()).toHaveLength(2);
    });

    it("filters by kind", () => {
      const spine = new EventSpine();
      spine.add({ kind: "command", payload: {} });
      spine.add({ kind: "assessment", severity: "info", payload: {} });
      spine.add({ kind: "assessment", severity: "error", payload: {} });
      spine.add({ kind: "device_event", payload: {} });
      expect(spine.getByKind("assessment")).toHaveLength(2);
      expect(spine.getByKind("command")).toHaveLength(1);
      expect(spine.getByKind("device_event")).toHaveLength(1);
    });

    it("filters by severity", () => {
      const spine = new EventSpine();
      spine.add({ kind: "assessment", severity: "info", payload: {} });
      spine.add({ kind: "assessment", severity: "warning", payload: {} });
      spine.add({ kind: "assessment", severity: "error", payload: {} });
      spine.add({ kind: "assessment", severity: "error", payload: {} });
      expect(spine.getBySeverity("error")).toHaveLength(2);
      expect(spine.getBySeverity("warning")).toHaveLength(1);
      expect(spine.getBySeverity("info")).toHaveLength(1);
    });

    it("filters by correlationId and stepId", () => {
      const spine = new EventSpine();
      spine.add({ kind: "command", correlationId: 1, payload: {} });
      spine.add({ kind: "deck_interaction", correlationId: 1, payload: {} });
      spine.add({ kind: "assessment", correlationId: 1, stepId: 10, payload: {} });
      spine.add({ kind: "command", correlationId: 2, payload: {} });
      expect(spine.getByCorrelation(1)).toHaveLength(3);
      expect(spine.getByCorrelation(2)).toHaveLength(1);
      expect(spine.getByStep(10)).toHaveLength(1);
      expect(spine.getByStep(999)).toHaveLength(0);
    });

    it("filters by time range (inclusive)", async () => {
      const spine = new EventSpine();
      spine.add({ kind: "command", payload: {} });
      // Ensure later entries have a strictly later timestamp.
      await new Promise((r) => setTimeout(r, 5));
      const mid = spine.add({ kind: "command", payload: {} });
      await new Promise((r) => setTimeout(r, 5));
      spine.add({ kind: "command", payload: {} });

      const window = spine.getInRange(mid.timestamp, mid.timestamp);
      expect(window.length).toBeGreaterThanOrEqual(1);
      expect(window.some((e: any) => e.id === mid.id)).toBe(true);
    });

    it("clear() resets id counter back to 1", () => {
      const spine = new EventSpine();
      spine.add({ kind: "command", payload: {} });
      spine.add({ kind: "command", payload: {} });
      expect(spine.size()).toBe(2);
      spine.clear();
      expect(spine.size()).toBe(0);
      const fresh = spine.add({ kind: "command", payload: {} });
      expect(fresh.id).toBe(1);
    });

    it("onEvent listener receives every add and unsubscribes cleanly", () => {
      const spine = new EventSpine();
      const received: number[] = [];
      const unsubscribe = spine.onEvent((e: any) => received.push(e.id));
      spine.add({ kind: "command", payload: {} });
      spine.add({ kind: "command", payload: {} });
      unsubscribe();
      spine.add({ kind: "command", payload: {} });
      expect(received).toEqual([1, 2]);
    });

    it("getByWell matches deck_interaction payloads whose resolution points at the well", () => {
      const spine = new EventSpine();
      spine.add({
        kind: "deck_interaction",
        payload: {
          timestamp: 0,
          command: "C0AS",
          x: 0, y: 0,
          resolution: { matched: true, carrierId: "SMP001", position: 0, wellIndex: 3, description: "well" },
        },
      });
      spine.add({
        kind: "deck_interaction",
        payload: {
          timestamp: 0,
          command: "C0DS",
          x: 0, y: 0,
          resolution: { matched: true, carrierId: "SMP001", position: 0, wellIndex: 5, description: "other" },
        },
      });
      const hits = spine.getByWell("SMP001:0:3");
      expect(hits).toHaveLength(1);
      expect((hits[0].payload as any).command).toBe("C0AS");
    });
  });

  // --- wired-into-twin tests --------------------------------------------

  describe("wired into DigitalTwin", () => {
    it("sendCommand appends a command event with the right correlationId", () => {
      twin = createTestTwin();
      const internal = getInternalTwin(twin.api, twin.deviceId);
      const spine = internal.getEventSpine();

      const before = spine.size();
      const r = twin.sendCommand("C0RFid9001");
      const commandEvents = spine
        .getByCorrelation(r.correlationId)
        .filter((e: any) => e.kind === "command");
      expect(spine.size()).toBeGreaterThan(before);
      expect(commandEvents.length).toBe(1);
      expect(commandEvents[0].payload.correlationId).toBe(r.correlationId);
    });

    it("an aspirate-at-unresolved command adds both assessment and command events", () => {
      twin = createTestTwin();
      const tipPos = twin.wellXY("TIP001", 0, 0);
      twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

      const internal = getInternalTwin(twin.api, twin.deviceId);
      const spine = internal.getEventSpine();

      const r = twin.sendCommand("C0ASid0201xp00000yp00000av01000tm255lm0");
      const related = spine.getByCorrelation(r.correlationId);
      const kinds = new Set(related.map((e: any) => e.kind));
      expect(kinds.has("assessment")).toBe(true);
      expect(kinds.has("command")).toBe(true);
    });

    it("a successful command adds a deck_interaction event", () => {
      twin = createTestTwin();
      const internal = getInternalTwin(twin.api, twin.deviceId);
      const spine = internal.getEventSpine();

      const tipPos = twin.wellXY("TIP001", 0, 0);
      const r = twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);
      const interactions = spine
        .getByCorrelation(r.correlationId)
        .filter((e: any) => e.kind === "deck_interaction");
      expect(interactions).toHaveLength(1);
    });

    it("device-event emissions flow onto the spine", () => {
      twin = createTestTwin();
      const internal = getInternalTwin(twin.api, twin.deviceId);
      const spine = internal.getEventSpine();
      const before = spine.getByKind("device_event").length;
      internal.getDeviceEvents().simulateCoverOpen();
      const after = spine.getByKind("device_event").length;
      expect(after).toBe(before + 1);
    });

    it("reset clears the spine and restarts ids at 1", () => {
      twin = createTestTwin();
      twin.sendCommand("C0RFid9001");
      twin.sendCommand("C0RFid9002");
      const internal = getInternalTwin(twin.api, twin.deviceId);
      expect(internal.getEventSpine().size()).toBeGreaterThan(0);
      twin.reset();
      const spine = internal.getEventSpine();
      expect(spine.size()).toBe(0);
      // New command after reset starts a fresh id sequence on the spine.
      twin.sendCommand("C0RFid9003");
      const first = spine.getAll()[0];
      expect(first.id).toBe(1);
    });
  });
});
