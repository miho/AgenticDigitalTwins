/**
 * Well Geometry — Volume ↔ Z-Height Calculations
 *
 * Calculates liquid surface height from well shape + volume, and vice versa.
 * Essential for:
 * - LLD (liquid level detection) simulation
 * - Submerge depth calculation
 * - Crash detection (tip hits bottom)
 * - Z-height → remaining volume estimation
 *
 * All dimensions in 0.1mm, volumes in 0.1uL.
 *
 * Well shapes:
 *   flat       — cylindrical, flat bottom (most 96-well plates)
 *   round      — cylinder with hemispherical bottom (round-bottom plates)
 *   conical    — cone transitioning to cylinder (V-bottom plates, tubes)
 *   v_bottom   — pure conical well (small V-bottom plates)
 *
 * Reference: Hamilton labware definitions store these as:
 *   wellShape, wellDiameterTop, wellDiameterBottom, wellDepth, cornerRadius
 */

// ============================================================================
// Types
// ============================================================================

export type WellShape = "flat" | "round" | "conical" | "v_bottom";

/** Geometry parameters for a single well */
export interface WellGeometry {
  /** Well shape */
  shape: WellShape;
  /** Total well depth in 0.1mm */
  depth: number;
  /** Inner diameter at top of well in 0.1mm */
  diameterTop: number;
  /** Inner diameter at bottom of well in 0.1mm (0 for V-bottom) */
  diameterBottom: number;
  /** Corner radius at bottom in 0.1mm (for round-bottom wells) */
  cornerRadius: number;
}

/** Result of an LLD detection */
export interface LLDResult {
  /** Whether liquid was detected */
  detected: boolean;
  /** Z-height of liquid surface from well bottom (0.1mm) */
  liquidSurfaceZ: number;
  /** Z-height of well top from deck surface (0.1mm, absolute) */
  wellTopZ: number;
  /** Submerge depth if tip goes to liquid surface (0.1mm) */
  submergeDepth: number;
  /** Volume at detected height (0.1uL) */
  volumeAtSurface: number;
  /** Whether tip would crash into well bottom at the given Z */
  crashRisk: boolean;
}

// ============================================================================
// Volume → Height calculations
// ============================================================================

/**
 * Calculate liquid surface height from well geometry and volume.
 *
 * @param geo - Well geometry parameters
 * @param volume - Liquid volume in 0.1uL
 * @returns Height of liquid surface from well bottom in 0.1mm
 *
 * Note: 1 uL = 1 mm^3, so 0.1uL = 0.1mm^3.
 * But our dimensions are in 0.1mm, so:
 *   volume_in_0.1mm^3 = volume_in_0.1uL * 1000
 *   (because (0.1mm)^3 = 0.001 mm^3 = 0.001 uL = 0.01 * 0.1uL)
 *
 * Actually: 1 mm^3 = 1 uL, and our units are 0.1mm and 0.1uL.
 * Volume in real mm^3 = volume_01ul / 10
 * Radius in real mm = radius_01mm / 10
 * Height in real mm = h_real
 * We'll compute in real mm then convert back to 0.1mm.
 */
export function volumeToHeight(geo: WellGeometry, volume_01ul: number): number {
  if (volume_01ul <= 0) return 0;

  // Convert to real units (mm, uL=mm^3)
  const V = volume_01ul / 10;           // mm^3 (= uL)
  const depth = geo.depth / 10;          // mm
  const rTop = geo.diameterTop / 20;     // mm (radius)
  const rBot = geo.diameterBottom / 20;  // mm
  const cornerR = geo.cornerRadius / 10; // mm

  let h_mm: number;

  switch (geo.shape) {
    case "flat": {
      // Simple cylinder: V = pi * r^2 * h
      const r = rBot > 0 ? rBot : rTop;
      const area = Math.PI * r * r;
      h_mm = area > 0 ? V / area : 0;
      break;
    }

    case "round": {
      // Hemisphere bottom (radius = cornerR or half of diameterBottom) + cylinder
      const sphereR = cornerR > 0 ? cornerR : rBot;
      const cylR = rBot > 0 ? rBot : rTop;

      // Volume of hemisphere cap: V_cap = pi * h^2 * (3R - h) / 3
      // Full hemisphere volume: V_hemi = (2/3) * pi * R^3
      const V_hemi = (2 / 3) * Math.PI * sphereR * sphereR * sphereR;

      if (V <= V_hemi) {
        // Liquid is within the hemisphere
        // Solve: V = pi * h^2 * (3R - h) / 3 for h
        // Use Newton's method
        h_mm = solveHemisphereHeight(V, sphereR);
      } else {
        // Hemisphere full + cylinder above
        const V_cyl = V - V_hemi;
        const cylArea = Math.PI * cylR * cylR;
        h_mm = sphereR + (cylArea > 0 ? V_cyl / cylArea : 0);
      }
      break;
    }

    case "conical": {
      // Cone at bottom transitioning to cylinder at top
      // Cone height = depth where diameter goes from diameterBottom to diameterTop
      // For a tapered well: r(h) = rBot + (rTop - rBot) * h / depth
      // V_cone(h) = pi/3 * h * (r(0)^2 + r(0)*r(h) + r(h)^2) — frustum formula

      if (rBot === 0) {
        // Pure cone (V-bottom equivalent): V = pi/3 * h * r(h)^2
        // where r(h) = rTop * h / depth
        // V = pi/3 * h * (rTop * h / depth)^2 = pi * rTop^2 * h^3 / (3 * depth^2)
        // h = cbrt(3 * V * depth^2 / (pi * rTop^2))
        const coeff = Math.PI * rTop * rTop / (3 * depth * depth);
        h_mm = coeff > 0 ? Math.cbrt(V / coeff) : 0;
      } else {
        // Tapered frustum: use numerical approach
        h_mm = solveFrustumHeight(V, rBot, rTop, depth);
      }
      break;
    }

    case "v_bottom": {
      // Pure V-bottom (cone only): V = pi/3 * r^2 * h
      // With r proportional to h: r = rTop * h / depth
      // V = pi/3 * (rTop * h / depth)^2 * h = pi * rTop^2 * h^3 / (3 * depth^2)
      const maxR = rTop > 0 ? rTop : rBot;
      const coeff = Math.PI * maxR * maxR / (3 * depth * depth);
      h_mm = coeff > 0 ? Math.cbrt(V / coeff) : 0;
      break;
    }

    default:
      // Fallback: treat as flat cylinder
      const r = rBot > 0 ? rBot : rTop;
      const area = Math.PI * r * r;
      h_mm = area > 0 ? V / area : 0;
  }

  // Clamp to well depth
  h_mm = Math.min(h_mm, depth);

  // Convert back to 0.1mm
  return Math.round(h_mm * 10);
}

/**
 * Calculate volume from liquid height in a well.
 *
 * @param geo - Well geometry
 * @param height_01mm - Liquid height from bottom in 0.1mm
 * @returns Volume in 0.1uL
 */
export function heightToVolume(geo: WellGeometry, height_01mm: number): number {
  if (height_01mm <= 0) return 0;

  const h = Math.min(height_01mm / 10, geo.depth / 10);  // mm, clamped
  const rTop = geo.diameterTop / 20;
  const rBot = geo.diameterBottom / 20;
  const cornerR = geo.cornerRadius / 10;
  const depth = geo.depth / 10;

  let V_mm3: number;

  switch (geo.shape) {
    case "flat": {
      const r = rBot > 0 ? rBot : rTop;
      V_mm3 = Math.PI * r * r * h;
      break;
    }

    case "round": {
      const sphereR = cornerR > 0 ? cornerR : rBot;
      const cylR = rBot > 0 ? rBot : rTop;

      if (h <= sphereR) {
        // Within hemisphere
        V_mm3 = Math.PI * h * h * (3 * sphereR - h) / 3;
      } else {
        // Hemisphere + cylinder
        const V_hemi = (2 / 3) * Math.PI * sphereR * sphereR * sphereR;
        V_mm3 = V_hemi + Math.PI * cylR * cylR * (h - sphereR);
      }
      break;
    }

    case "conical": {
      if (rBot === 0) {
        // Pure cone
        const rAtH = rTop * h / depth;
        V_mm3 = Math.PI * rAtH * rAtH * h / 3;
      } else {
        // Frustum: V = pi*h/3 * (r1^2 + r1*r2 + r2^2)
        const rAtH = rBot + (rTop - rBot) * h / depth;
        V_mm3 = Math.PI * h / 3 * (rBot * rBot + rBot * rAtH + rAtH * rAtH);
      }
      break;
    }

    case "v_bottom": {
      const maxR = rTop > 0 ? rTop : rBot;
      const rAtH = maxR * h / depth;
      V_mm3 = Math.PI * rAtH * rAtH * h / 3;
      break;
    }

    default: {
      const r = rBot > 0 ? rBot : rTop;
      V_mm3 = Math.PI * r * r * h;
    }
  }

  // Convert mm^3 (=uL) to 0.1uL
  return Math.round(V_mm3 * 10);
}

// ============================================================================
// LLD simulation
// ============================================================================

/**
 * Simulate liquid level detection for a well.
 *
 * @param geo - Well geometry
 * @param volume_01ul - Current liquid volume in 0.1uL
 * @param wellTopZ_01mm - Z-height of well top from deck surface (0.1mm)
 * @param lldMode - 0=off, 1=cLLD, 2=pLLD, 3=dual
 * @param tipZ_01mm - Current tip Z position from deck surface (0.1mm)
 * @returns LLD detection result
 */
export function simulateLLD(
  geo: WellGeometry,
  volume_01ul: number,
  wellTopZ_01mm: number,
  lldMode: number,
  tipZ_01mm: number
): LLDResult {
  const surfaceHeight = volumeToHeight(geo, volume_01ul);
  const wellBottomZ = wellTopZ_01mm - geo.depth;
  const liquidSurfaceAbsolute = wellBottomZ + surfaceHeight;

  // Can the LLD detect liquid?
  let detected = false;
  const minDetectableHeight = 5; // 0.5mm minimum liquid height for detection

  if (volume_01ul > 0 && surfaceHeight >= minDetectableHeight) {
    switch (lldMode) {
      case 1: // cLLD — capacitive, works with aqueous/conductive liquids
        // Detects within ~1mm of surface
        detected = tipZ_01mm <= liquidSurfaceAbsolute + 10;
        break;
      case 2: // pLLD — pressure-based, works with all liquids
        // Detects on contact with surface
        detected = tipZ_01mm <= liquidSurfaceAbsolute;
        break;
      case 3: // Dual — both
        detected = tipZ_01mm <= liquidSurfaceAbsolute + 10;
        break;
      default: // LLD off
        detected = false;
    }
  }

  // Submerge depth: how far below liquid surface the tip is
  const submergeDepth = Math.max(0, liquidSurfaceAbsolute - tipZ_01mm);

  // Crash risk: tip at or below well bottom
  const crashRisk = tipZ_01mm <= wellBottomZ;

  return {
    detected,
    liquidSurfaceZ: surfaceHeight,
    wellTopZ: wellTopZ_01mm,
    submergeDepth,
    volumeAtSurface: volume_01ul,
    crashRisk,
  };
}

/**
 * Calculate the recommended Z position for aspiration/dispense.
 *
 * @param geo - Well geometry
 * @param volume_01ul - Current liquid volume
 * @param wellTopZ_01mm - Well top Z from deck surface
 * @param submergeDepth_01mm - Desired submerge depth below liquid surface (0.1mm)
 * @returns Recommended Z position from deck surface (0.1mm), or null if insufficient liquid
 */
export function calculatePipetteZ(
  geo: WellGeometry,
  volume_01ul: number,
  wellTopZ_01mm: number,
  submergeDepth_01mm: number = 20 // Default 2mm submerge
): number | null {
  if (volume_01ul <= 0) return null;

  const surfaceHeight = volumeToHeight(geo, volume_01ul);
  const wellBottomZ = wellTopZ_01mm - geo.depth;
  const liquidSurfaceAbsolute = wellBottomZ + surfaceHeight;

  // Target Z = liquid surface - submerge depth
  const targetZ = liquidSurfaceAbsolute - submergeDepth_01mm;

  // Don't go below well bottom + 2mm safety margin
  const minZ = wellBottomZ + 20;
  if (targetZ < minZ) return null;  // Not enough liquid for safe submerge

  return Math.round(targetZ);
}

/**
 * Calculate the cross-section area of a well at a given height.
 * Used for liquid following: how much the surface drops per unit volume aspirated.
 * @param geo - Well geometry
 * @param height_01mm - Height from well bottom in 0.1mm
 * @returns Cross-section area in mm^2 (NOT 0.1mm units -- in real mm^2)
 */
export function wellCrossSectionAt(geo: WellGeometry, height_01mm: number): number {
  const h = Math.max(0, height_01mm / 10);  // real mm
  const depth = geo.depth / 10;
  const rTop = geo.diameterTop / 20;
  const rBot = geo.diameterBottom / 20;

  switch (geo.shape) {
    case "flat": {
      const r = rBot > 0 ? rBot : rTop;
      return Math.PI * r * r;
    }
    case "round": {
      const sphereR = geo.cornerRadius > 0 ? geo.cornerRadius / 10 : rBot;
      if (h <= sphereR) {
        // Within hemisphere: cross section = pi * (2Rh - h^2)
        return Math.PI * (2 * sphereR * h - h * h);
      }
      const cylR = rBot > 0 ? rBot : rTop;
      return Math.PI * cylR * cylR;
    }
    case "conical":
    case "v_bottom": {
      // r(h) = rBot + (rTop - rBot) * h / depth
      const r = rBot + (rTop - rBot) * Math.min(h, depth) / depth;
      return Math.PI * r * r;
    }
    default: {
      const r = rBot > 0 ? rBot : rTop;
      return Math.PI * r * r;
    }
  }
}

/**
 * Get the well geometry for a labware type.
 *
 * Resolves via the labware-catalog single source of truth; falls back to
 * a heuristic based on the type name (Rd/round → round-bottom, Vb →
 * V-bottom, otherwise flat cylinder) only for labware not yet in the
 * catalog. There is no separate legacy table — the catalog covers every
 * type we know about.
 */
export function getWellGeometry(labwareType: string): WellGeometry {
  // Lazy-require to avoid a circular import between labware-catalog and well-geometry.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { findCatalogEntry, wellGeometryOf } = require("./labware-catalog");
  const entry = findCatalogEntry(labwareType);
  if (entry) return wellGeometryOf(entry);

  // Heuristic fallback for unknown types.
  if (labwareType.includes("Rd") || labwareType.includes("round")) {
    return { shape: "round", depth: 112, diameterTop: 69, diameterBottom: 69, cornerRadius: 34 };
  }
  if (labwareType.includes("Vb") || labwareType.includes("v_bottom")) {
    return { shape: "v_bottom", depth: 112, diameterTop: 69, diameterBottom: 0, cornerRadius: 0 };
  }
  return { shape: "flat", depth: 112, diameterTop: 69, diameterBottom: 69, cornerRadius: 0 };
}

// ============================================================================
// Numerical solvers (private)
// ============================================================================

/** Solve hemisphere cap height from volume using Newton's method */
function solveHemisphereHeight(V: number, R: number): number {
  // V = pi * h^2 * (3R - h) / 3
  // dV/dh = pi * h * (2R - h)
  let h = Math.cbrt(3 * V / Math.PI);  // Initial guess
  for (let i = 0; i < 20; i++) {
    const f = Math.PI * h * h * (3 * R - h) / 3 - V;
    const df = Math.PI * h * (2 * R - h);
    if (Math.abs(df) < 1e-12) break;
    const dh = f / df;
    h -= dh;
    h = Math.max(0, Math.min(h, R));
    if (Math.abs(dh) < 1e-6) break;
  }
  return Math.max(0, h);
}

/** Solve frustum height from volume using Newton's method */
function solveFrustumHeight(V: number, rBot: number, rTop: number, depth: number): number {
  // r(h) = rBot + (rTop - rBot) * h / depth
  // V(h) = pi*h/3 * (rBot^2 + rBot*r(h) + r(h)^2)
  let h = V / (Math.PI * rBot * rBot) || 1;  // Initial guess: cylinder
  h = Math.min(h, depth);

  for (let i = 0; i < 20; i++) {
    const rH = rBot + (rTop - rBot) * h / depth;
    const Vh = Math.PI * h / 3 * (rBot * rBot + rBot * rH + rH * rH);
    const drH = (rTop - rBot) / depth;
    const dVh = Math.PI / 3 * (rBot * rBot + rBot * rH + rH * rH)
              + Math.PI * h / 3 * (rBot * drH + 2 * rH * drH);

    if (Math.abs(dVh) < 1e-12) break;
    const dh = (Vh - V) / dVh;
    h -= dh;
    h = Math.max(0, Math.min(h, depth));
    if (Math.abs(dh) < 1e-6) break;
  }
  return Math.max(0, h);
}
