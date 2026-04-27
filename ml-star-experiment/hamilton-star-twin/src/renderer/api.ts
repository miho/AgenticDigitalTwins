/**
 * HTTP API + SSE communication with the digital twin server.
 * All communication via fetch() and EventSource (no Node requires).
 */
/// <reference path="state.ts" />
/// <reference path="log.ts" />

namespace Twin {
  const API = window.location.origin;

  const ERROR_DESCRIPTIONS: Record<string, string> = {
    "03": "Not initialized", "06": "Too little liquid", "07": "Tip already fitted",
    "08": "No tip fitted", "09": "No carrier", "15": "Not allowed in current state",
    "18": "Wash fluid error", "19": "Temperature error", "22": "No element",
    "27": "Position not reachable", "99": "Slave error",
  };

  // ── Low-level fetch helpers ─────────────────────────────────────────────

  export async function apiPost(path: string, body: any): Promise<any> {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  export async function apiGet(path: string): Promise<any> {
    return (await fetch(`${API}${path}`)).json();
  }

  // ── High-level commands ─────────────────────────────────────────────────

  export async function sendCommand(raw: string): Promise<void> {
    const cmdTag = raw.slice(0, 4);
    addLogEntry("cmd", `>> ${raw}`);
    const result = await apiPost("/command", { raw });
    if (result.errorCode > 0) {
      const e = String(result.errorCode).padStart(2, "0");
      addLogEntry("err", `<< ${cmdTag} ERROR ${e}: ${result.errorDescription || ERROR_DESCRIPTIONS[e] || "Unknown"}`);
    } else if (result.accepted) {
      addLogEntry("ok", `<< ${cmdTag} OK  [${result.targetModule}]`);
    } else {
      addLogEntry("warn", `<< ${cmdTag} ${result.response}  (no effect)`);
    }
    if (result.deckInteraction?.effect) {
      addLogEntry("state", `   ${cmdTag} DECK: ${result.deckInteraction.effect}`);
    }
    for (const log of result.logs || []) {
      addLogEntry(log.includes("REJECTED") || log.includes("ERROR") ? "err" : "state", `   ${cmdTag} ${log}`);
    }
  }

  export async function sendCompletion(evt: string): Promise<void> {
    addLogEntry("info", `>> ${evt}`);
    await apiPost("/completion", { event: evt });
  }

  export async function doReset(): Promise<void> {
    await apiPost("/reset", {});
    State.previousVariables = {};
    State.deckTracking = { tipUsage: {}, wellVolumes: {}, unresolved: [], unresolvedCount: 0 };
    addLogEntry("warn", "=== RESET ===");
  }

  export async function refreshDeckTracking(): Promise<void> {
    State.deckTracking = await apiGet("/tracking");
    Glow.detectTrackingChanges();
    UI.updateUnresolvedBadge();
    DeckSVG.updateTracking();
    Inspector.refresh();
  }

  // ── SSE live updates ────────────────────────────────────────────────────

  export function setupSSE(): void {
    const es = new EventSource(`${API}/events`);

    es.addEventListener("state-changed", (e: Event) => {
      const state = JSON.parse((e as MessageEvent).data);
      UI.updateFromState(state);
    });

    es.addEventListener("tracking-changed", (e: Event) => {
      State.deckTracking = JSON.parse((e as MessageEvent).data);
      Glow.detectTrackingChanges();
      UI.updateUnresolvedBadge();
      DeckSVG.updateTracking();
      // Keep the inspector in sync with live volume / tip-usage changes —
      // without this, a fill or aspirate that happens while the user is
      // viewing a labware leaves the inspector panel showing stale zeros.
      Inspector.refresh();
    });

    es.addEventListener("command-result", (e: Event) => {
      const { raw, result } = JSON.parse((e as MessageEvent).data);
      // Include the 4-char command prefix in each entry so the filter
      // (e.g. "hide C0TT") can match the whole exchange, not just the
      // ">>" line.
      const cmdTag = raw.slice(0, 4);
      addLogEntry("cmd", `>> ${raw}  [ext]`);
      if (result.errorCode > 0) {
        addLogEntry("err", `<< ${cmdTag} ERROR ${result.errorCode}: ${result.errorDescription || "?"}`);
      } else if (result.accepted) {
        addLogEntry("ok", `<< ${cmdTag} OK  [${result.targetModule}]`);
      } else if (result.accepted === false) {
        // Silent SCXML rejection — this is exactly the path where the
        // arm animates (motion envelope fires pre-check) but no volume
        // change happens (deckTracker.processCommand is gated on
        // accepted+errorCode=0). Without surfacing it here the user
        // sees "arm moved, nothing else changed" with no clue why.
        addLogEntry("err", `<< ${cmdTag} REJECTED (SCXML state refused this command)`);
      }
      if (result.deckInteraction?.effect) {
        addLogEntry("state", `   ${cmdTag} DECK: ${result.deckInteraction.effect}`);
      }
      // Surface every internal log from the twin — REJECTED / PHYSICS /
      // DECK entries that explain rejections and unresolved positions.
      // The REST `sendCommand` already does this; the bridge path
      // previously dropped them, which left VENUS-driven runs looking
      // like "arm moves but volumes don't change" with no explanation.
      for (const log of result.logs || []) {
        const text = typeof log === "string" ? log : (log?.message ?? JSON.stringify(log));
        const level = /REJECT|ERROR|PHYSICS/i.test(text) ? "err" : "state";
        addLogEntry(level, `   ${cmdTag} ${text}`);
      }
    });

    es.addEventListener("completion", (e: Event) => {
      const { event } = JSON.parse((e as MessageEvent).data);
      addLogEntry("info", `>> ${event}  [ext]`);
    });

    es.addEventListener("reset", () => {
      State.previousVariables = {};
      State.deckTracking = { tipUsage: {}, wellVolumes: {}, unresolved: [], unresolvedCount: 0 };
      addLogEntry("warn", "=== RESET ===");
    });

    // #60 — hot-swap deck load. The REST/MCP/File-menu layout loaders
    // all end with `broker.broadcast("deck-loaded", …)`. Without this
    // listener the renderer kept showing the PREVIOUS layout; the
    // server was right, the UI lied. Re-fetch /deck, redraw, flush the
    // inspector (its HitRegion pointed at the old carrier).
    es.addEventListener("deck-loaded", async (e: Event) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data);
        State.deckData = await apiGet("/deck");
        State.deckTracking = await apiGet("/tracking");
        DeckSVG.renderDeck();
        // Fit to the fresh layout so off-deck fixtures from the new .dck
        // are visible without the user having to click Fit manually.
        DeckSVG.fitToContent();
        // Drop the inspector's cached HitRegion — it indexes into the
        // previous carrier list and would rerender onto the wrong
        // carrier on the next tracking-changed event.
        Inspector.clear();
        const insp = document.getElementById("inspector-content");
        if (insp) insp.textContent = "Deck reloaded — click a carrier to inspect";
        const name = payload?.path ? payload.path.split(/[\\/]/).pop() : "layout";
        addLogEntry("info", `Deck reloaded: ${name} (${payload?.placements?.length || 0} placements)`);
        if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
          for (const w of payload.warnings) addLogEntry("warn", `deck-loaded: ${w.code} — ${w.message}`);
        }
      } catch (err: any) {
        addLogEntry("err", `deck-loaded handler failed: ${err?.message ?? err}`);
      }
    });

    // Assessment events (physics observations)
    es.addEventListener("assessment", (e: Event) => {
      const event = JSON.parse((e as MessageEvent).data);
      Assessment.onAssessmentEvent(event);
      // Mirror onto the spatial annotations overlay (Step 3.6).
      try { Annotations.addFromAssessment(event); } catch {}
    });

    // Phase 3 replay events — keep annotations in sync with the cursor
    // so scrubbing shows the correct spatial markers.
    es.addEventListener("analysis-state-changed", (e: Event) => {
      // Repaint the annotations layer after the renderer has finished
      // drawing the new deck state. A short setTimeout yields to the
      // existing DeckSVG.updateTracking handler.
      setTimeout(() => { try { Annotations.render(); } catch {} }, 0);
    });

    // Device events (unsolicited FW events)
    es.addEventListener("device-event", (e: Event) => {
      const event = JSON.parse((e as MessageEvent).data);
      Assessment.onDeviceEvent(event);
    });

    // Motion envelopes — register with Arm so the renderer interpolates arm
    // position during the travel instead of snapping at the end.
    es.addEventListener("motion", (e: Event) => {
      try {
        const envelope = JSON.parse((e as MessageEvent).data);
        Arm.onMotionEnvelope(envelope);
      } catch {}
    });

    // Settings changes — sync the header Speed/Fast-Init controls when
    // another client (MCP, a second tab) writes the server-wide settings.
    es.addEventListener("settings-changed", (e: Event) => {
      try {
        const s = JSON.parse((e as MessageEvent).data);
        const speedSel = document.getElementById("sim-speed") as HTMLSelectElement | null;
        const fastChk = document.getElementById("fast-init") as HTMLInputElement | null;
        if (speedSel && typeof s.simSpeed === "number") {
          let best = speedSel.options[0];
          let bestDelta = Math.abs(Number(best.value) - s.simSpeed);
          for (const opt of Array.from(speedSel.options)) {
            const d = Math.abs(Number(opt.value) - s.simSpeed);
            if (d < bestDelta) { best = opt; bestDelta = d; }
          }
          speedSel.value = best.value;
        }
        if (fastChk && typeof s.fastInit === "boolean") fastChk.checked = s.fastInit;
      } catch {}
    });

    es.onerror = () => {
      addLogEntry("warn", "SSE connection lost, retrying...");
    };
  }
}
