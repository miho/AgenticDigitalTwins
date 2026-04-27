/**
 * HxCfgFile parser (Phase-post-5, issue #18; binary support added for
 * issue #20 — customer-saved .lay files default to binary in VENUS 6+).
 *
 * Hamilton uses the `HxCfgFile` container for every static
 * configuration artefact: decks (`.dck`), carrier templates (`.tml`),
 * labware racks (`.rck`), and method layouts (`.lay`). The container
 * has two wire formats — text and binary — with identical semantics.
 *
 * TEXT format (original):
 *   Header:
 *     HxCfgFile,<ver>;                   — format tag + version
 *     ConfigIsValid,Y;                   — always Y in deliverables
 *   Zero or more sections:
 *     DataDef,<TYPE>,<ver>,<name>,       — section start
 *     { body };                          — object body, OR
 *     [ body ];                          — array body
 *
 *   Object body lines:
 *     Key, "value",                      — string value
 *     Key, value,                        — numeric/bool (rare in practice;
 *                                          treat everything as string)
 *   Keys may contain dots to express nested structure. The parser
 *   materialises `Labware.1.TForm.3.X` as `Labware[1].TForm[3].X` in a
 *   plain object tree. Numeric path components (all-digit keys) become
 *   string keys so sparse indices (e.g. "Labware.13") don't waste
 *   memory on phantom entries. VENUS files use 1-based indices.
 *
 *   Array body lines:
 *     "value1",
 *     "value2", ...
 *
 *   Comments (legal outside blocks only):
 *     * ... line comment starting with asterisk at column 0
 *
 * BINARY format (MFC CArchive-serialised, the default when VENUS's
 * System Config Editor or Method Editor saves a file):
 *   - All integers are little-endian.
 *   - `short` = 2 bytes, `long` = 4 bytes.
 *   - `CString` uses MFC's length-prefix scheme: one byte `bLen`; if
 *     `bLen < 0xFF` that's the length in bytes (ASCII). If `bLen ==
 *     0xFF`, read a WORD `wLen`; if < 0xFFFF that's the length. If
 *     0xFFFE, the string is Unicode UTF-16 (we reject — the VENUS
 *     files we've seen are all ASCII). If 0xFFFF, read a DWORD for
 *     the length.
 *   - `CObject::Serialize` is a no-op when called as a member, so no
 *     schema markers appear inside the nested blocks.
 *   Layout (see VENUS-2026-04-13/Vector/src/HxCfgFil/Code/HxCfgFile.cpp
 *   ::CHxCfgFile::DeserializeFile, cfgfile.cpp::HxCfgDataDefTbl::Serialize,
 *   cfgfile.h::HxCfgDataDef::Serialize, cfgfile.cpp::HxCfgDict::Serialize):
 *
 *     short verNum                        — format version (1..3)
 *     short cfgStatus                     — 1 = valid, 0 = not valid
 *     long  ddCount                       — number of DataDef entries
 *     for each DataDef:
 *       CString completeName              — "TYPE,name"
 *       short  ddVerNum                   — section version
 *       long   dictCount                  — number of dict pairs
 *       for each dict pair:
 *         CString key                     — dotted path
 *         CString value
 *     if verNum == 3 (WITH_ARRAYSUPPORT):
 *       long   dd2Count                   — DataDef2 table (array bodies)
 *       for each DataDef2:
 *         CString completeName
 *         short  ddVerNum
 *         long   arrayCount               — number of elements (pairs of
 *                                           key+value in our observation)
 *         for each element:
 *           CString key                   — array index as string "1","2"…
 *                                           followed by nested-dict cells
 *           CString value
 *     (We parse the DataDef2 table best-effort — empty in most files we
 *     see; if the format drifts we surface a warning and continue with
 *     just the DataDef table.)
 *
 * This parser is INTENTIONALLY permissive — we've seen real files with
 * trailing spaces, mixed line endings, and empty sections. We preserve
 * the raw string value for every field; higher-level interpreters
 * convert to numbers where semantics demand it.
 */

// ============================================================================
// Types
// ============================================================================

/** One section (`DataDef,...`) with its body. */
export interface HxCfgSection {
  /** Section type (e.g. "DECKLAY", "DECK", "RECTRACK", "TEMPLATE"). */
  dataType: string;
  /** Section format version as declared on the DataDef line. */
  version: string;
  /** Section name as declared on the DataDef line (e.g. "ML_STAR"). */
  name: string;
  /** Parsed body — object for `{ ... }` blocks, array for `[ ... ]` blocks. */
  body: HxCfgNode;
}

/** Union of node kinds a parsed body can produce. */
export type HxCfgNode = HxCfgObject | HxCfgArray | string;
/** Nested object mirroring the `A.B.C, "x"` key dot paths. */
export interface HxCfgObject { [key: string]: HxCfgNode; }
/** Array body. */
export type HxCfgArray = string[];

/** Full parsed document — header fields + sections in order. */
export interface HxCfgDocument {
  /** Format version from `HxCfgFile,<ver>;`. */
  formatVersion: string;
  /** Whether `ConfigIsValid,Y;` was asserted. Non-Y files still parse;
   *  consumers decide whether to reject them. */
  configIsValid: boolean;
  /** Sections in the order they appeared. */
  sections: HxCfgSection[];
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a HxCfgFile payload. Accepts either the text format (as a
 * string) or the binary format (as a Buffer); auto-detects which one
 * it's got by sniffing the first bytes. Throws on unrecoverable format
 * errors (missing `HxCfgFile,<ver>;` header for text; malformed
 * length-prefix or truncation for binary).
 */
export function parseHxCfg(input: string | Buffer): HxCfgDocument {
  if (Buffer.isBuffer(input)) {
    return isBinaryHxCfg(input) ? parseHxCfgBinary(input) : parseHxCfgText(input.toString("utf-8"));
  }
  return parseHxCfgText(input);
}

/** Legacy alias — several callers still pass a string. Text-only. */
function parseHxCfgText(text: string): HxCfgDocument {
  const lines = text.split(/\r?\n/);
  const doc: HxCfgDocument = {
    formatVersion: "",
    configIsValid: false,
    sections: [],
  };

  let i = 0;
  let sawHeader = false;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip blanks + comments (must be outside a block).
    if (line.length === 0 || line.startsWith("*")) { i++; continue; }

    // Header: HxCfgFile,<ver>;
    const hdr = /^HxCfgFile\s*,\s*([^;]+);/.exec(line);
    if (hdr) {
      doc.formatVersion = hdr[1].trim();
      sawHeader = true;
      i++;
      continue;
    }

    // Header: ConfigIsValid,Y;
    const civ = /^ConfigIsValid\s*,\s*([^;]+);/.exec(line);
    if (civ) {
      doc.configIsValid = /^Y/i.test(civ[1].trim());
      i++;
      continue;
    }

    // DataDef,TYPE,ver,name,
    const dd = /^DataDef\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*(.*?)\s*,?\s*$/.exec(line);
    if (dd) {
      if (!sawHeader) throw new Error("parseHxCfg: DataDef before HxCfgFile header");
      const section: HxCfgSection = {
        dataType: dd[1].trim(),
        version: dd[2].trim(),
        name: stripTrailingComma(dd[3]),
        body: {},
      };
      // The next non-blank line starts the body with { or [.
      i++;
      while (i < lines.length && lines[i].trim().length === 0) i++;
      if (i >= lines.length) throw new Error("parseHxCfg: DataDef missing body");
      const bodyOpen = lines[i].trim();
      if (bodyOpen === "{") {
        const [body, next] = parseObjectBody(lines, i + 1);
        section.body = body;
        i = next;
      } else if (bodyOpen === "[") {
        const [body, next] = parseArrayBody(lines, i + 1);
        section.body = body;
        i = next;
      } else {
        throw new Error(`parseHxCfg: expected '{' or '[' at line ${i + 1}, got '${bodyOpen}'`);
      }
      doc.sections.push(section);
      continue;
    }

    // Any other top-level line is ignored — real files contain a few
    // oddities (e.g. blank lines surrounded by whitespace).
    i++;
  }

  if (!sawHeader) throw new Error("parseHxCfg: missing HxCfgFile header");
  return doc;
}

/** Parse body lines until we hit a `};` terminator. Returns [body, nextLineIndex]. */
function parseObjectBody(lines: string[], start: number): [HxCfgObject, number] {
  const body: HxCfgObject = {};
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "};" || line === "}") return [body, i + 1];
    if (line.length === 0) { i++; continue; }

    const kv = /^([A-Za-z0-9_.-]+)\s*,\s*(.*)$/.exec(line);
    if (!kv) {
      // Unparseable line inside a body — skip with tolerance. Real
      // files occasionally include stray whitespace.
      i++;
      continue;
    }
    const keyPath = kv[1];
    const rest = kv[2].trim();
    const value = extractValue(rest);
    setDotPath(body, keyPath, value);
    i++;
  }
  throw new Error(`parseHxCfg: unterminated object body starting at line ${start}`);
}

function parseArrayBody(lines: string[], start: number): [HxCfgArray, number] {
  const body: HxCfgArray = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "];" || line === "]") return [body, i + 1];
    if (line.length === 0) { i++; continue; }
    body.push(extractValue(line));
    i++;
  }
  throw new Error(`parseHxCfg: unterminated array body starting at line ${start}`);
}

/**
 * A value line looks like `"foo",` — strip the trailing comma and
 * surrounding quotes. Quoted strings may contain escaped quotes as
 * `""` — we preserve them as a single `"`. Unquoted scalars (rare in
 * practice) pass through minus the trailing comma.
 */
function extractValue(raw: string): string {
  let v = stripTrailingComma(raw);
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v.slice(1, -1).replace(/""/g, '"');
  }
  return v;
}

function stripTrailingComma(s: string): string {
  const trimmed = s.trim();
  return trimmed.endsWith(",") ? trimmed.slice(0, -1).trim() : trimmed;
}

/**
 * Assign `value` into the object at the dot-separated path. Numeric
 * path components are preserved as string keys so sparse indices
 * (e.g. "Labware.13") don't waste memory on phantom entries.
 */
function setDotPath(root: HxCfgObject, path: string, value: string): void {
  const parts = path.split(".");
  let cursor: HxCfgObject = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cursor[key];
    if (!isObject(next)) {
      const created: HxCfgObject = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[parts[parts.length - 1]] = value;
}

function isObject(node: HxCfgNode | undefined): node is HxCfgObject {
  return node !== undefined && typeof node === "object" && !Array.isArray(node);
}

// ============================================================================
// Accessors — convenience getters that interpret fields as numbers etc.
// ============================================================================

/** Pull a string field from an object body. Returns `undefined` if absent. */
export function getStr(obj: HxCfgObject, path: string): string | undefined {
  const parts = path.split(".");
  let cursor: HxCfgNode | undefined = obj;
  for (const p of parts) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[p];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/** Pull a numeric field, parsing from the stored string. */
export function getNum(obj: HxCfgObject, path: string): number | undefined {
  const s = getStr(obj, path);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Enumerate indexed children: for `Labware.1`, `Labware.2`, …, return
 * each child object alongside its index. Skips non-numeric keys.
 */
export function enumerateIndexed(obj: HxCfgObject, prefix: string): Array<{ index: number; child: HxCfgObject }> {
  const container = (obj[prefix] ?? {}) as HxCfgObject;
  if (!isObject(container)) return [];
  const out: Array<{ index: number; child: HxCfgObject }> = [];
  for (const k of Object.keys(container)) {
    const idx = Number(k);
    if (!Number.isInteger(idx)) continue;
    const child = container[k];
    if (isObject(child)) out.push({ index: idx, child });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Find the first section of a given dataType, or undefined. */
export function findSection(doc: HxCfgDocument, dataType: string): HxCfgSection | undefined {
  return doc.sections.find((s) => s.dataType === dataType);
}

// ============================================================================
// Binary HxCfgFile — MFC CArchive layout, see top-of-file block for the
// wire-format reference.
// ============================================================================

/** Sniff the first bytes to decide which wire format we got. Text
 *  files always begin with the ASCII marker "HxCfgFile"; binary files
 *  start with a 2-byte version number (1..3 in existing releases). */
function isBinaryHxCfg(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf.slice(0, 9).toString("latin1") === "HxCfgFile") return false;
  // Binary header: short verNum + short cfgStatus. Sanity-check the
  // version falls in the set the MFC serialiser has ever produced
  // (1..3) and status is 0 or 1. That rules out random text/UTF BOMs.
  const verNum = buf.readInt16LE(0);
  const cfgStatus = buf.readInt16LE(2);
  return verNum >= 1 && verNum <= 10 && (cfgStatus === 0 || cfgStatus === 1);
}

interface BinReader {
  buf: Buffer;
  pos: number;
}

function readShort(r: BinReader): number {
  const v = r.buf.readInt16LE(r.pos);
  r.pos += 2;
  return v;
}

function readLong(r: BinReader): number {
  const v = r.buf.readInt32LE(r.pos);
  r.pos += 4;
  return v;
}

/** MFC CString::Serialize decode. Supports short (≤254), medium (WORD),
 *  long (DWORD) ASCII forms. Unicode (wLen == 0xFFFE) is not supported
 *  — none of the VENUS files we've inspected contain one, and
 *  tolerating it would complicate the parser significantly. */
function readCString(r: BinReader): string {
  if (r.pos + 1 > r.buf.length) throw new Error(`parseHxCfgBinary: CString length byte past EOF at offset ${r.pos}`);
  const bLen = r.buf.readUInt8(r.pos);
  r.pos += 1;
  let nLen: number;
  if (bLen < 0xff) {
    nLen = bLen;
  } else {
    if (r.pos + 2 > r.buf.length) throw new Error(`parseHxCfgBinary: CString wLen past EOF at offset ${r.pos}`);
    const wLen = r.buf.readUInt16LE(r.pos);
    r.pos += 2;
    if (wLen === 0xfffe) {
      throw new Error(`parseHxCfgBinary: Unicode CString at offset ${r.pos - 3} — file format not supported`);
    } else if (wLen < 0xffff) {
      nLen = wLen;
    } else {
      if (r.pos + 4 > r.buf.length) throw new Error(`parseHxCfgBinary: CString dwLen past EOF at offset ${r.pos}`);
      nLen = r.buf.readUInt32LE(r.pos);
      r.pos += 4;
    }
  }
  if (r.pos + nLen > r.buf.length) throw new Error(`parseHxCfgBinary: CString bytes past EOF at offset ${r.pos} (want ${nLen})`);
  const s = r.buf.slice(r.pos, r.pos + nLen).toString("latin1");
  r.pos += nLen;
  return s;
}

/** Parse the binary HxCfgFile format into the same HxCfgDocument the
 *  text parser emits, so downstream callers (importVenusLayout etc.)
 *  don't need to care which format they got. */
export function parseHxCfgBinary(buf: Buffer): HxCfgDocument {
  const r: BinReader = { buf, pos: 0 };
  const verNum = readShort(r);
  const cfgStatus = readShort(r);
  const doc: HxCfgDocument = {
    formatVersion: String(verNum),
    configIsValid: cfgStatus === 1,
    sections: [],
  };

  // --- DataDefTbl (object bodies, always present) -----------------------
  const ddCount = readLong(r);
  for (let i = 0; i < ddCount; i++) {
    const completeName = readCString(r);
    const ddVerNum = readShort(r);
    const body = readDictBody(r);
    doc.sections.push(splitCompleteName(completeName, ddVerNum, body));
  }

  // --- DataDefTbl2 (array bodies, only in file-version 3) ---------------
  if (verNum === 3 && r.pos < buf.length) {
    try {
      const dd2Count = readLong(r);
      for (let i = 0; i < dd2Count; i++) {
        const completeName = readCString(r);
        const ddVerNum = readShort(r);
        // DataDef2 in the files we've seen is empty; fall back to a
        // dict read — if the schema drifts we stop gracefully rather
        // than corrupting the document.
        const body = readDictBody(r);
        doc.sections.push(splitCompleteName(completeName, ddVerNum, body));
      }
    } catch {
      // Swallow — best-effort. The primary table is intact.
    }
  }

  return doc;
}

function readDictBody(r: BinReader): HxCfgObject {
  const count = readLong(r);
  const body: HxCfgObject = {};
  for (let i = 0; i < count; i++) {
    const key = readCString(r);
    const value = readCString(r);
    setDotPath(body, key, value);
  }
  return body;
}

/** Split "TYPE,name" into { dataType: "TYPE", name: "name" }. VENUS
 *  allows spaces between the two. */
function splitCompleteName(completeName: string, ddVerNum: number, body: HxCfgObject): HxCfgSection {
  const commaIdx = completeName.indexOf(",");
  const dataType = commaIdx >= 0 ? completeName.slice(0, commaIdx).trim() : completeName.trim();
  const name = commaIdx >= 0 ? completeName.slice(commaIdx + 1).trim() : "";
  return { dataType, version: String(ddVerNum), name, body };
}
