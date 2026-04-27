# Hamilton STAR Digital Twin — Monorepo

A firmware-faithful, state-machine-driven digital twin of the Hamilton
Microlab STAR liquid handling robot, plus the MCP bridge that lets AI
agents drive it and the Windows installer that ships both as a single
package. VENUS 6.0.2 drives the twin end-to-end over its native TCP
protocol — anything that talks to a real STAR also talks to the twin.

## Repository layout

```
.
├── hamilton-star-twin/     Electron app + headless HTTP server + 2D/3D
│                           renderer + 10 SCXML modules + physics plugins.
│                           See hamilton-star-twin/README.md.
├── hamilton-star-mcp/      stdio→HTTP MCP server. Forwards MCP tool calls
│                           to a running twin's /api/mcp/*; never
│                           instantiates its own DigitalTwinAPI.
├── installer/              electron-builder config, portable .zip
│                           staging (bundled Node runtime), launchers.
├── scxml/                  W3C SCXML state-chart sources (authored in
│                           VSCXML; compiled into hamilton-star-twin/).
├── labware/                JSON labware definitions (subset; the canonical
│                           catalog lives in
│                           hamilton-star-twin/src/twin/labware-catalog.ts
│                           with .ctr-derived geometry baked in).
├── hamilton-star-digital-twin.{json,md}
│                           Original FW-command spec (still consumed by
│                           the twin for error-code descriptions).
├── ARCHITECTURE.md         Legacy v0.4.0 architecture doc — superseded
│                           by hamilton-star-twin/docs/ARCHITECTURE.md.
├── Command sets (13.04.2026)/
│                           Extracted Hamilton FW command reference
│                           (source for the JSON spec).
└── install.ps1             One-shot Windows installer: runs `npm install`
                            + `npm run build` for the twin and MCP, then
                            generates desktop launchers.
```

VENUS source (`VENUS-2026-04-13/`) and large Hamilton-supplied PDFs are
referenced in code/docs but kept out of git per `.gitignore`.

## Quick start

**Windows, GUI:**

```powershell
# One-time install (Node 18+ required)
.\install.ps1

# Then double-click the launchers it generated, or:
cd hamilton-star-twin
npm start                    # Electron UI on http://localhost:8222
```

**Headless / CI:**

```bash
cd hamilton-star-twin
npm install
npm run build
node dist/headless/server.js --port 8222
```

The Electron app and the headless server expose the same HTTP surface,
the same SSE stream, the same MCP registry. For the full feature
overview (sim settings, CNC motion, Hamilton Z convention, FW Z-param
validation, per-channel Y/Z, …) see
[`hamilton-star-twin/README.md`](hamilton-star-twin/README.md).

## Components

### `hamilton-star-twin/` — the twin itself

236 firmware commands across 10 SCXML modules (master, PIP channels,
CoRe 96/384 heads, iSWAP, CO-RE gripper, autoload, wash, temperature,
heater-shaker). Pinned against real VENUS ComTrace recordings.
Motion envelopes drive a CNC-style retract→XY→descend profile at
nominal STAR speeds. Strict FW Z-param validation matches real
firmware (er03 on missing `tp`/`th`/`zp`). MCP tool surface
(`twin.*`, `analysis.*`, `report.*`, `deck.*`, `venus.*`, `docs.*`)
is self-describing — agents call `docs.overview` to discover the
rest. See [`hamilton-star-twin/docs/ARCHITECTURE.md`](hamilton-star-twin/docs/ARCHITECTURE.md)
for the principles and [`hamilton-star-twin/docs/TUTORIAL.md`](hamilton-star-twin/docs/TUTORIAL.md)
for an end-to-end walkthrough.

### `hamilton-star-mcp/` — stdio→HTTP MCP bridge

A thin MCP server that forwards tool calls to a running twin over
HTTP. Useful when the agent host (Claude Desktop, etc.) only speaks
stdio MCP. Does not instantiate its own twin.

```bash
cd hamilton-star-mcp
npm install && npm run build
node dist/index.js          # speaks MCP over stdio
```

### `installer/` — Windows distribution

`electron-builder` produces two artifacts on Windows:

- **NSIS installer** — desktop integration, Start-Menu shortcuts.
- **Portable `.zip`** (`HamiltonStarTwin-<version>-x64.zip`) — bundled
  Node runtime, unzip and run. Useful when the target machine doesn't
  have Node.js. Built via `installer/build-installer.ps1`.

## Testing & CI

Tests live under `hamilton-star-twin/tests/`:

```bash
cd hamilton-star-twin
npm run test:unit            # ~450 tests, ~8 s
npm run test:contract        # HTTP round-trips
npm run test:integration     # full-stack integration
npm run test:e2e             # Playwright UI flows
npm run test:visual          # pixelmatch-gated tutorial screenshots
npm test                     # everything
```

GitHub Actions runs three blocking jobs on every push to `master`:

- `build + unit` — builds the twin and runs the unit suite.
- `e2e (click-routing on Method1.lay)` — verifies the deck-click
  routing regression against a real Hamilton .lay file.
- `fw-server + trace-replay + twin-guards` — replays a real VENUS
  ComTrace through the twin's BDZ TCP bridge.

The visual-regression job runs with `continue-on-error: true` — pixel
diffs surface as artifacts but don't block the merge.

Workflow: `.github/workflows/test.yml`. Test-discipline guidance:
`hamilton-star-twin/tests/TESTING-GUIDE.md`.

## Where to read next

- [`hamilton-star-twin/README.md`](hamilton-star-twin/README.md) — quick-start, features, layout.
- [`hamilton-star-twin/docs/ARCHITECTURE.md`](hamilton-star-twin/docs/ARCHITECTURE.md) — six architectural principles with diagrams.
- [`hamilton-star-twin/docs/TUTORIAL.md`](hamilton-star-twin/docs/TUTORIAL.md) — end-to-end walkthrough with screenshots.
- [`hamilton-star-twin/docs/PHASE-6-STATUS.md`](hamilton-star-twin/docs/PHASE-6-STATUS.md) — current real-VENUS compatibility state and recent post-Phase-6 polish.
