/**
 * Channel view — 16 PIP channel cells showing tip status, volume, Z height,
 * liquid identity, and contamination state.
 */
/// <reference path="state.ts" />

namespace Twin {
  /** Color map for liquid types */
  const LIQUID_COLORS: Record<string, string> = {
    "Water": "#4aa8ff", "DMSO": "#c084fc", "Serum": "#f59e42",
    "Ethanol": "#34d399", "80% Glycerol": "#f472b6", "Unknown": "#94a3b8",
  };

  function liquidColor(type: string): string {
    if (LIQUID_COLORS[type]) return LIQUID_COLORS[type];
    // Assign a color from hash of the name
    let h = 0;
    for (let i = 0; i < type.length; i++) h = type.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
  }

  export function getLiquidColor(type: string): string { return liquidColor(type); }

  export namespace Channels {
    export function buildChannelGrid(): void {
      const grid = document.getElementById("channel-grid");
      if (!grid) return;
      grid.innerHTML = "";
      // Cell layout (bottom-up):
      //   row 1: channel number + tip type chip
      //   row 2: volume, optionally split with trailing-air
      //   row 3: liquid label
      //   row 4: X/Y/Z numeric readouts (px-tight mono)
      //   row 5: vertical z-depth bar with traverse-height tick
      for (let i = 0; i < 16; i++) {
        const cell = document.createElement("div");
        cell.className = "channel-cell";
        cell.id = `ch-${i}`;
        cell.innerHTML =
          `<div class="ch-row ch-row-id">` +
            `<span class="ch-id">${i + 1}</span>` +
            `<span class="ch-tip no-tip">--</span>` +
          `</div>` +
          `<div class="ch-vol empty">0</div>` +
          `<div class="ch-liquid"></div>` +
          `<div class="ch-coords">` +
            `<span class="ch-coord"><span class="ch-coord-label">Y</span><span class="ch-coord-value ch-y">–</span></span>` +
            `<span class="ch-coord"><span class="ch-coord-label">Z</span><span class="ch-coord-value ch-z">–</span></span>` +
          `</div>` +
          `<div class="ch-z-bar" title="Z extension: top = retracted (home), fill grows downward as tip descends. Dashed line = traverse height — fill past the line means the tip is engaged in labware.">` +
            `<div class="ch-z-fill"></div>` +
            `<div class="ch-z-traverse-mark"></div>` +
          `</div>`;
        grid.appendChild(cell);
      }
    }

    /** Format a 0.1mm value as "NNN.Nmm" (or short dashes when undefined). */
    function mm(v: number | undefined): string {
      if (v === undefined || v === null || Number.isNaN(v)) return "–";
      const r = v / 10;
      return r.toFixed(r < 100 ? 1 : 0);
    }

    export function updateChannelView(pipVars: Record<string, unknown>): void {
      const tipFitted = pipVars["tip_fitted"] as boolean[] || [];
      const tipType = pipVars["tip_type"] as number[] || [];
      const volume = pipVars["volume"] as number[] || [];
      const posY = pipVars["pos_y"] as number[] || [];
      const posZ = pipVars["pos_z"] as number[] || [];
      const posX = typeof pipVars["pos_x"] === "number" ? pipVars["pos_x"] as number : 0;
      const zMax = typeof pipVars["z_max"] === "number" ? pipVars["z_max"] as number : 2500;
      const zTraverse = typeof pipVars["z_traverse"] === "number" ? pipVars["z_traverse"] as number : 1450;

      // Arm-wide header: single X (mechanically shared) + z limits.
      const armX = document.getElementById("pip-arm-x");
      const armZmax = document.getElementById("pip-arm-zmax");
      const armZtrav = document.getElementById("pip-arm-ztrav");
      if (armX) armX.textContent = mm(posX);
      if (armZmax) armZmax.textContent = mm(zMax);
      if (armZtrav) armZtrav.textContent = mm(zTraverse);

      // Liquid tracking (air-split display etc.)
      const channels = State.deckTracking.channels || [];

      // Traverse tick: sits at z_traverse / z_max from the TOP of the bar
      // — matching the new downward-growing fill convention. As the fill
      // (representing extension) passes the tick, the channel has entered
      // labware. At z_traverse=145 mm / z_max=250 mm → tick sits at 58 %.
      const traversePct = zMax > 0 ? Math.max(0, Math.min(100, (zTraverse / zMax) * 100)) : 0;

      for (let i = 0; i < 16; i++) {
        const cell = document.getElementById(`ch-${i}`);
        if (!cell) continue;
        const hasTip = tipFitted[i] || false;
        const vol = volume[i] || 0;
        const tt = tipType[i] || -1;
        const z = posZ[i] || 0;
        const y = posY[i] || 0;
        const chInfo = channels[i] as ChannelLiquidInfo | undefined;

        const tipEl = cell.querySelector(".ch-tip") as HTMLElement;
        const volEl = cell.querySelector(".ch-vol") as HTMLElement;
        const liquidEl = cell.querySelector(".ch-liquid") as HTMLElement;
        const yEl = cell.querySelector(".ch-y") as HTMLElement;
        const zEl = cell.querySelector(".ch-z") as HTMLElement;
        const zFill = cell.querySelector(".ch-z-fill") as HTMLElement;
        const zMark = cell.querySelector(".ch-z-traverse-mark") as HTMLElement;

        cell.classList.toggle("has-tip", hasTip);
        cell.classList.toggle("has-volume", vol > 0);
        cell.classList.toggle("contaminated", chInfo?.contaminated || false);
        // Hamilton Z convention: 0 = fully retracted (top of travel), z_max
        // = fully extended (deepest possible). z_traverse marks the safe
        // travel height. A channel extended past z_traverse (z > zTraverse)
        // is inside labware — flag so the tick + CSS highlight it.
        cell.classList.toggle("below-traverse", z > zTraverse);

        if (tipEl) {
          tipEl.textContent = hasTip ? `T${tt}` : "--";
          tipEl.className = hasTip ? "ch-tip" : "ch-tip no-tip";
        }
        if (volEl) {
          const liquidVol = (chInfo?.contents as any)?.liquidVolume ?? vol;
          const airVol    = (chInfo?.contents as any)?.airVolume ?? 0;
          if (vol > 0) {
            const liqStr = (liquidVol / 10).toFixed(2);
            volEl.textContent = airVol > 0
              ? `${liqStr} µL + ${(airVol / 10).toFixed(2)} air`
              : `${liqStr} µL`;
            volEl.className = airVol > 0 ? "ch-vol ch-vol--air" : "ch-vol";
            volEl.title = airVol > 0
              ? `${(liquidVol / 10).toFixed(2)} µL liquid + ${(airVol / 10).toFixed(2)} µL trailing air (next dispense will spit air first)`
              : "";
          } else {
            volEl.textContent = "0";
            volEl.className = "ch-vol empty";
            volEl.title = "";
          }
        }
        if (liquidEl) {
          const liqType = chInfo?.contents?.liquidType || "";
          if (liqType) {
            liquidEl.textContent = liqType.length > 10 ? liqType.slice(0, 10) + ".." : liqType;
            liquidEl.style.color = liquidColor(liqType);
            liquidEl.title = liqType;
          } else {
            liquidEl.textContent = "";
            liquidEl.style.color = "";
          }
        }
        if (yEl) {
          yEl.textContent = mm(y);
          yEl.title = `pos_y[${i}] = ${y} (0.1mm) = ${(y / 10).toFixed(1)} mm`;
        }
        if (zEl) {
          zEl.textContent = mm(z);
          zEl.title = `pos_z[${i}] = ${z} (0.1mm) = ${(z / 10).toFixed(1)} mm`;
        }
        if (zFill) {
          // Bar height represents the tip's physical protrusion from the
          // head: 0 = fully retracted (empty bar), zMax = fully extended
          // (full bar). The fill grows DOWNWARD with increasing Z — like
          // a tip physically sticking out — so the dashed traverse line
          // becomes an obvious "engagement boundary" (fill past the
          // dashed line = tip is inside a well). An earlier version
          // inverted the fill (more fill = more retracted), which read
          // like a graph with the dashed line as a zero-axis — user
          // report 2026-04-19.
          const zPct = zMax > 0 ? Math.max(0, Math.min(100, (z / zMax) * 100)) : 0;
          zFill.style.height = zPct + "%";
          zFill.title = `Z ${(z / 10).toFixed(1)}mm extended (traverse=${(zTraverse / 10).toFixed(0)}mm, max=${(zMax / 10).toFixed(0)}mm)`;
        }
        if (zMark) {
          zMark.style.top = traversePct + "%";
          zMark.title = `Traverse line = ${(zTraverse / 10).toFixed(0)}mm (above = safe to move, below = engaged in labware)`;
        }
      }

      updateContaminationBadge();
    }

    /** Update JUST the Z-depth bars on all channel cells. Driven by the
     *  per-frame animate() loop in arm.ts so the gauge follows the
     *  animated Z during a C0AS / C0DS / C0TP move instead of waiting
     *  for the end-of-command SSE state broadcast. Without this the
     *  bar stayed full (pos_z=0) for any command that didn't include
     *  `zp` explicitly, and for every command between the aspirate and
     *  the next SSE frame — user report 2026-04-19.
     *
     *  When `animZ_ch` is provided (modern per-channel envelopes) each
     *  channel's bar follows its OWN Z. A real STAR has 16 independent
     *  Z drives — one channel can sit deeper than another when wells
     *  have different depths — so the bars should diverge during the
     *  descend phase, not move as a rigid block. Falls back to arm-
     *  wide animZ (all bars same height) when the envelope predates
     *  per-channel support (iSWAP/96-head/legacy traces). */
    export function updateAnimatedPipZ(animZ: number, animZ_ch?: number[]): void {
      const zMax = 2500;
      const zTraverse = 1450;
      for (let i = 0; i < 16; i++) {
        const cell = document.getElementById(`ch-${i}`);
        if (!cell) continue;
        const z = animZ_ch && i < animZ_ch.length ? animZ_ch[i] : animZ;
        const pct = zMax > 0 ? Math.max(0, Math.min(100, (z / zMax) * 100)) : 0;
        const belowTraverse = z > zTraverse;
        cell.classList.toggle("below-traverse", belowTraverse);
        const zFill = cell.querySelector(".ch-z-fill") as HTMLElement | null;
        if (zFill) zFill.style.height = pct + "%";
      }
    }

    function updateContaminationBadge(): void {
      let badge = document.getElementById("contamination-badge");
      const hasContam = State.deckTracking.hasContamination || false;
      if (!badge && hasContam) {
        const panel = document.getElementById("channel-view");
        if (panel) {
          badge = document.createElement("div");
          badge.id = "contamination-badge";
          badge.style.cssText = "background:#ef4444;color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-top:4px;text-align:center;";
          badge.textContent = "Contamination detected";
          panel.appendChild(badge);
        }
      }
      if (badge) badge.style.display = hasContam ? "block" : "none";
    }
  }
}
