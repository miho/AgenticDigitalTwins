# Hamilton Microlab STAR Digital Twin — Architecture

**Version:** 0.4.0 | **Date:** 2026-04-14

## 1. Purpose

A firmware-level digital twin of the Hamilton Microlab STAR liquid handling robot. It simulates the behavioral contract of every hardware module — what commands are legal in which states, what observable state changes result, and what errors are produced on violations. Physics plugins extend this with timing, sensor simulation, and correction curves.

The twin serves three audiences:
- **Humans** — SCXML state machines are visual and inspectable
- **Coding agents** — JSON spec + SCXML + TypeScript are all machine-readable
- **Physical instrument** — traces recorded on the twin can be compared against real hardware

---

## 2. Layered Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Electron UI                        │
│  Module state cards, command input, variable          │
│  inspector, event log                                 │
│  (src/renderer/)                                      │
├──────────────────────────────────────────────────────┤
│                   IPC Bridge                          │
│  main.ts — Electron main process                     │
│  Forwards commands/state between UI and Twin          │
├──────────────────────────────────────────────────────┤
│                 Digital Twin Core                     │
│  digital-twin.ts — top-level API                     │
│  ┌────────────────────────────────────────────┐      │
│  │           Command Router                    │      │
│  │  Parses FW commands, dispatches to the      │      │
│  │  correct module executor by event code      │      │
│  │  (fw-protocol.ts, module-registry.ts)       │      │
│  └──────┬──────┬──────┬──────┬──────┬─────────┘      │
│         │      │      │      │      │                 │
│  ┌──────┴──┐ ┌─┴────┐ │  ┌──┴───┐ ┌┴─────┐          │
│  │Executor │ │Exec. │ │  │Exec. │ │Exec. │  ...      │
│  │ Master  │ │ PIP  │ │  │iSWAP │ │Wash  │          │
│  ├─────────┤ ├──────┤ │  ├──────┤ ├──────┤          │
│  │ SCXML   │ │SCXML │ │  │SCXML │ │SCXML │          │
│  │  SM     │ │ SM   │ │  │ SM   │ │ SM   │          │
│  ├─────────┤ ├──────┤ │  ├──────┤ ├──────┤          │
│  │ Physics │ │Phys. │ │  │Phys. │ │Phys. │          │
│  │ Plugin  │ │Plugin│ │  │Plugin│ │Plugin│          │
│  └─────────┘ └──────┘ │  └──────┘ └──────┘          │
│                        │                              │
├────────────────────────┼──────────────────────────────┤
│              JSON Specification                       │
│  hamilton-star-digital-twin.json                      │
│  (command parameters, ranges, units, error codes,     │
│   deck layout, liquid classes, VENUS step mappings)   │
└──────────────────────────────────────────────────────┘
```

---

## 3. Core Concepts

### 3.1 Module

A hardware component of the STAR instrument (PIP channels, CoRe 96 Head, iSWAP, etc.). Each module is self-contained:

| Property | Description |
|---|---|
| **SCXML file** | `scxml/<module>.scxml` — behavioral state machine |
| **Generated JS** | `dist/state-machines/modules/<module>-s-m.js` — code-generated from SCXML |
| **Executor** | `ContinuousExecutor` wrapping the SM — handles event queue and run-to-completion |
| **Physics Plugin** | TypeScript class attached to the executor — adds simulation fidelity |
| **Event list** | FW command codes this module handles (e.g. `C0AS`, `C0TP` for PIP) |

### 3.2 Executor

Each module's SCXML state machine is wrapped in a `ContinuousExecutor` from the SCXML runtime. The executor provides:

- **Event queue** — commands are queued and processed in order
- **Run-to-completion** — a macrostep finishes entirely before the next event is processed
- **Delayed events** — `<send delay="...">` in SCXML for timed operations (wash cycles, heating ramps, move completion)
- **Trace listeners** — hook points for physics plugins and the UI

**Never call `sm.send()` directly.** Always go through the executor.

### 3.3 Command Router

The `module-registry.ts` defines which FW event codes map to which module. When a command like `C0ASid0001tm1av1000` arrives:

1. `fw-protocol.ts` parses it into `{module: "C0", code: "AS", event: "C0AS", params: {tm: 1, av: 1000}}`
2. The router looks up `"C0AS"` in the event map → finds the PIP module
3. The PIP executor receives `send("C0AS", {tm: 1, av: 1000})`
4. The SCXML state machine evaluates guards, fires transitions, updates data
5. The physics plugin reacts via trace listener hooks
6. The result (new states, variables, logs, errors) is returned

### 3.4 SCXML-vs-Plugin Split

This is the most important architectural decision. The boundary is:

**SCXML owns behavioral truth:**
- What states exist and when transitions are legal
- Observable data variables (positions, volumes, tip states, temperatures)
- Guard conditions that encode physical constraints (axis limits, traverse height, tip presence)
- Error states with FW error codes
- Timing skeletons (`<send delay>` for async completion)

**Plugins own simulation fidelity:**
- Correction curves (volume nominal → actual)
- Sensor signal generation (TADM pressure, cLLD capacitance)
- Stochastic behavior (random failures, read errors)
- Complex geometry (collision mesh calculation)
- The plugin CALCULATES values, the SCXML USES them

**The rule:** If a human or agent needs to understand WHY a command was accepted/rejected, that logic must be in the SCXML. If it's about HOW physics works internally, it goes in the plugin.

### 3.5 Physics Plugin Interface

```typescript
interface PhysicsPlugin {
  /** Called when the module's executor is created */
  onAttach(executor: ContinuousExecutor, moduleId: string): void;

  /** Called before an event is processed — can modify event data */
  onBeforeEvent?(event: string, data: Record<string, unknown>): Record<string, unknown>;

  /** Called after a transition completes — can send follow-up events */
  onAfterTransition?(source: string, target: string, event: string): void;

  /** Called on state entry — can trigger timed events */
  onStateEnter?(stateId: string, activeStates: string[]): void;

  /** Called to calculate delay for <send delay> expressions */
  calculateDelay?(operation: string, params: Record<string, unknown>): number;
}
```

Plugins attach as trace listeners on the executor. The Proxy-based listener pattern ensures forward compatibility with any trace methods the generated code may call.

---

## 4. Data Flow

### 4.1 Command Execution

```
User/Agent
  │  "C0ASid0001tm1av1000lm1"
  ▼
fw-protocol.ts  →  parse  →  {event: "C0AS", params: {tm:1, av:1000, lm:1}}
  │
  ▼
module-registry  →  lookup "C0AS"  →  PIP module
  │
  ▼
Plugin.onBeforeEvent  →  may adjust params (e.g. apply liquid class corrections)
  │
  ▼
executor.send("C0AS", params)
  │
  ▼
SCXML evaluates:
  ├─ Guard: tip_fitted? volume within tip capacity?
  ├─ YES → transition tip_empty → tip_loaded
  │        actions: assign volume[], assign position, log
  │        <send delay="200ms" event="aspirate.done"/>
  ├─ NO  → no transition (event dropped)
  │        router detects "not accepted" → infer error code
  ▼
Plugin.onAfterTransition  →  generate TADM curve, calculate LLD result
  │                           may send("lld.detected", {height: 1234})
  │                           may send("tadm.error", {code: 20})
  ▼
Return CommandResult {
  response: "C0ASid0001er00/00",
  activeStates: {pip: ["operational","idle","tip_fitted","tip_loaded"]},
  variables: {pip: {volume: [1000,0,0,...], pos_x: 5000, ...}},
  logs: ["[pip] FW: Aspirate vol=1000 (0.1ul)"],
  accepted: true,
  errorCode: 0
}
```

### 4.2 Async Operations

Some operations take time (movement, washing, heating). The SCXML models this with delayed events:

```xml
<!-- In the SCXML: entering "moving" state sends a delayed completion event -->
<state id="moving">
  <onentry>
    <send event="move.done" delay="_event.data._delay || '500ms'"/>
  </onentry>
  <transition event="move.done" target="idle"/>
</state>
```

The physics plugin calculates the delay:
```typescript
calculateDelay("move", {distance: 5000, speed: 10000}) → 250  // ms
```

The router injects this as `_delay` in the event data before sending to the executor.

---

## 5. File Structure

```
Hamilton-STAR 2026/
├── ARCHITECTURE.md                          ← This document
├── hamilton-star-digital-twin.json          ← Authoritative data spec (1.36 MB)
├── hamilton-star-digital-twin.md            ← Human-readable overview
│
├── scxml/                                   ← SCXML behavioral models
│   ├── master.scxml                         ← System init, cover, lights, arms
│   ├── pip_channel.scxml                    ← PIP channels (1000uL)
│   ├── core96_head.scxml                    ← CoRe 96 Multi-Probe Head
│   ├── iswap.scxml                          ← iSWAP plate transport
│   ├── autoload.scxml                       ← Carrier loading
│   ├── wash_station.scxml                   ← Needle/tip washing
│   ├── temperature.scxml                    ← Temperature controlled carrier
│   └── system_orchestrator.scxml            ← (legacy) parallel composition
│
├── hamilton-star-twin/                      ← Electron + TypeScript application
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main/
│   │   │   └── main.ts                      ← Electron main process + IPC
│   │   ├── renderer/
│   │   │   ├── index.html                   ← UI layout
│   │   │   ├── style.css                    ← UI styling
│   │   │   └── renderer.ts                  ← UI logic
│   │   └── twin/
│   │       ├── digital-twin.ts              ← Top-level twin API
│   │       ├── module-registry.ts           ← Module creation + event routing
│   │       ├── fw-protocol.ts               ← FW command parser/formatter
│   │       ├── command-interpreter.ts        ← (legacy, to be removed)
│   │       └── hamilton-star-digital-twin.json  ← Copy of spec
│   └── dist/
│       ├── state-machines/
│       │   ├── scxml-runtime.js             ← SCXML runtime (CJS converted)
│       │   └── modules/                     ← Generated SM code per module
│       │       ├── master-s-m.js
│       │       ├── pip-channel-s-m.js
│       │       ├── co-re96-head-s-m.js
│       │       ├── i-swap-s-m.js
│       │       ├── auto-load-s-m.js
│       │       ├── wash-station-s-m.js
│       │       └── temperature-s-m.js
│       ├── main/                            ← Compiled TS
│       ├── renderer/                        ← Compiled TS + static assets
│       └── twin/                            ← Compiled TS + JSON spec
│
├── Command sets (13.04.2026)/               ← Source FW documentation
│   ├── *.doc / *.docx / *.pdf              ← 36 FW command documents
│   ├── hamilton_command_specs_extracted.json ← Extracted: 3,569 commands
│   └── extracted_text/                      ← Plain text of .doc files
│
├── VENUS-2026-04-13/                        ← VENUS source code reference
│   └── Star/src/
│       ├── HxAtsInstrument/Code/            ← FW command C++ classes (846 files)
│       ├── HxGruCommand/code/               ← VENUS step execution (Run*.cpp)
│       └── HxGruCommand/Config/ML_STAR.cfg  ← Instrument config (76K lines)
│
└── *.pdf                                    ← Operator's + Programmer's manuals
```

---

## 6. SCXML Design Guidelines

### 6.1 Data Variables

Each module SCXML should declare these categories of variables:

```xml
<datamodel>
  <!-- OBSERVABLE STATE — what the module "is" right now -->
  <data id="pos_x" expr="0"/>           <!-- Axis positions -->
  <data id="volume" expr="[0,0,...]"/>  <!-- Per-channel volumes -->
  <data id="tip_fitted" expr="[false,false,...]"/>

  <!-- INSTRUMENT CONFIGURATION — physical limits, set once -->
  <data id="x_min" expr="0"/>
  <data id="x_max" expr="30000"/>
  <data id="z_traverse" expr="1450"/>

  <!-- ERROR STATE -->
  <data id="last_error" expr="0"/>
</datamodel>
```

### 6.2 Guard Conventions

Guards should encode ONE physical constraint each, with a clear name:

```xml
<!-- GOOD: one constraint per guard, readable -->
<transition event="C0AS" target="tip_loaded"
  cond="tip_fitted.some(function(t){return t;})">
  <!-- At least one channel has a tip -->
</transition>

<!-- GOOD: separate error transition for the violation -->
<transition event="C0AS" target="error">
  <!-- No tip → error 08 -->
  <assign location="last_error" expr="8"/>
</transition>
```

Transitions for the same event are evaluated in document order. Put the happy path first, error cases last. For dispense modes, put specific modes (dm==4, dm==2||3) before the default.

### 6.3 Timing

Use `<send delay>` for operations that take time in reality:

```xml
<state id="moving">
  <onentry>
    <!-- The delay is calculated by the physics plugin and injected as _delay -->
    <send event="move.done" delay="_event.data._delay || '500ms'"/>
  </onentry>
  <transition event="move.done" target="idle"/>
</state>
```

If no physics plugin is attached, the default delay (500ms) provides basic timing.

### 6.4 Error Transitions

Every module should handle illegal commands explicitly. The SCXML should transition to an error state with the correct FW error code:

```xml
<!-- In no_tip state: aspirate is illegal → error 08 -->
<transition event="C0AS" target="error">
  <assign location="last_error" expr="8"/>
  <log label="ERROR" expr="'No tip fitted (error 08)'"/>
</transition>
```

Error recovery is always via the module's init command (C0DI for PIP, C0EI for 96Head, etc.).

### 6.5 No Visual Styling

Do not set state colors or styling in SCXML files. The VSCXML editor applies its own theming. Only use `editor_highlight` for temporary debugging emphasis.

---

## 7. Extending the Twin

### 7.1 Adding a New Module

1. **Create SCXML:** `scxml/new_module.scxml`
   - Define states, transitions, data variables following Section 6 guidelines
   - Test in VSCXML simulator with `scxml_sim_scenario`
   
2. **Generate JS:** Use VSCXML `scxml_generate` tool → `dist/state-machines/modules/`
   - Convert to CJS (automated in build script)

3. **Register module:** Add entry to `module-registry.ts`
   - Class import, event list, module ID and name

4. **Add physics plugin** (optional): Implement `PhysicsPlugin` interface
   - Attach to executor in `digital-twin.ts`

5. **Add UI card:** Add `<div class="module-card">` in `index.html`

### 7.2 Adding a Physics Plugin

```typescript
// src/twin/plugins/pip-physics.ts
import { PhysicsPlugin } from "../plugin-interface";

export class PipPhysicsPlugin implements PhysicsPlugin {
  onAttach(executor, moduleId) {
    // Store reference
  }

  calculateDelay(operation, params) {
    if (operation === "move") {
      const distance = Math.abs(params.target_x - params.current_x);
      const speed = params.speed || 10000; // 0.1mm/s
      return Math.round((distance / speed) * 1000); // ms
    }
    return 500; // default
  }

  onAfterTransition(source, target, event) {
    if (event === "C0AS") {
      // Generate simulated TADM pressure curve
      // Send "tadm.ok" or "tadm.error" to the executor
    }
  }
}
```

### 7.3 Adding Error Coverage

To add a new error condition:

1. Add the guard to the SCXML (the behavioral constraint)
2. Add the error transition with the correct FW error code
3. Add the error code description to the JSON spec's `error_codes` section
4. Test via `scxml_sim_scenario` — send the illegal command, verify error state

### 7.4 CAD Model Integration (Future)

When a CAD model becomes available:

1. **Geometry layer** reads position variables from SCXML data
2. **Collision detection** uses geometry — results feed back as events to SCXML
3. **Visualization** renders the CAD model with positions from the twin
4. The SCXML and plugins don't change — the geometry layer is additive

---

## 8. Build and Run

```bash
cd hamilton-star-twin

# Install dependencies
npm install

# Build TypeScript
npx tsc

# Copy static assets
cp src/renderer/index.html dist/renderer/
cp src/renderer/style.css dist/renderer/

# Launch
npx electron dist/main/main.js
```

To regenerate SCXML state machines after editing `.scxml` files, use the VSCXML tools:
```
scxml_generate(source="file", file="scxml/pip_channel.scxml", target="javascript",
               outputDir="hamilton-star-twin/dist/state-machines/modules",
               options={className: "PipChannelSM", codeOnly: true})
```
Then convert ES modules to CJS (automated in build).

---

## 9. Testing

### SCXML-level testing (via VSCXML simulator)
- `scxml_sim_scenario` — run event sequences, verify state transitions
- `scxml_sim_fuzz` — random event injection, find unexpected paths
- `scxml_sim_explore` — exhaustive reachability analysis
- `scxml_trace_embed` — record reference traces for regression
- `scxml_compare_traces` — compare simulator vs generated code

### Application-level testing
- Unit tests for `fw-protocol.ts` (parse/format round-trip)
- Integration tests: send command sequences through the full twin, verify results
- UI testing: Playwright (available via MCP) for Electron UI verification

### Hardware validation (future)
- Record traces from real instrument
- Replay against digital twin
- `scxml_compare_traces` to identify behavioral divergences
- Update SCXML guards and plugin parameters to match reality

---

## 10. Key Design Decisions

| Decision | Rationale |
|---|---|
| One executor per module (not one big SM) | Each module is independently testable, replaceable, and extendable |
| SCXML for behavior, not physics | SCXML is the shared language between humans, agents, and code. Physics is implementation detail. |
| ContinuousExecutor (not RunToCompletion) | Supports delayed events for async operations |
| Proxy-based trace listeners | Future-proofs against new trace methods in generated code |
| JSON spec as authoritative data source | Parameters, ranges, units stay in one place. SCXML references but doesn't duplicate. |
| CJS conversion of generated code | Electron main process requires CJS. Will migrate to full ESM when Electron support matures. |
| FW command strings as the API | The twin speaks the same protocol as the real instrument. No abstraction layer to maintain. |
