/**
 * Bounding-box analysis + footprint inference for resolved LDraw parts.
 *
 * LDraw units (LDU):
 *   1 stud (X/Z width)     = 20 LDU
 *   1 brick height (Y)     = 24 LDU
 *   1 plate height (Y)     = 8  LDU
 *
 * Coord convention: -Y is "up" in LDraw. The bbox is reported in raw LDU
 * (no flip applied) so downstream consumers can decide whether to flip.
 *
 * Stud footprint is reported as (studsX, studsZ, heightPlates) — width and
 * depth in stud units, height in plate units (8 LDU). For a 2×4 brick this
 * comes out to (4, 2, 3) — 4 wide, 2 deep, 3 plates tall (= 1 brick).
 */

import type { ResolvedTriangle } from './resolve.js';

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface Footprint {
  /** Cells along X in stud-width units. */
  studsX: number;
  /** Cells along Z in stud-width units. */
  studsZ: number;
  /** Vertical extent in plate-height units (8 LDU each). */
  heightPlates: number;
}

const STUD_LDU = 20;
const PLATE_LDU = 8;
/** Studs protrude ~4 LDU above the brick/plate body. Subtract before
 *  computing height-in-plate-units so a 1-brick-tall piece reads as 3 plates
 *  (= 24 LDU body), not 4 (= 28 LDU body+stud). */
const STUD_PROTRUSION_LDU = 4;

export function computeBoundingBox(triangles: ResolvedTriangle[]): BoundingBox {
  if (triangles.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of triangles) {
    for (const v of [t.v1, t.v2, t.v3]) {
      if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
    }
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

export function inferFootprint(bbox: BoundingBox): Footprint {
  const bodyHeight = Math.max(0, bbox.size[1] - STUD_PROTRUSION_LDU);
  return {
    studsX: Math.max(1, Math.round(bbox.size[0] / STUD_LDU)),
    studsZ: Math.max(1, Math.round(bbox.size[2] / STUD_LDU)),
    heightPlates: Math.max(1, Math.round(bodyHeight / PLATE_LDU)),
  };
}
