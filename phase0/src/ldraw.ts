/**
 * LDraw manifest loader + gallery renderer for phase0.
 *
 * Loads the manifest produced by ldraw_runner (lives at
 * /ldraw/manifest.json on the Vite dev server), converts each part's
 * triangle list into a Three.js BufferGeometry, and provides a "gallery"
 * view that lays them out in a grid so we can visually verify the
 * pipeline.
 *
 * LDraw conventions to handle here:
 *   - −Y is up (we apply scale(1, -1, 1) to flip into Three.js +Y up).
 *   - 1 stud = 20 LDU, 1 plate = 8 LDU, 1 brick = 24 LDU.
 *   - Colour 16 = "inherit" — should never appear here (resolved server-side);
 *     colour 24 = edge colour.
 */

import * as THREE from 'three';

export interface LDrawFootprint {
  studsX: number;
  studsZ: number;
  heightPlates: number;
}

export interface LDrawPart {
  id: string;
  description: string;
  category: string | null;
  footprint: LDrawFootprint;
  bbox: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  /** Three.js BufferGeometry built from the manifest's flat triangle list. */
  geometry: THREE.BufferGeometry;
  triangleCount: number;
}

interface ManifestPart {
  id: string;
  description: string;
  category: string | null;
  footprint: LDrawFootprint;
  bbox: LDrawPart['bbox'];
  positions: number[];
  colors: number[];
  triangleCount: number;
}

interface Manifest {
  schemaVersion: string;
  generatedAt: string;
  source: string;
  parts: ManifestPart[];
}

// Subset of the LDraw colour table — the common solid colours. Full table
// has ~150 entries; this is enough for the gallery view.
const LDRAW_COLOURS: Record<number, number> = {
  0: 0x05131d, 1: 0x0055bf, 2: 0x257a3e, 3: 0x008e8e, 4: 0xc91a09,
  5: 0xc870a0, 6: 0x583927, 7: 0x9ba19d, 8: 0x6d6e5c, 9: 0xb4d2e3,
  10: 0x4b9f4a, 11: 0x55a5af, 12: 0xf2705e, 14: 0xf2cd37, 15: 0xffffff,
  16: 0xc0c0c0, // "current colour" fallback for unresolved geometry
  19: 0xe4cd9e, 22: 0x81007b, 23: 0x2032b0, 24: 0x595d60, // edge dark grey
  25: 0xfe8a18, 26: 0x923978, 27: 0xbbe90b, 28: 0x958a73,
  70: 0x582a12, 71: 0x9c9291, 72: 0x4d5e57, 74: 0x73dca1, 78: 0xf6d7b3,
  84: 0xcc702a, 85: 0x3f3691, 86: 0x7c503a,
};

export function ldrawColour(code: number): THREE.Color {
  const hex = LDRAW_COLOURS[code] ?? 0xc0c0c0; // default light grey
  return new THREE.Color(hex);
}

function buildGeometry(positions: number[], colors: number[]): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  // Apply LDraw -Y-up → Three.js +Y-up flip by negating the y component.
  const flipped = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    flipped[i]     = positions[i];
    flipped[i + 1] = -positions[i + 1];
    flipped[i + 2] = positions[i + 2];
  }
  geom.setAttribute('position', new THREE.BufferAttribute(flipped, 3));

  // Per-vertex colours: each triangle gets 3 vertices with the same colour.
  const colourBuf = new Float32Array(positions.length); // same length as positions
  for (let i = 0; i < colors.length; i++) {
    const c = ldrawColour(colors[i]);
    const base = i * 9;
    for (let v = 0; v < 3; v++) {
      colourBuf[base + v * 3]     = c.r;
      colourBuf[base + v * 3 + 1] = c.g;
      colourBuf[base + v * 3 + 2] = c.b;
    }
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colourBuf, 3));

  // Y-flip inverted triangle winding — fix by reversing the order pairwise.
  // (Flipping Y mirrors the geometry; without fixing winding, faces would
  // backface-cull from the wrong side.)
  const reordered = new Float32Array(positions.length);
  const reorderedC = new Float32Array(colourBuf.length);
  for (let i = 0; i < positions.length; i += 9) {
    // (v1, v2, v3) → (v1, v3, v2) to reverse winding
    reordered[i]     = flipped[i];
    reordered[i + 1] = flipped[i + 1];
    reordered[i + 2] = flipped[i + 2];
    reordered[i + 3] = flipped[i + 6];
    reordered[i + 4] = flipped[i + 7];
    reordered[i + 5] = flipped[i + 8];
    reordered[i + 6] = flipped[i + 3];
    reordered[i + 7] = flipped[i + 4];
    reordered[i + 8] = flipped[i + 5];
    for (let k = 0; k < 9; k++) reorderedC[i + k] = colourBuf[i + (k < 3 ? k : k < 6 ? k + 3 : k - 3)];
  }
  geom.setAttribute('position', new THREE.BufferAttribute(reordered, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(reorderedC, 3));
  geom.computeVertexNormals();
  return geom;
}

export async function loadLDrawManifest(url: string = '/ldraw/manifest.json'): Promise<LDrawPart[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load LDraw manifest: ${res.status}`);
  const manifest: Manifest = await res.json();

  console.log(
    `[ldraw] loaded ${manifest.parts.length} parts from ${manifest.source} ` +
    `(schema ${manifest.schemaVersion}, generated ${manifest.generatedAt})`,
  );

  return manifest.parts.map((p) => ({
    id: p.id,
    description: p.description,
    category: p.category,
    footprint: p.footprint,
    bbox: p.bbox,
    geometry: buildGeometry(p.positions, p.colors),
    triangleCount: p.triangleCount,
  }));
}

/**
 * Render a list of LDraw placements (from the fitter) into the scene.
 * Each placement is positioned, rotated, and anisotropically scaled to
 * match the voxel-grid interpretation (1 voxel = 20 LDU X, 8 LDU Y, 20 LDU Z).
 *
 * Placements are grouped by part-ID + rotation so each unique geometry/
 * orientation pair gets one InstancedMesh.
 */
import type { LDrawPlacement } from './ldraw_fitter';

const STUD_LDU = 20;
const PLATE_LDU = 8;
// Anisotropic Y compression — 8 LDU plate / 20 LDU stud = 0.4. Baked into
// each instance matrix's scale below so rotation and squash compose
// correctly (renderGroup.scale stays uniform 1).
const Y_SQUASH = 0.4;

// Where the geometry's bbox-min ends up in cell coords AFTER the part-local
// Y-flip, the LDU→cell scale, and the around-Y rotation — but before the
// world translation. The render translates this point onto the placement's
// anchor cell so the geometry exactly fills its claimed footprint.
//
// LDraw slopes are not symmetric around their origin (e.g. 3037's Z range
// runs [-30, +10] LDU because the angled face protrudes past the stud cluster).
// Using bbox.min directly — instead of assuming the geometry is centered at
// (0, top, 0) — fixes the visible 0.5–1.0-cell offsets between slopes and
// their neighbours.
function postRotationBboxMin(part: LDrawPart, rotation: 0 | 1 | 2 | 3): { x: number; y: number; z: number } {
  const xmin = part.bbox.min[0] / STUD_LDU;
  const xmax = part.bbox.max[0] / STUD_LDU;
  const zmin = part.bbox.min[2] / STUD_LDU;
  const zmax = part.bbox.max[2] / STUD_LDU;
  // Y-flip: post-flip Y range = [-bbox.max.y, -bbox.min.y] in LDU; post-flip min
  // Y in cells = -bbox.max.y / PLATE (the body's bottom, since studs are above).
  const yminPost = -part.bbox.max[1] / PLATE_LDU;

  // THREE.makeRotationY(θ) sends (x,y,z) → (cosθ·x + sinθ·z, y, -sinθ·x + cosθ·z).
  // θ = 90° → (z, y, -x); 180° → (-x, y, -z); 270° → (-z, y, x).
  let rxmin: number, rzmin: number;
  switch (rotation) {
    case 0: rxmin = xmin;  rzmin = zmin;  break;
    case 1: rxmin = zmin;  rzmin = -xmax; break;
    case 2: rxmin = -xmax; rzmin = -zmax; break;
    case 3: rxmin = -zmax; rzmin = xmin;  break;
  }
  return { x: rxmin, y: yminPost, z: rzmin };
}

export function renderLDrawPlacements(
  group: THREE.Group,
  placements: LDrawPlacement[],
  parts: LDrawPart[],
  gridSize: number,
  gridSizeY: number,
  colorByPart: boolean = false,
  voxelColors?: Map<string, THREE.Color>,
  /** When provided, overrides voxelColors/colorByPart: floating pieces render
   *  red and supported pieces render green. Used by the "physics check"
   *  coloring mode to visualize the support-chain analysis. */
  floatingIndices?: Set<number>,
  /** Parallel to `placements`: true for pieces completely enclosed by other
   *  covered cells. Stashed on InstancedMesh.userData.hidden so the layer
   *  slider can skip rendering them until they're exposed. */
  hiddenFlags?: boolean[],
): void {
  if (placements.length === 0) return;
  const halfXZ = gridSize / 2;
  const halfY = gridSizeY / 2;
  const partById = new Map<string, LDrawPart>();
  for (const p of parts) partById.set(p.id, p);
  const usePhysics = floatingIndices !== undefined;
  const useVoxelColors = !colorByPart && !usePhysics && voxelColors !== undefined && voxelColors.size > 0;

  // Group placements by (partId, rotation) → InstancedMesh. Preserve each
  // placement's original index alongside it so per-instance logic (physics
  // floating lookup, etc.) can find the right entry.
  type IndexedPlacement = { placement: LDrawPlacement; index: number };
  const groups = new Map<string, IndexedPlacement[]>();
  for (let i = 0; i < placements.length; i++) {
    const key = `${placements[i].partId}/${placements[i].rotation}`;
    let entry = groups.get(key);
    if (!entry) { entry = []; groups.set(key, entry); }
    entry.push({ placement: placements[i], index: i });
  }

  // Pre-compute scale matrix: converts LDU → world coords with Y-squash
  // baked in. (1/20, 0.4/8, 1/20) = (0.05, 0.05, 0.05) — uniform 0.05
  // scale, so rotation in the matrix composes cleanly without the
  // renderGroup having to apply a separate non-uniform scale.
  const scaleMat = new THREE.Matrix4().makeScale(1 / STUD_LDU, Y_SQUASH / PLATE_LDU, 1 / STUD_LDU);
  const rotMat = new THREE.Matrix4();
  const transMat = new THREE.Matrix4();
  const finalMat = new THREE.Matrix4();

  // Small palette for `colorByPart` debug visualization
  const PALETTE = [0xff7a59, 0x6fa3c2, 0xb8b35f, 0xa78ce6, 0x6fb88f, 0xc8995c, 0xc97a6e, 0xa49481];
  const tmpColor = new THREE.Color();
  const fallbackColor = new THREE.Color(0x88aacc);

  for (const [groupKey, members] of groups) {
    const [partId, rotStr] = groupKey.split('/');
    const part = partById.get(partId);
    if (!part) continue;
    const rotation = parseInt(rotStr, 10) as 0 | 1 | 2 | 3;
    const angle = rotation * Math.PI / 2;
    rotMat.makeRotationY(angle);

    let mat: THREE.Material;
    if (colorByPart) {
      // Hash partId to palette index for distinct debug colours per part
      let hash = 0;
      for (let i = 0; i < partId.length; i++) hash = (hash * 31 + partId.charCodeAt(i)) >>> 0;
      mat = new THREE.MeshStandardMaterial({
        color: PALETTE[hash % PALETTE.length],
        side: THREE.DoubleSide,
        flatShading: true,
        roughness: 0.4,
        metalness: 0.1,
      });
    } else if (useVoxelColors) {
      // Per-instance tint sampled from the original mesh texture. White base
      // so instance.color survives unmodified; vertex colors disabled so the
      // LDraw native grey doesn't multiply against the sampled colour.
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        roughness: 0.4,
        metalness: 0.1,
      });
    } else if (usePhysics) {
      // White base + per-instance tint: red for floating, green for supported.
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        roughness: 0.6,
        metalness: 0.0,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.4,
        metalness: 0.1,
      });
    }

    const inst = new THREE.InstancedMesh(part.geometry, mat, members.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    // Per-instance metadata read by the layer slider (anchor.y, hidden flag),
    // the explode-pile physics (footprint W/D/H, bottom offset), and the
    // adjacency-based joint creation (the placement's original index so we
    // can map (mesh, instance) ↔ placement ↔ joint endpoint).
    const instLayers: number[] = [];
    const instHidden: boolean[] = [];
    const instFootprintW: number[] = [];
    const instFootprintD: number[] = [];
    const instFootprintH: number[] = [];
    const instBottomOffset: number[] = [];
    const instPlacementIdx: number[] = [];

    // The geometry's post-rotation bbox.min in cell coords is the same for
    // every placement in this group (same part + rotation), so compute once.
    const localMin = postRotationBboxMin(part, rotation);

    const FLOATING_COLOR = new THREE.Color(0xff3a3a);
    const SUPPORTED_COLOR = new THREE.Color(0x3aaa55);

    for (let i = 0; i < members.length; i++) {
      const { placement: p, index: globalIndex } = members[i];
      instLayers.push(p.anchor.y);
      instHidden.push(hiddenFlags?.[globalIndex] ?? false);
      instFootprintW.push(p.footprint.width);
      instFootprintD.push(p.footprint.depth);
      instFootprintH.push(p.footprint.height);
      instBottomOffset.push(-p.footprint.height);
      instPlacementIdx.push(globalIndex);
      // Place the geometry so its post-rotation bbox.min lands exactly on the
      // anchor cell — guarantees the rendered body matches the claimed cells
      // even for off-center geometry (e.g. slopes). ty multiplied by
      // Y_SQUASH because the matrix scale bakes the squash into the
      // geometry; the translation Y has to be in world units to match.
      const tx = p.anchor.x - localMin.x - halfXZ;
      const ty = (p.anchor.y - localMin.y - halfY) * Y_SQUASH;
      const tz = p.anchor.z - localMin.z - halfXZ;
      transMat.makeTranslation(tx, ty, tz);

      // Final transform: T * R * S
      finalMat.identity();
      finalMat.multiply(transMat);
      finalMat.multiply(rotMat);
      finalMat.multiply(scaleMat);
      inst.setMatrixAt(i, finalMat);

      if (useVoxelColors) {
        // Average over all cells the placement claims so the colour reads as
        // a smooth blend across the piece rather than picking a single voxel.
        let r = 0, g = 0, b = 0, n = 0;
        for (const key of p.cells) {
          const c = voxelColors!.get(key);
          if (c) { r += c.r; g += c.g; b += c.b; n++; }
        }
        if (n > 0) {
          tmpColor.setRGB(r / n, g / n, b / n);
          inst.setColorAt(i, tmpColor);
        } else {
          inst.setColorAt(i, fallbackColor);
        }
      } else if (usePhysics) {
        inst.setColorAt(i, floatingIndices!.has(globalIndex) ? FLOATING_COLOR : SUPPORTED_COLOR);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if ((useVoxelColors || usePhysics) && inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.userData.layers = instLayers;
    inst.userData.hidden = instHidden;
    inst.userData.footprintW = instFootprintW;
    inst.userData.footprintD = instFootprintD;
    inst.userData.footprintH = instFootprintH;
    inst.userData.bottomOffset = instBottomOffset;
    inst.userData.placementIdx = instPlacementIdx;
    group.add(inst);
  }
}

/**
 * Gallery view: arrange all loaded parts in a grid, scaled so each part's
 * widest axis fits within `cellSize`. Adds the meshes to `group`.
 *
 * Useful as a sanity-check view — confirms the manifest loaded, geometry
 * built, colours/winding correct.
 */
export function renderLDrawGallery(
  group: THREE.Group,
  parts: LDrawPart[],
  cellSize: number = 7,
  padding: number = 2,
): void {
  if (parts.length === 0) return;

  const cols = Math.ceil(Math.sqrt(parts.length));
  const stride = cellSize + padding;
  const offsetX = -((cols - 1) * stride) / 2;
  const offsetZ = -((Math.ceil(parts.length / cols) - 1) * stride) / 2;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    // Scale uniformly so the largest bbox axis fits within `cellSize`.
    const maxBbox = Math.max(part.bbox.size[0], part.bbox.size[1], part.bbox.size[2]) || 1;
    const scale = cellSize / maxBbox;

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      flatShading: false,
      roughness: 0.4,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(part.geometry, mat);
    mesh.scale.setScalar(scale);
    // Centre the part's bbox at origin, then translate to grid cell.
    const cx = (part.bbox.min[0] + part.bbox.max[0]) / 2;
    const cy = (part.bbox.min[1] + part.bbox.max[1]) / 2;
    const cz = (part.bbox.min[2] + part.bbox.max[2]) / 2;
    mesh.position.set(
      offsetX + col * stride - cx * scale,
      // After Y-flip in buildGeometry, the visible Y centre is -cy.
      cy * scale,
      offsetZ + row * stride - cz * scale,
    );
    group.add(mesh);
  }
}
