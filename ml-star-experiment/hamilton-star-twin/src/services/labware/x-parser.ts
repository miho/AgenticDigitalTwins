/**
 * Minimal DirectX .x text-format parser — just enough to read
 * Hamilton's .hxx-wrapped meshes.
 *
 * The format is documented at
 * https://learn.microsoft.com/en-us/windows/win32/direct3d9/dx9-graphics-reference-x-file-format
 * but we only need the subset Hamilton actually writes:
 *
 *   - `xof 0302txt 0032` file header (version 3.2, text, float32)
 *   - top-level `Header` instance (ignored)
 *   - `template <Name> { <GUID> … }` declarations (ignored)
 *   - `Frame <name> { FrameTransformMatrix { … } <children> }`
 *   - `Mesh <name> { nVerts; v0;v1;…;; nFaces; f0;f1;…;; <attrs> }`
 *   - `MeshNormals`, `MeshMaterialList`, `Material`, `MeshTextureCoords`
 *     as attribute children of a `Mesh`
 *
 * Everything else (Animation, AnimationSet, SkinWeights, textures)
 * is skipped with balanced-brace counting.
 *
 * Numbers: the DirectX .x grammar says field values are separated by
 * `;` and array elements by `,`. In practice Hamilton writes
 * `x;y;z;,` for each Vector in an array and `;;` only on the last
 * element, but many .x producers are sloppy — this parser accepts
 * `;` and `,` interchangeably as value separators to keep things
 * robust.
 */

export interface XMaterial {
  faceColor: [number, number, number, number];
  power: number;
  specular: [number, number, number];
  emissive: [number, number, number];
}

export interface XMesh {
  name: string;
  /** Flattened xyz triples. `positions.length === nVerts * 3`. */
  positions: number[];
  /** Flattened xyz triples or undefined if the mesh has no normals. */
  normals?: number[];
  /** One entry per face — variable-length index array (triangle=3, quad=4, …). */
  faces: number[][];
  /** Per-normal, per-face indices if MeshNormals has an independent
   *  face-index table (common in Hamilton exports). */
  normalFaces?: number[][];
  /** Per-face material index into `materials`, or undefined if all
   *  faces use material 0. */
  faceMaterialIndex?: number[];
  materials: XMaterial[];
}

export interface XFrame {
  name: string;
  /** 4×4 transform stored in *column-major* order (glTF / three.js
   *  convention). Identity if the frame had no FrameTransformMatrix. */
  matrix: number[];
  children: XFrame[];
  meshes: XMesh[];
}

export interface ParsedX {
  root: XFrame;
}

export class XParseError extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Tiny tokenizer that skips whitespace, comments, and punctuation we don't care about. */
class Scanner {
  private i = 0;
  constructor(readonly s: string) {}

  /** Current position (for error messages). */
  pos(): number { return this.i; }

  eof(): boolean { return this.i >= this.s.length; }

  /** Advance over whitespace, comments, and value separators.
   *
   *  Treating `;` and `,` as trivia is a deliberate simplification.
   *  The DirectX .x spec uses `;` between struct fields and `,`
   *  between array elements — but every reader in this parser knows
   *  its expected value count up-front (nVertices, nFaces, the
   *  16 floats of a Matrix4x4, …). Once counts are known, the
   *  separators carry no information and eating them in one place
   *  is simpler + more robust than tracking them precisely. */
  private skipTrivia(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a || c === 0x3b /*;*/ || c === 0x2c /*,*/) {
        this.i++;
        continue;
      }
      if (c === 0x2f /*/*/ && this.s.charCodeAt(this.i + 1) === 0x2f) {
        while (this.i < this.s.length && this.s.charCodeAt(this.i) !== 0x0a) this.i++;
        continue;
      }
      if (c === 0x23 /*#*/) {
        while (this.i < this.s.length && this.s.charCodeAt(this.i) !== 0x0a) this.i++;
        continue;
      }
      break;
    }
  }

  /** Peek next non-trivia character (single char preview). */
  peekChar(): string {
    this.skipTrivia();
    return this.i < this.s.length ? this.s[this.i] : "";
  }

  /** Consume a specific literal character, throwing if not there. */
  expect(ch: string): void {
    this.skipTrivia();
    if (this.s[this.i] !== ch) {
      throw new XParseError(`Expected '${ch}' at offset ${this.i}, got ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
    }
    this.i++;
  }

  /** Consume one of `;` or `,` (used as value separators). */
  consumeSeparator(): void {
    this.skipTrivia();
    const c = this.s[this.i];
    if (c === ";" || c === ",") this.i++;
  }

  /** Consume identifier; throws if missing. */
  readIdent(): string {
    this.skipTrivia();
    const m = this.s.slice(this.i).match(IDENT);
    if (!m) {
      throw new XParseError(`Expected identifier at offset ${this.i}, got ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
    }
    this.i += m[0].length;
    return m[0];
  }

  /** Optional identifier (returns "" if next non-trivia isn't one). */
  tryReadIdent(): string {
    this.skipTrivia();
    const m = this.s.slice(this.i).match(IDENT);
    if (!m) return "";
    this.i += m[0].length;
    return m[0];
  }

  /** Read a number. Accepts integers and floats. Skips any leading
   *  `;` / `,` separators and consumes the trailing one. */
  readNumber(): number {
    this.skipTrivia();
    while (this.i < this.s.length && (this.s[this.i] === ";" || this.s[this.i] === ",")) {
      this.i++;
      this.skipTrivia();
    }
    const start = this.i;
    if (this.s[this.i] === "+" || this.s[this.i] === "-") this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if ((c >= "0" && c <= "9") || c === "." || c === "e" || c === "E" || c === "+" || c === "-") {
        this.i++;
      } else break;
    }
    if (this.i === start) {
      throw new XParseError(`Expected number at offset ${start}, got ${JSON.stringify(this.s.slice(start, start + 20))}`);
    }
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(n)) {
      throw new XParseError(`Not a finite number: ${this.s.slice(start, this.i)}`);
    }
    this.consumeSeparator();
    return n;
  }

  /** Skip a `<GUID>` block if present. */
  skipGuid(): void {
    this.skipTrivia();
    if (this.s[this.i] !== "<") return;
    this.i++;
    while (this.i < this.s.length && this.s[this.i] !== ">") this.i++;
    if (this.i < this.s.length) this.i++;  // consume '>'
  }

  /** Skip a balanced `{ … }` block, consuming the closing brace. */
  skipBlock(): void {
    this.expect("{");
    let depth = 1;
    while (depth > 0 && this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
  }
}

/** Parse the whole .x text into a frame tree. */
export function parseX(text: string): ParsedX {
  const sc = new Scanner(text);

  // File header line — e.g. `xof 0302txt 0032`. Must be the first
  // non-trivia token. We don't validate fields beyond the `xof`
  // magic — the decoder has already confirmed we're inside a
  // Hamilton3dData container.
  const magic = sc.tryReadIdent();
  if (magic !== "xof") {
    throw new XParseError(`Expected "xof" magic, got ${JSON.stringify(magic)}`);
  }
  // Skip the rest of the fixed-format header line (`xof 0302txt 0032`).
  // Advance to the next newline character — the skipTrivia() inside
  // subsequent reads will handle any trailing whitespace.
  while (!sc.eof() && sc.s.charCodeAt(sc.pos()) !== 0x0a) (sc as any).i++;

  const root: XFrame = { name: "root", matrix: identity(), children: [], meshes: [] };

  while (!sc.eof()) {
    sc.skipGuid();                            // no-op at top level
    const kw = sc.tryReadIdent();
    if (!kw) break;

    if (kw === "Header" || kw === "template") {
      // Skip: either an instance of Header or a template declaration.
      // template declarations start with an identifier *after* the
      // keyword (`template Name { … }`); Header instances go
      // directly into `{ … }`.
      if (kw === "template") sc.readIdent();
      sc.skipBlock();
      continue;
    }

    // Any top-level block we recognise becomes a child of the root
    // frame. Unknown ones are skipped.
    const parsed = parseTopLevelNode(sc, kw);
    if (parsed?.kind === "frame") root.children.push(parsed.frame);
    else if (parsed?.kind === "mesh") root.meshes.push(parsed.mesh);
    // Everything else (AnimationSet, etc.) was skipped inside
    // parseTopLevelNode → skipBlock.
  }

  return { root };
}

type NodeResult =
  | { kind: "frame"; frame: XFrame }
  | { kind: "mesh"; mesh: XMesh }
  | { kind: "skip" };

function parseTopLevelNode(sc: Scanner, kw: string): NodeResult | undefined {
  // Optional instance name before `{`.
  const name = sc.tryReadIdent();

  if (kw === "Frame") {
    return { kind: "frame", frame: parseFrameBody(sc, name || "") };
  }
  if (kw === "Mesh") {
    return { kind: "mesh", mesh: parseMeshBody(sc, name || "") };
  }
  // Unknown top-level block — skip it (AnimationSet, Animation, etc.)
  sc.skipBlock();
  return { kind: "skip" };
}

function parseFrameBody(sc: Scanner, name: string): XFrame {
  sc.expect("{");
  const frame: XFrame = { name, matrix: identity(), children: [], meshes: [] };

  while (true) {
    const next = sc.peekChar();
    if (next === "}") { (sc as any).i++; break; }
    sc.skipGuid();
    const child = sc.tryReadIdent();
    if (!child) {
      throw new XParseError(`Expected identifier or '}' inside Frame ${name} at offset ${sc.pos()}`);
    }
    if (child === "FrameTransformMatrix") {
      frame.matrix = parseFrameTransform(sc);
      continue;
    }
    if (child === "Frame") {
      const childName = sc.tryReadIdent();
      frame.children.push(parseFrameBody(sc, childName || ""));
      continue;
    }
    if (child === "Mesh") {
      const childName = sc.tryReadIdent();
      frame.meshes.push(parseMeshBody(sc, childName || ""));
      continue;
    }
    // Unknown node inside a frame — skip (could be a referenced
    // template Instance the .x format allows).
    sc.tryReadIdent();  // optional name
    sc.skipBlock();
  }
  return frame;
}

function parseFrameTransform(sc: Scanner): number[] {
  sc.expect("{");
  // `Matrix4x4 frameMatrix` — but the data is written inline as an
  // array of 16 floats, separated by `,` and terminated by `;;`.
  const m: number[] = [];
  while (m.length < 16) m.push(sc.readNumber());
  // Skip until closing brace.
  while (sc.peekChar() !== "}") (sc as any).i++;
  sc.expect("}");
  return m;
}

function parseMeshBody(sc: Scanner, name: string): XMesh {
  sc.expect("{");
  const mesh: XMesh = { name, positions: [], faces: [], materials: [] };

  // nVertices
  const nVerts = Math.floor(sc.readNumber());
  for (let i = 0; i < nVerts; i++) {
    mesh.positions.push(sc.readNumber(), sc.readNumber(), sc.readNumber());
  }
  // nFaces
  const nFaces = Math.floor(sc.readNumber());
  for (let i = 0; i < nFaces; i++) {
    const nIdx = Math.floor(sc.readNumber());
    const face: number[] = [];
    for (let k = 0; k < nIdx; k++) face.push(Math.floor(sc.readNumber()));
    mesh.faces.push(face);
  }

  // Child attribute blocks.
  while (true) {
    const next = sc.peekChar();
    if (next === "}") { (sc as any).i++; break; }
    sc.skipGuid();
    const attr = sc.tryReadIdent();
    if (!attr) {
      throw new XParseError(`Expected attribute identifier inside Mesh ${name} at offset ${sc.pos()}`);
    }
    if (attr === "MeshNormals") {
      sc.tryReadIdent();  // optional name
      parseMeshNormals(sc, mesh);
      continue;
    }
    if (attr === "MeshMaterialList") {
      sc.tryReadIdent();
      parseMeshMaterialList(sc, mesh);
      continue;
    }
    if (attr === "MeshTextureCoords") {
      sc.tryReadIdent();
      sc.skipBlock();  // texture coords aren't used in the twin's 3D view yet
      continue;
    }
    // Unknown attribute — skip.
    sc.tryReadIdent();
    sc.skipBlock();
  }

  return mesh;
}

function parseMeshNormals(sc: Scanner, mesh: XMesh): void {
  sc.expect("{");
  const nNormals = Math.floor(sc.readNumber());
  const normals: number[] = [];
  for (let i = 0; i < nNormals; i++) {
    normals.push(sc.readNumber(), sc.readNumber(), sc.readNumber());
  }
  mesh.normals = normals;

  const nFaceNormals = Math.floor(sc.readNumber());
  const normalFaces: number[][] = [];
  for (let i = 0; i < nFaceNormals; i++) {
    const nIdx = Math.floor(sc.readNumber());
    const face: number[] = [];
    for (let k = 0; k < nIdx; k++) face.push(Math.floor(sc.readNumber()));
    normalFaces.push(face);
  }
  mesh.normalFaces = normalFaces;
  while (sc.peekChar() !== "}") (sc as any).i++;
  sc.expect("}");
}

function parseMeshMaterialList(sc: Scanner, mesh: XMesh): void {
  sc.expect("{");
  const nMaterials = Math.floor(sc.readNumber());
  const nFaceIndexes = Math.floor(sc.readNumber());
  const faceMaterialIndex: number[] = [];
  for (let i = 0; i < nFaceIndexes; i++) faceMaterialIndex.push(Math.floor(sc.readNumber()));
  mesh.faceMaterialIndex = faceMaterialIndex;

  for (let m = 0; m < nMaterials; m++) {
    sc.skipGuid();
    const kw = sc.tryReadIdent();
    if (kw !== "Material") {
      // Reference to a previously-declared material (by name) — skip.
      continue;
    }
    sc.tryReadIdent();  // optional material name
    mesh.materials.push(parseMaterialBody(sc));
  }
  while (sc.peekChar() !== "}") (sc as any).i++;
  sc.expect("}");
}

function parseMaterialBody(sc: Scanner): XMaterial {
  sc.expect("{");
  // Material layout: ColorRGBA faceColor; FLOAT power; ColorRGB specularColor; ColorRGB emissiveColor;
  const faceColor: [number, number, number, number] = [
    sc.readNumber(), sc.readNumber(), sc.readNumber(), sc.readNumber(),
  ];
  const power = sc.readNumber();
  const specular: [number, number, number] = [sc.readNumber(), sc.readNumber(), sc.readNumber()];
  const emissive: [number, number, number] = [sc.readNumber(), sc.readNumber(), sc.readNumber()];
  // There may be trailing children (TextureFilename, etc.) — skip
  // to the closing brace.
  while (sc.peekChar() !== "}") {
    const k = sc.tryReadIdent();
    if (!k) { (sc as any).i++; continue; }
    sc.tryReadIdent();  // optional name
    sc.skipBlock();
  }
  sc.expect("}");
  return { faceColor, power, specular, emissive };
}

function identity(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}
