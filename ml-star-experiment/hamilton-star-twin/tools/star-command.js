#!/usr/bin/env node
/**
 * Hamilton STAR FW Command Assembler & Sender
 *
 * Builds firmware commands from human-readable parameters and sends
 * them to the running digital twin via the HTTP API (port 8222).
 *
 * Uses the twin's deck model to compute exact well coordinates —
 * just like VENUS does for the real instrument.
 *
 * Usage:
 *   node tools/star-command.js                    # run default transfer demo
 *   node tools/star-command.js <script.json>      # run a command script
 *
 * Script format (JSON):
 *   [
 *     { "action": "init" },
 *     { "action": "tip_pickup", "carrier": "TIP001", "position": 0, "channels": [0,1,2,3], "tipType": 4 },
 *     { "action": "aspirate", "carrier": "SMP001", "position": 0, "row": 0, "startCol": 0, "channels": [0,1,2,3], "volume": 100 },
 *     { "action": "dispense", "carrier": "DST001", "position": 0, "row": 0, "startCol": 0, "channels": [0,1,2,3], "volume": 100, "mode": "jet" },
 *     { "action": "tip_eject" }
 *   ]
 */

const http = require("http");

const API_BASE = "http://localhost:8222";

// ============================================================================
// HTTP helpers
// ============================================================================

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, API_BASE);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    http.get(url, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    }).on("error", reject);
  });
}

// ============================================================================
// Deck coordinate computation (mirrors deck.ts logic)
// ============================================================================

const TRACK_PITCH = 225;      // 22.5mm in 0.1mm
const X_OFFSET = 1000;        // Track 1 center
const Y_FRONT_EDGE = 630;     // Front edge of carrier slots
const Y_REAR_EDGE = 4530;     // Rear edge of carrier slots

/** Compute well position from deck layout data — must match deck.ts */
function wellPosition(deck, carrierId, position, row, column) {
  const carrier = deck.carriers.find((c) => c.id === carrierId);
  if (!carrier) throw new Error(`Carrier '${carrierId}' not found on deck`);

  const lw = carrier.labware[position];
  if (!lw) throw new Error(`No labware at ${carrierId} position ${position}`);

  // Carrier left edge X (offsetX is relative to left edge)
  const carrierLeftX = X_OFFSET + (carrier.track - 1) * TRACK_PITCH - TRACK_PITCH / 2;

  // Position Y: positions arranged front-to-back (matches deck.ts)
  const posPitchY = (Y_REAR_EDGE - Y_FRONT_EDGE) / carrier.positions;
  const positionBaseY = Y_FRONT_EDGE + position * posPitchY;

  // Well geometry
  const wellPitch = lw.wellPitch || 90;
  const offsetX = lw.offsetX || 145;
  const offsetY = lw.offsetY || 115;

  const wellX = Math.round(carrierLeftX + offsetX + column * wellPitch);
  const wellY = Math.round(positionBaseY + offsetY + row * wellPitch);

  return { x: wellX, y: wellY };
}

/** Build tip mask from channel array [0,1,2,3] -> 15 */
function tipMask(channels) {
  let mask = 0;
  for (const ch of channels) mask |= (1 << ch);
  return mask;
}

// ============================================================================
// FW command assemblers
// ============================================================================

function assembleInit() {
  return [
    { raw: "C0VI", desc: "System pre-initialize" },
    { raw: null, completion: "init.done", desc: "Hardware init complete" },
    { raw: "C0DI", desc: "Initialize PIP channels" },
  ];
}

function assembleTipPickup(deck, carrierId, position, channels, tipType) {
  // First channel position — remaining channels offset along Y by 9mm each
  const pos = wellPosition(deck, carrierId, position, 0, 0);
  // Channels pick up from row positions: ch0 = row 0, ch1 = row 1, etc.
  // Base Y = well A1 Y for channel 0
  const baseY = pos.y;
  const tm = tipMask(channels);
  return [
    { raw: `C0TPtm${tm}tt${tipType}xp${pos.x}yp${baseY}`, desc: `Tip pickup: ${channels.length} ch from ${carrierId} pos ${position}, type ${tipType}` },
  ];
}

function assembleAspirate(deck, carrierId, position, row, startCol, channels, volumeUL) {
  const pos = wellPosition(deck, carrierId, position, row, startCol);
  const av = Math.round(volumeUL * 10);  // Convert uL to 0.1uL
  const tm = tipMask(channels);
  const wellName = String.fromCharCode(65 + row) + (startCol + 1);
  return [
    { raw: `C0AStm${tm}av${av}xp${pos.x}yp${pos.y}`, desc: `Aspirate ${volumeUL}uL from ${carrierId} pos ${position} ${wellName}+ (${channels.length} ch)` },
  ];
}

function assembleDispense(deck, carrierId, position, row, startCol, channels, volumeUL, mode) {
  const pos = wellPosition(deck, carrierId, position, row, startCol);
  const dv = Math.round(volumeUL * 10);
  const dm = mode === "jet" ? 0 : mode === "partial" ? 2 : mode === "empty" ? 4 : 0;
  const tm = tipMask(channels);
  const wellName = String.fromCharCode(65 + row) + (startCol + 1);
  return [
    { raw: `C0DStm${tm}dm${dm}dv${dv}xp${pos.x}yp${pos.y}`, desc: `Dispense ${volumeUL}uL ${mode} to ${carrierId} pos ${position} ${wellName}+ (${channels.length} ch)` },
  ];
}

function assembleMove(xMM) {
  const xp = Math.round(xMM * 10);
  return [
    { raw: `C0JMxp${xp}`, desc: `Move PIP arm to X=${xMM}mm` },
    { raw: null, completion: "move.done", desc: "Move complete" },
  ];
}

function assembleTipEject() {
  return [{ raw: "C0TR", desc: "Eject tips" }];
}

// ============================================================================
// Sequence runner
// ============================================================================

async function runStep(step) {
  if (step.raw) {
    const result = await httpPost("/command", { raw: step.raw });
    const ok = result.accepted && result.errorCode === 0;
    const status = ok ? "OK" : `ERROR ${result.errorCode}: ${result.errorDescription || "?"}`;
    console.log(`  >> ${step.raw}`);
    console.log(`     ${step.desc}`);
    console.log(`     [${status}]`);
    if (result.deckInteraction?.effect) {
      console.log(`     DECK: ${result.deckInteraction.effect}`);
    }
    return ok;
  } else if (step.completion) {
    await httpPost("/completion", { event: step.completion });
    console.log(`  >> ${step.completion} (completion)`);
    console.log(`     ${step.desc}`);
    return true;
  }
  return true;
}

async function runSequence(steps) {
  for (const step of steps) {
    const ok = await runStep(step);
    if (!ok) {
      console.log("\n  ABORTED — command failed.");
      return false;
    }
  }
  return true;
}

// ============================================================================
// High-level action processor
// ============================================================================

async function processAction(deck, action) {
  switch (action.action) {
    case "init":
      return assembleInit();

    case "tip_pickup":
      return assembleTipPickup(deck, action.carrier, action.position ?? 0,
        action.channels ?? [0,1,2,3,4,5,6,7], action.tipType ?? 4);

    case "aspirate":
      return assembleAspirate(deck, action.carrier, action.position ?? 0,
        action.row ?? 0, action.startCol ?? 0, action.channels ?? [0,1,2,3,4,5,6,7],
        action.volume ?? 100);

    case "dispense":
      return assembleDispense(deck, action.carrier, action.position ?? 0,
        action.row ?? 0, action.startCol ?? 0, action.channels ?? [0,1,2,3,4,5,6,7],
        action.volume ?? 100, action.mode ?? "jet");

    case "move": {
      // Calculate X from target well position (not carrier center!)
      let xMM = action.xMM;
      if (!xMM && action.carrier) {
        const pos = wellPosition(deck, action.carrier, action.position ?? 0, action.row ?? 0, action.startCol ?? 0);
        xMM = pos.x / 10;
      }
      return assembleMove(xMM || 200);
    }

    case "tip_eject":
      return assembleTipEject();

    case "reset":
      await httpPost("/reset", {});
      console.log("  >> RESET");
      return [];

    default:
      console.log(`  Unknown action: ${action.action}`);
      return [];
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Check connection
  let deck;
  try {
    deck = await httpGet("/deck");
    if (!deck.carriers) throw new Error("Invalid response");
  } catch (err) {
    console.error("Cannot connect to twin at", API_BASE);
    console.error("Make sure the Electron app is running: npx electron dist/main/main.js");
    process.exit(1);
  }

  console.log(`\n  Connected to Hamilton STAR Digital Twin`);
  console.log(`  Deck: ${deck.carriers.length} carriers, ${deck.totalTracks} tracks\n`);

  // Load script from argument or use default demo
  const scriptFile = process.argv[2];
  let actions;

  if (scriptFile) {
    const fs = require("fs");
    actions = JSON.parse(fs.readFileSync(scriptFile, "utf-8"));
    console.log(`  Running script: ${scriptFile} (${actions.length} actions)\n`);
  } else {
    // Default: 8-channel transfer from source to destination plate
    console.log("  Running default demo: 8-channel 100uL transfer\n");
    actions = [
      { action: "init" },
      { action: "tip_pickup", carrier: "TIP001", position: 0, channels: [0,1,2,3,4,5,6,7], tipType: 4 },
      { action: "aspirate", carrier: "SMP001", position: 0, row: 0, startCol: 0, channels: [0,1,2,3,4,5,6,7], volume: 100 },
      { action: "move", carrier: "DST001" },
      { action: "dispense", carrier: "DST001", position: 0, row: 0, startCol: 0, channels: [0,1,2,3,4,5,6,7], volume: 100, mode: "jet" },
      { action: "tip_eject" },
    ];
  }

  // Process each action
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    console.log(`\n  === Step ${i + 1}: ${action.action.toUpperCase()} ===`);

    const steps = await processAction(deck, action);
    const ok = await runSequence(steps);
    if (!ok) break;
  }

  // Show final state
  console.log("\n  === Final State ===");
  const tracking = await httpGet("/tracking");
  const usedTips = Object.entries(tracking.tipUsage).filter(([, v]) => v);
  const filledWells = Object.entries(tracking.wellVolumes).filter(([, v]) => v > 0);
  console.log(`  Tips used: ${usedTips.length}`);
  console.log(`  Wells with volume: ${filledWells.length}`);
  for (const [key, vol] of filledWells) {
    const [carrier, pos, well] = key.split(":");
    const cols = 12;
    const row = String.fromCharCode(65 + Math.floor(Number(well) / cols));
    const col = (Number(well) % cols) + 1;
    console.log(`    ${carrier} pos ${pos}: ${row}${col} = ${vol / 10} uL`);
  }
  console.log("");
}

main().catch(console.error);
