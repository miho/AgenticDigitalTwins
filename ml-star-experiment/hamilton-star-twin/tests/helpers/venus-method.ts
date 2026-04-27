/**
 * Scripted Stage-5 method runner (#54).
 *
 * Drives an Initialize → Tip Pickup → Aspirate → Dispense → Tip Eject
 * sequence against the twin without clicking through VENUS's Method
 * Editor. Two backends:
 *
 *   - `via: "twin-http"` (default) — talks to the twin's REST
 *     `/command` endpoint. Fast, requires no Hamilton install,
 *     ideal for CI.
 *   - `via: "venus-web-api"` — talks to Hamilton's Web API so a
 *     real VENUS 6.0.2 drives the twin. Gated behind a
 *     `venusHost` option (or the `VENUS_HOST` env var when called
 *     from vitest); skipped cleanly when not configured.
 *
 * The method description is deck-agnostic — carrier IDs + site +
 * well letters stay symbolic and are resolved against the deck
 * snapshot at run time. That keeps the API readable in tests:
 *
 *     await runVenusMethod(server, {
 *       initialize: true,
 *       tipPickup: { carrier: "TIP001", pos: 0, wellA1: true, channels: 8 },
 *       aspirate:  { carrier: "SMP001", pos: 0, wellA1: true, volumeUl: 100 },
 *       dispense:  { carrier: "DST001", pos: 0, wellA1: true, volumeUl: 100 },
 *       tipEject:  "waste",
 *     });
 *
 * Returns a `RunResult` with the raw command/response log + summary
 * flags the caller can assert on.
 */

import type { TestTwin } from "./in-process";

// ============================================================================
// Method description
// ============================================================================

export interface TipPickupStep {
  carrier: string;
  pos: number;
  /** When true, target well A1 of the labware. */
  wellA1?: boolean;
  /** Override: raw well index (0 = A1). */
  wellIdx?: number;
  /** 1..8 PIP channels; defaults to 8 (tm=255). */
  channels?: number;
  /** Tip-type code (matches `tt` FW param). Defaults to 04 (standard tip). */
  tipType?: string;
}

export interface PipetteStep {
  carrier: string;
  pos: number;
  wellA1?: boolean;
  wellIdx?: number;
  /** Volume in µL. */
  volumeUl: number;
  /** 1..8 PIP channels; defaults to 8 (tm=255). */
  channels?: number;
}

export type TipEjectTarget = "waste" | "rack";

export interface MethodDescription {
  initialize?: boolean;
  tipPickup?: TipPickupStep;
  aspirate?: PipetteStep;
  dispense?: PipetteStep;
  tipEject?: TipEjectTarget;
}

export interface RunResult {
  /** One entry per FW command sent: { raw, response, errorCode, ok }. */
  log: Array<{
    raw: string;
    response: string;
    errorCode: number;
    ok: boolean;
    step: string;
  }>;
  /** True when every step's errorCode === 0. */
  success: boolean;
}

// ============================================================================
// Backend protocol
// ============================================================================

/** A minimal abstraction so the same `runVenusMethod` logic can drive
 *  either the twin directly or a real VENUS instance. */
export interface MethodBackend {
  /** Human name for log/error messages. */
  readonly name: string;
  /** Fire a raw FW command and wait for the device's reply. */
  sendFw(raw: string): Promise<{ response: string; errorCode: number; ok: boolean }>;
  /** Return a fresh deck snapshot (for well-coordinate resolution). */
  getDeck(): Promise<any>;
}

// ============================================================================
// Compiler — method → FW commands
// ============================================================================

function pad5(n: number): string {
  return Math.max(0, Math.min(99999, Math.round(n))).toString().padStart(5, "0");
}

function channelsToMask(channels: number | undefined): number {
  const n = Math.max(1, Math.min(8, channels ?? 8));
  return (1 << n) - 1;   // 1→1, 2→3, 4→15, 8→255
}

/** Resolve a carrier+pos+well-A1 reference to deck-Y/X (0.1 mm). */
function resolveWellXY(deck: any, step: { carrier: string; pos: number; wellA1?: boolean; wellIdx?: number }): { x: number; y: number } {
  const carrier = (deck.carriers ?? []).find((c: any) => c.id === step.carrier);
  if (!carrier) throw new Error(`runVenusMethod: carrier '${step.carrier}' not found on deck`);
  const labware = carrier.labware?.[step.pos];
  if (!labware) throw new Error(`runVenusMethod: no labware at ${step.carrier} pos ${step.pos}`);
  const cols = labware.columns ?? (labware.wellCount > 96 ? 24 : 12);
  const wellPitch = labware.wellPitch ?? 90;
  const offsetX = labware.offsetX ?? 145;
  const offsetY = labware.offsetY ?? 745;
  // siteYOffsets may be set on the carrier snapshot
  const siteY = Array.isArray(carrier.siteYOffsets) ? carrier.siteYOffsets[step.pos] : null;
  const baseY = siteY != null ? 630 + siteY : 630 + step.pos * (4530 - 630) / (carrier.positions || 5);
  const idx = step.wellIdx ?? 0;
  const row = Math.floor(idx / cols);
  const col = idx % cols;
  const x = carrier.xMin + offsetX + col * wellPitch;
  const y = baseY + offsetY - row * wellPitch;
  return { x: Math.round(x), y: Math.round(y) };
}

// ============================================================================
// Runner
// ============================================================================

let idCounter = 1;
function nextId(): string { return String(idCounter++).padStart(4, "0"); }

export async function runVenusMethod(backend: MethodBackend, method: MethodDescription): Promise<RunResult> {
  const log: RunResult["log"] = [];
  let deck: any = null;

  const run = async (step: string, raw: string) => {
    const { response, errorCode, ok } = await backend.sendFw(raw);
    log.push({ raw, response, errorCode, ok, step });
    if (!ok) throw new Error(`${backend.name} step '${step}' failed (${raw}) → ${response}`);
  };

  if (method.initialize) {
    await run("initialize", `C0VIid${nextId()}`);   // cover-status query primes the master SCXML
    await run("initialize", `C0DIid${nextId()}`);   // PIP init
    await run("initialize", `C0EIid${nextId()}`);   // 96-head init
    await run("initialize", `C0FIid${nextId()}`);   // iSWAP init
    await run("initialize", `C0IIid${nextId()}`);   // autoload init
  }

  if (method.tipPickup) {
    deck = deck ?? await backend.getDeck();
    const { x, y } = resolveWellXY(deck, method.tipPickup);
    const tm = channelsToMask(method.tipPickup.channels);
    const tt = method.tipPickup.tipType ?? "04";
    await run("tipPickup", `C0TPid${nextId()}xp${pad5(x)}yp${pad5(y)}tm${tm}tt${tt}tp2264tz2164th2450td1`);
  }

  if (method.aspirate) {
    deck = deck ?? await backend.getDeck();
    const { x, y } = resolveWellXY(deck, method.aspirate);
    const tm = channelsToMask(method.aspirate.channels);
    const vol = Math.round(method.aspirate.volumeUl * 10);  // 0.1 µL units
    await run("aspirate", `C0ASid${nextId()}xp${pad5(x)}yp${pad5(y)}av${pad5(vol)}tm${tm}lm0`);
  }

  if (method.dispense) {
    deck = deck ?? await backend.getDeck();
    const { x, y } = resolveWellXY(deck, method.dispense);
    const tm = channelsToMask(method.dispense.channels);
    const vol = Math.round(method.dispense.volumeUl * 10);
    await run("dispense", `C0DSid${nextId()}xp${pad5(x)}yp${pad5(y)}dv${pad5(vol)}tm${tm}lm0`);
  }

  if (method.tipEject) {
    deck = deck ?? await backend.getDeck();
    if (method.tipEject === "waste") {
      const tw = deck?.tipWaste;
      if (!tw) throw new Error("tipEject=waste: deck has no tipWaste");
      const xMid = Math.round((tw.xMin + tw.xMax) / 2);
      const yMid = Math.round((tw.yMin + tw.yMax) / 2);
      await run("tipEject", `C0TRid${nextId()}xp${pad5(xMid)}yp${pad5(yMid)}tm255`);
    } else {
      // "rack" — eject back into the source tip rack at the pickup coords
      if (!method.tipPickup) throw new Error("tipEject='rack' requires tipPickup");
      const { x, y } = resolveWellXY(deck, method.tipPickup);
      await run("tipEject", `C0TRid${nextId()}xp${pad5(x)}yp${pad5(y)}tm255`);
    }
  }

  return { log, success: log.every(l => l.ok) };
}

// ============================================================================
// Backends
// ============================================================================

/** HTTP backend: talks to the twin's REST `/command` + `/deck` endpoints.
 *  `baseUrl` is the origin of a running headless twin, e.g.
 *  `http://127.0.0.1:8222`. This is what `createTestServer` returns. */
export function viaTwinHttp(baseUrl: string): MethodBackend {
  return {
    name: `twin-http(${baseUrl})`,
    async sendFw(raw) {
      const r = await fetch(`${baseUrl}/command`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      const body = await r.json() as any;
      const errorCode = Number(body?.errorCode ?? 0);
      return { response: body?.response ?? "", errorCode, ok: body?.accepted === true && errorCode === 0 };
    },
    async getDeck() {
      const r = await fetch(`${baseUrl}/deck`);
      return r.json();
    },
  };
}

/** In-process backend: talks to a `TestTwin` directly, no HTTP hop.
 *  Fastest; used by unit-ish integration tests. */
export function viaInProcess(twin: TestTwin): MethodBackend {
  return {
    name: "in-process",
    async sendFw(raw) {
      const result = twin.sendCommand(raw);
      return {
        response: result.response ?? "",
        errorCode: Number(result.errorCode ?? 0),
        ok: result.accepted && Number(result.errorCode ?? 0) === 0,
      };
    },
    async getDeck() {
      return twin.api.getDeck(twin.deviceId);
    },
  };
}

/** VENUS Web API backend — drives a real VENUS 6.0.2 host via its
 *  `Hamilton.WebAPI.Host.exe` HTTP surface. Accepts a method URI or
 *  base URL; implementation is a stub until we have a reproducible
 *  Web API host to validate against. Throws with a clear message
 *  rather than returning a fake success so tests that opt in don't
 *  silently drift.
 *
 *  Configure via `VENUS_HOST=http://<ip>:<port>` (vitest envs) or
 *  pass an explicit URL. */
export function viaVenusWebApi(_host: string): MethodBackend {
  return {
    name: `venus-web-api`,
    async sendFw() {
      throw new Error(
        "viaVenusWebApi is not yet implemented. " +
        "The Hamilton.WebAPI.Host.exe surface needs a reproducible " +
        "test box to validate against before we wire its exact " +
        "route/payload here. Use viaTwinHttp for now. See #54.",
      );
    },
    async getDeck() {
      throw new Error("viaVenusWebApi.getDeck not implemented (see sendFw).");
    },
  };
}
