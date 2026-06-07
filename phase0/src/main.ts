import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { voxelize, type VoxelGrid } from './voxelize';
import { quantizeByNormal, quantizeByTopology, type Arrangement } from './quantize';
import { quantizeMultiPass, type BeamPlacement, type PlatePlacement } from './multipass';
import { KIT } from './kit';
import { renderVoxelCubes, renderArrangement, renderMesh, renderBeams, renderPlates } from './render';
import { buildStateSummary, postState } from './state';
import { loadLDrawManifest, renderLDrawGallery, renderLDrawPlacements, type LDrawPart } from './ldraw';
import { placeLDrawParts, type LDrawPlacement } from './ldraw_fitter';
import { checkPhysics, findHiddenPlacements, computeAdjacency, type PhysicsCheck, type AdjacencyBond } from './physics';
import { voxelKey } from './voxelize';

const container = document.getElementById('app') as HTMLDivElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const resInput = document.getElementById('res') as HTMLInputElement;
const resLabel = document.getElementById('resLabel') as HTMLSpanElement;
const quantizerSelect = document.getElementById('quantizer') as HTMLSelectElement;
const smoothingCheckbox = document.getElementById('smoothing') as HTMLInputElement;
const coloringSelect = document.getElementById('coloring') as HTMLSelectElement;
const rerunButton = document.getElementById('rerun') as HTMLButtonElement;
const explodeButton = document.getElementById('explode') as HTMLButtonElement;
const crashButton = document.getElementById('crash') as HTMLButtonElement;
const layerSlider = document.getElementById('layerSlider') as HTMLInputElement;
const layerLabel = document.getElementById('layerLabel') as HTMLSpanElement;
const statsDiv = document.getElementById('stats') as HTMLDivElement;
const legendDiv = document.getElementById('legend') as HTMLDivElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);

// Perspective camera for a studio "model render" look. FOV chosen narrow-ish
// (35°) so the model reads close to a long-lens product shot — flatter than
// human-eye perspective but still depth-aware. Positioned over the model
// looking down-front; orbit controls let the user rotate.
const aspect = container.clientWidth / container.clientHeight;
const camera = new THREE.PerspectiveCamera(35, aspect, 0.1, 500);
camera.position.set(55, 38, 55);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

// Neutral studio environment, applied ONLY to the original-mesh view —
// TRELLIS-exported materials usually have metalness > 0 and render almost
// black without something to reflect. Lego/voxel views use solid-colour
// MeshStandardMaterial with metalness ≈ 0 where the env map isn't needed
// and would just wash out the studio lighting we already set up. The
// render() function toggles scene.environment based on view mode.
const pmrem = new THREE.PMREMGenerator(renderer);
const meshEnvTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 10;
controls.maxDistance = 200;

// Three-light studio rig.
//
// Key: warm-white directional from up-front-right, casts shadows. Tuned to
// cover a ~70-unit cube centred at origin — large enough for any reasonable
// model at our grid sizes without wasting shadow-map resolution.
//
// Fill: cool ambient-ish directional from the opposite side, softens the
// shadowed side so detail stays readable.
//
// Hemisphere: sky→ground gradient ambient for a subtle global term.
scene.add(new THREE.HemisphereLight(0xc4d4e8, 0x404048, 0.35));

const key = new THREE.DirectionalLight(0xfff4e0, 1.15);
key.position.set(40, 60, 30);
key.castShadow = true;
// Bigger shadow camera so crash-dispersed pieces still cast shadows when
// they fly outward — without this the floor "disappears" past ±40 because
// the ShadowMaterial only renders within the directional light's shadow
// frustum. 4K shadow map keeps detail crisp across the wider area
// (~20 texels per world unit at 200×200 coverage).
key.shadow.mapSize.set(4096, 4096);
key.shadow.camera.near = 1;
key.shadow.camera.far = 500;
key.shadow.camera.left = -100;
key.shadow.camera.right = 100;
key.shadow.camera.top = 100;
key.shadow.camera.bottom = -100;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
key.shadow.radius = 4;
scene.add(key);

const fill = new THREE.DirectionalLight(0x90b0d8, 0.4);
fill.position.set(-30, 10, -20);
scene.add(fill);

// Soft bounce light from below — brings up the dark undersides of bricks
// without overpowering the key. No shadows; this is just a fill-from-below
// simulation of light reflecting off the ground.
const underLight = new THREE.DirectionalLight(0xfff0d8, 0.35);
underLight.position.set(0, -40, 5);
scene.add(underLight);

// Ground plane purely for catching shadows — transparent except for the
// shadow itself, so the model appears to float on a soft contact shadow
// without a visible floor disc.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.ShadowMaterial({ opacity: 0.35 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

// Y squash constant — 8 LDU plate / 20 LDU stud = 0.4. NOT applied to the
// renderGroup any more; instead it's baked into each renderer's instance
// matrices / box geometries so rotation composes correctly through it
// (T·R·S with S = (1, 0.4, 1) for instance matrices, vs the previous
// non-uniform parent scale that distorted rotated geometry).
const Y_SQUASH = 0.4;
const renderGroup = new THREE.Group();
renderGroup.scale.set(1, 1, 1);
scene.add(renderGroup);

let currentMesh: THREE.Mesh | null = null;
let currentMeshSource = 'default torus knot';
let currentVoxelGrid: VoxelGrid | null = null;
let currentArrangement: Arrangement | null = null;
let currentBeams: BeamPlacement[] = [];
let currentPlates: PlatePlacement[] = [];
let ldrawParts: LDrawPart[] | null = null;
let ldrawLoadAttempted = false;
let currentLDrawPlacements: LDrawPlacement[] = [];
let currentPhysics: PhysicsCheck = { floating: new Set(), floatingCells: 0 };
let currentHiddenFlags: boolean[] = [];
let currentAdjacency: AdjacencyBond[] = [];

function clearRenderGroup() {
  for (const child of [...renderGroup.children]) {
    renderGroup.remove(child);
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && mesh.geometry !== (child as THREE.InstancedMesh).geometry) {
      // InstancedMeshes share kit geometries — don't dispose those
    }
    const isInstanced = (child as THREE.InstancedMesh).isInstancedMesh;
    if (!isInstanced && mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    }
  }
}

function setStats(...lines: string[]) {
  statsDiv.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}

function setLegend(arrangement: Arrangement | null) {
  if (!arrangement || modeSelect.value !== 'quantized') {
    legendDiv.innerHTML = '';
    return;
  }
  const counts = new Map<number, number>();
  for (const inst of arrangement) counts.set(inst.blockIndex, (counts.get(inst.blockIndex) ?? 0) + 1);
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([blockIndex, count]) => {
      const block = KIT[blockIndex];
      const hex = '#' + block.color.toString(16).padStart(6, '0');
      return `<div class="row"><span class="swatch" style="background:${hex}"></span>${block.name} · ${count}</div>`;
    })
    .join('');
  legendDiv.innerHTML = rows;
}

function defaultMesh(): THREE.Mesh {
  // Procedural placeholder so the app shows something on first load.
  const geom = new THREE.TorusKnotGeometry(8, 2.5, 100, 16);
  return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0x88aacc }));
}

async function loadFromFile(file: File): Promise<THREE.Mesh> {
  const buf = await file.arrayBuffer();
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      buf,
      '',
      (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        let found: THREE.Mesh | null = null;
        gltf.scene.traverse((obj) => {
          if (!found && (obj as THREE.Mesh).isMesh) found = obj as THREE.Mesh;
        });
        if (!found) reject(new Error('No mesh found in file'));
        else resolve(found);
      },
      (err) => reject(err),
    );
  });
}

function runPipeline() {
  if (!currentMesh) return;
  const resolution = parseInt(resInput.value, 10);

  const t0 = performance.now();
  currentVoxelGrid = voxelize(currentMesh, resolution);
  const tVox = performance.now() - t0;

  const useSmooth = smoothingCheckbox.checked;
  const t1 = performance.now();
  currentBeams = [];
  currentPlates = [];
  currentLDrawPlacements = [];
  currentPhysics = { floating: new Set(), floatingCells: 0 };
  currentHiddenFlags = [];
  currentAdjacency = [];
  if (quantizerSelect.value === 'ldraw') {
    if (ldrawParts) {
      const fit = placeLDrawParts(currentVoxelGrid, ldrawParts);
      currentLDrawPlacements = fit.placements;
      currentPhysics = checkPhysics(fit.placements);
      // Single-cell fallback for any cells the LDraw kit couldn't claim
      currentArrangement = quantizeByTopology(currentVoxelGrid, KIT, useSmooth, fit.claimed);
      // Hidden-block optimisation: any placement whose every external face
      // touches another covered cell (LDraw piece OR kit-block fallback) is
      // never visible from outside, so we mark it so the layer slider can
      // skip rendering it until it's exposed by slicing.
      const arrCells = new Set<string>();
      for (const a of currentArrangement) {
        arrCells.add(voxelKey(a.position.x, a.position.y, a.position.z));
      }
      currentHiddenFlags = findHiddenPlacements(currentLDrawPlacements, arrCells);
      currentAdjacency = computeAdjacency(currentLDrawPlacements);
    } else {
      // Parts not loaded yet — trigger the load and re-run when ready.
      if (!ldrawLoadAttempted) {
        ldrawLoadAttempted = true;
        void loadLDrawManifest()
          .then((parts) => {
            ldrawParts = parts;
            if (quantizerSelect.value === 'ldraw') runPipeline();
          })
          .catch((err) => {
            console.error('[ldraw] manifest load failed:', err);
            setStats(`ldraw load failed: ${(err as Error).message}`);
          });
      }
      currentArrangement = quantizeByTopology(currentVoxelGrid, KIT, useSmooth);
    }
  } else if (quantizerSelect.value === 'multipass') {
    const mp = quantizeMultiPass(currentVoxelGrid, KIT, useSmooth);
    currentArrangement = mp.arrangement;
    currentBeams = mp.beams;
    currentPlates = mp.plates;
  } else if (quantizerSelect.value === 'normal') {
    currentArrangement = quantizeByNormal(currentVoxelGrid, KIT);
  } else {
    currentArrangement = quantizeByTopology(currentVoxelGrid, KIT, useSmooth);
  }
  const tQuant = performance.now() - t1;

  render();

  const usedBlocks = new Set(currentArrangement.map((a) => a.blockIndex)).size;
  const statLines = [
    `resolution · ${resolution}³`,
    `voxels    · ${currentVoxelGrid.occupied.size}`,
    `voxelize  · ${tVox.toFixed(1)} ms`,
    `quantize  · ${tQuant.toFixed(1)} ms`,
    `blocks    · ${usedBlocks} / ${KIT.length}`,
  ];
  if (currentLDrawPlacements.length > 0) {
    const pct = (100 * currentPhysics.floating.size / currentLDrawPlacements.length).toFixed(1);
    statLines.push(`physics   · ${currentPhysics.floating.size} floating / ${currentLDrawPlacements.length} (${pct}%)`);
  }
  setStats(...statLines);

  const summary = buildStateSummary({
    source: currentMeshSource,
    grid: currentVoxelGrid,
    arrangement: currentArrangement,
    beams: currentBeams,
    plates: currentPlates,
    ldrawPlacements: currentLDrawPlacements,
    kit: KIT,
    quantizer: quantizerSelect.value,
    smoothing: smoothingCheckbox.checked,
    view: modeSelect.value,
    coloring: coloringSelect.value,
  });
  void postState(summary);
}

function render() {
  if (!currentMesh) return;
  clearRenderGroup();
  // Reset explode state — new InstancedMeshes start with fresh matrices,
  // old WeakMap entries get GC'd along with their meshes. Any in-flight
  // physics world is freed so we don't keep stale colliders around.
  explodeMode = 'idle';
  if (eventQueue) { eventQueue.free(); eventQueue = null; }
  if (physicsWorld) { physicsWorld.free(); physicsWorld = null; }
  groundBody = null;
  pendingBreaks.clear();
  brokenBodies.clear();
  bodyToPlacements.clear();
  isCrashSim = false;
  const mode = modeSelect.value;
  // Env map only lights the original mesh — Lego/voxel views use their own
  // studio rig and the env wash makes them feel "ambient-blasted".
  scene.environment = mode === 'mesh' ? meshEnvTexture : null;
  if (mode === 'mesh') {
    renderMesh(renderGroup, currentMesh, currentVoxelGrid?.size ?? 32);
  } else if (mode === 'voxels' && currentVoxelGrid) {
    renderVoxelCubes(renderGroup, currentVoxelGrid);
  } else if (mode === 'quantized' && currentArrangement && currentVoxelGrid) {
    renderArrangement(
      renderGroup,
      currentArrangement,
      currentVoxelGrid.size,
      currentVoxelGrid.sizeY,
      KIT,
      coloringSelect.value === 'bytype',
      currentVoxelGrid.colors,
    );
    if (currentPlates.length > 0) {
      renderPlates(renderGroup, currentPlates, currentVoxelGrid.size, currentVoxelGrid.sizeY);
    }
    if (currentBeams.length > 0) {
      renderBeams(renderGroup, currentBeams, currentVoxelGrid.size, currentVoxelGrid.sizeY);
    }
    if (currentLDrawPlacements.length > 0 && ldrawParts) {
      renderLDrawPlacements(
        renderGroup,
        currentLDrawPlacements,
        ldrawParts,
        currentVoxelGrid.size,
        currentVoxelGrid.sizeY,
        coloringSelect.value === 'bytype',
        currentVoxelGrid.colors,
        coloringSelect.value === 'physics' ? currentPhysics.floating : undefined,
        currentHiddenFlags,
      );
    }
  } else if (mode === 'ldraw') {
    if (ldrawParts) {
      renderLDrawGallery(renderGroup, ldrawParts);
    } else if (!ldrawLoadAttempted) {
      ldrawLoadAttempted = true;
      void loadLDrawManifest()
        .then((parts) => {
          ldrawParts = parts;
          setStats(`ldraw: ${parts.length} parts loaded`);
          if (modeSelect.value === 'ldraw') render();
        })
        .catch((err) => {
          setStats(`ldraw load failed: ${(err as Error).message}`);
          console.error('[ldraw] manifest load failed:', err);
        });
      setStats('ldraw: loading manifest…');
    }
  }
  setLegend(currentArrangement);
  recalibrateGround();
  refreshLayerBounds();
}

// Slide the shadow-catcher plane up to sit just under the rendered model's
// lowest point so the contact shadow always lands directly beneath the
// bricks. Without this the floor sits at world Y=0 and floats above or
// below the model depending on the chosen view / grid size / smoothing.
const _bbox = new THREE.Box3();
function recalibrateGround(): void {
  if (renderGroup.children.length === 0) return;
  renderGroup.updateMatrixWorld(true);
  _bbox.makeEmpty().setFromObject(renderGroup);
  if (Number.isFinite(_bbox.min.y)) {
    ground.position.y = _bbox.min.y - 0.05;
  }
}

// Instance transforms — every InstancedMesh's per-instance matrices get
// rewritten each tick. When idle, applyTransforms applies layer-mask
// hiding. When exploding, Rapier steps the physics world and we sync
// rigid-body transforms back into the matrices. When reassembling,
// stepReassemble lerps each piece's stored final position back to its
// cached original.
const instanceMatrices = new WeakMap<THREE.InstancedMesh, THREE.Matrix4[]>();
const instancePositions = new WeakMap<THREE.InstancedMesh, Float32Array>();
const instanceRotations = new WeakMap<THREE.InstancedMesh, Float32Array>();

type ExplodeMode = 'idle' | 'crashLifting' | 'exploding' | 'reassembling';
let explodeMode: ExplodeMode = 'idle';
let lastFrameTime = performance.now();

// Crash mode lift+tilt animation. Phase 1: lerp every instance matrix from
// its cached original to (crashRotation · pos + crashLiftAmount on Y) over
// ~0.6s with no physics — model rises and tilts visibly. Phase 2 (on
// completion): spawn Rapier bodies at the end-of-lift state, switch mode
// to 'exploding' so gravity takes over.
const crashRotation = new THREE.Quaternion();
let crashLiftAmount = 0;
let crashLiftStartTime = 0;
const CRASH_LIFT_DURATION_S = 0.6;

// Rapier physics world + per-instance body refs. The world is recreated
// each time the user detonates and freed when reassembly completes.
// rapierReady is flipped true once the async WASM init finishes; the
// explode button stays disabled until then.
let physicsWorld: RAPIER.World | null = null;
// Body per instance — for clustered LDraw pieces, many instances share a
// single body (compound rigid body with one collider per piece). Local
// offset + local rotation per instance store the piece's pose relative to
// its body's origin; world pose = body.translation + body.rotation·offset.
const instanceBodies = new WeakMap<THREE.InstancedMesh, RAPIER.RigidBody[]>();
const instanceYCenter = new WeakMap<THREE.InstancedMesh, Float32Array>();
const instanceLocalOffset = new WeakMap<THREE.InstancedMesh, Float32Array>();   // xyz × count
const instanceLocalRotation = new WeakMap<THREE.InstancedMesh, Float32Array>(); // xyzw × count

// Crash-mode dynamic breaking state. The model falls as one giant compound
// body (high K_FALL). On first ground contact, the body splits into pre-
// computed impact-cluster sub-bodies that inherit velocity + scatter from
// the impact point. Each sub-body's pieces share the same impact_cluster_id
// so they can't split further.
let groundBody: RAPIER.RigidBody | null = null;
let eventQueue: RAPIER.EventQueue | null = null;
const pendingBreaks = new Set<RAPIER.RigidBody>();
const brokenBodies = new Set<RAPIER.RigidBody>();
const bodyToPlacements = new Map<RAPIER.RigidBody, number[]>();
let placementToInstance: Array<{ mesh: THREE.InstancedMesh; idx: number } | null> = [];
let placementToBody: Array<RAPIER.RigidBody | null> = [];
// Per-placement offset in its body's LOCAL frame — same value that was
// passed to the collider's setTranslation in Stage 3. Stage 4 needs this
// to avoid trying to derive it from `body.translation()`, which is in
// world frame and includes the crash lift/rotation, so the difference
// `p.wx − bt.x` does NOT equal the collider's body-local x for crash.
let placementToLocalOffset: Float32Array | null = null;
let impactClusterId: Int32Array | null = null;
let isCrashSim = false;
let rapierReady = false;
explodeButton.disabled = true;
crashButton.disabled = true;
explodeButton.textContent = '💥 Explode (loading…)';
crashButton.textContent = '🪨 Crash (loading…)';
RAPIER.init().then(() => {
  rapierReady = true;
  explodeButton.disabled = false;
  explodeButton.textContent = '💥 Explode';
  crashButton.disabled = false;
  crashButton.textContent = '🪨 Crash';
});

let layerCutoff = Number.POSITIVE_INFINITY;
let layerMax = 0;

function cacheOriginals(inst: THREE.InstancedMesh): THREE.Matrix4[] {
  let cached = instanceMatrices.get(inst);
  if (!cached) {
    cached = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m);
      cached.push(m.clone());
    }
    instanceMatrices.set(inst, cached);
  }
  return cached;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const HIDDEN_SCALE = 1e-6;

function applyTransforms(): void {
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const originals = cacheOriginals(inst);
    const layers = inst.userData.layers as number[] | undefined;
    const hidden = inst.userData.hidden as boolean[] | undefined;
    for (let i = 0; i < originals.length; i++) {
      _m.copy(originals[i]);
      _m.decompose(_v, _q, _s);
      // Visibility rules — layer is the piece's anchor.y in cell coords:
      //   1. layer > cutoff       → cut away by the slider's primary slice
      //   2. hidden && layer < cutoff → interior optimisation; the piece is
      //      completely enclosed by other covered cells, so we skip it until
      //      the slider exposes its layer (slider at == layer reveals it)
      const layer = layers ? layers[i] : 0;
      const isHidden = hidden ? hidden[i] : false;
      const sliced = layers !== undefined && layer > layerCutoff;
      const enclosed = isHidden && layer < layerCutoff;
      if (sliced || enclosed) {
        _s.setScalar(HIDDEN_SCALE);
      }
      _m.compose(_v, _q, _s);
      inst.setMatrixAt(i, _m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
}

// Walk all InstancedMeshes to find the highest layer (anchor.y in cell
// coords) and map the slider's integer range onto [0, maxLayer]. Called
// right after each render() once the new meshes exist.
function refreshLayerBounds(): void {
  let maxLayer = 0;
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const layers = inst.userData.layers as number[] | undefined;
    if (!layers) continue;
    for (const l of layers) if (l > maxLayer) maxLayer = l;
  }
  layerMax = maxLayer;
  layerSlider.max = String(maxLayer);
  layerSlider.value = String(maxLayer);
  layerCutoff = Number.POSITIVE_INFINITY;
  layerLabel.textContent = 'all';
  applyTransforms();
}

layerSlider.addEventListener('input', () => {
  const v = parseInt(layerSlider.value, 10);
  if (v >= layerMax) {
    layerCutoff = Number.POSITIVE_INFINITY;
    layerLabel.textContent = 'all';
  } else {
    layerCutoff = v;
    layerLabel.textContent = String(v);
  }
  applyTransforms();
});

// Build a fresh Rapier world, decide which adjacency bonds hold, group
// pieces into clusters, and create ONE compound rigid body per cluster
// (with N colliders attached to it, one per piece in the cluster). No
// joints. Joints between rigid colliders create constraint chains that
// Rapier's iterative solver can't resolve in finite iterations → jitter
// → cascading forces. Compound bodies are a single rigid object — zero
// internal constraints — so chunks fly as truly rigid blobs.
//
// Coords: Rapier simulates in WORLD space. Pieces live inside renderGroup
// which Y-squashes everything by 0.4, so per-instance state stores its
// local→world conversion offset (yCenter) plus the offset and rotation of
// each instance relative to its (possibly shared) body's origin.
type ExplodeKind = 'explode' | 'crash';

function initExplodePhysics(mode: ExplodeKind = 'explode'): void {
  // Discard any previous world (e.g., user re-detonating mid-reassembly).
  if (eventQueue) { eventQueue.free(); eventQueue = null; }
  if (physicsWorld) { physicsWorld.free(); physicsWorld = null; }
  groundBody = null;

  const isCrash = mode === 'crash';
  physicsWorld = new RAPIER.World({ x: 0, y: -30, z: 0 });

  // Crash mode: lift + tilt come from module-scope `crashRotation` and
  // `crashLiftAmount`, set by `detonate('crash')` at the START of phase 1
  // (the animated lift). By the time we get here phase 1 has finished and
  // pieces' rendered matrices already reflect the lifted/tilted pose, so
  // we spawn bodies at exactly that pose with zero discontinuity.
  const CRASH_LIFT = crashLiftAmount;
  const crashRot = crashRotation;

  // Static ground — large in X/Z so nothing flies off the edge, AND deep
  // in Y so fast-falling crash bodies can't tunnel through it in a single
  // timestep (impact velocity after a 45-unit drop is ~50 m/s; at 60fps
  // that's ~1 unit per frame — a thin 1-unit-deep slab is barely thicker
  // than the per-step motion, so bodies were occasionally leapfrogging
  // past it). Half-extent 50 in Y kills any tunneling. Translation puts
  // the top face at ground.position.y to match the shadow plane.
  const groundDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(0, ground.position.y - 50, 0);
  groundBody = physicsWorld.createRigidBody(groundDesc);
  const groundColDesc = RAPIER.ColliderDesc.cuboid(200, 50, 200)
    .setRestitution(isCrash ? 0.35 : 0.05)
    .setFriction(isCrash ? 0.5 : 0.95);
  if (isCrash) groundColDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  physicsWorld.createCollider(groundColDesc, groundBody);

  // Event queue — populated by world.step in crash mode. Created fresh per
  // detonation, freed in captureFinalPosesAndFreeWorld.
  eventQueue = isCrash ? new RAPIER.EventQueue(true) : null;

  // === Stage 1: decide which adjacency bonds hold, then cluster ===
  //
  // K controls average chunk size: higher → bigger chunks (more bonds
  // survive). 0.15 gives mostly-singles with occasional pairs / triples.
  // 0.25 small handfuls; 0.5 medium clumps; 0.8+ big slabs.
  // Crash gets TWO clusterings:
  //   K_FALL = 2.0 — almost every bond holds → the model falls as one
  //                  giant compound body (or a few big chunks).
  //   K_IMPACT = 0.25 — finer clustering used to pre-decide HOW the giant
  //                     body will split when it hits the ground. Stored
  //                     per-placement in `impactClusterId` for the run-time
  //                     splitter to consult on contact.
  const K_FALL = isCrash ? 2.0 : 0.20;
  const K_IMPACT = 0.25;
  const ADJACENCY_BOND_K = K_FALL;
  const heldBonds: AdjacencyBond[] = [];
  for (const bond of currentAdjacency) {
    const probHold = 1 - Math.exp(-bond.sharedFaces * ADJACENCY_BOND_K);
    if (Math.random() <= probHold) heldBonds.push(bond);
  }

  // Union-find clusters across the LDraw placements.
  const N = currentLDrawPlacements.length;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (const bond of heldBonds) {
    const ra = find(bond.a), rb = find(bond.b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Crash-mode impact clustering — second union-find over a fresh random
  // sample with K_IMPACT. The result tells the run-time impact splitter
  // which placements should end up in the same sub-body after each fall
  // body is broken. We collapse all roots to canonical IDs so equality
  // tests during splitting are simple integer comparisons.
  if (isCrash) {
    const impactParent = new Int32Array(N);
    for (let i = 0; i < N; i++) impactParent[i] = i;
    const findImpact = (x: number): number => {
      while (impactParent[x] !== x) { impactParent[x] = impactParent[impactParent[x]]; x = impactParent[x]; }
      return x;
    };
    for (const bond of currentAdjacency) {
      const probHold = 1 - Math.exp(-bond.sharedFaces * K_IMPACT);
      if (Math.random() > probHold) continue;
      const ra = findImpact(bond.a), rb = findImpact(bond.b);
      if (ra !== rb) impactParent[ra] = rb;
    }
    impactClusterId = new Int32Array(N);
    for (let i = 0; i < N; i++) impactClusterId[i] = findImpact(i);
  } else {
    impactClusterId = null;
  }

  // Reset crash run-time state. Bookkeeping is rebuilt below; bodies will
  // be assigned in stages 3 + 4.
  pendingBreaks.clear();
  brokenBodies.clear();
  bodyToPlacements.clear();
  placementToInstance = new Array(N).fill(null);
  isCrashSim = isCrash;

  // === Stage 2: walk meshes to gather per-instance world poses ===
  //
  // We need each piece's world position before we can build cluster
  // centroids and collider offsets. Stash them by placement index for
  // LDraw pieces; non-LDraw pieces (no placementIdx) get handled
  // separately in stage 4.
  type Pose = { wx: number; wy: number; wz: number; q: THREE.Quaternion; w: number; h: number; d: number; yCenter: number };
  const placementPose = new Array<Pose | null>(N).fill(null);
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const placementIdx = inst.userData.placementIdx as number[] | undefined;
    if (!placementIdx) continue;
    const originals = cacheOriginals(inst);
    const fW = inst.userData.footprintW as number[] | undefined;
    const fD = inst.userData.footprintD as number[] | undefined;
    const fH = inst.userData.footprintH as number[] | undefined;
    const bOff = inst.userData.bottomOffset as number[] | undefined;
    for (let i = 0; i < originals.length; i++) {
      _m.copy(originals[i]);
      _m.decompose(_v, _q, _s);
      const w = fW?.[i] ?? 1;
      const d = fD?.[i] ?? 1;
      const h = fH?.[i] ?? 1;
      // yCenter expressed in WORLD units so we can add it directly to the
      // matrix Y (which is now also in world frame). bottomOff + h/2 is
      // still in cells, multiplied by Y_SQUASH to convert.
      const yCenter = ((bOff?.[i] ?? -0.5) + h / 2) * Y_SQUASH;
      placementPose[placementIdx[i]] = {
        wx: _v.x,
        wy: _v.y + yCenter,
        wz: _v.z,
        q: _q.clone(),
        w, h, d, yCenter,
      };
    }
  }

  // Bonds-per-piece adjacency list, used for the connectivity sanity check
  // below (and only over held bonds — pieces only touch each other through
  // the bonds that survived stage 1).
  const bondsByPiece = new Map<number, number[]>();
  for (const b of heldBonds) {
    let la = bondsByPiece.get(b.a); if (!la) { la = []; bondsByPiece.set(b.a, la); }
    let lb = bondsByPiece.get(b.b); if (!lb) { lb = []; bondsByPiece.set(b.b, lb); }
    la.push(b.b); lb.push(b.a);
  }

  // === Stage 2.5: verify each cluster is fully face-touching ===
  //
  // Union-find produces connected components by construction, so this is
  // a defensive check. If anything has gone subtly wrong (mismatched bond
  // book-keeping, accidental cross-cluster union, etc.), pieces that
  // can't actually be reached from each other via held bonds get split
  // into their own cluster instead of being welded into one body.
  const initialClusters = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const root = find(i);
    let arr = initialClusters.get(root);
    if (!arr) { arr = []; initialClusters.set(root, arr); }
    arr.push(i);
  }
  const verifiedClusters: number[][] = [];
  for (const members of initialClusters.values()) {
    if (members.length === 1) { verifiedClusters.push(members); continue; }
    const remaining = new Set(members);
    while (remaining.size > 0) {
      const start = remaining.values().next().value as number;
      const reachable: number[] = [start];
      remaining.delete(start);
      // BFS through held bonds, only following bonds to pieces still in
      // this cluster's remaining set.
      let head = 0;
      while (head < reachable.length) {
        const cur = reachable[head++];
        for (const nb of bondsByPiece.get(cur) ?? []) {
          if (remaining.has(nb)) {
            remaining.delete(nb);
            reachable.push(nb);
          }
        }
      }
      verifiedClusters.push(reachable);
    }
  }

  // === Stage 3: bucket placements by cluster root, build one body per ===
  // Each cluster's body sits at its centroid (in world coords), starts at
  // identity rotation. Each piece in the cluster is added as a collider
  // offset by (piece_world_pos − centroid), rotated by the piece's start
  // rotation. The whole chunk is then ONE rigid body — no internal
  // constraints, no jitter.
  // Lookup from placement-index → cluster body, built as we iterate
  // verifiedClusters below. Used in stage 4 to wire each instance to its
  // chunk's compound body, and by the crash-mode impact splitter at run
  // time. Module-scope so the splitter can read/mutate it.
  placementToBody = new Array<RAPIER.RigidBody | null>(N).fill(null);
  placementToLocalOffset = new Float32Array(N * 3);

  for (const members of verifiedClusters) {
    // Centroid of the cluster's piece-centres in world coords.
    let cx = 0, cy = 0, cz = 0;
    for (const idx of members) {
      const p = placementPose[idx]!;
      cx += p.wx; cy += p.wy; cz += p.wz;
    }
    cx /= members.length; cy /= members.length; cz /= members.length;

    // Per-cluster impulse: radial outward from the model centre (origin),
    // upward kick. Shared by every collider in the body via the body's
    // own linvel — chunk translates as one rigid blob, no internal
    // velocity disagreement. Crash mode starts everything at rest; gravity
    // does all the work and the impact at the bottom of the fall decides
    // how things scatter.
    let vx = 0, vy = 0, vz = 0;
    let angX = 0, angY = 0, angZ = 0;
    if (!isCrash) {
      const baseAngle = Math.atan2(cz, cx) || Math.random() * Math.PI * 2;
      const angle = baseAngle + (Math.random() - 0.5) * 0.5;
      const radial = 4 + Math.random() * 6;
      vx = Math.cos(angle) * radial;
      vy = 6 + Math.random() * 8;
      vz = Math.sin(angle) * radial;
      angX = (Math.random() - 0.5) * 0.8;
      angY = (Math.random() - 0.5) * 0.8;
      angZ = (Math.random() - 0.5) * 0.8;
    }

    // In crash mode, lift the body up and tilt it on the random crashRot
    // axis. Centroid rotates around world origin (model is centred there)
    // and gets the lift added to Y; body's rotation becomes crashRot so
    // every collider inherits the tilt. Local offsets stay in body frame.
    let bx = cx, by = cy, bz = cz;
    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (isCrash) {
      const v = new THREE.Vector3(cx, cy, cz).applyQuaternion(crashRot);
      bx = v.x; by = v.y + CRASH_LIFT; bz = v.z;
      qx = crashRot.x; qy = crashRot.y; qz = crashRot.z; qw = crashRot.w;
    }
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(bx, by, bz)
      .setRotation({ x: qx, y: qy, z: qz, w: qw })
      .setLinvel(vx, vy, vz)
      .setAngvel({ x: angX, y: angY, z: angZ })
      // Heavy damping in both modes — crash relies on it to keep the model
      // visually intact during free-fall (low damping let adjacent bodies
      // drift apart from epsilon contact forces over the ~1.5s of fall).
      .setLinearDamping(0.5)
      .setAngularDamping(2.0);
    const body = physicsWorld.createRigidBody(desc);

    // Each piece becomes an axis-aligned box collider at its offset from
    // the cluster centroid. The collider dims are POST-rotation (footprint
    // W/D are already rotated values), so leaving the collider unrotated
    // gives the brick's actual world AABB. Rotating it would double-rotate
    // and shove neighbouring colliders apart.
    for (const idx of members) {
      const p = placementPose[idx]!;
      const hx = p.w / 2;
      const hy = (p.h / 2) * Y_SQUASH;
      const hz = p.d / 2;
      // Local offset in body-local frame. For non-crash, body translation
      // == centroid so this matches `p − bt`; for crash the body has been
      // lifted + rotated and `p − bt` is NOT in body-local frame, so we
      // save the centroid-relative offset directly here for Stage 4.
      const lox = p.wx - cx, loy = p.wy - cy, loz = p.wz - cz;
      const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(lox, loy, loz)
        .setRestitution(0.08)
        .setFriction(0.85)
        .setDensity(1.0);
      // Crash mode: collider fires collision events so the splitter knows
      // when a fall body touches the ground.
      if (isCrash) col.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      physicsWorld.createCollider(col, body);
      placementToBody[idx] = body;
      placementToLocalOffset![idx * 3]     = lox;
      placementToLocalOffset![idx * 3 + 1] = loy;
      placementToLocalOffset![idx * 3 + 2] = loz;
    }
    // Reverse map for the impact splitter (only need to populate it in
    // crash mode, but it's cheap to do unconditionally).
    bodyToPlacements.set(body, [...members]);
  }

  // === Stage 4: per-instance bookkeeping (body ref + local offset/rot) ===
  // For LDraw instances, body comes from cluster lookup, offset/rotation
  // place the collider in the cluster's local frame. For non-LDraw
  // instances (kit blocks, voxel cubes), each piece gets its own body
  // (no cluster) with identity offset and rotation = start rotation.
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const originals = cacheOriginals(inst);
    const placementIdx = inst.userData.placementIdx as number[] | undefined;
    const fW = inst.userData.footprintW as number[] | undefined;
    const fD = inst.userData.footprintD as number[] | undefined;
    const fH = inst.userData.footprintH as number[] | undefined;
    const bOff = inst.userData.bottomOffset as number[] | undefined;

    const bodies: RAPIER.RigidBody[] = new Array(originals.length);
    const yCenters = new Float32Array(originals.length);
    const offsets = new Float32Array(originals.length * 3);
    const rots = new Float32Array(originals.length * 4);

    for (let i = 0; i < originals.length; i++) {
      const w = fW?.[i] ?? 1;
      const d = fD?.[i] ?? 1;
      const h = fH?.[i] ?? 1;
      const bottomOff = bOff?.[i] ?? -0.5;
      // yCenter and the cached yCenters[i] are both in WORLD units now —
      // matrix Y is world after the squash-baking refactor, so we add this
      // directly without a further squash multiplication in the sync path.
      const yCenter = (bottomOff + h / 2) * Y_SQUASH;
      yCenters[i] = yCenter;

      if (placementIdx) {
        // LDraw piece — attach to its cluster's compound body via the
        // post-connectivity-check placementToBody lookup.
        const idx = placementIdx[i];
        const p = placementPose[idx]!;
        const body = placementToBody[idx]!;
        bodies[i] = body;
        // Reverse map for the impact splitter: which mesh+instance renders
        // each LDraw placement. Lets the splitter rewrite instanceBodies +
        // instanceLocalOffset when a body breaks into sub-bodies.
        placementToInstance[idx] = { mesh: inst, idx: i };
        // Body-local offset stored in Stage 3 alongside the collider's
        // setTranslation. For non-crash this equals `p.wx − body.translation`
        // since the body sits at the centroid; for crash the body has been
        // lifted + rotated, so we need the original centroid-relative
        // offset — NOT `p − body.translation`, which would be off by the
        // lift+rotation and decouple the rendered piece from its collider.
        offsets[i * 3]     = placementToLocalOffset![idx * 3];
        offsets[i * 3 + 1] = placementToLocalOffset![idx * 3 + 1];
        offsets[i * 3 + 2] = placementToLocalOffset![idx * 3 + 2];
        rots[i * 4]     = p.q.x;
        rots[i * 4 + 1] = p.q.y;
        rots[i * 4 + 2] = p.q.z;
        rots[i * 4 + 3] = p.q.w;
      } else {
        // Non-LDraw piece — own body at the piece's world position with
        // identity rotation (so the axis-aligned collider matches the
        // brick's post-rotation world AABB directly). The piece's start
        // rotation lives in localRotation, so rendered world rotation
        // = body.rotation · localRotation as physics tumbles the body.
        _m.copy(originals[i]);
        _m.decompose(_v, _q, _s);
        const wx = _v.x;
        const wy = _v.y + yCenter;
        const wz = _v.z;
        let vx = 0, vy = 0, vz = 0;
        let angX = 0, angY = 0, angZ = 0;
        if (!isCrash) {
          const baseAngle = Math.atan2(wz, wx) || Math.random() * Math.PI * 2;
          const angle = baseAngle + (Math.random() - 0.5) * 0.5;
          const radial = 4 + Math.random() * 6;
          vx = Math.cos(angle) * radial;
          vy = 6 + Math.random() * 8;
          vz = Math.sin(angle) * radial;
          angX = (Math.random() - 0.5) * 1.2;
          angY = (Math.random() - 0.5) * 1.2;
          angZ = (Math.random() - 0.5) * 1.2;
        }
        // Same crash lift + tilt as cluster bodies — body rotation is the
        // crash quaternion; piece.q stays in localRotation. World rotation
        // becomes body.rotation · localRotation = crashRot · piece.q so
        // the model reads as one tilted-and-lifted object.
        let bx = wx, by = wy, bz = wz;
        let qbx = 0, qby = 0, qbz = 0, qbw = 1;
        if (isCrash) {
          const v = new THREE.Vector3(wx, wy, wz).applyQuaternion(crashRot);
          bx = v.x; by = v.y + CRASH_LIFT; bz = v.z;
          qbx = crashRot.x; qby = crashRot.y; qbz = crashRot.z; qbw = crashRot.w;
        }
        const desc = RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(bx, by, bz)
          .setRotation({ x: qbx, y: qby, z: qbz, w: qbw })
          .setLinvel(vx, vy, vz)
          .setAngvel({ x: angX, y: angY, z: angZ })
          .setLinearDamping(0.15)
          .setAngularDamping(0.4);
        const body = physicsWorld.createRigidBody(desc);
        const hx = w / 2;
        const hy = (h / 2) * Y_SQUASH;
        const hz = d / 2;
        const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setRestitution(0.25)
          .setFriction(0.6)
          .setDensity(1.0);
        physicsWorld.createCollider(col, body);
        bodies[i] = body;
        offsets[i * 3] = 0; offsets[i * 3 + 1] = 0; offsets[i * 3 + 2] = 0;
        rots[i * 4]     = _q.x;
        rots[i * 4 + 1] = _q.y;
        rots[i * 4 + 2] = _q.z;
        rots[i * 4 + 3] = _q.w;
      }
    }

    instanceBodies.set(inst, bodies);
    instanceYCenter.set(inst, yCenters);
    instanceLocalOffset.set(inst, offsets);
    instanceLocalRotation.set(inst, rots);
  }
}

// Compute one instance's world pose from its (possibly shared) compound
// body and its local offset/rotation. Stored into `outPos` and `outQuat`.
const _bodyQ = new THREE.Quaternion();
const _localQ = new THREE.Quaternion();
const _localOff = new THREE.Vector3();
function instanceWorldPose(
  body: RAPIER.RigidBody,
  offX: number, offY: number, offZ: number,
  rotX: number, rotY: number, rotZ: number, rotW: number,
  outPos: THREE.Vector3, outQuat: THREE.Quaternion,
): void {
  const t = body.translation();
  const r = body.rotation();
  _bodyQ.set(r.x, r.y, r.z, r.w);
  _localOff.set(offX, offY, offZ).applyQuaternion(_bodyQ);
  outPos.set(t.x + _localOff.x, t.y + _localOff.y, t.z + _localOff.z);
  _localQ.set(rotX, rotY, rotZ, rotW);
  outQuat.copy(_bodyQ).multiply(_localQ);
}

// When a fall body first contacts ground in crash mode, split it into its
// pre-computed impact-cluster sub-bodies. Each sub-body inherits the
// original body's linear+angular velocity (with rigid-body kinematics so
// rotation about the original centre contributes to each sub-body's linear
// velocity) and gets fresh box colliders for its pieces. Per-instance
// bookkeeping (instanceBodies, instanceLocalOffset) is rewritten in place
// so the matrix sync after this picks up the new bodies seamlessly.
const _splitBodyPos = new THREE.Vector3();
const _splitBodyQ = new THREE.Quaternion();
const _splitOmega = new THREE.Vector3();
const _splitR = new THREE.Vector3();
const _splitVel = new THREE.Vector3();
const _splitCentroidLocal = new THREE.Vector3();
const _splitCentroidWorld = new THREE.Vector3();
function processImpactBreaks(): void {
  if (!physicsWorld || pendingBreaks.size === 0) return;
  for (const body of pendingBreaks) {
    if (brokenBodies.has(body)) continue;
    brokenBodies.add(body);
    const placements = bodyToPlacements.get(body);
    if (!placements || placements.length === 0 || !impactClusterId) continue;

    // Group this body's placements by their pre-computed impact cluster.
    const subClusters = new Map<number, number[]>();
    for (const p of placements) {
      const cid = impactClusterId[p];
      let arr = subClusters.get(cid);
      if (!arr) { arr = []; subClusters.set(cid, arr); }
      arr.push(p);
    }
    if (subClusters.size <= 1) continue; // already at minimum granularity

    // Snapshot the body's current world transform and velocities.
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    _splitBodyPos.set(t.x, t.y, t.z);
    _splitBodyQ.set(r.x, r.y, r.z, r.w);
    _splitOmega.set(av.x, av.y, av.z);

    for (const subPlacements of subClusters.values()) {
      // Compute centroid of this sub-cluster in the OLD body's local frame
      // (i.e., the average of pieces' existing localOffsets). That offset,
      // rotated by the body's current rotation and added to the body's
      // position, gives the sub-body's world position.
      _splitCentroidLocal.set(0, 0, 0);
      for (const p of subPlacements) {
        const inst = placementToInstance[p];
        if (!inst) continue;
        const offs = instanceLocalOffset.get(inst.mesh)!;
        _splitCentroidLocal.x += offs[inst.idx * 3];
        _splitCentroidLocal.y += offs[inst.idx * 3 + 1];
        _splitCentroidLocal.z += offs[inst.idx * 3 + 2];
      }
      _splitCentroidLocal.divideScalar(subPlacements.length);

      _splitCentroidWorld.copy(_splitCentroidLocal).applyQuaternion(_splitBodyQ).add(_splitBodyPos);

      // Linear velocity of the original body at the new centroid:
      //   v_at(p) = v_center + omega × (p − center)
      _splitR.copy(_splitCentroidWorld).sub(_splitBodyPos);
      _splitVel.copy(_splitOmega).cross(_splitR);
      _splitVel.x += lv.x; _splitVel.y += lv.y; _splitVel.z += lv.z;

      // Build the sub-body — same rotation as the parent (so piece local
      // rotations stay valid), same angvel (angular velocity is invariant
      // under translation), inherited linvel.
      const newBody = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(_splitCentroidWorld.x, _splitCentroidWorld.y, _splitCentroidWorld.z)
          .setRotation({ x: _splitBodyQ.x, y: _splitBodyQ.y, z: _splitBodyQ.z, w: _splitBodyQ.w })
          .setLinvel(_splitVel.x, _splitVel.y, _splitVel.z)
          .setAngvel({ x: av.x, y: av.y, z: av.z })
          // Lower damping post-impact so chunks tumble and scatter freely.
          .setLinearDamping(0.2)
          .setAngularDamping(0.8),
      );

      // Build colliders and rewrite per-instance bookkeeping. The new local
      // offset for each piece = old offset − sub-cluster centroid (in the
      // parent body's local frame, which the new body shares since it has
      // the parent's rotation).
      for (const p of subPlacements) {
        const inst = placementToInstance[p];
        if (!inst) continue;
        const offs = instanceLocalOffset.get(inst.mesh)!;
        const oldOx = offs[inst.idx * 3];
        const oldOy = offs[inst.idx * 3 + 1];
        const oldOz = offs[inst.idx * 3 + 2];
        const newOx = oldOx - _splitCentroidLocal.x;
        const newOy = oldOy - _splitCentroidLocal.y;
        const newOz = oldOz - _splitCentroidLocal.z;
        const fW = inst.mesh.userData.footprintW as number[] | undefined;
        const fD = inst.mesh.userData.footprintD as number[] | undefined;
        const fH = inst.mesh.userData.footprintH as number[] | undefined;
        const w = fW?.[inst.idx] ?? 1;
        const d = fD?.[inst.idx] ?? 1;
        const h = fH?.[inst.idx] ?? 1;
        physicsWorld.createCollider(
          RAPIER.ColliderDesc.cuboid(w / 2, (h / 2) * Y_SQUASH, d / 2)
            .setTranslation(newOx, newOy, newOz)
            .setRestitution(0.08)
            .setFriction(0.85)
            .setDensity(1.0),
          newBody,
        );
        offs[inst.idx * 3]     = newOx;
        offs[inst.idx * 3 + 1] = newOy;
        offs[inst.idx * 3 + 2] = newOz;
        instanceBodies.get(inst.mesh)![inst.idx] = newBody;
        placementToBody[p] = newBody;
      }
      bodyToPlacements.set(newBody, subPlacements);
    }

    // Tear down the old body.
    bodyToPlacements.delete(body);
    physicsWorld.removeRigidBody(body);
  }
  pendingBreaks.clear();
}

// Step the Rapier world once, then sync every instance's world transform
// back to its InstancedMesh matrix in renderGroup-local frame. For cluster
// pieces, world pose = bodyTransform · localOffset/rotation.
function stepExplodePhysics(_dt: number): void {
  if (!physicsWorld) return;
  // Crash mode passes the event queue so we can drain ground-contact
  // events and trigger impact-driven splits.
  if (isCrashSim && eventQueue) {
    physicsWorld.step(eventQueue);
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started || !physicsWorld) return;
      const c1 = physicsWorld.getCollider(h1);
      const c2 = physicsWorld.getCollider(h2);
      if (!c1 || !c2) return;
      const b1 = c1.parent();
      const b2 = c2.parent();
      if (!b1 || !b2 || !groundBody) return;
      // Identify which body is the (non-ground) candidate for breaking.
      let other: RAPIER.RigidBody | null = null;
      if (b1.handle === groundBody.handle) other = b2;
      else if (b2.handle === groundBody.handle) other = b1;
      if (other && !brokenBodies.has(other)) pendingBreaks.add(other);
    });
    processImpactBreaks();
  } else {
    physicsWorld.step();
  }
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const bodies = instanceBodies.get(inst);
    const yCenters = instanceYCenter.get(inst);
    const offsets = instanceLocalOffset.get(inst);
    const rots = instanceLocalRotation.get(inst);
    const originals = cacheOriginals(inst);
    if (!bodies || !yCenters || !offsets || !rots) continue;
    for (let i = 0; i < bodies.length; i++) {
      // Pull scale from the original matrix first (decompose overwrites _v
      // and _q which we then immediately replace via instanceWorldPose).
      _m.copy(originals[i]);
      _m.decompose(_v, _q, _s);
      instanceWorldPose(
        bodies[i],
        offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2],
        rots[i * 4], rots[i * 4 + 1], rots[i * 4 + 2], rots[i * 4 + 3],
        _v, _q,
      );
      // World → matrix: yCenters[i] is in world units (pre-multiplied by
      // Y_SQUASH at storage time), so this just subtracts the offset that
      // separates the matrix reference point (body-top for LDraw, cell-
      // centre for kit blocks) from the piece centre.
      _v.y = _v.y - yCenters[i];
      _m.compose(_v, _q, _s);
      inst.setMatrixAt(i, _m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
}

// Capture the post-physics pose of every piece into instancePositions +
// instanceRotations so stepReassemble can lerp/slerp them home, then free
// the Rapier world — we don't need physics during the reassembly animation.
function captureFinalPosesAndFreeWorld(): void {
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const bodies = instanceBodies.get(inst);
    const yCenters = instanceYCenter.get(inst);
    const offsets = instanceLocalOffset.get(inst);
    const rots = instanceLocalRotation.get(inst);
    if (!bodies || !yCenters || !offsets || !rots) continue;
    const pos = new Float32Array(bodies.length * 3);
    const rot = new Float32Array(bodies.length * 4);
    for (let i = 0; i < bodies.length; i++) {
      instanceWorldPose(
        bodies[i],
        offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2],
        rots[i * 4], rots[i * 4 + 1], rots[i * 4 + 2], rots[i * 4 + 3],
        _v, _q,
      );
      pos[i * 3]     = _v.x;
      pos[i * 3 + 1] = _v.y - yCenters[i];
      pos[i * 3 + 2] = _v.z;
      rot[i * 4]     = _q.x;
      rot[i * 4 + 1] = _q.y;
      rot[i * 4 + 2] = _q.z;
      rot[i * 4 + 3] = _q.w;
    }
    instancePositions.set(inst, pos);
    instanceRotations.set(inst, rot);
  }
  if (eventQueue) { eventQueue.free(); eventQueue = null; }
  if (physicsWorld) { physicsWorld.free(); physicsWorld = null; }
  groundBody = null;
  pendingBreaks.clear();
  brokenBodies.clear();
  bodyToPlacements.clear();
  isCrashSim = false;
}

// Phase-1 crash lift: lerp every instance's matrix from its cached original
// to (crashRotation · pos around world origin) + (0, crashLiftAmount, 0)
// in world space, with rotation slerped from original to crashRotation ·
// originalRotation. Works in renderGroup-local frame, converting through
// the Y squash so the world-space transform is right.
const _liftV = new THREE.Vector3();
const _liftQOrig = new THREE.Quaternion();
const _liftQTarget = new THREE.Quaternion();
const _liftQCur = new THREE.Quaternion();
const _liftTarget = new THREE.Vector3();
function applyCrashLiftAnimation(t: number): void {
  const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const originals = cacheOriginals(inst);
    for (let i = 0; i < originals.length; i++) {
      _m.copy(originals[i]);
      _m.decompose(_liftV, _liftQOrig, _s);

      // Matrix translation is already in world frame (Y_SQUASH is baked
      // into the renderers' instance matrix scales now), so we can rotate
      // around world origin and add the lift directly with no scale
      // gymnastics.
      _liftTarget.copy(_liftV).applyQuaternion(crashRotation);
      _liftTarget.y += crashLiftAmount;

      // Target rotation: crashRotation · originalRotation. renderGroup has
      // no rotation so local = world for the rotation component.
      _liftQTarget.copy(crashRotation).multiply(_liftQOrig);

      // Lerp / slerp from original toward target.
      _liftV.lerp(_liftTarget, eased);
      _liftQCur.copy(_liftQOrig).slerp(_liftQTarget, eased);

      _m.compose(_liftV, _liftQCur, _s);
      inst.setMatrixAt(i, _m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
}

// Lerp each piece's stored final pose back to its original cached pose.
// Slerps rotation alongside position so pieces un-tumble visibly rather
// than snapping back to their resting orientation. Returns true while any
// piece is still meaningfully far from home.
const _qTarget = new THREE.Quaternion();
const _qCurrent = new THREE.Quaternion();
function stepReassemble(): boolean {
  let stillMoving = false;
  for (const child of renderGroup.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    const pos = instancePositions.get(inst);
    const rot = instanceRotations.get(inst);
    const originals = cacheOriginals(inst);
    if (!pos || !rot) continue;
    for (let i = 0; i < originals.length; i++) {
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
      const ri = i * 4;
      _m.copy(originals[i]);
      _m.decompose(_v, _qTarget, _s);
      const tx = _v.x, ty = _v.y, tz = _v.z;
      pos[ix] += (tx - pos[ix]) * 0.18;
      pos[iy] += (ty - pos[iy]) * 0.18;
      pos[iz] += (tz - pos[iz]) * 0.18;
      _qCurrent.set(rot[ri], rot[ri + 1], rot[ri + 2], rot[ri + 3]);
      _qCurrent.slerp(_qTarget, 0.18);
      rot[ri]     = _qCurrent.x;
      rot[ri + 1] = _qCurrent.y;
      rot[ri + 2] = _qCurrent.z;
      rot[ri + 3] = _qCurrent.w;
      const r2 = (tx - pos[ix]) ** 2 + (ty - pos[iy]) ** 2 + (tz - pos[iz]) ** 2;
      if (r2 > 0.0004 || _qCurrent.angleTo(_qTarget) > 0.02) stillMoving = true;
      _v.set(pos[ix], pos[iy], pos[iz]);
      _m.compose(_v, _qCurrent, _s);
      inst.setMatrixAt(i, _m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
  return stillMoving;
}

function detonate(mode: ExplodeKind): void {
  if (!rapierReady) return;
  if (explodeMode === 'idle') {
    if (mode === 'crash') {
      // Phase 1 picks a random tilt (±45° per X/Y/Z) and the lift amount,
      // then animates the model into that pose with no physics. Now that
      // Y_SQUASH is baked into the renderers' matrix scales (renderGroup
      // is uniform) the rotation composes correctly — no geometry
      // distortion under arbitrary axes. Phase 2 spawns bodies at the
      // end-of-lift pose, gravity takes over, impact splits on contact.
      const rx = (Math.random() - 0.5) * (Math.PI / 2);
      const ry = (Math.random() - 0.5) * (Math.PI / 2);
      const rz = (Math.random() - 0.5) * (Math.PI / 2);
      crashRotation.setFromEuler(new THREE.Euler(rx, ry, rz));
      crashLiftAmount = 45;
      crashLiftStartTime = performance.now();
      explodeMode = 'crashLifting';
    } else {
      initExplodePhysics(mode);
      explodeMode = 'exploding';
      lastFrameTime = performance.now();
    }
  } else if (explodeMode === 'exploding') {
    // Freeze the sim, capture post-physics poses, free the world. The
    // reassembly animation runs purely off the cached arrays from here.
    captureFinalPosesAndFreeWorld();
    explodeMode = 'reassembling';
  }
  // If already lifting or reassembling, ignore — let the animation finish.
}

explodeButton.addEventListener('click', () => detonate('explode'));
crashButton.addEventListener('click', () => detonate('crash'));

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    currentMesh = await loadFromFile(file);
    currentMeshSource = file.name;
    runPipeline();
  } catch (e) {
    setStats(`error · ${(e as Error).message}`);
  }
});

modeSelect.addEventListener('change', render);
quantizerSelect.addEventListener('change', runPipeline);
smoothingCheckbox.addEventListener('change', runPipeline);
coloringSelect.addEventListener('change', render);
resInput.addEventListener('input', () => {
  resLabel.textContent = resInput.value;
});
rerunButton.addEventListener('click', runPipeline);

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

currentMesh = defaultMesh();
runPipeline();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  const now = performance.now();
  // Cap dt at 50ms so a stalled tab doesn't launch pieces into the next
  // dimension when it comes back.
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  if (explodeMode === 'crashLifting') {
    // Phase 1: smoothly lift + tilt the model. No physics.
    const elapsed = (now - crashLiftStartTime) / 1000;
    const t = Math.min(1, elapsed / CRASH_LIFT_DURATION_S);
    applyCrashLiftAnimation(t);
    if (t >= 1) {
      // Phase 2: bodies spawn at the end-of-lift pose, gravity takes over.
      initExplodePhysics('crash');
      explodeMode = 'exploding';
      lastFrameTime = now;
    }
  } else if (explodeMode === 'exploding') {
    stepExplodePhysics(dt);
  } else if (explodeMode === 'reassembling') {
    if (!stepReassemble()) {
      explodeMode = 'idle';
      applyTransforms();   // restore slider/hidden state cleanly
      recalibrateGround(); // and put the floor back under the model
    }
  }
  renderer.render(scene, camera);
}
animate();
