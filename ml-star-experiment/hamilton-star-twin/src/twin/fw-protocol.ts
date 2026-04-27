/**
 * Hamilton STAR Firmware Protocol Parser
 *
 * Parses FW command strings like "C0ASid0001tm1at0xp02980yp1460..."
 * into structured objects, and formats responses back.
 *
 * Protocol format:
 *   <module_prefix:2><command_code:2>id<order_id:4><param_key:2><value>...
 *
 * All values are integers. Parameter keys are 2 lowercase letters.
 * Module prefix and command code are 2 uppercase letters.
 */

/** A parsed firmware command */
export interface FwCommand {
  /** Module prefix (e.g. "C0") */
  module: string;
  /** Command code (e.g. "AS") */
  code: string;
  /** Combined module+code for event routing (e.g. "C0AS") */
  event: string;
  /** Order ID for async tracking (0-9999) */
  orderId: number;
  /** Parameter key-value pairs (e.g. {tm: 1, av: 1000}) */
  params: Record<string, number>;
  /** Original raw command string */
  raw: string;
  /** Multi-channel array parameters (space-separated values per channel) */
  arrayParams?: Record<string, number[]>;
}

/** A firmware response */
export interface FwResponse {
  module: string;
  code: string;
  orderId: number;
  mainError: number;
  detailError: number;
  data: Record<string, number | string>;
}

/**
 * Parse a raw FW command string into a structured FwCommand.
 *
 * Example: "C0ASid0001tm1at0xp02980" parses to:
 *   { module: "C0", code: "AS", event: "C0AS", orderId: 1,
 *     params: { tm: 1, at: 0, xp: 2980 } }
 */
export function parseFwCommand(raw: string): FwCommand {
  if (raw.length < 4) {
    throw new Error(`Command too short: "${raw}"`);
  }

  const module = raw.substring(0, 2);
  const code = raw.substring(2, 4);
  const event = module + code;

  let orderId = 0;
  let paramStart = 4;

  // Parse order ID if present: "id" followed by 4 digits
  if (raw.substring(4, 6) === "id") {
    orderId = parseInt(raw.substring(6, 10), 10) || 0;
    paramStart = 10;
  }

  // Parse parameters: 2 lowercase letters followed by digits
  // Handles multi-channel & separator: "xp03204&yp3378 3288 3198..." and
  // space-separated per-channel arrays: "tm1 0 1 0 1 0 1 0"
  const params: Record<string, number> = {};
  const arrayParams: Record<string, number[]> = {};

  // Split on & to handle array parameter boundaries
  // "xp03204&yp3378 3288 3198 3108tm1&tt04" → ["xp03204", "yp3378 3288 3198 3108tm1", "tt04"]
  const paramStr = raw.substring(paramStart);
  const segments = paramStr.split("&");

  for (const segment of segments) {
    let pos = 0;
    while (pos < segment.length) {
      if (pos + 2 > segment.length) break;

      const key = segment.substring(pos, pos + 2);
      if (!/^[a-z]{2}$/.test(key)) {
        pos++;
        continue;
      }
      pos += 2;

      // Collect all values (space-separated = per-channel array)
      const values: number[] = [];
      while (pos < segment.length) {
        // Skip spaces between values
        while (pos < segment.length && segment[pos] === " ") pos++;

        // Check if next chars are a parameter key (2 lowercase letters)
        if (pos + 2 <= segment.length && /^[a-z]{2}/.test(segment.substring(pos, pos + 2))) {
          // Peek: if followed by a digit or sign, it's a new parameter
          const afterKey = pos + 2 < segment.length ? segment[pos + 2] : "";
          if (/[\d\-]/.test(afterKey) || afterKey === "" || afterKey === " ") break;
        }

        // Parse one value
        let valueStr = "";
        while (pos < segment.length && /[\d\-]/.test(segment[pos])) {
          valueStr += segment[pos];
          pos++;
        }

        if (valueStr.length > 0) {
          values.push(parseInt(valueStr, 10));
        } else {
          break;
        }
      }

      if (values.length === 1) {
        params[key] = values[0];
      } else if (values.length > 1) {
        params[key] = values[0]; // First value for backward compatibility
        arrayParams[key] = values;
      }
    }
  }

  return { module, code, event, orderId, params, raw, arrayParams };
}

/**
 * Shape of the `er` field in a FW response. Confirmed against
 * `VENUS-2026-04-13/Star/src/HxGruCommand/Config/ML_STAR_Simulator.cfg`:
 *
 *   - Master (C0) responses use two 2-digit fields: `er##/##`.
 *   - Sub-device (P1..P8, H0, X0, W1..W2, D0..D4) responses use a
 *     single 2-digit field: `er##`.
 *   - A handful of status-query commands (notably `C0RQ`) omit the er
 *     field entirely; they return only raw data. Callers signal this
 *     via `errorFormat: "none"`.
 */
export type FwErrorFormat = "master" | "subdevice" | "none";

/**
 * Decide which error-field shape a given module+code uses on the wire.
 *
 * Rules (derived from the simulator config and real `.trc` recordings):
 *   - `C0RQ` is the one master command that emits no error field —
 *     responses are bare `rq####`.
 *   - Any other `C0xx` command uses the two-field `er##/##` form.
 *   - Every sub-device (two-char prefix not starting with C) uses the
 *     single-field `er##` form.
 *
 * The table is deliberately small. Additional exceptions discovered
 * against real hardware get added here, with a reference comment.
 */
export function errorFormatFor(module: string, code: string): FwErrorFormat {
  if (module === "C0" && code === "RQ") return "none";
  if (module === "C0") return "master";
  return "subdevice";
}

/**
 * Format a FW response string.
 *
 * Defaults match the production digital twin's legacy behaviour (master
 * format, two 2-digit error fields). Pass `errorFormat` to produce the
 * shapes real VENUS hardware uses for sub-device replies and for the
 * status-query commands that omit the error field.
 *
 * Examples (verified against real VENUS ComTrace recordings):
 *   formatFwResponse("C0", "AS", 1, 0, 0)                               → "C0ASid0001er00/00"
 *   formatFwResponse("C0", "RQ", 1, 0, 0, { rq: "0000" }, "none")        → "C0RQid0001rq0000"
 *   formatFwResponse("P1", "RF", 1, 0, 0, { rf: "6.0S …" }, "subdevice") → "P1RFid0001er00rf6.0S …"
 */
export function formatFwResponse(
  module: string,
  code: string,
  orderId: number,
  mainError: number = 0,
  detailError: number = 0,
  data?: Record<string, number | string>,
  errorFormat: FwErrorFormat = "master"
): string {
  const id = String(orderId).padStart(4, "0");
  const main2 = String(mainError).padStart(2, "0");
  const detail2 = String(detailError).padStart(2, "0");
  let response = `${module}${code}id${id}`;
  if (errorFormat === "master") {
    response += `er${main2}/${detail2}`;
  } else if (errorFormat === "subdevice") {
    response += `er${main2}`;
  }
  // "none" → skip the er field entirely (e.g. C0RQ).

  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (key === "") {
        response += value; // Packed format (C0QM)
      } else {
        response += `${key}${value}`;
      }
    }
  }

  return response;
}

/**
 * Build a FW command string from structured parameters.
 *
 * Example: buildFwCommand("C0", "AS", 1, {tm: 1, av: 1000})
 *   => "C0ASid0001tm1av1000"
 */
export function buildFwCommand(
  module: string,
  code: string,
  orderId: number,
  params: Record<string, number>
): string {
  const id = String(orderId).padStart(4, "0");
  let cmd = `${module}${code}id${id}`;

  for (const [key, value] of Object.entries(params)) {
    cmd += `${key}${value}`;
  }

  return cmd;
}
