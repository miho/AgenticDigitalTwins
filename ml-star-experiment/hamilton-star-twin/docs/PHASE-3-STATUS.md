# Phase 3 Status — Replay & Analysis (flagship UX)

**Status:** ✅ **SUPERSEDED** by `docs/PHASE-3-REPORT.md` — Phase 3 is complete.
**Last updated:** 2026-04-16 (historical snapshot, kept for diff/audit)

This file was the live planning doc for Phase 3. The report captures
what landed, test counts, verification gate results, and architectural
decisions.

**Umbrella issue:** #42
**Key issues delivered:** #38, #36, #37, #41
**Plan:** `hamilton-star-twin/docs/PHASE-PLAN.md` (Phase 3 section)

## Naming — avoid collision with Phase 2's ReplayService

Phase 2 shipped `src/services/replay-service.ts` containing a FW-command
trace re-sender (load a recorded `.trc` file, re-send each command to
the live twin). That functionality is still useful for the /replay/*
UX — live-trace execution — and Phase 3 keeps it as-is under the name
`ReplayService`.

Phase 3 adds a DIFFERENT kind of replay: state-replay against a
`TwinTrace` produced by the Phase 1 `TraceRecorder`. To avoid confusion,
Phase 3's new service is named `TraceReplayService` and lives at
`src/services/trace-replay-service.ts`. It exposes its state-replay
functionality under `/api/analysis/*` — a distinct endpoint namespace.

## Step-by-step

### 🔜 Step 3.1 — TraceReplayService core

**What:** Load a `TwinTrace` (from Phase 1's trace-format) and navigate it
without re-running the twin from scratch. `getPosition`, `step`, `jump`,
`seek`, `getStateAt`. Uses embedded snapshots as cached checkpoints;
between snapshots, falls back to bounded re-execution (≤ snapshotEveryN
events, default 50 — cheap enough for interactive UX).

**Why separate from Phase 2's ReplayService:** Phase 2's service replays
FW commands against a LIVE twin. Phase 3's service traverses a RECORDED
trace's state history. Different data model, different use case.

**Biggest risk:** state-at-eventId fidelity. Property test:
`jump(N); step('forward')` → state should match `jump(N+1)`. Fails loudly
if the snapshot/re-execution pipeline drifts.

### 🔜 Step 3.2 — What-if fork

**What:** Clone the twin at any event in the trace, execute alternative
commands on the clone, diff against the original. Uses Phase 1's
`DigitalTwin.clone()` + `restore()`.

### 🔜 Step 3.3 — Event lifecycle classifier

**What:** Extend `TwinTimelineEvent` with `lifecycle: active | expected |
flagged | suppressed | resolved`. Rules engine auto-classifies common
patterns (contamination → subsequent tip eject = resolved). API:
`classify`, `autoClassify`, `getFlagged`, `getSummary`.

### 🔜 Step 3.4 — Analysis REST API

**What:** `/api/analysis/load`, `/position`, `/step`, `/jump`, `/seek`,
`/state`, `/events`, `/fork`, `/fork/:id/command`, `/fork/:id/step`,
`/fork/:id/state`, `/fork/:id/diff`, DELETE `/fork/:id`, `/play`,
`/pause`, `/resume`, `/speed`. Contract-test per endpoint.

### 🔜 Step 3.5 — MCP tools

**What:** `src/api/mcp-server.ts` (doesn't exist yet). Tools:
- `twin.*` — sendCommand, getState, executeStep, snapshot, restore
- `analysis.*` — load, jump, whatIf, inspectWell, findIssues, summary
- `report.summary(traceId)` — stub for Phase 4/5

### 🔜 Step 3.6 — Spatial event annotations

**What:** SVG overlay on the deck. Per-well markers (error ring, warning
ring, unresolved crosshair). Layer toggles. Click marker → scroll
assessment panel. Routine info fades after 5 s; pinned on click.

### 🔜 Step 3.7 — Well inspector

**What:** Click a well → panel with current state + per-well event
history + volume-over-time chart + liquid provenance + expandable
TADM curve viewer. Works in both live and replay modes.

### 🔜 Step 3.8 — Timeline scrubber UI

**What:** Horizontal bar at bottom of deck view — progress indicator,
severity markers, click to jump, hover for command summary, play /
pause / step / speed controls.

## Verification gate

- **Property test**: for any trace T and eventId N,
  `replay.jump(N); replay.step('forward')` state equals `replay.jump(N+1)` state.
- **Integration test**: record 500-cmd trace, jump to event 247, verify state matches.
- **Integration test**: fork at event 100, send different command, original unaffected, diff shows expected differences.
- **Integration test**: known contamination event auto-classified as flagged; subsequent tip eject moves it to resolved.
- **E2E test**: Playwright — load trace, scrub timeline, verify deck updates, click well, inspector shows correct history.
- **MCP contract test**: every MCP tool response shape matches the corresponding REST endpoint.
- **Coverage**: `src/services/**` ≥ 70%.

## How to resume cold

```
cd hamilton-star-twin/
cat docs/PHASE-STATUS.md         # master index
cat docs/PHASE-3-STATUS.md       # this file
cat docs/PHASE-PLAN.md           # full Phase 3 detail (line 300+)
cat docs/PHASE-2-REPORT.md       # what Phase 3 inherits (clean service arch)
npm run test:unit                # baseline: 190 pass in ~3s
```
