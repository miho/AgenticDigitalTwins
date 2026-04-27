/**
 * Assessment UI — TADM chart, event stream, contamination timeline.
 *
 * Displays physics observations from the assessment engine.
 * Three tabbed views inside the #assessment-panel.
 */
/// <reference path="state.ts" />
/// <reference path="log.ts" />

namespace Twin {

  // ── Assessment event types (mirror backend types for UI) ───────────────

  interface AssessmentEvent {
    id: number;
    timestamp: number;
    category: string;
    severity: "info" | "warning" | "error";
    module: string;
    command: string;
    channel?: number;
    description: string;
    data?: Record<string, unknown>;
    tadm?: TADMData;
    lld?: any;
    contamination?: any;
  }

  interface TADMData {
    operation: string;
    curve: { time: number; pressure: number }[];
    upperBand: number[];
    lowerBand: number[];
    passed: boolean;
    violationIndex?: number;
    peakPressure: number;
    duration: number;
    volume: number;
    speed: number;
    perturbation?: string;
  }

  interface LLDData {
    detected: boolean;
    liquidSurfaceZ: number;    // 0.1 mm
    submergeDepth: number;     // 0.1 mm
    crashRisk: boolean;
    wellTopZ?: number;
    volumeAtSurface?: number;
  }

  interface DeviceEventData {
    type: string;
    module: string;
    description: string;
    errorCode?: number;
    timestamp: number;
  }

  // ── State ──────────────────────────────────────────────────────────────

  export namespace Assessment {
    let events: AssessmentEvent[] = [];
    let deviceEvents: DeviceEventData[] = [];
    let lastTADM: TADMData | null = null;
    /** Per-channel last-TADM, keyed by channel index (0..15). */
    const tadmByChannel: Map<number, TADMData> = new Map();
    /** Per-channel last LLD result, keyed by channel index. */
    const lldByChannel: Map<number, LLDData> = new Map();
    /**
     * Channel filter for the TADM chart. `null` = overlay all channels
     * that have data; otherwise only the specified channel's curve
     * renders. Driven by the channel chip UI above the chart.
     */
    let selectedChannel: number | null = null;
    const MAX_EVENTS = 200;

    /** Curve colours for channel overlay. 8 distinguishable hues. */
    const CHANNEL_COLORS = [
      "#4cc9f0", "#4895ef", "#4361ee", "#3a0ca3",
      "#7209b7", "#b5179e", "#f72585", "#ff7f50",
    ];

    /** Initialize assessment panel event listeners. */
    export function init(): void {
      // Tab switching is handled by switchAssessTab (window-exposed)
    }

    /** Apply an assessment to the UI (TADM chart, event list, toasts).
     *  Split out from `onAssessmentEvent` so we can defer display until
     *  the current motion envelope finishes — keeps the visual order
     *  consistent (arm descends → aspirate → TADM curve appears, not
     *  TADM popping up before the arm has moved). User request
     *  2026-04-19. */
    function applyAssessment(event: AssessmentEvent): void {
      events.push(event);
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);

      // Update TADM if this is a TADM observation
      if (event.tadm) {
        lastTADM = event.tadm;
        // Per-channel storage: when the assessment event is tagged
        // with a channel, keep the most recent curve for that channel
        // so the user can overlay or isolate curves in the chart.
        if (typeof event.channel === "number") {
          tadmByChannel.set(event.channel, event.tadm);
        }
        renderChannelChips();
        drawTADMChart();
      }

      // Capture LLD so the chart can annotate the liquid surface.
      if (event.lld && typeof event.channel === "number") {
        lldByChannel.set(event.channel, event.lld as LLDData);
        drawTADMChart();
      }

      // Update event list
      updateEventList();

      // Update contamination view
      if (event.category === "contamination") {
        updateContamination();
      }

      // Toast for warnings and errors
      if (event.severity === "error") {
        showToast(event.description, "error");
      } else if (event.severity === "warning" && event.category !== "tadm") {
        showToast(event.description, "warning");
      }
    }

    /** Handle an assessment event from SSE. If a motion envelope is
     *  currently animating on any arm, hold the event until it
     *  finishes so the user sees the arm move BEFORE the TADM curve /
     *  warning toast appears — otherwise the assessment arrives in
     *  the same frame as the send and beats the animation by 1–2 s. */
    export function onAssessmentEvent(event: AssessmentEvent): void {
      const envs = Arm.getActiveEnvelopes();
      if (envs.length > 0) {
        const now = performance.now();
        // End time of the latest envelope across all arms — wait for
        // ALL animations to complete, not just the first.
        const endsAt = Math.max(
          ...envs.map((e: any) => (e.startTimeLocal || 0) + (e.effectiveDurationMs || 0)),
        );
        const remaining = endsAt - now;
        if (remaining > 0) {
          window.setTimeout(() => applyAssessment(event), remaining);
          return;
        }
      }
      applyAssessment(event);
    }

    /** Handle a device event from SSE (unsolicited FW events). */
    export function onDeviceEvent(event: DeviceEventData): void {
      deviceEvents.push(event);
      if (deviceEvents.length > MAX_EVENTS) deviceEvents = deviceEvents.slice(-MAX_EVENTS);

      // Show in event list as a special entry
      const assessLike: AssessmentEvent = {
        id: -deviceEvents.length,
        timestamp: event.timestamp,
        category: event.type,
        severity: event.errorCode ? "error" : "info",
        module: event.module,
        command: "",
        description: event.description,
      };
      events.push(assessLike);
      updateEventList();

      if (event.errorCode) {
        showToast(event.description, "error");
      }
    }

    // ── Channel chip strip (above TADM chart) ─────────────────────────

    /**
     * Render one button per PIP channel that has data, plus an "All"
     * toggle. Clicking a chip narrows the chart to that channel;
     * clicking "All" restores the overlay. Kept rendering-light — we
     * only reflow when the channel set changes.
     */
    function renderChannelChips(): void {
      const strip = document.getElementById("tadm-channel-chips");
      if (!strip) return;
      const chans = [...tadmByChannel.keys()].sort((a, b) => a - b);
      const parts: string[] = [];
      parts.push(
        `<button class="tadm-chip ${selectedChannel === null ? "tadm-chip--on" : ""}" data-ch="all">All</button>`,
      );
      for (const ch of chans) {
        const active = selectedChannel === ch;
        const colour = CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
        parts.push(
          `<button class="tadm-chip ${active ? "tadm-chip--on" : ""}" data-ch="${ch}" style="--chip-color:${colour}">Ch ${ch + 1}</button>`,
        );
      }
      strip.innerHTML = parts.join("");
      strip.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const v = (btn as HTMLElement).dataset.ch!;
          selectedChannel = v === "all" ? null : Number(v);
          renderChannelChips();
          drawTADMChart();
        });
      });
    }

    /** Expose so initial load + tab-switch can refresh. */
    export function refreshChannelChips(): void {
      renderChannelChips();
    }

    // ── TADM Chart ─────────────────────────────────────────────────────

    export function drawTADMChart(): void {
      const canvas = document.getElementById("tadm-canvas") as HTMLCanvasElement;
      const info = document.getElementById("tadm-info");
      if (!canvas) return;

      // Figure out which curves to draw: either the selected channel
      // in isolation, the per-channel map (overlay mode), or — as a
      // fallback for legacy tests with no channel tagging — the single
      // `lastTADM` curve.
      const curvesToDraw: Array<{ channel: number | null; tadm: TADMData; color: string }> = [];
      if (selectedChannel !== null && tadmByChannel.has(selectedChannel)) {
        curvesToDraw.push({
          channel: selectedChannel,
          tadm: tadmByChannel.get(selectedChannel)!,
          color: CHANNEL_COLORS[selectedChannel % CHANNEL_COLORS.length],
        });
      } else if (tadmByChannel.size > 0) {
        for (const [ch, t] of tadmByChannel) {
          curvesToDraw.push({ channel: ch, tadm: t, color: CHANNEL_COLORS[ch % CHANNEL_COLORS.length] });
        }
      } else if (lastTADM) {
        curvesToDraw.push({ channel: null, tadm: lastTADM, color: "#4cc9f0" });
      }
      if (curvesToDraw.length === 0) return;

      const primary = curvesToDraw[0].tadm;

      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      const w = rect.width;
      const h = rect.height;

      const padL = 36, padR = 8, padT = 12, padB = 20;
      const cw = w - padL - padR;
      const ch = h - padT - padB;

      // Clear
      ctx.fillStyle = "#0a0e18";
      ctx.fillRect(0, 0, w, h);

      const curve = primary.curve;
      if (!curve || curve.length === 0) return;

      // Compute ranges over ALL curves so overlays share scale.
      const allTimes: number[] = [];
      const allPress: number[] = [];
      for (const entry of curvesToDraw) {
        for (const p of entry.tadm.curve) { allTimes.push(p.time); allPress.push(p.pressure); }
        allPress.push(...entry.tadm.upperBand, ...entry.tadm.lowerBand);
      }
      const tMax = Math.max(...allTimes);
      let pMin = Math.min(...allPress) - 20;
      let pMax = Math.max(...allPress) + 20;

      function tToX(t: number): number { return padL + (t / tMax) * cw; }
      function pToY(p: number): number { return padT + ch - ((p - pMin) / (pMax - pMin)) * ch; }

      // Grid
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 0.5;
      // Horizontal: zero line
      const zeroY = pToY(0);
      ctx.beginPath();
      ctx.moveTo(padL, zeroY);
      ctx.lineTo(padL + cw, zeroY);
      ctx.stroke();
      // Label
      ctx.fillStyle = "#4a5a6a";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("0", padL - 4, zeroY + 3);

      // Time axis
      ctx.textAlign = "center";
      ctx.fillStyle = "#3a4a5a";
      ctx.font = "7px sans-serif";
      const tStep = tMax > 500 ? 200 : tMax > 200 ? 100 : 50;
      for (let t = 0; t <= tMax; t += tStep) {
        const x = tToX(t);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
        ctx.fillText(`${t}ms`, x, h - 4);
      }

      // Tolerance band uses the primary curve (first on the overlay).
      if (primary.upperBand.length === primary.curve.length) {
        ctx.beginPath();
        for (let i = 0; i < primary.curve.length; i++) {
          const x = tToX(primary.curve[i].time);
          ctx[i === 0 ? "moveTo" : "lineTo"](x, pToY(primary.upperBand[i]));
        }
        for (let i = primary.curve.length - 1; i >= 0; i--) {
          ctx.lineTo(tToX(primary.curve[i].time), pToY(primary.lowerBand[i]));
        }
        ctx.closePath();
        ctx.fillStyle = primary.passed ? "rgba(82, 183, 136, 0.08)" : "rgba(247, 37, 133, 0.08)";
        ctx.fill();
        ctx.strokeStyle = primary.passed ? "rgba(82, 183, 136, 0.25)" : "rgba(247, 37, 133, 0.25)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let i = 0; i < primary.curve.length; i++) {
          ctx[i === 0 ? "moveTo" : "lineTo"](tToX(primary.curve[i].time), pToY(primary.upperBand[i]));
        }
        ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < primary.curve.length; i++) {
          ctx[i === 0 ? "moveTo" : "lineTo"](tToX(primary.curve[i].time), pToY(primary.lowerBand[i]));
        }
        ctx.stroke();
      }

      // Draw every channel's curve in its own colour.
      for (const entry of curvesToDraw) {
        ctx.strokeStyle = entry.color;
        ctx.lineWidth = curvesToDraw.length === 1 ? 1.5 : 1.1;
        ctx.globalAlpha = selectedChannel !== null && entry.channel !== selectedChannel ? 0.25 : 1;
        ctx.beginPath();
        for (let i = 0; i < entry.tadm.curve.length; i++) {
          ctx[i === 0 ? "moveTo" : "lineTo"](
            tToX(entry.tadm.curve[i].time),
            pToY(entry.tadm.curve[i].pressure),
          );
        }
        ctx.stroke();
        // Violation marker
        if (!entry.tadm.passed && entry.tadm.violationIndex !== undefined && entry.tadm.violationIndex < entry.tadm.curve.length) {
          const vp = entry.tadm.curve[entry.tadm.violationIndex];
          ctx.beginPath();
          ctx.arc(tToX(vp.time), pToY(vp.pressure), 3.5, 0, Math.PI * 2);
          ctx.fillStyle = entry.tadm.perturbation === "clot" ? "#f9844a" : "#f72585";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // LLD annotations — a small triangle near the start of the
      // curve marking detected liquid surface. Only shown when a
      // single channel is isolated so overlay views don't get noisy.
      if (selectedChannel !== null && lldByChannel.has(selectedChannel)) {
        const lld = lldByChannel.get(selectedChannel)!;
        const annX = padL + 20;
        const annY = padT + 2;
        ctx.fillStyle = lld.detected ? "#52b788" : "#f9844a";
        ctx.font = "8px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(
          lld.detected
            ? `LLD: surface Z=${(lld.liquidSurfaceZ / 10).toFixed(1)}mm  submerge=${(lld.submergeDepth / 10).toFixed(1)}mm`
            : `LLD: no surface detected`,
          annX,
          annY + 10,
        );
        if (lld.crashRisk) {
          ctx.fillStyle = "#f72585";
          ctx.fillText("⚠ crash risk", annX, annY + 20);
        }
      }

      // Pass/Fail indicator uses the primary curve.
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = primary.passed ? "#52b788" : "#f72585";
      ctx.fillText(primary.passed ? "PASS" : "FAIL", padL + 4, padT + 10);

      // Operation label
      ctx.fillStyle = "#6a7a9a";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "right";
      const channelLabel = selectedChannel !== null
        ? `Ch${selectedChannel + 1}`
        : curvesToDraw.length > 1 ? `${curvesToDraw.length} ch` : "";
      ctx.fillText(
        `${channelLabel ? channelLabel + "  " : ""}${primary.operation} ${primary.volume / 10}uL @ ${primary.speed / 10}uL/s  peak: ${primary.peakPressure}`,
        padL + cw, padT + 10,
      );

      // Pressure axis labels
      ctx.textAlign = "right";
      ctx.fillStyle = "#3a4a5a";
      ctx.font = "7px sans-serif";
      ctx.fillText(`${Math.round(pMax)}`, padL - 4, padT + 8);
      ctx.fillText(`${Math.round(pMin)}`, padL - 4, padT + ch);

      // Info bar
      if (info) {
        const extra = primary.perturbation ? ` — ${primary.perturbation}` : "";
        info.innerHTML = primary.passed
          ? `<span style="color:var(--accent-success)">TADM ${primary.operation} PASSED${extra}</span> — ` +
            `${primary.volume / 10}uL, peak ${primary.peakPressure} mbar, ${primary.duration}ms`
          : `<span style="color:var(--accent-error)">TADM ${primary.operation} VIOLATION${extra}</span> — ` +
            `at sample ${primary.violationIndex}, peak ${primary.peakPressure} mbar`;
      }
    }

    // ── Event List ─────────────────────────────────────────────────────

    function updateEventList(): void {
      const container = document.getElementById("assessment-events");
      if (!container) return;

      // Show most recent 50 events, newest first
      const recent = events.slice(-50).reverse();
      let html = "";

      for (const ev of recent) {
        const time = new Date(ev.timestamp).toLocaleTimeString("en-US", { hour12: false });
        const sevClass = `assess-event--${ev.severity}`;
        html += `<div class="assess-event ${sevClass}">` +
          `<span class="ae-time">${time}</span>` +
          `<span class="ae-module">${ev.module}</span>` +
          `<span class="ae-cat">${ev.category}</span>` +
          `<span class="ae-desc">${escapeHtml(ev.description)}</span>` +
          `</div>`;
      }

      container.innerHTML = html || `<div style="padding:8px;color:var(--text-muted);font-size:9px;">No assessment events yet</div>`;
    }

    // ── Contamination Timeline ─────────────────────────────────────────

    function updateContamination(): void {
      const channelsEl = document.getElementById("contam-channels");
      const eventsEl = document.getElementById("contam-events");
      if (!channelsEl) return;

      // Channel status dots from tracking data
      const channels = State.deckTracking.channels;
      let dotsHtml = "";
      for (let i = 0; i < 16; i++) {
        const ch = channels?.[i];
        const contaminated = ch?.contaminated;
        const cls = contaminated ? "contam-dot contam-dot--error" : "contam-dot";
        dotsHtml += `<div class="${cls}" title="Ch ${i + 1}">${i + 1}</div>`;
      }
      channelsEl.innerHTML = dotsHtml;

      // Contamination events
      if (eventsEl) {
        const contamEvents = events.filter(e => e.category === "contamination").slice(-20).reverse();
        let html = "";
        for (const ev of contamEvents) {
          const time = new Date(ev.timestamp).toLocaleTimeString("en-US", { hour12: false });
          html += `<div class="assess-event assess-event--${ev.severity}">` +
            `<span class="ae-time">${time}</span>` +
            `<span class="ae-module">Ch${ev.channel !== undefined ? ev.channel + 1 : "?"}</span>` +
            `<span class="ae-desc">${escapeHtml(ev.description)}</span>` +
            `</div>`;
        }
        eventsEl.innerHTML = html || `<div style="padding:8px;color:var(--text-muted);font-size:9px;">No contamination events</div>`;
      }
    }

    // ── Toast Notifications ────────────────────────────────────────────

    function showToast(message: string, severity: "info" | "warning" | "error"): void {
      const toast = document.createElement("div");
      toast.className = `toast toast--${severity}`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    function escapeHtml(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  }

  // ── Window-exposed tab switcher ──────────────────────────────────────

  (window as any).switchAssessTab = function (tab: string): void {
    document.querySelectorAll(".assess-tab").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab);
    });
    document.querySelectorAll(".assess-view").forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
    const target = document.getElementById(`${tab}-view`);
    if (target) target.style.display = "";

    // Redraw TADM chart when switching to its tab (for correct sizing)
    if (tab === "tadm") {
      Assessment.refreshChannelChips();
      Assessment.drawTADMChart();
    }
  };
}
