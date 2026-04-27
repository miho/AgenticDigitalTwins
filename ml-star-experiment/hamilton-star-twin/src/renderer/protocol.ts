/**
 * Protocol Editor — visual VENUS step sequence builder.
 *
 * Users add steps to a protocol, configure parameters via inline forms,
 * then execute the sequence. Results are shown inline per step.
 */
/// <reference path="state.ts" />
/// <reference path="api.ts" />
/// <reference path="log.ts" />

namespace Twin {

  /** Step parameter definitions: what fields each step type needs */
  const STEP_PARAMS: Record<string, Array<{
    key: string; label: string;
    type: "carrier" | "position" | "column" | "number" | "mask" | "select" | "liquidClass" | "text";
    default?: any; min?: number; max?: number; options?: Array<{ value: any; label: string }>;
    group?: string; // group related fields (e.g. "tip", "source", "dest")
    placeholder?: string;
  }>> = {
    // ── Pipetting ──────────────────────────────────────────────────────
    easyTransfer: [
      { key: "tipPosition.carrierId", label: "Tip Carrier", type: "carrier", default: "TIP001", group: "tip" },
      { key: "tipPosition.position", label: "Tip Position", type: "position", default: 0, group: "tip" },
      { key: "tipPosition.column", label: "Tip Column", type: "column", default: 0, group: "tip" },
      { key: "sourcePosition.carrierId", label: "Source Carrier", type: "carrier", default: "SMP001", group: "source" },
      { key: "sourcePosition.position", label: "Source Position", type: "position", default: 0, group: "source" },
      { key: "sourcePosition.column", label: "Source Column", type: "column", default: 0, group: "source" },
      { key: "destPosition.carrierId", label: "Dest Carrier", type: "carrier", default: "DST001", group: "dest" },
      { key: "destPosition.position", label: "Dest Position", type: "position", default: 0, group: "dest" },
      { key: "destPosition.column", label: "Dest Column", type: "column", default: 0, group: "dest" },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100, min: 1, max: 1000 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    easyAspirate: [
      { key: "tipPosition.carrierId", label: "Tip Carrier", type: "carrier", default: "TIP001", group: "tip" },
      { key: "tipPosition.position", label: "Pos", type: "position", default: 0, group: "tip" },
      { key: "tipPosition.column", label: "Col", type: "column", default: 0, group: "tip" },
      { key: "aspiratePosition.carrierId", label: "Source Carrier", type: "carrier", default: "SMP001", group: "source" },
      { key: "aspiratePosition.position", label: "Pos", type: "position", default: 0, group: "source" },
      { key: "aspiratePosition.column", label: "Col", type: "column", default: 0, group: "source" },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100, min: 1, max: 1000 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    easyDispense: [
      { key: "dispensePosition.carrierId", label: "Dest Carrier", type: "carrier", default: "DST001", group: "dest" },
      { key: "dispensePosition.position", label: "Pos", type: "position", default: 0, group: "dest" },
      { key: "dispensePosition.column", label: "Col", type: "column", default: 0, group: "dest" },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100, min: 1, max: 1000 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    aspirate: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "SMP001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100, min: 1, max: 1000 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    dispense: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "DST001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100, min: 1, max: 1000 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
      { key: "dispenseMode", label: "Mode", type: "select", default: 0, options: [
        { value: 0, label: "Jet Empty" }, { value: 2, label: "Surface Partial" },
        { value: 3, label: "Surface Empty" }, { value: 4, label: "Jet Tip Empty" },
      ]},
    ],
    tipPickUp: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "TIP001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    tipEject: [
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    // ── Transport ──────────────────────────────────────────────────────
    easyTransport: [
      { key: "sourcePosition.carrierId", label: "Source Carrier", type: "carrier", default: "SMP001", group: "source" },
      { key: "sourcePosition.position", label: "Pos", type: "position", default: 0, group: "source" },
      { key: "sourcePosition.column", label: "Col", type: "column", default: 0, group: "source" },
      { key: "destPosition.carrierId", label: "Dest Carrier", type: "carrier", default: "DST001", group: "dest" },
      { key: "destPosition.position", label: "Pos", type: "position", default: 0, group: "dest" },
      { key: "destPosition.column", label: "Col", type: "column", default: 0, group: "dest" },
    ],
    // ── 96-Head ────────────────────────────────────────────────────────
    easy96Aspirate: [
      { key: "tipPosition.carrierId", label: "Tip Carrier", type: "carrier", default: "TIP001", group: "tip" },
      { key: "tipPosition.position", label: "Pos", type: "position", default: 0, group: "tip" },
      { key: "tipPosition.column", label: "Col", type: "column", default: 0, group: "tip" },
      { key: "aspiratePosition.carrierId", label: "Source Carrier", type: "carrier", default: "SMP001", group: "source" },
      { key: "aspiratePosition.position", label: "Pos", type: "position", default: 0, group: "source" },
      { key: "aspiratePosition.column", label: "Col", type: "column", default: 0, group: "source" },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100 },
    ],
    head96Move: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "SMP001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
    ],
    // ── Power Steps ────────────────────────────────────────────────────
    transferSamples: [
      { key: "tipCarrier", label: "Tip Carrier", type: "carrier", default: "TIP001" },
      { key: "tipPosition", label: "Tip Pos", type: "position", default: 0 },
      { key: "sourceCarrier", label: "Source Carrier", type: "carrier", default: "SMP001" },
      { key: "sourcePosition", label: "Source Pos", type: "position", default: 0 },
      { key: "destCarrier", label: "Dest Carrier", type: "carrier", default: "DST001" },
      { key: "destPosition", label: "Dest Pos", type: "position", default: 0 },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100 },
      { key: "columns", label: "Columns", type: "number", default: 12, min: 1, max: 24 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    addReagent: [
      { key: "tipCarrier", label: "Tip Carrier", type: "carrier", default: "TIP001" },
      { key: "tipPosition", label: "Tip Pos", type: "position", default: 0 },
      { key: "reagentCarrier", label: "Reagent Carrier", type: "carrier", default: "RGT001" },
      { key: "reagentPosition", label: "Reagent Pos", type: "position", default: 0 },
      { key: "destCarrier", label: "Dest Carrier", type: "carrier", default: "DST001" },
      { key: "destPosition", label: "Dest Pos", type: "position", default: 0 },
      { key: "volume", label: "Volume (µL)", type: "number", default: 50 },
      { key: "columns", label: "Columns", type: "number", default: 12, min: 1, max: 24 },
    ],
    fill: [
      { key: "carrierId", label: "Carrier", type: "carrier", default: "SMP001" },
      { key: "position", label: "Position", type: "position", default: 0 },
      { key: "liquidType", label: "Liquid", type: "text", default: "Diluent",
        placeholder: "Water, Buffer, Sample, DMSO…" },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100, min: 0 },
      { key: "target", label: "Target", type: "select", default: "all", options: [
        { value: "all", label: "All wells" },
        { value: "columns", label: "Column(s)" },
        { value: "rows", label: "Row(s)" },
        { value: "wells", label: "Well index/indices" },
      ]},
      { key: "selector", label: "Selector", type: "text", default: "",
        placeholder: "e.g. 1 or 2-12 or 1,3,5 (1-based for cols/rows)" },
    ],
    serialDilution: [
      { key: "tipCarrier", label: "Tip Carrier", type: "carrier", default: "TIP001" },
      { key: "tipPosition", label: "Tip Pos", type: "position", default: 0 },
      { key: "plateCarrier", label: "Plate Carrier", type: "carrier", default: "SMP001" },
      { key: "platePosition", label: "Plate Pos", type: "position", default: 0 },
      { key: "volume", label: "Transfer Vol (µL)", type: "number", default: 100 },
      { key: "numDilutions", label: "# Dilutions", type: "number", default: 11, min: 1, max: 23 },
      { key: "mixCycles", label: "Mix Cycles", type: "number", default: 3, min: 0, max: 10 },
    ],
    setTemperature: [
      { key: "temperature", label: "Temperature (°C)", type: "number", default: 37, min: 4, max: 70 },
      { key: "heaterNumber", label: "Heater", type: "number", default: 1, min: 1, max: 4 },
    ],
    wash: [],
    dispenseFly: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "DST001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
      { key: "volume", label: "Volume (µL)", type: "number", default: 10 },
      { key: "numDispenses", label: "# Dispenses", type: "number", default: 5, min: 1, max: 20 },
      { key: "channelMask", label: "Channels", type: "mask", default: 255 },
    ],
    // Stubs for step types that exist but don't need custom params in editor
    head96TipPickUp: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "TIP001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
    ],
    easy96Dispense: [
      { key: "dispensePosition.carrierId", label: "Dest Carrier", type: "carrier", default: "DST001", group: "dest" },
      { key: "dispensePosition.position", label: "Pos", type: "position", default: 0, group: "dest" },
      { key: "dispensePosition.column", label: "Col", type: "column", default: 0, group: "dest" },
      { key: "ejectPosition.carrierId", label: "Eject Carrier", type: "carrier", default: "TIP001", group: "eject" },
      { key: "ejectPosition.position", label: "Pos", type: "position", default: 0, group: "eject" },
      { key: "ejectPosition.column", label: "Col", type: "column", default: 0, group: "eject" },
      { key: "volume", label: "Volume (µL)", type: "number", default: 100 },
    ],
    getPlate: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "SMP001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
    ],
    putPlate: [
      { key: "position.carrierId", label: "Carrier", type: "carrier", default: "DST001" },
      { key: "position.position", label: "Pos", type: "position", default: 0 },
      { key: "position.column", label: "Col", type: "column", default: 0 },
    ],
    movePIP: [
      { key: "xPosition", label: "X Position (mm)", type: "number", default: 100, min: 0, max: 1300 },
    ],
  };

  // Step type display names
  const STEP_NAMES: Record<string, string> = {
    easyTransfer: "Easy Transfer",
    easyAspirate: "Easy Aspirate",
    easyDispense: "Easy Dispense",
    aspirate: "Aspirate",
    dispense: "Dispense",
    dispenseFly: "Dispense Fly",
    tipPickUp: "Tip Pick Up",
    tipEject: "Tip Eject",
    easy96Aspirate: "96-Head Aspirate",
    easy96Dispense: "96-Head Dispense",
    head96Move: "96-Head Move",
    head96TipPickUp: "96-Head Tip Pick Up",
    easyTransport: "Easy Transport",
    getPlate: "iSWAP Get Plate",
    putPlate: "iSWAP Put Plate",
    transferSamples: "Transfer Samples",
    addReagent: "Add Reagent",
    serialDilution: "Serial Dilution",
    fill: "Fill (setup)",
    setTemperature: "Set Temperature",
    wash: "Wash",
    movePIP: "Move PIP",
  };

  interface ProtocolStep {
    id: number;
    type: string;
    params: Record<string, any>;
    result?: any;
    status: "pending" | "running" | "success" | "error";
    subSteps?: Array<{ type: string; label: string; params: any }>;
    subResults?: Array<{ type: string; label: string; result: any }>;
    currentSub?: number;
  }

  let steps: ProtocolStep[] = [];
  let stepCounter = 0;

  function getCarrierIds(): string[] {
    return State.deckData?.carriers?.map((c: any) => c.id) || [];
  }

  /** Set nested property: "tipPosition.carrierId" → obj.tipPosition.carrierId */
  function setNested(obj: Record<string, any>, path: string, value: any): void {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in cur)) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  /** Get nested property */
  function getNested(obj: Record<string, any>, path: string): any {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  export function switchCmdTab(tab: string): void {
    document.querySelectorAll(".cmd-tab").forEach(b => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    document.querySelectorAll(".cmd-view").forEach(v => (v as HTMLElement).style.display = "none");
    const view = document.getElementById(`cmd-${tab}`);
    if (view) view.style.display = "";
  }

  export namespace Protocol {
    export function addStep(): void {
      const select = document.getElementById("step-type-select") as HTMLSelectElement;
      const type = select.value;
      const paramDefs = STEP_PARAMS[type] || [];
      const params: Record<string, any> = {};
      for (const p of paramDefs) setNested(params, p.key, p.default ?? "");
      const step: ProtocolStep = { id: ++stepCounter, type, params, status: "pending" };
      steps.push(step);
      renderSteps();
    }

    /** Programmatic step creation (from deck context menu, API, etc.).
     *  Fills unspecified params with their STEP_PARAMS defaults. Returns the
     *  new step's id so callers can optionally `runStep(id)` right after. */
    export function addStepWith(type: string, params: Record<string, any>): number {
      const paramDefs = STEP_PARAMS[type] || [];
      const merged: Record<string, any> = {};
      for (const p of paramDefs) setNested(merged, p.key, p.default ?? "");
      for (const k of Object.keys(params)) setNested(merged, k, params[k]);
      const step: ProtocolStep = { id: ++stepCounter, type, params: merged, status: "pending" };
      steps.push(step);
      renderSteps();
      return step.id;
    }

    export function removeStep(id: number): void {
      steps = steps.filter(s => s.id !== id);
      renderSteps();
    }

    export function moveStep(id: number, dir: -1 | 1): void {
      const idx = steps.findIndex(s => s.id === id);
      if (idx < 0) return;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= steps.length) return;
      [steps[idx], steps[newIdx]] = [steps[newIdx], steps[idx]];
      renderSteps();
    }

    export function updateParam(stepId: number, key: string, value: any): void {
      const step = steps.find(s => s.id === stepId);
      if (step) setNested(step.params, key, value);
    }

    function getSimSpeed(): number {
      const el = document.getElementById("sim-speed") as HTMLSelectElement | null;
      return el ? Number(el.value) : 0;
    }

    /** Parse selector strings like "1", "2-12", "1,3,5", "1-3, 5, 7-9".
     *  Input is 1-based (user-facing); returns 0-based indices. */
    function parseIndexList(input: string): number[] {
      if (!input || !input.trim()) return [];
      const out = new Set<number>();
      for (const part of input.split(",")) {
        const s = part.trim();
        if (!s) continue;
        const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
          const a = Number(m[1]) - 1, b = Number(m[2]) - 1;
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (let i = lo; i <= hi; i++) if (i >= 0) out.add(i);
        } else {
          const n = Number(s);
          if (Number.isFinite(n) && n >= 1) out.add(n - 1);
        }
      }
      return Array.from(out).sort((a, b) => a - b);
    }

    /** Transform step params just before sending to the server. Today this
     *  expands the Fill step's free-text `selector` into a concrete index
     *  array on the correct field. Other steps pass through unchanged.
     *
     *  Important: only overwrite the index array when the selector string is
     *  non-empty. Right-click fills arrive with columns/rows/wellIndices
     *  already populated — we must not clobber them with [] from a blank
     *  selector (the default seeded by addStepWith). */
    function prepareParamsForSend(stepType: string, params: any): any {
      if (stepType !== "fill") return params;
      const out = { ...params };
      const sel = String(out.selector ?? "").trim();
      delete out.selector;
      if (sel !== "") {
        const indices = parseIndexList(sel);
        if (out.target === "columns") out.columns = indices;
        else if (out.target === "rows") out.rows = indices;
        else if (out.target === "wells") out.wellIndices = indices;
      }
      return out;
    }

    /** Wait until the arm animation reports it has settled, or until timeoutMs.
     *  Polls State.animActive (set by Twin.Arm) every animation frame. */
    function waitForArmSettle(timeoutMs: number): Promise<void> {
      return new Promise((resolve) => {
        const start = performance.now();
        const tick = () => {
          if (!State.animActive) return resolve();
          if (performance.now() - start >= timeoutMs) return resolve();
          requestAnimationFrame(tick);
        };
        // One microtask delay so the just-arrived state update had a chance to
        // set a new target (and flip animActive back to true).
        requestAnimationFrame(tick);
      });
    }

    export async function runStep(id: number): Promise<void> {
      const step = steps.find(s => s.id === id);
      if (!step) return;
      const simSpeed = getSimSpeed();
      step.status = "running";
      step.result = undefined;
      step.subSteps = undefined;
      step.subResults = [];
      step.currentSub = -1;
      renderSteps();

      try {
        // Resolve step-specific UI → API param shape (e.g., parse fill selector strings).
        const sendParams = prepareParamsForSend(step.type, step.params);

        // Decompose composite steps
        let decomp: any = null;
        try { decomp = await apiPost("/step/decompose", { type: step.type, params: sendParams }); } catch {}
        const hasSubs = decomp?.subSteps?.length > 0;

        if (hasSubs) {
          step.subSteps = decomp.subSteps;
          renderSteps();
          for (let i = 0; i < step.subSteps!.length; i++) {
            step.currentSub = i;
            renderSteps();
            const sub = step.subSteps![i];
            const result = await apiPost("/step", { type: sub.type, params: sub.params, simSpeed });
            step.subResults!.push({ type: sub.type, label: sub.label, result });
            await refreshDeckTracking();
            renderSteps();
            if (!result.success) {
              step.status = "error";
              step.result = { success: false, error: `${sub.label} failed: ${result.error}` };
              step.currentSub = -1;
              renderSteps();
              return;
            }
            // Wait for the arm animation to complete before firing the next
            // sub-step. Motion envelopes drive a physically-grounded
            // trajectory whose duration depends on X-travel distance, so we
            // cap generously (worst-case full-deck traverse) rather than
            // using a fixed short budget.
            await waitForArmSettle(8000);
          }
          step.status = "success";
          step.result = { success: true, subStepCount: step.subSteps!.length };
        } else {
          const result = await apiPost("/step", { type: step.type, params: sendParams, simSpeed });
          step.result = result;
          step.status = result.success ? "success" : "error";
          await refreshDeckTracking();
        }
      } catch (err: any) {
        step.result = { success: false, error: err.message };
        step.status = "error";
      }
      step.currentSub = -1;
      renderSteps();
    }

    export async function runAll(): Promise<void> {
      const status = document.getElementById("proto-status")!;
      for (const step of steps) {
        step.status = "pending";
        step.result = undefined;
        step.subSteps = undefined;
        step.subResults = [];
      }
      renderSteps();
      const t0 = Date.now();
      for (let i = 0; i < steps.length; i++) {
        status.textContent = `Running step ${i + 1}/${steps.length}...`;
        await runStep(steps[i].id);
        if (steps[i].status === "error") {
          status.textContent = `Failed at step ${i + 1}`;
          return;
        }
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      status.textContent = `All ${steps.length} steps completed (${elapsed}s)`;
    }

    export function clearSteps(): void {
      steps = [];
      stepCounter = 0;
      const status = document.getElementById("proto-status");
      if (status) status.textContent = "";
      renderSteps();
    }

    function renderSteps(): void {
      const container = document.getElementById("protocol-steps")!;
      if (!container) return;
      if (steps.length === 0) {
        container.innerHTML = `<div class="proto-empty">No steps — select a step type and click + Add</div>`;
        return;
      }

      container.innerHTML = "";
      for (const step of steps) {
        const el = document.createElement("div");
        el.className = `proto-step proto-step--${step.status}`;
        el.dataset.stepId = String(step.id);

        // Header
        const header = document.createElement("div");
        header.className = "proto-step-header";
        const nameLabel = STEP_NAMES[step.type] || step.type;
        header.innerHTML = `
          <span class="proto-step-badge">${steps.indexOf(step) + 1}</span>
          <span class="proto-step-name">${nameLabel}</span>
          <span class="proto-step-actions">
            <button onclick="Twin.Protocol.moveStep(${step.id},-1)" title="Move up">&uarr;</button>
            <button onclick="Twin.Protocol.moveStep(${step.id},1)" title="Move down">&darr;</button>
            <button onclick="Twin.Protocol.runStep(${step.id})" title="Run this step">&triangleright;</button>
            <button onclick="Twin.Protocol.removeStep(${step.id})" title="Remove">&times;</button>
          </span>
        `;
        el.appendChild(header);

        // Parameter form
        const paramDefs = STEP_PARAMS[step.type] || [];
        if (paramDefs.length > 0) {
          const form = document.createElement("div");
          form.className = "proto-step-params";

          let currentGroup = "";
          for (const p of paramDefs) {
            if (p.group && p.group !== currentGroup) {
              currentGroup = p.group;
              const groupLabel = document.createElement("div");
              groupLabel.className = "proto-param-group";
              groupLabel.textContent = p.group.charAt(0).toUpperCase() + p.group.slice(1);
              form.appendChild(groupLabel);
            } else if (!p.group && currentGroup) {
              currentGroup = "";
            }

            const row = document.createElement("label");
            row.className = "proto-param";
            row.innerHTML = `<span class="proto-param-label">${p.label}</span>`;

            const val = getNested(step.params, p.key) ?? p.default;

            if (p.type === "carrier") {
              const sel = document.createElement("select");
              sel.className = "proto-input";
              for (const cid of getCarrierIds()) {
                sel.innerHTML += `<option value="${cid}" ${cid === val ? "selected" : ""}>${cid}</option>`;
              }
              sel.onchange = () => Protocol.updateParam(step.id, p.key, sel.value);
              row.appendChild(sel);
            } else if (p.type === "select") {
              const sel = document.createElement("select");
              sel.className = "proto-input";
              for (const opt of p.options || []) {
                sel.innerHTML += `<option value="${opt.value}" ${opt.value == val ? "selected" : ""}>${opt.label}</option>`;
              }
              sel.onchange = () => Protocol.updateParam(step.id, p.key, Number(sel.value));
              row.appendChild(sel);
            } else if (p.type === "mask") {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.className = "proto-input";
              inp.min = "0"; inp.max = "255"; inp.value = String(val);
              inp.onchange = () => Protocol.updateParam(step.id, p.key, Number(inp.value));
              row.appendChild(inp);
            } else if (p.type === "text") {
              const inp = document.createElement("input");
              inp.type = "text";
              inp.className = "proto-input";
              inp.value = val == null ? "" : String(val);
              if (p.placeholder) inp.placeholder = p.placeholder;
              inp.onchange = () => Protocol.updateParam(step.id, p.key, inp.value);
              row.appendChild(inp);
            } else {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.className = "proto-input";
              if (p.min !== undefined) inp.min = String(p.min);
              if (p.max !== undefined) inp.max = String(p.max);
              inp.value = String(val);
              inp.onchange = () => Protocol.updateParam(step.id, p.key, Number(inp.value));
              row.appendChild(inp);
            }

            form.appendChild(row);
          }
          el.appendChild(form);
        }

        // Sub-steps with FW commands (decomposed execution)
        if (step.subResults && step.subResults.length > 0) {
          const subsDiv = document.createElement("div");
          subsDiv.style.cssText = "margin-top:4px;border-top:1px solid var(--border-subtle);padding-top:4px;";
          for (let si = 0; si < step.subResults.length; si++) {
            const sr = step.subResults[si];
            const isActive = step.currentSub === si;
            const ok = sr.result?.success !== false;
            const badge = ok ? `<span class="proto-ok">OK</span>` : `<span class="proto-err">FAIL</span>`;
            let html = `<div style="margin-bottom:3px;${isActive ? "color:var(--accent-primary);" : ""}">`;
            html += `<span style="font-size:9px;font-weight:600;color:${ok ? "var(--text-secondary)" : "#ef4444"};">${si + 1}. ${sr.label}</span> ${badge}`;
            if (!ok && sr.result?.error) {
              html += `<div style="color:#ef4444;font-size:9px;padding:2px 0 2px 12px;">${String(sr.result.error).replace(/</g, "&lt;")}</div>`;
            }
            // Show FW commands
            if (sr.result?.commands) {
              for (const cmd of sr.result.commands) {
                const raw = cmd.raw || "";
                const label = raw.substring(0, 4);
                const cmdOk = cmd.result?.accepted !== false;
                const time = cmd.estimatedTimeMs ? ` <span style="color:var(--text-muted);font-size:8px;">${(cmd.estimatedTimeMs / 1000).toFixed(1)}s</span>` : "";
                html += `<div style="font-family:var(--font-mono);font-size:8px;color:var(--text-muted);padding:1px 0 1px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">`;
                html += `<span style="color:var(--accent-primary);font-weight:600;">${label}</span> `;
                html += `<span>${raw.substring(4)}</span>`;
                html += ` <span style="color:${cmdOk ? "#22c55e" : "#ef4444"};font-weight:600;">${cmdOk ? "OK" : "ERR"}</span>`;
                html += time;
                html += `</div>`;
              }
            }
            html += `</div>`;
            subsDiv.innerHTML += html;
          }
          // Show remaining sub-steps as pending
          if (step.subSteps && step.currentSub !== undefined && step.currentSub >= 0) {
            for (let si = step.subResults.length; si < step.subSteps.length; si++) {
              const isActive = step.currentSub === si;
              subsDiv.innerHTML += `<div style="font-size:9px;color:var(--text-muted);${isActive ? "color:var(--accent-primary);font-weight:600;" : ""}padding:1px 0;">${si + 1}. ${step.subSteps[si].label}${isActive ? " ..." : ""}</div>`;
            }
          }
          el.appendChild(subsDiv);
        } else if (step.result) {
          // Simple result (non-decomposed or single step)
          const res = document.createElement("div");
          res.className = `proto-step-result proto-step-result--${step.status}`;
          if (step.result.success) {
            const cmdCount = step.result.commands?.length || step.result.subStepCount || 0;
            const totalTime = step.result.totalEstimatedTimeMs;
            res.innerHTML = `<span class="proto-ok">OK</span> ${cmdCount} cmd${cmdCount !== 1 ? "s" : ""}`;
            if (totalTime) res.innerHTML += ` (${(totalTime / 1000).toFixed(1)}s est.)`;
            // Show FW commands
            if (step.result.commands) {
              for (const cmd of step.result.commands) {
                const raw = cmd.raw || "";
                const label = raw.substring(0, 4);
                const cmdOk = cmd.result?.accepted !== false;
                const time = cmd.estimatedTimeMs ? ` ${(cmd.estimatedTimeMs / 1000).toFixed(1)}s` : "";
                res.innerHTML += `<div style="font-family:var(--font-mono);font-size:8px;color:var(--text-muted);padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><span style="color:var(--accent-primary);font-weight:600;">${label}</span> ${raw.substring(4)} <span style="color:${cmdOk ? "#22c55e" : "#ef4444"};font-weight:600;">${cmdOk ? "OK" : "ERR"}</span><span style="font-size:7px;color:var(--text-muted);">${time}</span></div>`;
              }
            }
          } else {
            res.innerHTML = `<span class="proto-err">FAIL</span> ${step.result.error || "Unknown error"}`;
          }
          el.appendChild(res);
        }

        container.appendChild(el);
      }
    }
  }
}
