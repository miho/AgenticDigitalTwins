/**
 * VENUS ComTrace replay harness (Phase 5 Step 5.6).
 *
 * Takes a recorded `.trc` file and replays its request lines against
 * the FDx bridge, confirming the bridge's responses match the
 * recorded ones in *shape* (command code + order id + error field +
 * named data fields). Exact numeric values can differ — real
 * pipetting commands return hardware-specific grip forces and Z
 * positions — so the matcher is tolerant on values and strict on
 * structure.
 *
 * The default target is the first 30 commands of the canonical
 * TipPickup1ml trace, which is the VENUS init sequence common to
 * every protocol. Keeping the harness narrow here means the test
 * runs in ~1 s and doesn't depend on the twin's deck layout.
 *
 * FAILURE INJECTION
 *   - If any init response drops its named field (e.g. twin no
 *     longer emits `rf…` for C0RF), the field-name comparison fails.
 *   - If the bridge drops the correlation between order id in and
 *     order id out, the id comparison fails on every row.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { createTestTwin } from "../helpers/in-process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startFwServer } = require("../../dist/services/bdz-bridge/fw-server");

// ============================================================================
// Trace parser
// ============================================================================

interface TraceEntry {
  direction: "tx" | "rx";
  timestamp: string;
  payload: string;
}

/**
 * Parse a .trc line. Format (from real VENUS ComTrace):
 *   `< HH:MM:SS.mmm <addr>: <payload>` — TX from host to instrument
 *   `> HH:MM:SS.mmm <addr>: <payload>` — RX from instrument to host
 */
function parseTraceLine(line: string): TraceEntry | null {
  const m = /^([<>])\s+([\d:.]+)\s+[^:]+:\s*(.*)$/.exec(line);
  if (!m) return null;
  const [, dir, ts, payload] = m;
  if (payload.length === 0) return null;
  return { direction: dir === "<" ? "tx" : "rx", timestamp: ts, payload };
}

interface Pair { request: string; expected: string; }

/** Parse a .trc file into ordered request/response pairs. Skips
 *  unsolicited `>` lines that have no matching preceding `<`. */
function parseTracePairs(traceText: string): Pair[] {
  const entries = traceText
    .split(/\r?\n/)
    .map(parseTraceLine)
    .filter((e): e is TraceEntry => e !== null);
  const pairs: Pair[] = [];
  let pendingReq: string | null = null;
  for (const e of entries) {
    if (e.direction === "tx") {
      pendingReq = e.payload;
    } else if (e.direction === "rx" && pendingReq !== null) {
      pairs.push({ request: pendingReq, expected: e.payload });
      pendingReq = null;
    }
  }
  return pairs;
}

// ============================================================================
// Shape comparator
// ============================================================================

interface ParsedResponse {
  prefix: string;               // module+code, e.g. "C0RF"
  orderId: string | null;       // the 4-digit id value (after "id")
  error: { main: string; detail: string | null } | null;
  fields: string[];             // ordered list of named data fields present
}

/**
 * Parse a response payload enough to compare shapes. We care about:
 *   1. module+code (4 chars) match,
 *   2. id<4-digit> match,
 *   3. error field shape match (`er##/##` vs `er##` vs absent),
 *   4. the set of named data fields (2-char keys in the tail).
 *
 * We deliberately do NOT compare numeric values — real hardware
 * returns grip forces, Z positions, serials etc. that the twin cannot
 * reproduce bit-for-bit.
 */
function parseResponseShape(resp: string): ParsedResponse {
  const prefix = resp.slice(0, 4);
  let rest = resp.slice(4);

  let orderId: string | null = null;
  const idMatch = /^id(\d{4})/.exec(rest);
  if (idMatch) {
    orderId = idMatch[1];
    rest = rest.slice(idMatch[0].length);
  }

  let error: ParsedResponse["error"] = null;
  const er2 = /^er(\d{2})\/(\d{2})/.exec(rest);
  if (er2) {
    error = { main: er2[1], detail: er2[2] };
    rest = rest.slice(er2[0].length);
  } else {
    const er1 = /^er(\d{2})/.exec(rest);
    if (er1) {
      error = { main: er1[1], detail: null };
      rest = rest.slice(er1[0].length);
    }
  }

  // Extract named data field keys. Keys in FW responses are lowercase
  // 2-char tokens (rf, kb, lh, sx, sg, rq, qb, si, sn, jd, js, …).
  // Values run until the next lowercase 2-char token or end-of-string.
  const fields: string[] = [];
  const fieldRe = /([a-z]{2})(?=[^a-z]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(rest)) !== null) {
    // Filter out bits that are part of a value: require that the
    // previous char (if any) is non-alphabetic.
    const i = m.index;
    if (i > 0 && /[a-z]/.test(rest[i - 1])) continue;
    fields.push(m[1]);
  }

  return { prefix, orderId, error, fields };
}

function shapesMatch(actual: ParsedResponse, expected: ParsedResponse): string | null {
  if (actual.prefix !== expected.prefix) return `prefix ${actual.prefix} vs ${expected.prefix}`;
  if (actual.orderId !== expected.orderId) return `orderId ${actual.orderId} vs ${expected.orderId}`;
  // Error shape: treat detail==null (single 2-digit) and detail!=null
  // (two 2-digit) as structurally distinct.
  const a = actual.error, e = expected.error;
  if ((!a) !== (!e)) return `error presence`;
  if (a && e) {
    if ((a.detail === null) !== (e.detail === null)) return `error shape ##/## vs ##`;
  }
  // Field set must be a superset of the expected set — twin may emit
  // extra fields, but must not omit fields VENUS reads.
  for (const f of expected.fields) {
    if (!actual.fields.includes(f)) return `missing field ${f}`;
  }
  return null;
}

// ============================================================================
// Test
// ============================================================================

/** Absolute path to the canonical TipPickup1ml trace. */
const TRACE_PATH = path.resolve(
  __dirname,
  "..", "..", "..",
  "VENUS-2026-04-13",
  "QA", "Venus.Tests.Integration", "TestData", "Star",
  "TipPickup", "TipPickup1ml_ComTrace.trc",
);

/** How many init-path pairs to compare. Beyond this the trace issues
 *  real pipetting ops whose hardware responses can't be matched
 *  structurally without running the whole protocol. */
const INIT_PAIRS = 30;

/** Plain line-delimited TCP client — matches the BDZ transport VENUS
 *  actually uses on the device port. No FDx framing, no handshake. */
async function connectClient(port: number) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const messages: string[] = [];
  let buffer = "";
  socket.setEncoding("ascii");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (line.length > 0) messages.push(line);
    }
  });
  return {
    async request(raw: string, timeoutMs = 5000): Promise<string> {
      const match = /id(\d{4})/.exec(raw);
      const id = match?.[1];
      const deadline = Date.now() + timeoutMs;
      socket.write(`${raw}\r\n`, "ascii");
      while (Date.now() < deadline) {
        const hit = messages.findIndex((m) => !id || m.includes(`id${id}`));
        if (hit >= 0) {
          const [resp] = messages.splice(hit, 1);
          return resp;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`request timeout for ${raw}`);
    },
    close(): Promise<void> {
      return new Promise((resolve) => socket.end(() => resolve()));
    },
  };
}

describe("FDx trace replay harness (Step 5.6)", () => {
  let server: any;
  let twin: ReturnType<typeof createTestTwin>;

  beforeAll(async () => {
    if (!fs.existsSync(TRACE_PATH)) {
      // We can't block the suite if the VENUS zip isn't unpacked — but
      // this test file EXISTS only because that trace exists at that
      // path. Flag it loudly.
      throw new Error(`trace file missing at ${TRACE_PATH} — cannot run replay harness`);
    }
    twin = createTestTwin();
    server = await startFwServer({
      api: twin.api,
      getActiveDeviceId: () => twin.deviceId,
      port: 0,
      simSpeed: 0,
    });
  });

  afterAll(async () => {
    await server?.close();
    twin?.destroy();
  });

  it(`replays the first ${INIT_PAIRS} init pairs with matching response shapes`, async () => {
    const traceText = fs.readFileSync(TRACE_PATH, "utf-8");
    const pairs = parseTracePairs(traceText).slice(0, INIT_PAIRS);
    expect(pairs.length).toBeGreaterThan(10);

    const client = await connectClient(server.port);
    const failures: Array<{ idx: number; req: string; reason: string; actual: string; expected: string }> = [];

    for (let i = 0; i < pairs.length; i++) {
      const { request, expected } = pairs[i];
      const actual = await client.request(request);
      const reason = shapesMatch(parseResponseShape(actual), parseResponseShape(expected));
      if (reason) failures.push({ idx: i, req: request, reason, actual, expected });
    }
    await client.close();

    // Report every divergence at once — makes the error message
    // actionable instead of showing one failure at a time.
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `#${f.idx} ${f.req}\n   want: ${f.expected}\n   got:  ${f.actual}\n   why:  ${f.reason}`)
        .join("\n");
      throw new Error(`${failures.length}/${pairs.length} init-pair mismatches:\n${detail}`);
    }
  });
});
