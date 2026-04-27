/**
 * FW-command TCP server — the payload channel VENUS reaches after
 * BDZ discovery. VENUS advertises this port in `R_GETDEVICELIST`
 * with `r_device_interfaceprotocol 2` (its "Hamilton/FDx" category
 * code), but the actual on-the-wire format between VENUS and this
 * server is the plain BDZ line-delimited ASCII transport used by
 * `HxTcpIpBdzComm` — there is NO FDx STX/ETX/BCC framing and NO
 * DLE+EOT+ENQ handshake. FDx framing only shows up between the
 * real STAR's module controller and its device controllers over
 * RS232/USB, which this twin doesn't emulate.
 *
 *     request:   "C0RQid0101\r\n"
 *     response:  "C0RQid0101rq0000\r\n"
 *
 * Verified against:
 *
 *   VENUS-2026-04-13/Vector/src/HxTcpIpBdzComm/CODE/Shared/
 *     AsyncStreamSocket.cpp:160  SendMessage appends "\r\n"
 *     AsyncStreamSocket.cpp:218  HandleData splits inbound on "\r\n"
 *     BaseSocket.cpp:39          m_szMessageDelimiter = "\r\n"
 *
 * Per-connection lifecycle
 * ------------------------
 *   1. TCP `connection` fires — we buffer inbound bytes.
 *   2. Each complete `\r\n`-terminated line is dispatched as one FW
 *      command via `api.sendCommand(deviceId, raw)`.
 *   3. Optional `simSpeed`-scaled delay mimics physical timing.
 *   4. The twin's response is written back as `response + "\r\n"`.
 *   5. Commands are serialised so a response can't race past the
 *      command that produced it, even if VENUS pipelines.
 */

import * as net from "net";
import type { DigitalTwinAPI } from "../../twin/api";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseFwCommand } = require("../../twin/fw-protocol");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { estimateCommandTime, applySimSpeed } = require("../../twin/command-timing");

// ============================================================================
// Types
// ============================================================================

export interface FwServerOptions {
  /** DigitalTwinAPI instance — must have at least one device. */
  api: DigitalTwinAPI;
  /** Callback returning the current active device id. */
  getActiveDeviceId: () => string;
  /** TCP port to listen on. Use 0 for an OS-assigned port (tests). */
  port?: number;
  /** Interface to bind. Default `127.0.0.1` to stay off the LAN unless
   *  explicitly opened. Set to `0.0.0.0` to accept remote VENUS. */
  host?: string;
  /**
   * Simulation speed — multiplies `estimateCommandTime()` before
   * responding so the bridge mimics physical timing.
   *   1.0  → real-hardware speed (default)
   *   100  → run ~100× faster for scripted regression testing
   *   0    → skip the delay entirely (fastest, for contract tests)
   */
  simSpeed?: number;
  /** Optional logger. Defaults to a no-op. */
  log?: (message: string, detail?: unknown) => void;
  /**
   * Fires after each command is dispatched, before the response is
   * sent back over the wire. Used by the server-setup wiring to
   * broadcast the same `command-result`/`state-changed` SSE events
   * REST callers produce, so the renderer's command-log panel shows
   * VENUS traffic alongside in-app commands.
   */
  onCommand?: (args: { raw: string; response: string; result: CommandResult }) => void;
}

/** Structural result shape used by `onCommand`. Mirrors what
 *  `DigitalTwinAPI.sendCommand` returns without pulling in its type here. */
export interface CommandResult {
  accepted?: boolean;
  response: string;
  errorCode?: number;
  errorDescription?: string;
  targetModule?: string;
  deckInteraction?: { effect?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface FwServerHandle {
  /** Resolved port after `start()`; 0 until the listener binds. */
  readonly port: number;
  /** Accepted connections — useful for teardown / introspection. */
  connectionCount(): number;
  /** Shut the listener down. Resolves after all connections drain. */
  close(): Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/** Protect against a rogue client never sending `\r\n`. 4 KiB is far
 *  larger than any realistic FW command (typical longest is ~200 chars
 *  for multi-channel arrays). */
const MAX_LINE_LENGTH = 4 * 1024;

// ============================================================================
// Server
// ============================================================================

export class FwServer implements FwServerHandle {
  private readonly api: DigitalTwinAPI;
  private readonly getActiveDeviceId: () => string;
  private readonly simSpeed: number;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly onCommand: FwServerOptions["onCommand"];
  private server: net.Server | null = null;
  private connections: Set<net.Socket> = new Set();
  private _port = 0;

  constructor(options: FwServerOptions) {
    this.api = options.api;
    this.getActiveDeviceId = options.getActiveDeviceId;
    this.simSpeed = options.simSpeed ?? 1;
    this.log = options.log ?? (() => {});
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 9999;
    this.onCommand = options.onCommand;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Start listening. Resolves once the socket is bound — use
   * `handle.port` to read the OS-assigned port when `port: 0`.
   */
  async start(): Promise<this> {
    if (this.server) throw new Error("FwServer: already started");
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => this.handleConnection(socket));
      srv.on("error", reject);
      srv.listen(this.requestedPort, this.host, () => {
        const addr = srv.address();
        this._port = typeof addr === "object" && addr ? addr.port : this.requestedPort;
        this.server = srv;
        this.log(`fw-server listening on ${this.host}:${this._port}`);
        resolve(this);
      });
    });
  }

  connectionCount(): number {
    return this.connections.size;
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

  // --- per-connection --------------------------------------------------

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.log(`fw-server: connection from ${remote}`);

    let buffer = "";
    let inFlight: Promise<void> = Promise.resolve();
    socket.setEncoding("ascii");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_LENGTH) {
        this.log(`fw-server: ${remote} buffer overflow — dropping connection`);
        socket.destroy();
        return;
      }
      // Drain every complete line we have. A single TCP chunk may
      // carry multiple commands (VENUS doesn't pipeline today, but
      // we don't want to depend on that).
      while (true) {
        const idx = buffer.indexOf("\r\n");
        // Tolerate a lone LF or CR — some clients / trace replayers
        // drop one half of the pair. VENUS itself always sends CRLF.
        const altIdx = idx === -1
          ? buffer.search(/[\r\n]/)
          : idx;
        if (altIdx === -1) break;
        const line = buffer.slice(0, altIdx);
        // Skip over the terminator (CR, LF, or CRLF).
        buffer = buffer.slice(
          buffer[altIdx] === "\r" && buffer[altIdx + 1] === "\n" ? altIdx + 2 : altIdx + 1,
        );
        if (line.length === 0) continue; // empty line — ignore stray CRLF
        // Serialise dispatch per socket so responses never race past
        // the command that produced them.
        inFlight = inFlight.then(() => this.handleCommand(socket, line, remote));
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      this.log(`fw-server: ${remote} disconnected`);
    });
    socket.on("error", (err) => {
      this.log(`fw-server: ${remote} socket error`, err);
    });
  }

  private async handleCommand(socket: net.Socket, raw: string, remote: string): Promise<void> {
    // ASCII arrows — Windows console code pages (437/850) mangle the
    // Unicode ← → into `ÔåÄ`/`ÔåÆ` which leaks into the terminal output
    // and distracts from the actual commands. Stick to <<< / >>> in the
    // log prefix; the UI's log panel still uses pretty arrows in HTML.
    this.log(`fw <<< ${raw}`);
    let responsePayload: string;
    let twinResult: CommandResult | null = null;
    try {
      // Defer the state mutation to the end of the motion — for VENUS
      // and any other TCP client the twin now behaves like a real
      // instrument: commands take physical time, and mid-motion state
      // queries return the pre-command snapshot. `sendCommandDeferred`
      // emits the motion envelope at t=0 and resolves after
      // `durationMs * simSpeed`, matching the bridge ACK delay we
      // previously implemented separately. User request 2026-04-19.
      const result = await this.api.sendCommandDeferred(this.getActiveDeviceId(), raw, { simSpeed: this.simSpeed }) as CommandResult;
      twinResult = result;
      responsePayload = result.response;
    } catch (err: any) {
      this.log(`fw-server: ${remote} twin error on "${raw}"`, err);
      responsePayload = synthesizeErrorResponse(raw, 99, err?.message ?? "twin error");
      twinResult = { response: responsePayload, errorCode: 99, errorDescription: err?.message ?? "twin error" };
    }

    this.log(`fw >>> ${responsePayload}`);
    if (this.onCommand && twinResult) {
      try { this.onCommand({ raw, response: responsePayload, result: twinResult }); }
      catch (err: any) { this.log(`fw-server: onCommand callback threw`, err); }
    }
    if (!socket.writable) return;
    socket.write(`${responsePayload}\r\n`, "ascii");
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a VENUS-shaped error response when the twin itself blew up.
 * We keep the original module + code + orderId so VENUS can correlate,
 * and stamp `er99/00` (max error, no subcode) per the FW convention.
 */
function synthesizeErrorResponse(raw: string, errorCode: number, _reason: string): string {
  const prefix = raw.slice(0, 4);
  const idMatch = /id(\d{4})/.exec(raw);
  const id = idMatch ? idMatch[1] : "0000";
  const codeStr = String(errorCode).padStart(2, "0");
  return `${prefix}id${id}er${codeStr}/00`;
}

// ============================================================================
// Public helper — used by tests / headless entry
// ============================================================================

export async function startFwServer(options: FwServerOptions): Promise<FwServer> {
  const srv = new FwServer(options);
  await srv.start();
  return srv;
}
