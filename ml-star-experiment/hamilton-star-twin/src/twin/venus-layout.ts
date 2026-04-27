/**
 * VENUS Layout Importer
 *
 * Parses Hamilton VENUS .lay (deck layout), .tml (carrier template),
 * and .rck (labware rack) files to build a Deck model.
 *
 * File format: HxCfgFile — text-based key-value pairs.
 *   .lay  → which carriers/labware go where on the deck
 *   .tml  → carrier geometry (sites, dimensions, track width)
 *   .rck  → labware geometry (well grid, dimensions, well depth)
 *
 * The .lay TForm.3.X/Y gives the absolute position (in mm) that
 * firmware commands will target for well A1 of that labware item.
 * This has been verified against real VENUS ComTrace recordings.
 */

import * as fs from "fs";
import * as path from "path";
import { Deck, Carrier, LabwareItem, PlatformType, PLATFORM, TRACK_PITCH, Y_FRONT_EDGE, POSITION_FALLBACK_Y_REAR } from "./deck";

// ============================================================================
// HxCfgFile parser
// ============================================================================

/** Parse an HxCfgFile into a flat key-value map per DataDef section. */
function parseHxCfgFile(content: string): Map<string, string> {
  const kvs = new Map<string, string>();
  const lines = content.replace(/\r/g, "").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_.]+),\s*"([^"]*)"/);
    if (m) {
      kvs.set(m[1], m[2]);
    }
  }
  return kvs;
}

// ============================================================================
// Layout entry types
// ============================================================================

interface LayoutEntry {
  index: number;
  file: string;        // e.g. "ML_STAR\\HT_L.rck"
  id: string;          // e.g. "HT_L_0001"
  siteId: string;      // "6T-10" (carrier on deck) or "3" (labware on carrier site)
  template: string;    // "default" = on deck; carrier ID = on that carrier
  absX: number;        // TForm.3.X in mm
  absY: number;        // TForm.3.Y in mm
  zTrans: number;      // height above deck surface in mm
}

interface CarrierInfo {
  entry: LayoutEntry;
  track: number;
  widthTracks: number;
  positions: number;
  siteMap: Map<string, number>;  // site ID → 0-based position index
}

// ============================================================================
// Parse .lay file
// ============================================================================

function parseLayEntries(content: string): LayoutEntry[] {
  const kvs = parseHxCfgFile(content);
  const entries: LayoutEntry[] = [];

  // Find all labware indices
  const indices = new Set<number>();
  for (const key of kvs.keys()) {
    const m = key.match(/^Labware\.(\d+)\./);
    if (m) indices.add(parseInt(m[1]));
  }

  for (const idx of indices) {
    const file = kvs.get(`Labware.${idx}.File`) || "";
    const id = kvs.get(`Labware.${idx}.Id`) || "";
    const siteId = kvs.get(`Labware.${idx}.SiteId`) || "";
    const template = kvs.get(`Labware.${idx}.Template`) || "default";
    const absX = parseFloat(kvs.get(`Labware.${idx}.TForm.3.X`) || "0");
    const absY = parseFloat(kvs.get(`Labware.${idx}.TForm.3.Y`) || "0");
    const zTrans = parseFloat(kvs.get(`Labware.${idx}.ZTrans`) || "100");

    if (file) {
      entries.push({ index: idx, file, id, siteId, template, absX, absY, zTrans });
    }
  }

  return entries;
}

// ============================================================================
// Parse .tml carrier template
// ============================================================================

interface CarrierTemplate {
  siteCnt: number;
  widthTracks: number;
  sites: { id: string; x: number; y: number; z: number }[];
}

function parseCarrierTemplate(content: string): CarrierTemplate {
  const kvs = parseHxCfgFile(content);
  const siteCnt = parseInt(kvs.get("Site.Cnt") || "0");
  const widthTracks = parseInt(findProperty(kvs, "MlStarCarWidthAsT") || "6");

  const sites: { id: string; x: number; y: number; z: number }[] = [];
  for (let i = 1; i <= siteCnt + 10; i++) {
    const id = kvs.get(`Site.${i}.Id`);
    if (!id) continue;
    sites.push({
      id,
      x: parseFloat(kvs.get(`Site.${i}.X`) || "0"),
      y: parseFloat(kvs.get(`Site.${i}.Y`) || "0"),
      z: parseFloat(kvs.get(`Site.${i}.Z`) || "0"),
    });
  }

  return { siteCnt: sites.length, widthTracks, sites };
}

function findProperty(kvs: Map<string, string>, propName: string): string | undefined {
  for (let i = 1; i <= 20; i++) {
    if (kvs.get(`Property.${i}`) === propName) {
      return kvs.get(`PropertyValue.${i}`);
    }
  }
  return undefined;
}

// ============================================================================
// Parse .rck labware definition
// ============================================================================

interface LabwareRck {
  rows: number;
  columns: number;
  pitchX: number;      // Dx in mm
  pitchY: number;      // Dy in mm
  bndryX: number;
  bndryY: number;
  dimDx: number;       // overall width mm
  dimDy: number;       // overall depth mm
  dimDz: number;       // overall height mm
  holeZ: number;       // well depth mm
  isTipRack: boolean;
  description: string;
}

function parseLabwareRck(content: string): LabwareRck {
  const kvs = parseHxCfgFile(content);
  const rows = parseInt(kvs.get("Rows") || "0");
  const columns = parseInt(kvs.get("Columns") || "0");
  const dx = parseFloat(kvs.get("Dx") || "9");
  const dy = parseFloat(kvs.get("Dy") || "9");
  const bndryX = parseFloat(kvs.get("BndryX") || "14");
  const bndryY = parseFloat(kvs.get("BndryY") || "11.5");
  const dimDx = parseFloat(kvs.get("Dim.Dx") || "127");
  const dimDy = parseFloat(kvs.get("Dim.Dy") || "86");
  const dimDz = parseFloat(kvs.get("Dim.Dz") || "14");
  const holeZ = parseFloat(kvs.get("Hole.Z") || "0");
  const description = kvs.get("Description") || kvs.get("ViewName") || "";

  // Detect tip racks from properties
  const isTipRack = findProperty(kvs, "MlStarTipRack") !== undefined
    || description.toLowerCase().includes("tip");

  return { rows, columns, pitchX: dx, pitchY: dy, bndryX, bndryY, dimDx, dimDy, dimDz, holeZ, isTipRack, description };
}

// ============================================================================
// Known labware catalog (fallback when .rck/.tml files aren't available)
// ============================================================================

const KNOWN_CARRIERS: Record<string, { widthTracks: number; positions: number }> = {
  TIP_CAR_480: { widthTracks: 6, positions: 5 },
  TIP_CAR_480BC: { widthTracks: 6, positions: 5 },
  TIP_CAR_384: { widthTracks: 6, positions: 4 },
  TIP_CAR_384BC: { widthTracks: 6, positions: 4 },
  TIP_CAR_288: { widthTracks: 6, positions: 3 },
  PLT_CAR_L5MD: { widthTracks: 6, positions: 5 },
  PLT_CAR_L5AC: { widthTracks: 6, positions: 5 },
  PLT_CAR_L5PCR: { widthTracks: 6, positions: 5 },
  PLT_CAR_P3MD: { widthTracks: 3, positions: 3 },
  PLT_CAR_P3HD: { widthTracks: 3, positions: 3 },
  SMP_CAR_24: { widthTracks: 6, positions: 24 },
  SMP_CAR_32: { widthTracks: 1, positions: 32 },
  RGT_CAR_3R: { widthTracks: 6, positions: 3 },
  RGT_CAR_3R120: { widthTracks: 1, positions: 3 },
  WasteBlock: { widthTracks: 3, positions: 8 },
  Core96SlideWaste: { widthTracks: 3, positions: 1 },
};

/** Derive labware type name for our model from VENUS file path */
function labwareTypeFromFile(filePath: string, rck?: LabwareRck): string {
  const base = path.basename(filePath, path.extname(filePath)).replace(/_A00|_B00|_C00/g, "");
  // Tip racks
  if (/^HT[F]?_[LP]$/i.test(base)) return "Tips_1000uL_HV";
  if (/^ST[F]?_[LP]$/i.test(base)) return "Tips_300uL_SV";
  if (/^LT[F]?_[LP]$/i.test(base)) return "Tips_10uL_LV";
  if (/^HTF?_L$/i.test(base)) return "Tips_1000uL_HV";
  if (/^STF?_L$/i.test(base)) return "Tips_300uL_SV";
  if (/^LTF?_L$/i.test(base)) return "Tips_10uL_LV";
  if (/^4mlT/i.test(base)) return "Tips_4mL";
  if (/^5mlT/i.test(base)) return "Tips_5mL";
  if (/^TIP_50ul/i.test(base)) return "Tips_50uL";
  if (/tip/i.test(base) || rck?.isTipRack) return "Tips_" + base;
  // Plates
  if (/^Nun_96/i.test(base)) return "Nunc_96_Fl";
  if (/^Cos_96/i.test(base)) return "Cos_96_Rd";
  if (/^Cos_384/i.test(base)) return "Cos_384_Sq";
  if (/^Gre_384/i.test(base)) return "Gre_384_Sq";
  // Reagent troughs
  if (/Ham_DW_Rgt_96/i.test(base)) return "Ham_DW_Rgt_96";
  if (/Ham_DW_Rgt/i.test(base)) return "Ham_DW_Rgt_Trough";
  if (/rgt_cont/i.test(base)) return "Rgt_Cont_Trough";
  if (/Ham_250ml/i.test(base)) return "Ham_250ml_Trough";
  // Sample carriers as labware
  if (/SMP_CAR/i.test(base)) return base;
  // Default: use the base name
  return base;
}

// ============================================================================
// File resolution
// ============================================================================

/** Search paths for VENUS labware files */
function resolveVenusFile(relativePath: string, searchPaths: string[]): string | null {
  // Normalize path separators
  const normalized = relativePath.replace(/\\/g, "/");
  for (const base of searchPaths) {
    const full = path.join(base, normalized);
    if (fs.existsSync(full)) return full;
    // Try case-insensitive on Windows
    const dir = path.dirname(full);
    const file = path.basename(full);
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        const match = files.find(f => f.toLowerCase() === file.toLowerCase());
        if (match) return path.join(dir, match);
      } catch { /* ignore */ }
    }
  }
  return null;
}

// ============================================================================
// Main converter: VENUS .lay → Deck
// ============================================================================

export interface ImportResult {
  deck: Deck;
  carriers: number;
  labware: number;
  resolvedFiles: number;
  unresolvedFiles: string[];
  warnings: string[];
}

/**
 * Import a VENUS .lay file and produce a Deck model.
 *
 * @param layPath - Path to the .lay file
 * @param labwareSearchPaths - Directories to search for .tml/.rck files
 * @param platform - Deck platform ("STAR" or "STARlet")
 */
export function importVenusLayout(
  layPath: string,
  labwareSearchPaths?: string[],
  platform?: PlatformType,
): ImportResult {
  const layContent = fs.readFileSync(layPath, "utf-8");
  const entries = parseLayEntries(layContent);
  const warnings: string[] = [];
  const unresolvedFiles: string[] = [];
  let resolvedFiles = 0;

  // Build search paths: .lay directory + provided paths
  const layDir = path.dirname(layPath);
  const searchPaths = [layDir, ...(labwareSearchPaths || [])];

  // Detect platform from layout
  const layKvs = parseHxCfgFile(layContent);
  const instrument = layKvs.get("Instrument") || "";
  const detectedPlatform = platform
    || (instrument.includes("STARlet") ? "STARlet" as PlatformType : "STAR" as PlatformType);

  const deck = new Deck(detectedPlatform);
  const xOffset = PLATFORM[detectedPlatform].xOffset;

  // Separate carriers (Template="default") from labware-on-carriers
  const carrierEntries = entries.filter(e => e.template === "default");
  const labwareEntries = entries.filter(e => e.template !== "default");

  // Build carrier info map
  const carrierMap = new Map<string, CarrierInfo>();

  for (const entry of carrierEntries) {
    // Parse track position from SiteId: "6T-10" → width=6, track=10
    // Also handles "1T-30", "WasteBlock", "96CORESlideWaste"
    let track = 0;
    let widthTracks = 6;

    const trackMatch = entry.siteId.match(/^(\d+)T-(\d+)$/);
    if (trackMatch) {
      widthTracks = parseInt(trackMatch[1]);
      track = parseInt(trackMatch[2]);
    } else {
      // Non-track sites (WasteBlock, 96CORESlideWaste) — skip for deck model
      // These are special positions outside the track system
      continue;
    }

    // Try to resolve .tml file for exact geometry
    let positions = 5;
    const siteMap = new Map<string, number>();

    const tmlPath = resolveVenusFile(entry.file, searchPaths);
    if (tmlPath && entry.file.endsWith(".tml")) {
      const tmlContent = fs.readFileSync(tmlPath, "utf-8");
      const tmpl = parseCarrierTemplate(tmlContent);
      positions = tmpl.siteCnt;
      widthTracks = tmpl.widthTracks;
      resolvedFiles++;

      // Build site ID → position index map (sorted by Y descending = rear to front)
      const sortedSites = [...tmpl.sites].sort((a, b) => b.y - a.y);
      sortedSites.forEach((s, i) => siteMap.set(s.id, i));
    } else {
      // Fallback: use known carrier catalog
      const baseName = path.basename(entry.file, path.extname(entry.file))
        .replace(/_A00|_B00|_C00/g, "");
      // Match longest prefix to avoid RGT_CAR_3R matching before RGT_CAR_3R120
      const known = Object.entries(KNOWN_CARRIERS)
        .filter(([k]) => baseName.startsWith(k))
        .sort((a, b) => b[0].length - a[0].length)[0];
      if (known) {
        positions = known[1].positions;
        // Trust SiteId for track width, only use catalog for positions
      }
      // Generate default site map (1-based IDs, rear to front)
      for (let i = 0; i < positions; i++) {
        siteMap.set(String(i + 1), i);
      }
      if (entry.file.endsWith(".tml")) {
        unresolvedFiles.push(entry.file);
      }
    }

    // Handle .rck carriers (e.g. SMP_CAR_32_13x100 — a tube rack that sits on a track)
    if (entry.file.endsWith(".rck")) {
      // These are single-track rack carriers. Create as a 1-position carrier
      // with the rack itself as labware.
      const rckPath = resolveVenusFile(entry.file, searchPaths);
      let labwareItem: LabwareItem;
      if (rckPath) {
        const rckContent = fs.readFileSync(rckPath, "utf-8");
        const rck = parseLabwareRck(rckContent);
        labwareItem = rckToLabwareItem(rck, entry, deck, track, widthTracks, 0, 1);
        resolvedFiles++;
      } else {
        labwareItem = fallbackLabwareItem(entry, deck, track, widthTracks, 0, 1);
        unresolvedFiles.push(entry.file);
      }

      const carrier: Carrier = {
        id: entry.id,
        type: path.basename(entry.file, path.extname(entry.file)),
        track,
        widthTracks,
        positions: 1,
        labware: [labwareItem],
      };
      deck.loadCarrier(carrier);
      carrierMap.set(entry.id, {
        entry, track, widthTracks, positions: 1,
        siteMap: new Map([["1", 0]]),
      });
      continue;
    }

    // Create carrier
    const carrier: Carrier = {
      id: entry.id,
      type: path.basename(entry.file, path.extname(entry.file)),
      track,
      widthTracks,
      positions,
      labware: new Array(positions).fill(null),
    };

    deck.loadCarrier(carrier);
    carrierMap.set(entry.id, { entry, track, widthTracks, positions, siteMap });
  }

  // Place labware on carriers
  let labwareCount = 0;
  for (const entry of labwareEntries) {
    const carrierInfo = carrierMap.get(entry.template);
    if (!carrierInfo) {
      warnings.push(`Labware ${entry.id}: carrier ${entry.template} not found`);
      continue;
    }

    // Determine position index from site ID
    let posIndex = carrierInfo.siteMap.get(entry.siteId);
    if (posIndex === undefined) {
      // Try numeric fallback
      const numId = parseInt(entry.siteId);
      if (!isNaN(numId)) {
        // Try direct lookup, or assume 1-based ordering
        posIndex = carrierInfo.siteMap.get(String(numId));
        if (posIndex === undefined && numId >= 1 && numId <= carrierInfo.positions) {
          posIndex = numId - 1;
        }
      }
    }
    if (posIndex === undefined) {
      warnings.push(`Labware ${entry.id}: unknown site ${entry.siteId} on carrier ${entry.template}`);
      continue;
    }

    // Build LabwareItem
    const rckPath = resolveVenusFile(entry.file, searchPaths);
    let labwareItem: LabwareItem;
    if (rckPath) {
      const rckContent = fs.readFileSync(rckPath, "utf-8");
      const rck = parseLabwareRck(rckContent);
      labwareItem = rckToLabwareItem(
        rck, entry, deck, carrierInfo.track, carrierInfo.widthTracks,
        posIndex, carrierInfo.positions,
      );
      resolvedFiles++;
    } else {
      labwareItem = fallbackLabwareItem(
        entry, deck, carrierInfo.track, carrierInfo.widthTracks,
        posIndex, carrierInfo.positions,
      );
      unresolvedFiles.push(entry.file);
    }

    const carrier = deck.getCarrier(carrierInfo.entry.id);
    if (carrier) {
      carrier.labware[posIndex] = labwareItem;
      labwareCount++;
    }
  }

  return {
    deck,
    carriers: carrierMap.size,
    labware: labwareCount,
    resolvedFiles,
    unresolvedFiles: [...new Set(unresolvedFiles)],
    warnings,
  };
}

// ============================================================================
// Build LabwareItem from .rck data
// ============================================================================

function rckToLabwareItem(
  rck: LabwareRck,
  entry: LayoutEntry,
  deck: Deck,
  carrierTrack: number,
  carrierWidthTracks: number,
  posIndex: number,
  totalPositions: number,
): LabwareItem {
  // Carrier origin X (track-center of leftmost track, VENUS convention).
  const carrierLeftX = deck.trackToX(carrierTrack);

  // Position base Y (from the evenly-spaced model). The rear bound for
  // this fallback is the POSITION_FALLBACK_Y_REAR heuristic, NOT the
  // physical Y_REAR_EDGE — see deck.ts for the semantics.
  const positionPitchY = (POSITION_FALLBACK_Y_REAR - Y_FRONT_EDGE) / totalPositions;
  const positionBaseY = Y_FRONT_EDGE + posIndex * positionPitchY;

  // The .lay TForm.3 gives the FW coordinate of well A1 (verified against traces)
  const a1X = entry.absX * 10;  // mm → 0.1mm
  const a1Y = entry.absY * 10;

  // Compute offsets so wellToPosition returns correct absolute coordinates
  // wellX = carrierLeftX + offsetX + col * pitch
  // wellY = positionBaseY + offsetY - row * pitch  (rows decrease in Y)
  const offsetX = Math.round(a1X - carrierLeftX);
  const offsetY = Math.round(a1Y - positionBaseY);
  const wellPitch = Math.round(rck.pitchX * 10);  // mm → 0.1mm

  const typeName = labwareTypeFromFile(entry.file, rck);

  return {
    type: typeName,
    wellCount: rck.rows * rck.columns,
    rows: rck.rows,
    columns: rck.columns,
    wellPitch,
    offsetX,
    offsetY,
    height: Math.round(entry.zTrans * 10),  // ZTrans from .lay (mm → 0.1mm)
    wellDepth: Math.round(rck.holeZ * 10),
    // Outer rack footprint + first-well boundary from the .rck, so the
    // 2D SVG and 3D view can draw the real plate body (127×86 SBS, tip
    // rack 122×83, tube rack ~45×115, etc.) instead of a pitch-derived
    // estimate that collapses to zero on single-column labware with
    // pitchX=0 (SMP_CAR_12_29x115). mm → 0.1mm.
    rackDx: Math.round(rck.dimDx * 10),
    rackDy: Math.round(rck.dimDy * 10),
    rackDz: Math.round(rck.dimDz * 10),
    bndryX: Math.round(rck.bndryX * 10),
    bndryY: Math.round(rck.bndryY * 10),
  };
}

function fallbackLabwareItem(
  entry: LayoutEntry,
  deck: Deck,
  carrierTrack: number,
  carrierWidthTracks: number,
  posIndex: number,
  totalPositions: number,
): LabwareItem {
  const carrierLeftX = deck.trackToX(carrierTrack);
  const positionPitchY = (POSITION_FALLBACK_Y_REAR - Y_FRONT_EDGE) / totalPositions;
  const positionBaseY = Y_FRONT_EDGE + posIndex * positionPitchY;

  const a1X = entry.absX * 10;
  const a1Y = entry.absY * 10;
  const offsetX = Math.round(a1X - carrierLeftX);
  const offsetY = Math.round(a1Y - positionBaseY);

  // Infer type from file name
  const typeName = labwareTypeFromFile(entry.file);
  const isTip = typeName.startsWith("Tips_");
  const isTrough = typeName.includes("Trough") || typeName.includes("Rgt_Cont") || typeName.includes("Ham_DW_Rgt");
  const is384 = typeName.includes("384");

  // Default geometry based on type
  let rows = 8, columns = 12, wellPitch = 90;
  let wellDepth = isTip ? 0 : 100;
  // Standard SBS-footprint dimensions + boundaries. Good enough for
  // renderer fallback when the .rck can't be resolved on disk — the
  // alternative is the renderer inventing a plate-sized footprint for
  // every labware and clipping narrow racks (tube carriers) oddly.
  let rackDx = 1277, rackDy = 854;       // 127.7 × 85.4 mm SBS
  let rackDz = isTip ? 200 : 144;        // 20 mm tip-rack body / 14.4 mm plate
  let bndryX = 140,  bndryY = 115;

  if (is384) { rows = 16; columns = 24; wellPitch = 45; }
  if (isTrough) {
    rows = 8; columns = 2; wellPitch = 90; wellDepth = 400;
    rackDx = 1270; rackDy = 854; rackDz = 445; bndryX = 140; bndryY = 115;
  }

  return {
    type: typeName,
    wellCount: rows * columns,
    rows,
    columns,
    wellPitch,
    offsetX,
    offsetY,
    height: Math.round(entry.zTrans * 10),
    wellDepth,
    rackDx, rackDy, rackDz, bndryX, bndryY,
  };
}

// ============================================================================
// Default VENUS labware search paths (relative to source tree)
// ============================================================================

export function defaultLabwareSearchPaths(venusRoot: string): string[] {
  return [
    path.join(venusRoot, "Vector/src/HxLabwrCatManager/Code/HxLabwrCatSerDe.Test/Labware"),
    path.join(venusRoot, "Star/src/HxGruCommand/test/TestInput/Labware"),
    path.join(venusRoot, "Star/src/HxGruCommand/test/CONFIG/DeckVersion3"),
  ];
}
