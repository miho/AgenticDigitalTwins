/**
 * Assessment Engine
 *
 * Observes all accepted commands and records their physical consequences.
 * Assessment NEVER rejects commands — that is the FW mirror layer's job
 * (validateCommand in physics plugins). This layer only observes and reports.
 *
 * Assessment events cover:
 *   - TADM pressure curve observations (pass/fail, peak pressure)
 *   - LLD detection results (liquid found, crash risk)
 *   - Cross-contamination (different liquid without tip change)
 *   - Empty aspiration (aspirating from empty/near-empty well)
 *   - Well overflow (dispensed volume exceeds well capacity)
 *   - Dead volume warning (aspirating below dead volume)
 *   - Tip crash risk (tip approaching well bottom)
 *   - Temperature excursion (target vs actual deviation)
 *   - Tip reuse (reusing a contaminated tip)
 */

import { TADMResult } from "./tadm";
import { LLDResult } from "./well-geometry";
import { ContaminationEvent } from "./liquid-tracker";

// ============================================================================
// Types
// ============================================================================

export type AssessmentSeverity = "info" | "warning" | "error";

export type AssessmentCategory =
  | "tadm"                 // TADM pressure curve observation
  | "lld"                  // LLD detection result
  | "contamination"        // Cross-contamination detected
  | "empty_aspiration"     // Aspirating from empty/near-empty well
  | "volume_underflow"     // Aspirated more than the well held (well volume went negative)
  | "air_in_dispense"      // Tip dispensed trailing air into destination (prior aspirate was partial)
  | "missing_diluent"      // Serial-dilution destination column had no diluent before transfer (dilution factor will be wrong)
  | "well_overflow"        // Dispense would exceed well capacity
  | "dead_volume"          // Aspirating below dead volume
  | "tip_crash"            // Tip crash risk detected
  | "temperature"          // Temperature excursion
  | "tip_reuse"            // Tip reused without wash
  | "wash_fluid"           // Wash station fluid level
  | "transport"            // Plate transport observation
  | "unresolved_position"  // FW command targeted coordinates with no deck match (#34)
  | "no_deck_effect"       // Accepted C0AS/C0DS produced no wellVolumes change (zero volume OR xp/yp unresolved) — surfaces the "arm moved, volumes didn't change, no hint why" bug
  | "collision"            // Arm-vs-carrier or multi-arm collision risk (Phase 4.B)
  | "foam"                 // Dispense speed high vs liquid class → foam risk (Phase 4.C)
  | "drip"                 // Aspirate without trailing transport air → drip risk (Phase 4.C)
  | "meniscus"             // Submerge depth vs liquid class default mismatch (Phase 4.C)
  | "liquid_follow"        // Liquid-following quality during aspirate (Phase 4.C)
  | "air_gap_disorder"     // Channel layer stack inverted (blowout misfire risk) (Phase 4.C)
  | "clot";                // TADM clot perturbation detected (Phase 4.C)

export interface AssessmentEvent {
  /** Unique sequential ID */
  id: number;
  /** When this observation was made */
  timestamp: number;
  /** What kind of observation */
  category: AssessmentCategory;
  /** How serious is this */
  severity: AssessmentSeverity;
  /** Which hardware module generated this */
  module: string;
  /** The FW event code that triggered this (e.g. "C0AS", "C0DS") */
  command: string;
  /** PIP channel index (0-15), if applicable */
  channel?: number;
  /** Human-readable summary */
  description: string;
  /** Category-specific payload */
  data?: Record<string, unknown>;
  /** TADM curve data (when category === "tadm") */
  tadm?: TADMResult;
  /** LLD detection result (when category === "lld") */
  lld?: LLDResult;
  /** Contamination event (when category === "contamination") */
  contamination?: ContaminationEvent;
  /** ID of the command that produced this event (Step 1.9). */
  correlationId?: number;
  /** ID of the composite step that contains the command (Step 1.9). */
  stepId?: number;
}

// ============================================================================
// Assessment Store
// ============================================================================

export type AssessmentListener = (event: AssessmentEvent) => void;

/**
 * Stores assessment events and notifies listeners.
 * One instance per DigitalTwin.
 */
export class AssessmentStore {
  private events: AssessmentEvent[] = [];
  private nextId = 1;
  private listeners: AssessmentListener[] = [];
  private maxEvents = 1000;

  /** Add an assessment event (id and timestamp are auto-assigned) */
  add(partial: Omit<AssessmentEvent, "id" | "timestamp">): AssessmentEvent {
    const event: AssessmentEvent = {
      ...partial,
      id: this.nextId++,
      timestamp: Date.now(),
    };

    this.events.push(event);

    // Cap stored events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    for (const listener of this.listeners) {
      try { listener(event); } catch { /* don't break the twin */ }
    }

    return event;
  }

  /** Get recent events (newest last) */
  getRecent(count: number = 50): AssessmentEvent[] {
    return this.events.slice(-count);
  }

  /** Get events filtered by category */
  getByCategory(category: AssessmentCategory): AssessmentEvent[] {
    return this.events.filter((e) => e.category === category);
  }

  /** Get events filtered by channel */
  getByChannel(channel: number): AssessmentEvent[] {
    return this.events.filter((e) => e.channel === channel);
  }

  /** Get all events */
  getAll(): AssessmentEvent[] {
    return [...this.events];
  }

  /** Register a listener for new assessment events */
  onAssessment(listener: AssessmentListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Clear all events */
  clear(): void {
    this.events = [];
    this.nextId = 1;
  }
}
