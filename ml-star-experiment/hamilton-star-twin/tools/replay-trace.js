#!/usr/bin/env node
/**
 * Replay a real VENUS ComTrace .trc file against the digital twin.
 *
 * Parses the trace, sends each command to the twin, and reports:
 * - Which commands were accepted
 * - Which commands were rejected (and why)
 * - Which command prefixes are unhandled
 *
 * Usage:
 *   node tools/replay-trace.js <path-to-trace.trc>
 *   node tools/replay-trace.js <path-to-trace.trc> --layout <path-to.lay>
 *   node tools/replay-trace.js <path-to-trace.trc> --auto-layout
 *
 * --auto-layout: automatically search for a .lay file in the trace directory
 * --layout:      path to a specific VENUS .lay file
 * --venus-root:  path to VENUS source tree (for resolving .tml/.rck files)
 */

const fs = require("fs");
const path = require("path");
const { DigitalTwinAPI } = require("../dist/twin/api");

// Parse args
const args = process.argv.slice(2);
let traceFile = null;
let layoutFile = null;
let autoLayout = false;
let venusRoot = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--layout" && args[i + 1]) {
    layoutFile = args[++i];
  } else if (args[i] === "--auto-layout") {
    autoLayout = true;
  } else if (args[i] === "--venus-root" && args[i + 1]) {
    venusRoot = args[++i];
  } else if (!args[i].startsWith("-")) {
    traceFile = args[i];
  }
}

if (!traceFile) {
  console.error("Usage: node tools/replay-trace.js <trace.trc> [--layout <file.lay>] [--auto-layout] [--venus-root <path>]");
  process.exit(1);
}

// Auto-detect layout file in the trace directory
if (!layoutFile && autoLayout) {
  const traceDir = path.dirname(traceFile);
  const layFiles = fs.readdirSync(traceDir).filter(f => f.endsWith(".lay"));
  if (layFiles.length === 1) {
    layoutFile = path.join(traceDir, layFiles[0]);
  } else if (layFiles.length > 1) {
    console.log(`Multiple .lay files found, using first: ${layFiles[0]}`);
    layoutFile = path.join(traceDir, layFiles[0]);
  }
}

// Auto-detect VENUS root if not specified
if (!venusRoot) {
  // Walk up from trace file looking for VENUS source tree
  let dir = path.dirname(path.resolve(traceFile));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "Vector", "src");
    if (fs.existsSync(candidate)) {
      venusRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// Parse trace file
const lines = fs.readFileSync(traceFile, "utf-8").replace(/\r/g, "").split("\n");
const commands = [];
const responses = [];

for (const line of lines) {
  const match = line.match(/^([<>])\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+\S+:\s+(.+)$/);
  if (!match) continue;
  const [, dir, time, content] = match;
  if (dir === "<") {
    commands.push({ time, raw: content.trim() });
  } else {
    responses.push({ time, raw: content.trim() });
  }
}

console.log(`Trace: ${path.basename(traceFile)}`);
console.log(`Commands: ${commands.length} sent, ${responses.length} responses`);

// Import VENUS layout if provided
let deck = undefined;
if (layoutFile) {
  try {
    const { importVenusLayout, defaultLabwareSearchPaths } = require("../dist/twin/venus-layout");
    const searchPaths = venusRoot ? defaultLabwareSearchPaths(venusRoot) : [];
    // Also add the .lay file's directory
    searchPaths.unshift(path.dirname(layoutFile));
    const result = importVenusLayout(layoutFile, searchPaths);
    deck = result.deck;
    console.log(`Layout: ${path.basename(layoutFile)} — ${result.carriers} carriers, ${result.labware} labware items`);
    console.log(`  Resolved: ${result.resolvedFiles} files, Unresolved: ${result.unresolvedFiles.length}`);
    if (result.unresolvedFiles.length > 0) {
      console.log(`  Unresolved: ${result.unresolvedFiles.join(", ")}`);
    }
    if (result.warnings.length > 0) {
      for (const w of result.warnings) console.log(`  Warning: ${w}`);
    }
  } catch (e) {
    console.error(`Failed to import layout: ${e.message}`);
    process.exit(1);
  }
}

console.log("");

// Create twin
const api = new DigitalTwinAPI();
const deviceId = api.createDevice({ name: "Trace Replay", deck });

// Auto-initialize: if the trace has no C0VI/C0DI, the instrument was already
// initialized when the trace was recorded. Send init commands to match.
const hasSystemInit = commands.some(c => c.raw.startsWith("C0VI"));
const hasPipInit = commands.some(c => c.raw.startsWith("C0DI"));
const hasH96Init = commands.some(c => c.raw.startsWith("C0EI"));
const hasIswapInit = commands.some(c => c.raw.startsWith("C0II"));

if (!hasSystemInit || !hasPipInit) {
  console.log("Auto-initializing (trace has no init commands)...");
  // Send the standard initialization sequence
  if (!hasSystemInit) api.sendCommand(deviceId, "C0VIid9999");
  if (!hasPipInit) api.sendCommand(deviceId, "C0DIid9998");
  if (!hasH96Init) api.sendCommand(deviceId, "C0EIid9997");
  if (!hasIswapInit) api.sendCommand(deviceId, "C0IIid9996");
  api.flushPendingEvents(deviceId);
  console.log("");
}

// Replay commands
let accepted = 0;
let rejected = 0;
let unhandled = 0;
const unhandledPrefixes = new Set();
const rejectionReasons = {};
const acceptedCodes = new Set();

for (const cmd of commands) {
  try {
    // Flush any pending delayed events from previous commands
    // (SCXML uses delayed events for timed operations like tip pickup, aspiration)
    api.flushPendingEvents(deviceId);
    const result = api.sendCommand(deviceId, cmd.raw);
    if (result.accepted) {
      accepted++;
      acceptedCodes.add(cmd.raw.substring(0, 4));
    } else {
      // Check if it's truly unhandled (no module) vs rejected by module
      if (result.errorCode === 15 && result.targetModule === "unknown") {
        unhandled++;
        unhandledPrefixes.add(cmd.raw.substring(0, 2) + ":" + cmd.raw.substring(2, 4));
      } else {
        rejected++;
        const code = cmd.raw.substring(0, 4);
        const reason = result.errorDescription || `error ${result.errorCode}`;
        rejectionReasons[code] = rejectionReasons[code] || { count: 0, reason };
        rejectionReasons[code].count++;
      }
    }
  } catch (e) {
    unhandled++;
    unhandledPrefixes.add(cmd.raw.substring(0, 2) + ":" + cmd.raw.substring(2, 4));
  }
}

// Report
console.log("=== REPLAY RESULTS ===");
console.log(`Accepted:  ${accepted}/${commands.length} (${(accepted/commands.length*100).toFixed(1)}%)`);
console.log(`Rejected:  ${rejected}/${commands.length} (state/physics errors — twin handled but denied)`);
console.log(`Unhandled: ${unhandled}/${commands.length} (no module for this command)\n`);

if (acceptedCodes.size > 0) {
  console.log("Accepted command codes:", [...acceptedCodes].sort().join(", "));
}

if (Object.keys(rejectionReasons).length > 0) {
  console.log("\nRejections (twin handled but state doesn't allow):");
  for (const [code, info] of Object.entries(rejectionReasons)) {
    console.log(`  ${code}: ${info.count}x — ${info.reason}`);
  }
}

if (unhandledPrefixes.size > 0) {
  console.log("\nUnhandled prefixes (need new module or routing):");
  for (const p of [...unhandledPrefixes].sort()) {
    console.log(`  ${p}`);
  }
}

// Summary state
const state = api.getState(deviceId);
const tracking = api.getDeckTracking(deviceId);
console.log("\n=== TWIN STATE AFTER REPLAY ===");
for (const [id, ms] of Object.entries(state.modules)) {
  const states = ms.states.filter(s => s !== "operational");
  console.log(`  ${id}: ${states.join(", ")}`);
}
console.log(`Tips tracked: ${Object.keys(tracking.tipUsage).filter(k => tracking.tipUsage[k]).length}`);
console.log(`Wells tracked: ${Object.keys(tracking.wellVolumes).length}`);
