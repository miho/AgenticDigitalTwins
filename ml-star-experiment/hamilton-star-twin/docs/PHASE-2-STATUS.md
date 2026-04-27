# Phase 2 Status — Service Architecture & Dual-Mode

**Status:** ✅ **SUPERSEDED** by `docs/PHASE-2-REPORT.md` — Phase 2 is complete.
**Last updated:** 2026-04-16 (historical snapshot, kept for diff/audit)

This file was the live checkpoint while Phase 2 was being planned. It is
no longer the source of truth — see the report for what landed, test counts,
and verification gate outcome.

**Umbrella issue:** #42
**Key issue:** #44
**Plan:** `hamilton-star-twin/docs/PHASE-PLAN.md` (Phase 2 section)

## Step-by-step

### 🔜 Step 2.2 — SSE broker

**What:** `src/api/sse-broker.ts` — encapsulate the `Set<http.ServerResponse>`
and the `broadcast(type, data)` fan-out. No business logic, just transport.

**Why first:** Both the REST layer (2.1) and the replay service (2.3) call
`broadcastSSE`. Extracting the broker makes both consumers reference the
same dependency without circular imports.

### 🔜 Step 2.3 — Replay service

**What:** `src/services/replay-service.ts` owns the in-memory trace buffer,
replay index, speed, and play/pause timer. Today that logic is scattered
across `traceCommands`, `replayIndex`, `replayTimer`, `replaySpeed` as
module-level state in `main.ts`.

**Preserve** the current re-simulation behaviour — Phase 3's `ReplayService`
replaces it with state replay against a `TwinTrace`. This step just extracts
and gives it a clean interface.

### 🔜 Step 2.1 — REST API

**What:** `src/api/rest-api.ts` exposes `registerRoutes(server, deps)` or an
`attach(server)` method. Takes `DigitalTwinAPI`, `SseBroker`, and
`ReplayService` as deps. Every route from `main.ts` moves here.

**Keep** response shapes byte-identical so existing integration tests pass
unchanged — verified by the contract tests in Step 2.6.

### 🔜 Step 2.4 — Dual-mode entry

**What:**
- `src/headless/server.ts` — pure Node entry. `new DigitalTwinAPI()`, wire
  services, start HTTP server. No `electron` import.
- `src/main/main.ts` — thin Electron entry. Starts the same HTTP server via
  the shared setup, then opens a `BrowserWindow`. Target < 100 lines.
- `package.json` — `npm run server` → `node dist/headless/server.js`,
  `npm run dev:server` → watch mode. Keep `npm run start` / `npm run dev`.

### 🔜 Step 2.5 — Programmatic test server

**What:** `tests/helpers/test-server.ts` exports
`createTestServer(options?): { port, baseUrl, close() }` that spawns the
headless server on a random port. Migrate integration tests to use it
instead of the hardcoded `localhost:8222`.

### 🔜 Step 2.6 — Contract tests

**What:** `tests/contract/api-contract.test.ts` — one call per endpoint with
a representative payload, asserts the response shape. Golden-file per
endpoint so refactors can't silently break the HTTP contract.

## Verification gate

- `main.ts` < 100 lines.
- `npm run server` starts the headless twin on any port.
- `npm run start` launches Electron identically to before.
- All existing integration tests pass against the new architecture.
- Contract tests cover 100% of endpoints.
- ≥ 10 new unit tests using the in-process twin (no HTTP).

## How to resume in a fresh session

```
cd hamilton-star-twin/
cat docs/PHASE-STATUS.md         # master index
cat docs/PHASE-2-STATUS.md       # this file
cat docs/PHASE-PLAN.md           # full Phase 2 detail (around line 246)
cat docs/PHASE-1-REPORT.md       # what Phase 1 delivered that Phase 2 builds on
npm run test:unit                # expect 169 pass in ~3s
```
