/**
 * TADM — Total Aspiration and Dispense Monitoring
 *
 * Simulates the pressure curve that the real Hamilton STAR measures
 * during aspiration and dispensation. The TADM system monitors the
 * air pressure in the tip during pipetting and compares it against
 * tolerance bands to detect errors.
 *
 * Real TADM measures pressure at ~1kHz. We generate a simplified
 * curve model with key phases:
 *
 * Aspiration pressure curve:
 *   1. Pre-aspiration (flat at atmospheric)
 *   2. Ramp down (plunger moves up, pressure drops)
 *   3. Liquid entry (pressure stabilizes as liquid enters)
 *   4. Steady aspiration (gradual pressure during aspiration)
 *   5. Post-aspiration (pressure returns toward atmospheric)
 *
 * Dispense pressure curve:
 *   1. Pre-dispense (flat)
 *   2. Ramp up (plunger pushes down, pressure rises)
 *   3. Liquid exit (pressure peak as liquid leaves)
 *   4. Blow-out (if jet mode, sharp pressure spike)
 *   5. Post-dispense (return to atmospheric)
 *
 * All pressures in arbitrary units (mbar-like), matching the
 * typical TADM display range of -500 to +500.
 */

/** A single point on the pressure curve */
export interface PressurePoint {
  /** Time in milliseconds from start */
  time: number;
  /** Pressure in arbitrary units (0 = atmospheric, negative = vacuum) */
  pressure: number;
}

/** A complete TADM measurement result */
export interface TADMResult {
  /** Operation type */
  operation: "aspirate" | "dispense";
  /** Pressure curve data points */
  curve: PressurePoint[];
  /** Upper tolerance band (same length as curve) */
  upperBand: number[];
  /** Lower tolerance band */
  lowerBand: number[];
  /** Whether the curve stayed within tolerance */
  passed: boolean;
  /** If failed, where the violation occurred */
  violationIndex?: number;
  /** Peak pressure magnitude */
  peakPressure: number;
  /** Duration in ms */
  duration: number;
  /** Nominal volume (0.1ul) */
  volume: number;
  /** Speed (0.1ul/s) */
  speed: number;
  /** Detected perturbation, if any. */
  perturbation?: "clot" | "foam";
}

/**
 * Physics perturbations that deform an otherwise-clean TADM curve.
 * Each triggers a recognisable pressure signature real operators watch
 * for:
 *   - `clot`: sudden negative-pressure spike mid-aspiration as a clot
 *             transiently blocks the tip. Often out-of-tolerance on
 *             peak.
 *   - `foam`: low-amplitude oscillation during dispense (surface
 *             tension disturbed by bubbles). Stays within tolerance but
 *             heavy oscillation is a yellow flag.
 */
export type TADMPerturbation = "clot" | "foam";

export interface TADMCurveOptions {
  liquidViscosity?: number;
  toleranceUpper?: number;
  toleranceLower?: number;
  perturbation?: TADMPerturbation;
}

// ============================================================================
// Curve generation
// ============================================================================

/**
 * Generate a simulated TADM aspiration pressure curve.
 *
 * @param volume - Aspiration volume in 0.1ul
 * @param speed - Aspiration speed in 0.1ul/s
 * @param liquidViscosity - 1.0 = water, higher = more viscous
 * @returns TADMResult with curve data
 */
export function generateAspirateCurve(
  volume: number,
  speed: number,
  liquidViscosity: number = 1.0,
  toleranceUpper: number = 50,
  toleranceLower: number = 50,
  options: Pick<TADMCurveOptions, "perturbation"> = {}
): TADMResult {
  const duration = Math.max(100, Math.round((volume / speed) * 1000));
  const sampleRate = 10; // ms per point
  const numPoints = Math.ceil(duration / sampleRate) + 20; // +20 for pre/post

  const curve: PressurePoint[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];

  // Peak negative pressure depends on volume and viscosity
  const peakPressure = -Math.min(400, 50 + (volume / 100) * liquidViscosity * 30);
  // Clot perturbation fires near 60% of the aspiration window and
  // spikes pressure well beyond the lower tolerance so operators
  // reliably catch it on the TADM chart.
  const clotCenterT = 100 + duration * 0.6;
  const clotHalfWidth = Math.max(30, duration * 0.08);
  const clotSpike = options.perturbation === "clot" ? peakPressure * 1.8 : 0;

  let violationIndex: number | undefined;
  let passed = true;

  for (let i = 0; i < numPoints; i++) {
    const t = i * sampleRate;
    let p = 0;

    if (t < 50) {
      p = 0;
    } else if (t < 100) {
      const rampProgress = (t - 50) / 50;
      p = peakPressure * rampProgress * 0.8;
    } else if (t < 100 + duration) {
      const aspProgress = (t - 100) / duration;
      p = peakPressure * (0.8 - aspProgress * 0.3);
      p += (Math.sin(t * 0.1) * 5) * liquidViscosity;
      // Clot spike: a narrow gaussian-ish pulse centred on clotCenterT.
      if (clotSpike !== 0) {
        const dt = (t - clotCenterT) / clotHalfWidth;
        p += clotSpike * Math.exp(-dt * dt);
      }
    } else {
      const postProgress = Math.min(1, (t - 100 - duration) / 100);
      p = peakPressure * 0.5 * (1 - postProgress);
    }

    const lo = Math.round(p - toleranceLower);
    const hi = Math.round(p + toleranceUpper);
    curve.push({ time: t, pressure: Math.round(p) });
    upperBand.push(hi);
    lowerBand.push(lo);

    // Tolerance check — with a clot spike the in-progress pressure
    // dips below the lower band at the peak of the pulse, which is
    // exactly the signal operators look for.
    if (clotSpike !== 0 && passed) {
      // Compare the unperturbed baseline against the raw sample — a
      // perturbation counts as a violation when the sample drops at
      // least 1.5x the lower tolerance below the baseline.
      const baselineNoise = Math.abs(peakPressure) * 0.05;
      const dt = (t - clotCenterT) / clotHalfWidth;
      const pulse = clotSpike * Math.exp(-dt * dt);
      if (Math.abs(pulse) > toleranceLower * 1.5 + baselineNoise) {
        passed = false;
        violationIndex = i;
      }
    }
  }

  return {
    operation: "aspirate",
    curve,
    upperBand,
    lowerBand,
    passed,
    violationIndex,
    peakPressure: Math.abs(Math.min(...curve.map((p) => p.pressure))),
    duration,
    volume,
    speed,
    perturbation: options.perturbation,
  };
}

/**
 * Generate a simulated TADM dispense pressure curve.
 */
export function generateDispenseCurve(
  volume: number,
  speed: number,
  dispenseMode: number, // 0=jet, 1=blowout jet, 2=surface, 3=blowout surface
  liquidViscosity: number = 1.0,
  toleranceUpper: number = 50,
  toleranceLower: number = 50
): TADMResult {
  const duration = Math.max(100, Math.round((volume / speed) * 1000));
  const sampleRate = 10;
  const isJet = dispenseMode <= 1;
  const isBlowout = dispenseMode === 1 || dispenseMode === 3;
  const blowoutTime = isBlowout ? 80 : 0;
  const numPoints = Math.ceil((duration + blowoutTime + 200) / sampleRate);

  const curve: PressurePoint[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];

  // Peak positive pressure
  const peakPressure = Math.min(400, 30 + (volume / 100) * liquidViscosity * 20);
  const blowoutPeak = isBlowout ? peakPressure * 1.5 : 0;

  for (let i = 0; i < numPoints; i++) {
    const t = i * sampleRate;
    let p = 0;

    if (t < 30) {
      // Pre-dispense
      p = 0;
    } else if (t < 80) {
      // Ramp up
      const rampProgress = (t - 30) / 50;
      p = peakPressure * rampProgress * 0.7;
    } else if (t < 80 + duration) {
      // Steady dispense
      const dspProgress = (t - 80) / duration;
      p = peakPressure * (0.7 - dspProgress * 0.2);
      p += Math.sin(t * 0.08) * 3 * liquidViscosity;
    } else if (isBlowout && t < 80 + duration + blowoutTime) {
      // Blow-out spike
      const blowProgress = (t - 80 - duration) / blowoutTime;
      p = blowoutPeak * Math.sin(blowProgress * Math.PI);
    } else {
      // Post-dispense
      const postStart = 80 + duration + blowoutTime;
      const postProgress = Math.min(1, (t - postStart) / 100);
      p = (isBlowout ? 10 : peakPressure * 0.3) * (1 - postProgress);
    }

    curve.push({ time: t, pressure: Math.round(p) });
    upperBand.push(Math.round(p + toleranceUpper));
    lowerBand.push(Math.round(p - toleranceLower));
  }

  return {
    operation: "dispense",
    curve,
    upperBand,
    lowerBand,
    passed: true,
    peakPressure,
    duration: duration + blowoutTime,
    volume,
    speed,
  };
}

/**
 * Generate an ERROR aspiration curve (e.g. clot, empty well, clogged tip).
 * The pressure deviates outside the tolerance band.
 */
export function generateErrorCurve(
  volume: number,
  speed: number,
  errorType: "clot" | "empty" | "clogged"
): TADMResult {
  const result = generateAspirateCurve(volume, speed, 1.0, 50, 50);

  // Modify the curve to show the error
  const midpoint = Math.floor(result.curve.length / 2);

  switch (errorType) {
    case "clot":
      // Sudden pressure spike as clot blocks the tip
      for (let i = midpoint; i < midpoint + 10 && i < result.curve.length; i++) {
        result.curve[i].pressure = -450;
      }
      break;
    case "empty":
      // Pressure drops to near-zero quickly (aspirating air)
      for (let i = midpoint; i < result.curve.length; i++) {
        result.curve[i].pressure = Math.round(result.curve[i].pressure * 0.1);
      }
      break;
    case "clogged":
      // Pressure stays at maximum negative (no liquid flowing)
      for (let i = midpoint; i < result.curve.length; i++) {
        result.curve[i].pressure = -400;
      }
      break;
  }

  // Find violation
  result.passed = false;
  for (let i = 0; i < result.curve.length; i++) {
    if (result.curve[i].pressure > result.upperBand[i] ||
        result.curve[i].pressure < result.lowerBand[i]) {
      result.violationIndex = i;
      break;
    }
  }

  return result;
}
