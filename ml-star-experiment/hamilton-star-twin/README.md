# Hamilton STAR Digital Twin

A firmware-faithful, state-machine-driven digital twin of the Hamilton
Microlab STAR liquid handling robot. The twin accepts the same wire-level
firmware commands a physical STAR does (`C0AS`, `C0TP`, `C0PP`, …), runs
them through W3C-compliant SCXML state machines, and mutates a single
shared datamodel that the renderer, physics plugins, REST/SSE bridge,
VENUS TCP bridge, and MCP tools all read from directly.

VENUS 6.0.2 drives the twin end-to-end: same TCP handshake, same FW
opcodes, same response shapes — anything that talks to a real STAR also
talks to the twin.

## Quick start

```bash
npm install              # first time only
npm run build            # tsc + asset bundling + SCXML codegen
npm start                # Electron UI on http://localhost:8222
# or:
node dist/headless/server.js --port 8222    # same API, no UI
```

The Electron app and the headless server expose the same HTTP surface,
the same SSE stream, the same MCP registry. Pick whichever fits.

## What's in the box

- **Firmware-level simulator.** 236 FW commands across 10 SCXML modules
  (master, PIP channels, CoRe 96 head, CoRe 384 head, iSWAP, CO-RE
  gripper, autoload, wash station, temperature, heater-shaker). Pinned
  against real VENUS ComTrace recordings under
  `VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/`.
- **Realistic motion.** Every motion-producing command emits a
  `MotionEnvelope` (start/end positions, traverseZ, per-channel Y/Z,
  durationMs). The 2D and 3D renderers animate a CNC-style retract →
  travel → descend profile at nominal STAR speeds (Z=300 mm/s,
  XY=800 mm/s) with phase boundaries derived from physical distance.
  State commits on motion end so a consumer polling `/tracking` mid-move
  sees the pre-command state.
- **Hamilton Z convention enforced.** `pos_z` measures height above the
  deck (bigger = higher = safer). `tp` / `th` / `zp` are derived from
  labware geometry + tip-type catalog, never hardcoded.
- **Strict FW Z-param validation.** A C0TP without `tp`/`th`, a C0AS
  without `zp` (and no LLD search), a C0TR without `tz`/`th` — all error
  with code 3, just like real firmware. Customer software that's missing
  required Z params fails on the simulator instead of fooling its way
  past CI and crashing on real hardware.
- **Per-channel Y/Z.** Each PIP channel has its own Y and Z drives;
  partial-mask aspirates spread the channels in Y, and engaged channels
  descend independently in Z. The 2D + 3D arms render the spread.
- **Physics plugins.** Collision detection, contamination tracking,
  TADM curves, LLD, foam/drip/meniscus observations. Each plugin sits
  next to the execution path as an observer; assessments stream out via
  SSE.
- **Replay + what-if.** `analysis.load(trace)` opens a recorded
  `.twintrace.json`. `jump`, `seek`, `step` give O(1) time-travel.
  `fork` clones the twin at any event for branched what-if execution.
- **VENUS TCP bridge.** `node dist/headless/server.js --venus-bridge`
  advertises BDZ discovery on UDP:34569 and accepts FW commands on
  TCP:34567. Real VENUS finds the twin as `MLSTARPipettor` and runs
  Initialize → Pickup → Aspirate → Dispense → Eject end-to-end.
- **MCP tools.** 28 MCP tools across `twin.*`, `analysis.*`, `report.*`,
  `deck.*`, `venus.*`, `docs.*`. An LLM agent calls `docs.overview` to
  discover everything else.

## Global simulation settings

Available via REST (`GET/POST /settings`), MCP (`twin.getSettings`,
`twin.setSettings`), and the dashboard header:

- `simSpeed` — physical-time multiplier. `0` = instant (no motion delay,
  used by tests). `1` = real time (default — CNC envelopes still play).
  `0.5` = 2× faster. `2` = 2× slower.
- `fastInit` — when `true` (default), `C0VI/C0DI/C0EI/C0FI/C0II` skip
  the ~70 s of homing delay so "Init All" lands in `sys_ready`
  immediately. Per-command `simSpeed` overrides still win.

## Project layout

```
hamilton-star-twin/
├── src/
│   ├── twin/                 # Core: command pipeline, motion envelope, deck, plugins
│   ├── state-machines/       # SCXML runtime + 10 compiled modules
│   ├── api/                  # REST + SSE + MCP
│   ├── services/             # BDZ bridge, VENUS .lay/.dck/.rck/.ctr import, replay
│   ├── headless/             # CLI entry (no Electron)
│   ├── main/                 # Electron main process
│   └── renderer/             # 2D SVG + 3D Three.js views
├── scxml/                    # State chart sources (VSCXML-authored)
├── assets/                   # Default deck + bundled labware definitions
├── scripts/                  # Build helpers (SM codegen, asset bundling)
├── tests/                    # unit · integration · contract · e2e
└── docs/
    ├── ARCHITECTURE.md       # Deep dive (slide-ready)
    ├── TUTORIAL.md           # End-to-end walkthrough with screenshots
    ├── PHASE-STATUS.md       # Master phase dashboard
    └── PHASE-{1..6}-*.md     # Per-phase reports
```

## Tests

```bash
npm run test:unit            # ~450 tests, ~8 s
npm run test:contract        # HTTP round-trips against a fresh server
npm run test:integration     # full-stack with real SCXML + plugins
npm run test:e2e             # Playwright-driven UI flows
npm run test:visual          # pixelmatch-gated tutorial screenshots
npm test                     # everything
```

CI runs unit + fw-integration + visual on every push to `master`. See
`.github/workflows/test.yml` (at the repo root) and
`tests/TESTING-GUIDE.md`.

## SCXML workflow

State charts live in `scxml/*.scxml`. Edit the XML, regenerate JS via
the VSCXML MCP tool (`mcp__plugin_vscxml_vscxml__scxml_generate` with
`options.className=<ExistingClass>`), and copy the output into
`src/state-machines/modules/` + `dist/state-machines/modules/`. Never
hand-edit generated JS — the next regeneration overwrites it.

## Where to read next

- `docs/ARCHITECTURE.md` — six principles (firmware as the contract,
  SCXML as the logic, shared datamodel, motion envelope, physics
  side-cars, MCP self-description) with diagrams.
- `docs/TUTORIAL.md` — end-to-end walkthrough: fill, transfer, inspect,
  TADM, iSWAP, h96, h384, autoload, VENUS layout import, REST + MCP.
- `docs/PHASE-6-STATUS.md` — current state of real-VENUS compatibility
  and recent post-Phase-6 polish (sim settings, CNC motion, Hamilton Z
  convention, per-channel Y/Z, FW Z-param validation, tip catalog).
- `tests/TESTING-GUIDE.md` — assertion discipline; every new feature
  lands with a failure-injection preamble.
