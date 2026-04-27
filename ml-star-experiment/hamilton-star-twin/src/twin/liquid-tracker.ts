/**
 * Liquid Identity Tracker
 *
 * Tracks what liquid is in each well and each PIP channel, enabling:
 * - Liquid type + volume + liquid class per well
 * - Channel contents tracking through aspirate/dispense
 * - Cross-contamination detection (different liquid without tip change)
 * - Dead volume enforcement per labware type
 * - Liquid mixing when dispensing into a well with different liquid
 *
 * All volumes in 0.1uL (firmware units).
 */

// ============================================================================
// Types
// ============================================================================

/** Identity of a liquid in a well or channel.
 *
 *  When used for a channel (tip), `volume` is the TOTAL plunger-contents
 *  including any trailing air aspirated after the liquid ran out. Callers
 *  inspecting a tip should read `liquidVolume` and `airVolume` directly;
 *  `volume` is preserved as their sum for backwards compatibility with the
 *  many call sites that still read it.
 *
 *  For wells, `volume` == Σ components (no air; air gas-exchanges out of a
 *  well after dispense, so we don't store it in the well). */
export interface LiquidContents {
  /** Primary liquid type (e.g. "Water", "DMSO", "Sample_A1") */
  liquidType: string;
  /** Volume in 0.1uL */
  volume: number;
  /** Liquid class name used for this liquid */
  liquidClass: string;
  /** Additional liquid components if mixed (type -> volume in 0.1uL) */
  components?: Map<string, number>;
  /** Channel-only: pure liquid volume (0.1uL). Omitted for wells. */
  liquidVolume?: number;
  /** Channel-only: trailing air drawn after the source went dry. At the
   *  *bottom* of the tip (nearest the opening) per real pipette physics —
   *  so it's the FIRST thing dispensed, followed by liquid. */
  airVolume?: number;
}

/** Per-channel state for the 16-channel PIP */
export interface ChannelState {
  /** Whether a tip is fitted */
  hasTip: boolean;
  /** Tip type (e.g. "Tips_1000uL") — null if no tip */
  tipType: string | null;
  /** Tip maximum volume in 0.1uL */
  tipMaxVolume: number;
  /** Current liquid in the tip */
  contents: LiquidContents | null;
  /** Liquids this tip has contacted (for contamination tracking) */
  contactHistory: string[];
  /** Whether this channel has cross-contamination risk */
  contaminated: boolean;
}

/** A contamination event */
export interface ContaminationEvent {
  timestamp: number;
  channel: number;
  previousLiquid: string;
  newLiquid: string;
  well: string;        // Human-readable well description
  severity: "warning" | "error";
  description: string;
}

/** Result of an aspirate or dispense operation */
export interface TransferResult {
  success: boolean;
  /** Actual volume moved by the plunger (liquid + air combined — this is
   *  what the real FW does; the plunger always moves the commanded amount
   *  of *something* and doesn't care whether it's air or liquid). */
  actualVolume: number;
  /** Remaining volume in source (aspirate) or destination (dispense) */
  remainingVolume: number;
  /** Liquid portion of `actualVolume`. For aspirate: actual liquid drawn
   *  from the source. For dispense: actual liquid delivered to the
   *  destination (air is gas-exchanged out, doesn't count). */
  liquidActual?: number;
  /** Air portion of `actualVolume`. For aspirate: air drawn after the well
   *  ran dry. For dispense: air pushed out before liquid (from prior
   *  underflow). */
  airActual?: number;
  /** Whether contamination was detected */
  contamination?: ContaminationEvent;
  /** Warning message (e.g. "aspirated below dead volume") */
  warning?: string;
}

// ============================================================================
// Well geometry helpers (for dead volume calculation)
// ============================================================================

// Dead volumes resolve through the unified labware catalog. The catalog is
// the single source of truth for per-labware physical properties — dead
// volume included. Legacy prefix-match behavior is preserved inside
// catalogDeadVolume().
import { catalogDeadVolume } from "./labware-catalog";

function getDeadVolume(labwareType: string): number {
  return catalogDeadVolume(labwareType);
}

// ============================================================================
// Liquid Tracker
// ============================================================================

export class LiquidTracker {
  /** Well contents: "carrierId:position:wellIndex" -> LiquidContents */
  private wells: Map<string, LiquidContents> = new Map();

  /** Per-channel state (16 channels) */
  private channels: ChannelState[] = [];

  /** Contamination event log */
  private contaminationLog: ContaminationEvent[] = [];

  /** Labware type at each well key (for dead volume lookup) */
  private wellLabwareType: Map<string, string> = new Map();

  constructor() {
    // Initialize 16 channels
    for (let i = 0; i < 16; i++) {
      this.channels.push({
        hasTip: false,
        tipType: null,
        tipMaxVolume: 0,
        contents: null,
        contactHistory: [],
        contaminated: false,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Well operations
  // --------------------------------------------------------------------------

  /** Set the initial contents of a well */
  /** Split `from` into an `extracted` map (of size `portion`) and mutate `from`
   *  to hold the remainder. Proportional: each component contributes
   *  `cv * portion / total`. Returns the extracted components. The sum of
   *  extracted values equals `portion` (modulo floating-point rounding). */
  private extractProportion(from: Map<string, number>, portion: number): Map<string, number> {
    const extracted = new Map<string, number>();
    if (portion <= 0 || from.size === 0) return extracted;
    let total = 0;
    for (const v of from.values()) total += Math.max(0, v);
    if (total <= 0) return extracted;
    const ratio = Math.min(1, portion / total);
    for (const [name, v] of from) {
      if (v <= 0) continue;
      const take = v * ratio;
      extracted.set(name, (extracted.get(name) || 0) + take);
      from.set(name, v - take);
    }
    return extracted;
  }

  /** Build a components map for a well/channel content. If it already has a
   *  `components` map, return a clone; otherwise synthesize a single-entry map
   *  from the `liquidType` + `volume` so downstream code can assume components
   *  are always present. */
  private asComponents(contents: LiquidContents | null | undefined): Map<string, number> {
    const out = new Map<string, number>();
    if (!contents || contents.volume <= 0) return out;
    if (contents.components && contents.components.size > 0) {
      for (const [k, v] of contents.components) if (v > 0) out.set(k, v);
      return out;
    }
    if (contents.liquidType && contents.liquidType !== "Unknown") out.set(contents.liquidType, contents.volume);
    return out;
  }

  /** Merge `add` into `into` in place (sum same-name volumes). */
  private mergeComponents(into: Map<string, number>, add: Map<string, number>): void {
    for (const [name, v] of add) if (v > 0) into.set(name, (into.get(name) || 0) + v);
  }

  /** Compose a human-readable `liquidType` label from a components map.
   *  Components are sorted by volume (desc) and joined with " + ". If only
   *  one component remains, returns its name cleanly (no " + "). */
  static summarizeComponents(components: Map<string, number>): string {
    const entries = [...components.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return "";
    if (entries.length === 1) return entries[0][0];
    return entries.map(([name]) => name).join(" + ");
  }

  /** Add a liquid to a well's contents, merging with any existing liquid.
   *  Same-name liquids accumulate; different names become components of a
   *  mixture. The `liquidType` label is derived from the components map so
   *  it stays clean (no "Water+Water+Sample" strings). */
  addLiquidToWell(wellKey: string, liquidType: string, volume: number, liquidClass: string, labwareType?: string): void {
    if (labwareType) this.wellLabwareType.set(wellKey, labwareType);
    if (volume <= 0) return;
    const existing = this.wells.get(wellKey);
    const components = existing?.components ?? new Map<string, number>();
    // Seed components from the existing single-liquid entry if needed.
    if (existing && !existing.components && existing.volume > 0 && existing.liquidType) {
      components.set(existing.liquidType, (components.get(existing.liquidType) || 0) + existing.volume);
    }
    components.set(liquidType, (components.get(liquidType) || 0) + volume);
    const totalVolume = (existing?.volume ?? 0) + volume;
    this.wells.set(wellKey, {
      liquidType: LiquidTracker.summarizeComponents(components),
      volume: totalVolume,
      liquidClass: existing?.liquidClass ?? liquidClass,
      components,
    });
  }

  setWellContents(wellKey: string, liquidType: string, volume: number, liquidClass: string, labwareType?: string): void {
    this.wells.set(wellKey, { liquidType, volume, liquidClass });
    if (labwareType) {
      this.wellLabwareType.set(wellKey, labwareType);
    }
  }

  /** Get well contents (returns null for empty/untracked wells) */
  getWellContents(wellKey: string): LiquidContents | null {
    return this.wells.get(wellKey) || null;
  }

  /** Get all well contents as a snapshot */
  getWellSnapshot(): Record<string, LiquidContents> {
    // JSON serialization can't round-trip a Map — convert `components` to a
    // plain Record so the renderer sees per-liquid breakdowns over HTTP.
    const result: Record<string, LiquidContents> = {};
    for (const [key, contents] of this.wells) {
      const copy: any = { ...contents };
      if (contents.components instanceof Map) {
        copy.components = Object.fromEntries(contents.components);
      }
      result[key] = copy;
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Channel operations
  // --------------------------------------------------------------------------

  /** Record a tip pickup for a channel */
  tipPickup(channel: number, tipType: string, tipMaxVolume: number): void {
    if (channel < 0 || channel >= 16) return;
    this.channels[channel] = {
      hasTip: true,
      tipType,
      tipMaxVolume,
      contents: null,
      contactHistory: [],
      contaminated: false,
    };
  }

  /** Record tip eject for a channel */
  tipEject(channel: number): void {
    if (channel < 0 || channel >= 16) return;
    this.channels[channel] = {
      hasTip: false,
      tipType: null,
      tipMaxVolume: 0,
      contents: null,
      contactHistory: [],
      contaminated: false,
    };
  }

  /** Get channel state */
  getChannelState(channel: number): ChannelState | null {
    if (channel < 0 || channel >= 16) return null;
    return { ...this.channels[channel] };
  }

  /** Get all channel states */
  getChannelSnapshot(): ChannelState[] {
    return this.channels.map(ch => ({
      ...ch,
      contents: ch.contents ? { ...ch.contents } : null,
      contactHistory: [...ch.contactHistory],
    }));
  }

  // --------------------------------------------------------------------------
  // Aspirate / Dispense
  // --------------------------------------------------------------------------

  /**
   * Process an aspiration: transfer liquid from well to channel.
   *
   * @param channel - Channel index (0-based)
   * @param wellKey - Well identifier ("carrierId:position:wellIndex")
   * @param requestedVolume - Requested volume in 0.1uL
   * @param wellDescription - Human-readable well description for logs
   * @returns Transfer result
   */
  aspirate(channel: number, wellKey: string, requestedVolume: number, wellDescription: string): TransferResult {
    if (channel < 0 || channel >= 16) {
      return { success: false, actualVolume: 0, remainingVolume: 0, warning: "Invalid channel" };
    }

    const ch = this.channels[channel];
    if (!ch.hasTip) {
      return { success: false, actualVolume: 0, remainingVolume: 0, warning: "No tip on channel" };
    }

    const well = this.wells.get(wellKey);
    const labwareType = this.wellLabwareType.get(wellKey) || "";
    const deadVolume = getDeadVolume(labwareType);

    // Determine available volume (above dead volume)
    let availableVolume: number;
    let wellLiquidType: string;
    let wellLiquidClass: string;

    if (well) {
      availableVolume = Math.max(0, well.volume - deadVolume);
      wellLiquidType = well.liquidType;
      wellLiquidClass = well.liquidClass;
    } else {
      // Untracked well — the twin has no record of this well having been
      // filled. Treat as empty: available = 0 so the underflow branch
      // below records a shortage and `pip-physics` emits the
      // `empty_aspiration` / `volume_underflow` assessment with the
      // well's description. The plunger still strokes — whatever volume
      // was requested comes in as Air (see airDrawn below). An earlier
      // version had `availableVolume = requestedVolume` which made the
      // aspirate silently "succeed" with a fake "Unknown" liquid and
      // no warning — user report 2026-04-19.
      availableVolume = 0;
      wellLiquidType = "Air";
      wellLiquidClass = "default";
    }

    // Calculate actual transfer volume
    let actualVolume = Math.min(requestedVolume, availableVolume);
    let warning: string | undefined;

    if (actualVolume < requestedVolume && well) {
      if (well.volume <= deadVolume) {
        warning = `Well at or below dead volume (${deadVolume / 10}uL) — insufficient liquid`;
        actualVolume = 0;
      } else {
        warning = `Requested ${requestedVolume / 10}uL but only ${availableVolume / 10}uL available above dead volume`;
      }
    }

    // Check tip capacity
    const currentChannelVol = ch.contents?.volume || 0;
    if (currentChannelVol + actualVolume > ch.tipMaxVolume && ch.tipMaxVolume > 0) {
      const maxAdditional = ch.tipMaxVolume - currentChannelVol;
      warning = `Tip overflow: requested ${actualVolume / 10}uL but only ${maxAdditional / 10}uL capacity remaining`;
      actualVolume = Math.max(0, maxAdditional);
    }

    // Check for cross-contamination
    let contamination: ContaminationEvent | undefined;
    if (ch.contactHistory.length > 0 && wellLiquidType !== "Unknown") {
      const lastContact = ch.contactHistory[ch.contactHistory.length - 1];
      if (lastContact !== wellLiquidType && lastContact !== "Unknown") {
        contamination = {
          timestamp: Date.now(),
          channel,
          previousLiquid: lastContact,
          newLiquid: wellLiquidType,
          well: wellDescription,
          severity: "warning",
          description: `Channel ${channel} contacting ${wellLiquidType} after ${lastContact} without tip change`,
        };
        ch.contaminated = true;
        this.contaminationLog.push(contamination);
      }
    }

    // ── Physical volume model ────────────────────────────────────────────
    // The plunger always moves exactly `requestedVolume` of *something*.
    // If the source can only give `actualVolume` of liquid (dead volume, tip
    // capacity, or empty well), the remainder comes in as AIR — drawn in
    // through the tip opening AFTER the liquid, so it sits at the bottom of
    // the tip (first in line for the next dispense).
    const airDrawn = Math.max(0, requestedVolume - actualVolume);

    if (actualVolume > 0 || airDrawn > 0) {
      let extracted: Map<string, number>;
      if (well && actualVolume > 0) {
        const wellComps = this.asComponents(well);
        extracted = this.extractProportion(wellComps, actualVolume);
        well.components = wellComps;
        well.volume -= actualVolume;
        well.liquidType = LiquidTracker.summarizeComponents(wellComps) || well.liquidType;
      } else if (!well && actualVolume > 0) {
        // Untracked source — single-component fallback.
        extracted = new Map<string, number>();
        extracted.set(wellLiquidType, actualVolume);
      } else {
        extracted = new Map<string, number>();
      }

      const chComps = this.asComponents(ch.contents);
      this.mergeComponents(chComps, extracted);
      const priorLiquid = ch.contents?.liquidVolume ?? ch.contents?.volume ?? 0;
      const priorAir    = ch.contents?.airVolume    ?? 0;
      const liquidVolume = priorLiquid + actualVolume;
      const airVolume    = priorAir + airDrawn;
      // Tip liquidType label: if there's any real liquid in the tip,
      // summarise its components; otherwise (tip is pure air) the label
      // is explicitly "Air". An earlier version fell through to the
      // source well's `wellLiquidType` here — which for a tracked empty
      // well was still the prior-liquid name, so an all-air aspirate
      // from an empty well got mislabelled as that prior liquid.
      // #62 follow-up 2026-04-19.
      const liquidLabel = LiquidTracker.summarizeComponents(chComps);
      const tipLabel = liquidVolume > 0
        ? (liquidLabel || wellLiquidType)
        : "Air";
      ch.contents = {
        liquidType: tipLabel,
        volume: liquidVolume + airVolume,
        liquidClass: wellLiquidClass,
        components: chComps,
        liquidVolume,
        airVolume,
      };

      if (wellLiquidType !== "Unknown" && actualVolume > 0) {
        ch.contactHistory.push(wellLiquidType);
      }
    }

    const remainingVolume = well ? well.volume : 0;
    return {
      success: actualVolume > 0 || airDrawn > 0,
      actualVolume: actualVolume + airDrawn,     // plunger moved this much
      liquidActual: actualVolume,                 // of which, this was real liquid
      airActual: airDrawn,                         // rest was air (underflow)
      remainingVolume,
      contamination,
      warning,
    };
  }

  /**
   * Process a dispense: transfer liquid from channel to well.
   *
   * @param channel - Channel index (0-based)
   * @param wellKey - Well identifier
   * @param requestedVolume - Requested volume in 0.1uL
   * @param wellDescription - Human-readable description for logs
   * @returns Transfer result
   */
  dispense(channel: number, wellKey: string, requestedVolume: number, wellDescription: string): TransferResult {
    if (channel < 0 || channel >= 16) {
      return { success: false, actualVolume: 0, remainingVolume: 0, warning: "Invalid channel" };
    }

    const ch = this.channels[channel];
    if (!ch.hasTip) {
      return { success: false, actualVolume: 0, remainingVolume: 0, warning: "No tip on channel" };
    }

    if (!ch.contents || ch.contents.volume <= 0) {
      return { success: false, actualVolume: 0, remainingVolume: 0, warning: "Channel empty — nothing to dispense" };
    }

    // Calculate actual dispense volume
    const actualVolume = Math.min(requestedVolume, ch.contents.volume);
    let warning: string | undefined;
    if (actualVolume < requestedVolume) {
      warning = `Requested ${requestedVolume / 10}uL but channel only has ${ch.contents.volume / 10}uL`;
    }

    // ── Physical dispense order: air first, liquid second ────────────────
    // Air drawn into the tip after a dry aspirate sits at the bottom (near
    // the opening). On dispense, the plunger pushes from the top, so the
    // FIRST thing to leave through the opening is that air — followed by
    // liquid once the air runs out. Only liquid actually reaches the
    // destination well; air gas-exchanges out.
    const dispensedClass = ch.contents.liquidClass;
    const priorAir    = ch.contents.airVolume    ?? 0;
    const priorLiquid = ch.contents.liquidVolume ?? ch.contents.volume;
    const airOut    = Math.min(priorAir, actualVolume);
    const liquidOut = actualVolume - airOut;

    const chComps = this.asComponents(ch.contents);
    const extracted = liquidOut > 0 ? this.extractProportion(chComps, liquidOut) : new Map<string, number>();

    // Update channel state.
    const remainingLiquid = priorLiquid - liquidOut;
    const remainingAir    = priorAir - airOut;
    if (remainingLiquid <= 0 && remainingAir <= 0) {
      ch.contents = null;
    } else {
      ch.contents = {
        liquidType: LiquidTracker.summarizeComponents(chComps) || (remainingLiquid > 0 ? ch.contents.liquidType : "Air"),
        volume: remainingLiquid + remainingAir,
        liquidClass: dispensedClass,
        components: chComps,
        liquidVolume: remainingLiquid,
        airVolume: remainingAir,
      };
    }

    // Update well — only LIQUID goes into the well. Air is accounted for in
    // the warning flag (caller's deck-tracker surfaces it as an assessment).
    const labwareType = this.wellLabwareType.get(wellKey);
    const existing = this.wells.get(wellKey);
    let well: LiquidContents | undefined = existing;
    if (liquidOut > 0) {
      const wellComps = this.asComponents(existing);
      this.mergeComponents(wellComps, extracted);
      const newVol = (existing?.volume ?? 0) + liquidOut;
      this.wells.set(wellKey, {
        liquidType: LiquidTracker.summarizeComponents(wellComps) || "Unknown",
        volume: newVol,
        liquidClass: existing?.liquidClass ?? dispensedClass,
        components: wellComps,
      });
      if (labwareType) this.wellLabwareType.set(wellKey, labwareType);
      well = this.wells.get(wellKey);
    }
    // If only air was dispensed (liquidOut === 0), the destination state
    // doesn't change — no stub well record with "Unknown" / volume 0.
    if (airOut > 0) warning = `Dispensed ${airOut / 10}uL air (from prior underflow) before ${liquidOut / 10}uL liquid`;

    // Record channel contact (contamination bookkeeping).
    for (const name of extracted.keys()) {
      if (name !== "Unknown") ch.contactHistory.push(name);
    }

    return {
      success: true,
      actualVolume,              // total plunger movement (liquid + air)
      liquidActual: liquidOut,   // what actually reached the well
      airActual: airOut,         // spit out first (if any)
      remainingVolume: well?.volume ?? 0,
      warning,
    };
  }

  // --------------------------------------------------------------------------
  // Contamination
  // --------------------------------------------------------------------------

  /** Get contamination log */
  getContaminationLog(): ContaminationEvent[] {
    return [...this.contaminationLog];
  }

  /** Get recent contamination events */
  getRecentContamination(count: number = 10): ContaminationEvent[] {
    return this.contaminationLog.slice(-count);
  }

  /** Check if any channel is contaminated */
  hasContamination(): boolean {
    return this.channels.some(ch => ch.contaminated);
  }

  // --------------------------------------------------------------------------
  // Bulk operations
  // --------------------------------------------------------------------------

  /**
   * Pre-fill wells on a labware with a liquid.
   * Useful for setting up initial deck state (reagent troughs, sample plates).
   */
  fillLabware(
    carrierId: string,
    position: number,
    labwareType: string,
    wellCount: number,
    liquidType: string,
    volume: number,
    liquidClass: string = "default"
  ): void {
    // Bulk whole-labware setup — replaces each well rather than mixing, since
    // the intent here is "initialize N wells identically", not additive.
    for (let i = 0; i < wellCount; i++) {
      const key = `${carrierId}:${position}:${i}`;
      this.setWellContents(key, liquidType, volume, liquidClass, labwareType);
    }
  }

  /** Fill a specific set of well indices on a labware with a liquid. Useful for
   *  setting up heterogeneous initial state (e.g., sample in col 1, diluent in
   *  cols 2–12). Additive: if the well already has liquid, the new volume
   *  accumulates (same name → sum, different name → mixture with components).
   *  Callers that want to start fresh should clear first. */
  fillWellRange(
    carrierId: string,
    position: number,
    labwareType: string,
    wellIndices: number[],
    liquidType: string,
    volume: number,
    liquidClass: string = "default"
  ): void {
    for (const i of wellIndices) {
      const key = `${carrierId}:${position}:${i}`;
      this.addLiquidToWell(key, liquidType, volume, liquidClass, labwareType);
    }
  }

  /** Remove all liquid from the given wells (no identity left, no components). */
  clearWellRange(carrierId: string, position: number, wellIndices: number[]): void {
    for (const i of wellIndices) {
      const key = `${carrierId}:${position}:${i}`;
      this.wells.delete(key);
    }
  }

  /** Reset all tracking state */
  reset(): void {
    this.wells.clear();
    this.wellLabwareType.clear();
    this.contaminationLog = [];
    for (let i = 0; i < 16; i++) {
      this.channels[i] = {
        hasTip: false,
        tipType: null,
        tipMaxVolume: 0,
        contents: null,
        contactHistory: [],
        contaminated: false,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Serialization (Phase 1 #43)
  //
  // `getLiquidState()` produces a JSON-safe snapshot. `restoreLiquidState()`
  // rehydrates from that snapshot, replacing all current state. Together
  // they form a round-trip primitive used by twin snapshot/clone/session
  // save-load and by the trace recorder.
  //
  // Design notes:
  //   - Maps are converted to Records so the result is pure JSON.
  //   - LiquidContents.components (a Map) is serialized via helpers in
  //     twin-config.ts.
  //   - Channel arrays are deep-copied to avoid aliasing the live array.
  // --------------------------------------------------------------------------

  /**
   * Capture a JSON-safe snapshot of all liquid state.
   */
  getLiquidState(): import("./twin-config").LiquidStateSnapshot {
    const { serializeLiquidContents, serializeChannelState, mapToRecord } = require("./twin-config");

    const wellContents: Record<string, import("./twin-config").SerializedLiquidContents> = {};
    for (const [key, contents] of this.wells) {
      const ser = serializeLiquidContents(contents);
      if (ser) wellContents[key] = ser;
    }

    return {
      wellContents,
      channels: this.channels.map(ch => serializeChannelState(ch)),
      wellLabwareType: mapToRecord(this.wellLabwareType),
      contaminationLog: this.contaminationLog.map(e => ({ ...e })),
    };
  }

  /**
   * Restore the tracker from a snapshot. Replaces current state completely;
   * callers that want to merge must do so externally.
   *
   * Throws if the snapshot has fewer than 16 channels (every twin has 16
   * PIP channels; a snapshot with fewer is malformed).
   */
  restoreLiquidState(snapshot: import("./twin-config").LiquidStateSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("restoreLiquidState: snapshot is null or not an object");
    }
    if (!Array.isArray(snapshot.channels) || snapshot.channels.length !== 16) {
      throw new Error(
        `restoreLiquidState: channels array must have length 16, got ${snapshot.channels?.length}`
      );
    }

    const { deserializeLiquidContents, deserializeChannelState, recordToMap } = require("./twin-config");

    // Wipe and rebuild wells
    this.wells.clear();
    for (const key of Object.keys(snapshot.wellContents || {})) {
      const lc = deserializeLiquidContents(snapshot.wellContents[key]);
      if (lc) this.wells.set(key, lc);
    }

    // Wipe and rebuild wellLabwareType
    this.wellLabwareType = recordToMap(snapshot.wellLabwareType);

    // Replace channels (deep-copy via deserialize to avoid aliasing)
    this.channels = snapshot.channels.map((ch: any) => deserializeChannelState(ch));

    // Replace contamination log (shallow copy is sufficient — the events are
    // plain data)
    this.contaminationLog = (snapshot.contaminationLog || []).map((e: any) => ({ ...e }));
  }
}
