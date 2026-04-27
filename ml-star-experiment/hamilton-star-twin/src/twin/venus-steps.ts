/**
 * VENUS Step Layer
 *
 * Translates high-level VENUS steps into FW command sequences.
 * Three levels: Power Steps → Easy Steps → Single Steps → FW Commands.
 *
 * VENUS Architecture:
 *   VENUS Step (user-facing)    — "Aspirate 100µL from plate A1"
 *        ↓
 *   FW Commands (protocol)      — C0TPid0001xp01033yp01375tm255tt04
 *        ↓                        C0ASid0002xp02383yp01375av01000tm255lm0
 *   Hardware (physical)         — Master + CAN slaves
 *
 * This module provides:
 *   - Step definitions (types + parameter interfaces)
 *   - Position resolver (carrier/position/column → xp,yp)
 *   - Command builder (step params → FW command string)
 *   - Step executor (sends command sequences, collects results)
 */

import { DigitalTwin, CommandResult } from "./digital-twin";
import { Deck, WellAddress, DeckPosition } from "./deck";
import { labwareItemFromCatalog, findCatalogEntry } from "./labware-catalog";
import { carrierFromCatalog, findCarrierCatalogEntry } from "./carrier-catalog";
import { buildFwCommand } from "./fw-protocol";
import { getLiquidClass, LiquidClass } from "./liquid-classes";
import { AssessmentEvent } from "./assessment";
import { getWellGeometry, calculatePipetteZ } from "./well-geometry";

// ============================================================================
// Helpers
// ============================================================================

function countBits(n: number): number {
  let c = 0; while (n) { c += n & 1; n >>= 1; } return c;
}

// ============================================================================
// Position Types
// ============================================================================

/** A deck position reference (carrier + labware position + column) */
export interface DeckAddress {
  carrierId: string;
  position: number;       // 0-based labware position on carrier
  column: number;         // 0-based column (for multi-well labware)
  row?: number;           // 0-based row (default 0 = Row A, for channel 0)
}

// ============================================================================
// Step Result
// ============================================================================

/** Source of a FW command parameter value */
export type ParamSource = "user" | "liquidClass" | "deckLayout" | "default" | "computed";

/** Annotation for a single FW parameter */
export interface ParamAnnotation {
  key: string;          // FW parameter key (e.g. "av", "xp")
  value: string;        // Formatted value as sent
  description: string;  // Human-readable (e.g. "aspiration volume 100µL")
  source: ParamSource;  // Where the value comes from
}

/** Result of executing a step (may involve multiple FW commands) */
export interface StepResult {
  success: boolean;
  stepType: string;
  commands: Array<{
    raw: string;
    result: CommandResult;
    /** Parameter annotations — what each param means and where it comes from */
    annotations?: ParamAnnotation[];
  }>;
  error?: string;
  assessments: AssessmentEvent[];
}

// ============================================================================
// Single Step Parameters
// ============================================================================

/** Parameters for Aspirate (C0AS) */
export interface AspirateParams {
  position: DeckAddress;
  volume: number;             // µL (converted to 0.1µL internally)
  channelMask?: number;       // default 255 (all 8 channels)
  liquidClass?: string;       // default "HighVolume_Water_DispenseJet_Empty"
  lldMode?: number;           // LLD override (0=off, 1=cLLD, 2=pLLD)
  mixCycles?: number;         // pre-aspirate mixing
  mixVolume?: number;         // µL for mixing
  submergeDepth?: number;     // mm below liquid surface (default from LC, typically 2.0)
  fixedHeight?: number;       // mm from well bottom (overrides LLD-based Z calc)
  liquidFollowing?: boolean;  // track surface during aspiration (default from LC, typically true)
  traverseHeight?: number;    // mm traverse clearance (default 145mm)
}

/** Parameters for Dispense (C0DS) */
export interface DispenseParams {
  position: DeckAddress;
  volume: number;             // µL (0 = dispense all)
  channelMask?: number;
  dispenseMode?: number;      // 0=jet empty, 2=surface partial, 3=surface empty, 4=jet empty tip
  liquidClass?: string;
  fixedHeight?: number;       // mm from well bottom (default from LC, typically 10mm)
  touchOff?: boolean;         // side-touch after dispense
}

/** Parameters for TipPickUp (C0TP) */
export interface TipPickUpParams {
  position: DeckAddress;
  channelMask?: number;
  tipType?: number;           // 4 = standard, 1 = 384-head
}

/** Parameters for TipEject (C0TR) */
export interface TipEjectParams {
  channelMask?: number;
}

/** Parameters for Fill (setup-only; pre-fills wells with a liquid).
 *  Not a FW command — mutates the deck tracker directly so the user can set up
 *  heterogeneous initial state (e.g., sample in col 1, diluent in cols 2–12)
 *  before running a real protocol step. Volume is in µL. */
export interface FillParams {
  carrierId: string;
  position: number;
  liquidType: string;
  volume: number;              // µL per well
  liquidClass?: string;
  target?: "all" | "columns" | "rows" | "wells";
  columns?: number[];          // 0-based
  rows?: number[];             // 0-based
  wellIndices?: number[];      // linear, 0-based
}

/** Parameters for Clear (setup-only; empties the chosen wells). */
export interface ClearParams {
  carrierId: string;
  position: number;
  target?: "all" | "columns" | "rows" | "wells";
  columns?: number[];
  rows?: number[];
  wellIndices?: number[];
}

/** Parameters for Head96 TipPickUp (C0EP) */
export interface Head96TipPickUpParams {
  position: DeckAddress;
}

/** Parameters for Head96 Aspirate (C0EA) */
export interface Head96AspirateParams {
  volume: number;             // µL
}

/** Parameters for Head96 Dispense (C0ED) */
export interface Head96DispenseParams {
  volume: number;             // µL
  dispenseMode?: number;
}

/** Parameters for Head96 TipEject (C0ER) */
export interface Head96TipEjectParams {}

/** Parameters for Head96 Move (C0EM) */
export interface Head96MoveParams {
  position: DeckAddress;
}

/** iSWAP GetPlate — C0PP */
export interface GetPlateParams {
  position: DeckAddress;
  gripWidth?: number;    // mm (default 82)
  openWidth?: number;    // mm (default 130)
  gripHeight?: number;   // mm from bottom (default 5)
}

/** iSWAP PutPlate — C0PR */
export interface PutPlateParams {
  position: DeckAddress;
  openWidth?: number;    // mm (default 130)
}

/** iSWAP MovePlate — C0PM */
export interface MovePlateParams {
  position: DeckAddress;
}

/** CO-RE Gripper GetTool — C0ZT */
export interface GripperGetToolParams {}

/** CO-RE Gripper GripPlate — C0ZP */
export interface GripperGripPlateParams {
  position: DeckAddress;
  gripWidth?: number;
}

/** CO-RE Gripper Release — C0ZR */
export interface GripperReleaseParams {
  position: DeckAddress;
}

/** CO-RE Gripper DiscardTool — C0ZS */
export interface GripperDiscardToolParams {}

/** DispenseFly — C0DF */
export interface DispenseFlyParams {
  position: DeckAddress;
  volume: number;          // µL per dispense
  numDispenses?: number;   // default 1
  channelMask?: number;
}

/** Parameters for MovePIP (C0JM) */
export interface MovePIPParams {
  xPosition: number;          // deck X in mm (converted to 0.1mm)
}

/** Parameters for SetTemperature (C0HC) */
export interface SetTemperatureParams {
  temperature: number;        // °C (converted to 0.1°C)
  heaterNumber?: number;      // default 1
}

/** Parameters for Wash (C0WS) */
export interface WashParams {
  cycles?: number;
  rinseTime?: number;      // ms (default 5000 from VENUS training)
  soakTime?: number;       // ms (default 5000)
  flowRate?: number;       // mL/s (default 11)
  drainingTime?: number;   // ms (default 10000)
  chamber?: number;        // 1 or 2 (default 1)
}

// ============================================================================
// Easy Step Parameters (composite)
// ============================================================================

/** EasyAspirate = TipPickUp + Aspirate */
export interface EasyAspirateParams {
  tipPosition: DeckAddress;
  aspiratePosition: DeckAddress;
  volume: number;
  channelMask?: number;
  tipType?: number;
  liquidClass?: string;
  lldMode?: number;
  mixCycles?: number;
  mixVolume?: number;
}

/** EasyDispense = Dispense + TipEject */
export interface EasyDispenseParams {
  dispensePosition: DeckAddress;
  volume: number;
  channelMask?: number;
  dispenseMode?: number;
  liquidClass?: string;
}

/** EasyTransfer = TipPickUp + Aspirate + Dispense + TipEject */
export interface EasyTransferParams {
  tipPosition: DeckAddress;
  sourcePosition: DeckAddress;
  destPosition: DeckAddress;
  volume: number;
  channelMask?: number;
  tipType?: number;
  liquidClass?: string;
  lldMode?: number;
  dispenseMode?: number;
}

/** Easy96Aspirate = Head96Move + Head96TipPickUp + Head96Move + Head96Aspirate */
export interface Easy96AspirateParams {
  tipPosition: DeckAddress;
  aspiratePosition: DeckAddress;
  volume: number;
}

/** Easy96Dispense = Head96Dispense + Head96Move + Head96TipEject */
export interface Easy96DispenseParams {
  dispensePosition: DeckAddress;
  ejectPosition: DeckAddress;
  volume: number;
  dispenseMode?: number;
}

/** EasyTransport = iSWAP GetPlate + MovePlate + PutPlate */
export interface EasyTransportParams {
  sourcePosition: DeckAddress;
  destPosition: DeckAddress;
  gripWidth?: number;
  openWidth?: number;
}

/** TransferSamples (Power Step) = loop over columns: EasyTransfer per column */
export interface TransferSamplesParams {
  tipCarrier: string;        // e.g. "TIP001"
  tipPosition: number;       // labware position on carrier
  sourceCarrier: string;
  sourcePosition: number;
  destCarrier: string;
  destPosition: number;
  volume: number;            // µL
  columns?: number;          // how many columns to transfer (default: all 12)
  startColumn?: number;      // 0-based (default 0)
  channelMask?: number;
  tipType?: number;
  liquidClass?: string;
}

/** AddReagent (Power Step) = aspirate from trough, dispense to each column */
export interface AddReagentParams {
  tipCarrier: string;
  tipPosition: number;
  reagentCarrier: string;
  reagentPosition: number;
  destCarrier: string;
  destPosition: number;
  volume: number;
  columns?: number;
  startColumn?: number;
  channelMask?: number;
  liquidClass?: string;
}

/** SerialDilution (Power Step) = transfer column-to-column with mixing */
export interface SerialDilutionParams {
  tipCarrier: string;
  tipPosition: number;
  plateCarrier: string;
  platePosition: number;
  volume: number;
  startColumn?: number;
  numDilutions?: number;    // default 11 (columns 0→11)
  channelMask?: number;
  mixCycles?: number;
  mixVolume?: number;
  liquidClass?: string;
}

/** AliquotDispense (Power Step) = 1 aspirate → N partial jet dispenses + rest to waste
 *  VENUS pattern: HighVolume_Water_AliquotDispenseJet_Part liquid class.
 *  The instrument aspirates (N * dispenseVolume + restVolume), then dispenses
 *  N times with dm=2 (surface partial), keeping rest volume in the tip.
 *  Tips are ejected with the rest volume (blown out to waste). */
export interface AliquotDispenseParams {
  tipPosition: DeckAddress;
  sourcePosition: DeckAddress;
  destPositions: DeckAddress[];    // one per dispense (length = dispenseCount)
  dispenseVolume: number;          // µL per dispense
  restVolume?: number;             // µL retained in tip (default 5% of total)
  channelMask?: number;
  tipType?: number;
  liquidClass?: string;            // default "HighVolume_Water_AliquotDispenseJet_Part"
}

/** Parameters for LoadCarrier step */
export interface LoadCarrierParams {
  track: number;            // Starting track number (1-based)
  carrierType: string;      // Carrier template name (e.g. "PLT_CAR_L5AC")
  carrierId: string;        // Unique carrier ID
  labware?: Array<{         // Optional labware to place on the carrier
    position: number;       // Position index (0-based)
    type: string;           // Labware template name (e.g. "HAM_DW_12ml")
  }>;
}

// ============================================================================
// Step Executor
// ============================================================================

/**
 * VENUS Step Executor.
 *
 * Translates high-level step requests into FW command sequences,
 * sends them through the DigitalTwin, and collects results.
 */
export class StepExecutor {
  private twin: DigitalTwin;
  private deck: Deck;
  private orderId = 1000;
  /**
   * stepId tagged onto every sub-command sent while a composite step is
   * running. Set by `executeStep` and cleared in its finally block so events
   * emitted by the sub-commands share a single id. See Step 1.9.
   */
  private currentStepId: number | undefined = undefined;

  constructor(twin: DigitalTwin) {
    this.twin = twin;
    this.deck = twin.getDeck();
  }

  private nextId(): string {
    return String(++this.orderId).padStart(4, "0");
  }

  private pad5(n: number): string {
    return String(Math.round(n)).padStart(5, "0");
  }

  private pad4(n: number): string {
    return String(Math.round(n)).padStart(4, "0");
  }

  /** Resolve a DeckAddress to FW coordinates (xp, yp) */
  resolvePosition(addr: DeckAddress): DeckPosition {
    const wellAddr: WellAddress = {
      carrierId: addr.carrierId,
      position: addr.position,
      row: addr.row ?? 0,
      column: addr.column,
    };
    const pos = this.deck.wellToPosition(wellAddr);
    if (!pos) {
      throw new Error(`Cannot resolve position: ${addr.carrierId} pos ${addr.position} col ${addr.column}`);
    }
    return pos;
  }

  /** Labware top Z (0.1 mm above deck) at a deck address — the `height`
   *  field of the placed labware (= ZTrans, well A1 top height). Used
   *  to compute sensible `tp` / `zp` / `th` defaults for FW commands
   *  so the twin's animations reach the actual labware instead of
   *  hardcoded heights. Returns a fallback (144 = typical 96-well
   *  plate) when the address is unresolvable. */
  private labwareTopZ(addr: DeckAddress): number {
    const lw = this.labwareAt(addr);
    if (lw?.height !== undefined && lw.height > 0) return lw.height;
    return 1440;  // 144 mm fallback — typical 96-well plate top
  }

  /** Resolve a DeckAddress to its placed LabwareItem (or undefined).
   *  Shared lookup for labwareTopZ and the tip-geometry helpers so
   *  callers don't walk `deck.getAllCarriers()` three times per step. */
  private labwareAt(addr: DeckAddress): import("./deck").LabwareItem | undefined {
    const carrier = this.deck.getAllCarriers().find((c) => c.id === addr.carrierId);
    return carrier?.labware[addr.position] ?? undefined;
  }

  /** Send a raw FW command and collect the result */
  private exec(raw: string): { raw: string; result: CommandResult } {
    const result = this.twin.sendCommand(raw, { stepId: this.currentStepId });
    return { raw, result };
  }

  /** Flush pending delayed events (move.done, wash.done, etc.) */
  private flush(): void {
    this.twin.flushPendingEvents();
  }

  /** Build a single-command StepResult */
  private singleResult(stepType: string, cmd: { raw: string; result: CommandResult }): StepResult {
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType,
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  // ── Single Steps ──────────────────────────────────────────────────────
  // Parameter order and semantics from VENUS C++ source:
  //   AtsMcPickUpTip.cpp, AtsMcAspirate.cpp, AtsMcDispense.cpp, AtsMcEjectTip.cpp
  // Source annotations: user=user input, liquidClass=from LC, deckLayout=from deck,
  //   default=hardcoded default, computed=calculated from other params

  /** Build annotated command result */
  private annotatedResult(stepType: string, raw: string, annotations: ParamAnnotation[]): StepResult {
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType,
      commands: [{ ...cmd, annotations }],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** TipPickUp — C0TP (VENUS: AtsMcPickUpTip.cpp)
   *  Param order: xp, yp, tm, tt, tp, tz, th, td */
  tipPickUp(params: TipPickUpParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const tm = params.channelMask ?? 255;
    const tt = params.tipType ?? 4;
    const id = this.nextId();

    // Hamilton pos_z convention: height above deck (bigger = higher).
    // Derive tp and th from the tip-rack geometry + tip geometry:
    //   tipTopZ   = rackTop + tipProtrusion (where the tip collar top sits)
    //   tp        = tipTopZ − collar/2  (nozzle lands mid-collar for grip)
    //   th        = rackTop + tipLength + 50  (tip end 5 mm above rack top
    //                                          once the tip is fitted)
    //
    // Tip geometry comes from the labware CATALOG entry keyed by
    // labware.type — the catalog is the single source of Hamilton-spec
    // dimensions (Tips_1000uL: tipLength=950, collar=115, protrusion=150;
    // Tips_300uL: 600/80/120; Tips_50uL: 350/50/80). Looking up by type
    // means labware loaded from .rck / VENUS .lay files — which don't
    // carry the tipX fields on the LabwareItem — still gets proper
    // tip-specific dimensions. Placed-item overrides win when present.
    const lw = this.labwareAt(params.position);
    const catalog = lw?.type ? findCatalogEntry(lw.type) : undefined;
    const rackTopZ = (lw?.height !== undefined && lw.height > 0) ? lw.height : 1440;
    const tipLength = lw?.tipLength ?? catalog?.tipLength ?? 950;
    const tipCollarHeight = lw?.tipCollarHeight ?? catalog?.tipCollarHeight ?? 115;
    const tipProtrusion = lw?.tipProtrusion ?? catalog?.tipProtrusion ?? 150;
    const tipTopZ = rackTopZ + tipProtrusion;
    const tp = Math.max(0, tipTopZ - Math.round(tipCollarHeight / 2));
    const th = rackTopZ + tipLength + 50;
    const raw = `C0TPid${id}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}tm${tm}tt${String(tt).padStart(2, "0")}tp${this.pad4(tp)}th${this.pad4(th)}`;

    const annotations: ParamAnnotation[] = [
      { key: "xp", value: this.pad5(pos.x), description: `X position ${(pos.x / 10).toFixed(1)}mm (${params.position.carrierId} col ${params.position.column})`, source: "deckLayout" },
      { key: "yp", value: this.pad5(pos.y), description: `Y position ${(pos.y / 10).toFixed(1)}mm (row A)`, source: "deckLayout" },
      { key: "tm", value: String(tm), description: `channel mask (${countBits(tm)} channels)`, source: tm === 255 ? "default" : "user" },
      { key: "tt", value: String(tt).padStart(2, "0"), description: `tip type ${tt === 4 ? "standard 1000µL" : tt === 1 ? "384-head" : String(tt)}`, source: tt === 4 ? "default" : "user" },
      { key: "tp", value: this.pad4(tp), description: `pickup Z ${(tp / 10).toFixed(1)}mm — ${(tipCollarHeight/20).toFixed(1)}mm into collar (top=${(tipTopZ / 10).toFixed(1)}mm)`, source: lw?.tipLength !== undefined ? "deckLayout" : catalog?.tipLength !== undefined ? "computed" : "default" },
      { key: "th", value: this.pad4(th), description: `post-retract Z ${(th / 10).toFixed(1)}mm — tip end ≥ rack top + 5mm once fitted (tipLen=${(tipLength/10).toFixed(0)}mm)`, source: lw?.tipLength !== undefined ? "deckLayout" : catalog?.tipLength !== undefined ? "computed" : "default" },
    ];

    return this.annotatedResult("TipPickUp", raw, annotations);
  }

  /** TipEject — C0TR (VENUS: AtsMcEjectTip.cpp, RunTipEject.cpp)
   *  VENUS always sends waste coordinates. Channels are spread vertically
   *  across the waste Y range (setEjectPositionFromWasteLabware).
   *  Param order: xp, yp, tp, tz, th, te, tm, ti */
  tipEject(params: TipEjectParams): StepResult {
    const tm = params.channelMask ?? 255;
    // VENUS: calculate waste position, distribute channels across Y range
    const waste = this.deck.getWasteEjectPositions(8);
    const id = this.nextId();

    // Hamilton pos_z convention: bigger = higher above deck.
    //   tz = eject Z — where the PIP nozzle lands so the waste-collar
    //        mechanical stripper pushes the tip off. Sourced from the
    //        deck's tip-waste geometry (deck.getWasteEjectPositions().z)
    //        so it matches whatever waste labware is configured.
    //   th = post-retract Z — no tip fitted after eject, so z_traverse
    //        (145 mm) is safe. Kept explicit so the SCXML writes pos_z.
    const tz = waste.z;
    const th = 1450;
    const raw = `C0TRid${id}xp${this.pad5(waste.x)}yp${this.pad5(waste.yChannels[0])}tm${tm}tz${this.pad4(tz)}th${this.pad4(th)}`;

    const annotations: ParamAnnotation[] = [
      { key: "xp", value: this.pad5(waste.x), description: `waste X ${(waste.x / 10).toFixed(1)}mm (tip waste track)`, source: "deckLayout" },
      { key: "yp", value: this.pad5(waste.yChannels[0]), description: `waste Y ${(waste.yChannels[0] / 10).toFixed(1)}mm (channels spread across waste)`, source: "computed" },
      { key: "tm", value: String(tm), description: `channel mask (${countBits(tm)} channels)`, source: tm === 255 ? "default" : "user" },
      { key: "tz", value: this.pad4(tz), description: `eject Z ${(tz / 10).toFixed(1)}mm (from waste geometry)`, source: "deckLayout" },
      { key: "th", value: this.pad4(th), description: `post-retract Z ${(th / 10).toFixed(1)}mm (traverse height, no tip)`, source: "default" },
    ];
    return this.annotatedResult("TipEject", raw, annotations);
  }

  /** Aspirate — C0AS (VENUS: AtsMcAspirate.cpp)
   *  Key params: at, tm, xp, yp, th, te, lp, ch, zl, zx, ip, it, fp,
   *  av, as, ta, ba, oa, lm, ll, lv, ld, de, wt, mv, mc, mp, ms, gi, gj, gk, ... */
  aspirate(params: AspirateParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const tm = params.channelMask ?? 255;
    const vol = Math.round(params.volume * 10);  // µL → 0.1µL
    const lm = params.lldMode ?? 0;
    const lcName = params.liquidClass || "HighVolume_Water_DispenseJet_Empty";
    const lc = getLiquidClass(lcName);
    const mv = params.mixVolume ? Math.round(params.mixVolume * 10) : 0;
    const mc = params.mixCycles ?? 0;
    const id = this.nextId();

    // Liquid class parameters (from VENUS LC editor calibration data)
    const aspSpeed = lc?.aspiration.speed ?? 2500;
    const transportAir = lc?.aspiration.transportAir ?? 50;
    const blowoutAir = lc?.aspiration.blowoutAir ?? 0;
    const settleTime = lc?.aspiration.settlingTime ?? 5;

    // Z-height parameters from user or liquid class defaults
    const submergeDepth_mm = params.submergeDepth ?? lc?.aspiration.submergeDepth ?? 2.0;
    const submergeDepth_01mm = Math.round(submergeDepth_mm * 10);
    const liquidFollowing = params.liquidFollowing ?? lc?.aspiration.liquidFollowing ?? true;
    // Traverse height default is labware-aware when tips are fitted.
    // Real VENUS computes this per-move from deck topology; we use
    // (labware.height + fitted-tip-length + 5 mm safety) so the tip
    // end clears the labware top by 5 mm post-retract. Without this,
    // the default 145 mm left tips BELOW the plate top on any plate
    // taller than ~85 mm (every deep-well plate and most tip racks),
    // which made the renderer show tips "disappearing into the plate"
    // after aspirate.
    //
    // Fitted-tip length comes from the twin's channel state: the
    // `tipType` (e.g. "Tips_300uL") looked up in the labware catalog
    // gives the real Hamilton tip dimensions. Falls back to 1000 µL
    // (95 mm) when no channel has a fitted tip — conservative.
    let fittedTipLength_01mm = 0;
    const chState = this.twin.getDeckTracker().getChannelState(0);
    if (chState?.hasTip && chState.tipType) {
      const tipCatalog = findCatalogEntry(chState.tipType);
      fittedTipLength_01mm = tipCatalog?.tipLength ?? 950;
    }
    let defaultTraverseMm = 145;
    const lwAsp = this.deck.getAllCarriers().find((c) => c.id === params.position.carrierId)?.labware[params.position.position];
    if (lwAsp?.height !== undefined && lwAsp.height > 0 && fittedTipLength_01mm > 0) {
      defaultTraverseMm = Math.max(145, Math.round((lwAsp.height + fittedTipLength_01mm + 50) / 10));
    }
    const traverseH_mm = params.traverseHeight ?? defaultTraverseMm;
    const traverseH = Math.round(traverseH_mm * 10);

    // Compute Z position using deck tracker + well geometry
    let tipZ = 0;
    let zSource: ParamSource = "default";
    let zDescription = "";

    const tracker = this.twin.getDeckTracker();
    const carrier = this.deck.getCarrier(params.position.carrierId);
    const labware = carrier?.labware?.[params.position.position];

    if (params.fixedHeight !== undefined) {
      // Fixed height from well bottom: absolute Z position
      const fixedH_01mm = Math.round(params.fixedHeight * 10);
      const labwareHeight = labware?.height ?? 144;
      const wellDepth = labware?.wellDepth ?? 112;
      const wellBottomZ = labwareHeight - wellDepth;
      tipZ = wellBottomZ + fixedH_01mm;
      zSource = "user";
      zDescription = `fixed ${params.fixedHeight}mm from well bottom (Z=${(tipZ / 10).toFixed(1)}mm)`;
    } else if (labware) {
      // Compute from well geometry + current volume
      const geo = getWellGeometry(labware.type);
      const wellIndex = (params.position.row ?? 0) * (labware.columns ?? 12) + params.position.column;
      const wellVolume = tracker.getWellVolume(params.position.carrierId, params.position.position, wellIndex) ?? 0;
      const labwareHeight = labware.height ?? 144;

      const pipZ = calculatePipetteZ(geo, wellVolume, labwareHeight, submergeDepth_01mm);
      if (pipZ !== null) {
        tipZ = pipZ;
        zSource = "computed";
        zDescription = `${submergeDepth_mm}mm below surface (Z=${(tipZ / 10).toFixed(1)}mm, vol=${wellVolume / 10}uL)`;
      } else {
        // Not enough liquid for safe submerge — use fixed fallback
        const wellBottomZ = labwareHeight - (labware.wellDepth ?? 112);
        tipZ = wellBottomZ + 20;  // 2mm above bottom
        zSource = "computed";
        zDescription = `fallback 2mm above bottom (insufficient liquid, vol=${wellVolume / 10}uL)`;
      }
    }

    // Build command — VENUS parameter order (simplified, key params only)
    // Full VENUS sends ~44 params; we send the ones the twin processes
    let raw = `C0ASid${id}`;
    raw += `tm${tm}`;                           // from: user / default
    raw += `xp${this.pad5(pos.x)}`;             // from: deckLayout
    raw += `yp${this.pad5(pos.y)}`;             // from: deckLayout
    if (tipZ > 0) {
      raw += `zp${this.pad5(tipZ)}`;            // from: computed / user
      raw += `th${this.pad5(traverseH)}`;       // from: user / default
      raw += `ip${this.pad5(submergeDepth_01mm)}`;  // from: user / liquidClass
    }
    raw += `av${this.pad5(vol)}`;               // from: user
    raw += `as${this.pad5(aspSpeed)}`;           // from: liquidClass
    raw += `ta${this.pad5(transportAir)}`;       // from: liquidClass
    raw += `ba${this.pad5(blowoutAir)}`;         // from: liquidClass
    raw += `lm${lm}`;                           // from: user / default
    raw += `wt${String(settleTime).padStart(2, "0")}`;  // from: liquidClass
    if (mc > 0) {
      raw += `mv${this.pad5(mv)}`;              // from: user
      raw += `mc${String(mc).padStart(2, "0")}`; // from: user
    }
    // Liquid following flag: lf1 = on, lf0 = off
    raw += `lf${liquidFollowing ? 1 : 0}`;

    const annotations: ParamAnnotation[] = [
      { key: "tm", value: String(tm), description: `channel mask (${countBits(tm)} ch)`, source: tm === 255 ? "default" : "user" },
      { key: "xp", value: this.pad5(pos.x), description: `X ${(pos.x / 10).toFixed(1)}mm (${params.position.carrierId} col ${params.position.column})`, source: "deckLayout" },
      { key: "yp", value: this.pad5(pos.y), description: `Y ${(pos.y / 10).toFixed(1)}mm (row A)`, source: "deckLayout" },
    ];
    if (tipZ > 0) {
      annotations.push(
        { key: "zp", value: this.pad5(tipZ), description: `tip Z ${zDescription}`, source: zSource },
        { key: "th", value: this.pad5(traverseH), description: `traverse height ${traverseH_mm}mm`, source: params.traverseHeight !== undefined ? "user" : "default" },
        { key: "ip", value: this.pad5(submergeDepth_01mm), description: `submerge depth ${submergeDepth_mm}mm`, source: params.submergeDepth !== undefined ? "user" : "liquidClass" },
      );
    }
    annotations.push(
      { key: "av", value: this.pad5(vol), description: `aspiration volume ${params.volume}µL`, source: "user" },
      { key: "as", value: this.pad5(aspSpeed), description: `flow rate ${aspSpeed / 10}µL/s`, source: "liquidClass" },
      { key: "ta", value: this.pad5(transportAir), description: `transport air ${transportAir / 10}µL`, source: "liquidClass" },
      { key: "ba", value: this.pad5(blowoutAir), description: `blowout air ${blowoutAir / 10}µL`, source: "liquidClass" },
      { key: "lm", value: String(lm), description: `LLD mode ${["off", "cLLD", "pLLD", "dual", "Z-touch"][lm] || lm}`, source: lm === 0 ? "default" : "user" },
      { key: "wt", value: String(settleTime).padStart(2, "0"), description: `settle time ${settleTime * 100}ms`, source: "liquidClass" },
    );
    if (mc > 0) {
      annotations.push({ key: "mv", value: this.pad5(mv), description: `mix volume ${mv / 10}µL`, source: "user" });
      annotations.push({ key: "mc", value: String(mc).padStart(2, "0"), description: `mix cycles ${mc}`, source: "user" });
    }
    annotations.push({ key: "lf", value: String(liquidFollowing ? 1 : 0), description: `liquid following ${liquidFollowing ? "ON" : "OFF"}`, source: params.liquidFollowing !== undefined ? "user" : "liquidClass" });

    return this.annotatedResult("Aspirate", raw, annotations);
  }

  /** Dispense — C0DS (VENUS: AtsMcDispense.cpp)
   *  Key params: dm, tm, xp, yp, zx, lp, zl, ip, it, fp, th, te,
   *  dv, ds, ss, rv, ta, ba, lm, zo, ll, lv, de, mv, mc, mp, ms, wt, gi, gj, gk, ... */
  dispense(params: DispenseParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const tm = params.channelMask ?? 255;
    const vol = Math.round(params.volume * 10);
    const dm = params.dispenseMode ?? 0;
    const lcName = params.liquidClass || "HighVolume_Water_DispenseJet_Empty";
    const lc = getLiquidClass(lcName);
    const id = this.nextId();

    const dspSpeed = lc?.dispense.speed ?? 5000;
    const transportAir = lc?.aspiration.transportAir ?? 50;  // shared with aspirate in LC
    const touchOff = params.touchOff ?? lc?.dispense.sideTouchOff ?? false;

    // Z-height parameters for dispense
    const fixedH_mm = params.fixedHeight ?? lc?.dispense.fixedHeight ?? 10;
    const fixedH_01mm = Math.round(fixedH_mm * 10);
    const traverseH = 1450;  // 145mm default traverse

    // Compute Z position from fixed height above well bottom
    let tipZ = 0;
    let zSource: ParamSource = "default";
    let zDescription = "";

    const carrier = this.deck.getCarrier(params.position.carrierId);
    const labware = carrier?.labware?.[params.position.position];

    if (labware) {
      const labwareHeight = labware.height ?? 144;
      const wellDepth = labware.wellDepth ?? 112;
      const wellBottomZ = labwareHeight - wellDepth;
      tipZ = wellBottomZ + fixedH_01mm;
      zSource = params.fixedHeight !== undefined ? "user" : "liquidClass";
      zDescription = `${fixedH_mm}mm from well bottom (Z=${(tipZ / 10).toFixed(1)}mm)`;
    }

    let raw = `C0DSid${id}`;
    raw += `dm${dm}`;                           // from: user / default
    raw += `tm${tm}`;                           // from: user / default
    raw += `xp${this.pad5(pos.x)}`;             // from: deckLayout
    raw += `yp${this.pad5(pos.y)}`;             // from: deckLayout
    if (tipZ > 0) {
      raw += `zp${this.pad5(tipZ)}`;            // from: computed / liquidClass
      raw += `th${this.pad5(traverseH)}`;       // from: default
    }
    raw += `dv${this.pad5(vol)}`;               // from: user
    raw += `ds${this.pad5(dspSpeed)}`;           // from: liquidClass
    raw += `ta${this.pad5(transportAir)}`;       // from: liquidClass
    if (touchOff) {
      raw += `to1`;                             // from: user / liquidClass
    }

    const dmLabels = ["jet empty", "reserved", "surface partial", "surface empty", "jet tip empty"];
    const annotations: ParamAnnotation[] = [
      { key: "dm", value: String(dm), description: `dispense mode: ${dmLabels[dm] || dm}`, source: dm === 0 ? "default" : "user" },
      { key: "tm", value: String(tm), description: `channel mask (${countBits(tm)} ch)`, source: tm === 255 ? "default" : "user" },
      { key: "xp", value: this.pad5(pos.x), description: `X ${(pos.x / 10).toFixed(1)}mm (${params.position.carrierId} col ${params.position.column})`, source: "deckLayout" },
      { key: "yp", value: this.pad5(pos.y), description: `Y ${(pos.y / 10).toFixed(1)}mm`, source: "deckLayout" },
    ];
    if (tipZ > 0) {
      annotations.push(
        { key: "zp", value: this.pad5(tipZ), description: `tip Z ${zDescription}`, source: zSource },
        { key: "th", value: this.pad5(traverseH), description: `traverse height 145mm`, source: "default" },
      );
    }
    annotations.push(
      { key: "dv", value: this.pad5(vol), description: `dispense volume ${params.volume}µL`, source: "user" },
      { key: "ds", value: this.pad5(dspSpeed), description: `flow rate ${dspSpeed / 10}µL/s`, source: "liquidClass" },
      { key: "ta", value: this.pad5(transportAir), description: `transport air ${transportAir / 10}µL`, source: "liquidClass" },
    );
    if (touchOff) {
      annotations.push({ key: "to", value: "1", description: "side touch-off enabled", source: params.touchOff !== undefined ? "user" : "liquidClass" });
    }

    return this.annotatedResult("Dispense", raw, annotations);
  }

  /** MovePIP — C0JM */
  movePIP(params: MovePIPParams): StepResult {
    const xp = Math.round(params.xPosition * 10);  // mm → 0.1mm
    const raw = `C0JMid${this.nextId()}xp${this.pad5(xp)}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "MovePIP",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** Head96 Move — C0EM */
  head96Move(params: Head96MoveParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const raw = `C0EMid${this.nextId()}xs${this.pad5(pos.x)}yh${this.pad5(pos.y)}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "Head96Move",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** Head96 TipPickUp — C0EP */
  head96TipPickUp(params: Head96TipPickUpParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const raw = `C0EPid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "Head96TipPickUp",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** Head96 Aspirate — C0EA */
  head96Aspirate(params: Head96AspirateParams): StepResult {
    const vol = Math.round(params.volume * 10);
    const raw = `C0EAid${this.nextId()}af${this.pad5(vol)}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "Head96Aspirate",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** Head96 Dispense — C0ED */
  head96Dispense(params: Head96DispenseParams): StepResult {
    const vol = Math.round(params.volume * 10);
    const dm = params.dispenseMode ?? 0;
    const raw = `C0EDid${this.nextId()}df${this.pad5(vol)}dm${dm}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "Head96Dispense",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** Head96 TipEject — C0ER */
  head96TipEject(_params?: Head96TipEjectParams): StepResult {
    const raw = `C0ERid${this.nextId()}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "Head96TipEject",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** SetTemperature — C0HC */
  setTemperature(params: SetTemperatureParams): StepResult {
    const temp = Math.round(params.temperature * 10);  // °C → 0.1°C
    const hn = params.heaterNumber ?? 1;
    const raw = `C0HCid${this.nextId()}hn${hn}hc${this.pad5(temp).slice(-4)}`;
    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "SetTemperature",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  /** Wash — C0WS (VENUS: AtsMcWashNeedle.cpp)
   *  Parameters: wn (washer), wm (station), ws (mode), wa/sa/ia/wb/sb/ib (cycle params), dt (drain) */
  wash(params?: WashParams): StepResult {
    const id = this.nextId();
    const chamber = params?.chamber ?? 1;
    const rinseTime = params?.rinseTime ?? 5000;
    const soakTime = params?.soakTime ?? 5000;
    const flowRate = params?.flowRate ?? 11;
    const drainingTime = params?.drainingTime ?? 10000;

    // Build FW command with wash parameters
    let raw = `C0WSid${id}`;
    raw += `wn1wm${chamber}ws1`;  // washer 1, station N, mode 1
    raw += `wa${String(Math.round(rinseTime / 100)).padStart(4, "0")}`;  // rinse time (0.1s units)
    raw += `sa${String(Math.round(soakTime / 100)).padStart(4, "0")}`;   // soak time
    raw += `ia${String(flowRate).padStart(3, "0")}`;                      // flow rate
    raw += `dt${String(Math.round(drainingTime / 100)).padStart(4, "0")}`; // drain time

    const cmd = this.exec(raw);
    return {
      success: cmd.result.accepted && cmd.result.errorCode === 0,
      stepType: "Wash",
      commands: [cmd],
      error: cmd.result.errorCode > 0 ? cmd.result.errorDescription : undefined,
      assessments: cmd.result.assessments || [],
    };
  }

  // ── LoadCarrier ──────────────────────────────────────────────────────

  /** Load a carrier onto the deck at runtime — C0CI + C0CL
   *  This step dynamically adds a carrier to the deck model.
   *  The FW commands C0CI (identify) and C0CL (load) are sent for protocol fidelity. */
  loadCarrier(params: LoadCarrierParams): StepResult {
    if (!findCarrierCatalogEntry(params.carrierType)) {
      return { success: false, stepType: "LoadCarrier", commands: [], error: `Unknown carrier type: ${params.carrierType}`, assessments: [] };
    }

    // Build the carrier from the single-source-of-truth catalog.
    const carrier = carrierFromCatalog(params.carrierType, params.track, params.carrierId);

    // Place labware if specified. `lw.type` is the Hamilton catalog
    // type name (Cos_96_Rd, Tips_1000uL, ...); labware-catalog is the
    // single source of geometry truth.
    if (params.labware) {
      for (const lw of params.labware) {
        const lwItem = labwareItemFromCatalog(lw.type);
        if (lwItem) {
          carrier.labware[lw.position] = lwItem as any;
        }
      }
    }

    // Add to deck
    const loaded = this.deck.loadCarrier(carrier);
    if (!loaded) {
      return { success: false, stepType: "LoadCarrier", commands: [], error: `Cannot load carrier at track ${params.track}: track occupied`, assessments: [] };
    }

    // Send FW commands for protocol fidelity
    const id1 = this.nextId();
    const cmd1 = this.exec(`C0CIid${id1}cp${String(params.track).padStart(2, "0")}`);
    const id2 = this.nextId();
    const cmd2 = this.exec(`C0CLid${id2}bd0bp0000cn${String(carrier.positions).padStart(2, "0")}co0960`);

    return {
      success: true,
      stepType: "LoadCarrier",
      commands: [cmd1, cmd2],
      assessments: [],
    };
  }

  // ── iSWAP Transport ───────────────────────────────────────────────────

  /** iSWAP GetPlate — C0PP */
  getPlate(params: GetPlateParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const gw = Math.round((params.gripWidth ?? 82) * 10);
    const ow = Math.round((params.openWidth ?? 130) * 10);
    const gh = Math.round((params.gripHeight ?? 5) * 10);
    const raw = `C0PPid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}gw${this.pad5(gw)}go${this.pad5(ow)}gh${this.pad5(gh)}`;
    const cmd = this.exec(raw);
    return this.singleResult("GetPlate", cmd);
  }

  /** iSWAP PutPlate — C0PR */
  putPlate(params: PutPlateParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const ow = Math.round((params.openWidth ?? 130) * 10);
    const raw = `C0PRid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}go${this.pad5(ow)}`;
    const cmd = this.exec(raw);
    return this.singleResult("PutPlate", cmd);
  }

  /** iSWAP MovePlate — C0PM */
  movePlate(params: MovePlateParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const raw = `C0PMid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}`;
    const cmd = this.exec(raw);
    return this.singleResult("MovePlate", cmd);
  }

  // ── CO-RE Gripper ─────────────────────────────────────────────────────

  /** CO-RE Gripper GetTool — C0ZT */
  gripperGetTool(_params?: GripperGetToolParams): StepResult {
    const raw = `C0ZTid${this.nextId()}`;
    const cmd = this.exec(raw);
    return this.singleResult("GripperGetTool", cmd);
  }

  /** CO-RE Gripper GripPlate — C0ZP */
  gripperGripPlate(params: GripperGripPlateParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const gw = Math.round((params.gripWidth ?? 82) * 10);
    const raw = `C0ZPid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}gw${this.pad5(gw)}`;
    const cmd = this.exec(raw);
    return this.singleResult("GripperGripPlate", cmd);
  }

  /** CO-RE Gripper Release — C0ZR */
  gripperRelease(params: GripperReleaseParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const raw = `C0ZRid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}`;
    const cmd = this.exec(raw);
    return this.singleResult("GripperRelease", cmd);
  }

  /** CO-RE Gripper DiscardTool — C0ZS */
  gripperDiscardTool(_params?: GripperDiscardToolParams): StepResult {
    const raw = `C0ZSid${this.nextId()}`;
    const cmd = this.exec(raw);
    return this.singleResult("GripperDiscardTool", cmd);
  }

  // ── Advanced Pipetting ────────────────────────────────────────────────

  /** DispenseFly — C0DF (dispense while moving in X) */
  dispenseFly(params: DispenseFlyParams): StepResult {
    const pos = this.resolvePosition(params.position);
    const tm = params.channelMask ?? 255;
    const vol = Math.round(params.volume * 10);
    const xi = params.numDispenses ?? 1;
    const raw = `C0DFid${this.nextId()}xp${this.pad5(pos.x)}yp${this.pad5(pos.y)}dv${this.pad5(vol)}xi${String(xi).padStart(2, "0")}tm${tm}`;
    const cmd = this.exec(raw);
    return this.singleResult("DispenseFly", cmd);
  }

  // ── Easy Steps (composite) ────────────────────────────────────────────

  /** EasyAspirate = TipPickUp + Aspirate */
  easyAspirate(params: EasyAspirateParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];

    // Step 1: Pick up tips
    const pickup = this.tipPickUp({
      position: params.tipPosition,
      channelMask: params.channelMask,
      tipType: params.tipType,
    });
    allCommands.push(...pickup.commands);
    allAssessments.push(...pickup.assessments);
    if (!pickup.success) {
      return { success: false, stepType: "EasyAspirate", commands: allCommands, error: `TipPickUp failed: ${pickup.error}`, assessments: allAssessments };
    }

    // Step 2: Aspirate
    const asp = this.aspirate({
      position: params.aspiratePosition,
      volume: params.volume,
      channelMask: params.channelMask,
      liquidClass: params.liquidClass,
      lldMode: params.lldMode,
      mixCycles: params.mixCycles,
      mixVolume: params.mixVolume,
    });
    allCommands.push(...asp.commands);
    allAssessments.push(...asp.assessments);

    return {
      success: asp.success,
      stepType: "EasyAspirate",
      commands: allCommands,
      error: asp.error,
      assessments: allAssessments,
    };
  }

  /** EasyDispense = Dispense + TipEject */
  easyDispense(params: EasyDispenseParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];

    // Step 1: Dispense
    const disp = this.dispense({
      position: params.dispensePosition,
      volume: params.volume,
      channelMask: params.channelMask,
      dispenseMode: params.dispenseMode,
      liquidClass: params.liquidClass,
    });
    allCommands.push(...disp.commands);
    allAssessments.push(...disp.assessments);
    if (!disp.success) {
      return { success: false, stepType: "EasyDispense", commands: allCommands, error: `Dispense failed: ${disp.error}`, assessments: allAssessments };
    }

    // Step 2: Eject tips
    const eject = this.tipEject({ channelMask: params.channelMask });
    allCommands.push(...eject.commands);
    allAssessments.push(...eject.assessments);

    return {
      success: eject.success,
      stepType: "EasyDispense",
      commands: allCommands,
      error: eject.error,
      assessments: allAssessments,
    };
  }

  /** EasyTransfer = TipPickUp + Aspirate + Dispense + TipEject */
  easyTransfer(params: EasyTransferParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];

    // Step 1: Pick up tips
    const pickup = this.tipPickUp({
      position: params.tipPosition,
      channelMask: params.channelMask,
      tipType: params.tipType,
    });
    allCommands.push(...pickup.commands);
    allAssessments.push(...pickup.assessments);
    if (!pickup.success) {
      return { success: false, stepType: "EasyTransfer", commands: allCommands, error: `TipPickUp failed: ${pickup.error}`, assessments: allAssessments };
    }

    // Step 2: Aspirate from source
    const asp = this.aspirate({
      position: params.sourcePosition,
      volume: params.volume,
      channelMask: params.channelMask,
      liquidClass: params.liquidClass,
      lldMode: params.lldMode,
    });
    allCommands.push(...asp.commands);
    allAssessments.push(...asp.assessments);
    if (!asp.success) {
      return { success: false, stepType: "EasyTransfer", commands: allCommands, error: `Aspirate failed: ${asp.error}`, assessments: allAssessments };
    }

    // Step 3: Dispense to destination
    const disp = this.dispense({
      position: params.destPosition,
      volume: params.volume,
      channelMask: params.channelMask,
      dispenseMode: params.dispenseMode,
    });
    allCommands.push(...disp.commands);
    allAssessments.push(...disp.assessments);
    if (!disp.success) {
      return { success: false, stepType: "EasyTransfer", commands: allCommands, error: `Dispense failed: ${disp.error}`, assessments: allAssessments };
    }

    // Step 4: Eject tips
    const eject = this.tipEject({ channelMask: params.channelMask });
    allCommands.push(...eject.commands);
    allAssessments.push(...eject.assessments);

    return {
      success: eject.success,
      stepType: "EasyTransfer",
      commands: allCommands,
      error: eject.error,
      assessments: allAssessments,
    };
  }

  /** Easy96Aspirate = Head96Move (tip) + Head96TipPickUp + Head96Move (plate) + Head96Aspirate */
  easy96Aspirate(params: Easy96AspirateParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];

    // Step 1: Move to tips (flush delayed events to complete move)
    const move1 = this.head96Move({ position: params.tipPosition });
    allCommands.push(...move1.commands);
    allAssessments.push(...move1.assessments);
    if (!move1.success) {
      return { success: false, stepType: "Easy96Aspirate", commands: allCommands, error: `Move to tips failed: ${move1.error}`, assessments: allAssessments };
    }
    this.flush();

    // Step 2: Pick up tips
    const pickup = this.head96TipPickUp({ position: params.tipPosition });
    allCommands.push(...pickup.commands);
    allAssessments.push(...pickup.assessments);
    if (!pickup.success) {
      return { success: false, stepType: "Easy96Aspirate", commands: allCommands, error: `TipPickUp failed: ${pickup.error}`, assessments: allAssessments };
    }

    // Step 3: Move to plate (flush delayed events)
    const move2 = this.head96Move({ position: params.aspiratePosition });
    allCommands.push(...move2.commands);
    allAssessments.push(...move2.assessments);
    if (!move2.success) {
      return { success: false, stepType: "Easy96Aspirate", commands: allCommands, error: `Move to plate failed: ${move2.error}`, assessments: allAssessments };
    }
    this.flush();

    // Step 4: Aspirate
    const asp = this.head96Aspirate({ volume: params.volume });
    allCommands.push(...asp.commands);
    allAssessments.push(...asp.assessments);

    return {
      success: asp.success,
      stepType: "Easy96Aspirate",
      commands: allCommands,
      error: asp.error,
      assessments: allAssessments,
    };
  }

  /** Easy96Dispense = Head96Dispense + Head96Move (eject pos) + Head96TipEject */
  easy96Dispense(params: Easy96DispenseParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];

    // Dispense
    const disp = this.head96Dispense({ volume: params.volume, dispenseMode: params.dispenseMode });
    allCommands.push(...disp.commands);
    allAssessments.push(...disp.assessments);
    if (!disp.success) {
      return { success: false, stepType: "Easy96Dispense", commands: allCommands, error: `Dispense failed: ${disp.error}`, assessments: allAssessments };
    }

    // Move to eject position
    const move = this.head96Move({ position: params.ejectPosition });
    allCommands.push(...move.commands);
    allAssessments.push(...move.assessments);

    // Eject tips
    const eject = this.head96TipEject();
    allCommands.push(...eject.commands);
    allAssessments.push(...eject.assessments);

    return {
      success: eject.success,
      stepType: "Easy96Dispense",
      commands: allCommands,
      error: eject.error,
      assessments: allAssessments,
    };
  }

  /** EasyTransport = GetPlate + MovePlate + PutPlate (with iSWAP init + flush) */
  easyTransport(params: EasyTransportParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];

    const get = this.getPlate({ position: params.sourcePosition, gripWidth: params.gripWidth, openWidth: params.openWidth });
    allCommands.push(...get.commands);
    allAssessments.push(...get.assessments);
    if (!get.success) return { success: false, stepType: "EasyTransport", commands: allCommands, error: `GetPlate failed: ${get.error}`, assessments: allAssessments };
    this.flush();

    const put = this.putPlate({ position: params.destPosition, openWidth: params.openWidth });
    allCommands.push(...put.commands);
    allAssessments.push(...put.assessments);

    return { success: put.success, stepType: "EasyTransport", commands: allCommands, error: put.error, assessments: allAssessments };
  }

  // ── Power Steps (multi-column workflows) ──────────────────────────────

  /** TransferSamples — full plate transfer, column by column with fresh tips */
  transferSamples(params: TransferSamplesParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];
    const cols = params.columns ?? 12;
    const startCol = params.startColumn ?? 0;
    const mask = params.channelMask ?? 255;

    for (let c = startCol; c < startCol + cols; c++) {
      const step = this.easyTransfer({
        tipPosition: { carrierId: params.tipCarrier, position: params.tipPosition, column: c },
        sourcePosition: { carrierId: params.sourceCarrier, position: params.sourcePosition, column: c },
        destPosition: { carrierId: params.destCarrier, position: params.destPosition, column: c },
        volume: params.volume,
        channelMask: mask,
        tipType: params.tipType,
        liquidClass: params.liquidClass,
      });
      allCommands.push(...step.commands);
      allAssessments.push(...step.assessments);
      if (!step.success) {
        return { success: false, stepType: "TransferSamples", commands: allCommands, error: `Column ${c} failed: ${step.error}`, assessments: allAssessments };
      }
    }

    return { success: true, stepType: "TransferSamples", commands: allCommands, assessments: allAssessments };
  }

  /** AddReagent — aspirate from trough, dispense to each plate column */
  addReagent(params: AddReagentParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];
    const cols = params.columns ?? 12;
    const startCol = params.startColumn ?? 0;
    const mask = params.channelMask ?? 255;

    for (let c = startCol; c < startCol + cols; c++) {
      // Pick up tips (fresh each column)
      const tipCol = c;  // Use same column index for tips
      const pickup = this.tipPickUp({
        position: { carrierId: params.tipCarrier, position: params.tipPosition, column: tipCol },
        channelMask: mask,
      });
      allCommands.push(...pickup.commands);
      allAssessments.push(...pickup.assessments);
      if (!pickup.success) {
        return { success: false, stepType: "AddReagent", commands: allCommands, error: `Tip pickup col ${c}: ${pickup.error}`, assessments: allAssessments };
      }

      // Aspirate from trough (always column 0 — single well)
      const asp = this.aspirate({
        position: { carrierId: params.reagentCarrier, position: params.reagentPosition, column: 0 },
        volume: params.volume,
        channelMask: mask,
        liquidClass: params.liquidClass,
      });
      allCommands.push(...asp.commands);
      allAssessments.push(...asp.assessments);
      if (!asp.success) {
        return { success: false, stepType: "AddReagent", commands: allCommands, error: `Aspirate col ${c}: ${asp.error}`, assessments: allAssessments };
      }

      // Dispense to plate column
      const disp = this.dispense({
        position: { carrierId: params.destCarrier, position: params.destPosition, column: c },
        volume: params.volume,
        channelMask: mask,
      });
      allCommands.push(...disp.commands);
      allAssessments.push(...disp.assessments);
      if (!disp.success) {
        return { success: false, stepType: "AddReagent", commands: allCommands, error: `Dispense col ${c}: ${disp.error}`, assessments: allAssessments };
      }

      // Eject tips
      const eject = this.tipEject({ channelMask: mask });
      allCommands.push(...eject.commands);
      allAssessments.push(...eject.assessments);
      if (!eject.success) {
        return { success: false, stepType: "AddReagent", commands: allCommands, error: `Tip eject col ${c}: ${eject.error}`, assessments: allAssessments };
      }
    }

    return { success: true, stepType: "AddReagent", commands: allCommands, assessments: allAssessments };
  }

  /** SerialDilution — custom power step (NOT a built-in VENUS step).
   *  VENUS has no serial dilution step; users program it manually with
   *  individual aspirate/dispense steps. This convenience step automates
   *  the standard serial dilution workflow:
   *    For each dilution: pickup tips → mix source → aspirate → dispense →
   *    mix destination → eject tips (fresh tips prevent carryover).
   *  Destination mixing ensures homogenization after transfer. */
  /** Shared helper: expand a target descriptor to concrete well indices on a
   *  given labware. Used by both Fill and Clear. */
  private resolveTargetIndices(
    labware: { wellCount: number; columns?: number; rows?: number },
    target: "all" | "columns" | "rows" | "wells",
    columns?: number[],
    rows?: number[],
    wellIndices?: number[],
  ): number[] {
    const cols = labware.columns ?? (labware.wellCount > 96 ? 24 : 12);
    const nRows = labware.rows ?? Math.ceil(labware.wellCount / cols);
    const out = new Set<number>();
    if (target === "all" || labware.wellCount === 1) {
      for (let i = 0; i < labware.wellCount; i++) out.add(i);
    }
    if (target === "columns" && columns) {
      for (const c of columns) {
        if (c < 0 || c >= cols) continue;
        for (let r = 0; r < nRows; r++) out.add(r * cols + c);
      }
    }
    if (target === "rows" && rows) {
      for (const r of rows) {
        if (r < 0 || r >= nRows) continue;
        for (let c = 0; c < cols; c++) out.add(r * cols + c);
      }
    }
    if (target === "wells" && wellIndices) {
      for (const i of wellIndices) if (i >= 0 && i < labware.wellCount) out.add(i);
    }
    return Array.from(out);
  }

  /** Clear — removes all liquid from the chosen wells. Setup-only, mirrors Fill. */
  clear(params: ClearParams): StepResult {
    if (!params.carrierId) {
      return { success: false, stepType: "Clear", commands: [], error: "Missing carrierId", assessments: [] };
    }
    const deck = this.twin.getDeck();
    const carrier = deck.getCarrier(params.carrierId);
    if (!carrier) return { success: false, stepType: "Clear", commands: [], error: `Carrier ${params.carrierId} not found`, assessments: [] };
    const labware = carrier.labware[params.position];
    if (!labware) return { success: false, stepType: "Clear", commands: [], error: `No labware at ${params.carrierId}:${params.position}`, assessments: [] };

    const wellIndices = this.resolveTargetIndices(
      labware, params.target ?? "all", params.columns, params.rows, params.wellIndices,
    );
    if (wellIndices.length === 0) {
      return { success: false, stepType: "Clear", commands: [], error: "Target resolved to zero wells", assessments: [] };
    }

    const tracker = this.twin.getDeckTracker();
    tracker.liquidTracker.clearWellRange(params.carrierId, params.position, wellIndices);
    for (const w of wellIndices) tracker.clearWellVolume(params.carrierId, params.position, w);

    return { success: true, stepType: "Clear", commands: [], assessments: [] };
  }

  /** Fill — environmental setup, NOT a FW command.
   *  Pre-populates wells with a liquid so serial dilutions etc. have realistic
   *  starting state (sample in col 1, diluent in cols 2–12, buffer in a trough).
   *  Idempotent: re-calling with the same target overwrites the contents. */
  fill(params: FillParams): StepResult {
    if (!params.carrierId) {
      return { success: false, stepType: "Fill", commands: [], error: "Missing carrierId", assessments: [] };
    }
    if (!params.liquidType) {
      return { success: false, stepType: "Fill", commands: [], error: "Missing liquidType", assessments: [] };
    }
    if (params.volume == null || params.volume <= 0) {
      return { success: false, stepType: "Fill", commands: [], error: "Volume must be > 0 µL", assessments: [] };
    }

    const deck = this.twin.getDeck();
    const carrier = deck.getCarrier(params.carrierId);
    if (!carrier) return { success: false, stepType: "Fill", commands: [], error: `Carrier ${params.carrierId} not found`, assessments: [] };
    const labware = carrier.labware[params.position];
    if (!labware) return { success: false, stepType: "Fill", commands: [], error: `No labware at ${params.carrierId}:${params.position}`, assessments: [] };

    const wellIndices = this.resolveTargetIndices(
      labware, params.target ?? "all", params.columns, params.rows, params.wellIndices,
    );
    if (wellIndices.length === 0) {
      return { success: false, stepType: "Fill", commands: [], error: "Target resolved to zero wells", assessments: [] };
    }

    // Volume convention: params.volume is µL, tracker stores 0.1 µL.
    const volume_01ul = Math.round(params.volume * 10);
    const tracker = this.twin.getDeckTracker();
    // Additive: fillWellRange accumulates into components; add to wellVolume too.
    // Intent = "I pipetted `volume` µL of `liquid` into these wells", not
    // "set the total volume to this value" — matches real-world intuition.
    tracker.liquidTracker.fillWellRange(params.carrierId, params.position, labware.type, wellIndices, params.liquidType, volume_01ul, params.liquidClass ?? "default");
    for (const w of wellIndices) tracker.addWellVolume(params.carrierId, params.position, w, volume_01ul);

    // No FW commands — this step mutates tracker state only. The success
    // result still carries through so the protocol editor marks it green.
    return { success: true, stepType: "Fill", commands: [], assessments: [] };
  }

  serialDilution(params: SerialDilutionParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];
    const startCol = params.startColumn ?? 0;
    const numDilutions = params.numDilutions ?? 11;
    const mask = params.channelMask ?? 255;
    const mixVol = params.mixVolume ?? params.volume;
    const mixCyc = params.mixCycles ?? 3;

    // Pre-check: destination columns must already contain diluent for a real
    // serial dilution. If not, the tracker's volume math looks "fine" after the
    // first iteration (liquid just shuttles column-to-column), but the physical
    // outcome is wrong (no actual dilution). Flag every empty destination so the
    // operator sees each affected column in the events panel, not just the
    // single underflow at the source.
    const tracker = this.twin.getDeckTracker();
    const store = this.twin.getAssessmentStore();
    // Count active channels in the mask (e.g. 255 → 8 rows).
    let rows = 0;
    for (let b = 0; b < 16; b++) if (mask & (1 << b)) rows++;
    if (rows === 0) rows = 8;
    for (let d = 0; d < numDilutions; d++) {
      const dstCol = startCol + d + 1;
      let emptyRowsCount = 0;
      for (let r = 0; r < rows; r++) {
        const wellIdx = r * 12 + dstCol;
        const v = tracker.getWellVolume?.(params.plateCarrier, params.platePosition, wellIdx);
        if (!v || v <= 0) emptyRowsCount++;
      }
      if (emptyRowsCount > 0) {
        const ev = store.add({
          category: "missing_diluent",
          severity: "warning",
          module: "pip",
          command: "SerialDilution",
          description: `Destination column ${dstCol + 1} has ${emptyRowsCount} empty well(s) — no diluent; dilution factor at this column will be incorrect`,
          data: {
            plateCarrier: params.plateCarrier,
            platePosition: params.platePosition,
            dstColumn: dstCol,
            emptyRows: emptyRowsCount,
            expectedVolume_01ul: params.volume,
          },
        });
        allAssessments.push(ev);
      }
    }

    for (let d = 0; d < numDilutions; d++) {
      const srcCol = startCol + d;
      const dstCol = startCol + d + 1;

      // Step 1: Pick up fresh tips (prevents carryover between dilutions)
      const pickup = this.tipPickUp({
        position: { carrierId: params.tipCarrier, position: params.tipPosition, column: srcCol },
        channelMask: mask,
      });
      allCommands.push(...pickup.commands);
      allAssessments.push(...pickup.assessments);
      if (!pickup.success) {
        return { success: false, stepType: "SerialDilution", commands: allCommands, error: `Tip pickup dilution ${d}: ${pickup.error}`, assessments: allAssessments };
      }

      // Step 2: Aspirate from source column WITH mixing (homogenize before transfer)
      const asp = this.aspirate({
        position: { carrierId: params.plateCarrier, position: params.platePosition, column: srcCol },
        volume: params.volume,
        channelMask: mask,
        liquidClass: params.liquidClass,
        mixCycles: mixCyc,
        mixVolume: mixVol,
      });
      allCommands.push(...asp.commands);
      allAssessments.push(...asp.assessments);
      if (!asp.success) {
        return { success: false, stepType: "SerialDilution", commands: allCommands, error: `Aspirate dilution ${d}: ${asp.error}`, assessments: allAssessments };
      }

      // Step 3: Dispense to next column WITH mixing (homogenize after transfer)
      const disp = this.dispense({
        position: { carrierId: params.plateCarrier, position: params.platePosition, column: dstCol },
        volume: params.volume,
        channelMask: mask,
      });
      allCommands.push(...disp.commands);
      allAssessments.push(...disp.assessments);
      if (!disp.success) {
        return { success: false, stepType: "SerialDilution", commands: allCommands, error: `Dispense dilution ${d}: ${disp.error}`, assessments: allAssessments };
      }

      // Eject tips
      const eject = this.tipEject({ channelMask: mask });
      allCommands.push(...eject.commands);
      allAssessments.push(...eject.assessments);
      if (!eject.success) {
        return { success: false, stepType: "SerialDilution", commands: allCommands, error: `Tip eject dilution ${d}: ${eject.error}`, assessments: allAssessments };
      }
    }

    return { success: true, stepType: "SerialDilution", commands: allCommands, assessments: allAssessments };
  }

  /** AliquotDispense — 1 aspirate → N partial jet dispenses.
   *  VENUS aliquot pattern: aspirate (N*vol + rest), then dispense N times
   *  with dm=2 (surface partial), ejecting tips with rest volume to waste.
   *  Uses HighVolume_Water_AliquotDispenseJet_Part liquid class by default. */
  aliquotDispense(params: AliquotDispenseParams): StepResult {
    const allCommands: Array<{ raw: string; result: CommandResult }> = [];
    const allAssessments: AssessmentEvent[] = [];
    const mask = params.channelMask ?? 255;
    const dispenseCount = params.destPositions.length;
    const dispenseVol = params.dispenseVolume;
    const restVol = params.restVolume ?? Math.round(dispenseVol * 0.05 * 10) / 10; // Default 5% of dispense vol
    const totalAspVol = dispenseVol * dispenseCount + restVol;
    const lc = params.liquidClass ?? "HighVolume_Water_AliquotDispenseJet_Part";

    // Step 1: Pick up tips
    const pickup = this.tipPickUp({ position: params.tipPosition, channelMask: mask, tipType: params.tipType });
    allCommands.push(...pickup.commands);
    allAssessments.push(...pickup.assessments);
    if (!pickup.success) {
      return { success: false, stepType: "AliquotDispense", commands: allCommands, error: `TipPickUp failed: ${pickup.error}`, assessments: allAssessments };
    }

    // Step 2: Aspirate total volume (N * dispenseVol + restVol)
    const asp = this.aspirate({
      position: params.sourcePosition,
      volume: totalAspVol,
      channelMask: mask,
      liquidClass: lc,
    });
    allCommands.push(...asp.commands);
    allAssessments.push(...asp.assessments);
    if (!asp.success) {
      return { success: false, stepType: "AliquotDispense", commands: allCommands, error: `Aspirate failed: ${asp.error}`, assessments: allAssessments };
    }

    // Step 3: Dispense N times with dm=2 (surface partial)
    for (let i = 0; i < dispenseCount; i++) {
      const isLast = (i === dispenseCount - 1);
      const disp = this.dispense({
        position: params.destPositions[i],
        volume: dispenseVol,
        channelMask: mask,
        dispenseMode: isLast ? 0 : 2,  // dm=2 for intermediate, dm=0 for last (jet empty of dispense vol)
        liquidClass: lc,
      });
      allCommands.push(...disp.commands);
      allAssessments.push(...disp.assessments);
      if (!disp.success) {
        return { success: false, stepType: "AliquotDispense", commands: allCommands, error: `Dispense ${i + 1}/${dispenseCount} failed: ${disp.error}`, assessments: allAssessments };
      }
    }

    // Step 4: Eject tips (rest volume goes to waste with the tip)
    const eject = this.tipEject({ channelMask: mask });
    allCommands.push(...eject.commands);
    allAssessments.push(...eject.assessments);

    return {
      success: true,
      stepType: "AliquotDispense",
      commands: allCommands,
      assessments: allAssessments,
    };
  }

  // ── Step dispatch (JSON API) ──────────────────────────────────────────

  /**
   * Execute a step from a JSON request.
   * This is the main entry point for the HTTP /step endpoint.
   */
  executeStep(stepType: string, params: Record<string, any>): StepResult {
    // Allocate a stepId for this composite execution. Every sendCommand
    // issued by the sub-methods below will stamp events with this id.
    const stepId = this.twin.nextStepId();
    const previousStepId = this.currentStepId;
    this.currentStepId = stepId;
    try {
      return this.dispatchStep(stepType, params);
    } finally {
      this.currentStepId = previousStepId;
    }
  }

  private dispatchStep(stepType: string, params: Record<string, any>): StepResult {
    switch (stepType) {
      case "tipPickUp":
        return this.tipPickUp(params as TipPickUpParams);
      case "tipEject":
        return this.tipEject(params as TipEjectParams);
      case "aspirate":
        return this.aspirate(params as AspirateParams);
      case "dispense":
        return this.dispense(params as DispenseParams);
      case "movePIP":
        return this.movePIP(params as MovePIPParams);
      case "head96Move":
        return this.head96Move(params as Head96MoveParams);
      case "head96TipPickUp":
        return this.head96TipPickUp(params as Head96TipPickUpParams);
      case "head96Aspirate":
        return this.head96Aspirate(params as Head96AspirateParams);
      case "head96Dispense":
        return this.head96Dispense(params as Head96DispenseParams);
      case "head96TipEject":
        return this.head96TipEject(params as Head96TipEjectParams);
      case "setTemperature":
        return this.setTemperature(params as SetTemperatureParams);
      case "wash":
        return this.wash(params as WashParams);
      case "easyAspirate":
        return this.easyAspirate(params as EasyAspirateParams);
      case "easyDispense":
        return this.easyDispense(params as EasyDispenseParams);
      case "easyTransfer":
        return this.easyTransfer(params as EasyTransferParams);
      case "easy96Aspirate":
        return this.easy96Aspirate(params as Easy96AspirateParams);
      case "easy96Dispense":
        return this.easy96Dispense(params as Easy96DispenseParams);
      case "getPlate":
        return this.getPlate(params as GetPlateParams);
      case "putPlate":
        return this.putPlate(params as PutPlateParams);
      case "movePlate":
        return this.movePlate(params as MovePlateParams);
      case "gripperGetTool":
        return this.gripperGetTool(params as GripperGetToolParams);
      case "gripperGripPlate":
        return this.gripperGripPlate(params as GripperGripPlateParams);
      case "gripperRelease":
        return this.gripperRelease(params as GripperReleaseParams);
      case "gripperDiscardTool":
        return this.gripperDiscardTool(params as GripperDiscardToolParams);
      case "dispenseFly":
        return this.dispenseFly(params as DispenseFlyParams);
      case "easyTransport":
        return this.easyTransport(params as EasyTransportParams);
      case "transferSamples":
        return this.transferSamples(params as TransferSamplesParams);
      case "addReagent":
        return this.addReagent(params as AddReagentParams);
      case "serialDilution":
        return this.serialDilution(params as SerialDilutionParams);
      case "aliquotDispense":
        return this.aliquotDispense(params as AliquotDispenseParams);
      case "loadCarrier":
        return this.loadCarrier(params as LoadCarrierParams);
      case "fill":
        return this.fill(params as FillParams);
      case "clear":
        return this.clear(params as ClearParams);
      default:
        return {
          success: false,
          stepType: stepType,
          commands: [],
          error: `Unknown step type: ${stepType}`,
          assessments: [],
        };
    }
  }

  /**
   * Decompose a composite step into its constituent single steps.
   * Returns an array of { type, params } that can be executed individually
   * for slow/step-through execution. Single steps return themselves.
   */
  static decomposeStep(stepType: string, params: Record<string, any>): Array<{ type: string; params: Record<string, any>; label: string }> {
    const mask = params.channelMask ?? params.channelMask ?? 255;
    switch (stepType) {
      case "easyAspirate":
        return [
          { type: "tipPickUp", label: "Tip Pick Up", params: { position: params.tipPosition, channelMask: mask, tipType: params.tipType } },
          { type: "aspirate", label: "Aspirate", params: { position: params.aspiratePosition, volume: params.volume, channelMask: mask, liquidClass: params.liquidClass, lldMode: params.lldMode, mixCycles: params.mixCycles, mixVolume: params.mixVolume } },
        ];
      case "easyDispense":
        return [
          { type: "dispense", label: "Dispense", params: { position: params.dispensePosition, volume: params.volume, channelMask: mask, dispenseMode: params.dispenseMode, liquidClass: params.liquidClass } },
          { type: "tipEject", label: "Tip Eject", params: { channelMask: mask } },
        ];
      case "easyTransfer":
        return [
          { type: "tipPickUp", label: "Tip Pick Up", params: { position: params.tipPosition, channelMask: mask, tipType: params.tipType } },
          { type: "aspirate", label: "Aspirate", params: { position: params.sourcePosition, volume: params.volume, channelMask: mask, liquidClass: params.liquidClass, lldMode: params.lldMode } },
          { type: "dispense", label: "Dispense", params: { position: params.destPosition, volume: params.volume, channelMask: mask, dispenseMode: params.dispenseMode } },
          { type: "tipEject", label: "Tip Eject", params: { channelMask: mask } },
        ];
      case "easyTransport":
        return [
          { type: "getPlate", label: "iSWAP Get", params: { position: params.sourcePosition, gripWidth: params.gripWidth, openWidth: params.openWidth } },
          { type: "putPlate", label: "iSWAP Put", params: { position: params.destPosition, openWidth: params.openWidth } },
        ];
      case "easy96Aspirate":
        return [
          { type: "head96Move", label: "96-Head Move (tips)", params: { position: params.tipPosition } },
          { type: "head96TipPickUp", label: "96-Head Tip Pick Up", params: { position: params.tipPosition } },
          { type: "head96Move", label: "96-Head Move (plate)", params: { position: params.aspiratePosition } },
          { type: "head96Aspirate", label: "96-Head Aspirate", params: { volume: params.volume } },
        ];
      case "easy96Dispense":
        return [
          { type: "head96Dispense", label: "96-Head Dispense", params: { volume: params.volume, dispenseMode: params.dispenseMode } },
          { type: "head96Move", label: "96-Head Move (eject)", params: { position: params.ejectPosition } },
          { type: "head96TipEject", label: "96-Head Tip Eject", params: {} },
        ];
      case "transferSamples": {
        const cols = params.columns ?? 12;
        const startCol = params.startColumn ?? 0;
        const subSteps: Array<{ type: string; params: Record<string, any>; label: string }> = [];
        for (let c = startCol; c < startCol + cols; c++) {
          subSteps.push(
            { type: "tipPickUp", label: `Tip Pick Up (col ${c})`, params: { position: { carrierId: params.tipCarrier, position: params.tipPosition, column: c }, channelMask: mask, tipType: params.tipType } },
            { type: "aspirate", label: `Aspirate (col ${c})`, params: { position: { carrierId: params.sourceCarrier, position: params.sourcePosition, column: c }, volume: params.volume, channelMask: mask, liquidClass: params.liquidClass } },
            { type: "dispense", label: `Dispense (col ${c})`, params: { position: { carrierId: params.destCarrier, position: params.destPosition, column: c }, volume: params.volume, channelMask: mask } },
            { type: "tipEject", label: `Tip Eject (col ${c})`, params: { channelMask: mask } },
          );
        }
        return subSteps;
      }
      case "addReagent": {
        const cols = params.columns ?? 12;
        const startCol = params.startColumn ?? 0;
        const subSteps: Array<{ type: string; params: Record<string, any>; label: string }> = [];
        for (let c = startCol; c < startCol + cols; c++) {
          subSteps.push(
            { type: "tipPickUp", label: `Tip Pick Up (col ${c})`, params: { position: { carrierId: params.tipCarrier, position: params.tipPosition, column: c }, channelMask: mask } },
            { type: "aspirate", label: `Aspirate from trough`, params: { position: { carrierId: params.reagentCarrier, position: params.reagentPosition, column: 0 }, volume: params.volume, channelMask: mask, liquidClass: params.liquidClass } },
            { type: "dispense", label: `Dispense (col ${c})`, params: { position: { carrierId: params.destCarrier, position: params.destPosition, column: c }, volume: params.volume, channelMask: mask } },
            { type: "tipEject", label: `Tip Eject (col ${c})`, params: { channelMask: mask } },
          );
        }
        return subSteps;
      }
      case "serialDilution": {
        const startCol = params.startColumn ?? 0;
        const numDil = params.numDilutions ?? 11;
        const subSteps: Array<{ type: string; params: Record<string, any>; label: string }> = [];
        for (let d = 0; d < numDil; d++) {
          subSteps.push(
            { type: "tipPickUp", label: `Tip (dil ${d + 1})`, params: { position: { carrierId: params.tipCarrier, position: params.tipPosition, column: startCol + d }, channelMask: mask } },
            { type: "aspirate", label: `Asp col ${startCol + d}`, params: { position: { carrierId: params.plateCarrier, position: params.platePosition, column: startCol + d }, volume: params.volume, channelMask: mask, liquidClass: params.liquidClass, mixCycles: params.mixCycles ?? 3, mixVolume: params.mixVolume ?? params.volume } },
            { type: "dispense", label: `Disp col ${startCol + d + 1}`, params: { position: { carrierId: params.plateCarrier, position: params.platePosition, column: startCol + d + 1 }, volume: params.volume, channelMask: mask } },
            { type: "tipEject", label: `Eject (dil ${d + 1})`, params: { channelMask: mask } },
          );
        }
        return subSteps;
      }
      case "aliquotDispense": {
        const dests = params.destPositions || [];
        const dispVol = params.dispenseVolume || 0;
        const restVol = params.restVolume ?? Math.round(dispVol * 0.05 * 10) / 10;
        const totalAsp = dispVol * dests.length + restVol;
        const aliquotLc = params.liquidClass || "HighVolume_Water_AliquotDispenseJet_Part";
        const subSteps: Array<{ type: string; params: Record<string, any>; label: string }> = [
          { type: "tipPickUp", label: "Tip Pick Up", params: { position: params.tipPosition, channelMask: mask, tipType: params.tipType } },
          { type: "aspirate", label: `Aspirate ${totalAsp}µL (${dests.length}×${dispVol}+${restVol}rest)`, params: { position: params.sourcePosition, volume: totalAsp, channelMask: mask, liquidClass: aliquotLc } },
        ];
        for (let i = 0; i < dests.length; i++) {
          const isLast = i === dests.length - 1;
          subSteps.push({
            type: "dispense",
            label: `Aliquot ${i + 1}/${dests.length} (${dispVol}µL, dm=${isLast ? 0 : 2})`,
            params: { position: dests[i], volume: dispVol, channelMask: mask, dispenseMode: isLast ? 0 : 2, liquidClass: aliquotLc },
          });
        }
        subSteps.push({ type: "tipEject", label: `Eject tips (${restVol}µL rest to waste)`, params: { channelMask: mask } });
        return subSteps;
      }
      default:
        // Single step — returns itself
        return [{ type: stepType, label: stepType, params }];
    }
  }

  /** List all supported step types */
  static listStepTypes(): string[] {
    return [
      // VENUS Single Steps — 1:1 with FW commands (from AtsMc*.cpp)
      "tipPickUp", "tipEject", "aspirate", "dispense", "dispenseFly", "movePIP",
      "head96Move", "head96TipPickUp", "head96Aspirate", "head96Dispense", "head96TipEject",
      "getPlate", "putPlate", "movePlate",
      "gripperGetTool", "gripperGripPlate", "gripperRelease", "gripperDiscardTool",
      "setTemperature", "wash",
      // VENUS Easy Steps — composite (from CommandEasyRunBase.cpp)
      "easyAspirate", "easyDispense", "easyTransfer", "easyTransport",
      "easy96Aspirate", "easy96Dispense",
      // Custom Power Steps — convenience workflows (NOT built-in VENUS steps)
      // VENUS has no power steps; users program these manually with HSL scripts.
      "transferSamples", "addReagent", "serialDilution", "aliquotDispense",
      "fill", "clear",
      // System steps
      "loadCarrier",
    ];
  }
}
