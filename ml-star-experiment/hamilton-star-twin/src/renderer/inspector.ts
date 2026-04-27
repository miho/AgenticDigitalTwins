/**
 * Inspector panel — carrier overview, labware detail, empty position views.
 * Uses inline SVG with the same CSS classes as the deck renderer.
 */
/// <reference path="state.ts" />
/// <reference path="deck-svg.ts" />

namespace Twin {
  export namespace Inspector {

    /** The view currently shown — captured so `refresh()` can re-render
     *  after a tracking update without losing the user's context. */
    type CurrentView =
      | { kind: "carrier"; hit: HitRegion }
      | { kind: "labware"; hit: HitRegion }
      | { kind: "emptyPosition"; hit: HitRegion }
      | { kind: "well"; carrierId: string; position: number; wellIndex: number }
      | null;
    let currentView: CurrentView = null;

    /** Re-render whatever the inspector is currently showing. Wire this
     *  into the SSE `tracking-changed` and `state-changed` handlers so a
     *  fill / aspirate / dispense that happens while the inspector is
     *  open updates the displayed volumes instead of going stale. */
    export function refresh(): void {
      if (!currentView) return;
      switch (currentView.kind) {
        case "carrier": showCarrier(currentView.hit); break;
        case "labware": showLabware(currentView.hit); break;
        case "emptyPosition": showEmptyPosition(currentView.hit); break;
        case "well":
          // `showWell` is async and fetches trace data; for live refreshes
          // we re-call it and let the new state flow through.
          void showWell(currentView.carrierId, currentView.position, currentView.wellIndex);
          break;
      }
    }

    /** Drop the currently-tracked view. Call on deck-load: a HitRegion
     *  from the previous deck carries a `carrierIdx` that may now point
     *  at a completely different carrier (e.g. the old PLT's idx=2
     *  becomes WasteBlock after a `.lay` with fewer carriers loads),
     *  and `refresh()` would render nonsense like
     *  "WasteBlock › pos 0 › Cos_96_DW_1mL". */
    export function clear(): void {
      currentView = null;
    }

    // ── Carrier overview ──────────────────────────────────────────────

    export function showCarrier(hit: HitRegion): void {
      currentView = { kind: "carrier", hit };
      const panel = document.getElementById("inspector-content");
      if (!panel) return;
      const carrier = State.deckData.carriers[hit.carrierIdx];
      if (!carrier) return;

      let html = "";
      html += `<span class="insp-label">Carrier</span>`;
      html += `<span class="insp-type">${carrier.type}</span>`;
      html += ` <span class="insp-dim">[${carrier.id}]</span><br>`;
      html += `<span class="insp-label">Tracks</span>`;
      html += `<span class="insp-value">T${carrier.track} – T${carrier.track + carrier.widthTracks - 1}</span><br>`;

      const occupiedCount = carrier.labware.filter((lw: any) => lw !== null).length;
      html += `<span class="insp-label">Positions</span>`;
      html += `<span class="insp-value">${occupiedCount} / ${carrier.positions} occupied</span><br>`;

      html += `<span class="insp-label">Contents</span>`;
      for (let i = 0; i < carrier.labware.length; i++) {
        const lw = carrier.labware[i];
        if (lw) {
          const isTip = lw.type.includes("Tip");
          let stateInfo = "";
          if (isTip) {
            const total = (lw.rows ?? 8) * (lw.columns ?? 12);
            let usedCount = 0;
            for (let wi = 0; wi < total; wi++) {
              if (State.deckTracking.tipUsage[`${carrier.id}:${i}:${wi}`]) usedCount++;
            }
            if (usedCount > 0) stateInfo = ` (${usedCount} used)`;
          } else if (lw.wellCount > 1) {
            const total = (lw.rows ?? 8) * (lw.columns ?? 12);
            let filledCount = 0;
            for (let wi = 0; wi < total; wi++) {
              if ((State.deckTracking.wellVolumes[`${carrier.id}:${i}:${wi}`] ?? 0) > 0) filledCount++;
            }
            if (filledCount > 0) stateInfo = ` (${filledCount} wells filled)`;
          }
          // VENUS SiteId is 1-indexed (matches the deck labels and the
          // VENUS Deck Editor). Our array index `i` stays 0-based in
          // code paths; only the user-facing text uses i+1.
          html += `<span class="insp-type">  ${i + 1}: ${lw.type}</span>`;
          html += `<span class="insp-dim">${stateInfo}</span><br>`;
        } else {
          html += `<span class="insp-empty">  ${i + 1}: empty</span><br>`;
        }
      }

      // Mini SVG carrier view
      html += `<span class="insp-label">Carrier View</span>`;
      html += miniCarrierSVG(carrier);

      panel.innerHTML = html;
    }

    // ── Labware detail ────────────────────────────────────────────────

    export function showLabware(hit: HitRegion): void {
      currentView = { kind: "labware", hit };
      const panel = document.getElementById("inspector-content");
      if (!panel) return;
      const carrier = State.deckData.carriers[hit.carrierIdx];
      const lw = hit.labware;
      if (!carrier || !lw) return;

      const isTipRack = lw.type.includes("Tip");
      const isTrough = lw.type.includes("Trough");
      const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
      const rows = lw.rows ?? (lw.wellCount > 96 ? 16 : 8);

      let html = "";
      html += `<div class="insp-breadcrumb">`;
      html += `<a onclick="showCarrierInspector(hitRegions?.find(h=>h.carrierIdx===${hit.carrierIdx}&&h.position===undefined))">${carrier.id}</a>`;
      html += ` &rsaquo; site ${hit.position! + 1} &rsaquo; <strong>${lw.type}</strong>`;
      html += `</div>`;
      html += `<span class="insp-label">Format</span>`;
      html += `<span class="insp-value">${rows}x${cols} (${lw.wellCount} wells)</span><br>`;

      // Dead volume per well — labware-defined residual that ML STAR won't
      // aspirate below. Shown so the user can read "how much is practically
      // usable" at a glance without inspecting individual wells.
      const deadVol = (lw as any)?.deadVolume as number | undefined;
      if (!isTipRack && deadVol !== undefined && deadVol > 0) {
        html += `<span class="insp-label">Dead volume</span>`;
        html += `<span class="insp-value">${(deadVol / 10).toFixed(2)} µL / well</span><br>`;
      }

      if (isTipRack) {
        let usedCount = 0;
        for (let wi = 0; wi < rows * cols; wi++) {
          if (State.deckTracking.tipUsage[`${carrier.id}:${hit.position}:${wi}`]) usedCount++;
        }
        html += `<span class="insp-label">Tips</span>`;
        html += `<span class="insp-value">${rows * cols - usedCount} available</span>`;
        if (usedCount > 0) html += ` <span class="insp-warn">${usedCount} used</span>`;
        html += `<br>`;
      } else if (isTrough) {
        const vol = State.deckTracking.wellVolumes[`${carrier.id}:${hit.position}:0`];
        if (vol !== undefined) {
          html += `<span class="insp-label">Volume</span>`;
          html += `<span class="insp-value">${(vol / 10).toFixed(2)} µL</span><br>`;
        }
      } else {
        let filledCount = 0, totalVol = 0;
        for (let wi = 0; wi < rows * cols; wi++) {
          const vol = State.deckTracking.wellVolumes[`${carrier.id}:${hit.position}:${wi}`];
          if (vol !== undefined && vol > 0) { filledCount++; totalVol += vol; }
        }
        if (filledCount > 0) {
          html += `<span class="insp-label">Wells filled</span>`;
          html += `<span class="insp-value">${filledCount} / ${rows * cols}</span><br>`;
          html += `<span class="insp-label">Total volume</span>`;
          html += `<span class="insp-value">${(totalVol / 10).toFixed(2)} µL</span><br>`;
        }
      }

      // Mini SVG labware view
      html += `<span class="insp-label">${isTipRack ? "Tip Map" : isTrough ? "Fill Level" : "Well Map"}</span>`;
      html += miniLabwareSVG(carrier, hit.position!, lw);

      panel.innerHTML = html;
    }

    // ── Empty position ────────────────────────────────────────────────

    export function showEmptyPosition(hit: HitRegion): void {
      currentView = { kind: "emptyPosition", hit };
      const panel = document.getElementById("inspector-content");
      if (!panel) return;
      const carrier = State.deckData.carriers[hit.carrierIdx];
      if (!carrier) return;

      let html = "";
      html += `<span class="insp-label">Carrier</span>`;
      html += `<span class="insp-dim">${carrier.type} [${carrier.id}]</span><br>`;
      html += `<span class="insp-label">Site</span>`;
      html += `<span class="insp-value">${hit.position! + 1}</span><br>`;
      html += `<span class="insp-empty">No labware at this site</span>`;

      panel.innerHTML = html;
    }

    // ── Mini SVG: carrier overview ────────────────────────────────────

    function miniCarrierSVG(carrier: any): string {
      const w = 240;
      const posCount = carrier.labware.length;
      const m = 4;
      const slotH = 36;      // occupied slot height
      const emptyH = 16;     // empty slot: thin line
      const gap = 3;

      // Compute total height based on actual content
      let totalH = m * 2;
      for (let i = 0; i < posCount; i++) {
        totalH += (carrier.labware[i] ? slotH : emptyH) + gap;
      }

      let svg = `<svg width="${w}" height="${totalH}" xmlns="http://www.w3.org/2000/svg" class="insp-svg">`;

      // Position 0 = REAR of carrier (largest siteYOffset = top after
      // Y-flip). So drawing top-to-bottom in the mini view means
      // iterating 0 → N-1 — same visual order as the deck, same as
      // VENUS's editor, same as the textual Contents list.
      let py = m;
      for (let i = 0; i < posCount; i++) {
        const lw = carrier.labware[i];
        const h = lw ? slotH : emptyH;

        if (!lw) {
          svg += `<rect x="${m + 20}" y="${py + h / 2 - 0.5}" width="${w - m * 2 - 40}" height="1" class="slot-empty" rx="0"/>`;
          svg += `<text x="${w / 2}" y="${py + h / 2 + 3}" text-anchor="middle" class="insp-svg-text" font-size="7" font-family="var(--font-mono)">${i + 1}</text>`;
          py += h + gap;
          continue;
        }

        const isTip = lw.type.includes("Tip");
        const isTrough = lw.type.includes("Trough") || lw.type.includes("Rgt") || lw.wellCount === 1;
        const isWash = lw.type.includes("Wash");
        const isHHS = lw.type.includes("HHS");
        const isTCC = lw.type.includes("TCC");
        const cls = isTip ? "labware-bg--tips"
          : isTrough ? "labware-bg--trough"
          : isWash ? "labware-bg--wash"
          : isHHS ? "labware-bg--hhs"
          : isTCC ? "labware-bg--tcc"
          : "labware-bg--plate";
        svg += `<rect x="${m}" y="${py}" width="${w - m * 2}" height="${slotH}" rx="4" class="labware-bg ${cls}"/>`;

        if (isTrough || isWash) {
          // Trough/wash: fill level bar inside the labware-bg rect (no extra basin)
          const key = `${carrier.id}:${i}:0`;
          const vol = State.deckTracking.wellVolumes[key] ?? 0;
          const maxVol = 1000000;
          const pct = Math.min(1, vol / maxVol);
          if (pct > 0) {
            const fillW = (w - m * 2 - 4) * pct;
            svg += `<rect x="${m + 2}" y="${py + 2}" width="${fillW}" height="${slotH - 4}" rx="3" class="trough-fill"/>`;
          }
          const label = isWash ? "Wash" : "Trough";
          const volStr = vol >= 10000 ? `${(vol / 10000).toFixed(2)} mL` : vol > 0 ? `${(vol / 10).toFixed(2)} µL` : "empty";
          svg += `<text x="${w / 2}" y="${py + slotH / 2 + 3}" text-anchor="middle" class="insp-svg-text" font-size="8" font-family="var(--font-mono)">${i + 1}  ${label} ${volStr}</text>`;
        } else {
          // Left: VENUS SiteId (1-indexed, matches deck labels)
          svg += `<text x="${m + 6}" y="${py + slotH / 2 + 3}" class="insp-svg-text" font-size="8" font-family="var(--font-mono)">${i + 1}</text>`;
          // Plate/tips: mini dots
          const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
          const rows = lw.rows ?? (lw.wellCount > 96 ? 16 : 8);
          const dotAreaX = m + 18;
          const dotAreaW = w - m * 2 - 55;
          const dotAreaH = slotH - 6;
          const dotW = dotAreaW / cols;
          const dotH = dotAreaH / rows;
          const r = Math.max(0.8, Math.min(dotW, dotH) * 0.35);

          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const cx = dotAreaX + (col + 0.5) * dotW;
              const cy = py + 3 + (row + 0.5) * dotH;
              const wi = row * cols + col;
              const key = `${carrier.id}:${i}:${wi}`;

              if (isTip) {
                const used = State.deckTracking.tipUsage[key] === true;
                svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="tip${used ? " tip--used" : ""}"/>`;
              } else {
                const vol = State.deckTracking.wellVolumes[key] ?? 0;
                svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="well${vol > 0 ? " well--filled" : ""}"${vol > 0 ? ` style="opacity:${(0.4 + Math.min(1, vol / 5000) * 0.6).toFixed(2)}"` : ""}/>`;
              }
            }
          }

          // Right: short type label
          const shortName = lw.type
            .replace("Tips_1000uL", "T1000")
            .replace("Tips_300uL", "T300")
            .replace("Cos_96_Rd", "96w")
            .replace("Cos_384_Sq", "384w")
            .replace("HHS_Plate_96", "HHS")
            .replace("TCC_Plate_96", "TCC")
            .replace("Trough_100ml", "Trough");
          svg += `<text x="${w - m - 4}" y="${py + slotH / 2 + 3}" text-anchor="end" class="insp-svg-text" font-size="8" font-family="var(--font-mono)">${shortName}</text>`;
        }
        py += slotH + gap;
      }

      svg += `</svg>`;
      return svg;
    }

    // ── Mini SVG: labware detail ──────────────────────────────────────

    function miniLabwareSVG(carrier: any, position: number, lw: any): string {
      const w = 240, h = 180;
      const isTipRack = lw.type.includes("Tip");
      const isTrough = lw.type.includes("Trough");

      let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" class="insp-svg">`;

      if (isTrough) {
        const key = `${carrier.id}:${position}:0`;
        const vol = State.deckTracking.wellVolumes[key] ?? 0;
        const pct = Math.max(0, Math.min(1, vol / 1000000));
        const bx = 40, by = 10, bw = w - 80, bh = h - 30;
        const dataAttrs = `data-well-key="${key}" data-carrier-id="${carrier.id}" data-position="${position}" data-well-idx="0"`;
        svg += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6" class="trough-basin" ${dataAttrs}/>`;
        const fillH = bh * pct;
        const negCls = vol < 0 ? " trough-fill--negative" : "";
        svg += `<rect x="${bx + 3}" y="${by + bh - fillH}" width="${bw - 6}" height="${fillH}" rx="4" class="trough-fill${negCls}" ${dataAttrs}/>`;
        const label = vol > 0
          ? (vol >= 10000 ? `${(vol / 10000).toFixed(2)} mL` : `${(vol / 10).toFixed(2)} µL`)
          : vol < 0 ? `${(vol / 10).toFixed(2)} µL (UNDERFLOW)` : "empty";
        svg += `<text x="${w / 2}" y="${h - 4}" text-anchor="middle" class="insp-svg-text" font-size="9" font-family="var(--font-mono)">${label}</text>`;
        svg += `</svg>`;
        return svg;
      }

      const cols = lw.columns ?? (lw.wellCount > 96 ? 24 : 12);
      const rows = lw.rows ?? (lw.wellCount > 96 ? 16 : 8);
      const labelM = 14;
      const dotW = (w - labelM - 4) / cols;
      const dotH = (h - labelM - 4) / rows;
      const r = Math.max(1, Math.min(dotW, dotH) * 0.35);

      // Row labels
      for (let row = 0; row < rows; row++) {
        svg += `<text x="${labelM - 3}" y="${labelM + (row + 0.5) * dotH + 3}" text-anchor="end" class="insp-svg-text" font-size="7" font-family="var(--font-mono)">${String.fromCharCode(65 + row)}</text>`;
      }
      // Col labels
      for (let col = 0; col < cols; col++) {
        if (cols <= 12 || col % 2 === 0) {
          svg += `<text x="${labelM + (col + 0.5) * dotW}" y="${h - 1}" text-anchor="middle" class="insp-svg-text" font-size="6" font-family="var(--font-mono)">${col + 1}</text>`;
        }
      }

      // Wells/tips
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const cx = labelM + (col + 0.5) * dotW;
          const cy = labelM + (row + 0.5) * dotH;
          const wi = row * cols + col;
          const key = `${carrier.id}:${position}:${wi}`;

          // data-* attributes let the shared well-tooltip handler (attachWellTooltip)
          // drive the same HTML tooltip used on the main deck.
          const dataAttrs = `data-well-key="${key}" data-carrier-id="${carrier.id}" data-position="${position}" data-well-idx="${wi}"`;
          if (isTipRack) {
            const used = State.deckTracking.tipUsage[key] === true;
            const wn = String.fromCharCode(65 + row) + (col + 1);
            svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="tip${used ? " tip--used" : ""}" ${dataAttrs}><title>${wn}: ${used ? "used" : "available"}</title></circle>`;
          } else {
            const vol = State.deckTracking.wellVolumes[key] ?? 0;
            const filled = vol > 0;
            const negative = vol < 0;
            const wn = String.fromCharCode(65 + row) + (col + 1);
            const liq = State.deckTracking.wellContents?.[key];
            const entries = componentsToEntries((liq as any)?.components);
            const isMixture = filled && entries.length >= 2;

            const tipText = filled
              ? `${wn}: ${(vol/10).toFixed(2)} µL${liq ? " " + liq.liquidType : ""}`
              : negative ? `${wn}: ${(vol/10).toFixed(2)} µL (UNDERFLOW)` : `${wn}: empty`;
            const cls = `well${filled ? " well--filled" : ""}${negative ? " well--negative" : ""}`;

            if (isMixture) {
              // Pie chart (log-scale) — per-liquid slice colors, no mixing.
              // Transparent circle stays as tooltip hitbox via data-well-key.
              const pie = buildLogPieMarkup(entries, cx, cy, r);
              svg += `<g class="well-pie">${pie}</g>`;
              svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}" style="fill:transparent;opacity:1" ${dataAttrs}><title>${tipText}</title></circle>`;
            } else {
              const opacityNum = filled
                ? (0.4 + Math.min(1, vol / 5000) * 0.6).toFixed(2)
                : negative ? "1" : "";
              const fillStyle = filled && liq?.liquidType ? `fill:${liquidColor(liq.liquidType)};` : "";
              const style = (fillStyle || opacityNum) ? ` style="${fillStyle}${opacityNum ? `opacity:${opacityNum}` : ""}"` : "";
              svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"${style} ${dataAttrs}><title>${tipText}</title></circle>`;
            }
          }
        }
      }

      svg += `</svg>`;
      return svg;
    }

    // ── Well inspector (Phase 3 Step 3.7) ─────────────────────────────
    //
    // Shows per-well context: current volume / liquid / surface height,
    // every trace event that touched the well, a volume-over-time chart,
    // liquid provenance (which channels, contamination risk), and for
    // aspirate/dispense events an expandable TADM curve viewer.
    //
    // Works in both live and replay modes. The backend assembles the
    // data via POST /api/mcp/call {name: "analysis.inspectWell"} when a
    // trace is loaded; otherwise we fall back to the live /tracking
    // snapshot.

    export async function showWell(carrierId: string, position: number, wellIndex: number): Promise<void> {
      currentView = { kind: "well", carrierId, position, wellIndex };
      const panel = document.getElementById("inspector-content");
      if (!panel) return;
      panel.innerHTML = `<span class="insp-dim">Loading well ${wellIndex}...</span>`;

      const wellKey = `${carrierId}:${position}:${wellIndex}`;
      const data = await loadWellData(wellKey, carrierId, position, wellIndex);

      let html = "";
      html += `<div class="insp-breadcrumb"><span class="insp-label">Well</span> `;
      html += `<span class="insp-type">${wellNameFromIndex(carrierId, position, wellIndex)}</span>`;
      html += ` <span class="insp-dim">${wellKey}</span></div>`;

      // Current state
      html += `<div class="insp-section">`;
      html += `<span class="insp-label">Current state</span>`;
      html += `<div>Volume: <span class="insp-value">${(data.currentVolume / 10).toFixed(1)} uL</span></div>`;
      if (data.currentLiquid) {
        html += `<div>Liquid: <span class="insp-value">${escapeHtml(data.currentLiquid.liquidType || "unknown")}</span></div>`;
        if (data.currentLiquid.liquidClass) {
          html += `<div>Class: <span class="insp-value">${escapeHtml(data.currentLiquid.liquidClass)}</span></div>`;
        }
      } else {
        html += `<div class="insp-empty">Well is empty.</div>`;
      }
      html += `</div>`;

      // Volume-over-time chart
      if (data.volumeSeries.length > 0) {
        html += `<div class="insp-section">`;
        html += `<span class="insp-label">Volume over time</span>`;
        html += volumeChartSVG(data.volumeSeries);
        html += `</div>`;
      }

      // Liquid provenance — channels that touched this well
      if (data.provenance.length > 0) {
        html += `<div class="insp-section">`;
        html += `<span class="insp-label">Provenance</span>`;
        for (const p of data.provenance) {
          const badge = p.contamination
            ? `<span class="insp-warn">contamination</span>`
            : `<span class="insp-dim">ok</span>`;
          html += `<div>Channel ${p.channel} ${p.op} ${(p.volume / 10).toFixed(1)} uL ${badge}</div>`;
        }
        html += `</div>`;
      }

      // Event history — each row has a small expandable chunk for TADM.
      html += `<div class="insp-section">`;
      html += `<span class="insp-label">Event history (${data.events.length})</span>`;
      if (data.events.length === 0) {
        html += `<div class="insp-empty">No events yet.</div>`;
      } else {
        for (const e of data.events) {
          html += renderEventRow(e);
        }
      }
      html += `</div>`;

      panel.innerHTML = html;

      // Wire up TADM-expand buttons now that the DOM is in place.
      panel.querySelectorAll(".insp-tadm-toggle").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = (btn as HTMLElement).dataset.eventId;
          const details = panel.querySelector(`[data-tadm-details="${id}"]`) as HTMLElement | null;
          if (details) details.style.display = details.style.display === "none" ? "" : "none";
        });
      });
    }

    interface WellData {
      currentVolume: number;
      currentLiquid: { liquidType?: string; liquidClass?: string } | null;
      events: any[];
      volumeSeries: Array<{ eventId: number; volume: number }>;
      provenance: Array<{ channel: number; op: string; volume: number; contamination: boolean }>;
    }

    async function loadWellData(wellKey: string, carrierId: string, position: number, wellIndex: number): Promise<WellData> {
      // Preferred path: when a trace is loaded, use the MCP tool — it
      // assembles the full history + volume series from the trace.
      try {
        const info = await apiGet("/api/analysis/info");
        if (info && info.loaded) {
          const r = await apiPost("/api/mcp/call", {
            name: "analysis.inspectWell",
            args: { carrierId, position, wellIndex },
          });
          if (r && r.result) {
            const result = r.result;
            return {
              currentVolume: result.currentVolume ?? 0,
              currentLiquid: result.currentLiquid ?? null,
              events: result.events ?? [],
              volumeSeries: result.volumeSeries ?? [],
              provenance: extractProvenance(result.events ?? [], wellKey),
            };
          }
        }
      } catch { /* fall through to live mode */ }

      // Live mode: no trace loaded. Use the current tracking snapshot.
      const currentVolume = State.deckTracking.wellVolumes[wellKey] ?? 0;
      const currentLiquid = State.deckTracking.wellContents?.[wellKey] ?? null;
      return { currentVolume, currentLiquid, events: [], volumeSeries: [], provenance: [] };
    }

    function extractProvenance(events: any[], wellKey: string): WellData["provenance"] {
      const out: WellData["provenance"] = [];
      for (const e of events) {
        if (e.kind !== "command") continue;
        const cmd = e.payload;
        if (!cmd?.rawCommand) continue;
        const op = cmd.rawCommand.startsWith("C0AS") ? "aspirated from"
                 : cmd.rawCommand.startsWith("C0DS") ? "dispensed into"
                 : cmd.rawCommand.startsWith("C0TP") ? "picked tip at"
                 : null;
        if (!op) continue;
        const match = cmd.rawCommand.match(/av(\d+)|dv(\d+)/);
        const volume = match ? Number(match[1] ?? match[2]) : 0;
        // Channel isn't obvious from the raw command; best we can do without
        // deeper parsing is "any" — surface it as channel -1.
        out.push({ channel: -1, op, volume, contamination: false });
      }
      return out;
    }

    function wellNameFromIndex(carrierId: string, position: number, wellIndex: number): string {
      const carrier = State.deckData?.carriers?.find((c: any) => c.id === carrierId);
      const lw = carrier?.labware?.[position];
      const cols = lw?.columns ?? 12;
      const row = Math.floor(wellIndex / cols);
      const col = wellIndex % cols;
      return String.fromCharCode(65 + row) + (col + 1);
    }

    function volumeChartSVG(series: Array<{ eventId: number; volume: number }>): string {
      if (series.length < 2) return "";
      const W = 300, H = 80, PAD = 8;
      const maxVol = Math.max(...series.map((p) => p.volume), 1);
      const pts = series.map((p, i) => {
        const x = PAD + (i / (series.length - 1)) * (W - 2 * PAD);
        const y = H - PAD - (p.volume / maxVol) * (H - 2 * PAD);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      return `<svg class="insp-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
        <polyline points="${pts}" fill="none" stroke="#4cc9f0" stroke-width="1.5" />
      </svg>`;
    }

    function renderEventRow(e: any): string {
      const kind = e.kind;
      const lifecycleBadge = e.lifecycle && e.lifecycle !== "active"
        ? `<span class="insp-dim"> [${e.lifecycle}]</span>` : "";
      let row = `<div class="insp-event">`;
      row += `<span class="insp-dim">#${e.id}</span> `;
      if (kind === "command") {
        const cmd = e.payload;
        row += `<span class="insp-value">${escapeHtml(cmd.rawCommand ?? "")}</span>`;
        if (cmd.accepted === false) row += ` <span class="insp-warn">rejected</span>`;
        // TADM viewer toggle if the command result's assessments include one.
        const assessments = cmd.assessments ?? [];
        const tadm = assessments.find((a: any) => a.category === "tadm");
        if (tadm) {
          row += ` <button class="insp-tadm-toggle" data-event-id="${e.id}">TADM</button>`;
          row += `<div data-tadm-details="${e.id}" class="insp-tadm-details" style="display:none">`;
          row += tadmCurveSVG(tadm);
          row += `</div>`;
        }
      } else if (kind === "assessment") {
        const a = e.payload;
        row += `<span class="insp-${a.severity === "error" ? "err" : a.severity === "warning" ? "warn" : "value"}">`;
        row += `${escapeHtml(a.category)}: ${escapeHtml(a.description)}`;
        row += `</span>`;
      } else {
        row += `<span class="insp-dim">${kind}</span>`;
      }
      row += lifecycleBadge;
      row += `</div>`;
      return row;
    }

    function tadmCurveSVG(tadm: any): string {
      const curve = tadm.tadm?.curve ?? tadm.data?.curve ?? [];
      if (!Array.isArray(curve) || curve.length < 2) {
        return `<div class="insp-dim">No curve samples.</div>`;
      }
      const W = 260, H = 60, PAD = 4;
      const xs = curve.map((p: any) => p.t ?? p[0] ?? 0);
      const ys = curve.map((p: any) => p.p ?? p.pressure ?? p[1] ?? 0);
      const maxY = Math.max(...ys, 1);
      const minY = Math.min(...ys, 0);
      const range = maxY - minY || 1;
      const pts = curve.map((_: any, i: number) => {
        const x = PAD + (i / (curve.length - 1)) * (W - 2 * PAD);
        const y = H - PAD - ((ys[i] - minY) / range) * (H - 2 * PAD);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
        <polyline points="${pts}" fill="none" stroke="#f5a524" stroke-width="1.5" />
      </svg>`;
    }

    function escapeHtml(s: string): string {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
  }
}
