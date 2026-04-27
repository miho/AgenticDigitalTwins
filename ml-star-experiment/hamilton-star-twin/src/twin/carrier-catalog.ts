/**
 * Carrier catalog — single source of truth for carrier geometry.
 *
 * Each entry captures the fixed physical layout of a Hamilton carrier
 * type (PLT_CAR_L5MD, TIP_CAR_480, etc.): how many tracks it spans,
 * how many labware sites it holds, and where those sites sit along the
 * carrier's Y axis. Callers build a concrete `Carrier` at a given
 * track + id via `carrierFromCatalog(type, track, id)`.
 *
 * Rationale: carriers used to be split between
 *   - `CARRIER_TEMPLATES` in deck.ts — hand-curated factory functions
 *   - `venus-deck-importer`'s `buildCarrierFromHamiltonTemplate` path
 *     that reads the real `.tml` file
 * which meant the "default test deck" and "imported VENUS layout" were
 * two parallel construction paths. This module makes the catalog the
 * shared fallback so both paths agree on geometry whenever a `.tml`
 * isn't available on disk.
 *
 * When Hamilton .tml files ARE available (venus-deck-importer with an
 * `installRoot`), they take precedence — this catalog is only consulted
 * when the user has no VENUS install but still wants a sensible default
 * test deck or a synthetic carrier by name.
 */

import type { Carrier } from "./deck";

export interface CarrierCatalogEntry {
  /** Carrier type name (e.g. "PLT_CAR_L5MD"). Matches VENUS .tml stem. */
  type: string;
  /** Category for UI filtering. */
  category: "plate_carrier" | "tip_carrier" | "sample_carrier" | "reagent_carrier" | "built_in" | "unknown";
  /** Optional human-readable description. */
  description?: string;
  /** Track count the carrier physically occupies (1 track = 22.5 mm). */
  widthTracks: number;
  /** Number of labware positions on this carrier. */
  positions: number;
  /** Per-site Y offset from the carrier front edge, 0.1 mm units.
   *  `undefined` means even-distribution fallback (rare — most real
   *  carriers have explicit offsets). */
  siteYOffsets?: number[];
  /** Physical carrier Y dimension (0.1 mm). Standard STAR carriers are
   *  4970 (= 497 mm). */
  yDim: number;
}

/**
 * All carrier types the twin recognises out of the box. Each entry has
 * been cross-checked against its VENUS `.tml` file (see
 * `VENUS-2026-04-13/.../labware/Car/*.tml`) — add new entries by doing
 * the same.
 */
// siteYOffsets are stored pos-0-first, and position 0 maps to the REAR
// of the carrier (largest Y, top in the Y-flipped editor) — the same
// VENUS SiteId-1 convention used by the venus-deck-importer.
export const DEFAULT_CARRIER_CATALOG: readonly CarrierCatalogEntry[] = [
  {
    type: "PLT_CAR_L5MD",
    category: "plate_carrier",
    description: "5-position plate carrier, landscape",
    widthTracks: 6, positions: 5,
    siteYOffsets: [3925, 2965, 2005, 1045, 85],
    yDim: 4970,
  },
  {
    type: "PLT_CAR_L5AC",
    category: "plate_carrier",
    description: "5-position auto-clamp plate carrier (same footprint as L5MD)",
    widthTracks: 6, positions: 5,
    siteYOffsets: [3925, 2965, 2005, 1045, 85],
    yDim: 4970,
  },
  {
    type: "TIP_CAR_480",
    category: "tip_carrier",
    description: "480-tip carrier, 5 positions",
    widthTracks: 6, positions: 5,
    siteYOffsets: [3940, 2980, 2020, 1060, 100],
    yDim: 4970,
  },
  {
    type: "TIP_CAR_480_50",
    category: "tip_carrier",
    description: "480-tip carrier, 50 µL variant (same footprint)",
    widthTracks: 6, positions: 5,
    siteYOffsets: [3940, 2980, 2020, 1060, 100],
    yDim: 4970,
  },
  {
    type: "TIP_CAR_480_BC",
    category: "tip_carrier",
    description: "480-tip carrier with barcode reader",
    widthTracks: 6, positions: 5,
    siteYOffsets: [3940, 2980, 2020, 1060, 100],
    yDim: 4970,
  },
  {
    type: "SMP_CAR_24",
    category: "sample_carrier",
    description: "24-tube sample carrier (even distribution, no explicit offsets)",
    widthTracks: 6, positions: 24,
    yDim: 4970,
  },
  {
    type: "SMP_CAR_32_EPIS",
    category: "sample_carrier",
    description: "32-position Eppendorf tube carrier",
    widthTracks: 6, positions: 32,
    yDim: 4970,
  },
  {
    type: "SMP_CAR_32_12x75",
    category: "sample_carrier",
    description: "32-position 12x75 mm tube carrier",
    widthTracks: 6, positions: 32,
    yDim: 4970,
  },
  {
    type: "RGT_CAR_3R",
    category: "reagent_carrier",
    description: "3-trough reagent carrier",
    widthTracks: 6, positions: 3,
    siteYOffsets: [3400, 1960, 500],
    yDim: 4970,
  },
  {
    type: "RGT_CAR_5R60",
    category: "reagent_carrier",
    description: "5-trough (60 mL) reagent carrier, same site layout as PLT_CAR_L5MD",
    widthTracks: 6, positions: 5,
    siteYOffsets: [3925, 2965, 2005, 1045, 85],
    yDim: 4970,
  },
  {
    type: "WASH_STATION",
    category: "built_in",
    description: "2-chamber wash station (built-in deck module)",
    widthTracks: 6, positions: 2,
    siteYOffsets: [2500, 500],
    yDim: 4970,
  },
  {
    type: "HHS_CAR",
    category: "built_in",
    description: "Heater/shaker carrier, 1 plate position centred",
    widthTracks: 6, positions: 1,
    siteYOffsets: [2000],
    yDim: 4970,
  },
  {
    type: "TCC_CAR",
    category: "built_in",
    description: "Temperature-controlled carrier, 1 plate position centred",
    widthTracks: 6, positions: 1,
    siteYOffsets: [2000],
    yDim: 4970,
  },
];

const CARRIER_INDEX: Map<string, CarrierCatalogEntry> = new Map(
  DEFAULT_CARRIER_CATALOG.map((e) => [e.type, e]),
);

/** O(1) lookup by carrier type. Returns undefined when not in catalog. */
export function findCarrierCatalogEntry(type: string): CarrierCatalogEntry | undefined {
  return CARRIER_INDEX.get(type);
}

/**
 * Build a fresh `Carrier` at the given track/id. Throws when the type
 * isn't in the catalog so mis-typed names fail loudly instead of
 * returning a silently-empty carrier.
 */
export function carrierFromCatalog(type: string, track: number, id: string): Carrier {
  const entry = CARRIER_INDEX.get(type);
  if (!entry) throw new Error(`Carrier type "${type}" not in catalog (carrier-catalog.ts).`);
  const carrier: Carrier = {
    id,
    type: entry.type,
    track,
    widthTracks: entry.widthTracks,
    positions: entry.positions,
    labware: new Array(entry.positions).fill(null),
    yDim: entry.yDim,
  };
  if (entry.siteYOffsets) carrier.siteYOffsets = [...entry.siteYOffsets];
  return carrier;
}

/** Diagnostic: list every catalog type. */
export function listCarrierCatalogTypes(): string[] {
  return Array.from(CARRIER_INDEX.keys()).sort();
}
