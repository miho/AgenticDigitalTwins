# Physical State Intelligence & VENUS Integration — Master Implementation Plan

## Context

The Hamilton STAR digital twin has reached feature maturity on the execution side (216 FW commands, 10 SCXML modules, physics plugins, VENUS step layer, basic FW-command replay). But the observation, analysis, and integration layers that transform it from a simulator into a **Physical State Intelligence platform** are missing or fragmented. This plan addresses 11 open GitHub issues under the umbrella #42, delivering:

- **Self-contained trace recording** (every FW command, every state transition, every assessment, periodic state snapshots) in a portable JSON format.
- **State replay** — navigate recorded traces without re-executing commands. Time-travel to any event via O(1) snapshot restore.
- **What-if branching** — fork from any trace point, simulate alternative commands, diff against the original.
- **Polished visual analysis UX** — spatial event annotation on the deck, well-level drill-down, timeline scrubber, MCP-accessible tools.
- **VENUS protocol bridge** — make the twin appear as a real Hamilton STAR to VENUS via FDx-over-TCP, enabling real methods to run against the twin.

## User decisions (locked in)

| Decision | Choice | Implication for plan |
|---|---|---|
| Primary outcome | **Both balanced** — replay UX mid-project, VENUS bridge after | No "enabler-only" phase; replay UX is shipped usable at Phase 3 end |
| Execution mode | **Serial with deep review** — main assistant drives, Explore agents for research only | Single-threaded implementation, every diff reviewed, no parallel streams |
| Twin architecture | **Dual-mode** (Electron + headless) — programmatic API for in-process tests | Phase 2 includes headless extraction |
| Test hardening | **Full overhaul** — audit every existing test, strengthen, add failure-injection | Phase 0 expanded: ~5 days |

## Issues in scope

| # | Title |
|---|-------|
| #42 | Physical State Intelligence (umbrella, tracking) |
| #43 | Twin state serialization — snapshot/restore/clone, save/load |
| #33 | Trace format & event spine — self-contained recording |
| #34 | Bridge unresolved interactions into assessment system |
| #44 | Service architecture — twin core / recorder / replay / MCP |
| #38 | Replay & analysis service — state replay, what-if, MCP-accessible |
| #36 | Event lifecycle — expected/flagged/suppressed/resolved |
| #37 | Spatial event annotation — deck SVG overlay |
| #41 | Well inspector — click-through to full history |
| #40 | Report generation — summaries, CSVs, diffs |
| #35 | Collision detection — arm paths, Z-safety, head-to-head |
| #39 | Advanced physics observations — foam, clot, meniscus, air gaps |
| #45 | VENUS protocol bridge — FDx-over-TCP to make twin appear as real STAR |

## Findings from exploration (summary)

**Twin core** (17 files, ~12k lines in `src/twin/`) is well-organized. Each component has clear responsibility. Plugin state is mostly derived from SCXML datamodel (good for serialization).

**SCXML runtime** (`src/state-machines/scxml-runtime.js`, 3579 lines) uses `activeStates: Set<string>` and `_datamodel: Object` — directly accessible but no public setter. A `forceConfiguration(states, datamodel, scheduledEvents)` method can be added by assigning these fields directly; bypasses entry actions but that's correct since snapshots capture post-action state.

**Hard-coded tables** need to move into config for self-contained traces:
- `WELL_GEOMETRIES` (well-geometry.ts:378)
- `DEAD_VOLUMES` (liquid-tracker.ts:75)

**main.ts monolith** (506 lines) handles everything. Needs to split into `api/`, `services/`, thin `main/`.

**Test concerns**:
- Integration-only tests requiring running Electron server at port 8222.
- Magic 2000ms wait after init (`helpers.ts:87`).
- Many tests check only `accepted: true` without verifying physical outcomes.
- No coverage tool configured.
- No unit tests for twin core.
- Shared server state across tests.

**Replay today** (`/replay/*` in main.ts) is **re-simulation** (re-executes FW commands), not state replay. Confirmed by reading lines 213-298.

**SCXML module mismatch**: 10 modules in `dist/state-machines/modules/`, only 4 in `src/state-machines/modules/`. Build process handles this via `scripts/convert-modules.js` but sources should be aligned later.

## Phase structure

Six sequential phases, serial execution per user's preference. Each phase ends with a hard verification gate.

---

### Phase 0 — Test Infrastructure Overhaul (prerequisite)

**Goal**: Fix test quality before touching anything else. Every subsequent phase depends on trustworthy tests.

**Deliverables**:

0.1 **Coverage tooling**
- Add `@vitest/coverage-v8` to devDependencies.
- Configure `vitest.config.ts` with:
  - `coverage.enabled: true`
  - `coverage.provider: 'v8'`
  - `coverage.include: ['src/twin/**', 'src/services/**', 'src/api/**']`
  - Initial threshold: 40% lines (baseline — many untested branches today)
  - Post-Phase-3 threshold: 70% lines
- Add `npm run test:coverage` script.

0.2 **Test tree restructure**
- Create `tests/unit/` for pure-function tests (no server, in-process twin).
- Keep `tests/integration/` for HTTP-based flows.
- Create `tests/contract/` for API/MCP contract tests with golden response snapshots.
- Create `tests/e2e/` for Playwright browser tests (already exists).

0.3 **Programmatic twin API for tests**
- Expose `createTestTwin(): DigitalTwinAPI` helper in `tests/helpers/in-process.ts`.
- Unit tests use this, not `fetch('http://localhost:8222')`.
- Remove dependency on port 8222 for unit tests.

0.4 **Fix magic waits**
- Replace `helpers.ts:87` hardcoded 2000ms with `waitForModuleState('master', 'sys_ready', 30000)`.
- Add `waitForModuleState()` helper that polls module state with timeout.

0.5 **Assertion hygiene guide**
- Write `tests/TESTING-GUIDE.md` documenting:
  - **Banned patterns**: `expect(x).toBeDefined()` without value check, testing only `accepted: true` without physical outcome, checking error code without checking rejection happened.
  - **Required patterns**: "capture before, capture after, verify difference" — e.g., volume before aspirate, volume after, verify delta matches the request.
  - **Failure-injection**: every test must demonstrably fail against a known-broken implementation (document one example per test file).

0.6 **Audit existing integration tests**
- Review every test in `tests/integration/*.test.ts`.
- Produce `tests/AUDIT-2026-04.md` with per-test rating (strong/weak/broken) and remediation note.
- Strengthen weak assertions. Estimated ~30% of tests need updates.

0.7 **Failure-injection baseline**
- Add `tests/unit/failure-injection.test.ts` with 5+ tests that deliberately break a small piece of the twin, run an integration test, verify it fails. This proves tests can catch regressions.

0.8 **CI script**
- `npm run test:ci` runs unit → contract → integration in order.
- Fails if coverage below threshold.
- Document how to run locally.

**Verification gate**:
- Coverage report shows baseline numbers for every file in `src/twin/`.
- `tests/AUDIT-2026-04.md` exists with every test reviewed.
- At least 5 failure-injection tests demonstrably catch breakages.
- `npm run test:ci` passes cleanly.
- No integration test uses a hardcoded `setTimeout` wait longer than 500ms without justification.

**Estimated effort**: 4-5 days.

---

### Phase 1 — Foundation: Serialization, Event Spine, Unresolved Bridge

**Goal**: Twin can be snapshotted, restored, cloned. Events flow through a correlated spine. Unresolved interactions are first-class assessments.

Serial execution. Not parallelized per user's preference.

#### Step 1.1 — Labware catalog unification (#43 prerequisite)

- Create `src/twin/labware-catalog.ts` containing `LabwareDefinition[]` with BOTH dimensions AND well geometry inline.
- Migrate `WELL_GEOMETRIES` entries (well-geometry.ts:378-449) into these definitions.
- Migrate `DEAD_VOLUMES` (liquid-tracker.ts:75-85) into the definitions.
- Keep `getWellGeometry(labwareType)` as a lookup, now resolving via catalog.
- **Tests**: unit test verifying every existing labware type resolves correctly with the old + new lookup returning the same result.

#### Step 1.2 — Config/state types (#43)

- Create `src/twin/twin-config.ts` with:
  - `TwinConfig` — platform, carriers (with inline labware definitions), liquid classes, tip waste config.
  - `TwinState` — modules (active states + datamodel), tracking, liquid, deck dynamic, plugin states, scheduled events.
  - `TwinSnapshot = TwinState` (state-only for replay/fork).
  - `TwinSession = { config, state, metadata }` (config+state for save/load).
- **Tests**: round-trip serialization tests using fast-check or manual cases.

#### Step 1.3 — Per-component serialization (#43)

In order of difficulty (easy first, SCXML last):

- `LiquidTracker.getLiquidState()`, `.restoreLiquidState(state)`, `.clear()`. Convert `Map`s to `Record`s for JSON.
- `DeckTracker.getTrackingState()`, `.restoreTrackingState(state)`.
- `Deck.getConfig()`, `.restoreFromConfig(config)`. Must handle platform + all carriers + labware with geometry.
- `AssessmentStore.getStoreState()`, `.restoreStoreState(state)` (just event counter and events up to snapshot point).

**Tests per component**: capture state, mutate twin, restore, verify exact match. Use golden comparison.

#### Step 1.4 — SCXML executor restore (#43, highest risk)

- Extend `ScxmlStateMachine` class in `scxml-runtime.js`:
  - `getConfiguration()` returns `{activeStates: string[], datamodel: object, scheduledEvents: Array<{id, time, eventName, eventData, remainingMs}>}`.
  - `forceConfiguration(config)` assigns activeStates (new Set), datamodel (replace), re-schedules events with remaining delays.
- `ContinuousExecutor` proxies these methods.
- **Critical test**: record 50 commands → snapshot → 50 more commands → restore → verify module state exactly matches snapshot.
- **Critical test**: mid-operation snapshot (e.g., during async move.done delay) → restore → verify scheduled event still fires at correct time.
- Document the "bypass entry actions" caveat in code comments.

#### Step 1.5 — Plugin serialization contract (#43)

- Add optional `getPluginState?()` and `restorePluginState?(state)` to `PhysicsPlugin` interface.
- Survey existing plugins (pip, h96, h384, iswap, temperature, hhs, wash): most are stateless or derive from SCXML. Only plugins with accumulated state implement these. Expect zero non-trivial implementations in Phase 1.
- **Test**: verify plugin state survives snapshot/restore even if empty.

#### Step 1.6 — Twin-level composition (#43)

- `DigitalTwin.snapshot(): TwinState` — calls every component's getter.
- `DigitalTwin.restore(state: TwinState)` — calls every component's setter.
- `DigitalTwin.getConfig(): TwinConfig`.
- `DigitalTwin.loadConfig(config: TwinConfig)` — replaces deck, resets trackers, re-initializes.
- `DigitalTwin.clone(): DigitalTwin` — new instance with same config + current state.
- **Integration test**: full snapshot → 100 commands → restore → verify state identical.
- **Integration test**: clone → commands on clone only → verify original unchanged.

#### Step 1.7 — Session save/load (#43)

- `POST /api/session/save` → returns `TwinSession` JSON.
- `POST /api/session/load` → accepts `TwinSession`, replaces twin.
- **Integration test**: save → reset → load → verify state restored.

#### Step 1.8 — Unresolved → assessment bridge (#34)

- In `DeckTracker.processCommand()` after classifying unresolved (lines 395-418), emit an `AssessmentEvent` with category `"unresolved_position"`.
- Severity rules: aspirate at no deck object = error; dispense at no deck object = warning; aspirate/dispense at tip rack = error; tip pickup from non-tip-rack = error.
- Extend `AssessmentCategory` union in `assessment.ts`.
- **Test**: aspirate at (0,0) produces an assessment event visible via `/assessment?category=unresolved_position`.

#### Step 1.9 — Correlation IDs (#33 prerequisite)

- Add `correlationId` counter to `DigitalTwin`.
- In `sendCommand()`, assign `correlationId` at start.
- Thread through to every emitted event (deck interaction, assessment, completion).
- `StepExecutor.executeStep()` assigns `stepId` too.

#### Step 1.10 — Event spine (#33)

- Create `src/twin/timeline.ts`:
  - `TwinTimelineEvent` type with discriminated union on `kind`.
  - `EventSpine` class with append-only array, query methods.
- Existing stores (AssessmentStore, DeviceEventEmitter, DeckTracker.interactions) push to spine as well.
- **Test**: every FW command produces a command event on the spine with correct correlationId; assessments link back via correlationId.

#### Step 1.11 — Trace format (#33)

- Create `src/twin/trace-format.ts`:
  - `TwinTrace` type: `{format, version, metadata, config, initialState, timeline, snapshots, finalState}`.
  - Serializer that produces canonical JSON (sorted keys, stable formatting).
  - Deserializer with version check.
- **Test**: round-trip a trace through JSON, verify deep equality.

#### Step 1.12 — Trace recorder (first service)

- Create `src/services/trace-recorder.ts`:
  - `TraceRecorder` class that attaches to twin's event listeners.
  - Buffers events into timeline, takes periodic snapshots (default every 50 events).
  - `start()`, `stop() → TwinTrace`, `getTrace()`.
- **Test**: record a 100-command protocol, verify trace contains all commands, all assessments, at least 2 snapshots.

**Verification gate**:
- Coverage on twin core ≥ 55% (up from Phase 0 baseline).
- Round-trip snapshot/restore tests pass for states that include: fresh-init, mid-aspirate with scheduled events, with liquid tracking, with contamination.
- Trace recorder produces parseable traces.
- Unresolved aspirate produces assessment event.
- No existing integration test regressions.

**Estimated effort**: 10-14 days.

---

### Phase 2 — Service Architecture & Dual-Mode

**Goal**: Clean separation of twin core, services, API layer. Twin runs headless OR in Electron. Tests use programmatic API.

#### Step 2.1 — Extract REST API

- Create `src/api/rest-api.ts` that takes `DigitalTwinAPI` and `services` as constructor args.
- Move ALL routes from `main.ts` to `rest-api.ts`.
- New endpoint namespaces: `/api/twin/*`, `/api/session/*`, `/api/trace/*`. Keep legacy `/command`, `/state`, `/tracking`, `/history`, `/assessment` as aliases.
- Preserve exact response shapes (verified by contract tests).

#### Step 2.2 — Extract SSE broker

- Create `src/api/sse-broker.ts` encapsulating client set + `broadcast()`.
- Everywhere in services that currently does inline SSE, use the broker.

#### Step 2.3 — Extract replay logic

- Move existing `/replay/*` handlers from `main.ts` to `src/services/replay-service.ts`.
- Current implementation is re-simulation; preserve as-is for now. Phase 3 replaces with state replay.

#### Step 2.4 — Dual-mode entry points

- Create `src/headless/server.ts` — pure Node entry point that creates twin, services, HTTP server. No Electron dependency.
- Refactor `src/main/main.ts` — thin: parse args, start HTTP server via same code path, open Electron window. Target <100 lines.
- Add `npm run server` script → `node dist/headless/server.js`.
- Add `npm run dev:server` → watch mode.
- Keep `npm run start` / `npm run dev` for Electron.

#### Step 2.5 — Programmatic API for tests

- `tests/helpers/in-process.ts` exports:
  - `createTestTwin(options?): { twin, services, api }` — fully in-process, no HTTP.
  - `createTestServer(options?): { port, baseUrl, close() }` — spawns server on random port for tests that must use HTTP.
- Migrate unit tests to use in-process twin.
- Integration tests use test server (random port), not hardcoded 8222.

#### Step 2.6 — Contract tests

- Create `tests/contract/api-contract.test.ts` — every endpoint called with representative payload; response shape captured as golden file.
- Ensures future refactors don't break API contracts.

**Verification gate**:
- `main.ts` under 100 lines.
- `npm run server` starts headless twin on any port.
- `npm run start` launches Electron identically to before.
- All existing integration tests pass against new architecture.
- Contract tests cover 100% of endpoints.
- At least 10 new unit tests using in-process twin (no HTTP needed).

**Estimated effort**: 4-6 days.

---

### Phase 3 — Replay & Analysis (Flagship UX)

**Goal**: Full state replay with time-travel navigation, what-if branching, event lifecycle. MCP-accessible. UI shows spatial annotations + well inspector during replay.

Deliverables from #38, #36, #37, #41 (grouped because they form one user experience).

#### Step 3.1 — Replay service core (#38)

- `ReplayService` class in `src/services/replay-service.ts` (replaces re-simulation stub from Phase 2).
- Loads `TwinTrace` from file or JSON.
- **State replay** (no re-execution):
  - `getPosition()`, `step(direction)`, `jump(eventId)`, `seek(filter)`, `getStateAt(eventId)`.
  - Uses embedded snapshots: find nearest snapshot ≤ target, apply state deltas from events between snapshot and target.
- Emits SSE `replay-position-changed`, `replay-state-changed` to sync the UI.

#### Step 3.2 — What-if fork (#38)

- `fork(atEventId): { forkId }` — creates new `DigitalTwin` instance, calls `restore(snapshot_at_eventId)`.
- `forkCommand(forkId, rawCommand): CommandResult` — executes on fork.
- `forkStep(forkId, stepType, params): StepResult`.
- `diffFork(forkId): StateDiff` — compare fork state to original trace at same event index.
- `discardFork(forkId)`.
- **Integration test**: fork at event 50, execute 10 different commands, verify original trace unchanged, diff shows expected differences.

#### Step 3.3 — Event lifecycle (#36)

- Extend `TwinTimelineEvent` with `lifecycle: 'active'|'expected'|'flagged'|'suppressed'|'resolved'`.
- `src/twin/lifecycle-classifier.ts` — rules engine.
- Auto-classification on trace load or live execution.
- Contamination + subsequent tip eject auto-resolves the contamination event.
- API: `classify(eventId, lifecycle)`, `autoClassify(trace)`, `getFlagged()`, `getSummary()`.

#### Step 3.4 — Analysis REST API (#38)

- `/api/analysis/load`, `/position`, `/step`, `/jump`, `/seek`, `/state`, `/events`.
- `/api/analysis/fork`, `/fork/:id/command`, `/fork/:id/step`, `/fork/:id/state`, `/fork/:id/diff`, `/fork/:id` (DELETE).
- `/api/analysis/play`, `/pause`, `/resume`, `/speed`.

#### Step 3.5 — MCP tools (#38)

- Create `src/api/mcp-server.ts` if not already stubbed.
- Tools:
  - `twin.*` (already partially exist): sendCommand, getState, executeStep, snapshot, restore.
  - `analysis.load(path)`, `.jump(id)`, `.whatIf(at, cmd)`, `.inspectWell(...)`, `.findIssues()`, `.summary()`.
  - `report.summary(traceId)` (stub for Phase 5).

#### Step 3.6 — Spatial event annotations (#37)

- New `src/renderer/annotations.ts` — SVG `<g>` overlay on the deck.
- Subscribe to SSE `assessment` + `replay-state-changed`.
- Per-well markers: error ring, warning ring, unresolved crosshair.
- Layer toggles (show/hide errors, warnings, unresolved, etc.).
- Click marker → scroll assessment panel to that event.
- Fade routine info markers after 5 seconds; pin on user click.

#### Step 3.7 — Well inspector (#41)

- New `src/renderer/well-inspector.ts`.
- Click well → panel opens with:
  - Current state (volume, liquid, surface height).
  - Event history for that well (from `/api/analysis/events?well=...`).
  - Volume-over-time chart (simple SVG path).
  - Liquid provenance (which channels touched, contamination risk).
  - For each aspirate/dispense event: expandable TADM curve viewer.
- Works in both live and replay modes.

#### Step 3.8 — Timeline scrubber UI

- New `src/renderer/timeline-scrubber.ts` — horizontal bar at bottom of deck view.
- Progress indicator, severity markers, click to jump, hover for command summary.
- Play / pause / step / speed controls.

**Verification gate**:
- **Property test**: for any trace T and eventId N, `replay.jump(N); replay.step('forward')` state === `replay.jump(N+1)` state.
- **Integration test**: record 500-cmd trace, jump to event 247, verify state matches what it was at that time.
- **Integration test**: fork at event 100, send different command, original state unaffected, diff shows only the differences.
- **Integration test**: known contamination event auto-classified as flagged; subsequent tip eject moves it to resolved.
- **E2E test**: Playwright — load trace, scrub timeline, verify deck updates, click well, inspector shows correct history.
- **MCP contract test**: every MCP tool produces response matching REST endpoint shape.
- Coverage on services/ ≥ 70%.

**Estimated effort**: 14-18 days.

---

### Phase 4 — Report Generation & Advanced Physics (parallel tracks within serial execution)

**Goal**: Downloadable reports from traces + deeper physics observations.

Per user's "serial with deep review" preference, these are done sequentially (first 4.A, then 4.B, then 4.C) rather than parallel.

#### Step 4.A — Report generation (#40)

- `ReportGenerator` service reads `TwinTrace`, emits formatted reports.
- Report types: protocol summary (text/HTML), well-level report (per-well history), assessment CSV, timing breakdown, what-if diff report.
- Endpoints: `/api/report/summary`, `/well`, `/assessments?format=csv`, `/timing`, `/diff`.
- MCP tools: `report.summary(trace)`, `.wellReport(trace, well)`, etc.
- **Golden-file tests**: fixed trace inputs produce identical outputs across runs.

**Estimated effort**: 4-6 days.

#### Step 4.B — Collision detection (#35)

- New `src/twin/plugins/collision-physics.ts` (global plugin, not per-module).
- Track arm X/Z per arm (partly already in SCXML datamodel).
- On each movement command, check:
  - Arm path vs carrier Z envelope (arm at traverse Z vs tall labware).
  - Multi-arm mutual exclusion (PIP vs 96-Head X overlap).
  - iSWAP/gripper transport path (sweep bounding box).
- Emit `AssessmentCategory: "collision"` with severity error + spatial data.
- **Integration tests**: stage a tall carrier, move arm over it → collision event. Move PIP and 96-Head to overlapping X → mutual-exclusion event.

**Estimated effort**: 5-7 days.

#### Step 4.C — Advanced physics observations (#39)

Pick and implement in priority order:
1. Meniscus tracking (refined submerge depth calculation).
2. Air gap layered channel state (refactor `ChannelState.contents` → `layers`).
3. Foam detection (low surface tension + high dispense speed).
4. Drip risk (aspirate without trailing air gap).
5. Clot/blockage (TADM curve perturbation modes — extend `generateAspirateCurve`).
6. Liquid following quality (surface drop rate vs tracking capability).

Each observation: new category, physics model, 3+ tests (positive, negative, boundary).

**Estimated effort**: 7-10 days.

**Verification gate for Phase 4**:
- Reports generated from any trace produce valid output.
- Collision detection catches staged scenarios.
- Each new physics observation has positive + negative + boundary test.
- Coverage stays ≥ 70%.

---

### Phase 5 — VENUS Protocol Bridge (#45)

**Goal**: Twin appears as a real Hamilton STAR to VENUS over FDx-over-TCP.

#### Step 5.1 — FDx framing layer

- `src/services/fdx-bridge/fdx-framing.ts`:
  - Frame payload: STX + payload + ETX + BCC.
  - Deframe: consume STX...ETX BCC, verify BCC, extract payload.
  - Handle DLE escape (DLE = 0x10, escapes STX/ETX/DLE in payload — check spec).
- **Unit tests**: property test — random payloads round-trip through frame/deframe.

#### Step 5.2 — FDx handshake state machine

- `src/services/fdx-bridge/fdx-handshake.ts`:
  - States: idle → awaiting-ack → sending → awaiting-response → done.
  - Handle ENQ → ACK/NAK; timeouts (1500ms receive, 3000ms response); 3 retries then recovery.
- **State-machine tests**: use VSCXML skill to design and verify the FDx state machine if complex.

#### Step 5.3 — TCP server

- `src/services/fdx-bridge/fdx-server.ts`:
  - TCP server on configurable port (default 9999).
  - Accept single or multiple VENUS connections.
  - Per-connection FDx handshake + framing state.

#### Step 5.4 — Command bridge

- Each framed command → extract ASCII FW command → `twin.sendCommand()` → format response with FDx framing → send back.
- Apply timing delay from `twin.estimateCommandTime()` scaled by configurable speed.

#### Step 5.5 — Response format enhancements

- Per-channel errors (`er99/00 P1##/## P2##/##...`): extend `formatFwResponse()` in `fw-protocol.ts` or bridge-level expansion.
- LLD query `C0RL` returns `ru#####` per channel.
- TADM query response format (spec TBD — research C0 commands for TADM readback).
- Sub-device queries (P1-P8 RF/RJ, H0, X0, W1, W2, D0) already work via `SUB_DEVICE_MAP`.

#### Step 5.6 — VENUS test harness

- If real VENUS installation available: configure it to use TCP bridge as communication.
- Else: replay a recorded VENUS trace (from `VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/`) through the bridge → twin. Verify every command gets a valid response.
- **End-to-end test**: run `Pipettec_apacitiveLLD` trace through bridge → twin. All 4188 commands succeed.

**Verification gate**:
- FDx framing round-trips correctly for all payloads.
- Handshake recovers from NAK, timeout, retry.
- Bridge processes a recorded VENUS trace without errors.
- Timing delays match configured speed.
- (If available) Real VENUS completes a test method through the bridge.

**Estimated effort**: 12-18 days.

---

## Cross-cutting: Testing discipline (ALL phases)

Every feature follows this checklist before merging:

- [ ] **Unit test** for pure logic (no server, uses in-process twin).
- [ ] **Integration test** using programmatic API (no hardcoded port).
- [ ] **Contract test** if new endpoint/MCP tool.
- [ ] **Round-trip test** if serialization involved.
- [ ] **Failure-injection test**: deliberately break the implementation, run the test, verify it fails (proves test has teeth).
- [ ] **Coverage threshold** met.
- [ ] No `expect(x).toBeDefined()` without a value check on `x`.
- [ ] Every `accepted: true` assertion paired with a downstream physical-outcome check.

## Agent usage (per user's "serial with deep review" choice)

- I drive the implementation directly using Edit/Write/Bash/Read.
- Explore agents ONLY for research questions ("where is X implemented?", "what's the structure of Y?").
- NO general-purpose agents writing code autonomously.
- Every test run reviewed by me. Every diff reviewed before commit.
- If a sub-task is narrowly scoped (e.g., "add these 5 unit tests for this specific function"), I may use an agent but I'll read its output file-by-file before accepting.

## Definition of "Done" per phase

A phase is complete when:
1. All features in that phase are implemented per this plan.
2. All tests in the phase's verification gate pass.
3. Coverage threshold met (baseline after Phase 0, 55% after 1, 70% after 3, 75% after 4).
4. At least one failure-injection test per new service/module proves tests catch breakage.
5. No regressions in previous phases' tests.
6. Docs updated: CLAUDE.md and relevant docs/*.md files.
7. GitHub issue(s) closed with summary comment.

## Timeline (serial, single-developer)

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| 0: Test hardening | 4-5 days | — |
| 1: Foundation | 10-14 days | Phase 0 |
| 2: Service architecture + headless | 4-6 days | Phase 1 |
| 3: Replay + analysis + lifecycle + annotations + well inspector | 14-18 days | Phase 2 |
| 4: Reports + collision + advanced physics | 16-23 days | Phase 3 |
| 5: VENUS bridge | 12-18 days | Phase 3 (stable API), ideally Phase 4 |

**Total: ~60-84 days (12-17 weeks) serial.**

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|:---:|:---:|------------|
| SCXML restore bypasses entry actions, produces invalid state | Medium | High | Extensive round-trip tests including mid-operation snapshots. Document caveat. Fallback: replay-based restore. |
| Tests hide errors (user's top concern) | High → controlled | Critical | Phase 0 overhaul. Failure-injection tests. Coverage thresholds. Assertion hygiene guide. Every integration test paired with physical-outcome check. |
| Dual-mode refactor breaks Electron UI | Medium | Medium | Contract tests capture pre-refactor behavior. Renderer untouched. |
| VENUS bridge fails validation (no real VENUS to test against) | Medium | Low | Record-trace replay as primary validation. Real VENUS optional upgrade. |
| Scope creep in advanced physics | Medium | Medium | Strict list in Phase 4.C. New categories → new issues, not Phase 4. |
| Event spine performance regression | Low | Medium | Benchmark every phase. Push-only spine. Lazy indexing. |
| Plugin internal state becomes non-trivial | Low | Medium | `getPluginState()`/`restorePluginState()` opt-in per plugin; add as needed. |

## Out of scope (explicitly deferred)

- HSL method execution (twin only receives FW commands).
- VENUS multi-resource scheduler.
- Real-time collaboration / multi-user editing.
- LIMS integration.
- USB driver-level VENUS integration (bridge is protocol-level over TCP).
- Trace file storage backend (traces remain in-memory + downloadable files).
- Labware library import from VENUS .rck files (separate, existing issue #18 was closed; revisit if needed).

## Critical files

### Must modify
- `src/twin/digital-twin.ts` — snapshot/restore/clone, correlation IDs, spine integration
- `src/state-machines/scxml-runtime.js` — forceConfiguration, getConfiguration
- `src/twin/deck.ts` — getConfig, restoreFromConfig
- `src/twin/deck-tracker.ts` — restore methods, unresolved → assessment emission
- `src/twin/liquid-tracker.ts` — restore methods, move dead volumes to config
- `src/twin/well-geometry.ts` — thin lookup over labware catalog
- `src/twin/assessment.ts` — new category, spine push
- `src/twin/plugin-interface.ts` — optional serialization methods
- `src/main/main.ts` — reduce to <100 lines (Phase 2)
- `vitest.config.ts` — coverage config

### Must create
- `src/twin/twin-config.ts` — config/state types
- `src/twin/timeline.ts` — spine
- `src/twin/trace-format.ts` — trace IO
- `src/twin/labware-catalog.ts` — unified labware + geometry
- `src/twin/lifecycle-classifier.ts` — event classification rules
- `src/headless/server.ts` — headless entry point
- `src/services/trace-recorder.ts`
- `src/services/replay-service.ts`
- `src/services/report-generator.ts`
- `src/services/fdx-bridge/{framing,handshake,server,bridge}.ts`
- `src/api/rest-api.ts`
- `src/api/sse-broker.ts`
- `src/api/mcp-server.ts`
- `src/renderer/annotations.ts`
- `src/renderer/well-inspector.ts`
- `src/renderer/timeline-scrubber.ts`
- `tests/helpers/in-process.ts`
- `tests/unit/*` — new unit test tree
- `tests/contract/api-contract.test.ts`
- `tests/TESTING-GUIDE.md`
- `tests/AUDIT-2026-04.md`

## Reusable existing utilities

Where possible, reuse existing code to avoid duplication:

- `DigitalTwinAPI` in `src/twin/api.ts` — already the programmatic API; extend with snapshot/restore/clone.
- `getWellGeometry()` in `src/twin/well-geometry.ts` — keep the signature, change the backing store.
- `Deck.getSnapshot()` — already serializes most deck state; extend to include well geometry + wellDepth + height.
- `LiquidTracker.getWellSnapshot()` / `getChannelSnapshot()` — already convert Maps to Records for JSON; reuse the pattern in restore.
- `AssessmentStore` already has listener registration; spine integrates as another listener.
- `DeckTracker.processCommand()` already has the unresolved-classification logic at lines 390-418 — extend to also emit assessment events.
- `EventEmitter` patterns throughout — consistent across `DeviceEventEmitter`, `AssessmentStore`, renderer; keep the pattern.
- `estimateCommandTime()` in `command-timing.ts` — reuse in FDx bridge for timing delays.

## Verification strategy (summary)

- **Phase 0**: demonstrated ability for tests to catch regressions.
- **Phase 1**: round-trip integrity for all serialization.
- **Phase 2**: dual-mode works, all existing tests pass through programmatic API.
- **Phase 3**: property-based tests on jump/step equivalence; E2E with Playwright for UI.
- **Phase 4**: golden-file reports; staged physical scenarios for collision.
- **Phase 5**: real VENUS trace replay end-to-end through bridge.

Every phase ends with a manual integration check: I start the twin, perform a representative workflow (e.g., record a protocol, save the trace, replay it, branch it, generate a report), and verify everything works end-to-end in the UI.
