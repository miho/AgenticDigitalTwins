/**
 * Liquid Class System
 *
 * Implements volume correction curves that map nominal pipetting
 * volume to actual plunger displacement based on:
 * - Liquid type (water, DMSO, serum, ethanol, glycerol, plasma, etc.)
 * - Tip size (10uL, 50uL, 300uL, 1000uL)
 * - Dispense mode (jet vs surface, empty vs part)
 *
 * The real Hamilton CO-RE Liquid Editor uses polynomial correction
 * curves fitted from gravimetric calibration data. We model this
 * with a simple polynomial: actual = a0 + a1*nominal + a2*nominal^2
 *
 * VENUS naming convention: {TipSize}_{Liquid}_{DispenseMode}_{Completion}
 *   TipSize:    HighVolume (1000uL), StandardVolume (300uL), LowVolume (50uL)
 *   Liquid:     Water, DMSO, Serum, Ethanol, Glycerol80, Plasma
 *   Mode:       DispenseJet, DispenseSurface, AliquotDispenseJet
 *   Completion: Empty (full blowout), Part (partial, keep rest volume)
 *
 * All volumes in 0.1uL (firmware units).
 */

/** Correction curve coefficients: actual = a0 + a1*nominal + a2*nominal^2 */
export interface CorrectionCurve {
  a0: number;  // Offset (0.1ul)
  a1: number;  // Linear coefficient (close to 1.0 for water)
  a2: number;  // Quadratic coefficient (small, for non-linearity)
}

/** A liquid class definition */
export interface LiquidClass {
  name: string;
  liquidType: string;
  description: string;

  /** Correction curves per tip size (0.1ul key = tip max volume) */
  correctionByTip: Record<number, CorrectionCurve>;

  /** Default aspiration parameters */
  aspiration: {
    speed: number;          // 0.1ul/s
    transportAir: number;   // 0.1ul
    blowoutAir: number;     // 0.1ul
    prewetVolume: number;   // 0.1ul
    settlingTime: number;   // 0.1s
    lldMode: number;        // 0=off, 1=cLLD, 2=pLLD, 3=dual
    swapSpeed: number;      // 0.1mm/s
    submergeDepth?: number; // mm below liquid surface (default 2.0)
    liquidFollowing?: boolean; // track surface during aspiration (default true)
  };

  /** Default dispense parameters */
  dispense: {
    speed: number;          // 0.1ul/s
    cutoffSpeed: number;    // 0.1ul/s
    stopBackVolume: number; // 0.1ul
    sideTouchOff: boolean;
    fixedHeight?: number;   // mm from well bottom (default 10)
  };
}

/**
 * Apply a correction curve to a nominal volume.
 *
 * @param nominal - Nominal volume in 0.1ul
 * @param curve - Correction coefficients
 * @returns Corrected volume in 0.1ul
 */
export function applyCorrection(nominal: number, curve: CorrectionCurve): number {
  const corrected = curve.a0 + curve.a1 * nominal + curve.a2 * nominal * nominal;
  return Math.max(0, Math.round(corrected));
}

/**
 * Get the correction curve for a specific liquid class and tip size.
 * Falls back to the nearest tip size if exact match not found.
 */
export function getCorrectionCurve(lc: LiquidClass, tipMaxVolume: number): CorrectionCurve {
  // Exact match
  if (lc.correctionByTip[tipMaxVolume]) {
    return lc.correctionByTip[tipMaxVolume];
  }

  // Find nearest tip size
  const tipSizes = Object.keys(lc.correctionByTip).map(Number).sort((a, b) => a - b);
  let nearest = tipSizes[0];
  for (const size of tipSizes) {
    if (Math.abs(size - tipMaxVolume) < Math.abs(nearest - tipMaxVolume)) {
      nearest = size;
    }
  }
  return lc.correctionByTip[nearest] || { a0: 0, a1: 1, a2: 0 };
}

// ============================================================================
// Standard Liquid Classes — VENUS naming convention
// ============================================================================

/**
 * Standard liquid classes following VENUS naming convention.
 *
 * Correction curves are approximations based on typical Hamilton
 * calibration data. In production, these would come from the
 * CO-RE Liquid Editor calibration files.
 */
export const LIQUID_CLASSES: Record<string, LiquidClass> = {

  // ── High Volume (1000uL tip) classes ─────────────────────────────────

  "HighVolume_Water_DispenseJet_Empty": {
    name: "HighVolume_Water_DispenseJet_Empty",
    liquidType: "Water",
    description: "Standard water transfer with full blow-out (jet mode, 1000uL tips)",
    correctionByTip: {
      10000: { a0: 2, a1: 1.005, a2: -0.0000001 },
      3000: { a0: 1.5, a1: 1.008, a2: -0.0000005 },
      500: { a0: 0.8, a1: 1.015, a2: -0.000005 },
      100: { a0: 0.3, a1: 1.03, a2: -0.00005 },
    },
    aspiration: {
      speed: 2500, transportAir: 50, blowoutAir: 300, prewetVolume: 50,
      settlingTime: 5, lldMode: 1, swapSpeed: 100,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 4000, cutoffSpeed: 2500, stopBackVolume: 0, sideTouchOff: false,
      fixedHeight: 10,
    },
  },

  "HighVolume_Water_DispenseSurface_Empty": {
    name: "HighVolume_Water_DispenseSurface_Empty",
    liquidType: "Water",
    description: "Water surface dispense (1000uL tips, touch liquid surface)",
    correctionByTip: {
      10000: { a0: 2, a1: 1.005, a2: -0.0000001 },
      3000: { a0: 1.5, a1: 1.008, a2: -0.0000005 },
    },
    aspiration: {
      speed: 2500, transportAir: 50, blowoutAir: 300, prewetVolume: 50,
      settlingTime: 5, lldMode: 1, swapSpeed: 100,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 2000, cutoffSpeed: 1000, stopBackVolume: 20, sideTouchOff: true,
      fixedHeight: 5,
    },
  },

  "HighVolume_Water_AliquotDispenseJet_Part": {
    name: "HighVolume_Water_AliquotDispenseJet_Part",
    liquidType: "Water",
    description: "Aliquot dispensing: 1 aspirate → N partial jet dispenses (1000uL tips)",
    correctionByTip: {
      10000: { a0: 3, a1: 1.008, a2: -0.0000001 },
      3000: { a0: 2, a1: 1.01, a2: -0.0000005 },
    },
    aspiration: {
      speed: 2000, transportAir: 80, blowoutAir: 400, prewetVolume: 50,
      settlingTime: 5, lldMode: 1, swapSpeed: 100,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 3000, cutoffSpeed: 2000, stopBackVolume: 0, sideTouchOff: false,
      fixedHeight: 5,
    },
  },

  // ── Standard Volume (300uL tip) classes ──────────────────────────────

  "StandardVolume_Water_DispenseJet_Empty": {
    name: "StandardVolume_Water_DispenseJet_Empty",
    liquidType: "Water",
    description: "Standard water transfer (300uL tips, jet empty) — VENUS default",
    correctionByTip: {
      3000: { a0: 1.2, a1: 1.008, a2: -0.0000008 },
      10000: { a0: 2, a1: 1.005, a2: -0.0000001 },
      500: { a0: 0.6, a1: 1.015, a2: -0.000005 },
      100: { a0: 0.2, a1: 1.03, a2: -0.00005 },
    },
    aspiration: {
      speed: 2500, transportAir: 50, blowoutAir: 300, prewetVolume: 50,
      settlingTime: 5, lldMode: 1, swapSpeed: 100,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 4000, cutoffSpeed: 2500, stopBackVolume: 0, sideTouchOff: false,
      fixedHeight: 10,
    },
  },

  "StandardVolume_Water_DispenseSurface_Empty": {
    name: "StandardVolume_Water_DispenseSurface_Empty",
    liquidType: "Water",
    description: "Water surface dispense (300uL tips)",
    correctionByTip: {
      3000: { a0: 1.2, a1: 1.008, a2: -0.0000008 },
      500: { a0: 0.6, a1: 1.015, a2: -0.000005 },
    },
    aspiration: {
      speed: 2500, transportAir: 50, blowoutAir: 300, prewetVolume: 50,
      settlingTime: 5, lldMode: 1, swapSpeed: 100,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 2000, cutoffSpeed: 1000, stopBackVolume: 20, sideTouchOff: true,
      fixedHeight: 5,
    },
  },

  "StandardVolume_Serum_DispenseJet_Empty": {
    name: "StandardVolume_Serum_DispenseJet_Empty",
    liquidType: "Serum",
    description: "Serum transfer (300uL tips, jet empty)",
    correctionByTip: {
      3000: { a0: 2, a1: 1.015, a2: -0.000001 },
      10000: { a0: 3, a1: 1.01, a2: -0.0000002 },
    },
    aspiration: {
      speed: 1200, transportAir: 60, blowoutAir: 350, prewetVolume: 60,
      settlingTime: 8, lldMode: 1, swapSpeed: 60,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 1500, cutoffSpeed: 800, stopBackVolume: 0, sideTouchOff: false,
      fixedHeight: 10,
    },
  },

  "StandardVolume_Serum_DispenseSurface_Empty": {
    name: "StandardVolume_Serum_DispenseSurface_Empty",
    liquidType: "Serum",
    description: "Serum surface dispense (300uL tips, foam-safe)",
    correctionByTip: {
      3000: { a0: 2, a1: 1.015, a2: -0.000001 },
      10000: { a0: 3, a1: 1.01, a2: -0.0000002 },
    },
    aspiration: {
      speed: 1200, transportAir: 60, blowoutAir: 350, prewetVolume: 60,
      settlingTime: 8, lldMode: 1, swapSpeed: 60,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 1500, cutoffSpeed: 800, stopBackVolume: 30, sideTouchOff: true,
      fixedHeight: 5,
    },
  },

  "StandardVolume_Plasma_DispenseJet_Empty": {
    name: "StandardVolume_Plasma_DispenseJet_Empty",
    liquidType: "Plasma",
    description: "Plasma transfer (300uL tips, jet empty)",
    correctionByTip: {
      3000: { a0: 2.5, a1: 1.012, a2: -0.0000008 },
      10000: { a0: 3.5, a1: 1.008, a2: -0.0000002 },
    },
    aspiration: {
      speed: 1500, transportAir: 60, blowoutAir: 350, prewetVolume: 60,
      settlingTime: 8, lldMode: 1, swapSpeed: 80,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 2000, cutoffSpeed: 1000, stopBackVolume: 0, sideTouchOff: false,
      fixedHeight: 10,
    },
  },

  // ── Low Volume (50uL tip) classes ────────────────────────────────────

  "LowVolume_Water_DispenseJet_Empty": {
    name: "LowVolume_Water_DispenseJet_Empty",
    liquidType: "Water",
    description: "Small-volume water transfer (<50uL, 50uL tips)",
    correctionByTip: {
      500: { a0: 0.5, a1: 1.025, a2: -0.00003 },
      100: { a0: 0.2, a1: 1.05, a2: -0.0002 },
      3000: { a0: 0.8, a1: 1.015, a2: -0.000005 },
      10000: { a0: 1, a1: 1.01, a2: -0.000001 },
    },
    aspiration: {
      speed: 1500, transportAir: 30, blowoutAir: 200, prewetVolume: 30,
      settlingTime: 5, lldMode: 1, swapSpeed: 50,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 2500, cutoffSpeed: 1500, stopBackVolume: 0, sideTouchOff: false,
      fixedHeight: 10,
    },
  },

  "LowVolume_Water_DispenseSurface_Empty": {
    name: "LowVolume_Water_DispenseSurface_Empty",
    liquidType: "Water",
    description: "Small-volume water surface dispense (50uL tips)",
    correctionByTip: {
      500: { a0: 0.5, a1: 1.025, a2: -0.00003 },
      100: { a0: 0.2, a1: 1.05, a2: -0.0002 },
    },
    aspiration: {
      speed: 1500, transportAir: 30, blowoutAir: 200, prewetVolume: 30,
      settlingTime: 5, lldMode: 1, swapSpeed: 50,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 1500, cutoffSpeed: 800, stopBackVolume: 10, sideTouchOff: true,
      fixedHeight: 5,
    },
  },

  // ── Special liquid classes ───────────────────────────────────────────

  "HighVolume_DMSO_DispenseJet_Empty": {
    name: "HighVolume_DMSO_DispenseJet_Empty",
    liquidType: "DMSO",
    description: "DMSO transfer (higher viscosity, slower speeds)",
    correctionByTip: {
      10000: { a0: 5, a1: 1.015, a2: -0.0000002 },
      3000: { a0: 3, a1: 1.02, a2: -0.000001 },
      500: { a0: 1.5, a1: 1.035, a2: -0.00001 },
    },
    aspiration: {
      speed: 1500, transportAir: 80, blowoutAir: 400, prewetVolume: 80,
      settlingTime: 10, lldMode: 1, swapSpeed: 80,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 2000, cutoffSpeed: 1000, stopBackVolume: 20, sideTouchOff: true,
      fixedHeight: 10,
    },
  },

  "HighVolume_Ethanol_DispenseJet_Empty": {
    name: "HighVolume_Ethanol_DispenseJet_Empty",
    liquidType: "Ethanol",
    description: "Volatile liquid (ADC recommended, pLLD)",
    correctionByTip: {
      10000: { a0: 1, a1: 0.995, a2: 0.0000001 },
      3000: { a0: 0.5, a1: 0.998, a2: 0.0000005 },
    },
    aspiration: {
      speed: 3000, transportAir: 100, blowoutAir: 400, prewetVolume: 0,
      settlingTime: 3, lldMode: 2, swapSpeed: 150,
      submergeDepth: 2.0, liquidFollowing: true,
    },
    dispense: {
      speed: 5000, cutoffSpeed: 3000, stopBackVolume: 50, sideTouchOff: false,
      fixedHeight: 10,
    },
  },

  "HighVolume_Glycerol80_DispenseSurface_Empty": {
    name: "HighVolume_Glycerol80_DispenseSurface_Empty",
    liquidType: "80% Glycerol",
    description: "Highly viscous liquid (very slow speeds, large blow-out)",
    correctionByTip: {
      10000: { a0: 15, a1: 1.04, a2: -0.0000005 },
      3000: { a0: 8, a1: 1.06, a2: -0.000003 },
    },
    aspiration: {
      speed: 500, transportAir: 100, blowoutAir: 500, prewetVolume: 100,
      settlingTime: 20, lldMode: 1, swapSpeed: 30,
      submergeDepth: 3.0, liquidFollowing: true,
    },
    dispense: {
      speed: 500, cutoffSpeed: 300, stopBackVolume: 50, sideTouchOff: true,
      fixedHeight: 5,
    },
  },
};

// ============================================================================
// Backward compatibility aliases (old names → new names)
// ============================================================================

const LIQUID_CLASS_ALIASES: Record<string, string> = {
  "Water_HighVolumeJet_Empty": "HighVolume_Water_DispenseJet_Empty",
  "Water_LowVolumeJet_Empty": "LowVolume_Water_DispenseJet_Empty",
  "DMSO_HighVolumeJet_Empty": "HighVolume_DMSO_DispenseJet_Empty",
  "Serum_HighVolumeSurface_Empty": "StandardVolume_Serum_DispenseSurface_Empty",
  "Ethanol_HighVolumeJet_Empty": "HighVolume_Ethanol_DispenseJet_Empty",
  "Glycerol80_HighVolumeSurface_Empty": "HighVolume_Glycerol80_DispenseSurface_Empty",
};

/**
 * Get a liquid class by name. Supports both VENUS convention and legacy names.
 */
export function getLiquidClass(name: string): LiquidClass | undefined {
  // Direct lookup
  if (LIQUID_CLASSES[name]) return LIQUID_CLASSES[name];
  // Try alias
  const aliased = LIQUID_CLASS_ALIASES[name];
  if (aliased && LIQUID_CLASSES[aliased]) return LIQUID_CLASSES[aliased];
  return undefined;
}

/**
 * List all available liquid class names (canonical VENUS names only).
 */
export function listLiquidClasses(): string[] {
  return Object.keys(LIQUID_CLASSES);
}

/**
 * List all aliases (old name → new name).
 */
export function listLiquidClassAliases(): Record<string, string> {
  return { ...LIQUID_CLASS_ALIASES };
}
