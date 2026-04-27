/**
 * Arm animation.
 *
 * Two path cases:
 *   (1) Server published a MotionEnvelope for this arm — sample it by wall
 *       clock for the duration the physics layer computed. This produces a
 *       smooth trajectory in real time that matches the FW-level timing.
 *   (2) No envelope for this arm — fall back to the legacy per-frame ease
 *       toward the target. Kept for state-only updates (e.g., reset snap).
 *
 * Server emits envelopes for motion-producing FW commands (C0JM, C0TP, C0TR,
 * C0AS, C0DS, C0EM, C0PP, etc.) — see digital-twin.extractMotionEnvelope.
 */
/// <reference path="state.ts" />

namespace Twin {
  export namespace Arm {

    /** Mirrors the server-side MotionEnvelope. All optional axes are
     *  absent when the command doesn't move them — we interpolate only
     *  what's present so a pure-X move doesn't accidentally zero Z. */
    interface MotionEnvelope {
      arm: "pip" | "iswap" | "h96" | "h384" | "autoload";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      startZ?: number;
      endZ?: number;
      /** Mid-motion Z waypoint — used by C0AS/C0DS so the arm visibly
       *  dives into the well and retracts rather than linearly
       *  interpolating startZ → endZ. See digital-twin.ts for the
       *  three-phase profile. */
      dwellZ?: number;
      /** Safe-height Z the sampler retracts to before XY travel (CNC-
       *  style motion). When present AND the envelope has meaningful
       *  XY delta, Z rises to traverseZ first, XY travels at safe
       *  height, then Z descends to endZ / dwellZ. Mirrors the server
       *  `traverseZ` field added with per-channel support. */
      traverseZ?: number;
      /** Per-channel Y/Z targets (0.1 mm, length = channel_count). Each
       *  PIP channel has its own Y drive and its own Z drive so one
       *  channel can land at Y=1000 while its neighbour lands at
       *  Y=2000 — that's exactly what "channel spread" looks like. If
       *  these are present we sample per-channel; if absent we fall
       *  back to the single arm-wide startY/endY/startZ/endZ. */
      startY_ch?: number[];
      endY_ch?: number[];
      startZ_ch?: number[];
      endZ_ch?: number[];
      /** Per-channel dwell Z for aspirate/dispense/tip-pickup — one
       *  channel may sit deeper than another when wells have different
       *  depths or the labware is at a height gradient. */
      dwellZ_ch?: number[];
      startRotation?: number;   // degrees (0 or 90 for iSWAP gr flag)
      endRotation?: number;
      startGripWidth?: number;  // 0.1 mm jaw-to-jaw
      endGripWidth?: number;
      startPlateWidth?: number;  // 0.1 mm — held-plate footprint X
      endPlateWidth?: number;
      startPlateHeight?: number; // 0.1 mm — held-plate footprint Y
      endPlateHeight?: number;
      startTime: number;    // Date.now() on the server at emit
      durationMs: number;
      command: string;
    }

    /** Active envelope per arm, plus the local wall-clock baseline we started
     *  sampling at. We use performance.now() client-side; startTimeLocal is the
     *  anchor so we don't depend on client/server clock skew. */
    interface ActiveEnvelope extends MotionEnvelope {
      startTimeLocal: number;  // performance.now() when registered
      effectiveDurationMs: number;  // after simSpeed scaling
    }

    const active: Map<string, ActiveEnvelope> = new Map();
    /** The most recent envelopes (any arm), kept for the trajectory overlay. */
    export function getActiveEnvelopes(): ActiveEnvelope[] {
      return [...active.values()];
    }

    /** Read the user's protocol sim-speed select, if present. Returns 0 for
     *  "Instant" (skip envelope animation entirely), otherwise a multiplier.
     *  Matches protocol.ts getSimSpeed() — same element. */
    function getSimSpeed(): number {
      const el = document.getElementById("sim-speed") as HTMLSelectElement | null;
      if (!el) return 1;
      const v = Number(el.value);
      return Number.isFinite(v) ? v : 1;
    }

    /** Clamp to [0, 1] and run smoothstep so the start/end of the move taper
     *  (visually close to a trapezoidal velocity profile). */
    function smoothstep(t: number): number {
      const c = Math.max(0, Math.min(1, t));
      return c * c * (3 - 2 * c);
    }

    /** Called by the SSE listener when the server emits a motion event. */
    export function onMotionEnvelope(env: MotionEnvelope): void {
      const simSpeed = getSimSpeed();
      if (simSpeed <= 0) {
        // Instant mode — no envelope animation; the subsequent state update
        // will snap the target. Drop any old envelope for this arm.
        active.delete(env.arm);
        return;
      }
      // Envelope duration in wall clock. `simSpeed` is a multiplier matching
      // applySimSpeed()'s convention: 0.5 = "2x Speed" (animation plays in
      // half the wall-clock time), 2.0 = "Half Speed" (twice as long). The
      // dropdown labels in index.html read the same way, and the server-side
      // applySimSpeed also multiplies. An earlier version divided here,
      // which inverted the dropdown (0.5 ran 2× SLOWER, defeating the
      // whole control) — #62 fix 2026-04-19. Clamp to a minimum so very
      // short moves (eject Z bob, intra-well shift) still show some travel.
      const MIN_MS = 150;
      const effective = Math.max(MIN_MS, env.durationMs * simSpeed);
      active.set(env.arm, {
        ...env,
        startTimeLocal: performance.now(),
        effectiveDurationMs: effective,
      });
      if (!State.animActive) {
        State.animActive = true;
        requestAnimationFrame(animate);
      }
    }

    /** Linear interpolation for an optional axis. If either endpoint is
     *  undefined the axis isn't being animated; return undefined so the
     *  caller can preserve existing State for that axis. */
    function lerpOptional(start: number | undefined, end: number | undefined, t: number): number | undefined {
      if (start === undefined || end === undefined) return undefined;
      return start + (end - start) * t;
    }

    /** Nominal STAR axis speeds in 0.1 mm / ms — used to partition the
     *  envelope duration into physical-time-proportional phases. Source:
     *  `src/twin/command-timing.ts` SPEED constants (pipX = 800 mm/s,
     *  pipZ = 300 mm/s). 1 mm/s = 0.01 units/ms, so 800 mm/s = 8, 300
     *  mm/s = 3. Earlier versions used fixed 15% / 20% phase fractions
     *  which squeezed a 190 mm Z descend into 15% of the envelope — at
     *  a 700 ms C0JM that left only ~100 ms for the descent, making
     *  the arm appear to snap rather than travel. Physical
     *  proportioning makes each phase take the time it would physically
     *  take, letting the aspirate-plunger-hold phase absorb whatever
     *  time is left over from the server's envelope duration.
     *
     *  Minimum per-phase duration (MIN_PHASE_MS) prevents sub-frame
     *  phases from collapsing invisibly when a distance is tiny but
     *  non-zero (e.g. a 2 mm Z nudge). */
    const Z_SPEED_UNITS_PER_MS = 3;
    const XY_SPEED_UNITS_PER_MS = 8;
    const MIN_PHASE_MS = 40;

    /** Compute the phase-end fractions of the envelope duration in
     *  physical-time order:
     *    [0, retract):       Z retracts start → peakZ
     *    [retract, travel):  XY travels, Z at peakZ
     *    [travel, descend):  Z descends peakZ → (dwellZ or endZ)
     *    [descend, hold):    at dwellZ (plunger / grip time — only if dwell)
     *    [hold, 1]:          Z retracts dwellZ → endZ (only if dwell)
     *
     *  For the in-place dwell (aspirate/dispense with no XY), the
     *  retract and travel phases are zero-width so the profile
     *  degenerates to descend → hold → retract-end with correct
     *  proportions — matches the previous 20/60/20 aspirate cadence
     *  when durationMs is the old 1.5 s estimate.
     */
    interface PhaseBoundaries {
      retract: number;
      travel: number;
      descend: number;
      hold: number;
      // endRetract boundary is always 1.
    }
    function computePhaseBoundaries(
      startZ: number,
      endZ: number,
      dwellZ: number | undefined,
      peakZ: number,
      xyDist: number,
      totalMs: number,
      hasXY: boolean,
    ): PhaseBoundaries {
      const hasDwell = dwellZ !== undefined;
      const dRetract = Math.abs(startZ - peakZ);
      const dDescend = hasDwell ? Math.abs(dwellZ - peakZ) : Math.abs(endZ - peakZ);
      const dEndRetract = hasDwell ? Math.abs(endZ - dwellZ) : 0;
      const dXY = hasXY ? xyDist : 0;

      // Base physical times per phase.
      let tRetract = dRetract / Z_SPEED_UNITS_PER_MS;
      let tTravel  = dXY / XY_SPEED_UNITS_PER_MS;
      let tDescend = dDescend / Z_SPEED_UNITS_PER_MS;
      let tEndRet  = dEndRetract / Z_SPEED_UNITS_PER_MS;

      // Bump any phase with real work below MIN_PHASE_MS up to the floor
      // so the animation is visible. Phases with zero work stay at zero.
      if (dRetract > 0 && tRetract < MIN_PHASE_MS) tRetract = MIN_PHASE_MS;
      if (dXY      > 0 && tTravel  < MIN_PHASE_MS) tTravel  = MIN_PHASE_MS;
      if (dDescend > 0 && tDescend < MIN_PHASE_MS) tDescend = MIN_PHASE_MS;
      if (dEndRetract > 0 && tEndRet < MIN_PHASE_MS) tEndRet = MIN_PHASE_MS;

      // Hold time = whatever the envelope gives us beyond physical travel.
      // Negative means the envelope is shorter than the physical motion
      // would take (server squeezed the estimate); we clamp at 0 and the
      // phases will scale proportionally to fit.
      const tPhysical = tRetract + tTravel + tDescend + tEndRet;
      const tHold = Math.max(0, totalMs - tPhysical);
      const tTotal = tPhysical + tHold;

      if (tTotal <= 0) {
        // Degenerate: no motion, no time. Collapse everything to the end.
        return { retract: 0, travel: 0, descend: 0, hold: 0 };
      }

      const retract = tRetract / tTotal;
      const travel  = retract + tTravel / tTotal;
      const descend = travel + tDescend / tTotal;
      const hold    = descend + tHold / tTotal;
      return { retract, travel, descend, hold };
    }

    /** Safe Z during the XY travel phase.
     *
     *  Hamilton convention (verified against well-geometry.simulateLLD
     *  and the pip-command-catalog trace values):
     *    pos_z = HEIGHT OF THE TIP ABOVE THE DECK SURFACE in 0.1 mm.
     *    Bigger pos_z = higher physically (safer, more retracted).
     *    Smaller pos_z = lower (closer to deck / inside a well).
     *
     *  So "safe during travel" = the HIGHEST of the start, end, and
     *  traverse heights — MAX, not min. An earlier version used MIN
     *  (inherited from an inverted-convention mental model) which
     *  made channels dive toward the deck during travel. User caught
     *  it: "tips never touch the labware" → the mapping was upside-
     *  down throughout the 3D + sampler path (2026-04-24).
     *
     *  dwellZ is EXCLUDED because it's the intentional LOW target
     *  (aspirate descends into well, tip pickup inserts into rack).
     *  We travel at the safe height and only descend to dwellZ in the
     *  dedicated descend phase.
     */
    function safeTravelZ(startZ: number, endZ: number, traverseZ: number | undefined): number {
      return traverseZ !== undefined
        ? Math.max(startZ, endZ, traverseZ)
        : Math.max(startZ, endZ);
    }

    /** Sample ONE Z axis through the CNC-style motion profile at raw
     *  fraction `r` given physical-distance phase boundaries. Phases:
     *   [0, retract): Z retracts startZ → peakZ
     *   [retract, travel): XY travels, Z held at peakZ
     *   [travel, descend): Z descends peakZ → (dwellZ or endZ)
     *   [descend, hold): hold at dwellZ (plunger / grip)
     *   [hold, 1]: Z retracts dwellZ → endZ
     *
     *  When there's no dwell, the descend phase goes straight to endZ
     *  and the hold/end-retract phases are zero-width (b.hold === 1).
     *  When there's no XY, the retract/travel phases are zero-width. */
    function sampleZFromPhases(
      r: number,
      startZ: number,
      endZ: number,
      dwellZ: number | undefined,
      peakZ: number,
      b: PhaseBoundaries,
    ): number {
      const rC = Math.max(0, Math.min(1, r));
      const hasDwell = dwellZ !== undefined;
      const lerp = (a: number, z: number, t: number): number => a + (z - a) * smoothstep(t);

      if (rC < b.retract && b.retract > 0) {
        return lerp(startZ, peakZ, rC / b.retract);
      }
      if (rC < b.travel) {
        return peakZ;
      }
      if (rC < b.descend && b.descend > b.travel) {
        const target = hasDwell ? dwellZ! : endZ;
        return lerp(peakZ, target, (rC - b.travel) / (b.descend - b.travel));
      }
      if (!hasDwell) {
        return endZ;
      }
      if (rC < b.hold) {
        return dwellZ!;  // plunger / grip hold
      }
      if (b.hold < 1) {
        return lerp(dwellZ!, endZ, (rC - b.hold) / (1 - b.hold));
      }
      return endZ;
    }

    /** What fraction of the envelope XY is active in. XY animates only
     *  between b.retract and b.travel — frozen at start before and at
     *  end after. Same boundaries as sampleZFromPhases so the 2D / 3D
     *  arm moves its XY in lockstep with Z's travel-phase plateau. */
    function computeXYFraction(b: PhaseBoundaries): { x0: number; x1: number } {
      return { x0: b.retract, x1: b.travel };
    }

    /** Sample an envelope at the given local time. Returns the
     *  interpolated value on every axis the envelope carries — arm-wide
     *  X/Y/Z and optional per-channel Y/Z arrays when the envelope
     *  carries channel-level detail. */
    function sampleEnvelope(env: ActiveEnvelope, now: number): {
      x: number; y: number;
      z?: number; rotation?: number; gripWidth?: number;
      plateWidth?: number; plateHeight?: number;
      /** Per-channel Y/Z at this time, one entry per channel. Absent
       *  when the envelope is arm-wide (iSWAP, h96, h384, autoload). */
      y_ch?: number[];
      z_ch?: number[];
      done: boolean;
    } {
      const elapsed = now - env.startTimeLocal;
      const raw = env.effectiveDurationMs <= 0 ? 1 : elapsed / env.effectiveDurationMs;
      const rClamped = Math.max(0, Math.min(1, raw));

      const hasXY = Math.abs(env.endX - env.startX) > 0.5
                 || Math.abs(env.endY - env.startY) > 0.5;
      const xyDist = Math.hypot(env.endX - env.startX, env.endY - env.startY);

      // Compute phase boundaries from physical distances once for the
      // arm-wide axes. Per-channel Z uses its own boundaries (each
      // channel may have a different descent distance), but all share
      // the same XY travel window — otherwise the head body would
      // distort. Using the arm-wide min/max startZ to drive the shared
      // retract/travel/endRetract window keeps all pins synchronised.
      const armPeakZ = env.startZ !== undefined && env.endZ !== undefined
        ? safeTravelZ(env.startZ, env.endZ, env.traverseZ)
        : 0;
      const armBoundaries = env.startZ !== undefined && env.endZ !== undefined
        ? computePhaseBoundaries(env.startZ, env.endZ, env.dwellZ, armPeakZ, xyDist, env.effectiveDurationMs, hasXY)
        : { retract: 0, travel: hasXY ? 1 : 0, descend: 1, hold: 1 };
      const { x0, x1 } = computeXYFraction(armBoundaries);
      const xyFrac = rClamped <= x0 ? 0
                    : rClamped >= x1 ? 1
                    : x1 > x0 ? (rClamped - x0) / (x1 - x0) : 1;
      const xyT = smoothstep(xyFrac);

      let z: number | undefined;
      if (env.startZ !== undefined && env.endZ !== undefined) {
        z = sampleZFromPhases(rClamped, env.startZ, env.endZ, env.dwellZ, armPeakZ, armBoundaries);
      } else {
        z = lerpOptional(env.startZ, env.endZ, smoothstep(rClamped));
      }

      // Per-channel sampling — each channel's Y uses the shared XY
      // window (all channels travel together in XY), and each channel's
      // Z uses its own phase boundaries (different dip depths give
      // different descent distances). The shared retract/travel window
      // keeps the head carriage rigid in XY while the pins can extend
      // independently in Z.
      let y_ch: number[] | undefined;
      let z_ch: number[] | undefined;
      if (env.startY_ch && env.endY_ch) {
        y_ch = new Array(env.startY_ch.length);
        for (let i = 0; i < env.startY_ch.length; i++) {
          y_ch[i] = env.startY_ch[i] + (env.endY_ch[i] - env.startY_ch[i]) * xyT;
        }
      }
      if (env.startZ_ch && env.endZ_ch) {
        z_ch = new Array(env.startZ_ch.length);
        for (let i = 0; i < env.startZ_ch.length; i++) {
          const s0 = env.startZ_ch[i];
          const s1 = env.endZ_ch[i];
          const dwell = env.dwellZ_ch?.[i] ?? env.dwellZ;
          const chPeak = safeTravelZ(s0, s1, env.traverseZ);
          // Per-channel phase boundaries, but clamped to the shared XY
          // window so all channels advance through retract/travel/descend
          // at the same rate (otherwise faster channels would finish
          // descend before slower ones and the head would look ragged).
          const chBoundaries: PhaseBoundaries = {
            retract: armBoundaries.retract,
            travel: armBoundaries.travel,
            descend: armBoundaries.descend,
            hold: armBoundaries.hold,
          };
          z_ch[i] = sampleZFromPhases(rClamped, s0, s1, dwell, chPeak, chBoundaries);
        }
      }

      return {
        x: env.startX + (env.endX - env.startX) * xyT,
        y: env.startY + (env.endY - env.startY) * xyT,
        z,
        rotation: lerpOptional(env.startRotation, env.endRotation, smoothstep(rClamped)),
        gripWidth: lerpOptional(env.startGripWidth, env.endGripWidth, smoothstep(rClamped)),
        // Plate dims don't animate meaningfully — on C0PP both endpoints
        // are the same resolved-labware width/height; on C0PR the field
        // is absent. `lerpOptional` returning undefined when absent is
        // exactly what we want: the iswap writer preserves the last
        // set value, which matches the physical picture (same plate
        // held throughout a grip session).
        plateWidth: lerpOptional(env.startPlateWidth, env.endPlateWidth, smoothstep(rClamped)),
        plateHeight: lerpOptional(env.startPlateHeight, env.endPlateHeight, smoothstep(rClamped)),
        y_ch,
        z_ch,
        done: raw >= 1,
      };
    }

    /** Arm-specific writers for Z / rotation / grip-width. Each takes a
     *  sample and pushes the axes it understands into State. Invoked
     *  every animation frame when the matching arm has an active envelope. */
    const extraAxisWriters: Partial<Record<ActiveEnvelope["arm"], (s: ReturnType<typeof sampleEnvelope>) => void>> = {
      pip: (s) => {
        if (s.z !== undefined) {
          State.animPipZ = s.z;
          // Mirror the animated Z onto the per-channel Z-depth bars so
          // they move in sync with the arm descent/retract. Static
          // pos_z[i] only updates at end-of-command via SSE, which is
          // too late for users to see the aspirate travel. #62 follow-up.
          Channels.updateAnimatedPipZ?.(s.z, s.z_ch);
        }
        // Per-channel Y/Z for the 2D arm and 3D channels. State.animPipY_ch
        // / State.animPipZ_ch hold the live per-channel positions; the
        // deck-svg render reads them to draw each channel at its own
        // Y/Z rather than a rigid 8-block at the ch0-equivalent Y.
        if (s.y_ch) State.animPipY_ch = s.y_ch;
        if (s.z_ch) State.animPipZ_ch = s.z_ch;
      },
      iswap: (s) => {
        if (s.z !== undefined) State.animIswapZ = s.z;
        if (s.rotation !== undefined) State.animIswapRotationDeg = s.rotation;
        if (s.gripWidth !== undefined) State.animIswapGripWidth = s.gripWidth;
        if (s.plateWidth !== undefined) State.animIswapPlateWidth = s.plateWidth;
        if (s.plateHeight !== undefined) State.animIswapPlateHeight = s.plateHeight;
      },
      h96: (s) => { if (s.z !== undefined) State.animH96Z = s.z; },
      h384: (s) => { if (s.z !== undefined) State.animH384Z = s.z; },
    };

    export function startAnimation(pipX: number, iswapX: number, pipY?: number): void {
      State.targetPipX = pipX;
      State.targetIswapX = iswapX;
      if (pipY !== undefined) State.targetPipY = pipY;
      if (!State.animActive) {
        State.animActive = true;
        requestAnimationFrame(animate);
      }
    }

    /** For each arm, either sample the active envelope (if present) or fall
     *  back to the legacy per-frame ease toward `targetX/Y`. */
    function stepArm(
      now: number,
      arm: ActiveEnvelope["arm"],
      getCurrent: () => { x: number; y: number },
      setCurrent: (x: number, y: number) => void,
      getTarget: () => { x: number; y: number },
    ): boolean {
      const env = active.get(arm);
      if (env) {
        const sample = sampleEnvelope(env, now);
        setCurrent(sample.x, sample.y);
        extraAxisWriters[arm]?.(sample);
        if (sample.done) {
          // Pin every axis the envelope carried — including optional
          // ones — so the rendered state lines up exactly with what
          // the server's post-command state update will confirm next.
          setCurrent(env.endX, env.endY);
          extraAxisWriters[arm]?.({
            x: env.endX, y: env.endY,
            z: env.endZ, rotation: env.endRotation, gripWidth: env.endGripWidth,
            plateWidth: env.endPlateWidth, plateHeight: env.endPlateHeight,
            y_ch: env.endY_ch, z_ch: env.endZ_ch,
            done: true,
          });
          active.delete(arm);
          return true;  // done
        }
        return false;   // still animating
      }
      // No envelope — legacy ease toward target.
      const ease = 0.12;
      const threshold = 0.1;
      const cur = getCurrent();
      const tgt = getTarget();
      const nx = cur.x + (tgt.x - cur.x) * ease;
      const ny = cur.y + (tgt.y - cur.y) * ease;
      setCurrent(nx, ny);
      return Math.abs(tgt.x - nx) < threshold && Math.abs(tgt.y - ny) < threshold;
    }

    export function animate(): void {
      const now = performance.now();

      const pipDone = stepArm(now, "pip",
        () => ({ x: State.animPipX, y: State.animPipY }),
        (x, y) => { State.animPipX = x; State.animPipY = y; },
        () => ({ x: State.targetPipX, y: State.targetPipY }),
      );
      const iswapDone = stepArm(now, "iswap",
        () => ({ x: State.animIswapX, y: State.animIswapY }),
        (x, y) => { State.animIswapX = x; State.animIswapY = y; },
        () => ({ x: State.targetIswapX, y: State.targetIswapY }),
      );
      const h96Done = stepArm(now, "h96",
        () => ({ x: State.animH96X, y: State.animH96Y }),
        (x, y) => { State.animH96X = x; State.animH96Y = y; },
        () => ({ x: State.targetH96X, y: State.targetH96Y }),
      );
      // h384 was single-axis; the envelope now carries Y and Z too.
      const h384Done = stepArm(now, "h384",
        () => ({ x: State.animH384X, y: State.animH384Y }),
        (x, y) => { State.animH384X = x; State.animH384Y = y; },
        () => ({ x: State.targetH384X, y: State.targetH384Y }),
      );
      const autoloadDone = stepArm(now, "autoload",
        () => ({ x: State.animAutoloadX, y: 0 }),
        (x) => { State.animAutoloadX = x; },
        () => ({ x: State.targetAutoloadX, y: 0 }),
      );

      // Ease the optional axes (Z / rotation / grip) toward their
      // targets when no envelope is driving them. This mirrors the X/Y
      // fallback in stepArm and stays in sync with the server-side
      // post-command state update.
      const extraEase = 0.18;
      const easeTo = (cur: number, tgt: number): number => cur + (tgt - cur) * extraEase;
      if (!active.has("pip")) State.animPipZ = easeTo(State.animPipZ, State.targetPipZ);
      if (!active.has("iswap")) {
        State.animIswapZ = easeTo(State.animIswapZ, State.targetIswapZ);
        State.animIswapRotationDeg = easeTo(State.animIswapRotationDeg, State.targetIswapRotationDeg);
        State.animIswapGripWidth = easeTo(State.animIswapGripWidth, State.targetIswapGripWidth);
      }
      if (!active.has("h96")) State.animH96Z = easeTo(State.animH96Z, State.targetH96Z);
      if (!active.has("h384")) State.animH384Z = easeTo(State.animH384Z, State.targetH384Z);

      // Do NOT snap animX/Y to targetX/Y after the envelope path
      // completes. The envelope pins to env.endX/Y in stepArm, which is
      // the correct visual position at that instant. The post-command
      // `target*` values update via SSE `state_change`, which can arrive
      // on a LATER frame than the envelope ends (setTimeout-commit +
      // event-loop scheduling). Snapping here would overwrite the pinned
      // end with a STALE pre-command target, briefly snapping the arm
      // back to its old position — and the legacy ease in the next frame
      // would then "replay" the motion toward the freshly-arrived
      // target. That's the post-envelope jump / replay reported
      // 2026-04-20. Letting the legacy ease in stepArm handle residual
      // epsilon (~0.01 mm) is invisible; the brief snap-back was not.

      DeckSVG.updateArm();
      DeckSVG.updateTracking();

      State.deckGlows = State.deckGlows.filter(g => now - g.startTime < g.duration);
      const hasGlows = State.deckGlows.length > 0;
      const anyEnvelope = active.size > 0;

      if (!pipDone || !iswapDone || !h96Done || !h384Done || !autoloadDone || hasGlows || anyEnvelope) {
        requestAnimationFrame(animate);
      } else {
        State.animActive = false;
      }
    }

    /** Update arm targets from all module variables. */
    export function updateDeckArm(
      pipVars: Record<string, unknown>,
      iswapVars: Record<string, unknown>,
      h96Vars?: Record<string, unknown>,
      h384Vars?: Record<string, unknown>,
      autoloadVars?: Record<string, unknown>,
    ): void {
      if (!State.deckData) return;
      const newPipX = (pipVars["pos_x"] as number) || 0;
      const newIswapX = (iswapVars["pos_x"] as number) || 0;
      const posY = pipVars["pos_y"] as number[];
      // pos_y[j] only gets updated for channels in the command mask, so
      // pos_y[0] can be stale when pickup/aspirate/dispense targets a
      // non-ch0 subset (e.g. tm=0x24 → only ch2,5 move). Back-calculate a
      // consistent ch0-equivalent Y from whichever channel was most recently
      // commanded: pos_y[j] = yp - j*90 ⇒ yp = pos_y[j] + j*90.
      let newPipY = posY?.[0] || 0;
      if (!newPipY && posY) {
        for (let j = 1; j < posY.length; j++) {
          if (posY[j]) { newPipY = posY[j] + j * 90; break; }
        }
      }
      // No fallback to mid-deck: at power-on pos_y is all zeros and the real
      // arm is parked at home (Y≈0). Faking a mid-deck Y made the arm appear
      // suspended and hid actual movement on the first commanded Y.

      // PIP Z: per-channel array. The deck arm viz uses the deepest
      // engaged channel (max Z) so when any channel dips into labware
      // the head drop is visible; channel panel shows each individually.
      const posZ = pipVars["pos_z"] as number[];
      if (Array.isArray(posZ)) {
        let maxZ = 0;
        for (const z of posZ) if (z > maxZ) maxZ = z;
        State.targetPipZ = maxZ;
      }

      // iSWAP full state — server SCXML keeps X/Y/Z/rotation/grip in sync,
      // so we just copy them as the resting target. Active envelopes
      // drive the animated values; these take over once envelopes end.
      State.targetIswapY = (iswapVars["pos_y"] as number) || 0;
      State.targetIswapZ = (iswapVars["pos_z"] as number) || 0;
      State.targetIswapRotationDeg = (iswapVars["plate_rotation_deg"] as number) || 0;
      State.targetIswapGripWidth = (iswapVars["grip_width_01mm"] as number) || 0;

      // 96-head position — pass Y/Z through from the datamodel without a
      // fake mid-deck fallback (for the same reason as pip).
      if (h96Vars) {
        State.targetH96X = (h96Vars["pos_x"] as number) || 0;
        State.targetH96Y = (h96Vars["pos_y"] as number) || 0;
        State.targetH96Z = (h96Vars["pos_z"] as number) || 0;
      }
      // 384-head — previously X-only; Y and Z now fed from the datamodel.
      if (h384Vars) {
        State.targetH384X = (h384Vars["pos_x"] as number) || 0;
        State.targetH384Y = (h384Vars["pos_y"] as number) || 0;
        State.targetH384Z = (h384Vars["pos_z"] as number) || 0;
      }

      // AutoLoad carriage — target X is the track the carriage is moving
      // toward. During load/unload, the SCXML updates `target_track`
      // before `pos_track` lands, so prefer `target_track` when it
      // differs. pos_track === 0 means parked at the home tray → hide
      // carriage on the deck.
      if (autoloadVars) {
        const posTrack = (autoloadVars["pos_track"] as number) ?? 0;
        const tgtTrack = (autoloadVars["target_track"] as number) ?? posTrack;
        State.autoloadParked = posTrack === 0 && tgtTrack === 0;
        const visibleTrack = tgtTrack || posTrack;
        if (State.deckData && visibleTrack > 0) {
          // trackToX matches the server's deck.ts formula. Both xOffset
          // and trackPitch travel on the snapshot's `dimensions` record
          // (see DeckSnapshot.dimensions) so renderer and server stay
          // in lock-step across STAR/STARlet/custom platforms.
          const dims: any = (State.deckData as any).dimensions ?? {};
          const xOffset = dims.xOffset ?? (State.deckData as any).xOffset ?? 1000;
          const trackPitch = dims.trackPitch ?? 225;
          State.targetAutoloadX = xOffset + (visibleTrack - 1) * trackPitch;
          if (State.animAutoloadX === 0) State.animAutoloadX = State.targetAutoloadX;
        }
      }

      startAnimation(newPipX, newIswapX, newPipY);
    }
  }
}
