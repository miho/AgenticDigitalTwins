/**
 * Wash Station Physics Plugin
 *
 * Simulates wash fluid depletion, cycle timing, and pressure dynamics.
 * The real Hamilton STAR wash station has 2 chambers with separate fluid
 * supply. Each wash cycle consumes ~5mL of fluid per channel.
 */

import { PhysicsPlugin, PhysicsValidation, TransitionInfo, StateEntryInfo, CommandTiming } from "../plugin-interface";
import { AssessmentEvent } from "../assessment";

/** Fluid volume per chamber in uL */
const CHAMBER_CAPACITY = 200_000;  // 200 mL
/** Fluid consumed per wash cycle (8 channels) in uL */
const FLUID_PER_CYCLE = 40_000;    // 40 mL (5mL per channel × 8)
/** Base wash time in ms */
const BASE_WASH_TIME = 3500;
/** Extra time per additional cycle */
const CYCLE_OVERHEAD = 800;

export class WashPhysicsPlugin implements PhysicsPlugin {
  readonly id = "wash-physics";

  private executor: any = null;
  private moduleId: string = "";
  /** Fluid level per chamber (uL). Index 0 = chamber 1, index 1 = chamber 2 */
  fluidLevel: number[] = [CHAMBER_CAPACITY, CHAMBER_CAPACITY];

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
    this.moduleId = moduleId;
  }

  validateCommand(event: string, data: Record<string, unknown>, _deckTracker: any): PhysicsValidation | undefined {
    if (event === "C0WS" || event === "C0WC" || event === "C0WR") {
      const chamber = ((data.ws as number) || 1) - 1;
      const idx = Math.max(0, Math.min(1, chamber));
      if (this.fluidLevel[idx] < FLUID_PER_CYCLE) {
        return {
          valid: false,
          errorCode: 18,
          errorDescription: `Wash fluid low in chamber ${idx + 1}: ${(this.fluidLevel[idx] / 1000).toFixed(0)}mL remaining`,
        };
      }
    }
    return undefined;
  }

  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    switch (event) {
      case "C0WI":
        // Reset fluid levels on init
        this.fluidLevel = [CHAMBER_CAPACITY, CHAMBER_CAPACITY];
        return { ...data, _delay: "500ms" };

      case "C0WS":
      case "C0WC": {
        // Standard/CR wash — consume fluid, calculate timing
        const chamber = ((data.ws as number) || 1) - 1;
        const idx = Math.max(0, Math.min(1, chamber));
        this.fluidLevel[idx] = Math.max(0, this.fluidLevel[idx] - FLUID_PER_CYCLE);
        return { ...data, _delay: BASE_WASH_TIME + "ms", _fluid_1: this.fluidLevel[0], _fluid_2: this.fluidLevel[1] };
      }

      case "C0WR": {
        // Repeat wash — same fluid consumption, slightly faster
        const chamber = ((data.ws as number) || 1) - 1;
        const idx = Math.max(0, Math.min(1, chamber));
        this.fluidLevel[idx] = Math.max(0, this.fluidLevel[idx] - FLUID_PER_CYCLE);
        return { ...data, _delay: (BASE_WASH_TIME - CYCLE_OVERHEAD) + "ms", _fluid_1: this.fluidLevel[0], _fluid_2: this.fluidLevel[1] };
      }

      case "C0WW":
        // Wait for wash completion
        return { ...data, _delay: "500ms" };

      default:
        return data;
    }
  }

  assess(event: string, data: Record<string, unknown>, _deckTracker: any): AssessmentEvent[] {
    const events: AssessmentEvent[] = [];

    if (event === "C0WS" || event === "C0WC" || event === "C0WR") {
      const chamber = ((data.ws as number) || 1) - 1;
      const idx = Math.max(0, Math.min(1, chamber));
      const remaining = this.fluidLevel[idx];
      const cyclesLeft = Math.floor(remaining / FLUID_PER_CYCLE);

      if (cyclesLeft <= 2) {
        events.push({
          id: 0, timestamp: 0,
          category: "wash_fluid",
          severity: cyclesLeft === 0 ? "error" : "warning",
          module: "wash",
          command: event,
          description: `Wash chamber ${idx + 1}: ${(remaining / 1000).toFixed(0)}mL remaining (~${cyclesLeft} cycles left)`,
          data: { chamber: idx + 1, remainingMl: remaining / 1000, cyclesLeft },
        });
      } else {
        events.push({
          id: 0, timestamp: 0,
          category: "wash_fluid",
          severity: "info",
          module: "wash",
          command: event,
          description: `Wash cycle on chamber ${idx + 1}: ${(remaining / 1000).toFixed(0)}mL remaining`,
          data: { chamber: idx + 1, remainingMl: remaining / 1000, cyclesLeft },
        });
      }
    }

    return events;
  }

  /** Get current fluid level for a chamber (for rendering) */
  getFluidLevel(chamber: number): number {
    return this.fluidLevel[Math.max(0, Math.min(1, chamber))] || 0;
  }

  /** Get fluid level as fraction 0-1 */
  getFluidFraction(chamber: number): number {
    return this.getFluidLevel(chamber) / CHAMBER_CAPACITY;
  }

  estimateTime(event: string, data: Record<string, unknown>): CommandTiming | undefined {
    const breakdown: Array<{ phase: string; ms: number; detail?: string }> = [];

    switch (event) {
      case "C0WS": {
        // Wash start: ~3s per cycle
        breakdown.push({ phase: "wash cycle", ms: 2500, detail: "fluid fill + drain" });
        breakdown.push({ phase: "settle", ms: 500, detail: "fluid drain complete" });
        return { totalMs: 3000, accuracy: "estimate", breakdown };
      }

      case "C0WI": {
        // Wash init
        breakdown.push({ phase: "initialize", ms: 500, detail: "prime fluid lines" });
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
