/**
 * VENUS configuration adapter
 *
 * VENUS cross-checks several FW values during `Discover Instruments` and
 * method init (`C0QM`, `C0RM`, `C0RI`, `C0RF`, `C0RU`). Every time the
 * user's deck differs from our hard-coded defaults we used to see a new
 * "VENUS rejected X" bug. This module centralises the derivation:
 *
 *   1. Start from `DEFAULT_CONFIG` (minimal single-arm STAR).
 *   2. Scan the loaded `Deck` for labware that implies an installed
 *      module (e.g. a 96-head waste → `core96Head` bit).
 *   3. Optionally parse the user's `ML_STAR.cfg` for additional overrides.
 *   4. Apply user CLI overrides last.
 *
 * The module bit tables mirror
 *   VENUS-2026-04-13/Star/src/HxAtsInstrument/Code/
 *     CommonInternalDeclarations.h:85-124
 * — `ka` is the `C0QM` low bitmask, `ke` the extended one, `kb` the
 * `C0RM` runtime-status byte.
 */

import * as fs from "fs";
import { Deck } from "./deck";

// ============================================================================
// Bit tables
// ============================================================================

/** `C0QM` ka module bits — CommonInternalDeclarations.h:94-117. */
export const MODULE_BITS = {
  newLeftXDrive:    0x000001,
  core96Head:       0x000002,
  newRightXDrive:   0x000004,
  core96HeadWasher: 0x000008,
  pumpStation2:     0x000010,
  typeOfWasher1:    0x000020,
  typeOfWasher2:    0x000040,
  leftCover:        0x000080,
  rightCover:       0x000100,
  addFrontCover:    0x000200,
  pumpStation3:     0x000400,
  nanoDispenser:    0x000800,
  head384Dispense:  0x001000,
  xlChannel:        0x002000,
  headGripper:      0x004000,
  wasteDirection:   0x008000,
  iswapGripperSize: 0x010000,
  addNanoDispenser: 0x020000,
  imageChannel:     0x040000,
  capperChannel:    0x080000,
  gelCardGripper:   0x800000,
} as const;

/** `C0QM` ke extended module bits. */
export const EXTENDED_MODULE_BITS = {
  punchCardGripper: 0x01,
  puncherModule:    0x02,
  twisterDecapper1: 0x10,
  twisterDecapper2: 0x20,
  twisterDecapper3: 0x40,
  twisterDecapper4: 0x80,
} as const;

/** `C0RM` kb runtime-status bits — CommonInternalDeclarations.h:85-91. */
export const STATUS_BITS = {
  gripperMod:   0x02,
  autoLoad:     0x08,
  washer_1:     0x10,
  washer_2:     0x20,
  temperatur_1: 0x40,
  temperatur_2: 0x80,
} as const;

// ============================================================================
// VenusConfig type + defaults
// ============================================================================

/** Values that drive the twin's VENUS-facing FW responses. */
export interface VenusConfig {
  /** C0RI serial number (the `sn...` payload). */
  serial: string;
  /** C0RI production date "YYYY-MM-DD". */
  productionDate: string;
  /** C0RF version line — "rf<ver> <build> YYYY-MM-DD (<comp>)" payload. */
  firmwareVersion: string;
  /** Deck tracks — emitted as C0QM xt/xa. */
  totalTracks: number;
  /** C0QM xw special-eject X position (0.1mm). */
  specialEjectX: number;
  /** C0QM ka module bitmask (low 24 bits). */
  moduleBits: number;
  /** C0QM ke extended module bitmask (8 bits). */
  extendedModuleBits: number;
  /** C0RM kb runtime-status bitmask (8 bits). */
  statusBits: number;
  /** C0RM kp active pipetting channel count. */
  pipChannels: number;
  /** C0RU left-arm X range [min, max] in 0.1mm. */
  leftArmXRange: [number, number];
  /** C0RU right-arm X range [min, max] in 0.1mm. Equal min/max signals
   *  "no right arm" (single-arm STAR). */
  rightArmXRange: [number, number];
}

/** Minimal instrument: single left arm, covers, iSWAP slot, no 96-head. */
export const DEFAULT_CONFIG: VenusConfig = {
  serial: "559I",
  productionDate: "2022-05-31",
  firmwareVersion: "7.6S 35 2025-10-22 (GRU C0)",
  totalTracks: 54,
  specialEjectX: 13400,
  moduleBits:
    MODULE_BITS.newLeftXDrive |
    MODULE_BITS.rightCover |
    MODULE_BITS.addFrontCover |
    MODULE_BITS.iswapGripperSize, // 0x010301
  extendedModuleBits: 0,
  statusBits: 0x0F, // matches real 54-track traces
  pipChannels: 8,
  leftArmXRange: [950, 13400],
  rightArmXRange: [30000, 30000],
};

// ============================================================================
// HxCfgFil parser (sectioned)
// ============================================================================

/** Parse an HxCfgFil file into per-DataDef section maps.
 *
 *  Format:
 *    `DataDef,<Name>,<Version>,<Variant>,`
 *    `{`
 *    `  Key, "Value",`
 *    `  ...`
 *    `};`
 *
 *  `*` introduces a line comment (rest of line is ignored). Keys may be
 *  dotted (`CommConfig.Baudrate`) or indexed (`1.V.2.K`).
 */
export function parseHxCfgSections(
  content: string,
): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  const lines = content.replace(/\r/g, "").split("\n");

  let currentName: string | null = null;
  let currentMap: Map<string, string> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s*\*.*$/, "").trim(); // strip `*` comments
    if (!line) continue;

    const header = line.match(/^DataDef\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,?$/);
    if (header) {
      currentName = `${header[1].trim()}:${header[3].trim()}`;
      currentMap = sections.get(currentName) ?? new Map();
      sections.set(currentName, currentMap);
      continue;
    }
    if (line === "{") continue;
    if (line === "};" || line === "}") {
      currentName = null;
      currentMap = null;
      continue;
    }
    if (!currentMap) continue;

    const kv = line.match(/^([A-Za-z0-9_.]+)\s*,\s*"([^"]*)"/);
    if (kv) currentMap.set(kv[1], kv[2]);
  }

  return sections;
}

/** Extract `VenusConfig` fields we can pull straight out of ML_STAR.cfg. */
export function extractCfgValues(
  sections: Map<string, Map<string, string>>,
): Partial<VenusConfig> {
  const out: Partial<VenusConfig> = {};

  // HxTcpIpBdzComm.ModuleId → serial (when set)
  const bdz = sections.get("HxTcpIpBdzComm:default");
  const moduleId = bdz?.get("ModuleId")?.trim();
  if (moduleId && moduleId !== "1" && moduleId !== "") out.serial = moduleId;

  // Latest entry in FirmwareCompatibility list → firmware version.
  // Each entry is `N.K,"<version>"` / `N.V.M.K,"<minor>"`. We pick
  // the highest-indexed major.
  const fwc = sections.get("HxPars:FirmwareCompatibility");
  if (fwc) {
    let bestIdx = -1;
    let bestVer = "";
    for (const [key, val] of fwc) {
      const m = key.match(/^(\d+)\.K$/);
      if (m && val.startsWith("C0")) {
        const idx = Number(m[1]);
        if (idx > bestIdx) {
          bestIdx = idx;
          // `7.6E` or `7.6S` — keep the whole compat entry
          const verVal = fwc.get(`${idx}.V.1.K`);
          if (verVal) bestVer = verVal;
        }
      }
    }
    // Too fuzzy to map to a full C0RF line; skip unless we grew confidence.
    void bestVer;
  }

  return out;
}

// ============================================================================
// Deck-based inference
// ============================================================================

/** Pattern tests that flip ka/ke/kb bits when a matching carrier is on-deck.
 *  Keep the list narrow — every false positive sends VENUS hunting for a
 *  module that isn't there. */
interface DeckBitRule {
  moduleBits?: number;
  extendedModuleBits?: number;
  statusBits?: number;
  matches(carrierType: string, labwareTypes: string[]): boolean;
}

const DECK_RULES: DeckBitRule[] = [
  // 96-head waste labware → core96Head bit. VENUS refuses init without
  // matching labware if the bit is set, and raises "Default waste for
  // C0-RE 96 Head is missing" if the bit is clear but the step uses a
  // 96-head; matching via labware is the reliable signal.
  {
    moduleBits: MODULE_BITS.core96Head,
    matches: (_c, lw) => lw.some((t) => /(Core96|MPH96|96.*Waste|Head96)/i.test(t)),
  },
  // 384-head
  {
    moduleBits: MODULE_BITS.head384Dispense,
    matches: (_c, lw) => lw.some((t) => /(384.*Head|MPH384|Head384)/i.test(t)),
  },
  // CO-RE head gripper (iSwap is ALREADY in DEFAULT_CONFIG; this is the
  // dedicated head-gripper accessory).
  {
    moduleBits: MODULE_BITS.headGripper,
    matches: (c) => /HeadGripper/i.test(c),
  },
];

/** Per-carrier rules (the carrier itself, independent of labware on it). */
const CARRIER_RULES: DeckBitRule[] = [
  // Autoload — inferred from any carrier placed on the autoload track band.
  // For now, go by name: VENUS autoload carriers contain "AUTO" or
  // have the autoload-specific "AL_" prefix.
  {
    statusBits: STATUS_BITS.autoLoad,
    matches: (c) => /(^AL_|AUTOLOAD|_AUTO)/i.test(c),
  },
];

/** Inspect the deck and return a Partial<VenusConfig> describing the
 *  extra bits (and track count) that follow from what's on it. */
export function inferFromDeck(deck: Deck): Partial<VenusConfig> {
  const snapshot = deck.getSnapshot();
  const carriers = snapshot.carriers;
  const labwareTypes = new Set<string>();
  for (const c of carriers) {
    for (const lw of c.labware) if (lw) labwareTypes.add(lw.type);
  }
  const labwareList = Array.from(labwareTypes);

  let extraModule = 0;
  let extraExtended = 0;
  let extraStatus = 0;

  for (const c of carriers) {
    const carrierLw = c.labware.filter((x): x is NonNullable<typeof x> => !!x).map((x) => x.type);
    for (const rule of DECK_RULES) {
      if (rule.matches(c.type, carrierLw)) {
        extraModule |= rule.moduleBits ?? 0;
        extraExtended |= rule.extendedModuleBits ?? 0;
        extraStatus |= rule.statusBits ?? 0;
      }
    }
    for (const rule of CARRIER_RULES) {
      if (rule.matches(c.type, carrierLw)) {
        extraModule |= rule.moduleBits ?? 0;
        extraExtended |= rule.extendedModuleBits ?? 0;
        extraStatus |= rule.statusBits ?? 0;
      }
    }
  }

  // Global scan across all deck labware for rules that don't care about
  // which carrier they sit on.
  for (const rule of DECK_RULES) {
    if (rule.matches("", labwareList)) {
      extraModule |= rule.moduleBits ?? 0;
      extraExtended |= rule.extendedModuleBits ?? 0;
      extraStatus |= rule.statusBits ?? 0;
    }
  }

  const inferred: Partial<VenusConfig> = {
    totalTracks: snapshot.totalTracks,
  };
  if (extraModule) inferred.moduleBits = DEFAULT_CONFIG.moduleBits | extraModule;
  if (extraExtended) inferred.extendedModuleBits = extraExtended;
  if (extraStatus) inferred.statusBits = DEFAULT_CONFIG.statusBits | extraStatus;
  return inferred;
}

// ============================================================================
// Top-level builder
// ============================================================================

export interface BuildConfigOptions {
  deck?: Deck;
  /** Absolute path to an ML_STAR.cfg. */
  cfgPath?: string;
  /** Parsed sections (alternative to `cfgPath` — handy in tests). */
  cfgSections?: Map<string, Map<string, string>>;
  /** User overrides — highest precedence. */
  overrides?: Partial<VenusConfig>;
}

/** Merge all sources into a final VenusConfig. Precedence (low → high):
 *  defaults → deck inference → cfg-file values → explicit overrides. */
export function buildVenusConfig(opts: BuildConfigOptions = {}): VenusConfig {
  const layers: Partial<VenusConfig>[] = [DEFAULT_CONFIG];

  if (opts.deck) layers.push(inferFromDeck(opts.deck));

  let sections = opts.cfgSections;
  if (!sections && opts.cfgPath) {
    const content = fs.readFileSync(opts.cfgPath, "utf-8");
    sections = parseHxCfgSections(content);
  }
  if (sections) layers.push(extractCfgValues(sections));

  if (opts.overrides) layers.push(opts.overrides);

  return Object.assign({}, ...layers) as VenusConfig;
}

// ============================================================================
// FW payload encoders — centralised so unit tests can lock the wire format.
// ============================================================================

/** Format a ka/ke module bitmask as 6 hex digits (C0QM convention). */
function hex6(n: number): string {
  return (n & 0xffffff).toString(16).toLowerCase().padStart(6, "0");
}
function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}
function pad5(n: number): string {
  return Math.max(0, Math.min(99999, Math.round(n))).toString().padStart(5, "0");
}

/** Build the C0QM response payload (no leading key). Pinned format:
 *   "ka010301xt54xa54xw13400xl07xr00xm03600xx11400ys090xu3540xv3700..."
 */
export function encodeC0QM(cfg: VenusConfig): string {
  const ka = hex6(cfg.moduleBits);
  const xt = String(cfg.totalTracks);
  const xa = String(cfg.totalTracks);
  const xw = String(cfg.specialEjectX);
  // The trailing block is static — the only fields VENUS cross-checks
  // on discovery are ka/xt/xa/xw. Everything else is parsed verbatim.
  return `ka${ka}xt${xt}xa${xa}xw${xw}xl07xr00xm03600xx11400ys090xu3540xv3700yu0060kl360kc0yx0060ke00003000xn00xo00ym6065kr0km360`;
}

/** C0RM response payload. */
export function encodeC0RM(cfg: VenusConfig): string {
  const kb = hex2(cfg.statusBits);
  const kp = cfg.pipChannels.toString().padStart(2, "0");
  return `kb${kb}kp${kp} C00000 X00000 P10000 P20000 P30000 P40000 P50000 P60000 P70000 P80000 I00000 R00000 H00000 SL0008`;
}

/** C0RI response payload: "si<YYYY-MM-DD>sn<serial>". */
export function encodeC0RI(cfg: VenusConfig): string {
  return `si${cfg.productionDate}sn${cfg.serial}`;
}

/** C0RF response — just the `rf` field. */
export function encodeC0RF(cfg: VenusConfig): string {
  return cfg.firmwareVersion;
}

/** C0RU payload — 4 × 5-digit space-separated values. */
export function encodeC0RU(cfg: VenusConfig): string {
  return `${pad5(cfg.leftArmXRange[0])} ${pad5(cfg.leftArmXRange[1])} ${pad5(cfg.rightArmXRange[0])} ${pad5(cfg.rightArmXRange[1])}`;
}
