/**
 * UI updates — module cards, variables panel, status bar, channel grid.
 */
/// <reference path="state.ts" />

namespace Twin {
  export namespace UI {
    // Busy states: module is performing a timed action
    const BUSY_STATES = [
      "moving", "washing", "washing_ws", "heating",
      "washing96", "moving96", "moving384", "washing384",
      "moving_grip", "shaking_state", "waiting_temp",
    ];

    // ── Aggregate update ────────────────────────────────────────────────

    export function updateAll(
      activeStates: Record<string, string[]>,
      variables: Record<string, Record<string, unknown>>,
    ): void {
      for (const [modId, states] of Object.entries(activeStates)) {
        updateModuleCard(modId, states);
      }
      updateStatusBar(activeStates);
      updateVariablesPanel(variables);
      updateAutoloadSubstat(variables["autoload"] || {});
      Channels.updateChannelView(variables["pip"] || {});
      Arm.updateDeckArm(variables["pip"] || {}, variables["iswap"] || {}, variables["h96"], variables["h384"], variables["autoload"]);
      DeckSVG.updateModuleVisuals(variables);
      State.previousVariables = JSON.parse(JSON.stringify(variables));
    }

    /** Render the AutoLoad module-card subtitle: "N/54 carriers · tray: empty|HAS CARRIER". */
    function updateAutoloadSubstat(vars: Record<string, unknown>): void {
      const el = document.getElementById("stat-autoload");
      if (!el) return;
      const onDeck = typeof vars.carriers_on_deck === "number" ? vars.carriers_on_deck : 0;
      const max = typeof vars.max_carriers === "number" ? vars.max_carriers : 54;
      const tray = vars.tray_occupied === true;
      const barcode = typeof vars.carrier_barcode === "string" ? vars.carrier_barcode : "";
      const parts = [`${onDeck}/${max} carriers`];
      parts.push(tray ? `<span class="autoload-tray-occupied">tray: HAS CARRIER</span>` : "tray: empty");
      if (barcode) parts.push(`bc: ${escapeHtml(barcode)}`);
      el.innerHTML = parts.join(" · ");
    }

    export function updateFromState(state: any): void {
      if (!state?.modules) return;
      const active: Record<string, string[]> = {};
      const vars: Record<string, Record<string, unknown>> = {};
      for (const [id, ms] of Object.entries(state.modules as Record<string, any>)) {
        active[id] = ms.states || [];
        vars[id] = ms.variables || {};
      }
      updateAll(active, vars);
    }

    // ── Module cards ────────────────────────────────────────────────────

    export function updateModuleCard(modId: string, states: string[]): void {
      const el = document.getElementById(`state-${modId}`);
      if (!el) return;
      const leaf = states.filter((s: string) =>
        !["operational", "idle", "tip_fitted_state", "tips_on", "ready", "idle_al"].includes(s)
      );
      el.textContent = leaf.length > 0 ? leaf.join(", ") : "--";

      const card = el.closest(".module-card") as HTMLElement;
      if (card) {
        card.classList.remove("active", "error", "busy");
        if (states.some((s: string) => s.includes("error"))) card.classList.add("error");
        else if (states.some((s: string) => BUSY_STATES.includes(s))) card.classList.add("busy");
        else if (leaf.length > 0 && !leaf.every(s => s === "not_initialized")) card.classList.add("active");
      }
    }

    // ── Variables panel ─────────────────────────────────────────────────

    export function updateVariablesPanel(allVars: Record<string, Record<string, unknown>>): void {
      const grid = document.getElementById("variables-grid");
      if (!grid) return;
      grid.innerHTML = "";
      for (const [modId, vars] of Object.entries(allVars)) {
        const card = document.createElement("div");
        card.className = "var-module-card";
        const header = document.createElement("div");
        header.className = "var-module-header";
        header.textContent = modId.toUpperCase();
        card.appendChild(header);
        const prev = State.previousVariables[modId] || {};
        for (const [key, value] of Object.entries(vars)) {
          if (Array.isArray(value)) continue;
          const row = document.createElement("div");
          row.className = "var-row";
          const n = document.createElement("span"); n.className = "var-name"; n.textContent = key;
          const v = document.createElement("span"); v.className = "var-value"; v.textContent = String(value);
          if (prev[key] !== undefined && JSON.stringify(prev[key]) !== JSON.stringify(value)) v.classList.add("changed");
          row.appendChild(n); row.appendChild(v);
          card.appendChild(row);
        }
        grid.appendChild(card);
      }
    }

    // ── Status bar ──────────────────────────────────────────────────────

    export function updateStatusBar(allStates: Record<string, string[]>): void {
      const bar = document.getElementById("system-status");
      if (!bar) return;
      const masterStates = allStates["master"] || [];
      const hasError = Object.values(allStates).some(s => s.some((st: string) => st.includes("error")));
      if (hasError) {
        bar.textContent = "ERROR";
        bar.style.background = "var(--accent-error)";
        bar.style.color = "#fff";
        bar.style.boxShadow = "0 0 12px var(--glow-error)";
      } else if (masterStates.includes("sys_ready")) {
        bar.textContent = "READY";
        bar.style.background = "var(--accent-success)";
        bar.style.color = "#fff";
        bar.style.boxShadow = "0 0 12px var(--glow-success)";
      } else {
        bar.textContent = "NOT INITIALIZED";
        bar.style.background = "var(--bg-surface)";
        bar.style.color = "var(--text-muted)";
        bar.style.boxShadow = "var(--shadow-inset)";
      }
    }

    // ── Unresolved badge ────────────────────────────────────────────────

    export function updateUnresolvedBadge(): void {
      const badge = document.getElementById("unresolved-badge");
      if (!badge) return;
      const count = State.deckTracking.unresolvedCount || 0;
      badge.textContent = String(count);
      badge.classList.toggle("hidden", count === 0);
    }
  }
}
