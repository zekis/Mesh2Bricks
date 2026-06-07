import * as THREE from 'three';
import type { VoxelGrid } from './voxelize';
import type { Arrangement } from './quantize';
import { ROTATIONS } from './quantize';
import type { KitBlock } from './kit';
import type { BeamPlacement, PlatePlacement } from './multipass';

// Anisotropic Y compression — baked into each instance matrix's scale (or
// the box geometry's Y dim) so rotation composes correctly. renderGroup
// stays uniform 1×1×1.
const Y_SQUASH = 0.4;

// Render the input mesh centered + scaled to fit a cube of side `gridSize`.
// Uses the source material (preserving any baseColorMap texture) so the
// view shows what TRELLIS actually produced rather than a flat-shaded gray.
//
// renderGroup now uses uniform scale (1×1×1) and the Lego Y-squash is
// baked into the voxel/lego renderers' instance matrices, so the original
// mesh view doesn't need any Y compensation — uniform scaling produces
// natural proportions directly.
export function renderMesh(group: THREE.Group, mesh: THREE.Mesh, gridSize: number) {
  mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(mesh);
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z) || 1;
  const scale = gridSize / maxSize;

  const geom = mesh.geometry.clone();
  geom.applyMatrix4(mesh.matrixWorld);
  geom.translate(-center.x, -center.y, -center.z);
  geom.scale(scale, scale, scale);
  // Only recompute normals if the source didn't have any — otherwise
  // preserve the original smooth normals so PBR shading reads correctly.
  if (!geom.attributes.normal) {
    geom.computeVertexNormals();
  }

  // Reuse the source material (clone so DoubleSide override doesn't leak back).
  // Falls back to a flat-shaded gray if the mesh has no material.
  const sourceMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  let mat: THREE.Material;
  if (sourceMat) {
    mat = sourceMat.clone();
    mat.side = THREE.DoubleSide;
  } else {
    mat = new THREE.MeshStandardMaterial({
      color: 0x88aacc,
      side: THREE.DoubleSide,
      flatShading: true,
    });
  }
  const sourceMesh = new THREE.Mesh(geom, mat);
  sourceMesh.castShadow = true;
  sourceMesh.receiveShadow = true;
  group.add(sourceMesh);
}

// Render the raw voxel occupancy grid as plain unit cubes, with per-cube
// color sampled from the mesh texture when available.
export function renderVoxelCubes(group: THREE.Group, grid: VoxelGrid) {
  if (grid.occupied.size === 0) return;
  // BoxGeometry's Y dim is Y_SQUASH so the cube has correct world
  // proportions without a renderGroup scale; translation Y likewise
  // multiplied so cells stack at the squashed Y pitch in world frame.
  const geom = new THREE.BoxGeometry(1, Y_SQUASH, 1);
  const hasColors = grid.colors.size > 0;
  const mat = new THREE.MeshStandardMaterial({
    color: hasColors ? 0xffffff : 0x88aacc,
    flatShading: true,
  });
  const inst = new THREE.InstancedMesh(geom, mat, grid.occupied.size);
  inst.castShadow = true;
  inst.receiveShadow = true;

  const matrix = new THREE.Matrix4();
  const fallback = new THREE.Color(0x88aacc);
  const halfXZ = grid.size / 2;
  const halfY = grid.sizeY / 2;
  const layers: number[] = [];
  let i = 0;
  for (const key of grid.occupied) {
    const [x, y, z] = key.split(',').map(Number);
    matrix.makeTranslation(x - halfXZ + 0.5, (y - halfY + 0.5) * Y_SQUASH, z - halfXZ + 0.5);
    inst.setMatrixAt(i, matrix);
    if (hasColors) inst.setColorAt(i, grid.colors.get(key) ?? fallback);
    layers.push(y);
    i++;
  }
  inst.instanceMatrix.needsUpdate = true;
  if (hasColors && inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.userData.layers = layers;
  group.add(inst);
}

// Render the quantized arrangement: one InstancedMesh per block type,
// each instance translated to its voxel position and rotated by its
// chosen cubic rotation.
export function renderArrangement(
  group: THREE.Group,
  arrangement: Arrangement,
  gridSize: number,
  gridSizeY: number,
  kit: KitBlock[],
  colorByType: boolean = true,
  voxelColors?: Map<string, THREE.Color>,
) {
  if (arrangement.length === 0) return;
  const halfXZ = gridSize / 2;
  const halfY = gridSizeY / 2;
  const hasVoxelColors = !colorByType && voxelColors !== undefined && voxelColors.size > 0;

  const byBlock = new Map<number, { positions: THREE.Vector3[]; rotations: number[]; keys: string[] }>();
  for (const inst of arrangement) {
    let entry = byBlock.get(inst.blockIndex);
    if (!entry) {
      entry = { positions: [], rotations: [], keys: [] };
      byBlock.set(inst.blockIndex, entry);
    }
    entry.positions.push(inst.position);
    entry.rotations.push(inst.rotationIndex);
    entry.keys.push(`${inst.position.x},${inst.position.y},${inst.position.z}`);
  }

  const t = new THREE.Matrix4();
  const r = new THREE.Matrix4();
  const s = new THREE.Matrix4().makeScale(1, Y_SQUASH, 1);
  const m = new THREE.Matrix4();
  const fallback = new THREE.Color(0x88aacc);

  for (const [blockIndex, { positions, rotations, keys }] of byBlock) {
    const block = kit[blockIndex];
    const mat = new THREE.MeshStandardMaterial({
      color: colorByType ? block.color : (hasVoxelColors ? 0xffffff : 0x88aacc),
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(block.geometry, mat, positions.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const layers: number[] = [];

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const q = ROTATIONS[rotations[i]];
      // T · R · S with S = (1, Y_SQUASH, 1) so the kit geometry's Y dim
      // gets squashed AFTER its own rotation but BEFORE world placement.
      // Translation Y also multiplied to land the cell stack at the right
      // world Y pitch.
      t.makeTranslation(p.x - halfXZ + 0.5, (p.y - halfY + 0.5) * Y_SQUASH, p.z - halfXZ + 0.5);
      r.makeRotationFromQuaternion(q);
      m.multiplyMatrices(t, r).multiply(s);
      mesh.setMatrixAt(i, m);
      if (hasVoxelColors) {
        mesh.setColorAt(i, voxelColors!.get(keys[i]) ?? fallback);
      }
      layers.push(p.y);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (hasVoxelColors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.layers = layers;
    group.add(mesh);
  }
}

// Render the multi-pass beam placements as elongated boxes. Beams are
// 1×1×N rectangular runs along an axis, so each (axis, length) combination
// shares geometry and gets one InstancedMesh.
//
// Beams live in the interior of the smoothed solid — they're often fully
// obscured by surface placements from the outside. For visual debugging
// they render in bright cyan with shading so they show through any gaps
// at the surface or when the surface itself is hidden.
export function renderBeams(group: THREE.Group, beams: BeamPlacement[], gridSize: number, gridSizeY: number) {
  if (beams.length === 0) return;
  const halfXZ = gridSize / 2;
  const halfY = gridSizeY / 2;

  // Group beams by (axis, length) so each combination shares one geometry.
  const groups = new Map<string, BeamPlacement[]>();
  for (const beam of beams) {
    const k = `${beam.axis}-${beam.length}`;
    let entry = groups.get(k);
    if (!entry) { entry = []; groups.set(k, entry); }
    entry.push(beam);
  }

  const matrix = new THREE.Matrix4();

  for (const [groupKey, members] of groups) {
    const [axisStr, lenStr] = groupKey.split('-');
    const axis = axisStr as 'x' | 'y' | 'z';
    const length = parseInt(lenStr, 10);

    // Y dim baked with the squash; for Y-axis beams the squash applies to
    // their length (length cells of squashed Y), for X/Z beams the Y dim is
    // just one cell of squashed Y.
    const geom = axis === 'x'
      ? new THREE.BoxGeometry(length, Y_SQUASH, 1)
      : axis === 'y'
        ? new THREE.BoxGeometry(1, length * Y_SQUASH, 1)
        : new THREE.BoxGeometry(1, Y_SQUASH, length);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x00d0ff,
      flatShading: true,
    });
    const inst = new THREE.InstancedMesh(geom, mat, members.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const layers: number[] = [];

    for (let i = 0; i < members.length; i++) {
      const { anchor } = members[i];
      layers.push(anchor.y);
      // Beam spans cells anchor..anchor+(length-1) along `axis`. Each cell is
      // a unit volume centered at (cell + 0.5). Translation Y multiplied by
      // Y_SQUASH to match the squashed world-Y pitch.
      let cx = anchor.x + 0.5 - halfXZ;
      let cy = anchor.y + 0.5 - halfY;
      let cz = anchor.z + 0.5 - halfXZ;
      if (axis === 'x') cx += (length - 1) / 2;
      else if (axis === 'y') cy += (length - 1) / 2;
      else cz += (length - 1) / 2;
      matrix.makeTranslation(cx, cy * Y_SQUASH, cz);
      inst.setMatrixAt(i, matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.userData.layers = layers;
    group.add(inst);
  }
}

// Render the multi-pass plate placements as flat rectangular slabs. Plates
// are W×1×H (or similar) boxes oriented so their thin axis matches their
// face direction. Each (thicknessAxis, width, depth) combination shares
// geometry via InstancedMesh.
//
// Plates render in distinctive orange so they stand apart from the
// single-cell surface kit (gray/colored) and the interior beams (cyan).
export function renderPlates(group: THREE.Group, plates: PlatePlacement[], gridSize: number, gridSizeY: number) {
  if (plates.length === 0) return;
  const halfXZ = gridSize / 2;
  const halfY = gridSizeY / 2;

  const groups = new Map<string, PlatePlacement[]>();
  for (const p of plates) {
    const k = `${p.thicknessAxis}-${p.width}x${p.depth}`;
    let entry = groups.get(k);
    if (!entry) { entry = []; groups.set(k, entry); }
    entry.push(p);
  }

  const matrix = new THREE.Matrix4();

  for (const [groupKey, members] of groups) {
    const [axisStr, dimStr] = groupKey.split('-');
    const axis = axisStr as 'x' | 'y' | 'z';
    const [w, h] = dimStr.split('x').map(Number);

    // Thin axis along `axis`, w and h spread across the two perpendicular
    // axes. Y dim multiplied by Y_SQUASH so the plate sits at correct
    // squashed world-Y proportions without a renderGroup scale.
    const geom = axis === 'x'
      ? new THREE.BoxGeometry(1, w * Y_SQUASH, h)
      : axis === 'y'
        ? new THREE.BoxGeometry(w, Y_SQUASH, h)
        : new THREE.BoxGeometry(w, h * Y_SQUASH, 1);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xff9c4a,
      flatShading: true,
    });
    const inst = new THREE.InstancedMesh(geom, mat, members.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const layers: number[] = [];

    for (let i = 0; i < members.length; i++) {
      const { anchor } = members[i];
      layers.push(anchor.y);
      // Center of the footprint along each axis. Thickness axis has the
      // single-cell center (anchor + 0.5); the other two axes have w/2 or h/2
      // offsets from the anchor.
      let cx = anchor.x + 0.5;
      let cy = anchor.y + 0.5;
      let cz = anchor.z + 0.5;
      if (axis === 'x')      { cy = anchor.y + w / 2; cz = anchor.z + h / 2; }
      else if (axis === 'y') { cx = anchor.x + w / 2; cz = anchor.z + h / 2; }
      else                   { cx = anchor.x + w / 2; cy = anchor.y + h / 2; }
      matrix.makeTranslation(cx - halfXZ, (cy - halfY) * Y_SQUASH, cz - halfXZ);
      inst.setMatrixAt(i, matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.userData.layers = layers;
    group.add(inst);
  }
}
