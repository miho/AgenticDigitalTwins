/**
 * Deck Tracker
 *
 * Resolves FW command coordinates to deck objects and tracks
 * the physical effect of commands on the deck state.
 *
 * The firmware doesn't know about labware — it just moves to
 * coordinates. This tracker adds simulation intelligence by
 * understanding what's at each position on the deck.
 *
 * Design principle: commands ALWAYS execute (like real FW).
 * Deck tracking is best-effort. If coordinates don't match
 * any known deck object, the command still succeeds but we
 * can't track the physical effect.
 */

import { Deck, WellAddress, DeckPosition, LabwareItem, Carrier, Y_FRONT_EDGE, POSITION_FALLBACK_Y_REAR } from "./deck";
import { LiquidTracker, LiquidContents, ChannelState, TransferResult, ContaminationEvent } from "./liquid-tracker";
import { getWellGeometry, volumeToHeight, WellGeometry } from "./well-geometry";

/** Tolerance for coordinate matching (0.1mm) */
const POSITION_TOLERANCE = 50;  // 5mm tolerance

/** PIP channel Y spacing in 0.1mm (9mm between channels) */
const CHANNEL_Y_PITCH = 90;

/** Result of resolving a coordinate to a deck object */
export interface DeckResolution {
  matched: boolean;
  carrierId?: string;
  carrierType?: string;
  position?: number;        // Carrier position (0-based)
  labwareType?: string;
  row?: number;             // Well row (0-based)
  column?: number;          // Well column (0-based)
  wellIndex?: number;       // Linear well index
  description: string;      // Human-readable: "plate SMP001 pos 0, well A1"
}

/** A tracked deck interaction */
export interface DeckInteraction {
  timestamp: number;
  command: string;          // FW command code (C0AS, C0TP, etc.)
  x: number;               // Command X coordinate (0.1mm)
  y: number;               // Command Y coordinate (0.1mm)
  resolution: DeckResolution;
  effect?: string;          // What happened: "aspirated 100ul from well A1"
  /** ID of the command that produced this interaction (Step 1.9). */
  correlationId?: number;
  /** ID of the composite step that contains the command (Step 1.9). */
  stepId?: number;
}

/**
 * Tracks the effect of FW commands on the deck.
 *
 * Call `processCommand` after each FW command to resolve
 * coordinates and update deck state (well volumes, tip usage, etc.).
 */
/** An interaction that couldn't be fully resolved to a deck object */
export interface UnresolvedInteraction {
  timestamp: number;
  command: string;
  x: number;
  y: number;
  reason: string;        // Why it's unresolved
  resolution: DeckResolution;
}

export class DeckTracker {
  private deck: Deck;
  private interactions: DeckInteraction[] = [];
  private unresolvedInteractions: UnresolvedInteraction[] = [];

  /** Track tip usage: carrier+position+wellIndex -> used (true/false) */
  private tipUsage: Map<string, boolean> = new Map();

  /** Track well volumes: carrier+position+wellIndex -> volume (0.1ul) */
  private wellVolumes: Map<string, number> = new Map();

  /** Per-well aspirate underflow trace, keyed by wellKey. Populated by the
   *  C0AS / C0EA / C0JA processing when actualVolume < requestedVolume; read
   *  by physics plugins in their assess() pass to emit `volume_underflow`
   *  events. Cleared on reset. */
  private lastUnderflow: Map<string, { requested: number; actual: number; deficit: number; available: number }> = new Map();

  /** Per-well dispense-with-air trace, keyed by wellKey. Populated by the
   *  C0DS processing when the channel pushed trailing air into the well
   *  before reaching the liquid. Read by pip-physics.assess to emit an
   *  `air_in_dispense` event. Cleared on reset. */
  private lastAirDispense: Map<string, { requested: number; liquid: number; air: number }> = new Map();

  /** Liquid identity tracker */
  readonly liquidTracker: LiquidTracker;

  /** Currently gripped labware (for plate transport) */
  private grippedLabware: LabwareItem | null = null;
  private grippedFrom: { carrierId: string; position: number } | null = null;

  constructor(deck: Deck) {
    this.deck = deck;
    this.liquidTracker = new LiquidTracker();
  }

  /**
   * Process a FW command and track its effect on the deck.
   *
   * @param event - FW event code (C0AS, C0TP, etc.)
   * @param params - Parsed command parameters
   * @returns The deck resolution (what was at the coordinates)
   */
  processCommand(event: string, params: Record<string, unknown>): DeckInteraction {
    const x = (params.xp as number) ?? (params.xs as number) ?? 0;
    const y = (params.yp as number) ?? (params.yh as number) ?? (params.yj as number) ?? 0;
    const tipMask = (params.tm as number) ?? 0;
    // Per-channel Y positions from arrayParams (independent Y-drives)
    const ypArray = params._yp_array as number[] | undefined;

    // Determine active channels from tip mask
    const activeChannels = this.expandTipMask(tipMask);

    const resolution = this.resolvePosition(x, y);
    let effect: string | undefined;

    switch (event) {
      case "C0TP": {
        // Tip pickup: each active channel picks up from its own Y position
        // Channel 0 at base Y, channel 1 at Y + 90, etc.
        const count = activeChannels.length || 1;
        let tipsPickedUp = 0;
        for (const ch of (activeChannels.length > 0 ? activeChannels : [0])) {
          const chY = ypArray && ypArray[ch] !== undefined ? ypArray[ch] : y - ch * CHANNEL_Y_PITCH;
          const chRes = this.resolvePosition(x, chY);
          if (chRes.matched && chRes.labwareType?.includes("Tip")) {
            this.tipUsage.set(this.wellKey(chRes), true);
            tipsPickedUp++;
            // Notify liquid tracker of tip pickup
            const tipMaxVol = chRes.labwareType?.includes("1000") ? 10000
              : chRes.labwareType?.includes("300") ? 3000
              : chRes.labwareType?.includes("50") ? 500 : 10000;
            this.liquidTracker.tipPickup(ch, chRes.labwareType || "Tips_1000uL", tipMaxVol);
          }
        }
        effect = `${tipsPickedUp} tip(s) picked up from ${resolution.carrierType || "deck"}[${resolution.carrierId || "?"}] (${count} ch)`;
        break;
      }

      case "C0AS": {
        // Aspirate: each active channel aspirates from its own Y position.
        //
        // The liquid tracker is the authority on *actual* volume moved (it
        // respects dead volume + tip capacity). We delegate the volume update
        // to it and then MIRROR the resulting well volume back into
        // `wellVolumes`, so the two books stay in sync.
        const vol = (params.av as number) || 0;
        const channels = activeChannels.length > 0 ? activeChannels : [0];
        let wellCount = 0;
        const transferResults: TransferResult[] = [];
        let totalActual = 0;
        for (const ch of channels) {
          const chY = ypArray && ypArray[ch] !== undefined ? ypArray[ch] : y - ch * CHANNEL_Y_PITCH;
          const chRes = this.resolvePosition(x, chY);
          if (chRes.matched && vol > 0) {
            const key = this.wellKey(chRes);
            const pre = this.wellVolumes.get(key) ?? 0;
            const result = this.liquidTracker.aspirate(ch, key, vol, chRes.description);
            // Pin wellVolumes to the liquid-tracker's remaining volume so
            // Σ components always equals the stored volume.
            this.wellVolumes.set(key, result.remainingVolume);
            const liquidActual = result.liquidActual ?? result.actualVolume;
            if (liquidActual < vol) {
              this.lastUnderflow.set(key, {
                requested: vol,
                actual: liquidActual,
                deficit: vol - liquidActual,
                available: Math.max(0, pre),
              });
            } else {
              this.lastUnderflow.delete(key);
            }
            wellCount++;
            transferResults.push(result);
            totalActual += liquidActual;
          }
        }
        // ALWAYS emit a log — silent aspirates were the root of the
        // "arm moved but volume didn't change and no feedback" bug.
        // Now we surface: requested volume, actual volume transferred,
        // how many wells were touched, AND coordinates when nothing
        // resolved so the user can compare against the plate position.
        const firstRes = this.resolvePosition(x, ypArray && ypArray[channels[0]] !== undefined ? ypArray[channels[0]] : y - (channels[0] || 0) * CHANNEL_Y_PITCH);
        const contaminations = transferResults.filter(r => r.contamination).length;
        if (vol <= 0) {
          effect = `aspirate NO-OP: av=${vol} at (${(x/10).toFixed(1)}, ${(y/10).toFixed(1)}) mm — command carried zero volume`;
        } else if (wellCount === 0) {
          effect = `aspirate UNMATCHED: ${vol/10}uL requested at (${(x/10).toFixed(1)}, ${(y/10).toFixed(1)}) mm → no labware under cursor — volume NOT tracked`;
        } else {
          effect = `aspirated ${(totalActual / 10).toFixed(1)}uL (requested ${vol / 10}uL) from ${wellCount} well(s) at ${firstRes.carrierType || "deck"}[${firstRes.carrierId || "?"}]`;
          if (contaminations > 0) effect += ` [${contaminations} contamination warning(s)]`;
        }
        break;
      }

      case "C0DS": {
        // Dispense — delegate to liquid tracker and mirror the resulting well
        // volume back. Keeps wellVolumes == Σ components at all times.
        const vol = (params.dv as number) || 0;
        const channels = activeChannels.length > 0 ? activeChannels : [0];
        let wellCount = 0;
        let totalLiquid = 0;
        let totalAir = 0;
        for (const ch of channels) {
          const chY = ypArray && ypArray[ch] !== undefined ? ypArray[ch] : y - ch * CHANNEL_Y_PITCH;
          const chRes = this.resolvePosition(x, chY);
          if (chRes.matched && vol > 0) {
            const key = this.wellKey(chRes);
            const result = this.liquidTracker.dispense(ch, key, vol, chRes.description);
            this.wellVolumes.set(key, result.remainingVolume);
            wellCount++;
            const liq = result.liquidActual ?? result.actualVolume;
            const air = result.airActual ?? 0;
            totalLiquid += liq;
            totalAir += air;
            // Record air-in-dispense so pip-physics.assess can emit an event.
            if (air > 0) {
              this.lastAirDispense.set(key, { requested: vol, liquid: liq, air });
            } else {
              this.lastAirDispense.delete(key);
            }
          }
        }
        const firstRes = this.resolvePosition(x, ypArray && ypArray[channels[0]] !== undefined ? ypArray[channels[0]] : y - (channels[0] || 0) * CHANNEL_Y_PITCH);
        // ALWAYS log — same reasoning as C0AS. Silent dispenses were
        // the exact path that produced "arm moved, TADM says pass,
        // inspector unchanged, no hint why".
        if (vol <= 0) {
          effect = `dispense NO-OP: dv=${vol} at (${(x/10).toFixed(1)}, ${(y/10).toFixed(1)}) mm — command carried zero volume`;
        } else if (wellCount === 0) {
          effect = `dispense UNMATCHED: ${vol/10}uL requested at (${(x/10).toFixed(1)}, ${(y/10).toFixed(1)}) mm → no labware under cursor — volume NOT tracked`;
        } else {
          const airNote = totalAir > 0 ? ` [${(totalAir / 10).toFixed(1)}uL air first]` : "";
          effect = `dispensed ${(totalLiquid / 10).toFixed(1)}uL liquid (requested ${vol / 10}uL) to ${wellCount} well(s) at ${firstRes.carrierType || "deck"}[${firstRes.carrierId || "?"}]${airNote}`;
        }
        break;
      }

      case "C0TR": {
        // Route the eject by actual xp/yp — user may target the waste chute,
        // a tip rack (returns tips), or any other deck location (off-deck).
        // Previously this always incremented tipWaste regardless of where the
        // head was, which made "eject over tip rack" behave like waste.
        //
        // A C0TR with no xp/yp (the Hamilton "eject to default waste" form —
        // AtsMcEjectTip without explicit coords) routes to waste unconditionally.
        const channels = this.expandTipMask(tipMask);
        const ejectedCount = channels.length || 1;

        // Liquid tracker always notified — tip state clears on every eject.
        for (const ch of (channels.length > 0 ? channels : [0])) {
          this.liquidTracker.tipEject(ch);
        }

        // Waste xy bounds, from deck geometry.
        const wasteXMin = this.deck.trackToX(this.deck.tipWaste.track) - 225 / 2;
        const wasteXMax = this.deck.trackToX(this.deck.tipWaste.track + this.deck.tipWaste.widthTracks - 1) + 225 / 2;
        const wasteY = this.deck.getTipWasteYRange();
        const noExplicitTarget = params.xp === undefined && params.yp === undefined;
        const overWaste = noExplicitTarget
          || (x >= wasteXMin && x <= wasteXMax && y >= wasteY.yMin && y <= wasteY.yMax);

        if (overWaste) {
          this.deck.tipWaste.tipCount += ejectedCount;
          effect = `${ejectedCount} tips ejected to waste (total: ${this.deck.tipWaste.tipCount}/${this.deck.tipWaste.capacity})`;
        } else {
          // Per-channel: check each channel's Y against its resolved labware.
          // If over a tip rack well, return the tip (unmark tipUsage). Any
          // channel landing elsewhere just drops — we don't model off-deck
          // bounce physics, the tip is simply gone from the channel.
          let returnedCount = 0;
          let droppedCount = 0;
          let firstRack: string | undefined;
          for (const ch of (channels.length > 0 ? channels : [0])) {
            const chY = ypArray && ypArray[ch] !== undefined ? ypArray[ch] : y - ch * CHANNEL_Y_PITCH;
            const chRes = this.resolvePosition(x, chY);
            if (chRes.matched && chRes.labwareType?.includes("Tip")) {
              const key = this.wellKey(chRes);
              this.tipUsage.set(key, false);
              returnedCount++;
              if (!firstRack) firstRack = `${chRes.carrierType || "tip rack"}[${chRes.carrierId}]`;
            } else {
              droppedCount++;
            }
          }
          if (returnedCount > 0 && droppedCount === 0) {
            effect = `${returnedCount} tips returned to ${firstRack}`;
          } else if (returnedCount > 0) {
            effect = `${returnedCount} tips returned to ${firstRack}, ${droppedCount} dropped off-deck`;
          } else {
            effect = `${ejectedCount} tips dropped off-deck at (${(x / 10).toFixed(1)}, ${(y / 10).toFixed(1)}) mm`;
          }
        }
        break;
      }

      // ==== 96-Head block operations ====
      case "C0EP": {
        // 96-head tip pickup: all 96 tips from A1 position of a tip rack
        if (resolution.matched && resolution.labwareType?.includes("Tip")) {
          let tipsPickedUp = 0;
          // Mark all 96 wells as used (8 rows x 12 cols)
          for (let i = 0; i < 96; i++) {
            const key = `${resolution.carrierId}:${resolution.position}:${i}`;
            this.tipUsage.set(key, true);
            tipsPickedUp++;
          }
          effect = `96-head: ${tipsPickedUp} tips picked up from ${resolution.description}`;
        }
        break;
      }

      case "C0ER": {
        // 96-head tip eject
        effect = `96-head: tips ejected`;
        break;
      }

      case "C0EA": {
        // 96-head aspirate: all 96 channels aspirate simultaneously
        const vol = (params.af as number) || 0;
        if (vol > 0 && resolution.matched) {
          let wellCount = 0;
          // 96-head covers all wells of a 96-well plate (or first 96 of a 384)
          const carrier = this.deck.getCarrier(resolution.carrierId!);
          const labware = carrier?.labware[resolution.position!];
          const wells = labware ? Math.min(96, labware.wellCount) : 96;
          for (let i = 0; i < wells; i++) {
            const key = `${resolution.carrierId}:${resolution.position}:${i}`;
            const current = this.wellVolumes.get(key) ?? 0;
            this.wellVolumes.set(key, current - vol);
            wellCount++;
          }
          effect = `96-head: aspirated ${vol / 10}uL from ${wellCount} wells at ${resolution.description}`;
        }
        break;
      }

      case "C0ED": {
        // 96-head dispense: all 96 channels dispense simultaneously
        const vol = (params.df as number) || 0;
        if (vol > 0 && resolution.matched) {
          let wellCount = 0;
          const carrier = this.deck.getCarrier(resolution.carrierId!);
          const labware = carrier?.labware[resolution.position!];
          const wells = labware ? Math.min(96, labware.wellCount) : 96;
          for (let i = 0; i < wells; i++) {
            const key = `${resolution.carrierId}:${resolution.position}:${i}`;
            const current = this.wellVolumes.get(key) ?? 0;
            this.wellVolumes.set(key, current + vol);
            wellCount++;
          }
          effect = `96-head: dispensed ${vol / 10}uL to ${wellCount} wells at ${resolution.description}`;
        }
        break;
      }

      // ==== 384-Head block operations ====
      case "C0JB": {
        // 384-head tip pickup: all 384 tips
        if (resolution.matched && resolution.labwareType?.includes("Tip")) {
          for (let i = 0; i < 384; i++) {
            const key = `${resolution.carrierId}:${resolution.position}:${i}`;
            this.tipUsage.set(key, true);
          }
          effect = `384-head: 384 tips picked up from ${resolution.description}`;
        }
        break;
      }

      case "C0JC": {
        // 384-head tip eject
        effect = `384-head: tips ejected`;
        break;
      }

      case "C0JA": {
        // 384-head aspirate
        const vol = (params.af as number) || 0;
        if (vol > 0 && resolution.matched) {
          let wellCount = 0;
          const carrier = this.deck.getCarrier(resolution.carrierId!);
          const labware = carrier?.labware[resolution.position!];
          const wells = labware ? Math.min(384, labware.wellCount) : 384;
          for (let i = 0; i < wells; i++) {
            const key = `${resolution.carrierId}:${resolution.position}:${i}`;
            const current = this.wellVolumes.get(key) ?? 0;
            this.wellVolumes.set(key, current - vol);
            wellCount++;
          }
          effect = `384-head: aspirated ${vol / 10}uL from ${wellCount} wells at ${resolution.description}`;
        }
        break;
      }

      case "C0JD": {
        // 384-head dispense
        const vol = (params.df as number) || 0;
        if (vol > 0 && resolution.matched) {
          let wellCount = 0;
          const carrier = this.deck.getCarrier(resolution.carrierId!);
          const labware = carrier?.labware[resolution.position!];
          const wells = labware ? Math.min(384, labware.wellCount) : 384;
          for (let i = 0; i < wells; i++) {
            const key = `${resolution.carrierId}:${resolution.position}:${i}`;
            const current = this.wellVolumes.get(key) ?? 0;
            this.wellVolumes.set(key, current + vol);
            wellCount++;
          }
          effect = `384-head: dispensed ${vol / 10}uL to ${wellCount} wells at ${resolution.description}`;
        }
        break;
      }

      // ==== Plate transport ====
      case "C0PP":
      case "C0ZP": {
        // iSWAP or CO-RE Gripper: pick up plate
        if (resolution.matched && resolution.carrierId && resolution.position !== undefined) {
          const removed = this.deck.removeLabware(resolution.carrierId, resolution.position);
          if (removed) {
            this.grippedLabware = removed;
            this.grippedFrom = { carrierId: resolution.carrierId, position: resolution.position };
            effect = `plate picked up from ${resolution.description} (${removed.type})`;
          } else {
            effect = `plate pickup at ${resolution.description} — no labware found`;
          }
        }
        break;
      }

      case "C0PR":
      case "C0ZR": {
        // iSWAP or CO-RE Gripper: place plate
        if (!this.grippedLabware) {
          effect = `plate place at ${resolution.description} — no plate gripped`;
          break;
        }
        // Try exact resolution first (placing onto existing labware — stacking)
        let targetCarrier = resolution.carrierId;
        let targetPosition = resolution.position;

        // If resolution didn't find a specific position (empty slot), infer from Y coordinate
        if (targetCarrier && targetPosition === undefined) {
          const carrier = this.deck.getCarrier(targetCarrier);
          if (carrier) {
            // Find closest position by Y coordinate, using site offsets if available.
            // Falls back to even-distribution using the heuristic Y-rear
            // (POSITION_FALLBACK_Y_REAR — NOT the physical Y_REAR_EDGE; see deck.ts).
            let bestPos = 0;
            let bestDist = Infinity;
            for (let p = 0; p < carrier.positions; p++) {
              let siteY: number;
              if (carrier.siteYOffsets && carrier.siteYOffsets[p] !== undefined) {
                siteY = Y_FRONT_EDGE + carrier.siteYOffsets[p] + 400; // approximate center of labware
              } else {
                const posPitch = (POSITION_FALLBACK_Y_REAR - Y_FRONT_EDGE) / carrier.positions;
                siteY = Y_FRONT_EDGE + p * posPitch + posPitch / 2;
              }
              const dist = Math.abs(y - siteY);
              if (dist < bestDist) { bestDist = dist; bestPos = p; }
            }
            targetPosition = bestPos;
          }
        }

        if (targetCarrier && targetPosition !== undefined) {
          this.deck.placeLabware(targetCarrier, targetPosition, this.grippedLabware);
          effect = `plate placed at ${targetCarrier} pos ${targetPosition} (${this.grippedLabware.type})`;
        } else {
          effect = `plate placed at ${resolution.description} (${this.grippedLabware.type})`;
        }
        this.grippedLabware = null;
        this.grippedFrom = null;
        break;
      }
    }

    const interaction: DeckInteraction = {
      timestamp: Date.now(),
      command: event,
      x,
      y,
      resolution,
      effect,
    };

    this.interactions.push(interaction);

    // Classify unresolved interactions (commands with coordinates that didn't match)
    const hasCoords = x > 0 || y > 0;
    const needsPosition = ["C0TP", "C0AS", "C0DS", "C0PP", "C0PR", "C0EA", "C0EP", "C0ED"].includes(event);
    if (hasCoords && needsPosition) {
      if (!resolution.matched) {
        this.unresolvedInteractions.push({
          timestamp: Date.now(), command: event, x, y,
          reason: `No deck object at X=${x / 10}mm Y=${y / 10}mm`,
          resolution,
        });
      } else if (event === "C0AS" && resolution.labwareType?.includes("Tip")) {
        this.unresolvedInteractions.push({
          timestamp: Date.now(), command: event, x, y,
          reason: `Aspirate targeting tip rack (${resolution.labwareType})`,
          resolution,
        });
      } else if (event === "C0DS" && resolution.labwareType?.includes("Tip")) {
        this.unresolvedInteractions.push({
          timestamp: Date.now(), command: event, x, y,
          reason: `Dispense targeting tip rack (${resolution.labwareType})`,
          resolution,
        });
      } else if (event === "C0TP" && resolution.matched && !resolution.labwareType?.includes("Tip")) {
        this.unresolvedInteractions.push({
          timestamp: Date.now(), command: event, x, y,
          reason: `Tip pickup from non-tip-rack (${resolution.labwareType})`,
          resolution,
        });
      }
    }

    return interaction;
  }

  /** Expand a tip mask bitmask into a sorted array of channel indices (0-based) */
  private expandTipMask(mask: number): number[] {
    const channels: number[] = [];
    for (let i = 0; i < 16; i++) {
      if (mask & (1 << i)) channels.push(i);
    }
    return channels;
  }

  /**
   * Resolve an X/Y coordinate to a deck object.
   *
   * Searches all carriers and their labware to find what's at the
   * given position, within POSITION_TOLERANCE.
   */
  /**
   * Resolve an X/Y coordinate to a deck well — **purely by coordinate
   *  proximity**, no carrier-rect gate.
   *
   * VENUS sends an absolute arm X/Y in every C0TP / C0AS / C0DS. Our
   * previous resolver first asked "is this X inside a registered
   * carrier's [xMin, xMax] band?" and rejected coords that fell in
   * the gap between carriers or just outside a fixture carrier's
   * track-derived range. That caused a class of false negatives —
   * WasteBlock-family fixtures whose child labware sits a few mm
   * past the parent's `trackToX + pitch/2` boundary came back as
   * "no carrier" even when a perfectly-matching well existed on
   * some other labware in the deck.
   *
   * We now scan every well on every labware on every carrier, track
   * the closest match within POSITION_TOLERANCE, and return that.
   * Single-well labware (troughs, waste blocks) match as long as the
   * cursor lies within the labware's physical rect. Unmatched coords
   * still come back with a descriptive label. O(carriers × positions
   * × rows × cols) per call — fine for the ~10 000 wells on a busy
   * STAR deck.
   */
  resolvePosition(x: number, y: number): DeckResolution {
    if (x === 0 && y === 0) {
      return { matched: false, description: "origin (0,0) — no deck object" };
    }

    let bestMatch: { dist2: number; res: DeckResolution } | null = null;
    let nearestSingle: { dist2: number; res: DeckResolution } | null = null;

    for (const carrier of this.deck.getAllCarriers()) {
      for (let pos = 0; pos < carrier.positions; pos++) {
        const labware = carrier.labware[pos];
        if (!labware) continue;

        // Multi-well labware — check every well, keep the closest
        // match within tolerance.
        for (let row = 0; row < labware.rows; row++) {
          for (let col = 0; col < labware.columns; col++) {
            const wellPos = this.deck.wellToPosition({
              carrierId: carrier.id,
              position: pos,
              row,
              column: col,
            });
            if (!wellPos) continue;
            const dx = wellPos.x - x;
            const dy = wellPos.y - y;
            if (Math.abs(dx) > POSITION_TOLERANCE || Math.abs(dy) > POSITION_TOLERANCE) continue;
            const dist2 = dx * dx + dy * dy;
            if (bestMatch && bestMatch.dist2 <= dist2) continue;
            const wellName = String.fromCharCode(65 + row) + (col + 1);
            bestMatch = {
              dist2,
              res: {
                matched: true,
                carrierId: carrier.id,
                carrierType: carrier.type,
                position: pos,
                labwareType: labware.type,
                row,
                column: col,
                wellIndex: row * labware.columns + col,
                description: `${carrier.type}[${carrier.id}] pos ${pos}, ${labware.type} well ${wellName}`,
              },
            };
          }
        }

        // Single-well labware (trough, waste-block child, etc.) —
        // match if the cursor lies near the labware's anchor. We use
        // the well-A1 as the anchor; the tolerance is relaxed by
        // half the labware's footprint so a big trough still matches.
        if (labware.wellCount === 1) {
          const a1 = this.deck.wellToPosition({ carrierId: carrier.id, position: pos, row: 0, column: 0 });
          if (!a1) continue;
          // `rackDx`/`rackDy` are 0.1-mm footprint dims (from the .rck);
          // use them as the reach where available, else fall back to
          // the resolver's default tolerance.
          const reachX = ((labware as any).rackDx ?? POSITION_TOLERANCE) / 2 + POSITION_TOLERANCE;
          const reachY = ((labware as any).rackDy ?? POSITION_TOLERANCE) / 2 + POSITION_TOLERANCE;
          const dx = a1.x - x;
          const dy = a1.y - y;
          if (Math.abs(dx) > reachX || Math.abs(dy) > reachY) continue;
          const dist2 = dx * dx + dy * dy;
          if (nearestSingle && nearestSingle.dist2 <= dist2) continue;
          nearestSingle = {
            dist2,
            res: {
              matched: true,
              carrierId: carrier.id,
              carrierType: carrier.type,
              position: pos,
              labwareType: labware.type,
              row: 0,
              column: 0,
              wellIndex: 0,
              description: `${carrier.type}[${carrier.id}] pos ${pos}, ${labware.type}`,
            },
          };
        }
      }
    }

    // A precise well match wins over a single-well "near" match.
    if (bestMatch) return bestMatch.res;
    if (nearestSingle) return nearestSingle.res;

    return {
      matched: false,
      description: `unresolved position X=${x / 10}mm Y=${y / 10}mm — no well within tolerance`,
    };
  }

  /** Get the volume of a specific well */
  getWellVolume(carrierId: string, position: number, wellIndex: number): number | undefined {
    const key = `${carrierId}:${position}:${wellIndex}`;
    return this.wellVolumes.get(key);
  }

  /** Max volume (0.1 µL) a well on this labware can hold, from the
   *  labware catalog / .ctr-derived `maxVolume`. Used by pip-physics
   *  for the well-overflow assessment so a Cos_96_DW_1mL (13273) isn't
   *  flagged at 300 µL just because that's a hardcoded default. */
  getWellCapacity(carrierId: string, position: number, _wellIndex: number): number | undefined {
    const carrier = this.deck.getCarrier(carrierId);
    const labware = carrier?.labware[position];
    return (labware as any)?.maxVolume;
  }

  /** Read the most recent underflow record for a well. Populated by the
   *  aspirate processing when `actualVolume < requestedVolume` (dead-volume
   *  clamp, tip-capacity clamp, or empty source). Undefined if the last
   *  aspirate on this well completed normally. */
  getLastUnderflow(carrierId: string, position: number, wellIndex: number):
    | { requested: number; actual: number; deficit: number; available: number }
    | undefined
  {
    return this.lastUnderflow.get(`${carrierId}:${position}:${wellIndex}`);
  }

  /** Read the most recent air-in-dispense record for a well. Populated on
   *  C0DS when the tip's trailing air leaves before liquid reaches the
   *  destination. Undefined for a clean dispense. */
  getLastAirDispense(carrierId: string, position: number, wellIndex: number):
    | { requested: number; liquid: number; air: number }
    | undefined
  {
    return this.lastAirDispense.get(`${carrierId}:${position}:${wellIndex}`);
  }

  /** Set well volume (for initial deck setup / liquid fill) */
  setWellVolume(carrierId: string, position: number, wellIndex: number, volume: number): void {
    const key = `${carrierId}:${position}:${wellIndex}`;
    this.wellVolumes.set(key, volume);
  }

  /** Add to well volume (additive fill — the well ends up with the pre-existing
   *  liquid plus `delta`). Use this from the Fill step and dispense path so the
   *  deck-tracker volume stays in sync with liquid-tracker components. */
  addWellVolume(carrierId: string, position: number, wellIndex: number, delta: number): void {
    const key = `${carrierId}:${position}:${wellIndex}`;
    const cur = this.wellVolumes.get(key) ?? 0;
    this.wellVolumes.set(key, cur + delta);
  }

  /** Remove the volume record for a well (used by the Clear setup step). */
  clearWellVolume(carrierId: string, position: number, wellIndex: number): void {
    const key = `${carrierId}:${position}:${wellIndex}`;
    this.wellVolumes.delete(key);
  }

  /** Check if a tip has been used */
  isTipUsed(carrierId: string, position: number, wellIndex: number): boolean {
    const key = `${carrierId}:${position}:${wellIndex}`;
    return this.tipUsage.get(key) || false;
  }

  /** Get all interactions */
  getInteractions(): DeckInteraction[] {
    return [...this.interactions];
  }

  /** Get recent interactions (last N) */
  getRecentInteractions(count: number = 10): DeckInteraction[] {
    return this.interactions.slice(-count);
  }

  /** Get a snapshot of tracked well volumes */
  getWellVolumeSnapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, vol] of this.wellVolumes) {
      result[key] = vol;
    }
    return result;
  }

  /** Get a snapshot of tip usage */
  getTipUsageSnapshot(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [key, used] of this.tipUsage) {
      result[key] = used;
    }
    return result;
  }

  /** Get unresolved interactions (commands with problematic coordinates) */
  getUnresolvedInteractions(): UnresolvedInteraction[] {
    return [...this.unresolvedInteractions];
  }

  /** Get count of unresolved interactions */
  getUnresolvedCount(): number {
    return this.unresolvedInteractions.length;
  }

  /** Get labware height at a carrier position (0.1mm) */
  getLabwareHeight(carrierId: string, position: number): number | undefined {
    const carrier = this.deck.getCarrier(carrierId);
    if (!carrier) return undefined;
    const labware = carrier.labware[position];
    return labware?.height;
  }

  /** Get liquid contents of a well */
  getWellLiquid(wellKey: string): LiquidContents | null {
    return this.liquidTracker.getWellContents(wellKey);
  }

  /** Get channel state */
  getChannelState(channel: number): ChannelState | null {
    return this.liquidTracker.getChannelState(channel);
  }

  /** Get liquid surface height in a well (0.1mm from well bottom) */
  getLiquidSurfaceHeight(carrierId: string, position: number, wellIndex: number): number {
    const carrier = this.deck.getCarrier(carrierId);
    if (!carrier) return 0;
    const labware = carrier.labware[position];
    if (!labware) return 0;

    const key = `${carrierId}:${position}:${wellIndex}`;
    const vol = this.wellVolumes.get(key) ?? 0;
    const geo = getWellGeometry(labware.type);
    return volumeToHeight(geo, vol);
  }

  /** Reset tracking state (but keep deck layout) */
  resetTracking(): void {
    this.interactions = [];
    this.unresolvedInteractions = [];
    this.tipUsage.clear();
    this.wellVolumes.clear();
    this.lastUnderflow.clear();
    this.lastAirDispense.clear();
    this.liquidTracker.reset();
    this.grippedLabware = null;
    this.grippedFrom = null;
  }

  // --------------------------------------------------------------------------
  // Serialization (Phase 1 #43)
  //
  // getTrackingState() captures well volumes, tip usage, and deck dynamic
  // state (gripped labware) into a JSON-safe shape. restoreTrackingState()
  // rebuilds the tracker from that snapshot, replacing all current state.
  //
  // The interactions[] and unresolvedInteractions[] history arrays are
  // cleared on restore — those are append-only audit logs tied to a session
  // and do not belong in a state snapshot. The trace format (Step 1.11)
  // captures them via the event spine instead.
  //
  // Liquid identity is a separate tracker (this.liquidTracker) and is
  // snapshotted/restored via its own methods; callers that want a
  // combined snapshot should orchestrate both.
  // --------------------------------------------------------------------------

  /**
   * Capture a JSON-safe snapshot of deck-tracker state.
   * Returns TrackingStateSnapshot + the separate deck-dynamic fields.
   */
  getTrackingState(): import("./twin-config").TrackingStateSnapshot {
    return {
      wellVolumes: this.getWellVolumeSnapshot(),
      tipUsage: this.getTipUsageSnapshot(),
    };
  }

  /** Capture the deck-dynamic bits (tip waste + gripped labware) separately. */
  getDeckDynamicState(): import("./twin-config").DeckDynamicStateSnapshot {
    return {
      tipWasteCount: this.deck.tipWaste.tipCount,
      grippedLabware: this.grippedLabware && this.grippedFrom
        ? {
            type: this.grippedLabware.type,
            from: { carrierId: this.grippedFrom.carrierId, position: this.grippedFrom.position },
          }
        : null,
    };
  }

  /**
   * Restore tracker state from a snapshot. Wipes interactions history and
   * rebuilds wellVolumes + tipUsage from the snapshot.
   *
   * Note: this does NOT restore liquid identity — call liquidTracker.restoreLiquidState()
   * separately.
   */
  restoreTrackingState(snapshot: import("./twin-config").TrackingStateSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("restoreTrackingState: snapshot is null or not an object");
    }
    if (!snapshot.wellVolumes || typeof snapshot.wellVolumes !== "object") {
      throw new Error("restoreTrackingState: wellVolumes must be an object");
    }
    if (!snapshot.tipUsage || typeof snapshot.tipUsage !== "object") {
      throw new Error("restoreTrackingState: tipUsage must be an object");
    }

    // Replace wellVolumes
    this.wellVolumes.clear();
    for (const key of Object.keys(snapshot.wellVolumes)) {
      this.wellVolumes.set(key, snapshot.wellVolumes[key]);
    }

    // Replace tipUsage
    this.tipUsage.clear();
    for (const key of Object.keys(snapshot.tipUsage)) {
      this.tipUsage.set(key, snapshot.tipUsage[key]);
    }

    // Interaction history is not part of the state snapshot — clear it.
    this.interactions = [];
    this.unresolvedInteractions = [];
  }

  /** Restore the deck-dynamic state (tip waste count + gripped labware). */
  restoreDeckDynamicState(snapshot: import("./twin-config").DeckDynamicStateSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("restoreDeckDynamicState: snapshot is null or not an object");
    }
    this.deck.tipWaste.tipCount = snapshot.tipWasteCount ?? 0;

    if (snapshot.grippedLabware) {
      // We have the gripped labware type and its origin, but not its full
      // LabwareItem (rows, columns, etc.). Reconstruct a minimal shim from
      // the deck's labware catalog if possible, otherwise leave a
      // placeholder that still round-trips through the same restore path.
      const fromCarrier = this.deck.getCarrier(snapshot.grippedLabware.from.carrierId);
      const originalLabware = fromCarrier?.labware[snapshot.grippedLabware.from.position];
      this.grippedLabware = originalLabware
        ? { ...originalLabware }
        : {
            type: snapshot.grippedLabware.type,
            wellCount: 0,
            rows: 0,
            columns: 0,
            wellPitch: 0,
            offsetX: 0,
            offsetY: 0,
            height: 0,
            wellDepth: 0,
          };
      this.grippedFrom = { ...snapshot.grippedLabware.from };
    } else {
      this.grippedLabware = null;
      this.grippedFrom = null;
    }
  }

  private wellKey(resolution: DeckResolution): string {
    return `${resolution.carrierId}:${resolution.position}:${resolution.wellIndex}`;
  }
}
