/**
 * Spatial event annotations (Step 3.6)
 *
 * SVG overlay on the deck — per-well markers for assessment events.
 * Subscribes to the SSE `assessment` stream (live) and the Phase 3
 * `analysis-state-changed` stream (replay). Per-well marker types:
 *
 *   - error ring     — red circle around wells with error-severity events
 *   - warning ring   — amber circle around wells with warning-severity events
 *   - unresolved X   — crosshair when the event's coordinates didn't
 *                      resolve to known labware
 *
 * Layer toggles: operators can hide error / warning / unresolved / info
 * independently via the Annotations.toggleLayer() UI.
 *
 * Decay: info-severity markers fade after 5 s; the operator can pin one
 * by clicking it to prevent the fade.
 */
/// <reference path="state.ts" />
/// <reference path="deck-svg.ts" />

namespace Twin.Annotations {
  /** Default fade-out for routine (info) markers, in milliseconds. */
  const INFO_FADE_MS = 5000;

  /** Visibility of each annotation layer — operator-toggleable. */
  interface LayerState {
    error: boolean;
    warning: boolean;
    unresolved: boolean;
    info: boolean;
  }

  /** A single annotation pinned to a well on the deck. */
  interface Annotation {
    id: number;                   // the assessment event id
    wellKey: string;              // "<carrierId>:<position>:<wellIndex>"
    category: string;
    severity: "info" | "warning" | "error";
    description: string;
    timestamp: number;             // ms at time of add
    pinned: boolean;               // true => never fades
  }

  const layerVisible: LayerState = { error: true, warning: true, unresolved: true, info: true };
  const annotations: Map<number, Annotation> = new Map();
  let overlay: SVGGElement | null = null;

  /**
   * Ensure the annotation overlay <g> exists inside the deck SVG. Idempotent;
   * called from every render hook.
   */
  function ensureOverlay(): SVGGElement | null {
    const svg = document.getElementById("deck-svg");
    if (!svg) return null;
    let g = svg.querySelector<SVGGElement>("#annotations-layer");
    if (!g) {
      g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("id", "annotations-layer");
      g.setAttribute("class", "annotations-layer");
      // The overlay renders on top of everything else.
      svg.appendChild(g);
    }
    overlay = g;
    return g;
  }

  /**
   * Public: push a new assessment-derived annotation. Idempotent on id —
   * repeat calls with the same id update in place.
   */
  export function addFromAssessment(a: {
    id: number;
    category: string;
    severity: "info" | "warning" | "error";
    description: string;
    data?: Record<string, unknown>;
  }): void {
    const key = wellKeyFromData(a.data, a.category);
    if (!key) return;
    const existing = annotations.get(a.id);
    annotations.set(a.id, {
      id: a.id,
      wellKey: key,
      category: a.category,
      severity: a.severity,
      description: a.description,
      timestamp: existing?.timestamp ?? Date.now(),
      pinned: existing?.pinned ?? false,
    });
    render();

    // Auto-fade for info — unless the user has pinned this specific marker.
    if (a.severity === "info") {
      setTimeout(() => {
        const cur = annotations.get(a.id);
        if (cur && !cur.pinned) {
          annotations.delete(a.id);
          render();
        }
      }, INFO_FADE_MS);
    }
  }

  /**
   * Replace the entire annotation set — called after loading a trace or
   * classifying events (so replay shows the correct markers at every
   * position).
   */
  export function setAll(events: Array<{
    id: number;
    kind: string;
    severity?: "info" | "warning" | "error";
    payload: any;
    lifecycle?: string;
  }>): void {
    annotations.clear();
    for (const e of events) {
      if (e.kind !== "assessment") continue;
      if (e.lifecycle === "suppressed" || e.lifecycle === "resolved") continue;
      const p = e.payload;
      const key = wellKeyFromData(p.data, p.category);
      if (!key) continue;
      annotations.set(e.id, {
        id: e.id,
        wellKey: key,
        category: p.category,
        severity: p.severity ?? "info",
        description: p.description ?? "",
        timestamp: Date.now(),
        pinned: false,
      });
    }
    render();
  }

  /** Toggle a layer on or off. Returns the new value. */
  export function toggleLayer(layer: keyof LayerState): boolean {
    layerVisible[layer] = !layerVisible[layer];
    render();
    return layerVisible[layer];
  }

  /** Clear all annotations (used on reset). */
  export function clearAll(): void {
    annotations.clear();
    render();
  }

  /** Pin a marker so it stops auto-fading. */
  export function pin(id: number): void {
    const a = annotations.get(id);
    if (a) { a.pinned = true; render(); }
  }

  /** Number of annotations currently rendered — for tests / badges. */
  export function count(): number {
    return annotations.size;
  }

  /**
   * Rebuild the overlay from the current annotation set. Simple enough to
   * clear-and-redraw; caller needn't reason about diffing.
   */
  export function render(): void {
    const g = ensureOverlay();
    if (!g) return;
    g.innerHTML = "";

    for (const a of annotations.values()) {
      // Layer gating
      const layerKey = a.category === "unresolved_position" ? "unresolved" : a.severity;
      if (!layerVisible[layerKey as keyof LayerState]) continue;

      const coord = findWellCoord(a.wellKey);
      if (!coord) continue;

      const marker = buildMarker(coord.cx, coord.cy, coord.r, a);
      // Click handler: pin, scroll to assessment panel.
      marker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pin(a.id);
        scrollAssessmentIntoView(a.id);
      });
      g.appendChild(marker);
    }
  }

  /** Look up the well circle by data-well-key, read cx/cy/r off it. */
  function findWellCoord(wellKey: string): { cx: number; cy: number; r: number } | null {
    const el = document.querySelector(`[data-well-key="${wellKey}"]`);
    if (!el) return null;
    const cx = Number(el.getAttribute("cx"));
    const cy = Number(el.getAttribute("cy"));
    const r = Number(el.getAttribute("r")) || 40;
    if (Number.isNaN(cx) || Number.isNaN(cy)) return null;
    return { cx, cy, r };
  }

  function buildMarker(cx: number, cy: number, r: number, a: Annotation): SVGGElement {
    const NS = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", `annotation annotation--${a.severity} annotation--${a.category}`);
    g.setAttribute("data-event-id", String(a.id));
    g.setAttribute("data-well-key", a.wellKey);

    const title = document.createElementNS(NS, "title");
    title.textContent = `[${a.severity.toUpperCase()}] ${a.category}: ${a.description}`;
    g.appendChild(title);

    if (a.category === "unresolved_position") {
      // Crosshair X
      const len = r + 4;
      for (const [x1, y1, x2, y2] of [
        [cx - len, cy - len, cx + len, cy + len],
        [cx - len, cy + len, cx + len, cy - len],
      ]) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
        line.setAttribute("class", "annotation-crosshair");
        g.appendChild(line);
      }
    } else {
      // Severity ring
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", String(r + 6));
      circle.setAttribute("class", `annotation-ring annotation-ring--${a.severity}`);
      g.appendChild(circle);
    }

    return g;
  }

  /** Extract a well key from assessment payload.data if present. */
  function wellKeyFromData(data: any, _category: string): string | null {
    if (!data) return null;
    if (data.carrierId !== undefined && data.position !== undefined && data.wellIndex !== undefined) {
      return `${data.carrierId}:${data.position}:${data.wellIndex}`;
    }
    return null;
  }

  /**
   * Scroll the assessment panel to the row matching this event id (if
   * present). Keeps the UX tight: click a marker → see its entry.
   */
  function scrollAssessmentIntoView(eventId: number): void {
    const row = document.querySelector(`[data-assessment-id="${eventId}"]`);
    if (row && typeof (row as HTMLElement).scrollIntoView === "function") {
      (row as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      (row as HTMLElement).classList.add("assessment-highlight");
      setTimeout(() => (row as HTMLElement).classList.remove("assessment-highlight"), 1500);
    }
  }
}
