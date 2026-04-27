/**
 * Catalog of C0AS / C0DS firmware-command parameters.
 *
 * This is the pinning reference: every param real VENUS sends on an
 * aspirate or dispense is listed here with its AtsMc*.cpp source line
 * and a real-trace example value. Tests (tests/unit/c0as-c0ds-fidelity)
 * assert that the twin's parser sees every one of these keys in the
 * canonical trace strings below, so any drift — VENUS adds a field,
 * we rename something, a refactor breaks parsing — surfaces immediately.
 *
 * The purpose is fidelity documentation, not execution: most of these
 * fields only affect physics when surface-following/LLD/TADM are in play,
 * and the twin consumes only the subset listed in `consumedBy` below. The
 * rest flow through the wire format so VENUS sees a well-formed echo, and
 * future work can lift fields into `consumedBy` as fidelity is added.
 *
 * Source: VENUS-2026-04-13/Star/src/HxAtsInstrument/Code/AtsMcAspirate.cpp
 *         VENUS-2026-04-13/Star/src/HxAtsInstrument/Code/AtsMcDispense.cpp
 * Traces: VENUS-2026-04-13/QA/Venus.Tests.Integration/TestData/Star/
 *         AspirateAndDispensePositions/Pipetting1mlCapacitiveLLD_ComTrace.trc
 */

/**
 * What, if anything, the twin does with a given param.
 *
 * - `"timing"` — feeds `command-timing.ts` (affects the ack delay).
 * - `"physics"` — feeds the liquid/tip tracker or assessment engine.
 * - `"state"` — written into a module's SCXML datamodel.
 * - `"echo-only"` — parsed but ignored; VENUS sees a valid ack only.
 */
export type ConsumerRole = "timing" | "physics" | "state" | "echo-only";

export interface PipParamSpec {
  /** Wire key (e.g. "av", "wt"). Always 2 lowercase letters. */
  key: string;
  /** VENUS source field name from AtsMcAspirate.cpp / AtsMcDispense.cpp. */
  venusName: string;
  /** Human-readable semantics. */
  description: string;
  /** Which AtsMc file + line the param comes from. */
  sourceRef: string;
  /** Example value from a real ComTrace (string, unpadded). */
  traceExample: string;
  /** Per-channel (array-valued) vs global (single value). */
  scope: "channel" | "global";
  /** Zero-padded field width on the wire (fillN). */
  fill: number;
  /** What the twin does with the value today. */
  consumedBy: ConsumerRole[];
}

/**
 * Every param present in a real-trace C0AS, ordered as AtsMcAspirate.cpp
 * emits them. `traceExample` is the value from the capacitive-LLD trace
 * (C0ASid0264 at 13:22:54) — the same one pinned in the fidelity test.
 */
export const C0AS_PARAMS: readonly PipParamSpec[] = [
  { key: "at", venusName: "aspirationType",      description: "0=surface, 1=jet", sourceRef: "AtsMcAspirate.cpp:20", traceExample: "0",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "tm", venusName: "activeTip",           description: "channel mask",                                                  sourceRef: "AtsMcAspirate.cpp:21", traceExample: "1",     scope: "channel", fill: 1, consumedBy: ["state", "physics"] },
  { key: "xp", venusName: "xPosition",           description: "X target (0.1mm)",                                              sourceRef: "AtsMcAspirate.cpp:22", traceExample: "05905", scope: "channel", fill: 5, consumedBy: ["state", "physics"] },
  { key: "yp", venusName: "yPosition",           description: "per-channel Y (0.1mm)",                                         sourceRef: "AtsMcAspirate.cpp:23", traceExample: "3380",  scope: "channel", fill: 4, consumedBy: ["state", "physics"] },
  { key: "th", venusName: "minTraversHeight",    description: "traverse Z clearance (0.1mm)",                                  sourceRef: "AtsMcAspirate.cpp:24", traceExample: "2450",  scope: "global",  fill: 4, consumedBy: ["state"] },
  { key: "te", venusName: "minZPosition",        description: "end-Z floor (0.1mm)",                                            sourceRef: "AtsMcAspirate.cpp:25", traceExample: "2450",  scope: "global",  fill: 4, consumedBy: ["state"] },
  { key: "lp", venusName: "lldSearchHeight",     description: "LLD search start Z (0.1mm)",                                    sourceRef: "AtsMcAspirate.cpp:26", traceExample: "2306",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "ch", venusName: "clotRetractHeight",   description: "clot retract height (0.1mm)",                                   sourceRef: "AtsMcAspirate.cpp:27", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "zl", venusName: "fluidHeight",         description: "LLD-detected liquid surface Z (0.1mm)",                         sourceRef: "AtsMcAspirate.cpp:28", traceExample: "1941",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "zx", venusName: "zMinHeight",          description: "minimum tip-Z safety floor (0.1mm)",                             sourceRef: "AtsMcAspirate.cpp:29", traceExample: "1891",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "ip", venusName: "submergeDepth",       description: "depth below liquid (0.1mm)",                                    sourceRef: "AtsMcAspirate.cpp:30", traceExample: "0020",  scope: "channel", fill: 4, consumedBy: ["state"] },
  { key: "it", venusName: "submergeDirection",   description: "0=down, 1=up",                                                  sourceRef: "AtsMcAspirate.cpp:31", traceExample: "0",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "fp", venusName: "followDistance",      description: "liquid-following Z delta (0.1mm)",                              sourceRef: "AtsMcAspirate.cpp:32", traceExample: "0005",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "av", venusName: "aspirationVolume",    description: "target aspirate volume (0.1µL)",                                 sourceRef: "AtsMcAspirate.cpp:33", traceExample: "05183", scope: "channel", fill: 5, consumedBy: ["timing", "physics"] },
  { key: "as", venusName: "aspirationFlowRate",  description: "aspirate flow rate (0.1µL/s)",                                   sourceRef: "AtsMcAspirate.cpp:34", traceExample: "2500",  scope: "channel", fill: 4, consumedBy: ["timing"] },
  { key: "ta", venusName: "airTransportVolume",  description: "trailing air gap (0.1µL)",                                       sourceRef: "AtsMcAspirate.cpp:35", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["physics"] },
  { key: "ba", venusName: "blowOutVolume",       description: "blow-out air volume (0.1µL)",                                    sourceRef: "AtsMcAspirate.cpp:36", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "oa", venusName: "overAspirateVolume",  description: "over-aspirate anti-drip (0.1µL)",                                sourceRef: "AtsMcAspirate.cpp:37", traceExample: "050",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "lm", venusName: "lldMode",             description: "0=off 1=cLLD 2=pLLD 3=dual 4=Z-touch",                          sourceRef: "AtsMcAspirate.cpp:38", traceExample: "1",     scope: "channel", fill: 1, consumedBy: ["state"] },
  { key: "ll", venusName: "lldSetting",          description: "LLD sensitivity preset",                                         sourceRef: "AtsMcAspirate.cpp:39", traceExample: "4",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "lv", venusName: "presureLldSettings",  description: "pressure-LLD tuning (0=off)",                                    sourceRef: "AtsMcAspirate.cpp:40", traceExample: "1",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "ld", venusName: "differenceDualLld",   description: "dual-LLD ΔZ threshold (0.1mm)",                                  sourceRef: "AtsMcAspirate.cpp:41", traceExample: "00",    scope: "channel", fill: 2, consumedBy: ["echo-only"] },
  { key: "de", venusName: "swapSpeed",           description: "swap speed (0.1µL/s)",                                           sourceRef: "AtsMcAspirate.cpp:42", traceExample: "0020",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "wt", venusName: "settlingTime",        description: "post-aspirate settle time (0.1s)",                               sourceRef: "AtsMcAspirate.cpp:43", traceExample: "10",    scope: "channel", fill: 2, consumedBy: ["timing"] },
  { key: "mv", venusName: "mixVolume",           description: "mix volume (0.1µL)",                                             sourceRef: "AtsMcAspirate.cpp:44", traceExample: "00000", scope: "channel", fill: 5, consumedBy: ["echo-only"] },
  { key: "mc", venusName: "mixCycles",           description: "mix cycles",                                                     sourceRef: "AtsMcAspirate.cpp:45", traceExample: "00",    scope: "channel", fill: 2, consumedBy: ["echo-only"] },
  { key: "mp", venusName: "mixPosition",         description: "mix Z offset (0.1mm)",                                           sourceRef: "AtsMcAspirate.cpp:46", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "ms", venusName: "mixFlowRate",         description: "mix flow rate (0.1µL/s)",                                        sourceRef: "AtsMcAspirate.cpp:47", traceExample: "1200",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "gi", venusName: "limitCurveIndex",     description: "TADM curve index",                                               sourceRef: "AtsMcAspirate.cpp:48", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "gj", venusName: "tadmAlgo",            description: "TADM algorithm (0=off)",                                         sourceRef: "AtsMcAspirate.cpp:49", traceExample: "0",     scope: "global",  fill: 1, consumedBy: ["echo-only"] },
  { key: "gk", venusName: "recMode",             description: "TADM record mode",                                               sourceRef: "AtsMcAspirate.cpp:50", traceExample: "0",     scope: "global",  fill: 1, consumedBy: ["echo-only"] },
  { key: "zu", venusName: "lastSegmentHeight",   description: "last tip-segment Z (0.1mm)",                                     sourceRef: "AtsMcAspirate.cpp:51", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "zr", venusName: "lastSegmentDiamRatio",description: "last-segment diameter ratio",                                    sourceRef: "AtsMcAspirate.cpp:52", traceExample: "00000", scope: "channel", fill: 5, consumedBy: ["echo-only"] },
  { key: "mh", venusName: "mixFollowDistance",   description: "mix liquid-follow Z delta (0.1mm)",                              sourceRef: "AtsMcAspirate.cpp:53", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "zo", venusName: "touchofDistance",     description: "side-touch distance (0.1mm)",                                    sourceRef: "AtsMcAspirate.cpp:54", traceExample: "005",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "po", venusName: "aspAirRetractDist",   description: "pull-out air retract distance (0.1mm)",                          sourceRef: "AtsMcAspirate.cpp:55", traceExample: "0050",  scope: "channel", fill: 4, consumedBy: ["timing"] },
  { key: "lk", venusName: "secondPhaseAsp",      description: "second-phase aspirate flag (0/1)",                               sourceRef: "AtsMcAspirate.cpp:58", traceExample: "0",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "ik", venusName: "retractDist",         description: "retract distance, phase-2 (0.1mm)",                              sourceRef: "AtsMcAspirate.cpp:59", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "sd", venusName: "emptyFlowRate",       description: "empty flow rate, phase-2 (0.1µL/s)",                              sourceRef: "AtsMcAspirate.cpp:60", traceExample: "0500",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "se", venusName: "searchFlowRate",      description: "search flow rate, phase-2 (0.1µL/s)",                             sourceRef: "AtsMcAspirate.cpp:61", traceExample: "0500",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "sz", venusName: "zSpeed",              description: "Z speed, phase-2 (0.1mm/s)",                                      sourceRef: "AtsMcAspirate.cpp:62", traceExample: "0300",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "io", venusName: "accessHeight",        description: "access height, phase-2 (0.1mm)",                                  sourceRef: "AtsMcAspirate.cpp:63", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "il", venusName: "ratioTipCup",         description: "tip/cup ratio, phase-2",                                          sourceRef: "AtsMcAspirate.cpp:64", traceExample: "00000", scope: "channel", fill: 5, consumedBy: ["echo-only"] },
  { key: "in", venusName: "submergeDepth2",      description: "submerge depth, phase-2 (0.1mm)",                                 sourceRef: "AtsMcAspirate.cpp:65", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
];

/**
 * Every param present in a real-trace C0DS, ordered as AtsMcDispense.cpp
 * emits them. `traceExample` comes from C0DSid0266 @13:23:04 in the same
 * capacitive-LLD trace.
 */
export const C0DS_PARAMS: readonly PipParamSpec[] = [
  { key: "dm", venusName: "dispensationType",    description: "0=jet empty 2=surface-partial 3=surface-empty 4=jet-tip",      sourceRef: "AtsMcDispense.cpp:20", traceExample: "2",     scope: "channel", fill: 1, consumedBy: ["state", "physics"] },
  { key: "tm", venusName: "activeTip",           description: "channel mask",                                                  sourceRef: "AtsMcDispense.cpp:21", traceExample: "1",     scope: "channel", fill: 1, consumedBy: ["state", "physics"] },
  { key: "xp", venusName: "xPosition",           description: "X target (0.1mm)",                                              sourceRef: "AtsMcDispense.cpp:22", traceExample: "07660", scope: "channel", fill: 5, consumedBy: ["state", "physics"] },
  { key: "yp", venusName: "yPosition",           description: "per-channel Y (0.1mm)",                                         sourceRef: "AtsMcDispense.cpp:23", traceExample: "5400",  scope: "channel", fill: 4, consumedBy: ["state", "physics"] },
  { key: "zx", venusName: "zMinHeight",          description: "minimum tip-Z safety floor (0.1mm)",                             sourceRef: "AtsMcDispense.cpp:24", traceExample: "1121",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "lp", venusName: "lldSearchHeight",     description: "LLD search start Z (0.1mm)",                                    sourceRef: "AtsMcDispense.cpp:25", traceExample: "2161",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "zl", venusName: "fluidHeight",         description: "LLD-detected liquid surface Z (0.1mm)",                         sourceRef: "AtsMcDispense.cpp:26", traceExample: "1171",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "ip", venusName: "submergeDepth",       description: "depth below liquid (0.1mm)",                                    sourceRef: "AtsMcDispense.cpp:27", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["state"] },
  { key: "it", venusName: "submergeDirection",   description: "0=down, 1=up",                                                  sourceRef: "AtsMcDispense.cpp:28", traceExample: "0",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "fp", venusName: "followDistance",      description: "liquid-following Z delta (0.1mm)",                              sourceRef: "AtsMcDispense.cpp:29", traceExample: "0040",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "th", venusName: "minTraversHeight",    description: "traverse Z clearance (0.1mm)",                                  sourceRef: "AtsMcDispense.cpp:30", traceExample: "2450",  scope: "global",  fill: 4, consumedBy: ["state"] },
  { key: "te", venusName: "minZPosition",        description: "end-Z floor (0.1mm)",                                            sourceRef: "AtsMcDispense.cpp:31", traceExample: "2450",  scope: "global",  fill: 4, consumedBy: ["state"] },
  { key: "dv", venusName: "dispensationVolume",  description: "target dispense volume (0.1µL)",                                 sourceRef: "AtsMcDispense.cpp:32", traceExample: "05183", scope: "channel", fill: 5, consumedBy: ["timing", "physics"] },
  { key: "ds", venusName: "dispensationFlowRate",description: "dispense flow rate (0.1µL/s)",                                   sourceRef: "AtsMcDispense.cpp:33", traceExample: "1200",  scope: "channel", fill: 4, consumedBy: ["timing"] },
  { key: "ss", venusName: "stopFlowRate",        description: "stop flow rate (0.1µL/s)",                                       sourceRef: "AtsMcDispense.cpp:34", traceExample: "0050",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "rv", venusName: "stopBackVolume",      description: "back-volume at stop (0.1µL)",                                    sourceRef: "AtsMcDispense.cpp:35", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "ta", venusName: "airTransportVolume",  description: "trailing air gap (0.1µL)",                                       sourceRef: "AtsMcDispense.cpp:36", traceExample: "500",   scope: "channel", fill: 3, consumedBy: ["physics"] },
  { key: "ba", venusName: "blowOutVolume",       description: "blow-out air volume (0.1µL)",                                    sourceRef: "AtsMcDispense.cpp:37", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "lm", venusName: "lldMode",             description: "0=off 1=cLLD 2=pLLD 3=dual 4=Z-touch",                          sourceRef: "AtsMcDispense.cpp:38", traceExample: "0",     scope: "channel", fill: 1, consumedBy: ["state"] },
  { key: "zo", venusName: "touchofDistance",     description: "side-touch distance (0.1mm)",                                    sourceRef: "AtsMcDispense.cpp:39", traceExample: "005",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "ll", venusName: "lldSetting",          description: "LLD sensitivity preset",                                         sourceRef: "AtsMcDispense.cpp:40", traceExample: "1",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "lv", venusName: "presureLldSettings",  description: "pressure-LLD tuning (0=off)",                                    sourceRef: "AtsMcDispense.cpp:41", traceExample: "1",     scope: "channel", fill: 1, consumedBy: ["echo-only"] },
  { key: "de", venusName: "swapSpeed",           description: "swap speed (0.1µL/s)",                                           sourceRef: "AtsMcDispense.cpp:42", traceExample: "0020",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "mv", venusName: "mixVolume",           description: "mix volume (0.1µL)",                                             sourceRef: "AtsMcDispense.cpp:43", traceExample: "00000", scope: "channel", fill: 5, consumedBy: ["echo-only"] },
  { key: "mc", venusName: "mixCycles",           description: "mix cycles",                                                     sourceRef: "AtsMcDispense.cpp:44", traceExample: "00",    scope: "channel", fill: 2, consumedBy: ["echo-only"] },
  { key: "mp", venusName: "mixPosition",         description: "mix Z offset (0.1mm)",                                           sourceRef: "AtsMcDispense.cpp:45", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "ms", venusName: "mixFlowRate",         description: "mix flow rate (0.1µL/s)",                                        sourceRef: "AtsMcDispense.cpp:46", traceExample: "0010",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "wt", venusName: "settlingTime",        description: "post-dispense settle time (0.1s)",                               sourceRef: "AtsMcDispense.cpp:47", traceExample: "00",    scope: "channel", fill: 2, consumedBy: ["timing"] },
  { key: "gi", venusName: "limitCurveIndex",     description: "TADM curve index",                                               sourceRef: "AtsMcDispense.cpp:48", traceExample: "000",   scope: "channel", fill: 3, consumedBy: ["echo-only"] },
  { key: "gj", venusName: "tadmAlgo",            description: "TADM algorithm (0=off)",                                         sourceRef: "AtsMcDispense.cpp:49", traceExample: "0",     scope: "global",  fill: 1, consumedBy: ["echo-only"] },
  { key: "gk", venusName: "recMode",             description: "TADM record mode",                                               sourceRef: "AtsMcDispense.cpp:50", traceExample: "0",     scope: "global",  fill: 1, consumedBy: ["echo-only"] },
  { key: "zu", venusName: "lastSegmentHeight",   description: "last tip-segment Z (0.1mm)",                                     sourceRef: "AtsMcDispense.cpp:51", traceExample: "0061",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "dj", venusName: "sideTouchDistance",   description: "side-touch X delta (0.1mm)",                                     sourceRef: "AtsMcDispense.cpp:52", traceExample: "00",    scope: "global",  fill: 2, consumedBy: ["echo-only"] },
  { key: "zr", venusName: "lastSegmentDiamRatio",description: "last-segment diameter ratio",                                    sourceRef: "AtsMcDispense.cpp:53", traceExample: "06180", scope: "channel", fill: 5, consumedBy: ["echo-only"] },
  { key: "mh", venusName: "mixFollowDistance",   description: "mix liquid-follow Z delta (0.1mm)",                              sourceRef: "AtsMcDispense.cpp:54", traceExample: "0000",  scope: "channel", fill: 4, consumedBy: ["echo-only"] },
  { key: "po", venusName: "aspAirRetractDist",   description: "pull-out air retract distance (0.1mm)",                          sourceRef: "AtsMcDispense.cpp:55", traceExample: "0050",  scope: "channel", fill: 4, consumedBy: ["timing"] },
];

/**
 * A real-trace C0AS ComTrace line, verbatim (minus the timestamp). The
 * fidelity test asserts that parseFwCommand extracts every key listed in
 * C0AS_PARAMS from this exact string. If VENUS adds, removes, or renames
 * a field on a future trace, the test breaks here first.
 *
 * Source: Pipetting1mlCapacitiveLLD_ComTrace.trc @ 13:22:54.105, id 0264.
 */
export const REAL_C0AS_TRACE =
  "C0ASid0264at0&tm1&xp05905&yp3380 3290 3200 3110 3020 2930 2840 2750th2450te2450lp2306&ch000&zl1941&zx1891&ip0020&it0&fp0005&av05183&as2500&ta000&ba0000&oa050&lm1&ll4&lv1&ld00&de0020&wt10&mv00000&mc00&mp000&ms1200&gi000&gj0gk0zu0000&zr00000&mh0000&zo005&po0050&lk0&ik0000&sd0500&se0500&sz0300&io0000&il00000&in0000";

/**
 * Matching real-trace C0DS from the same capacitive-LLD run (id 0266,
 * @13:23:04.850). Pinned by the same fidelity test.
 */
export const REAL_C0DS_TRACE =
  "C0DSid0266dm2&tm1&xp07660&yp5400 5200 5000 4800 4600 4400 4200 4000zx1121&lp2161&zl1171&ip0000&it0&fp0040&th2450te2450dv05183&ds1200&ss0050&rv000&ta500&ba0000&lm0&zo005&ll1&lv1&de0020&mv00000&mc00&mp000&ms0010&wt00&gi000&gj0gk0zu0061&dj00zr06180&mh0000&po0050";

/** Lookup by wire key (for tests + future consumers). */
export function findC0ASParam(key: string): PipParamSpec | undefined {
  return C0AS_PARAMS.find((p) => p.key === key);
}
export function findC0DSParam(key: string): PipParamSpec | undefined {
  return C0DS_PARAMS.find((p) => p.key === key);
}
