/**
 * CoRe 96 Head Physics Plugin
 *
 * The 96-channel head moves as a single unit in X, Y, Z.
 * Y range is constrained to 1054-5743 (0.1mm).
 * All 96 channels operate simultaneously.
 */

import { PhysicsPlugin, PhysicsValidation, TransitionInfo, CommandTiming } from "../plugin-interface";
import { AssessmentEvent } from "../assessment";
import { generateAspirateCurve, generateDispenseCurve } from "../tadm";

const Y_SPEED = 8000;      // 800 mm/s
const Z_SPEED = 12000;     // 1200 mm/s
const X_SPEED = 20000;     // 2000 mm/s
const ACCEL = 40000;       // 4000 mm/s^2

const TIP_PICKUP_96_MS = 1200;   // 96 tips simultaneously
const TIP_EJECT_96_MS = 800;
const WASH_CYCLE_MS = 3000;      // Per wash cycle

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

export class CoRe96HeadPhysicsPlugin implements PhysicsPlugin {
  readonly id = "h96-physics";
  private executor: any = null;
  private lastTADM: import("../tadm").TADMResult | null = null;
  private lastEventData: Record<string, unknown> = {};

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
  }

  /**
   * Physics validation: check labware type for 96-head commands.
   * The 96-head can only pick tips from tip racks and aspirate from non-tip-rack labware.
   */
  validateCommand(event: string, data: Record<string, unknown>, deckTracker: any): PhysicsValidation | undefined {
    const x = (data.xp as number) ?? (data.xs as number) ?? 0;
    const y = (data.yp as number) ?? (data.yh as number) ?? 0;

    switch (event) {
      case "C0EA": {
        // 96-tip aspirate: target must NOT be a tip rack
        if (x === 0 && y === 0) return undefined;
        const res = deckTracker.resolvePosition(x, y);
        if (res.matched && res.labwareType?.includes("Tip")) {
          return { valid: false, errorCode: 22, errorDescription: `Cannot aspirate from tip rack (${res.description})` };
        }
        return undefined;
      }

      case "C0EP": {
        // 96-tip pickup: target must BE a tip rack
        if (x === 0 && y === 0) return undefined;
        const res = deckTracker.resolvePosition(x, y);
        if (res.matched && !res.labwareType?.includes("Tip")) {
          return { valid: false, errorCode: 22, errorDescription: `No tip rack at position — found ${res.labwareType} (${res.description})` };
        }
        if (!res.matched && res.carrierId) {
          return { valid: false, errorCode: 22, errorDescription: `No labware at ${res.description}` };
        }
        return undefined;
      }
    }

    return undefined;
  }

  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    this.lastEventData = data;
    const dm = this.executor?.machine?._datamodel;
    if (!dm) return data;

    switch (event) {
      case "C0EI":
        return { ...data, _delay: "2000ms" };

      case "C0EP":
        return { ...data, _delay: TIP_PICKUP_96_MS + "ms" };

      case "C0ER":
        return { ...data, _delay: TIP_EJECT_96_MS + "ms" };

      case "C0EA": {
        const vol = (data.af as number) || 0;
        const speed = (data.ag as number) || 5000;
        const aspTime = Math.round((vol / speed) * 1000);
        const settleTime = ((data.wh as number) || 0) * 100;
        return { ...data, _delay: (aspTime + settleTime + 200) + "ms" };
      }

      case "C0ED": {
        const vol = (data.df as number) || 0;
        const speed = (data.dg as number) || 5000;
        const dspTime = Math.round((vol / speed) * 1000);
        return { ...data, _delay: (dspTime + 150) + "ms" };
      }

      case "C0EM": {
        const currentY = dm.pos_y || 0;
        const targetY = (data.yh as number) ?? currentY;
        const yDist = Math.abs(targetY - currentY);
        const currentX = dm.pos_x || 0;
        const targetX = (data.xs as number) ?? currentX;
        const xDist = Math.abs(targetX - currentX);
        // X and Y move in parallel, Z moves first (sequential)
        const xyTime = Math.max(moveTime(xDist, X_SPEED, ACCEL), moveTime(yDist, Y_SPEED, ACCEL));
        const zDist = (data.za as number) ? Math.abs((data.za as number) - (dm.pos_z || 0)) : 0;
        const zTime = moveTime(zDist, Z_SPEED, ACCEL);
        return { ...data, _delay: (zTime + xyTime + 100) + "ms" };
      }

      case "C0EG": {
        const cycles = (data.hc as number) || 3;
        return { ...data, _delay: (cycles * WASH_CYCLE_MS + 500) + "ms" };
      }

      default:
        return data;
    }
  }

  onAfterTransition(info: TransitionInfo): void {
    const event = info.event;
    const data = this.lastEventData;

    // Generate TADM curves for aspirate/dispense (real 96-head has TADM)
    if (event === "C0EA") {
      const vol = (data.af as number) ?? 0;
      const speed = (data.ag as number) ?? 2500;
      this.lastTADM = generateAspirateCurve(vol, speed, 1.0);  // viscosity 1.0 (water default)
    } else if (event === "C0ED") {
      const vol = (data.df as number) ?? 0;
      const speed = (data.dg as number) ?? 2500;
      const dm = (data.da as number) ?? 0;
      this.lastTADM = generateDispenseCurve(vol, speed, dm, 1.0);
    }
  }

  assess(event: string, data: Record<string, unknown>, deckTracker: any): AssessmentEvent[] {
    const events: AssessmentEvent[] = [];

    if (event === "C0EA" || event === "C0ED") {
      const vol = (data.af as number) ?? (data.df as number) ?? 0;
      const operation = event === "C0EA" ? "aspirate" : "dispense";

      events.push({
        id: 0, timestamp: 0,
        category: "tadm",
        severity: "info",
        module: "h96",
        command: event,
        description: `TADM 96-head ${operation} passed — peak ${this.lastTADM?.peakPressure ?? 0} mbar, ${vol / 10}uL`,
        tadm: this.lastTADM ?? undefined,
      });
    }

    if (event === "C0EA") {
      // Scan all wells the head just aspirated from; flag any that went negative.
      const x = (data.xp as number) ?? (data.xs as number) ?? 0;
      const y = (data.yp as number) ?? (data.yh as number) ?? 0;
      const aspVol = (data.af as number) ?? 0;
      const res = deckTracker.resolvePosition?.(x, y);
      if (res?.matched && aspVol > 0) {
        let underflowed = 0;
        let maxDeficit = 0;
        let firstWellIdx = -1;
        for (let i = 0; i < 96; i++) {
          const wv = deckTracker.getWellVolume?.(res.carrierId, res.position, i);
          if (wv !== undefined && wv < 0) {
            underflowed++;
            if (-wv > maxDeficit) maxDeficit = -wv;
            if (firstWellIdx < 0) firstWellIdx = i;
          }
        }
        if (underflowed > 0) {
          events.push({
            id: 0, timestamp: 0,
            category: "volume_underflow",
            severity: "warning",
            module: "h96",
            command: event,
            description: `96-head underflow: ${underflowed} well(s) at ${res.description} had < ${aspVol / 10}uL — max deficit ${maxDeficit / 10}uL`,
            data: {
              underflowedWells: underflowed,
              maxDeficit_01ul: maxDeficit,
              requestedVolume_01ul: aspVol,
              firstWellIdx,
            },
          });
        }
      }
    }

    return events;
  }

  estimateTime(event: string, data: Record<string, unknown>): CommandTiming | undefined {
    const breakdown: Array<{ phase: string; ms: number; detail?: string }> = [];

    switch (event) {
      case "C0EM": {
        // 96-head X+Y move
        breakdown.push({ phase: "X+Y travel", ms: 900, detail: "parallel axis move" });
        breakdown.push({ phase: "settle", ms: 100 });
        return { totalMs: 1000, accuracy: "estimate", breakdown };
      }

      case "C0EP": {
        // 96-tip pickup: Z down + 96-grip + Z up
        breakdown.push({ phase: "Z descend", ms: 400, detail: "to tip rack" });
        breakdown.push({ phase: "96-grip", ms: 500, detail: "CO-RE compression x96" });
        breakdown.push({ phase: "Z retract", ms: 400 });
        return { totalMs: 1300, accuracy: "estimate", breakdown };
      }

      case "C0ER": {
        // 96-tip eject
        breakdown.push({ phase: "Z descend", ms: 250, detail: "to eject height" });
        breakdown.push({ phase: "tip release", ms: 300, detail: "96 channels" });
        breakdown.push({ phase: "Z retract", ms: 250 });
        return { totalMs: 800, accuracy: "estimate", breakdown };
      }

      case "C0EA": {
        // 96-head aspirate: compute from volume
        const vol = (data.af as number) || 0;
        const speed = (data.ag as number) || 2500; // default 250uL/s
        const aspMs = vol > 0 ? Math.round((vol / speed) * 1000) : 200;
        const settleMs = ((data.wh as number) || 0) * 100;
        breakdown.push({ phase: "Z descend", ms: 300, detail: "to liquid" });
        breakdown.push({ phase: "aspirate", ms: aspMs, detail: `${vol / 10}uL at ${speed / 10}uL/s` });
        if (settleMs > 0) breakdown.push({ phase: "settle", ms: settleMs });
        breakdown.push({ phase: "Z retract", ms: 300 });
        const total = 300 + aspMs + settleMs + 300;
        return { totalMs: total, accuracy: vol > 0 ? "hybrid" : "estimate", breakdown };
      }

      case "C0ED": {
        // 96-head dispense: compute from volume
        const vol = (data.df as number) || 0;
        const speed = (data.dg as number) || 2500; // default 250uL/s
        const dspMs = vol > 0 ? Math.round((vol / speed) * 1000) : 200;
        breakdown.push({ phase: "Z descend", ms: 250, detail: "to dispense height" });
        breakdown.push({ phase: "dispense", ms: dspMs, detail: `${vol / 10}uL at ${speed / 10}uL/s` });
        breakdown.push({ phase: "blowout", ms: 150 });
        breakdown.push({ phase: "Z retract", ms: 250 });
        const total = 250 + dspMs + 150 + 250;
        return { totalMs: total, accuracy: vol > 0 ? "hybrid" : "estimate", breakdown };
      }

      default:
        return undefined;
    }
  }
}
