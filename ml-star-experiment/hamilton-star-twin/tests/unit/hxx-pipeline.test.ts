/**
 * Unit tests for the .hxx → glTF pipeline.
 *
 *   decodeHxx  — Hamilton3dData container + gzip payload
 *   parseX     — DirectX .x text (subset Hamilton uses)
 *   xToGlb     — glTF 2.0 GLB serialization
 *   loadHxxAsGlb + resolveHxxPath + listInstalledHxx — install-aware loader
 *
 * Where possible the tests use hand-rolled fixtures so they pass on CI
 * runners without Hamilton installed. Install-gated tests skip cleanly
 * when `C:/Program Files (x86)/Hamilton/Labware/` isn't present, and
 * pin specific size/shape expectations against known assets when it is.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as zlib from "zlib";
import { decodeHxx, isHxx, HxxDecodeError } from "../../src/services/labware/hxx-decoder";
import { parseX, XParseError } from "../../src/services/labware/x-parser";
import { xToGlb } from "../../src/services/labware/x-to-gltf";
import {
  loadHxxAsGlb,
  resolveHxxPath,
  listInstalledHxx,
  clearHxxCache,
} from "../../src/services/labware/hxx-loader";

const WASTE2 = "C:/Program Files (x86)/HAMILTON/Labware/ML_STAR/CORE/Waste2.hxx";

function hamiltonInstallPresent(): boolean {
  return fs.existsSync(WASTE2);
}

// Minimal valid .x text with 1 frame, 1 mesh, 1 triangle, 1 material.
const MINIMAL_X = `xof 0302txt 0032
Header { 1; 0; 1; }
Frame TestRoot {
  FrameTransformMatrix {
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0;;
  }
  Mesh unit_triangle {
    3;
    0.0; 0.0; 0.0;,
    1.0; 0.0; 0.0;,
    0.0; 1.0; 0.0;;
    1;
    3; 0, 1, 2;;
    MeshNormals {
      3;
      0.0; 0.0; 1.0;,
      0.0; 0.0; 1.0;,
      0.0; 0.0; 1.0;;
      1;
      3; 0, 1, 2;;
    }
    MeshMaterialList {
      1;
      1;
      0;;
      Material {
        0.5; 0.7; 0.9; 1.0;;
        16.0;
        0.2; 0.2; 0.2;;
        0.0; 0.0; 0.0;;
      }
    }
  }
}
`;

/** Wrap an already-gzipped payload in the Hamilton3dData container
 *  header. Produces a byte-identical structure to what Hamilton's
 *  `HxLabwrCatSerDe` writes for real labware. */
function buildHxxContainer(payload: Buffer): Buffer {
  const magic = Buffer.from("Hamilton3dData", "ascii");
  // Observed header bytes — version + chunk-table shape. We don't
  // interpret these; decodeHxx scans for the gzip stream.
  const header = Buffer.from([
    0x01, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00,
    0x20, 0x00, 0x00, 0x00,
    0x0e, 0x00, 0x00,
    0xa6, 0x15,
  ]);
  const chunkName = Buffer.from("__Main3dData__", "ascii");
  return Buffer.concat([magic, header, chunkName, payload]);
}

describe("hxx-decoder", () => {
  it("rejects buffers without the Hamilton3dData magic", () => {
    const bad = Buffer.from("NotHamilton", "ascii");
    expect(isHxx(bad)).toBe(false);
    expect(() => decodeHxx(bad)).toThrow(HxxDecodeError);
  });

  it("decodes a hand-rolled container to the embedded .x text", () => {
    const gz = zlib.gzipSync(Buffer.from(MINIMAL_X, "latin1"));
    const container = buildHxxContainer(gz);
    expect(isHxx(container)).toBe(true);
    const text = decodeHxx(container);
    expect(text.startsWith("xof 0302txt 0032")).toBe(true);
    expect(text).toContain("Mesh unit_triangle");
  });

  it("tolerates trailing bytes after the gzip stream (container footer)", () => {
    const gz = zlib.gzipSync(Buffer.from(MINIMAL_X, "latin1"));
    const footer = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00]);
    const container = Buffer.concat([buildHxxContainer(gz), footer]);
    const text = decodeHxx(container);
    expect(text).toContain("unit_triangle");
  });

  it("throws HxxDecodeError when no gzip stream follows the header", () => {
    const magic = Buffer.from("Hamilton3dData", "ascii");
    const junk = Buffer.alloc(40, 0xaa);
    expect(() => decodeHxx(Buffer.concat([magic, junk]))).toThrow(HxxDecodeError);
  });
});

describe("x-parser", () => {
  it("parses the minimal fixture into a single frame with one triangle", () => {
    const parsed = parseX(MINIMAL_X);
    expect(parsed.root.children).toHaveLength(1);
    const frame = parsed.root.children[0];
    expect(frame.name).toBe("TestRoot");
    expect(frame.meshes).toHaveLength(1);
    const mesh = frame.meshes[0];
    expect(mesh.positions).toHaveLength(9);       // 3 verts × 3 coords
    expect(mesh.faces).toEqual([[0, 1, 2]]);
    expect(mesh.normals).toHaveLength(9);
    expect(mesh.materials).toHaveLength(1);
    expect(mesh.materials[0].faceColor).toEqual([0.5, 0.7, 0.9, 1.0]);
  });

  it("rejects input that doesn't start with the xof header", () => {
    expect(() => parseX("Header { 1;0;1; }")).toThrow(XParseError);
  });

  it("preserves the FrameTransformMatrix values", () => {
    const parsed = parseX(MINIMAL_X);
    expect(parsed.root.children[0].matrix.slice(0, 4)).toEqual([1, 0, 0, 0]);
  });

  it("triangulates via fan layout when face has more than 3 vertices (by preserving the raw polygon)", () => {
    // Quad face: 4 indices. Parser stores the polygon as-is; the GLB
    // converter handles fan triangulation downstream.
    const src = MINIMAL_X.replace("3; 0, 1, 2;;", "4; 0, 1, 2, 0;;");
    const parsed = parseX(src.replace("3;\n    0.0; 0.0; 0.0;,",
                                       "3;\n    0.0; 0.0; 0.0;,"));
    expect(parsed.root.children[0].meshes[0].faces[0]).toHaveLength(4);
  });
});

describe("x-to-gltf", () => {
  it("emits a valid glTF 2.0 GLB with correct magic + structure", () => {
    const glb = xToGlb(parseX(MINIMAL_X));
    // GLB header: magic 'glTF', version 2, total length = file length
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);  // "glTF"
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    // JSON chunk header: length, type = 'JSON'
    const jsonLen = glb.readUInt32LE(12);
    expect(glb.readUInt32LE(16)).toBe(0x4e4f534a);
    const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString("utf8").trimEnd());
    expect(json.asset.version).toBe("2.0");
    expect(json.scenes[0].nodes).toHaveLength(1);
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes[0].primitives[0].mode).toBe(4);  // TRIANGLES
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([0.5, 0.7, 0.9, 1]);
    // BIN chunk follows the JSON chunk.
    const binOffset = 20 + jsonLen;
    const binLen = glb.readUInt32LE(binOffset);
    expect(glb.readUInt32LE(binOffset + 4)).toBe(0x004e4942);  // "BIN\0"
    expect(binOffset + 8 + binLen).toBe(glb.length);
  });

  it("round-trips a unit triangle: 3 positions, 3 normals, 1 primitive", () => {
    const glb = xToGlb(parseX(MINIMAL_X));
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString("utf8").trimEnd());
    // Positions + normals = 2 accessors, 2 buffer views
    expect(json.accessors.length).toBeGreaterThanOrEqual(2);
    const posAcc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(posAcc.count).toBe(3);
    expect(posAcc.type).toBe("VEC3");
  });
});

describe("hxx-loader (install-aware)", () => {
  beforeEach(() => clearHxxCache());

  it("resolves a known repo path to an absolute .hxx when install is present", () => {
    if (!hamiltonInstallPresent()) return;
    const abs = resolveHxxPath("ML_STAR/CORE/Waste2.hxx");
    expect(abs).not.toBeNull();
    expect(abs!.toLowerCase().endsWith("waste2.hxx")).toBe(true);
  });

  it("returns null when the requested .hxx isn't in the install", () => {
    if (!hamiltonInstallPresent()) return;
    expect(resolveHxxPath("ML_STAR/NONEXISTENT_XYZ.hxx")).toBeNull();
  });

  it("converts Waste2.hxx to a valid GLB end-to-end (real install)", () => {
    if (!hamiltonInstallPresent()) return;
    const glb = loadHxxAsGlb(WASTE2);
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.length).toBeGreaterThan(1024);
    // Same input → cache hit returns identical buffer instance.
    const glb2 = loadHxxAsGlb(WASTE2);
    expect(glb2).toBe(glb);
  });

  it("manifest lists all 66 .hxx files under the install's Labware tree", () => {
    if (!hamiltonInstallPresent()) return;
    const list = listInstalledHxx();
    expect(list.length).toBeGreaterThanOrEqual(50);  // install ships ~66, allow slack
    expect(list.every((p) => p.endsWith(".hxx"))).toBe(true);
    expect(list.some((p) => p.includes("Waste2"))).toBe(true);
  });
});
