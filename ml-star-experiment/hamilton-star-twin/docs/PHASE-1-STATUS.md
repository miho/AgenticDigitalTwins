# Phase 1 Status — Physical State Intelligence Foundation

**Status:** ✅ **SUPERSEDED** by `docs/PHASE-1-REPORT.md` — Phase 1 is complete.
**Last updated:** 2026-04-16 (historical snapshot, kept for diff/audit)

This file was the live checkpoint while Phase 1 was in progress at 60%. It is
no longer the source of truth — see the **report** for what landed, test counts,
coverage results, and the verification gate outcome.

**Umbrella issue:** #42
**Plan:** see `hamilton-star-twin/docs/PHASE-PLAN.md`

## Commit history (most recent first)

| Commit | Scope |
|---|---|
| `5936662` | Phase 1 partial — serialization foundation + unresolved → assessment bridge (Steps 1.1-1.6, 1.8) |
| `ebd105b` | Phase 0 — test infrastructure overhaul (coverage, in-process twin, audit, failure injection) |
| `d76f1e4` | Baseline (before the Physical State Intelligence initiative) |

## Completed steps

Each step is verified by unit tests in `tests/unit/` (92 total, all passing):

### ✅ Step 1.1 — Unified labware catalog
- `src/twin/labware-catalog.ts` — `LabwareCatalogEntry` with rows, cols, wellPitch, height, full well geometry, and dead volume inline.
- `WELL_GEOMETRIES` (`src/twin/well-geometry.ts:378`) and `DEAD_VOLUMES` (`src/twin/liquid-tracker.ts:75`, removed) now route through the catalog.
- Tests: `tests/unit/labware-catalog.test.ts` (8 tests) — consistency parity with legacy tables, prefix-match fallback, default dead volume.

### ✅ Step 1.2 — TwinConfig / TwinState / TwinSession
- `src/twin/twin-config.ts` defines all three types with full JSON-safe Map↔Record helpers:
  - `TwinConfig` — static world (platform, carriers with inlined labware definitions, tip waste).
  - `TwinState` — dynamic state (modules, scheduledEvents, tracking, liquid, deck-dynamic, plugins).
  - `TwinSession` — save-file format (config + state + metadata).
  - Helpers: `serializeLiquidContents`, `serializeChannelState`, `mapToRecord`, `recordToMap`, `assertJsonRoundTrip`.
- Tests: `tests/unit/twin-config.test.ts` (11 tests).

### ✅ Step 1.3a — LiquidTracker serialization
- `LiquidTracker.getLiquidState()` / `restoreLiquidState(state)` in `src/twin/liquid-tracker.ts`.
- Preserves well contents, channel states, contamination log, labware types.
- Tests: `tests/unit/liquid-tracker-serialization.test.ts` (9 tests).

### ✅ Step 1.3b — DeckTracker serialization
- `DeckTracker.getTrackingState()` / `restoreTrackingState(state)` + `getDeckDynamicState()` / `restoreDeckDynamicState(state)` in `src/twin/deck-tracker.ts`.
- Interaction history is session-scoped (cleared on restore); tracking state is part of snapshots.
- Tests: `tests/unit/deck-tracker-serialization.test.ts` (10 tests).

### ✅ Step 1.3c — Deck config serialization
- `Deck.getConfig()` / `Deck.restoreFromConfig(config)` in `src/twin/deck.ts`.
- Self-contained: placed labware carries its full definition inline (no external catalog lookup needed at load time).
- Tests: `tests/unit/deck-config-serialization.test.ts` (10 tests).

### ✅ Step 1.4 — SCXML executor restore (the hardest piece)
- `ScxmlStateMachine.getConfiguration()` / `forceConfiguration(config)` in `src/state-machines/scxml-runtime.js`.
- Captures active states (Set → array), datamodel (deep-cloned via JSON), scheduled events (with remainingMs).
- Restore re-schedules delayed events with correct remaining delay so mid-operation snapshots produce correct timing.
- **Bypasses entry actions** by design: snapshots capture post-action state, re-running would double-apply.
- Tests: `tests/unit/scxml-restore.test.ts` (10 tests) — includes timing preservation and cross-instance determinism.

### ✅ Step 1.5 — Plugin serialization contract
- Optional `getPluginState?()` / `restorePluginState?(state)` on `PhysicsPlugin` in `src/twin/plugin-interface.ts`.
- Opt-in: plugins that derive all state from SCXML datamodel leave it off; those with accumulated internal state implement.

### ✅ Step 1.6 — Twin-level snapshot / restore / clone
- `DigitalTwin.snapshot()`, `DigitalTwin.restore(state)`, `DigitalTwin.getConfig()`, `DigitalTwin.loadConfig(config)`, `DigitalTwin.clone()` in `src/twin/digital-twin.ts`.
- Composes all per-component serializers. `clone()` produces fully independent twin instances.
- Tests: `tests/unit/twin-snapshot-restore.test.ts` (9 tests) — includes clone independence, mid-work state round-trip, liquid identity preservation.

### ✅ Step 1.8 — Unresolved → assessment bridge (#34)
- New `AssessmentCategory: "unresolved_position"` in `src/twin/assessment.ts`.
- `DigitalTwin.maybeEmitUnresolvedFromParams()` emits the event for positional commands where the target doesn't resolve (off-deck) OR resolves to the wrong labware type (aspirate from tip rack, tip pickup from sample plate).
- Fires BEFORE physics validation so it flows even for rejected commands.
- Severity: aspirate/tip-pickup at wrong target = error; dispense at off-deck = warning; movement-only = info.
- Tests: `tests/unit/unresolved-assessment.test.ts` (6 tests).

### Build fixes (side effects)
- `package.json::build:sm` now also copies `scxml-runtime.js` from src to dist.
- `scripts/convert-modules.js` now fixes the `./scxml-runtime.js` require path even on files already in CJS form (previously left broken paths baked into src files).

## Next steps — remaining Phase 1 work

### 🔜 Step 1.7 — Session save/load endpoints
**What:** Expose snapshot/restore/clone through REST + MCP.
**Where:**
- `src/main/main.ts` — add `POST /api/session/save` (returns `TwinSession`) and `POST /api/session/load` (accepts one).
- `src/twin/api.ts` — add `DigitalTwinAPI.saveSession(deviceId): TwinSession` and `loadSession(deviceId, session): void`. MCP tools go through these.
**Test:** integration test — save to JSON, reset twin, load, verify state restored.
**Est. effort:** 0.5 day.

### 🔜 Step 1.9 — Correlation IDs
**What:** Thread a `correlationId` counter through `DigitalTwin.sendCommand` so every emitted event (deck interaction, assessment, device event) carries the ID of the command that caused it. `StepExecutor.executeStep` adds a `stepId` for composite steps.
**Where:**
- `src/twin/digital-twin.ts` — add `private correlationCounter: number` and assign at top of `sendCommand`.
- `src/twin/assessment.ts::AssessmentEvent` — add optional `correlationId?: number`.
- `src/twin/deck-tracker.ts::DeckInteraction` — add optional `correlationId?: number`.
- `src/twin/device-events.ts::DeviceEvent` — add optional `correlationId?: number` (may be null for truly async events).
- `src/twin/venus-steps.ts::StepExecutor` — thread `stepId` through sub-commands.
**Test:** unit test — issue a command, verify every event in the assessment store for that command shares the correlationId.
**Est. effort:** 0.5 day.

### 🔜 Step 1.10 — Unified event spine
**What:** Create `EventSpine` — a single ordered append-only array that aggregates every twin event (commands, assessments, device events, deck interactions, step boundaries). Existing stores become consumers/projections.
**Where:** new file `src/twin/timeline.ts`:
```typescript
export interface TwinTimelineEvent {
  id: number;                     // global monotonically increasing
  timestamp: number;              // performance.now() at emit
  kind: "command" | "deck_interaction" | "assessment" | "device_event" | "step" | "completion";
  correlationId?: number;
  stepId?: number;
  severity?: "info" | "warning" | "error";
  payload: CommandResult | DeckInteraction | AssessmentEvent | DeviceEvent | StepResult;
}
export class EventSpine {
  add(event: TwinTimelineEvent): void;
  getByCorrelation(id: number): TwinTimelineEvent[];
  getByKind(kind: string): TwinTimelineEvent[];
  getBySeverity(sev: "info" | "warning" | "error"): TwinTimelineEvent[];
  getByWell(wellKey: string): TwinTimelineEvent[];
  getInRange(t0: number, t1: number): TwinTimelineEvent[];
  size(): number;
  getAll(): TwinTimelineEvent[];
}
```
- Wire into `DigitalTwin`: spine is owned by the twin; every existing emit site also pushes to spine.
**Test:** unit test — issue commands of different kinds, query spine by correlation / kind / severity / well.
**Est. effort:** 1 day.

### 🔜 Step 1.11 — Trace format
**What:** `TwinTrace` serialization format combining `TwinConfig` header, initial `TwinState`, timeline of events, periodic snapshots, final `TwinState`. Canonical JSON with stable key order.
**Where:** new file `src/twin/trace-format.ts`:
```typescript
export interface TwinTrace {
  format: "hamilton-twin-trace";
  version: 1;
  metadata: { deviceName, platform, startTime, endTime, commandCount, eventCount };
  config: TwinConfig;
  initialState: TwinState;
  timeline: TwinTimelineEvent[];
  snapshots: Array<{ afterEventId: number; state: TwinState }>;
  finalState: TwinState;
}
export function serializeTrace(trace: TwinTrace): string;
export function deserializeTrace(json: string): TwinTrace;
```
**Test:** round-trip a trace through JSON, verify deep equality; version mismatch rejection.
**Est. effort:** 0.5 day.

### 🔜 Step 1.12 — Trace recorder service
**What:** `TraceRecorder` class that attaches to the twin and buffers events + periodic snapshots.
**Where:** new dir `src/services/`, file `trace-recorder.ts`:
```typescript
export class TraceRecorder {
  constructor(twin: DigitalTwin, options?: { snapshotEveryNEvents?: number });
  start(): void;
  stop(): TwinTrace;
  getTrace(): TwinTrace;  // snapshot of current state while recording
  isRecording(): boolean;
}
```
- Subscribes to twin via `twin.onStateChange` and `twin.getAssessmentStore().onAssessment` (already exists).
- Takes a `twin.snapshot()` every N events (default 50) and appends to the trace.
**Test:** record a 100-command protocol, verify trace contains all commands, all assessments, at least 2 snapshots.
**Est. effort:** 1 day.

### 🔜 Phase 1 verification gate
1. Coverage on `src/twin/**` ≥ 55% (was 28% at Phase 0 baseline).
2. All unit tests pass (target: 120+ tests).
3. All existing integration tests pass (200 tests baseline).
4. Round-trip integrity holds for: idle twin, mid-aspirate with scheduled events, with liquid tracking, with contamination.
5. No regressions in previous phases.

### Phase 1 exit criteria
- `npm run test:coverage` reports line coverage ≥ 55% for `dist/twin/**`.
- A recorded trace can be serialized to JSON, parsed back, and produces byte-identical re-serialization.
- The full integration test suite passes file-by-file.

## How to resume in a fresh session

```
# 1. From the repo root
cd hamilton-star-twin/

# 2. Read the plan and status
cat docs/PHASE-PLAN.md
cat docs/PHASE-1-STATUS.md

# 3. Verify current state
npm run test:unit         # expect 92 pass in <2s

# 4. Pick a step from "Next steps" and implement.
#    Every new feature:
#    - unit test in tests/unit/
#    - follows tests/TESTING-GUIDE.md
#    - FAILURE INJECTION comment
#    - coverage contribution
```

## File index — everything Phase 1 touches

**Modified (Phase 1):**
- `src/twin/assessment.ts` — `unresolved_position` category
- `src/twin/deck-tracker.ts` — tracking + deck-dynamic serialization
- `src/twin/deck.ts` — getConfig / restoreFromConfig
- `src/twin/digital-twin.ts` — snapshot / restore / clone / unresolved assessment
- `src/twin/liquid-tracker.ts` — liquid-state serialization (also dead-volumes now via catalog)
- `src/twin/plugin-interface.ts` — optional plugin state methods
- `src/twin/well-geometry.ts` — catalog-first lookup
- `src/state-machines/scxml-runtime.js` — getConfiguration / forceConfiguration
- `package.json` — build:sm now copies runtime too
- `scripts/convert-modules.js` — fixes runtime require path on already-CJS files

**New (Phase 1):**
- `src/twin/labware-catalog.ts`
- `src/twin/twin-config.ts`
- `tests/unit/labware-catalog.test.ts`
- `tests/unit/twin-config.test.ts`
- `tests/unit/liquid-tracker-serialization.test.ts`
- `tests/unit/deck-tracker-serialization.test.ts`
- `tests/unit/deck-config-serialization.test.ts`
- `tests/unit/scxml-restore.test.ts`
- `tests/unit/twin-snapshot-restore.test.ts`
- `tests/unit/unresolved-assessment.test.ts`

**Still to create (Step 1.9-1.12):**
- `src/twin/timeline.ts` — EventSpine
- `src/twin/trace-format.ts` — TwinTrace
- `src/services/trace-recorder.ts` — TraceRecorder
- `tests/unit/timeline.test.ts`
- `tests/unit/trace-format.test.ts`
- `tests/unit/trace-recorder.test.ts`
- `tests/integration/session-save-load.test.ts` — for Step 1.7
