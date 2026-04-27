#!/usr/bin/env node
/**
 * Demo: Simulate a 4-channel sample-to-destination plate transfer.
 *
 * This is what VENUS does under the hood — each step is a single FW command
 * that operates on all specified channels simultaneously via the tip mask.
 *
 * Workflow:
 *   1. Initialize system + PIP channels
 *   2. Pick up 4 tips (channels 1-4) from TIP001 pos 0
 *   3. Aspirate 100uL from source plate SMP001 pos 0
 *   4. Move arm to destination carrier
 *   5. Dispense 100uL (jet) into DST001 pos 0
 *   6. Eject tips to waste
 *
 * Run: node scripts/demo-transfer.js
 */

const { DigitalTwinAPI } = require("../dist/twin/api");

const api = new DigitalTwinAPI();
const deviceId = api.createDevice({ name: "STAR Demo" });

function step(label) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`  VENUS >> ${label}`);
  console.log("=".repeat(64));
}

function cmd(raw, description) {
  const r = api.sendCommand(deviceId, raw);
  const status = r.errorCode > 0
    ? `ERROR ${r.errorCode}: ${r.errorDescription}`
    : r.accepted ? "OK" : "no effect";
  console.log(`\n  FW command:  ${raw}`);
  console.log(`  Description: ${description}`);
  console.log(`  Result:      ${status}`);
  if (r.deckInteraction?.effect) {
    console.log(`  Deck effect: ${r.deckInteraction.effect}`);
  }
  for (const log of r.logs || []) {
    if (!log.startsWith("[pip]")) console.log(`  Log:         ${log}`);
  }
  return r;
}

function evt(event, description) {
  api.sendCompletion(deviceId, event);
  console.log(`\n  Completion:  ${event}`);
  console.log(`  Description: ${description}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showState() {
  const state = api.getState(deviceId);
  const pipVars = state.modules?.pip?.variables || {};
  const pipStates = state.modules?.pip?.states || [];
  const tipCount = (pipVars.tip_fitted || []).filter(Boolean).length;
  const totalVol = (pipVars.volume || []).reduce((s, v) => s + v, 0);

  console.log(`\n  --- PIP State ---`);
  console.log(`  State:     ${pipStates.filter(s => !["operational","idle","tip_fitted_state"].includes(s)).join(", ") || "idle"}`);
  console.log(`  Arm X:     ${(pipVars.pos_x || 0) / 10} mm`);
  console.log(`  Tips:      ${tipCount} fitted`);
  if (tipCount > 0) {
    const fitted = [];
    for (let i = 0; i < 16; i++) {
      if (pipVars.tip_fitted?.[i]) fitted.push(`ch${i + 1}(T${pipVars.tip_type?.[i]})`);
    }
    console.log(`             ${fitted.join(", ")}`);
  }
  console.log(`  Volume:    ${totalVol / 10} uL total`);
  if (totalVol > 0) {
    const vols = [];
    for (let i = 0; i < 16; i++) {
      if (pipVars.volume?.[i] > 0) vols.push(`ch${i + 1}: ${pipVars.volume[i] / 10}uL`);
    }
    console.log(`             ${vols.join(", ")}`);
  }
}

function showDeckTracking() {
  const tracking = api.getDeckTracking(deviceId);
  const usedTips = Object.entries(tracking.tipUsage).filter(([, v]) => v);
  const filledWells = Object.entries(tracking.wellVolumes).filter(([, v]) => v > 0);

  if (usedTips.length > 0 || filledWells.length > 0) {
    console.log(`\n  --- Deck Tracking ---`);
  }
  if (usedTips.length > 0) {
    console.log(`  Tips used: ${usedTips.length}`);
    for (const [key] of usedTips.slice(0, 8)) {
      const [carrier, pos, well] = key.split(":");
      const cols = 12;
      const row = String.fromCharCode(65 + Math.floor(Number(well) / cols));
      const col = (Number(well) % cols) + 1;
      console.log(`    ${carrier} pos ${pos}: ${row}${col}`);
    }
  }
  if (filledWells.length > 0) {
    console.log(`  Wells with volume: ${filledWells.length}`);
    for (const [key, vol] of filledWells) {
      const [carrier, pos, well] = key.split(":");
      const cols = 12;
      const row = String.fromCharCode(65 + Math.floor(Number(well) / cols));
      const col = (Number(well) % cols) + 1;
      console.log(`    ${carrier} pos ${pos}: ${row}${col} = ${vol / 10} uL`);
    }
  }
}

// ============================================================================
// Run the transfer
// ============================================================================

async function main() {
  console.log("\n  ================================================");
  console.log("  Hamilton STAR Digital Twin — Transfer Demo");
  console.log("  I am VENUS, driving the firmware layer.");
  console.log("  ================================================");

  // --- Step 1: Initialize ---
  step("Initialize instrument");
  cmd("C0VI", "Master: system pre-initialization");
  evt("init.done", "Hardware init complete (simulated)");
  cmd("C0DI", "PIP: initialize all 16 channels");
  showState();

  // --- Step 2: Pick up 4 tips ---
  // Tip mask: channels 1-4 = bits 0-3 = 0b1111 = 15
  // Tip carrier TIP001 at track 1, pos 0 = first tip rack
  // xp/yp = position on deck where tips are located
  step("Pick up tips (4 channels, 1000uL)");
  cmd("C0TPtm15tt4xp1700yp745", "Tip pickup: ch 1-4, type 4 (1000uL), at tip rack position");
  showState();
  showDeckTracking();

  // --- Step 3: Aspirate from source plate ---
  // Source plate SMP001 at track 7, pos 0
  step("Aspirate 100uL from source plate");
  cmd("C0ASav1000xp2900yp745", "Aspirate 100uL (1000 x 0.1uL) at source plate position");
  showState();
  showDeckTracking();

  // --- Step 4: Move arm to destination ---
  step("Move arm to destination plate");
  cmd("C0JMxp4200", "Move PIP arm to X=420mm (destination carrier area)");
  showState();

  // Wait for move.done auto-completion from SCXML delayed send
  console.log("\n  (waiting 600ms for move completion...)");
  await wait(600);

  // Check if move completed (should auto-fire move.done)
  showState();

  // --- Step 5: Dispense at destination ---
  step("Dispense 100uL to destination plate (jet mode)");
  cmd("C0DSdm0dv1000xp4200yp745", "Jet dispense 100uL at destination plate position");
  showState();
  showDeckTracking();

  // --- Step 6: Eject tips ---
  step("Eject tips to waste");
  cmd("C0TR", "Eject all tips");
  showState();
  showDeckTracking();

  // --- Final summary ---
  console.log(`\n${"=".repeat(64)}`);
  console.log("  TRANSFER COMPLETE — 4-channel, 100uL each");
  console.log("=".repeat(64));
  showState();
  showDeckTracking();

  console.log(`\n  Launch the Electron app to see the deck visually:`);
  console.log(`  cd hamilton-star-twin && npx electron dist/main/main.js\n`);

  api.destroyDevice(deviceId);
}

main().catch(console.error);
