/**
 * Temperature Controller Physics Plugin
 *
 * Simulates heating/cooling ramp with a simple thermal model.
 * The delay for reaching temperature depends on the delta from
 * current to target and the heating/cooling rate.
 *
 * Real TCC specs:
 * - Heating rate: ~2-3 C/min (depending on carrier mass)
 * - Cooling rate: ~1-2 C/min (passive, or active with Peltier)
 * - Range: ambient to 70C (0-700 in 0.1C FW units)
 * - Accuracy: +/- 1C
 */

import { PhysicsPlugin, PhysicsValidation, CommandTiming } from "../plugin-interface";
import { AssessmentEvent } from "../assessment";

/** Heating rate in 0.1C per second — real Hamilton TCC: ~2-3 C/min */
const HEATING_RATE = 0.5;    // 0.05 C/s ≈ 3 C/min (matches real TCC spec)

/** Cooling rate in 0.1C per second — passive cooling: ~1-2 C/min */
const COOLING_RATE = 0.2;    // 0.02 C/s ≈ 1.2 C/min (passive, no Peltier)

/** Minimum delay even for small temperature changes */
const MIN_DELAY_MS = 1000;

export class TemperaturePhysicsPlugin implements PhysicsPlugin {
  readonly id = "temp-physics";
  private executor: any = null;

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
  }

  /**
   * Physics validation: overtemperature protection.
   * The TCC hardware limits temperature to 105C (1050 in 0.1C units).
   */
  validateCommand(event: string, data: Record<string, unknown>, _deckTracker: any): PhysicsValidation | undefined {
    if (event === "C0HC") {
      const target = (data.hc as number) ?? 0;
      if (target > 1050) {
        return { valid: false, errorCode: 19, errorDescription: `Temperature ${(target / 10).toFixed(1)}C exceeds maximum 105.0C — overtemp protection` };
      }
    }
    return undefined;
  }

  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    const dm = this.executor?.machine?._datamodel;
    if (!dm) return data;

    switch (event) {
      case "C0HI": {
        // Set temperature (immediate response, heating in background)
        const current = dm.current_temp_01c || 220;  // Room temp default
        const target = (data.hi as number) ?? current;
        const delta = Math.abs(target - current);
        const rate = target > current ? HEATING_RATE : COOLING_RATE;
        const timeMs = Math.max(MIN_DELAY_MS, Math.round((delta / rate) * 1000));
        return { ...data, _delay: timeMs + "ms", _tempDelta: delta, _heatTime: timeMs };
      }

      case "C0HC": {
        // Set temperature (wait until reached)
        const current = dm.current_temp_01c || 220;
        const target = (data.hc as number) ?? current;
        const delta = Math.abs(target - current);
        const rate = target > current ? HEATING_RATE : COOLING_RATE;
        const timeMs = Math.max(MIN_DELAY_MS, Math.round((delta / rate) * 1000));
        return { ...data, _delay: timeMs + "ms", _tempDelta: delta, _heatTime: timeMs };
      }

      default:
        return data;
    }
  }

  assess(event: string, data: Record<string, unknown>, _deckTracker: any): AssessmentEvent[] {
    const events: AssessmentEvent[] = [];
    const dm = this.executor?.machine?._datamodel;

    if (event === "C0HC" || event === "C0HI") {
      const target = (data.hc as number) ?? (data.hi as number) ?? 0;
      const current = dm?.current_temp_01c ?? 220;
      const delta = Math.abs(target - current);

      // Large temperature jumps are noteworthy
      if (delta > 200) {  // >20C jump
        events.push({
          id: 0, timestamp: 0,  // filled by store
          category: "temperature",
          severity: target > 700 ? "warning" : "info",
          module: "temp",
          command: event,
          description: `Temperature change: ${(current / 10).toFixed(1)}C → ${(target / 10).toFixed(1)}C (Δ${(delta / 10).toFixed(1)}C)`,
          data: { current, target, delta },
        });
      }
    }

    return events;
  }

  estimateTime(event: string, data: Record<string, unknown>): CommandTiming | undefined {
    const breakdown: Array<{ phase: string; ms: number; detail?: string }> = [];

    switch (event) {
      case "C0HC": {
        // Set temperature AND wait until reached — compute full ramp time
        const dm = this.executor?.machine?._datamodel;
        const current = dm?.current_temp_01c ?? 220;
        const target = (data.hc as number) ?? current;
        const delta = Math.abs(target - current);
        const rate = target > current ? HEATING_RATE : COOLING_RATE;
        const rampMs = Math.max(MIN_DELAY_MS, Math.round((delta / rate) * 1000));
        breakdown.push({ phase: "temperature ramp", ms: rampMs, detail: `${(current / 10).toFixed(1)}→${(target / 10).toFixed(1)}C at ${(rate * 600).toFixed(0)} C/min` });
        return { totalMs: rampMs, accuracy: "computed", breakdown };
      }

      case "C0HI": {
        // Set temperature (async, FW returns immediately but heating starts)
        breakdown.push({ phase: "command accept", ms: 500, detail: "controller acknowledges, heating async" });
        return { totalMs: 500, accuracy: "estimate", breakdown };
      }

      case "C0HF": {
        // Temperature off
        breakdown.push({ phase: "heater disable", ms: 200, detail: "controller off" });
        return { totalMs: 200, accuracy: "estimate", breakdown };
      }

      default:
        return undefined;
    }
  }
}
