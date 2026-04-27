/**
 * Labware Catalog — Unified labware definitions with well geometry and dead volume.
 *

 * Rationale: labware used to be split across three places (`LABWARE_TEMPLATES`
 * in deck.ts, `WELL_GEOMETRIES` in well-geometry.ts, `DEAD_VOLUMES` in
 * liquid-tracker.ts). All three are gone — this module is the sole source
 * of truth for labware geometry + dead volume + well shape.
 *
 * For TwinConfig self-containment (Phase 1, #43), every placed labware must
 * be able to travel *with* its full physical definition inside a serialized
 * trace or session file. This module is the single source of truth that
 * downstream code (well-geometry, liquid-tracker, deck) consults via thin
 * lookups.
 *
 * Units:
 *   - All dimensions in 0.1 mm.
 *   - All volumes in 0.1 µL.
 *   - Dimensions convention matches the existing codebase; do not convert to mm here.
 *
 * Adding a new labware type:
 *   1. Add an entry below.
 *   2. Run `npm run test:unit` — the catalog-consistency test verifies
 *      geometry + dead-volume coherence for every entry.
 */

import type { WellShape, WellGeometry } from "./well-geometry";

/**
 * Complete definition of one labware type. Everything needed for physics,
 * rendering, liquid tracking, and serialization, inlined.
 */
export interface LabwareCatalogEntry {
  /** Canonical type name (e.g. "Cos_96_Rd"). Case-sensitive. Used as the catalog key. */
  type: string;
  /** Grouping for UI and default-selection logic. */
  category: "plate96" | "plate384" | "trough" | "tube" | "tip_rack" | "deep_well" | "wash" | "carrier_specific" | "unknown";
  /** Optional human-readable description. */
  description?: string;

  // --- Well grid geometry (for coordinate resolution + rendering) ---
  /** Rows (A, B, C, ...). 1 for troughs. */
  rows: number;
  /** Columns (1, 2, 3, ...). 1 for troughs. */
  columns: number;
  /** Total well count (rows * columns). Cached for convenience. */
  wellCount: number;
  /** Well-to-well center pitch in 0.1 mm (90 for 96-well, 45 for 384-well, 0 for single-well). */
  wellPitch: number;
  /** X offset from carrier position origin to well A1 center in 0.1 mm. */
  offsetX: number;
  /** Y offset from carrier position origin to well A1 center in 0.1 mm. */
  offsetY: number;

  // --- Labware body dimensions (for collision detection + rendering) ---
  /** Height of labware top above the deck surface in 0.1 mm. */
  height: number;

  // --- Well shape geometry (for physics: volume<->height, LLD simulation) ---
  /** Total well depth in 0.1 mm (well bottom relative to well top). */
  wellDepth: number;
  /** Well shape. Determines the volume↔height curve. */
  wellShape: WellShape;
  /** Inner diameter at well top in 0.1 mm. */
  wellDiameterTop: number;
  /** Inner diameter at well bottom in 0.1 mm (0 for V-bottom). */
  wellDiameterBottom: number;
  /** Corner/hemisphere radius at well bottom in 0.1 mm. */
  cornerRadius: number;

  // --- Liquid handling properties ---
  /** Dead volume in 0.1 µL. Aspirating below this may break LLD or leave residue. */
  deadVolume: number;
  /** Maximum usable well volume in 0.1 µL. 0 = derived from geometry if needed. */
  maxVolume?: number;

  // --- Tip geometry (tip_rack category only) ---
  /** Physical tip total length in 0.1 mm — collar top to tapered point.
   *  Real Hamilton: HT 1000 µL = 950 (~95 mm), ST 300 µL = 600, 50 µL = 350.
   *  Used by venus-steps.tipPickUp/tipEject to compute tp / th based on
   *  actual tip geometry instead of hardcoded guesses. Fitted tips hang
   *  this many 0.1 mm below the PIP nozzle end when in the renderer. */
  tipLength?: number;
  /** Tip collar (grip zone) length in 0.1 mm — the cylindrical mount
   *  section at the top of the tip where the nozzle clamps. Real HT
   *  1000 µL ≈ 115 (11.5 mm). Pickup Z is computed as (rack top +
   *  tipProtrusion − half of collarHeight) so the nozzle lands mid-
   *  collar for a firm grip. */
  tipCollarHeight?: number;
  /** How far the tip collar sticks above the rack top in 0.1 mm.
   *  Racks are designed with a lip that catches the collar; the upper
   *  portion stays above the rack surface so the PIP can access it.
   *  Real Hamilton tips: 1000 µL ≈ 150, 300 µL ≈ 120, 50 µL ≈ 80. */
  tipProtrusion?: number;
  /** True when the real `.ctr` container-geometry file describes a
   *  hemispheric or V-shaped well bottom (shape codes 4 or 5). The
   *  inspector / physics cue off this for "bottom-X µL is impractical
   *  to aspirate cleanly" messaging. Sourced from the canonical .ctr
   *  files shipped with VENUS where possible; false for flat-bottom
   *  labware. */
  hasConicalBottom?: boolean;
}

/**
 * Extract just the `WellGeometry` subset from a catalog entry. Used by
 * `getWellGeometry()` in well-geometry.ts.
 */
export function wellGeometryOf(entry: LabwareCatalogEntry): WellGeometry {
  return {
    shape: entry.wellShape,
    depth: entry.wellDepth,
    diameterTop: entry.wellDiameterTop,
    diameterBottom: entry.wellDiameterBottom,
    cornerRadius: entry.cornerRadius,
  };
}

// ============================================================================
// Default catalog — the single source of truth for labware geometry,
// well shape, and dead volume. Every consumer (deck.ts's factories,
// well-geometry.getWellGeometry, liquid-tracker's dead-volume lookup,
// venus-deck-importer fallback, venus-steps labware placement) resolves
// through here.
// ============================================================================

const MTP_96_DEFAULTS = {
  rows: 8, columns: 12, wellCount: 96,
  wellPitch: 90, offsetX: 33, offsetY: 745,
  height: 144,
};

const MTP_384_DEFAULTS = {
  rows: 16, columns: 24, wellCount: 384,
  wellPitch: 45, offsetX: 10, offsetY: 767,
  height: 144,
};

/** 96-well tip-rack grid defaults. `height` is per-rack (not shared):
 *  1000-µL rack = 60 mm, 300-µL = 50 mm, 50-µL = 35 mm. These are the
 *  physical carrier-slot heights (not tip length) that the renderer +
 *  collision physics need. Tip length itself isn't tracked here because
 *  tips are consumables and we don't model them as liquid-bearing wells. */
const TIP_RACK_GRID_DEFAULTS = {
  rows: 8, columns: 12, wellCount: 96,
  wellPitch: 90, offsetX: 33, offsetY: 745,
};

export const DEFAULT_LABWARE_CATALOG: LabwareCatalogEntry[] = [
  // ── 96-well plates ─────────────────────────────────────────────────────
  // Depth / diameter / hasConicalBottom extracted from the canonical
  // VENUS .ctr files — see tests/unit/ctr-bakeout.test.ts.
  {
    type: "Cos_96_Rd",
    category: "plate96",
    description: "Corning 96 round-bottom polystyrene",
    ...MTP_96_DEFAULTS,
    wellDepth: 113,                  // .ctr: 11.3 mm
    wellShape: "round",
    wellDiameterTop: 69,
    wellDiameterBottom: 69,
    cornerRadius: 34,
    deadVolume: 200,
    maxVolume: 4225,                 // .ctr: 422.5 µL max geometric capacity
    hasConicalBottom: true,          // hemispheric bottom cap
  },
  {
    type: "Cos_96_Fl",
    category: "plate96",
    description: "Corning 96 flat-bottom polystyrene",
    ...MTP_96_DEFAULTS,
    wellDepth: 107,                  // .ctr: 10.67 mm
    wellShape: "flat",
    wellDiameterTop: 69,
    wellDiameterBottom: 69,
    cornerRadius: 0,
    deadVolume: 100,
    maxVolume: 3944,                 // .ctr: 394.4 µL
    hasConicalBottom: false,
  },
  {
    type: "Cos_96_Vb",
    category: "plate96",
    description: "Corning 96 V-bottom polystyrene",
    ...MTP_96_DEFAULTS,
    wellDepth: 109,                  // .ctr: 10.9 mm
    wellShape: "v_bottom",
    wellDiameterTop: 69,
    wellDiameterBottom: 0,
    cornerRadius: 0,
    deadVolume: 100,
    maxVolume: 4076,                 // .ctr: 407.6 µL (cylindrical upper bound)
    hasConicalBottom: true,          // V-shaped bottom
  },

  // ── 384-well plates ────────────────────────────────────────────────────
  {
    type: "Cos_384_Sq",
    category: "plate384",
    description: "Corning 384 square-well polystyrene",
    ...MTP_384_DEFAULTS,
    wellDepth: 116,                  // .ctr: 11.56 mm
    wellShape: "flat",
    wellDiameterTop: 35,             // .ctr: 3.5 mm edge (was 32, wrong)
    wellDiameterBottom: 35,
    cornerRadius: 0,
    deadVolume: 50,
    maxVolume: 1112,                 // .ctr: 111.2 µL
    hasConicalBottom: false,
  },
  {
    type: "Cos_384_Rd",
    category: "plate384",
    description: "Corning 384 round-bottom polystyrene",
    ...MTP_384_DEFAULTS,
    wellDepth: 116,                  // .ctr: 11.56 mm
    wellShape: "round",
    wellDiameterTop: 36,             // .ctr: 3.6 mm
    wellDiameterBottom: 36,
    cornerRadius: 16,
    deadVolume: 101,                 // .ctr cone-derived; was 30, too low
    maxVolume: 1169,                 // .ctr: 116.9 µL
    hasConicalBottom: true,
  },

  // ── Nunc plates ────────────────────────────────────────────────────────
  {
    type: "Nunc_96_Fl",
    category: "plate96",
    description: "Nunc 96 flat-bottom",
    ...MTP_96_DEFAULTS,
    wellDepth: 113,                  // .ctr: 11.3 mm (Nun_96_Fl.ctr)
    wellShape: "flat",
    wellDiameterTop: 70,             // .ctr: 7.0 mm (was 64, off by 6)
    wellDiameterBottom: 70,
    cornerRadius: 0,
    deadVolume: 100,
    maxVolume: 4349,                 // .ctr: 434.9 µL
    hasConicalBottom: false,
  },
  {
    type: "Nunc_384_Sq",
    category: "plate384",
    description: "Nunc 384 square-well",
    ...MTP_384_DEFAULTS,
    wellDepth: 116,                  // matches Cos_384_Sq / Gre_384_Sq
    wellShape: "flat",
    wellDiameterTop: 38,             // Gre_384_Sq .ctr: 3.75 mm square
    wellDiameterBottom: 38,
    cornerRadius: 0,
    deadVolume: 50,
    hasConicalBottom: false,
  },

  // ── Deep-well plates ───────────────────────────────────────────────────
  // `.ctr` extraction: Cos_96_DW_1mL: 40 mm, dia 6.5. Cos_96_DW_2mL:
  //  42 mm, dia 8. Ham_DW_Rgt_96: 44 mm, dia 9, flat bottom.
  {
    type: "Cos_96_DW_1mL",
    category: "deep_well",
    description: "Corning 96 deep-well, 1 mL",
    rows: 8, columns: 12, wellCount: 96,
    wellPitch: 90, offsetX: 33, offsetY: 745,
    height: 410,
    wellDepth: 400,                  // .ctr: 40 mm
    wellShape: "round",
    wellDiameterTop: 65,             // .ctr: 6.5 mm
    wellDiameterBottom: 65,
    cornerRadius: 33,
    deadVolume: 830,                 // .ctr cone volume ~83 µL
    maxVolume: 13273,                // .ctr: 1327 µL
    hasConicalBottom: true,
  },
  {
    type: "Cos_96_DW_2mL",
    category: "deep_well",
    description: "Corning 96 deep-well, 2 mL",
    rows: 8, columns: 12, wellCount: 96,
    wellPitch: 90, offsetX: 33, offsetY: 745,
    height: 430,
    wellDepth: 420,                  // .ctr: 42 mm
    wellShape: "round",
    wellDiameterTop: 80,             // .ctr: 8 mm
    wellDiameterBottom: 80,
    cornerRadius: 40,
    deadVolume: 2011,                // .ctr cone volume ~201 µL (V-bottom)
    maxVolume: 21112,                // .ctr: 2111 µL
    hasConicalBottom: true,
  },
  {
    type: "HAM_DW_12ml",
    category: "deep_well",
    description: "Hamilton 12 mL deep-well (96-style, large wells)",
    rows: 8, columns: 12, wellCount: 96,
    wellPitch: 90, offsetX: 33, offsetY: 745,
    height: 440,
    wellDepth: 440,                  // Ham_DW_Rgt_96 .ctr: 44 mm
    wellShape: "round",
    wellDiameterTop: 90,             // .ctr: 9 mm
    wellDiameterBottom: 90,
    cornerRadius: 0,
    deadVolume: 200,
    maxVolume: 27992,                // .ctr: ~2800 µL (flat bottom)
    hasConicalBottom: false,
  },
  {
    type: "Pfi_96_DW",
    category: "deep_well",
    description: "Pfizer 96 deep-well (approx. Ham_DW footprint)",
    rows: 8, columns: 12, wellCount: 96,
    wellPitch: 90, offsetX: 33, offsetY: 745,
    height: 440,
    wellDepth: 440,
    wellShape: "round",
    wellDiameterTop: 90,
    wellDiameterBottom: 90,
    cornerRadius: 0,
    deadVolume: 200,
    maxVolume: 27992,
    hasConicalBottom: false,
  },

  // ── Troughs ────────────────────────────────────────────────────────────
  {
    type: "Trough_100ml",
    category: "trough",
    description: "100 mL reagent trough",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 563, offsetY: 650,
    height: 400,       // 40 mm — carrier-slot height for the trough body
    wellDepth: 380,    // 38 mm
    wellShape: "flat",
    wellDiameterTop: 800,
    wellDiameterBottom: 800,
    cornerRadius: 0,
    deadVolume: 5000,   // 500 µL
  },
  {
    type: "Trough_300ml",
    category: "trough",
    description: "300 mL reagent trough",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 563, offsetY: 650,
    height: 620,
    wellDepth: 580,
    wellShape: "flat",
    wellDiameterTop: 1200,
    wellDiameterBottom: 1200,
    cornerRadius: 0,
    deadVolume: 10000,  // 1000 µL
  },
  {
    type: "Trough_60ml",
    category: "trough",
    description: "60 mL reagent trough",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 563, offsetY: 650,
    height: 320,
    wellDepth: 280,
    wellShape: "flat",
    wellDiameterTop: 600,
    wellDiameterBottom: 600,
    cornerRadius: 0,
    deadVolume: 3000,   // 300 µL (estimated)
  },

  // ── Tubes ──────────────────────────────────────────────────────────────
  // All three are conical / V-bottom by construction; hasConicalBottom
  // is true. Ground-truth .ctr values for individual tube geometries
  // aren't in the vendored sample set, so depths/diameters here stay
  // at standard manufacturer specs.
  {
    type: "Eppendorf_1.5",
    category: "tube",
    description: "1.5 mL Eppendorf tube",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 3, offsetY: 115,
    height: 400,
    wellDepth: 380,
    wellShape: "conical",
    wellDiameterTop: 87,
    wellDiameterBottom: 0,
    cornerRadius: 0,
    deadVolume: 200,
    hasConicalBottom: true,
  },
  {
    type: "Falcon_15",
    category: "tube",
    description: "15 mL Falcon tube",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 3, offsetY: 115,
    height: 1200,
    wellDepth: 1180,
    wellShape: "conical",
    wellDiameterTop: 147,
    wellDiameterBottom: 0,
    cornerRadius: 0,
    deadVolume: 1000,
    hasConicalBottom: true,
  },
  {
    type: "Falcon_50",
    category: "tube",
    description: "50 mL Falcon tube",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 3, offsetY: 115,
    height: 1170,
    wellDepth: 1150,
    wellShape: "conical",
    wellDiameterTop: 270,
    wellDiameterBottom: 0,
    cornerRadius: 0,
    deadVolume: 2000,
    hasConicalBottom: true,
  },

  // ── Tip racks ──────────────────────────────────────────────────────────
  // Tip racks don't hold liquid in the traditional sense; well geometry is
  // a nominal cylinder used only for channel-position resolution.
  {
    type: "Tips_1000uL",
    category: "tip_rack",
    description: "1000 µL high-volume tip rack",
    ...TIP_RACK_GRID_DEFAULTS,
    height: 600,          // 60 mm carrier-slot height
    wellDepth: 0,         // tip racks don't have wells; tip length tracked by consumable state
    wellShape: "flat",
    wellDiameterTop: 69,
    wellDiameterBottom: 69,
    cornerRadius: 0,
    deadVolume: 0,
    maxVolume: 10000,  // tip capacity
    // Hamilton HT 1000 µL tip — 95 mm total, ~11.5 mm collar, sticks
    // 15 mm above the rack top when seated.
    tipLength: 950,
    tipCollarHeight: 115,
    tipProtrusion: 150,
  },
  {
    type: "Tips_300uL",
    category: "tip_rack",
    description: "300 µL standard tip rack",
    ...TIP_RACK_GRID_DEFAULTS,
    height: 500,          // 50 mm
    wellDepth: 0,
    wellShape: "flat",
    wellDiameterTop: 55,
    wellDiameterBottom: 55,
    cornerRadius: 0,
    deadVolume: 0,
    maxVolume: 3000,
    // Hamilton ST 300 µL tip — 60 mm total, 8 mm collar, 12 mm protrusion.
    tipLength: 600,
    tipCollarHeight: 80,
    tipProtrusion: 120,
  },
  {
    type: "Tips_50uL",
    category: "tip_rack",
    description: "50 µL low-volume tip rack",
    ...TIP_RACK_GRID_DEFAULTS,
    height: 350,          // 35 mm
    wellDepth: 0,
    wellShape: "flat",
    wellDiameterTop: 50,
    wellDiameterBottom: 50,
    cornerRadius: 0,
    deadVolume: 0,
    maxVolume: 500,
    // Hamilton 50 µL tip — 35 mm total, 5 mm collar, 8 mm protrusion.
    tipLength: 350,
    tipCollarHeight: 50,
    tipProtrusion: 80,
  },

  // ── Carrier-specific labware ───────────────────────────────────────────
  {
    type: "Wash_Chamber",
    category: "wash",
    description: "Wash station chamber",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 563, offsetY: 975,
    height: 200,
    wellDepth: 180,
    wellShape: "flat",
    wellDiameterTop: 800,
    wellDiameterBottom: 800,
    cornerRadius: 0,
    deadVolume: 0,
  },
  {
    type: "HHS_Plate_96",
    category: "carrier_specific",
    description: "Heater-shaker 96-well plate position",
    ...MTP_96_DEFAULTS,
    wellDepth: 113,                  // matches Cos_96_Rd
    wellShape: "round",
    wellDiameterTop: 69,
    wellDiameterBottom: 69,
    cornerRadius: 34,
    deadVolume: 200,
    hasConicalBottom: true,
  },
  {
    type: "TCC_Plate_96",
    category: "carrier_specific",
    description: "Temperature controller 96-well plate position",
    ...MTP_96_DEFAULTS,
    wellDepth: 113,
    wellShape: "round",
    wellDiameterTop: 69,
    wellDiameterBottom: 69,
    cornerRadius: 34,
    deadVolume: 200,
    hasConicalBottom: true,
  },

  {
    type: "COREGripTool",
    category: "carrier_specific",
    description: "CO-RE gripper tool parked on the waste block",
    rows: 1, columns: 1, wellCount: 1,
    wellPitch: 0, offsetX: 563, offsetY: 400,
    height: 100,
    wellDepth: 0,
    wellShape: "flat",
    wellDiameterTop: 0,
    wellDiameterBottom: 0,
    cornerRadius: 0,
    deadVolume: 0,
  },
];

// ============================================================================
// Catalog lookup
// ============================================================================

/**
 * Build the type → entry index once at module load time. The catalog itself
 * is treated as read-only; entries are looked up in O(1).
 */
const CATALOG_INDEX: Map<string, LabwareCatalogEntry> = new Map(
  DEFAULT_LABWARE_CATALOG.map((entry) => [entry.type, entry])
);

/**
 * Look up a labware definition by type.
 *
 * @returns The entry, or `undefined` if the type isn't in the catalog.
 *   Callers that want heuristic fallback should use `getWellGeometry()` in
 *   well-geometry.ts, which wraps this lookup and returns a safe default
 *   when no catalog entry matches.
 */
export function findCatalogEntry(labwareType: string): LabwareCatalogEntry | undefined {
  return CATALOG_INDEX.get(labwareType);
}

/**
 * Look up dead volume by labware type. Prefix-matches if no exact entry.
 * Returns `DEFAULT_DEAD_VOLUME` (10 µL = 100 in 0.1 µL) if nothing matches.
 *
 * This replaces the hardcoded `DEAD_VOLUMES` table in liquid-tracker.ts.
 */
export const DEFAULT_DEAD_VOLUME = 100;

export function catalogDeadVolume(labwareType: string): number {
  const entry = CATALOG_INDEX.get(labwareType);
  if (entry) return entry.deadVolume;
  // Prefix fallback — matches legacy behavior in liquid-tracker.getDeadVolume().
  for (const [key, val] of CATALOG_INDEX) {
    if (labwareType.startsWith(key)) return val.deadVolume;
  }
  return DEFAULT_DEAD_VOLUME;
}

/**
 * Diagnostic: list every catalog type. Used by the consistency test.
 */
export function listCatalogTypes(): string[] {
  return Array.from(CATALOG_INDEX.keys()).sort();
}

/**
 * Build a `LabwareItem` (the deck-side labware representation) from a
 * catalog type name. Returns `undefined` when the type isn't cataloged
 * so callers can fall back or surface an error; never silently fabricate.
 *
 * Single source of truth for labware geometry — deck.ts, venus-steps,
 * and venus-deck-importer all route through this.
 */
export function labwareItemFromCatalog(labwareType: string): {
  type: string;
  wellCount: number;
  rows: number;
  columns: number;
  wellPitch: number;
  offsetX: number;
  offsetY: number;
  height: number;
  wellDepth: number;
  maxVolume?: number;
  deadVolume?: number;
  hasConicalBottom?: boolean;
  tipLength?: number;
  tipCollarHeight?: number;
  tipProtrusion?: number;
} | undefined {
  const entry = CATALOG_INDEX.get(labwareType);
  if (!entry) return undefined;
  return {
    type: entry.type,
    wellCount: entry.wellCount,
    rows: entry.rows,
    columns: entry.columns,
    wellPitch: entry.wellPitch,
    offsetX: entry.offsetX,
    offsetY: entry.offsetY,
    height: entry.height,
    wellDepth: entry.wellDepth,
    ...(entry.maxVolume !== undefined ? { maxVolume: entry.maxVolume } : {}),
    deadVolume: entry.deadVolume,
    ...(entry.hasConicalBottom !== undefined ? { hasConicalBottom: entry.hasConicalBottom } : {}),
    // Tip geometry — propagated so the deck placement carries real
    // Hamilton-spec dimensions into venus-steps for tp/th computation.
    ...(entry.tipLength !== undefined ? { tipLength: entry.tipLength } : {}),
    ...(entry.tipCollarHeight !== undefined ? { tipCollarHeight: entry.tipCollarHeight } : {}),
    ...(entry.tipProtrusion !== undefined ? { tipProtrusion: entry.tipProtrusion } : {}),
  };
}
