/**
 * Advanced-physics global plugin (Phase 4 Step 4.C, #39)
 *
 * Adds three lightweight physics observations that sit alongside the
 * existing TADM / LLD / dead-volume assessments emitted by pip-physics:
 *
 *   1. Foam risk       — `C0DS` with dispense speed ≫ the liquid class
 *                         default suggests mechanical foaming at the
 *                         liquid-air interface.
 *   2. Drip risk       — `C0AS` without a trailing transport-air (ta)
 *                         parameter: the tip carries a free surface past
 *                         the lip and may lose droplets in transit.
 *   3. Meniscus        — `ip` (submerge depth) differs sharply from the
 *                         liquid class default; either the tip is riding
 *                         on top of the surface (too shallow) or spearing
 *                         the bottom (too deep).
 *
 * Design notes
 * ------------
 *   - Registered via `DigitalTwin.registerGlobalPlugin` so it sees
 *     commands from every module. Keeps the PIP plugin free of these
 *     opinionated checks; sites that don't want them just skip the
 *     registration.
 *   - Each observation is a simple comparison against the liquid class
 *     catalogue. No coupling to the plunger/TADM state — that's the job
 *     of the production plugin.
 *   - Tunables (foam speed multiplier, meniscus mismatch tolerance) are
 *     exported so tests and integrators can pin the exact thresholds.
 */

import type { PhysicsPlugin } from "../plugin-interface";
import type { AssessmentEvent } from "../assessment";
import { getLiquidClass } from "../liquid-classes";
import type { TADMResult } from "../tadm";

// ============================================================================
// Tunables
// ============================================================================

/** Dispense speed above `FOAM_SPEED_RATIO × class default` triggers foam risk. */
export const FOAM_SPEED_RATIO = 1.75;

/** Submerge depth outside [default × (1 ± tolerance)] triggers a meniscus warning. */
export const MENISCUS_MISMATCH_TOLERANCE = 0.4;

/** Transport-air minimum (0.1 µL) below which a trailing-air gap is considered absent. */
export const DRIP_MIN_TRANSPORT_AIR = 10;

/**
 * Liquid-following quality score threshold. Scores below this emit a
 * `liquid_follow` warning — the tip is losing contact faster than it
 * should during aspiration. 1.0 = perfect tracking; 0.0 = tip stayed
 * at initial Z while surface dropped completely.
 */
export const LIQUID_FOLLOW_QUALITY_WARN = 0.85;

/**
 * One layer in a channel's internal stack. The stack is ordered
 * FROM plunger (bottom, first-in) TO tip opening (top, last-in).
 * Dispense pops from the top; aspirate pushes onto the top.
 */
export interface ChannelLayer {
  kind: "liquid" | "air";
  volume: number;         // 0.1 µL
  liquidType?: string;    // only for liquid layers
  addedAt: number;        // epoch ms
}

// ============================================================================
// Plugin
// ============================================================================

export interface AdvancedPhysicsOptions {
  /** Resolve the liquid class name for a given command. Defaults to the
   *  `lc` string param if present, else "water". */
  resolveLiquidClass?: (event: string, data: Record<string, unknown>) => string;
  /** Override individual tunables (e.g. for dev spikes). */
  foamSpeedRatio?: number;
  meniscusMismatchTolerance?: number;
  dripMinTransportAir?: number;
}

export class AdvancedPhysics implements PhysicsPlugin {
  readonly id = "advanced-physics";

  private resolver: Required<AdvancedPhysicsOptions>["resolveLiquidClass"];
  private foamRatio: number;
  private meniscusTol: number;
  private dripMinTa: number;

  constructor(options: AdvancedPhysicsOptions = {}) {
    this.resolver = options.resolveLiquidClass ?? defaultResolveLiquidClass;
    this.foamRatio = options.foamSpeedRatio ?? FOAM_SPEED_RATIO;
    this.meniscusTol = options.meniscusMismatchTolerance ?? MENISCUS_MISMATCH_TOLERANCE;
    this.dripMinTa = options.dripMinTransportAir ?? DRIP_MIN_TRANSPORT_AIR;
  }

  /**
   * Per-channel layer stack. Populated via `pushLayer`/`popLayer` — the
   * pip-physics integration can hook into this as it matures. Exposed
   * so report generation can enumerate channel contents post-run.
   */
  private layers: Map<number, ChannelLayer[]> = new Map();

  /** Return the current stack for a channel (copy). */
  getLayerStack(channel: number): ChannelLayer[] {
    return [...(this.layers.get(channel) ?? [])];
  }

  /** Push a liquid or air layer on top of a channel's stack. */
  pushLayer(channel: number, layer: Omit<ChannelLayer, "addedAt">): void {
    const stack = this.layers.get(channel) ?? [];
    stack.push({ ...layer, addedAt: Date.now() });
    this.layers.set(channel, stack);
  }

  /**
   * Remove `volume` (0.1 µL) from the top of the stack, spanning
   * multiple layers if needed. Returns the removed layers in dispense
   * order (top → bottom).
   */
  popVolume(channel: number, volume: number): ChannelLayer[] {
    const stack = this.layers.get(channel) ?? [];
    const removed: ChannelLayer[] = [];
    let remaining = volume;
    while (remaining > 0 && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.volume <= remaining) {
        remaining -= top.volume;
        removed.push(stack.pop()!);
      } else {
        removed.push({ ...top, volume: remaining });
        top.volume -= remaining;
        remaining = 0;
      }
    }
    this.layers.set(channel, stack);
    return removed;
  }

  assess(event: string, data: Record<string, unknown>): AssessmentEvent[] {
    const out: AssessmentEvent[] = [];
    const lcName = this.resolver(event, data);
    const lc = getLiquidClass(lcName);
    if (!lc) return out;

    if (event === "C0DS") {
      const foam = this.checkFoam(lc, data);
      if (foam) out.push(foam);
      // Channel-layer disorder: if someone dispenses and the top
      // layer is "air" we're about to puff the first pulse out as air
      // instead of liquid — a calibration misfire.
      const mask = typeof data.tm === "number" ? data.tm : 0;
      for (let ch = 0; ch < 8; ch++) {
        if (((mask >> ch) & 1) === 0) continue;
        const stack = this.layers.get(ch) ?? [];
        if (stack.length === 0) continue;
        const top = stack[stack.length - 1];
        if (top.kind !== "air") continue;
        out.push(buildEvent({
          category: "air_gap_disorder",
          severity: "warning",
          module: "pip",
          command: event,
          description: `Channel ${ch + 1} will dispense an ${top.volume / 10} µL air gap before liquid — blowout misfire risk`,
          data: { channel: ch, topLayerKind: top.kind, topLayerVolume: top.volume },
        }));
      }
    }

    if (event === "C0AS") {
      const drip = this.checkDrip(lc, data);
      if (drip) out.push(drip);
      const meniscus = this.checkMeniscus(lc, data);
      if (meniscus) out.push(meniscus);
      const follow = this.checkLiquidFollow(lc, data);
      if (follow) out.push(follow);
    }

    // Clot events: the pip-physics plugin attaches the TADM result on
    // the command result; we re-assess it here through an ambient
    // data channel since our `assess` signature doesn't carry the TADM
    // directly. The convention: a caller may set `data._tadm` so this
    // plugin can surface a typed `clot` assessment alongside the
    // existing TADM warning.
    if ((event === "C0AS" || event === "C0DS") && data._tadm) {
      const t = data._tadm as TADMResult;
      if (t.perturbation === "clot") {
        out.push(buildEvent({
          category: "clot",
          severity: t.passed ? "warning" : "error",
          module: "pip",
          command: event,
          description: `TADM clot signature detected at sample ${t.violationIndex ?? "?"} — peak ${t.peakPressure} mbar`,
          data: { perturbation: t.perturbation, violationIndex: t.violationIndex, peakPressure: t.peakPressure },
        }));
      }
    }

    return out;
  }

  private checkLiquidFollow(
    lc: ReturnType<typeof getLiquidClass>,
    data: Record<string, unknown>,
  ): AssessmentEvent | null {
    if (!lc) return null;
    // Only meaningful when liquid-following is enabled.
    const lf = typeof data.lf === "number" ? data.lf : 1;
    if (lf !== 1) return null;
    const av = typeof data.av === "number" ? data.av : 0;  // volume (0.1 µL)
    const as = typeof data.as === "number" ? data.as : lc.aspiration.speed;
    const wellVolume = typeof data._wellVolume === "number" ? data._wellVolume : av * 5;
    if (av <= 0 || wellVolume <= 0) return null;

    // Quality heuristic: how much of the aspirate depletes the well,
    // scaled by speed vs class default. Faster aspirates with
    // high-depletion lag more — real instruments see the meniscus fall
    // below the tip tracking capability.
    const depletion = Math.min(1, av / wellVolume);
    const speedRatio = as / (lc.aspiration.speed || as || 1);
    const score = Math.max(0, Math.min(1, 1 - depletion * Math.max(1, speedRatio) * 0.8));
    if (score >= LIQUID_FOLLOW_QUALITY_WARN) {
      // Emit an info-level trace so reports can show a quality
      // timeline even on clean runs. Keeps the assessment useful for
      // the new TADM/LLD chart UI without polluting the warning bus.
      return buildEvent({
        category: "liquid_follow",
        severity: "info",
        module: "pip",
        command: "C0AS",
        description: `Liquid-following quality ${(score * 100).toFixed(0)}% (depletion ${(depletion * 100).toFixed(0)}%)`,
        data: { liquidClass: lc.name, score, depletion, speedRatio },
      });
    }
    return buildEvent({
      category: "liquid_follow",
      severity: "warning",
      module: "pip",
      command: "C0AS",
      description: `Liquid-following quality ${(score * 100).toFixed(0)}% — tip may lose surface contact (depletion ${(depletion * 100).toFixed(0)}%, ${speedRatio.toFixed(1)}× class speed)`,
      data: { liquidClass: lc.name, score, depletion, speedRatio, threshold: LIQUID_FOLLOW_QUALITY_WARN },
    });
  }

  // --- observations -----------------------------------------------------

  private checkFoam(
    lc: ReturnType<typeof getLiquidClass>,
    data: Record<string, unknown>,
  ): AssessmentEvent | null {
    if (!lc) return null;
    const speedDef = lc.dispense.speed;      // 0.1 µL/s
    const actual = toNum(data.ds) ?? toNum(data.sp);
    if (actual === null || actual <= 0 || speedDef <= 0) return null;
    if (actual <= speedDef * this.foamRatio) return null;
    return buildEvent({
      category: "foam",
      severity: "warning",
      module: "pip",
      command: "C0DS",
      description: `Dispense speed ${(actual / 10).toFixed(1)} µL/s exceeds ${this.foamRatio}× class default ${(speedDef / 10).toFixed(1)} µL/s for ${lc.name} — foam risk`,
      data: { liquidClass: lc.name, actualSpeed: actual, defaultSpeed: speedDef, ratio: this.foamRatio },
    });
  }

  private checkDrip(
    lc: ReturnType<typeof getLiquidClass>,
    data: Record<string, unknown>,
  ): AssessmentEvent | null {
    if (!lc) return null;
    const ta = toNum(data.ta);
    // A missing `ta` is common for quick tests; we only flag when the
    // class's default explicitly requires transport air but the command
    // omitted it.
    const classDefault = lc.aspiration.transportAir;
    if (classDefault <= 0) return null;
    const effective = ta ?? 0;
    if (effective >= this.dripMinTa) return null;
    return buildEvent({
      category: "drip",
      severity: "warning",
      module: "pip",
      command: "C0AS",
      description: `Aspirate without trailing transport air (ta=${effective / 10} µL, class default ${classDefault / 10} µL) for ${lc.name} — drip risk in transit`,
      data: { liquidClass: lc.name, transportAir: effective, classDefault },
    });
  }

  private checkMeniscus(
    lc: ReturnType<typeof getLiquidClass>,
    data: Record<string, unknown>,
  ): AssessmentEvent | null {
    if (!lc) return null;
    const submergeDef_mm = lc.aspiration.submergeDepth ?? 2.0;
    const submergeDef_01mm = Math.round(submergeDef_mm * 10);
    const ip = toNum(data.ip);
    if (ip === null || ip <= 0 || submergeDef_01mm <= 0) return null;
    const lo = submergeDef_01mm * (1 - this.meniscusTol);
    const hi = submergeDef_01mm * (1 + this.meniscusTol);
    if (ip >= lo && ip <= hi) return null;
    return buildEvent({
      category: "meniscus",
      severity: ip < lo ? "warning" : "info",
      module: "pip",
      command: "C0AS",
      description: `Submerge depth ${(ip / 10).toFixed(1)}mm ${ip < lo ? "shallow vs" : "deeper than"} ${lc.name} default ${submergeDef_mm}mm — meniscus tracking suspect`,
      data: { liquidClass: lc.name, submergeDepth: ip, defaultDepth: submergeDef_01mm, tolerance: this.meniscusTol },
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Catalogue-default class used when a command doesn't identify one
 * explicitly. Matches the name VENUS protocols use for "standard 1 mL
 * aqueous transfer". Change this (or pass a resolver) if your lab
 * calibrates against a different baseline.
 */
export const DEFAULT_LIQUID_CLASS = "HighVolume_Water_DispenseJet_Empty";

function defaultResolveLiquidClass(
  _event: string,
  data: Record<string, unknown>,
): string {
  const lc = data.liquidClass ?? data.lc;
  return typeof lc === "string" && lc.length > 0 ? lc : DEFAULT_LIQUID_CLASS;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function buildEvent(args: {
  category: AssessmentEvent["category"];
  severity: AssessmentEvent["severity"];
  module: string;
  command: string;
  description: string;
  data: Record<string, unknown>;
}): AssessmentEvent {
  return {
    id: 0,
    timestamp: Date.now(),
    category: args.category,
    severity: args.severity,
    module: args.module,
    command: args.command,
    description: args.description,
    data: args.data,
  };
}
