/**
 * STAR Twin — 3D view (scout).
 *
 * Self-contained browser ES module. Loads the VENUS chassis glTF, renders
 * placeholder arms/heads/iSWAP/autoload, subscribes to the twin's live
 * state stream (/api/state bootstrap + /events SSE motion envelopes), and
 * interpolates arm trajectories smoothly during the travel.
 *
 * Coordinate convention
 *   Twin native: 0.1 mm units. Axes: X = along deck (long axis), Y = deck
 *   depth (front-back), Z = vertical (up).
 *
 *   Scene (three.js Y-up): chassis loaded from Pixyz-exported glTF which is
 *   already Y-up with X = long axis and Z = depth. So the mapping is
 *     scene.x = twinX / 10
 *     scene.y = twinZ / 10      (vertical)
 *     scene.z = twinY / 10      (depth)
 *
 *   The chassis glTF origin does not perfectly coincide with the twin's
 *   mechanical origin. The scout leaves both at their native origins so
 *   it's visually obvious if the offset matters; calibration is a later
 *   task.
 */

import * as THREE from 'three';
import { OrbitControls }      from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }         from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment }    from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ---------------------------------------------------------------- constants
const CHANNEL_COUNT = 8;
const CHANNEL_PITCH_MM = 9;            // physical PIP pitch, fixed

// Approximate geometry for placeholder arms — refined later against CAD.
const GANTRY_RAIL_Y_MM   = 550;        // gantry rail depth (back of deck)
// Arm bar Y (scene mm above deck). Chosen so the pin top roughly
// meets the head bottom when channels are fully retracted (pos_z near
// the z_max ≈ 250 mm ceiling) — pin-top world Y = pos_z + pin + tip ≈
// 250 + 60 + 95 = 405 with tips fitted. 420 gives ~15 mm overlap
// between pin and head body at max retract; at lower pos_z the pin
// visually extends out the head bottom, matching what a channel nozzle
// looks like on a real STAR.
//
// Hamilton convention (bigger pos_z = higher in world Y) means the
// visual mapping is direct: tip end world Y = pos_z / 10. Dropping
// below deck level (world Y < 0) would indicate a crash, which the
// simulateLLD code path in pip-physics flags separately.
const GANTRY_TOP_Y_MM    = 420;
                                       // Twin Z increases as head descends: at Z=1500 (150mm into
                                       // well) the arm sits at scene Y = 240 - 150 = 90 mm.
const PIP_CARRIAGE_W_MM  = 140;        // X-carriage box width
const PIP_CARRIAGE_H_MM  = 40;
const PIP_CARRIAGE_D_MM  = 40;
const CHANNEL_DIAMETER_MM = 5;
const CHANNEL_TIP_LEN_MM  = 60;        // shown as a cylinder below the head

const ISWAP_W_MM  = 90;
const ISWAP_H_MM  = 30;
const ISWAP_D_MM  = 50;

const H96_W_MM  = 140;
const H96_D_MM  = 100;
const H96_H_MM  = 50;
const H384_W_MM = 160;
const H384_D_MM = 120;
const H384_H_MM = 50;

// ---------------------------------------------------------------- DOM refs
const $ = (id) => document.getElementById(id);
const connEl = $('conn');
const connText = $('connText');
const modelSel = $('modelSel');

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x181a20);

// Operator-view root: `scale.z = -1` negates the Y-depth mapping so the
// camera can sit on the POSITIVE-Z side (where three.js camera math
// gives `camera.right = +X_world`) and still have the deck front edge
// closest to the viewer. Result: track 1 on the LEFT, track 54 on the
// RIGHT, deck front at the BOTTOM of the screen, rear at the TOP —
// matching VENUS's 2D view and operator expectation.
// DoubleSide shading compensates for the scale-flipped face winding.
const sceneRoot = new THREE.Group();
sceneRoot.scale.z = -1;
scene.add(sceneRoot);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1, 20000);
// Camera sits BEHIND the negated-Z mapping (positive Z in world) so
// camera.right comes out as +X_world and the deck reads left-to-right
// in natural operator orientation.
camera.position.set(607, 700, 900);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
// Orbit around the deck centre. Note `scale.z = -1` on sceneRoot means
// scene objects at twin Y=311 render at world Z=-311, so the target's
// Z is negated here to look at the deck centre in world space.
// Wide distance range so the user can both zoom in on a single tip
// rack (50 mm) and pull back to see the whole chassis at once (15 m)
// without hitting a hard limit that feels like "the zoom is stuck".
controls.target.set(607, 50, -311);
controls.minDistance = 60;
controls.maxDistance = 15000;
controls.zoomSpeed = 0.9;
controls.panSpeed = 0.9;
controls.rotateSpeed = 0.85;
controls.screenSpacePanning = true;
controls.update();
camera.lookAt(controls.target);

// Image-based lighting — PMREM of the built-in RoomEnvironment. Gives
// the PBR materials something coherent to reflect so the deck reads as
// one scene, not a collection of flat-shaded boxes.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
keyLight.position.set(800, 2000, 1200);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 500;
keyLight.shadow.camera.far = 5000;
keyLight.shadow.camera.left = -1500;
keyLight.shadow.camera.right = 1500;
keyLight.shadow.camera.top = 1500;
keyLight.shadow.camera.bottom = -1500;
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffeedd, 0.35);
fillLight.position.set(-1500, 800, -600);
scene.add(fillLight);

// Ground plane sits below the chassis (bottom ≈ Y=-247 after offset),
// not at the deck surface. Otherwise the grid cuts through the chassis
// body and the contact shadows land on top of labware instead of under it.
const GROUND_Y = -260;
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(8000, 8000),
  new THREE.ShadowMaterial({ opacity: 0.28 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = GROUND_Y;
ground.receiveShadow = true;
sceneRoot.add(ground);

const grid = new THREE.GridHelper(3000, 60, 0x3b3e4a, 0x222633);
grid.position.y = GROUND_Y + 0.5;
sceneRoot.add(grid);
const axes = new THREE.AxesHelper(300);
sceneRoot.add(axes);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- chassis
// Chassis sits under a pivot group so its origin can be shifted to line
// up with the twin's mechanical origin (track 1 left edge, Y front, Z
// deck surface). The pivot offset is tuned visually using rendered
// carriers at known coords as reference.
const loader = new GLTFLoader();
const chassisPivot = new THREE.Group();
sceneRoot.add(chassisPivot);
let chassisRoot = null;

/**
 * Chassis alignment. Verified bbox from the Pixyz-exported glTF:
 *   X: -522 .. +1136  (center 307, size 1658)
 *   Y: -152 .. +103   (center -24,  size 255)  — Y is vertical
 *   Z: -645 .. +357   (center -144, size 1001) — Z is depth
 *
 * Transform chain (see `loadChassis`):
 *   chassisPivot.scale.z = -1   (cancels sceneRoot.scale.z = -1 for this subtree)
 *   chassisPivot.position = CHASSIS_OFFSET
 *   sceneRoot.scale.z = -1      (operator view — applied to all children)
 *
 * Net effect: world_pos = (x_native + ox, y_native + oy, z_native - oz)
 *   — X preserved, Y preserved, Z offset by `oz` with native-Z direction
 *     preserved (chassis front stays at front after the scene-level Z flip).
 *
 * The old approach used `chassisPivot.rotation.y = PI` which also flipped X,
 * making the chassis X direction run opposite the deck. That's why the
 * carrier/head "position completely off" — the chassis was mirrored in X.
 *
 * Targets:
 *   ox = 300   → chassis native X=307 center lands at scene X≈607 (deck X center)
 *   oy = -103  → chassis bbox top (native Y=+103) lands at scene Y=0 (deck surface)
 *   oz = 167   → chassis Z center aligns with deck yCenter (world Z≈-311)
 */
// oy lifts the chassis so its rendered deck surface lines up with the
// carrier TOPs (Y = CARRIER_THICKNESS_MM = 90), not with carrier bottoms.
// At the previous value (-103) the chassis top sat at scene Y=0 and every
// 90 mm-tall carrier box stuck up above it — carriers read as "bricks
// floating on the deck" instead of "slotted in". Raised by 90 mm so the
// chassis top now coincides with the carrier top plane; carrier bodies
// and labware anchor points unchanged, but the chassis visually
// envelopes the carrier stack.
const CHASSIS_OFFSET = { x: 300, y: -13, z: 167 };

function disposeTree(obj) {
  obj.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) {
      const ms = Array.isArray(n.material) ? n.material : [n.material];
      ms.forEach((m) => m.dispose());
    }
  });
}

function loadChassis(name) {
  if (chassisRoot) { chassisPivot.remove(chassisRoot); disposeTree(chassisRoot); chassisRoot = null; }
  loader.load(`./3d/models/${name}.gltf`, (gltf) => {
    const root = gltf.scene;
    // Pixyz exports unlit "Color #rrggbbaa" materials — upgrade to a lit
    // standard material so the chassis actually takes lighting + reflects
    // the PMREM environment.
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m, i) => {
        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return;
        const color = m.color ? m.color.clone() : new THREE.Color(0xcccccc);
        const upgraded = new THREE.MeshStandardMaterial({
          color, metalness: 0.25, roughness: 0.55, envMapIntensity: 0.9,
          side: THREE.DoubleSide,   // sceneRoot.scale.x = -1 flips faces
        });
        if (Array.isArray(o.material)) o.material[i] = upgraded;
        else o.material = upgraded;
      });
    });
    chassisRoot = root;
    chassisPivot.add(root);
    chassisPivot.position.set(CHASSIS_OFFSET.x, CHASSIS_OFFSET.y, CHASSIS_OFFSET.z);
    // The Pixyz-exported chassis glTF has front rail at native +Z. Applying
    // `scale.z = -1` here cancels the outer sceneRoot Z-flip FOR THIS SUBTREE
    // ONLY, so the chassis front rail renders at the front of the scene
    // while the deck layer (carriers, labware) still benefits from the
    // operator-view Z flip. Unlike `rotation.y = PI`, this preserves X
    // direction — essential so the chassis X grid matches track pitch on
    // the deck layer.
    chassisPivot.scale.z = -1;
    chassisPivot.rotation.y = 0;
    applyWireframe();
  }, undefined, (err) => {
    console.error('chassis load failed', err);
  });
}

// ---------------------------------------------------------------- deck layer
// Carriers + labware driven from state.deck. Scene Y=0 is the deck surface:
// carriers sit with their top face at Y=0, labware stacks above.
const deckLayer = new THREE.Group();
sceneRoot.add(deckLayer);

// Y_FRONT/REAR base-Y for the positionBaseY computation (mirrors deck.ts).
const POS_Y_FRONT_01MM = 630;
const POS_Y_REAR_01MM  = 4530;

// Per-color material cache. Materials reused across labware cut draw calls
// a lot when a tip carrier puts 5 identical racks down.
function makeMatCache() {
  const cache = new Map();
  return (color, opts = {}) => {
    const key = color + '|' + JSON.stringify(opts);
    let m = cache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        color,
        metalness: opts.metalness ?? 0.0,
        roughness: opts.roughness ?? 0.45,
        clearcoat: opts.clearcoat ?? 0.35,
        clearcoatRoughness: opts.clearcoatRoughness ?? 0.2,
        envMapIntensity: opts.envMapIntensity ?? 0.85,
        transparent: opts.opacity != null && opts.opacity < 1,
        opacity: opts.opacity ?? 1,
        // DoubleSide compensates for the `sceneRoot.scale.x = -1` flip:
        // negative-scale reverses face winding so the front-face would
        // disappear otherwise.
        side: THREE.DoubleSide,
      });
      cache.set(key, m);
    }
    return m;
  };
}
const mat = makeMatCache();

// Calm Hamilton-ish palette — reference images (VENUS Run Control,
// product photos) are mostly greys + off-whites, not saturated primaries.
const PALETTE = {
  carrierBody:  0x2e333c,
  carrierRail:  0x1a1d24,
  tipRackBody:  0x4c5159,
  tipTop:       0x17191e,           // dark grey/black tip tops
  tip300Top:    0x5d6877,
  plateBody:    0xe4e6ea,           // off-white polystyrene
  plateWell:    0x2b2f38,           // dark cavity
  tubeRackBody: 0x253140,
  tube:         0x0e2140,
  trough:       0x6f7680,
  wash:         0x7b8592,
  waste:        0x4a4d54,
  fallback:     0xa8adb5,
};

// A standard ML_STAR carrier is ~90 mm tall — the full frame that slots
// into the deck rail teeth. Using 8 mm before made labware sit 80 mm too
// low, which stacked wrong against the ZTrans heights from the .lay.
const CARRIER_THICKNESS_MM = 90;

function disposeDeckLayer() {
  // Do NOT call disposeTree on the children — our `mat` and
  // `roundedBox` caches share materials/geometries across meshes, so
  // disposing would invalidate still-in-use resources on subsequent
  // rebuilds. The native JS GC + the bounded cache sizes keep us safe.
  // Just unlink from the scene graph.
  while (deckLayer.children.length > 0) {
    deckLayer.remove(deckLayer.children[0]);
  }
}

// Cheap helpers — reuse a canonical RoundedBoxGeometry per (w,h,d,r).
const roundedBoxCache = new Map();
function roundedBox(w, h, d, r = 1.5) {
  const key = `${Math.round(w)}|${Math.round(h)}|${Math.round(d)}|${r}`;
  let g = roundedBoxCache.get(key);
  if (!g) { g = new RoundedBoxGeometry(w, h, d, 2, r); roundedBoxCache.set(key, g); }
  return g;
}

/** Classify labware by type so we can pick the right geometry + colors. */
function classify(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('waste') || t.includes('wasteblock')) return 'waste';
  if (t.includes('wash')) return 'wash';
  if (t.includes('trough') || t.includes('reservoir') || t.includes('reagent')) return 'trough';
  if (t.includes('tip') || t.startsWith('tips_')) return 'tips';
  if (t.includes('smp_car') || t.includes('sample')) return 'tubes';
  if (t.includes('plate') || t.includes('cos_') || t.includes('nun_') || t.includes('nunc_')) return 'plate';
  return 'generic';
}

/**
 * Place well instances in a grid above the plate body.
 * kind=wells  → cylinder depressions (plates)
 * kind=tips   → tall slim cylinders rising above the body (tip racks)
 * kind=tubes  → stout cylinders (tube racks)
 */
function addWells(parent, { rows, cols, pitch, rackDx, rackDy, a1Px, a1Py,
                             bodyH, wellRadius, wellDepth, wellMat, kind,
                             usedSlots }) {
  if (rows < 1 || cols < 1) return;
  // Count used slots so we only allocate instances for occupied wells.
  // For tip racks: `usedSlots` is a Set of wellIndex (= row * cols + col)
  // whose tip has been picked up — we DON'T draw those. For plates and
  // tube racks we pass undefined → draw every position.
  const skip = (wellIndex) => usedSlots && usedSlots.has(wellIndex);
  const total = rows * cols;
  let occupied = 0;
  for (let i = 0; i < total; i++) if (!skip(i)) occupied++;
  if (occupied === 0) return;

  const geom = new THREE.CylinderGeometry(wellRadius, wellRadius, wellDepth, 16);
  const inst = new THREE.InstancedMesh(geom, wellMat, occupied);
  // Shadows: only the RISING-ABOVE features (tips, tubes, collars) cast
  // shadow. The recessed ones (wells, hole_markers) are inside the
  // labware and don't need to self-shadow.
  inst.castShadow = (kind === 'tips' || kind === 'tubes' || kind === 'collar');
  inst.receiveShadow = true;
  const m = new THREE.Matrix4();
  // Y offset of each instance in the body's LOCAL frame. RoundedBoxGeometry
  // is centered on its origin, so the body occupies local Y ∈ [-bodyH/2, +bodyH/2].
  // The rack top is at local Y = +bodyH/2 (NOT bodyH — using bodyH put markers
  // floating half-bodyH above the rack, a.k.a. the "hover" bug in Image 13).
  //   wells         — recess inside a plate, sunken a tiny bit below top
  //   hole_marker   — dark disk sitting JUST above rack top (fakes a drilled hole)
  //   collar        — visible 11.5 mm tip top protruding above rack top
  //   tips (legacy) — tall cylinders above (still used for tube racks)
  //   tubes         — cylinders rising above the rack body
  //
  // `Z_EPS` keeps instance surfaces off the rack/plate top face so nothing is
  // coplanar — without it the depth buffer can't separate two surfaces at the
  // same Y, producing a speckled moiré pattern at typical camera distances.
  // 0.3 mm is below visual discrimination on a full-deck view but well beyond
  // depth-buffer precision with far=20000 mm.
  const topY = bodyH / 2;
  const Z_EPS = 0.3;
  const yFromKind =
    kind === 'wells'        ? (topY - wellDepth / 2 - Z_EPS) :
    kind === 'hole_marker'  ? (topY + wellDepth / 2 + Z_EPS) :
    kind === 'collar'       ? (topY + wellDepth / 2 + Z_EPS) :
    kind === 'tips'         ? (topY + wellDepth / 2 + Z_EPS) :
                              (topY + wellDepth / 2 - 1);
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wellIdx = r * cols + c;
      if (skip(wellIdx)) continue;
      const x = a1Px + c * pitch;
      const z = a1Py - r * pitch;
      m.makeTranslation(x - parent.position.x, yFromKind, z - parent.position.z);
      inst.setMatrixAt(idx++, m);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  parent.add(inst);
}

/** Resolve the Y (scene Z) base of a carrier site. Mirrors the 2D
 *  renderer's `getSiteBaseY()` in deck-svg.ts — real `siteYOffsets`
 *  from the .tml when the importer supplied them, else an even-split
 *  across the carrier's OWN yDim (NOT the global
 *  POSITION_FALLBACK_Y_REAR constant). Using the wrong fallback base
 *  was misplacing labware rows by 15-30 mm per site. */
function getSiteBaseYMm(carrier, totalPositions, posIndex) {
  const yFrontMm = POS_Y_FRONT_01MM / 10;      // 63 mm
  const offsets = carrier.siteYOffsets;
  if (Array.isArray(offsets) && offsets[posIndex] != null) {
    return yFrontMm + offsets[posIndex] / 10;
  }
  const yDimMm = (carrier.yDim ?? 4970) / 10;
  const posPitchYMm = yDimMm / Math.max(1, totalPositions);
  return yFrontMm + posIndex * posPitchYMm;
}

/** Compute the labware placement in world mm from snapshot fields. */
function labwarePose(carrier, totalPositions, posIndex, lw) {
  // mm conversions
  const a1X = ((carrier.xMin ?? 0) + (lw.offsetX ?? 0)) / 10;
  const positionBaseYMm = getSiteBaseYMm(carrier, totalPositions, posIndex);
  const a1Y = positionBaseYMm + (lw.offsetY ?? 0) / 10;

  const pitch = (lw.wellPitch ?? 0) / 10 || 9;   // mm, default 9 mm (96-well)
  const rows = Math.max(1, lw.rows || 1);
  const cols = Math.max(1, lw.columns || 1);

  // Rack footprint. Prefer the real `.rck` dimensions when the parser
  // populated them (Dim.Dx/Dim.Dy); fall back to pitch-derived + pad,
  // then finally to a sensible carrier-clipped default.
  let rackDx = (lw.rackDx ?? 0) / 10;
  let rackDy = (lw.rackDy ?? 0) / 10;
  if (rackDx < 1) rackDx = Math.max(10, cols * pitch + 2 * pitch);
  if (rackDy < 1) rackDy = Math.max(10, rows * pitch + 2 * pitch);

  // Boundary from A1 to top-left of rack body.
  const bndryX = (lw.bndryX ?? Math.min(rackDx * 0.2, pitch * 0.8) * 10) / 10;
  const bndryY = (lw.bndryY ?? Math.min(rackDy * 0.2, pitch * 0.8) * 10) / 10;

  // Body centre = A1 + (col_center_offset, -row_center_offset).
  // Rows run A → H front-to-back (rows decrease in Y), so body centre Z
  // is a1Y - ((rows-1)/2)*pitch + small Y correction for the boundary.
  const cxMm = a1X + (cols - 1) * pitch / 2;
  const czMm = a1Y - (rows - 1) * pitch / 2;

  // bodyH: the labware's OWN thickness. Distinct from `height` (zTrans)
  // which tells you well-A1-top Z above the deck and can be 200+ mm for
  // tip racks. Using zTrans here made every plate a skyscraper.
  const bodyH = Math.max(4, (lw.rackDz ?? 0) / 10 || 15);
  const wellDepth = Math.max(3, (lw.wellDepth ?? 80) / 10);
  // How far the well tops rise ABOVE the rack body — non-zero for tip
  // racks (tips stick up) and tube racks (tubes rise above the rack
  // cutouts). Derived from height-zTrans minus carrier+body, with a
  // floor per-type.
  const topRise = Math.max(0, (lw.height ?? 0) / 10 - bodyH - CARRIER_THICKNESS_MM);

  const holeDiameter = (lw.holeDiameter ?? 0) / 10;     // mm

  return { cx: cxMm, cz: czMm, a1X, a1Y, pitch, rows, cols, rackDx, rackDy,
           bodyH, wellDepth, topRise, bndryX, bndryY, holeDiameter };
}

// Labware types Hamilton ships with a dedicated .hxx 3D model. When the
// install is present we prefer the real mesh over our procedural rack.
// Keys are LOWERCASE because the twin lowercases the rack name it
// reads from the .rck (Hamilton's file names aren't stable — we've
// seen `TeachingNeedleBlock`, `teachingneedleblock`, `TEACHINGNEEDLE`
// in the wild — so the renderer normalises everything to lowercase
// before lookup). Extend as needed — missing keys fall through to the
// primitive body.
const HXX_OVERRIDES = {
  'waste':                  'ML_STAR/CORE/Waste2.hxx',
  'waste2':                 'ML_STAR/CORE/Waste2.hxx',
  'teachingneedle5ml':      'ML_STAR/CORE/TeachingNeedle5ml.hxx',
  'teachingneedleblock':    'ML_STAR/CORE/TeachingNeedleBlock.hxx',
  'verification':           'ML_STAR/CORE/Verification.hxx',
  'starpluscore96waste':    'ML_STAR/CORE/StarPlusCore96Waste.hxx',
  'starpluscore384waste':   'ML_STAR/CORE/StarPlusCore384Waste.hxx',
  'core96slidewaste':       'ML_STAR/96CoReHead/Core96SlideWaste.hxx',
  'core384slidewaste':      'ML_STAR/384CoReHead/Core384SlideWaste.hxx',
  'autolyswaste':           'ML_STAR/AutoLys/AutoLysWaste.hxx',
};

// Cache for GLTFLoader.load() promises so repeat labware on the deck
// doesn't refetch the same .hxx.
const hxxPromiseCache = new Map();
function loadHxxOverride(hxxPath) {
  let pending = hxxPromiseCache.get(hxxPath);
  if (pending) return pending;
  const url = `/api/labware/3d/${hxxPath.replace(/\\/g, '/').replace(/\.hxx$/i, '.glb')}`;
  pending = new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, (err) => reject(err));
  });
  hxxPromiseCache.set(hxxPath, pending);
  return pending;
}

// Hamilton's .hxx assets are authored in METERS but ship with a top
// Frame whose FrameTransformMatrix bakes in a 1000× scale (and a
// per-asset translation) — so the glTF we emit already lands the
// geometry in MILLIMETRES. Don't add another 1000× here or the mesh
// comes out a thousand times too big.
//
// Each asset's authoring origin varies: Waste2 sits +56..+118 mm
// above its own Y=0; TeachingNeedle hangs −118 mm below (origin at
// the needle's top mount); Verification is centred on zero. Rather
// than hand-crafting per-asset offsets we compute the bbox and
// translate the root so the mesh lands with:
//   - its X/Z centre at the labware pose centre (cx, cz)
//   - its lowest Y flush with the top of the carrier (CARRIER_THICKNESS_MM)
function applyHxxTransform(root, pose) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // Hamilton's .x assets come in two flavours of Y convention:
  //
  //   1. "Hanging" — teaching needles, tip-style probes: authored as
  //      if hanging from a channel, so the WIDE mounting end sits at
  //      +Y and the NARROW probe tip at -Y. On a real STAR these
  //      probes stick UP off the carrier (base down, tip up), so we
  //      need to flip them.
  //
  //   2. "Standing" — bins, troughs, bases like Waste2: the opening
  //      is at +Y and the floor/drain at -Y, which is already
  //      correct for Y-up display (drain touches carrier, opening
  //      faces up).
  //
  // Detect which flavour by sampling X-width across Y. A profile
  // that narrows monotonically from top to bottom is a
  // hanging-probe; a profile whose widest slice is in the middle is
  // a standing bin.
  root.updateMatrixWorld(true);
  const flip = shouldFlipHxx(root);
  if (flip) {
    root.rotation.x = Math.PI;
    root.updateMatrixWorld(true);
  }
  const bbox = new THREE.Box3().setFromObject(root);
  const center = bbox.getCenter(new THREE.Vector3());
  // Y anchor: put bbox.min.y on the carrier top. This matches the
  // intuitive "the lowest extent of the visible geometry rests on
  // the carrier" reading, which lines up correctly once the matrix
  // bug in x-to-gltf is fixed (DirectX row-major ↔ glTF column-major
  // round-trips as the same bytes; the previous transpose silently
  // dropped Hamilton's authored translations and floated everything
  // by 50-90 mm). X/Z stay centred on the labware pose because
  // Hamilton doesn't always keep mesh origin aligned with the well
  // grid for every asset.
  root.position.set(
    pose.cx - center.x,
    CARRIER_THICKNESS_MM - bbox.min.y,
    pose.cz - center.z,
  );
}

/**
 * Decide whether a Hamilton .hxx mesh was authored hanging-down (wide
 * base at +Y, narrow tip at -Y) vs standing-up (opening at +Y, drain
 * at -Y). Returns true if the mesh needs a 180° flip around X.
 *
 * Heuristic: sample X-width at three Y-slices (top/middle/bottom). If
 * top is much wider than bottom AND middle is close to top, the mesh
 * tapers to a tip at the bottom — flip. If middle is much wider than
 * either end, the mesh widens in the middle (a bin) — don't flip.
 */
function shouldFlipHxx(root) {
  const bbox = new THREE.Box3().setFromObject(root);
  const topY = bbox.max.y;
  const botY = bbox.min.y;
  const midY = (topY + botY) / 2;
  const SLAB = Math.max(2, (topY - botY) * 0.05);     // sample a narrow slab at each height

  let topMin = Infinity, topMax = -Infinity;
  let botMin = Infinity, botMax = -Infinity;
  let midMin = Infinity, midMax = -Infinity;
  const tmp = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      const y = tmp.y;
      if (y > topY - SLAB) {
        if (tmp.x < topMin) topMin = tmp.x;
        if (tmp.x > topMax) topMax = tmp.x;
      }
      if (y < botY + SLAB) {
        if (tmp.x < botMin) botMin = tmp.x;
        if (tmp.x > botMax) botMax = tmp.x;
      }
      if (Math.abs(y - midY) < SLAB * 2) {
        if (tmp.x < midMin) midMin = tmp.x;
        if (tmp.x > midMax) midMax = tmp.x;
      }
    }
  });
  const topW = Math.max(0, topMax - topMin);
  const botW = Math.max(0, botMax - botMin);
  const midW = Math.max(0, midMax - midMin);

  // Bin-shape: middle at least 1.5× wider than the widest end.
  const widestEnd = Math.max(topW, botW);
  if (midW > widestEnd * 1.5) return false;
  // Tip-shape: top at least 3× bottom (wide-base-down-to-narrow-tip authoring).
  if (topW > botW * 3 + 1) return true;
  // Default: don't flip (safer for ambiguous assets).
  return false;
}

function buildLabware(lw, carrier, totalPositions, posIndex, usedSlots) {
  const p = labwarePose(carrier, totalPositions, posIndex, lw);
  const kind = classify(lw.type);
  const g = new THREE.Group();
  g.userData = { kind: 'labware', type: lw.type, carrierId: carrier.id, pos: posIndex };

  // .hxx override: if the Hamilton install ships a dedicated 3D mesh
  // for this type we kick off an async load and drop the GLB in as
  // soon as it arrives. Until then we render the primitive below —
  // that keeps the deck visible during the first paint and acts as a
  // fallback when no install is present (the fetch 404s).
  const hxxPath = HXX_OVERRIDES[(lw.type || '').toLowerCase()];
  let hxxRoot = null;
  if (hxxPath) {
    loadHxxOverride(hxxPath).then((scene) => {
      hxxRoot = scene.clone(true);
      applyHxxTransform(hxxRoot, p);
      // On success, hide the primitive body so we don't double-render.
      g.children
        .filter((c) => c.userData?.primitiveBody)
        .forEach((c) => { c.visible = false; });
      g.add(hxxRoot);
    }).catch(() => {
      // 404 (no install / unknown file) or parse failure — silently
      // keep the primitive body.
    });
  }

  // Body.
  const bodyColor =
    kind === 'tips'   ? PALETTE.tipRackBody :
    kind === 'plate'  ? PALETTE.plateBody :
    kind === 'tubes'  ? PALETTE.tubeRackBody :
    kind === 'trough' ? PALETTE.trough :
    kind === 'wash'   ? PALETTE.wash :
    kind === 'waste'  ? PALETTE.waste :
    PALETTE.fallback;
  const bodyMat = mat(bodyColor, {
    roughness: kind === 'plate' ? 0.25 : 0.5,
    clearcoat: kind === 'plate' ? 0.8 : 0.25,
    clearcoatRoughness: kind === 'plate' ? 0.08 : 0.3,
  });
  const body = new THREE.Mesh(roundedBox(p.rackDx, p.bodyH, p.rackDy, 1.8), bodyMat);
  body.position.set(p.cx, CARRIER_THICKNESS_MM + p.bodyH / 2, p.cz);
  body.castShadow = true;
  body.receiveShadow = true;
  // Tag so loadHxxOverride() can hide just this mesh once the real
  // glTF lands, without touching wells/collars added below.
  body.userData.primitiveBody = true;
  g.add(body);

  // Wells / tips / tubes.
  const wellKind =
    kind === 'tips'  ? 'tips'  :
    kind === 'tubes' ? 'tubes' :
    kind === 'plate' ? 'wells' : null;
  if (wellKind && p.rows >= 1 && p.cols >= 1) {
    const holeDiameterMm = p.holeDiameter > 0 ? p.holeDiameter : 0;
    const wellRadius =
      holeDiameterMm > 0 ? holeDiameterMm / 2 :
      wellKind === 'tips' ? p.pitch * 0.36 :
      wellKind === 'tubes' ? Math.min(p.rackDx / 2 - 2, p.pitch * 0.42) :
      p.pitch * 0.36;

    if (wellKind === 'tips') {
      // Real Hamilton tip rack: tips sit DOWN into the rack enclosure
      // with only the top cylindrical collar protruding. The visible
      // height is driven by the .rck/.ctr pair:
      //
      //   tipTotal   = ctr.depth              (well/tip internal length)
      //   baseOffset = Cntr.1.base (signed)   (where the container's
      //                                        bottom sits vs. the rack top)
      //   visible    = tipTotal + baseOffset  (baseOffset is negative
      //                                        so this is tipTotal - |base|)
      //
      // HT_L tip rack: tipTotal=95, base=-83.5 → visible=11.5.
      // LTF_L tip rack: tipTotal=59, base=-48 → visible=11.
      //
      // Trust the computed value only when BOTH halves were sourced
      // from a real .rck / .ctr pair (big-enough tip length, negative
      // base, plausible result). Otherwise — legacy catalog labware,
      // missing .ctr on disk, 0-default containerBase — fall back to
      // the proven 11.5 mm hardcode rather than a 3 mm stub.
      const tipTotalMm = (lw.wellDepth ?? 0) / 10;
      const baseOffsetMm = (lw.containerBase ?? 0) / 10;
      const computed = tipTotalMm + baseOffsetMm;
      const visibleCollarMm = (tipTotalMm >= 30 && baseOffsetMm < 0 && computed >= 5 && computed <= 40)
        ? computed
        : 11.5;

      // Pass 1: hole markers — darker disks flush with rack top at
      //         every position, so the enclosure reads as "holes in a
      //         plastic lid" even when the tip is missing.
      addWells(body, {
        rows: p.rows, cols: p.cols, pitch: p.pitch,
        rackDx: p.rackDx, rackDy: p.rackDy,
        a1Px: p.a1X, a1Py: p.a1Y,
        bodyH: p.bodyH,
        wellRadius: wellRadius * 1.02,
        wellDepth: 0.8,
        wellMat: mat(0x17181c, { roughness: 0.95, clearcoat: 0, metalness: 0 }),
        kind: 'hole_marker',
      });
      // Pass 2: visible tip collar — cylinder protruding above the
      //         hole for every NON-picked-up position.
      addWells(body, {
        rows: p.rows, cols: p.cols, pitch: p.pitch,
        rackDx: p.rackDx, rackDy: p.rackDy,
        a1Px: p.a1X, a1Py: p.a1Y,
        bodyH: p.bodyH,
        wellRadius: wellRadius * 0.96,
        wellDepth: visibleCollarMm,
        wellMat: mat(lw.type?.includes('300') ? PALETTE.tip300Top : PALETTE.tipTop,
          { roughness: 0.4, clearcoat: 0.3 }),
        kind: 'collar',
        usedSlots,
      });
    } else if (wellKind === 'wells') {
      // Plates: the old code placed `wellDepth`-tall cylinders INSIDE
      // the opaque body — perfectly recessed in theory, invisible in
      // practice, since the body's top face occludes them. Instead,
      // stamp a darker disk ON the plate top (same pattern tip racks
      // use for hole markers) so each well opening reads as a visible
      // dot. This matches what lab users see on a real plate from
      // above: a regular grid of darker well interiors on a lighter
      // plate surface.
      const wellMat = mat(PALETTE.plateWell, {
        roughness: 0.92, clearcoat: 0, metalness: 0,
      });
      addWells(body, {
        rows: p.rows, cols: p.cols, pitch: p.pitch,
        rackDx: p.rackDx, rackDy: p.rackDy,
        a1Px: p.a1X, a1Py: p.a1Y,
        bodyH: p.bodyH,
        wellRadius: wellRadius * 0.92,
        wellDepth: 0.6,
        wellMat,
        kind: 'hole_marker',
      });
    } else {
      // Tubes keep their original treatment: cylinders rising ABOVE
      // the rack top (the tubes themselves are the visible feature,
      // the rack body is just a frame underneath them).
      const risingFromHeight = p.topRise > 3 ? p.topRise : 0;
      const wellH = Math.min(risingFromHeight || 90, 100);
      const wellMat = mat(PALETTE.tube, { roughness: 0.55, clearcoat: 0.3 });
      addWells(body, {
        rows: p.rows, cols: p.cols, pitch: p.pitch,
        rackDx: p.rackDx, rackDy: p.rackDy,
        a1Px: p.a1X, a1Py: p.a1Y,
        bodyH: p.bodyH, wellRadius, wellDepth: wellH,
        wellMat, kind: 'tubes',
      });
    }
  }

  // Trough / wash: single long depression along Y as a cue.
  if (kind === 'trough' || kind === 'wash') {
    const cavity = new THREE.Mesh(
      roundedBox(p.rackDx * 0.82, 1.5, p.rackDy * 0.78, 1),
      mat(0x1a1d22, { roughness: 0.9, clearcoat: 0 }),
    );
    cavity.position.y = p.bodyH / 2 - 0.2;
    body.add(cavity);
  }

  return g;
}

/**
 * Rebuild deckLayer from a DeckSnapshot. Called on bootstrap and on
 * each `state-changed` event — cheap enough, even if we blow the whole
 * layer away and rebuild.
 *
 * `tipUsage` is the twin's deckTracker tip map, keyed by
 * `carrierId:positionIndex:wellIndex`. When a tip is picked up, the
 * corresponding key becomes true. We convert that into a per-labware
 * Set of wellIndex so `addWells` can skip drawing picked-up tips.
 */
function buildDeckLayer(deck, tipUsage) {
  disposeDeckLayer();
  if (!deck) return;
  const dims = deck.dimensions || {};
  const yFrontMm = (dims.yFrontEdge ?? 630) / 10;
  const yRearMm  = (dims.yRearEdge ?? 5600) / 10;
  const deckDepth = yRearMm - yFrontMm;
  const deckWidth = (dims.deckWidth ?? 12150) / 10;

  for (const c of deck.carriers || []) {
    const xMin = (c.xMin ?? 0) / 10;
    const xMax = (c.xMax ?? 0) / 10;
    const cw = Math.max(4, xMax - xMin);
    const cd = (c.yDim ?? 4970) / 10;
    const carrierBody = new THREE.Mesh(
      roundedBox(cw, CARRIER_THICKNESS_MM, cd, 1.5),
      mat(PALETTE.carrierBody, { roughness: 0.6, metalness: 0.05, clearcoat: 0.25 }),
    );
    carrierBody.position.set(
      xMin + cw / 2,
      CARRIER_THICKNESS_MM / 2,
      yFrontMm + cd / 2,
    );
    carrierBody.receiveShadow = true;
    carrierBody.castShadow = true;
    carrierBody.userData = { kind: 'carrier', id: c.id };
    deckLayer.add(carrierBody);

    const n = Math.max(1, c.positions || (c.labware || []).length || 1);
    for (let p = 0; p < (c.labware || []).length; p++) {
      const lw = c.labware[p];
      if (!lw) continue;
      // Build the set of wellIndex values that are currently empty
      // (tips already picked up) for this specific labware site, so
      // the tip-rack instance mesh skips those positions.
      let usedSlots;
      if (tipUsage) {
        const prefix = `${c.id}:${p}:`;
        for (const k in tipUsage) {
          if (tipUsage[k] && k.startsWith(prefix)) {
            if (!usedSlots) usedSlots = new Set();
            usedSlots.add(Number(k.slice(prefix.length)));
          }
        }
      }
      deckLayer.add(buildLabware(lw, c, n, p, usedSlots));
    }
  }
}

// ---------------------------------------------------------------- arms (placeholder geometry)
// Arms share the deck-layer palette but get their own material factory
// because they need per-instance opacity for the translucent target
// ghosts. Kept as MeshPhysicalMaterial so arms take the PMREM env the
// same way the chassis does — consistent look across the scene.
function armMat(color, opacity = 1.0) {
  return new THREE.MeshPhysicalMaterial({
    color, metalness: 0.55, roughness: 0.35,
    clearcoat: 0.45, clearcoatRoughness: 0.2, envMapIntensity: 0.9,
    transparent: opacity < 1.0, opacity,
    side: THREE.DoubleSide,
  });
}

// Arm palette — muted greys/metals so arms read as real hardware next to
// the CAD chassis. Avoid saturated primaries; those are what made the
// first pass look like 1990s demo-scene 3D.
const ARM_PAL = {
  pipBody:      0x2e333c,
  pipAccent:    0x8a6040,          // a hint of warm trim
  channel:      0xbcc4cc,          // channel shafts — brushed alloy
  channelTip:   0x0e1115,          // plastic tip adapter
  iswap:        0x363c46,
  iswapJaw:     0x1f232a,
  h96:          0x343a44,
  h384:         0x2c3139,
  autoload:     0x2a2f38,
};

// PIP arm: carriage + 8 channels.
// Coordinate convention — twin keeps `pos_y[j] = yp - j*9 mm` so channel 0
// is at the REAR (largest Y) and channels 1-7 extend FORWARD (smaller Y).
// Scene Z = twin Y (bigger = rearward), so in group-local coords channel i
// sits at `z = -i * CHANNEL_PITCH_MM`. Channel 0 stays at group origin so
// `group.position.z = yTwinCh0 / 10` still lands ch0 exactly where the twin
// state says. Carriage + accent get shifted to the channel-span midpoint so
// the head visually straddles the pins instead of dangling off the rear.
function makePipArm() {
  const group = new THREE.Group();
  const spanZ = (CHANNEL_COUNT - 1) * CHANNEL_PITCH_MM;      // 63 mm
  const carriageZ = -spanZ / 2;                              // midpoint, channel side

  const carriage = new THREE.Mesh(
    roundedBox(PIP_CARRIAGE_W_MM, PIP_CARRIAGE_H_MM,
               spanZ + PIP_CARRIAGE_D_MM, 2),
    armMat(ARM_PAL.pipBody),
  );
  carriage.position.set(0, 0, carriageZ);
  carriage.name = 'carriage';
  group.add(carriage);

  // Warm accent strip along the top edge of the carriage — reads as a
  // painted frame on the ML-head and gives the PMREM something warm to
  // reflect against the cooler grey body.
  const accent = new THREE.Mesh(
    roundedBox(PIP_CARRIAGE_W_MM * 0.9, 2, spanZ + PIP_CARRIAGE_D_MM - 6, 0.8),
    armMat(ARM_PAL.pipAccent),
  );
  accent.position.set(0, PIP_CARRIAGE_H_MM / 2 + 1, carriageZ);
  group.add(accent);

  const channelShaftMat = armMat(ARM_PAL.channel);
  const channelTipMat = armMat(ARM_PAL.channelTip);
  // Tip material — tapered black plastic, same color palette as the
  // tips sitting in the rack so the pickup reads as a swap, not two
  // different objects.
  const fittedTipMat = armMat(PALETTE.tipTop);
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(CHANNEL_DIAMETER_MM / 2, CHANNEL_DIAMETER_MM / 2.2, CHANNEL_TIP_LEN_MM, 18),
      channelShaftMat,
    );
    pin.position.set(0,
      -PIP_CARRIAGE_H_MM / 2 - CHANNEL_TIP_LEN_MM / 2,
      -i * CHANNEL_PITCH_MM);
    pin.name = `ch${i}`;
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(CHANNEL_DIAMETER_MM / 2 + 1.2, CHANNEL_DIAMETER_MM / 2 + 1.2, 4, 14),
      channelTipMat,
    );
    collar.position.y = CHANNEL_TIP_LEN_MM / 2 - 4;
    pin.add(collar);
    // Tip hanging off the channel nozzle — hidden until the twin's
    // liquid tracker reports `channels[i].hasTip=true`. Built with a
    // UNIT length (1 mm) cylinder whose `scale.y` is updated per-frame
    // to match the fitted tip's actual length from the labware catalog
    // (HT 1000 µL = 95 mm, ST 300 µL = 60 mm, 50 µL = 35 mm). Without
    // scaling, every tip looked 95 mm long — made 300 µL pickups
    // visually reach ~30 mm PAST the well bottom, which the user saw
    // as tips "floating above the plate" because placePip offset the
    // pin to account for a too-long tip.
    const tip = new THREE.Mesh(
      new THREE.CylinderGeometry(3.4, 0.3, 1, 16),  // unit height — scaled per-frame
      fittedTipMat,
    );
    tip.name = 'tip';
    // Anchor tip TOP at pin BOTTOM (local y = -CHANNEL_TIP_LEN_MM/2).
    // With scale.y = length_mm, tip origin at pin bottom, tip extends
    // downward by length_mm. Since the cylinder's center is at its
    // origin, position origin at `-CHANNEL_TIP_LEN_MM/2 - length_mm/2`
    // — computed dynamically when scale.y changes (see updateTipLength
    // below / placePip).
    tip.position.y = -CHANNEL_TIP_LEN_MM / 2 - 47.5;  // default for 95mm; overwritten each frame
    tip.scale.y = 95;  // default HT-1000 length; overwritten by applyState
    tip.userData.lengthMm = 95;  // cached actual length, read by placePip
    tip.visible = false;
    pin.add(tip);
    group.add(pin);
  }
  return group;
}

// iSWAP: simple gripper block with two jaw markers.
function makeISwap() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    roundedBox(ISWAP_W_MM, ISWAP_H_MM, ISWAP_D_MM, 2),
    armMat(ARM_PAL.iswap),
  );
  group.add(body);
  const jawMat = armMat(ARM_PAL.iswapJaw);
  const jawL = new THREE.Mesh(new THREE.BoxGeometry(30, 8, 6), jawMat);
  const jawR = new THREE.Mesh(new THREE.BoxGeometry(30, 8, 6), jawMat);
  jawL.position.set(0, -ISWAP_H_MM / 2 - 4, -30);
  jawR.position.set(0, -ISWAP_H_MM / 2 - 4,  30);
  jawL.name = 'jawL'; jawR.name = 'jawR';
  group.add(jawL); group.add(jawR);
  return group;
}

function makeHeadBox(w, d, h, color) {
  // Wrap in a group so the head's transform origin sits at its BOTTOM
  // face (not the geometry centre). placeHead can then use `position.y`
  // directly as the "head bottom Y in world space" — setting it to
  // (GANTRY_TOP - zT/10) puts the body bottom exactly at the commanded
  // descent level, instead of centering the head on that Y which made
  // the bottom half of the body plunge below the deck at full descent
  // (the "head dives below the tip carrier" symptom).
  const mesh = new THREE.Mesh(roundedBox(w, h, d, 2), armMat(color));
  mesh.position.y = h / 2;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

// Autoload carriage — slides along the front rail in X.
function makeAutoload() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(roundedBox(90, 40, 60, 2), armMat(ARM_PAL.autoload));
  group.add(body);
  return group;
}

// Build the arm set once. Kept in a struct so the animation loop can
// reach them directly without scene-graph lookups.
const arms = {
  pip:      makePipArm(),
  iswap:    makeISwap(),
  h96:      makeHeadBox(H96_W_MM,  H96_D_MM,  H96_H_MM,  ARM_PAL.h96),
  h384:     makeHeadBox(H384_W_MM, H384_D_MM, H384_H_MM, ARM_PAL.h384),
  autoload: makeAutoload(),
};
for (const a of Object.values(arms)) {
  a.visible = false;   // bootstrap will reveal once state arrives
  a.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
  sceneRoot.add(a);
}

// ---------------------------------------------------------------- ghost (target overlay)
// A translucent copy of each arm that snaps to the commanded target.
// Lets the user see where the arm is heading while the real arm
// interpolates. Parallel to the 2D renderer's "ghost arm" concept.
function makeGhost(src) {
  const ghost = src.clone(true);
  ghost.traverse((n) => {
    if (!n.isMesh) return;
    n.material = n.material.clone();
    n.material.transparent = true;
    n.material.opacity = 0.22;
    n.material.depthWrite = false;
  });
  return ghost;
}
const ghosts = {
  pip:      makeGhost(arms.pip),
  iswap:    makeGhost(arms.iswap),
  h96:      makeGhost(arms.h96),
  h384:     makeGhost(arms.h384),
};
for (const g of Object.values(ghosts)) { g.visible = false; sceneRoot.add(g); }

// ---------------------------------------------------------------- state → arm
// Targets the animation loop eases toward when no active motion envelope.
const target = {
  pip:      {
    x: 0, y: 0, z: 0,
    // Per-channel Y and Z arrays. yArr starts at the rigid 9-mm layout
    // so ch0..ch7 sit at Y, Y-9, Y-18, ... until a command rewrites
    // pos_y[]. Updated from the /state snapshot and from motion
    // envelopes; placePip consults yArr to spread the pins.
    zArr: new Array(CHANNEL_COUNT).fill(0),
    yArr: null,
  },
  iswap:    { x: 0, y: 0, z: 0, rot: 0, grip: 0 },
  h96:      { x: 0, y: 0, z: 0 },
  h384:     { x: 0, y: 0, z: 0 },
  autoload: { track: 0 },
};

// Currently-playing motion envelopes. Keyed by arm; overwritten when a
// new envelope for the same arm arrives (real arms don't queue either).
const active = new Map();

// ---------------------------------------------------------------- trajectory overlay
// Dashed line from envelope start → end for each moving arm. Drawn above
// the arm so the user can see the commanded path — mirrors the "ghost"
// target-position overlay in the 2D deck renderer. The line fades out
// once the envelope completes (kept around briefly as a trail).
const trajectoryGroup = new THREE.Group();
sceneRoot.add(trajectoryGroup);
const trajectoryLines = new Map();                // arm → {line, fadeUntil}
// Trajectory stays on screen until the next motion for that arm
// overwrites it — matches the 2D "ghost target" behaviour. A short
// fade-in so new tubes don't pop on abruptly.
const TRAIL_FADE_MS = 99999;

// Palette mirrors `.trajectory--*` in src/renderer/style.css so 2D and
// 3D show the same color per arm — cyan for pip, purple for iswap,
// green for h96, orange for h384, pink for autoload.
function trajectoryColorForArm(arm) {
  return (
    arm === 'pip'      ? 0x4cc9f0 :   // rgba(76,201,240) — 2D pip default
    arm === 'iswap'    ? 0xc896ff :   // rgba(200,150,255)
    arm === 'h96'      ? 0x64dc8c :   // rgba(100,220,140)
    arm === 'h384'     ? 0xffb464 :   // rgba(255,180,100)
    arm === 'autoload' ? 0xff78b4 :   // rgba(255,120,180)
    0x4cc9f0
  );
}

/** Build (or reuse) the trajectory tube for an arm, given an envelope.
 *  Uses `TubeGeometry` over a CatmullRomCurve3 because WebGL1 ignores
 *  `linewidth > 1` on THREE.Line, making LineDashedMaterial essentially
 *  invisible against the deck. A tube is real 3D geometry — thick, lit
 *  by the PMREM, and impossible to miss. */
function updateTrajectory(armKey, env) {
  let entry = trajectoryLines.get(armKey);
  const color = trajectoryColorForArm(armKey);
  // Deduplicate adjacent co-located points. A CNC envelope where
  // startZ is already at the safe height degenerates the "retract"
  // leg to a zero-length segment; CatmullRomCurve3 produces NaN
  // tangents on a zero-length segment, and the resulting tube
  // collapses to nothing — the user only sees the endpoint spheres.
  const rawPts = trajectoryPoints(env);
  const pts = [];
  for (const p of rawPts) {
    const last = pts[pts.length - 1];
    if (!last || last.distanceToSquared(p) > 1e-4) pts.push(p);
  }

  // Dispose the old geometry before rebuilding — TubeGeometry doesn't
  // support in-place updates.
  if (entry) {
    entry.tube.geometry.dispose();
    trajectoryGroup.remove(entry.tube);
  }

  const curve = pts.length >= 2
    ? new THREE.CatmullRomCurve3(pts, /*closed*/false, "catmullrom", 0.0)
    : null;
  if (!curve) return;

  // Thin tube (3 mm radius) matching the 2D "trajectory" stroke weight.
  // Unlit material with flat color + no emissive so it reads cleanly
  // without the "glowing hot rod" look the user flagged.
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(24, pts.length * 12), 3, 8, false),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true, opacity: 0.7, depthWrite: false,
    }),
  );
  tube.frustumCulled = false;
  trajectoryGroup.add(tube);

  // Endpoint pin-heads — small filled circles at start/end, same color
  // as the trajectory tube. Matches the 2D `.trajectory-dot-*` pattern.
  const sphereMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85, depthWrite: false,
  });
  const startSphere = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 10), sphereMat);
  const endSphere = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 10), sphereMat);
  startSphere.position.copy(pts[0]);
  endSphere.position.copy(pts[pts.length - 1]);
  tube.add(startSphere);
  tube.add(endSphere);

  trajectoryLines.set(armKey, { tube, fadeUntil: env.startTime + env.durationMs + TRAIL_FADE_MS });
}

/** Construct the polyline for one envelope. For CNC moves we emit the
 *  retract → travel → descend legs so the trajectory mirrors what the
 *  sampler actually animates; for dwellZ moves we add the hold +
 *  final-retract legs. When the envelope carries neither a traverseZ
 *  nor a dwellZ we fall back to a straight line for back-compat. */
function trajectoryPoints(env) {
  // Hamilton convention: z is HEIGHT ABOVE DECK (bigger = higher).
  // Trajectory waypoints map directly to world Y = z/10 above the
  // deck base. Deck base sits at scene Y=0; gantry at GANTRY_TOP_Y_MM.
  const mkPt = (x, y, z) => new THREE.Vector3(x / 10, z / 10, y / 10);
  const startZ = env.startZ ?? 0;
  const endZ   = env.endZ ?? 0;
  const hasXY = Math.abs((env.endX ?? 0) - (env.startX ?? 0)) > 0.5
             || Math.abs((env.endY ?? 0) - (env.startY ?? 0)) > 0.5;
  const peakZ = safeTravelZ3d(startZ, endZ, env.traverseZ);

  // Emit every waypoint the sampler will animate through — the tube
  // builder (updateTrajectory) deduplicates colocated consecutive
  // points so it's fine if a degenerate phase (e.g. startZ === peakZ
  // means no retract) produces a duplicate point.
  if (env.dwellZ != null && hasXY) {
    return [
      mkPt(env.startX, env.startY, startZ),
      mkPt(env.startX, env.startY, peakZ),
      mkPt(env.endX,   env.endY,   peakZ),
      mkPt(env.endX,   env.endY,   env.dwellZ),
      mkPt(env.endX,   env.endY,   endZ),
    ];
  }
  if (env.dwellZ != null) {
    return [
      mkPt(env.startX, env.startY, startZ),
      mkPt(env.startX, env.startY, env.dwellZ),
      mkPt(env.endX,   env.endY,   env.dwellZ),
      mkPt(env.endX,   env.endY,   endZ),
    ];
  }
  if (hasXY) {
    return [
      mkPt(env.startX, env.startY, startZ),
      mkPt(env.startX, env.startY, peakZ),
      mkPt(env.endX,   env.endY,   peakZ),
      mkPt(env.endX,   env.endY,   endZ),
    ];
  }
  return [mkPt(env.startX, env.startY, startZ), mkPt(env.endX, env.endY, endZ)];
}

function tickTrajectories(nowMs) {
  for (const [armKey, entry] of trajectoryLines) {
    const remaining = entry.fadeUntil - nowMs;
    if (remaining <= 0) {
      trajectoryGroup.remove(entry.tube);
      entry.tube.geometry.dispose();
      entry.tube.material.dispose();
      entry.tube.traverse((n) => { if (n.isMesh && n !== entry.tube) { n.geometry.dispose(); n.material.dispose(); } });
      trajectoryLines.delete(armKey);
    } else if (remaining < TRAIL_FADE_MS) {
      const fade = (remaining / TRAIL_FADE_MS);
      entry.tube.material.opacity = fade * 0.88;
      entry.tube.traverse((n) => { if (n.isMesh && n !== entry.tube) n.material.opacity = fade * 0.9; });
    }
  }
}

// Lerp helpers -------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// Map twin coords (0.1 mm) to scene mm. The scene Y axis is vertical,
// Z is depth, so we swap Y/Z vs the twin frame.
//
// Hamilton convention (confirmed by well-geometry.simulateLLD and the
// pip-command-catalog trace values th=2450, zl=1941, zx=1891, ...):
//   pos_z is the HEIGHT OF THE TIP ABOVE THE DECK SURFACE in 0.1 mm.
//   Bigger pos_z = higher physically (safer, more retracted).
//   Smaller pos_z = lower physically (closer to deck / in well).
//   pos_z = 0 would be at deck level; well-geometry flags it as a crash.
//
// The earlier placePip implementation inverted this convention — it
// treated bigger pos_z as DEEPER extension — so channels dove INTO the
// deck during travel and tips never reached labware. Fixed 2026-04-24.
//
// Per-channel Y support: each PIP channel has its own Y drive on a real
// STAR, so one channel can dip into plate A while another dips into
// plate B. When `yTenthsArr` is provided we set each pin's local z offset
// to (ch_i_Y − ch_0_Y); the group is anchored at channel 0's Y so that
// stays visually identical. When `yTenthsArr` is absent we fall back to
// the rigid -i*CHANNEL_PITCH_MM layout the head was built with.
function placePip(obj, xTenths, yTenthsCh0, zTenthsMax, zTenthsArr, yTenthsArr) {
  obj.position.x = xTenths / 10;
  obj.position.z = yTenthsCh0 / 10;
  // Carriage stays anchored at the gantry rail. Only the channels
  // extend down from it as pos_z decreases.
  obj.position.y = GANTRY_TOP_Y_MM;
  // Visibility is owned by setArmVisible() — never force-unhide here,
  // or an uninitialized arm at (0,0,0) reappears every animation frame.
  const useYArr = Array.isArray(yTenthsArr) && yTenthsArr.length >= CHANNEL_COUNT;
  const anchorY = useYArr ? yTenthsArr[0] : yTenthsCh0;
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const pin = obj.getObjectByName(`ch${i}`);
    if (!pin) continue;
    const zt = Array.isArray(zTenthsArr) ? (zTenthsArr[i] ?? zTenthsMax) : zTenthsMax;
    // Working end Y (where the tip end / nozzle end sits in world space)
    // = pos_z / 10. When a tip is fitted, the tip cone hangs its own
    // catalog-driven length below the pin's bottom (95 mm for HT, 60
    // for 300, 35 for 50). Without a tip, the pin bottom IS the
    // working end. Read the per-pin tip length from userData so each
    // channel's rendering matches whatever tip type that channel is
    // holding — picked in applyState's tip-visibility pass.
    const tip = pin.getObjectByName('tip');
    const hasTip = !!(tip && tip.visible);
    const tipLengthMm = hasTip ? (tip.userData.lengthMm || 95) : 0;
    const workingEndWorldY = zt / 10;
    const pinBottomWorldY = workingEndWorldY + tipLengthMm;
    const pinCenterWorldY = pinBottomWorldY + CHANNEL_TIP_LEN_MM / 2;
    pin.position.y = pinCenterWorldY - GANTRY_TOP_Y_MM;
    // Group origin sits at channel 0's scene-Z; each pin's local z is
    // (ch_i_Y − ch_0_Y) / 10 so channel 0 stays at 0 and channels 1..7
    // spread out based on their actual commanded Y. Falls back to the
    // rigid 9 mm layout when no per-channel Y is available.
    if (useYArr) {
      pin.position.z = -(anchorY - yTenthsArr[i]) / 10;
    } else {
      pin.position.z = -i * CHANNEL_PITCH_MM;
    }
  }
}
function placeHead(obj, xT, yT, zT) {
  obj.position.x = xT / 10;
  obj.position.z = yT / 10;
  obj.position.y = GANTRY_TOP_Y_MM - zT / 10;
}
function placeISwap(obj, xT, yT, zT, rotDeg, gripHundredthMm) {
  obj.position.x = xT / 10;
  obj.position.z = yT / 10;
  obj.position.y = GANTRY_TOP_Y_MM - zT / 10;
  obj.rotation.y = (rotDeg || 0) * Math.PI / 180;
  const gripMm = (gripHundredthMm || 0) / 10;
  const jL = obj.getObjectByName('jawL'), jR = obj.getObjectByName('jawR');
  if (jL && jR) { jL.position.z = -gripMm / 2; jR.position.z = gripMm / 2; }
}
function placeAutoload(obj, track, trackPitchMm, xOffsetMm) {
  if (!track) { obj.visible = false; return; }
  obj.visible = true;
  obj.position.x = xOffsetMm + track * trackPitchMm;
  obj.position.y = 60;
  obj.position.z = 50;   // front rail
}

// ---------------------------------------------------------------- bootstrap
async function bootstrap() {
  try {
    const res = await fetch('/state');
    if (!res.ok) throw new Error(`/state → ${res.status}`);
    const state = await res.json();
    applyState(state);
    setConn(true, `live (${state.deviceName ?? 'twin'})`);
  } catch (err) {
    setConn(false, 'bootstrap failed');
    console.error(err);
  }
}

function moduleInitialized(m, key) {
  const s = m?.[key]?.states;
  if (!Array.isArray(s)) return false;
  if (s.includes('not_initialized')) return false;
  // Twin reports things like ["operational", "idle", "no_tip"]. Any state
  // other than "not_initialized" means the module is live in some form.
  return true;
}

/** Decide whether a given arm is worth drawing right now.
 *  - not initialized           → hide (no physical meaning)
 *  - initialized, at (0,0,0)   → hide (never commanded; avoids a box
 *                                parked at the left-front corner that
 *                                looks like real data)
 *  - in a moving-state         → always show (envelope drives it)
 *  - otherwise                 → show (has genuine resting position)
 */
function armShouldShow(modules, key, x, y, z) {
  if (!moduleInitialized(modules, key)) return false;
  const states = modules?.[key]?.states ?? [];
  if (states.some((s) => /moving|aspirating|dispensing|picking|dropping|rotating/i.test(s))) return true;
  const atOrigin = (x | 0) === 0 && (y | 0) === 0 && (z | 0) === 0;
  return !atOrigin;
}

function setArmVisible(kind, visible) {
  if (arms[kind]) arms[kind].visible = visible;
  // Ghost only appears during an active motion envelope — otherwise the
  // arm and ghost sit at identical coords and Z-fight, which reads as
  // "the geometry is duplicated" instead of "the arm is at rest".
  if (ghosts[kind]) ghosts[kind].visible = visible && $('ghost').checked && active.has(kind);
}

function applyState(state) {
  // Deck layer (carriers + labware) — rebuild on each state update. The
  // snapshot is small (a few KB) and carriers rarely change during a run.
  // Feed the twin's tip-usage map through so picked-up tips disappear
  // from their rack.
  buildDeckLayer(state?.deck, state?.deckTracker?.tipUsage);

  const m = state?.modules ?? {};
  const pipV = m.pip?.variables || {};
  const iswapV = m.iswap?.variables || {};
  const h96V = m.h96?.variables || {};
  const h384V = m.h384?.variables || {};
  const alV = m.autoload?.variables || {};

  // Hide uninitialized arms AND initialized-but-never-moved ones. The
  // real instrument parks idle heads at mechanical home positions we
  // don't model, so showing them at (0,0,0) creates "phantom box over
  // the front-left corner" confusion. Uses pos values computed below.
  // Visibility decisions land after the target updates so we use the
  // freshly-computed values, not stale ones from the previous state.

  // PIP Y: per-channel-masked array — back-calculate a ch0-equivalent Y
  // from whichever channel last moved. Mirrors arm.ts updateDeckArm.
  const posY = pipV.pos_y;
  let pipY0 = Array.isArray(posY) ? (posY[0] || 0) : 0;
  if (!pipY0 && Array.isArray(posY)) {
    for (let j = 1; j < posY.length; j++) {
      if (posY[j]) { pipY0 = posY[j] + j * 90; break; }
    }
  }
  const posZ = pipV.pos_z;
  let maxZ = 0;
  if (Array.isArray(posZ)) for (const z of posZ) if (z > maxZ) maxZ = z;

  target.pip.x = pipV.pos_x || 0;
  target.pip.y = pipY0;
  target.pip.z = maxZ;
  target.pip.zArr = Array.isArray(posZ) ? posZ : new Array(CHANNEL_COUNT).fill(0);
  // Per-channel Y from the datamodel. Only the first CHANNEL_COUNT (8)
  // slots matter for 3D — the STAR has 16 PIP channels on the firmware
  // side but 3D currently draws 8. Channels whose pos_y is 0 keep the
  // rigid 9 mm layout (they weren't commanded and the arm default has
  // them at nominal spacing).
  if (Array.isArray(posY)) {
    const yArr = new Array(CHANNEL_COUNT);
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const v = Number(posY[i]);
      yArr[i] = Number.isFinite(v) && v > 0 ? v : pipY0 - i * 90;
    }
    target.pip.yArr = yArr;
  } else {
    target.pip.yArr = null;
  }

  target.iswap.x = iswapV.pos_x || 0;
  target.iswap.y = iswapV.pos_y || 0;
  target.iswap.z = iswapV.pos_z || 0;
  target.iswap.rot = iswapV.plate_rotation_deg || 0;
  target.iswap.grip = iswapV.grip_width_01mm || 0;

  target.h96.x = h96V.pos_x || 0;
  target.h96.y = h96V.pos_y || 0;
  target.h96.z = h96V.pos_z || 0;

  target.h384.x = h384V.pos_x || 0;
  target.h384.y = h384V.pos_y || 0;
  target.h384.z = h384V.pos_z || 0;

  target.autoload.track = alV.pos_track || 0;

  // Deck snapshot carries the xOffset + trackPitch used for autoload X.
  const dims = state?.deck?.dimensions || {};
  target.autoload.xOffset = (dims.xOffset ?? 1000) / 10;
  target.autoload.trackPitch = (dims.trackPitch ?? 225) / 10;

  // Per-channel tip state. The twin's liquid tracker maintains one
  // `hasTip` flag per channel AND a `tipType` (string) matching a
  // labware-catalog entry (e.g. "Tips_1000uL"). Scale the rendered
  // tip cone to the catalog's `tipLength` so a 300 µL tip is drawn
  // 60 mm long, a 50 µL at 35 mm, etc — previously every tip was
  // 95 mm regardless, which put 300 µL tip bottoms 35 mm past where
  // placePip thought they were.
  const channels = state?.liquidTracking?.channels ?? [];
  const tipLengthFor = (tipType) => {
    const entry = state?.deck?.carriers ? null : null;  // fast path
    void entry;
    const table = applyState._tipLenByType ||= {};
    if (table[tipType] !== undefined) return table[tipType];
    // Fallback: infer from tipMaxVolume if tipType name isn't a direct
    // catalog match. Cache the result so the lookup runs once per type.
    const byVolume = { 1000: 95, 300: 60, 50: 35, 10: 30 };
    let len = 95;
    if (typeof tipType === 'string') {
      if (/1000/.test(tipType)) len = 95;
      else if (/300/.test(tipType)) len = 60;
      else if (/50/.test(tipType)) len = 35;
      else if (/10/.test(tipType)) len = 30;
    }
    void byVolume;
    table[tipType] = len;
    return len;
  };
  const setTipLength = (tip, lengthMm) => {
    if (!tip) return;
    tip.scale.y = lengthMm;
    tip.position.y = -CHANNEL_TIP_LEN_MM / 2 - lengthMm / 2;
    tip.userData.lengthMm = lengthMm;
  };
  for (const kind of ['pip']) {
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const pin = arms[kind].getObjectByName(`ch${i}`);
      const tip = pin?.getObjectByName('tip');
      const hasTip = !!channels[i]?.hasTip;
      if (tip) {
        tip.visible = hasTip;
        if (hasTip) setTipLength(tip, tipLengthFor(channels[i]?.tipType));
      }
      const ghostPin = ghosts[kind].getObjectByName(`ch${i}`);
      const ghostTip = ghostPin?.getObjectByName('tip');
      if (ghostTip) {
        ghostTip.visible = hasTip;
        if (hasTip) setTipLength(ghostTip, tipLengthFor(channels[i]?.tipType));
      }
    }
  }

  // Snap ghosts to targets so the viewer has something immediately.
  updateGhosts();

  // Decide what's visible now that targets are up-to-date.
  setArmVisible('pip',   armShouldShow(m, 'pip',   target.pip.x,   target.pip.y,   target.pip.z));
  setArmVisible('iswap', armShouldShow(m, 'iswap', target.iswap.x, target.iswap.y, target.iswap.z));
  setArmVisible('h96',   armShouldShow(m, 'h96',   target.h96.x,   target.h96.y,   target.h96.z));
  setArmVisible('h384',  armShouldShow(m, 'h384',  target.h384.x,  target.h384.y,  target.h384.z));
}

function updateGhosts() {
  if (ghosts.pip)   placePip(ghosts.pip,   target.pip.x, target.pip.y, target.pip.z, target.pip.zArr, target.pip.yArr);
  if (ghosts.iswap) placeISwap(ghosts.iswap, target.iswap.x, target.iswap.y, target.iswap.z, target.iswap.rot, target.iswap.grip);
  if (ghosts.h96)   placeHead(ghosts.h96,  target.h96.x, target.h96.y, target.h96.z);
  if (ghosts.h384)  placeHead(ghosts.h384, target.h384.x, target.h384.y, target.h384.z);
}

// ---------------------------------------------------------------- SSE
let sse = null;
function connectSSE() {
  try {
    sse = new EventSource('/events');
    sse.addEventListener('open', () => setConn(true, 'live'));
    sse.addEventListener('connected', () => setConn(true, 'live'));
    sse.addEventListener('error', () => setConn(false, 'reconnecting…'));
    sse.addEventListener('state-changed', (evt) => {
      try { applyState(JSON.parse(evt.data)); } catch (e) { console.warn(e); }
    });
    sse.addEventListener('motion', (evt) => {
      try { onMotion(JSON.parse(evt.data)); } catch (e) { console.warn(e); }
    });
  } catch (err) {
    setConn(false, 'sse failed');
    console.error(err);
  }
}

function setConn(ok, text) {
  connEl.classList.toggle('ok', !!ok);
  connEl.classList.toggle('err', !ok);
  connText.textContent = text;
}

function onMotion(env) {
  // Keep only the latest envelope per arm — matches the real hardware
  // where a new command aborts the previous move.
  active.set(env.arm, env);
  // Draw the commanded path so the user can see start → end of the move
  // in addition to the live-animated arm position.
  updateTrajectory(env.arm, env);
  window.__motionCount = (window.__motionCount || 0) + 1;
  window.__lastEnv = env;
}

// ---------------------------------------------------------------- animation
// CNC-style motion profile — mirrors renderer/arm.ts exactly, including
// the physical-distance phase partitioning so a 190 mm descend gets
// proportional time instead of a fixed 15% of the envelope. If the two
// samplers diverge the 3D arm and 2D deck arm drift apart mid-motion.
const Z_SPEED_UNITS_PER_MS_3D = 3;   // 300 mm/s
const XY_SPEED_UNITS_PER_MS_3D = 8;  // 800 mm/s
const MIN_PHASE_MS_3D = 40;

function sample3dSmooth(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function safeTravelZ3d(startZ, endZ, traverseZ) {
  // Hamilton convention: pos_z is height above deck, bigger = higher.
  // Safe during XY travel = MAX of endpoints + traverseZ. See arm.ts
  // safeTravelZ for the full rationale.
  return traverseZ != null
    ? Math.max(startZ, endZ, traverseZ)
    : Math.max(startZ, endZ);
}

/** Compute phase boundaries from physical distances and the envelope's
 *  durationMs. Returns end-fractions for retract / travel / descend /
 *  hold phases. See arm.ts computePhaseBoundaries for the full spec. */
function computePhaseBoundaries3d(startZ, endZ, dwellZ, peakZ, xyDist, totalMs, hasXY) {
  const hasDwell = dwellZ != null;
  const dRetract = Math.abs(startZ - peakZ);
  const dDescend = hasDwell ? Math.abs(dwellZ - peakZ) : Math.abs(endZ - peakZ);
  const dEndRetract = hasDwell ? Math.abs(endZ - dwellZ) : 0;
  const dXY = hasXY ? xyDist : 0;

  let tRetract = dRetract / Z_SPEED_UNITS_PER_MS_3D;
  let tTravel  = dXY / XY_SPEED_UNITS_PER_MS_3D;
  let tDescend = dDescend / Z_SPEED_UNITS_PER_MS_3D;
  let tEndRet  = dEndRetract / Z_SPEED_UNITS_PER_MS_3D;

  if (dRetract > 0 && tRetract < MIN_PHASE_MS_3D) tRetract = MIN_PHASE_MS_3D;
  if (dXY      > 0 && tTravel  < MIN_PHASE_MS_3D) tTravel  = MIN_PHASE_MS_3D;
  if (dDescend > 0 && tDescend < MIN_PHASE_MS_3D) tDescend = MIN_PHASE_MS_3D;
  if (dEndRetract > 0 && tEndRet < MIN_PHASE_MS_3D) tEndRet = MIN_PHASE_MS_3D;

  const tPhysical = tRetract + tTravel + tDescend + tEndRet;
  const tHold = Math.max(0, totalMs - tPhysical);
  const tTotal = tPhysical + tHold;
  if (tTotal <= 0) return { retract: 0, travel: 0, descend: 0, hold: 0 };

  const retract = tRetract / tTotal;
  const travel  = retract + tTravel / tTotal;
  const descend = travel + tDescend / tTotal;
  const hold    = descend + tHold / tTotal;
  return { retract, travel, descend, hold };
}

function sampleZFromPhases3d(r, startZ, endZ, dwellZ, peakZ, b) {
  const rC = Math.max(0, Math.min(1, r));
  const hasDwell = dwellZ != null;
  const lerpS = (a, z, t) => a + (z - a) * sample3dSmooth(t);
  if (rC < b.retract && b.retract > 0) return lerpS(startZ, peakZ, rC / b.retract);
  if (rC < b.travel) return peakZ;
  if (rC < b.descend && b.descend > b.travel) {
    const target = hasDwell ? dwellZ : endZ;
    return lerpS(peakZ, target, (rC - b.travel) / (b.descend - b.travel));
  }
  if (!hasDwell) return endZ;
  if (rC < b.hold) return dwellZ;
  if (b.hold < 1) return lerpS(dwellZ, endZ, (rC - b.hold) / (1 - b.hold));
  return endZ;
}

function stepEnvelope(env, now) {
  const elapsed = now - env.startTime;
  const rawT = env.durationMs > 0 ? Math.min(1, elapsed / env.durationMs) : 1;
  const hasXY = Math.abs((env.endX ?? 0) - (env.startX ?? 0)) > 0.5
             || Math.abs((env.endY ?? 0) - (env.startY ?? 0)) > 0.5;
  const xyDist = Math.hypot((env.endX ?? 0) - (env.startX ?? 0), (env.endY ?? 0) - (env.startY ?? 0));

  // Arm-wide Z + shared XY window.
  const armPeakZ = env.startZ != null && env.endZ != null
    ? safeTravelZ3d(env.startZ, env.endZ, env.traverseZ)
    : 0;
  const b = env.startZ != null && env.endZ != null
    ? computePhaseBoundaries3d(env.startZ, env.endZ, env.dwellZ, armPeakZ, xyDist, env.durationMs, hasXY)
    : { retract: 0, travel: hasXY ? 1 : 0, descend: 1, hold: 1 };
  const xyFrac = rawT <= b.retract ? 0
               : rawT >= b.travel ? 1
               : b.travel > b.retract ? (rawT - b.retract) / (b.travel - b.retract) : 1;
  const xyT = sample3dSmooth(xyFrac);

  const z = env.startZ != null && env.endZ != null
    ? sampleZFromPhases3d(rawT, env.startZ, env.endZ, env.dwellZ, armPeakZ, b)
    : 0;

  // Per-channel arrays follow the shared XY window but each channel's Z
  // uses its own safeTravelZ so mixed depths (plate A shallow, plate B
  // deep) land at the right per-channel Z.
  let y_ch = null, z_ch = null;
  if (Array.isArray(env.startY_ch) && Array.isArray(env.endY_ch)) {
    y_ch = new Array(env.startY_ch.length);
    for (let i = 0; i < y_ch.length; i++) {
      y_ch[i] = env.startY_ch[i] + (env.endY_ch[i] - env.startY_ch[i]) * xyT;
    }
  }
  if (Array.isArray(env.startZ_ch) && Array.isArray(env.endZ_ch)) {
    z_ch = new Array(env.startZ_ch.length);
    for (let i = 0; i < z_ch.length; i++) {
      const s0 = env.startZ_ch[i];
      const s1 = env.endZ_ch[i];
      const dwell = env.dwellZ_ch != null ? env.dwellZ_ch[i] : env.dwellZ;
      const chPeak = safeTravelZ3d(s0, s1, env.traverseZ);
      z_ch[i] = sampleZFromPhases3d(rawT, s0, s1, dwell, chPeak, b);
    }
  }

  return {
    x: lerp(env.startX, env.endX, xyT),
    y: lerp(env.startY, env.endY, xyT),
    z,
    y_ch,
    z_ch,
    rotation: env.startRotation != null && env.endRotation != null
      ? lerp(env.startRotation, env.endRotation, sample3dSmooth(rawT))
      : null,
    gripWidth: env.startGripWidth != null && env.endGripWidth != null
      ? lerp(env.startGripWidth, env.endGripWidth, sample3dSmooth(rawT))
      : null,
    done: rawT >= 1,
  };
}

// Exponential snap so arms always converge to their resting target even
// when the latest envelope finishes slightly short of it.
function ease(curr, tgt, k = 0.25) { return curr + (tgt - curr) * k; }

const live = {
  pip:      { x: 0, y: 0, z: 0 },
  iswap:    { x: 0, y: 0, z: 0, rot: 0, grip: 0 },
  h96:      { x: 0, y: 0, z: 0 },
  h384:     { x: 0, y: 0, z: 0 },
};

function tick() {
  requestAnimationFrame(tick);
  const now = Date.now();

  // PIP --------------------------------------------------------------------
  {
    const env = active.get('pip');
    let x, y, z, yArr, zArr;
    if (env) {
      const p = stepEnvelope(env, now);
      x = p.x; y = p.y; z = p.z;
      // Per-channel arrays drive the live pin Y/Z spread. When the
      // envelope provides them we use them; when it doesn't (older
      // traces, iSWAP/h96/h384) we fall back to the static target
      // arrays from the /state snapshot.
      yArr = p.y_ch ?? target.pip.yArr;
      zArr = p.z_ch ?? target.pip.zArr;
      if (p.done) active.delete('pip');
    } else {
      x = ease(live.pip.x, target.pip.x);
      y = ease(live.pip.y, target.pip.y);
      z = ease(live.pip.z, target.pip.z);
      yArr = target.pip.yArr;
      zArr = target.pip.zArr;
    }
    live.pip.x = x; live.pip.y = y; live.pip.z = z;
    placePip(arms.pip, x, y, z, zArr, yArr);
  }

  // iSWAP ------------------------------------------------------------------
  {
    const env = active.get('iswap');
    let x, y, z, rot, grip;
    if (env) {
      const p = stepEnvelope(env, now);
      x = p.x; y = p.y; z = p.z;
      rot = p.rotation ?? target.iswap.rot;
      grip = p.gripWidth ?? target.iswap.grip;
      if (p.done) active.delete('iswap');
    } else {
      x = ease(live.iswap.x, target.iswap.x);
      y = ease(live.iswap.y, target.iswap.y);
      z = ease(live.iswap.z, target.iswap.z);
      rot = ease(live.iswap.rot, target.iswap.rot);
      grip = ease(live.iswap.grip, target.iswap.grip);
    }
    Object.assign(live.iswap, { x, y, z, rot, grip });
    placeISwap(arms.iswap, x, y, z, rot, grip);
  }

  // H96, H384 --------------------------------------------------------------
  for (const key of ['h96', 'h384']) {
    const env = active.get(key);
    let x, y, z;
    if (env) {
      const p = stepEnvelope(env, now);
      x = p.x; y = p.y; z = p.z;
      if (p.done) active.delete(key);
    } else {
      x = ease(live[key].x, target[key].x);
      y = ease(live[key].y, target[key].y);
      z = ease(live[key].z, target[key].z);
    }
    live[key] = { x, y, z };
    placeHead(arms[key], x, y, z);
  }

  // Autoload ---------------------------------------------------------------
  placeAutoload(arms.autoload, target.autoload.track,
    target.autoload.trackPitch ?? 22.5, target.autoload.xOffset ?? 100);

  // HUD --------------------------------------------------------------------
  updateHud();

  // Trajectories — fade out lines after their envelopes complete.
  tickTrajectories(now);

  controls.update();
  renderer.render(scene, camera);
}

function fmtMm(tenths) {
  if (!Number.isFinite(tenths)) return '—';
  return (tenths / 10).toFixed(1);
}
function updateHud() {
  $('pipX').textContent = fmtMm(live.pip.x);
  $('pipY').textContent = fmtMm(live.pip.y);
  $('pipZ').textContent = fmtMm(live.pip.z);
  $('iswapX').textContent = fmtMm(live.iswap.x);
  $('iswapY').textContent = fmtMm(live.iswap.y);
  $('iswapZ').textContent = fmtMm(live.iswap.z);
  $('h96X').textContent = fmtMm(live.h96.x);
  $('h96Y').textContent = fmtMm(live.h96.y);
  $('h96Z').textContent = fmtMm(live.h96.z);
  $('h384X').textContent = fmtMm(live.h384.x);
  $('h384Y').textContent = fmtMm(live.h384.y);
  $('h384Z').textContent = fmtMm(live.h384.z);
  $('alX').textContent = target.autoload.track || '—';
}

// ---------------------------------------------------------------- UI wiring
// Chassis offset sliders — calibrate by eye without a rebuild. Once a
// good set is found, bake into CHASSIS_OFFSET and hide this panel.
function wireOffsetSlider(axis, labelId, sliderId) {
  const el = document.getElementById(sliderId);
  const lbl = document.getElementById(labelId);
  if (!el || !lbl) return;
  el.addEventListener('input', () => {
    const v = Number(el.value);
    lbl.textContent = v;
    chassisPivot.position[axis] = v;
  });
}
wireOffsetSlider('x', 'offXv', 'offX');
wireOffsetSlider('y', 'offYv', 'offY');
wireOffsetSlider('z', 'offZv', 'offZ');

modelSel.addEventListener('change', (e) => loadChassis(e.target.value));

$('wf').addEventListener('change', applyWireframe);
$('grid').addEventListener('change', (e) => grid.visible = e.target.checked);
$('axes').addEventListener('change', (e) => axes.visible = e.target.checked);
$('ghost').addEventListener('change', (e) => {
  for (const g of Object.values(ghosts)) g.visible = e.target.checked;
});

function applyWireframe() {
  const on = $('wf').checked;
  if (!chassisRoot) return;
  chassisRoot.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach((m) => { m.wireframe = on; });
  });
}

// ---------------------------------------------------------------- go
loadChassis('star_deck');
bootstrap();
connectSSE();
tick();

// Debug hook — exposes the three.js scene, camera, arms, and trajectory
// lines so the dev console (and tests) can inspect. Safe to leave in —
// costs nothing unless someone goes looking for it.
window.__STAR3D__ = {
  scene, camera, renderer, controls,
  chassisPivot, deckLayer, arms, ghosts,
  trajectoryGroup, trajectoryLines,
  target, live, active,
};
