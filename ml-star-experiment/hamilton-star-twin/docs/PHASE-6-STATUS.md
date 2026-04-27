# Phase 6 — Real-VENUS Compatibility

**Status (2026-04-20 — latest):** Back-to-back envelope smoothness
landed (see 2026-04-20 cycle below) — the arm no longer snaps back /
replays motion between consecutive commands. Portable `.zip` release
shipped (`HamiltonStarTwin-<version>-x64.zip`, bundled Node runtime).
Pip-channel SCXML now scopes C0AS/C0DS/C0TR/C0TP per-channel writes on
the `tm` mask — the previously-excluded `c0tp-c0as-c0tr-tm-isolation`
suite is green and back in CI. Release: `snapshot-20260420-1543`.

**Status (2026-04-19):** #54, #55 (all parts: A/B/C + .ctr data — row
5), #56, #57, #58, #59, #60, #61 all closed. Consolidation pass driven
by user directive ("fractured design as bad as VENUS"):
single-source-of-truth catalogs for labware (`labware-catalog.ts`) and
carriers (`carrier-catalog.ts`); retired `LABWARE_TEMPLATES`,
`WELL_GEOMETRIES`, `CARRIER_TEMPLATES`; Y-dimension constants declared
once in `deck.ts` and imported everywhere; `DeckSnapshot.dimensions`
carries platform bounds so the renderer has no STAR-hardcoded
constants. Catalog now carries .ctr-derived
wellDepth/maxVolume/hasConicalBottom for all canonical Hamilton types —
no more uniform estimate-defaults (`tests/unit/ctr-bakeout.test.ts`
pins against the source files). C0AS/C0DS parameter catalog
(`pip-command-catalog.ts`) pins 43+36 real-trace params to AtsMc*.cpp
lines; command timing now honors `wt`/`po`. iSWAP plate footprint
resolves from the labware under the gripper on C0PP; fixed
iswap-physics rejecting real C0PP because the plugin read `yp` instead
of `yj`. `inspector-liquid` Playwright test chains fill → click →
inspector DOM assertion + per-well assertion. Build-script Dropbox-lock
retries remain (errno -4094 handled). Remaining open: the larger
architecture epics (#33-#53).

## COLD-RESUME RECIPE (read this first on a fresh session)

```bash
cat hamilton-star-twin/docs/PHASE-6-STATUS.md   # this file — single source of truth
git log --oneline -10                            # latest commits (see "This cycle's commits" below)
cd hamilton-star-twin && npm run build           # clean-room rebuild works as of milestone A.1
npx vitest run tests/unit                        # 434 pass / 3 skip / 0 fail as of 2026-04-20
npm run test:visual                              # VISUAL_COMPARE=1 — 13 pixelmatch-gated shots
                                                 # against committed baselines in
                                                 # docs/tutorial-images/. Run
                                                 # `npm run test:visual:update` to regenerate.
```

The one command that fully proves where we are today:

```bash
node dist/headless/server.js --port 8233 --no-discovery --fw-port 9998
# then in another shell or browser-devtools:
curl -s -X POST http://localhost:8233/command -H 'content-type: application/json' \
  -d '{"raw":"C0CLid0010pq15"}' ; sleep 5
curl -s http://localhost:8233/state | jq '.modules.autoload.variables'
# expect: carriers_on_deck=1, pos_track=15, target_track=15
```

## 2026-04-20 cycle — envelope smoothness, portable release, per-channel isolation

Release: [`snapshot-20260420-1543`](https://github.com/miho/hamilton-star-digital-twin/releases/tag/snapshot-20260420-1543).

Commits on master:

```
f645e7d  pip-channel: per-channel isolation across tm-masked C0AS/C0DS/C0TR/C0TP
e2e5962  twin + renderer: eliminate back-to-back envelope jumps
8462f3d  installer: portable .zip target + bundled Node.js runtime
```

**1. Back-to-back envelope smoothness (`e2e5962`).** Three interacting
bugs produced visible jumps between consecutive motion envelopes.

- **Server-side `extractMotionEnvelope` (pip branch):**
  - `startY` now reconstructs the arm-wide ch0-equivalent from masked
    `pos_y[j] + j*90` (pitch locked at 9 mm — see
    `feedback_pip_channel_pitch_fixed.md`), mirroring the fallback in
    `arm.ts updateDeckArm`. Before, a non-ch0 mask left `pos_y[0]`
    stale, so the next envelope's `startY` snapped the arm back to
    that value.
  - `endY` consults `_yp_array` when scalar `data.yp` resolves to 0
    (VENUS's common `yp0 0 <target> 0 ...` layout). Before, `endY`
    fell through to `startY` and the envelope carried no Y motion —
    forcing the renderer's legacy ease to drift the arm to the new
    position AFTER the envelope finished.
  - `startZ` / `endZ` / `dwellZ` use max across `pos_z` /
    `_zp_array`, matching `updateDeckArm`'s deepest-channel rule.

- **Renderer `animate()`:** dropped the unconditional snap of
  `animX/Y` to `target*` after envelope completion. The envelope
  already pins the correct end in `stepArm`; the SSE `state_change`
  that refreshes `target*` arrives one or more frames LATER
  (setTimeout-commit + event-loop scheduling). Snapping there
  overwrote the pinned end with a stale pre-command target, briefly
  snapping the arm back to its old position — then legacy ease
  replayed the motion toward the freshly-arrived target. Residual
  <0.01 mm from legacy ease convergence is invisible; the snap-back
  was not.

- **Regression tests:** two new cases in `tests/unit/motion-envelope.test.ts`
  covering startY reconstruction and endY array reading for masked
  multi-channel commands.

**2. Pip-channel SCXML isolation (`f645e7d`).** The previously-excluded
`tests/unit/c0tp-c0as-c0tr-tm-isolation.test.ts` is green. Root cause:
the PIP SCXML scripts iterated `for (i=0..15) if (tip_fitted[i])` and
overwrote channel state regardless of the command's `tm` mask.

- **C0AS / C0DS** now gate `volume[i]` writes on `tm & (1<<i)`.
  Aspirating with `tm=0x02` adds the volume only to ch1, leaving
  ch0's earlier volume intact. Same for partial-jet dispense (`dm=0`)
  and partial dispense (`dm=2`/`dm=3`).
- **C0TR** split into partial-eject (some channels remain fitted ⇒
  stays in `tip_empty`/`tip_loaded`) and full-eject (all fitted
  channels in mask ⇒ → `no_tip`). Eject `tm=0x01` now drops only ch0;
  ch1..7 keep their tips.
- **C0TP** gained an accept-additional transition (no masked channel
  already fitted ⇒ pickup added to existing). Pickup `tm=0x03` then
  pickup `tm=0x0C` at a different well reports `active_tip_count=4`,
  not 2. Existing error-07 transition kept as fallback for overlap.

Workflow: edited `scxml/pip_channel.scxml`, regenerated JS via
`mcp__plugin_vscxml_vscxml__scxml_generate` with
`options.className=PipChannelSM`, copied to
`src/state-machines/modules/` + `dist/state-machines/modules/`.

CI: dropped the `--exclude "**/c0tp-c0as-c0tr-tm-isolation.test.ts"`
from `.github/workflows/test.yml`'s unit job now that the underlying
SCXML is correct. All 437 unit tests (434 pass + 3 skip + 0 fail) are
now part of the CI gate.

**3. Portable `.zip` installer + bundled Node runtime (`8462f3d`).**
`electron-builder` now emits a second artifact alongside the NSIS
setup:

- `HamiltonStarTwin-<version>-x64.zip` — unzip anywhere, no install.
- Runtime stage: `installer/build-installer.ps1` downloads
  `node-v22.11.0-win-x64.zip` once (cached under `installer/cache/`)
  and stages `node.exe` into the zip under `resources/runtime/`.
- `installer/README.portable.md` stages to the zip root via
  `extraFiles`.
- Launchers (`run-editor.bat`, `run-mcp.bat`) prefer the bundled
  runtime and fall back to system Node on PATH — the zip works on
  machines without Node.js.
- Release: `HamiltonStarTwin-0.2.0-x64.zip` (135 MB) uploaded to
  `snapshot-20260420-1543` via `gh release`.

**Test + build status at cycle close:**

- `npx vitest run tests/unit` → 434 pass / 3 skip / 0 fail (was 430
  pass / 4 fail / 3 skip on 2026-04-19).
- `npx vitest run tests/integration/fw-server.test.ts
  contamination-multichannel no-deck-effect-guard fw-bridge-asp-disp-volume`
  → 13/13.
- CI on `f645e7d`: `build + unit` ✅, `fw-integration` ✅. The two
  `continue-on-error` jobs (`visual` / `e2e-click-routing`) fail as
  designed — Windows-captured pixel baselines + Hamilton install not
  on the Linux CI image.

---

## 2026-04-19 cycle — renderer UX + real-VENUS robustness

Closed issues this cycle: **#54, #55 (part A), #56, #57, #58, #59,
#60, #61**. Full commit list in the order it landed:

```
e882960  ghost-head: dedicated placement tool + pointer-transparent ghost (#56)
71aee3b  renderer: fix Y-flip labels + drop PIP Z-badge + rebalance layout
45feaa2  renderer: screenToDeck for ghost drag/tool — fix Y-flip drag inversion
1303e2f  ghost menu: geometric hit-test fallback for right-click (pointer-events: none)
c50313e  header: theme the Cover toggle button + cover-open warning state (#59)
1c4627e  deck: render non-track fixtures from the loaded .dck (#57)
25b4e4e  deck-svg: carrier outlines + track numbers + readable labware badges (#58)
8dd9b37  deck: Space-to-pan + middle-click pan + Fit-to-content + F shortcut (#61)
e9ca766  renderer: listen for deck-loaded SSE and re-fetch + redraw (#60)
f185f63  venus-import: honor physical carrier width + drop invisible fixtures
1eaf549  docs: Phase 6 status — renderer UX round (#56-#61) closed
1f365d5  venus-import: read .ctr alongside .rck for well geometry (#55 part A)
1dcccae  scripted Stage-5 method runner (#54)
ad778c4  build: retry Dropbox-locked file copies (errno -4094 / UNKNOWN)
ec8b44c  venus-config: File menu + REST + MCP for explicit cfg loading
1702c8c  venus-import: accept carriers past the nominal track grid
9d598f9  deck-tracker: coordinate-only position resolution + inspector-fill tests
```

**Key design points locked in this cycle:**

- `resolvePosition` no longer has a carrier-rect gate. Scans every
  well on every labware, picks the closest match within
  POSITION_TOLERANCE (50 = 5 mm). Single-well labware (trough, waste)
  match by anchor-proximity scaled to the `.rck` footprint. This
  unblocked VENUS's C0TR at X=1340 mm which previously fell between
  the WasteBlock's track-derived xMax and its child labware's
  absolute X.
- `Deck.loadCarrier` accepts `±MARGIN_TRACKS=5` past `[1,
  totalTracks]` so fixture carriers on the margin rail (WasteBlock
  at track 55 on a 54-track deck) don't get silently dropped.
- `buildCarrierFromHamiltonTemplate` uses `ceil(dx / 22.5)` (not
  `round`) so a sub-track carrier rounds UP and covers its children.
- VENUS config (`.cfg`) loading is explicit-only — File menu /
  `POST /api/venus-config/load` / MCP `venus.loadConfig`. No
  auto-detect of the locally-installed ML_STAR.cfg.
- Scripted Stage-5 runner (`tests/helpers/venus-method.ts`) with
  three backends: `viaInProcess` (CI, synchronous), `viaTwinHttp`
  (integration), `viaVenusWebApi` (stubbed, throws until Hamilton's
  Web API handshake is pinned against a real box).
- Build now survives Dropbox file-lock races — `scripts/build-sm.js`
  and `scripts/build-assets.js` retry copyFileSync on UNKNOWN /
  EBUSY / EPERM with exponential backoff.

**Test-discipline additions:**

- `tests/integration/deck-geometry.test.ts` — 17 Y-flip / interaction
  invariants (ghost tool, drag, right-click menu, fixture loading,
  track numbers, SSE deck-loaded round-trip, Space+drag, Fit, wheel
  zoom clamp).
- `tests/integration/inspector-liquid.test.ts` — 3 tests: fill →
  click → inspector DOM; nudged-coord aspirate; Method1.lay aspirate.
- `tests/integration/stage5-real-venus.test.ts` — 2 tests driving
  the runner helper end-to-end.
- `tests/integration/venus-config-load.test.ts` — 3 tests for the
  explicit-opt-in cfg loading.
- `tests/unit/hamilton-ctr.test.ts` — 3 tests pinning `.ctr`
  parsing + Method1.lay ingestion + WasteBlock margin-track import.

**Known pre-existing failures (unchanged from prior cycle):**

1. `tests/integration/foundation-fixes.test.ts` — 2 liquid-class
   alias tests red.
2. `tests/integration/ghost-head-e2e.test.ts` #2 — tip-setup issue
   in the test fixture, unrelated to any twin code.

(`tests/unit/c0tp-c0as-c0tr-tm-isolation.test.ts` was red in prior
cycles — closed 2026-04-20 by the pip-channel SCXML isolation fix,
see that cycle's section below.)

---

## Earlier cycle — April 2026 foundation commits (on `master`)

All work described below landed as discrete commits. Use these SHAs to
diff against `16f2809` (the entry point for this cycle):

```
c15c361  SCXML: iSWAP rotation/grip + h96/h384 Z + autoload track; fix h384 FW params
b66ed31  Twin: VENUS config adapter + motion envelope Z/rotation/grip axes + --venus-cfg CLI
e0b6f48  Renderer: iSWAP plate group, per-arm Z badges, autoload carriage, per-channel Z
a70c8c5  docs: Phase 6 status rewrite + tutorial §5-8 for new fidelity + light-theme screenshots
272e67f  Reproducibility: regen 3 missing src SCXML modules + pixelmatch visual-regression (A.1+A.3)
01e7857  CI: GitHub Actions (unit + fw-integration + visual jobs) (A.2)
24c8d84  pip-physics: C0AS/C0DS envelope includes Z-traverse + Y-travel (B.1)
f12915c  Hot-swap deck: twin.setDeck + POST /api/deck/load + MCP deck.loadLayout + File menu
526412e  HxCfgFile: binary format parser (MFC CArchive) + TIP_ST/PLT_L5AC aliases
2526a66  venus-deck-importer: place labware by SiteId + override siteYOffsets from .lay
32edcc2  deck-svg: flip Y to match VENUS back-at-top convention
8435e61  Fix .lay labware resolution + widen deck bounds + Fit/Fill toggle
f233743  Revert CARRIER_Y_DIM widen — offsetY=0 already fixed the overflow
e8d35a1  deck-svg: labware-bg rect and well-grid use same offsets (|| → ??)
fd71a38  Read Hamilton .tml/.rck directly — kill the hardcoded template aliases
d2ad9d9  Tighten visual-regression threshold (2% → 0.3%) + regenerate baselines
09838f6  deck-svg: position-number labels on empty carrier sites
8b367e1  deck-svg: waste labware renders as solid block with WASTE glyph
c03acbd  Renderer: real .rck Dim.Dx/Dy/BndryY for labware body, not pitch estimates
```

**SCXML (`scxml/*.scxml`):**
- `autoload.scxml` — added `pos_track` / `target_track` datamodel + `<send delay>` timers.
- `iswap.scxml` — added `plate_rotation_deg`; grip width propagates from FW `gb`/`gw`/`go`; rotation from `gr`.
- `core96_head.scxml` — `C0EM`/`C0EP`/`C0ER`/`C0EA`/`C0ED` propagate pos_z from `za`/`zh`.
- `core384_head.scxml` — **critical bug fix:** was reading `yh`/`zh`; corrected to the real FW params `yk`/`je`/`zf` per `AtsMc384HeadMoveAbs.cpp`. Every C0EN had been silently rejected before.
- `temperature.scxml`, `core_gripper.scxml`, `heater_shaker.scxml` — now regenerated in `src/state-machines/modules/` (A.1). Clean-room `rm -rf dist && npm run build` now works end-to-end.

**Twin core (`hamilton-star-twin/src/twin/`):**
- `venus-config.ts` — HxCfgFil sectioned parser, MODULE_BITS / STATUS_BITS tables pinned to `CommonInternalDeclarations.h`, deck-inference rules, encoders for `C0QM`/`C0RM`/`C0RI`/`C0RF`/`C0RU`.
- `digital-twin.ts` — `MotionEnvelope` extended with optional `startZ/endZ`, `startRotation/endRotation`, `startGripWidth/endGripWidth`. `extractMotionEnvelope` carries those axes for pip/iswap/h96/h384 and emits `arm: "autoload"` envelopes for C0CL/C0CR. `VenusConfig` field + `setVenusConfig/getVenusConfig` API. C0CL/C0CR removed from always-accepted list (routed through SCXML now).
- `command-timing.ts` — C0CL=4500ms, C0CR=5500ms, C0CI=3000ms pinned to real-trace timings.
- `api.ts` — `getVenusConfig/setVenusConfig` passthrough.
- `src/api/server-setup.ts` + `src/headless/server.ts` + `src/main/main.ts` — `--venus-cfg <path>` CLI flag.

**Renderer (`src/renderer/`):**
- `state.ts` — added `animIswap{Y,Z,RotationDeg,GripWidth}`, `animH96Z`, `animH384{Y,Z}`, `animPipZ`, `animAutoloadX`, `autoloadParked`.
- `arm.ts` — envelope carries all 5 axes per arm; extra-axis writers pin Z/rotation/grip on envelope end; ease fallback for axes when no envelope.
- `deck-svg.ts` — iSWAP plate group (SBS 127.76×85.48 mm) with jaws + rotation tick, per-arm Z badges (green/amber), autoload carriage, h384 head rect.
- `channels.ts` — per-channel Y/Z readout + vertical depth bar + traverse tick + amber-highlight-when-engaged.
- `index.html` + `ui.ts` + `log.ts` + `renderer.ts` + `api.ts` + `style.css` — hide-C0TT checkbox in log panel; autoload substat on module card; arm-wide X/Zmax/Ztrav header on channel panel; `[data-theme="light"]` styling for the new elements.

**Tests + docs:**
- `tests/unit/venus-config.test.ts` — 16 tests (parser round-trip + encoder fixtures).
- `tests/integration/tutorial-screenshots.test.ts` — 13 tests, all asserting DOM state + server datamodel before writing the screenshot. **Now pixelmatch-gated** (A.3): defaults to update locally, compare in CI. Override via `VISUAL_COMPARE=1` / `VISUAL_UPDATE=1`. Diffs land in `test-results/visual-diff/`.
- `docs/TUTORIAL.md` — extended with new §5 (accurate arm motion — iSWAP plate, h96/h384 Z, autoload motion), §6 (per-channel X/Y/Z), §7 (log filter), §8 (full deck), §11 (test discipline references).
- `docs/tutorial-images/*.png` — 14 light-theme screenshots regenerated + 7 new. These PNGs ARE the pixelmatch baseline.
- `.github/workflows/test.yml` (A.2) — three parallel jobs (unit / fw-integration / visual). Visual job uploads `test-results/visual-diff/*.png` on failure.

## Fidelity work layered in this cycle

After the initial phase-6 write-up, these gaps closed:

| Axis | Before | After |
|---|---|---|
| iSWAP rotation | not tracked at all | `plate_rotation_deg` in datamodel, animated via envelope |
| iSWAP Z descent | tracked but not animated | `MotionEnvelope.{startZ,endZ}` for C0PP/C0PR/C0PM |
| iSWAP gripper jaws | not visualized | two jaw lines that close from `go` to `gb` width |
| 96-head Z | not in envelope | full X/Y/Z envelope + datamodel propagation |
| 384-head Y/Z | hardcoded 0 | full X/Y/Z via correct FW params (`yk`/`je`) — fixes silent rejection |
| Autoload carriage | no motion model | `pos_track`/`target_track` + motion envelope + carriage render |
| PIP per-channel Z | server-only | channel panel depth bar + amber-engaged highlight + deck Z badge |
| Discovery module bits | hardcoded `ka010301` | inferred from on-deck labware (`core96Head`, `headGripper`, etc.) |
| VENUS cfg adaptation | fully hardcoded | `--venus-cfg <path>` parses `ML_STAR.cfg` |
| Event log noise | unfiltered | hide-C0TT checkbox |

## What works today

| Stage | Proof |
|---|---|
| 1. Discovery | VENUS's "Discover Instruments" finds the twin as `MLSTARPipettor`. |
| 2. Payload bridge | Plain BDZ TCP transport (no FDx framing). Full init-query sequence accepted. |
| 3. Control Panel | Initialize Instrument, Move Pipetting Arm, Move Autoload, Prime all drive real FW commands; arm slider reflects the advertised X range. |
| 4. Method run | Real method (Initialize + Tip Pickup + Tip Eject) executes against the twin: `C0TP` + `C0TR` accepted with grip-force responses. VENUS reports "Execute method – complete" with zero errors. |

## How to reproduce

1. From `hamilton-star-twin/` → `npm run build`.
2. `node dist/headless/server.js --venus-bridge --bridge-host 0.0.0.0`
   (Electron app: `npm start` defaults bridge ON; `--no-bridge` opts out.)
3. In VENUS System Configuration Editor → add/pick the discovered `Hamilton STAR Digital Twin` as the active instrument. Header must read `Instrument: <twin name>`, **not** `Instrument: Simulation`.
4. In Method Editor → add **Initialize** step first, then pickup/eject/etc. Run.

## Gap list against VENUS UI (captured 2026-04-18, updated 2026-04-19)

Ordered roughly by user-perceived impact. Each line has a ticket — tackle in
whatever order the user prioritises, one at a time, with visual verification
before moving on.

| # | Gap | Ticket | Status |
|---|---|---|---|
| 1 | Ghost head always visible, blocks click-to-inspect on labware | [#56](https://github.com/miho/hamilton-star-digital-twin/issues/56) | ✅ **Closed** — e882960, 71aee3b, 45feaa2, 1303e2f. Tool mode + pointer-transparent children + dedicated drag handle + geometric right-click hit-test. |
| 2 | Tool zones not drawn | [#57](https://github.com/miho/hamilton-star-digital-twin/issues/57) | ✅ **Closed** — 1c4627e, f185f63. `.dck` non-track sites flow through `Deck.fixtures[]`; `Visible=0` sites are honoured. Core96SlideWaste carrier renders the big green park zone via physical `dimensions.dx`. |
| 3 | Carrier outline, labware labels, track numbers, FRONT/REAR labels | [#58](https://github.com/miho/hamilton-star-digital-twin/issues/58) | ✅ **Closed** — 25b4e4e. 5-px carrier outline (non-scaling), track numbers every 5 tracks, `formatLabwareBadge()` tags, FRONT/REAR at carrier-row edges. Light + dark themes. |
| 3.5 | Cover-closed button looked off-theme, couldn't click | [#59](https://github.com/miho/hamilton-star-digital-twin/issues/59) | ✅ **Closed** — c50313e. |
| 3.6 | Loading a `.lay` didn't actually re-render the deck | [#60](https://github.com/miho/hamilton-star-digital-twin/issues/60) | ✅ **Closed** — e9ca766, f185f63. Renderer now listens for `deck-loaded` SSE; MCP path also broadcasts. |
| 3.7 | Pan/zoom/fit UX felt clunky (Fit/Fill wasn't what users wanted) | [#61](https://github.com/miho/hamilton-star-digital-twin/issues/61) | ✅ **Closed** — 8dd9b37. Space-to-pan, middle-click pan, F shortcut, `fitToContent()`, 0.05-3× zoom range. |
| 4 | `Y_FRONT` / `CARRIER_Y_DIM` / `totalTracks` hardcoded in `deck-svg.ts` + `deck.ts` | [#55](https://github.com/miho/hamilton-star-digital-twin/issues/55) | ✅ **Closed** — 9165a2e. Constants exported from `deck.ts` once; `DeckSnapshot.dimensions` carries platform bounds; renderer (deck-svg/arm/deck-interact) reads from snapshot. `POSITION_FALLBACK_Y_REAR` disambiguates the 4530 heuristic from the 5600 physical rear edge. |
| 5 | `.ctr` (container) files not read — wellDepth, cone angle, dead volume still zero | [#55](https://github.com/miho/hamilton-star-digital-twin/issues/55) | ✅ **Closed** — b08cbf5. `readContainerDefinition()` is called by `venus-deck-importer` when a Hamilton install is on disk; the `.ctr` parser bug (shape=3 treated as conical) is fixed; and 11 catalog entries are now baked with real `.ctr`-derived wellDepth / maxVolume / hasConicalBottom (tests/unit/ctr-bakeout.test.ts pins the contract against the source files). Catalog-fallback path delivers the same fidelity as the .tml-based path. |
| 6 | Retire `CARRIER_TEMPLATES` / `LABWARE_TEMPLATES` entirely | [#55](https://github.com/miho/hamilton-star-digital-twin/issues/55) | ✅ **Closed** — 9165a2e + 390b5d9. `labware-catalog.ts` + `carrier-catalog.ts` are the only sources of geometry; `LABWARE_TEMPLATES` / `WELL_GEOMETRIES` / `CARRIER_TEMPLATES` all deleted. Default deck, venus-deck-importer fallback, and venus-steps.LoadCarrier all route through the catalogs. .dck-based synthesis is a future nicety, not blocking. |
| 7 | Stage-5 regression still driven by Method Editor clicks | [#54](https://github.com/miho/hamilton-star-digital-twin/issues/54) | ✅ **Closed** — stub-backed runner helper landed (`tests/helpers/venus-method.ts` with `viaInProcess` / `viaTwinHttp` / `viaVenusWebApi`). Live Web API backend is follow-up work tracked under **Milestone B.x** below. |

The visual-regression suite catches rendering changes at 0.3% pixel-drift
(d2ad9d9). Any fix to the above MUST regenerate `docs/tutorial-images/`
baselines as part of the same commit — else future changes go undetected.

**Interaction tests** live in `tests/integration/deck-geometry.test.ts`
(17 tests covering Y-flip invariants, ghost tool, drag, right-click menu,
#57 fixture loading, #58 carrier outlines, #59 cover button, #60 SSE
deck-loaded round-trip, #61 Space+drag / Fit / wheel-zoom clamp). These
are ordinary vitest + Playwright tests — NOT gated by the pixelmatch
threshold — so small-label Y-flip regressions can't slip past them.

## Key prior-cycle commits (on `master`)

```
3ba162e  SCXML: idempotent re-init + iSWAP park on method repeats
082a3c7  Rename fdx-bridge → bdz-bridge, drop unused FDx framing code
520140e  Arm visualization: propagate master C0KX/C0KR to pip/iswap pos_x
a64706b  Real-VENUS compatibility: BDZ discovery + FW TCP bridge + protocol fixes
```

This cycle's commits are listed above under "This cycle's commits".

## Protocol fixes pinned against real traces

Every non-trivial response in `src/twin/digital-twin.ts` is pinned with a
line reference to a real VENUS ComTrace recording under
`VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/`. Values to keep
stable:

- `C0QM`: `xw13400` (not derived from tracks — VENUS deck cfg cross-checks);
  `ka010301` (minimal instrument, no 96-head — flip bits on if the user's deck
  advertises those modules with their default-waste labware).
- `C0QC`: `qc1 = closed / qc0 = open` (inverted from the obvious; VENUS
  `OnOffType` has `Off=0, On=1` and `RunLockFrontCover.cpp:125` raises the
  error on `coverState == Off`).
- `C0RU`: `ru00950 13400 30000 30000` (single-arm STAR — right arm min==max
  signals "not installed").
- `C0QS`, `C0RT`, `C0RJ`: 8 channels, not 16 (matches `kp08`).
- Sub-device replies: bare `erNN` for writes, `<fields>` for queries.
- `PXAF` is a WRITE ack → `er00`, NOT a field echo.

## SCXML discipline

Edits go to `scxml/*.scxml`, regenerated via **`mcp__plugin_vscxml_vscxml__scxml_generate`** (or `npm run build:sm` if the generator CLI is running on :48620). Pass `options: { className: "<ExistingName>" }` so the output filename matches the existing `module-registry.ts` requires. Never hand-edit generated JS.

Re-init transitions added on every module so VENUS's repeat-init pattern
works:

- `master.scxml`: all five init verbs enter from `sys_off`; self-loop in
  `sys_initializing` + `sys_ready`.
- `autoload.scxml`: `C0II` self-loops in `idle_al`.
- `pip_channel.scxml`: `C0DI` self-loops in `idle`.
- `core96_head.scxml`: `C0EI` self-loops in `idle`.
- `iswap.scxml`: `C0FI` in both `ready` and `parked`; `C0PG` in `parked`.

## Known test failures

Two integration tests remain red — investigate only if touching the
surrounding area:

1. `tests/integration/foundation-fixes.test.ts` — 2 liquid-class-alias
   tests fail. Naming-convention issue, not motion/twin.
2. `tests/integration/ghost-head-e2e.test.ts` — 1 test fails on a
   menu-click chain. UI-routing issue.

Everything else in `tests/unit` (434 tests pass, 3 skipped, 0 failing
as of 2026-04-20) + the integration tests we added this cycle
(`venus-config` 16, `tutorial-screenshots` 13) pass. CI's unit job no
longer excludes the c0tp/c0as/c0tr isolation suite — see the
2026-04-20 cycle below.

## Backlog — consolidated with external-report issues

### Milestone A — reproducibility gate ✅ done

**A.1 · Regenerate the 3 missing SCXML modules in src — ✅ done**
- Regenerated `temperature-s-m.js`, `co-re-gripper-s-m.js`, `heater-shaker-s-m.js` via VSCXML MCP with matching classNames (`TemperatureSM`, `CoReGripperSM`, `HeaterShakerSM`).
- Fixed latent `build:sm` bug: script now `mkdirSync({recursive:true})` the target dir so a clean-room build works from an empty `dist/`.
- Verified: `rm -rf dist && npm run build && npx vitest run tests/unit --exclude "**/c0tp-c0as-c0tr-tm-isolation.test.ts"` → 358 pass.
- Also removed stale tracked `dist/state-machines/*` files that the current build never produces (old generator layout).

**A.2 · GitHub Actions CI — ✅ done**
- `.github/workflows/test.yml`: three parallel jobs on `ubuntu-latest`, Node 22:
  - `unit` — `npm ci && npm run build` + unit suite (excluding the known-red isolation test).
  - `fw-integration` — `fw-server.test.ts` + `fw-trace-replay.test.ts`.
  - `visual` — Playwright chromium + `tutorial-screenshots.test.ts` with `VISUAL_COMPARE=1`, uploads `test-results/visual-diff/*.png` on failure.
- Triggers on push to `master` + all PRs.

**A.3 · Visual-regression baseline — ✅ done**
- `tutorial-screenshots.test.ts` now diffs each render against the committed PNG via `pixelmatch` (per-pixel YIQ threshold 0.15, total-pixel ratio limit 2%).
- Mode is env-driven: `VISUAL_UPDATE=1` writes baselines (default when `CI` is unset); `VISUAL_COMPARE=1` fails on divergence (default in CI). Scripts: `npm run test:visual` and `npm run test:visual:update`.
- Verified: `npm run test:visual` → 13/13 pass locally; on injected divergence the actual + diff PNGs land in `test-results/visual-diff/`.

### Milestone B — finish real-VENUS (P0 feature)

**B.1 · Stage 5 — aspirate + dispense method run — ✅ done**
- Real VENUS 6.0.2 drove Init → Pickup → Aspirate → Dispense → Eject end-to-end. Observed via SSE capture (\`/tmp/b1-stage5/run3.log\`): all motion-bearing commands accepted, TADM curves generated for C0AS and C0DS, no \`er15\` rejections. Twin's physics-based tip tracking caught a real-hardware behavior on the second run (re-using the same tip rack well returned \`er75 TPD reports no tip\` — the same error a physical STAR would raise).
- Two visual fidelity bugs exposed and fixed in this cycle:
  - \`24c8d84\` pip-physics: \`_delay\` for C0AS/C0DS now includes Z-traverse + Y-travel, not just pump time. Zero-volume steps (VENUS's default on untouched steps) no longer collapse to a 100ms snap.
  - \`b66ed31\` extractMotionEnvelope already covered iSWAP Z on C0PG; confirmed live-firing on the fresh twin (pre-cycle twin was running stale binaries).
- Hot-swap deck loader (\`f12915c\`) — \`twin.setDeck\`, \`POST /api/deck/load\`, MCP \`deck.loadLayout\`, Electron File → Load deck layout… — added so Stage-5 retests can point the twin at a customer's \`.lay\` without restarting VENUS's TCP connection.

**B.2 · `--venus-cfg` validated against a real ML_STAR.cfg**
- Parser + encoder unit-tested this cycle but never driven by live VENUS.
- Accept: VENUS 6.0.2 init passes with the user's cfg + 2 different decks
  (54-track with core96-head, 30-track STARlet).
- Follow-up filed: [#55](https://github.com/miho/hamilton-star-digital-twin/issues/55) — extend the parser to also ingest `.lay` / `.rck` / `.ctr` so the twin's deck + labware + well geometry tracks VENUS's config directory verbatim, not just the instrument cfg.

**B.x · Script-driven Stage-5 regression** (filed, not started)
- [#54](https://github.com/miho/hamilton-star-digital-twin/issues/54) — wire HSL codegen / HxRun / COM-or-Web-API so Stage-5 aspirate + dispense regression doesn't require manual Method-Editor clicks between every twin change. Either option gives us a vitest-level \`runVenusMethod(...)\` helper and a CI-skippable \`stage5-real-venus.test.ts\`.

**B.3 · Aspirate/dispense parameter fidelity** (P1, from external report)
- Current PIP SCXML handles basic C0AS/C0DS. Real VENUS also carries:
  `wt` (settling), `pp` (pull-out), `zt` (per-phase Z), `aa` (second phase),
  `cm` (cLLD mode), `pd` (pressure LLD).
- Pin each to its `AtsMcAspirate.cpp` line + a real-trace value, same
  discipline as C0QM.

### Milestone C — coverage + refactor (P1)

**C.1 · 384-head + heater-shaker runtime-surface expansion**
- h384: add `C0JW` (wash), `C0JU` (verify existing), `C0JF`/`JT` (flow/pressure).
- Heater-shaker: SCXML is thin; cross-reference JSON spec
  `hamilton-star-digital-twin.json:10839+` and wire missing transitions.

**C.2 · Split `digital-twin.ts` (1758 LOC)**
- Target files under `src/twin/twin/`: `command-router`, `canned-responses`,
  `motion-envelope`, `snapshot-restore`, `assessment-orchestrator`. Facade ≤ 400 LOC.

**C.3 · `any` cleanup**
- Top offenders: `rest-api.ts`, `deck-interact.ts`, `protocol.ts`, `digital-twin.ts`, `api.ts`.
- Introduce typed command-payload interfaces per FW command family.

### Milestone D — platform hardening (P2)

**D.1 · Single-source-of-truth for FW command registry**
- Today: SCXML + `module-registry.ts` event maps + `digital-twin.ts` always-accepted list + JSON spec + docs describe the same commands in 4 places.
- Codegen the event routing table + always-accepted list from SCXML + JSON.

**D.2 · Split `venus-steps.ts` (1765 LOC)**
- Per step family: tips / pipetting / transport / utility / power.

**D.3 · Phase-doc auto-consolidation**
- Generate single `docs/STATUS.md` from per-phase frontmatter + code introspection.

**D.4 · iSWAP plate dimensions from held-plate labware**
- Today the renderer uses the SBS 127.76×85.48 mm standard. Should come
  from the plate the iSWAP actually grabbed (carry plate labware ref
  through C0PP into iSWAP datamodel).

## Original phase-6 backlog (pending)

### P0 — Stage 5: aspirate + dispense method

Next real-method test. Add one Aspirate step + one Dispense step to the
method, run. Expect new FW commands: `C0AS` (aspirate), `C0DS` (dispense),
pressure / TADM reads (`C0RD`, `C0RL`, `C0RY`). Any rejection gets fixed the
same way the pickup/eject cycle did — find the SCXML transition, add
self-loop or idempotent handling, regenerate.

### P1 — VENUS config auto-adapter (`--venus-cfg <path>`)

Parse the user's `ML_STAR.cfg` + deck `.lay` at startup, extract the fields
VENUS cross-checks on init, and plug them into the twin's FW responses
verbatim so the twin becomes a chameleon.

Covers the existing whack-a-mole sources:
- `xt`/`xa` (track counts) from the deck config.
- `xw` (special-eject X) from the deck.
- `ka`/`ke` bits from whichever modules the user has carriers for.
- `bdc_modulenumber` (serial) from the instrument cfg.

Approach:
- HxCfgFil parser — plain text, `DataDef,<name>,<version>,<variant>,{` …
  `key, "value",` … `};`. Strip `*` line comments. Already have
  `VENUS-2026-04-13/Vector/src/HxCfgFil/Code/` as C++ reference.
- Extend `venus-layout.ts` to infer module presence from on-deck labware
  (96-head waste labware → set `core96Head` bit, etc.).

### P1 — Fix SSE `motion` event broadcast on VENUS-bridge path

In-process API test showed the motion envelope fires correctly for C0KX with
`{arm:'pip', startX:0, endX:6500, durationMs:700}`. During the live
VENUS-bridge run, SSE subscribers received `command-result` / `state-changed`
/ `tracking-changed` but **not** `motion`. User has confirmed the arm
animates with trajectory visible so the broadcast is reaching the renderer
in practice — something about my test-client timing was off. Verify during
next session by grepping `/events` output while a `C0KX` is in flight.

### P2 — #7 Autoload visualization

Twin accepts I0 / C0-prefixed autoload commands but the renderer has no
carriage indicator. Add a sidebar display or a small marker on the deck
front edge showing current autoload Y + carriers-on-deck.

### P2 — FDx log-line prefix mismatch

`server-setup.ts:log(\`FDx server listening on ${host}:${fwServer.port}\`)`
still says "FDx" while `fw-server.ts` itself prints `fw-server listening`.
Cosmetic. Fix to "FW server listening" for consistency with the rename.

### P2 — Renderer command-log filter toggle

The C0TT flood (68 tip-type registrations per method load) dominates the
renderer's command-log panel. Add a checkbox to hide `C0TT` lines.

## Cold-resume recipe

```bash
# 1. Orient
cat hamilton-star-twin/docs/PHASE-6-STATUS.md   # this file
git log --oneline -10                            # recent commits
cat hamilton-star-twin/docs/PHASE-STATUS.md      # phase 5 + prior

# 2. Check the twin still builds + tests pass
cd hamilton-star-twin
npm run build
npx vitest run tests/unit tests/integration/fw-server.test.ts tests/integration/fw-trace-replay.test.ts

# 3. Boot the bridge
node dist/headless/server.js --venus-bridge --bridge-host 0.0.0.0
# Expect: "fw-server listening on 0.0.0.0:9999" + "Discovery advertising…"

# 4. Pick a task from "Phase 6 backlog" above.
```

## GitHub-issue state (consolidated 2026-04-20)

Issues closed in this consolidation pass (commit `c38b567` / doc,
closeouts via `gh issue close`):

| # | Title | Closed per |
|:-:|---|---|
| #33 | Trace format & event spine | Phase 1 closeout `d58f0a5` · `docs/PHASE-1-REPORT.md` |
| #34 | Bridge unresolved interactions into assessment | Phase 1 closeout `d58f0a5` |
| #43 | Twin state serialization / session endpoints | Phase 1 closeout `d58f0a5` |
| #44 | Service architecture (twin core / recorder / replay / MCP) | Phase 2 closeout `a84f66c` · `docs/PHASE-2-REPORT.md` |
| #36 | Event lifecycle classifier | Phase 3 `ce6bead` · `docs/PHASE-3-REPORT.md` |
| #37 | Spatial event annotation on deck SVG | Phase 3 `174fd3d` |
| #38 | Replay & analysis service | Phase 3 `ce6bead` + `17a52a4` + `174fd3d` |
| #41 | Well inspector | Phase 3 `174fd3d` |
| #35 | Collision detection plugin | Phase 4 closeout `bce6e1d` · `docs/PHASE-4-REPORT.md` |
| #39 | Advanced physics observations (foam/drip/meniscus) | Phase 4 closeout `bce6e1d` |
| #40 | Report generation (text/HTML/CSV) | Phase 4 closeout `bce6e1d` |
| #45 | VENUS protocol bridge | Phase 5 `55fa57b`; Phase 6 live-validated against VENUS 6.0.2 |
| #62 | Zoom cursor drift + instantaneous asp/disp | `1c9b062` + `9242f66` (zoom) / `24c8d84` + `eb16f8d` + `6e50b57` + `ab41408` (asp-disp) / `e2e5962` (2026-04-20 envelope smoothness) |

Still-open issues after consolidation:

| # | Title | Notes |
|:-:|---|---|
| [#42](https://github.com/miho/hamilton-star-digital-twin/issues/42) | PSI umbrella | Stays open while any PSI follow-up work is in flight. |
| [#13](https://github.com/miho/hamilton-star-digital-twin/issues/13) | VENUS step layer — separate SW module | Subsumed by `venus-steps.ts`; close pending the D.2 split. |
| [#46](https://github.com/miho/hamilton-star-digital-twin/issues/46) | Trajectory preview (full planned motion path) | Enhancement. Adjacent to envelope emitter — cheap to layer on after `extractMotionEnvelope` pip fixes landed. |
| [#47](https://github.com/miho/hamilton-star-digital-twin/issues/47) | **Epic: Hardware profiles (MPH96 / MPH384 / PIP+gripper)** | Epic, children #48-#53. |
| [#48](https://github.com/miho/hamilton-star-digital-twin/issues/48) | `hardwareProfile` in TwinConfig + conditional module instantiation | Child of #47. |
| [#49](https://github.com/miho/hamilton-star-digital-twin/issues/49) | Head-aware channel sidebar (8 / 96 / 384 grids) | Child of #47. |
| [#50](https://github.com/miho/hamilton-star-digital-twin/issues/50) | Head-aware context menu (h96 / h384 asp + disp) | Child of #47. |
| [#51](https://github.com/miho/hamilton-star-digital-twin/issues/51) | Ghost head mode switch | Child of #47. |
| [#52](https://github.com/miho/hamilton-star-digital-twin/issues/52) | Arm-rail mutual-exclusion & multi-head conflict detection | Child of #47. |
| [#53](https://github.com/miho/hamilton-star-digital-twin/issues/53) | Hide unused arm rails per hardware profile | Child of #47. |

Backlog items in Milestones B/C/D below are NOT tracked as individual
GitHub issues yet. File as-needed when one is picked up; don't bulk-file
to avoid noise.

## Notes for the next AI / engineer

- The VENUS source tree at `VENUS-2026-04-13/` is the ground truth for every
  protocol question. Parsers live in `Vector/src/HxTcpIpBdzComm/CODE/Shared/`
  (BDZ transport) and `Vector/src/HxFDxProtocol/Code/` (RS232 FDx — we don't
  speak this). Per-command semantics live in
  `Star/src/HxAtsInstrument/Code/AtsMc*.cpp` (instrument-controller layer)
  and `Star/src/HxGruCommand/code/Run*.cpp` (method-step layer).
- Real ComTrace recordings at
  `VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/**/*.trc` are
  the test vectors we pin responses against.
- User hates whack-a-mole. When you hit a new VENUS-expected field,
  preference is: find the real-trace line, pin the value, commit.
- SCXML init-state pattern is now fixed across all modules. If a new
  command rejects with `er15`, it's almost certainly missing a
  state-specific transition in the target module's SCXML.
- Changes that affect user-facing wire format MUST also update the
  corresponding trace-replay test so regressions get caught.
