/**
 * Physics sanity check for LDraw placements.
 *
 * Two pieces are connected if any of their cells share a face — vertical
 * OR lateral. Lateral adjacency isn't a real Lego connection per se, but
 * it represents a join that's bridgeable with a Technic pin, bracket, or
 * sideways-stud piece in a real build. We flag the pass as a "buildability"
 * diagnostic: pieces that touch *something* are repairable; pieces hanging
 * in space with no neighbours at all are not.
 *
 * The pass walks connected components from anything touching y=0 and
 * flags any piece that isn't in a grounded component as floating.
 */

import { voxelKey } from './voxelize';
import type { LDrawPlacement } from './ldraw_fitter';

export interface PhysicsCheck {
  /** Indices into the input `placements` array that have no support chain to y=0. */
  floating: Set<number>;
  /** Total voxel cells claimed by floating pieces (for stats). */
  floatingCells: number;
}

/**
 * For every pair of touching placements, sum the cell-face contacts between
 * them — the "bond strength." Two stacked 2×4 bricks share an 8-cell face;
 * a 1×1 plate balanced on a brick shares 1. The explode sim uses this to
 * decide which bonds survive a detonation (strong = piece stays attached
 * to its neighbour) and which break (weak = pieces fly apart).
 */
export interface AdjacencyBond {
  a: number;       // index into placements
  b: number;       // index into placements (a < b)
  sharedFaces: number;
}
export function computeAdjacency(placements: LDrawPlacement[]): AdjacencyBond[] {
  if (placements.length === 0) return [];
  const cellOwner = new Map<string, number>();
  for (let i = 0; i < placements.length; i++) {
    for (const c of placements[i].cells) cellOwner.set(c, i);
  }
  const FACES: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  // Pair key (a*N + b) → shared face count.
  const counts = new Map<number, number>();
  const N = placements.length;
  for (let i = 0; i < placements.length; i++) {
    for (const cell of placements[i].cells) {
      const [x, y, z] = cell.split(',').map(Number);
      for (const [dx, dy, dz] of FACES) {
        const nKey = voxelKey(x + dx, y + dy, z + dz);
        const other = cellOwner.get(nKey);
        if (other === undefined || other === i) continue;
        const a = Math.min(i, other), b = Math.max(i, other);
        // Each shared face will be visited from BOTH sides — count once
        // by only incrementing from the lower-index side.
        if (i !== a) continue;
        const key = a * N + b;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const bonds: AdjacencyBond[] = [];
  for (const [key, sharedFaces] of counts) {
    bonds.push({ a: Math.floor(key / N), b: key % N, sharedFaces });
  }
  return bonds;
}

/**
 * Mark placements that are completely enclosed by other claimed cells on
 * every external face — they're physically inside the model and never seen
 * from outside, so we can skip rendering them as an optimisation.
 *
 * Pass `otherCells` to include cells covered by something other than these
 * placements (e.g. the kit-block fallback fill) — without it we'd flag
 * boundary placements adjacent to kit cells as exposed.
 */
export function findHiddenPlacements(
  placements: LDrawPlacement[],
  otherCells?: ReadonlySet<string>,
): boolean[] {
  const covered = new Set<string>();
  for (const p of placements) for (const c of p.cells) covered.add(c);
  if (otherCells) for (const c of otherCells) covered.add(c);

  const FACES: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];

  return placements.map((p) => {
    const own = new Set(p.cells);
    for (const cell of p.cells) {
      const [x, y, z] = cell.split(',').map(Number);
      for (const [dx, dy, dz] of FACES) {
        const nKey = voxelKey(x + dx, y + dy, z + dz);
        if (own.has(nKey)) continue;
        if (!covered.has(nKey)) return false; // exposed face
      }
    }
    return true; // every external face is touching another covered cell
  });
}

export function checkPhysics(placements: LDrawPlacement[]): PhysicsCheck {
  if (placements.length === 0) return { floating: new Set(), floatingCells: 0 };

  // Map every claimed cell back to its owner placement index.
  const cellOwner = new Map<string, number>();
  for (let i = 0; i < placements.length; i++) {
    for (const c of placements[i].cells) cellOwner.set(c, i);
  }

  // Build a 6-direction face-adjacency graph: piece i is connected to piece
  // j if any cell of one shares a face with any cell of the other. Captures
  // both vertical (stud-tube) connections and lateral neighbours (joinable
  // via a Technic pin / bracket / sideways stud in a real build).
  // Anything resting on y=0 seeds the grounded set.
  const adj: Set<number>[] = placements.map(() => new Set<number>());
  const groundResting = new Set<number>();
  const NEIGHBOURS: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (let i = 0; i < placements.length; i++) {
    for (const cell of placements[i].cells) {
      const [x, y, z] = cell.split(',').map(Number);
      if (y === 0) groundResting.add(i);
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const owner = cellOwner.get(voxelKey(x + dx, y + dy, z + dz));
        if (owner !== undefined && owner !== i) {
          adj[i].add(owner);
          adj[owner].add(i);
        }
      }
    }
  }

  // BFS connected components from anything touching the ground.
  const supported = new Set<number>(groundResting);
  const queue = [...groundResting];
  while (queue.length > 0) {
    const i = queue.shift()!;
    for (const j of adj[i]) {
      if (supported.has(j)) continue;
      supported.add(j);
      queue.push(j);
    }
  }

  const floating = new Set<number>();
  let floatingCells = 0;
  for (let i = 0; i < placements.length; i++) {
    if (!supported.has(i)) {
      floating.add(i);
      floatingCells += placements[i].cells.length;
    }
  }
  return { floating, floatingCells };
}
