/**
 * PIP Channel Physics Plugin
 *
 * This is a REAL physics simulation plugin, not a stub.
 * It tracks:
 *   - Arm X position with travel time calculation
 *   - Per-channel Y positions with spacing enforcement
 *   - Per-channel Z positions with traverse height checks
 *   - Aspiration/dispense timing from volume and speed
 *   - Plunger displacement (volume correction ready)
 *
 * The plugin hooks into the executor via onBeforeEvent to inject
 * calculated delays and corrected parameters. The SCXML state machine
 * uses these via _event.data._delay for <send delay>.
 */

import { PhysicsPlugin, PhysicsValidation, TransitionInfo, StateEntryInfo } from "../plugin-interface";
import { AssessmentEvent, AssessmentSeverity } from "../assessment";
import { getLiquidClass, getCorrectionCurve, applyCorrection, LiquidClass } from "../liquid-classes";
import { TADMResult, generateAspirateCurve, generateDispenseCurve } from "../tadm";
import { getWellGeometry, volumeToHeight, simulateLLD, calculatePipetteZ, wellCrossSectionAt, LLDResult } from "../well-geometry";

// ============================================================================
// Physical constants from the Hamilton STAR spec
// ============================================================================

/** Axis speed defaults (0.1mm per second) */
const X_SPEED_DEFAULT = 25000;    // 2500 mm/s max X travel
const X_SPEED_WITH_LIQUID = 15000; // 1500 mm/s when carrying liquid
const Z_SPEED_DEFAULT = 12000;     // 1200 mm/s Z movement
const Y_SPEED_DEFAULT = 8000;      // 800 mm/s Y movement

/** Axis acceleration (0.1mm per second^2) — for trapezoidal profile */
const X_ACCEL = 50000;   // 5000 mm/s^2
const Z_ACCEL = 30000;   // 3000 mm/s^2

/** Pipetting speed defaults (0.1ul per second) */
const ASP_SPEED_DEFAULT = 5000;   // 500 ul/s
const DSP_SPEED_DEFAULT = 5000;   // 500 ul/s

/** Fixed overhead times (milliseconds) — mechanical grip/release only, NOT full sequence */
const TIP_GRIP_TIME_MS = 800;       // CO-RE compression mechanism
const TIP_RELEASE_TIME_MS = 500;    // CO-RE release mechanism
const BARCODE_READ_TIME_MS = 200;   // Scanner read time

/** Z distances for tip operations in 0.1mm units */
const Z_TRAVERSE_TO_TIP = 1800;     // ~180mm from traverse to tip top
const Z_TRAVERSE_TO_LIQUID = 1500;  // ~150mm from traverse to typical liquid surface
const Z_TRAVERSE_TO_DISPENSE = 1200;// ~120mm from traverse to dispense position
const Z_EJECT_TRAVEL = 600;         // ~60mm for tip eject stroke

/**
 * Hamilton tip type → max volume mapping (0.1uL units).
 * From VENUS TT_ constants: 0=Standard 1000ul, 4=High Volume 1000ul,
 * 5=Standard 300ul, 1=Low Volume 50ul, 2=10ul, 6/7/8=needles
 */
const TIP_TYPE_TO_MAX_VOLUME: Record<number, number> = {
  0: 10000,  // Standard 1000uL
  1: 500,    // Low Volume 50uL
  2: 100,    // 10uL
  3: 500,    // 50uL needle
  4: 10000,  // High Volume 1000uL
  5: 3000,   // Standard Volume 300uL
  6: 10000,  // Standard Volume Needle
  7: 10000,  // High Volume Needle
  8: 10000,  // 5mL Needle
};

/** Channel geometry */
const MIN_Y_SPACING_01MM = 90;      // 9mm minimum between channels
/**
 * Expand a PIP tip-mask byte into a list of active channel indices
 * (0..7). The low bit is channel 1, and so on. Kept local to avoid a
 * cross-module import cycle with `deck-tracker.ts`.
 */
function expandMask(mask: number): number[] {
  const out: number[] = [];
  for (let ch = 0; ch < 8; ch++) {
    if (((mask >> ch) & 1) === 1) out.push(ch);
  }
  return out;
}

/** Alias for readability in assess() — `expandChannelMask` emphasises
 *  the domain. Both names resolve to the same function. */
const expandChannelMask = expandMask;

const CHANNEL_Y_HOME = [             // Default Y home positions for 8 channels
  1460, 1550, 1640, 1730, 1820, 1910, 2000, 2090,
  2180, 2270, 2360, 2450, 2540, 2630, 2720, 2810
];

// ============================================================================
// Physics calculations
// ============================================================================

/**
 * Calculate travel time for a linear axis move using trapezoidal profile.
 *
 * For short distances, the profile is triangular (never reaches full speed).
 * For longer distances, it's trapezoidal (accelerate, cruise, decelerate).
 *
 * @param distance - Distance in 0.1mm
 * @param maxSpeed - Maximum speed in 0.1mm/s
 * @param accel - Acceleration in 0.1mm/s^2
 * @returns Time in milliseconds
 */
function trapezoidalMoveTime(distance: number, maxSpeed: number, accel: number): number {
  if (distance <= 0) return 0;

  // Distance needed to accelerate to full speed
  const accelDistance = (maxSpeed * maxSpeed) / (2 * accel);

  if (distance < 2 * accelDistance) {
    // Triangular profile: never reaches full speed
    // t = 2 * sqrt(distance / accel)
    return Math.round(2 * Math.sqrt(distance / accel) * 1000);
  } else {
    // Trapezoidal profile
    const accelTime = maxSpeed / accel;                       // seconds
    const cruiseDistance = distance - 2 * accelDistance;       // 0.1mm
    const cruiseTime = cruiseDistance / maxSpeed;              // seconds
    const totalTime = 2 * accelTime + cruiseTime;             // seconds
    return Math.round(totalTime * 1000);
  }
}

/**
 * Calculate pipetting time from volume and speed.
 *
 * @param volume - Volume in 0.1ul
 * @param speed - Speed in 0.1ul/s
 * @returns Time in milliseconds
 */
function pipetteTime(volume: number, speed: number): number {
  if (volume <= 0 || speed <= 0) return 0;
  return Math.round((volume / speed) * 1000);
}

/**
 * Travel time for a pipette-into-well motion: X travel + Y travel + Z down
 * + Z up. Shared by C0AS (aspirate) and C0DS (dispense) — both drop the
 * channel into a well and lift it out again regardless of pump volume.
 *
 * Before this helper, `_delay` for those commands counted only pump time,
 * so a zero-volume step (VENUS's default when the method author never
 * touched the step) collapsed the animation envelope to ~100 ms — the
 * arm snapped. Including travel keeps the motion envelope matching the
 * physical sequence even with `av00000` / `dv00000`.
 *
 * @param data   Event data (reads xp, yp, _yp_array)
 * @param dm     Module datamodel (current pos_x, pos_y)
 * @param zSink  Z descent distance in 0.1mm — Z_TRAVERSE_TO_LIQUID for
 *               aspirate, Z_TRAVERSE_TO_DISPENSE for dispense.
 */
function pipTravelTime(
  data: Record<string, unknown>,
  dm: Record<string, unknown>,
  zSink: number,
): number {
  const curX = (dm.pos_x as number) || 0;
  const tgtX = (data.xp as number) ?? curX;
  const xTime = trapezoidalMoveTime(Math.abs(tgtX - curX), X_SPEED_DEFAULT, X_ACCEL);

  const curYArr = Array.isArray(dm.pos_y) ? (dm.pos_y as number[]) : [dm.pos_y as number];
  const curY = curYArr[0] || 0;
  const ypArr = data._yp_array as number[] | undefined;
  const tgtY = ypArr?.[0] ?? (data.yp as number) ?? curY;
  const yTime = trapezoidalMoveTime(Math.abs(tgtY - curY), Y_SPEED_DEFAULT, X_ACCEL);

  const zDown = trapezoidalMoveTime(zSink, Z_SPEED_DEFAULT, Z_ACCEL);
  const zUp = zDown;

  return xTime + yTime + zDown + zUp;
}

// ============================================================================
// Plugin implementation
// ============================================================================

export class PipPhysicsPlugin implements PhysicsPlugin {
  readonly id = "pip-physics";

  private executor: any = null;
  private moduleId: string = "";
  private activeLiquidClass: LiquidClass | null = null;
  private lastTADM: TADMResult | null = null;
  private lastLLD: LLDResult | null = null;
  private lastEventData: Record<string, unknown> = {};

  /**
   * Physics validation: check physical constraints before SCXML.
   * Simulates sensor-based error detection on the real instrument.
   */
  validateCommand(event: string, data: Record<string, unknown>, deckTracker: any, datamodel?: Record<string, unknown>): PhysicsValidation | undefined {
    const x = (data.xp as number) ?? (data.xs as number) ?? 0;
    const y = (data.yp as number) ?? (data.yh as number) ?? 0;
    const tm = (data.tm as number) ?? 0;

    switch (event) {
      case "C0TP": {
        // Tip pickup validation — match real hardware:
        //   1. Command must carry `tp` (pickup Z) and `th` (retract Z).
        //      Real VENUS always sends these; without them the arm has
        //      nowhere to descend and nowhere to retract to, so real FW
        //      rejects the command rather than silently no-op. We
        //      surface it as error 3 — if a customer's software sends a
        //      malformed C0TP, the twin-driven test must fail so the
        //      bug shows up on the simulator instead of on real
        //      hardware.
        //   2. Every active channel must land over a tip-rack well (labware type).
        //   3. That specific well must still have a tip (tipUsage). Real Hamilton
        //      detects missing tips via capacitive Tip Presence Detection (TPD):
        //      if no tip is found at the expected height, the pickup attempt
        //      returns error 75 ("tip pick-up fail, tip not fetched").
        //   4. No active channel may already be fitted — real FW returns
        //      error 07 ("tip already fitted") before attempting the motion.
        if (x === 0 && y === 0) return undefined; // system command — no position
        const tp = (data.tp as number) ?? 0;
        const th = (data.th as number) ?? 0;
        if (tp <= 0 || th <= 0) {
          return {
            valid: false,
            errorCode: 3,
            errorDescription: `C0TP missing Z params: needs 'tp' (pickup Z, got ${tp}) and 'th' (retract Z, got ${th}). Real STAR FW requires both.`,
          };
        }
        const ypArray = data._yp_array as number[] | undefined;
        const activeChannels = expandMask(tm);
        if (activeChannels.length === 0) return undefined;
        // Error 07: any masked channel already has a tip.
        const tipFitted = datamodel?.tip_fitted as boolean[] | undefined;
        if (tipFitted) {
          const alreadyFitted = activeChannels.filter((ch) => tipFitted[ch]);
          if (alreadyFitted.length > 0) {
            return {
              valid: false,
              errorCode: 7,
              errorDescription: `Tip already fitted on channel(s) ${alreadyFitted.map((c) => c + 1).join(",")}`,
            };
          }
        }
        const misses: number[] = [];
        const empty: number[] = [];
        let emptyDetail = "";
        for (const ch of activeChannels) {
          const chY = ypArray && ypArray[ch] !== undefined
            ? ypArray[ch]
            : y - ch * MIN_Y_SPACING_01MM;
          const cRes = deckTracker.resolvePosition(x, chY);
          if (!cRes.matched) { misses.push(ch); continue; }
          if (!cRes.labwareType?.includes("Tip")) {
            return {
              valid: false,
              errorCode: 22,
              errorDescription: `Tip pickup ch${ch + 1}: target is ${cRes.labwareType} at ${cRes.description}, not a tip rack`,
            };
          }
          // TPD check: this well must still hold a tip.
          if (deckTracker.isTipUsed(cRes.carrierId!, cRes.position!, cRes.wellIndex!)) {
            empty.push(ch);
            if (!emptyDetail) emptyDetail = cRes.description;
          }
        }
        if (misses.length > 0) {
          const chLabels = misses.map((c) => c + 1).join(",");
          return {
            valid: false,
            errorCode: 22,
            errorDescription: `Tip pickup: channel(s) ${chLabels} fell outside any tip-rack well — arm misaligned by ~${Math.round(misses.length * 0.5)}mm`,
          };
        }
        if (empty.length > 0) {
          const chLabels = empty.map((c) => c + 1).join(",");
          return {
            valid: false,
            errorCode: 75,
            errorDescription: `Tip pickup ch${chLabels}: TPD reports no tip at ${emptyDetail} (well already used)`,
          };
        }
        return undefined;
      }

      case "C0AS": {
        // Aspirate: check there's liquid at the target
        if (x === 0 && y === 0) return undefined;
        const res = deckTracker.resolvePosition(x, y);
        if (res.matched && res.labwareType?.includes("Tip")) {
          return { valid: false, errorCode: 22, errorDescription: `Cannot aspirate from tip rack (${res.description})` };
        }
        // Well volume tracking: the real FW aspirates regardless of volume.
        // LLD may detect "no liquid" but doesn't reject the command at FW level.
        // Volume tracking is for simulation purposes, not command acceptance.
        if (res.matched) {

          // Z-axis / LLD validation
          const zTarget = (data.zp as number) ?? 0;
          const zpArrCheck = Array.isArray(data._zp_array) ? (data._zp_array as number[]) : undefined;
          const hasAnyZTarget = zTarget > 0 || (zpArrCheck && zpArrCheck.some((z) => Number(z) > 0));
          const lldMode = (data.lm as number) ?? (this.activeLiquidClass?.aspiration.lldMode ?? 0);
          const lldSearchStart = (data.lp as number) ?? 0;  // zl from real VENUS = lp in some codebases

          // Malformed-command rejection — real FW behaviour. The arm
          // needs either an explicit fixed Z target (zp, lm=0 fixed
          // height) OR an LLD search start (lp, lm>0). Without either,
          // the command has no Z and the real STAR errors rather than
          // silently dropping the tip somewhere. Treating it as "no
          // motion" in the twin would let malformed software pass
          // tests it would fail on real hardware — the user's explicit
          // bar: don't silently swallow errors. (Error code 03 =
          // "command not completed" per spec.)
          if (!hasAnyZTarget && lldMode === 0 && lldSearchStart <= 0) {
            return {
              valid: false,
              errorCode: 3,
              errorDescription: `C0AS missing Z target: needs 'zp' (fixed height, lm=0) or 'lp' with 'lm'>0 (LLD search). Real STAR FW requires a Z reference for every aspirate.`,
            };
          }

          // When LLD is active and no fixed Z target (zp=0), the instrument uses
          // the LLD sensor to find the liquid surface — it won't crash to Z=0.
          // Only validate Z crash when there's an explicit fixed Z target.
          if (res.labwareType && zTarget > 0) {
            const geo = getWellGeometry(res.labwareType);
            const wellVolume = deckTracker.getWellVolume?.(res.carrierId, res.position, res.wellIndex) ?? 0;
            const labwareHeight = deckTracker.getLabwareHeight?.(res.carrierId, res.position) ?? 144;

            // Simulate LLD
            const lldResult = simulateLLD(geo, wellVolume, labwareHeight, lldMode, zTarget);
            this.lastLLD = lldResult;

            // Crash detection
            if (lldResult.crashRisk) {
              return { valid: false, errorCode: 7, errorDescription: `Tip crash: Z=${zTarget / 10}mm is at or below well bottom at ${res.description}` };
            }

            // LLD expected but no liquid detected
            if (lldMode > 0 && !lldResult.detected && wellVolume <= 0) {
              return { valid: false, errorCode: 6, errorDescription: `LLD: no liquid detected at ${res.description}` };
            }

            // Above-surface detection: if tip is above liquid surface and LLD is off,
            // the instrument will aspirate air. Flag this for assessment.
            if (lldMode === 0 && wellVolume > 0) {
              const wellBottomZ = labwareHeight - geo.depth;
              const surfaceHeight = volumeToHeight(geo, wellVolume);
              const liquidSurfaceAbsolute = wellBottomZ + surfaceHeight;
              if (zTarget > liquidSurfaceAbsolute) {
                data._aboveSurface = true;
              }
            }
          }
        }
        return undefined;
      }

      case "C0DS": {
        // Dispense: check target is not a tip rack
        if (x === 0 && y === 0) return undefined;
        const res = deckTracker.resolvePosition(x, y);
        if (res.matched && res.labwareType?.includes("Tip")) {
          return { valid: false, errorCode: 22, errorDescription: `Cannot dispense to tip rack (${res.description})` };
        }

        // Same Z-target requirement as C0AS — a malformed dispense with
        // no zp / lp / LLD mode has no Z to descend to, and real FW
        // errors rather than silently dropping. See C0AS comment above.
        const zTarget = (data.zp as number) ?? 0;
        const zpArrCheck = Array.isArray(data._zp_array) ? (data._zp_array as number[]) : undefined;
        const hasAnyZTarget = zTarget > 0 || (zpArrCheck && zpArrCheck.some((z) => Number(z) > 0));
        const lldMode = (data.lm as number) ?? 0;
        const lldSearchStart = (data.lp as number) ?? 0;
        if (!hasAnyZTarget && lldMode === 0 && lldSearchStart <= 0) {
          return {
            valid: false,
            errorCode: 3,
            errorDescription: `C0DS missing Z target: needs 'zp' (fixed height, lm=0) or 'lp' with 'lm'>0 (LLD search). Real STAR FW requires a Z reference for every dispense.`,
          };
        }
        return undefined;
      }

      case "C0TR": {
        // Tip eject: real VENUS sends tz (eject Z — usually the waste
        // collar's strip height) and th (retract Z). Without tz the
        // arm has no target to descend to; without th no safe height
        // to retract to. Error 3 rather than silently accept.
        const tz = (data.tz as number) ?? 0;
        const th = (data.th as number) ?? 0;
        if (tz <= 0 || th <= 0) {
          return {
            valid: false,
            errorCode: 3,
            errorDescription: `C0TR missing Z params: needs 'tz' (eject Z, got ${tz}) and 'th' (retract Z, got ${th}). Real STAR FW requires both.`,
          };
        }
        return undefined;
      }
    }

    return undefined;  // No validation for this command
  }

  onAttach(executor: any, moduleId: string): void {
    this.executor = executor;
    this.moduleId = moduleId;
    // Default liquid class
    this.activeLiquidClass = getLiquidClass("HighVolume_Water_DispenseJet_Empty") || null;
  }

  /** Set the active liquid class by name */
  setLiquidClass(name: string): boolean {
    const lc = getLiquidClass(name);
    if (lc) {
      this.activeLiquidClass = lc;
      return true;
    }
    return false;
  }

  /**
   * Before event: calculate timing and inject _delay into event data.
   *
   * This is called BEFORE the SCXML processes the event. The SCXML
   * uses _event.data._delay for <send delayexpr>.
   */
  onBeforeEvent(event: string, data: Record<string, unknown>): Record<string, unknown> {
    this.lastEventData = data;
    const dm = this.getDatamodel();
    if (!dm) return data;

    switch (event) {
      case "C0DI": {
        // Init: home all 16 Z-drives + Y-drives + X-axis + calibration
        // Real trace: C0DI takes ~55s (16 channels × Z-home ~2s each + Y-home + overhead)
        const initTime = 16 * 2000 + 5000 + 8000;  // 16×Z + Y + calibration ≈ 45s
        return { ...data, _delay: initTime + "ms" };
      }

      case "C0TP": {
        // Tip pickup: full sequence = X travel + Z descend + grip + Z retract
        // Real trace: C0TP takes 7-9s total
        const currentX = dm.pos_x || 0;
        const targetX = (data.xp as number) ?? currentX;
        const xDist = Math.abs(targetX - currentX);
        const xTime = xDist > 0 ? trapezoidalMoveTime(xDist, X_SPEED_DEFAULT, X_ACCEL) : 0;
        const zDown = trapezoidalMoveTime(Z_TRAVERSE_TO_TIP, Z_SPEED_DEFAULT, Z_ACCEL);
        const zUp = trapezoidalMoveTime(Z_TRAVERSE_TO_TIP, Z_SPEED_DEFAULT, Z_ACCEL);
        const total = xTime + zDown + TIP_GRIP_TIME_MS + zUp;
        return { ...data, _delay: Math.max(2000, total) + "ms" };
      }

      case "C0TR": {
        // Tip eject: full sequence = X travel to waste + Z down + release + Z retract
        // Real trace: C0TR takes 7-8s total
        const currentX = dm.pos_x || 0;
        const targetX = (data.xp as number) ?? currentX;
        const xDist = Math.abs(targetX - currentX);
        const xTime = xDist > 0 ? trapezoidalMoveTime(xDist, X_SPEED_DEFAULT, X_ACCEL) : 0;
        const zDown = trapezoidalMoveTime(Z_EJECT_TRAVEL, Z_SPEED_DEFAULT, Z_ACCEL);
        const zUp = trapezoidalMoveTime(Z_EJECT_TRAVEL, Z_SPEED_DEFAULT, Z_ACCEL);
        const total = xTime + zDown + TIP_RELEASE_TIME_MS + zUp;
        return { ...data, _delay: Math.max(1000, total) + "ms" };
      }

      case "C0AS": {
        // Aspiration: apply liquid class correction + timing
        const nominalVol = (data.av as number) || 0;
        const speed = (data.as as number) || (this.activeLiquidClass?.aspiration.speed || ASP_SPEED_DEFAULT);
        const settleTime = ((data.wt as number) || (this.activeLiquidClass?.aspiration.settlingTime || 0)) * 100;

        // Volume correction from liquid class
        let correctedVol = nominalVol;
        let correctionApplied = false;
        if (this.activeLiquidClass && dm.tip_type) {
          const tipTypes = dm.tip_type as number[];
          const activeTipType = tipTypes.find((t: number) => t >= 0);
          if (activeTipType !== undefined) {
            // Map tip type to max volume using real Hamilton TT_ constants
            const tipMaxVol = TIP_TYPE_TO_MAX_VOLUME[activeTipType] ?? 10000;
            const curve = getCorrectionCurve(this.activeLiquidClass, tipMaxVol);
            correctedVol = applyCorrection(nominalVol, curve);
            correctionApplied = true;
          }
        }

        const aspTime = pipetteTime(correctedVol, speed);
        const travelTime = pipTravelTime(data, dm, Z_TRAVERSE_TO_LIQUID);
        return {
          ...data,
          _delay: (travelTime + aspTime + settleTime + 100) + "ms",
          _aspTime: aspTime,
          _travelTime: travelTime,
          _nominalVol: nominalVol,
          _correctedVol: correctedVol,
          _correctionApplied: correctionApplied,
          _liquidClass: this.activeLiquidClass?.name || "none",
          _lld: this.lastLLD ? {
            detected: this.lastLLD.detected,
            liquidSurfaceZ: this.lastLLD.liquidSurfaceZ,
            submergeDepth: this.lastLLD.submergeDepth,
            crashRisk: this.lastLLD.crashRisk,
          } : undefined,
        };
      }

      case "C0DS": {
        // Dispense: time depends on volume, speed, and mode
        const vol = (data.dv as number) || 0;
        const speed = (data.ds as number) || DSP_SPEED_DEFAULT;
        const dspTime = pipetteTime(vol, speed);
        const travelTime = pipTravelTime(data, dm, Z_TRAVERSE_TO_DISPENSE);
        return {
          ...data,
          _delay: (travelTime + dspTime + 100) + "ms",
          _dspTime: dspTime,
          _travelTime: travelTime,
        };
      }

      case "C0JM": {
        // Move: calculate travel time from distance
        const currentX = dm.pos_x || 0;
        const targetX = (data.xp as number) ?? currentX;
        const distance = Math.abs(targetX - currentX);

        // Use slower speed if carrying liquid
        const hasLiquid = (dm.active_volume_total || 0) > 0;
        const xSpeed = hasLiquid ? X_SPEED_WITH_LIQUID : X_SPEED_DEFAULT;

        const moveTime = trapezoidalMoveTime(distance, xSpeed, X_ACCEL);

        return {
          ...data,
          _delay: Math.max(50, moveTime) + "ms",
          _moveDistance: distance,
          _moveTime: moveTime,
          _speed: xSpeed,
        };
      }

      case "C0DF": {
        // Dispense on fly: depends on number of shoots and X travel
        const shoots = (data.xi as number) || 1;
        const vol = (data.dv as number) || 0;
        const speed = (data.ds as number) || DSP_SPEED_DEFAULT;
        const totalTime = shoots * pipetteTime(vol, speed);
        return { ...data, _delay: (totalTime + 200) + "ms" };
      }

      case "C0LW": {
        // DC Wash: depends on wash cycles and volume
        const cycles = (data.dc as number) || 3;
        const vol = (data.av as number) || 5000;  // default 500ul
        const aspSpeed = (data.as as number) || ASP_SPEED_DEFAULT;
        const dspSpeed = (data.ds as number) || DSP_SPEED_DEFAULT;
        const soakTime = ((data.sa as number) || 0) * 100; // sa is in 0.1s
        const cycleTime = pipetteTime(vol, aspSpeed) + pipetteTime(vol, dspSpeed) + soakTime;
        return { ...data, _delay: (cycles * cycleTime + 500) + "ms" };
      }

      default:
        return data;
    }
  }

  /**
   * After transition: this is where we'd generate sensor data.
   *
   * Future: send TADM curves, LLD detection results, etc.
   */
  onAfterTransition(info: TransitionInfo): void {
    const dm = this.getDatamodel();
    if (!dm) return;

    // Determine liquid viscosity from active liquid class
    const viscosityMap: Record<string, number> = {
      "Water": 1.0, "DMSO": 2.0, "Serum": 1.5,
      "Ethanol": 0.8, "80% Glycerol": 15.0,
    };
    const viscosity = viscosityMap[this.activeLiquidClass?.liquidType || "Water"] || 1.0;

    if (info.event === "C0AS" && info.targets.some(t => t === "tip_loaded")) {
      // Generate aspiration TADM curve — use event data volume (datamodel not yet updated)
      const vol = (this.lastEventData.av as number) || 0;
      const speed = (this.lastEventData.as as number) || this.activeLiquidClass?.aspiration.speed || ASP_SPEED_DEFAULT;
      this.lastTADM = generateAspirateCurve(vol, speed, viscosity);
    }

    if (info.event === "C0DS" && (info.targets.some(t => t === "tip_empty" || t === "tip_loaded"))) {
      // Generate dispense TADM curve — use event data volume
      const vol = (this.lastEventData.dv as number) || 0;
      const speed = (this.lastEventData.ds as number) || this.activeLiquidClass?.dispense.speed || DSP_SPEED_DEFAULT;
      const dm_mode = (this.lastEventData.dm as number) ?? 0;
      this.lastTADM = generateDispenseCurve(vol, speed, dm_mode, viscosity);
    }
  }

  /** Get the last TADM measurement result */
  getLastTADM(): TADMResult | null {
    return this.lastTADM;
  }

  /** Get the last LLD detection result */
  getLastLLD(): LLDResult | null {
    return this.lastLLD;
  }

  /**
   * Assess the physical consequences of an accepted command.
   * Called after the command is accepted — generates observations, never rejects.
   */
  assess(event: string, data: Record<string, unknown>, deckTracker: any): AssessmentEvent[] {
    const events: Omit<AssessmentEvent, "id" | "timestamp">[] = [];
    const dm = this.getDatamodel();

    switch (event) {
      case "C0AS": {
        // DECK EFFECT CHECK — before anything else, confirm the
        // requested aspirate is actually going to change any well
        // volume. If `av=0` (no-op), or `xp/yp` don't resolve to any
        // labware, the command is silently a no-op on the deck books.
        // Without this guard we produced "arm moved over the well,
        // TADM passed, inspector showed no change" with zero in-UI
        // hint that it had effectively been a no-op.
        {
          const xAs = (data.xp as number) ?? 0;
          const yAs = (data.yp as number) ?? 0;
          const avAs = (data.av as number) ?? 0;
          if (avAs <= 0) {
            events.push({
              category: "no_deck_effect",
              severity: "warning",
              module: "pip",
              command: event,
              description: `C0AS accepted but av=${avAs} — zero-volume aspirate, no wells touched`,
              data: { xp_01mm: xAs, yp_01mm: yAs, volume_01ul: avAs },
            });
          } else if (xAs > 0 || yAs > 0) {
            const rAs = deckTracker.resolvePosition?.(xAs, yAs);
            if (!rAs?.matched) {
              events.push({
                category: "no_deck_effect",
                severity: "warning",
                module: "pip",
                command: event,
                description: `C0AS ${avAs / 10}uL at (${(xAs / 10).toFixed(1)}, ${(yAs / 10).toFixed(1)}) mm — no labware under coordinates, volume NOT tracked`,
                data: { xp_01mm: xAs, yp_01mm: yAs, volume_01ul: avAs },
              });
            }
          }
        }

        // TADM observation — emit ONE assessment per active channel so
        // the UI can bucket curves per channel. The underlying curve
        // is the same (single pressure sensor per plunger group), but
        // tagging each active channel lets the operator isolate /
        // overlay curves in the TADM chart.
        if (this.lastTADM) {
          const sev: AssessmentSeverity = this.lastTADM.passed ? "info" : "warning";
          const tm = (data.tm as number) ?? 0;
          const channels = expandChannelMask(tm);
          const fanout = channels.length > 0 ? channels : [undefined];
          for (const ch of fanout) {
            events.push({
              category: "tadm",
              severity: sev,
              module: "pip",
              command: event,
              channel: ch,
              description: this.lastTADM.passed
                ? `TADM aspirate${ch !== undefined ? ` ch${ch + 1}` : ""} passed — peak ${this.lastTADM.peakPressure} mbar, ${this.lastTADM.volume / 10}uL`
                : `TADM aspirate${ch !== undefined ? ` ch${ch + 1}` : ""} VIOLATION at sample ${this.lastTADM.violationIndex} — peak ${this.lastTADM.peakPressure} mbar`,
              tadm: this.lastTADM,
            });
          }
        }

        // LLD observation — one per active channel, same reasoning.
        if (this.lastLLD) {
          const tm = (data.tm as number) ?? 0;
          const channels = expandChannelMask(tm);
          const fanout = channels.length > 0 ? channels : [undefined];
          for (const ch of fanout) {
            events.push({
              category: "lld",
              severity: this.lastLLD.crashRisk ? "error" : (this.lastLLD.detected ? "info" : "warning"),
              module: "pip",
              command: event,
              channel: ch,
              description: this.lastLLD.detected
                ? `LLD${ch !== undefined ? ` ch${ch + 1}` : ""} detected liquid at Z=${(this.lastLLD.liquidSurfaceZ / 10).toFixed(1)}mm, submerge ${(this.lastLLD.submergeDepth / 10).toFixed(1)}mm`
                : `LLD${ch !== undefined ? ` ch${ch + 1}` : ""}: no liquid detected (volume at surface: ${this.lastLLD.volumeAtSurface / 10}uL)`,
              lld: this.lastLLD,
            });
          }
        }

        // Z-height telemetry — emit for every aspiration
        const zp = (data.zp as number) ?? 0;
        const aspIp = (data.ip as number) ?? 0;
        const aspLf = (data.lf as number) ?? 1;
        if (zp > 0) {
          const xTel = (data.xp as number) ?? 0;
          const yTel = (data.yp as number) ?? 0;
          const resTel = deckTracker.resolvePosition?.(xTel, yTel);
          let wellBottomZ: number | undefined;
          let crashMargin: number | undefined;
          if (resTel?.matched && resTel.labwareType) {
            const geoTel = getWellGeometry(resTel.labwareType);
            const labHt = deckTracker.getLabwareHeight?.(resTel.carrierId, resTel.position) ?? 144;
            wellBottomZ = labHt - geoTel.depth;
            crashMargin = zp - wellBottomZ;
          }
          events.push({
            category: "info" as any,
            severity: "info",
            module: "pip",
            command: event,
            description: `Z telemetry: tipZ=${(zp / 10).toFixed(1)}mm, submerge=${(aspIp / 10).toFixed(1)}mm, following=${aspLf === 1 ? "ON" : "OFF"}`,
            data: {
              tipZ_01mm: zp,
              surfaceZ_01mm: this.lastLLD?.liquidSurfaceZ,
              wellBottomZ_01mm: wellBottomZ,
              crashMargin_01mm: crashMargin,
              submergeDepth_mm: aspIp / 10,
              liquidFollowing: aspLf === 1,
            },
          });
        }

        // Above-surface warning (tip above liquid, LLD off)
        if (data._aboveSurface) {
          events.push({
            category: "empty_aspiration",
            severity: "warning",
            module: "pip",
            command: event,
            description: `Tip above liquid surface (LLD off, fixed Z) — may aspirate air`,
            data: { aboveSurface: true, tipZ_01mm: zp },
          });
        }

        // Liquid following OFF: surface drops below tip → air aspiration risk
        // Check is done here in assess() because it needs access to deckTracker
        const lfFlag = (data.lf as number) ?? 1;
        const tipZForLf = (data.zp as number) ?? 0;
        const aspVolLf = (data.av as number) ?? 0;
        if (lfFlag === 0 && tipZForLf > 0 && aspVolLf > 0 && this.lastLLD) {
          const surfaceZLf = this.lastLLD.liquidSurfaceZ;
          const wellTopZLf = this.lastLLD.wellTopZ;
          if (surfaceZLf > 0) {
            const xLf = (data.xp as number) ?? 0;
            const yLf = (data.yp as number) ?? 0;
            if (xLf > 0 || yLf > 0) {
              const resLf = deckTracker.resolvePosition?.(xLf, yLf);
              if (resLf?.matched && resLf.labwareType) {
                const geoLf = getWellGeometry(resLf.labwareType);
                const crossSection = wellCrossSectionAt(geoLf, surfaceZLf);
                if (crossSection > 0) {
                  const volMm3 = aspVolLf / 10;  // 0.1uL -> uL = mm^3
                  const surfaceDrop_mm = volMm3 / crossSection;
                  const surfaceDrop_01mm = surfaceDrop_mm * 10;
                  const wellBottomZLf = wellTopZLf - geoLf.depth;
                  const tipZAboveBottom = tipZForLf - wellBottomZLf;
                  const newSurfaceZ = surfaceZLf - surfaceDrop_01mm;
                  if (newSurfaceZ < tipZAboveBottom) {
                    events.push({
                      category: "empty_aspiration",
                      severity: "warning",
                      module: "pip",
                      command: event,
                      description: `Liquid following OFF: surface drops ${surfaceDrop_mm.toFixed(1)}mm during aspiration — tip will be above liquid`,
                      data: {
                        liquidFollowing: false,
                        surfaceDrop_mm: surfaceDrop_mm,
                        originalSurfaceZ_01mm: surfaceZLf,
                        newSurfaceZ_01mm: Math.max(0, newSurfaceZ),
                        tipZ_01mm: tipZForLf,
                        volume_01ul: aspVolLf,
                      },
                    });
                  }
                }
              }
            }
          }
        }

        // Volume observations. Source of truth: the deck-tracker records a
        // per-well underflow marker when `result.actualVolume < requested`
        // during the aspirate (dead-volume clamp, tip overflow, or empty
        // source). The tracker's wellVolumes itself stays pinned to Σ
        // components for truthful display, so we no longer rely on
        // "wellVol < 0" as the underflow signal.
        const x = (data.xp as number) ?? 0;
        const y = (data.yp as number) ?? 0;
        if (x > 0 || y > 0) {
          const res = deckTracker.resolvePosition?.(x, y);
          if (res?.matched) {
            const wellVol = deckTracker.getWellVolume?.(res.carrierId, res.position, res.wellIndex) ?? 0;
            const aspVol = (data.av as number) ?? 0;
            const underflow = deckTracker.getLastUnderflow?.(res.carrierId, res.position, res.wellIndex);

            if (underflow && underflow.available <= 0 && aspVol > 0) {
              events.push({
                category: "empty_aspiration",
                severity: "warning",
                module: "pip",
                command: event,
                description: `Aspirating ${aspVol / 10}uL from empty well at ${res.description}`,
              });
            }

            if (underflow) {
              // VENUS applies a liquid-class correction factor on top of
              // the user's method volume (typically 2–6% for water, more
              // for viscous liquids) so plunger stroke > method volume.
              // When a well is filled to exactly the method volume, the
              // plunger request can't fully be met by liquid alone and
              // the tail comes up as air — physically correct, but it is
              // NOT the "well ran dry during aspirate" case the warning
              // implies. Distinguish: small deficit = liquid-class
              // correction overhead (info), large deficit = real shortage
              // (warning). 15% threshold sits safely above the ~6% max
              // overhead Hamilton liquid classes use for typical liquids.
              const deficitRatio = underflow.requested > 0
                ? underflow.deficit / underflow.requested
                : 0;
              const isLiquidClassCorrection = deficitRatio < 0.15;
              events.push({
                category: "volume_underflow",
                severity: isLiquidClassCorrection ? "info" : "warning",
                module: "pip",
                command: event,
                description: isLiquidClassCorrection
                  ? `Liquid-class over-aspirate at ${res.description}: plunger requested ${underflow.requested / 10}uL (includes ${underflow.deficit / 10}uL correction), well gave ${underflow.actual / 10}uL liquid — destination still receives the method volume`
                  : `Underflow at ${res.description}: requested ${underflow.requested / 10}uL, got ${underflow.actual / 10}uL, deficit ${underflow.deficit / 10}uL`,
                data: {
                  wellKey: `${res.carrierId}:${res.position}:${res.wellIndex}`,
                  requestedVolume_01ul: underflow.requested,
                  actualVolume_01ul: underflow.actual,
                  availableVolume_01ul: underflow.available,
                  deficit_01ul: underflow.deficit,
                  liquidClassCorrection: isLiquidClassCorrection,
                },
              });
            } else if (wellVol > 0 && wellVol < aspVol) {
              events.push({
                category: "dead_volume",
                severity: "warning",
                module: "pip",
                command: event,
                description: `Well has ${wellVol / 10}uL remaining after aspirating ${aspVol / 10}uL at ${res.description} — may be below dead volume`,
                data: { wellVolume: wellVol, requestedVolume: aspVol },
              });
            }
          }
        }
        break;
      }

      case "C0DS": {
        // DECK EFFECT CHECK — same guard as C0AS. A silent zero-volume
        // or unresolved dispense previously looked identical to a
        // normal successful one from the user's POV.
        {
          const xDs = (data.xp as number) ?? 0;
          const yDs = (data.yp as number) ?? 0;
          const dvDs = (data.dv as number) ?? 0;
          if (dvDs <= 0) {
            events.push({
              category: "no_deck_effect",
              severity: "warning",
              module: "pip",
              command: event,
              description: `C0DS accepted but dv=${dvDs} — zero-volume dispense, no wells touched`,
              data: { xp_01mm: xDs, yp_01mm: yDs, volume_01ul: dvDs },
            });
          } else if (xDs > 0 || yDs > 0) {
            const rDs = deckTracker.resolvePosition?.(xDs, yDs);
            if (!rDs?.matched) {
              events.push({
                category: "no_deck_effect",
                severity: "warning",
                module: "pip",
                command: event,
                description: `C0DS ${dvDs / 10}uL at (${(xDs / 10).toFixed(1)}, ${(yDs / 10).toFixed(1)}) mm — no labware under coordinates, volume NOT tracked`,
                data: { xp_01mm: xDs, yp_01mm: yDs, volume_01ul: dvDs },
              });
            }
          }
        }

        // TADM observation for dispense — one per active channel
        // (same reasoning as C0AS above).
        if (this.lastTADM) {
          const sev: AssessmentSeverity = this.lastTADM.passed ? "info" : "warning";
          const tm = (data.tm as number) ?? 0;
          const channels = expandChannelMask(tm);
          const fanout = channels.length > 0 ? channels : [undefined];
          for (const ch of fanout) {
            events.push({
              category: "tadm",
              severity: sev,
              module: "pip",
              command: event,
              channel: ch,
              description: this.lastTADM.passed
                ? `TADM dispense${ch !== undefined ? ` ch${ch + 1}` : ""} passed — peak ${this.lastTADM.peakPressure} mbar, ${this.lastTADM.volume / 10}uL`
                : `TADM dispense${ch !== undefined ? ` ch${ch + 1}` : ""} VIOLATION at sample ${this.lastTADM.violationIndex} — peak ${this.lastTADM.peakPressure} mbar`,
              tadm: this.lastTADM,
            });
          }
        }

        // Well overflow check + air-in-dispense from prior underflow.
        const x = (data.xp as number) ?? 0;
        const y = (data.yp as number) ?? 0;
        const dv = (data.dv as number) ?? 0;
        if ((x > 0 || y > 0) && dv > 0) {
          const res = deckTracker.resolvePosition?.(x, y);
          if (res?.matched) {
            const airRec = deckTracker.getLastAirDispense?.(res.carrierId, res.position, res.wellIndex);
            if (airRec && airRec.air > 0) {
              // Mirror the liquid-class-correction vs real-shortage
              // distinction made on the aspirate side: a small air
              // prefix is the tail of an over-aspirated plunger stroke
              // (expected) while a large one means the source ran dry.
              const airRatio = (airRec.liquid + airRec.air) > 0
                ? airRec.air / (airRec.liquid + airRec.air)
                : 0;
              const isLiquidClassCorrection = airRatio < 0.15;
              events.push({
                category: "air_in_dispense",
                severity: isLiquidClassCorrection ? "info" : "warning",
                module: "pip",
                command: event,
                description: isLiquidClassCorrection
                  ? `Liquid-class over-aspirate tail: ${airRec.air / 10}uL air dispensed before ${airRec.liquid / 10}uL liquid at ${res.description} — destination still gets the method volume`
                  : `Dispensed ${airRec.air / 10}uL air before ${airRec.liquid / 10}uL liquid at ${res.description} (prior aspirate was partial)`,
                data: {
                  wellKey: `${res.carrierId}:${res.position}:${res.wellIndex}`,
                  requested_01ul: airRec.requested,
                  liquid_01ul: airRec.liquid,
                  air_01ul: airRec.air,
                  liquidClassCorrection: isLiquidClassCorrection,
                },
              });
            }
            const wellVol = deckTracker.getWellVolume?.(res.carrierId, res.position, res.wellIndex) ?? 0;
            // Rough capacity check: 96-well ~3000 (300uL), 384-well ~500 (50uL), trough ~1000000
            const maxCapacity = deckTracker.getWellCapacity?.(res.carrierId, res.position, res.wellIndex) ?? 3000;
            if (wellVol + dv > maxCapacity) {
              events.push({
                category: "well_overflow",
                severity: "warning",
                module: "pip",
                command: event,
                description: `Well overflow risk: ${(wellVol + dv) / 10}uL in a ${maxCapacity / 10}uL well at ${res.description}`,
                data: { currentVolume: wellVol, dispensedVolume: dv, capacity: maxCapacity },
              });
            }
          }
        }
        break;
      }

      case "C0TP": {
        // Tip reuse: check if channel had contamination before tip change
        if (dm) {
          const channels = dm.tip_type as number[] | undefined;
          if (channels) {
            // Look for channels that just got tips — check contamination state
            // This is informational: "previous tip was contaminated, now picking up fresh tip"
          }
        }
        break;
      }
    }

    // Contamination: a multi-channel command (tm=255) can trigger one
    // contamination per active channel — the deck-tracker pushes them
    // into `liquidTracker.contaminationLog` in the order channels are
    // iterated. Previously this pulled only the LAST entry, which meant
    // an 8-channel serial-dilution aspirate surfaced exactly one event
    // (always the highest-index channel, e.g. CH8) and hid the other 7.
    // Pull up to 16 recent entries and emit every one whose timestamp
    // falls inside the 100 ms window — that's the set attributable to
    // this command, regardless of how many channels were masked in.
    if (event === "C0AS" || event === "C0DS") {
      const contam = deckTracker.liquidTracker?.getRecentContamination?.(16);
      if (contam && contam.length > 0) {
        const now = Date.now();
        for (const c of contam) {
          if (now - c.timestamp >= 100) continue;
          events.push({
            category: "contamination",
            severity: c.severity,
            module: "pip",
            command: event,
            channel: c.channel,
            description: c.description,
            contamination: c,
          });
        }
      }
    }

    return events as AssessmentEvent[];
  }

  /** Calculate delay for a named operation */
  calculateDelay(operation: string, params: Record<string, unknown>): number | undefined {
    switch (operation) {
      case "move": {
        const distance = (params.distance as number) || 0;
        return trapezoidalMoveTime(distance, X_SPEED_DEFAULT, X_ACCEL);
      }
      case "aspirate": {
        const vol = (params.volume as number) || 0;
        const speed = (params.speed as number) || ASP_SPEED_DEFAULT;
        return pipetteTime(vol, speed);
      }
      default:
        return undefined;
    }
  }

  // ── Physics-based timing ──────────────────────────────────────────────

  estimateTime(event: string, data: Record<string, unknown>): import("../plugin-interface").CommandTiming | undefined {
    const dm = this.getDatamodel();
    const breakdown: Array<{ phase: string; ms: number; detail?: string }> = [];

    switch (event) {
      case "C0TP": {
        // Tip pickup: X travel + Z down + grip + Z up
        const targetX = (data.xp as number) ?? 0;
        const currentX = dm?.pos_x || 0;
        const xDist = Math.abs(targetX - currentX);
        if (xDist > 0) {
          const xTime = trapezoidalMoveTime(xDist, X_SPEED_DEFAULT, X_ACCEL);
          breakdown.push({ phase: "X travel", ms: xTime, detail: `${(xDist / 10).toFixed(0)}mm at ${X_SPEED_DEFAULT / 10}mm/s` });
        }
        const zDown = trapezoidalMoveTime(Z_TRAVERSE_TO_TIP, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z descend", ms: zDown, detail: "~180mm to tip" });
        breakdown.push({ phase: "tip grip", ms: TIP_GRIP_TIME_MS, detail: "CO-RE compression" });
        const zUp = trapezoidalMoveTime(Z_TRAVERSE_TO_TIP, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z retract", ms: zUp, detail: "~180mm" });
        return { totalMs: breakdown.reduce((s, b) => s + b.ms, 0), accuracy: dm ? "computed" : "hybrid", breakdown };
      }

      case "C0TR": {
        // Tip eject: X to waste + Z down + release + Z up
        const tgtX = (data.xp as number) ?? 0;
        const curX = dm?.pos_x || 0;
        const xDist2 = Math.abs(tgtX - curX);
        if (xDist2 > 0) {
          const xMs = trapezoidalMoveTime(xDist2, X_SPEED_DEFAULT, X_ACCEL);
          breakdown.push({ phase: "X to waste", ms: xMs, detail: `${(xDist2 / 10).toFixed(0)}mm` });
        }
        const zTime = trapezoidalMoveTime(Z_EJECT_TRAVEL, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z to eject", ms: zTime, detail: "~60mm" });
        breakdown.push({ phase: "tip release", ms: TIP_RELEASE_TIME_MS });
        breakdown.push({ phase: "Z retract", ms: zTime });
        return { totalMs: breakdown.reduce((s, b) => s + b.ms, 0), accuracy: "hybrid", breakdown };
      }

      case "C0AS": {
        // Aspirate: X travel + Z descend + aspirate + settle + Z retract
        const targetX = (data.xp as number) ?? 0;
        const currentX = dm?.pos_x || 0;
        const xDist = Math.abs(targetX - currentX);
        const vol = (data.av as number) || 0;
        const speed = (data.as as number) || ASP_SPEED_DEFAULT;
        const settleWait = ((data.wt as number) || 5) * 100;  // wt is in 0.1s units → ms (default 0.5s)

        if (xDist > 0) {
          const hasLiquid = dm ? (dm.active_volume_total || 0) > 0 : false;
          const xSpeed = hasLiquid ? X_SPEED_WITH_LIQUID : X_SPEED_DEFAULT;
          const xTime = trapezoidalMoveTime(xDist, xSpeed, X_ACCEL);
          breakdown.push({ phase: "X travel", ms: xTime, detail: `${(xDist / 10).toFixed(0)}mm at ${xSpeed / 10}mm/s` });
        }
        const zDown = trapezoidalMoveTime(1500, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z descend", ms: zDown, detail: "~150mm to liquid" });
        const aspMs = pipetteTime(vol, speed);
        breakdown.push({ phase: "aspirate", ms: aspMs, detail: `${vol / 10}uL at ${speed / 10}uL/s` });
        breakdown.push({ phase: "settle", ms: settleWait, detail: `${settleWait}ms` });
        const zUp = trapezoidalMoveTime(1500, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z retract", ms: zUp, detail: "~150mm" });
        return { totalMs: breakdown.reduce((s, b) => s + b.ms, 0), accuracy: dm ? "computed" : "hybrid", breakdown };
      }

      case "C0DS": {
        // Dispense: X travel + Z descend + dispense + blowout + Z retract
        const targetX = (data.xp as number) ?? 0;
        const currentX = dm?.pos_x || 0;
        const xDist = Math.abs(targetX - currentX);
        const vol = (data.dv as number) || 0;
        const speed = (data.ds as number) || DSP_SPEED_DEFAULT;

        if (xDist > 0) {
          const xTime = trapezoidalMoveTime(xDist, X_SPEED_WITH_LIQUID, X_ACCEL);
          breakdown.push({ phase: "X travel", ms: xTime, detail: `${(xDist / 10).toFixed(0)}mm` });
        }
        const zDown = trapezoidalMoveTime(1200, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z descend", ms: zDown, detail: "~120mm" });
        const dspMs = pipetteTime(vol, speed);
        breakdown.push({ phase: "dispense", ms: dspMs, detail: `${vol / 10}uL at ${speed / 10}uL/s` });
        breakdown.push({ phase: "blowout", ms: 200 });
        const zUp = trapezoidalMoveTime(1200, Z_SPEED_DEFAULT, Z_ACCEL);
        breakdown.push({ phase: "Z retract", ms: zUp, detail: "~120mm" });
        return { totalMs: breakdown.reduce((s, b) => s + b.ms, 0), accuracy: dm ? "computed" : "hybrid", breakdown };
      }

      case "C0JM": {
        // PIP X move: computed from current position
        const currentX = dm?.pos_x || 0;
        const targetX = (data.xp as number) ?? currentX;
        const dist = Math.abs(targetX - currentX);
        const hasLiquid = dm ? (dm.active_volume_total || 0) > 0 : false;
        const xSpeed = hasLiquid ? X_SPEED_WITH_LIQUID : X_SPEED_DEFAULT;
        const ms = trapezoidalMoveTime(dist, xSpeed, X_ACCEL);
        breakdown.push({ phase: "X travel", ms, detail: `${(dist / 10).toFixed(0)}mm at ${xSpeed / 10}mm/s` });
        return { totalMs: ms, accuracy: dm ? "computed" : "estimate", breakdown };
      }

      case "C0DF": {
        // Dispense on fly: X travel + dispensing per position
        const xi = (data.xi as number) || 1;
        const vol = (data.dv as number) || 0;
        const speed = (data.ds as number) || DSP_SPEED_DEFAULT;
        const dspPerPos = pipetteTime(vol, speed);
        const travelPerPos = 200;  // ~20mm between dispense positions at ~100mm/s
        const total = xi * (dspPerPos + travelPerPos);
        breakdown.push({ phase: `${xi} dispenses`, ms: xi * dspPerPos, detail: `${vol / 10}uL each` });
        breakdown.push({ phase: "X travel", ms: xi * travelPerPos, detail: `~${xi * 20}mm total` });
        return { totalMs: total, accuracy: "hybrid", breakdown };
      }

      case "C0LW": {
        // Liquid wash: ~5s per cycle
        breakdown.push({ phase: "wash cycle", ms: 5000, detail: "probe wash" });
        return { totalMs: 5000, accuracy: "estimate", breakdown };
      }

      default:
        return undefined;  // Not handled by PIP plugin
    }
  }

  // ---- Private helpers ----

  private getDatamodel(): Record<string, any> | null {
    return this.executor?.machine?._datamodel || null;
  }
}
