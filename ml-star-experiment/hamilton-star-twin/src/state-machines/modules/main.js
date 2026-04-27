// main.js — entry point for the HeaterShakerSM state machine.
//
// Usage:
//   node main.js                              # interactive mode (stdin)
//   node main.js --events ev1 ev2 ev3         # batch mode (runs events then exits)
//   node main.js --events ev1 ev2 --verbose   # batch mode with logging
//
// ContinuousExecutor handles delayed events (<send delay="..."/>) automatically
// via the JavaScript event loop — no manual polling required.
import { createInterface } from 'readline';
import { ContinuousExecutor, JsonlTraceWriter } from './scxml-runtime.js';
import { HeaterShakerSM } from './heater-shaker-s-m.js';

// Parse CLI flags
const { events, verbose } = (() => {
    const args = process.argv.slice(2);
    const events = [];
    let verbose = false, inEvents = false;
    for (const arg of args) {
        if (arg === '--events' || arg === '-e') { inEvents = true; }
        else if (arg === '--verbose' || arg === '-v') { verbose = true; }
        else if (inEvents) { events.push(arg); }
    }
    return { events, verbose };
})();

const machine = new HeaterShakerSM();
if (verbose) {
    machine.setLogger(msg => console.log(`[LOG] ${msg}`));
}
const executor = new ContinuousExecutor(machine);

executor.start();

if (events.length > 0) {
    // ── Batch mode ──────────────────────────────────────────────────
    console.log('Active states:', [...machine.getActiveStateIds()].join(', ') || '(none)');
    for (const ev of events) {
        if (machine.isFinished()) break;
        console.log('>', ev);
        executor.send(ev);
        console.log('Active states:', [...machine.getActiveStateIds()].join(', ') || '(none)');
    }
    if (machine.isFinished()) {
        console.log('State machine has finished.');
    }
    executor.stop();
} else {
    // ── Interactive mode ─────────────────────────────────────────────
    console.log('=== HeaterShakerSM State Machine Demo ===');
    console.log();
    console.log('Active states:', [...machine.getActiveStateIds()].join(', ') || '(none)');
    console.log();
    console.log("Type an event name and press Enter ('quit' to exit):");
    console.log();

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function prompt() {
        if (machine.isFinished()) {
            console.log('State machine has finished.');
            rl.close();
            executor.stop();
            return;
        }
        rl.question('> ', (input) => {
            input = input.trim();
            if (input === 'quit' || input === 'exit') {
                console.log('Goodbye!');
                rl.close();
                executor.stop();
                return;
            }
            if (input) {
                executor.send(input);
                console.log('Active states:', [...machine.getActiveStateIds()].join(', ') || '(none)');
                if (machine.isFinished()) {
                    console.log('State machine has finished.');
                    rl.close();
                    executor.stop();
                    return;
                }
            }
            prompt();
        });
    }
    prompt();
}

// === With Tracing (for debugging) ===
// Records all state transitions, events, and actions to a JSONL file.
//
// import fs from 'fs';
// const traceWriter = new JsonlTraceWriter(
//   (line) => fs.appendFileSync('trace.jsonl', line + '\n')
// );
// const tracedMachine = new HeaterShakerSM();
// tracedMachine.addTraceListener(traceWriter);
// tracedMachine.start();
// tracedMachine.send('myEvent');
