/**
 * Test helpers for integration tests against the running HTTP twin.
 */

const BASE = "http://localhost:8222";

export async function apiGet(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

export async function apiPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
  return r.json();
}

export async function sendCommand(raw: string): Promise<any> {
  return apiPost("/command", { raw });
}

export async function sendCompletion(event: string): Promise<void> {
  await apiPost("/completion", { event });
}

export async function resetTwin(): Promise<void> {
  await apiPost("/reset", {});
}

export async function fillPlate(carrierId: string, position: number, liquidType: string, volume: number): Promise<any> {
  return apiPost("/liquid/fill", { carrierId, position, liquidType, volume });
}

export async function getState(): Promise<any> {
  return apiGet("/state");
}

export async function getTracking(): Promise<any> {
  return apiGet("/tracking");
}

export async function getAssessments(count = 50): Promise<any[]> {
  return apiGet(`/assessment?count=${count}`);
}

/** Get module variables from state */
export async function getModuleVars(moduleId: string): Promise<Record<string, any>> {
  const state = await getState();
  return state.modules?.[moduleId]?.variables || {};
}

/** Get module active states */
export async function getModuleStates(moduleId: string): Promise<string[]> {
  const state = await getState();
  return state.modules?.[moduleId]?.states || [];
}

/** Get well volume from tracking */
export async function getWellVolume(carrierId: string, position: number, wellIdx: number): Promise<number> {
  const tracking = await getTracking();
  return tracking.wellVolumes?.[`${carrierId}:${position}:${wellIdx}`] ?? 0;
}

/** Get all well volumes for a carrier position */
export async function getColumnVolumes(carrierId: string, position: number, col: number, rows = 8, cols = 12): Promise<number[]> {
  const tracking = await getTracking();
  const vols: number[] = [];
  for (let row = 0; row < rows; row++) {
    const key = `${carrierId}:${position}:${row * cols + col}`;
    vols.push(tracking.wellVolumes?.[key] ?? 0);
  }
  return vols;
}

/**
 * Wait for a module to reach a specific active state.
 * Polls /state until the state is observed or the timeout fires.
 *
 * Replaces hardcoded setTimeout waits — fails loudly with a descriptive
 * error when the state is never reached.
 */
export async function waitForModuleState(
  moduleId: string,
  expectedState: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  const { timeoutMs = 30_000, pollMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastStates: string[] = [];
  while (Date.now() < deadline) {
    try {
      const state = await getState();
      lastStates = state?.modules?.[moduleId]?.states || [];
      if (lastStates.includes(expectedState)) return;
    } catch {
      // transient fetch error — retry
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `waitForModuleState(${moduleId}, "${expectedState}") timed out after ${timeoutMs}ms. ` +
    `Last observed states: ${JSON.stringify(lastStates)}`
  );
}

/** Initialize all modules (after reset). Polls for master=sys_ready instead of sleeping. */
export async function initAll(): Promise<void> {
  await sendCommand("C0VIid0001");
  await sendCommand("C0DIid0002");
  await sendCommand("C0EIid0003");
  await sendCommand("C0FIid0004");
  await sendCommand("C0IIid0005");
  // Wait for delayed init events (master sys_initializing → sys_ready).
  // Poll instead of sleeping — fails loudly if the twin never reaches sys_ready.
  await waitForModuleState("master", "sys_ready");
}

/** Reset twin and re-initialize all modules */
export async function resetAndInit(): Promise<void> {
  await resetTwin();
  await initAll();
}

/** Flush a delayed SCXML event by sending it as a completion */
export async function flush(event: string, waitMs = 500): Promise<void> {
  await sendCompletion(event);
  await new Promise(r => setTimeout(r, waitMs));
}

/** Check server is reachable */
export async function isServerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/state`);
    return r.ok;
  } catch {
    return false;
  }
}

// ── Coordinate resolution ──────────────────────────────────────────────

let _deckCache: any = null;

/** Get deck data (cached per test run) */
export async function getDeck(): Promise<any> {
  if (!_deckCache) {
    const state = await getState();
    _deckCache = state.deck;
  }
  return _deckCache;
}

/** Clear the deck cache (call after reset) */
export function clearDeckCache(): void {
  _deckCache = null;
}

/**
 * Resolve a well position to FW coordinates.
 * Returns { xp: "02383", yp: "01460" } ready for FW command strings.
 */
export async function wellXY(carrierId: string, position: number, column: number): Promise<{ xp: string; yp: string; x: number; y: number }> {
  const deck = await getDeck();
  const carrier = deck.carriers?.find((c: any) => c.id === carrierId);
  if (!carrier) throw new Error(`Carrier ${carrierId} not found`);
  const lw = carrier.labware?.[position];
  if (!lw) throw new Error(`No labware at ${carrierId} pos ${position}`);

  const Y_FRONT = 630;
  let posBaseY: number;
  if (carrier.siteYOffsets?.[position] !== undefined) {
    posBaseY = Y_FRONT + carrier.siteYOffsets[position];
  } else {
    const yDim = carrier.yDim || 4970;
    posBaseY = Y_FRONT + position * (yDim / carrier.positions);
  }

  const x = carrier.xMin + (lw.offsetX || 145) + column * (lw.wellPitch || 90);
  const y = posBaseY + (lw.offsetY || 745);

  return {
    x: Math.round(x),
    y: Math.round(y),
    xp: String(Math.round(x)).padStart(5, "0"),
    yp: String(Math.round(y)).padStart(5, "0"),
  };
}

/** Build a padded 5-digit string */
export function pad5(n: number): string {
  return String(Math.round(n)).padStart(5, "0");
}
