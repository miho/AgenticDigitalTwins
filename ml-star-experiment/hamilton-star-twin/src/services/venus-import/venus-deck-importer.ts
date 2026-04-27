/**
 * VENUS layout (`.lay`) → Twin Deck importer (issue #18).
 *
 * Takes a parsed `HxCfgDocument` of a VENUS `.lay` file and builds a
 * `Deck` populated with the carriers and labware that layout
 * specifies. Coordinates map as follows:
 *
 *   VENUS TForm.3.X/Y      mm from deck origin
 *   Twin x/y               0.1 mm from deck origin (same frame)
 *   Twin track             1-based — `xToTrack(x_01mm)` converts
 *
 * The importer is NOT a full VENUS file parser. We resolve a
 * deliberately narrow set of carrier and labware templates by their
 * VENUS filename stem. For an unknown carrier / labware, we emit a
 * warning on the result and substitute a best-effort generic template
 * so the import succeeds — the twin can still run protocols; only
 * physics that depends on precise dimensions will be approximate.
 *
 * Out of scope:
 *   - Reading the referenced `.dck` file (we assume STAR geometry).
 *   - Parsing `.tml`/`.rck` internals (we rely on the template
 *     registry; the user can extend it).
 *   - Rotations / barcodes / ZTrans nuances beyond position mapping.
 */

import {
  Deck,
  Carrier,
  DeckFixture,
  LabwareItem,
  Y_FRONT_EDGE,
  TRACK_PITCH,
} from "../../twin/deck";
import { labwareItemFromCatalog } from "../../twin/labware-catalog";
import { carrierFromCatalog, findCarrierCatalogEntry } from "../../twin/carrier-catalog";
import { HxCfgDocument, HxCfgObject, findSection, enumerateIndexed, getStr, getNum } from "./hxcfg-parser";
import {
  readDeckConfig,
  readCarrierTemplate,
  readRackDefinition,
  readContainerDefinition,
  resolveHamiltonPath,
  findHamiltonInstallRoot,
  CarrierTemplate,
  RackDefinition,
  ContainerDefinition,
  DeckSite,
} from "./hamilton-config-loader";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Template registry — VENUS filename stem → twin builder
// ============================================================================

/**
 * Known VENUS carrier filename stems mapped to their canonical catalog
 * type. The catalog (carrier-catalog.ts) is the single source of carrier
 * geometry — this table just translates install-side filenames.
 */
const CARRIER_BY_STEM: Record<string, string> = {
  // 480-tip carriers — A / B / ST flavors share the 6-track footprint.
  TIP_CAR_480_A00: "TIP_CAR_480",
  TIP_CAR_480_B00: "TIP_CAR_480",
  TIP_CAR_480_ST_A00: "TIP_CAR_480",
  TIP_CAR_480: "TIP_CAR_480",
  // 5-position plate carriers — MD (medium) and AC (active cooling)
  // are mechanically identical for layout purposes; AC adds Peltier
  // plumbing below the deck but the SBS sites sit in the same place.
  PLT_CAR_L5MD_A00: "PLT_CAR_L5MD",
  PLT_CAR_L5MD: "PLT_CAR_L5MD",
  PLT_CAR_L5AC_A00: "PLT_CAR_L5AC",
  PLT_CAR_L5AC: "PLT_CAR_L5AC",
  SMP_CAR_24_15x100_A00: "SMP_CAR_24",
  SMP_CAR_24_15x75_A00: "SMP_CAR_24",
  RGT_CAR_3R_A00: "RGT_CAR_3R",
  RGT_CAR_3R: "RGT_CAR_3R",
};

/**
 * Known VENUS labware (rack/plate/tip) filename stems mapped to their
 * canonical catalog type. The catalog (labware-catalog.ts) is the single
 * source of geometry — this table just translates install-side filenames
 * to type names.
 */
const LABWARE_BY_STEM: Record<string, string> = {
  // Tip racks — uppercase + lowercase variants because VENUS installs
  // vary in how stem case is preserved (the lay file just records the
  // on-disk file name, which follows the OS + install era).
  HT_L: "Tips_1000uL",      // 1000 µL tips, 96-well rack
  ht_l: "Tips_1000uL",
  ST_L: "Tips_300uL",       // 300 µL tips, 96-well rack
  st_l: "Tips_300uL",
  STF_L: "Tips_300uL",
  stf_l: "Tips_300uL",
  LT_L: "Tips_50uL",        // 50 µL tips, 96-well rack
  lt_l: "Tips_50uL",
  LTF_L: "Tips_50uL",
  ltf_l: "Tips_50uL",
  // 96-well plates — the twin tracks them identically for positioning;
  // per-well geometry (deep-well vs. PCR) matters for volume/LLD but
  // not for where the arm descends. Missing depth data is an issue
  // #55 follow-on that needs .rck parsing.
  Cos_96_Rd: "Cos_96_Rd",
  Cos_96_Rd_L: "Cos_96_Rd",
  Cos_96_PCR: "Cos_96_Rd",
  Cos_96_DW: "Cos_96_Rd",
  Cos_96_DW_1mL: "Cos_96_Rd",
  Cos_96_DW_2mL: "Cos_96_Rd",
  Cos_96_DWP: "Cos_96_Rd",
  // 384-well plates
  Cos_384_Rd: "Cos_384_Sq",
  Cos_384_PCR: "Cos_384_Sq",
  Cos_384_Sq: "Cos_384_Sq",
  // Generic pass-throughs
  MTP_96: "Cos_96_Rd",
  MTP_384: "Cos_384_Sq",
  Trough_100ml: "Trough_100ml",
  DiTi_Trough: "Trough_100ml",
};

// ============================================================================
// Types
// ============================================================================

/** Parsed Labware.N entry — the subset we need for deck construction. */
interface VenusLabware {
  index: number;
  file: string;        // e.g. "ML_STAR\\TIP_CAR_480_A00.tml"
  stem: string;        // basename without extension
  id: string;
  siteId: string;
  templateRef: string; // "default" or another labware's Id
  x_mm: number | undefined;
  y_mm: number | undefined;
  zTrans_mm: number | undefined;
}

/** Warnings + diagnostics produced during import. */
export interface ImportWarning {
  code:
    | "unknown_carrier"
    | "unknown_labware"
    | "missing_parent"
    | "missing_coord"
    | "bad_site"
    | "deck-config-unavailable";
  message: string;
  labwareId?: string;
}

export interface ImportResult {
  deck: Deck;
  /** Every labware entry from the `.lay` we attempted to place. */
  placements: Array<{
    labwareId: string;
    carrierId: string;
    position: number;
    type: string;
  }>;
  warnings: ImportWarning[];
  /** Top-level layout fields copied verbatim (for metadata display). */
  metadata: {
    deckFile: string | undefined;
    activeLayer: string | undefined;
    instrument: string | undefined;
  };
}

// ============================================================================
// Entry point
// ============================================================================

/** Options for customising how `.lay` references are resolved. */
export interface ImportVenusLayoutOptions {
  /** Root of a Hamilton install (defaults to auto-discovery — see
   *  `findHamiltonInstallRoot`). When set, the importer pulls carrier
   *  dimensions, site layouts, rack geometry and well pitches from the
   *  actual `.tml`/`.rck` files. Otherwise both labware-catalog and
   *  carrier-catalog supply single-source-of-truth fallback geometry. */
  hamiltonInstallRoot?: string | null;
}

/** Parse a `.lay` HxCfgDocument into a populated `Deck`. */
export function importVenusLayout(doc: HxCfgDocument, options: ImportVenusLayoutOptions = {}): ImportResult {
  const layoutSection = findSection(doc, "DECKLAY");
  if (!layoutSection) throw new Error("importVenusLayout: no DECKLAY section found");
  const body = layoutSection.body as HxCfgObject;

  const metadata = {
    deckFile: getStr(body, "Deck"),
    activeLayer: getStr(body, "ActiveLayer"),
    instrument: getStr(body, "Instrument"),
  };

  const installRoot = options.hamiltonInstallRoot === undefined
    ? findHamiltonInstallRoot()
    : options.hamiltonInstallRoot;

  const entries = readLabwareEntries(body);

  // Group: parents with Template="default" are carriers. Everything
  // else is a child labware that references a parent by Id (or in
  // rare cases, references a `WasteBlock`-style sibling — we hoist
  // those as deck-level "virtual" carriers).
  const warnings: ImportWarning[] = [];
  const deck = new Deck("STAR");
  const placements: ImportResult["placements"] = [];

  const byId = new Map<string, VenusLabware>();
  for (const e of entries) byId.set(e.id, e);
  const childrenOf = groupChildren(entries);

  for (const entry of entries) {
    if (entry.templateRef !== "default") continue;
    placeCarrierTree(entry, childrenOf, byId, deck, placements, warnings, installRoot);
  }

  // Deck fixtures (#57) — non-track sites from the referenced `.dck`
  // (e.g. `WasteBlock`, `96COREExtWaste`, `PuncherModule`, decorative
  // edges). Pulled in so the renderer can draw the gaps VENUS shows
  // between carrier slots. Best-effort: if the `.dck` can't be resolved
  // or parsed we just leave `deck.fixtures` empty — the rest of the
  // import stays valid.
  if (metadata.deckFile && installRoot) {
    const dckPath = resolveHamiltonPath(installRoot, metadata.deckFile, "deck");
    if (!dckPath) {
      warnings.push({
        code: "deck-config-unavailable",
        message: `Could not find referenced .dck (${metadata.deckFile}) under ${installRoot}. Fixture overlays will be omitted.`,
      });
    } else {
      try {
        const dck = readDeckConfig(dckPath);
        deck.fixtures = extractFixtures(dck.sites);
      } catch (err) {
        warnings.push({
          code: "deck-config-unavailable",
          message: `Could not parse ${dckPath}: ${(err as Error).message}. Fixture overlays will be omitted.`,
        });
      }
    }
  }

  return { deck, placements, warnings, metadata };
}

// ============================================================================
// Fixture extraction (#57)
// ============================================================================

/** `NT-M?N` is every track site — 1T-1, 6T-12, 7T-M3 etc. Anything
 *  else is a fixture or decorative site. */
const TRACK_SITE_RE = /^[0-9]+T-[A-Z]?[0-9]+$/;
/** Raster position markers: plain numbers, `Nb`/`Nf` edge markers,
 *  `rNb`/`rNf` right-edge markers. These are hints for VENUS's editor
 *  grid, not drawable fixtures (they're either zero-area or 100×2mm
 *  hairlines), so we exclude them. */
const RASTER_MARKER_RE = /^r?[0-9]+[bf]?$/;

export function extractFixtures(sites: DeckSite[]): DeckFixture[] {
  const fixtures: DeckFixture[] = [];
  for (const s of sites) {
    if (TRACK_SITE_RE.test(s.id)) continue;
    if (RASTER_MARKER_RE.test(s.id)) continue;
    if (s.id === "LeftEdge" || s.id === "RightEdge") continue;  // hairline decorations
    if (s.dx <= 0 || s.dy <= 0) continue;                        // nothing to draw
    // .dck `Visible=0` sites are internal tool-zone references that
    // VENUS normally doesn't render as deck overlays (96-head external
    // waste, puncher module, auxiliary waste block). Their X/Y live in
    // a different frame from the carrier sites and rendering them
    // anyway produced big off-deck ghost shapes in the Method1.lay
    // review. Skip them.
    if (!s.visible) continue;
    fixtures.push({
      id: s.id,
      x: Math.round(s.x * 10),
      y: Math.round(s.y * 10),
      dx: Math.round(s.dx * 10),
      dy: Math.round(s.dy * 10),
      visible: s.visible,
      kind: classifyFixture(s.id),
    });
  }
  return fixtures;
}

function classifyFixture(id: string): DeckFixture["kind"] {
  const lower = id.toLowerCase();
  if (lower.includes("slidewaste")) return "tipwaste96slide";
  if (lower.includes("core") && lower.includes("waste")) return "tipwaste96";
  if (lower.includes("waste")) return "wasteblock";
  if (lower.includes("puncher")) return "puncher";
  if (lower.includes("edge")) return "edge";
  return "other";
}

// ============================================================================
// Internals
// ============================================================================

function readLabwareEntries(body: HxCfgObject): VenusLabware[] {
  const out: VenusLabware[] = [];
  for (const { index, child } of enumerateIndexed(body, "Labware")) {
    const file = getStr(child, "File") ?? "";
    const id = getStr(child, "Id") ?? "";
    if (!id) continue;
    out.push({
      index,
      file,
      stem: fileStem(file),
      id,
      siteId: getStr(child, "SiteId") ?? "",
      templateRef: getStr(child, "Template") ?? "",
      x_mm: getNum(child, "TForm.3.X"),
      y_mm: getNum(child, "TForm.3.Y"),
      zTrans_mm: getNum(child, "ZTrans"),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function groupChildren(entries: VenusLabware[]): Map<string, VenusLabware[]> {
  const out = new Map<string, VenusLabware[]>();
  for (const e of entries) {
    if (e.templateRef === "default" || e.templateRef === "") continue;
    const arr = out.get(e.templateRef) ?? [];
    arr.push(e);
    out.set(e.templateRef, arr);
  }
  return out;
}

function placeCarrierTree(
  carrierEntry: VenusLabware,
  childrenOf: Map<string, VenusLabware[]>,
  byId: Map<string, VenusLabware>,
  deck: Deck,
  placements: ImportResult["placements"],
  warnings: ImportWarning[],
  installRoot: string | null,
): void {
  if (carrierEntry.x_mm === undefined || carrierEntry.y_mm === undefined) {
    warnings.push({
      code: "missing_coord",
      labwareId: carrierEntry.id,
      message: `carrier '${carrierEntry.id}' has no TForm.3.X/Y — cannot compute track`,
    });
    return;
  }

  const track = venusXToTrack(carrierEntry.x_mm);
  if (track < 1) {
    warnings.push({
      code: "bad_site",
      labwareId: carrierEntry.id,
      message: `carrier '${carrierEntry.id}' resolved to track ${track} (<1) — skipping`,
    });
    return;
  }

  // Prefer the Hamilton-sourced path — read the actual .tml to get the
  // carrier's real dimensions, site count, and widthAsTracks. Fall
  // back to the carrier-catalog (single source of truth) when the file
  // isn't on disk; log a warning in that case.
  let carrierTmpl: CarrierTemplate | null = null;
  if (installRoot && carrierEntry.file) {
    const tmlPath = resolveHamiltonPath(installRoot, carrierEntry.file, "labware");
    if (tmlPath) {
      try { carrierTmpl = readCarrierTemplate(tmlPath); }
      catch (e: any) {
        warnings.push({
          code: "unknown_carrier",
          labwareId: carrierEntry.id,
          message: `failed to parse .tml for '${carrierEntry.file}': ${e?.message ?? e}`,
        });
      }
    }
  }

  let carrier: Carrier;
  if (carrierTmpl) {
    carrier = buildCarrierFromHamiltonTemplate(carrierTmpl, track, carrierEntry.id, carrierEntry.y_mm);
  } else {
    const catalogType = CARRIER_BY_STEM[carrierEntry.stem];
    if (!catalogType || !findCarrierCatalogEntry(catalogType)) {
      warnings.push({
        code: "unknown_carrier",
        labwareId: carrierEntry.id,
        message: `unknown carrier '${carrierEntry.file}' and no Hamilton install available — skipping placement`,
      });
      return;
    }
    carrier = carrierFromCatalog(catalogType, track, carrierEntry.id);
  }
  deck.loadCarrier(carrier);

  // Place every direct child on its carrier site using VENUS's SiteId
  // (1..N, back-to-front) and its absolute TForm.3.Y (row-A anchor).
  // `applySiteOverride` patches the carrier's siteYOffsets so the
  // deck-tracker's resolvePosition matches exactly what VENUS will
  // send in C0TP/C0AS/C0DS.
  const kids = childrenOf.get(carrierEntry.id) ?? [];
  const carrierY01 = Math.round((carrierEntry.y_mm || 0) * 10);
  for (const kid of kids) {
    // placeChild must run first: it builds the LabwareItem (so we know
    // its `offsetY` = labware's Row A from site floor), then we convert
    // the .lay's absolute Row-A Y into the site-floor Y that the rest of
    // the twin expects. applySiteOverride used to run first + store Row
    // A directly, which made `posBaseY + 745` (the empty-slot rect's
    // Row-A reference) overshoot by one plate offset — empty-slot
    // rectangles then rendered 74.5 mm above their actual slot,
    // visually overlapping the plate above them.
    placeChild(kid, carrier, placements, warnings, installRoot);
    applySiteOverride(kid, carrier, carrierY01);

    // Grandchildren — real layouts stack things like "WasteBlock" →
    // "teachingNeedleBlock" via chained templateRefs. Walk the
    // chain so every labware ends up somewhere rather than being
    // silently dropped.
    const grandkids = childrenOf.get(kid.id) ?? [];
    for (const gk of grandkids) {
      // Rare enough that we flatten onto the same carrier; if dims
      // conflict we flag and skip — never corrupt placements.
      if (!placeChild(gk, carrier, placements, warnings, installRoot)) {
        warnings.push({
          code: "missing_parent",
          labwareId: gk.id,
          message: `grandchild '${gk.id}' under '${kid.id}' could not be placed`,
        });
      }
    }
  }
  // Catch labware whose parent we skipped (e.g. WasteBlock-family).
  // We log a warning and leave them out rather than crashing.
  for (const e of byId.values()) {
    if (e.templateRef === carrierEntry.id && !kids.includes(e)) {
      warnings.push({
        code: "missing_parent",
        labwareId: e.id,
        message: `child '${e.id}' of carrier '${carrierEntry.id}' not placed`,
      });
    }
  }
}

function placeChild(
  kid: VenusLabware,
  carrier: Carrier,
  placements: ImportResult["placements"],
  warnings: ImportWarning[],
  installRoot: string | null,
): boolean {
  // Prefer the Hamilton-sourced path — parse the actual .rck to get
  // real rows/columns/pitch/boundary/hole-diameter. Fall back to the
  // labware-catalog (via labwareItemFromCatalog) only when the file
  // isn't on disk.
  let rackDef: RackDefinition | null = null;
  if (installRoot && kid.file) {
    const rckPath = resolveHamiltonPath(installRoot, kid.file, "labware");
    if (rckPath) {
      try { rackDef = readRackDefinition(rckPath); }
      catch (e: any) {
        warnings.push({
          code: "unknown_labware",
          labwareId: kid.id,
          message: `failed to parse .rck for '${kid.file}': ${e?.message ?? e}`,
        });
      }
    }
  }

  // .ctr (container) geometry — sits next to the .rck with a
  // matching stem (`Cos_96_DW_1mL.rck` → `Cos_96_DW_1mL.ctr`).
  // Provides well depth, max volume, cone-bottom flag — feeds the
  // liquid tracker + the inspector's volume badges. #55 part A.
  let ctrDef: ContainerDefinition | null = null;
  if (rackDef && installRoot) {
    try {
      const rckDir = path.dirname(rackDef.sourcePath);
      // Same-stem .ctr first (99 % of Hamilton cases), then any .ctr
      // declared by the rack's `Cntr` field.
      const stem = path.basename(rackDef.sourcePath, path.extname(rackDef.sourcePath));
      const sameStemCtr = path.join(rckDir, `${stem}.ctr`);
      if (fs.existsSync(sameStemCtr)) {
        ctrDef = readContainerDefinition(sameStemCtr);
      }
    } catch (e: any) {
      warnings.push({
        code: "unknown_labware",
        labwareId: kid.id,
        message: `failed to parse .ctr alongside '${kid.file}': ${e?.message ?? e}`,
      });
    }
  }

  let item: LabwareItem | null = null;
  if (rackDef) {
    item = buildLabwareFromHamiltonRack(rackDef, kid.stem, ctrDef);
    // Preserve ZTrans (stacking Z — top of well A1 above deck) as
    // `height`. buildLabwareFromHamiltonRack defaults to `Dim.Dz` (body
    // thickness), which the 3D renderer needs as `rackDz` but is the
    // wrong thing to treat as "height above deck" in physics. Override
    // with the real ZTrans when the .lay supplied one; `rackDz` then
    // carries the body thickness.
    if (kid.zTrans_mm !== undefined) {
      (item as LabwareItem).rackDz = Math.round(rackDef.dimensions.dz * 10);
      (item as LabwareItem).height = Math.round(kid.zTrans_mm * 10);
    } else {
      (item as LabwareItem).rackDz = Math.round(rackDef.dimensions.dz * 10);
    }
    // Carry well-hole diameter through so the 3D view can draw wells
    // and tips at their real size instead of guessing from pitch.
    (item as LabwareItem).holeDiameter = Math.round(rackDef.holeDiameter * 10);
  } else {
    const catalogType = LABWARE_BY_STEM[kid.stem];
    const fallback = catalogType ? labwareItemFromCatalog(catalogType) : undefined;
    if (!fallback) {
      warnings.push({
        code: "unknown_labware",
        labwareId: kid.id,
        message: `unknown labware '${kid.file}' and no Hamilton install available — skipping`,
      });
      return false;
    }
    item = fallback as LabwareItem;
  }
  if (kid.y_mm === undefined) {
    warnings.push({
      code: "missing_coord",
      labwareId: kid.id,
      message: `labware '${kid.id}' has no TForm.3.Y — cannot pick position`,
    });
    return false;
  }
  // Prefer VENUS's explicit SiteId when it's numeric and in range —
  // VENUS numbers sites 1..N back-to-front (SiteId 1 = rear = highest Y,
  // farthest from operator). The twin's `labware[]` array is now
  // 0-indexed REAR-to-FRONT (matching VENUS's SiteId ordering after
  // commit 350e791), so pos 0 = SiteId 1 and `siteNum - 1` is the
  // correct mapping. `applySiteOverride` uses the same `siteNum - 1`
  // → the two must agree, otherwise the .lay-stated siteYOffset for
  // SiteId N lands at the wrong array slot. Fall back to Y-nearest
  // matching for carriers whose SiteId is a non-numeric layout code.
  const siteNum = Number.parseInt(kid.siteId, 10);
  const position = Number.isFinite(siteNum) && siteNum >= 1 && siteNum <= carrier.positions
    ? siteNum - 1
    : closestPosition(carrier, kid.y_mm);
  if (position < 0) return false;

  alignLabwareToVenusFrame(item, kid, carrier);
  carrier.labware[position] = item;
  placements.push({
    labwareId: kid.id,
    carrierId: carrier.id,
    position,
    type: item.type,
  });
  return true;
}

/**
 * Pick the carrier position whose Y offset is closest to the child's
 * declared Y. VENUS places labware by absolute coords; the twin
 * stores carrier-relative site offsets. For carriers with
 * `siteYOffsets`, we match against those; otherwise we divide the
 * carrier Y-dim evenly across positions (same fallback the twin uses
 * for rendering).
 */
/**
 * Y-origin of the deck's front edge in 0.1 mm. Every `siteYOffsets[i]`
 * in a Carrier is relative to this origin so `resolvePosition()` can
 * add the two and compare to an incoming absolute Y. Keep in sync with
 * the matching constant in twin-internal deck code.
 */
// Alias kept for the sparse-carrier applySiteOverride below; everything
// else now imports Y_FRONT_EDGE from deck.ts.
const Y_FRONT = Y_FRONT_EDGE;

/**
 * Overwrite one slot of a carrier's siteYOffsets with the .lay's
 * observed labware Y. Called for every labware we place so each slot's
 * advertised Y matches exactly what VENUS expects — including sparse
 * carriers (e.g. two plates at sites 1 and 5, sites 2-4 empty) where
 * relying on the template's stock pitch produces the wrong result.
 *
 * Unresolved slots (the 2/3/4 in the sparse-plate example) keep their
 * template defaults. That's fine: VENUS won't address them during the
 * method since its own deck view knows those sites are empty, and
 * rendering-only code continues to show sensible slot placeholders.
 */
function applySiteOverride(kid: VenusLabware, carrier: Carrier, carrierY01: number): void {
  if (kid.y_mm === undefined) return;
  const siteNum = Number.parseInt(kid.siteId, 10);
  if (!Number.isFinite(siteNum) || siteNum < 1 || siteNum > carrier.positions) return;
  // Hamilton numbers sites 1..N with SiteId 1 at the REAR (highest Y /
  // top in the Y-flipped editor). We mirror that in our 0-based index:
  // position 0 = rear = VENUS SiteId 1, position N-1 = front = SiteId N.
  const idx = siteNum - 1;
  // The .lay's `TForm.3.Y` is the absolute deck-Y of the labware's
  // Row A anchor. The rest of the twin keeps `siteYOffsets` in
  // **site-floor** coords (catalog convention) — `posBaseY` is site
  // floor, `wellY = posBaseY + labware.offsetY - row * pitch`, and the
  // empty-slot placeholder assumes `posBaseY + 745` is Row A of a
  // reference SBS plate. Convert the .lay's Row A absolute Y back to
  // site floor by subtracting the placed labware's own `offsetY`.
  const placed = carrier.labware[idx];
  const labwareOffsetY = placed?.offsetY ?? 745;  // 74.5 mm SBS default
  const labwareY01 = Math.round(kid.y_mm * 10);
  const offset = labwareY01 - Y_FRONT - labwareOffsetY;
  // The carrier was constructed from a factory that may not have set
  // siteYOffsets at all — keep working either way.
  if (!carrier.siteYOffsets) carrier.siteYOffsets = new Array(carrier.positions);
  carrier.siteYOffsets[idx] = offset;
  // Also keep the carrier's y-origin in sync so renderer-side code that
  // reads carrier.yMin + siteYOffset[i] lines up with VENUS's frame.
  if ((carrier as any).yMin === undefined && carrierY01 >= 0) {
    (carrier as any).yMin = carrierY01;
  }
}

/**
 * Align a labware's offsetX with the .lay's absolute TForm.3.X.
 *
 * Our stock labware templates model the labware's origin as the
 * bottom-left outer corner — the first well sits at offsetX/offsetY
 * inside that rectangle. VENUS's .lay stores `TForm.3.X/.Y` as the
 * absolute deck coord of the labware's Row-A / Col-1 handling point
 * (after `ZTrans`). We keep the labware's own offsetY (its Row-A
 * inset from site floor, e.g. 745 for SBS plates) because the twin's
 * `siteYOffsets` are in site-floor coords, and the caller
 * `applySiteOverride` uses that same offsetY to back out the site
 * floor from `TForm.3.Y`. For X we still patch offsetX so Col 1 lands
 * on `TForm.3.X` regardless of the template default.
 */
function alignLabwareToVenusFrame(
  lw: LabwareItem,
  kid: VenusLabware,
  carrier: Carrier,
): void {
  if (kid.x_mm === undefined || kid.y_mm === undefined) return;
  const carrierLeftX_01 = trackLeftEdge(carrier.track);
  const labwareX_01 = Math.round(kid.x_mm * 10);
  // Labware Col-1 anchor on the carrier = labware abs X − carrier left X.
  // Subtract the labware's own offsetX so that when the renderer does
  // `col0_X = carrier.xMin + lw.offsetX`, we land exactly on Col-1.
  // Previously this was `labwareX_01 - carrierLeftX_01` plus zeroed
  // offsetY, which collapsed the labware's X inset. We keep offsetX
  // conceptually meaning "col-1 inset from labware origin", so the
  // labware origin = col1_abs − offsetX.
  lw.offsetX = labwareX_01 - carrierLeftX_01;
  // offsetY stays at the labware's own template / .rck value — see
  // applySiteOverride for why we keep site-floor convention everywhere.
}

/** Carrier origin X in 0.1 mm — VENUS places carriers with their
 *  `TForm.3.X` at the track-CENTER of the leftmost track (verified
 *  against Method1.lay 2026-04-19: PLT_CAR on track 8 reports
 *  257.5 mm = `trackToX(8)` exactly). Labware offsetX stored on a
 *  carrier is therefore measured from this point; the renderer then
 *  computes absolute col-1 X as `carrier.xMin + lw.offsetX`.
 *  Private to this module so we don't take a public API dependency. */
function trackLeftEdge(track: number): number {
  return 1000 + (track - 1) * 225;
}

/**
 * Build a twin Carrier from a Hamilton .tml CarrierTemplate.
 *
 * The .tml gives us yDim, per-site dimensions, widthAsTracks in mm
 * relative to the carrier's own frame. Combined with the carrier's
 * absolute deck-Y (from the .lay's TForm.3.Y), we can precompute
 * siteYOffsets for every slot — including empty ones — so the
 * renderer's `getSiteBaseY` doesn't fall back to an even-division
 * guess when a site has no labware. `applySiteOverride` subsequently
 * refines occupied slots with the actual labware Y from the .lay.
 *
 * Sites are sorted DESC by Y so slot 0 is the rearmost (VENUS SiteId 1
 * = pos 0). The twin stores `siteYOffsets` in **site-floor** coords —
 * i.e., the deck-Y where a labware's bottom-left outer corner sits,
 * NOT its Row A. `posBaseY = Y_FRONT + siteYOffsets[i]`; Row A of a
 * placed labware is then `posBaseY + labware.offsetY` (the labware's
 * own Row-A inset from its bottom-left, ≈ 74.5 mm for SBS plates).
 * Empty-slot placeholders use the same `posBaseY + 745` assumption.
 *
 * Previous versions stored Row A directly here (and in
 * `applySiteOverride`) while the renderer kept adding 745 on top,
 * which drew empty-slot rectangles 74.5 mm above their real site and
 * overlapped the plate above them.
 */
function buildCarrierFromHamiltonTemplate(
  tmpl: CarrierTemplate,
  track: number,
  id: string,
  carrierYmm: number,
): Carrier {
  // Sort DESCENDING by Y so siteYOffsets[0] = largest Y = rear of
  // carrier = top in the Y-flipped editor. Matches VENUS SiteId 1
  // ordering (see `applySiteOverride`).
  const sortedSites = [...tmpl.sites].sort((a, b) => b.y - a.y);
  const siteYOffsets: number[] = sortedSites.map((s) => {
    // Site floor absolute Y (0.1 mm), relative to the deck's front edge.
    const siteFloor_abs_mm = carrierYmm + s.y;
    return Math.round(siteFloor_abs_mm * 10) - Y_FRONT_EDGE;
  });
  // Some carriers declare widthAsTracks=1 even though their physical
  // dimensions.dx spans many tracks — Core96SlideWaste is 450 mm (≈ 20
  // tracks) wide but widthAsTracks=1 because VENUS addresses it at a
  // single mount point. Use the larger of the two so the renderer
  // draws the real footprint; otherwise the big green 96-head park
  // collapses into a 22.5-mm stripe. `ceil` (not `round`) so a 30-mm
  // WasteBlock covers 2 tracks — otherwise its child labware lands at
  // absolute X coords past the carrier's xMax and resolvePosition
  // reports "no carrier" on VENUS's tip-eject (see user report against
  // Method1.lay).
  // TRACK_PITCH from deck.ts is in 0.1 mm; the per-carrier width math
  // here lives in mm so divide.
  const physicalTracks = Math.max(1, Math.ceil(tmpl.dimensions.dx / (TRACK_PITCH / 10)));
  const widthTracks = Math.max(tmpl.widthAsTracks, physicalTracks);

  return {
    id,
    type: tmpl.name,
    track,
    widthTracks,
    positions: sortedSites.length,
    labware: new Array(sortedSites.length).fill(null),
    siteYOffsets,
    yDim: Math.round(tmpl.dimensions.dy * 10),
  };
}

/**
 * Build a twin LabwareItem from a Hamilton .rck RackDefinition.
 *
 * offsetX/Y stay at 0 — they get set via `alignLabwareToVenusFrame`
 * using the .lay's absolute TForm.3.X/Y so the row-A / column-1 anchor
 * lines up with the coordinate VENUS will ask the arm to travel to.
 *
 * The `type` string fed back into `LabwareItem.type` is used by
 * downstream physics (`pip-physics.validateCommand` matches `"Tip"` to
 * decide whether C0TP is legal, `"Trough"` / `"Wash"` to classify
 * single-well containers, etc.). Hamilton's own filename scheme
 * encodes the family — `st_l.rck`, `HT_L.rck`, `LTF_P.rck` are all
 * tip racks, `Cos_96_*` / `Greiner_*` are plates, `Trough_*` is a
 * reagent reservoir — so map back to the physics-layer vocabulary
 * here rather than teaching the physics layer to understand raw
 * stems. The description string provides an extra hint when a file
 * doesn't follow the conventional stems.
 */
function buildLabwareFromHamiltonRack(
  rack: RackDefinition,
  fileStem: string,
  ctr: ContainerDefinition | null,
): LabwareItem {
  const wellDepth_01mm = ctr && ctr.depth > 0 ? Math.round(ctr.depth * 10) : 0;
  // Convert µL → 0.1 µL units (the liquid-tracker's internal unit).
  const maxVolume_01ul = ctr && ctr.maxVolumeUl > 0 ? Math.round(ctr.maxVolumeUl * 10) : undefined;
  const deadVolume_01ul = ctr && ctr.deadVolumeUl > 0 ? Math.round(ctr.deadVolumeUl * 10) : undefined;
  // Row-A inset from labware bottom-left = rackDy − boundaryY (bndryY is
  // the top-inset). Twin stores `siteYOffsets` in site-floor coords, so
  // the renderer reconstructs `rowA = posBaseY + labware.offsetY`. A
  // zero here would collapse the plate onto the site floor and place
  // empty-slot placeholders at the wrong Y. Falls back to 745 (the SBS
  // plate row-A anchor) when the .rck doesn't carry outer dims.
  const rackDy_01 = Math.round(rack.dimensions.dy * 10);
  const bndryY_01 = Math.round(rack.boundaryY * 10);
  const rowAInset_01 = (rackDy_01 > 0 && bndryY_01 >= 0)
    ? Math.max(0, rackDy_01 - bndryY_01)
    : 745;
  return {
    type: classifyLabware(rack, fileStem),
    wellCount: rack.rows * rack.columns,
    rows: rack.rows,
    columns: rack.columns,
    wellPitch: Math.round(rack.pitchY * 10),
    offsetX: 0, // filled by alignLabwareToVenusFrame
    offsetY: rowAInset_01,
    height: Math.round(rack.dimensions.dz * 10),
    wellDepth: wellDepth_01mm,
    // Carry the rack footprint + first-well boundary straight from the
    // .rck so the renderer draws the labware body at its real outer
    // dimensions — 127×86 mm for a Cos_96_DW, 122.4×82.6 mm for a 300-
    // µL tip rack — instead of a pitch-based estimate.
    rackDx: Math.round(rack.dimensions.dx * 10),
    rackDy: Math.round(rack.dimensions.dy * 10),
    bndryX: Math.round(rack.boundaryX * 10),
    bndryY: Math.round(rack.boundaryY * 10),
    // Cntr.1.base: signed Z-offset of the container bottom below the
    // rack top face. Negative for tip racks / deep-wells. The 3D
    // view uses this to draw tip collars at true visible height.
    containerBase: Math.round(rack.containerBase * 10),
    holeShape: rack.holeShape,
    maxVolume: maxVolume_01ul,
    deadVolume: deadVolume_01ul,
    hasConicalBottom: ctr?.hasConicalBottom,
  };
}

/** Map a Hamilton rack file + description to the physics-layer type
 *  string the twin's plugins expect. Kept as a single function so the
 *  rules are easy to extend when new labware families show up. */
function classifyLabware(rack: RackDefinition, fileStem: string): string {
  const stem = fileStem || rack.name || "unknown";
  const desc = (rack.description || "").toLowerCase();
  const isTipByStem = /^(ht|st|lt|htf|stf|ltf|ftf)_[lp]$/i.test(stem)
    || /^4?ml?tf?_[lp]$/i.test(stem)
    || stem.toLowerCase().startsWith("tips_")
    || stem.toLowerCase().startsWith("diti");
  const isTipByDesc = /\btip\b/.test(desc) || /\bditi\b/.test(desc);
  if (isTipByStem || isTipByDesc) {
    const volMatch = desc.match(/(\d+)\s*ul/i);
    const vol = volMatch ? `${volMatch[1]}uL` : "";
    return vol ? `Tips_${vol}` : `Tips_${stem}`;
  }
  if (/trough|reservoir/.test(desc) || stem.toLowerCase().includes("trough")) {
    return "Trough";
  }
  if (/\bwash\b/.test(desc) || stem.toLowerCase().includes("wash")) {
    return "Wash";
  }
  // Default: keep the stem. Downstream renderer uses `includes("Tip")` /
  // `includes("Trough")` / `includes("Wash")` / falls through to plate
  // styling otherwise — which is the right call for MTPs / deep-well /
  // PCR plates whose stems already read like `Cos_96_DW_1mL`.
  return stem;
}

function closestPosition(carrier: Carrier, yMm: number): number {
  const y_01mm = Math.round(yMm * 10);
  const offsets = carrier.siteYOffsets
    ?? inferOffsets(carrier);
  if (offsets.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < offsets.length; i++) {
    const siteY = Y_FRONT + offsets[i];
    const d = Math.abs(siteY - y_01mm);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  // Clamp to the carrier's available positions — some templates omit
  // offsets past `positions` even though the array was longer.
  if (best >= carrier.positions) best = carrier.positions - 1;
  return best;
}

function inferOffsets(carrier: Carrier): number[] {
  const yDim = carrier.yDim ?? 4970;
  const offsets: number[] = [];
  const step = yDim / Math.max(1, carrier.positions);
  for (let i = 0; i < carrier.positions; i++) {
    offsets.push(Math.round(step * i + step / 2));
  }
  return offsets;
}

/** Twin's `xOffset` is 100 mm to track 1 centre; pitch is 22.5 mm. */
function venusXToTrack(x_mm: number): number {
  const x_01mm = x_mm * 10;
  return Math.round((x_01mm - 1000) / 225) + 1;
}

function fileStem(file: string): string {
  // VENUS files use backslash separators. Extract basename without
  // extension for our registry lookup.
  const base = file.split(/[\\/]/).pop() ?? file;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
