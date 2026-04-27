/**
 * SVG deck interaction — ghost head positioning, context menu actions,
 * inspector integration, zoom/pan.
 *
 * Interaction model:
 *   Left-click well/tip  → position ghost head at that column, show inspector
 *   Left-click empty     → hide ghost head
 *   Right-click (ghost)  → action menu: aspirate/dispense/pickup/eject + channel toggles
 *   Right-click (no ghost, on well) → fill/inspect options
 *   Wheel                → zoom
 *   Drag                 → pan
 *   Double-click         → reset zoom
 */
/// <reference path="state.ts" />
/// <reference path="deck-svg.ts" />
/// <reference path="inspector.ts" />

namespace Twin {

  const DECK_Y_MIN = 430;
  const DECK_Y_MAX = 5800;  // matches deck-svg.ts (carrier rear + margin)

  // ── Context menu ────────────────────────────────────────────────────

  interface MenuAction {
    label?: string;
    action?: () => Promise<void>;
    disabled?: boolean;
    separator?: boolean;
    html?: string;  // custom HTML content (for channel toggles)
  }

  let menuEl: HTMLElement | null = null;
  let menuCloseHandler: ((e: MouseEvent) => void) | null = null;

  function showContextMenu(x: number, y: number, actions: MenuAction[]): void {
    hideContextMenu();
    lastMenuX = x;
    lastMenuY = y;
    menuEl = document.createElement("div");
    menuEl.className = "deck-context-menu";
    for (const a of actions) {
      if (a.separator) {
        const sep = document.createElement("div");
        sep.className = "deck-menu-sep";
        menuEl.appendChild(sep);
        continue;
      }
      if (a.html) {
        const el = document.createElement("div");
        el.className = "deck-menu-custom";
        el.innerHTML = a.html;
        menuEl.appendChild(el);
        continue;
      }
      const item = document.createElement("div");
      item.className = "deck-menu-item" + (a.disabled ? " disabled" : "");
      item.textContent = a.label || "";
      if (!a.disabled && a.action) {
        const fn = a.action;
        item.addEventListener("click", (e) => {
          e.stopPropagation(); // prevent bubbling to window close handler
          hideContextMenu();
          fn().catch((err: any) => addLogEntry("err", `Command error: ${err}`));
        });
      }
      menuEl.appendChild(item);
    }
    menuEl.style.left = x + "px";
    menuEl.style.top = y + "px";
    document.body.appendChild(menuEl);

    // Stop clicks INSIDE the menu from propagating to window close handler
    menuEl.addEventListener("click", (e) => { e.stopPropagation(); });

    // Wire channel toggle checkboxes — call setGhostMask for full menu rebuild
    menuEl.querySelectorAll(".ch-toggle").forEach((cb, idx) => {
      cb.addEventListener("change", () => {
        const mask = State.ghostChannelMask ^ (1 << idx);
        Twin.setGhostMask(mask);
      });
    });

    // Close menu on next click OUTSIDE (delayed so the opening click doesn't trigger it)
    setTimeout(() => {
      menuCloseHandler = (e: MouseEvent) => {
        if (menuEl && !menuEl.contains(e.target as Node)) hideContextMenu();
      };
      window.addEventListener("click", menuCloseHandler, { once: true });
    }, 50);
  }

  function hideContextMenu(): void {
    // Remove the window close handler to prevent it from killing a rebuilt menu
    if (menuCloseHandler) {
      window.removeEventListener("click", menuCloseHandler);
      menuCloseHandler = null;
    }
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  // ── Resolve clicked SVG element to deck info ────────────────────────

  function resolveWellClick(target: SVGElement): {
    carrierId: string; position: number; wellIdx: number;
    labware: any; carrier: any; deckX: number; deckY: number;
    isTip: boolean; row: number; col: number;
  } | null {
    const wellEl = target.closest("[data-well-key]") as SVGElement | null;
    if (!wellEl) return null;
    const carrierId = wellEl.dataset.carrierId!;
    const position = Number(wellEl.dataset.position);
    const wellIdx = Number(wellEl.dataset.wellIdx);
    const carrier = State.deckData?.carriers?.find((c: any) => c.id === carrierId);
    if (!carrier) return null;
    const lw = carrier.labware?.[position];
    if (!lw) return null;

    const cols = lw.columns ?? 12;
    const row = Math.floor(wellIdx / cols);
    const col = wellIdx % cols;
    const isTip = lw.type.includes("Tip");

    const posBaseY = getSiteBaseY(carrier, position);
    const deckX = carrier.xMin + (lw.offsetX || 33) + col * (lw.wellPitch || 90);
    const deckY = posBaseY + (lw.offsetY || 745) - row * (lw.wellPitch || 90);

    return { carrierId, position, wellIdx, labware: lw, carrier, deckX, deckY, isTip, row, col };
  }

  /** Get Y base for a position, using real site offsets when available.
   *  Reads yFrontEdge from the snapshot's `dimensions` so a STARlet or
   *  custom platform uses its own front edge. The fallback `4530` is
   *  the position-fallback heuristic (see deck.ts). */
  function getSiteBaseY(carrier: any, posIdx: number): number {
    const dims: any = (State.deckData as any)?.dimensions ?? {};
    const yFront = dims.yFrontEdge ?? 630;
    if (carrier.siteYOffsets && carrier.siteYOffsets[posIdx] !== undefined) {
      return yFront + carrier.siteYOffsets[posIdx];
    }
    const posFallback = 4530;  // POSITION_FALLBACK_Y_REAR — heuristic last-labware-Y
    return yFront + posIdx * ((posFallback - yFront) / carrier.positions);
  }

  /** Snap ghost head to column — returns Row A Y, X, and the well pitch */
  function snapToColumn(carrier: any, position: number, col: number, lw: any): { x: number; y: number; pitch: number } {
    const posBaseY = getSiteBaseY(carrier, position);
    const pitch = lw.wellPitch || 90;
    const x = carrier.xMin + (lw.offsetX || 33) + col * pitch;
    const y = posBaseY + (lw.offsetY || 745);
    return { x, y, pitch };
  }

  // ── Ghost drag: nearest-column snapping ────────────────────────────────

  /** Find the closest (column, row) snap target to an arbitrary deck point.
   *
   *  Each well is a snap candidate — channel 0 of the 8-channel head lands on
   *  the well; channels 1..7 fan down at 9mm fixed pitch. On 96-well plates
   *  the natural snap rows are A (all 8 channels on A..H) but the caller may
   *  want B or deeper to exercise the "channel fell off the rack" FW error
   *  path. On 384-well plates (4.5mm pitch) both A/C/E/G and B/D/F/H give
   *  valid per-other-row docking, plus arbitrary rows that trigger errors —
   *  expose all of them.
   *
   *  Returns the best (col, row) within `threshold` distance; null otherwise
   *  — callers pass `Infinity` to always snap to whatever's nearest. */
  function findClosestColumn(px: number, py: number, threshold: number): {
    carrierId: string; position: number; col: number; labware: any; carrier: any;
    isTip: boolean; x: number; y: number; pitch: number; dist: number;
  } | null {
    const carriers = State.deckData?.carriers;
    if (!carriers) return null;
    let best: ReturnType<typeof findClosestColumn> | null = null;
    for (const carrier of carriers) {
      if (!carrier.labware) continue;
      for (let p = 0; p < carrier.labware.length; p++) {
        const lw = carrier.labware[p];
        if (!lw) continue;
        const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
        const rows = lw.rows ?? Math.ceil((lw.wellCount ?? 96) / cols);
        const rowA = snapToColumn(carrier, p, 0, lw);
        const pitch = rowA.pitch;
        // Scan every (col, row). `rowA.y` is the row A Y; subsequent rows
        // step by -pitch (Hamilton convention: higher row letter = smaller Y).
        for (let c = 0; c < cols; c++) {
          const cx = rowA.x + c * pitch;
          for (let r = 0; r < rows; r++) {
            const cy = rowA.y - r * pitch;
            const d = Math.hypot(px - cx, py - cy);
            if (d <= threshold && (!best || d < best.dist)) {
              best = {
                carrierId: carrier.id,
                position: p,
                col: c,
                labware: lw,
                carrier,
                isTip: (lw.type || "").includes("Tip"),
                x: cx, y: cy, pitch,
                dist: d,
              };
            }
          }
        }
      }
    }
    return best;
  }

  /** Start a deck pan (viewBox scroll). Triggered from plain
   *  left-click-drag on empty deck, from middle-click, or from Space+drag
   *  (#61). Pan deltas are in root-SVG coords — screenToSvgDelta does
   *  the right thing for viewBox-based panning. */
  function beginPan(svg: HTMLElement, downEvt: MouseEvent): void {
    State.deckDragging = false;
    State.deckDragStartX = downEvt.clientX;
    State.deckDragStartY = downEvt.clientY;
    State.deckPanStartX = State.deckPanX;
    State.deckPanStartY = State.deckPanY;
    svg.style.cursor = "grabbing";

    const onMove = (me: MouseEvent) => {
      const dxPx = me.clientX - State.deckDragStartX;
      const dyPx = me.clientY - State.deckDragStartY;
      if (Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3) State.deckDragging = true;
      const svgDelta = DeckSVG.screenToSvgDelta(dxPx, dyPx);
      State.deckPanX = State.deckPanStartX + svgDelta.dx;
      State.deckPanY = State.deckPanStartY + svgDelta.dy;
      DeckSVG.applyZoomPan();
    };

    const onUp = () => {
      svg.style.cursor = State.spaceHeldForPan ? "grab" : "crosshair";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setTimeout(() => { State.deckDragging = false; }, 50);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Start a ghost-head drag. Live-updates the ghost position during mouse
   *  movement; on release commits either the snapped target (default) or the
   *  raw deck coords (Shift held → deliberate off-deck placement). */
  function beginGhostDrag(downEvt: MouseEvent): void {
    State.ghostDragging = true;
    const svg = document.getElementById("deck-svg") as unknown as SVGSVGElement | null;
    if (svg) svg.style.cursor = "move";
    document.body.classList.add("ghost-dragging");

    // Capture the ghost-to-cursor offset in DECK coords so the ghost
    // tracks the cursor while preserving where the user grabbed it — grab
    // semantics, not teleport. Must use screenToDeck (not screenToSvg):
    // the viewport has a Y-flip, so root-SVG-Y and deck-Y point opposite
    // directions and mixing them makes the ghost jump erratically during
    // drag. Regression test: tests/integration/deck-geometry.test.ts
    // "drag moves ghost in cursor direction".
    const downDeck = DeckSVG.screenToDeck(downEvt.clientX, downEvt.clientY);
    const offsetX = State.ghostX - downDeck.x;
    const offsetY = State.ghostY - downDeck.y;

    const applyAt = (clientX: number, clientY: number, shift: boolean) => {
      const svgPt = DeckSVG.screenToDeck(clientX, clientY);
      const targetX = svgPt.x + offsetX;
      const targetY = svgPt.y + offsetY;
      if (shift) {
        // Free placement (no snap) — commit the raw deck coords. If the
        // mouse is off-deck, the arm will attempt an invalid move and the
        // twin's physics plugin will reject it with error 22 — exactly the
        // experience the user wants when testing error paths.
        State.ghostX = Math.round(targetX);
        State.ghostY = Math.round(targetY);
        State.ghostPitch = State.ghostPitch || 90;
        State.ghostFree = true;
        State.ghostSnap = null;
      } else {
        // Always snap to the nearest column on drag — no radius threshold.
        // Previously a 60-unit cap meant dragging from a gap between carriers
        // never snapped (e.g., ghost default at 5000,1460 is 1600+ units from
        // the nearest plate column). Hold Shift to lock free placement.
        const snap = findClosestColumn(targetX, targetY, Infinity);
        if (snap) {
          State.ghostX = snap.x;
          State.ghostY = snap.y;
          // Pitch stays fixed at 9mm — Hamilton PIP channels are mechanically
          // locked at that spacing. On 384 the 8 channels cover every-other-row
          // (A, C, E, G, I, K, M, O); the ghost preview reflects that honestly.
          State.ghostFree = false;
          State.ghostSnap = {
            carrierId: snap.carrierId,
            position: snap.position,
            col: snap.col,
            labware: snap.labware,
            carrier: snap.carrier,
            isTip: snap.isTip,
          };
        } else {
          // Empty deck (no labware loaded at all) — fall back to free.
          State.ghostX = Math.round(targetX);
          State.ghostY = Math.round(targetY);
          State.ghostFree = true;
          State.ghostSnap = null;
        }
      }
      DeckSVG.updateGhostHead();
    };

    // Re-run placement at mousedown so a Shift-down+release commits free mode
    // immediately; with the offset captured above this is a no-op on position
    // for a plain click.
    applyAt(downEvt.clientX, downEvt.clientY, downEvt.shiftKey);

    // Track the last cursor position so a mid-drag Shift toggle can re-evaluate
    // snap/free at the current cursor (onKey needs a position — no mouse event
    // fires on key events).
    let lastMovePos: { x: number; y: number } = { x: downEvt.clientX, y: downEvt.clientY };

    // Single `onMove` reference is registered AND removed — previous code wrapped
    // onMove in a closure for lastMovePos tracking but removed the unwrapped
    // reference on mouseup, leaking the listener. That's why the ghost kept
    // following the cursor after release.
    const onMove = (me: MouseEvent) => {
      lastMovePos = { x: me.clientX, y: me.clientY };
      applyAt(me.clientX, me.clientY, me.shiftKey);
    };
    const onKey = (ke: KeyboardEvent) => {
      if (ke.key === "Shift") applyAt(lastMovePos.x, lastMovePos.y, ke.type === "keydown");
    };
    const onUp = (me: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      document.body.classList.remove("ghost-dragging");
      if (svg) svg.style.cursor = "crosshair";
      // Final commit at release — Shift state at release is authoritative.
      applyAt(me.clientX, me.clientY, me.shiftKey);
      // Re-open the inspector for the snapped labware (if any) so the user
      // gets the same context they'd see from a click.
      if (State.ghostSnap) {
        const snap = State.ghostSnap;
        const carrierIdx = State.deckData?.carriers?.findIndex((c: any) => c.id === snap.carrierId) ?? 0;
        Inspector.showLabware({
          x: 0, y: 0, w: 0, h: 0,
          carrierId: snap.carrierId,
          carrierType: snap.carrier?.type || "",
          carrierIdx,
          position: snap.position,
          labware: snap.labware,
        });
      }
      setTimeout(() => { State.ghostDragging = false; }, 50);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
  }

  function wellName(row: number, col: number): string {
    return String.fromCharCode(65 + row) + (col + 1);
  }

  // ── Ghost head actions (context menu) ───────────────────────────────

  /** Last menu position + snap — stored so we can rebuild the menu in-place. */
  let lastMenuX = 0;
  let lastMenuY = 0;

  function buildGhostActions(snap: typeof State.ghostSnap): MenuAction[] {
    const state = (window as any).__lastState;
    const pip = state?.modules?.pip?.variables;
    const tipFitted: boolean[] = pip?.tip_fitted || [];
    const hasTip = tipFitted.some((v: boolean) => v === true);
    const vols: number[] = pip?.volume || [];
    const maxVol = Math.max(...vols.filter((v: number) => v > 0), 0);
    const hasVolume = maxVol > 0;
    // Read mask LIVE — all closures below also read State.ghostChannelMask live
    const tm = State.ghostChannelMask;
    const chCount = countBits(tm);
    const maskedHasTip = tipFitted.some((v: boolean, i: number) => v && (tm & (1 << i)) !== 0);

    // Always surface every FW-firing action — whether the ghost is snapped to
    // a tip rack, a plate, or free-placed. The user needs to be able to fire
    // any command from any position so they can exercise FW error paths
    // deliberately (see feedback_error_paths.md). Disabled state is purely
    // the tip/volume gate. Fill actions are the one exception — they target
    // the twin's liquid tracker (not the FW) and need carrierId + position.
    const isTip = snap?.isTip ?? false;
    const colLabel = snap ? `col ${snap.col + 1}` : "here";

    const actions: MenuAction[] = [];

    actions.push({ label: `Pick up ${chCount} tips at ${colLabel}`, action: () => cmdPickTips(State.ghostX, State.ghostY), disabled: maskedHasTip });
    actions.push({ label: `Eject tips here`, action: () => cmdEjectTips(), disabled: !hasTip });
    actions.push({ separator: true });
    actions.push({ label: `Aspirate 100\u00B5L (${chCount}ch)`, action: () => cmdAspirate(State.ghostX, State.ghostY, 1000), disabled: !hasTip });
    actions.push({ label: `Aspirate 50\u00B5L (${chCount}ch)`, action: () => cmdAspirate(State.ghostX, State.ghostY, 500), disabled: !hasTip });
    actions.push({ separator: true });
    actions.push({ label: `Dispense all (${chCount}ch)`, action: () => cmdDispenseAll(State.ghostX, State.ghostY), disabled: !hasVolume });
    actions.push({ label: `Dispense 50\u00B5L (${chCount}ch)`, action: () => cmdDispense(State.ghostX, State.ghostY, 500), disabled: !hasVolume });
    if (snap && !isTip) {
      actions.push({ separator: true });
      actions.push({ label: `Fill column ${snap.col + 1} (200\u00B5L)`, action: () => cmdFillLiquid(snap!.carrierId, snap!.position, "Sample", 2000) });
      actions.push({ label: `Fill plate (200\u00B5L)`, action: () => cmdFillLiquid(snap!.carrierId, snap!.position, "Sample", 2000) });
    }

    // Channel toggles
    actions.push({ separator: true });
    let toggleHtml = `<div class="ch-toggle-row">`;
    for (let ch = 0; ch < 8; ch++) {
      const checked = (tm & (1 << ch)) !== 0;
      toggleHtml += `<label class="ch-toggle-label${checked ? " active" : ""}">`;
      toggleHtml += `<input type="checkbox" class="ch-toggle" ${checked ? "checked" : ""}> ${ch + 1}`;
      toggleHtml += `</label>`;
    }
    toggleHtml += `</div>`;
    toggleHtml += `<div class="ch-toggle-shortcuts">`;
    toggleHtml += `<span class="ch-shortcut" onclick="Twin.setGhostMask(255)">All</span>`;
    toggleHtml += `<span class="ch-shortcut" onclick="Twin.setGhostMask(0)">None</span>`;
    toggleHtml += `<span class="ch-shortcut" onclick="Twin.setGhostMask(15)">1-4</span>`;
    toggleHtml += `<span class="ch-shortcut" onclick="Twin.setGhostMask(240)">5-8</span>`;
    toggleHtml += `</div>`;
    actions.push({ html: toggleHtml });

    // Pitch selector
    const curPitch = State.ghostPitch;
    actions.push({ separator: true });
    let pitchHtml = `<div class="ch-toggle-row">`;
    pitchHtml += `<span style="font-size:9px;color:var(--text-muted);margin-right:4px;">Pitch:</span>`;
    for (const [label, val] of [["4.5mm", 45], ["9mm", 90], ["18mm", 180]] as [string, number][]) {
      const sel = val === curPitch;
      pitchHtml += `<span class="ch-shortcut${sel ? " active" : ""}" onclick="Twin.setGhostPitch(${val})">${label}</span>`;
    }
    pitchHtml += `</div>`;
    actions.push({ html: pitchHtml });

    actions.push({ separator: true });
    actions.push({ label: `Move PIP here`, action: () => cmdMovePIP(State.ghostX, State.ghostY) });

    return actions;
  }

  function countBits(n: number): number {
    let c = 0;
    while (n) { c += n & 1; n >>= 1; }
    return c;
  }

  // Expose for inline onclick in pitch/channel shortcuts
  export function setGhostPitch(pitch: number): void {
    State.ghostPitch = pitch;
    DeckSVG.updateGhostHead();
    refreshGhostMenu();
  }

  export function setGhostMask(mask: number): void {
    State.ghostChannelMask = mask;
    DeckSVG.updateGhostHead();
    refreshGhostMenu();
  }

  /**
   * Toggle the ghost-placement tool. When on, the ghost becomes visible and
   * follows the cursor (updated by the deck mousemove handler); the next
   * click places it and exits the tool. When off, clicks go straight to the
   * inspector and the ghost stays put (pointer-transparent via CSS).
   */
  export function setGhostTool(on: boolean): void {
    State.ghostTool = on;
    document.body.classList.toggle("ghost-tool", on);
    document.getElementById("ghost-tool-btn")?.classList.toggle("active", on);
    if (on) {
      State.ghostVisible = true;
    } else {
      // Exiting the tool without placing leaves the ghost's current position
      // intact — if the user placed it on a click, ghostSnap is already set;
      // if they hit Esc before placing, the escape handler will hide it.
    }
    DeckSVG.updateGhostHead();
  }

  /**
   * Rebuild the ghost action menu in-place when channel mask or pitch changes.
   * Preserves position. Skips if no menu is open.
   */
  function refreshGhostMenu(): void {
    if (!menuEl || !State.ghostVisible) return;
    showContextMenu(lastMenuX, lastMenuY, buildGhostActions(State.ghostSnap));
  }

  // ── FW command helpers ───────────────────────────────────────────────
  // All commands read State.ghostChannelMask LIVE (not a captured value)
  // and explicitly refresh deck tracking after execution.

  async function cmdPickTips(x: number, y: number): Promise<void> {
    const tm = State.ghostChannelMask;
    await sendCommand(`C0TPid${nextId()}xp${pad5(x)}yp${pad5(y)}tm${tm}tt04`);
    await refreshDeckTracking();
  }

  async function cmdEjectTips(): Promise<void> {
    // Pass ghost xp/yp so the arm actually moves to the ghost position before
    // ejecting — previously only `tm` was sent, so pip-physics computed the
    // motion as xDist=0 and the head stayed put while the tracker still logged
    // "ejected to waste". Matches VENUS AtsMcEjectTip which always sends xp/yp.
    const tm = State.ghostChannelMask;
    await sendCommand(`C0TRid${nextId()}xp${pad5(State.ghostX)}yp${pad5(State.ghostY)}tm${tm}`);
    await refreshDeckTracking();
  }

  async function cmdAspirate(x: number, y: number, vol: number): Promise<void> {
    const tm = State.ghostChannelMask;
    await sendCommand(`C0ASid${nextId()}xp${pad5(x)}yp${pad5(y)}av${pad5(vol)}tm${tm}lm0`);
    await refreshDeckTracking();
  }

  async function cmdDispense(x: number, y: number, vol: number): Promise<void> {
    const tm = State.ghostChannelMask;
    await sendCommand(`C0DSid${nextId()}xp${pad5(x)}yp${pad5(y)}dv${pad5(vol)}dm0tm${tm}`);
    await refreshDeckTracking();
  }

  async function cmdDispenseAll(x: number, y: number): Promise<void> {
    const tm = State.ghostChannelMask;
    try { (window as any).__lastState = await apiGet("/state"); } catch {}
    const vols: number[] = (window as any).__lastState?.modules?.pip?.variables?.volume || [];
    const vol = Math.max(...vols.filter((v: number) => v > 0), 0);
    if (vol <= 0) { addLogEntry("warn", "No volume to dispense"); return; }
    await sendCommand(`C0DSid${nextId()}xp${pad5(x)}yp${pad5(y)}dv${pad5(vol)}dm0tm${tm}`);
    await refreshDeckTracking();
  }

  async function cmdMovePIP(x: number, y: number): Promise<void> {
    // C0JM moves both X (PIP arm) and Y (per-channel Y block). Without `yp`
    // only X would move and the arm would visibly miss the ghost column along
    // the front/back axis — precisely the "arm doesn't align with ghost"
    // complaint. Sending `yp` as row-A of the ghost puts channel 0 at the
    // rearmost row; subsequent channels follow the 9 mm fixed pitch.
    await sendCommand(`C0JMid${nextId()}xp${pad5(x)}yp${pad5(y)}`);
  }

  async function cmdFillLiquid(carrierId: string, position: number, liquidType: string, volume: number): Promise<void> {
    await apiPost("/liquid/fill", { carrierId, position, liquidType, volume, liquidClass: "default" });
    await refreshDeckTracking();
    addLogEntry("state", `Filled ${carrierId} pos ${position} with ${volume / 10}uL ${liquidType}`);
  }

  // ── Right-click Fill form ─────────────────────────────────────────────
  // Small popover that collects { liquidType, volume } for a pre-scoped region
  // (well / column / row / whole plate). On submit, appends a Fill step to the
  // protocol editor — optionally running it right away — so every liquid drop
  // on the deck corresponds to a visible, re-runnable step (VENUS-compliant).

  /** What the user wants to do with a fill form submission. */
  type FillAction = "once" | "save";  // once = apply, don't record; save = add to protocol + run
  interface FillPromptResult {
    liquidType: string;
    volume: number;        // µL
    action: FillAction;
  }

  let fillPromptEl: HTMLElement | null = null;
  function closeFillPrompt(): void {
    if (fillPromptEl) { fillPromptEl.remove(); fillPromptEl = null; }
  }

  function promptFill(opts: { x: number; y: number; title: string; defaultVolume?: number }): Promise<FillPromptResult | null> {
    closeFillPrompt();
    const KNOWN_LIQUIDS = ["Water", "Buffer", "Diluent", "Sample", "Stock", "Reagent", "DMSO", "Ethanol"];
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.className = "deck-fill-form";
      const chipsHtml = KNOWN_LIQUIDS.map(name =>
        `<button type="button" class="dff-chip" data-liquid="${name}" style="--chip-color:${liquidColor(name)}">${name}</button>`
      ).join("");
      host.innerHTML = `
        <div class="dff-title">${opts.title}</div>
        <div class="dff-label">Liquid — click a preset or type your own</div>
        <div class="dff-chips">${chipsHtml}</div>
        <label class="dff-row"><span>Custom</span>
          <input type="text" class="dff-liquid" value="Diluent" autocomplete="off" spellcheck="false">
        </label>
        <label class="dff-row"><span>Volume (µL per well)</span>
          <input type="number" class="dff-volume" min="0" step="1" value="${opts.defaultVolume ?? 100}">
        </label>
        <div class="dff-buttons">
          <button class="dff-cancel" type="button" title="Escape">Cancel</button>
          <button class="dff-save"   type="button" title="Add a Fill step to the protocol and run it — reproducible on reload">Save as step</button>
          <button class="dff-once"   type="button" title="Apply once to the deck, do not record a step (Enter)">Fill</button>
        </div>
      `;
      host.style.left = opts.x + "px";
      host.style.top = opts.y + "px";
      document.body.appendChild(host);
      fillPromptEl = host;

      const liquidInp = host.querySelector(".dff-liquid") as HTMLInputElement;
      const volInp    = host.querySelector(".dff-volume") as HTMLInputElement;
      liquidInp.focus(); liquidInp.select();

      // Clicking a chip sets the text input's value — chips are hints, not
      // constraints. The user can still free-type anything.
      host.querySelectorAll<HTMLElement>(".dff-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          const liq = chip.dataset.liquid || "";
          liquidInp.value = liq;
          host.querySelectorAll(".dff-chip").forEach(c => c.classList.remove("dff-chip--active"));
          chip.classList.add("dff-chip--active");
          volInp.focus(); volInp.select();
        });
      });

      function finish(action: FillAction | null) {
        if (action === null) { closeFillPrompt(); resolve(null); return; }
        const liquidType = liquidInp.value.trim() || "Liquid";
        const volume = Number(volInp.value);
        if (!Number.isFinite(volume) || volume <= 0) { volInp.focus(); return; }
        closeFillPrompt();
        resolve({ liquidType, volume, action });
      }
      host.querySelector(".dff-cancel")!.addEventListener("click", () => finish(null));
      host.querySelector(".dff-save")!  .addEventListener("click", () => finish("save"));
      host.querySelector(".dff-once")!  .addEventListener("click", () => finish("once"));
      host.addEventListener("keydown", (e) => {
        if (e.key === "Escape") finish(null);
        if (e.key === "Enter")  finish("once");
      });
      // Click outside the popover closes it.
      setTimeout(() => {
        const outside = (e: MouseEvent) => {
          if (fillPromptEl && !fillPromptEl.contains(e.target as Node)) {
            window.removeEventListener("click", outside);
            finish(null);
          }
        };
        window.addEventListener("click", outside);
      }, 50);
    });
  }

  interface FillScope {
    carrierId: string;
    position: number;
    labwareLabel: string;
    target: "all" | "columns" | "rows" | "wells";
    columns?: number[];
    rows?: number[];
    wellIndices?: number[];
    regionLabel: string;
  }

  /** Clear — ad-hoc (no protocol step). Empties the specified region immediately. */
  async function runClear(scope: FillScope): Promise<void> {
    const params: Record<string, any> = {
      carrierId: scope.carrierId,
      position: scope.position,
      target: scope.target,
    };
    if (scope.columns)     params.columns = scope.columns;
    if (scope.rows)        params.rows = scope.rows;
    if (scope.wellIndices) params.wellIndices = scope.wellIndices;
    try {
      const resp = await apiPost("/step", { type: "clear", params });
      await refreshDeckTracking();
      if (resp?.success) {
        addLogEntry("state", `Cleared ${scope.regionLabel} of ${scope.labwareLabel}`);
      } else {
        addLogEntry("err", `Clear failed: ${resp?.error || "unknown error"}`);
      }
    } catch (err: any) {
      addLogEntry("err", `Clear failed: ${err?.message || err}`);
    }
  }

  async function runFillPrompt(scope: FillScope, x: number, y: number): Promise<void> {
    const result = await promptFill({ x, y, title: `Fill ${scope.regionLabel} — ${scope.labwareLabel}` });
    if (!result) return;
    const params: Record<string, any> = {
      carrierId: scope.carrierId,
      position: scope.position,
      liquidType: result.liquidType,
      volume: result.volume,
      target: scope.target,
    };
    if (scope.columns)     params.columns = scope.columns;
    if (scope.rows)        params.rows = scope.rows;
    if (scope.wellIndices) params.wellIndices = scope.wellIndices;

    if (result.action === "save") {
      // Add a reproducible Fill step to the protocol AND run it. Survives
      // protocol save/reload — part of the method prelude.
      const stepId = (Twin as any).Protocol.addStepWith("fill", params);
      addLogEntry("state", `Added Fill step: ${scope.regionLabel} of ${scope.labwareLabel} → ${result.volume}µL ${result.liquidType}`);
      await (Twin as any).Protocol.runStep(stepId);
      return;
    }

    // action === "once": fire the step directly, don't append to the protocol.
    // Used for ad-hoc deck setup while exploring.
    try {
      const resp = await apiPost("/step", { type: "fill", params });
      await refreshDeckTracking();
      if (resp?.success) {
        addLogEntry("state", `Filled ${scope.regionLabel} of ${scope.labwareLabel} with ${result.volume}µL ${result.liquidType} (ad-hoc)`);
      } else {
        addLogEntry("err", `Fill failed: ${resp?.error || "unknown error"}`);
      }
    } catch (err: any) {
      addLogEntry("err", `Fill failed: ${err?.message || err}`);
    }
  }

  let cmdCounter = 100;
  function nextId(): string { return String(++cmdCounter).padStart(4, "0"); }
  function pad5(n: number): string { return String(Math.round(n)).padStart(5, "0"); }

  // ── Main setup ───────────────────────────────────────────────────────

  export namespace DeckInteract {
    export function setupDeckClick(): void {
      const svg = document.getElementById("deck-svg");
      if (!svg) return;

      svg.style.cursor = "crosshair";
      (window as any).__lastState = null;

      // ── Hover tooltip ────────────────────────────────────────────────
      const tooltip = document.getElementById("deck-tooltip");

      function lookupLabware(carrierId: string, position: number): any {
        const carrier = State.deckData?.carriers?.find((c: any) => c.id === carrierId);
        return carrier?.labware?.[position] || null;
      }

      svg.addEventListener("mousemove", (e) => {
        // ── Ghost-tool mode: ghost tracks the cursor live ──
        //   Snap-preview when hovering labware (ch0 lands on the nearest
        //   well), free-move over empty deck. The actual placement only
        //   happens on click.
        if (State.ghostTool && !State.ghostDragging) {
          const target = e.target as SVGElement;
          const info = resolveWellClick(target);
          if (info) {
            State.ghostX = info.deckX;
            State.ghostY = info.deckY;
            State.ghostVisible = true;
            State.ghostFree = false;
            State.ghostSnap = {
              carrierId: info.carrierId,
              position: info.position,
              col: info.col,
              labware: info.labware,
              carrier: info.carrier,
              isTip: info.isTip,
            };
          } else {
            // Deck coords (not root-SVG): the viewport is Y-flipped, so
            // writing root-SVG Y into State.ghostY would place the ghost
            // mirrored relative to the cursor.
            const deckPt = DeckSVG.screenToDeck(e.clientX, e.clientY);
            State.ghostX = Math.round(deckPt.x);
            State.ghostY = Math.round(deckPt.y);
            State.ghostVisible = true;
            State.ghostFree = true;
            State.ghostSnap = null;
          }
          DeckSVG.updateGhostHead();
        }

        if (!tooltip) return;
        const target = e.target as SVGElement;

        const wellEl = target.closest("[data-well-key]") as SVGElement | null;
        const washEl = target.closest("[data-wash-chamber]") as SVGElement | null;

        // Check if we're inside a labware-slot that holds a trough/wash (even if no data-well-key)
        let troughSlot: SVGElement | null = null;
        if (!wellEl && !washEl) {
          const slot = target.closest("[data-position]") as SVGElement | null;
          if (slot) {
            const hasTroughClass = slot.querySelector(".labware-bg--trough, .labware-bg--wash");
            if (hasTroughClass) troughSlot = slot;
          }
        }

        if (!wellEl && !washEl && !troughSlot) {
          tooltip.style.display = "none";
          return;
        }

        let html: string;

        if (washEl) {
          // Wash chamber tooltip
          const chamberIdx = Number(washEl.dataset.washChamber ?? 0);
          const washVars = State.previousVariables?.["wash"] || {};
          const fluid = (washVars[`fluid_level_${chamberIdx + 1}`] as number) || 0;
          const cycles = (washVars["wash_cycles"] as number) || 0;
          html = `<span class="tt-well">Wash Chamber ${chamberIdx + 1}</span> <span class="tt-vol">${(fluid / 1000).toFixed(0)} mL</span>`;
          html += ` <span class="tt-liq">${cycles} cycles</span>`;
        } else if (wellEl) {
          const key = wellEl.dataset.wellKey!;
          // carrierId/position may be on the element or parsed from the key (carrierId:position:wellIdx)
          const keyParts = key.split(":");
          const carrierId = wellEl.dataset.carrierId || keyParts[0] || "?";
          const position = wellEl.dataset.position !== undefined ? Number(wellEl.dataset.position) : Number(keyParts[1] || 0);
          const isTip = wellEl.classList.contains("tip");
          const wellIdx = wellEl.dataset.wellIdx !== undefined ? Number(wellEl.dataset.wellIdx) : Number(keyParts[2] || 0);
          const lw = lookupLabware(carrierId, position);

          // Determine labware type for correct labeling
          const isTrough = lw?.type?.includes("Trough") || lw?.type?.includes("Rgt") || (lw?.wellCount === 1);
          const isWash = lw?.type?.includes("Wash");
          const cols = lw?.columns ?? (lw?.wellCount > 96 ? 24 : 12);
          const row = Math.floor(wellIdx / cols);
          const col = wellIdx % cols;
          const wn = String.fromCharCode(65 + row) + (col + 1);

          if (isTip) {
            const used = wellEl.classList.contains("tip--used");
            html = `<span class="tt-well">${wn}</span> <span class="${used ? "tt-used" : "tt-tip"}">${used ? "used" : "available"}</span>`;
          } else if (isTrough || isWash) {
            // Trough / wash: show volume in mL
            const vol = State.deckTracking.wellVolumes?.[key] ?? 0;
            const contents = State.deckTracking.wellContents?.[key];
            const label = isWash ? `Wash ${position + 1}` : `Trough ${position + 1}`;
            if (vol > 0) {
              const unit = vol >= 10000 ? `${(vol / 10000).toFixed(2)} mL` : `${(vol / 10).toFixed(2)} µL`;
              html = `<span class="tt-well">${label}</span> <span class="tt-vol">${unit}</span>`;
              if (contents?.liquidType) html += ` <span class="tt-liq">${contents.liquidType}</span>`;
            } else {
              html = `<span class="tt-well">${label}</span> <span class="tt-empty">empty</span>`;
            }
          } else {
            // Standard plate well
            const vol = State.deckTracking.wellVolumes?.[key];
            const contents = State.deckTracking.wellContents?.[key];
            const dead = (lw as any)?.deadVolume as number | undefined;
            if (vol !== undefined && vol > 0) {
              html = `<span class="tt-well">${wn}</span> <span class="tt-vol">${(vol / 10).toFixed(2)} µL</span>`;
              // Prefer per-component breakdown when the well holds a mixture.
              const comps = (contents as any)?.components;
              if (comps) {
                const entries: Array<[string, number]> = comps instanceof Map
                  ? [...comps.entries()] as Array<[string, number]>
                  : Array.isArray(comps) ? comps as Array<[string, number]>
                  : Object.entries(comps as Record<string, number>);
                const parts = entries
                  .filter(([, v]) => v > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, v]) => `${name} ${(v / 10).toFixed(2)}`);
                if (parts.length >= 2) {
                  html += ` <span class="tt-liq">${parts.join(" + ")} µL</span>`;
                } else if (contents?.liquidType) {
                  html += ` <span class="tt-liq">${contents.liquidType}</span>`;
                }
              } else if (contents?.liquidType) {
                html += ` <span class="tt-liq">${contents.liquidType}</span>`;
              }
              // Dead volume annotation: shows the residual below which the
              // real ML STAR won't aspirate (labware + liquid class minimum
              // height). Usable volume = total − dead.
              if (dead !== undefined && dead > 0) {
                const usable = Math.max(0, vol - dead);
                html += ` <span class="tt-dead">[dead ${(dead / 10).toFixed(2)} · usable ${(usable / 10).toFixed(2)} µL]</span>`;
              }
            } else if (vol !== undefined && vol < 0) {
              html = `<span class="tt-well">${wn}</span> <span class="tt-underflow">${(vol / 10).toFixed(2)} µL (UNDERFLOW)</span>`;
            } else {
              html = `<span class="tt-well">${wn}</span> <span class="tt-empty">empty</span>`;
              if (dead !== undefined && dead > 0) {
                html += ` <span class="tt-dead">[dead ${(dead / 10).toFixed(2)} µL]</span>`;
              }
            }
          }
        } else if (troughSlot) {
          // Trough/wash body hover — resolved via labware-slot group
          const carrierId = troughSlot.dataset.carrierId || target.closest("[data-carrier-id]")?.getAttribute("data-carrier-id") || "?";
          const position = Number(troughSlot.dataset.position ?? 0);
          const lw = lookupLabware(carrierId, position);
          const isWashLw = lw?.type?.includes("Wash");
          const label = isWashLw ? `Wash Chamber ${position + 1}` : `Trough ${position + 1}`;
          const key = `${carrierId}:${position}:0`;
          const vol = State.deckTracking.wellVolumes?.[key] ?? 0;
          const unit = vol >= 10000 ? `${(vol / 10000).toFixed(2)} mL` : vol > 0 ? `${(vol / 10).toFixed(2)} µL` : "";
          html = `<span class="tt-well">${label}</span>`;
          html += vol > 0 ? ` <span class="tt-vol">${unit}</span>` : ` <span class="tt-empty">empty</span>`;
          const contents = State.deckTracking.wellContents?.[key];
          if (vol > 0 && contents?.liquidType) html += ` <span class="tt-liq">${contents.liquidType}</span>`;
        } else {
          tooltip.style.display = "none";
          return;
        }

        tooltip.innerHTML = html;
        tooltip.style.display = "block";
        // Tooltip uses position: fixed so viewport-space coords work from any
        // SVG source. Flip to the left of the cursor when it would overflow
        // the right edge of the viewport, and clamp so the tooltip never
        // extends below the bottom.
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const padR = 12;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = e.clientX + padR + tw + 8 > vw ? Math.max(4, e.clientX - padR - tw) : e.clientX + padR;
        const top  = Math.max(4, Math.min(vh - th - 4, e.clientY - 28));
        tooltip.style.left = left + "px";
        tooltip.style.top  = top + "px";
      });
      svg.addEventListener("mouseleave", () => {
        if (tooltip) tooltip.style.display = "none";
      });

      // ── Left-click ───────────────────────────────────────────────────
      //   Tool ON: place the ghost (snap if over labware, free otherwise)
      //     and exit the tool. Ctrl/Cmd/Alt-click bypasses placement and
      //     falls through to the inspector (per #56 acceptance).
      //   Tool OFF: inspect only — never create or move the ghost. That's
      //     the whole point of #56: the inspector must be reachable without
      //     the ghost hijacking the click.
      svg.addEventListener("click", async (e) => {
        // Ghost drag drops synthesize a click on mouseup; without this check
        // a drop on empty deck area would be interpreted as "clicked empty".
        if (State.deckDragging || State.ghostDragging) return;
        hideContextMenu();
        const target = e.target as SVGElement;

        // Refresh state for commands
        try { (window as any).__lastState = await apiGet("/state"); } catch {}

        const info = resolveWellClick(target);
        const bypassPlacement = e.ctrlKey || e.metaKey || e.altKey;

        // ── Ghost-tool mode: click places the ghost ──
        if (State.ghostTool && !bypassPlacement) {
          if (info) {
            State.ghostX = info.deckX;
            State.ghostY = info.deckY;
            State.ghostVisible = true;
            State.ghostFree = false;
            State.ghostSnap = {
              carrierId: info.carrierId,
              position: info.position,
              col: info.col,
              labware: info.labware,
              carrier: info.carrier,
              isTip: info.isTip,
            };
          } else {
            // Deck coords (see comment in mousemove handler above).
            const deckPt = DeckSVG.screenToDeck(e.clientX, e.clientY);
            State.ghostX = Math.round(deckPt.x);
            State.ghostY = Math.round(deckPt.y);
            State.ghostPitch = State.ghostPitch || 90;
            State.ghostVisible = true;
            State.ghostFree = true;
            State.ghostSnap = null;
          }
          setGhostTool(false);
          return;
        }

        // ── Default (tool off, or modifier-held): route to inspector ──
        if (info) {
          const carrierIdx = State.deckData?.carriers?.findIndex((c: any) => c.id === info.carrierId) ?? 0;
          Inspector.showLabware({
            x: 0, y: 0, w: 0, h: 0,
            carrierId: info.carrierId,
            carrierType: info.carrier?.type || "",
            carrierIdx,
            position: info.position,
            labware: info.labware,
          });
          return;
        }

        // Resolve carrierIdx by ID, not by dataset attribute: `closest`
        // returns the INNERMOST element with `data-carrier-id`, which for
        // a labware-bg or label click is the slot `<g>` (data-carrier-id
        // but no data-carrier-idx). Reading idx from that fell back to 0
        // = WasteBlock, producing a "WasteBlock › pos N › <lw>"
        // breadcrumb for every non-well click.
        const slotEl = target.closest("[data-position]") as SVGElement | null;
        const carrierEl = target.closest("[data-carrier-id]") as SVGElement | null;
        const carriers = State.deckData?.carriers ?? [];
        if (slotEl) {
          const carrierId = slotEl.dataset.carrierId!;
          const position = Number(slotEl.dataset.position);
          const carrierIdx = carriers.findIndex((c: any) => c.id === carrierId);
          const carrier = carriers[carrierIdx];
          const lw = carrier?.labware?.[position];
          const hit: HitRegion = {
            x: 0, y: 0, w: 0, h: 0,
            carrierId,
            carrierType: carrier?.type || "",
            carrierIdx,
            position,
            labware: lw,
          };
          if (lw) Inspector.showLabware(hit);
          else Inspector.showEmptyPosition(hit);
        } else if (carrierEl) {
          const carrierId = carrierEl.dataset.carrierId!;
          const carrierIdx = carriers.findIndex((c: any) => c.id === carrierId);
          const carrier = carriers[carrierIdx];
          Inspector.showCarrier({
            x: 0, y: 0, w: 0, h: 0,
            carrierId, carrierType: carrier?.type || "", carrierIdx,
          });
        }
      });

      // ── Right-click: menu depends on WHAT was clicked, not ghost state ─
      //   · on the ghost body/dots/label → ghost head action menu
      //   · on a labware well              → fill/clear menu
      // The two menus can coexist: the ghost may be visible on one plate
      // while the user right-clicks a different plate to seed liquid.
      svg.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        const target = e.target as SVGElement;

        try { (window as any).__lastState = await apiGet("/state"); } catch {}

        // Ghost body/dots/rail/label are pointer-transparent (#56) so
        // `e.target` never resolves to them AND Chromium's
        // `elementsFromPoint` silently skips pointer-events:none elements
        // (the browser diverges from the MDN description here). Use a
        // geometric hit-test: any right-click inside the ghost body's
        // screen rect opens the ghost menu. The handle is included for
        // free because it sits directly above the body and — when
        // hovered — already catches right-click via closest(".ghost-handle").
        let onGhost = false;
        if (State.ghostVisible) {
          const targetEl = e.target as Element;
          if (targetEl.closest?.(".ghost-handle, .ghost-body, .ghost-dot, .ghost-rail, .ghost-label, .ghost-handle-glyph")) {
            onGhost = true;
          } else {
            const body = document.querySelector("#deck-svg .ghost-body");
            if (body) {
              const r = body.getBoundingClientRect();
              if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                onGhost = true;
              }
            }
            if (!onGhost) {
              const handle = document.querySelector("#deck-svg .ghost-handle");
              if (handle) {
                const r = handle.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                  onGhost = true;
                }
              }
            }
          }
        }
        if (onGhost && State.ghostVisible) {
          const actions = buildGhostActions(State.ghostSnap);
          if (actions.length > 0) showContextMenu(e.clientX, e.clientY, actions);
          return;
        }

        {
          // Labware-aimed menu: fill/clear regardless of whether the ghost
          // is visible elsewhere.
          // Resolve a well hit when available; otherwise fall back to the
          // containing labware slot so right-click on the plate body
          // (label, border, gap between wells) still opens a useful menu
          // with "Fill whole plate" / "Clear whole plate". Without this
          // the user has to land a pixel-perfect right-click on a well
          // circle — the "very picky about location" complaint.
          let info = resolveWellClick(target);
          let plateOnlyFallback = false;
          if (!info) {
            const slotEl = target.closest("[data-position]") as SVGElement | null;
            if (slotEl) {
              const carrierId = slotEl.dataset.carrierId!;
              const position = Number(slotEl.dataset.position);
              const carrier = State.deckData?.carriers?.find((c: any) => c.id === carrierId);
              const lw = carrier?.labware?.[position];
              if (lw) {
                info = {
                  carrierId, position, wellIdx: 0,
                  labware: lw, carrier,
                  deckX: 0, deckY: 0,
                  isTip: (lw.type || "").includes("Tip"),
                  row: 0, col: 0,
                };
                plateOnlyFallback = true;
              }
            }
          }
          if (info && !info.isTip && plateOnlyFallback) {
            // Plate-only fallback menu: just the labware-scoped actions.
            const lw = info.labware;
            const isTrough = (lw.wellCount ?? 1) === 1;
            const labwareLabel = `${info.carrierId}[${info.position}] ${lw.type}`;
            const actions: MenuAction[] = [];
            actions.push({ label: `Fill ${isTrough ? labwareLabel : "whole plate"}…`, action: async () => {
              await runFillPrompt({
                carrierId: info!.carrierId, position: info!.position,
                labwareLabel, target: "all",
                regionLabel: isTrough ? "trough" : "whole plate",
              }, e.clientX, e.clientY);
            }});
            actions.push({ separator: true });
            actions.push({ label: `Clear ${isTrough ? labwareLabel : "whole plate"}`, action: () => runClear({
              carrierId: info!.carrierId, position: info!.position,
              labwareLabel, target: "all",
              regionLabel: isTrough ? "trough" : "whole plate",
            })});
            if (actions.length > 0) showContextMenu(e.clientX, e.clientY, actions);
          } else if (info && !info.isTip) {
            const lw = info.labware;
            const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
            const wellCount = lw.wellCount ?? 1;
            const isTrough = wellCount === 1;
            const labwareLabel = `${info.carrierId}[${info.position}] ${lw.type}`;
            const actions: MenuAction[] = [];

            if (isTrough) {
              // Single-cell labware: one action.
              actions.push({ label: `Fill ${labwareLabel}…`, action: async () => {
                await runFillPrompt({
                  carrierId: info.carrierId, position: info.position,
                  labwareLabel, target: "all", regionLabel: "trough",
                }, e.clientX, e.clientY);
              }});
            } else {
              const wn = wellName(info.row, info.col);
              actions.push({ label: `Fill well ${wn}…`, action: async () => {
                await runFillPrompt({
                  carrierId: info.carrierId, position: info.position,
                  labwareLabel, target: "wells", wellIndices: [info.wellIdx],
                  regionLabel: `well ${wn}`,
                }, e.clientX, e.clientY);
              }});
              actions.push({ label: `Fill column ${info.col + 1}…`, action: async () => {
                await runFillPrompt({
                  carrierId: info.carrierId, position: info.position,
                  labwareLabel, target: "columns", columns: [info.col],
                  regionLabel: `column ${info.col + 1}`,
                }, e.clientX, e.clientY);
              }});
              actions.push({ label: `Fill row ${String.fromCharCode(65 + info.row)}…`, action: async () => {
                await runFillPrompt({
                  carrierId: info.carrierId, position: info.position,
                  labwareLabel, target: "rows", rows: [info.row],
                  regionLabel: `row ${String.fromCharCode(65 + info.row)}`,
                }, e.clientX, e.clientY);
              }});
              actions.push({ label: `Fill whole plate…`, action: async () => {
                await runFillPrompt({
                  carrierId: info.carrierId, position: info.position,
                  labwareLabel, target: "all", regionLabel: "whole plate",
                }, e.clientX, e.clientY);
              }});
              // Shortcut for a common serial-dilution setup: the remaining cols
              // from here to the right edge (typical diluent region).
              if (info.col < cols - 1) {
                const rest: number[] = [];
                for (let c = info.col; c < cols; c++) rest.push(c);
                const label = `Fill columns ${info.col + 1}–${cols}…`;
                actions.push({ label, action: async () => {
                  await runFillPrompt({
                    carrierId: info.carrierId, position: info.position,
                    labwareLabel, target: "columns", columns: rest,
                    regionLabel: `columns ${info.col + 1}–${cols}`,
                  }, e.clientX, e.clientY);
                }});
              }

              // ── Clear actions (ad-hoc — no confirmation, Undo via refill) ──
              actions.push({ separator: true });
              const wnClear = wellName(info.row, info.col);
              actions.push({ label: `Clear well ${wnClear}`, action: () => runClear({
                carrierId: info.carrierId, position: info.position,
                labwareLabel, target: "wells", wellIndices: [info.wellIdx],
                regionLabel: `well ${wnClear}`,
              })});
              actions.push({ label: `Clear column ${info.col + 1}`, action: () => runClear({
                carrierId: info.carrierId, position: info.position,
                labwareLabel, target: "columns", columns: [info.col],
                regionLabel: `column ${info.col + 1}`,
              })});
              actions.push({ label: `Clear row ${String.fromCharCode(65 + info.row)}`, action: () => runClear({
                carrierId: info.carrierId, position: info.position,
                labwareLabel, target: "rows", rows: [info.row],
                regionLabel: `row ${String.fromCharCode(65 + info.row)}`,
              })});
              actions.push({ label: `Clear whole plate`, action: () => runClear({
                carrierId: info.carrierId, position: info.position,
                labwareLabel, target: "all",
                regionLabel: "whole plate",
              })});
            }

            if (isTrough) {
              actions.push({ separator: true });
              actions.push({ label: `Clear ${labwareLabel}`, action: () => runClear({
                carrierId: info.carrierId, position: info.position,
                labwareLabel, target: "all",
                regionLabel: "trough",
              })});
            }

            if (actions.length > 0) showContextMenu(e.clientX, e.clientY, actions);
          }
        }
      });

      // ── Wheel zoom (toward cursor, with letterbox guard) ────────────
      // The deck has a wide aspect ratio; preserveAspectRatio="xMidYMid
      // meet" letterboxes the viewBox inside the SVG container. When
      // the cursor lands in a letterbox padding strip (no drawn
      // content under it), `screenToSvg` extrapolates a deck-X that
      // sits WAY off the deck — and every subsequent wheel step
      // anchors on that off-deck point, sliding the viewport further
      // out of view until the deck disappears off-screen entirely.
      // Guard: if the cursor's mapped point isn't inside the current
      // viewBox, fall back to center-anchored zoom (preserves panX,
      // just scales). #61 / 2026-04-19 fix.
      svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = DeckSVG.clampZoom(State.deckZoom * factor);
        if (newZoom === State.deckZoom) return;

        // Deck point that was under the cursor BEFORE the zoom change.
        // `screenToSvg` uses the SVG's getScreenCTM inverse, so it's
        // letterbox-correct even when preserveAspectRatio="xMidYMid meet"
        // adds left/right or top/bottom padding (#61 / #62).
        const svgPtBefore = DeckSVG.screenToSvg(e.clientX, e.clientY);
        const vb = svg.getAttribute("viewBox")?.split(/\s+/).map(Number) || [0, 0, 0, 0];
        const [vbX, vbY, vbW, vbH] = vb;
        const cursorInViewBox =
          svgPtBefore.x >= vbX && svgPtBefore.x <= vbX + vbW &&
          svgPtBefore.y >= vbY && svgPtBefore.y <= vbY + vbH;

        if (!cursorInViewBox) {
          // Center-anchored zoom — preserves panX/panY, just re-scales.
          State.deckZoom = newZoom;
          DeckSVG.applyZoomPan();
          return;
        }

        // Cursor-anchored zoom via the CTM. Earlier versions derived the
        // pivot from a screen fraction `(clientX - rect.left) / rect.width`
        // which IGNORES letterbox padding — with a wide deck on a nearly-
        // square viewport the pivot drifted several mm to the right on
        // every wheel tick. Instead we apply the zoom at the current pan,
        // re-query the CTM to find where the cursor now lands in deck
        // coords, and pan by exactly that delta so the old deck point
        // ends up under the cursor screen pixel again. #62 2026-04-19.
        //
        // Sign note: `applyZoomPan` computes `vbX = cx - vbW/2 - panX`,
        // so `panX` is the opposite of the viewBox origin. To SHIFT
        // the viewBox right by Δ (i.e. make svgPtBefore land where
        // svgPtAfter is now), we need `vbX += Δ` → `panX -= Δ` where
        // `Δ = svgPtBefore - svgPtAfter`.
        State.deckZoom = newZoom;
        DeckSVG.applyZoomPan();
        const svgPtAfter = DeckSVG.screenToSvg(e.clientX, e.clientY);
        State.deckPanX -= (svgPtBefore.x - svgPtAfter.x);
        State.deckPanY -= (svgPtBefore.y - svgPtAfter.y);
        DeckSVG.applyZoomPan();
      }, { passive: false });

      // ── Mousedown: pan modes (space/middle) first, then ghost drag ────
      // Order matters: Space+drag and middle-click pan are the
      // Affinity/Figma-style pan mode (#61) and take priority over the
      // ghost-handle drag so users can reposition the viewport even when
      // the cursor happens to land on the handle.
      svg.addEventListener("mousedown", (e) => {
        const wantPan = (e.button === 0 && State.spaceHeldForPan) || e.button === 1;
        if (wantPan) {
          e.preventDefault();
          e.stopPropagation();
          beginPan(svg, e);
          return;
        }
        if (e.button !== 0) return;

        // Ghost drag: only the .ghost-handle grip receives pointer events
        // (body/dots/rail/label are pointer-transparent so the inspector
        // stays reachable — see #56). Mousedown on the handle enters drag
        // mode. Holding Shift suppresses snap on release.
        const ghostEl = (e.target as Element).closest(".ghost-handle");
        if (ghostEl && State.ghostVisible) {
          e.preventDefault();
          e.stopPropagation();
          beginGhostDrag(e);
          return;
        }

        beginPan(svg, e);
      });

      // ── Double-click empty deck: fit to content ──────────────────────
      // Matches scxml-editor where dblclick on canvas frames all content.
      svg.addEventListener("dblclick", (e) => {
        // Don't steal dblclick from labware/carrier interactions
        const t = e.target as Element;
        if (t.closest("[data-well-key], [data-position], [data-carrier-id], .ghost-handle")) return;
        DeckSVG.fitToContent();
      });

      // ── Keyboard: Escape (cancel ghost), G (tool), Space (pan), F (fit) ─
      const isTextTarget = (t: EventTarget | null): boolean => {
        const el = t as HTMLElement | null;
        if (!el) return false;
        const tag = el.tagName?.toLowerCase() || "";
        return tag === "input" || tag === "textarea" || tag === "select" || !!el.isContentEditable;
      };

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          hideContextMenu();
          if (State.ghostTool) setGhostTool(false);
          State.ghostVisible = false;
          State.ghostSnap = null;
          DeckSVG.updateGhostHead();
          return;
        }
        if (isTextTarget(e.target)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "g" || e.key === "G") {
          e.preventDefault();
          setGhostTool(!State.ghostTool);
          return;
        }
        if (e.key === "f" || e.key === "F") {
          // Match scxml-editor: F fits all content, Shift+F is reserved
          // for fit-to-selection (not implemented yet).
          e.preventDefault();
          DeckSVG.fitToContent();
          return;
        }
        if (e.key === " " && !State.spaceHeldForPan) {
          e.preventDefault();  // stop the browser from scrolling
          State.spaceHeldForPan = true;
          if (svg) svg.style.cursor = "grab";
        }
      });

      window.addEventListener("keyup", (e) => {
        if (e.key === " " && State.spaceHeldForPan) {
          State.spaceHeldForPan = false;
          if (svg && !State.deckDragging) svg.style.cursor = "crosshair";
        }
      });
    }
  }
}
