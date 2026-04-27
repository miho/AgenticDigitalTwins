/**
 * Renderer entry point — Hamilton STAR Digital Twin UI
 *
 * This file bootstraps the application. All logic is split across modules
 * under the Twin namespace (state, api, log, glow, arm, ui, channels,
 * deck-draw, deck-interact, inspector, layout).
 *
 * Built with tsc --outFile via tsconfig.renderer.json, which concatenates
 * all namespace files into a single renderer.js for the browser.
 */
/// <reference path="state.ts" />
/// <reference path="log.ts" />
/// <reference path="glow.ts" />
/// <reference path="arm.ts" />
/// <reference path="api.ts" />
/// <reference path="ui.ts" />
/// <reference path="channels.ts" />
/// <reference path="assessment.ts" />
/// <reference path="deck-svg.ts" />
/// <reference path="deck-interact.ts" />
/// <reference path="well-tooltip.ts" />
/// <reference path="inspector.ts" />
/// <reference path="layout.ts" />
/// <reference path="annotations.ts" />
/// <reference path="timeline-scrubber.ts" />

namespace Twin {
  // ── Window-exposed functions (called from HTML onclick handlers) ─────

  (window as any).sendInput = function (): void {
    const input = document.getElementById("command-input") as HTMLInputElement;
    if (!input) return;
    const v = input.value.trim();
    if (!v) return;
    if (/^[A-Z]{2}/.test(v)) sendCommand(v); else sendCompletion(v);
    input.value = ""; input.focus();
  };

  (window as any).quickCmd = function (cmd: string): void { sendCommand(cmd); };
  (window as any).quickEvt = function (evt: string): void { sendCompletion(evt); };
  (window as any).resetTwin = doReset;

  function setCoverButtonState(btn: HTMLElement | null, open: boolean): void {
    if (!btn) return;
    btn.textContent = `Cover: ${open ? "open" : "closed"}`;
    btn.classList.toggle("cover-open", open);
    (btn as HTMLButtonElement).setAttribute(
      "title",
      open
        ? "Front cover is OPEN — VENUS halts physical commands until it's closed. Click to close."
        : "Front cover closed. Click to open (simulates lifting the door — VENUS will refuse commands).",
    );
  }

  (window as any).toggleCover = async function (): Promise<void> {
    // Flip the front-cover state. VENUS polls C0QC before every
    // physical command and halts with "Cover not closed" when the
    // cover reports open, so this is how the user simulates pressing
    // the physical door.
    const btn = document.getElementById("header-cover");
    try {
      const current = await fetch("/cover").then((r) => r.json());
      const updated = await fetch("/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open: !current.open }),
      }).then((r) => r.json());
      setCoverButtonState(btn, !!updated.open);
      addLogEntry(updated.open ? "warn" : "info", `Front cover ${updated.open ? "OPENED" : "closed"}`);
    } catch (err: any) {
      addLogEntry("err", `Cover toggle failed: ${err?.message ?? err}`);
    }
  };

  // Initial cover-state sync on page load so the label matches the
  // server's truth even if the server was left with the cover open.
  fetch("/cover").then((r) => r.json()).then((s) => {
    setCoverButtonState(document.getElementById("header-cover"), !!s.open);
  }).catch(() => { /* server not ready yet, ignore */ });

  (window as any).toggleTheme = function (): void {
    const body = document.body;
    const current = body.getAttribute("data-theme");
    const next = current === "light" ? "dark" : "light";
    body.setAttribute("data-theme", next);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = next === "light" ? "\u2600" : "\u263E";  // sun / moon
    try { localStorage.setItem("twin-theme", next); } catch {}
    DeckSVG.renderDeck();
  };

  (window as any).initAll = async function (): Promise<void> {
    addLogEntry("info", "Initializing all modules...");
    await sendCommand("C0VI");
    await sendCommand("C0DI");
    await sendCommand("C0EI");
    await sendCommand("C0FI");
    await sendCommand("C0II");
    // Wait for delayed init events to complete
    setTimeout(async () => {
      await refreshDeckTracking();
      addLogEntry("ok", "All modules initialized");
    }, 2000);
  };

  (window as any).showCarrierInspector = function (hit: HitRegion | undefined): void {
    if (hit) Inspector.showCarrier(hit);
  };

  (window as any).hitRegions = null;  // Set after drawDeck

  (window as any).showUnresolved = function (): void {
    const panel = document.getElementById("inspector-content");
    if (!panel || !State.deckTracking.unresolved) return;
    let html = `<span class="insp-label">Unresolved Interactions (${State.deckTracking.unresolvedCount})</span>`;
    for (const u of State.deckTracking.unresolved) {
      html += `<div style="margin:4px 0;padding:4px;background:rgba(249,199,79,0.06);border-radius:4px;border-left:2px solid var(--accent-warning);">`;
      html += `<span class="insp-warn">${u.command}</span> `;
      html += `<span class="insp-dim">X=${(u.x / 10).toFixed(1)} Y=${(u.y / 10).toFixed(1)}mm</span><br>`;
      html += `<span class="insp-dim">${u.reason}</span>`;
      html += `</div>`;
    }
    if (State.deckTracking.unresolvedCount === 0) {
      html += `<span class="insp-value">All interactions resolved</span>`;
    }
    panel.innerHTML = html;
  };

  (window as any).setDeckMode = function (mode: "fit" | "fill"): void {
    State.deckMode = mode;
    document.getElementById("deck-fit")?.classList.toggle("active", mode === "fit");
    document.getElementById("deck-fill")?.classList.toggle("active", mode === "fill");
    DeckSVG.renderDeck();
  };

  (window as any).fitDeckToContent = function (): void {
    DeckSVG.fitToContent();
  };

  (window as any).zoomDeck = function (direction: number): void {
    // direction: +1 → zoom in, -1 → zoom out. Centered on the
    // current viewport so the user's eye doesn't lose its spot.
    const factor = direction > 0 ? 1.25 : 1 / 1.25;
    DeckSVG.zoomBy(factor);
  };

  (window as any).toggleGhostTool = function (): void {
    setGhostTool(!State.ghostTool);
  };

  // ── Initialization ──────────────────────────────────────────────────

  async function initialize(): Promise<void> {
    const state = await apiGet("/state");
    State.deckData = await apiGet("/deck");
    State.deckTracking = await apiGet("/tracking");
    UI.updateFromState(state);
    DeckSVG.renderDeck();
    Channels.buildChannelGrid();

    // Load assessment history (events sent before page opened)
    try {
      const assessments = await apiGet("/assessment?count=50");
      if (assessments && assessments.length > 0) {
        for (const a of assessments) Assessment.onAssessmentEvent(a);
      }
    } catch {}

    addLogEntry("info", "Digital Twin connected");
    setupSSE();
  }

  window.addEventListener("DOMContentLoaded", () => {
    // Restore saved theme
    try {
      const saved = localStorage.getItem("twin-theme");
      if (saved === "light") {
        document.body.setAttribute("data-theme", "light");
        const btn = document.getElementById("theme-toggle");
        if (btn) btn.textContent = "\u2600";
      }
    } catch {}

    initialize();
    DeckInteract.setupDeckClick();
    Layout.setupResizeHandles();
    TimelineScrubber.mount();

    // Delegated well-tooltip listener on the inspector panel so its mini-SVG
    // wells get the same hover UX as the main deck (same #deck-tooltip element).
    const insp = document.getElementById("inspector-content");
    if (insp) WellTooltip.attach(insp);

    // Log filter + C0TT hide toggle. Both run the same pass over existing
    // entries so either can be toggled independently.
    const logFilter = document.getElementById("log-filter") as HTMLInputElement;
    const hideC0tt = document.getElementById("log-hide-c0tt") as HTMLInputElement;
    const applyLogFilters = () => {
      const term = logFilter?.value.toLowerCase() ?? "";
      const hide = hideC0tt?.checked ?? false;
      document.querySelectorAll<HTMLElement>("#log-entries .log-entry").forEach((el) => {
        const isC0tt = el.dataset.cmd === "C0TT";
        if (hide && isC0tt) { el.style.display = "none"; return; }
        const matchesFilter = !term || (el.textContent ?? "").toLowerCase().includes(term);
        el.style.display = matchesFilter ? "" : "none";
      });
    };
    logFilter?.addEventListener("input", applyLogFilters);
    hideC0tt?.addEventListener("change", applyLogFilters);

    // Arm opacity slider
    const slider = document.getElementById("arm-opacity") as HTMLInputElement;
    if (slider) {
      slider.addEventListener("input", () => {
        State.armOpacity = parseInt(slider.value) / 100;
        DeckSVG.renderDeck();
      });
    }

    // Global simulation settings — Speed dropdown + Fast Init checkbox
    // in the header. Both read/write /api/settings so the server-wide
    // default governs every transport (raw /command, /step, MCP, VENUS
    // bridge) without the caller having to pass simSpeed explicitly.
    // `settings-changed` SSE keeps all connected clients in sync.
    setupSettingsControls();
  });

  function setSpeedSelect(value: number): void {
    const sel = document.getElementById("sim-speed") as HTMLSelectElement | null;
    if (!sel) return;
    // Find the closest option; exact match preferred so "1.0" and "1"
    // both land on the real-time row.
    let best = sel.options[0];
    let bestDelta = Math.abs(Number(best.value) - value);
    for (const opt of Array.from(sel.options)) {
      const d = Math.abs(Number(opt.value) - value);
      if (d < bestDelta) { best = opt; bestDelta = d; }
    }
    sel.value = best.value;
  }

  function setupSettingsControls(): void {
    const speedSel = document.getElementById("sim-speed") as HTMLSelectElement | null;
    const fastChk = document.getElementById("fast-init") as HTMLInputElement | null;
    if (!speedSel && !fastChk) return;

    const pushSettings = async () => {
      const patch: { simSpeed?: number; fastInit?: boolean } = {};
      if (speedSel) patch.simSpeed = Number(speedSel.value);
      if (fastChk) patch.fastInit = fastChk.checked;
      try {
        await apiPost("/settings", patch);
      } catch (err: any) {
        addLogEntry("err", `Settings update failed: ${err?.message ?? err}`);
      }
    };

    speedSel?.addEventListener("change", pushSettings);
    fastChk?.addEventListener("change", pushSettings);

    // Pull initial server state so the controls reflect what's actually
    // in effect (e.g. a headless server started with --sim-speed).
    apiGet("/settings").then((s: { simSpeed: number; fastInit: boolean }) => {
      if (!s) return;
      if (typeof s.simSpeed === "number") setSpeedSelect(s.simSpeed);
      if (fastChk && typeof s.fastInit === "boolean") fastChk.checked = s.fastInit;
    }).catch(() => { /* server not ready, ignore */ });
  }

  window.addEventListener("resize", () => { DeckSVG.renderDeck(); });
}
