/**
 * Timeline scrubber UI (Step 3.8)
 *
 * A horizontal scrubber bar for navigating the Phase 3 replay cursor.
 * Shows:
 *   - A progress indicator (current position / total events)
 *   - Severity markers (one tick per flagged / error / warning event)
 *   - Click to jump, hover for a command summary tooltip
 *   - Play / pause / step-back / step-forward / speed controls
 *
 * The component is lazy: it installs itself into the `#timeline-scrubber`
 * DOM element when `mount()` is called, and subscribes to SSE
 * `analysis-position-changed` so its state tracks the server cursor.
 */
/// <reference path="state.ts" />
/// <reference path="api.ts" />

namespace Twin.TimelineScrubber {
  interface Position {
    eventId: number;
    totalEvents: number;
    currentEvent: any | null;
    revision: number;
  }

  interface Info extends Position {
    loaded: boolean;
    playing: boolean;
    speed: number;
    traceName: string | null;
    metadata: any | null;
  }

  let mounted = false;
  let root: HTMLElement | null = null;
  let events: any[] = [];   // cache of all events for severity ticks

  /**
   * Attach the scrubber to `#timeline-scrubber`. Safe to call multiple
   * times — idempotent.
   */
  export function mount(): void {
    if (mounted) return;
    root = document.getElementById("timeline-scrubber");
    if (!root) return;
    mounted = true;
    buildDom();
    refresh();
    subscribe();
  }

  /** Re-read the server's info + events, then re-render. */
  export async function refresh(): Promise<void> {
    if (!root) return;
    const info = await apiGet("/api/analysis/info") as Info;
    if (!info.loaded) {
      // Show the empty-state placeholder AND keep the controls visible
      // (disabled). Wiping the whole DOM would force a rebuild on load;
      // instead we toggle a class and an empty-state message.
      ensureScaffold();
      root.classList.add("ts-no-trace");
      const empty = root.querySelector<HTMLElement>(".ts-empty-msg");
      if (empty) empty.textContent = "No trace loaded — POST /api/analysis/load";
      return;
    }
    root.classList.remove("ts-no-trace");
    ensureScaffold();
    // Pull events only when the total changes (cheap even for 10k events).
    if (events.length !== info.totalEvents) {
      events = await apiGet(`/api/analysis/events?from=0&to=${info.totalEvents}`);
    }
    render(info);
  }

  /** Ensure the controls + track scaffold exists — idempotent. */
  function ensureScaffold(): void {
    if (!root) return;
    if (root.querySelector(".ts-controls")) return;
    buildDom();
  }

  /** Wire SSE — refresh on position changes so the cursor stays live. */
  function subscribe(): void {
    try {
      const es = new EventSource(`${window.location.origin}/events`);
      es.addEventListener("analysis-position-changed", () => { refresh(); });
      es.addEventListener("analysis-done", () => { refresh(); });
    } catch { /* no-op — scrubber stays static without SSE */ }
  }

  function buildDom(): void {
    if (!root) return;
    root.innerHTML = `
      <div class="ts-empty-msg"></div>
      <div class="ts-controls">
        <button class="ts-btn" data-action="step-back" title="Step back">⏮</button>
        <button class="ts-btn ts-btn--primary" data-action="toggle-play" title="Play/pause">▶</button>
        <button class="ts-btn" data-action="step-fwd" title="Step forward">⏭</button>
        <span class="ts-position"><span class="ts-pos-current">0</span> / <span class="ts-pos-total">0</span></span>
        <label class="ts-speed">speed
          <select data-action="speed">
            <option value="50">50 ms</option>
            <option value="150" selected>150 ms</option>
            <option value="500">500 ms</option>
            <option value="1000">1000 ms</option>
          </select>
        </label>
      </div>
      <div class="ts-track">
        <div class="ts-track-bg"></div>
        <div class="ts-track-fill"></div>
        <div class="ts-ticks"></div>
        <div class="ts-cursor"></div>
        <div class="ts-tooltip" style="display:none"></div>
      </div>
    `;

    // Controls
    root.querySelector('[data-action="step-back"]')?.addEventListener("click", async () => {
      await apiPost("/api/analysis/step", { direction: "backward" });
    });
    root.querySelector('[data-action="step-fwd"]')?.addEventListener("click", async () => {
      await apiPost("/api/analysis/step", { direction: "forward" });
    });
    root.querySelector('[data-action="toggle-play"]')?.addEventListener("click", async () => {
      const info = await apiGet("/api/analysis/info") as Info;
      if (info.playing) await apiPost("/api/analysis/pause", {});
      else await apiPost("/api/analysis/play", {});
    });
    root.querySelector('[data-action="speed"]')?.addEventListener("change", async (ev) => {
      const v = Number((ev.target as HTMLSelectElement).value);
      await apiPost("/api/analysis/speed", { speed: v });
    });

    // Click-to-jump on the track
    const track = root.querySelector<HTMLElement>(".ts-track");
    if (track) {
      track.addEventListener("click", async (ev) => {
        const rect = track.getBoundingClientRect();
        const pct = (ev.clientX - rect.left) / rect.width;
        const total = events.length;
        const target = Math.max(0, Math.min(total, Math.round(pct * total)));
        await apiPost("/api/analysis/jump", { eventId: target });
      });

      track.addEventListener("mousemove", (ev) => {
        const rect = track.getBoundingClientRect();
        const pct = (ev.clientX - rect.left) / rect.width;
        const total = events.length;
        const idx = Math.max(0, Math.min(total - 1, Math.round(pct * total)));
        const e = events[idx];
        const tip = root!.querySelector<HTMLElement>(".ts-tooltip");
        if (!tip || !e) return;
        tip.style.display = "block";
        tip.style.left = `${ev.clientX - rect.left}px`;
        tip.innerHTML = summariseEvent(idx + 1, e);
      });

      track.addEventListener("mouseleave", () => {
        const tip = root!.querySelector<HTMLElement>(".ts-tooltip");
        if (tip) tip.style.display = "none";
      });
    }
  }

  function render(info: Info): void {
    if (!root) return;
    const total = info.totalEvents;
    const current = info.eventId;
    const pct = total > 0 ? (current / total) * 100 : 0;

    const fill = root.querySelector<HTMLElement>(".ts-track-fill");
    const cursor = root.querySelector<HTMLElement>(".ts-cursor");
    const curLabel = root.querySelector<HTMLElement>(".ts-pos-current");
    const totLabel = root.querySelector<HTMLElement>(".ts-pos-total");
    const toggle = root.querySelector<HTMLElement>('[data-action="toggle-play"]');

    if (fill) fill.style.width = `${pct}%`;
    if (cursor) cursor.style.left = `${pct}%`;
    if (curLabel) curLabel.textContent = String(current);
    if (totLabel) totLabel.textContent = String(total);
    if (toggle) toggle.textContent = info.playing ? "⏸" : "▶";

    renderTicks();
  }

  function renderTicks(): void {
    if (!root) return;
    const ticksEl = root.querySelector<HTMLElement>(".ts-ticks");
    if (!ticksEl) return;
    ticksEl.innerHTML = "";
    const total = events.length;
    if (total === 0) return;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const sev = e.severity;
      if (sev !== "error" && sev !== "warning") continue;
      const pct = ((i + 1) / total) * 100;
      const tick = document.createElement("div");
      tick.className = `ts-tick ts-tick--${sev}`;
      tick.style.left = `${pct}%`;
      tick.title = `#${e.id} ${e.kind} ${sev}`;
      ticksEl.appendChild(tick);
    }
  }

  function summariseEvent(position: number, e: any): string {
    const kind = e.kind;
    if (kind === "command") {
      const raw = e.payload?.rawCommand ?? "";
      return `<b>#${position}</b> command <code>${escapeHtml(raw)}</code>`;
    }
    if (kind === "assessment") {
      return `<b>#${position}</b> assessment [${e.severity}] ${escapeHtml(e.payload?.description ?? "")}`;
    }
    return `<b>#${position}</b> ${kind}`;
  }

  function escapeHtml(s: string): string {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
