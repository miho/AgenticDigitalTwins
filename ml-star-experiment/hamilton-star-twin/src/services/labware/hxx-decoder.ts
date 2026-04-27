/**
 * .hxx decoder — Hamilton's "Hamilton3dData" 3D asset container.
 *
 * Format (reverse-engineered):
 *
 *   offset 0   : "Hamilton3dData"              (14 bytes, ASCII magic)
 *   offset 14  : 2 bytes version/flags         (0x01 0x01 observed)
 *   offset 16  : 2 bytes reserved              (0x00 0x00 observed)
 *   offset 18+ : chunk table — for every labware .hxx we've seen
 *                there is exactly ONE chunk named "__Main3dData__"
 *                followed directly by a gzip stream.
 *
 * We don't need to understand the chunk table in detail — the gzip
 * magic (`1f 8b 08`) is easy to scan for and every file in the
 * install tree has its main 3D payload as the first gzip stream.
 * The payload, once decompressed, is a DirectX .x file in TEXT
 * encoding (`xof 0302txt 0032` header).
 *
 * The 14-byte ASCII magic is what we key off — don't mistake any
 * random file starting with `1f 8b` for a .hxx.
 */
import * as zlib from "zlib";

const MAGIC = Buffer.from("Hamilton3dData", "ascii");
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);

export class HxxDecodeError extends Error {}

/** Return true if the given bytes look like a Hamilton3dData container. */
export function isHxx(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Decode a .hxx buffer to its DirectX .x text payload.
 *
 * Throws HxxDecodeError on missing magic, missing gzip stream, or
 * decompression failure.
 */
export function decodeHxx(buf: Buffer): string {
  if (!isHxx(buf)) {
    throw new HxxDecodeError(
      `Not a Hamilton3dData container (first bytes: ${buf.subarray(0, 16).toString("hex")})`,
    );
  }

  const gzipStart = buf.indexOf(GZIP_MAGIC, MAGIC.length);
  if (gzipStart < 0) {
    throw new HxxDecodeError("No gzip stream found after Hamilton3dData header");
  }

  // `zlib.gunzipSync` rejects Hamilton's containers because they
  // pack 8 bytes of gzip trailer + a container footer after the
  // deflate stream and Node reads the footer as a second member's
  // header. `inflateRawSync` stops cleanly at end-of-stream and
  // ignores trailing bytes, so we skip the 10-byte gzip header
  // (plus any optional fields signalled by FLG) ourselves and
  // inflate the raw deflate payload.
  const deflateStart = gzipStart + parseGzipHeaderLength(buf, gzipStart);
  const decompressed = zlib.inflateRawSync(buf.subarray(deflateStart));

  // DirectX .x text encoding is ASCII / latin1. Using latin1 keeps
  // the byte stream round-trippable even if a stray high byte
  // appears in a comment or template GUID.
  return decompressed.toString("latin1");
}

/**
 * Return the length of the gzip member header at `offset`, so callers
 * can advance past it to the raw deflate payload. Every .hxx we've seen
 * has FLG=0 (10-byte header) but the logic here is the full gzip
 * spec so it tolerates files with filename/comment/extra fields.
 */
function parseGzipHeaderLength(buf: Buffer, offset: number): number {
  // 1f 8b 08 FLG MTIME(4) XFL OS = 10 bytes base
  const flg = buf[offset + 3];
  let pos = offset + 10;
  if (flg & 0x04) {
    // FEXTRA: 2-byte XLEN + XLEN bytes of extra field
    const xlen = buf.readUInt16LE(pos);
    pos += 2 + xlen;
  }
  if (flg & 0x08) {
    // FNAME: zero-terminated ISO-8859-1 filename
    while (pos < buf.length && buf[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 0x10) {
    // FCOMMENT: zero-terminated ISO-8859-1 comment
    while (pos < buf.length && buf[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 0x02) {
    // FHCRC: 2-byte CRC16 of header
    pos += 2;
  }
  return pos - offset;
}
