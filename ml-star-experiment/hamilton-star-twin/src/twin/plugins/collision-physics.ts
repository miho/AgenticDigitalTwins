/**
 * Collision-physics global plugin (Phase 4 Step 4.B, #35)
 *
 * Registered as a GLOBAL plugin (see DigitalTwin.registerGlobalPlugin).
 * The plugin sees every accepted command regardless of target module and
 * emits `AssessmentCategory: "collision"` events when a movement would
 * bring an arm into conflict with:
 *
 *   1. A tall carrier's Z envelope — the arm's descent target is lower
 *      than the carrier's top at the commanded X.
 *   2. Another arm on the shared X-rail — PIP and 96-Head mutual
 *      exclusion zone. The two arms cannot physically pass each other
 *      closer than an enforced safety gap.
 *   3. The iSWAP transport sweep — during a gripper traverse the swept
 *      bounding box overlaps a PIP or 96-Head arm position.
 *
 * Design notes
 * ------------
 *   - The plugin only OBSERVES. It never rejects commands (in line with
 *     the assessment contract — rejection is the FW mirror's job). A
 *     real collision would typically be caught by `validateCommand` in
 *     a per-module plugin first; this global pass exists to surface
 *     *risk patterns* — the kind a human reviewer would want to see.
 *   - Arm state is tracked internally. Only movement commands update it.
 *     The list is deliberately narrow: C0TP/C0AS/C0DS/C0RO for PIP,
 *     I1PI/I1EI for 96-Head, I5xx for iSWAP. Extend as the command set
 *     grows.
 *   - Carrier Z envelopes are derived from the Deck snapshot each
 *     command, so operators changing the deck mid-run don't desync the
 *     plugin.
 */

import type { PhysicsPlugin } from "../plugin-interface";
import type { AssessmentEvent } from "../assessment";
import type { DeckTracker } from "../deck-tracker";

// ============================================================================
// Constants
// ============================================================================

/** Minimum X separation between PIP and 96-Head before we flag overlap. (0.1mm) */
const ARM_MIN_X_GAP = 500; // 50 mm — conservative mutual-exclusion zone

/** Z distance below traverse at which we consider the arm "committed" below carrier tops. */
const Z_COMMIT_BELOW_TRAVERSE = 200; // 20 mm

/** Traverse Z height (0.1 mm) above which an arm is considered safely clear of carriers. */
const Z_TRAVERSE_DEFAULT = 2450;

/** Default top-of-carrier Z for labware considered "tall" enough to matter. (0.1 mm) */
const TALL_CARRIER_Z_DEFAULT = 1400; // 140 mm — e.g. reagent troughs, tip racks

/**
 * Carrier IDs (prefixes) we treat as tall by default. Matches what the
 * built-in deck layout produces — a project-specific layout can extend
 * via `CollisionPhysics.addTallCarrier()`.
 */
const DEFAULT_TALL_PREFIXES = ["TIP", "TRG"]; // tip racks, reagent troughs

// ============================================================================
// Types
// ============================================================================

export type ArmId = "pip" | "head96" | "iswap";

export interface ArmPose {
  /** 0.1 mm on the global deck frame. */
  x: number;
  /** 0.1 mm on the global deck frame. */
  y: number;
  /** 0.1 mm below traverse; 0 means at traverse. */
  zBelowTraverse: number;
}

export interface TallCarrier {
  carrierId: string;
  xMin: number;
  xMax: number;
  /** Z height of the carrier's top surface (0.1 mm, below traverse). */
  zTop: number;
}

// ============================================================================
// Plugin
// ============================================================================

export class CollisionPhysics implements PhysicsPlugin {
  readonly id = "collision";

  private arms: Record<ArmId, ArmPose> = {
    pip:    { x: 0, y: 0, zBelowTraverse: 0 },
    head96: { x: 0, y: 0, zBelowTraverse: 0 },
    iswap:  { x: 0, y: 0, zBelowTraverse: 0 },
  };

  /**
   * Carriers whose height makes them a collision risk when an arm
   * descends above them. Seeded from the deck snapshot on first
   * assess(), refreshed each call so manual additions persist.
   */
  private tallCarriers: TallCarrier[] = [];

  /** Operator-added extras (e.g. a custom-height reagent carrier). */
  addTallCarrier(c: TallCarrier): void {
    this.tallCarriers.push(c);
  }

  /** Current internal pose — exposed for tests and for the UI inspector. */
  getArmState(): Record<ArmId, ArmPose> {
    return {
      pip:    { ...this.arms.pip },
      head96: { ...this.arms.head96 },
      iswap:  { ...this.arms.iswap },
    };
  }

  getPluginState(): Record<string, unknown> {
    return {
      arms: this.arms,
      tallCarriers: this.tallCarriers,
    };
  }

  restorePluginState(state: Record<string, unknown>): void {
    if (state.arms) this.arms = state.arms as Record<ArmId, ArmPose>;
    if (Array.isArray(state.tallCarriers)) this.tallCarriers = state.tallCarriers as TallCarrier[];
  }

  assess(event: string, data: Record<string, unknown>, deckTracker: DeckTracker): AssessmentEvent[] {
    // Refresh the tall-carrier catalogue from the deck on every call —
    // cheap, and keeps the plugin in sync with runtime deck edits.
    this.refreshTallCarriers(deckTracker);

    const arm = this.armForEvent(event);
    if (!arm) return [];

    const prev = { ...this.arms[arm] };
    const next = this.updatePose(arm, event, data);
    if (!next) return [];

    const out: AssessmentEvent[] = [];

    // 1. Z envelope check vs tall carriers.
    const zAssessment = this.checkZEnvelope(arm, next, event);
    if (zAssessment) out.push(zAssessment);

    // 2. Multi-arm mutual exclusion (PIP vs 96-Head).
    if (arm === "pip" || arm === "head96") {
      const other: ArmId = arm === "pip" ? "head96" : "pip";
      const overlap = this.checkArmOverlap(arm, next, other, this.arms[other], event);
      if (overlap) out.push(overlap);
    }

    // 3. iSWAP transport sweep — check bounding box against other arms.
    if (arm === "iswap") {
      const sweep = this.checkIswapSweep(prev, next, event);
      out.push(...sweep);
    }

    return out;
  }

  // --- internals --------------------------------------------------------

  private armForEvent(event: string): ArmId | null {
    // PIP commands: tip pickup/eject, aspirate/dispense, single move.
    if (event === "C0TP" || event === "C0TR" || event === "C0AS" || event === "C0DS" || event === "C0JM") return "pip";
    // 96-Head commands (HSL naming in the firmware).
    if (event === "I1PI" || event === "I1EI" || event === "I1AS" || event === "I1DS") return "head96";
    // iSWAP (plate gripper) commands — movement / place / pickup.
    if (event === "I5MV" || event === "I5PL" || event === "I5PU" || event === "I5RT") return "iswap";
    return null;
  }

  private updatePose(arm: ArmId, event: string, data: Record<string, unknown>): ArmPose | null {
    const xp = toNum(data.xp ?? data.xs);
    const yp = toNum(data.yp ?? data.ys);
    const zp = toNum(data.zp ?? data.zs ?? data.zx);
    const pose = this.arms[arm];
    if (xp !== null) pose.x = xp;
    if (yp !== null) pose.y = yp;

    // Descent events imply the arm drops below traverse for the duration
    // of the operation. Aspirate/dispense imply the largest excursion.
    if (event === "C0AS" || event === "C0DS" || event === "I1AS" || event === "I1DS") {
      pose.zBelowTraverse = zp ?? Z_COMMIT_BELOW_TRAVERSE;
    } else if (event === "C0TP" || event === "I1PI") {
      pose.zBelowTraverse = zp ?? Z_COMMIT_BELOW_TRAVERSE;
    } else if (event === "C0TR" || event === "I1EI") {
      // eject returns to traverse
      pose.zBelowTraverse = 0;
    } else if (event === "C0JM" || event === "I5MV" || event === "I5RT") {
      // straight X/Y move — assume at traverse unless the command specifies Z
      pose.zBelowTraverse = zp ?? 0;
    } else if (event === "I5PL" || event === "I5PU") {
      pose.zBelowTraverse = zp ?? Z_COMMIT_BELOW_TRAVERSE;
    }
    return pose;
  }

  private checkZEnvelope(arm: ArmId, next: ArmPose, event: string): AssessmentEvent | null {
    if (next.zBelowTraverse <= 0) return null;
    // "Arm Z at the floor" = zTraverse - zBelowTraverse in the deck's frame;
    // we compare to the carrier's top (below traverse) directly.
    for (const c of this.tallCarriers) {
      if (next.x < c.xMin || next.x > c.xMax) continue;
      // The arm is above this carrier and committed below traverse.
      // If its committed depth reaches or exceeds the carrier's top we
      // flag — the carrier obstructs the arm's travel path.
      if (next.zBelowTraverse >= c.zTop) {
        return buildCollisionEvent({
          severity: "error",
          module: arm,
          command: event,
          description: `arm ${arm} descending to z=${next.zBelowTraverse} above carrier ${c.carrierId} (zTop=${c.zTop})`,
          data: {
            subtype: "z_envelope",
            arm,
            armX: next.x,
            armZ: next.zBelowTraverse,
            carrierId: c.carrierId,
            carrierXMin: c.xMin,
            carrierXMax: c.xMax,
            carrierZTop: c.zTop,
          },
        });
      }
    }
    return null;
  }

  private checkArmOverlap(
    arm: ArmId,
    next: ArmPose,
    other: ArmId,
    otherPose: ArmPose,
    event: string,
  ): AssessmentEvent | null {
    // Only meaningful when the other arm is actually on deck (x > 0).
    if (otherPose.x <= 0) return null;
    const dx = Math.abs(next.x - otherPose.x);
    if (dx >= ARM_MIN_X_GAP) return null;
    return buildCollisionEvent({
      severity: "error",
      module: arm,
      command: event,
      description: `arm ${arm} x=${next.x} within ${ARM_MIN_X_GAP} of ${other} x=${otherPose.x}`,
      data: {
        subtype: "arm_overlap",
        arm,
        other,
        armX: next.x,
        otherX: otherPose.x,
        minGap: ARM_MIN_X_GAP,
        actualGap: dx,
      },
    });
  }

  private checkIswapSweep(prev: ArmPose, next: ArmPose, event: string): AssessmentEvent[] {
    if (prev.x === next.x && prev.y === next.y) return [];
    const xMin = Math.min(prev.x, next.x);
    const xMax = Math.max(prev.x, next.x);
    const out: AssessmentEvent[] = [];
    for (const other of ["pip", "head96"] as ArmId[]) {
      const o = this.arms[other];
      if (o.x <= 0) continue;
      if (o.x >= xMin && o.x <= xMax) {
        out.push(buildCollisionEvent({
          severity: "warning",
          module: "iswap",
          command: event,
          description: `iswap sweep [${xMin}..${xMax}] crosses ${other} at x=${o.x}`,
          data: {
            subtype: "iswap_sweep",
            arm: "iswap",
            other,
            sweepXMin: xMin,
            sweepXMax: xMax,
            otherX: o.x,
          },
        }));
      }
    }
    return out;
  }

  private refreshTallCarriers(deckTracker: DeckTracker): void {
    // deckTracker is an escape hatch — pull the Deck out through the
    // public API surface to enumerate carriers by ID. Each carrier's
    // X-range is computed via `getCarrierXRange` which handles the
    // track → X mapping for us.
    const dt = deckTracker as unknown as {
      deck: {
        getAllCarriers?: () => Array<{ id: string }>;
        getCarrierXRange?: (id: string) => { xMin: number; xMax: number } | null;
      };
    };
    if (!dt?.deck?.getAllCarriers || !dt?.deck?.getCarrierXRange) return;

    // Keep operator-added entries verbatim; replace the deck-derived set.
    const operatorAdded = this.tallCarriers.filter(
      (tc) => !DEFAULT_TALL_PREFIXES.some((p) => tc.carrierId.startsWith(p)),
    );
    const derived: TallCarrier[] = [];
    for (const c of dt.deck.getAllCarriers()) {
      if (!DEFAULT_TALL_PREFIXES.some((p) => c.id.startsWith(p))) continue;
      const range = dt.deck.getCarrierXRange(c.id);
      if (!range) continue;
      derived.push({
        carrierId: c.id,
        xMin: range.xMin,
        xMax: range.xMax,
        zTop: TALL_CARRIER_Z_DEFAULT,
      });
    }
    this.tallCarriers = [...derived, ...operatorAdded];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Shape an AssessmentEvent-compatible object. `id`/`timestamp`/
 * `correlationId`/`stepId` are filled in by the twin when the event is
 * stored — we only set the identifying fields.
 */
function buildCollisionEvent(args: {
  severity: "info" | "warning" | "error";
  module: string;
  command: string;
  description: string;
  data: Record<string, unknown>;
}): AssessmentEvent {
  return {
    id: 0,
    timestamp: Date.now(),
    category: "collision",
    severity: args.severity,
    module: args.module,
    command: args.command,
    description: args.description,
    data: args.data,
  };
}

/** Re-export so this file can be the single entry point for tests. */
export const COLLISION_ARM_MIN_X_GAP = ARM_MIN_X_GAP;
export const COLLISION_Z_TRAVERSE_DEFAULT = Z_TRAVERSE_DEFAULT;
