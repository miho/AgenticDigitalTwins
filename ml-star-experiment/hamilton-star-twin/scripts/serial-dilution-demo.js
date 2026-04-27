#!/usr/bin/env node
/**
 * Live serial-dilution demo — drives the running twin over HTTP so the
 * user can watch the sequence in the Electron / browser UI.
 *
 * What it does, on one Cos_96_DW_1mL plate (pos 0 of PLT_CAR_L5AC_A00_0001
 * as loaded from Method1.lay):
 *
 *   Column 1       : 200 µL Stock  (magenta)  — the concentrated source
 *   Columns 2..12  : 100 µL Diluent (green)   — the dilution buffer
 *
 *   Then, 11× over: aspirate 100 µL from col N (all 8 channels), dispense
 *   100 µL to col N+1. Each step halves the stock concentration:
 *
 *     col 1: stock        → col 2: 1/2 × stock  → col 3: 1/4 × stock  …
 *
 *   The deck SVG shows a live color gradient from magenta → mixed →
 *   green as the dilution propagates across the plate.
 *
 * PREREQUISITES
 *   - Twin is running (either `npm start` for Electron, or `npm run
 *     dev:server` for headless). Default port 8222; override with
 *     $TWIN_PORT env var.
 *   - Method1.lay is available at the path below; override with
 *     $TWIN_LAY env var.
 *
 * USAGE
 *   node scripts/serial-dilution-demo.js                       # reuse tips
 *   FRESH_TIPS=1 node scripts/serial-dilution-demo.js          # eject+pickup between steps
 *   TWIN_PORT=8223 node scripts/serial-dilution-demo.js
 *   STEP_DELAY_MS=1200 node scripts/serial-dilution-demo.js    # slower
 *
 * TIP-HANDLING TOGGLE (FRESH_TIPS)
 *   Default (off): one tip set picked up at the start, reused for all 11
 *   transfers, ejected at the end. Minimum arm movement, fastest demo.
 *   Every well that the channel visits contaminates the tip with its
 *   mixture — the twin's contamination assessments fire every step.
 *
 *   On (FRESH_TIPS=1): a clean tip set is fetched from the tip rack before
 *   each transfer and ejected to waste after. This is the realistic
 *   serial-dilution procedure — no carry-over between columns. Uses
 *   11 × 8 = 88 tips (columns 1..11 of the 300 µL rack at TIP_CAR pos 0),
 *   which fits in a single rack.
 */

const http = require("http");

const HOST = process.env.TWIN_HOST || "127.0.0.1";
const PORT = Number(process.env.TWIN_PORT || 8222);
const LAY = process.env.TWIN_LAY || "C:\\Program Files (x86)\\Hamilton\\Methods\\Method1.lay";
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 600);
const FRESH_TIPS = /^(1|true|yes|on)$/i.test(process.env.FRESH_TIPS || "");

// ── Minimal HTTP helpers (no deps) ────────────────────────────────────

function request(method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => {
          try { resolve(chunks ? JSON.parse(chunks) : {}); }
          catch (e) { reject(new Error(`bad JSON from ${path}: ${chunks.slice(0, 120)}`)); }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const post = (path, body) => request("POST", path, body ?? {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── FW command helpers ────────────────────────────────────────────────

let orderId = 0;
const nextId = () => String(++orderId).padStart(4, "0");
const pad5 = (n) => String(Math.round(n)).padStart(5, "0");

// Per-channel Y array for tm=255 (all 8 channels, fixed 9 mm pitch).
//   ch0 at yA, ch1 at yA-90, …, ch7 at yA-630.
const yMask8 = (yA) =>
  Array.from({ length: 8 }, (_, i) => pad5(yA - i * 90)).join(" ");

async function send(raw, description) {
  const preview = raw.length > 72 ? raw.slice(0, 72) + "…" : raw;
  process.stdout.write(`  >>> ${preview}\n`);
  if (description) process.stdout.write(`      · ${description}\n`);
  const r = await post("/command", { raw });
  if (r.errorCode > 0) {
    process.stdout.write(`      ! er${r.errorCode} ${r.errorDescription || ""}\n`);
  } else if (r.deckInteraction && r.deckInteraction.effect) {
    process.stdout.write(`      · ${r.deckInteraction.effect}\n`);
  }
  await sleep(STEP_DELAY_MS);
  return r;
}

// ── Plate / tip geometry (matches Method1.lay after the SiteId flip) ──

const PLT_CARRIER = "PLT_CAR_L5AC_A00_0001";
const PLT_POS     = 0;              // VENUS SiteId 1 = rear plate on the carrier
const PLT_XP_COL1 = 2755;           // plate col 1 X (0.1 mm)
const PLT_YP_ROWA = 5300;           // plate row A Y (0.1 mm) — rear plate
const COL_PITCH   = 90;             // 9 mm between columns

// Plate Z geometry (Cos_96_DW_1mL — 40 mm-deep 96 deep-well plate).
//   plate top = 1872 (187.2 mm above deck)  — ZTrans / well A1 top
//   well depth = 400 (40 mm)
//   well bottom = 1472 (147.2 mm above deck)
// These match labware-catalog.ts Cos_96_DW_1mL and the loaded .rck.
const PLT_TOP_Z        = 1872;
const PLT_WELL_BOTTOM  = 1472;
const PLT_ASP_Z        = PLT_WELL_BOTTOM + 20;  // 2 mm above bottom — fixed-height aspirate (lm=0)
const PLT_DSP_Z        = PLT_WELL_BOTTOM + 100; // 10 mm above bottom — dispense clear of aspirated volume

const TIP_XP_COL1 = 1180;           // TIP_CAR pos 0 col 1 X
const TIP_YP_ROWA = 5298;           // TIP_CAR pos 0 row A Y

// Tip rack Z geometry (Tips_300uL).
//   rack top   = 1645 (164.5 mm — ZTrans)
//   tip length = 600  (60 mm — from labware-catalog tipLength for 300 µL)
//   tip collar protrusion = 120 (12 mm above rack top)
//   pickup depth: nozzle lands ~4 mm into the collar.
const TIP_RACK_TOP     = 1645;
const TIP_LEN_300      = 600;   // 300 µL tip length
const TIP_PROTRUSION   = 120;
const TIP_COLLAR_HALF  = 40;    // half of 8 mm collar
const TIP_PICKUP_Z     = TIP_RACK_TOP + TIP_PROTRUSION - TIP_COLLAR_HALF;  // 1725 = 172.5 mm
// Post-retract traverse MUST clear the fitted tip over any labware
// along the return path. Plate is 187.2 mm tall; tips hang 60 mm below
// nozzle, so nozzle needs to be >= 187.2 + 60 + 5 = 252.2 mm.
const TIP_RACK_TRAVERSE= TIP_RACK_TOP + TIP_LEN_300 + 50;                  // 2295 = 229.5 mm (no plate on return)
const PLT_TIP_TRAVERSE = PLT_TOP_Z + TIP_LEN_300 + 50;                     // 2522 = 252.2 mm (over the plate)

const WASTE_XP    = 13400;          // waste block X
const WASTE_YP_A  = 4050;           // waste block row A Y
const WASTE_EJECT_Z = 100;          // 10 mm above deck — matches deck.getWasteEjectPositions().z

const STOCK_VOL_01UL   = 2000;      // 200 µL in col 1 per well
const DILUENT_VOL_01UL = 1000;      // 100 µL in cols 2..12 per well
const XFER_VOL_01UL    = 1000;      // 100 µL transferred each step

// ── Main ──────────────────────────────────────────────────────────────

// Pick up a fresh column of tips. `tipCol` is 0-based — column 0 = col 1 A1.
//
// Real-VENUS C0TP always includes:
//   tp = pickup Z (nozzle dips into the tip collar to grip)
//   th = post-retract Z (tip + safety clearance above the rack so the
//        fitted tip doesn't collide with the rack on the way out)
// Omitting these makes the twin's motion envelope skip the descend
// phase (no dwellZ) — same behaviour real STAR firmware would exhibit
// if the command were malformed. The twin treats absent Z params as
// "command didn't specify a Z target" and does NOT fabricate one.
async function pickUpTips(tipCol) {
  const xp = TIP_XP_COL1 + tipCol * COL_PITCH;
  return send(
    `C0TPid${nextId()}xp${pad5(xp)}yp${yMask8(TIP_YP_ROWA)}tm255tt04tp${pad5(TIP_PICKUP_Z)}th${pad5(TIP_RACK_TRAVERSE)}`,
    `pick up 8 tips on channels 1..8 from TIP rack pos 0 col ${tipCol + 1}`,
  );
}

// Eject the currently-fitted tip set to the waste block.
// Real-VENUS C0TR includes tz (eject Z — where the waste collar strips
// the tip) and th (post-retract). Tips have zero length after eject so
// th can be the nominal 1450 traverse.
async function ejectTips(tag) {
  return send(
    `C0TRid${nextId()}xp${pad5(WASTE_XP)}yp${yMask8(WASTE_YP_A)}tm255tz${pad5(WASTE_EJECT_Z)}th${pad5(1450)}`,
    tag || "eject all 8 tips to waste",
  );
}

async function main() {
  console.log(`Serial dilution demo — twin at http://${HOST}:${PORT}`);
  console.log(`Layout: ${LAY}`);
  console.log(`Tip handling: ${FRESH_TIPS ? "FRESH tips per step (11× pickup + eject)" : "reuse one tip set"}`);
  console.log(`Step delay: ${STEP_DELAY_MS} ms (raise via $STEP_DELAY_MS to slow down)\n`);

  console.log("── 1/4  Reset + (optional) reload deck ──────────────────");
  await post("/reset");
  await sleep(300);
  // Only override the default deck if a real .lay is resolvable. The
  // twin's default deck already has the TIP_CAR_480 + PLT_CAR_L5AC
  // layout the script targets, so running without TWIN_LAY works.
  const loaded = await post("/api/deck/load", { path: LAY });
  const placements = Array.isArray(loaded.placements) ? loaded.placements.length : 0;
  if (loaded.error || placements === 0) {
    console.log(`  Layout "${LAY.split(/[\\/]/).pop()}" not usable (${loaded.error || "0 placements"}); using default deck.`);
  } else {
    console.log(`  Loaded ${placements} placements from ${LAY.split(/[\\/]/).pop()}`);
  }
  await sleep(300);

  console.log("\n── 2/4  Pre-fill source + diluent columns ───────────────");
  const fill = (target, columns, liquidType, vol01ul) =>
    post("/step", {
      type: "fill",
      params: {
        carrierId: PLT_CARRIER,
        position:  PLT_POS,
        liquidType, liquidClass: "default",
        volume:    vol01ul,
        target,    columns,
      },
    });
  await fill("columns", [0], "Stock", STOCK_VOL_01UL);
  console.log(`  col 1      : ${STOCK_VOL_01UL / 10} µL Stock  (magenta) × 8 wells`);
  await fill("columns", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "Diluent", DILUENT_VOL_01UL);
  console.log(`  cols 2..12 : ${DILUENT_VOL_01UL / 10} µL Diluent (green)   × 88 wells`);
  await sleep(500);

  console.log("\n── 3/4  Initialize ───────────────────────────────────────");
  await send("C0VIid" + nextId(), "master init (C0VI)");
  await send("C0DIid" + nextId(), "PIP init (C0DI)");

  // In reuse mode, grab one tip set up front and keep it until the end.
  if (!FRESH_TIPS) {
    console.log("\n      Pick up a single tip set (reuse for all 11 transfers)");
    await pickUpTips(0);
  }

  console.log(
    `\n── 4/4  Serial dilution: 11 transfers, 100 µL each${FRESH_TIPS ? " (fresh tips each step)" : ""} ──`,
  );
  for (let i = 0; i < 11; i++) {
    const srcX = PLT_XP_COL1 +  i      * COL_PITCH;
    const dstX = PLT_XP_COL1 + (i + 1) * COL_PITCH;
    console.log(`\n  Step ${String(i + 1).padStart(2, " ")}/11 — col ${i + 1} → col ${i + 2}`);

    // Fresh-tip mode: pick up a clean column of tips before each
    // transfer. col 1 of the tip rack for step 1, col 2 for step 2, etc.
    // 11 steps use cols 1..11 of the 300 µL rack at pos 0 (one rack).
    if (FRESH_TIPS) {
      await pickUpTips(i);
    }

    // Fixed-Z aspirate (lm=0, no LLD). Real-VENUS always carries:
    //   zp — target tip Z (we aim 2 mm above well bottom)
    //   th — post-retract Z (above the plate top + fitted-tip length
    //        + safety; otherwise the fitted tip collides with the
    //        plate wall on the retract)
    //   te — minimum Z floor (same as th for no-LLD fixed-Z moves)
    // Omitting zp makes the twin's motion envelope skip the descend
    // phase (same as real FW would — the command doesn't carry a Z
    // target so the arm has nowhere to descend to).
    await send(
      `C0ASid${nextId()}xp${pad5(srcX)}yp${yMask8(PLT_YP_ROWA)}zp${pad5(PLT_ASP_Z)}th${pad5(PLT_TIP_TRAVERSE)}te${pad5(PLT_TIP_TRAVERSE)}av${pad5(XFER_VOL_01UL)}tm255lm0`,
      `aspirate ${XFER_VOL_01UL / 10} µL × 8 from col ${i + 1} @ Z=${(PLT_ASP_Z / 10).toFixed(1)}mm`,
    );
    await send(
      `C0DSid${nextId()}xp${pad5(dstX)}yp${yMask8(PLT_YP_ROWA)}zp${pad5(PLT_DSP_Z)}th${pad5(PLT_TIP_TRAVERSE)}te${pad5(PLT_TIP_TRAVERSE)}dv${pad5(XFER_VOL_01UL)}tm255dm2`,
      `dispense ${XFER_VOL_01UL / 10} µL × 8 into col ${i + 2} @ Z=${(PLT_DSP_Z / 10).toFixed(1)}mm`,
    );

    // Fresh-tip mode: eject after each transfer so the next step gets a
    // genuinely uncontaminated tip set — this is the whole point of the
    // toggle (no cross-column carry-over in the contamination tracker).
    if (FRESH_TIPS) {
      await ejectTips(`eject tips used for col ${i + 1} → col ${i + 2}`);
    }
  }

  // Reuse mode keeps the single tip set until the very end.
  if (!FRESH_TIPS) {
    console.log("\n── Eject tips + done ────────────────────────────────────");
    await ejectTips("eject the reused tip set at method end");
  } else {
    console.log("\n── Done ─────────────────────────────────────────────────");
  }
  console.log(
    `\n  Final plate: col 1 = Stock, col 12 ≈ Stock / 2^11 = 1/2048 × Stock.`,
  );
  console.log(`  Open the inspector on any well to compare volumes + components.\n`);
}

main().catch((err) => {
  console.error("\nDemo failed:", err && err.message ? err.message : err);
  process.exit(1);
});
