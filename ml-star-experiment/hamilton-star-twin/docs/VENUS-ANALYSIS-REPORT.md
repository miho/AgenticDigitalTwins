# VENUS Data & Traces Deep Analysis Report

**Date:** 2026-04-16
**Scope:** Complete analysis of VENUS C++ source, FW traces, HSL scripts, SCXML state machines, physics plugins, step layer, and test coverage — compared against Hamilton STAR Digital Twin implementation.

---

## Table of Contents

1. [Project Inventory](#1-project-inventory)
2. [FW Command Parameter Accuracy](#2-fw-command-parameter-accuracy)
3. [Trace Analysis vs Twin Behavior](#3-trace-analysis-vs-twin-behavior)
4. [SCXML State Machine Analysis](#4-scxml-state-machine-analysis)
5. [Physics Plugin Accuracy](#5-physics-plugin-accuracy)
6. [VENUS Step Layer Accuracy](#6-venus-step-layer-accuracy)
7. [Test Coverage Analysis](#7-test-coverage-analysis)
8. [Inconsistencies Found](#8-inconsistencies-found)
9. [Recommendations](#9-recommendations)

---

## 1. Project Inventory

### VENUS C++ Source (9,654 files)

| Component | Files | Key Modules |
|-----------|-------|-------------|
| Star | 2,943 | HxGruCommand (1,550), HxAtsInstrument (946), HxGRUCompCmd (253), HxStarLiquid (82) |
| Vantage | 2,436 | Pipettor (2,213), EntryExit (112), TrackGripper (111) |
| Vector | 3,864 | Instrument control core & UI framework |
| Nimbus | 358 | Nimbus-96 (170), Nimbus-8 (156), Common (32) |
| Modules/Transport | 52 | IPG, LabLync |

### VENUS Traces (152 files)

Location: `VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/`

- **15 Star ComTrace/HxUsbComm traces** from instrument SN559I
- **30 Vantage traces** from SN509, SN516, SN1736
- Total: **4,188 FW commands sent + 4,188 responses** across Star traces
- **106 unique FW command codes** observed

### VENUS HSL Scripts (86 files)

Location: `STAR VENUS INFO ML API/venus_training/`

- 01 Basic Training: Method, Sequence, Transport, Sub-Method, ErrorHandling, FileHandling, MappingFile
- 02 Advanced Training: Datamanager, ThreeLayer Architecture, Scheduler, Final Exam
- 04 HSL Training: ASWStandards, AppConfig, INI File, SQL Database, Integration Examples

### VENUS Layout Files (1,693 files)

Distributed across Star, Vantage, Nimbus components. 16 training-specific layouts.

---

## 2. FW Command Parameter Accuracy

### C0AS (Aspirate) — CRITICAL DIFFERENCES

**VENUS C++ source (AtsMcAspirate.cpp): 45 parameters**

| # | Tag | Width | VENUS Name | In Twin? | Notes |
|---|-----|-------|-----------|----------|-------|
| 1 | id | 4 | uniqueOrderId | YES | |
| 2 | at | 1 | aspirationType | NO | Always 0 in traces |
| 3 | tm | 1 | activeTip | YES | Channel bitmask |
| 4 | xp | 5+5 | xPosition | YES | Special multi-channel encoding |
| 5 | yp | 4 | yPosition | YES | Per-channel array |
| 6 | th | 4 | minTraversHeight | NO | Z traverse safety |
| 7 | te | 4 | minZPosition | NO | Z transport end |
| 8 | lp | 4 | lldSearchHeight | NO | LLD search start |
| 9 | ch | 3 | clotRetractHeight | NO | Clot retract distance |
| 10 | zl | 4 | fluidHeight | NO | Estimated fluid Z |
| 11 | zx | 4 | zMinHeight | NO | Z minimum search |
| 12 | ip | 4 | submergeDepth | NO | Immersion below surface |
| 13 | it | 1 | submergeDirection | NO | Direction flag |
| 14 | fp | 4 | followDistance | NO | LLD follow distance |
| 15 | av | 5 | aspirationVolume | YES | 0.1uL units |
| 16 | as | 4 | aspirationFlowRate | YES | uL/s from liquid class |
| 17 | ta | 3 | airTransportVolume | YES | From liquid class |
| 18 | ba | 4 | blowOutVolume | YES | From liquid class |
| 19 | oa | 3 | overAspirateVolume | NO | |
| 20 | lm | 1 | lldMode | YES | 0=off, 1=cLLD, 2=pLLD |
| 21 | ll | 1 | lldSetting | NO | LLD sensitivity 1-4 |
| 22 | lv | 1 | presureLldSettings | NO | pLLD settings |
| 23 | ld | 2 | differenceDualLld | NO | Dual LLD delta |
| 24 | de | 4 | swapSpeed | NO | Named "de" but actually swap speed |
| 25 | wt | 2 | settlingTime | YES | Settle time |
| 26 | mv | 5 | mixVolume | YES | Optional mixing |
| 27 | mc | 2 | mixCycles | YES | Optional mixing |
| 28 | mp | 3 | mixPosition | NO | Mix Z position |
| 29 | ms | 4 | mixFlowRate | NO | Mix speed |
| 30 | gi | 3 | limitCurveIndex | NO | TADM curve ID |
| 31 | gj | 1 | tadmAlgo | NO | TADM algorithm |
| 32 | gk | 1 | recMode | NO | Recording mode |
| 33 | zu | 4 | lastSegmentHeight | NO | Last segment Z |
| 34 | zr | 5 | lastSegmentDiamRatio | NO | Container shape |
| 35 | mh | 4 | mixFollowDistance | NO | |
| 36 | zo | 3 | touchofDistance | NO | Touch-off distance |
| 37 | po | 4 | aspAirRetractDist | NO | Air retract |
| 38 | lk | 1 | secondPhaseAsp | NO | 2nd phase flag |
| 39 | ik | 4 | retractDist | NO | 2nd phase retract |
| 40 | sd | 4 | emptyFlowRate | NO | 2nd phase speed |
| 41 | se | 4 | searchFlowRate | NO | 2nd phase search |
| 42 | sz | 4 | zSpeed | NO | Z axis speed |
| 43 | io | 4 | accessHeight | NO | 2nd phase access |
| 44 | il | 5 | ratioTipCup | NO | 2nd phase ratio |
| 45 | in | 4 | submergeDepth2 | NO | 2nd phase immerse |

**Twin sends 11 of 45 parameters.** The SCXML processes these 11 correctly. The remaining 34 are Z-positioning, LLD config, TADM config, 2nd-phase aspirate, and mixing position parameters that the SCXML does not use for state transitions.

### C0DS (Dispense) — Similar Gap

**VENUS: 37 parameters. Twin sends 7.**

Key missing: dm (dispense mode), zx, lp, zl (Z positions), ip/it/fp (immersion), ss (stop flow), rv (stop back volume), ba (blowout), lm/ll/lv (LLD), gi/gj/gk (TADM), zu/zr (container shape), dj (side-touch), mh (mix follow), po (retract). The twin does send dm correctly.

### C0TP (Tip Pickup) — Close Match

**VENUS: 9 parameters. Twin sends 5 (xp, yp, tm, tt, id).**

Missing: tp (Z start), tz (Z end), th (traverse height), td (tip detection method). These affect Z safety but not the pickup logic itself.

### C0TR (Tip Eject) — Close Match

**VENUS: 9 parameters. Twin sends 4 (xp, yp, tm, id).**

Missing: tp, tz, th, te (Z positions), ti (access height).

### 96-Head Commands — DIFFERENT TAG NAMES

**CRITICAL:** The 96-head uses completely different parameter tags than PIP channels:

| Function | PIP Tag | 96-Head Tag | 384-Head Tag |
|----------|---------|-------------|--------------|
| Volume | av | af | jf |
| Speed | as | ag | jg |
| Position X | xp | xs | xs |
| Position Y | yp | yh | yk |
| Traverse Z | th | zh | zf |
| Tip mask | tm (binary) | cw (24-hex) | N/A |
| Dispense mode | dm | da | ja |

The twin's venus-steps.ts correctly uses `af`/`ag` for 96-head and the appropriate tags for each module.

### iSWAP — GetPlate vs PutPlate Asymmetry

**C0PP (GetPlate): 15 params.** Includes gw (grip strength), gb (plate width), gt (tolerance).
**C0PR (PutPlate): 12 params.** Omits gw, gb, gt (doesn't need to measure, just releases).
**C0PM (MovePlate): 11 params.** Adds xe (X acceleration factor).

The twin's step layer correctly omits grip params from PutPlate.

---

## 3. Trace Analysis vs Twin Behavior

### Command Sequencing — IMPORTANT FINDING

Real VENUS traces show a strict command sequencing pattern that the twin step layer partially reproduces:

**Real VENUS single aspirate sequence:**
```
C0RX → C0TP → C0RT → C0RT → C0RX → C0AS → C0RX
```

**Twin step layer `easyAspirate`:**
```
C0TP → C0AS
```

**Missing intermediate commands:** `C0RX` (read X position) and `C0RT` (read tip status) are verification/safety queries. VENUS always:
1. Reads X position before any move (`C0RX`)
2. Verifies tip pickup succeeded (double `C0RT` check)
3. Reads X position after each operation

The twin accepts these commands (they're in the always-accepted list) but the step layer doesn't emit them. This means:
- **Functional parity:** Correct — the twin doesn't need verification of its own virtual state
- **Trace replay compatibility:** Correct — `C0RX`/`C0RT` are accepted and return valid data
- **Protocol fidelity:** Gap — if someone expects the same number of commands as real VENUS, the twin is leaner

### Timing Analysis from Traces

| Command | Trace Timing | Twin Timing (computed) | Twin Timing (estimate) | Match? |
|---------|-------------|----------------------|----------------------|--------|
| C0DI (init) | ~55s | 3000ms | 3000ms | **WAY TOO FAST** |
| C0TP (tip pickup) | 7-9s | ~700ms | ~700ms | **TOO FAST by ~10x** |
| C0AS (aspirate) | 10-13s | varies (correct) | varies | Reasonable for liquid phase |
| C0DS (dispense) | 6-12s | varies (correct) | varies | Reasonable for liquid phase |
| C0TR (tip eject) | 7-8s | ~530ms | ~530ms | **TOO FAST by ~10x** |
| C0PP (iSWAP pick) | ~17s | ~2200ms | ~2200ms | **TOO FAST by ~8x** |
| C0PR (iSWAP place) | ~9s | ~2200ms | ~2200ms | **TOO FAST by ~4x** |
| C0CO (cover open) | ~1s | N/A | N/A | |
| C0AW (arm wait) | 0.3-0.4s | N/A | N/A | |
| Simple queries | 15-30ms | 50ms | 50ms | Close |

**Key finding:** The twin's timing estimates are 4-10x too fast for mechanical operations (tip pickup, eject, iSWAP). The liquid handling phase timing (volume/speed) is more accurate. The real instrument includes significant X/Y travel time, Z descent/retract with safety checks, and sensor verification that the twin timing model underestimates.

### Tip Table Upload (C0TT)

Real traces show massive C0TT bulk uploads (~68 commands) during initialization, defining liquid class parameters for the FW. The twin accepts C0TT (in always-accepted list) but doesn't process the parameters — liquid classes are handled internally via `liquid-classes.ts`.

### Error Handling

Only 1 error observed across 4,188 trace commands: `P5 er00 sm Tip Pick Up Error 78` — a deliberate test scenario. The twin generates appropriate error codes (7=tip already fitted, 8=no tip, 9=no carrier, 19=temp out of range, 22=no element, 27=Z not safe) matching VENUS error conventions.

---

## 4. SCXML State Machine Analysis

### Module Coverage: 10 modules, 12 SCXML files

| Module | States | FW Events | History? | Guard Conditions | Accuracy |
|--------|--------|-----------|----------|------------------|----------|
| Master | 4 flat | 55+ | No | None | Good |
| PIP | 7 nested | 29 | Deep | Z-traverse, X-range | Excellent |
| 96-Head | 7 nested | 14 SCXML / 20 registry | Deep | Y-range | Good |
| 384-Head | 7 nested | 13 | **No** | Y-range | Gap (see below) |
| iSWAP | 5 nested | 20 | No | Plate presence | Good |
| AutoLoad | 7 flat | 20 | No | Carrier count | Good |
| Wash | 5 flat | 6 | No | Fluid level | Good |
| Temperature | 4 flat | 4 | No | Temp range | Good |
| Gripper | 5 nested | 7 | No | Plate presence | Good |
| HHS | 6 flat | 23 | No | Temp range | Good |

### Issues Found

1. **384-Head Missing History Pseudo-State:** PIP and 96-Head both use deep history to restore tip state after movement. The 384-Head does NOT. After `C0EN` (move), it returns to `idle384` directly, which would reset to `no_tips384` even if tips were loaded. This is a **state logic bug** if 384-head move-then-dispense sequences are used.

2. **96-Head Registry/SCXML Mismatch:** The module registry registers `C0EU, C0EF, C0EW, C0ES, C0EE` (96-head washer commands) but these have no transitions in `core96_head.scxml`. They're silently absorbed by the always-accepted path. This is functional but not clean.

3. **5 Generated JS Files Only in dist/:** iSWAP, AutoLoad, Temperature, 384-Head, CO-RE Gripper, and HHS generated JS files exist only in `dist/` (not in `src/state-machines/modules/`). The build copies them, but this creates a fragile build dependency.

4. **deck_slot.scxml Not Used:** Has no generated JS and isn't in the module registry. It's a conceptual model for deck positions that could be useful for autoload simulation.

5. **system_orchestrator.scxml Outdated:** Uses a `<parallel>` composition with simplified versions of all modules. The production twin uses separate per-module executors instead. This file is documentation only but could drift from reality.

### Datamodel Variable Coverage

**PIP (26 variables)** — Most complete. Tracks per-channel: tip_fitted, tip_type, volume, pos_x/y/z, last_lld_height. Also: tadm_status, dispense_fly_active, multi_dispense_cycles/dx.

**96-Head (7 variables)** — Simpler because all 96 channels move as a unit: tips_fitted (boolean), tip_type, volume_01ul, pos_x/y/z, y_min/y_max.

**Master (12 variables)** — System-level: instrument_initialized, left/right arm X, cover/light state, error codes.

---

## 5. Physics Plugin Accuracy

### Accuracy Scorecard

| Plugin | Motion | Volume | Sensors | Assessment | Timing | Overall |
|--------|--------|--------|---------|------------|--------|---------|
| PIP | A | B+ | B | A | A- | **A-** |
| 96-Head | B | C | F | D | B | **C+** |
| 384-Head | D | C | F | D | D | **D+** |
| iSWAP | B | N/A | C | F | B | **C** |
| Temperature | D | N/A | N/A | B | D | **D** |
| Wash | N/A | B+ | N/A | B | C | **B-** |
| HHS | D | N/A | N/A | B | C | **C-** |

### Critical Issues

#### ISSUE 1: Temperature Ramp Rates 10x Too Fast (temperature-physics.ts AND hhs-physics.ts)

```
Code comment: "Heating rate: ~2-3 C/min"
Code constant: HEATING_RATE = 5 (= 0.5 C/s = 30 C/min)
```

A 22C→70C ramp takes **96 seconds** in the twin but **~15-25 minutes** on real hardware. The code's own documentation contradicts its constants.

**Fix:** `HEATING_RATE = 0.05` (0.005 C/s ≈ 3 C/min), `COOLING_RATE = 0.03` (≈ 1.8 C/min)

#### ISSUE 2: Wash Assessment Uses Wrong Category

`wash-physics.ts` emits assessment events with `category: "tip_reuse"` instead of a wash-specific category. This is a copy-paste artifact that will confuse assessment filtering.

#### ISSUE 3: PIP Tip-Type-to-Volume Mapping Approximate

```typescript
// Current (pip-physics.ts line ~250)
activeTipType <= 1 -> 100uL
activeTipType <= 3 -> 500uL  
else -> 10000uL
```

Real Hamilton tip types: 0=300uL standard, 1=50uL low-volume, 2=10uL, 4=1000uL high-volume, 6/7/8=needles. The current mapping assigns type 0 (300uL) to the 100uL correction curve.

#### ISSUE 4: C0HC estimateTime Returns 500ms

`C0HC` is the "heat AND WAIT until temperature reached" command. The twin's `estimateTime` returns a flat 500ms instead of computing the actual ramp time. For a 22→70C transition, this should be ~15-25 minutes.

### PIP Plugin — Detailed Accuracy

**TADM Curve Generation:**
- Peak pressure formula: `peakPressure = -min(400, 50 + (volume/100) * viscosity * 30)`
- At 100uL water: -350 mbar (real: -50 to -300 mbar) — slightly high
- Tolerance bands: symmetric ±50, tracking curve shape exactly
- **Gap:** Real TADM bands are independent acceptance envelopes, not curve-followers. The current model cannot produce stochastic failures.

**Axis Speeds (all in 0.1mm units):**

| Constant | Twin Value | Real STAR Spec | Match? |
|----------|-----------|----------------|--------|
| X_SPEED_DEFAULT | 25000 (2500 mm/s) | ~2500 mm/s | YES |
| X_SPEED_WITH_LIQUID | 15000 (1500 mm/s) | ~1200-1500 mm/s | YES |
| Z_SPEED_DEFAULT | 12000 (1200 mm/s) | ~1200 mm/s | YES |
| Y_SPEED_DEFAULT | 8000 (800 mm/s) | ~600-800 mm/s | YES |
| X_ACCEL | 50000 (5000 mm/s²) | ~4000-6000 mm/s² | REASONABLE |

**Trapezoidal Motion Profile:** Correctly implements triangular (short moves) and trapezoidal (long moves) kinematics. Dimensionally consistent.

**Volume Correction:** Polynomial `actual = a0 + a1*nominal + a2*nominal²` per tip size — matches Hamilton's CO-RE Liquid Editor model.

**Well Geometry:** Supports 4 shapes (flat, round, conical, v_bottom) with Newton's method numerical solvers for hemisphere and frustum height inversion. The math is correct.

### Plugins Missing Assessment Events

| Plugin | assess() method? | Events generated |
|--------|-----------------|------------------|
| PIP | Yes | TADM, LLD, contamination, dead volume, empty aspiration, tip reuse |
| 96-Head | Yes | Basic info only (no TADM curves) |
| 384-Head | Yes | Basic info only |
| iSWAP | **NO** | Zero assessment events |
| Temperature | Yes | Large temp jump warnings |
| Wash | Yes | Fluid level warnings |
| HHS | Yes | Large temp jump warnings |

---

## 6. VENUS Step Layer Accuracy

### Step Type Inventory (29 types)

| Category | Steps | VENUS Source Match |
|----------|-------|-------------------|
| Single (PIP) | tipPickUp, tipEject, aspirate, dispense, dispenseFly, movePIP | YES (from AtsMc*.cpp via Run*.cpp) |
| Single (96-Head) | head96Move, head96TipPickUp, head96Aspirate, head96Dispense, head96TipEject | YES |
| Single (iSWAP) | getPlate, putPlate, movePlate | YES |
| Single (Gripper) | gripperGetTool, gripperGripPlate, gripperRelease, gripperDiscardTool | YES |
| Single (Misc) | setTemperature, wash | YES |
| Easy | easyAspirate, easyDispense, easyTransfer, easyTransport, easy96Aspirate, easy96Dispense | YES (from CommandEasyRunBase.cpp) |
| Power (Custom) | transferSamples, addReagent, serialDilution | Custom (NOT built-in VENUS) |

### Parameter Annotation Sources

The step layer correctly annotates parameters with their sources:
- `user` — explicitly set (volume, mask, dispense mode)
- `liquidClass` — from liquid class calibration (speed, transport air, blowout, settle time)
- `deckLayout` — resolved from carrier/position/column (xp, yp coordinates)
- `default` — hardcoded (mask=255, tip type=4, LLD=0)
- `computed` — calculated (waste Y positions)

### Missing Step Types vs Real VENUS

| VENUS Step | Status in Twin |
|-----------|---------------|
| 1000ul Channel Aspirate (Single Step) | YES (`aspirate`) |
| 1000ul Channel Dispense (Single Step) | YES (`dispense`) |
| 1000ul Channel Tip Pick Up (Single Step) | YES (`tipPickUp`) |
| 1000ul Channel Tip Eject (Single Step) | YES (`tipEject`) |
| 1000ul Channel Dispense on the Fly (Single Step) | YES (`dispenseFly`) |
| 1000ul Channel Get Last Liquid Level (Single Step) | **NO** — `C0RL` accepted but no step |
| Load Carrier (Single Step) | **NO** — autoload commands exist but no step |
| Unload Carrier (Single Step) | **NO** — same |
| iSWAP Get Plate (Single Step) | YES (`getPlate`) |
| iSWAP Place Plate (Single Step) | YES (`putPlate`) |
| Initialize (Single Step) | **NO** — init done via helper, no formal step |
| Needle Wash (Single Step) | **NO** — `C0LW` registered but no step |
| 96-Head Wash | **NO** — C0EG registered but no step |

---

## 7. Test Coverage Analysis

### Summary

| File | Tests | FW Commands | Step Types |
|------|-------|-------------|------------|
| tutorial-workflow.test.ts | 22 | 20 | N/A (raw FW) |
| ghost-commands.test.ts | 32 | 4 (C0TP/TR/AS/DS) | N/A |
| venus-steps.test.ts | 22 | via step API | 10 of 29 |
| power-steps.test.ts | 16 | via step API | 6 of 29 |
| visual.test.ts (e2e) | 33 | 10 | N/A |
| **TOTAL** | **125** | **20 of ~210 (9.5%)** | **18 of 29 (62%)** |

### Modules with ZERO Test Coverage

1. **384-Head** — No tests for C0JA, C0JB, C0JC, C0JD, C0JI, C0EN, C0JG
2. **CO-RE Gripper** — No tests for C0ZT, C0ZP, C0ZR, C0ZS, C0ZM
3. **iSWAP Transport** — No tests for C0PP, C0PR, C0PM (via step API)
4. **AutoLoad** — No tests for C0CI, C0CL, C0CR and related

### Step Types with ZERO Test Coverage (11 of 29)

dispenseFly, movePIP, head96Dispense, head96TipEject, getPlate, putPlate, movePlate, gripperGetTool, gripperGripPlate, gripperRelease, gripperDiscardTool, easyTransport, easy96Dispense, wash

### Physics Behaviors Never Tested

- Volume overdraw (aspirating more than well contains)
- Tip capacity overflow (exceeding 1000uL)
- Liquid class variation (all tests use default class)
- LLD mode activation (lldMode always 0)
- Concurrent module operations
- Temperature ramp/reached verification
- Wash fluid exhaustion
- 384-head max volume validation (50uL cap)

---

## 8. Inconsistencies Found

### CRITICAL (Incorrect Behavior)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **Temperature ramp 10x too fast** | `temperature-physics.ts:9-10`, `hhs-physics.ts` | HEATING_RATE=5 gives 30 C/min; real is 2-3 C/min. Comment says the right value but code is wrong. |
| 2 | **384-Head missing history pseudo-state** | `core384_head.scxml` | Move resets to `idle384` → `no_tips384`, losing tip state. PIP and 96-Head both have deep history for this. |
| 3 | **Wash assessment wrong category** | `wash-physics.ts` assess() | Uses `"tip_reuse"` category for wash fluid events. Should be a wash-specific category. |
| 4 | **C0HC estimateTime returns 500ms flat** | `temperature-physics.ts` estimateTime() | C0HC = "wait until reached" but returns 500ms instead of ramp time. |
| 5 | **PIP tip type mapping approximate** | `pip-physics.ts:~250` | Type 0 (300uL standard) incorrectly maps to 100uL correction curve. |

### MODERATE (Missing Functionality)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 6 | No C0RX/C0RT interleaving in step sequences | `venus-steps.ts` | Real VENUS sends verification queries between every operation |
| 7 | 96-Head/384-Head lack TADM curves | `h96-physics.ts`, `h384-physics.ts` | Only emit placeholder info events, no pressure curve data |
| 8 | 96-Head/384-Head lack liquid class correction | Same | Volume correction is PIP-only |
| 9 | iSWAP has no assess() method | `iswap-physics.ts` | Zero assessment events for plate transport |
| 10 | PIP C0TP assess stub empty | `pip-physics.ts:486-496` | Tip pickup contamination check is a TODO |
| 11 | No autoload step types | `venus-steps.ts` | Real VENUS has Load/Unload Carrier steps |
| 12 | No needle wash step | `venus-steps.ts` | C0LW registered but no step type |
| 13 | No getLiquidLevel step | `venus-steps.ts` | C0RL registered but no step type |
| 14 | Timing 4-10x too fast for mechanical ops | `command-timing.ts`, plugins | Tip pickup: 700ms vs real 7-9s; iSWAP: 2.2s vs real 17s |

### MINOR (Polish/Completeness)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 15 | Generated JS files inconsistent location | `src/state-machines/modules/` vs `dist/` | 5 modules only in dist/ |
| 16 | deck_slot.scxml unused | `scxml/deck_slot.scxml` | No generated JS, not in module registry |
| 17 | system_orchestrator.scxml outdated | `scxml/system_orchestrator.scxml` | Simplified parallel model, not used in production |
| 18 | 96-head registry registers 5 unhandled events | Module registry vs SCXML | C0EU/EF/EW/ES/EE have no SCXML transitions |
| 19 | No RPM-dependent timing for HHS shaker | `hhs-physics.ts` | Spin-up time doesn't vary with target RPM |
| 20 | No per-channel Y array in step layer | `venus-steps.ts` | Steps send single Y; real VENUS sends per-channel arrays |

---

## 9. Recommendations

### Priority 1 — Fix Incorrect Behavior

1. **Fix temperature ramp rates** in `temperature-physics.ts` and `hhs-physics.ts`:
   ```
   HEATING_RATE = 0.05  // 0.005 C/s ≈ 3 C/min (was 5, i.e., 30 C/min)
   COOLING_RATE = 0.03  // 0.003 C/s ≈ 1.8 C/min (was 3, i.e., 18 C/min)
   ```
   Also fix C0HC estimateTime to compute actual ramp time.

2. **Add deep history to 384-Head SCXML** (`core384_head.scxml`):
   - Add `<history id="idle384_history" type="deep">` inside `idle384`
   - Change `moving384 → idle384` to `moving384 → idle384_history`
   - Regenerate JS via VSCXML

3. **Fix wash assessment category** in `wash-physics.ts` — change `"tip_reuse"` to `"contamination"` or add a new `"wash_fluid"` category.

4. **Fix PIP tip type mapping** — use actual Hamilton tip type IDs: `{0: 3000, 1: 500, 2: 100, 3: 500, 4: 10000, 6: 10000, 7: 10000, 8: 10000}`.

### Priority 2 — Improve Timing Realism

5. **Calibrate mechanical timing against traces:**
   - C0TP: ~7-9s total (current: 700ms) — includes X travel + Z descent + grip + verify + Z retract
   - C0TR: ~7-8s total (current: 530ms)
   - C0DI: ~55s total (current: 3000ms) — full channel homing
   - iSWAP operations: 9-17s (current: 2.2s) — includes arm rotation + Z approach + grip + retract

6. **Add X travel distance to timing** — the PIP plugin already does this for some commands but the default `TIP_PICKUP_TIME_MS` (800ms) doesn't include X travel, which dominates real timing.

### Priority 3 — Expand Coverage

7. **Add 96-Head TADM curves** — the real 96-head has TADM monitoring. Generate curves similar to PIP but with aggregate pressure.

8. **Add iSWAP assessment events** — plate grip success/failure, collision risk.

9. **Add missing step types**: `getLiquidLevel`, `needleWash`, `loadCarrier`, `unloadCarrier`, `head96Wash`.

10. **Add tests for untested modules**: 384-head, gripper, iSWAP transport, autoload (at minimum a basic cycle test for each).

### Priority 4 — Protocol Fidelity

11. **Consider adding optional C0RX/C0RT interleaving** — in a "high-fidelity" step mode, emit the same verification queries that real VENUS sends.

12. **Add per-channel Y arrays** to the step layer — real VENUS sends independent Y positions per channel, not a single Y value.

13. **Implement 2nd-phase aspirate parameters** — used for bottom-sensing with air displacement detection (tags lk, ik, sd, se, sz, io, il, in).

---

## Appendix A: Complete FW Command Catalog from Traces

106 unique command codes observed across all Star traces:

```
C0AS C0AW C0AZ C0CB C0CD C0CE C0CI C0CL C0CO C0CP C0CR C0CT C0CU C0CW
C0DF C0DI C0DR C0EA C0ED C0EI C0EP C0ER C0EV C0FI C0HO C0II C0IV C0JE
C0JM C0PG C0PP C0PR C0QB C0QC C0QH C0QM C0QP C0QS C0QW C0RC C0RF C0RG
C0RI C0RJ C0RL C0RM C0RQ C0RT C0RU C0RV C0RX C0RS C0SR C0ST C0TP C0TR
C0TT C0VI C0WS C0ZA
P1-P8: AF RF RJ RA RV VW
X0: RF RJ RA
I0: RF RJ RV
R0: RF RJ RV
H0: RF RJ RV QG
PX: AF
```

## Appendix B: VENUS Training Script Coverage

The 86 HSL/STP/SUB training files demonstrate:
- Method creation and sequence manipulation
- Transport operations (iSWAP plate moves)
- Sub-method architecture (callable methods)
- Error handling patterns (recovery strategies)
- File I/O (CSV, mapping files)
- Three-layer architecture (Workflow → Logic → Execution)
- Scheduler/parallel execution
- Data management

These training scripts could be parsed for additional step patterns not currently in the twin.

## Appendix C: VENUS Trace File Locations

```
VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/
├── AspirateAndDispensePositions/
│   ├── Pipetting1mlCapacitiveLLD_ComTrace.trc
│   ├── Pipetting1mlPressureLLD_ComTrace.trc
│   └── Pipetting96MPHCapacitiveLLD_ComTrace.trc
├── DispenseOnTheFly/
│   ├── DispenseOnTheFly1mlDefaultValues_ComTrace.trc
│   ├── DispenseOnTheFly1mlCustomSequenceOrder_ComTrace.trc
│   └── DispenseOnTheFly1mlExcludedPositions_ComTrace.trc
├── GetLastLiquidLevel/
│   └── GetLastLiquidLevel_ComTrace.trc
├── Legacy1mlChannelLiquidHandling/
│   └── [7 scenario traces]
├── MethodTermination/
│   ├── PickupEject1mlChannelNeedle_ComTrace.trc
│   └── TipPickup_HxUsbComm.trc
├── SingleStepAspirateTouchOff/
├── SingleStepDispenseSideTouch/
├── SingleStepDispenseTouchOff/
├── STARletPreFillTubesForSynergy/
│   └── PreFillTubesForSynergy_ComTrace.trc (LARGEST: 1,226 commands)
└── SN559IBigBang/
    └── SN559IBigBang_HxUsbComm.trc (full workflow: autoload+iSWAP+pip+DOF)
```
