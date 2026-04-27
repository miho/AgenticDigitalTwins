/**
 * iSWAP Physics Plugin
 *
 * The iSWAP is a robotic arm that picks up and places plates.
 * It swivels (rotation), extends (Y), raises/lowers (Z),
 * and rides on the X-arm rail.
 */

import { PhysicsPlugin, PhysicsValidation, CommandTiming } from "../plugin-interface";
import { AssessmentEvent } from "../assessment";

/**
 * iSWAP operation times from real Hamilton STAR traces.
 * Real C0PP (get plate) takes ~17s total, C0PR (put plate) ~9s.
 * The full sequence is: X travel + arm extend + Y approach + Z descent +
 * gripper close + Z retract + arm collapse + X decelerate.
 */
const ARM_EXTEND_MS = 1200;     // Arm swing out to reach position
const ARM_COLLAPSE_MS = 800;    // Arm swing back to park
const Y_APPROACH_MS = 1500;     // Y-axis approach to plate center
const Y_RETRACT_MS = 1000;      // Y-axis retract from plate
const Z_APPROACH_MS = 1200;     // Z descent to grip height (slower for safety)
const Z_RETRACT_MS = 1000;      // Z ascent with plate (slower with load)
const GRIPPER_OPEN_MS = 300;    // Gripper open actuator
const GRIPPER_CLOSE_MS = 500;   // Gripper close + pressure check
const PLATE_SENSE_MS = 400;     // Plate width verification
const X_SPEED = 20000;          // 0.1mm/s (2000 mm/s)
const X_ACCEL = 40000;          // 0.1mm/s² (4000 mm/s²)

function moveTime(distance: number, speed: number, accel: number): number {
  if (distance <= 0) return 0;
  const accelDist = (speed * speed) / (2 * accel);
  if (distance < 2 * accelDist) {
    return Math.round(2 * Math.sqrt(distance / accel) * 1000);
  }
  const accelTime = speed / accel;
  const cruiseDist = distance - 2 * accelDist;
  return Math.round((2 * accelTime + cruiseDist / speed) * 1000);
}

export class ISwapPhysicsPlugin implements PhysicsPlugin {
  readonly id = "iswap-physics";
  private executor: any = null;

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
  }

  /**
   * Physics validation: check plate presence/absence before iSWAP commands.
   * Simulates the plate sensor on the real instrument.
   */
  validateCommand(event: string, data: Record<string, unknown>, deckTracker: any): PhysicsValidation | undefined {
    // iSWAP FW commands (C0PP/C0PR/C0PM) carry coords as `xs`/`yj`,
    // not `xp`/`yp` — those belong to the PIP channel. Fall through
    // both so the pre-check works for iSWAP commands too.
    const x = (data.xp as number) ?? (data.xs as number) ?? 0;
    const y = (data.yp as number) ?? (data.yh as number) ?? (data.yj as number) ?? 0;

    switch (event) {
      case "C0PP": {
        // Get plate: there must be a plate at the target position
        if (x === 0 && y === 0) return undefined;
        const res = deckTracker.resolvePosition(x, y);
        if (res.matched && res.labwareType?.includes("Tip")) {
          return { valid: false, errorCode: 22, errorDescription: `Cannot grip a tip rack at ${res.description}` };
        }
        if (!res.matched) {
          return { valid: false, errorCode: 22, errorDescription: `No labware at target position to pick up` };
        }
        return undefined;
      }

      case "C0PR": {
        // Put plate: target position must be empty
        if (x === 0 && y === 0) return undefined;
        const res = deckTracker.resolvePosition(x, y);
        if (res.matched && res.labwareType?.includes("Tip")) {
          return { valid: false, errorCode: 22, errorDescription: `Cannot place plate on tip rack at ${res.description}` };
        }
        if (res.matched && res.labwareType) {
          return { valid: false, errorCode: 22, errorDescription: `Position occupied by ${res.labwareType} (${res.description})` };
        }
        return undefined;
      }
    }

    return undefined;
  }

  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    const dm = this.executor?.machine?._datamodel;
    if (!dm) return data;

    switch (event) {
      case "C0FI":
        return { ...data, _delay: "1500ms" };

      case "C0FY":
        return { ...data, _delay: "300ms" };

      case "C0PP": {
        // Get plate: full sequence ≈ 12-17s from real traces
        // X travel + arm extend + Y approach + Z descent + grip + sense + Z retract + Y retract + arm collapse
        const currentX = dm.pos_x || 0;
        const targetX = (data.xs as number) ?? currentX;
        const xDist = Math.abs(targetX - currentX);
        const xTime = xDist > 0 ? moveTime(xDist, X_SPEED, X_ACCEL) : 0;
        const totalTime = xTime + ARM_EXTEND_MS + Y_APPROACH_MS + Z_APPROACH_MS + GRIPPER_CLOSE_MS + PLATE_SENSE_MS + Z_RETRACT_MS + Y_RETRACT_MS + ARM_COLLAPSE_MS;
        return { ...data, _delay: totalTime + "ms" };
      }

      case "C0PR": {
        // Put plate: ≈ 7-9s from real traces
        const currentX = dm.pos_x || 0;
        const targetX = (data.xs as number) ?? currentX;
        const xDist = Math.abs(targetX - currentX);
        const xTime = xDist > 0 ? moveTime(xDist, Math.round(X_SPEED * 0.7), X_ACCEL) : 0;
        const totalTime = xTime + ARM_EXTEND_MS + Y_APPROACH_MS + Z_APPROACH_MS + GRIPPER_OPEN_MS + Z_RETRACT_MS + Y_RETRACT_MS + ARM_COLLAPSE_MS;
        return { ...data, _delay: totalTime + "ms" };
      }

      case "C0PM": {
        // Move plate: X travel (with plate, 30% slower) + Y re-approach
        const currentX = dm.pos_x || 0;
        const targetX = (data.xs as number) ?? currentX;
        const distance = Math.abs(targetX - currentX);
        const plateSpeed = Math.round(X_SPEED * 0.7);
        const xTime = moveTime(distance, plateSpeed, X_ACCEL);
        return { ...data, _delay: Math.max(500, xTime + Y_APPROACH_MS) + "ms" };
      }

      case "C0PG":
        // Park: arm collapse + Y retract
        return { ...data, _delay: (ARM_COLLAPSE_MS + Y_RETRACT_MS) + "ms" };

      case "C0PB":
        // Barcode read
        return { ...data, _delay: "400ms" };

      default:
        return data;
    }
  }

  assess(event: string, data: Record<string, unknown>, deckTracker: any): AssessmentEvent[] {
    const events: AssessmentEvent[] = [];
    const x = (data.xs as number) ?? 0;
    const y = (data.yj as number) ?? (data.yh as number) ?? 0;

    if (event === "C0PP") {
      // GetPlate: report grip operation
      const gw = (data.gw as number) ?? 0;
      const go = (data.go as number) ?? 0;
      const res = x > 0 ? deckTracker.resolvePosition?.(x, y) : null;
      events.push({
        id: 0, timestamp: 0,
        category: "transport",
        severity: "info",
        module: "iswap",
        command: event,
        description: `iSWAP pick plate${res?.matched ? ` from ${res.description}` : ""} (grip=${(gw / 10).toFixed(0)}mm, open=${(go / 10).toFixed(0)}mm)`,
        data: { gripWidth_01mm: gw, openWidth_01mm: go, position: res?.description },
      });
    } else if (event === "C0PR") {
      // PutPlate: report place operation
      const res = x > 0 ? deckTracker.resolvePosition?.(x, y) : null;
      events.push({
        id: 0, timestamp: 0,
        category: "transport",
        severity: "info",
        module: "iswap",
        command: event,
        description: `iSWAP place plate${res?.matched ? ` at ${res.description}` : ""}`,
        data: { position: res?.description },
      });
    } else if (event === "C0PM") {
      events.push({
        id: 0, timestamp: 0,
        category: "transport",
        severity: "info",
        module: "iswap",
        command: event,
        description: `iSWAP move plate to X=${(x / 10).toFixed(0)}mm`,
        data: { targetX_01mm: x },
      });
    }

    return events;
  }

  estimateTime(event: string, data: Record<string, unknown>): CommandTiming | undefined {
    const breakdown: Array<{ phase: string; ms: number; detail?: string }> = [];

    switch (event) {
      case "C0PP": {
        // Get plate: full approach + grip + retract sequence (12-17s from real traces)
        breakdown.push({ phase: "arm extend", ms: ARM_EXTEND_MS, detail: "swing out to position" });
        breakdown.push({ phase: "Y approach", ms: Y_APPROACH_MS, detail: "approach plate center" });
        breakdown.push({ phase: "Z approach", ms: Z_APPROACH_MS, detail: "descend to grip height" });
        breakdown.push({ phase: "gripper close", ms: GRIPPER_CLOSE_MS, detail: "grip plate" });
        breakdown.push({ phase: "plate sense", ms: PLATE_SENSE_MS, detail: "width verification" });
        breakdown.push({ phase: "Z retract", ms: Z_RETRACT_MS, detail: "lift plate" });
        breakdown.push({ phase: "Y retract", ms: Y_RETRACT_MS, detail: "retract from position" });
        breakdown.push({ phase: "arm collapse", ms: ARM_COLLAPSE_MS, detail: "swing to travel" });
        const total = ARM_EXTEND_MS + Y_APPROACH_MS + Z_APPROACH_MS + GRIPPER_CLOSE_MS + PLATE_SENSE_MS + Z_RETRACT_MS + Y_RETRACT_MS + ARM_COLLAPSE_MS;
        return { totalMs: total, accuracy: "computed", breakdown };
      }

      case "C0PR": {
        // Put plate: approach + release + retract (7-9s from real traces)
        breakdown.push({ phase: "arm extend", ms: ARM_EXTEND_MS, detail: "swing out to position" });
        breakdown.push({ phase: "Y approach", ms: Y_APPROACH_MS, detail: "approach target" });
        breakdown.push({ phase: "Z approach", ms: Z_APPROACH_MS, detail: "descend to place" });
        breakdown.push({ phase: "gripper open", ms: GRIPPER_OPEN_MS, detail: "release plate" });
        breakdown.push({ phase: "Z retract", ms: Z_RETRACT_MS, detail: "lift arm" });
        breakdown.push({ phase: "Y retract", ms: Y_RETRACT_MS, detail: "retract from position" });
        breakdown.push({ phase: "arm collapse", ms: ARM_COLLAPSE_MS, detail: "swing to travel" });
        const total = ARM_EXTEND_MS + Y_APPROACH_MS + Z_APPROACH_MS + GRIPPER_OPEN_MS + Z_RETRACT_MS + Y_RETRACT_MS + ARM_COLLAPSE_MS;
        return { totalMs: total, accuracy: "computed", breakdown };
      }

      case "C0PM": {
        // Move plate: X travel with plate (30% slower)
        const dm2 = this.executor?.machine?._datamodel;
        const curX = dm2?.pos_x || 0;
        const tgtX = (data.xs as number) ?? curX;
        const dist = Math.abs(tgtX - curX);
        const xMs = dist > 0 ? moveTime(dist, Math.round(X_SPEED * 0.7), X_ACCEL) : 500;
        breakdown.push({ phase: "X travel", ms: xMs, detail: `${(dist / 10).toFixed(0)}mm with plate` });
        return { totalMs: xMs, accuracy: dist > 0 ? "computed" : "estimate", breakdown };
      }

      default:
        return undefined;
    }
  }
}
