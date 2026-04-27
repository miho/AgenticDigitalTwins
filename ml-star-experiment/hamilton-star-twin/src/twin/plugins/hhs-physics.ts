/**
 * Heater/Shaker (HHS) Physics Plugin
 *
 * Simulates temperature ramping and shaking dynamics.
 * TCC: ambient-22C to 60C. HHS: up to 105C with orbital shaking.
 */

import { PhysicsPlugin, PhysicsValidation, TransitionInfo, StateEntryInfo, CommandTiming } from "../plugin-interface";
import { AssessmentEvent } from "../assessment";

/** Temperature ramp rate in 0.1C per second — real Hamilton HHS: ~2-3 C/min heating */
const HEATING_RATE = 0.5;    // 0.05 C/s ≈ 3 C/min (matches real HHS spec)
const COOLING_RATE = 0.2;    // 0.02 C/s ≈ 1.2 C/min (passive cooling)

/** Max temperature in 0.1C */
const MAX_TEMP = 1050;     // 105C
const MIN_TEMP = -100;     // -10C (with Peltier cooling)

export class HHSPhysicsPlugin implements PhysicsPlugin {
  readonly id = "hhs-physics";

  private executor: any = null;
  private moduleId: string = "";

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
    this.moduleId = moduleId;
  }

  validateCommand(event: string, data: Record<string, unknown>, _deckTracker: any): PhysicsValidation | undefined {
    switch (event) {
      case "T1TA":
      case "T1TW": {
        const temp = (data.ta as number) ?? 0;
        // Error code 19 = "Incubation error (temperature out of limit)"
        // per hamilton-star-digital-twin.json. Using 99 here would mask the
        // specific temperature-out-of-range signal.
        if (temp > MAX_TEMP) {
          return { valid: false, errorCode: 19, errorDescription: `Temperature ${temp / 10}C exceeds max ${MAX_TEMP / 10}C` };
        }
        if (temp < MIN_TEMP) {
          return { valid: false, errorCode: 19, errorDescription: `Temperature ${temp / 10}C below min ${MIN_TEMP / 10}C` };
        }
        return undefined;
      }
    }
    return undefined;
  }

  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    const dm = this.getDatamodel();

    switch (event) {
      case "T1SI":
        return { ...data, _delay: "1000ms" };

      case "T1TA": {
        // Set temperature: calculate ramp time
        const target = (data.ta as number) ?? 0;
        const current = dm?.current_temp_01c ?? 250;
        const delta = Math.abs(target - current);
        const rate = target > current ? HEATING_RATE : COOLING_RATE;
        const rampTime = Math.round((delta / rate) * 1000);
        return { ...data, _delay: Math.max(200, rampTime) + "ms", _rampTime: rampTime };
      }

      case "T1TW": {
        // Wait for temperature: same ramp calculation
        const target = (data.ta as number) ?? dm?.target_temp_01c ?? 0;
        const current = dm?.current_temp_01c ?? 250;
        const delta = Math.abs(target - current);
        const rate = target > current ? HEATING_RATE : COOLING_RATE;
        const rampTime = Math.round((delta / rate) * 1000);
        return { ...data, _delay: Math.max(200, rampTime) + "ms", _rampTime: rampTime };
      }

      case "T1SA":
        return { ...data, _delay: "500ms" };  // Shaker spin-up

      case "T1SS":
        return { ...data, _delay: "300ms" };  // Shaker spin-down

      case "T1LA":
      case "T1LP":
      case "T1LO":
        return { ...data, _delay: "200ms" };  // Lock actuation

      default:
        return data;
    }
  }

  calculateDelay(operation: string, params: Record<string, unknown>): number | undefined {
    switch (operation) {
      case "heat": {
        const delta = (params.delta as number) || 0;
        const rate = delta > 0 ? HEATING_RATE : COOLING_RATE;
        return Math.round((Math.abs(delta) / rate) * 1000);
      }
      default: return undefined;
    }
  }

  assess(event: string, data: Record<string, unknown>, _deckTracker: any): AssessmentEvent[] {
    const events: AssessmentEvent[] = [];
    const dm = this.getDatamodel();

    if (event === "T1TA" || event === "T1TW") {
      const target = (data.ta as number) ?? 0;
      const current = dm?.current_temp_01c ?? 250;
      const delta = Math.abs(target - current);

      if (delta > 200) {
        events.push({
          id: 0, timestamp: 0,
          category: "temperature",
          severity: target > 700 ? "warning" : "info",
          module: "hhs",
          command: event,
          description: `HHS temperature: ${(current / 10).toFixed(1)}C → ${(target / 10).toFixed(1)}C (Δ${(delta / 10).toFixed(1)}C)`,
          data: { current, target, delta },
        });
      }
    }

    return events;
  }

  estimateTime(event: string, data: Record<string, unknown>): CommandTiming | undefined {
    const breakdown: Array<{ phase: string; ms: number; detail?: string }> = [];

    switch (event) {
      case "T1SA": {
        // Start shake: motor spin-up
        breakdown.push({ phase: "spin-up", ms: 500, detail: "orbital shaker ramp" });
        return { totalMs: 500, accuracy: "estimate", breakdown };
      }

      case "T1SS": {
        // Stop shake: motor spin-down
        breakdown.push({ phase: "spin-down", ms: 300, detail: "orbital shaker brake" });
        return { totalMs: 300, accuracy: "estimate", breakdown };
      }

      case "T1TA": {
        // Set temperature: command accepted, heating is async
        breakdown.push({ phase: "command accept", ms: 500, detail: "controller acknowledges, heating async" });
        return { totalMs: 500, accuracy: "estimate", breakdown };
      }

      default:
        return undefined;
    }
  }

  private getDatamodel(): Record<string, any> | null {
    return this.executor?.machine?._datamodel || null;
  }
}
