/**
 * SVG Deck Renderer — carriers, labware, wells, tips, arms, glows.
 *
 * Replaces the Canvas 2D renderer with SVG for:
 *   - Native viewBox coordinate mapping (no manual scale/offset)
 *   - CSS classes for all visual styling (theming, state-driven)
 *   - DOM events for interaction (no manual hit-region collision)
 *   - Incremental updates (toggle classes, not full redraw)
 */
/// <reference path="state.ts" />
/// <reference path="glow.ts" />

namespace Twin {

  /** Normalize a components payload (Map / serialized tuple array / record)
   *  into a stable sorted [name, volume] list. Shared by deck + inspector. */
  export function componentsToEntries(components: unknown): Array<[string, number]> {
    if (!components) return [];
    let entries: Array<[string, number]>;
    if (components instanceof Map) entries = [...components.entries()] as Array<[string, number]>;
    else if (Array.isArray(components)) entries = components as Array<[string, number]>;
    else entries = Object.entries(components as Record<string, number>);
    return entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }

  /** Build SVG <path> markup for a proportional pie with a minimum slice size.
   *  Slice angle is proportional to actual volume (so equal volumes really
   *  look 50/50, and a 10:100 split looks like 9/91 — the truth). Any slice
   *  below MIN_FRAC gets clamped up to that minimum so trace components stay
   *  visible; the rest shrink proportionally to compensate. No color mixing:
   *  each slice takes its liquid's own palette color. */
  export function buildLogPieMarkup(entries: Array<[string, number]>, cx: number, cy: number, r: number): string {
    if (entries.length < 2) return "";
    const MIN_FRAC = 0.06;  // guaranteed ≥ 6 % of the circle for any present liquid
    const vols = entries.map(([, v]) => Math.max(0, v));
    const total = vols.reduce((a, b) => a + b, 0);
    if (total <= 0) return "";
    // 1) linear proportion, 2) floor each at MIN_FRAC, 3) normalize to sum 1.
    const raw = vols.map((v) => v / total);
    const clamped = raw.map((f) => Math.max(MIN_FRAC, f));
    const clampedSum = clamped.reduce((a, b) => a + b, 0);
    const fracs = clamped.map((f) => f / clampedSum);

    let start = -Math.PI / 2;  // 12 o'clock
    const parts: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const frac = fracs[i];
      const end = start + frac * 2 * Math.PI;
      const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
      const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
      const large = frac > 0.5 ? 1 : 0;
      const color = liquidColor(entries[i][0]);
      // Full-circle edge case (single slice covering everything): two arcs.
      const d = frac >= 0.999
        ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
        : `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      // pointer-events:none so the underlying <circle> still gets hover events
      // (tooltip handler walks target.closest("[data-well-key]") and the
      // circle is the only element carrying that attribute).
      parts.push(`<path d="${d}" fill="${color}" class="well-pie-slice" style="pointer-events:none" />`);
      start = end;
    }
    return parts.join("");
  }

  /** Deterministic color per liquid name. Known liquids get curated hues;
   *  unknown names hash to a color. Used by deck + inspector to distinguish
   *  sample/diluent/buffer at a glance. */
  export function liquidColor(name: string): string {
    const known: Record<string, string> = {
      Water:    "#58b4e8",  // default blue
      Buffer:   "#8bd3a4",  // green
      Diluent:  "#8bd3a4",  // green (alias)
      Sample:   "#f5b94c",  // amber
      Stock:    "#e85c8b",  // magenta
      DMSO:     "#c792ea",  // lavender
      Ethanol:  "#7fd1c6",  // teal
      Reagent:  "#f79b5c",  // orange
    };
    if (known[name]) return known[name];
    // Hash unknowns to a hue on a perceptually-spaced palette.
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 65% 60%)`;
  }

  // Carrier physical extent. Defaults match STAR; the server's DeckSnapshot
  // carries `dimensions.yFrontEdge` / `yRearEdge` so a STARlet or custom
  // platform takes precedence over these fall-back values. `deckDims()`
  // reads the snapshot at call time so a hot-swapped deck updates without
  // reloading the page.
  const Y_FRONT_DEFAULT = 630;
  const Y_REAR_DEFAULT = 5600;
  const MARGIN_ABOVE = 200;
  const MARGIN_BELOW = 200;

  // ── Arm overlay dimensions (0.1 mm) ──
  // Derived from the margin above the rear edge so the rear-of-deck
  // bar + label don't overlap carrier geometry and scale sensibly if
  // MARGIN_ABOVE changes. `ARM_TOP_BAR_HEIGHT` is a visual choice; the
  // gap + label offset are derived from it so there's only one magic
  // number to tune.
  const ARM_TOP_BAR_HEIGHT = 80;
  const ARM_TOP_BAR_WIDTH = 160;
  const ARM_TOP_BAR_MARGIN = MARGIN_ABOVE * 0.1;               // 20  — sits just outside the deck rear
  const ARM_TOP_BAR_LABEL_GAP = ARM_TOP_BAR_HEIGHT * 0.5;      // 40  — space below the label
  const ARM_PIP_LABEL_OFFSET_FROM_REAR = ARM_TOP_BAR_MARGIN + ARM_TOP_BAR_HEIGHT + ARM_TOP_BAR_LABEL_GAP;
  const ARM_ISWAP_LABEL_OFFSET_FROM_REAR = ARM_PIP_LABEL_OFFSET_FROM_REAR + 40;

  // Origin marker radius (0.1 mm). Fixed 4 mm dot — same visual weight
  // as VENUS's.
  const ORIGIN_DOT_RADIUS = 40;

  function deckDims(): { yFront: number; yRear: number; yMin: number; yMax: number; trackPitch: number } {
    const d: any = State.deckData?.dimensions;
    const yFront = typeof d?.yFrontEdge === "number" ? d.yFrontEdge : Y_FRONT_DEFAULT;
    const yRear = typeof d?.yRearEdge === "number" ? d.yRearEdge : Y_REAR_DEFAULT;
    const trackPitch = typeof d?.trackPitch === "number" ? d.trackPitch : 225;
    return {
      yFront,
      yRear,
      yMin: yFront - MARGIN_ABOVE,
      yMax: yRear + MARGIN_BELOW,
      trackPitch,
    };
  }
  // Legacy symbols kept as defaults for existing call sites not yet reading
  // from deckDims(). Any reader below that can vary with platform should
  // call deckDims() instead; anything that's platform-independent (e.g. the
  // flip-transform around a static centre) can stay on the const.
  const Y_FRONT = Y_FRONT_DEFAULT;
  const Y_REAR = Y_REAR_DEFAULT;
  const DECK_Y_MIN = Y_FRONT - MARGIN_ABOVE;
  const DECK_Y_MAX = Y_REAR + MARGIN_BELOW;

  /**
   * VENUS renders the deck back-at-top, operator-at-bottom (north-up on
   * a workbench). Hamilton firmware coords, however, have Y growing away
   * from the operator — so low Y = front, high Y = back. The SVG's
   * native top-to-bottom Y direction would put FRONT at the top, which
   * is the opposite of every System Config Editor screenshot and every
   * Method Editor deck view the user works with.
   *
   * We resolve this by applying a single `matrix(1 0 0 -1 0 OFFSET)`
   * flip to the viewport group: graphics keep using native deck
   * coordinates (the code below still places carriers at Y_FRONT +
   * offset), but the viewport mirrors them around the deck centre so
   * back-of-deck ends up at the top of the screen. Text has to
   * counter-flip so glyphs stay readable — the `svgDeckText` /
   * `setTextDeckY` helpers below apply that counter-flip; any
   * `<text>` placed inside the viewport must go through them.
   */
  /** The Y-flip pivot — `yMin + yMax` but computed from the current
   *  dimensions so a STARlet or custom-Y platform flips around its own
   *  deck centre instead of the STAR default. */
  function yFlipOffset(): number {
    const d = deckDims();
    return d.yMin + d.yMax;
  }

  /** Build the counter-flip transform for a text element at deck-Y `y`.
   *  `matrix(1 0 0 -1 0 2y)` is the SVG rendering of "flip around the
   *  horizontal line at Y=y" — cancels the viewport's outer flip at
   *  exactly this text's anchor so the glyphs land upright. */
  function textCounterFlip(y: number): string {
    return `matrix(1 0 0 -1 0 ${2 * y})`;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  /** Build a `<text>` inside the flipped viewport with the counter-flip
   *  already wired up. Use this instead of `svgEl("text", …)` anywhere
   *  the text lives under `#deck-viewport`. Callers that reposition the
   *  text later must use `setTextDeckY` so the counter-flip updates. */
  function svgDeckText(attrs?: Record<string, string | number>): SVGTextElement {
    const t = document.createElementNS(SVG_NS, "text");
    if (attrs) for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, String(v));
    const y = Number(attrs?.y ?? 0);
    t.setAttribute("transform", textCounterFlip(y));
    return t;
  }

  /** Update a deck-frame text's y attribute and refresh its counter-flip
   *  transform in one go. Use for any label whose y shifts after
   *  creation (arm readouts, per-channel badges, etc). */
  function setTextDeckY(t: SVGTextElement, y: number): void {
    t.setAttribute("y", String(y));
    t.setAttribute("transform", textCounterFlip(y));
  }

  export namespace DeckSVG {
    /** Zoom bounds — shared by the wheel handler, the +/− toolbar buttons,
     *  and `fitToContent`. `MAX` raised from 3× to 12× on user request
     *  (2026-04-19) so inspecting a single well is feasible. */
    export const ZOOM_MIN = 0.05;
    export const ZOOM_MAX = 12;
    /** Clamp a zoom value into the allowed range. */
    export function clampZoom(z: number): number {
      return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    }

    let svg: SVGSVGElement | null = null;
    let viewport: SVGGElement | null = null;
    /** Deck X extents chosen by `renderDeck` — widened to include
     *  off-track fixtures (#57). Used by `applyZoomPan` so pan/zoom
     *  stays consistent with what `renderDeck` laid out. */
    let deckMinX = 0;
    let deckMaxX = 0;
    /** Deck Y extents — default to STAR; updated by `renderDeck` from
     *  the snapshot's `dimensions.yFrontEdge`/`yRearEdge` so a STARlet
     *  or custom platform picks up its own Y bounds without code changes. */
    let deckMinY = DECK_Y_MIN;
    let deckMaxY = DECK_Y_MAX;
    let armsGroup: SVGGElement | null = null;
    let trajectoryGroup: SVGGElement | null = null;
    let pipArmLine: SVGLineElement | null = null;
    let pipArmHead: SVGRectElement | null = null;
    let pipArmDots: SVGGElement | null = null;
    let pipArmLabel: SVGTextElement | null = null;
    let pipArmTopBar: SVGRectElement | null = null;
    let iswapArmLine: SVGLineElement | null = null;
    let iswapArmLabel: SVGTextElement | null = null;
    let h96ArmLine: SVGLineElement | null = null;
    let h96ArmHead: SVGRectElement | null = null;
    let h96ArmDots: SVGGElement | null = null;
    let h96ArmLabel: SVGTextElement | null = null;
    let h384ArmLine: SVGLineElement | null = null;
    let h384ArmLabel: SVGTextElement | null = null;
    let h384ArmHead: SVGRectElement | null = null;
    let h384ArmZBadge: SVGGElement | null = null;
    let h96ArmZBadge: SVGGElement | null = null;
    let pipArmZBadge: SVGGElement | null = null;
    // iSWAP plate + jaws overlay (rotates around the plate centre at
    // animIswapX / animIswapY; jaws open at animIswapGripWidth).
    let iswapPlateGroup: SVGGElement | null = null;
    let iswapPlateRect: SVGRectElement | null = null;
    let iswapJawLeft: SVGLineElement | null = null;
    let iswapJawRight: SVGLineElement | null = null;
    let iswapRotationMark: SVGLineElement | null = null;   // short tick showing orientation
    let iswapZBadge: SVGGElement | null = null;
    let autoloadCarriage: SVGGElement | null = null;
    let autoloadCarriageRect: SVGRectElement | null = null;
    let autoloadCarriageLabel: SVGTextElement | null = null;
    let ghostGroup: SVGGElement | null = null;

    /** Set or update an SVG <title> tooltip on an element. */
    function setTooltip(el: SVGElement, text: string): void {
      let title = el.querySelector("title") as SVGTitleElement | null;
      if (!title) {
        title = document.createElementNS(SVG_NS, "title") as SVGTitleElement;
        el.prepend(title);
      }
      title!.textContent = text;
    }

    /** Get the Y base for a labware position, using real site offsets
     *  when available. Falls back to an even-distribution across the
     *  carrier's own yDim (physical rear = front + yDim) since a custom
     *  platform's POSITION_FALLBACK_Y_REAR isn't in the snapshot today.
     *  In practice every .lay import and template supplies siteYOffsets
     *  so this fallback fires only on bare synthetic carriers. */
    function getSiteBaseY(carrier: any, posIdx: number): number {
      const d = deckDims();
      if (carrier.siteYOffsets && carrier.siteYOffsets[posIdx] !== undefined) {
        return d.yFront + carrier.siteYOffsets[posIdx];
      }
      const carrierH = carrier.yDim || (d.yRear - d.yFront);
      const posPitchY = carrierH / carrier.positions;
      return d.yFront + posIdx * posPitchY;
    }

    /** Full rebuild of the SVG deck from State.deckData. */
    export function renderDeck(): void {
      if (!State.deckData) return;
      svg = document.getElementById("deck-svg") as unknown as SVGSVGElement;
      if (!svg) return;

      const totalTracks = State.deckData.totalTracks || 54;
      const dims = deckDims();
      // Default deck X range [0 .. totalTracks*trackPitch + 1000] covers
      // all carrier tracks with a 1000-unit right-side pad. Fixtures from
      // the loaded .dck (#57) can sit OUTSIDE this range — e.g.
      // `96COREExtWaste` lands at x ≈ -3900 on ML_STAR2.dck — so widen
      // the viewBox to include every fixture rect; otherwise they'd be
      // clipped off the left/right edge and the user would think the
      // feature never worked.
      deckMinX = 0;
      deckMaxX = totalTracks * dims.trackPitch + 1000;
      deckMinY = dims.yMin;
      deckMaxY = dims.yMax;
      if (Array.isArray(State.deckData.fixtures)) {
        for (const f of State.deckData.fixtures) {
          if (f.x < deckMinX) deckMinX = f.x;
          if (f.x + f.dx > deckMaxX) deckMaxX = f.x + f.dx;
        }
      }
      const deckW = deckMaxX - deckMinX;
      const maxX = deckMaxX;  // kept for downstream arithmetic that's still "relative to origin"
      const deckH = deckMaxY - deckMinY;

      // viewBox: deck coordinates directly (deckMinX..deckMaxX / deckMinY..deckMaxY).
      svg.setAttribute("viewBox", `${deckMinX} ${deckMinY} ${deckW} ${deckH}`);
      // Fit (default) = "meet" — letterbox so the whole deck is always
      // visible regardless of panel aspect ratio. Fill = "slice" —
      // zoom-to-fill so the deck touches both panel edges, cropping on
      // the longer axis. Without this the Fit/Fill toggle did nothing
      // because setDeckMode only re-rendered without changing the SVG
      // attribute.
      const fitMode = State.deckMode === "fill" ? "slice" : "meet";
      svg.setAttribute("preserveAspectRatio", `xMidYMid ${fitMode}`);
      svg.innerHTML = "";

      // Store scale info for arm.ts and interactions
      const rect = svg.getBoundingClientRect();
      State.deckScale = rect.width / maxX;
      State.deckScaleY = rect.height / deckH;
      State.deckMaxX = maxX;

      // Viewport group for zoom/pan — also carries the Y-flip so the
      // renderer follows VENUS's back-at-top convention. Zoom/pan goes
      // via viewBox (not element transforms), so the deck-wide flip on
      // this `transform` attribute stays stable across interactions.
      viewport = svgEl("g", { id: "deck-viewport" });
      viewport.setAttribute("transform", `matrix(1 0 0 -1 0 ${yFlipOffset()})`);
      updateViewportTransform();
      svg.appendChild(viewport);

      // Background
      const bg = svgEl("rect", {
        x: 0, y: DECK_Y_MIN, width: maxX, height: deckH,
        class: "deck-bg",
      });
      viewport.appendChild(bg);

      // Deck bounds frame
      viewport.appendChild(svgEl("rect", {
        x: 0, y: Y_FRONT, width: maxX, height: Y_REAR - Y_FRONT,
        class: "deck-frame", rx: 20, ry: 20,
      }));

      // Track lines
      const tracksG = svgEl("g", { class: "track-lines" });
      for (let t = 0; t < totalTracks; t++) {
        const tx = State.deckData.tracks[t].x;
        tracksG.appendChild(svgEl("line", {
          x1: tx, y1: Y_FRONT, x2: tx, y2: Y_REAR,
          class: "track-line",
        }));
      }
      viewport.appendChild(tracksG);

      // Track numbers — every 5 tracks along the FRONT edge (visually
      // BELOW the deck after the Y-flip). Helps users eyeball positions
      // like "track 25" without counting every stroke. #58.
      // Offset chosen so the glyph's top stays outside the carrier
      // physical bounds; at Y_FRONT - 30 the numbers crossed the
      // carrier-bottom line (see user report 2026-04-19).
      const numsG = svgEl("g", { class: "track-numbers" });
      for (let t = 0; t < totalTracks; t++) {
        const trackNum = t + 1;
        if (trackNum === 1 || trackNum % 5 === 0 || trackNum === totalTracks) {
          const tx = State.deckData.tracks[t].x;
          const label = svgDeckText({
            x: tx, y: dims.yFront - 120,
            class: "track-number",
          });
          label.setAttribute("text-anchor", "middle");
          label.textContent = String(trackNum);
          numsG.appendChild(label);
        }
      }
      viewport.appendChild(numsG);

      // Deck fixtures (#57) — 96-head waste, gripper park, puncher,
      // etc. sourced from the loaded `.dck`. Drawn UNDER carriers so
      // a carrier sitting on top of a nominally-covered fixture
      // (rare but possible) still reads correctly.
      if (Array.isArray(State.deckData.fixtures) && State.deckData.fixtures.length > 0) {
        const fixG = svgEl("g", { class: "deck-fixtures" });
        for (const f of State.deckData.fixtures) fixG.appendChild(buildFixture(f));
        viewport.appendChild(fixG);
      }

      // Carriers
      const carriersG = svgEl("g", { class: "carriers" });
      for (let ci = 0; ci < State.deckData.carriers.length; ci++) {
        const carrier = State.deckData.carriers[ci];
        carriersG.appendChild(buildCarrier(carrier, ci));
      }
      viewport.appendChild(carriersG);

      // Tip waste — our built-in fallback, used when no VENUS deck is
      // loaded. VENUS decks bring their own `WasteBlock` (Method1.lay
      // puts it on track 55 alongside the teaching needle block), so
      // skip the fallback to avoid double-waste rendering when the
      // real Hamilton waste is already on the deck (user report
      // 2026-04-19).
      const hasVenusWaste = (State.deckData.carriers ?? []).some((c: any) =>
        typeof c?.type === "string" && /waste/i.test(c.type)
      );
      if (State.deckData.tipWaste && !hasVenusWaste) {
        viewport.appendChild(buildTipWaste(State.deckData.tipWaste));
      }

      // Front/Rear labels — anchored at the carrier-row edges rather than
      // the viewport margins (#58). FRONT sits just outside the front
      // edge (low deck-Y → visually below the deck after Y-flip) and
      // REAR just outside the rear edge. X is anchored LEFT of the deck
      // so they don't overlap the carriers themselves.
      const labelsG = svgEl("g", { class: "deck-labels" });
      const edgeX = 120;  // a bit right of the left deck margin
      const frontLabel = svgDeckText({ x: edgeX, y: dims.yFront - 80, class: "deck-label" });
      frontLabel.textContent = "FRONT";
      labelsG.appendChild(frontLabel);
      const rearLabel = svgDeckText({ x: edgeX, y: dims.yRear + 90, class: "deck-label" });
      rearLabel.textContent = "REAR";
      labelsG.appendChild(rearLabel);
      viewport.appendChild(labelsG);

      // Coordinate origin marker — small red dot at deck (x=0, y=0).
      // After the Y-flip this lands at the front-left corner, matching
      // VENUS's "red dot" in the Deck Editor and making it obvious which
      // corner the firmware's (0,0) coordinate refers to. Non-scaling so
      // it stays visible at any zoom level.
      const originDot = svgEl("circle", {
        cx: 0, cy: 0, r: ORIGIN_DOT_RADIUS,
        class: "deck-origin-dot",
      });
      originDot.setAttribute("vector-effect", "non-scaling-stroke");
      viewport.appendChild(originDot);

      // Trajectory overlay (planned-motion preview) sits UNDER the arm so the
      // arm head draws over it. Populated each frame by updateArm() when the
      // Arm namespace has active motion envelopes.
      trajectoryGroup = svgEl("g", { class: "trajectory-overlay" });
      viewport.appendChild(trajectoryGroup);

      // Arms overlay
      armsGroup = svgEl("g", { class: "arm-overlay" });
      buildArmElements();
      viewport.appendChild(armsGroup);

      // Apply initial tracking state
      updateTracking();

      // Re-render the Phase 3 spatial-annotations overlay after the full
      // deck rebuild. The overlay sits on top of everything else; without
      // this call it would vanish whenever the deck is redrawn.
      try { Annotations.render(); } catch { /* annotations module may not be loaded in older pages */ }

      // Reapply persisted zoom/pan. renderDeck sets the default viewBox above;
      // without this, any call to renderDeck during active zoom (e.g. divider
      // drag relayout) would snap the deck back to 1× and lose the user's view.
      applyZoomPan();

      // Re-render the ghost head from State. svg.innerHTML="" wiped the old
      // rect/dots; buildArmElements re-created empty placeholders; now sync
      // visibility + position from State so a divider drag (which triggers
      // renderDeck every frame) doesn't appear to erase the ghost.
      updateGhostHead();
    }

    /** Incremental update: toggle CSS classes on wells/tips from tracking data. */
    export function updateTracking(): void {
      if (!svg) return;

      // Tip usage (with glow on change + tooltips)
      svg.querySelectorAll(".tip").forEach((el) => {
        const key = (el as SVGElement).dataset.wellKey;
        if (!key) return;
        const used = State.deckTracking.tipUsage[key] === true;
        const wasUsed = el.classList.contains("tip--used");
        el.classList.toggle("tip--used", used);
        if (used && !wasUsed) {
          el.classList.add("tip--glow");
          el.addEventListener("animationend", () => el.classList.remove("tip--glow"), { once: true });
        }
        // Tooltip
        setTooltip(el as SVGElement, used ? "used" : "available");
      });

      // Well volumes (with glow on change + liquid type tooltips)
      const contents = State.deckTracking.wellContents || {};
      svg.querySelectorAll(".well").forEach((el) => {
        const key = (el as SVGElement).dataset.wellKey;
        if (!key) return;
        const vol = State.deckTracking.wellVolumes[key];
        const filled = vol !== undefined && vol > 0;
        const negative = vol !== undefined && vol < 0;
        const wasFilled = el.classList.contains("well--filled");
        el.classList.toggle("well--filled", filled);
        el.classList.toggle("well--negative", negative);
        const svgElC = el as SVGElement;
        // Multi-component: render a log-scale pie overlay next to the circle
        // so each liquid keeps its own color instead of being mixed into one.
        const entries = componentsToEntries((contents[key] as any)?.components);
        const isMixture = filled && entries.length >= 2;
        const pieId = `pie-${key.replace(/[^\w-]/g, "_")}`;
        let pieEl = svgElC.parentNode ? (svgElC.parentNode as ParentNode).querySelector(`[data-pie-for="${key}"]`) as SVGGElement | null : null;
        if (isMixture) {
          const cx = Number(svgElC.getAttribute("cx") || 0);
          const cy = Number(svgElC.getAttribute("cy") || 0);
          const r  = Number(svgElC.getAttribute("r")  || 0);
          const markup = buildLogPieMarkup(entries, cx, cy, r);
          if (!pieEl) {
            pieEl = document.createElementNS("http://www.w3.org/2000/svg", "g");
            pieEl.setAttribute("class", "well-pie");
            pieEl.setAttribute("data-pie-for", key);
            pieEl.setAttribute("pointer-events", "none");
            pieEl.id = pieId;
            // Insert AFTER the circle so it draws on top of the dim well bg.
            svgElC.parentNode?.insertBefore(pieEl, svgElC.nextSibling);
          }
          pieEl.innerHTML = markup;
          // Hide the circle fill so the pie shows; keep circle as transparent
          // hitbox for the existing tooltip handler.
          svgElC.style.fill = "transparent";
          svgElC.style.opacity = "1";
        } else if (pieEl) {
          // No longer a mixture — drop the pie group.
          pieEl.remove();
        }

        if (!isMixture) {
          if (filled) {
            const intensity = Math.min(1, vol / 5000);
            svgElC.style.opacity = String(0.4 + intensity * 0.6);
            // Liquid-type tinting: deterministic color per liquid name so
            // different liquids are distinguishable at a glance.
            const liq = contents[key]?.liquidType;
            if (liq) svgElC.style.fill = liquidColor(liq);
            else svgElC.style.fill = "";
            if (!wasFilled) {
              el.classList.add("well--glow");
              el.addEventListener("animationend", () => el.classList.remove("well--glow"), { once: true });
            }
          } else if (negative) {
            svgElC.style.opacity = "1";
            svgElC.style.fill = "";
          } else {
            svgElC.style.opacity = "";
            svgElC.style.fill = "";
          }
        }
        // Tooltip — look up labware for correct column count and type
        // Parse from data-well-key if dedicated attributes missing (trough-fill etc.)
        const svgEl = el as SVGElement;
        const keyParts = (key || "").split(":");
        const carrierId = svgEl.dataset.carrierId || keyParts[0] || "";
        const posIdx = svgEl.dataset.position !== undefined ? Number(svgEl.dataset.position) : Number(keyParts[1] || 0);
        const wIdx = svgEl.dataset.wellIdx !== undefined ? Number(svgEl.dataset.wellIdx) : Number(keyParts[2] || 0);
        const carrier = State.deckData?.carriers?.find((c: any) => c.id === carrierId);
        const lw = carrier?.labware?.[posIdx];
        const isTrough = lw?.type?.includes("Trough") || lw?.type?.includes("Rgt") || (lw?.wellCount === 1 && !lw?.type?.includes("Tip"));
        const isWash = lw?.type?.includes("Wash");

        let tipText: string;
        if (isTrough || isWash) {
          const label = isWash ? `Wash Chamber ${posIdx + 1}` : `Trough ${posIdx + 1}`;
          if (filled) {
            const unit = vol >= 10000 ? `${(vol / 10000).toFixed(2)} mL` : `${(vol / 10).toFixed(2)} µL`;
            tipText = `${label}: ${unit}`;
          } else {
            tipText = `${label}: empty`;
          }
        } else {
          const cols = lw?.columns ?? (lw?.wellCount > 96 ? 24 : 12);
          const row = Math.floor(wIdx / cols);
          const col = wIdx % cols;
          const wn = String.fromCharCode(65 + row) + (col + 1);
          const liq = contents[key];
          tipText = filled
            ? `${wn}: ${(vol / 10).toFixed(2)} µL ${liq?.liquidType || ""}`
            : negative
              ? `${wn}: ${(vol / 10).toFixed(2)} µL (UNDERFLOW)`
              : `${wn}: empty`;
        }
        setTooltip(svgEl, tipText);
      });

      // Trough fills + labels — both driven by tracked volume so the UI
      // never lies about actual state (previously the fill defaulted to 70%
      // and the label was hardcoded "100 mL").
      svg.querySelectorAll(".trough-fill").forEach((el) => {
        const key = (el as SVGElement).dataset.wellKey;
        if (!key) return;
        const vol = State.deckTracking.wellVolumes[key] ?? 0;
        const pct = Math.max(0, Math.min(1, vol / 1000000));
        const maxH = Number((el as SVGElement).dataset.maxH);
        const baseY = Number((el as SVGElement).dataset.baseY);
        (el as SVGElement).setAttribute("height", String(pct * maxH));
        (el as SVGElement).setAttribute("y", String(baseY + maxH - pct * maxH));
        (el as SVGElement).classList.toggle("trough-fill--empty", vol <= 0);
        (el as SVGElement).classList.toggle("trough-fill--negative", vol < 0);
      });
      svg.querySelectorAll(".trough-volume-label").forEach((el) => {
        const key = (el as SVGElement).dataset.wellKey;
        if (!key) return;
        const vol = State.deckTracking.wellVolumes[key] ?? 0;
        if (vol <= 0) {
          el.textContent = vol < 0 ? `${(vol / 10).toFixed(2)} µL (UNDERFLOW)` : "empty";
        } else if (vol >= 10000) {
          el.textContent = `${(vol / 10000).toFixed(2)} mL`;
        } else {
          el.textContent = `${(vol / 10).toFixed(2)} µL`;
        }
      });

      // Tip waste
      const twFill = svg.querySelector(".tipwaste-fill") as SVGRectElement;
      if (twFill && State.deckData?.tipWaste) {
        const tw = State.deckData.tipWaste;
        const pct = Math.min(1, tw.tipCount / tw.capacity);
        const maxH = Number(twFill.dataset.maxH);
        const baseY = Number(twFill.dataset.baseY);
        twFill.setAttribute("height", String(pct * maxH));
        twFill.setAttribute("y", String(baseY + maxH - pct * maxH));
        twFill.classList.toggle("tipwaste-fill--warning", pct > 0.8);
        const countEl = svg.querySelector(".tipwaste-count");
        if (countEl) countEl.textContent = `${tw.tipCount}/${tw.capacity}`;
      }
    }

    /** Update HHS/TCC/Wash visuals from module variables. */
    export function updateModuleVisuals(allVars: Record<string, Record<string, unknown>>): void {
      if (!svg) return;

      // --- HHS ---
      const hhs = allVars["hhs"];
      if (hhs) {
        const tempActive = hhs.temp_active as boolean;
        const target = (hhs.target_temp_01c as number) || 0;
        const current = (hhs.current_temp_01c as number) || 250;
        const shaking = hhs.shaking as boolean;
        const locked = hhs.plate_locked as boolean;
        const speed = (hhs.shake_speed as number) || 0;

        // Temperature bar fill (0-100% based on current vs max 105C)
        svg.querySelectorAll("[data-hhs-temp-fill]").forEach((el) => {
          const maxW = Number((el as SVGElement).dataset.maxW) || 1;
          const pct = tempActive ? Math.min(1, current / 1050) : 0;
          (el as SVGElement).setAttribute("width", String(pct * maxW));
          (el as SVGElement).classList.toggle("hhs-temp-fill--active", tempActive);
        });

        // Temperature label
        svg.querySelectorAll("[data-hhs-temp]").forEach((el) => {
          el.textContent = `${(current / 10).toFixed(1)}\u00B0C`;
          if (tempActive && Math.abs(current - target) > 10) {
            el.textContent += ` \u2192 ${(target / 10).toFixed(1)}\u00B0C`;
          }
        });

        // Shake indicator
        svg.querySelectorAll("[data-hhs-shake]").forEach((el) => {
          el.classList.toggle("hhs-shake--active", shaking);
        });
        svg.querySelectorAll("[data-hhs-shake-label]").forEach((el) => {
          el.textContent = shaking ? `${speed} rpm` : "OFF";
        });

        // Lock indicator
        svg.querySelectorAll("[data-hhs-lock]").forEach((el) => {
          el.textContent = locked ? "\uD83D\uDD12" : "\uD83D\uDD13";
        });
      }

      // --- TCC ---
      const temp = allVars["temp"];
      if (temp) {
        const target = (temp.target_temp_01c as number) || 0;
        const current = (temp.current_temp_01c as number) || 220;
        const isHeating = target > 0;

        svg.querySelectorAll("[data-tcc-temp-fill]").forEach((el) => {
          const maxW = Number((el as SVGElement).dataset.maxW) || 1;
          const pct = isHeating ? Math.min(1, current / 1050) : 0;
          (el as SVGElement).setAttribute("width", String(pct * maxW));
          (el as SVGElement).classList.toggle("tcc-temp-fill--active", isHeating);
        });

        svg.querySelectorAll("[data-tcc-temp]").forEach((el) => {
          el.textContent = `${(current / 10).toFixed(1)}\u00B0C`;
          if (isHeating && Math.abs(current - target) > 10) {
            el.textContent += ` \u2192 ${(target / 10).toFixed(1)}\u00B0C`;
          }
        });
      }

      // --- Wash ---
      const wash = allVars["wash"];
      if (wash) {
        const fluid1 = (wash.fluid_level_1 as number) ?? 200000;
        const fluid2 = (wash.fluid_level_2 as number) ?? 200000;
        const levels = [fluid1, fluid2];

        svg.querySelectorAll("[data-wash-chamber]").forEach((el) => {
          const idx = Number((el as SVGElement).dataset.washChamber) || 0;
          const vol = levels[idx] || 0;
          const pct = Math.min(1, vol / 200000);
          const maxH = Number((el as SVGElement).dataset.maxH) || 1;
          const baseY = Number((el as SVGElement).dataset.baseY) || 0;
          (el as SVGElement).setAttribute("height", String(pct * maxH));
          (el as SVGElement).setAttribute("y", String(baseY + maxH - pct * maxH));
          (el as SVGElement).classList.toggle("wash-fill--low", pct < 0.2);
        });

        svg.querySelectorAll("[data-wash-label]").forEach((el) => {
          const idx = Number(el.textContent?.includes("2") ? 1 : 0);
          const vol = levels[Number((el as SVGElement).dataset.washLabel)] || 0;
          el.textContent = `${(vol / 1000).toFixed(0)} mL`;
        });
      }
    }

    /** Update ghost head position and channel dots. */
    export function updateGhostHead(): void {
      if (!ghostGroup) return;
      if (!State.ghostVisible || State.ghostX <= 0) {
        ghostGroup.style.display = "none";
        return;
      }

      ghostGroup.style.display = "";
      const x = State.ghostX;
      const y = State.ghostY;  // Row A (rear, highest Y)
      const pitch = State.ghostPitch || 90;
      const headW = 80;
      const lastChY = y - 7 * pitch;
      const headTop = lastChY - 20;
      const headH = y - lastChY + 40;

      // Rail
      const rail = ghostGroup.querySelector(".ghost-rail") as SVGLineElement;
      if (rail) { rail.setAttribute("x1", String(x)); rail.setAttribute("x2", String(x)); }

      // Body rect
      const body = ghostGroup.querySelector(".ghost-body") as SVGRectElement;
      if (body) {
        body.setAttribute("x", String(x - headW / 2));
        body.setAttribute("y", String(headTop));
        body.setAttribute("width", String(headW));
        body.setAttribute("height", String(headH));
      }

      // Channel dots — active channels in amber, disabled in gray
      const dots = ghostGroup.querySelectorAll(".ghost-dot");
      for (let ch = 0; ch < 8 && ch < dots.length; ch++) {
        const active = (State.ghostChannelMask & (1 << ch)) !== 0;
        dots[ch].setAttribute("cx", String(x));
        dots[ch].setAttribute("cy", String(y - ch * pitch));
        dots[ch].classList.toggle("ghost-dot--active", active);
        dots[ch].classList.toggle("ghost-dot--disabled", !active);
      }

      // Label — rearward of Row A in deck coords so it renders visually
      // above the ghost body after the viewport Y-flip. `headTop - 20`
      // (the pre-flip "above body" position) would land BELOW the body
      // on screen — every y-flip-related label needs the coord on the
      // rear side of the body instead.
      const label = ghostGroup.querySelector(".ghost-label") as SVGTextElement;
      if (label) {
        const snap = State.ghostSnap;
        label.setAttribute("x", String(x + headW));
        setTextDeckY(label, y + 80);
        const pitchMm = (pitch / 10).toFixed(1);
        label.textContent = snap ? `Col ${snap.col + 1} @ ${snap.carrierId}  [${pitchMm}mm]` : "";
      }

      // Drag handle — sized in deck units so it lands around 24×8 screen
      // pixels at the default fit zoom (deck width ~13150 units / ~880 px),
      // which matches the other interactive on-deck widgets. Positioned in
      // deck-Y `y + 120` (rearward of Row A in deck coords), which after the
      // viewport Y-flip renders above the ghost body — clear of labware
      // rows so the drag target doesn't overlap inspectable wells.
      const handleW = 360;
      const handleH = 120;
      const handleY = y + 120;
      const handle = ghostGroup.querySelector(".ghost-handle") as SVGRectElement;
      if (handle) {
        handle.setAttribute("x", String(x - handleW / 2));
        handle.setAttribute("y", String(handleY));
        handle.setAttribute("width", String(handleW));
        handle.setAttribute("height", String(handleH));
      }
      const glyph = ghostGroup.querySelector(".ghost-handle-glyph") as SVGTextElement;
      if (glyph) {
        glyph.setAttribute("x", String(x));
        setTextDeckY(glyph, handleY + handleH / 2);
        glyph.textContent = "\u2630 DRAG";
      }
    }

    /** Update arm positions (called from Arm.animate on each frame). */
    export function updateArm(): void {
      if (!armsGroup) return;

      // Trajectory overlay — one dashed line per active motion envelope. Cheap
      // to rebuild from scratch because there are at most four of them
      // (pip / iswap / h96 / h384).
      if (trajectoryGroup) {
        const envelopes = Arm.getActiveEnvelopes();
        // Clear and rebuild. Rarely more than 1-2 entries.
        while (trajectoryGroup.firstChild) trajectoryGroup.removeChild(trajectoryGroup.firstChild);
        for (const env of envelopes) {
          const line = svgEl("line", {
            x1: env.startX, y1: env.startY, x2: env.endX, y2: env.endY,
            class: `trajectory trajectory--${env.arm}`,
            "data-arm": env.arm,
            "data-cmd": env.command,
          });
          trajectoryGroup.appendChild(line);
          const endDot = svgEl("circle", {
            cx: env.endX, cy: env.endY, r: 20,
            class: `trajectory-dot trajectory-dot--${env.arm}`,
          });
          trajectoryGroup.appendChild(endDot);
        }
      }

      const opacity = State.armOpacity;
      armsGroup.style.opacity = String(opacity);

      // PIP arm. Previously guarded on `animPipX > 0` which hid the arm at
      // its true home position (pos_x = 0, upper-left). The real device is
      // visibly parked at home on power-on; the twin should mirror that.
      // Top-edge position bar — always visible (even at pos_x=0 on init).
      if (pipArmTopBar) {
        pipArmTopBar.setAttribute("x", String(State.animPipX - ARM_TOP_BAR_WIDTH / 2));
        pipArmTopBar.setAttribute("y", String(deckDims().yRear + ARM_TOP_BAR_MARGIN));
        pipArmTopBar.style.display = "";
      }

      if (pipArmLine && pipArmHead && pipArmLabel && pipArmDots) {
        pipArmLine.setAttribute("x1", String(State.animPipX));
        pipArmLine.setAttribute("x2", String(State.animPipX));
        pipArmLine.style.display = "";

        const headX = State.animPipX;
        const headY = State.animPipY;  // Ch0 = rear (highest Y) — arm-wide fallback
        // Channels are mounted on the X-arm at fixed 9mm nominal pitch
        // IN X (they can't compress along the arm). But each channel
        // has its OWN Y-drive, so per-channel Y positions can legitimately
        // diverge — "channel 0 over plate A, channel 1 over plate B"
        // is a real motion the renderer must show. When the envelope
        // supplies `animPipY_ch`, draw every dot at its own Y; else fall
        // back to the rigid -ch*chPitch block below the arm-wide Y. See
        // feedback_pip_channel_pitch_fixed.md (X-pitch rule stands) and
        // the user's 2026-04-24 correction that Y spread is real.
        const chPitch = 90;
        const headW = 80;
        const yArr = State.animPipY_ch;

        // Head-rect + channel dots make sense only once a command has
        // positioned the arm on a real well (headY > 0). At init the
        // firmware's pos_y[0] is 0, which would draw the rect far below
        // the deck — "head disappears" from the user's point of view.
        // Hide both until the arm has been positioned; the top-bar +
        // rail still convey the X.
        if (headY > 0) {
          const dots = pipArmDots.querySelectorAll("circle");
          // Compute per-channel Y, sourcing from the live envelope
          // array when available. Skips zero entries (a channel not in
          // the command mask whose start snapshot was never captured)
          // by falling back to the rigid-pitch slot so it's still
          // drawn at a sensible location.
          const chY = (ch: number): number => {
            if (yArr && ch < yArr.length && yArr[ch] > 0) return yArr[ch];
            return headY - ch * chPitch;
          };
          // Bounding rect spans the min..max channel Y so a wide spread
          // still looks like one physical head (it IS one — the body
          // that carries all 16 Y drives).
          let yMin = chY(0), yMax = chY(0);
          for (let ch = 1; ch < dots.length; ch++) {
            const y = chY(ch);
            if (y < yMin) yMin = y;
            if (y > yMax) yMax = y;
          }
          const headTop = yMin - 30;
          const headH = (yMax - yMin) + 60;
          pipArmHead.setAttribute("x", String(headX - headW / 2));
          pipArmHead.setAttribute("y", String(headTop));
          pipArmHead.setAttribute("width", String(headW));
          pipArmHead.setAttribute("height", String(headH));
          pipArmHead.style.display = "";

          for (let ch = 0; ch < dots.length; ch++) {
            dots[ch].setAttribute("cx", String(headX));
            dots[ch].setAttribute("cy", String(chY(ch)));
          }
          pipArmDots.style.display = "";
        } else {
          pipArmHead.style.display = "none";
          pipArmDots.style.display = "none";
        }

        pipArmLabel.setAttribute("x", String(headX));
        setTextDeckY(pipArmLabel, deckDims().yRear + ARM_PIP_LABEL_OFFSET_FROM_REAR);
        pipArmLabel.textContent = `PIP ${(State.animPipX / 10).toFixed(0)}mm`;
        pipArmLabel.style.display = "";
        // No head-level Z badge for the PIP arm: individual channels have
        // independent Z (the head doesn't move as one rigid block), so a
        // single aggregate readout is misleading. The channel panel shows
        // per-channel Z already.
        if (pipArmZBadge) pipArmZBadge.style.display = "none";
      } else {
        if (pipArmLine) pipArmLine.style.display = "none";
        if (pipArmHead) pipArmHead.style.display = "none";
        if (pipArmDots) pipArmDots.style.display = "none";
        if (pipArmLabel) pipArmLabel.style.display = "none";
        if (pipArmZBadge) pipArmZBadge.style.display = "none";
      }

      // iSWAP arm — rail, plate overlay (if gripped / mid-move), label, Z badge.
      if (State.animIswapX > 0 && iswapArmLine && iswapArmLabel) {
        iswapArmLine.setAttribute("x1", String(State.animIswapX));
        iswapArmLine.setAttribute("x2", String(State.animIswapX));
        iswapArmLine.style.display = "";
        iswapArmLabel.setAttribute("x", String(State.animIswapX));
        setTextDeckY(iswapArmLabel, DECK_Y_MIN + 120);
        iswapArmLabel.textContent =
          `iSWAP ${(State.animIswapX / 10).toFixed(0)}mm` +
          (State.animIswapGripWidth > 0 ? `  [${Math.round(State.animIswapRotationDeg)}°]` : "");
        iswapArmLabel.style.display = "";

        // Plate group visible whenever jaws are closed on a plate (grip
        // width > 0). Positioned at the arm's (X, Y) with a rotation.
        const plateActive = State.animIswapGripWidth > 0 && State.animIswapY > 0;
        if (iswapPlateGroup && iswapJawLeft && iswapJawRight && iswapPlateRect) {
          if (plateActive) {
            iswapPlateGroup.setAttribute(
              "transform",
              `translate(${State.animIswapX} ${State.animIswapY}) rotate(${State.animIswapRotationDeg})`,
            );
            // Plate footprint comes from the labware under the iSWAP at
            // C0PP time (via MotionEnvelope.startPlateWidth/Height). Falls
            // back to the ANSI/SBS 1278×855 default when no labware was
            // resolvable. Rect is centred at origin so rotation pivots
            // around the plate's centre.
            const plateW = State.animIswapPlateWidth;
            const plateH = State.animIswapPlateHeight;
            iswapPlateRect.setAttribute("x", String(-plateW / 2));
            iswapPlateRect.setAttribute("y", String(-plateH / 2));
            iswapPlateRect.setAttribute("width", String(plateW));
            iswapPlateRect.setAttribute("height", String(plateH));
            // Jaws clamp opposite X-sides of the plate and each runs the
            // full plate Y-span (short edges for landscape).
            const plateYHalf = plateH / 2;
            const halfGrip = State.animIswapGripWidth / 2;
            iswapJawLeft.setAttribute("x1", String(-halfGrip));
            iswapJawLeft.setAttribute("x2", String(-halfGrip));
            iswapJawLeft.setAttribute("y1", String(-plateYHalf));
            iswapJawLeft.setAttribute("y2", String(plateYHalf));
            iswapJawRight.setAttribute("x1", String(halfGrip));
            iswapJawRight.setAttribute("x2", String(halfGrip));
            iswapJawRight.setAttribute("y1", String(-plateYHalf));
            iswapJawRight.setAttribute("y2", String(plateYHalf));
            iswapPlateGroup.style.display = "";
          } else {
            iswapPlateGroup.style.display = "none";
          }
        }
        // Z badge — shows current iSWAP Z; engaged when z > 0 (the
        // iSWAP's only descents are for grab/place).
        updateZBadge(iswapZBadge, State.animIswapX, DECK_Y_MAX - 120, State.animIswapZ, 0);
      } else {
        if (iswapArmLine) iswapArmLine.style.display = "none";
        if (iswapArmLabel) iswapArmLabel.style.display = "none";
        if (iswapPlateGroup) iswapPlateGroup.style.display = "none";
        if (iswapZBadge) iswapZBadge.style.display = "none";
      }

      // 96-Head arm — wider block representing the 8x12 head
      if (State.animH96X > 0 && h96ArmLine && h96ArmHead && h96ArmLabel) {
        h96ArmLine.setAttribute("x1", String(State.animH96X));
        h96ArmLine.setAttribute("x2", String(State.animH96X));
        h96ArmLine.style.display = "";
        // 96-head covers 12 columns * 90 pitch = 1080 wide, 8 rows * 90 = 630 tall
        const colPitch = 90;
        const rowPitch = 90;
        const headW = 11 * colPitch;
        const headH = 7 * rowPitch;
        const headY = State.animH96Y;  // Row A (rear, highest Y)
        const margin = 40;
        h96ArmHead.setAttribute("x", String(State.animH96X - margin));
        h96ArmHead.setAttribute("y", String(headY - headH - margin));
        h96ArmHead.setAttribute("width", String(headW + 2 * margin));
        h96ArmHead.setAttribute("height", String(headH + 2 * margin));
        h96ArmHead.style.display = "";
        // Position 96 channel dots: 8 rows (A-H) x 12 columns
        if (h96ArmDots) {
          const dots = h96ArmDots.querySelectorAll("circle");
          for (let col = 0; col < 12; col++) {
            for (let row = 0; row < 8; row++) {
              const idx = col * 8 + row;
              if (idx < dots.length) {
                dots[idx].setAttribute("cx", String(State.animH96X + col * colPitch));
                dots[idx].setAttribute("cy", String(headY - row * rowPitch));
              }
            }
          }
          h96ArmDots.style.display = "";
        }
        h96ArmLabel.setAttribute("x", String(State.animH96X + headW / 2));
        setTextDeckY(h96ArmLabel, DECK_Y_MIN + 80);
        h96ArmLabel.textContent = `96-Head ${(State.animH96X / 10).toFixed(0)}mm`;
        h96ArmLabel.style.display = "";
        // Z badge: rearward of headY (body rear edge ≈ headY + margin) so
        // the Y-flipped viewport renders it above the head on screen.
        updateZBadge(h96ArmZBadge, State.animH96X + headW / 2, headY + 260, State.animH96Z, 0);
      } else {
        if (h96ArmLine) h96ArmLine.style.display = "none";
        if (h96ArmHead) h96ArmHead.style.display = "none";
        if (h96ArmDots) h96ArmDots.style.display = "none";
        if (h96ArmLabel) h96ArmLabel.style.display = "none";
        if (h96ArmZBadge) h96ArmZBadge.style.display = "none";
      }

      // 384-Head arm — X/Y rail, head rect, label, Z badge. Footprint
      // is 24 columns × 16 rows at 4.5 mm pitch (23 × 4.5 = 103.5 mm ×
      // 15 × 4.5 = 67.5 mm). Position head so A1 (rear-most) is at animH384Y.
      if (State.animH384X > 0 && h384ArmLine && h384ArmLabel && h384ArmHead) {
        const h384ColPitch = 45;  // 0.1mm (4.5 mm, 384-well standard)
        const h384RowPitch = 45;
        const h384W = 23 * h384ColPitch;
        const h384H = 15 * h384RowPitch;
        const h384Y = State.animH384Y || 0;
        const h384Margin = 40;
        h384ArmLine.setAttribute("x1", String(State.animH384X));
        h384ArmLine.setAttribute("x2", String(State.animH384X));
        h384ArmLine.style.display = "";
        h384ArmHead.setAttribute("x", String(State.animH384X - h384Margin));
        h384ArmHead.setAttribute("y", String(h384Y - h384H - h384Margin));
        h384ArmHead.setAttribute("width", String(h384W + 2 * h384Margin));
        h384ArmHead.setAttribute("height", String(h384H + 2 * h384Margin));
        h384ArmHead.style.display = "";
        h384ArmLabel.setAttribute("x", String(State.animH384X + h384W / 2));
        setTextDeckY(h384ArmLabel, DECK_Y_MIN + 120);
        h384ArmLabel.textContent = `384-Head ${(State.animH384X / 10).toFixed(0)}mm`;
        h384ArmLabel.style.display = "";
        // Badge rearward of h384Y (body rear edge ≈ h384Y + h384Margin)
        // so the Y-flip renders it above the head on screen.
        updateZBadge(h384ArmZBadge, State.animH384X + h384W / 2, h384Y + 260, State.animH384Z, 0);
      } else {
        if (h384ArmLine) h384ArmLine.style.display = "none";
        if (h384ArmHead) h384ArmHead.style.display = "none";
        if (h384ArmLabel) h384ArmLabel.style.display = "none";
        if (h384ArmZBadge) h384ArmZBadge.style.display = "none";
      }

      // AutoLoad carriage: center-track-aligned rect that slides on the
      // front rail. Hidden when pos_track === 0 (parked at home tray).
      if (autoloadCarriage && autoloadCarriageRect && autoloadCarriageLabel) {
        if (State.autoloadParked || State.animAutoloadX <= 0) {
          autoloadCarriage.style.display = "none";
        } else {
          const AUTOLOAD_W = 225;
          const x = State.animAutoloadX - AUTOLOAD_W / 2;
          autoloadCarriageRect.setAttribute("x", String(x));
          autoloadCarriageLabel.setAttribute("x", String(State.animAutoloadX));
          autoloadCarriage.style.display = "";
        }
      }
    }

    // ── Builder helpers ─────────────────────────────────────────────────

    function buildCarrier(carrier: any, ci: number): SVGGElement {
      const g = svgEl("g", { class: "carrier", "data-carrier-id": carrier.id, "data-carrier-idx": ci });
      const hasLabware = carrier.labware.some((lw: any) => lw !== null);

      // Carrier rect — uses physical carrier Y dimension. Falls back to
      // the loaded deck's carrier span (`yRear - yFront`) when the
      // carrier didn't come with its own `yDim` (default-deck synthesised
      // carriers often lack it).
      const cw = carrier.xMax - carrier.xMin;
      const dims = deckDims();
      const carrierH = carrier.yDim || (dims.yRear - dims.yFront);
      g.appendChild(svgEl("rect", {
        x: carrier.xMin, y: dims.yFront, width: cw, height: carrierH,
        class: hasLabware ? "carrier-bg" : "carrier-bg carrier-bg--empty",
        rx: 20, ry: 20,
      }));

      // Carrier label
      const label = svgDeckText( {
        x: (carrier.xMin + carrier.xMax) / 2, y: Y_FRONT + carrierH + 80,
        class: "carrier-label",
      });
      label.textContent = carrier.id;
      g.appendChild(label);

      // Labware — positioned using real site offsets when available
      const posCount = Math.min(carrier.positions, carrier.labware.length);

      for (let i = 0; i < posCount; i++) {
        const lw = carrier.labware[i];
        const posBaseY = getSiteBaseY(carrier, i);

        const slotG = svgEl("g", {
          class: "labware-slot",
          "data-carrier-id": carrier.id,
          "data-position": i,
        });

        if (!lw) {
          // Empty slot — draw a dashed placeholder sized to a standard
          // 96-well footprint and label it with VENUS's SiteId.
          //
          // VENUS numbers sites 1..N back-to-front (SiteId 1 = back-most,
          // farthest from the operator). After the position flip (pos 0 =
          // rear = VENUS SiteId 1), our index `i` already matches VENUS
          // 1..N order, so the label is just `i + 1`. Using
          // `carrier.positions - i` here dates back to the old
          // front-first indexing — that produced the wrong labels (5 at
          // the top, 1 at the bottom) VENUS shows the opposite.
          const refA1Y = posBaseY + 745;
          const refLastY = refA1Y - 7 * 90;
          const refPad = 54;
          const slotY = refLastY - refPad;
          const slotH = (refA1Y - refLastY) + 2 * refPad;
          slotG.appendChild(svgEl("rect", {
            x: carrier.xMin + 15, y: slotY, width: cw - 30, height: slotH,
            class: "slot-empty", rx: 15, ry: 15,
          }));
          const venusSiteId = i + 1;
          const label = svgDeckText({
            x: carrier.xMin + cw / 2, y: slotY + slotH / 2 + 30,
            class: "slot-empty-label",
          });
          label.textContent = String(venusSiteId);
          slotG.appendChild(label);
        } else {
          const typeL = lw.type.toLowerCase();
          const isTipRack = lw.type.includes("Tip");
          const isTrough = lw.type.includes("Trough") || lw.type.includes("Rgt");
          const isWash = lw.type.includes("Wash");
          const isHHS = lw.type.includes("HHS");
          const isTCC = lw.type.includes("TCC");
          const is300 = lw.type.includes("300");
          // Waste fixtures (Core96SlideWaste, WasteBlock, tip waste
          // blocks, teaching needles) are `labware` only in the VENUS
          // sense — there are no wells to pipette into. Drawing the
          // default 8×12 well grid on them is meaningless. Flag so we
          // render a solid block with a WASTE glyph instead.
          const isWaste = (typeL.includes("waste") && !typeL.includes("wash"))
            || typeL.includes("needle") || typeL.includes("verification");

          // Compute ACTUAL well grid extent from offsets.
          // Use `??` not `||` so offsetY=0 (the value .lay imports set
          // when anchoring row-A to the VENUS site Y) is respected
          // instead of falling through to the 745 SBS default. The
          // well grid (buildWellGrid below) MUST use the same default
          // — a mismatch there drew the background rect 63 mm away
          // from the well circles on .lay-imported labware.
          const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
          const rows = lw.rows ?? (lw.wellCount > 96 ? 16 : 8);
          const pitch = lw.wellPitch ?? 90;
          const ofsX = lw.offsetX ?? 33;
          const ofsY = lw.offsetY ?? 745;

          // Well A1 absolute position (row 0, col 0)
          const a1X = carrier.xMin + ofsX;
          const a1Y = posBaseY + ofsY;  // Row A (rear, highest Y)
          // Last well: row=rows-1, col=cols-1
          const lastRowY = a1Y - (rows - 1) * pitch;  // Row H/P (front, lowest Y)
          const lastColX = a1X + (cols - 1) * pitch;

          // Plate footprint. Prefer the actual `.rck`-sourced outer
          // dimensions (rackDx/rackDy) + first-well boundary (bndryX/Y)
          // when they're set — that gives a Cos_96_DW a 127×86 mm body
          // and a 300-µL tip rack a 122.4×82.6 mm body, matching what
          // VENUS draws. Fall back to a pitch-derived estimate when
          // the labware came from the hand-curated templates (older
          // default deck) which don't carry these fields.
          let plateX: number, plateY: number, plateW: number, plateH: number;

          const hasRackDims = lw.rackDx && lw.rackDy && lw.bndryX !== undefined && lw.bndryY !== undefined;
          if (hasRackDims) {
            // Rack origin is at row-A / col-1 minus the boundary offsets.
            plateX = a1X - (lw.bndryX ?? 0);
            plateY = (a1Y + (lw.bndryY ?? 0)) - (lw.rackDy ?? 0);
            plateW = lw.rackDx ?? 0;
            plateH = lw.rackDy ?? 0;
          } else if ((isTrough || isWash) && lw.wellCount <= 2) {
            // Trough/wash: match the same vertical footprint as a 96-well plate
            // in the same slot position, using standard 8-row grid math.
            const refPitch = 90;
            const refRows = 8;
            const refOfsY = 745;
            const refA1Y = posBaseY + refOfsY;
            const refLastY = refA1Y - (refRows - 1) * refPitch;
            const refPad = refPitch * 0.6;
            plateX = carrier.xMin + 40;
            plateW = cw - 80;
            plateY = refLastY - refPad;
            plateH = (refA1Y - refLastY) + 2 * refPad;
          } else {
            const pad = isTrough ? 40 : pitch * 0.6;
            plateX = Math.min(a1X, lastColX) - pad;
            plateY = Math.min(a1Y, lastRowY) - pad;
            plateW = Math.abs(lastColX - a1X) + 2 * pad;
            plateH = Math.abs(a1Y - lastRowY) + 2 * pad;
          }

          // Labware body — distinct classes per type
          const lwClass = isWaste ? "labware-bg labware-bg--waste"
            : isTipRack ? (is300 ? "labware-bg labware-bg--tips300" : "labware-bg labware-bg--tips")
            : isTrough ? "labware-bg labware-bg--trough"
            : isWash ? "labware-bg labware-bg--wash"
            : isHHS ? "labware-bg labware-bg--hhs"
            : isTCC ? "labware-bg labware-bg--tcc"
            : "labware-bg labware-bg--plate";
          slotG.appendChild(svgEl("rect", {
            x: plateX, y: plateY, width: plateW, height: plateH,
            class: lwClass, rx: 15, ry: 15,
          }));

          // Contents — type-specific rendering
          if (isWaste) {
            // Waste block: solid rect with a WASTE glyph in the centre.
            // No wells, no dots — there's nothing pipette-addressable.
            const wasteGlyph = svgDeckText({
              x: plateX + plateW / 2,
              y: plateY + plateH / 2 + 20,
              class: "labware-waste-glyph",
            });
            wasteGlyph.textContent = "WASTE";
            slotG.appendChild(wasteGlyph);
          } else if (isTrough) {
            buildTrough(slotG, carrier, i, plateX, plateY, plateW, plateH);
          } else if (isWash) {
            buildWashChamber(slotG, carrier, i, plateX, plateY, plateW, plateH);
          } else if (isHHS) {
            buildHHSPlate(slotG, carrier, i, lw, plateX, plateY, plateW, plateH);
          } else if (isTCC) {
            buildTCCPlate(slotG, carrier, i, lw, plateX, plateY, plateW, plateH);
          } else {
            buildWellGrid(slotG, carrier, i, lw, isTipRack, is300);
          }

          // Label — below the plate (in deck-Y → visually above after
          // Y-flip since the plate extends DOWN in screen space from Row A).
          // Badge format: short descriptive name (e.g. "DW 96", "Tip
          // 1000 µL", "Trough") — VENUS uses the same kind of short
          // tags in its editor, much easier to read at deck-zoom than
          // the full `Cos_96_DW_2mL_Rd` stem. #58.
          const lwLabel = svgDeckText({
            x: plateX + plateW / 2, y: plateY + plateH + 45,
            class: "labware-label",
          });
          lwLabel.textContent = isWash ? `Chamber ${i + 1}`
            : isHHS ? "Heater/Shaker"
            : isTCC ? "Temp Ctrl"
            : formatLabwareBadge(lw);
          slotG.appendChild(lwLabel);
        }

        g.appendChild(slotG);
      }

      return g;
    }

    function buildWellGrid(
      parent: SVGGElement, carrier: any, posIdx: number,
      lw: any, isTipRack: boolean, is300: boolean,
    ): void {
      // Defaults must match the labware-background-rect code above
      // (look for `// Compute ACTUAL well grid extent from offsets`).
      // Previously this used `|| 115` while the rect used `|| 745`, so
      // .lay-imported labware with offsetY=0 drew the background 63 mm
      // away from the well circles. Both now read the same value via
      // `??` which respects a legitimate zero.
      const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
      const rows = lw.rows ?? (lw.wellCount > 96 ? 16 : 8);
      const wellPitch = lw.wellPitch ?? 90;
      const ofsX = lw.offsetX ?? 33;
      const ofsY = lw.offsetY ?? 745;

      const posBaseY = getSiteBaseY(carrier, posIdx);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const wellIdx = row * cols + col;
          const cx = carrier.xMin + ofsX + col * wellPitch;
          // Row A (0) at rear (high Y), Row H (7) at front (low Y) — matches deck.ts
          const cy = posBaseY + ofsY - row * wellPitch;
          const key = `${carrier.id}:${posIdx}:${wellIdx}`;
          const r = isTipRack ? 14 : (lw.wellCount > 96 ? 8 : 12);

          const circle = svgEl("circle", {
            cx, cy, r,
            class: isTipRack ? (is300 ? "tip tip--300" : "tip") : "well",
            "data-well-key": key,
            "data-carrier-id": carrier.id,
            "data-position": posIdx,
            "data-well-idx": wellIdx,
          });
          parent.appendChild(circle);
        }
      }
    }

    function buildTrough(
      parent: SVGGElement, carrier: any, posIdx: number,
      x: number, y: number, w: number, h: number,
    ): void {
      const key = `${carrier.id}:${posIdx}:0`;
      const inset = 20;

      // Inner well area (the reservoir basin)
      parent.appendChild(svgEl("rect", {
        x: x + inset, y: y + inset, width: w - inset * 2, height: h - inset * 2,
        class: "trough-basin", rx: 12, ry: 12,
      }));

      // Liquid fill — starts from bottom, height based on volume
      const fillH = h - inset * 2;
      const fillRect = svgEl("rect", {
        x: x + inset + 4, y: y + inset + 4,
        width: w - inset * 2 - 8, height: fillH - 8,
        class: "trough-fill",
        "data-well-key": key,
        "data-max-h": fillH - 8,
        "data-base-y": y + inset + 4,
        rx: 8, ry: 8,
      });
      parent.appendChild(fillRect);

      // Volume label — updated live by updateTracking() from wellVolumes[key].
      const label = svgDeckText( {
        x: x + w / 2, y: y + h / 2 + 15,
        class: "trough-volume-label",
        "data-well-key": key,
      });
      label.textContent = "empty";
      parent.appendChild(label);
    }

    /** Wash chamber — fluid basin with level indicator and cycle count */
    function buildWashChamber(
      parent: SVGGElement, carrier: any, posIdx: number,
      x: number, y: number, w: number, h: number,
    ): void {
      const key = `wash:${carrier.id}:${posIdx}`;
      const inset = 25;

      // Inner basin (darker)
      parent.appendChild(svgEl("rect", {
        x: x + inset, y: y + inset, width: w - inset * 2, height: h - inset * 2,
        class: "wash-basin", rx: 12, ry: 12,
      }));

      // Fluid fill — starts from bottom
      const fillH = h - inset * 2;
      const fillRect = svgEl("rect", {
        x: x + inset + 4, y: y + inset + 4,
        width: w - inset * 2 - 8, height: fillH - 8,
        class: "wash-fill",
        "data-wash-chamber": posIdx,
        "data-max-h": fillH - 8,
        "data-base-y": y + inset + 4,
        rx: 8, ry: 8,
      });
      parent.appendChild(fillRect);

      // Wash icon — wavy lines
      const cx = x + w / 2;
      const cy = y + h / 2 - 30;
      for (let wave = 0; wave < 3; wave++) {
        const wy = cy + wave * 45;
        const path = svgEl("path", {
          d: `M${cx - 80},${wy} q20,-20 40,0 q20,20 40,0 q20,-20 40,0`,
          class: "wash-wave",
        });
        parent.appendChild(path);
      }

      // Label
      const label = svgDeckText( {
        x: cx, y: y + h - inset - 20,
        class: "wash-label",
      });
      label.textContent = "200 mL";
      label.setAttribute("data-wash-label", String(posIdx));
      parent.appendChild(label);
    }

    /** HHS plate — 96-well plate with temperature bar and shake indicator */
    function buildHHSPlate(
      parent: SVGGElement, carrier: any, posIdx: number,
      lw: any, x: number, y: number, w: number, h: number,
    ): void {
      // Well grid (standard 96-well)
      buildWellGrid(parent, carrier, posIdx, lw, false, false);

      // Temperature bar along the bottom
      const barH = 30;
      parent.appendChild(svgEl("rect", {
        x: x + 10, y: y + h - barH - 8, width: w - 20, height: barH,
        class: "hhs-temp-bar", rx: 6, ry: 6,
      }));
      // Temperature fill (animated width based on state)
      const tempFill = svgEl("rect", {
        x: x + 12, y: y + h - barH - 6, width: 0, height: barH - 4,
        class: "hhs-temp-fill", rx: 4, ry: 4,
        "data-hhs-temp-fill": "1",
        "data-max-w": w - 24,
      });
      parent.appendChild(tempFill);

      // Temperature readout
      const tempLabel = svgDeckText( {
        x: x + w / 2, y: y + h - barH / 2 - 5,
        class: "hhs-temp-label",
      });
      tempLabel.textContent = "25.0\u00B0C";
      tempLabel.setAttribute("data-hhs-temp", "1");
      parent.appendChild(tempLabel);

      // Shake indicator icon (orbit circle at top-right)
      const shakeG = svgEl("g", { class: "hhs-shake-icon", "data-hhs-shake": "1" });
      const sx = x + w - 50;
      const sy = y + 40;
      shakeG.appendChild(svgEl("circle", { cx: sx, cy: sy, r: 25, class: "hhs-shake-ring" }));
      shakeG.appendChild(svgEl("circle", { cx: sx + 12, cy: sy, r: 6, class: "hhs-shake-dot" }));
      const shakeLabel = svgDeckText( { x: sx, y: sy + 45, class: "hhs-shake-label" });
      shakeLabel.textContent = "OFF";
      shakeLabel.setAttribute("data-hhs-shake-label", "1");
      shakeG.appendChild(shakeLabel);
      parent.appendChild(shakeG);

      // Lock indicator (padlock icon at top-left)
      const lockLabel = svgDeckText( { x: x + 35, y: y + 50, class: "hhs-lock-label" });
      lockLabel.textContent = "\uD83D\uDD13";  // unlocked padlock
      lockLabel.setAttribute("data-hhs-lock", "1");
      parent.appendChild(lockLabel);
    }

    /** TCC plate — 96-well plate with temperature gradient background */
    function buildTCCPlate(
      parent: SVGGElement, carrier: any, posIdx: number,
      lw: any, x: number, y: number, w: number, h: number,
    ): void {
      // Well grid (standard 96-well)
      buildWellGrid(parent, carrier, posIdx, lw, false, false);

      // Temperature bar along the bottom
      const barH = 30;
      parent.appendChild(svgEl("rect", {
        x: x + 10, y: y + h - barH - 8, width: w - 20, height: barH,
        class: "tcc-temp-bar", rx: 6, ry: 6,
      }));
      const tempFill = svgEl("rect", {
        x: x + 12, y: y + h - barH - 6, width: 0, height: barH - 4,
        class: "tcc-temp-fill", rx: 4, ry: 4,
        "data-tcc-temp-fill": "1",
        "data-max-w": w - 24,
      });
      parent.appendChild(tempFill);

      // Temperature readout
      const tempLabel = svgDeckText( {
        x: x + w / 2, y: y + h - barH / 2 - 5,
        class: "tcc-temp-label",
      });
      tempLabel.textContent = "22.0\u00B0C";
      tempLabel.setAttribute("data-tcc-temp", "1");
      parent.appendChild(tempLabel);
    }

    /** Short "DW 96" / "Tip 1000 µL" / "Trough" style badge derived
     *  from a labware type stem. Matches VENUS's compact editor labels,
     *  which read far better than the full `Cos_96_DW_2mL_Rd` name at
     *  deck zoom. #58. */
    function formatLabwareBadge(lw: any): string {
      const type = String(lw?.type ?? "");
      const lower = type.toLowerCase();
      // Waste / verification sites on the right-edge waste block — keep
      // the label terse, they're visual markers, not interactive items.
      if (lower.includes("slidewaste")) return "Slide Waste";
      if (lower.includes("extwaste")) return "Ext. Waste";
      if (lower.includes("teachingneedle")) return "Teach Needle";
      if (lower.startsWith("waste")) return "Waste";
      if (lower.includes("verification")) return "Verification";
      // Tips — pull out volume token from `Tips_<NN>uL[_STF][_L][_F]`.
      const tipMatch = /Tips?_(\d+)uL/i.exec(type);
      if (tipMatch) return `Tip ${tipMatch[1]} \u00B5L`;
      // Troughs — volume token from `Trough_<NN>ml` or `Reagent_<NN>ml`.
      const troughMatch = /Trough_(\d+)ml/i.exec(type) || /Reagent_(\d+)ml/i.exec(type);
      if (troughMatch) return `Trough ${troughMatch[1]} mL`;
      // Cos_96_... → "DW 96" / "RD 96" / "96-well".
      const cosMatch = /Cos_(\d+)_(\w+?)(?:_(\w+))?$/i.exec(type);
      if (cosMatch) {
        const wells = cosMatch[1];
        const shape = (cosMatch[2] || "").toLowerCase();
        if (shape.startsWith("dw")) return `DW ${wells}`;
        if (shape.startsWith("rd")) return `RD ${wells}`;
        if (shape.startsWith("vb")) return `V ${wells}`;
        if (shape.startsWith("pcr")) return `PCR ${wells}`;
        return `${wells}-well`;
      }
      // Fall back to a terse form — strip the longest common prefixes
      // and trailing revision suffixes (`_A00`, `_B00`, `_L`, `_F`, …).
      const wellCount = lw?.wellCount;
      const base = type
        .replace(/_([A-Z]\d{2}|L|F|STF|HD|A00|B00)$/, "")
        .replace(/_/g, " ")
        .slice(0, 14);
      return wellCount && wellCount > 1 ? `${base} (${wellCount})` : base;
    }

    /** Render a non-track deck fixture (96-head waste, puncher, gripper
     *  park — see #57). Coordinates are in the same 0.1 mm deck frame
     *  as carriers, so the existing viewBox math handles letterboxing
     *  and zoom. Kinds map to distinct CSS classes with glyph + colour. */
    function buildFixture(f: any): SVGGElement {
      const g = svgEl("g", {
        class: `deck-fixture deck-fixture--${f.kind}${f.visible ? "" : " deck-fixture--hidden-default"}`,
        "data-fixture-id": String(f.id),
      });
      g.appendChild(svgEl("rect", {
        x: f.x, y: f.y, width: f.dx, height: f.dy,
        class: `deck-fixture-bg deck-fixture-bg--${f.kind}`,
        rx: 12, ry: 12,
      }));
      const GLYPHS: Record<string, string> = {
        tipwaste96:       "96 HEAD WASTE",
        tipwaste96slide:  "96 SLIDE WASTE",
        wasteblock:       "WASTE",
        puncher:          "PUNCHER",
        edge:             "",
        other:            "",
      };
      const text = GLYPHS[f.kind] || String(f.id);
      if (text) {
        const glyph = svgDeckText({
          x: f.x + f.dx / 2,
          y: f.y + f.dy / 2,
          class: `deck-fixture-glyph deck-fixture-glyph--${f.kind}`,
        });
        glyph.setAttribute("text-anchor", "middle");
        glyph.setAttribute("dominant-baseline", "central");
        glyph.textContent = text;
        g.appendChild(glyph);
      }
      return g;
    }

    function buildTipWaste(tw: any): SVGGElement {
      const g = svgEl("g", { class: "tipwaste" });
      const x = tw.xMin;
      const w = tw.xMax - tw.xMin;
      // Y bounds come from the backend snapshot — keeps renderer and
      // getWasteEjectPositions() using the same range.
      const y = tw.yMin ?? 730;
      const h = (tw.yMax ?? 4430) - y;

      // Background
      g.appendChild(svgEl("rect", {
        x, y, width: w, height: h,
        class: "tipwaste-bg", rx: 20, ry: 20,
      }));

      // Fill level
      const fillPct = Math.min(1, tw.tipCount / tw.capacity);
      g.appendChild(svgEl("rect", {
        x: x + 5, y: y + h - fillPct * h, width: w - 10, height: fillPct * h,
        class: fillPct > 0.8 ? "tipwaste-fill tipwaste-fill--warning" : "tipwaste-fill",
        "data-max-h": h, "data-base-y": y,
        rx: 15, ry: 15,
      }));

      // Labels
      const titleLabel = svgDeckText( { x: x + w / 2, y: y + h + 80, class: "tipwaste-label" });
      titleLabel.textContent = "TIP WASTE";
      g.appendChild(titleLabel);
      const countLabel = svgDeckText( { x: x + w / 2, y: y + h + 160, class: "tipwaste-count tipwaste-label" });
      countLabel.textContent = `${tw.tipCount}/${tw.capacity}`;
      g.appendChild(countLabel);

      return g;
    }

    /** Build a small Z-badge group: a pill-shaped background with a
     *  text child. Used to show "Z 48mm" next to each arm head; CSS
     *  colour-codes based on below-traverse state.
     *  Returns the <g> with two children: [0] the rect, [1] the text. */
    function buildZBadge(className: string): SVGGElement {
      const g = svgEl("g", { class: className });
      g.appendChild(svgEl("rect", {
        x: 0, y: 0, width: 360, height: 140, rx: 28, ry: 28, class: "arm-z-badge-bg",
      }));
      const t = svgDeckText( { x: 180, y: 95, class: "arm-z-badge-text" });
      t.setAttribute("text-anchor", "middle");
      g.appendChild(t);
      g.style.display = "none";
      return g;
    }

    /** Update a Z badge: position, text, and a CSS class that flips
     *  when z > traverse (i.e. tip engaged in labware). */
    function updateZBadge(
      badge: SVGGElement | null,
      x: number, y: number,
      z: number, traverse: number,
    ): void {
      if (!badge) return;
      const mm = z / 10;
      const engaged = z > traverse && z > 0;
      badge.setAttribute("transform", `translate(${x - 180} ${y - 220})`);
      const text = badge.querySelector("text");
      if (text) text.textContent = `Z ${mm.toFixed(0)}mm`;
      badge.classList.toggle("arm-z-badge--engaged", engaged);
      badge.style.display = "";
    }

    function buildArmElements(): void {
      if (!armsGroup) return;

      // PIP arm rail
      pipArmLine = svgEl("line", {
        x1: 0, y1: DECK_Y_MIN, x2: 0, y2: DECK_Y_MAX,
        class: "arm-pip-rail",
      });
      pipArmLine.style.display = "none";
      armsGroup.appendChild(pipArmLine);

      // PIP arm head
      pipArmHead = svgEl("rect", {
        x: 0, y: 0, width: 80, height: 700,
        class: "arm-pip-head", rx: 15, ry: 15,
      });
      pipArmHead.style.display = "none";
      armsGroup.appendChild(pipArmHead);

      // PIP channel dots
      pipArmDots = svgEl("g", { class: "arm-pip-dots" });
      for (let ch = 0; ch < 8; ch++) {
        pipArmDots.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 10, class: "arm-pip-dot" }));
      }
      pipArmDots.style.display = "none";
      armsGroup.appendChild(pipArmDots);

      // PIP label + Z badge (max channel depth readout).
      pipArmLabel = svgDeckText( { x: 0, y: 0, class: "arm-pip-label" });
      pipArmLabel.style.display = "none";
      armsGroup.appendChild(pipArmLabel);
      pipArmZBadge = buildZBadge("arm-pip-zbadge");
      armsGroup.appendChild(pipArmZBadge);

      // Top-edge head-position bar — always visible, matches the
      // arm-position indicator VENUS draws above the deck in its
      // Layout Editor. Gives the user an immediate cue for "where
      // is the arm?" even before any command has moved it.
      pipArmTopBar = svgEl("rect", {
        x: 0, y: 0, width: ARM_TOP_BAR_WIDTH, height: ARM_TOP_BAR_HEIGHT,
        rx: ARM_TOP_BAR_HEIGHT * 0.15, ry: ARM_TOP_BAR_HEIGHT * 0.15,
        class: "arm-pip-topbar",
      });
      armsGroup.appendChild(pipArmTopBar);

      // iSWAP arm rail
      iswapArmLine = svgEl("line", {
        x1: 0, y1: DECK_Y_MIN, x2: 0, y2: DECK_Y_MAX,
        class: "arm-iswap-rail",
      });
      iswapArmLine.style.display = "none";
      armsGroup.appendChild(iswapArmLine);

      // iSWAP plate overlay — a group that rotates around the plate
      // centre so we can animate orientation changes (landscape ↔
      // portrait) plus jaw open/close. Plate footprint uses the SBS
      // microplate standard (127.76 × 85.48 mm = 1278 × 855 in 0.1mm);
      // not a magic number, it's the ANSI/SLAS-1-2004 plate geometry.
      iswapPlateGroup = svgEl("g", { class: "arm-iswap-plate" });
      iswapPlateRect = svgEl("rect", {
        x: -639, y: -427, width: 1278, height: 855,    // centred at (0,0)
        rx: 20, ry: 20, class: "arm-iswap-plate-rect",
      });
      iswapPlateGroup.appendChild(iswapPlateRect);
      // Jaws — vertical lines at ±gripWidth/2 along the plate's X axis
      // (short edges when landscape). Updated per-frame in updateArm.
      iswapJawLeft = svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 0, class: "arm-iswap-jaw" });
      iswapJawRight = svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 0, class: "arm-iswap-jaw" });
      iswapPlateGroup.appendChild(iswapJawLeft);
      iswapPlateGroup.appendChild(iswapJawRight);
      // Orientation tick — short line pointing "north" of the plate so
      // you can read 0° vs 90° at a glance.
      iswapRotationMark = svgEl("line", { x1: 0, y1: -520, x2: 0, y2: -380, class: "arm-iswap-rotmark" });
      iswapPlateGroup.appendChild(iswapRotationMark);
      iswapPlateGroup.style.display = "none";
      armsGroup.appendChild(iswapPlateGroup);

      // iSWAP label + Z badge
      iswapArmLabel = svgDeckText( { x: 0, y: 0, class: "arm-iswap-label" });
      iswapArmLabel.style.display = "none";
      armsGroup.appendChild(iswapArmLabel);
      iswapZBadge = buildZBadge("arm-iswap-zbadge");
      armsGroup.appendChild(iswapZBadge);

      // 96-Head arm
      h96ArmLine = svgEl("line", { x1: 0, y1: DECK_Y_MIN, x2: 0, y2: DECK_Y_MAX, class: "arm-h96-rail" });
      h96ArmLine.style.display = "none";
      armsGroup.appendChild(h96ArmLine);
      h96ArmHead = svgEl("rect", { x: 0, y: 0, width: 1000, height: 700, class: "arm-h96-head", rx: 15, ry: 15 });
      h96ArmHead.style.display = "none";
      armsGroup.appendChild(h96ArmHead);
      // 96 channel dots (8 rows x 12 cols)
      h96ArmDots = svgEl("g", { class: "arm-h96-dots" });
      for (let i = 0; i < 96; i++) {
        h96ArmDots.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 18, class: "arm-h96-dot" }));
      }
      h96ArmDots.style.display = "none";
      armsGroup.appendChild(h96ArmDots);
      h96ArmLabel = svgDeckText( { x: 0, y: 0, class: "arm-h96-label" });
      h96ArmLabel.style.display = "none";
      armsGroup.appendChild(h96ArmLabel);
      h96ArmZBadge = buildZBadge("arm-h96-zbadge");
      armsGroup.appendChild(h96ArmZBadge);

      // 384-Head arm — rail, head rect, label, Z badge. The head is
      // 24 columns × 16 rows at 4.5 mm pitch = 103.5 × 67.5 mm footprint.
      h384ArmLine = svgEl("line", { x1: 0, y1: DECK_Y_MIN, x2: 0, y2: DECK_Y_MAX, class: "arm-h384-rail" });
      h384ArmLine.style.display = "none";
      armsGroup.appendChild(h384ArmLine);
      h384ArmHead = svgEl("rect", { x: 0, y: 0, width: 1035, height: 675, class: "arm-h384-head", rx: 15, ry: 15 });
      h384ArmHead.style.display = "none";
      armsGroup.appendChild(h384ArmHead);
      h384ArmLabel = svgDeckText( { x: 0, y: 0, class: "arm-h384-label" });
      h384ArmLabel.style.display = "none";
      armsGroup.appendChild(h384ArmLabel);
      h384ArmZBadge = buildZBadge("arm-h384-zbadge");
      armsGroup.appendChild(h384ArmZBadge);

      // AutoLoad carriage — sits on the deck front rail (top of the
      // viewBox in SVG coords, since front = lower Y). Rect is one track
      // wide and slides in X as C0CL/C0CR envelopes animate.
      const AUTOLOAD_W = 225;    // one track wide
      const AUTOLOAD_H = 150;    // carriage visible height
      const AUTOLOAD_Y = DECK_Y_MIN + 30;
      autoloadCarriage = svgEl("g", { class: "autoload-carriage" });
      autoloadCarriage.style.display = "none";
      autoloadCarriageRect = svgEl("rect", {
        x: 0, y: AUTOLOAD_Y, width: AUTOLOAD_W, height: AUTOLOAD_H,
        rx: 8, ry: 8, class: "autoload-carriage-body",
      });
      autoloadCarriage.appendChild(autoloadCarriageRect);
      autoloadCarriageLabel = svgDeckText( {
        x: AUTOLOAD_W / 2, y: AUTOLOAD_Y + AUTOLOAD_H / 2 + 5,
        class: "autoload-carriage-label",
      });
      autoloadCarriageLabel.setAttribute("text-anchor", "middle");
      autoloadCarriageLabel.textContent = "AL";
      autoloadCarriage.appendChild(autoloadCarriageLabel);
      armsGroup.appendChild(autoloadCarriage);

      // Ghost head — preview overlay. Parent group is pointer-events: none so
      // underlying carriers/wells still receive inspector clicks. The ghost is
      // repositioned either by re-entering the ghost tool (toolbar) or by
      // grabbing the dedicated .ghost-handle grip that overlays the top edge
      // of the body — handle is the one child that re-enables pointer events.
      ghostGroup = svgEl("g", { class: "ghost-head" });
      ghostGroup.style.display = "none";
      // Ghost rail
      ghostGroup.appendChild(svgEl("line", { x1: 0, y1: DECK_Y_MIN, x2: 0, y2: DECK_Y_MAX, class: "ghost-rail" }));
      // Ghost body rect
      ghostGroup.appendChild(svgEl("rect", { x: 0, y: 0, width: 80, height: 700, class: "ghost-body", rx: 12, ry: 12 }));
      // 8 channel dots — purely visual; channel toggling happens via the
      // right-click action menu. Keeping them interactive would block the
      // inspector when a dot sits over a well (#56).
      const ghostDots = svgEl("g", { class: "ghost-dots" });
      for (let ch = 0; ch < 8; ch++) {
        const dot = svgEl("circle", { cx: 0, cy: 0, r: 16, class: "ghost-dot" });
        ghostDots.appendChild(dot);
      }
      ghostGroup.appendChild(ghostDots);
      // Column label
      ghostGroup.appendChild(svgDeckText( { x: 0, y: 0, class: "ghost-label" }));
      // Drag handle — the only ghost child that receives pointer events. Sits
      // at the top edge of the body so users can still reposition a placed
      // ghost without re-entering the tool.
      ghostGroup.appendChild(svgEl("rect", { x: 0, y: 0, width: 140, height: 44, rx: 6, ry: 6, class: "ghost-handle" }));
      ghostGroup.appendChild(svgDeckText({ x: 0, y: 0, class: "ghost-handle-glyph" }));
      armsGroup.appendChild(ghostGroup);
    }

    function updateViewportTransform(): void {
      // No-op — all transform is via viewBox now
    }

    /** Fit the whole deck (carriers + fixtures + tipwaste) into the
     *  viewport with 10 % padding, Affinity/Figma-style (#61). Dblclick
     *  on empty deck and the `F` keyboard shortcut both call this. */
    export function fitToContent(): void {
      if (!svg || !State.deckData) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // Compute the tight bounding rect of everything that should be
      // on-screen. Start with the full deck extents that renderDeck
      // already chose (carriers + fixture extents), then pull in the
      // tipwaste block if present.
      let minX = deckMinX;
      let maxX = deckMaxX;
      let minY = Y_FRONT - 200;   // margin for FRONT label
      let maxY = Y_REAR + 300;    // margin for REAR label + carrier name
      if (State.deckData.tipWaste) {
        const tw = State.deckData.tipWaste;
        if (tw.xMin < minX) minX = tw.xMin;
        if (tw.xMax > maxX) maxX = tw.xMax;
        if (tw.yMin < minY) minY = tw.yMin;
        if (tw.yMax > maxY) maxY = tw.yMax;
      }

      const contentW = Math.max(1, maxX - minX);
      const contentH = Math.max(1, maxY - minY);

      // 10 % padding each side.
      const padding = 0.1;
      const baseVbW = Math.max(1, deckMaxX - deckMinX);
      const baseVbH = DECK_Y_MAX - DECK_Y_MIN;
      const scaleX = (rect.width * (1 - 2 * padding)) / (contentW * rect.width / baseVbW);
      const scaleY = (rect.height * (1 - 2 * padding)) / (contentH * rect.height / baseVbH);
      // `zoom` in our model multiplies into vbW = baseVbW / zoom. Solving
      // for the zoom that makes the content-width match the viewport
      // width (with padding) gives zoom = baseVbW * (1 - 2*padding) / contentW.
      const zoomX = baseVbW * (1 - 2 * padding) / contentW;
      const zoomY = baseVbH * (1 - 2 * padding) / contentH;
      void scaleX; void scaleY;  // kept for clarity, actual math below uses baseVb*.
      State.deckZoom = clampZoom(Math.min(zoomX, zoomY));

      // Center the content in the viewBox: with deckZoom set above,
      // vbW = baseVbW / deckZoom, vbX = cx - vbW/2 - panX. We want the
      // content centre to land at the viewport centre, i.e. vbX should
      // equal (contentCx - vbW/2). Solve for panX:
      const baseCx = deckMinX + baseVbW / 2;
      const baseCy = DECK_Y_MIN + baseVbH / 2;
      const contentCx = (minX + maxX) / 2;
      const contentCy = (minY + maxY) / 2;
      State.deckPanX = baseCx - contentCx;
      State.deckPanY = baseCy - contentCy;
      applyZoomPan();
    }

    /** The deck extents `applyZoomPan` uses — exposed so wheel zoom
     *  and the +/− buttons anchor on the same frame instead of drifting
     *  when fixtures widen the deck beyond the nominal track grid. The
     *  Y range matches `applyZoomPan`'s deckMinY/maxY — cursor-anchored
     *  zoom must read from the same frame or the pivot slides off with
     *  each tick (#62). */
    export function getDeckExtents(): { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; cx: number; cy: number } {
      const width = Math.max(1, deckMaxX - deckMinX);
      const height = Math.max(1, deckMaxY - deckMinY);
      return {
        minX: deckMinX,
        maxX: deckMaxX,
        minY: deckMinY,
        maxY: deckMaxY,
        width,
        height,
        cx: deckMinX + width / 2,
        cy: deckMinY + height / 2,
      };
    }

    /** Zoom the deck by `factor` (>1 zoom in, <1 out) centered on the
     *  viewport midpoint. Clamped to ZOOM_MIN..ZOOM_MAX (the same band
     *  the wheel handler uses). Cheap companion for the toolbar +/-
     *  buttons so users who don't know about Space-to-pan / wheel-zoom
     *  can still navigate. */
    export function zoomBy(factor: number): void {
      const newZoom = clampZoom(State.deckZoom * factor);
      if (newZoom === State.deckZoom) return;
      State.deckZoom = newZoom;
      applyZoomPan();
    }

    /** Apply zoom + pan by modifying the SVG viewBox.
     *  Pan is stored in SVG coordinate units (not screen pixels).
     *  Zoom changes the viewBox size; pan offsets the viewBox origin.
     *  Uses the same dynamic `deckMinX/deckMaxX/deckMinY/deckMaxY` that
     *  `renderDeck` picked so off-track fixtures stay visible under
     *  pan/zoom (#57) AND the cursor-anchored wheel zoom in
     *  deck-interact uses the exact same frame via `getDeckExtents`
     *  (previously this used DECK_Y_MIN/MAX while extents used
     *  `deckMinY/deckMaxY` — for custom platforms the Y centres drifted
     *  apart and the zoom pivot slid off the cursor with each wheel
     *  tick; #62). */
    export function applyZoomPan(): void {
      if (!svg || !State.deckData) return;
      const deckW = Math.max(1, deckMaxX - deckMinX);
      const deckH = Math.max(1, deckMaxY - deckMinY);
      // ViewBox dimensions at current zoom
      const vbW = deckW / State.deckZoom;
      const vbH = deckH / State.deckZoom;
      // Center of deck in SVG coords
      const cx = deckMinX + deckW / 2;
      const cy = deckMinY + deckH / 2;
      // Pan is in SVG units — applied directly to viewBox origin
      const vbX = cx - vbW / 2 - State.deckPanX;
      const vbY = cy - vbH / 2 - State.deckPanY;
      svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    }

    // preserveAspectRatio="xMidYMid meet" letterboxes the viewBox inside the
    // bounding rect whenever the container aspect ratio differs. Manual
    // rect-ratio math gets the scale and offset wrong; getScreenCTM() accounts
    // for letterboxing, viewBox, and any CSS transforms automatically.

    /** Convert a screen-pixel delta to root SVG coordinate delta at current
     *  zoom. Used by pan code that manipulates viewBox directly (viewBox
     *  lives in the root SVG coordinate space, pre-flip). */
    export function screenToSvgDelta(dxPx: number, dyPx: number): { dx: number; dy: number } {
      if (!svg) return { dx: 0, dy: 0 };
      const ctm = svg.getScreenCTM();
      if (!ctm) return { dx: 0, dy: 0 };
      const inv = ctm.inverse();
      // Scale factor only — drop translation by differencing two points.
      const p0 = new DOMPoint(0, 0).matrixTransform(inv);
      const p1 = new DOMPoint(dxPx, dyPx).matrixTransform(inv);
      return { dx: p1.x - p0.x, dy: p1.y - p0.y };
    }

    /** Convert screen position to root-SVG coordinates (pre-flip). Pan /
     *  zoom code that talks to viewBox uses this. */
    export function screenToSvg(clientX: number, clientY: number): { x: number; y: number } {
      if (!svg) return { x: 0, y: 0 };
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }

    /** Convert screen position to DECK coordinates, accounting for the
     *  viewport Y-flip. Anything comparing to deck-native state (ghostX,
     *  ghostY, labware deck coords) must use this — `screenToSvg` returns
     *  root-SVG coords which are mirrored relative to deck-Y and would
     *  make drag offsets wrong. */
    export function screenToDeck(clientX: number, clientY: number): { x: number; y: number } {
      if (!viewport) return screenToSvg(clientX, clientY);
      const ctm = viewport.getScreenCTM();
      if (!ctm) return screenToSvg(clientX, clientY);
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }
  }
}
