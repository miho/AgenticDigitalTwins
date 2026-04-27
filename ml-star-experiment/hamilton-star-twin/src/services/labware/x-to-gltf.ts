/**
 * Convert parsed DirectX .x meshes (from x-parser) into a glTF 2.0
 * binary (GLB) the renderer can load via three.js GLTFLoader.
 *
 * Design notes:
 *
 *   - The frame hierarchy is preserved: every XFrame becomes a glTF
 *     node with its FrameTransformMatrix, and each XMesh on a frame
 *     becomes a glTF mesh attached to that node.
 *
 *   - Attribute indexing: DirectX allows independent indices for
 *     positions vs normals (MeshNormals has its own faceNormals
 *     table). glTF requires all attributes to share one vertex
 *     index buffer. We un-index into a flat triangle soup — for a
 *     quad with 4 positions + 4 normals we emit 6 vertices per
 *     triangle after fan triangulation. Hamilton meshes are small
 *     (< 12k source verts, mostly < 1k) so the blow-up is harmless.
 *
 *   - Multi-material meshes: DirectX's `MeshMaterialList` has a
 *     per-face material index. We split such meshes into one
 *     glTF primitive per material, which three.js renders as
 *     separate draw calls with the right colour each.
 *
 *   - The output is glTF 2.0 GLB — a JSON chunk + a single binary
 *     chunk. One buffer per glTF file; every accessor points into
 *     that buffer. No textures, no skinning, no animation (none of
 *     which Hamilton's .hxx labware uses).
 */

import type { ParsedX, XFrame, XMesh, XMaterial } from "./x-parser";

/**
 * DirectX `.x` stores a 4×4 matrix row-major with the translation
 * components in the LAST ROW (because transformations are applied as
 * row-vector × matrix, `v' = v × M`). glTF stores a 4×4 matrix
 * column-major with the translation components in the LAST COLUMN
 * (because transformations are applied as matrix × column-vector,
 * `v' = M × v`). Converting the same linear transformation between
 * the two representations requires transposing the 2D matrix — but
 * once flattened, both representations end up with the SAME 16-float
 * array (the DirectX last-row translation lands at indices 12..15,
 * which is exactly where the glTF last-column translation also
 * lives). So no array reshuffle is needed; the bytes round-trip.
 *
 * The previous version here ran a genuine transpose on the linear
 * array, which ended up putting the translations at indices 3, 7, 11
 * (the w-row of the column-major layout). three.js then dropped them
 * as perspective terms and the mesh rendered without its authored
 * deck-relative offset — Waste2 floated ~90 mm above its rim, etc.
 */
function passthroughMatrix(m: number[]): number[] {
  return m.slice();
}

interface PrimitiveData {
  positions: Float32Array;   // 3 floats per vertex, soup (3 verts per triangle)
  normals: Float32Array;     // 3 floats per vertex
  materialIndex: number;     // index into glTF materials[]
}

/** Lower one Hamilton mesh to one or more glTF primitives (grouped by material). */
function meshToPrimitives(mesh: XMesh, materialBaseIndex: number): PrimitiveData[] {
  const triangles: { pos: number[]; norm: number[]; mat: number }[] = [];

  // Fan-triangulate each face and pair positions with normals at
  // matching fan slices. Both position-face and normal-face use the
  // same [a, b[k], b[k+1]] split so the indices stay consistent.
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const face = mesh.faces[fi];
    const normFace = mesh.normalFaces?.[fi];
    const mat = mesh.faceMaterialIndex?.[fi] ?? 0;
    for (let k = 1; k < face.length - 1; k++) {
      triangles.push({
        pos: [face[0], face[k], face[k + 1]],
        norm: normFace ? [normFace[0], normFace[k], normFace[k + 1]] : [face[0], face[k], face[k + 1]],
        mat,
      });
    }
  }

  // Group by material.
  const byMat = new Map<number, typeof triangles>();
  for (const t of triangles) {
    const bucket = byMat.get(t.mat) ?? [];
    bucket.push(t);
    byMat.set(t.mat, bucket);
  }

  const prims: PrimitiveData[] = [];
  for (const [mat, tris] of byMat) {
    const positions = new Float32Array(tris.length * 9);
    const normals = new Float32Array(tris.length * 9);
    let p = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const pi = t.pos[k] * 3;
        positions[p] = mesh.positions[pi];
        positions[p + 1] = mesh.positions[pi + 1];
        positions[p + 2] = mesh.positions[pi + 2];
        const ni = t.norm[k] * 3;
        if (mesh.normals) {
          normals[p] = mesh.normals[ni] ?? 0;
          normals[p + 1] = mesh.normals[ni + 1] ?? 0;
          normals[p + 2] = mesh.normals[ni + 2] ?? 1;
        } else {
          // Will be overwritten by flat-shade pass below.
          normals[p] = 0;
          normals[p + 1] = 0;
          normals[p + 2] = 1;
        }
        p += 3;
      }
      if (!mesh.normals) {
        // Compute flat face normal.
        const ax = positions[p - 9], ay = positions[p - 8], az = positions[p - 7];
        const bx = positions[p - 6], by = positions[p - 5], bz = positions[p - 4];
        const cx = positions[p - 3], cy = positions[p - 2], cz = positions[p - 1];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (let k = 0; k < 3; k++) {
          normals[p - 9 + k * 3] = nx;
          normals[p - 9 + k * 3 + 1] = ny;
          normals[p - 9 + k * 3 + 2] = nz;
        }
      }
    }
    prims.push({ positions, normals, materialIndex: materialBaseIndex + mat });
  }
  return prims;
}

function materialToGltf(m: XMaterial): any {
  const [r, g, b, a] = m.faceColor;
  return {
    pbrMetallicRoughness: {
      baseColorFactor: [r, g, b, a],
      metallicFactor: 0,
      // Spec says `power` is specular exponent; map loosely to roughness.
      // High power (shiny) → low roughness.
      roughnessFactor: Math.max(0.05, Math.min(1, 1 - Math.log10(1 + m.power) / 3)),
    },
    emissiveFactor: m.emissive,
    doubleSided: true,
  };
}

/**
 * Build a glTF 2.0 GLB buffer from a parsed .x.
 *
 * The output is a single Buffer containing:
 *   - 12-byte GLB header
 *   - JSON chunk (structure: scene, nodes, meshes, materials, accessors, bufferViews)
 *   - BIN chunk (all attribute data concatenated)
 */
export function xToGlb(parsed: ParsedX): Buffer {
  const gltf: any = {
    asset: { version: "2.0", generator: "hamilton-star-twin/x-to-gltf" },
    scene: 0,
    scenes: [{ nodes: [] as number[] }],
    nodes: [] as any[],
    meshes: [] as any[],
    materials: [] as any[],
    buffers: [{ byteLength: 0 }],
    bufferViews: [] as any[],
    accessors: [] as any[],
  };

  const binChunks: Buffer[] = [];
  let binOffset = 0;
  function addBufferView(data: Float32Array | Uint32Array, target?: number): number {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    // glTF requires 4-byte alignment between buffer views.
    const pad = (4 - (binOffset % 4)) % 4;
    if (pad > 0) {
      binChunks.push(Buffer.alloc(pad));
      binOffset += pad;
    }
    binChunks.push(bytes);
    const view = { buffer: 0, byteOffset: binOffset, byteLength: bytes.byteLength, ...(target !== undefined ? { target } : {}) };
    binOffset += bytes.byteLength;
    gltf.bufferViews.push(view);
    return gltf.bufferViews.length - 1;
  }
  function addFloat32Accessor(data: Float32Array, type: "VEC3"): number {
    const viewIdx = addBufferView(data, 34962 /* ARRAY_BUFFER */);
    const count = data.length / 3;
    let min: number[] | undefined;
    let max: number[] | undefined;
    if (count > 0) {
      min = [Infinity, Infinity, Infinity];
      max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < 3; k++) {
          const v = data[i * 3 + k];
          if (v < min![k]) min![k] = v;
          if (v > max![k]) max![k] = v;
        }
      }
    }
    gltf.accessors.push({ bufferView: viewIdx, componentType: 5126 /* FLOAT */, count, type, ...(min ? { min, max } : {}) });
    return gltf.accessors.length - 1;
  }

  // Walk frames → nodes + meshes.
  function emitFrame(frame: XFrame): number {
    const node: any = { name: frame.name || undefined };
    // DirectX row-major ↔ glTF column-major round-trips as the same
    // 16-float array — see `passthroughMatrix`.
    if (!isIdentity(frame.matrix)) node.matrix = passthroughMatrix(frame.matrix);

    // Emit meshes attached to this frame.
    if (frame.meshes.length > 0) {
      // glTF node has a single `mesh` field; if we have multiple
      // Hamilton meshes on one frame we wrap them each in an
      // intermediate child node with its own mesh.
      if (frame.meshes.length === 1) {
        node.mesh = emitMesh(frame.meshes[0]);
      } else {
        node.children = node.children ?? [];
        for (const m of frame.meshes) {
          const child: any = { mesh: emitMesh(m) };
          gltf.nodes.push(child);
          node.children.push(gltf.nodes.length - 1);
        }
      }
    }

    // Recurse into child frames.
    for (const c of frame.children) {
      const ci = emitFrame(c);
      node.children = node.children ?? [];
      node.children.push(ci);
    }

    gltf.nodes.push(node);
    return gltf.nodes.length - 1;
  }

  function emitMesh(mesh: XMesh): number {
    const matBase = gltf.materials.length;
    if (mesh.materials.length === 0) {
      // Default grey material.
      gltf.materials.push(materialToGltf({
        faceColor: [0.6, 0.6, 0.6, 1], power: 1, specular: [0.2, 0.2, 0.2], emissive: [0, 0, 0],
      }));
    } else {
      for (const m of mesh.materials) gltf.materials.push(materialToGltf(m));
    }

    const prims = meshToPrimitives(mesh, matBase);
    const primitives = prims.map((p) => ({
      attributes: {
        POSITION: addFloat32Accessor(p.positions, "VEC3"),
        NORMAL: addFloat32Accessor(p.normals, "VEC3"),
      },
      material: p.materialIndex,
      mode: 4 /* TRIANGLES */,
    }));
    gltf.meshes.push({ name: mesh.name || undefined, primitives });
    return gltf.meshes.length - 1;
  }

  // The parsed root frame is an artificial container; emit each of
  // its children as a top-level scene node.
  for (const c of parsed.root.children) {
    const ni = emitFrame(c);
    gltf.scenes[0].nodes.push(ni);
  }
  // If root had direct meshes (rare for Hamilton), attach them too.
  if (parsed.root.meshes.length > 0) {
    const wrap: any = {};
    wrap.children = parsed.root.meshes.map((m) => {
      const child = { mesh: emitMesh(m) };
      gltf.nodes.push(child);
      return gltf.nodes.length - 1;
    });
    gltf.nodes.push(wrap);
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }

  const binBody = Buffer.concat(binChunks);
  gltf.buffers[0].byteLength = binBody.byteLength;

  const jsonText = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonText, "utf8");
  const jsonPad = (4 - (jsonBuf.byteLength % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);  // pad with spaces
  const binPad = (4 - (binBody.byteLength % 4)) % 4;
  const binChunk = Buffer.concat([binBody, Buffer.alloc(binPad, 0)]);

  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
  const out = Buffer.alloc(totalLength);
  // GLB header
  out.write("glTF", 0, "ascii");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  // JSON chunk
  out.writeUInt32LE(jsonChunk.byteLength, 12);
  out.writeUInt32LE(0x4e4f534a, 16);  // "JSON"
  jsonChunk.copy(out, 20);
  // BIN chunk
  const binChunkOffset = 20 + jsonChunk.byteLength;
  out.writeUInt32LE(binChunk.byteLength, binChunkOffset);
  out.writeUInt32LE(0x004e4942, binChunkOffset + 4);  // "BIN\0"
  binChunk.copy(out, binChunkOffset + 8);
  return out;
}

function isIdentity(m: number[]): boolean {
  for (let i = 0; i < 16; i++) {
    const expected = (i % 5 === 0) ? 1 : 0;
    if (Math.abs(m[i] - expected) > 1e-9) return false;
  }
  return true;
}
