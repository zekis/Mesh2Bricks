import * as THREE from 'three';
import type { VoxelGrid } from './voxelize';
import { voxelKey } from './voxelize';
import type { KitBlock } from './kit';
import { buildCubeRotations } from './rotations';

export interface BlockInstance {
  position: THREE.Vector3;  // integer voxel coords
  blockIndex: number;       // index into KIT
  rotationIndex: number;    // index into cube-rotation list
}

export type Arrangement = BlockInstance[];

export const ROTATIONS = buildCubeRotations();

// Heuristic post-pass: pair adjacent single-cell slopes whose anchor cells are
// one step apart along the slope's rotated long axis (+z in canonical
// orientation), replacing each pair with a single 1×1×2 long-slope block.
//
// Caveat: two single-cell 45° slopes adjacent along their long axis form a
// stairstep (vertical wall between them), not a continuous ramp. Replacing
// them with a long-slope flattens the silhouette — geometrically lossy, not
// just a reparameterization. The honest fix is multi-cell-aware quantization
// that fits multi-cell patterns against the solid volume directly; this is
// here to validate the multi-cell *infrastructure* (kit data, render) works.
function mergeLongSlopes(arrangement: Arrangement, kit: KitBlock[]): Arrangement {
  const slopeIdx = kit.findIndex((b) => b.name === 'slope');
  const longIdx = kit.findIndex((b) => b.name === 'long-slope');
  if (slopeIdx < 0 || longIdx < 0) return arrangement;

  const longAxisByRotation = ROTATIONS.map((q) => {
    const v = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return new THREE.Vector3(Math.round(v.x), Math.round(v.y), Math.round(v.z));
  });

  const byPos = new Map<string, number>();
  for (let i = 0; i < arrangement.length; i++) {
    const p = arrangement[i].position;
    byPos.set(`${p.x},${p.y},${p.z}`, i);
  }

  const removed = new Set<number>();
  const additions: BlockInstance[] = [];

  for (let i = 0; i < arrangement.length; i++) {
    if (removed.has(i)) continue;
    const inst = arrangement[i];
    if (inst.blockIndex !== slopeIdx) continue;

    const dir = longAxisByRotation[inst.rotationIndex];
    const np = inst.position.clone().add(dir);
    const nKey = `${np.x},${np.y},${np.z}`;
    const nIdx = byPos.get(nKey);
    if (nIdx === undefined || removed.has(nIdx)) continue;

    const n = arrangement[nIdx];
    if (n.blockIndex !== slopeIdx || n.rotationIndex !== inst.rotationIndex) continue;

    additions.push({
      position: inst.position.clone(),
      blockIndex: longIdx,
      rotationIndex: inst.rotationIndex,
    });
    removed.add(i);
    removed.add(nIdx);
  }

  const result: Arrangement = [];
  for (let i = 0; i < arrangement.length; i++) {
    if (!removed.has(i)) result.push(arrangement[i]);
  }
  result.push(...additions);
  return result;
}

// Normal-only quantizer. For each occupied surface voxel, pick the
// (block, rotation) whose primary outward normal — rotated — best matches
// the voxel's averaged surface normal.
//
// The cube has zero primary normal; treated as a fallback with a constant
// baseline score so it wins when no oriented block does better.
//
// Limitation: on noisy meshes, corner-outside dominates because its primary
// normal (1,1,1)/√3 covers all 8 octants via rotation. See quantizeByTopology
// for the geometry-aware alternative.
export function quantizeByNormal(grid: VoxelGrid, kit: KitBlock[]): Arrangement {
  const result: Arrangement = [];

  // Precompute rotated normals per (block, rotation). Skips the cube (zero normal).
  const rotatedNormals: (THREE.Vector3[] | null)[] = kit.map((block) => {
    if (block.primaryNormal.lengthSq() < 0.01) return null;
    return ROTATIONS.map((q) => block.primaryNormal.clone().applyQuaternion(q));
  });

  // Score threshold below which we fall back to the cube
  const FALLBACK_SCORE = 0.3;
  const cubeIndex = kit.findIndex((b) => b.primaryNormal.lengthSq() < 0.01);

  for (const key of grid.occupied) {
    const [x, y, z] = key.split(',').map(Number);
    const normal = grid.normals.get(key);
    if (!normal) continue;

    let bestScore = FALLBACK_SCORE;
    let bestBlock = cubeIndex >= 0 ? cubeIndex : 0;
    let bestRot = 0;

    for (let bi = 0; bi < kit.length; bi++) {
      const rotated = rotatedNormals[bi];
      if (!rotated) continue;

      for (let ri = 0; ri < rotated.length; ri++) {
        const score = rotated[ri].dot(normal);
        if (score > bestScore) {
          bestScore = score;
          bestBlock = bi;
          bestRot = ri;
        }
      }
    }

    result.push({
      position: new THREE.Vector3(x, y, z),
      blockIndex: bestBlock,
      rotationIndex: bestRot,
    });
  }

  return mergeLongSlopes(result, kit);
}

// Topology-aware quantizer. Picks block *type* from the voxel's face-neighbor
// occupancy pattern (geometrically what kind of surface voxel this is), then
// uses the exposed-face directions to pick rotation.
//
// Counts of exposed (open-air) face-neighbors map to block types:
//   0           → cube (interior — shouldn't occur on a surface shell)
//   1           → half-block, facing the exposed direction
//   2 adjacent  → slope, with hypotenuse over the two exposed faces
//   2 opposite  → cube (thin sheet, no good fit)
//   3 corner    → corner-outside (the three exposed faces meet at one corner)
//   3 coplanar  → wedge (two opposite + one perpendicular → ridge)
//   4–5         → pyramid (isolated protrusion attached on one or two sides)
//   6           → cube (fully isolated voxel)
//
// Real corners only appear when there *is* a geometric corner. The pointy-bit
// over-representation in quantizeByNormal disappears.
export function quantizeByTopology(
  grid: VoxelGrid,
  kit: KitBlock[],
  useSmooth: boolean = true,
  excludeSet?: Set<string>,
): Arrangement {
  const result: Arrangement = [];
  const reference = useSmooth ? grid.smooth : grid.solid;
  // Iterate the surface of the *same* set we're checking neighbors against —
  // otherwise voxels removed by smoothing get classified against an empty
  // neighborhood and look like isolated pyramids/corners.
  const surfaceSet = useSmooth ? grid.smoothSurface : grid.occupied;

  const indexOf: Record<string, number> = {};
  kit.forEach((b, i) => { indexOf[b.name] = i; });

  const dirs = [
    { v: new THREE.Vector3( 1, 0, 0), dx:  1, dy:  0, dz:  0 },
    { v: new THREE.Vector3(-1, 0, 0), dx: -1, dy:  0, dz:  0 },
    { v: new THREE.Vector3( 0, 1, 0), dx:  0, dy:  1, dz:  0 },
    { v: new THREE.Vector3( 0,-1, 0), dx:  0, dy: -1, dz:  0 },
    { v: new THREE.Vector3( 0, 0, 1), dx:  0, dy:  0, dz:  1 },
    { v: new THREE.Vector3( 0, 0,-1), dx:  0, dy:  0, dz: -1 },
  ];

  const outward = new THREE.Vector3();
  const rotated = new THREE.Vector3();
  const exposed: typeof dirs = [];

  for (const key of surfaceSet) {
    if (excludeSet?.has(key)) continue;
    const [x, y, z] = key.split(',').map(Number);

    exposed.length = 0;
    for (const d of dirs) {
      if (!reference.has(voxelKey(x + d.dx, y + d.dy, z + d.dz))) {
        exposed.push(d);
      }
    }
    const n = exposed.length;

    // Surface normal from the voxelizer (only available for original surface voxels;
    // smoothing may have added voxels that have no normal — treat those as ambiguous).
    const surfaceNormal = grid.normals.get(key);

    // Lego-style classification: cube is the default. Half-block, slope, and
    // corner-outside are placed only when topology AND the surface normal
    // BOTH agree — i.e. the topology pattern AND the surface direction
    // independently support that block choice. Otherwise: cube.
    //
    // Without normal verification, noisy voxelizations produce slopes/corners
    // anywhere topology happens to expose 2–3 faces, even when the actual
    // surface is just a curving wall. Verification filters those out.
    let name: string = 'cube';

    if (n === 1) {
      const target = exposed[0].v;
      const agreement = surfaceNormal ? surfaceNormal.dot(target) : 0;
      if (agreement >= 0.7) name = 'half-block';
    } else if (n === 2) {
      const isOpposite = exposed[0].v.dot(exposed[1].v) < -0.5;
      if (!isOpposite) {
        outward.set(0, 0, 0);
        for (const e of exposed) outward.add(e.v);
        outward.normalize();
        const agreement = surfaceNormal ? surfaceNormal.dot(outward) : 0;
        if (agreement >= 0.75) name = 'slope';
      }
    } else if (n === 3) {
      let hasOpposing = false;
      for (let i = 0; i < 3 && !hasOpposing; i++) {
        for (let j = i + 1; j < 3 && !hasOpposing; j++) {
          if (exposed[i].v.dot(exposed[j].v) < -0.5) hasOpposing = true;
        }
      }
      if (!hasOpposing) {
        outward.set(0, 0, 0);
        for (const e of exposed) outward.add(e.v);
        outward.normalize();
        const agreement = surfaceNormal ? surfaceNormal.dot(outward) : 0;
        if (agreement >= 0.7) name = 'corner-outside';
      }
    }
    // n = 0, 4, 5, 6 → cube (default).

    const blockIndex = indexOf[name] ?? 0;

    outward.set(0, 0, 0);
    for (const e of exposed) outward.add(e.v);

    let rotationIndex = 0;
    const primary = kit[blockIndex].primaryNormal;
    if (primary.lengthSq() > 0.01 && outward.lengthSq() > 0) {
      outward.normalize();
      let bestScore = -Infinity;
      for (let ri = 0; ri < ROTATIONS.length; ri++) {
        rotated.copy(primary).applyQuaternion(ROTATIONS[ri]);
        const score = rotated.dot(outward);
        if (score > bestScore) {
          bestScore = score;
          rotationIndex = ri;
        }
      }
    }

    result.push({
      position: new THREE.Vector3(x, y, z),
      blockIndex,
      rotationIndex,
    });
  }

  return mergeLongSlopes(result, kit);
}
