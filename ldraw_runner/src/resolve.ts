/**
 * Recursive subpart resolver.
 *
 * Takes a top-level part filename, walks its tree of Type-1 references,
 * applies the cumulative position + 3×3 rotation transforms, splits Type-4
 * quads into two triangles, resolves the "inherit colour" sentinel (16),
 * and returns a flat list of world-space triangles.
 *
 * Transform composition: if a parent has transform (T_p, M_p) and contains
 * a subpart line (T_l, M_l) which itself contains geometry at point p_local,
 * the world-space position is
 *
 *     p_world = T_p + M_p · (T_l + M_l · p_local)
 *             = (T_p + M_p · T_l) + (M_p · M_l) · p_local
 *
 * so the new translation is T_p + M_p · T_l and the new rotation is M_p · M_l.
 */

import { fetchDat } from './fetch.js';
import { parseDat, type ParsedDat, type DatSubpart } from './parse.js';

export interface ResolvedTriangle {
  /** Three world-space vertices, each [x, y, z] in LDU. */
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
  /** Resolved LDraw colour code (inheritance applied). */
  color: number;
  /** Whether this triangle should be flipped (BFC winding). */
  flip: boolean;
}

/**
 * A connection point on a part: a stud, anti-stud, pin-hole, axle-hole, etc.
 *
 * Each is detected by the recursive resolver when a Type-1 line references
 * one of the well-known LDraw connection primitives (stud.dat, peghol3.dat,
 * axlehol*.dat, etc.). The position/rotation reflect the accumulated
 * transform from the top-level part to this primitive — i.e. they're the
 * connection's coords in the part's local frame.
 *
 * Connections are extracted in addition to (not in place of) the triangle
 * mesh — the renderable geometry still includes the primitive's triangles.
 */
export interface ConnectionPoint {
  /** Connection category. Mating rules constrain which pairs can attach. */
  type: 'stud' | 'anti_stud' | 'pin_hole' | 'axle_hole' | 'connect';
  /** Position in part-local LDU coords. */
  position: [number, number, number];
  /** 3×3 row-major orientation matrix. The connection's "up" direction is
   *  rotation @ (0, -1, 0) since LDraw is -Y-up.  */
  rotation: Mat3;
  /** Filename of the primitive that triggered the detection (for debug). */
  primitive: string;
}

export interface ResolvedPart {
  /** Filename without .dat (e.g. "3001"). */
  id: string;
  /** From the part's first `0` comment. */
  description: string;
  /** From `0 !CATEGORY` if present. */
  category: string | null;
  triangles: ResolvedTriangle[];
  connections: ConnectionPoint[];
}

type Mat3 = [number, number, number, number, number, number, number, number, number];
type Vec3 = [number, number, number];

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Map from LDraw connection-primitive filename → connection category.
 *
 * We detect these during recursive resolve and record their transformed
 * positions. Note: LDraw doesn't have 1-to-1 named primitives for every
 * attachment feature.
 *
 *   STUDS are explicit — each `stud*.dat` reference is one literal stud.
 *   ANTI-STUDS are implicit — the cavity is formed by interior tube
 *     primitives (stud3a/stud4/stud4o) that don't 1-to-1 correspond to
 *     anti-stud positions. We DERIVE anti-studs parametrically downstream
 *     (mirror each stud's X/Z to the bottom face) rather than from these.
 *   PIN-HOLES use `peghole.dat` — but this primitive is a half-hole "end"
 *     placed in pairs (one per side of the brick) to form one through-hole.
 *     We detect both and dedup downstream.
 *   AXLE-HOLES use `axlehol*.dat` and have many size variants.
 *
 * Mating rules (for downstream socket code):
 *   stud      ↔ anti_stud
 *   pin_hole  ↔ pin_hole       (a pin spans two coaxial pin-holes)
 *   axle_hole ↔ axle_hole       (similarly for axles)
 *   connect   ↔ connect         (generic connector — could be either side)
 */
export const CONNECTION_PRIMITIVES: Readonly<Record<string, ConnectionPoint['type']>> = {
  // Real studs (the cylinders sticking up on top of bricks/plates).
  'stud.dat':     'stud',
  'stud2.dat':    'stud',
  'stud2a.dat':   'stud',
  'stud3.dat':    'stud',
  // 'stud4.dat' is "Stud Tube Open" — NOT a stud, it's anti-stud cavity geometry.
  'stud4a.dat':   'stud',
  'stud4h.dat':   'stud',
  'stud4s.dat':   'stud',
  'studa.dat':    'stud',
  'studel.dat':   'stud',
  'studp01.dat':  'stud',
  // Technic pin-hole ends (used in pairs to form one through-hole).
  'peghole.dat':    'pin_hole',
  'peghol3.dat':    'pin_hole',
  'peghol3a.dat':   'pin_hole',
  'npeghol3a.dat':  'pin_hole',
  'connecthol.dat': 'pin_hole',
  // Technic axle-holes.
  'axlehol2.dat':  'axle_hole',
  'axlehol3.dat':  'axle_hole',
  'axlehol4.dat':  'axle_hole',
  'axlehol5.dat':  'axle_hole',
  'axlehol8.dat':  'axle_hole',
  'axlehol9.dat':  'axle_hole',
  'axleholm.dat':  'axle_hole',
  'axleholp.dat':  'axle_hole',
  'axleholp2.dat': 'axle_hole',
  // Generic Technic connectors.
  'connect.dat':  'connect',
  'connect2.dat': 'connect',
  'connect3.dat': 'connect',
};

function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0]*b[0] + a[1]*b[3] + a[2]*b[6],  a[0]*b[1] + a[1]*b[4] + a[2]*b[7],  a[0]*b[2] + a[1]*b[5] + a[2]*b[8],
    a[3]*b[0] + a[4]*b[3] + a[5]*b[6],  a[3]*b[1] + a[4]*b[4] + a[5]*b[7],  a[3]*b[2] + a[4]*b[5] + a[5]*b[8],
    a[6]*b[0] + a[7]*b[3] + a[8]*b[6],  a[6]*b[1] + a[7]*b[4] + a[8]*b[7],  a[6]*b[2] + a[7]*b[5] + a[8]*b[8],
  ];
}

function mat3Det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function applyTransform(m: Mat3, t: Vec3, p: Vec3): Vec3 {
  return [
    t[0] + m[0]*p[0] + m[1]*p[1] + m[2]*p[2],
    t[1] + m[3]*p[0] + m[4]*p[1] + m[5]*p[2],
    t[2] + m[6]*p[0] + m[7]*p[1] + m[8]*p[2],
  ];
}

interface AccumState {
  triangles: ResolvedTriangle[];
  connections: ConnectionPoint[];
}

async function accumulate(
  parsed: ParsedDat,
  translation: Vec3,
  rotation: Mat3,
  inheritColor: number,
  flipWinding: boolean,
  state: AccumState,
): Promise<void> {
  // Determinant < 0 means the cumulative transform has a reflection
  // (mirror), which flips effective winding. BFC convention handles this
  // by tracking a flip bit.
  const transformFlips = mat3Det(rotation) < 0;
  const effectiveFlip = flipWinding !== transformFlips;

  for (const line of parsed.lines) {
    switch (line.type) {
      case 1: {
        const sub = line as DatSubpart;
        // Compute composed transform up front — we need it whether this is
        // a connection primitive OR a regular subpart.
        const newT: Vec3 = applyTransform(rotation, translation, sub.position);
        const newR: Mat3 = mat3Multiply(rotation, sub.rotation);

        // If this subpart is a known connection primitive, record it.
        // We still recurse into it below so its triangles render normally;
        // connections are extracted in addition to, not instead of, geometry.
        const subFile = sub.file.toLowerCase().replace(/\\/g, '/');
        const subFileBase = subFile.split('/').pop() ?? subFile;
        const connType = CONNECTION_PRIMITIVES[subFileBase];
        if (connType) {
          state.connections.push({
            type: connType,
            position: [...newT] as Vec3,
            rotation: [...newR] as Mat3,
            primitive: subFileBase,
          });
        }

        const result = await fetchDat(sub.file);
        if (!result) continue;
        const subparsed = parseDat(result.content);
        const newColor = sub.color === 16 ? inheritColor : sub.color;
        // Subparts inherit the current flip bit unaltered.
        await accumulate(subparsed, newT, newR, newColor, flipWinding, state);
        break;
      }
      case 3: {
        const v1 = applyTransform(rotation, translation, line.v1);
        const v2 = applyTransform(rotation, translation, line.v2);
        const v3 = applyTransform(rotation, translation, line.v3);
        const color = line.color === 16 ? inheritColor : line.color;
        state.triangles.push({ v1, v2, v3, color, flip: effectiveFlip });
        break;
      }
      case 4: {
        const v1 = applyTransform(rotation, translation, line.v1);
        const v2 = applyTransform(rotation, translation, line.v2);
        const v3 = applyTransform(rotation, translation, line.v3);
        const v4 = applyTransform(rotation, translation, line.v4);
        const color = line.color === 16 ? inheritColor : line.color;
        // Split quad into two triangles. Both share the v1-v3 diagonal.
        state.triangles.push({ v1, v2, v3, color, flip: effectiveFlip });
        state.triangles.push({ v1, v2: v3, v3: v4, color, flip: effectiveFlip });
        break;
      }
      // Type 0 (comment) ignored at resolution time.
    }
  }
}

/**
 * Resolve a part by its filename (with or without .dat suffix) into a flat
 * list of world-space triangles. Returns null if the part can't be fetched.
 *
 * Follows `~Moved to X` redirect chains for metadata so the resolved part's
 * description/category reflects the renamed target rather than the stale
 * "moved to" stub. Geometry resolution is unaffected — the redirect's
 * Type-1 subpart reference pulls the target's mesh in automatically.
 */
export async function resolvePart(partFilename: string): Promise<ResolvedPart | null> {
  const filename = partFilename.endsWith('.dat') ? partFilename : `${partFilename}.dat`;
  const result = await fetchDat(filename);
  if (!result) return null;

  const root = parseDat(result.content);

  // Walk redirect chain to find the canonical metadata.
  let displayDescription = root.description;
  let displayCategory = root.category ?? null;
  const visited = new Set([filename.toLowerCase()]);
  let cursorDescription = root.description;
  let cursorCategory = root.category ?? null;
  while (cursorDescription.startsWith('~Moved to ')) {
    const target = cursorDescription.replace(/^~Moved to\s+/, '').trim();
    const targetFile = target.toLowerCase().endsWith('.dat') ? target.toLowerCase() : `${target.toLowerCase()}.dat`;
    if (visited.has(targetFile)) break;
    visited.add(targetFile);
    const targetResult = await fetchDat(targetFile);
    if (!targetResult) break;
    const targetParsed = parseDat(targetResult.content);
    cursorDescription = targetParsed.description;
    cursorCategory = targetParsed.category ?? cursorCategory;
    displayDescription = cursorDescription;
    displayCategory = cursorCategory;
  }

  const state: AccumState = { triangles: [], connections: [] };
  await accumulate(root, [0, 0, 0], IDENTITY, 16, false, state);

  const id = filename.replace(/\.dat$/i, '');
  return {
    id,
    description: displayDescription,
    category: displayCategory,
    triangles: state.triangles,
    connections: state.connections,
  };
}
