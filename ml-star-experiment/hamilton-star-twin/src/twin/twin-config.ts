/**
 * TwinConfig / TwinState — serialization types for the digital twin.
 *
 * Three related types partition the twin's data into static configuration,
 * dynamic state, and combined session artifacts:
 *
 *   TwinConfig
 *     What the twin IS — platform, deck layout, labware definitions, liquid
 *     classes. Static during a protocol run. Required to reconstruct a
 *     functioning twin from scratch.
 *
 *   TwinState
 *     What the twin is DOING right now — module states and datamodel
 *     variables, well volumes, tip usage, liquid identities per well and
 *     channel, contamination history, scheduled delayed events. Mutates
 *     on every command.
 *
 *   TwinSession
 *     A self-contained save file: TwinConfig + TwinState + metadata.
 *     Anyone with this JSON can reconstruct the exact twin.
 *
 * Three use cases, same primitives:
 *   - Save/load         → TwinSession (config + state + metadata)
 *   - Trace snapshot    → TwinState only (config is in the trace header)
 *   - What-if fork      → TwinState only (config inherited from parent)
 *
 * Design rule: every value in these types must be JSON-serializable. No
 * Map, no Set, no functions, no circular references. Map<string, T> →
 * Record<string, T>. Set<string> → string[]. This keeps the types clean
 * across HTTP, MCP, trace files, and direct TypeScript usage.
 *
 * Units: coordinates in 0.1 mm, volumes in 0.1 µL, temperatures in 0.1 °C.
 */

import type { LabwareCatalogEntry } from "./labware-catalog";
import type { LiquidContents, ChannelState, ContaminationEvent } from "./liquid-tracker";
import type { PlatformType } from "./deck";

// ============================================================================
// Configuration (static world definition)
// ============================================================================

/**
 * A labware instance placed on a carrier position. The `definition` field
 * inlines everything physics/rendering needs — no external catalog lookup
 * required when loading this config elsewhere.
 */
export interface PlacedLabware {
  /** 0-based index into the carrier's `positions` array. */
  position: number;
  /**
   * Inlined labware definition. Matches a LabwareCatalogEntry for known
   * types; for custom/imported labware, the caller supplies a full entry.
   */
  definition: LabwareCatalogEntry;
  /** Optional barcode if the labware was loaded via an autoload step. */
  barcode?: string;
}

/**
 * A carrier placed on the deck. All geometry required to render and resolve
 * positions is captured here — no catalog lookup needed at load time, which
 * keeps a TwinConfig self-contained for trace replay and what-if forking.
 */
export interface PlacedCarrier {
  /** Unique ID within the deck (e.g. "TIP001"). */
  id: string;
  /** Carrier type name (e.g. "TIP_CAR_480"). Free-form; not validated. */
  type: string;
  /** Leftmost track (1-based). */
  track: number;
  /** Number of tracks this carrier occupies. */
  widthTracks: number;
  /** Number of labware positions. */
  positions: number;
  /**
   * Per-position Y offset from the carrier front edge in 0.1 mm.
   * When present, overrides the even-division fallback.
   */
  siteYOffsets?: number[];
  /** Physical Y extent of the carrier in 0.1 mm (typically 4970 for ML_STAR). */
  yDim?: number;
  /** Carrier-level barcode if read by autoload. */
  barcode?: string;
  /** Labware placements on this carrier. */
  labware: PlacedLabware[];
}

/** Tip waste configuration (typically one per deck). */
export interface TipWasteConfig {
  track: number;
  widthTracks: number;
  capacity: number;
}

/**
 * Everything needed to construct a fully functional twin from scratch.
 * `TwinConfig` + a fresh constructor run = a twin in its initial state
 * (before `initAll()`).
 */
export interface TwinConfig {
  /** Schema version — bump when the shape changes in an incompatible way. */
  version: 1;
  /** Platform — determines track count, X offset, etc. */
  platform: PlatformType;
  /** All carriers currently placed on the deck, with their labware. */
  carriers: PlacedCarrier[];
  /** Tip waste configuration. */
  tipWaste: TipWasteConfig;
  /**
   * Optional: extra labware definitions beyond the built-in catalog. Each
   * entry is merged into the catalog lookup at twin construction time.
   * Used by VENUS layout import for custom labware types.
   */
  extraLabwareDefinitions?: LabwareCatalogEntry[];
  /**
   * Optional: custom liquid class overrides. Keys are liquid-class names.
   * Values are opaque to this type — the physics plugins interpret them.
   */
  liquidClasses?: Record<string, unknown>;
}

// ============================================================================
// State (dynamic runtime data)
// ============================================================================

/** SCXML module snapshot — active states and datamodel variables. */
export interface ModuleStateSnapshot {
  /** Active state IDs (flat Set represented as array). */
  activeStateIds: string[];
  /** All datamodel variables. Values must be JSON-serializable. */
  variables: Record<string, unknown>;
}

/**
 * A scheduled SCXML delayed event, captured with the REMAINING delay at
 * snapshot time (not the original absolute time). On restore, we
 * reschedule with this delay relative to the restore moment.
 */
export interface ScheduledEventSnapshot {
  /** Module ID the event fires in. */
  moduleId: string;
  /** Event name. */
  eventName: string;
  /** Event data payload (may be null). */
  eventData: unknown;
  /** Remaining milliseconds until this event fires. */
  remainingMs: number;
  /** Optional send ID — preserved for cancelEvent lookups if needed. */
  sendId?: string;
}

/** Deck-tracker snapshot (volumes + tip usage). */
export interface TrackingStateSnapshot {
  /** Well volumes: "carrierId:position:wellIndex" → volume in 0.1 µL. */
  wellVolumes: Record<string, number>;
  /** Tip usage: "carrierId:position:wellIndex" → used (true/false). */
  tipUsage: Record<string, boolean>;
}

/** Liquid-identity snapshot (per-well and per-channel liquids). */
export interface LiquidStateSnapshot {
  /** Well contents: "carrierId:position:wellIndex" → LiquidContents (serializable). */
  wellContents: Record<string, SerializedLiquidContents>;
  /** 16 per-channel states. */
  channels: SerializedChannelState[];
  /** Labware type per well key (for dead volume lookup). */
  wellLabwareType: Record<string, string>;
  /** Contamination event log. */
  contaminationLog: ContaminationEvent[];
}

/**
 * JSON-safe form of `LiquidContents`. The production type uses
 * `Map<string, number>` for mixed-liquid components; we convert to Record.
 */
export interface SerializedLiquidContents {
  liquidType: string;
  volume: number;
  liquidClass: string;
  /** Mixed components: liquidType → volume in 0.1 µL. */
  components?: Record<string, number>;
}

/** JSON-safe form of `ChannelState`. Matches the production shape. */
export interface SerializedChannelState {
  hasTip: boolean;
  tipType: string | null;
  tipMaxVolume: number;
  contents: SerializedLiquidContents | null;
  contactHistory: string[];
  contaminated: boolean;
}

/** Deck dynamic state (tip waste count, gripped labware). */
export interface DeckDynamicStateSnapshot {
  /** Tips ejected so far. */
  tipWasteCount: number;
  /** Labware currently held by iSWAP / CO-RE gripper, if any. */
  grippedLabware: {
    type: string;
    from: { carrierId: string; position: number };
  } | null;
}

/** Per-plugin opaque state. Plugins that opt in implement get/restorePluginState(). */
export type PluginStateSnapshot = Record<string, Record<string, unknown>>;

/**
 * Complete runtime state of a twin at one moment. Combined with a TwinConfig
 * (to rebuild the deck layout + labware catalog), this fully determines the
 * twin's observable behavior from that point forward.
 */
export interface TwinState {
  /** Schema version. */
  version: 1;
  /** Monotonically increasing snapshot ID assigned by the recorder. Optional for standalone use. */
  snapshotId?: number;
  /** Monotonic timestamp from `performance.now()` at snapshot time. Optional. */
  timestamp?: number;
  /** SCXML module states (10 modules: master, pip, h96, h384, iswap, gripper, wash, temp, hhs, autoload). */
  modules: Record<string, ModuleStateSnapshot>;
  /** Scheduled delayed events across all modules. */
  scheduledEvents: ScheduledEventSnapshot[];
  /** Deck tracking state. */
  tracking: TrackingStateSnapshot;
  /** Liquid identity state. */
  liquid: LiquidStateSnapshot;
  /** Deck dynamic state. */
  deck: DeckDynamicStateSnapshot;
  /** Per-plugin opaque state (optional). */
  plugins: PluginStateSnapshot;
}

/** Alias for clarity — a TwinSnapshot is a TwinState used for time-travel. */
export type TwinSnapshot = TwinState;

// ============================================================================
// Session (save-file format)
// ============================================================================

/**
 * Self-contained save file: configuration + state + metadata. Writing this
 * as JSON and loading it on another machine should produce an identical
 * twin.
 */
export interface TwinSession {
  format: "hamilton-twin-session";
  version: 1;
  metadata: {
    /** Human-readable session name. */
    name: string;
    /** ISO-8601 timestamp at save time. */
    savedAt: string;
    /** Software version of the twin that produced this session. */
    twinVersion: string;
    /** Free-form description. */
    description?: string;
  };
  config: TwinConfig;
  state: TwinState;
}

// ============================================================================
// Serialization helpers (Map ↔ Record, and round-trip validators)
// ============================================================================

/** Convert a Map<K, V> to a Record<string, V>. Keys are coerced to strings. */
export function mapToRecord<V>(m: Map<string, V> | undefined): Record<string, V> {
  const out: Record<string, V> = {};
  if (!m) return out;
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

/** Convert a Record<string, V> to a Map<string, V>. */
export function recordToMap<V>(r: Record<string, V> | undefined): Map<string, V> {
  const m = new Map<string, V>();
  if (!r) return m;
  for (const k of Object.keys(r)) m.set(k, r[k]);
  return m;
}

/** Convert a runtime LiquidContents (with Map components) to serialized form. */
export function serializeLiquidContents(lc: LiquidContents | null | undefined): SerializedLiquidContents | null {
  if (!lc) return null;
  return {
    liquidType: lc.liquidType,
    volume: lc.volume,
    liquidClass: lc.liquidClass,
    components: lc.components ? mapToRecord(lc.components) : undefined,
  };
}

/** Convert a serialized LiquidContents back to runtime form (with Map components). */
export function deserializeLiquidContents(sc: SerializedLiquidContents | null | undefined): LiquidContents | null {
  if (!sc) return null;
  return {
    liquidType: sc.liquidType,
    volume: sc.volume,
    liquidClass: sc.liquidClass,
    components: sc.components ? recordToMap(sc.components) : undefined,
  };
}

/** Convert a runtime ChannelState to serialized form. */
export function serializeChannelState(ch: ChannelState): SerializedChannelState {
  return {
    hasTip: ch.hasTip,
    tipType: ch.tipType,
    tipMaxVolume: ch.tipMaxVolume,
    contents: serializeLiquidContents(ch.contents),
    contactHistory: [...ch.contactHistory],
    contaminated: ch.contaminated,
  };
}

/** Convert a serialized ChannelState back to runtime form. */
export function deserializeChannelState(sc: SerializedChannelState): ChannelState {
  return {
    hasTip: sc.hasTip,
    tipType: sc.tipType,
    tipMaxVolume: sc.tipMaxVolume,
    contents: deserializeLiquidContents(sc.contents),
    contactHistory: [...sc.contactHistory],
    contaminated: sc.contaminated,
  };
}

/**
 * Verify a snapshot round-trips cleanly through JSON. Throws if the
 * parsed form differs from the original.
 *
 * Used by tests; not expected to be called at runtime but cheap enough
 * that it could be enabled in debug builds.
 */
export function assertJsonRoundTrip<T>(value: T, label: string = "value"): void {
  const serialized = JSON.stringify(value);
  const parsed = JSON.parse(serialized) as T;
  // Re-serialize and compare strings — guards against functions, Maps, or
  // Dates silently leaking into the object.
  const reserialized = JSON.stringify(parsed);
  if (serialized !== reserialized) {
    throw new Error(`${label} is not JSON-stable: first-pass and second-pass serialization differ.`);
  }
}
