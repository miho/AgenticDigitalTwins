# VENUS Training Data & Scripts Deep Analysis Report

**Date:** 2026-04-16
**Source:** `STAR VENUS INFO ML API/STAR VENUS INFO ML API/`
**Scope:** Complete analysis of VENUS training HSL scripts, PDFs, layouts, C#/.NET artifacts, liquid handling parameters, and training curriculum — compared against Hamilton STAR Digital Twin implementation.

---

## Table of Contents

1. [Inventory Summary](#1-inventory-summary)
2. [HSL Script Analysis — VENUS API Catalog](#2-hsl-script-analysis)
3. [Liquid Handling Parameters](#3-liquid-handling-parameters)
4. [Deck Layout & Geometry Verification](#4-deck-layout--geometry-verification)
5. [VENUS Step Hierarchy — Smart Steps / PTL](#5-venus-step-hierarchy)
6. [Training Curriculum Structure](#6-training-curriculum-structure)
7. [Programmatic Interfaces (C#/.NET/COM)](#7-programmatic-interfaces)
8. [Comparison with Twin Implementation](#8-comparison-with-twin-implementation)
9. [Inconsistencies & Gaps Found](#9-inconsistencies--gaps-found)
10. [Recommendations](#10-recommendations)

---

## 1. Inventory Summary

| Category | Count | Key Content |
|----------|-------|-------------|
| HSL scripts (.hsl) | 31 | VENUS method programming |
| Step files (.stp) | 38 | VENUS step definitions |
| Sub-methods (.sub) | 17 | VENUS sub-method libraries |
| Layout files (.lay) | 16 | Deck configurations |
| Method files (.med) | 15 | Complete VENUS methods |
| PDF documents | 23 | HSL programming reference |
| Presentations (.ppt/.pptx) | 41 | Training slides |
| C# source (.cs) | 18 | COM interop + HxRun integration |
| DLL libraries | 35 | Hamilton framework DLLs |
| Library headers (.hsi/.hs_) | 32 | HSL library interfaces |
| Training videos (.mp4) | 4 | Recorded sessions (~2GB) |
| Settings (.smt) | 13 | VENUS settings/configs |
| **Total files** | **964** | |

---

## 2. HSL Script Analysis — VENUS API Catalog

### ML_STAR Instrument Commands (COM GUIDs)

| Command | GUID | Digital Twin Step |
|---------|------|-------------------|
| Initialize | `{1C0C0CB0-7C87-11D3-AD83-0004ACB1DCB2}` | C0VI (via initAll) |
| LoadCarrier | `{54114402-7FA2-11D3-AD85-0004ACB1DCB2}` | **NOT IMPLEMENTED** |
| TipPickUp | `{541143FA-7FA2-11D3-AD85-0004ACB1DCB2}` | `tipPickUp` step |
| Aspirate | `{541143F5-7FA2-11D3-AD85-0004ACB1DCB2}` | `aspirate` step |
| Dispense | `{541143F8-7FA2-11D3-AD85-0004ACB1DCB2}` | `dispense` step |
| TipEject | `{541143FC-7FA2-11D3-AD85-0004ACB1DCB2}` | `tipEject` step |
| ZSwapGetPlate | `{A108628C-BEB7-4CB6-99FD-8523302C700F}` | `getPlate` step (iSWAP) |
| ZSwapPlacePlate | `{9DF3DD4B-3B5E-4750-8989-04458D1B134B}` | `putPlate` step (iSWAP) |
| GetPlate (iSWAP) | `{CC819D7A-5DD8-4d13-A921-D74A06460F9E}` | `getPlate` step |
| PutPlate (iSWAP) | `{E34155E5-7529-4b6b-AE3E-CDDA40789D55}` | `putPlate` step |

### Smart Step (PTL) API — Complete Parameter Catalog

**50+ configurable pipetting parameters** discovered across training scripts:

#### Aspirate Parameters
| Parameter | Values Observed | Twin Status |
|-----------|----------------|-------------|
| `AspirateMode` | 0 (standard) | Mapped to C0AS `at` param |
| `AspirateCLLDSensitivity` | 0 (off), 5 (high) | `lm` param in step layer |
| `AspiratePLLDSensitivity` | 0 (off), 3 | **NOT IN STEP LAYER** |
| `AspirateFluidHeight` | 0 (auto from LLD) | **NOT IN STEP LAYER** |
| `AspirateSubmergeDepth` | 2mm (always) | **NOT IN STEP LAYER** |
| `AspirateLiquidFollowing` | true (always) | **NOT IN STEP LAYER** |
| `AspirateMaxHeightDiff` | 0 | **NOT IN STEP LAYER** |
| `AspiratePrerinsingMixCycles` | 5 | Maps to `mv`/`mc` params |
| `AspiratePrerinsingMixPosition` | 2mm | **NOT IN STEP LAYER** |
| `AspiratePrerinsingMixVolume` | 20ul | Maps to `mv` param |
| `AspirateUserDefinedLiquidClass` | 7 classes | `liquid-classes.ts` |
| `AspirateSequenceReloadable` | true/false | N/A (step layer) |
| `AspirateSequenceReducible` | true/false | N/A (step layer) |
| `AspirateChannelVariable` | variable ref | N/A (step layer) |

#### Dispense Parameters
| Parameter | Values Observed | Twin Status |
|-----------|----------------|-------------|
| `DispenseMode` | 0 (surface), 1 (jet) | `dm` param in step layer |
| `DispenseCLLDSensitivity` | 0 (always off) | N/A |
| `DispenseFluidHeight` | 5mm, 10mm | **NOT IN STEP LAYER** |
| `DispenseSubmergeDepth` | 0 (never) | **NOT IN STEP LAYER** |
| `DispenseLiquidFollowing` | true (always) | **NOT IN STEP LAYER** |
| `DispenseRestVolumeDestination` | 0 (none), 1 (waste) | **NOT IN STEP LAYER** |
| `DispenseUserDefinedLiquidClass` | same as aspirate | `liquid-classes.ts` |

#### Aliquot Parameters
| Parameter | Values Observed | Twin Status |
|-----------|----------------|-------------|
| `AliquotEnabled` | true/false | **NOT IN STEP LAYER** |
| `AliquotPreAspirateVolume` | 0 | **NOT IN STEP LAYER** |
| `AliquotAspirateDefaultMixingEnabled` | true | **NOT IN STEP LAYER** |

### Sequence Manipulation API

| Function | Purpose | Twin Status |
|----------|---------|-------------|
| `SeqIncrement(seq, N)` | Advance by N positions | Not needed (step layer handles) |
| `SeqAdd(seq, labware, position)` | Dynamic sequence building | Not needed |
| `seq.GetCurrentPosition()` | Read position | Not needed |
| `seq.SetCurrentPosition(N)` | Set position | Not needed |
| `AlignSequences(flag, seq, count)` | Align for parallel pipetting | **Relevant — multi-channel alignment** |

### Additional VENUS APIs Discovered

| API | Purpose | Twin Relevance |
|-----|---------|----------------|
| `STCC::SetElementBarcodeForSequencePos` | Barcode assignment | LOW (tracking layer) |
| `STCC::GenerateMappingFileV43Ex1` | Mapping file output | LOW (reporting) |
| `DATAMANAGERINTERFACE::AddTable/InsertRow/ExecuteSelectCommand` | In-memory database | NONE (VENUS-only) |
| `ImportWorklist::ImportXlsWorklist` | Excel worklist import | LOW (data source) |
| `MatchWorklist::MatchJobData` | Barcode-based matching | LOW (data source) |
| `ExcelFile.Open/ReadRecord/Close` | SQL-filtered file I/O | NONE (VENUS-only) |
| `PTL::Pipette/Pipette2` | Smart Step pipetting | HIGH (see Section 5) |
| `PTL::Load/Load2` | Smart Step loading | MEDIUM (autoload) |

---

## 3. Liquid Handling Parameters

### Liquid Classes Found in Training

| Name | Tip | Liquid | Mode | Twin Match |
|------|-----|--------|------|------------|
| `HighVolume_Water_AliquotDispenseJet_Part` | 1000ul | Water | Jet, Aliquot | **NOT IN TWIN** (aliquot class) |
| `StandardVolume_Water_DispenseJet_Empty` | 300ul | Water | Jet, Empty | Similar to `Water_HighVolumeJet_Empty` |
| `StandardVolume_Serum_DispenseJet_Empty` | 300ul | Serum | Jet, Empty | Similar to `Serum_HighVolumeSurface_Empty` |
| `StandardVolume_Water_DispenseSurface_Empty` | 300ul | Water | Surface | **NOT IN TWIN** |
| `StandardVolume_Serum_DispenseSurface_Empty` | 300ul | Serum | Surface | **NOT IN TWIN** |
| `StandardVolumePlasmaDispenseJet_Empty` | 300ul | Plasma | Jet, Empty | **NOT IN TWIN** |
| `Tip_50ul_Water_DispenseSurface_Empty` | 50ul | Water | Surface | **NOT IN TWIN** |

**Naming convention:** `{TipVolume}_{LiquidType}_{DispenseMode}_{EmptyOrPart}`

The twin currently has 6 liquid classes but **none match the VENUS naming convention exactly**. The twin uses names like `Water_HighVolumeJet_Empty` while VENUS uses `HighVolume_Water_AliquotDispenseJet_Part`.

### Key Liquid Handling Constants from Training

| Parameter | Value | Twin Value | Match? |
|-----------|-------|------------|--------|
| Submerge depth (aspirate) | 2mm | Not modeled | **GAP** |
| Submerge depth (dispense) | 0mm | Not modeled | **GAP** |
| Liquid following | Always ON | Not modeled | **GAP** |
| cLLD sensitivity | 0 or 5 | `lm` param (0-2) | Different scale |
| pLLD sensitivity | 0 or 3 | `lm` param | Simplified |
| Pre-rinsing cycles | 5 | `mc` param available | OK |
| Pre-rinsing volume | 20ul | `mv` param available | OK |
| Pre-rinsing position | 2mm | `mp` param **NOT SENT** | **GAP** |
| Dispense height | 5-10mm | Not modeled | **GAP** |
| Aspirate height | Auto (from LLD) | Not modeled | **GAP** |

### Wash Station Parameters (Standard)

| Parameter | Training Value | Twin Value | Match? |
|-----------|---------------|------------|--------|
| RinseTime1 | 5s | BASE_WASH_TIME=3500ms | Close |
| SoakTime1 | 5s | Not separate | **GAP** |
| FlowRate1 | 11 ml/s | Not modeled | **GAP** |
| RinseTime2 | 0 (off) | Not modeled | N/A |
| DrainingTime | 10s | Not modeled | **GAP** |
| Fluid per cycle | ~40ml (5ml × 8ch) | FLUID_PER_CYCLE=40000uL | YES |

---

## 4. Deck Layout & Geometry Verification

### Carrier Templates from Training Layouts

| Template | Twin Template | Y Sites (0.1mm) | Match? |
|----------|--------------|-----------------|--------|
| PLT_CAR_L5AC_A00 | PLT_CAR_L5MD | [1460, 2420, 3380, 4340, 5300] | **DIFFERENT CARRIER** |
| PLT_CAR_L5MD_A00 | PLT_CAR_L5MD | [85, 1045, 2005, 2965, 3925] | YES |
| TIP_CAR_480BC_ST_A00 | TIP_CAR_480 | [100, 1060, 2020, 2980, 3940] | YES |
| RGT_CAR_3R_A01 | RGT_CAR_3R | [500, 1960, 3400] | Approx |
| SMP_CAR_24_15x75_A00 | SMP_CAR_24 | Even division | Approx |
| SMP_CAR_32_EPIS_A00 | **NOT IN TWIN** | N/A | **MISSING** |
| SMP_CAR_32_12x75_A00 | **NOT IN TWIN** | N/A | **MISSING** |
| RGT_CAR_5R60_A00 | **NOT IN TWIN** | N/A | **MISSING** |
| TIP_CAR_480_HT_A00 | **NOT IN TWIN** | N/A | **MISSING** |
| TIP_CAR_480BC_TIP_50ul_A00 | **NOT IN TWIN** | N/A | **MISSING** |

### Labware Templates from Training

| Labware | Type | Twin Match |
|---------|------|------------|
| Nun_96_Fl_Lb | Nunc 96-well flat low-binding | MTP_96 (generic) |
| Nun_96_Fl_Hb | Nunc 96-well flat high-binding | MTP_96 (generic) |
| Nun_384_Sq | Nunc 384-well square | MTP_384 (generic) |
| HAM_DW_12_ml | Hamilton 96 deepwell 12ml | **NOT IN TWIN** |
| Pfi_96_DW | Polyfiltronic 96 deepwell | **NOT IN TWIN** |
| ST_L / st_l | 300ul standard tip rack | TIP_RACK_1000 (wrong size) |
| HT_L / ht_l | 1000ul high-volume tip rack | TIP_RACK_1000 |
| TIP_50ul_L | 50ul tip rack | **NOT IN TWIN** |
| rgt_cont_120ml_a00 | 120ml reagent trough | TROUGH (generic) |
| rgt_cont_60ml_BC_A00 | 60ml barcode trough | **NOT IN TWIN** |
| COREGripTool_AtWaste_1000ul | CO-RE grip tool parking | **NOT IN TWIN** |

### Coordinate Cross-Reference

| Feature | Training Layouts | Twin Value | Match? |
|---------|-----------------|------------|--------|
| Carrier site spacing (plate) | 96mm (~960 units) | 960 units | YES |
| Carrier site spacing (reagent 3R) | ~163.4mm | [500, 1960, 3400] ÷ 10 | YES |
| WasteBlock X (Starlet) | 778mm | N/A (STAR=54 tracks) | N/A |
| WasteBlock X (STAR) | 1318mm | Tracks 52-54 | ~YES |
| 6-track carrier width | 135mm | 135mm (6×22.5) | YES |
| Plate carrier Y dim | 497mm (from .tml) | 4970 units | YES |

### CO-RE Grip Default Parameters (from Challenge_SubMethod.pdf)

| Parameter | Training Value | Twin Step | Match? |
|-----------|---------------|-----------|--------|
| Grip height | 5mm | `gh` param | Available |
| Grip width | 81mm | `gw` param | Available |
| Opening width | 88mm | `go` param | Available |

---

## 5. VENUS Step Hierarchy — Smart Steps / PTL

### PTL::Pipette() Function (from training code)

```
PTL::Pipette(device, tipSequence, aspirateSequence, dispenseSequence,
             param5, param6, transferVolume, param8, pipetteMode,
             aspirateCount, dispenseCount, totalTransfers, param13)
```

**pipetteMode values:**
- `1` = Standard single transfer (1 aspirate → 1 dispense)
- `2` = Aliquot mode (1 aspirate → N dispenses)

The twin's `easyTransfer` step maps to pipetteMode=1. The twin has **no aliquot mode** equivalent.

### Loading Patterns — PTL::Load/Load2

| Load Function | Description | Twin Status |
|---------------|-------------|-------------|
| `PTL::Load(device, barcodeRead)` | Smart load with barcode | **NOT IMPLEMENTED** |
| `PTL::Load2(device, ...)` | Load with worklist matching | **NOT IMPLEMENTED** |

### Three-Layer Architecture Pattern

The training reveals VENUS methods follow a strict architecture:
- **WorkflowLayer** — Main method (.med): calls Logic functions
- **LogicLayer** — Processing libraries (.smt): orchestrates executing layer
- **ExecutingLayer** — Controller libraries (.smt): PipettingController, TransportController, TipController, DialogController, DataHandlingController

The twin's step layer partially maps to the ExecutingLayer (individual FW commands) but the Logic/Workflow layers are handled by the protocol editor.

### Scheduler Resource Model

| Resource | Capacity | Activities | Twin Status |
|----------|----------|------------|-------------|
| Res_ML_STAR | 1 | Load, Pipette, Transport | Partially modeled |
| Shaker | 4 | Shake | HHS module exists |
| Incubator | 4 | Incubate | **NOT MODELED** |
| Reader | 1 | Read on Photometer | **NOT MODELED** |

---

## 6. Training Curriculum Structure

### 4-Tier Progression

| Tier | Modules | Focus |
|------|---------|-------|
| **Basic** (01-29) | 29 modules | Deck layout, sequences, steps, pipetting, transport, error handling, file I/O, mapping files |
| **Advanced** (30-41) | 12 modules | 3-layer architecture, DataManager, scheduler, final exam |
| **Liquid Handling** (03) | 2 modules | Liquid classes, TADM, ADC, cLLD, pLLD |
| **HSL Developer** (04) | 8 modules | Language syntax, COM interop, libraries, HxRun integration |

### Key Exercises Matching Twin Capabilities

| Exercise | VENUS Capability | Twin Support |
|----------|-----------------|--------------|
| 03: Method | Aspirate/Dispense/TipPickUp/TipEject | YES |
| 04: Sequences | Sequence manipulation, 384-well | PARTIAL |
| 05: Transports | CO-RE Grip + iSWAP | YES (steps defined) |
| 06: Sub-Methods | Parameterized plate transport | YES (steps) |
| 07: Error Handling | onerror, recovery | PARTIAL (error codes) |
| 08: File Handling | Worklist import, dynamic sequences | NOT IMPLEMENTED |
| 09: Mapping File | Sample tracking, barcodes | NOT IMPLEMENTED |
| 01 Adv: DataManager | In-memory database | NOT APPLICABLE |
| 02 Adv: Three-Layer | Architecture pattern | Protocol editor |
| 03 Adv: Scheduler | Multi-resource scheduling | NOT IMPLEMENTED |
| Final Exam | DNA dilution assay | COULD BE REPRODUCED |

---

## 7. Programmatic Interfaces (C#/.NET/COM)

### Three Programmatic Interfaces Beyond HSL/VENUS

| Interface | Direction | Purpose | Twin Relevance |
|-----------|-----------|---------|----------------|
| COM Interop | HSL → .NET | Extend VENUS with C# DLLs | LOW (internal VENUS) |
| HxRun API | .NET → VENUS | External app launches methods | LOW (VENUS runtime) |
| SQL Database | HSL → DB | LIMS integration | LOW (data layer) |

### Key Hamilton DLLs

| DLL | Purpose |
|-----|---------|
| `Hamilton.AswGui.StandardGui.dll` | HxRunManager — launch/monitor VENUS methods |
| `Hamilton.Toolbox.Application.dll` | VectorHelper — resolve VENUS directories |
| `Hamilton.Toolbox.WPF.dll` | Hamilton standard icons and resources |
| `INIFile.dll` | COM-visible INI file reader (called from HSL) |

### Important Finding: "Phoenix" = VENUS

`VectorHelper.GetPhoenixDirectory(PhoenixDirectoryType.Methods)` confirms "Phoenix" is the internal codename for the VENUS software platform.

---

## 8. Comparison with Twin Implementation

### Liquid Class Naming Mismatch

| VENUS Convention | Twin Convention | Issue |
|-----------------|----------------|-------|
| `HighVolume_Water_AliquotDispenseJet_Part` | `Water_HighVolumeJet_Empty` | Different naming scheme |
| `StandardVolume_Water_DispenseJet_Empty` | `Water_HighVolumeJet_Empty` | No standard volume variant |
| `StandardVolume_Serum_DispenseJet_Empty` | `Serum_HighVolumeSurface_Empty` | Mode mismatch (jet vs surface) |
| `Tip_50ul_Water_DispenseSurface_Empty` | Not defined | 50ul class missing |
| `StandardVolumePlasmaDispenseJet_Empty` | Not defined | Plasma class missing |

The twin's 6 liquid classes don't follow the real VENUS naming convention and are missing key classes (StandardVolume variants, 50ul, Plasma, Aliquot).

### Step Layer Coverage vs Training Workflows

| Training Workflow | Steps Needed | Twin Coverage |
|-------------------|-------------|---------------|
| Standard single transfer | TP + AS + DS + TR | YES |
| Aliquot from trough | TP + AS + DS×N + TR | **PARTIAL** (no aliquot mode) |
| Worklist-driven variable volume | Dynamic sequence + individual volumes | **NO** |
| DNA dilution (Final Exam) | TP + AS(TE water) + DS + TP + AS(DNA) + DS + TR | YES (via protocol) |
| Multi-carrier transfer | Loop across carriers | YES (via power steps) |
| Plate transport (CO-RE Grip) | ZSwapGet + ZSwapPlace | YES (`getPlate`/`putPlate`) |
| Plate transport (iSWAP) | GetPlate + PutPlate | YES (`getPlate`/`putPlate`) |
| Scheduler multi-resource | Activities with resource allocation | **NOT IMPLEMENTED** |
| LoadCarrier with barcode | C0CI + C0CL + C0RC | **NOT AS STEP** |

### Carrier/Labware Template Coverage

**Twin has 7 carrier templates, training uses 10.** Missing:
- `PLT_CAR_L5AC_A00` (different from L5MD — auto-clamp variant)
- `SMP_CAR_32_EPIS_A00` (32-position Eppendorf carrier)
- `SMP_CAR_32_12x75_A00` (32-position 12×75mm tube carrier)
- `RGT_CAR_5R60_A00` (5×60ml reagent carrier)
- `TIP_CAR_480_HT_A00` (high-volume only tip carrier)
- `TIP_CAR_480BC_TIP_50ul_A00` (50ul tip carrier)

**Twin has 8 labware templates, training uses 15+.** Missing:
- `HAM_DW_12_ml` (12ml deepwell plate)
- `Pfi_96_DW` (Polyfiltronic deepwell)
- `ST_L` (300ul tip rack — distinct from 1000ul)
- `TIP_50ul_L` (50ul tip rack)
- `rgt_cont_60ml_BC_A00` (60ml barcoded trough)
- `Nun_96_Fl_Lb` / `Nun_96_Fl_Hb` (specific Nunc plates vs generic MTP_96)
- `COREGripTool_AtWaste_1000ul` (gripper tool parking)

### PTL State Parameters Not in Twin

The training reveals 50+ pipetting state parameters controlled via `PTL::SetPipettingState()`. The twin's step layer handles ~11 FW parameters. Key missing PTL parameters:

| Parameter Group | Count | Twin Status |
|----------------|-------|-------------|
| Aspirate Z-height control | 5 (FluidHeight, SubmergeDepth, MaxHeightDiff, LiquidFollowing, MixPosition) | **NOT MODELED** |
| Dispense Z-height control | 4 (FluidHeight, SubmergeDepth, LiquidFollowing, RestVolume) | **NOT MODELED** |
| Aliquot control | 3 (Enabled, PreAspirateVol, MixEnabled) | **NOT MODELED** |
| Sequence lifecycle | 12 (Reloadable, Reducible, CurrentInit/Finalize, CountInit/Finalize, Calibration) | N/A (step layer) |
| Channel variables | 2 (AspirateChannelVariable, DispenseChannelVariable) | N/A |
| Error handling | 3 (ErrorHandling, UserResponseTime, CalibrateCarrierChannel) | **NOT MODELED** |

---

## 9. Inconsistencies & Gaps Found

### CRITICAL

| # | Issue | Impact |
|---|-------|--------|
| 1 | **Liquid class names don't match VENUS convention** | Twin liquid classes won't match when replaying real VENUS traces/methods |
| 2 | **No aliquot/multi-dispense mode** | Cannot simulate the most common production pipetting pattern |
| 3 | **No 300ul StandardVolume tip type** | Training uses 300ul as the default; twin only has 1000ul and 10/50ul |
| 4 | **No LoadCarrier step** | One of the fundamental VENUS single steps, used in every method |

### MODERATE

| # | Issue | Impact |
|---|-------|--------|
| 5 | Missing 6 carrier templates (L5AC, SMP_32, RGT_5R60, TIP_HT, TIP_50ul) | Cannot represent common training/production deck configurations |
| 6 | Missing 7 labware templates (deepwell, specific Nunc, 300ul rack, 50ul rack, 60ml trough) | Limited labware variety |
| 7 | No Z-height parameters in step layer (SubmergeDepth, FluidHeight, LiquidFollowing) | Simplified pipetting physics |
| 8 | No rest volume / dead volume routing (DispenseRestVolumeDestination) | Aliquot dead-volume handling missing |
| 9 | No pre-rinsing position (`mp` param) in step layer | Pre-rinsing height not controllable |
| 10 | No wash cycle parameters (RinseTime, SoakTime, FlowRate, DrainingTime) | Wash step has no parameters |
| 11 | No barcode simulation | STCC barcode assignment and matching not supported |
| 12 | PTL pipetteMode not modeled (1=standard, 2=aliquot) | Cannot distinguish pipette modes |

### MINOR

| # | Issue | Impact |
|---|-------|--------|
| 13 | No scheduler/resource model | Multi-device orchestration not possible |
| 14 | No worklist import/file I/O | Cannot drive protocols from external data |
| 15 | No DataManager equivalent | In-memory data management not relevant to twin |
| 16 | CO-RE grip tool parking position not modeled | `COREGripTool_AtWaste_1000ul` labware |
| 17 | Verification/teaching positions not modeled | `RearVerification`, `FrontVerification` |
| 18 | Plate stacking not modeled | Stack sequences with Z-height ordering |
| 19 | No Starlet deck variant | Training uses ML_Starlet.dck (30 tracks vs 54) |

---

## 10. Recommendations

### Priority 1 — Liquid Class Accuracy

1. **Rename liquid classes to match VENUS convention:**
   ```
   Water_HighVolumeJet_Empty → HighVolume_Water_DispenseJet_Empty
   ```
   Follow pattern: `{TipVolume}_{LiquidType}_{DispenseMode}_{EmptyOrPart}`

2. **Add missing liquid classes:**
   - `StandardVolume_Water_DispenseJet_Empty` (300ul tip, water, jet)
   - `StandardVolume_Water_DispenseSurface_Empty` (300ul tip, water, surface)
   - `StandardVolume_Serum_DispenseJet_Empty` (300ul tip, serum, jet)
   - `HighVolume_Water_AliquotDispenseJet_Part` (1000ul tip, aliquot mode)
   - `Tip_50ul_Water_DispenseSurface_Empty` (50ul tip)
   - `StandardVolumePlasmaDispenseJet_Empty` (300ul tip, plasma)

3. **Add 300ul standard volume tip type** — the most commonly used tip in VENUS training

### Priority 2 — Step Layer Completeness

4. **Add aliquot/multi-dispense step type:**
   - Aspirate once (larger volume + transport air)
   - Dispense N times (partial dispenses)
   - Blow out rest volume to waste
   - Uses `dm=2` (partial surface) or `dm=3` (partial jet) for intermediates, `dm=0` or `dm=1` for final

5. **Add LoadCarrier step** — generates C0CI (identify) + C0CL (load) + C0RC (read content)

6. **Add Z-height parameters to aspirate/dispense steps:**
   - `submergeDepth` (default 2mm for aspirate, 0 for dispense)
   - `fluidHeight` (mm above bottom, 0=auto from LLD)
   - `liquidFollowing` (boolean, default true)
   - `restVolumeDestination` (0=none, 1=waste)

7. **Add wash step parameters:**
   - `rinseTime1/2` (seconds)
   - `soakTime1/2` (seconds)
   - `flowRate1/2` (ml/s)
   - `drainingTime` (seconds)

### Priority 3 — Template Expansion

8. **Add carrier templates:**
   - `PLT_CAR_L5AC_A00` (auto-clamp plate carrier)
   - `SMP_CAR_32_EPIS_A00` (Eppendorf tube carrier)
   - `RGT_CAR_5R60_A00` (5×60ml reagent carrier)
   - `TIP_CAR_480BC_TIP_50ul_A00` (50ul tip carrier)

9. **Add labware templates:**
   - `HAM_DW_12_ml` (96 deepwell, 12ml per well)
   - `ST_L` (300ul standard tip rack — different height from HT_L)
   - `TIP_50ul_L` (50ul tip rack)
   - `rgt_cont_60ml_BC_A00` (60ml barcoded trough)

### Priority 4 — Protocol Fidelity

10. **Add STARlet deck variant** — 30 tracks, narrower waste block position

11. **Add gripper tool parking** — `COREGripTool_AtWaste_1000ul` as waste block labware

12. **Consider plate stacking** — Z-height sorted sequences for multi-plate stacks

---

## Appendix A: Complete File Tree

```
STAR VENUS INFO ML API/
├── venus_training/
│   ├── 01 Venus three - Basic training/
│   │   ├── A_Training/  (29 numbered modules: slides + exercises)
│   │   └── B_SolutionForChallenges/  (9 complete working methods)
│   ├── 02 Venus three - Advanced Training/
│   │   ├── A_Training/  (12 numbered modules)
│   │   └── B_SolutionForChallenges/  (4 complete methods)
│   ├── 03 Liquid Handling/  (2 PPT presentations: Basic + TADM/ADC)
│   └── 04 HSL Training/
│       ├── Challenges/  (9 exercises)
│       ├── Doc/  (8 PDF references)
│       ├── Libraries/  (ASWStandards, INIConfig, SQLDatabase)
│       ├── Slides/  (4 PPTs + HxRunIntegration C# project)
│       └── Solutions/  (7 HSL templates + COMExample)
├── VENUS-Schulungs-Videos/  (4 MP4 recordings, ~2GB)
├── Macros alt/  (empty folder structure — production macros removed)
├── Methoden/  (empty — EP Washer, RunIn Washer)
└── Star Auslieferungen/  (empty — delivery records)
```

## Appendix B: Pipetting Pattern Catalog from Training

### Pattern A — Standard Single Transfer
```
TipPickUp(300ul tips, cLLD=0)
→ Aspirate(source, cLLD=5, submerge=2mm, liquidFollowing=ON, preRinse=5×20ul@2mm)
→ Dispense(dest, jet mode, height=10mm, liquidFollowing=ON)
→ TipEject(waste)
```

### Pattern B — Aliquot from Reagent Trough
```
TipPickUp(1000ul tips, cLLD=0)
→ Loop 12×:
    Aspirate(trough, pLLD=3, submerge=2mm, liquidFollowing=ON)
    Dispense(plate, jet, height=5mm)
→ RestVolume → Waste
→ TipEject(waste)
```

### Pattern C — Worklist-Driven Variable Volume
```
ImportWorklist(Excel, SQL filter)
→ MatchWorklist(barcodes)
→ PTL::Pipette2(device, tipSeq, srcSeq, dstSeq, volumeArray[])
```

### Pattern D — DNA Dilution (Final Exam)
```
Dialog(numSamples, dnaVolume)
teWaterVol = 150 - dnaVolume
PREPROCESSING::Initialize(ML_STAR)
PROCESSING::TransferDilution(teWaterVol, 300ul tips)  // TE water → dilution plate
PROCESSING::TransferSamples(dnaVolume, 50ul tips, across 3 carriers)  // DNA → dilution plate
POSTPROCESSING::GenerateReport()
```
