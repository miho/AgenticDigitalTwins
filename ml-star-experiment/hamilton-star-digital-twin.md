# Hamilton Microlab STAR - Digital Twin Specification

**Version:** 0.1.0 | **Date:** 2026-04-13 | **Status:** Core Workflow Complete

## Purpose

Machine-readable + human-readable specification of the Hamilton Microlab STAR liquid handling system at the firmware command level. Designed to enable:

- Digital twin simulation without physical hardware
- Method development and validation by coding agents
- Automated test generation for VENUS methods
- Integration with CAD models (when available)

## Architecture Overview

```
+------------------+     +-------------------+     +------------------+
|   VENUS Method   |     |  VENUS Software   |     |    Firmware      |
|   (HSL Script)   | --> |  Step Execution    | --> |  Command Layer   |
|                  |     |  (HxGruCommand)   |     | (HxAtsInstrument)|
+------------------+     +-------------------+     +------------------+
                                                          |
                                                    USB / Ethernet
                                                          |
                                                   +------v-------+
                                                   | Master Module|
                                                   |    (C0)      |
                                                   +------+-------+
                                                          |
                                                       CAN Bus
                                    +--------+--------+--------+--------+
                                    |        |        |        |        |
                                  Px(PIP) H0(96H)  T1(Temp) W1(Wash) R0(iSWAP) ...
```

### Three-Layer Mapping

| Layer | Description | Source |
|-------|-------------|--------|
| **VENUS Steps** | User-facing operations (Aspirate, Dispense, Transport...) | HxGruCommand/code/Run*.cpp |
| **FW Commands** | 2-letter ASCII protocol commands sent to Master (C0) | HxAtsInstrument/Code/AtsMc*.cpp |
| **Hardware** | Physical modules connected via CAN bus | Operator's Manual Ch.3 |

### Command Protocol

All commands are ASCII strings sent to the Master Module (C0):

```
C0ASid0001tm1at0xp02980yp1460th2450te2450av05000as01200...
^^ ^^   ^^^^  ^^  ^^     ^^     ^^     ^^     ^^     ^^
|  |    |  |  |   |      |      |      |      |      +-- asp speed
|  |    |  |  |   |      |      |      |      +-- asp volume (0.1ul)
|  |    |  |  |   |      |      |      +-- Z-end
|  |    |  |  |   |      |      +-- traverse height
|  |    |  |  |   |      +-- Y-position
|  |    |  |  |   +-- X-position
|  |    |  |  +-- asp type
|  |    |  +-- tip pattern
|  |    +-- order ID (4 digits)
|  +-- command code (AS = Aspirate)
+-- module prefix (C0 = Master)
```

Response: `C0ASid0001er00/00` (success) or `C0ASid0001er06/00` (error: too little liquid)

---

## Module Catalog

### Core Workflow Modules (Fully Detailed)

| Module | FW Prefix | Commands | Description |
|--------|-----------|----------|-------------|
| **Master** | C0 | ~200 | Central controller, all commands route through here |
| **PIP Channels** | C0 (DI,TP,TR,AS,DS,DF,...) | 30+ | Up to 16x 1000uL independent channels |
| **CO-RE 96 Head** | C0 (EI,EP,ER,EA,ED,...) | 12 | 96-channel parallel pipetting head |
| **AutoLoad** | C0 (II,CI,CL,CR,...) | 16 | Automatic carrier loading with barcode |
| **iSWAP** | C0 (FI,PP,PR,PM,...) | 18 | Robotic plate transport arm |
| **CO-RE Gripper** | C0 (ZT,ZS,ZP,ZR,ZM,...) | 7 | Plate transport via PIP channels |
| **Wash Station** | C0 (WI,WS,WW,WR,...) | 6 | Needle/tip washing |
| **Temperature** | C0 (HI,HC,HF,RP) | 4 | Heating/cooling carriers |
| **Pump Unit** | C0 (EF,EW,ES,...) | 14 | DC wash station pump control |

### Stubbed Modules (Command Lists Only)

| Module | FW Prefix | Doc Ref | Status |
|--------|-----------|---------|--------|
| CO-RE 384 Head | C0 (JA-JD,JI...) | E289241a.doc | Stubbed |
| XL Channels (5mL) | C0 (LA-LD,LI...) | E289243a.doc | Stubbed |
| Nano Dispenser | C0 (NA-NF,NI...) | E289240a.doc | Stubbed |
| Tube Gripper | C0 (FC-FW) | E2891001a.docx | Stubbed |
| Gel Card Gripper | C0 (CJ,BG,CH...) | E289251a.doc | Stubbed |
| Image Channel | C0 (IC-IN) | E289245a.doc | Stubbed |
| Robotic Channels | C0 (OI-OW) | E2891001a.docx | Stubbed |
| Decapper | C0 (UI-UV) | E2891018a.doc | Stubbed |
| Puncher | C0 (BI-BQ) | E2891010a.doc | Stubbed |
| Heater Shaker | T1/TS | E289247a.doc | Stubbed |
| Washer 96 | V1 | E2891013a.doc | Stubbed |
| Centrifuge | CAN slave | E2891023a.docx | Stubbed |
| Gel Card Incubator | TB | E2891022a.docx | Stubbed |
| RD5 Process Unit | CAN slave | E2891016a.docx | Stubbed |
| RD5 Loading Unit | CAN slave | E2891017a.docx | Stubbed |
| 2D AutoLoad | CAN slave | E2891024a.docx | Stubbed |
| Head Squeezer | I2C | E2891026a.docx | Stubbed |

---

## VENUS Step Hierarchy

### Power Steps (Highest Level)
Wizard-based workflow steps that combine multiple Easy/Single steps:
- **TransferSamples** - Full sample transfer workflow
- **AddReagent** - Reagent addition to plate
- **SerialDilution** - Serial dilution series
- **Replicates** - Plate replication
- **HitPicking** - Worklist-based cherry picking
- **LoadAndMatch** - Load and barcode-match carriers

### Easy Steps (Composite)
Each decomposes into a sequence of Single Steps:

| Easy Step | Decomposes To | FW Commands |
|-----------|--------------|-------------|
| EasyAspirate | TipPickUp + Aspirate | C0TP + C0AS |
| EasyDispense | Dispense + TipEject | C0DS + C0TR |
| EasyHead96Aspirate | Head96TipPickUp + Head96Aspirate | C0EP + C0EA |
| EasyHead96Dispense | Head96Dispense + Head96TipEject | C0ED + C0ER |
| EasyISwapTransport | GetPlate + MovePlate + PutPlate | C0PP + C0PM + C0PR |
| EasyCOREGripTransport | GetTool + GetPlate + Move + PutPlate + DiscardTool | C0ZT + C0ZP + C0ZM + C0ZR + C0ZS |

### Single Steps (Direct FW Wrappers)

Each maps to exactly one firmware command via the chain:

```
Run_Aspirate (CRunAspirate.cpp)
  -> m_pcommand->getInstrumentPtr()->McAspirate()
    -> new AtsMcAspirate()
      -> prepareCommand() builds "C0AS..." string
        -> sent to hardware via USB/Ethernet
```

**Core Liquid Handling:**
| Step | FW Code | AtsMc Class |
|------|---------|-------------|
| Initialize | C0DI | AtsMcInitDispenseChannels |
| TipPickUp | C0TP | AtsMcPickUpTip |
| TipEject | C0TR | AtsMcEjectTip |
| Aspirate | C0AS | AtsMcAspirate |
| Dispense | C0DS | AtsMcDispense |
| DispenseFly | C0DF | AtsMcChannelDispenseFly |

**96-Head:**
| Step | FW Code | AtsMc Class |
|------|---------|-------------|
| Head96TipPickUp | C0EP | AtsMc96HeadPickUpTip |
| Head96TipEject | C0ER | AtsMc96HeadEjectTip |
| Head96Aspirate | C0EA | AtsMc96HeadAspirate |
| Head96Dispense | C0ED | AtsMc96HeadDispense |

**Transport:**
| Step | FW Code | AtsMc Class |
|------|---------|-------------|
| GetPlate (iSWAP) | C0PP | AtsMcGetPlate |
| PutPlate (iSWAP) | C0PR | AtsMcPutPlate |
| MovePlate | C0PM | AtsMcMovePlate |
| LoadCarrier | C0CL | AtsMcLoadCarrier |
| UnloadCarrier | C0CR | AtsMcUnloadCarrier |

---

## State Models

### Pipetting Channel State Machine
```
                    +---> [error] <---+
                    |                 |
[not_initialized] --DI--> [idle] --TP--> [tip_fitted] --AS--> [aspirated]
                                  ^            |    ^              |
                                  |           TR    |             DS
                                  |            v    +---(loop)----+
                                  +--- (tip ejected)
```

### iSWAP State Machine
```
[not_initialized] --FI--> [parked] --> [empty] --PP--> [plate_gripped] --PR--> [empty]
                                         ^                    |
                                         |         PM (move)  |
                                        PG                    v
                                         +---- [parked] <----+
```

### AutoLoad State Machine
```
[not_initialized] --II--> [idle] --CL--> [loading] --> [idle]
                            |                            ^
                            +----CR--> [unloading] ------+
                            |
                            +----CI--> [identifying] ----+
```

---

## Error Codes (Master Module)

| Code | Meaning | Typical Cause |
|------|---------|---------------|
| 00 | No error | |
| 02 | Hardware error | Drive blocked, low power |
| 04 | Clot detected | cLLD signal not interrupted |
| 06 | Too little liquid | LLD surface not found |
| 07 | Tip already fitted | Double tip pickup attempt |
| 08 | No tip | Command requires fitted tip |
| 17 | Aspiration error | Liquid stream disruption |
| 20 | TADM error | Pressure overshoot |
| 26 | TADM limit exceeded | Tolerance band violation |
| 99 | Slave error | Error in downstream module |

Full error table: see `hamilton-star-digital-twin.json` -> `error_codes`

---

## File Map

| File | Purpose |
|------|---------|
| `hamilton-star-digital-twin.json` | Machine-readable spec (158 KB) — THE authoritative source |
| `hamilton-star-digital-twin.md` | This file — human-readable overview |
| `build_digital_twin.py` | Generator script (can be re-run to rebuild JSON) |
| `Command sets (13.04.2026)/hamilton_command_specs_extracted.json` | Raw FW command extraction (1.8 MB, 3,569 commands) |
| `Command sets (13.04.2026)/extracted_text/` | Plain text of all .doc files |

---

## Roadmap

| Phase | Name | Status | Scope |
|-------|------|--------|-------|
| 1 | Core Workflow | **Done** | Master, PIP, 96 Head, AutoLoad, iSWAP, Gripper, Wash, TCC |
| 2 | Full Module Detail | Planned | Expand all 21 stubbed modules with full parameters |
| 3 | Deck & Labware Model | Planned | Track positions, carrier types, labware definitions |
| 4 | Liquid Class Model | Planned | Aspiration/dispense parameter sets per liquid type |
| 5 | CAD Integration | Planned | Physical dimensions, collision volumes, 3D geometry |
| 6 | Simulation Engine | Planned | State machine execution, command validation, virtual traces |

---

## Source Material Reference

| Document | Pages | Covers |
|----------|-------|--------|
| Operator's Manual | 206 | Hardware components, specs, maintenance |
| Programmer's Manual | ~400 | VENUS software, HSL, step programming |
| 36 FW Command Docs | ~1000+ | Every firmware command with parameters |
| VENUS Source (Star/src/) | ~1000 files | C++ implementation of all layers |

---

*Generated 2026-04-13. Authoritative source: `hamilton-star-digital-twin.json`*
