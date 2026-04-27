/**
 * Deck Model
 *
 * Models the Hamilton STAR deck geometry:
 * - Track-based coordinate system (54 or 30 tracks at 22.5mm pitch)
 * - Carrier registry (which carrier at which track, how wide)
 * - Labware positions on carriers (wells, tubes at specific coordinates)
 * - Coordinate conversion: track+position -> X/Y in 0.1mm (FW units)
 *
 * All coordinates are in 0.1mm (firmware units) unless noted.
 * The deck origin (0,0) is at the left-rear corner.
 * X-axis runs left-to-right. Y-axis runs rear-to-front.
 */

import { catalogDeadVolume, labwareItemFromCatalog } from "./labware-catalog";
import { carrierFromCatalog } from "./carrier-catalog";

// ============================================================================
// Constants from the STAR hardware specification
// ============================================================================

/** Track pitch in 0.1 mm — every carrier/labware/deck-renderer import
 *  this; never re-declare locally. */
export const TRACK_PITCH = 225;  // 22.5 mm

/** Deck parameters per platform */
export const PLATFORM = {
  STAR: {
    name: "Microlab STAR",
    totalTracks: 54,
    deckWidth_01mm: 12150,  // 1215mm
    /** X offset from track 1 to the deck origin (0.1mm) */
    xOffset: 1000,  // 100mm from left edge to track 1 center
  },
  STARlet: {
    name: "Microlab STARlet",
    totalTracks: 30,
    deckWidth_01mm: 6750,   // 675mm
    xOffset: 1000,
  },
} as const;

/** Physical Y-axis bounds of the carrier slot area (0.1 mm).
 *  - `Y_FRONT_EDGE` — front edge (closest to operator).
 *  - `Y_REAR_EDGE`  — rear edge; 630 + 4970 (a standard 497 mm carrier).
 *  - `CARRIER_Y_DIM` — physical carrier height, same 4970.
 *  - `POSITION_FALLBACK_Y_REAR` — the last-labware-Y heuristic used for
 *    even-distribution fallback when a carrier has no explicit
 *    `siteYOffsets`. Not a physical bound; real .lay imports always carry
 *    offsets and bypass this. Centralised here so deck-tracker and
 *    venus-layout stop re-declaring divergent values under the same name.
 *
 *  Every other file that needs these imports from here — never re-declare
 *  locally. */
export const Y_FRONT_EDGE = 630;
export const Y_REAR_EDGE = 5600;
export const CARRIER_Y_DIM = Y_REAR_EDGE - Y_FRONT_EDGE;  // 4970
export const POSITION_FALLBACK_Y_REAR = 4530;
const Y_PLATE_A1 = 1460;    // Typical A1 position for landscape plate

/** Z-axis constants (0.1mm) */
const Z_DECK_SURFACE = 0;        // Deck surface reference
const Z_TRAVERSE_HEIGHT = 1450;   // 145mm safe travel height
const Z_MAX = 2500;               // 250mm maximum Z

// ============================================================================
// Types
// ============================================================================

export type PlatformType = "STAR" | "STARlet";

/** A carrier placed on the deck */
export interface Carrier {
  /** Unique ID (e.g. "PLT_CAR_L5MD_12345") */
  id: string;
  /** Carrier type name (e.g. "PLT_CAR_L5MD") */
  type: string;
  /** Leftmost track number (1-based) */
  track: number;
  /** Width in tracks */
  widthTracks: number;
  /** Number of labware positions on this carrier */
  positions: number;
  /** Labware items on this carrier (indexed by position, 0-based) */
  labware: (LabwareItem | null)[];
  /** Per-site Y offsets from carrier front edge in 0.1mm units.
   *  If provided, these override the even-division model.
   *  Index matches position index. */
  siteYOffsets?: number[];
  /** Physical Y dimension of carrier in 0.1mm (e.g. 4970 for 497mm standard carrier).
   *  Used for rendering the carrier rect at its actual physical size. */
  yDim?: number;
  /** Barcode (if read) */
  barcode?: string;
}

/** A labware item on a carrier */
export interface LabwareItem {
  /** Labware type name (e.g. "Cos_96_Rd", "Tips_1000uL") */
  type: string;
  /** Number of wells/positions (96, 384, 1536, 24 for tubes, etc.) */
  wellCount: number;
  /** Rows x Columns */
  rows: number;
  columns: number;
  /** Well pitch in 0.1mm (90 for 96-well, 45 for 384-well) */
  wellPitch: number;
  /** Offset from carrier left edge to A1 well center (0.1mm) */
  offsetX: number;
  /** Offset from carrier front edge to A1 well center (0.1mm) */
  offsetY: number;
  /** Height of the labware top above deck (0.1mm) */
  height: number;
  /** Well depth (0.1mm) */
  wellDepth: number;
  /** Maximum usable well volume, 0.1 µL. Sourced from the .ctr
   *  segment geometry when the container file is resolvable on disk;
   *  falls back to 0 (unknown) for labware without a .ctr. */
  maxVolume?: number;
  /** Dead volume — the liquid that can't be aspirated out of this
   *  well, 0.1 µL. Sourced from the .ctr's conical bottom segment
   *  when available, else from the labware catalog. */
  deadVolume?: number;
  /** True when the .ctr describes a conical / tapered bottom. The
   *  inspector / physics can cue off this (e.g. to flag that the
   *  last N µL are impractical to aspirate cleanly). */
  hasConicalBottom?: boolean;
  /** Outer rack footprint in 0.1 mm. Hamilton SBS plate is 1277 × 854,
   *  tip-300 rack is 1224 × 826. Sourced from the .rck `Dim.Dx/Dy`
   *  when loaded via the Hamilton config loader; falls back to a
   *  derived-from-wells estimate when unset so legacy hardcoded
   *  templates keep rendering. */
  rackDx?: number;
  rackDy?: number;
  /** Outer rack height in 0.1 mm — the labware's own body thickness
   *  (`Dim.Dz` from the .rck). Distinct from `height`, which is the
   *  `ZTrans` stacking coordinate (well A1 top above deck). Used by
   *  the 3D renderer to draw labware at its real thickness instead of
   *  turning a 20 mm tip-rack into a 200 mm "skyscraper". */
  rackDz?: number;
  /** Well / tip hole diameter in 0.1 mm (`Hole.X` from the .rck —
   *  Hamilton writes the same value to X/Y/Z for circular holes).
   *  The 3D renderer uses this to draw wells/tips at their real
   *  aperture size instead of a pitch-derived estimate. */
  holeDiameter?: number;
  /** Hamilton hole-shape code (0 = round, 1 = square/rect). When
   *  non-zero the 3D renderer cuts a rectangular cavity in the rack
   *  top instead of a cylinder. */
  holeShape?: number;
  /** Distance from the rack's outer edge to the row-A / column-1 well
   *  centres, 0.1 mm. Needed so the renderer draws the rack body
   *  correctly flush around the well grid — a 96-well plate has
   *  `bndryY ≈ 115` (11.5 mm), a 300-µL tip rack has `bndryY ≈ 98`
   *  (9.8 mm), SBS boundary. Unset → fall back to pitch × 0.6. */
  bndryX?: number;
  bndryY?: number;
  /** Signed Z-offset of the container's internal origin relative to
   *  the rack's top face, 0.1 mm. Sourced from `Cntr.1.base` in the
   *  .rck. Negative (the common case) means the well bottom sits
   *  BELOW the rack top; the 3D view subtracts |this| from the total
   *  well depth to get the *visible* portion (e.g. the 11.5 mm tip
   *  collar on a 95 mm HT tip: base=-83.5 → visible=95-83.5). */
  containerBase?: number;
  /** Tip geometry — present only for tip_rack labware. Copied from the
   *  labware catalog at labware-placement time so the step generator
   *  and renderer have direct access without a catalog lookup. Used
   *  by venus-steps.tipPickUp to compute tp (pickup Z) and th
   *  (post-retract Z) from the ACTUAL tip dimensions instead of
   *  hardcoded constants. Units: 0.1 mm. */
  tipLength?: number;
  tipCollarHeight?: number;
  tipProtrusion?: number;
  /** Barcode (if read) */
  barcode?: string;
  /** Current well contents (volume in 0.1ul per well, sparse) */
  wellVolumes?: Map<number, number>;
}

/** An absolute position on the deck in FW coordinates */
export interface DeckPosition {
  x: number;   // 0.1mm from deck origin
  y: number;   // 0.1mm from deck origin
  z: number;   // 0.1mm from deck surface
}

/** A well address on labware */
export interface WellAddress {
  carrierId: string;
  position: number;   // Carrier position (0-based)
  row: number;        // 0-based (A=0, B=1, ...)
  column: number;     // 0-based
}

/** A non-track fixture on the deck — 96-head waste, gripper park, slide
 *  waste, puncher, left/right decorative edges, etc. Sourced from the
 *  `.dck` file's Site entries that don't match the `NT-N` track pattern.
 *
 *  `kind` is our coarse classification used by the renderer to pick a
 *  colour / glyph. We derive it from the raw `id` string because
 *  Hamilton doesn't expose a type field — see `classifyFixture` in
 *  `venus-deck-importer.ts`. */
export interface DeckFixture {
  /** Raw site id from the .dck (e.g. "WasteBlock", "96CORESlideWaste"). */
  id: string;
  /** Rect in 0.1mm deck coords (to match the rest of the twin's frame). */
  x: number;
  y: number;
  dx: number;
  dy: number;
  visible: boolean;
  kind: "tipwaste96" | "tipwaste96slide" | "wasteblock" | "puncher"
      | "edge" | "other";
}

// ============================================================================
// Deck class
// ============================================================================

export class Deck {
  readonly platform: PlatformType;
  readonly totalTracks: number;
  readonly xOffset: number;

  private carriers: Map<string, Carrier> = new Map();
  /** Track occupancy: track number -> carrier ID */
  private trackMap: Map<number, string> = new Map();

  /** Tip waste: fixed position, counts ejected tips */
  tipWaste = {
    track: 52,       // Default tip waste at tracks 52-54
    widthTracks: 3,
    tipCount: 0,     // Total ejected tips
    capacity: 960,   // Max tips before full
  };

  /** Non-track fixtures (waste blocks, puncher, decorative edges)
   *  populated from the loaded `.dck`. Empty when no deck file has
   *  been imported (fresh default deck). Consumed by the renderer to
   *  draw the gaps VENUS shows between carrier slots. */
  fixtures: DeckFixture[] = [];

  constructor(platform: PlatformType = "STAR") {
    this.platform = platform;
    const p = PLATFORM[platform];
    this.totalTracks = p.totalTracks;
    this.xOffset = p.xOffset;
  }

  /**
   * Get tip waste eject coordinates for PIP channels.
   *
   * Real PIP channels are mechanically fixed at 9 mm pitch — you CANNOT spread
   * them across a 400 mm waste. We return channels at that real pitch,
   * centered inside the waste Y span. Ch0 is rearmost (highest Y) per
   * Hamilton convention.
   *
   * Returns { x, yChannels[], z } in 0.1 mm units.
   */
  getWasteEjectPositions(channelCount: number = 8): { x: number; yChannels: number[]; z: number } {
    const wasteX = this.trackToX(this.tipWaste.track + 1);  // Center track
    const { yMin, yMax } = this.getTipWasteYRange();
    const yCenter = (yMin + yMax) / 2;
    const CHANNEL_PITCH_01MM = 90;  // 9 mm, same as the arm's mechanical pitch
    const z = 100;

    const yChannels: number[] = [];
    if (channelCount <= 1) {
      yChannels.push(Math.round(yCenter));
    } else {
      // Centered block of `channelCount` channels at fixed 9 mm pitch.
      // Ch0 = rear (highest Y), ChN-1 = front (lowest Y).
      const halfSpan = ((channelCount - 1) * CHANNEL_PITCH_01MM) / 2;
      const ch0Y = yCenter + halfSpan;
      for (let ch = 0; ch < channelCount; ch++) {
        yChannels.push(Math.round(ch0Y - ch * CHANNEL_PITCH_01MM));
      }
    }

    return { x: Math.round(wasteX), yChannels, z };
  }

  /** Physical Y bounds of the tip-waste labware (0.1 mm). Kept in one place so
   *  the backend (eject math) and renderer (drawn rect) agree. */
  getTipWasteYRange(): { yMin: number; yMax: number } {
    return { yMin: 730, yMax: 4430 };
  }

  // --------------------------------------------------------------------------
  // Coordinate conversion
  // --------------------------------------------------------------------------

  /** Convert a track number (1-based) to X position in 0.1mm */
  trackToX(track: number): number {
    return this.xOffset + (track - 1) * TRACK_PITCH;
  }

  /** Convert an X position (0.1mm) to the nearest track number */
  xToTrack(x: number): number {
    return Math.round((x - this.xOffset) / TRACK_PITCH) + 1;
  }

  /**
   * Get the absolute deck position of a well on a labware item.
   *
   * @param address - The well address (carrier, position, row, column)
   * @returns Position in FW coordinates (0.1mm), or null if not found
   */
  wellToPosition(address: WellAddress): DeckPosition | null {
    const carrier = this.carriers.get(address.carrierId);
    if (!carrier) return null;

    const labware = carrier.labware[address.position];
    if (!labware) return null;

    // Carrier origin X — track-CENTER of the leftmost track. VENUS's
    // TForm.3.X for a carrier equals this (verified against Method1.lay
    // 2026-04-19: PLT_CAR at track 8 reports 257.5 mm = trackToX(8)),
    // so `offsetX` stored on a labware is measured from this point.
    // A 6-track carrier physically spans this origin → origin + 6*pitch.
    const carrierLeftX = this.trackToX(carrier.track);

    // Position Y: use real site offsets if available, otherwise even division
    let positionBaseY: number;
    if (carrier.siteYOffsets && carrier.siteYOffsets[address.position] !== undefined) {
      positionBaseY = Y_FRONT_EDGE + carrier.siteYOffsets[address.position];
    } else {
      const positionPitchY = (Y_REAR_EDGE - Y_FRONT_EDGE) / carrier.positions;
      positionBaseY = Y_FRONT_EDGE + address.position * positionPitchY;
    }

    // Well position within the labware
    // Columns run left-to-right (+X), rows run rear-to-front (-Y).
    // Row A (0) is at the rear (highest Y), row H (7) at the front.
    const wellX = carrierLeftX + labware.offsetX + address.column * labware.wellPitch;
    const wellY = positionBaseY + labware.offsetY - address.row * labware.wellPitch;
    const wellZ = labware.height;

    return { x: Math.round(wellX), y: Math.round(wellY), z: wellZ };
  }

  // --------------------------------------------------------------------------
  // Carrier management
  // --------------------------------------------------------------------------

  /** Load a carrier onto the deck at a specific track.
   *  Real Hamilton layouts place fixture carriers like `WasteBlock` on
   *  the margin rail past the nominal track grid (track 55+ for a
   *  54-track deck). Dropping them silently meant VENUS's eject
   *  commands hit "no carrier" because the waste sits just past the
   *  last carrier-bearing track. We allow up to `MARGIN_TRACKS` extra
   *  tracks on either side so those fixtures still land in the
   *  carrier map (and the resolver finds them).
   */
  loadCarrier(carrier: Carrier): boolean {
    const MARGIN_TRACKS = 5;   // enough for WasteBlock / teaching-needle etc.
    for (let t = carrier.track; t < carrier.track + carrier.widthTracks; t++) {
      if (t < 1 - MARGIN_TRACKS || t > this.totalTracks + MARGIN_TRACKS) return false;
      if (this.trackMap.has(t)) return false;  // Track occupied
    }

    // Place carrier
    this.carriers.set(carrier.id, carrier);
    for (let t = carrier.track; t < carrier.track + carrier.widthTracks; t++) {
      this.trackMap.set(t, carrier.id);
    }
    return true;
  }

  /** Unload a carrier from the deck */
  unloadCarrier(carrierId: string): Carrier | null {
    const carrier = this.carriers.get(carrierId);
    if (!carrier) return null;

    for (let t = carrier.track; t < carrier.track + carrier.widthTracks; t++) {
      this.trackMap.delete(t);
    }
    this.carriers.delete(carrierId);
    return carrier;
  }

  /** Get a carrier by ID */
  getCarrier(carrierId: string): Carrier | null {
    return this.carriers.get(carrierId) || null;
  }

  /** Get the carrier at a specific track */
  getCarrierAtTrack(track: number): Carrier | null {
    const id = this.trackMap.get(track);
    return id ? this.carriers.get(id) || null : null;
  }

  /** Get all loaded carriers */
  getAllCarriers(): Carrier[] {
    return Array.from(this.carriers.values());
  }

  /** Check if a track range is free */
  isTrackRangeFree(startTrack: number, widthTracks: number): boolean {
    for (let t = startTrack; t < startTrack + widthTracks; t++) {
      if (this.trackMap.has(t)) return false;
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Labware management
  // --------------------------------------------------------------------------

  /** Place labware on a carrier position */
  placeLabware(carrierId: string, position: number, labware: LabwareItem): boolean {
    const carrier = this.carriers.get(carrierId);
    if (!carrier) return false;
    if (position < 0 || position >= carrier.positions) return false;
    carrier.labware[position] = labware;
    return true;
  }

  /** Remove labware from a carrier position */
  removeLabware(carrierId: string, position: number): LabwareItem | null {
    const carrier = this.carriers.get(carrierId);
    if (!carrier) return null;
    const item = carrier.labware[position];
    carrier.labware[position] = null;
    return item;
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  /** Get the X range (0.1mm) that a carrier occupies */
  getCarrierXRange(carrierId: string): { xMin: number; xMax: number } | null {
    const carrier = this.carriers.get(carrierId);
    if (!carrier) return null;
    const xMin = Math.round(this.trackToX(carrier.track));
    const xMax = Math.round(this.trackToX(carrier.track) + carrier.widthTracks * TRACK_PITCH);
    return { xMin, xMax };
  }

  // --------------------------------------------------------------------------
  // Serialization (Phase 1 #43)
  //
  // getConfig() produces a self-contained TwinConfig capturing the platform,
  // every placed carrier, every placed labware with its FULL definition
  // inlined (not just a type name). This means a TwinConfig can travel to
  // another process and reconstruct the deck without access to the
  // labware-catalog or carrier templates — crucial for trace replay
  // and what-if forking.
  //
  // restoreFromConfig() rebuilds the deck from a TwinConfig: clears all
  // carriers, loads the new ones, places labware at each position.
  //
  // Distinct from getSnapshot(): the snapshot is optimized for UI rendering
  // and omits fields the renderer doesn't need (wellDepth, full geometry).
  // getConfig() is the full serialization view — lossless round-trip.
  // --------------------------------------------------------------------------

  /**
   * Capture the full deck configuration: platform, carriers, labware with
   * inlined geometry, and tip waste. The result is a JSON-safe object that
   * can be passed to `new Deck(platform)` + `restoreFromConfig()` to
   * reconstruct an equivalent deck.
   */
  getConfig(): import("./twin-config").TwinConfig {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { findCatalogEntry } = require("./labware-catalog");

    const carriers: import("./twin-config").PlacedCarrier[] = [];
    for (const carrier of this.carriers.values()) {
      const labware: import("./twin-config").PlacedLabware[] = [];
      for (let p = 0; p < carrier.labware.length; p++) {
        const item = carrier.labware[p];
        if (!item) continue;

        // Try to pull a full definition from the catalog. If the item is a
        // known type, inline the canonical entry. Otherwise, synthesize an
        // ad-hoc entry from the LabwareItem fields — callers loading this
        // config back will still get coherent geometry.
        const catEntry = findCatalogEntry(item.type);
        const definition = catEntry ?? {
          type: item.type,
          category: "unknown" as const,
          rows: item.rows,
          columns: item.columns,
          wellCount: item.wellCount,
          wellPitch: item.wellPitch,
          offsetX: item.offsetX,
          offsetY: item.offsetY,
          height: item.height,
          wellDepth: item.wellDepth,
          wellShape: "flat" as const,
          wellDiameterTop: 69,
          wellDiameterBottom: 69,
          cornerRadius: 0,
          deadVolume: 100,
        };

        labware.push({
          position: p,
          definition,
          barcode: item.barcode,
        });
      }

      carriers.push({
        id: carrier.id,
        type: carrier.type,
        track: carrier.track,
        widthTracks: carrier.widthTracks,
        positions: carrier.positions,
        siteYOffsets: carrier.siteYOffsets ? [...carrier.siteYOffsets] : undefined,
        yDim: carrier.yDim,
        barcode: carrier.barcode,
        labware,
      });
    }

    return {
      version: 1,
      platform: this.platform,
      carriers,
      tipWaste: {
        track: this.tipWaste.track,
        widthTracks: this.tipWaste.widthTracks,
        capacity: this.tipWaste.capacity,
      },
    };
  }

  /**
   * Rebuild the deck from a TwinConfig. Clears all existing carriers, loads
   * the new ones, and places labware at each carrier position.
   *
   * This does NOT preserve the tracker's well volumes or tip usage — those
   * live in DeckTracker and have their own restore path.
   *
   * @throws if the config platform doesn't match this deck's platform.
   */
  restoreFromConfig(config: import("./twin-config").TwinConfig): void {
    if (!config || typeof config !== "object") {
      throw new Error("restoreFromConfig: config is null or not an object");
    }
    if (config.version !== 1) {
      throw new Error(`restoreFromConfig: unsupported config version ${config.version}`);
    }
    if (config.platform !== this.platform) {
      throw new Error(
        `restoreFromConfig: platform mismatch — config is "${config.platform}", deck is "${this.platform}"`
      );
    }

    // Wipe current carriers and track map
    this.carriers.clear();
    this.trackMap.clear();

    // Rebuild tip waste config
    this.tipWaste = {
      track: config.tipWaste.track,
      widthTracks: config.tipWaste.widthTracks,
      tipCount: 0,  // count is dynamic state, not config
      capacity: config.tipWaste.capacity,
    };

    // Load each carrier
    for (const placed of config.carriers) {
      const carrier: Carrier = {
        id: placed.id,
        type: placed.type,
        track: placed.track,
        widthTracks: placed.widthTracks,
        positions: placed.positions,
        siteYOffsets: placed.siteYOffsets ? [...placed.siteYOffsets] : undefined,
        yDim: placed.yDim,
        barcode: placed.barcode,
        labware: new Array(placed.positions).fill(null),
      };

      // Place labware at each specified position
      for (const pl of placed.labware) {
        if (pl.position < 0 || pl.position >= carrier.positions) {
          throw new Error(
            `restoreFromConfig: labware at invalid position ${pl.position} on carrier ${placed.id} (positions=${carrier.positions})`
          );
        }
        const def = pl.definition;
        carrier.labware[pl.position] = {
          type: def.type,
          wellCount: def.wellCount,
          rows: def.rows,
          columns: def.columns,
          wellPitch: def.wellPitch,
          offsetX: def.offsetX,
          offsetY: def.offsetY,
          height: def.height,
          wellDepth: def.wellDepth,
          barcode: pl.barcode,
        };
      }

      if (!this.loadCarrier(carrier)) {
        throw new Error(
          `restoreFromConfig: failed to load carrier ${placed.id} at track ${placed.track} (track occupied or out of range)`
        );
      }
    }
  }

  /** Get a snapshot of the deck state for the UI */
  getSnapshot(): DeckSnapshot {
    const tracks: TrackInfo[] = [];
    for (let t = 1; t <= this.totalTracks; t++) {
      const carrierId = this.trackMap.get(t) || null;
      tracks.push({
        track: t,
        x: this.trackToX(t),
        carrierId,
      });
    }

    const carriers: CarrierSnapshot[] = [];
    for (const carrier of this.carriers.values()) {
      carriers.push({
        id: carrier.id,
        type: carrier.type,
        track: carrier.track,
        widthTracks: carrier.widthTracks,
        xMin: Math.round(this.trackToX(carrier.track)),
        xMax: Math.round(this.trackToX(carrier.track) + carrier.widthTracks * TRACK_PITCH),
        positions: carrier.positions,
        siteYOffsets: carrier.siteYOffsets,
        yDim: carrier.yDim,
        labware: carrier.labware.map((lw) =>
          lw ? {
            type: lw.type, wellCount: lw.wellCount, rows: lw.rows, columns: lw.columns,
            wellPitch: lw.wellPitch, offsetX: lw.offsetX, offsetY: lw.offsetY,
            barcode: lw.barcode,
            // Outer footprint + first-well boundary — carried from the
            // `.rck` so the renderer draws the labware body at its real
            // 127×86 mm (or 122.4×82.6 mm) outline. Without these the
            // renderer falls back to a pitch-based estimate and the
            // plate looks jammed/shrunken within its carrier slot.
            rackDx: lw.rackDx, rackDy: lw.rackDy, rackDz: lw.rackDz,
            holeDiameter: lw.holeDiameter,
            bndryX: lw.bndryX, bndryY: lw.bndryY,
            holeShape: lw.holeShape,
            // `containerBase` is negative for tip racks / deep-wells —
            // how far the well bottom sits BELOW the rack top. The 3D
            // view uses it to compute the visible tip/well collar
            // height from real geometry instead of the hardcoded 11.5
            // mm that used to be baked in for every tip rack.
            containerBase: lw.containerBase,
            height: lw.height,
            // Prefer the .ctr-derived values when present (#55 part A),
            // fall back to the shared labware catalog otherwise.
            deadVolume: lw.deadVolume ?? catalogDeadVolume(lw.type),
            wellDepth: lw.wellDepth,
            maxVolume: lw.maxVolume,
            hasConicalBottom: lw.hasConicalBottom,
          } : null
        ),
        barcode: carrier.barcode,
      });
    }

    const tipWasteYRange = this.getTipWasteYRange();
    const tipWaste = {
      track: this.tipWaste.track,
      widthTracks: this.tipWaste.widthTracks,
      xMin: this.trackToX(this.tipWaste.track) - TRACK_PITCH / 2,
      xMax: this.trackToX(this.tipWaste.track + this.tipWaste.widthTracks - 1) + TRACK_PITCH / 2,
      yMin: tipWasteYRange.yMin,
      yMax: tipWasteYRange.yMax,
      tipCount: this.tipWaste.tipCount,
      capacity: this.tipWaste.capacity,
    };

    return {
      platform: this.platform, totalTracks: this.totalTracks, tracks, carriers, tipWaste,
      fixtures: this.fixtures.slice(),
      dimensions: {
        yFrontEdge: Y_FRONT_EDGE,
        yRearEdge: Y_REAR_EDGE,
        trackPitch: TRACK_PITCH,
        deckWidth: PLATFORM[this.platform].deckWidth_01mm,
        xOffset: this.xOffset,
      },
    };
  }
}

// ============================================================================
// Snapshot types (for UI serialization)
// ============================================================================

export interface TrackInfo {
  track: number;
  x: number;
  carrierId: string | null;
}

export interface CarrierSnapshot {
  id: string;
  type: string;
  track: number;
  widthTracks: number;
  xMin: number;
  xMax: number;
  positions: number;
  siteYOffsets?: number[];
  yDim?: number;
  labware: ({
    type: string; wellCount: number; rows: number; columns: number;
    wellPitch: number; offsetX: number; offsetY: number;
    barcode?: string;
    /** Outer footprint + first-well boundary (0.1 mm), from the `.rck`.
     *  Renderer prefers these over the pitch-derived estimate so plate
     *  bodies draw at their real dimensions (e.g. 127×86 mm SBS). */
    rackDx?: number;
    rackDy?: number;
    rackDz?: number;
    holeDiameter?: number;
    bndryX?: number;
    bndryY?: number;
    /** Labware Z height (0.1 mm). Used by the renderer and physics
     *  (Z-travel clearance checks). */
    height?: number;
    /** Dead / max / well-depth geometry — sourced from the loaded
     *  `.ctr` when available (#55 part A), else `deadVolume` falls
     *  back to the labware catalog. All in 0.1 µL / 0.1 mm. */
    deadVolume?: number;
    wellDepth?: number;
    maxVolume?: number;
    hasConicalBottom?: boolean;
  } | null)[];
  barcode?: string;
}

export interface DeckSnapshot {
  platform: PlatformType;
  totalTracks: number;
  tracks: TrackInfo[];
  carriers: CarrierSnapshot[];
  tipWaste: {
    track: number;
    widthTracks: number;
    xMin: number;
    xMax: number;
    tipCount: number;
    capacity: number;
  };
  /** Non-track `.dck` fixtures, or [] when no layout has been imported. */
  fixtures: DeckFixture[];
  /** Physical deck dimensions (0.1 mm). The renderer reads these instead of
   *  hardcoding the STAR defaults, so a STARlet or custom platform doesn't
   *  need separate renderer-side constants. */
  dimensions: {
    yFrontEdge: number;
    yRearEdge: number;
    trackPitch: number;
    deckWidth: number;
    xOffset: number;
  };
}

// ============================================================================
// Common labware templates
//
// Single source of truth: labware-catalog.ts. Call `fromCatalog(type)` with
// a Hamilton type name (Cos_96_Rd, Tips_1000uL, etc.) to get a fresh
// LabwareItem. Throws on unknown types so typos fail loud instead of
// silently loading empty labware.
// ============================================================================

function fromCatalog(labwareType: string): LabwareItem {
  const lw = labwareItemFromCatalog(labwareType);
  if (!lw) throw new Error(`Labware type "${labwareType}" not in catalog (labware-catalog.ts).`);
  return lw as LabwareItem;
}

// CARRIER_TEMPLATES has been retired. Callers use carrierFromCatalog(type,
// track, id) from carrier-catalog.ts — the single source of carrier
// geometry. siteYOffsets semantics are unchanged: Y offset from carrier
// front edge in 0.1 mm, added to the labware's own offsetY to get well
// A1's absolute Y.

// ============================================================================
// Labware JSON loader
// ============================================================================

/** JSON labware definition (matches labware/schema.json) */
export interface LabwareDefinition {
  type: string;
  category: string;
  description?: string;
  manufacturer?: string;
  geometry: {
    rows: number;
    columns: number;
    wellPitch: number;
    wellShape?: string;
    wellDepth?: number;
    wellDiameterTop?: number;
    wellDiameterBottom?: number;
    wellVolume?: number;
    cornerRadius?: number;
  };
  dimensions?: {
    length?: number;
    width?: number;
    height?: number;
    flangeHeight?: number;
  };
  positions?: {
    layout?: string;
    offsetX?: number;
    offsetY?: number;
    customPositions?: Array<{ row: number; column: number; x: number; y: number }>;
  };
  liquidHandling?: {
    deadVolume?: number;
    touchOffDistance?: number;
    cLLDSensitivity?: string;
    material?: string;
  };
}

/**
 * Convert a JSON labware definition to the internal LabwareItem format.
 */
export function labwareFromDefinition(def: LabwareDefinition): LabwareItem {
  return {
    type: def.type,
    wellCount: def.geometry.rows * def.geometry.columns,
    rows: def.geometry.rows,
    columns: def.geometry.columns,
    wellPitch: def.geometry.wellPitch,
    offsetX: def.positions?.offsetX ?? 33,
    offsetY: def.positions?.offsetY ?? 115,
    height: def.dimensions?.height ?? 144,
    wellDepth: def.geometry.wellDepth ?? 0,
  };
}

/**
 * Load a labware definition from a JSON object.
 * Returns a LabwareItem ready to place on a carrier.
 */
export function loadLabwareDefinition(json: unknown): LabwareItem {
  const def = json as LabwareDefinition;
  if (!def.type || !def.geometry || !def.geometry.rows || !def.geometry.columns) {
    throw new Error("Invalid labware definition: missing type or geometry");
  }
  return labwareFromDefinition(def);
}

// ============================================================================
// Helper: create a typical deck layout for testing
// ============================================================================

/**
 * Try to load a real VENUS Method1.lay as the twin's default deck.
 *
 * Search order:
 *   1. The user's actual Hamilton install
 *      (`C:\Program Files (x86)\Hamilton\Methods\Method1.lay`) — uses
 *      the binary-capable `parseHxCfg` and resolves referenced
 *      `.rck`/`.tml` against `C:\Program Files (x86)\Hamilton`.
 *      This is the file VENUS itself loads, so anything the user sees
 *      in the twin matches what VENUS shows.
 *   2. Bundled `assets/default-deck.lay` in the repo (text form).
 *
 * Returns null if everything fails so the hand-coded fallback below
 * can take over.
 */
function tryLoadBakedLayout(): Deck | null {
  const fsMod = (() => { try { return require("fs") as typeof import("fs"); } catch { return null; } })();
  const pathMod = (() => { try { return require("path") as typeof import("path"); } catch { return null; } })();
  if (!fsMod || !pathMod) return null;

  const hxCfg = (() => { try { return require("../services/venus-import/hxcfg-parser") as typeof import("../services/venus-import/hxcfg-parser"); } catch { return null; } })();
  const importer = (() => { try { return require("../services/venus-import/venus-deck-importer") as typeof import("../services/venus-import/venus-deck-importer"); } catch { return null; } })();
  if (!hxCfg || !importer) return null;

  // 1) Hamilton install (binary .lay — exact same file VENUS uses).
  const installRoot = process.env.HAMILTON_INSTALL_ROOT
    || "C:\\Program Files (x86)\\Hamilton";
  const installLay = pathMod.join(installRoot, "Methods", "Method1.lay");
  if (fsMod.existsSync(installLay)) {
    try {
      const buf = fsMod.readFileSync(installLay);
      const doc = hxCfg.parseHxCfg(buf);
      const result = importer.importVenusLayout(doc, { hamiltonInstallRoot: installRoot });
      return result.deck;
    } catch {
      // fall through to the repo-bundled fallback
    }
  }

  // 2) Bundled text copy in the repo (works on CI / Docker / no-install).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = pathMod.join(dir, "assets", "default-deck.lay");
    if (fsMod.existsSync(candidate)) {
      try {
        const buf = fsMod.readFileSync(candidate);
        const doc = hxCfg.parseHxCfg(buf);
        const labwareRoot = pathMod.join(dir, "assets", "labware");
        const fakeInstallRoot = fsMod.existsSync(labwareRoot) ? pathMod.join(dir, "assets") : undefined;
        const result = importer.importVenusLayout(doc, { hamiltonInstallRoot: fakeInstallRoot });
        return result.deck;
      } catch { /* keep walking */ }
    }
    dir = pathMod.dirname(dir);
  }

  return null;
}

export function createDefaultDeckLayout(): Deck {
  const baked = tryLoadBakedLayout();
  if (baked) return baked;
  return createFallbackDeckLayout();
}

/**
 * Hand-coded fallback layout. Used when the baked-in Method1.lay
 * can't be resolved (tests running in unusual cwd, asset dir moved,
 * etc.). Kept so the twin always has *some* populated deck.
 */
function createFallbackDeckLayout(): Deck {
  const deck = new Deck("STAR");

  // Track 1-6: Tip carrier (1000uL + 300uL tips)
  const tipCarrier = carrierFromCatalog("TIP_CAR_480", 1, "TIP001");
  for (let i = 0; i < 3; i++) tipCarrier.labware[i] = fromCatalog("Tips_1000uL");
  tipCarrier.labware[3] = fromCatalog("Tips_300uL");
  tipCarrier.labware[4] = fromCatalog("Tips_300uL");
  deck.loadCarrier(tipCarrier);

  // Track 7-12: Sample plates (96-well + 384-well)
  const sampleCarrier = carrierFromCatalog("PLT_CAR_L5MD", 7, "SMP001");
  sampleCarrier.labware[0] = fromCatalog("Cos_96_Rd");
  sampleCarrier.labware[2] = fromCatalog("Cos_384_Sq");
  deck.loadCarrier(sampleCarrier);

  // Track 13-18: Destination plates
  const destCarrier = carrierFromCatalog("PLT_CAR_L5MD", 13, "DST001");
  destCarrier.labware[0] = fromCatalog("Cos_96_Rd");
  destCarrier.labware[1] = fromCatalog("Cos_96_Rd");
  destCarrier.labware[3] = fromCatalog("Cos_96_Rd");
  deck.loadCarrier(destCarrier);

  // Track 19-24: Reagent troughs
  const reagentCarrier = carrierFromCatalog("RGT_CAR_3R", 19, "RGT001");
  reagentCarrier.labware[0] = fromCatalog("Trough_100ml");
  reagentCarrier.labware[2] = fromCatalog("Trough_100ml");
  deck.loadCarrier(reagentCarrier);

  // Track 25-30: Second tip carrier (300uL for 96-head)
  const tipCarrier2 = carrierFromCatalog("TIP_CAR_480", 25, "TIP002");
  for (let i = 0; i < 5; i++) tipCarrier2.labware[i] = fromCatalog("Tips_300uL");
  deck.loadCarrier(tipCarrier2);

  // Track 31-36: Wash station (2 chambers)
  const washStation = carrierFromCatalog("WASH_STATION", 31, "WASH01");
  washStation.labware[0] = fromCatalog("Wash_Chamber");
  washStation.labware[1] = fromCatalog("Wash_Chamber");
  deck.loadCarrier(washStation);

  // Track 37-42: Heater/Shaker with plate
  const hhsCarrier = carrierFromCatalog("HHS_CAR", 37, "HHS001");
  hhsCarrier.labware[0] = fromCatalog("HHS_Plate_96");
  deck.loadCarrier(hhsCarrier);

  // Track 43-48: Temperature controller with plate
  const tccCarrier = carrierFromCatalog("TCC_CAR", 43, "TCC001");
  tccCarrier.labware[0] = fromCatalog("TCC_Plate_96");
  deck.loadCarrier(tccCarrier);

  return deck;
}
