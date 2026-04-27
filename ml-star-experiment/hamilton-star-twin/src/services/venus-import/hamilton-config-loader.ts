/**
 * Hamilton config-file loader (issue #55 core).
 *
 * Instead of baking in stock deck dimensions — which only happen to
 * match the stock STAR and break on every real-customer .lay — this
 * module reads the same HxCfgFile artefacts VENUS itself reads at
 * runtime. Labware + carrier geometry both flow through their
 * single-source-of-truth catalogs (labware-catalog.ts +
 * carrier-catalog.ts) when a .rck / .tml isn't available on disk:
 *
 *   .dck  — deck definition (dims, origin, per-track sites)
 *   .tml  — carrier template (outer dims, per-site slots, labware refs)
 *   .rck  — rack / labware definition (well count, pitch, boundary)
 *   .ctr  — container / well geometry (optional, referenced by .rck)
 *
 * All four are HxCfgFile sections and our `parseHxCfg(Buffer|string)`
 * already decodes both the text and the binary serialisations. This
 * file layers typed extractors on top so downstream importers can drop
 * the hand-written fallback tables.
 *
 * Units: Hamilton stores distances in **millimetres** in these files;
 * we preserve that in the returned shapes and let callers convert to
 * the twin's internal 0.1 mm where they need to.
 *
 * Resolution: `.lay` files reference siblings by repo-relative paths
 * like `ML_STAR\TIP_CAR_480_ST_A00.tml` or
 * `CORNING-COSTAR\Cos_96_DW_1mL.rck`. `resolveHamiltonPath()` maps
 * those against an install root so a .lay loaded from
 * `C:/…/Methods/Method1.lay` finds its rack file under
 * `C:/…/Labware/ML_STAR/st_l.rck`.
 */

import * as fs from "fs";
import * as path from "path";
import { parseHxCfg, getStr, getNum, findSection, HxCfgObject, HxCfgSection } from "./hxcfg-parser";

// ============================================================================
// Types — one shape per Hamilton file family
// ============================================================================

export interface DeckSite {
  id: string;
  /** Site origin in mm, deck frame. */
  x: number;
  y: number;
  /** Site extent in mm. */
  dx: number;
  dy: number;
  visible: boolean;
}

export interface DeckConfig {
  /** File the data came from — carried so callers can log resolution. */
  sourcePath: string;
  /** Section name ("default" in every real file we've seen). */
  name: string;
  dimensions: { dx: number; dy: number; dz: number };
  origin: { x: number; y: number; z: number };
  sites: DeckSite[];
  /** Optional 3D model + textures referenced by the .dck, kept as-is. */
  model3D?: string;
}

export interface CarrierSite {
  /** VENUS-facing site id (often "1", "2" … but can be "3", "6T-1", etc.). */
  id: string;
  /** Offset in mm from the carrier's own origin (lower-left, Hamilton frame). */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Relative path to the .rck/.tml that normally sits at this site. */
  labwareFile?: string;
  /** `SnapBase=1` is the common case; SnapStack carriers stack labware. */
  snapBase: boolean;
  stack: boolean;
}

export interface CarrierTemplate {
  sourcePath: string;
  /** e.g. "TIP_CAR_480_A00" — NOT the .lay's instance id. */
  name: string;
  description: string;
  dimensions: { dx: number; dy: number; dz: number };
  sites: CarrierSite[];
  /** Width in tracks (6 for a full plate/tip carrier, 3 for a waste block). */
  widthAsTracks: number;
  /** Track raster pitch in mm — 22.5 on STAR. */
  rasterWidthMm: number;
  /** Hamilton's own property bag — kept verbatim for callers that need it. */
  properties: Record<string, string>;
}

export interface RackDefinition {
  sourcePath: string;
  name: string;
  description: string;
  dimensions: { dx: number; dy: number; dz: number };
  rows: number;
  columns: number;
  /** Well pitch in mm along X (columns) and Y (rows). */
  pitchX: number;
  pitchY: number;
  /** First-well centre offset from the rack's lower-left corner, mm. */
  boundaryX: number;
  boundaryY: number;
  /** Well "hole" diameter in mm — 6.8 for most tips/plates. */
  holeDiameter: number;
  /** Hamilton hole shape code (0 = round, 1 = square/rect). Drives
   *  whether the 3D renderer cuts a cylinder or a box in the rack top. */
  holeShape: number;
  /** Hole depth in mm (Hole.Z) — how deep the cut-out goes into the
   *  rack top. Distinct from the well depth in the .ctr (which
   *  measures the container interior from rim to bottom). */
  holeDepth: number;
  /** .ctr file referenced for per-well geometry (conical/flat, depth…). */
  containerFile?: string;
  containerOffsetX: number;
  containerOffsetY: number;
  /** Z-offset of the container's internal origin relative to the
   *  rack's top face, signed. Negative values (the common case for
   *  tip racks and deep-well plates) mean the well bottom sits
   *  BELOW the rack top by |base| mm — which is exactly what the
   *  3D view needs to know to draw tips at their true visible
   *  collar height. From `Cntr.1.base` in the .rck. */
  containerBase: number;
}

export interface ContainerDefinition {
  sourcePath: string;
  name: string;
  /** Outer diameter at the top of the well, mm. */
  diameter: number;
  /** Well depth from the top opening to the bottom tip, mm. */
  depth: number;
  /** Dead volume — liquid that cannot be aspirated, in µL. */
  deadVolumeUl: number;
  /** Cone angle if conical, 0 if flat. */
  coneAngleDeg: number;
  /** Maximum usable volume — computed from segment geometry when
   *  available, else 0. µL. */
  maxVolumeUl: number;
  /** True if the well has a conical (tapered) bottom segment. */
  hasConicalBottom: boolean;
}

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Resolve a VENUS-style repo path (e.g. `ML_STAR\st_l.rck` or
 * `CORNING-COSTAR\Cos_96_DW_1mL.rck`) against a Hamilton install's
 * `Labware/` root (typically `C:\Program Files (x86)\Hamilton\Labware\`).
 *
 * .dck files live under `Config/`, not `Labware/`, so pass `kind="deck"`
 * to route accordingly.
 *
 * Returns `null` if the file isn't found — caller decides whether that's
 * fatal. We do NOT fall back to any bundled template.
 */
export function resolveHamiltonPath(
  installRoot: string,
  reference: string,
  kind: "labware" | "deck",
): string | null {
  // VENUS files use backslashes even on paths that don't exist on disk
  // as a single string — normalise to forward slashes for consistency.
  const rel = reference.replace(/\\/g, "/").replace(/^\.\//, "");
  const baseDir = kind === "deck" ? "Config" : "Labware";
  const candidate = path.join(installRoot, baseDir, rel);
  if (fs.existsSync(candidate)) return candidate;
  // Some .lay references already include the category dir, some don't.
  // Try the install root directly as a last resort.
  const flat = path.join(installRoot, rel);
  if (fs.existsSync(flat)) return flat;
  return null;
}

/**
 * Default install root resolver — tries the standard Windows install
 * location first, then `$HAMILTON_ROOT` if set. Returns the first that
 * actually contains a `Labware/` dir, or null if none do.
 */
export function findHamiltonInstallRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.HAMILTON_ROOT) candidates.push(process.env.HAMILTON_ROOT);
  candidates.push("C:/Program Files (x86)/Hamilton");
  candidates.push("C:/Program Files/Hamilton");
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "Labware")) || fs.existsSync(path.join(c, "Config"))) {
        return c;
      }
    } catch {
      // keep going
    }
  }
  return null;
}

// ============================================================================
// Deck (.dck)
// ============================================================================

export function readDeckConfig(dckPath: string): DeckConfig {
  const buf = fs.readFileSync(dckPath);
  const doc = parseHxCfg(buf);
  const section = findSection(doc, "DECK");
  if (!section) {
    throw new Error(`readDeckConfig: no DECK section in ${dckPath}`);
  }
  const body = section.body as HxCfgObject;
  const sites = extractIndexed(body, "Site").map(
    ({ index, child }): DeckSite => ({
      id: getStr(child, "Id") ?? String(index),
      x: getNum(child, "X") ?? 0,
      y: getNum(child, "Y") ?? 0,
      dx: getNum(child, "Dx") ?? 0,
      dy: getNum(child, "Dy") ?? 0,
      visible: (getStr(child, "Visible") ?? "1") !== "0",
    }),
  );
  return {
    sourcePath: dckPath,
    name: section.name,
    dimensions: {
      dx: getNum(body, "Dim.Dx") ?? 0,
      dy: getNum(body, "Dim.Dy") ?? 0,
      dz: getNum(body, "Dim.Dz") ?? 0,
    },
    origin: {
      x: getNum(body, "Origin.X") ?? 0,
      y: getNum(body, "Origin.Y") ?? 0,
      z: getNum(body, "Origin.Z") ?? 0,
    },
    sites,
    model3D: getStr(body, "3DModel"),
  };
}

// ============================================================================
// Carrier template (.tml)
// ============================================================================

export function readCarrierTemplate(tmlPath: string): CarrierTemplate {
  const buf = fs.readFileSync(tmlPath);
  const doc = parseHxCfg(buf);
  const section = findSection(doc, "TEMPLATE");
  if (!section) throw new Error(`readCarrierTemplate: no TEMPLATE section in ${tmlPath}`);
  const body = section.body as HxCfgObject;

  // `Property.N = <name>, PropertyValue.N = <value>` is how Hamilton
  // attaches MLStar-specific metadata (raster width, track width, BC
  // orientation, …). Flatten into a plain string map so callers don't
  // need to index into both arrays.
  const properties = extractPropertyValues(body);

  const widthAsTracks = Number.parseInt(properties.MlStarCarWidthAsT ?? "", 10) || 1;
  const rasterWidthMm = (Number.parseInt(properties.MlStarCarRasterWidth ?? "", 10) || 225) / 10;

  const sites = extractIndexed(body, "Site").map(
    ({ index, child }): CarrierSite => ({
      id: getStr(child, "Id") ?? String(index),
      x: getNum(child, "X") ?? 0,
      y: getNum(child, "Y") ?? 0,
      dx: getNum(child, "Dx") ?? 0,
      dy: getNum(child, "Dy") ?? 0,
      labwareFile: getStr(child, "LabwareFile") ?? undefined,
      snapBase: (getStr(child, "SnapBase") ?? "1") !== "0",
      stack: (getStr(child, "Stack") ?? "0") !== "0",
    }),
  );

  // Derive a template name — prefer MlStarCarLabelName, fall back to the
  // file stem. Both the .lay and C0QM reference carriers by this name.
  const labelName = properties.MlStarCarLabelName
    || path.basename(tmlPath).replace(/\.tml$/i, "");

  return {
    sourcePath: tmlPath,
    name: labelName,
    description: getStr(body, "Description") ?? "",
    dimensions: {
      dx: getNum(body, "Dim.Dx") ?? 0,
      dy: getNum(body, "Dim.Dy") ?? 0,
      dz: getNum(body, "Dim.Dz") ?? 0,
    },
    sites,
    widthAsTracks,
    rasterWidthMm,
    properties,
  };
}

// ============================================================================
// Rack / labware (.rck)
// ============================================================================

export function readRackDefinition(rckPath: string): RackDefinition {
  const buf = fs.readFileSync(rckPath);
  const doc = parseHxCfg(buf);
  const section = findSection(doc, "RECTRACK") ?? findSection(doc, "DIVTRACK");
  if (!section) throw new Error(`readRackDefinition: no RECTRACK/DIVTRACK section in ${rckPath}`);
  const body = section.body as HxCfgObject;

  // Hamilton uses IX.First/IX.Inc/IX.Start/IX.Index to lay out grids in
  // unusual stepping patterns; for flat 8×12 / 16×24 plates we can
  // rely on `Columns` + infer rows from wellCount if set, else guess
  // from Dim.Dy / Dy pitch.
  const columns = Number.parseInt(getStr(body, "Columns") ?? "", 10) || 12;
  const pitchY = getNum(body, "Dy") ?? 9;
  const dimY = getNum(body, "Dim.Dy") ?? 0;
  const rows = pitchY > 0 && dimY > 0
    ? Math.max(1, Math.round((dimY - 2 * (getNum(body, "BndryY") ?? 0)) / pitchY) + 1)
    : 8;

  const container = extractIndexed(body, "Cntr")[0]?.child;

  return {
    sourcePath: rckPath,
    name: section.name,
    description: getStr(body, "Description") ?? "",
    dimensions: {
      dx: getNum(body, "Dim.Dx") ?? 0,
      dy: dimY,
      dz: getNum(body, "Dim.Dz") ?? 0,
    },
    rows,
    columns,
    pitchX: getNum(body, "Dx") ?? 9,
    pitchY,
    boundaryX: getNum(body, "BndryX") ?? 0,
    boundaryY: getNum(body, "BndryY") ?? 0,
    holeDiameter: getNum(body, "Hole.X") ?? getNum(body, "Hole.Y") ?? 6.8,
    holeShape: getNum(body, "Hole.Shape") ?? 0,
    holeDepth: getNum(body, "Hole.Z") ?? 0,
    containerFile: container ? getStr(container, "file") : undefined,
    containerOffsetX: container ? (getNum(container, "offsetx") ?? 0) : 0,
    containerOffsetY: container ? (getNum(container, "offsety") ?? 0) : 0,
    containerBase: container ? (getNum(container, "base") ?? 0) : 0,
  };
}

// ============================================================================
// Container (.ctr) — optional, a few fields of interest for volume tracking
// ============================================================================

export function readContainerDefinition(ctrPath: string): ContainerDefinition {
  const buf = fs.readFileSync(ctrPath);
  const doc = parseHxCfg(buf);
  const section = findSection(doc, "CNTR") ?? doc.sections[0];
  if (!section) throw new Error(`readContainerDefinition: no CNTR section in ${ctrPath}`);
  const body = section.body as HxCfgObject;
  // Real Hamilton .ctr files describe the well as a stack of numbered
  // `Segments` children — each a `{DX, DY, DZ, Shape, Min, Max,
  // EqnOfVol}` block. Segment index 1 is the topmost (usually a
  // cylinder), index N the bottom. Shape: 0=cylinder/prism,
  // 4=cone/pyramid. We enumerate them to answer "is the well conical
  // at the bottom?" (hasConicalBottom → inspector cue). For volume,
  // we use the well's top dimensions (`Dim.Dx/Dy`) + `Depth` as a
  // cylindrical/prismatic upper bound rather than parsing the
  // `EqnOfVol` expressions — those are Hamilton-specific formulas
  // (e.g. "h*h*(10.2102 - 1.0472*h)" for a conical bottom) that need
  // a proper expression evaluator to integrate. A cylindrical upper
  // bound is close enough for UI / tooltips (actual fill stops below
  // max anyway due to pipetting headroom) and clearly-labelled.
  // Hamilton .ctr segment shape codes observed in the Corning-Costar +
  // Hamilton labware set under VENUS-2026-04-13/:
  //   0/1 → prism (square/rect cross-section, straight walls)
  //   3   → cylinder (round, straight walls)
  //   4   → hemisphere / tapered cone at the well bottom
  //   5   → V-bottom (pointed cone)
  // Earlier revisions of this parser flagged any non-0 shape as
  // "conical", which spuriously marked every cylindrical-well plate
  // (Cos_96_Rd, Cos_96_Fl, Cos_384_Sq) as having a cone. Only shapes
  // 4 and 5 actually indicate a non-flat bottom.
  const NON_FLAT_SHAPES = new Set([4, 5]);
  const segCount = Math.max(0, Math.floor(getNum(body, "Segments") ?? 0));
  let hasCone = false;
  let coneHeight = 0;  // mm — height of the bottom non-flat segment (min==0)
  for (let i = 1; i <= segCount; i++) {
    const seg = body[String(i)] as HxCfgObject | undefined;
    if (!seg) continue;
    const shape = getNum(seg, "Shape") ?? 0;
    const min = getNum(seg, "Min") ?? 0;
    const max = getNum(seg, "Max") ?? 0;
    if (NON_FLAT_SHAPES.has(shape)) {
      hasCone = true;
      if (min === 0) coneHeight = Math.max(0, max - min);
    }
  }

  const depth_mm = getNum(body, "Depth") ?? getNum(body, "Dim.Dz") ?? 0;
  const dia_mm = getNum(body, "Dia") ?? getNum(body, "Diameter") ?? getNum(body, "Dim.Dx") ?? 0;
  const dy_mm = getNum(body, "Dim.Dy") ?? dia_mm;
  // Cross-section area (mm²). Rectangular if Dx ≠ Dy (e.g. a
  // reservoir), circular otherwise.
  const area_mm2 = dia_mm > 0 && dy_mm > 0
    ? (Math.abs(dia_mm - dy_mm) < 0.01 ? Math.PI * (dia_mm / 2) * (dia_mm / 2) : dia_mm * dy_mm)
    : 0;
  // Max volume: cylindrical upper bound across the full depth.
  const maxVolumeUl = area_mm2 > 0 && depth_mm > 0 ? area_mm2 * depth_mm : 0;
  // Dead volume: cylinder × cone-height gives a rough floor for what
  // a tip can't reach. Callers that have a real explicit value
  // (`DeadVolume` field in the .ctr, rare but possible) win.
  const explicitDead = getNum(body, "DeadVolume");
  const deadVolumeUl = explicitDead
    ?? (area_mm2 > 0 && coneHeight > 0 ? area_mm2 * coneHeight : 0);

  return {
    sourcePath: ctrPath,
    name: section.name,
    diameter: getNum(body, "Dia") ?? getNum(body, "Diameter") ?? getNum(body, "Dim.Dx") ?? 0,
    depth: getNum(body, "Depth") ?? getNum(body, "Dim.Dz") ?? 0,
    deadVolumeUl: Math.round(deadVolumeUl * 10) / 10,
    coneAngleDeg: getNum(body, "ConeAngle") ?? 0,
    maxVolumeUl: Math.round(maxVolumeUl * 10) / 10,
    hasConicalBottom: hasCone,
  };
}

// ============================================================================
// Local helpers (module-private)
// ============================================================================

/** Flatten `Property.N = key; PropertyValue.N = value` pairs into a map. */
function extractPropertyValues(body: HxCfgObject): Record<string, string> {
  const props = extractIndexed(body, "Property");
  const values = extractIndexed(body, "PropertyValue");
  const out: Record<string, string> = {};
  for (const { index, child } of props) {
    const name = typeof child === "string" ? child : "";
    const valEntry = values.find((v) => v.index === index);
    const val = valEntry && typeof valEntry.child === "string" ? valEntry.child : "";
    if (name) out[name] = val;
  }
  return out;
}

/**
 * Pull out a dotted-prefix family: for `Site.1.X`, `Site.1.Y`, `Site.2.X` …
 * returns `[{index:1, child:<Site.1 object>}, {index:2, child:<Site.2 object>}, …]`.
 * Handles scalar leaves too — `Property.1 = "foo"` gives `{index:1, child:"foo"}`.
 */
function extractIndexed(
  body: HxCfgObject,
  prefix: string,
): Array<{ index: number; child: any }> {
  const group = body[prefix];
  if (!group || typeof group !== "object") return [];
  const out: Array<{ index: number; child: any }> = [];
  for (const k of Object.keys(group)) {
    const idx = Number.parseInt(k, 10);
    if (!Number.isFinite(idx)) continue;
    out.push({ index: idx, child: (group as HxCfgObject)[k] });
  }
  return out.sort((a, b) => a.index - b.index);
}
