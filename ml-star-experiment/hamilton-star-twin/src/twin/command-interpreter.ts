/**
 * Command Interpreter
 *
 * Bridges the FW command protocol with the SCXML state machines.
 * Takes a FW command string, validates parameters against the JSON spec,
 * sends the corresponding event to the state machine, and returns
 * the FW response string.
 */

import { parseFwCommand, formatFwResponse, FwCommand } from "./fw-protocol";

// Load the digital twin spec (the JSON we built)
import spec from "./hamilton-star-digital-twin.json";

/** Result of processing a command */
export interface CommandResult {
  /** FW response string */
  response: string;
  /** Active states after processing */
  activeStates: string[];
  /** Current variable values */
  variables: Record<string, unknown>;
  /** Log messages generated during processing */
  logs: string[];
  /** Whether the command was accepted (state machine transitioned) */
  accepted: boolean;
  /** Error code if command failed */
  errorCode: number;
}

/** Log entry from state machine execution */
export interface LogEntry {
  label: string;
  message: string;
  timestamp: number;
}

/**
 * The CommandInterpreter connects the FW protocol to the SCXML state machine.
 *
 * Usage:
 *   const interpreter = new CommandInterpreter(stateMachine);
 *   const result = interpreter.execute("C0ASid0001tm1av1000...");
 */
export class CommandInterpreter {
  private sm: any; // The SCXML-generated state machine instance
  private orderCounter: number = 0;
  private logs: LogEntry[] = [];
  private errorCodes: Record<string, string>;

  constructor(stateMachine: any) {
    this.sm = stateMachine;

    // Load error codes from the spec
    this.errorCodes = (spec as any).error_codes || {};

    // Hook into state machine logging with full trace listener interface
    // Method names must match the generated runtime's TraceListener class exactly
    if (this.sm.addTraceListener) {
      const noop = () => {};
      this.sm.addTraceListener({
        onSessionStart: noop,
        onSessionEnd: noop,
        onTransitionExecute: noop,
        onStateEnter: noop,
        onStateExit: noop,
        onEventProcess: noop,
        onEventQueue: noop,
        onMacrostepStart: noop,
        onMacrostepEnd: noop,
        onError: noop,
        onLog: (_label: string, message: string) => {
          this.logs.push({
            label: _label,
            message,
            timestamp: Date.now(),
          });
        },
      });
    }
  }

  /**
   * Execute a FW command string against the state machine.
   *
   * The command is parsed, the corresponding SCXML event is sent
   * with the parameters as event data, and the result is returned.
   */
  execute(rawCommand: string): CommandResult {
    // Parse the command
    const cmd = parseFwCommand(rawCommand);

    // Clear log buffer
    this.logs = [];

    // Snapshot state before
    const statesBefore = this.getActiveStates();
    const varsBefore = JSON.stringify(this.getVariables());

    // Send the event to the state machine with command params as data
    this.sm.send(cmd.event, cmd.params);

    // Snapshot state after
    const statesAfter = this.getActiveStates();
    const variables = this.getVariables();
    const varsAfter = JSON.stringify(variables);

    // Check if a transition actually occurred (states changed OR variables changed OR logs produced)
    const statesChanged = JSON.stringify(statesBefore) !== JSON.stringify(statesAfter);
    const varsChanged = varsBefore !== varsAfter;
    const accepted = statesChanged || varsChanged || this.logs.length > 0;

    // Determine error code
    let errorCode = 0;

    // 1) Check if we landed in an error state
    errorCode = this.detectError(statesAfter, variables);

    // 2) If the event was silently dropped (no transition, no variable change, no log),
    //    that means the command is illegal in the current state
    if (!accepted && errorCode === 0) {
      errorCode = this.inferErrorForRejectedCommand(cmd.event, statesBefore);
      this.logs.push({
        label: "REJECTED",
        message: `${cmd.event} not valid in current state [${this.describeModuleState(cmd.event, statesBefore)}]`,
        timestamp: Date.now(),
      });
    }

    // Format response
    const response = formatFwResponse(
      cmd.module,
      cmd.code,
      cmd.orderId,
      errorCode,
      0
    );

    return {
      response,
      activeStates: statesAfter,
      variables,
      logs: this.logs.map((l) => `${l.label}: ${l.message}`),
      accepted,
      errorCode,
    };
  }

  /**
   * Execute a VENUS Easy Step by decomposing it into FW commands.
   *
   * Example: executeEasyStep("EasyAspirate", { ... })
   * decomposes into C0TP (tip pickup) + C0AS (aspirate).
   */
  executeEasyStep(
    stepName: string,
    params: Record<string, unknown>
  ): CommandResult[] {
    const easySteps = (spec as any).venus_steps?.easy_steps?.steps;
    if (!easySteps || !easySteps[stepName]) {
      throw new Error(`Unknown Easy Step: ${stepName}`);
    }

    const step = easySteps[stepName];
    const fwCommands: string[] = step.fw_commands || [];
    const results: CommandResult[] = [];

    for (const fwCode of fwCommands) {
      const module = fwCode.substring(0, 2);
      const code = fwCode.substring(2, 4);
      this.orderCounter++;

      const orderId = this.orderCounter;
      const id = String(orderId).padStart(4, "0");
      let cmdStr = `${module}${code}id${id}`;

      // Add params as key-value pairs
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === "number" && key.length === 2) {
          cmdStr += `${key}${value}`;
        }
      }

      results.push(this.execute(cmdStr));
    }

    return results;
  }

  /** Send a completion event (e.g. "wash.done", "move.done") */
  complete(eventName: string): void {
    this.sm.send(eventName);
  }

  /** Get the list of currently active state IDs */
  getActiveStates(): string[] {
    if (this.sm.getActiveStateIds) {
      return Array.from(this.sm.getActiveStateIds());
    }
    return [];
  }

  /** Get current variable values */
  getVariables(): Record<string, unknown> {
    // The SCXML datamodel stores variables in _datamodel
    if (this.sm._datamodel) {
      return { ...this.sm._datamodel };
    }
    return {};
  }

  /** Get events that are currently enabled (can trigger a transition) */
  getEnabledEvents(): string[] {
    if (this.sm.getEnabledEvents) {
      return this.sm.getEnabledEvents();
    }
    return [];
  }

  /** Get the full event log */
  getLog(): LogEntry[] {
    return [...this.logs];
  }

  /** Get human-readable error description for an error code */
  getErrorDescription(code: number): string {
    const key = String(code).padStart(2, "0");
    return this.errorCodes[key] || `Unknown error ${code}`;
  }

  /** Detect if we're in an error state by checking active states and variables */
  private detectError(
    states: string[],
    variables: Record<string, unknown>
  ): number {
    // Check if any error state is active
    const inError = states.some(
      (s) =>
        s.includes("error") ||
        s === "pip_error" ||
        s === "h96_error" ||
        s === "isw_error" ||
        s === "error_al" ||
        s === "error_ws" ||
        s === "error_temp" ||
        s === "sys_error"
    );

    if (inError) {
      const lastError = variables["last_error"] || variables["system_error"];
      return typeof lastError === "number" ? lastError : 99;
    }

    return 0;
  }

  /**
   * Infer an appropriate FW error code when a command was silently rejected
   * (no matching transition in the state machine).
   */
  private inferErrorForRejectedCommand(event: string, states: string[]): number {
    // Pipetting commands without a tip -> error 08 (No Tip)
    const needsTip = ["C0AS", "C0DS", "C0DF", "C0LW"];
    if (needsTip.includes(event)) {
      const pipState = states.find((s) => s.startsWith("pip_") || s === "no_tip");
      if (pipState === "pip_no_tip" || pipState === "pip_uninit" || pipState === "no_tip") {
        return 8; // No tip
      }
    }

    // Dispense without liquid -> error 06 if in tip_empty
    if (event === "C0DS" || event === "C0DF") {
      if (states.includes("pip_tip_empty") || states.includes("tip_empty")) {
        return 6; // Too little liquid
      }
    }

    // 96-head commands without tips
    const needs96Tips = ["C0EA", "C0ED", "C0EG"];
    if (needs96Tips.includes(event)) {
      if (states.includes("h96_no_tips") || states.includes("h96_uninit")) {
        return 8;
      }
    }

    // iSWAP put plate without plate gripped
    if (event === "C0PR" && (states.includes("isw_empty") || states.includes("isw_parked"))) {
      return 22; // Element still holding / no element
    }

    // Command sent to uninitialized module
    if (states.includes("pip_uninit") && event.startsWith("C0") && ["TP", "AS", "DS", "TR", "JM"].includes(event.substring(2))) {
      return 3; // Command not completed
    }

    // Generic: command not applicable in current state
    return 15; // Not allowed parameter combination (closest generic code)
  }

  /** Get a human-readable description of the relevant module state for an event */
  private describeModuleState(event: string, states: string[]): string {
    // Map event prefixes to module state prefixes
    const pipEvents = ["C0DI", "C0TP", "C0TR", "C0AS", "C0DS", "C0DF", "C0JM", "C0ZA", "C0LW"];
    const h96Events = ["C0EI", "C0EP", "C0ER", "C0EA", "C0ED", "C0EM", "C0EV", "C0EG"];
    const iswEvents = ["C0FI", "C0FY", "C0PP", "C0PR", "C0PM", "C0PG", "C0PB"];
    const alEvents = ["C0II", "C0CI", "C0CL", "C0CR", "C0CW"];
    const wsEvents = ["C0WI", "C0WS", "C0WC", "C0WW", "C0WR"];
    const tmpEvents = ["C0HI", "C0HC", "C0HF", "C0RP"];

    let prefix = "";
    if (pipEvents.includes(event)) prefix = "pip_";
    else if (h96Events.includes(event)) prefix = "h96_";
    else if (iswEvents.includes(event)) prefix = "isw_";
    else if (alEvents.includes(event)) prefix = "al_";
    else if (wsEvents.includes(event)) prefix = "ws_";
    else if (tmpEvents.includes(event)) prefix = "t_";

    const moduleState = states.find((s) => s.startsWith(prefix));
    return moduleState || states.join(", ");
  }
}
