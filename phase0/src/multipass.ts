/**
 * Multi-pass kit decomposition — Spec.v3.1 §3.
 *
 * Phase 1a: just the beam pass. Finds long 1×1×N runs inside the smoothed
 * solid that are NOT on the surface (interior structural beams). Each run
 * becomes a single multi-cell placement that claims its cells, so later
 * passes (and the existing single-cell quantizer used as the final pass)
 * can't double-cover.
 *
 * This module is intentionally not yet wired into the UI or renderer — the
 * goal here is the algorithm + types. Integration goes through a new
 * quantizer option once the renderer can place multi-cell pieces.
 */

import * as THREE from 'three';
import { voxelKey, type VoxelGrid } from './voxelize';
import { quantizeByTopology, type Arrangement } from './quantize';
import type { KitBlock } from './kit';

export type Axis = 'x' | 'y' | 'z';

export interface BeamPlacement {
  /** Anchor cell — the min-corner of the run. */
  anchor: { x: number; y: number; z: number };
  /** Direction the beam extends from the anchor. */
  axis: Axis;
  /** Number of cells covered (N for a 1×1×N beam). */
  length: number;
  /** Voxel keys claimed by this beam. */
  cells: string[];
}

export interface MultiPassResult {
  /** Multi-cell pieces placed during the structural passes. */
  beams: BeamPlacement[];
  /** Cells claimed by any multi-pass placement — pass to the fallback
   *  single-cell quantizer so it skips these. */
  claimed: Set<string>;
  /** Cells that remain unclaimed and should be classified by the fallback
   *  single-cell quantizer. For Phase 1a this is the full smoothSurface
   *  minus any cells the beam pass happened to touch (rare — beams live
   *  in the interior). */
  remaining: Set<string>;
}

/**
 * Beam-pass entry point.
 *
 * @param grid       Output of voxelize()
 * @param maxLength  Longest beam to try (8 is reasonable for 64³ grids)
 * @param minLength  Shortest beam worth placing (3; below this just leave
 *                   the cells to the single-cell quantizer)
 */
export function placeBeams(
  grid: VoxelGrid,
  maxLength: number = 8,
  minLength: number = 3,
): MultiPassResult {
  // Beams live in the interior of the smoothed solid — cells that are in
  // grid.smooth but NOT in grid.smoothSurface. Surface cells stay available
  // for surface-pass kit pieces (plates, slopes, chamfers, cubes).
  const interior = new Set<string>();
  for (const key of grid.smooth) {
    if (!grid.smoothSurface.has(key)) interior.add(key);
  }

  const claimed = new Set<string>();
  const beams: BeamPlacement[] = [];
  const axes: Axis[] = ['x', 'y', 'z'];

  // Try each length, longest first. Within a length, scan all axes. Within
  // an axis, scan all candidate starting voxels in raster order. A starting
  // voxel `(sx, sy, sz)` is a valid beam start if (1) it's interior and not
  // yet claimed, (2) the voxel just before it along the axis is NOT in the
  // candidate set or is claimed (so we don't start mid-beam), (3) the next
  // `length` cells along the axis are all interior and unclaimed.
  for (let length = maxLength; length >= minLength; length--) {
    for (const axis of axes) {
      const dx = axis === 'x' ? 1 : 0;
      const dy = axis === 'y' ? 1 : 0;
      const dz = axis === 'z' ? 1 : 0;

      for (const startKey of interior) {
        if (claimed.has(startKey)) continue;
        const [sx, sy, sz] = startKey.split(',').map(Number);

        // Skip mid-beam starts (predecessor along axis is also a candidate).
        const prevKey = voxelKey(sx - dx, sy - dy, sz - dz);
        if (interior.has(prevKey) && !claimed.has(prevKey)) continue;

        // Try a run of `length` consecutive cells.
        const runCells: string[] = [];
        let runValid = true;
        for (let i = 0; i < length; i++) {
          const k = voxelKey(sx + dx * i, sy + dy * i, sz + dz * i);
          if (!interior.has(k) || claimed.has(k)) {
            runValid = false;
            break;
          }
          runCells.push(k);
        }

        if (runValid) {
          beams.push({ anchor: { x: sx, y: sy, z: sz }, axis, length, cells: runCells });
          for (const k of runCells) claimed.add(k);
        }
      }
    }
  }

  // Remaining = smoothSurface − claimed. (Interior cells claimed by beams
  // are not passed to the single-cell quantizer either, since they're
  // structurally inside the volume and shouldn't render as surface pieces.)
  const remaining = new Set<string>();
  for (const key of grid.smoothSurface) {
    if (!claimed.has(key)) remaining.add(key);
  }

  return { beams, claimed, remaining };
}

/**
 * Multi-pass quantizer entry point — Step A.
 *
 * Runs the beam pass first (interior structural pieces), then falls back to
 * the existing single-cell topology quantizer for surface cells. Since
 * beams operate on `grid.smooth − grid.smoothSurface` and the topology
 * quantizer operates on `grid.smoothSurface`, the two passes are disjoint
 * — beams never affect single-cell placement.
 *
 * Returned together so the renderer can draw both.
 */
export interface MultiPassResult2 {
  beams: BeamPlacement[];
  plates: PlatePlacement[];
  arrangement: Arrangement;
}

export function quantizeMultiPass(
  grid: VoxelGrid,
  kit: KitBlock[],
  useSmooth: boolean = true,
): MultiPassResult2 {
  // Step A: interior beams (claims cells in grid.smooth − grid.smoothSurface)
  const beamResult = placeBeams(grid);
  // Step B: surface plates (claims cells in grid.smoothSurface where normals
  // align with one of 6 face directions)
  const plateResult = placePlates(grid, beamResult.claimed);
  // Step E: single-cell fallback for whatever's left of the surface
  const arrangement = quantizeByTopology(grid, kit, useSmooth, plateResult.claimed);
  return {
    beams: beamResult.beams,
    plates: plateResult.plates,
    arrangement,
  };
}

/**
 * Convenience: summarize a beam pass for the state JSON sink.
 */
export function summarizeBeams(beams: BeamPlacement[]): {
  count: number;
  totalCellsClaimed: number;
  byLength: Record<number, number>;
  byAxis: Record<Axis, number>;
} {
  const byLength: Record<number, number> = {};
  const byAxis: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  let totalCellsClaimed = 0;
  for (const beam of beams) {
    byLength[beam.length] = (byLength[beam.length] ?? 0) + 1;
    byAxis[beam.axis]++;
    totalCellsClaimed += beam.length;
  }
  return { count: beams.length, totalCellsClaimed, byLength, byAxis };
}

// ---------------------------------------------------------------------------
// Next pass stubs — Spec.v3.1 §6 steps B–F.
// Each follows the same template: take grid + claimed-set, return placements
// + updated claimed-set + remaining set.
// ---------------------------------------------------------------------------

// ===========================================================================
// Step B — Plate pass
// ===========================================================================

export interface PlatePlacement {
  /** Min-corner cell of the plate's footprint. */
  anchor: { x: number; y: number; z: number };
  /** Axis perpendicular to the plate's flat face (the thickness direction). */
  thicknessAxis: 'x' | 'y' | 'z';
  /** Sign of the face direction — which side of the model the plate is on. */
  faceSign: 1 | -1;
  /** Cells along the first perpendicular axis. */
  width: number;
  /** Cells along the second perpendicular axis. */
  depth: number;
  /** Voxel keys this plate claims. */
  cells: string[];
}

interface PlateFaceConfig {
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
  dir: [number, number, number];
  perpA: [number, number, number];
  perpB: [number, number, number];
}

const PLATE_FACES: PlateFaceConfig[] = [
  { axis: 'x', sign:  1, dir: [ 1, 0, 0], perpA: [0, 1, 0], perpB: [0, 0, 1] },
  { axis: 'x', sign: -1, dir: [-1, 0, 0], perpA: [0, 1, 0], perpB: [0, 0, 1] },
  { axis: 'y', sign:  1, dir: [ 0, 1, 0], perpA: [1, 0, 0], perpB: [0, 0, 1] },
  { axis: 'y', sign: -1, dir: [ 0,-1, 0], perpA: [1, 0, 0], perpB: [0, 0, 1] },
  { axis: 'z', sign:  1, dir: [ 0, 0, 1], perpA: [1, 0, 0], perpB: [0, 1, 0] },
  { axis: 'z', sign: -1, dir: [ 0, 0,-1], perpA: [1, 0, 0], perpB: [0, 1, 0] },
];

/**
 * Plate pass — tile flat regions of the smoothed surface with multi-cell
 * rectangular plates. A plate fits when:
 *   - All cells in its footprint are surface voxels (in grid.smoothSurface)
 *   - All cells have a surface normal that agrees with one face direction
 *     (dot product ≥ NORMAL_AGREEMENT)
 *   - None of the cells are already claimed by a previous pass (beams etc.)
 *
 * Plates are tried largest first within each face direction; the algorithm
 * is greedy with no backtracking.
 */
export function placePlates(
  grid: VoxelGrid,
  claimed: Set<string>,
  sizes: Array<[number, number]> = [[4, 4], [4, 2], [2, 4], [2, 2]],
): { plates: PlatePlacement[]; claimed: Set<string>; remaining: Set<string> } {
  const NORMAL_AGREEMENT = 0.85;
  const plates: PlatePlacement[] = [];
  const newClaimed = new Set(claimed);

  for (const cfg of PLATE_FACES) {
    // Surface voxels whose normal aligns with this face direction.
    const candidates = new Set<string>();
    for (const key of grid.smoothSurface) {
      if (newClaimed.has(key)) continue;
      const n = grid.normals.get(key);
      if (!n) continue;
      const dot = n.x * cfg.dir[0] + n.y * cfg.dir[1] + n.z * cfg.dir[2];
      if (dot >= NORMAL_AGREEMENT) candidates.add(key);
    }
    if (candidates.size === 0) continue;

    for (const [w, h] of sizes) {
      for (const startKey of candidates) {
        if (newClaimed.has(startKey)) continue;
        const [sx, sy, sz] = startKey.split(',').map(Number);

        // Verify the w×h footprint at this anchor fits in candidates and
        // isn't already claimed.
        const plateCells: string[] = [];
        let valid = true;
        for (let j = 0; j < h && valid; j++) {
          for (let i = 0; i < w && valid; i++) {
            const x = sx + i * cfg.perpA[0] + j * cfg.perpB[0];
            const y = sy + i * cfg.perpA[1] + j * cfg.perpB[1];
            const z = sz + i * cfg.perpA[2] + j * cfg.perpB[2];
            const k = voxelKey(x, y, z);
            if (!candidates.has(k) || newClaimed.has(k)) {
              valid = false;
              break;
            }
            plateCells.push(k);
          }
        }

        if (valid) {
          plates.push({
            anchor: { x: sx, y: sy, z: sz },
            thicknessAxis: cfg.axis,
            faceSign: cfg.sign,
            width: w,
            depth: h,
            cells: plateCells,
          });
          for (const k of plateCells) newClaimed.add(k);
        }
      }
    }
  }

  const remaining = new Set<string>();
  for (const key of grid.smoothSurface) {
    if (!newClaimed.has(key)) remaining.add(key);
  }
  return { plates, claimed: newClaimed, remaining };
}

export function summarizePlates(plates: PlatePlacement[]): {
  count: number;
  totalCellsClaimed: number;
  bySize: Record<string, number>;
  byAxis: Record<string, number>;
} {
  const bySize: Record<string, number> = {};
  const byAxis: Record<string, number> = { x: 0, y: 0, z: 0 };
  let totalCellsClaimed = 0;
  for (const p of plates) {
    const sizeKey = `${p.width}x${p.depth}`;
    bySize[sizeKey] = (bySize[sizeKey] ?? 0) + 1;
    byAxis[p.thicknessAxis]++;
    totalCellsClaimed += p.width * p.depth;
  }
  return { count: plates.length, totalCellsClaimed, bySize, byAxis };
}

/** Step C: detect 1-cell vertical transitions and place 1×N slope pieces. */
export function placeSlopes(
  _grid: VoxelGrid,
  _claimed: Set<string>,
): { slopes: never[]; claimed: Set<string>; remaining: Set<string> } {
  throw new Error('placeSlopes: not yet implemented — Spec.v3.1 §6 step C');
}

/** Step D: place chamfered cubes at remaining corner-meeting voxels. */
export function placeChamfers(
  _grid: VoxelGrid,
  _claimed: Set<string>,
): { chamfers: never[]; claimed: Set<string>; remaining: Set<string> } {
  throw new Error('placeChamfers: not yet implemented — Spec.v3.1 §6 step D');
}

/** Step F: place decorative pipes, rails, studs on already-placed pieces. */
export function placeDetails(
  _grid: VoxelGrid,
  _claimed: Set<string>,
  _placedBeams: BeamPlacement[],
): { details: never[]; claimed: Set<string> } {
  throw new Error('placeDetails: not yet implemented — Spec.v3.1 §6 step F');
}
