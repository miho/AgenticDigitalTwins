# Method1.lay — end-to-end pipetting tutorial

Walkthrough of a single-channel aspirate/dispense against the user's
own `C:\Program Files (x86)\Hamilton\Methods\Method1.lay` (a STARlet
layout with one plate carrier holding two Cos_96_DW_1mL plates, one
tip carrier with five 300-µL tip racks, and a waste block).

Every screenshot is taken from the running twin UI after driving the
sequence programmatically through the public REST/FW endpoints —
nothing was staged. The server state and the rendered deck / inspector
agree at every stage.

## Stages

| # | Screenshot | State |
|---|---|---|
| 00 | [venus-reference.png](00-venus-reference.png) | VENUS's own Deck Editor view of `Method1.lay` — visual reference for the twin rendering. |
| 01 | [initial-method1-loaded.png](01-initial-method1-loaded.png) | Twin after `POST /api/deck/load { path: Method1.lay }`. Deck shows both carriers + waste + origin dot + PIP top-bar at x=0. Twin still `sys_off`. |
| 02 | [source-prefilled.png](02-source-prefilled.png) | After `POST /liquid/fill { carrierId: PLT_CAR_L5AC_A00_0001, position: 0, volume: 8000, liquidType: Water }`. The **top** DW96 plate (pos 0 = VENUS SiteId 1 = rear) renders all 96 wells filled blue; inspector reports `pos 0: Cos_96_DW_1mL (96 wells filled)`. Bottom plate still empty. |
| 03 | [tip-picked-up.png](03-tip-picked-up.png) | `C0VI/C0DI/C0EI/C0II` init + `C0TP ch0` at the top tip rack's A1. PIP arm rail and head jump to that position; inspector on the tip rack shows `Tips: 95 available 1 used`. |
| 04 | [aspirated-source.png](04-aspirated-source.png) | `C0AS xp=2756 yp=5300 av00300 tm1` — aspirate 300 µL from top plate A1. Channel 1 panel shows "300 µL Water 7/4". Inspector on the source labware: `Wells filled 96/96, Total volume 76500.00 µL` (was 76800; −300 ✓). Event log: `C0AS DECK: aspirated 300.0uL (requested 300uL) from 1 well(s)`. |
| 05 | [dispensed-target.png](05-dispensed-target.png) | `C0DS xp=2756 yp=1460 dv00300 tm1 dm2` — dispense 300 µL to bottom plate A1. Channel 1 empty again. Inspector on the destination labware: `Wells filled 1/96, Total volume 300.00 µL` with a single bright well (A1) in the Well Map. |
| 06 | [final-overview.png](06-final-overview.png) | Carrier-level inspector view at the end. Contents list: `pos 0: Cos_96_DW_1mL (96 wells filled)` / `pos 4: Cos_96_DW_1mL (1 wells filled)`. Carrier View mini-SVG lays pos 0 at the top (rear) and pos 4 at the bottom (front), matching the deck. |

## Commands exercised

```
C0VIid8001       initialize master
C0DIid8002       initialize PIP
C0EIid8003       initialize 96-head
C0IIid8004       initialize autoload
C0TPid8010xp01180yp05298tm1tt04      tip pickup ch0 at TIP_CAR pos 0 A1
C0ASid8011xp02756yp05300av00300tm1lm0    aspirate 300 µL from PLT pos 0 A1
C0DSid8012xp02756yp01460dv00300tm1dm2    dispense 300 µL to PLT pos 4 A1
```

## What the sequence proves

- `.lay` → Deck import is lossless: carriers at the right tracks,
  labware at the right positions, siteYOffsets correctly ordered
  (position 0 at the rear, position N-1 at the front — matching
  VENUS's SiteId-1 convention).
- Liquid tracking updates end-to-end: fill → aspirate → dispense
  leaves server state, deck rendering, and both inspector views
  (labware detail + carrier overview) in agreement.
- Tip usage is recorded: the picked-up tip marks as used in the
  tip-rack's live inspector and the channel state shows tip fitted.
- Motion envelopes fire: the PIP arm visual moves to each commanded
  (X, Y); the top-bar indicator tracks X even at rest.
