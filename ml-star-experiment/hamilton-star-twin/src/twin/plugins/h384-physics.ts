/**
 * CO-RE 384 Head Physics Plugin
 *
 * Physics simulation for the 384 multi-probe head.
 * Similar to the 96-head but with 384 channels in a 16x24 grid.
 * Volume range: 0.1uL–50uL.
 */

import { PhysicsPlugin, PhysicsValidation, TransitionInfo, StateEntryInfo, CommandTiming } from "../plugin-interface";
import { AssessmentEvent } from "../assessment";
import { generateAspirateCurve, generateDispenseCurve } from "../tadm";

const ASP_SPEED_384 = 1500;    // 150 ul/s (slower for small volumes)
const DSP_SPEED_384 = 2000;    // 200 ul/s
const TIP_PICKUP_TIME_MS = 1200;  // Slower — 384 tips at once
const TIP_EJECT_TIME_MS = 800;
const MOVE_TIME_MS = 500;

export class CoRe384HeadPhysicsPlugin implements PhysicsPlugin {
  readonly id = "h384-physics";

  private executor: any = null;
  private lastTADM: import("../tadm").TADMResult | null = null;
  private lastEventData: Record<string, unknown> = {};
  private moduleId: string = "";

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
    this.moduleId = moduleId;
  }

  validateCommand(event: string, data: Record<string, unknown>, deckTracker: any): PhysicsValidation | undefined {
    switch (event) {
      case "C0JA": {
        // Aspirate: check volume within 384-head range (0.1uL–50uL = 1–500 in 0.1uL)
        const vol = (data.af as number) ?? 0;
        if (vol > 500) {
          return { valid: false, errorCode: 5, errorDescription: `384-head max volume 50uL, requested ${vol / 10}uL` };
        }
        return undefined;
      }
    }
    return undefined;
  }

  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    this.lastEventData = data;
    switch (event) {
      case "C0JI":
        return { ...data, _delay: "2000ms" };
      case "C0JB":
        return { ...data, _delay: TIP_PICKUP_TIME_MS + "ms" };
      case "C0JC":
        return { ...data, _delay: TIP_EJECT_TIME_MS + "ms" };
      case "C0JA": {
        const vol = (data.af as number) || 0;
        const time = Math.max(100, Math.round((vol / ASP_SPEED_384) * 1000));
        return { ...data, _delay: (time + 200) + "ms" };
      }
      case "C0JD": {
        const vol = (data.df as number) || 0;
        const time = Math.max(100, Math.round((vol / DSP_SPEED_384) * 1000));
        return { ...data, _delay: (time + 200) + "ms" };
      }
      case "C0EN":
        return { ...data, _delay: MOVE_TIME_MS + "ms" };
      case "C0JG":
        return { ...data, _delay: "3000ms" };
      default:
        return data;
    }
  }

  calculateDelay(operation: string, params: Record<string, unknown>): number | undefined {
    switch (operation) {
      case "move": return MOVE_TIME_MS;
      case "wash": return 3000;
      default: return undefined;
    }
  }

  onAfterTransition(info: TransitionInfo): void {
    const event = info.event;
    const data = this.lastEventData;

    // Generate TADM curves (384-head has smaller volumes → higher relative pressure)
    if (event === "C0JA") {
      const vol = (data.af as number) ?? 0;
      const speed = (data.ag as number) ?? ASP_SPEED_384;
      this.lastTADM = generateAspirateCurve(vol, speed, 1.0);
    } else if (event === "C0JD") {
      const vol = (data.df as number) ?? 0;
      const speed = (data.dg as number) ?? DSP_SPEED_384;
      const dm = (data.da as number) ?? 0;
      this.lastTADM = generateDispenseCurve(vol, speed, dm, 1.0);
    }
  }

  assess(event: string, data: Record<string, unknown>, deckTracker: any): AssessmentEvent[] {
    const events: AssessmentEvent[] = [];

    if (event === "C0JA" || event === "C0JD") {
      const vol = (data.af as number) ?? (data.df as number) ?? 0;
      const operation = event === "C0JA" ? "aspirate" : "dispense";

      events.push({
        id: 0, timestamp: 0,
        category: "tadm",
        severity: "info",
        module: "h384",
        command: event,
        description: `TADM 384-head ${operation} passed — peak ${this.lastTADM?.peakPressure ?? 0} mbar, ${vol / 10}uL`,
        tadm: this.lastTADM ?? undefined,
      });
    }

    if (event === "C0JA") {
      const x = (data.xp as number) ?? (data.xs as number) ?? 0;
      const y = (data.yp as number) ?? (data.yj as number) ?? 0;
      const aspVol = (data.af as number) ?? 0;
      const res = deckTracker.resolvePosition?.(x, y);
      if (res?.matched && aspVol > 0) {
        let underflowed = 0;
        let maxDeficit = 0;
        let firstWellIdx = -1;
        for (let i = 0; i < 384; i++) {
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
            module: "h384",
            command: event,
            description: `384-head underflow: ${underflowed} well(s) at ${res.description} had < ${aspVol / 10}uL — max deficit ${maxDeficit / 10}uL`,
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
      case "C0EN": {
        // 384-head X+Y move (heavier assembly, slightly slower than 96)
        breakdown.push({ phase: "X+Y travel", ms: 1000, detail: "parallel axis move (384 assembly)" });
        breakdown.push({ phase: "settle", ms: 150, detail: "heavier head" });
        return { totalMs: 1150, accuracy: "estimate", breakdown };
      }

      case "C0JB": {
        // 384-tip pickup: Z down + grip + Z up (heavier than 96)
        breakdown.push({ phase: "Z descend", ms: 450, detail: "to tip rack" });
        breakdown.push({ phase: "384-grip", ms: 600, detail: "CO-RE compression x384" });
        breakdown.push({ phase: "Z retract", ms: 450 });
        return { totalMs: 1500, accuracy: "estimate", breakdown };
      }

      case "C0JC": {
        // 384-tip eject
        breakdown.push({ phase: "Z descend", ms: 300, detail: "to eject height" });
        breakdown.push({ phase: "tip release", ms: 350, detail: "384 channels" });
        breakdown.push({ phase: "Z retract", ms: 300 });
        return { totalMs: 950, accuracy: "estimate", breakdown };
      }

      case "C0JA": {
        // 384-head aspirate: compute from volume (smaller volumes, slower default)
        const vol = (data.af as number) || 0;
        const speed = (data.ag as number) || ASP_SPEED_384;
        const aspMs = vol > 0 ? Math.round((vol / speed) * 1000) : 200;
        breakdown.push({ phase: "Z descend", ms: 350, detail: "to liquid" });
        breakdown.push({ phase: "aspirate", ms: aspMs, detail: `${vol / 10}uL at ${speed / 10}uL/s` });
        breakdown.push({ phase: "Z retract", ms: 350 });
        const total = 350 + aspMs + 350;
        return { totalMs: total, accuracy: vol > 0 ? "hybrid" : "estimate", breakdown };
      }

      case "C0JD": {
        // 384-head dispense: compute from volume
        const vol = (data.df as number) || 0;
        const speed = (data.dg as number) || DSP_SPEED_384;
        const dspMs = vol > 0 ? Math.round((vol / speed) * 1000) : 200;
        breakdown.push({ phase: "Z descend", ms: 300, detail: "to dispense height" });
        breakdown.push({ phase: "dispense", ms: dspMs, detail: `${vol / 10}uL at ${speed / 10}uL/s` });
        breakdown.push({ phase: "blowout", ms: 150 });
        breakdown.push({ phase: "Z retract", ms: 300 });
        const total = 300 + dspMs + 150 + 300;
        return { totalMs: total, accuracy: vol > 0 ? "hybrid" : "estimate", breakdown };
      }

      default:
        return undefined;
    }
  }
}
