/**
 * Cached .hxx → GLB loader.
 *
 * The REST handler uses this to turn a VENUS-style repo path
 * (e.g. `ML_STAR/CORE/Waste2.hxx`) into a ready-to-serve GLB.
 * Conversion is O(file size) and does some non-trivial work, so
 * we cache the converted GLB keyed by the absolute .hxx path
 * + mtime. Invalidating on mtime is cheap and future-proofs us
 * against operators updating Hamilton's labware install in place.
 */

import * as fs from "fs";
import * as path from "path";
import { decodeHxx, isHxx } from "./hxx-decoder";
import { parseX } from "./x-parser";
import { xToGlb } from "./x-to-gltf";
import { findHamiltonInstallRoot, resolveHamiltonPath } from "../venus-import/hamilton-config-loader";

interface CacheEntry {
  mtimeMs: number;
  glb: Buffer;
}
const cache = new Map<string, CacheEntry>();

export class HxxNotFoundError extends Error {}

/**
 * Resolve a relative repo path (Labware-rooted) to an absolute .hxx
 * on disk, looking at `process.env.HAMILTON_ROOT` → standard install
 * locations.
 *
 * Returns null when no Hamilton install is present or when the file
 * doesn't exist — the caller turns these into HTTP 404.
 */
export function resolveHxxPath(relativePath: string): string | null {
  const installRoot = findHamiltonInstallRoot();
  if (!installRoot) return null;
  // Strip a leading "Labware/" if the caller included it — the
  // resolver adds it.
  const rel = relativePath.replace(/^\/+/, "").replace(/^Labware[\\/]+/i, "");
  return resolveHamiltonPath(installRoot, rel, "labware");
}

/**
 * Load + convert a .hxx file to GLB, cached by (path, mtime).
 *
 * Throws HxxNotFoundError if the file doesn't exist on disk.
 */
export function loadHxxAsGlb(absPath: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new HxxNotFoundError(`No such .hxx file: ${absPath}`);
  }
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.glb;

  const buf = fs.readFileSync(absPath);
  if (!isHxx(buf)) {
    throw new Error(`${absPath} is not a Hamilton3dData container`);
  }
  const glb = xToGlb(parseX(decodeHxx(buf)));
  cache.set(absPath, { mtimeMs: stat.mtimeMs, glb });
  return glb;
}

/** Clear the converted-GLB cache. Primarily for tests. */
export function clearHxxCache(): void {
  cache.clear();
}

/**
 * List every .hxx file present under the active Hamilton install's
 * `Labware/` tree, returning repo-style relative paths the renderer
 * can pass back to the GLB endpoint.
 *
 * Returns [] when no Hamilton install is available.
 */
export function listInstalledHxx(): string[] {
  const installRoot = findHamiltonInstallRoot();
  if (!installRoot) return [];
  const labwareRoot = path.join(installRoot, "Labware");
  if (!fs.existsSync(labwareRoot)) return [];
  const out: string[] = [];
  function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith(".hxx")) {
        out.push(path.relative(labwareRoot, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(labwareRoot);
  return out.sort();
}
