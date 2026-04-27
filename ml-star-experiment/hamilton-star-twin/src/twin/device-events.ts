/**
 * Device Event System
 *
 * Models unsolicited events that the real Hamilton STAR firmware
 * can emit without being asked. These are NOT command responses —
 * they're device-initiated notifications.
 *
 * Real examples:
 * - Cover opened/closed during a run
 * - Carrier removed from loading tray
 * - Temperature out of limits
 * - Emergency stop activated
 * - Wash fluid empty
 * - TADM error detected asynchronously
 *
 * The device event system runs alongside the command processing.
 * Events are pushed to all listeners (UI, MCP, REST).
 */

/** A device-initiated event */
export interface DeviceEvent {
  /** Event type identifier */
  type: DeviceEventType;
  /** Module that generated the event */
  module: string;
  /** FW error code (if applicable) */
  errorCode?: number;
  /** Human-readable description */
  description: string;
  /** Additional data */
  data?: Record<string, unknown>;
  /** Timestamp */
  timestamp: number;
  /** ID of the command that triggered this event, if command-driven (Step 1.9).
   *  Left undefined for truly async events (cover opens, emergency stops). */
  correlationId?: number;
  /** ID of the composite step containing the triggering command (Step 1.9). */
  stepId?: number;
}

/** Known device event types */
export type DeviceEventType =
  | "cover.opened"
  | "cover.closed"
  | "carrier.removed"
  | "carrier.detected"
  | "emergency.stop"
  | "emergency.release"
  | "temperature.out_of_range"
  | "temperature.reached"
  | "wash.fluid_empty"
  | "wash.waste_full"
  | "tadm.error"
  | "tip.collision"
  | "custom";

export type DeviceEventListener = (event: DeviceEvent) => void;

/**
 * Device event emitter.
 *
 * Attached to a DigitalTwin instance. Monitors module states
 * and emits device events when conditions are met.
 *
 * Can also be triggered programmatically for testing
 * (e.g. simulate a cover open during a pipetting run).
 */
export class DeviceEventEmitter {
  private listeners: DeviceEventListener[] = [];
  private eventLog: DeviceEvent[] = [];

  /** Register a listener for device events */
  onDeviceEvent(listener: DeviceEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Emit a device event */
  emit(type: DeviceEventType, module: string, description: string, data?: Record<string, unknown>, errorCode?: number): void {
    const event: DeviceEvent = {
      type,
      module,
      description,
      data,
      errorCode,
      timestamp: Date.now(),
    };

    this.eventLog.push(event);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        // Don't let listener errors break the device
      }
    }
  }

  /** Simulate a cover open event (for testing or user interaction) */
  simulateCoverOpen(): void {
    this.emit("cover.opened", "master", "Front cover opened by user");
  }

  /** Simulate a cover close event */
  simulateCoverClose(): void {
    this.emit("cover.closed", "master", "Front cover closed");
  }

  /** Simulate emergency stop */
  simulateEmergencyStop(): void {
    this.emit("emergency.stop", "master", "Emergency stop activated", undefined, 2);
  }

  /** Simulate carrier removal from tray */
  simulateCarrierRemoved(track: number): void {
    this.emit("carrier.removed", "autoload", `Carrier removed from track ${track}`, { track });
  }

  /** Simulate wash fluid empty */
  simulateWashFluidEmpty(station: number): void {
    this.emit("wash.fluid_empty", "wash", `Wash station ${station} fluid empty`, { station }, 18);
  }

  /** Simulate temperature out of range */
  simulateTemperatureAlert(zone: number, currentTemp: number, targetTemp: number): void {
    this.emit(
      "temperature.out_of_range", "temp",
      `Zone ${zone} temp ${currentTemp / 10}C deviates from target ${targetTemp / 10}C`,
      { zone, currentTemp, targetTemp }, 19
    );
  }

  /** Get the full event log */
  getEventLog(): DeviceEvent[] {
    return [...this.eventLog];
  }

  /** Get recent events */
  getRecentEvents(count: number = 20): DeviceEvent[] {
    return this.eventLog.slice(-count);
  }

  /** Clear the event log */
  clearLog(): void {
    this.eventLog = [];
  }
}
