/**
 * Module Registry
 *
 * Creates one SCXML state machine + ContinuousExecutor per hardware module.
 * Maps FW command event codes to the correct module executor.
 */

const runtime = require("../state-machines/scxml-runtime");
const { MasterSM } = require("../state-machines/modules/master-s-m");
const { PipChannelSM } = require("../state-machines/modules/pip-channel-s-m");
const { CoRe96HeadSM } = require("../state-machines/modules/co-re96-head-s-m");
const { ISwapSM } = require("../state-machines/modules/i-swap-s-m");
const { AutoLoadSM } = require("../state-machines/modules/auto-load-s-m");
const { WashStationSM } = require("../state-machines/modules/wash-station-s-m");
const { TemperatureSM } = require("../state-machines/modules/temperature-s-m");
const { CoRe384HeadSM } = require("../state-machines/modules/co-re384-head-s-m");
const { CoReGripperSM } = require("../state-machines/modules/co-re-gripper-s-m");
const { HeaterShakerSM } = require("../state-machines/modules/heater-shaker-s-m");

const ContinuousExecutor = runtime.ContinuousExecutor;

/** One module: its executor, metadata, and the events it handles */
export interface ModuleEntry {
  id: string;
  name: string;
  executor: any;
  events: string[];
}

/**
 * Create a complete noop trace listener with ALL methods the generated code may call.
 * This must cover every on* method used by the SCXML runtime and generated SM code,
 * including onActionExecute which is emitted when tracing is enabled.
 */
function noopTraceListener() {
  const noop = () => {};
  return new Proxy({}, {
    get(_target, prop) {
      // Return noop for any method call — future-proofs against new trace methods
      return noop;
    }
  });
}

/** Create all module executors and return the registry. */
export function createModuleRegistry(): ModuleEntry[] {
  const modules: ModuleEntry[] = [
    {
      id: "master",
      name: "Master",
      executor: new ContinuousExecutor(new MasterSM()),
      events: [
        // System
        "C0VI", "C0RF", "C0RE", "C0RA", "C0QB", "C0MU", "C0QW", "C0VP", "C0RQ", "C0SR", "C0QV",
        // Settings volatile
        "C0AM", "C0NS", "C0HD", "C0AZ", "C0AB", "C0AW",
        // Settings nonvolatile
        "C0SI", "C0AV", "C0AT", "C0AK", "C0DD", "C0XK", "C0TT",
        "C0AG", "C0AF", "C0AD", "C0AN", "C0AJ", "C0AE", "C0IP", "C0AO", "C0BT", "C0AU",
        // Settings queries
        "C0QT", "C0RI", "C0RO", "C0RV", "C0RS", "C0RJ", "C0UJ", "C0RM", "C0QM", "C0VD", "C0RK",
        // X-axis
        "C0JX", "C0JS", "C0KX", "C0KR", "C0BA", "C0BB", "C0BC", "C0RX", "C0QX", "C0RU", "C0UA",
        // Status light
        "C0ST", "C0SS", "C0SL", "C0WL", "C0WJ",
        // Cover
        "C0CO", "C0HO", "C0CD", "C0CE", "C0QC",
        // Port I/O
        "C0OS", "C0OR", "C0AC", "C0RW",
        // Download
        "C0AP", "C0DE", "C0DP",
        // Service
        "C0GO", "C0AH", "C0AL", "C0RH", "C0AI", "C0AA",
        // Completion
        "init.done", "system.error",
      ],
    },
    {
      id: "pip",
      name: "PIP Channels",
      executor: new ContinuousExecutor(new PipChannelSM()),
      events: [
        "C0DI", "C0TP", "C0TR", "C0TW", "C0AS", "C0DS", "C0DA", "C0DF", "C0DC",
        "C0JM", "C0JY", "C0JZ", "C0KY", "C0KZ", "C0ZA", "C0JE", "C0JP", "C0XL", "C0JR",
        "C0LW",
        "C0RY", "C0RB", "C0RZ", "C0RD", "C0RT", "C0RL", "C0QS", "C0FS", "C0VE",
        "move.done",
      ],
    },
    {
      id: "h96",
      name: "CoRe 96 Head",
      executor: new ContinuousExecutor(new CoRe96HeadSM()),
      events: [
        "C0EI", "C0EP", "C0ER", "C0EA", "C0ED", "C0EM", "C0EV", "C0EG", "C0EU",
        // 96-Head washer commands (VENUS sends these for wash operations)
        "C0EF", "C0EW", "C0ES", "C0EE",
        "C0QH", "C0QI", "C0VC", "C0VB",
        "move96.done", "wash96.done",
      ],
    },
    {
      id: "iswap",
      name: "iSWAP",
      executor: new ContinuousExecutor(new ISwapSM()),
      events: [
        "C0FI", "C0FY", "C0PP", "C0PR", "C0PM", "C0PG", "C0PB",
        "C0GF", "C0GC", "C0GI", "C0PO", "C0PI", "C0PN", "C0PT",
        "C0GX", "C0GY", "C0GZ",
        "C0RG", "C0QP", "C0QG", "C0PC",
        "move_iswap.done", "barcode.done",
      ],
    },
    {
      id: "autoload",
      name: "AutoLoad",
      executor: new ContinuousExecutor(new AutoLoadSM()),
      events: [
        "C0II", "C0IV", "C0CI", "C0CL", "C0CR", "C0CW", "C0CT", "C0CS",
        "C0CP", "C0CB", "C0CU", "C0CA", "C0CN", "C0DB", "C0DR",
        "C0RC", "C0QA", "C0CQ", "C0VL",
        "identify.done", "load.done", "unload.done", "monitor.done",
      ],
    },
    {
      id: "wash",
      name: "Wash Station",
      executor: new ContinuousExecutor(new WashStationSM()),
      events: [
        "C0WI", "C0WS", "C0WC", "C0WW", "C0WR", "C0QF",
        "wash_ws.done", "wait_ws.done",
      ],
    },
    {
      id: "temp",
      name: "Temperature",
      executor: new ContinuousExecutor(new TemperatureSM()),
      events: [
        "C0HI", "C0HC", "C0HF", "C0RP",
        "temp.reached", "temp.error",
      ],
    },
    {
      id: "h384",
      name: "CoRe 384 Head",
      executor: new ContinuousExecutor(new CoRe384HeadSM()),
      events: [
        "C0JI", "C0JA", "C0JD", "C0JB", "C0JC", "C0EN", "C0EY", "C0JG", "C0JU",
        "C0QJ", "C0QK", "C0QY",
        "move384.done", "wash384.done",
      ],
    },
    {
      id: "gripper",
      name: "CO-RE Gripper",
      executor: new ContinuousExecutor(new CoReGripperSM()),
      events: [
        "C0ZT", "C0ZS", "C0ZP", "C0ZR", "C0ZM", "C0ZO", "C0ZB",
        "move_grip.done",
      ],
    },
    {
      id: "hhs",
      name: "Heater/Shaker",
      executor: new ContinuousExecutor(new HeaterShakerSM()),
      events: [
        // Shaker control
        "T1SI", "T1SA", "T1SS", "T1SO", "T1ST", "T1SB", "T1SC",
        // Temperature control
        "T1TA", "T1TW", "T1TO",
        // Plate lock
        "T1LI", "T1LA", "T1LP", "T1LO", "T1LS",
        // Queries
        "T1RA", "T1RQ", "T1RF", "T1RT", "T1QC", "T1QD", "T1QE",
        // Completions
        "hhs_temp.reached", "hhs_temp.error",
      ],
    },
  ];

  // Start all executors with a Proxy-based trace listener
  // that accepts any method call without crashing
  for (const mod of modules) {
    mod.executor.addTraceListener(noopTraceListener());
    mod.executor.start();
  }

  return modules;
}

/** Build a lookup map: event code -> module entry */
export function buildEventMap(modules: ModuleEntry[]): Map<string, ModuleEntry> {
  const map = new Map<string, ModuleEntry>();
  for (const mod of modules) {
    for (const event of mod.events) {
      map.set(event, mod);
    }
  }
  return map;
}
