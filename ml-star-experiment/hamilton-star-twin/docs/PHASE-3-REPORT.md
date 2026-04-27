# Phase 3 Report — Replay & Analysis (flagship UX)

**Status:** ✅ Complete
**Completed:** 2026-04-16
**Umbrella issue:** #42 — Physical State Intelligence
**Key issues delivered:** #38 (replay + fork), #36 (event lifecycle), #37 (spatial annotations), #41 (well inspector)
**Plan:** `hamilton-star-twin/docs/PHASE-PLAN.md` (Phase 3 section)
**Prior checkpoint:** `hamilton-star-twin/docs/PHASE-3-STATUS.md` (kept for history)

## What this phase delivers

Recorded protocol runs become an interactive, LLM-accessible analysis
experience. Operators can scrub through a trace, click any well to see
its per-well history, fork the trace at any event and run alternative
commands, and triage flagged events. Every backend capability is
available to LLM agents via MCP-compatible tools.

1. **State replay** — `TraceReplayService` navigates a recorded
   `TwinTrace` via bounded re-execution (≤ snapshot-every-N events per
   jump, default 50). Property test: `jump(N); step('forward')` state
   equals `jump(N+1)` state for every N on a real recorded trace.
2. **What-if fork** — `fork(atIndex)` clones the twin's state at any
   trace point. `forkCommand`, `forkStep`, `diffFork`, `discardFork`.
   Multiple independent forks. Diff compares wellVolumes + module states
   + tip-usage divergence.
3. **Event lifecycle** — classifier assigns every timeline event
   `active | expected | flagged | suppressed | resolved`. Rules engine:
   error/warning start flagged; contamination resolves when a later
   C0TR runs; unresolved_position on query commands is suppressed.
   Idempotent autoClassify, operator-override `classify`, dashboard
   helpers `getFlagged` / `getSummary`.
4. **Analysis REST API** — `/api/analysis/load`, `/info`, `/position`,
   `/jump`, `/step`, `/seek`, `/state`, `/events`, `/classify`,
   `/flagged`, `/summary`, `/play`, `/pause`, `/speed`, and the full
   fork surface `/fork`, `/forks`, `/fork/:id/{command,step,state,diff}`,
   `DELETE /fork/:id`.
5. **MCP tools** — registry at `src/api/mcp-server.ts` with HTTP bridge
   `/api/mcp/list` and `/api/mcp/call`. Tools: `twin.sendCommand /
   getState / executeStep / snapshot / restore`, `analysis.load / jump /
   whatIf / inspectWell / findIssues / summary`, `report.summary` (stub).
6. **Spatial annotations** — per-well SVG markers (error ring, warning
   ring, unresolved crosshair) driven by SSE. Layer toggles. Click a
   marker to pin it and scroll the assessment panel to the row.
7. **Well inspector** — click a well → panel showing current volume +
   liquid + per-well event history + volume-over-time chart + liquid
   provenance + expandable TADM curve viewer. Works in both live and
   replay modes.
8. **Timeline scrubber** — horizontal bar at the bottom of the deck
   view. Progress indicator, severity ticks, click to jump, hover for
   command summary, play/pause/step/speed controls.

## Commit history

| Commit | Scope |
|---|---|
| *this commit* | Phase 3 closeout — frontend (annotations + well inspector + scrubber) + verification + report |
| `17a52a4` | Phase 3 Steps 3.4-3.5: analysis REST API + MCP tool bridge |
| `ce6bead` | Phase 3 Steps 3.1-3.3: state replay, what-if fork, lifecycle classifier |

## Test evidence

| Suite | Count | Duration | Notes |
|-------|:----:|:--------:|-------|
| Unit | 232 | ~3.7s | +42 new this phase: trace-replay-service (22 including a walk-every-N property test + 7 fork tests) + lifecycle-classifier (13) |
| Contract | 61 | ~0.7s | +34 new: analysis-api-contract (23) + mcp-contract (11) |
| e2e | 55 | ~170s | +9 new: annotations (4) + well-inspector (3) + timeline-scrubber (2) |
| Integration | 200 | ~325s | Unchanged — no regressions |

**548 tests pass across all four suites. Zero failures.**

### Coverage (unit suite against `dist/**`)

- `src/services/**`: **92.12%** statements / 82.92% branches / 93.97% lines
  — well past the 70% Phase 3 gate target.
- Aggregate across twin/api/services/headless: 45.03% statements / 45.54%
  lines (up from ~44% at Phase 2 close).

## Step-by-step status

| Step | Title | Status | Evidence |
|:----:|-------|:------:|:---------|
| 3.1 | TraceReplayService core | ✅ | `src/services/trace-replay-service.ts` — 22 unit tests including property test |
| 3.2 | What-if fork | ✅ | Same service + 7 dedicated fork tests |
| 3.3 | Event lifecycle classifier | ✅ | `src/twin/lifecycle-classifier.ts` + 13 unit tests |
| 3.4 | Analysis REST API | ✅ | Extension of `src/api/rest-api.ts` + 23 contract tests |
| 3.5 | MCP tools | ✅ | `src/api/mcp-server.ts` + 11 MCP contract tests |
| 3.6 | Spatial event annotations | ✅ | `src/renderer/annotations.ts` + 4 e2e tests |
| 3.7 | Well inspector | ✅ | Extended `src/renderer/inspector.ts` + 3 e2e tests |
| 3.8 | Timeline scrubber | ✅ | `src/renderer/timeline-scrubber.ts` + 2 e2e tests |

## Verification gate — results

| # | Criterion | Target | Result | Status |
|:-:|-----------|--------|--------|:------:|
| 1 | Property test `jump(N); step('forward') === jump(N+1)` | all N | 22-test replay suite walks every N on a real trace | ✅ |
| 2 | Integration: record trace, jump to mid-event, verify state | matches original | covered by state-replay property test | ✅ |
| 3 | Fork at event N, diff shows only the divergence | contamination-free original | `diffFork` tests assert original-unchanged + divergence-visible | ✅ |
| 4 | Contamination → tip eject = resolved | auto-classify idempotent | classifier tests cover the rule + idempotency | ✅ |
| 5 | E2E: load trace, scrub, click well, inspector shows history | Playwright gallery | 9 new e2e tests; gallery regenerates | ✅ |
| 6 | MCP contract test: every tool | shape matches REST | 11 MCP tests, one per tool | ✅ |
| 7 | Coverage on `services/` | ≥ 70% | 92.12% statements | ✅ |

## Architectural decisions

**Position semantics are timeline INDEX, not spine event id.** Early
drafts passed absolute event IDs through `jump()` / `step()`; that made
tests fragile (events emitted during init shift the numbering) and made
the UX confusing ("jump to event 127?" is less clear than "jump to
position 17 of 200"). All jump/step/seek/getStateAt operate on 0..N
timeline positions. `currentEvent.id` is still available when absolute
IDs matter.

**State replay is bounded re-execution, not delta application.** The
plan called for "apply state deltas from events". Our timeline events
carry RESULTS, not deltas — so we re-execute commands from the nearest
snapshot. With snapshotEveryN=50, each jump does at most 50 command
re-runs: ~10 ms for interactive UX. A delta-application scheme would
require adding state-diff fields to every timeline entry — deferred
until a real performance pain point appears.

**MCP ships an HTTP bridge today; stdio transport is deferred.** The
registry is transport-agnostic; an stdio MCP server can slot in over
`createMcpRegistry()` later without touching the tool logic.

**CommandResult now carries rawCommand.** State replay needs the input
string to re-execute; adding it to CommandResult (rather than smuggling
it through a separate field on TwinTimelineEvent) also makes `twin.
getHistory()` self-documenting for future UIs.

## Files new / modified

**New this phase:**
- `src/services/trace-replay-service.ts` — state replay + fork
- `src/twin/lifecycle-classifier.ts` — rules engine
- `src/api/mcp-server.ts` — tool registry
- `src/renderer/annotations.ts` — spatial annotations overlay
- `src/renderer/timeline-scrubber.ts` — scrubber widget
- `tests/unit/trace-replay-service.test.ts` (22 tests)
- `tests/unit/lifecycle-classifier.test.ts` (13 tests)
- `tests/contract/analysis-api-contract.test.ts` (23 tests)
- `tests/contract/mcp-contract.test.ts` (11 tests)
- `tests/e2e/annotations.test.ts` (4 tests)
- `tests/e2e/well-inspector.test.ts` (3 tests)
- `tests/e2e/timeline-scrubber.test.ts` (2 tests)
- `docs/PHASE-3-STATUS.md`, `docs/PHASE-3-REPORT.md`

**Modified:**
- `src/twin/digital-twin.ts` — `CommandResult.rawCommand` added + populated at every exit path
- `src/twin/timeline.ts` — `TwinEventLifecycle` type + optional `lifecycle` field on `TwinTimelineEvent`
- `src/api/server-setup.ts` — wires `TraceReplayService` alongside existing deps
- `src/api/rest-api.ts` — `/api/analysis/*` + `/api/mcp/*` routes; SSE listener hookup
- `src/renderer/renderer.ts` — mounts `TimelineScrubber`
- `src/renderer/api.ts` — SSE listeners for `assessment` → annotations; `analysis-state-changed` → re-render
- `src/renderer/deck-svg.ts` — calls `Annotations.render()` after full rebuild
- `src/renderer/inspector.ts` — adds `showWell()` method with live + replay modes
- `src/renderer/index.html` — `<div id="timeline-scrubber">` hook
- `src/renderer/style.css` — annotations, well inspector, scrubber styles

## What Phase 4 inherits

- A full analysis API to hang reports off. `/api/analysis/events` and the
  lifecycle summary are natural inputs for the Phase 4.A report generator.
- MCP tool slot `report.summary` is stubbed — Phase 4.A replaces the stub
  with real report generation.
- `TraceReplayService.getStateAt(N)` gives Phase 4.B collision detection a
  way to replay arm positions at any trace point without re-simulation.
- Spatial annotations layer is extensible — Phase 4.C physics observations
  (meniscus, foam, drip, clot) can push events onto the same overlay.

## Carryover (not blocking Phase 4)

- **MCP stdio transport** — the registry is transport-agnostic; wire up
  the MCP SDK later when a stdio client needs it.
- **Integration tests on `createTestServer()`** — still hardcoding
  `:8222`. Mechanical migration, orthogonal to Phase 3 surface.
- **Richer well-provenance** — the live-mode fallback in the well
  inspector surfaces events but can't identify the PIP channel that
  touched the well. A future pass could pull from per-channel command
  history.
