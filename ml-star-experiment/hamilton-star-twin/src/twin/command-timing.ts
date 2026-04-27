/**
 * Command Execution Timing
 *
 * Estimates realistic execution times for FW commands based on
 * the physical operations the real Hamilton STAR performs.
 *
 * Timing sources:
 * - Hamilton STAR service manual (mechanical specifications)
 * - VENUS trace file timestamps (real instrument recordings)
 * - Physical constraints (flow rates, axis speeds, acceleration)
 *
 * All times in milliseconds.
 */

/** Axis speeds (mm/s) — from Hamilton specifications */
const SPEED = {
  pipX: 800,      // PIP X-axis travel (fast linear motor)
  pipY: 400,      // PIP Y-axis travel (per channel)
  pipZ: 300,      // PIP Z-axis travel (tip engagement/retract)
  h96X: 600,      // 96-head X travel
  h96Z: 200,      // 96-head Z travel (heavier assembly)
  iswapX: 500,    // iSWAP X travel
  iswapZ: 200,    // iSWAP Z travel (gripping)
};

/** Acceleration adds ~200ms to each axis move */
const ACCEL_OVERHEAD = 200;

/** Z distances for common operations (mm) */
const Z_DIST = {
  tipPickup: 60,     // Traverse → tip top → engage → retract
  aspirate: 80,      // Traverse → liquid surface → submerge → retract
  dispense: 70,      // Traverse → dispense height → retract
  tipEject: 40,      // Lower to eject position → release → retract
};

/**
 * Estimate execution time for a FW command.
 *
 * @param event - FW event code (e.g. "C0AS")
 * @param params - Parsed command parameters
 * @returns Estimated execution time in milliseconds
 */
export function estimateCommandTime(event: string, params: Record<string, unknown> = {}): number {
  const vol = (params.av as number) || (params.dv as number) || (params.af as number) || (params.df as number) || 0;
  const flowRate = (params.as as number) || (params.ds as number) || 2500;  // 0.1µL/s

  switch (event) {
    // ── PIP Channel Commands ────────────────────────────────────────

    case "C0TP": {
      // Tip pickup: X travel + Z down + grip + Z up (real: 7-9s from traces)
      const zTime = (Z_DIST.tipPickup / SPEED.pipZ) * 1000;
      return Math.round(zTime * 2 + ACCEL_OVERHEAD * 3 + 800 + 2000);  // Z×2 + grip 800ms + X ~2s
    }

    case "C0TR": {
      // Tip eject: X to waste + Z down + release + Z up (real: 7-8s)
      const zTime = (Z_DIST.tipEject / SPEED.pipZ) * 1000;
      return Math.round(zTime * 2 + ACCEL_OVERHEAD * 3 + 500 + 2000);  // Z×2 + release + X ~2s
    }

    case "C0AS": {
      // Aspirate: Z down + aspirate at flow rate + settle + pull-out retract + Z up
      // Field refs (AtsMcAspirate.cpp): wt=settlingTime@43, po=aspAirRetractDist@55
      const zTime = (Z_DIST.aspirate / SPEED.pipZ) * 1000;
      const aspTime = vol > 0 ? (vol / flowRate) * 1000 : 500;  // vol in 0.1µL, rate in 0.1µL/s
      const settleTime = (params.wt as number) || 50;  // 0.1s units (real trace: wt10 = 1s)
      const pullOutMm = ((params.po as number) || 0) / 10;  // 0.1mm units (real trace: po0050 = 5mm)
      const pullOutTime = pullOutMm > 0 ? (pullOutMm / SPEED.pipZ) * 1000 : 0;
      return Math.round(zTime + aspTime + settleTime * 100 + pullOutTime + ACCEL_OVERHEAD);
    }

    case "C0DS": {
      // Dispense: Z down + dispense at flow rate + settle + blowout + pull-out + Z up
      // Field refs (AtsMcDispense.cpp): wt=settlingTime@47, po=aspAirRetractDist@55
      const zTime = (Z_DIST.dispense / SPEED.pipZ) * 1000;
      const dispTime = vol > 0 ? (vol / flowRate) * 1000 : 500;
      const settleTime = (params.wt as number) || 0;  // 0.1s units (real trace: wt00 typical on dispense)
      const pullOutMm = ((params.po as number) || 0) / 10;  // 0.1mm units
      const pullOutTime = pullOutMm > 0 ? (pullOutMm / SPEED.pipZ) * 1000 : 0;
      return Math.round(zTime + dispTime + settleTime * 100 + pullOutTime + 200 + ACCEL_OVERHEAD);
    }

    case "C0DF": {
      // Dispense fly: travel distance + dispense during movement
      const xi = (params.xi as number) || 1;
      return Math.round(500 + xi * 300);  // ~300ms per dispense position
    }

    case "C0JM": {
      // PIP X-axis move: depends on distance
      return Math.round(ACCEL_OVERHEAD + 500);  // typical ~0.7s
    }

    case "C0KX":
    case "C0KR":
    case "C0JX":
    case "C0JS": {
      // Master-owned X-axis moves (left arm, right arm, absolute left,
      // absolute right). Real hardware: 0.3–1 s depending on travel.
      // Non-zero duration also lets the motion envelope fire so the
      // renderer can interpolate the ghost arm along the trajectory.
      return 700;
    }

    case "C0LW": {
      // Liquid wash: multiple wash cycles
      return 5000;  // ~5 seconds for a wash cycle
    }

    // ── 96-Head Commands ────────────────────────────────────────────

    case "C0EM": {
      // 96-head X+Y move
      return Math.round(ACCEL_OVERHEAD + 800);
    }

    case "C0EP": {
      // 96-head tip pickup (heavier, slower Z)
      const zTime = (Z_DIST.tipPickup / SPEED.h96Z) * 1000;
      return Math.round(zTime + ACCEL_OVERHEAD + 500);  // +500 for 96 simultaneous grips
    }

    case "C0ER": {
      // 96-head tip eject
      return Math.round(800 + ACCEL_OVERHEAD);
    }

    case "C0EA": {
      // 96-head aspirate
      const aspTime = vol > 0 ? (vol / 2500) * 1000 : 500;
      return Math.round(aspTime + 1000 + ACCEL_OVERHEAD);
    }

    case "C0ED": {
      // 96-head dispense
      const dispTime = vol > 0 ? (vol / 2500) * 1000 : 500;
      return Math.round(dispTime + 800 + ACCEL_OVERHEAD);
    }

    // ── iSWAP Commands ──────────────────────────────────────────────

    case "C0PP": {
      // Get plate: full sequence (real: ~17s from traces)
      // arm extend + Y approach + Z descent + grip + sense + Z retract + Y retract + collapse
      return Math.round(1200 + 1500 + 1200 + 500 + 400 + 1000 + 1000 + 800);  // ~7.6s base
    }

    case "C0PR": {
      // Put plate: (real: ~9s from traces)
      return Math.round(1200 + 1500 + 1200 + 300 + 1000 + 1000 + 800);  // ~7.0s base
    }

    case "C0PM": {
      // Move plate: X travel with plate
      return Math.round(2000 + ACCEL_OVERHEAD + 1500);
    }

    // ── CO-RE Gripper ───────────────────────────────────────────────

    case "C0ZT": return 1500;   // Get tool
    case "C0ZP": return 2000;   // Grip plate
    case "C0ZR": return 2000;   // Release plate
    case "C0ZS": return 1500;   // Discard tool
    case "C0ZM": return 1500;   // Move with plate

    // ── Temperature / Wash ──────────────────────────────────────────

    case "C0HC": {
      // Set temp and WAIT until reached — estimate ramp time from ambient
      // Real TCC: ~3 C/min heating, ~1.2 C/min cooling
      const target = (params.hc as number) ?? 0;
      const ambient = 220;  // 22.0C assumed ambient (static fallback, no datamodel access)
      const delta = Math.abs(target - ambient);
      const rate = target > ambient ? 0.5 : 0.2;  // 0.1C/s heating or cooling
      return Math.max(1000, Math.round((delta / rate) * 1000));
    }
    case "C0HF": return 200;    // Temp off
    case "C0WS": return 3000;   // Wash cycle start
    case "C0WI": return 500;    // Wash init

    // ── Heater/Shaker ───────────────────────────────────────────────

    case "T1SA": return 500;    // Start shake
    case "T1SS": return 300;    // Stop shake
    case "T1TA": return 500;    // Set HHS temp

    // ── Init / Query commands ───────────────────────────────────────

    case "C0VI": return 5000;    // System init (homing axes)
    case "C0DI": return 45000;  // PIP init: 16 Z-drives + Y + calibration (real: ~55s)
    case "C0EI": return 20000;  // 96-head init (real: ~20s)
    case "C0FI": return 1500;   // iSWAP init
    case "C0II": return 1000;   // AutoLoad init

    // AutoLoad carriage moves (real traces: C0CL ~4-6 s per track,
    // C0CR ~5-7 s including push-off, C0CI ~3 s barcode read).
    case "C0CL": return 4500;   // Load carrier to a track
    case "C0CR": return 5500;   // Unload carrier back to tray
    case "C0CI": return 3000;   // Identify (barcode scan)

    default: {
      // Query/config commands are fast
      if (event.startsWith("C0Q") || event.startsWith("C0R") || event.startsWith("C0V")) {
        return 50;  // Near-instant query response
      }
      return 300;  // Default for unknown commands
    }
  }
}

import { PhysicsPlugin, CommandTiming } from "./plugin-interface";

/**
 * Get the best available timing for a command.
 *
 * Priority: plugin physics (computed/hybrid) → static estimate.
 * Returns a CommandTiming with accuracy tier and optional breakdown.
 *
 * @param event - FW event code
 * @param params - Parsed command parameters
 * @param plugin - Physics plugin for this module (if available)
 */
export function getCommandTiming(event: string, params: Record<string, unknown>, plugin?: PhysicsPlugin): CommandTiming {
  // Try physics plugin first
  if (plugin?.estimateTime) {
    const pluginTiming = plugin.estimateTime(event, params);
    if (pluginTiming) return pluginTiming;
  }

  // Fall back to static estimate
  const est = estimateCommandTime(event, params);
  return {
    totalMs: est,
    accuracy: "estimate",
  };
}

/**
 * Simulation speed multiplier.
 *
 * - 0 = instant (no delay)
 * - 1 = real-time (actual estimated timing)
 * - 0.1 = 10x faster than real
 * - 2 = 2x slower (for detailed observation)
 */
export type SimulationSpeed = number;

/**
 * Apply simulation speed to an estimated time.
 * Returns the actual delay to apply in milliseconds.
 */
export function applySimSpeed(estimatedMs: number, speed: SimulationSpeed): number {
  if (speed <= 0) return 0;
  return Math.round(estimatedMs * speed);
}
