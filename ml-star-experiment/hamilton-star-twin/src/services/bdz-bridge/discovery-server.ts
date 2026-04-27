/**
 * Hamilton BDZ discovery service
 *
 * Implements the two-stage VENUS instrument-discovery protocol so a
 * running twin appears in VENUS's instrument picker. Both halves are
 * line-oriented ASCII with `\r\n` as the message delimiter.
 *
 *   1. UDP on port 34569 — listen for `HAMILTON_BROADCAST bdc_headerid
 *      2271560481` probes and unicast a module-info response back.
 *      Parser and field names verified against VENUS source:
 *        VENUS-2026-04-13/Vector/src/HxTcpIpBdzComm/CODE/Shared/
 *          ModuleControllerInfo.cpp:106 ParseModuleControllerAnswer
 *          (field list: bdc_headerid, bdc_counter, bdc_ipstate,
 *           bdc_ipaddress, bdc_macaddress, bdc_systemid, bdc_modulename,
 *           bdc_moduledesc, bdc_modulenumber, bdc_modulemode,
 *           bdc_hamsmartport).
 *        ModuleControllerInfo.cpp:24 DiscoveryPort = 34569.
 *
 *   2. TCP on port 34567 (hamsmartport) — handle `R_GETDEVICELIST
 *      device_nr N\r\n` queries, return one record pointing at the
 *      FDx port, then `r_device_used 0` to end enumeration.
 *      Parser verified against:
 *        VENUS-2026-04-13/Vector/src/HxTcpIpBdzComm/CODE/Shared/
 *          DeviceControllerInfo.cpp:66 Parse_R_GETDEVICELIST
 *          (required fields: er, r_device_used, r_device_state,
 *           r_device_name, r_device_number, r_device_interfacetype,
 *           r_device_interfacedata, r_device_description,
 *           r_device_interfaceprotocol).
 *        ModuleControllerSocket.cpp:59 EnumerateNextDevice
 *          sends `R_GETDEVICELIST device_nr <N>`; terminates on
 *          `r_device_used != 1`.
 *
 * VENUS filters the picker so only `bdc_modulename == "MLSTARPipettor"`
 * with `r_device_interfaceprotocol == 2` (FDx) are shown — see
 *   VENUS-2026-04-13/Star/src/HxStarConfig/code/
 *     HxStarConfigClass.cs:1339  ModuleTypeStarPipettor
 *     HxStarConfigClass.cs:1367  filter on protocol == 2
 * so both values are baked into the defaults below and must stay.
 *
 * Response shape (UDP reply template, single line + `\r\n`) matches the
 * reference implementation in Hamilton's test instrument:
 *   VENUS-2026-04-13/Vector/test/HxTcpIpBdzComm/HxTestInstrument/
 *     HxTestInstrumentDlg.cpp:387-398
 *   HxTestInstrumentDlg.cpp:516-534  R_GETDEVICELIST answer format
 *   HxTestInstrumentDlg.cpp:109      `r_device_used 0\r\n` terminator
 *
 * Scope
 * -----
 * This module only speaks the discovery protocol. The FDx payload
 * channel is handled by `fdx-server.ts`; this code just advertises the
 * port where FDx is listening.
 */

import * as dgram from "dgram";
import * as net from "net";
import * as os from "os";

// ============================================================================
// Protocol constants — verified against VENUS source
// ============================================================================

/** UDP port for HAMILTON_BROADCAST — ModuleControllerInfo.cpp:24. */
export const DEFAULT_DISCOVERY_PORT = 34569;
/** Default TCP port for R_GETDEVICELIST — ModuleControllerInfo.cpp:25. */
export const DEFAULT_HAMSMART_PORT = 34567;
/** Our FDx server's default TCP port (phase 5). */
export const DEFAULT_FW_PORT = 9999;
/** Magic number VENUS stamps on every valid broadcast probe. */
export const HEADER_ID = "2271560481"; // 0x87654321
/** VENUS's probe command word. */
export const DISCOVERY_COMMAND = "HAMILTON_BROADCAST";
/** STAR module-type string VENUS uses to filter the picker. */
export const STAR_MODULE_TYPE = "MLSTARPipettor";
/** FDx interface-protocol code (`interfaceProtocol_Hamilton`). */
export const FDX_INTERFACE_PROTOCOL = "2";
/** TCP interface-type code (`interfaceType_TcpIp`). */
export const TCPIP_INTERFACE_TYPE = "1";

// ============================================================================
// Types
// ============================================================================

/**
 * Identity advertised to VENUS. These values show up in the instrument
 * picker and later get saved into the user's .cfg when they select the
 * twin, so they should be stable across restarts unless the user
 * deliberately changes them.
 */
export interface DiscoveryIdentity {
  /** bdc_systemid — user-visible instrument name in the picker. */
  instrumentId: string;
  /** bdc_modulename — MUST be "MLSTARPipettor" for a STAR twin. */
  moduleType: string;
  /** bdc_modulenumber — serial number string. */
  moduleId: string;
  /** bdc_moduledesc — human-readable description. */
  moduleDescription: string;
  /** bdc_macaddress — 12 hex chars (no separators). */
  macAddress: string;
  /**
   * bdc_ipaddress — IPv4 VENUS will use to open the enumeration TCP
   * socket. Defaults to the first non-internal IPv4 on the host at
   * startup. Override when the twin binds to a specific NIC.
   */
  ipAddress?: string;
  /** bdc_hamsmartport — TCP port where we answer R_GETDEVICELIST. */
  hamSmartPort: number;

  /** r_device_name — device-controller type string. */
  deviceType: string;
  /** r_device_number — device-controller id (string form). */
  deviceId: string;
  /** r_device_description — user-visible description. */
  deviceDescription: string;
  /**
   * r_device_interfacedata — FDx TCP port. Must equal the FdxServer
   * port VENUS will connect to once enumeration completes.
   */
  fwPort: number;
}

/** Build a reasonable default identity; caller overrides as needed. */
export function defaultIdentity(overrides: Partial<DiscoveryIdentity> = {}): DiscoveryIdentity {
  return {
    instrumentId: "Hamilton STAR Digital Twin",
    moduleType: STAR_MODULE_TYPE,
    moduleId: "9999",
    moduleDescription: "Simulated STAR (Hamilton Digital Twin)",
    macAddress: "001e9a999999", // Hamilton OUI 00-1e-9a + synthetic tail
    hamSmartPort: DEFAULT_HAMSMART_PORT,
    deviceType: STAR_MODULE_TYPE,
    deviceId: "0",
    deviceDescription: "Hamilton STAR Digital Twin",
    fwPort: DEFAULT_FW_PORT,
    ...overrides,
  };
}

// ============================================================================
// UDP discovery responder
// ============================================================================

export interface UdpDiscoveryOptions {
  identity: DiscoveryIdentity;
  /** UDP bind port. Defaults to 34569. */
  port?: number;
  /** Bind address. Defaults to 0.0.0.0 so broadcast probes reach us. */
  host?: string;
  /** Optional logger. Defaults to a no-op. */
  log?: (message: string, detail?: unknown) => void;
}

export class UdpDiscoveryResponder {
  private readonly identity: DiscoveryIdentity;
  private readonly port: number;
  private readonly host: string;
  private readonly log: (message: string, detail?: unknown) => void;
  private socket: dgram.Socket | null = null;
  private counter = 0;
  private _boundPort = 0;

  constructor(options: UdpDiscoveryOptions) {
    this.identity = options.identity;
    this.port = options.port ?? DEFAULT_DISCOVERY_PORT;
    this.host = options.host ?? "0.0.0.0";
    this.log = options.log ?? (() => {});
  }

  /** Resolved port after `start()` — useful when `port` was 0 (OS-assigned). */
  get boundPort(): number {
    return this._boundPort;
  }

  async start(): Promise<this> {
    if (this.socket) throw new Error("UdpDiscoveryResponder: already started");
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", (err) => {
        this.log(`udp-discovery: error`, err);
        reject(err);
      });
      sock.on("message", (msg, rinfo) => this.handleProbe(sock, msg, rinfo));
      sock.once("listening", () => {
        const addr = sock.address();
        this._boundPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.log(`udp-discovery listening on ${this.host}:${this._boundPort}`);
        resolve(this);
      });
      sock.bind({ address: this.host, port: this.port, exclusive: false });
      this.socket = sock;
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const sock = this.socket;
    this.socket = null;
    await new Promise<void>((resolve) => sock.close(() => resolve()));
  }

  private handleProbe(sock: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const text = msg.toString("ascii").trim();
    // Every probe starts with the command + the headerid magic. If either
    // is missing we stay silent — the test instrument does the same via
    // ParseModuleControllerAnswer returning false. Reply to anything we
    // can identify as a Hamilton probe.
    if (!text.startsWith(DISCOVERY_COMMAND)) {
      this.log(`udp-discovery: ignoring non-Hamilton probe from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    if (text.indexOf(HEADER_ID) === -1) {
      this.log(`udp-discovery: ignoring probe with wrong headerid from ${rinfo.address}:${rinfo.port}`);
      return;
    }

    this.counter += 1;
    const reply = buildBroadcastResponse(this.identity, this.counter);
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) {
        this.log(`udp-discovery: send to ${rinfo.address}:${rinfo.port} failed`, err);
      } else {
        this.log(`udp-discovery: replied to ${rinfo.address}:${rinfo.port} counter=${this.counter}`);
      }
    });
  }
}

/**
 * Build the on-the-wire HAMILTON_BROADCAST response. Output ends with
 * `\r\n` — the VENUS parser splits on carriage-return/linefeed (see
 * AsyncMessageSocket.cpp:118).
 */
export function buildBroadcastResponse(id: DiscoveryIdentity, counter: number): Buffer {
  const ip = id.ipAddress ?? detectLocalIpv4() ?? "127.0.0.1";
  // Order matches the test-instrument template at
  // HxTestInstrumentDlg.cpp:387-398. Field order is not strictly
  // required (the parser is key/value), but keeping the canonical
  // ordering makes wire-level diffing easier.
  const payload =
    `${DISCOVERY_COMMAND}` +
    ` bdc_headerid ${HEADER_ID}` +
    ` bdc_counter ${counter}` +
    ` bdc_ipstate 2` +
    ` bdc_ipaddress "${ip}"` +
    ` bdc_macaddress "${id.macAddress}"` +
    ` bdc_systemid "${id.instrumentId}"` +
    ` bdc_modulename "${id.moduleType}"` +
    ` bdc_moduledesc "${id.moduleDescription}"` +
    ` bdc_modulenumber "${id.moduleId}"` +
    ` bdc_modulemode 2` +
    ` bdc_hamsmartport ${id.hamSmartPort}` +
    `\r\n`;
  return Buffer.from(payload, "ascii");
}

// ============================================================================
// TCP HamSmart server — answers R_GETDEVICELIST
// ============================================================================

export interface HamSmartServerOptions {
  identity: DiscoveryIdentity;
  /** TCP bind port. Defaults to 34567. */
  port?: number;
  /** Bind address. Defaults to 0.0.0.0 so remote VENUS can reach us. */
  host?: string;
  /** Optional logger. Defaults to a no-op. */
  log?: (message: string, detail?: unknown) => void;
}

export class HamSmartServer {
  private readonly identity: DiscoveryIdentity;
  private readonly requestedPort: number;
  private readonly host: string;
  private readonly log: (message: string, detail?: unknown) => void;
  private server: net.Server | null = null;
  private connections: Set<net.Socket> = new Set();
  private _port = 0;

  constructor(options: HamSmartServerOptions) {
    this.identity = options.identity;
    this.requestedPort = options.port ?? DEFAULT_HAMSMART_PORT;
    this.host = options.host ?? "0.0.0.0";
    this.log = options.log ?? (() => {});
  }

  get port(): number {
    return this._port;
  }

  async start(): Promise<this> {
    if (this.server) throw new Error("HamSmartServer: already started");
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => this.handleConnection(socket));
      srv.once("error", reject);
      srv.listen(this.requestedPort, this.host, () => {
        const addr = srv.address();
        this._port = typeof addr === "object" && addr ? addr.port : this.requestedPort;
        this.server = srv;
        this.log(`hamsmart listening on ${this.host}:${this._port}`);
        resolve(this);
      });
    });
  }

  async close(): Promise<void> {
    for (const sock of this.connections) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.connections.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.log(`hamsmart: connection from ${remote}`);

    let buffer = "";
    socket.setEncoding("ascii");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // The wire format is line-delimited (\r\n). ModuleControllerSocket
      // sends one command at a time, but be defensive in case VENUS
      // pipelines or sends short writes.
      while (true) {
        const idx = buffer.indexOf("\r\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this.handleLine(socket, line, remote);
      }
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      this.log(`hamsmart: ${remote} disconnected`);
    });
    socket.on("error", (err) => {
      this.log(`hamsmart: ${remote} socket error`, err);
    });
  }

  private handleLine(socket: net.Socket, line: string, remote: string): void {
    // Every enumeration message starts with R_GETDEVICELIST followed by
    // a device_nr parameter. We only advertise one device (the twin),
    // so device_nr==1 gets the record and anything else terminates.
    const match = /^R_GETDEVICELIST\s+device_nr\s+(\d+)/i.exec(line);
    if (!match) {
      // Unknown command — the real behaviour is simply to ignore. The
      // test instrument does nothing (HxTestInstrumentDlg.cpp:550-561).
      this.log(`hamsmart: ${remote} unexpected command "${line}"`);
      return;
    }
    const deviceNr = Number(match[1]);
    const reply = deviceNr === 1
      ? buildDeviceListReply(this.identity)
      : buildDeviceListTerminator();
    this.log(`hamsmart: ${remote} device_nr=${deviceNr} → ${deviceNr === 1 ? "advertise" : "terminate"}`);
    if (socket.writable) socket.write(reply);
  }
}

/** Build the advertising record for our one virtual device. */
export function buildDeviceListReply(id: DiscoveryIdentity): Buffer {
  const payload =
    `R_GETDEVICELIST er 0` +
    ` r_device_used 1` +
    ` r_device_state 1` +
    ` r_device_name "${id.deviceType}"` +
    ` r_device_number "${id.deviceId}"` +
    ` r_device_interfacetype ${TCPIP_INTERFACE_TYPE}` +
    ` r_device_interfacedata "${id.fwPort}"` +
    ` r_device_description "${id.deviceDescription}"` +
    ` r_device_interfaceprotocol ${FDX_INTERFACE_PROTOCOL}` +
    `\r\n`;
  return Buffer.from(payload, "ascii");
}

/** Terminator response — `r_device_used 0` stops enumeration. */
export function buildDeviceListTerminator(): Buffer {
  return Buffer.from(`R_GETDEVICELIST er 0 r_device_used 0\r\n`, "ascii");
}

// ============================================================================
// Combined service — start both halves together
// ============================================================================

export interface DiscoveryServiceOptions {
  identity: DiscoveryIdentity;
  /** Override UDP port. Defaults to 34569. */
  discoveryPort?: number;
  /** Override TCP port for device enumeration. Defaults to identity.hamSmartPort. */
  hamSmartPort?: number;
  /** Bind host for both halves. Defaults to 0.0.0.0. */
  host?: string;
  /** Optional logger shared by both servers. */
  log?: (message: string, detail?: unknown) => void;
}

export interface DiscoveryServiceHandle {
  readonly identity: DiscoveryIdentity;
  readonly udp: UdpDiscoveryResponder;
  readonly hamsmart: HamSmartServer;
  close(): Promise<void>;
}

/**
 * Start the UDP discovery responder and the TCP HamSmart enumerator.
 * Caller is responsible for also starting the FDx server on
 * `identity.fwPort` — this function does not touch FDx.
 *
 * Ordering matters: the TCP hamsmart listener binds first, so the UDP
 * broadcast responder can advertise the actual listening port even
 * when the caller asked for an OS-assigned port (`0`).
 */
export async function startDiscoveryService(
  options: DiscoveryServiceOptions,
): Promise<DiscoveryServiceHandle> {
  const requestedHamSmart = options.hamSmartPort ?? options.identity.hamSmartPort;

  const hamsmart = new HamSmartServer({
    identity: options.identity,
    port: requestedHamSmart,
    host: options.host,
    log: options.log,
  });

  try {
    await hamsmart.start();
  } catch (err) {
    await hamsmart.close();
    throw err;
  }

  // Rebuild the identity with the actual bound port so UDP responses
  // point VENUS at a listener that really exists. Matters mostly for
  // tests that pass `0`; production hands us the well-known 34567.
  const effectiveIdentity: DiscoveryIdentity = {
    ...options.identity,
    hamSmartPort: hamsmart.port,
  };

  const udp = new UdpDiscoveryResponder({
    identity: effectiveIdentity,
    port: options.discoveryPort,
    host: options.host,
    log: options.log,
  });

  try {
    await udp.start();
  } catch (err) {
    await Promise.allSettled([udp.close(), hamsmart.close()]);
    throw err;
  }

  return {
    identity: effectiveIdentity,
    udp,
    hamsmart,
    async close() {
      await Promise.allSettled([udp.close(), hamsmart.close()]);
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Pick the first non-internal IPv4 address exposed by the host. If
 * nothing suitable is found, returns null and callers fall back to a
 * loopback address — a same-box VENUS will still work over 127.0.0.1.
 */
export function detectLocalIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  // Prefer Ethernet/Wi-Fi-looking names first, then fall back to anything.
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const lc = name.toLowerCase();
      if (lc.includes("ethernet") || lc.includes("wi-fi") || lc.includes("wlan") || lc.includes("en")) {
        preferred.push(entry.address);
      } else {
        fallback.push(entry.address);
      }
    }
  }
  return preferred[0] ?? fallback[0] ?? null;
}
