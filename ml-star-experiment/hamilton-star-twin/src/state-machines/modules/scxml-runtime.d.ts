/**
 * @scxml-gen/runtime - W3C SCXML State Machine Runtime for JavaScript
 *
 * Base classes for transpiled SCXML state machines.
 */

/**
 * Event object as per W3C SCXML specification
 */
export declare class ScxmlEvent {
  name: string;
  data: any;
  type: 'external' | 'internal' | 'platform';
  sendid?: string;
  origin?: string;
  origintype?: string;
  invokeid?: string;

  constructor(name: string, data?: any, options?: {
    type?: 'external' | 'internal' | 'platform';
    sendid?: string;
    origin?: string;
    origintype?: string;
    invokeid?: string;
  });
}

/**
 * Runtime context for state machine execution
 */
export declare class RuntimeContext {
  machine: ScxmlStateMachine;
  internalQueue: ScxmlEvent[];
  externalQueue: ScxmlEvent[];
  scheduledEvents: Map<string, { time: number; event: ScxmlEvent }>;
  invokedMachines: Map<string, any>;

  constructor(machine: ScxmlStateMachine);

  raiseEvent(name: string, data?: any, type?: string): void;
  raisePlatformEvent(name: string, options?: { sendid?: string }): void;
  sendEvent(name: string, data?: any, options?: {
    delay?: number | string;
    id?: string;
    sendid?: string;
  }): string | null;
  cancelEvent(sendid: string): void;
  getNextScheduledTime(): number | null;
  processDueEvents(): boolean;
}

/**
 * Base class for transpiled SCXML state machines
 */
export declare class ScxmlStateMachine {
  activeStates: Set<string>;
  historyValues: Map<string, Set<string>>;
  ctx: RuntimeContext;
  _sessionid: string;
  _name: string;
  _ioprocessors: Record<string, { location: string }>;
  _event: ScxmlEvent | null;
  _datamodel: Record<string, any>;

  constructor();

  /** Start the state machine */
  start(): void;

  /** Send an external event to the state machine */
  send(name: string, data?: any, options?: {
    origin?: string;
    origintype?: string;
    sendid?: string;
    invokeid?: string;
  }): void;

  /** Check if the state machine has finished */
  isFinished(): boolean;

  /** Get the set of currently active state IDs */
  getActiveStateIds(): Set<string>;

  /** Check if a state is currently active (for In() predicate) */
  isInState(stateId: string): boolean;

  /** Subscribe to state changes */
  onStateChange(callback: (entered: string[], exited: string[]) => void): () => void;

  /** Set the logger function */
  setLogger(logger: (message: string) => void): void;

  /** Process any scheduled delayed events */
  processDelayedEvents(): boolean;

  /** Set an invoke loader function for loading external SCXML sources */
  setInvokeLoader(loader: (src: string) => string): void;

  // Protected methods (for generated code)
  protected _enterInitialConfiguration(): void;
  protected _processEventQueue(): void;
  protected _processEvent(event: ScxmlEvent): void;
  protected _enterState(stateId: string): void;
  protected _exitState(stateId: string): void;
  protected _recordHistory(historyId: string, stateIds: string[]): void;
  protected _getHistory(historyId: string): Set<string>;
  protected _setFinished(doneData?: any): void;
  protected _log(label: string, expr: string): void;
  protected _raise(eventName: string, data?: any): void;
  protected _raisePlatform(eventName: string, data?: any): void;
  protected _send(eventName: string, options?: {
    target?: string;
    type?: string;
    delay?: number | string;
    id?: string;
    data?: any;
  }): void;
  protected _cancel(sendid: string): void;
  protected _evalCond(expr: string): boolean;
  protected _evalExpr(expr: string, throwOnError?: boolean): any;
  protected _execScript(script: string): void;
  protected _assign(location: string, value: any): void;
  protected _validateAndAssign(location: string, value: any): void;
  protected _startInvoke(invokeid: string, options: {
    type?: string;
    src?: string;
    content?: string;
    contentExpr?: string;
    childClass?: new () => ScxmlStateMachine;
    autoforward?: boolean;
    data?: Record<string, any>;
    finalize?: (event: ScxmlEvent) => void;
    parentState?: string;
  }): void;
  protected _cancelInvoke(invokeid: string): void;
}
