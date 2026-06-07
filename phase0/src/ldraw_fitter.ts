/**
 * LDraw piece fitter — Spec.v3.1 Stage 3.
 *
 * Greedy multi-pass that places LDraw parts into the solid voxel volume.
 *
 * Voxel-grid interpretation: anisotropic. 1 voxel = 20 LDU in X, 8 LDU in Y,
 * 20 LDU in Z (= 1 stud-width × 1 plate-height × 1 stud-width). So:
 *   - A standard brick is 3 voxels tall (3 plate-heights)
 *   - A plate is 1 voxel tall
 *   - A 2×4 brick is 4×3×2 voxels (X × Y × Z)
 *
 * Algorithm:
 *   1. Sort kit parts by descending footprint volume (largest first).
 *   2. For each part, scan candidate anchor positions in grid.smooth.
 *   3. Try each of 4 rotations around Y (0°, 90°, 180°, 270°) — distinct
 *      only when width ≠ depth.
 *   4. A placement is valid when every cell of the rotated footprint is
 *      inside grid.smooth AND not yet claimed.
 *   5. Place the part, mark its cells claimed, continue.
 *
 * Unclaimed cells after all parts are exhausted indicate gaps the kit
 * couldn't fill. Add a small fallback piece (e.g. 1×1 plate) for any
 * remaining 1-cell holes.
 */

import { voxelKey, type VoxelGrid } from './voxelize';
import type { LDrawPart } from './ldraw';

export interface LDrawPlacement {
  partId: string;
  /** Min-corner cell of the footprint. */
  anchor: { x: number; y: number; z: number };
  /** Rotation around Y axis: 0 = 0°, 1 = 90°, 2 = 180°, 3 = 270°. */
  rotation: 0 | 1 | 2 | 3;
  /** Effective footprint after rotation (in voxel cells). */
  footprint: { width: number; height: number; depth: number };
  /** Voxel keys claimed by this placement. */
  cells: string[];
}

export interface LDrawFitResult {
  placements: LDrawPlacement[];
  claimed: Set<string>;
  unclaimed: Set<string>;
}

interface Candidate {
  part: LDrawPart;
  /** Footprint volume in cells (for sort ordering). */
  volume: number;
}

/**
 * Sort candidates by descending volume so the fitter tries biggest pieces
 * first. Ties broken by part ID for determinism.
 */
function rankCandidates(parts: LDrawPart[]): Candidate[] {
  return parts
    .map((part) => ({
      part,
      volume: part.footprint.studsX * part.footprint.heightPlates * part.footprint.studsZ,
    }))
    .sort((a, b) => {
      if (b.volume !== a.volume) return b.volume - a.volume;
      return a.part.id.localeCompare(b.part.id);
    });
}

/**
 * Test whether a part with the given rotated footprint fits at anchor
 * (sx, sy, sz) inside the solid volume and outside the claimed set.
 * Returns the cell list on success, null on failure.
 */
function tryFootprint(
  solid: Set<string>,
  claimed: Set<string>,
  sx: number,
  sy: number,
  sz: number,
  w: number,
  h: number,
  d: number,
): string[] | null {
  const cells: string[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const k = voxelKey(sx + dx, sy + dy, sz + dz);
        if (!solid.has(k) || claimed.has(k)) return null;
        cells.push(k);
      }
    }
  }
  return cells;
}

function categorize(parts: LDrawPart[]): { plates: LDrawPart[]; bricks: LDrawPart[]; slopes: LDrawPart[]; tiles: LDrawPart[] } {
  const plates: LDrawPart[] = [];
  const bricks: LDrawPart[] = [];
  const slopes: LDrawPart[] = [];
  const tiles: LDrawPart[] = [];
  for (const part of parts) {
    const desc = part.description.trim().toLowerCase();
    // Tiles first — "Round" tiles (like 4150) should still flow into the
    // tile pass since they share the same flat-cap placement constraints
    // as regular tiles, just with rounded geometry.
    if (desc.startsWith('tile')) { tiles.push(part); continue; }
    // Other round/antenna/dome/dish parts are placed by their own targeted
    // passes — exclude here so the greedy bulk fills don't sprinkle them.
    // Headlight bricks have a side stud (SNOT) — need a face-direction-
    // aware pass we don't have yet; keep out of bulk for now.
    if (desc.includes('round') || desc.includes('antenna') ||
        desc.includes('dome') || desc.includes('dish') ||
        desc.includes('headlight')) continue;
    if (desc.includes('slope')) slopes.push(part);
    else if (desc.startsWith('plate')) plates.push(part);
    else if (desc.startsWith('brick')) bricks.push(part);
  }
  // Sort each category by descending footprint volume
  const byDescVolume = (a: LDrawPart, b: LDrawPart) =>
    (b.footprint.studsX * b.footprint.heightPlates * b.footprint.studsZ) -
    (a.footprint.studsX * a.footprint.heightPlates * a.footprint.studsZ);
  plates.sort(byDescVolume);
  bricks.sort(byDescVolume);
  slopes.sort(byDescVolume);
  tiles.sort(byDescVolume);
  return { plates, bricks, slopes, tiles };
}

function rasterOrder(cells: Set<string>): string[] {
  const arr: Array<[number, number, number, string]> = [];
  for (const key of cells) {
    const [x, y, z] = key.split(',').map(Number);
    arr.push([x, y, z, key]);
  }
  // Sort by Y, then Z, then X so the fitter scans bottom-up, back-to-front, left-to-right.
  arr.sort((a, b) => (a[1] - b[1]) || (a[2] - b[2]) || (a[0] - b[0]));
  return arr.map((a) => a[3]);
}

function orientationsFor(part: LDrawPart): Array<{ w: number; d: number; rotation: 0 | 1 }> {
  const { studsX, studsZ } = part.footprint;
  if (studsX === studsZ) return [{ w: studsX, d: studsZ, rotation: 0 }];
  return [
    { w: studsX, d: studsZ, rotation: 0 },
    { w: studsZ, d: studsX, rotation: 1 },
  ];
}

/** Place a part in the given candidate cells, requiring each placement to fit
 *  inside `solid` with no overlap with `claimed`. Mutates `claimed` and pushes
 *  placements into `out`. */
function placePartGreedy(
  part: LDrawPart,
  candidates: string[],
  solid: Set<string>,
  claimed: Set<string>,
  out: LDrawPlacement[],
): void {
  const baseH = part.footprint.heightPlates;
  const orientations = orientationsFor(part);
  for (const startKey of candidates) {
    if (claimed.has(startKey)) continue;
    const [sx, sy, sz] = startKey.split(',').map(Number);
    for (const { w, d, rotation } of orientations) {
      const cells = tryFootprint(solid, claimed, sx, sy, sz, w, baseH, d);
      if (cells) {
        out.push({
          partId: part.id,
          anchor: { x: sx, y: sy, z: sz },
          rotation,
          footprint: { width: w, height: baseH, depth: d },
          cells,
        });
        for (const c of cells) claimed.add(c);
        break;
      }
    }
  }
}

/** Place a plate (height-1 piece) on top-exposed cells only, so plates form
 *  visible flat caps on top surfaces rather than being hidden under bricks. */
function placePlateOnTop(
  part: LDrawPart,
  topExposed: Set<string>,
  candidates: string[],
  claimed: Set<string>,
  out: LDrawPlacement[],
): void {
  if (part.footprint.heightPlates !== 1) return; // only plates qualify
  const orientations = orientationsFor(part);
  for (const startKey of candidates) {
    if (claimed.has(startKey) || !topExposed.has(startKey)) continue;
    const [sx, sy, sz] = startKey.split(',').map(Number);
    for (const { w, d, rotation } of orientations) {
      const cells: string[] = [];
      let valid = true;
      for (let dz = 0; dz < d && valid; dz++) {
        for (let dx = 0; dx < w && valid; dx++) {
          const k = voxelKey(sx + dx, sy, sz + dz);
          if (!topExposed.has(k) || claimed.has(k)) {
            valid = false;
          } else {
            cells.push(k);
          }
        }
      }
      if (valid) {
        out.push({
          partId: part.id,
          anchor: { x: sx, y: sy, z: sz },
          rotation,
          footprint: { width: w, height: 1, depth: d },
          cells,
        });
        for (const c of cells) claimed.add(c);
        break;
      }
    }
  }
}

// ===========================================================================
// Slope cell patterns
// ===========================================================================
//
// LDraw slopes have angled geometry — their bounding box claims more cells
// than the slope's *solid* volume fills (e.g. the upper-front quadrant is
// "cut away" by the slope's angled face). The fitter must require ONLY the
// cells that the slope's geometry actually fills, not the full bbox,
// otherwise slopes never fit at the edges they're designed for.
//
// Each pattern lists filled-cell offsets relative to the part's min-corner
// anchor, with one entry per 90°-around-Y rotation. Coordinates are
// non-negative integers in voxel cells.
//
// The patterns below are derived from the LDraw spec: a 45° slope rises
// across `slopeRun` studs of depth, full brick-height at the back, dropping
// to 0 at the front. The front column(s) have only the bottom (Y=0) cell
// filled (representing the brick floor under the slope's angled face).

type SlopePattern = {
  footprint: [number, number, number];
  cells: Array<[number, number, number]>;
};

type SlopeRotations = [SlopePattern, SlopePattern, SlopePattern, SlopePattern];

function buildSlope45Pattern(width: number, run: number): SlopeRotations {
  // Canonical orientation: high side at +Z, low side at -Z (Z=0).
  // Body extends X = 0..width-1, Y = 0..2 (brick height), Z = 0..run-1.
  // Filled cells: every X column has full height at Z = run-1 (the back),
  // and only Y=0 filled for Z < run-1 (the floor under the slope).
  function build(w: number, r: number): Array<[number, number, number]> {
    const cells: Array<[number, number, number]> = [];
    for (let x = 0; x < w; x++) {
      // Back column: full 3 cells of height
      cells.push([x, 0, r - 1]);
      cells.push([x, 1, r - 1]);
      cells.push([x, 2, r - 1]);
      // Front floor cells: just Y=0
      for (let z = 0; z < r - 1; z++) {
        cells.push([x, 0, z]);
      }
    }
    return cells;
  }

  // Generate 90° / 180° / 270° rotations by transforming the base pattern.
  const base = build(width, run);
  const r90: Array<[number, number, number]> = base.map(([x, y, z]) => [z, y, width - 1 - x]);
  const r180: Array<[number, number, number]> = base.map(([x, y, z]) => [width - 1 - x, y, run - 1 - z]);
  const r270: Array<[number, number, number]> = base.map(([x, y, z]) => [run - 1 - z, y, x]);

  return [
    { footprint: [width, 3, run], cells: base },
    { footprint: [run, 3, width], cells: r90 },
    { footprint: [width, 3, run], cells: r180 },
    { footprint: [run, 3, width], cells: r270 },
  ];
}

/**
 * Pattern builder for non-45° slopes (curved slopes, shallow slopes).
 *
 * Models the slope surface as a linear ramp from `heightFront` at z=0 to
 * `heightBack` at z=run-1 (in plate-cell units). At each z, fills cells
 * y=0..floor(surface) — the solid volume under the angled face.
 *
 * Use for: curved 2×1/3×1/4×1 (LDraw 11477/50950/61678) and shallow
 * slopes like 30363 (Slope 18 4×2) that rise gradually over a long run.
 */
function buildSlopePattern(
  width: number,
  run: number,
  heightFront: number,
  heightBack: number,
  totalHeight: number,
): SlopeRotations {
  function build(w: number, r: number): Array<[number, number, number]> {
    const cells: Array<[number, number, number]> = [];
    const denom = Math.max(1, r - 1);
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < r; z++) {
        const surface = heightFront + (z * (heightBack - heightFront)) / denom;
        // Round to nearest cell so the linear ramp matches the geometry's
        // approximate filled volume per layer (under-claim trims edge cells
        // that might or might not be in the model; the void check around
        // them will reject placements that don't fit).
        const fillHeight = Math.max(1, Math.round(surface));
        for (let y = 0; y < fillHeight; y++) cells.push([x, y, z]);
      }
    }
    return cells;
  }
  const base = build(width, run);
  const r90: Array<[number, number, number]> = base.map(([x, y, z]) => [z, y, width - 1 - x]);
  const r180: Array<[number, number, number]> = base.map(([x, y, z]) => [width - 1 - x, y, run - 1 - z]);
  const r270: Array<[number, number, number]> = base.map(([x, y, z]) => [run - 1 - z, y, x]);
  return [
    { footprint: [width, totalHeight, run], cells: base },
    { footprint: [run, totalHeight, width], cells: r90 },
    { footprint: [width, totalHeight, run], cells: r180 },
    { footprint: [run, totalHeight, width], cells: r270 },
  ];
}

// Mapping from LDraw part ID → rotation-indexed cell patterns. Only the
// slopes we have in the curated manifest are listed; missing entries fall
// back to bbox fitting (which is fine for non-slope parts).
const SLOPE_PATTERNS: Record<string, SlopeRotations> = {
  '3040b': buildSlope45Pattern(1, 2),  // Slope 45 2x1: 1 stud wide, 2 deep
  '3039':  buildSlope45Pattern(2, 2),  // Slope 45 2x2
  '3038':  buildSlope45Pattern(3, 2),  // Slope 45 2x3
  '3037':  buildSlope45Pattern(4, 2),  // Slope 45 2x4
  // 3298 (Slope 33 3x2) and 3299 (Slope 33 2x4 Double) have non-45°
  // angles; their cell patterns differ. Approximated as 45° slopes here
  // — the rendered geometry preserves the true angle, only the cell-fit
  // check is approximated.
  '3298':  buildSlope45Pattern(2, 3),  // approximate
  '3299':  buildSlope45Pattern(4, 2),  // approximate

  // Curved slopes — linear-ramp approximation of their angled face.
  // 11477 is half-height (2 plates) so it's effectively a smooth "roof"
  // piece, used as a curved cap on top of plates. The longer 3×1 / 4×1
  // variants are brick-height with the curve concentrated near the front.
  '11477': buildSlopePattern(1, 2, 1, 2, 2),  // Curved 2x1, 1×2×2p
  '50950': buildSlopePattern(1, 3, 1, 3, 3),  // Curved 3x1, 1×3×3p
  '61678': buildSlopePattern(1, 4, 1, 3, 3),  // Curved 4x1, 1×4×3p
  '30363': buildSlopePattern(2, 4, 1, 3, 3),  // Slope 18 4x2 (shallow), 2×4×3p
};

function tryPattern(
  pattern: SlopePattern,
  sx: number,
  sy: number,
  sz: number,
  solid: Set<string>,
  claimed: Set<string>,
): string[] | null {
  // Walk every cell in the slope's bbox. Filled cells must be in solid AND
  // unclaimed (the slope's solid volume goes here). Void cells must be
  // OUTSIDE the solid — they're the air above the angled face, and if the
  // model's volume continues into them, this isn't a silhouette edge and
  // the slope doesn't belong here.
  const filledKey = new Set(pattern.cells.map(([x, y, z]) => `${x},${y},${z}`));
  const [W, H, D] = pattern.footprint;
  const cells: string[] = [];
  for (let dy = 0; dy < H; dy++) {
    for (let dz = 0; dz < D; dz++) {
      for (let dx = 0; dx < W; dx++) {
        const worldKey = voxelKey(sx + dx, sy + dy, sz + dz);
        if (filledKey.has(`${dx},${dy},${dz}`)) {
          if (!solid.has(worldKey) || claimed.has(worldKey)) return null;
          cells.push(worldKey);
        } else if (solid.has(worldKey)) {
          return null; // void cell is inside the model — wrong place for a slope
        }
      }
    }
  }
  return cells;
}

function placeSlopesAtEdges(
  slope: LDrawPart,
  candidates: string[],
  solid: Set<string>,
  claimed: Set<string>,
  out: LDrawPlacement[],
): void {
  const patterns = SLOPE_PATTERNS[slope.id];
  if (!patterns) return;

  for (const startKey of candidates) {
    if (claimed.has(startKey)) continue;
    const [sx, sy, sz] = startKey.split(',').map(Number);

    for (let rot = 0; rot < 4; rot++) {
      const pattern = patterns[rot];
      const cells = tryPattern(pattern, sx, sy, sz, solid, claimed);
      if (cells) {
        out.push({
          partId: slope.id,
          anchor: { x: sx, y: sy, z: sz },
          rotation: rot as 0 | 1 | 2 | 3,
          footprint: { width: pattern.footprint[0], height: pattern.footprint[1], depth: pattern.footprint[2] },
          cells,
        });
        for (const c of cells) claimed.add(c);
        break;
      }
    }
  }
}

/**
 * Place an antenna (3957 — 1×1×12-plate spire) at the top of an isolated thin
 * column. The column must be 1 stud wide at every Y level (no neighbours
 * touching it sideways) for at least the antenna's full height, so the
 * geometry can't visually clash with adjacent volume.
 */
function placeAntennas(
  antenna: LDrawPart,
  topExposed: Set<string>,
  solid: Set<string>,
  claimed: Set<string>,
  out: LDrawPlacement[],
): void {
  const H = antenna.footprint.heightPlates;
  const isolated = (x: number, y: number, z: number): boolean =>
    !solid.has(voxelKey(x + 1, y, z)) && !solid.has(voxelKey(x - 1, y, z)) &&
    !solid.has(voxelKey(x, y, z + 1)) && !solid.has(voxelKey(x, y, z - 1));

  for (const key of topExposed) {
    if (claimed.has(key)) continue;
    const [x, y, z] = key.split(',').map(Number);
    if (!isolated(x, y, z)) continue;

    // Walk down H-1 cells. Each must be in solid, unclaimed, and isolated.
    const cells: string[] = [key];
    let ok = true;
    for (let dy = 1; dy < H; dy++) {
      const cy = y - dy;
      const k = voxelKey(x, cy, z);
      if (!solid.has(k) || claimed.has(k) || !isolated(x, cy, z)) { ok = false; break; }
      cells.push(k);
    }
    if (!ok) continue;

    out.push({
      partId: antenna.id,
      anchor: { x, y: y - H + 1, z },
      rotation: 0,
      footprint: { width: 1, height: H, depth: 1 },
      cells,
    });
    for (const c of cells) claimed.add(c);
  }
}

/**
 * Place a 4×4 dome (86500) at the top of an isolated tower where the cell
 * counts per Y layer decrease as you go up — i.e. the model's surface is
 * actually curving inward like a hemisphere. The dome geometry fills the
 * curved interior of its 4×4×5 bbox; cells in the bbox that aren't in solid
 * stay unclaimed.
 */
function placeDome4x4(
  dome: LDrawPart,
  candidates: string[],
  solid: Set<string>,
  claimed: Set<string>,
  out: LDrawPlacement[],
): void {
  const W = 4, D = 4;
  const H = dome.footprint.heightPlates;

  // 16-cell ring around a 4×4 footprint (per Y layer).
  const ringOffsets: Array<[number, number]> = [];
  for (let i = -1; i <= W; i++) { ringOffsets.push([i, -1]); ringOffsets.push([i, D]); }
  for (let j = 0; j < D; j++)    { ringOffsets.push([-1, j]); ringOffsets.push([W, j]); }

  // Hemispheric coverage thresholds — minimum cells filled per Y layer
  // (out of 16). A perfect oblate hemisphere is roughly [16, 16, 12, 8, 4].
  const minPerLayer = [16, 12, 8, 4, 1];

  for (const startKey of candidates) {
    if (claimed.has(startKey)) continue;
    const [sx, sy, sz] = startKey.split(',').map(Number);

    // Ring at every Y level of the dome must be empty (free-standing tower).
    let isolated = true;
    for (let dy = 0; dy < H && isolated; dy++) {
      for (const [rx, rz] of ringOffsets) {
        if (solid.has(voxelKey(sx + rx, sy + dy, sz + rz))) { isolated = false; break; }
      }
    }
    if (!isolated) continue;

    // Cell directly above the dome's centre 2×2 must be empty (dome is on top).
    let topClear = true;
    for (let dz = 1; dz < D - 1 && topClear; dz++) {
      for (let dx = 1; dx < W - 1 && topClear; dx++) {
        if (solid.has(voxelKey(sx + dx, sy + H, sz + dz))) { topClear = false; break; }
      }
    }
    if (!topClear) continue;

    // Per-layer cell counts must clear the hemispheric thresholds, monotonically.
    const layerCounts: number[] = [];
    let coverageOk = true;
    for (let dy = 0; dy < H && coverageOk; dy++) {
      let count = 0;
      for (let dz = 0; dz < D; dz++) {
        for (let dx = 0; dx < W; dx++) {
          if (solid.has(voxelKey(sx + dx, sy + dy, sz + dz))) count++;
        }
      }
      if (count < minPerLayer[dy]) coverageOk = false;
      if (dy > 0 && count > layerCounts[dy - 1]) coverageOk = false;
      layerCounts.push(count);
    }
    if (!coverageOk) continue;

    // Validate every solid cell in the box is still unclaimed, then claim them.
    const cells: string[] = [];
    let claimOk = true;
    for (let dy = 0; dy < H && claimOk; dy++) {
      for (let dz = 0; dz < D && claimOk; dz++) {
        for (let dx = 0; dx < W && claimOk; dx++) {
          const k = voxelKey(sx + dx, sy + dy, sz + dz);
          if (solid.has(k)) {
            if (claimed.has(k)) { claimOk = false; break; }
            cells.push(k);
          }
        }
      }
    }
    if (!claimOk) continue;

    out.push({
      partId: dome.id,
      anchor: { x: sx, y: sy, z: sz },
      rotation: 0,
      footprint: { width: W, height: H, depth: D },
      cells,
    });
    for (const c of cells) claimed.add(c);
  }
}

/**
 * Place an N×N round part (brick or plate) only where the footprint is a
 * genuine free-standing cylindrical feature — every cell in the ring
 * around the N×N must be empty at every Y level of the part. That restricts
 * placement to actual towers / nozzles / turrets, not concave edges (which
 * would otherwise eat slope placements).
 *
 * For plates we additionally require the top to be exposed (cell above is
 * empty) so they only land as caps on round towers, never mid-stack.
 */
function placeRoundColumn(
  part: LDrawPart,
  candidates: string[],
  solid: Set<string>,
  claimed: Set<string>,
  out: LDrawPlacement[],
  width: number,
  requireTopExposed: boolean,
): void {
  const W = width, D = width;
  const H = part.footprint.heightPlates;

  // All cells forming the ring around an N×N footprint (4 edges + 4 corners).
  const ringOffsets: Array<[number, number]> = [];
  for (let i = -1; i <= W; i++) {
    ringOffsets.push([i, -1]);
    ringOffsets.push([i, D]);
  }
  for (let j = 0; j < D; j++) {
    ringOffsets.push([-1, j]);
    ringOffsets.push([W, j]);
  }

  for (const startKey of candidates) {
    if (claimed.has(startKey)) continue;
    const [sx, sy, sz] = startKey.split(',').map(Number);

    // 2×H×2 box must all be in solid, none claimed.
    const cells: string[] = [];
    let ok = true;
    for (let dy = 0; dy < H && ok; dy++) {
      for (let dz = 0; dz < D && ok; dz++) {
        for (let dx = 0; dx < W && ok; dx++) {
          const k = voxelKey(sx + dx, sy + dy, sz + dz);
          if (!solid.has(k) || claimed.has(k)) { ok = false; break; }
          cells.push(k);
        }
      }
    }
    if (!ok) continue;

    // The 8-cell ring around the 2×2 must be empty at every Y level of the
    // part — confirms this is a stand-alone column, not a corner of a slab.
    let isolated = true;
    for (let dy = 0; dy < H && isolated; dy++) {
      for (const [rx, rz] of ringOffsets) {
        if (solid.has(voxelKey(sx + rx, sy + dy, sz + rz))) { isolated = false; break; }
      }
    }
    if (!isolated) continue;

    // For caps (plates), only fit where the cell above is genuinely empty —
    // i.e. this is the top of a round feature, not buried inside one.
    if (requireTopExposed) {
      const yAbove = sy + H;
      let anyTopOpen = false;
      for (let dz = 0; dz < D; dz++) {
        for (let dx = 0; dx < W; dx++) {
          if (!solid.has(voxelKey(sx + dx, yAbove, sz + dz))) { anyTopOpen = true; break; }
        }
        if (anyTopOpen) break;
      }
      if (!anyTopOpen) continue;
    }

    out.push({
      partId: part.id,
      anchor: { x: sx, y: sy, z: sz },
      rotation: 0,
      footprint: { width: W, height: H, depth: D },
      cells,
    });
    for (const c of cells) claimed.add(c);
  }
}

/**
 * For every slope placement, drop a 1×1 plate directly underneath each cell
 * of its bottom layer that's currently empty. Curved/shallow slopes often
 * sit at the bottom edge of a feature where the model's voxelisation didn't
 * fill the cells below, leaving the slope visibly hanging over a void; this
 * pass closes that gap with the smallest piece available.
 *
 * Plates are added at cells outside the smoothed solid — they're decorative
 * support, extending the model slightly beyond its voxelised silhouette.
 */
function fillUnderSlopes(
  slopes: LDrawPart[],
  placements: LDrawPlacement[],
  onexone: LDrawPart,
  solid: Set<string>,
  claimed: Set<string>,
): void {
  const slopeIds = new Set(slopes.map((p) => p.id));
  // Snapshot length — we'll append to `placements` during iteration and
  // don't want to re-process the new 1×1 plates we just added.
  const initialLen = placements.length;
  for (let i = 0; i < initialLen; i++) {
    const p = placements[i];
    if (!slopeIds.has(p.partId)) continue;
    const yBelow = p.anchor.y - 1;
    if (yBelow < 0) continue;
    for (let dz = 0; dz < p.footprint.depth; dz++) {
      for (let dx = 0; dx < p.footprint.width; dx++) {
        const x = p.anchor.x + dx;
        const z = p.anchor.z + dz;
        const k = voxelKey(x, yBelow, z);
        if (solid.has(k) || claimed.has(k)) continue;
        placements.push({
          partId: onexone.id,
          anchor: { x, y: yBelow, z },
          rotation: 0,
          footprint: { width: 1, height: 1, depth: 1 },
          cells: [k],
        });
        claimed.add(k);
      }
    }
  }
}

/**
 * Multi-pass fitter:
 *   Pass N — antennas at isolated thin protrusions (signature spires)
 *   Pass D — 4×4 domes at hemispheric isolated tower tops
 *   Pass S — slopes at silhouette edges
 *   Pass R — 2×2 round bricks/plates at isolated cylindrical features
 *   Pass T — smooth tiles on top-exposed cells (visible stud-free finish)
 *   Pass A — plates on remaining top-exposed cells
 *   Pass B — bricks fill the bulk (interior + sides)
 *   Pass C — plates everywhere else (catches < 3-cell-tall residuals)
 *   Pass Z — 1×1 plate fallback for any single-cell holes
 *   Pass U — 1×1 plate supports beneath each slope's bottom layer
 *
 * Each pass picks the largest part of its category first, so the model
 * reads as detail-pieces-at-edges + plates-over-brick-chassis rather
 * than a brick mountain.
 */
export function placeLDrawParts(grid: VoxelGrid, parts: LDrawPart[]): LDrawFitResult {
  const solid = grid.smooth;
  const claimed = new Set<string>();
  const placements: LDrawPlacement[] = [];
  const { plates, bricks, slopes, tiles } = categorize(parts);
  const ordered = rasterOrder(solid);

  // Pre-compute top-exposed cells (no neighbour in +Y direction).
  const topExposed = new Set<string>();
  for (const key of solid) {
    const [x, y, z] = key.split(',').map(Number);
    if (!solid.has(voxelKey(x, y + 1, z))) topExposed.add(key);
  }

  // Pass N — antennas: tall isolated thin protrusions become signature spires.
  const antenna = parts.find((p) => p.id === '3957');
  if (antenna) placeAntennas(antenna, topExposed, solid, claimed, placements);

  // Pass D — 4×4 dome: spherical pods / large round caps. Runs early so it
  // can claim its full bbox before smaller passes start sprinkling parts.
  const dome = parts.find((p) => p.id === '86500');
  if (dome) placeDome4x4(dome, ordered, solid, claimed, placements);

  // Pass S — slopes at edges. Slope cell patterns only match where the
  // model's geometry has the right L-shape, so they fit at silhouette
  // edges without false-positives on the bulk. Run this BEFORE round 2×2
  // so slopes win concave corners — round 2×2 is only for genuine isolated
  // cylindrical features (towers, nozzles), not generic curved edges.
  for (const part of slopes) placeSlopesAtEdges(part, ordered, solid, claimed, placements);

  // Pass R — round pieces at isolated cylindrical features. 2×2 first
  // (greedy big-piece preference), then 1×1 for thinner single-cell columns.
  // Bricks (3 cells tall) for column bodies; plates (1 cell) as top caps.
  const round2x2Brick = parts.find((p) => p.id === '3941');
  if (round2x2Brick) placeRoundColumn(round2x2Brick, ordered, solid, claimed, placements, 2, false);
  const round2x2Plate = parts.find((p) => p.id === '4032');
  if (round2x2Plate) placeRoundColumn(round2x2Plate, ordered, solid, claimed, placements, 2, true);
  const round1x1Brick = parts.find((p) => p.id === '3062');
  if (round1x1Brick) placeRoundColumn(round1x1Brick, ordered, solid, claimed, placements, 1, false);
  const round1x1Plate = parts.find((p) => p.id === '6141');
  if (round1x1Plate) placeRoundColumn(round1x1Plate, ordered, solid, claimed, placements, 1, true);

  // Pass T — smooth tiles on top-exposed cells. Tiles run BEFORE plates so
  // visible top surfaces get a stud-free finish; any cells the tiles can't
  // fit (odd shapes) fall through to the plate pass that follows.
  for (const part of tiles) placePlateOnTop(part, topExposed, ordered, claimed, placements);

  // Pass A — large plates on the model's roof (residual top cells where no
  // tile size fit).
  for (const part of plates) placePlateOnTop(part, topExposed, ordered, claimed, placements);

  // Pass B — bricks for the bulk.
  for (const part of bricks) placePartGreedy(part, ordered, solid, claimed, placements);

  // Pass C — remaining plates anywhere (catches residuals where brick height didn't fit).
  for (const part of plates) placePartGreedy(part, ordered, solid, claimed, placements);

  // Pass D — single 1×1 plate fallback for any stragglers.
  const onexone = plates.find((p) => p.id === '3024');
  if (onexone) placePartGreedy(onexone, ordered, solid, claimed, placements);

  // Pass U — under-slope supports. Curved slopes often overhang into space
  // the model's voxelisation didn't fill (the curve descends past the body's
  // actual silhouette), leaving the slope hanging in air with a visible gap
  // beneath it. Walk every slope placement's bottom layer and drop a 1×1
  // plate at any cell directly below that's currently empty.
  if (onexone) fillUnderSlopes(slopes, placements, onexone, solid, claimed);

  const unclaimed = new Set<string>();
  for (const key of solid) {
    if (!claimed.has(key)) unclaimed.add(key);
  }
  return { placements, claimed, unclaimed };
}

// rankCandidates kept for callers that want a flat priority list (currently
// unused but exposed for experimentation).
export { rankCandidates };

/**
 * Summary stats for the state JSON.
 */
export function summarizeLDrawFit(result: LDrawFitResult): {
  count: number;
  cellsClaimed: number;
  cellsUnclaimed: number;
  coverage: number;
  byPart: Record<string, number>;
} {
  const byPart: Record<string, number> = {};
  for (const p of result.placements) {
    byPart[p.partId] = (byPart[p.partId] ?? 0) + 1;
  }
  const cellsClaimed = result.claimed.size;
  const cellsUnclaimed = result.unclaimed.size;
  const total = cellsClaimed + cellsUnclaimed;
  return {
    count: result.placements.length,
    cellsClaimed,
    cellsUnclaimed,
    coverage: total > 0 ? cellsClaimed / total : 0,
    byPart,
  };
}
