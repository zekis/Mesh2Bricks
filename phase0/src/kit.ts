import * as THREE from 'three';

// A kit block: a mesh with a primary outward normal used by the quantizer
// for matching, debug color, and the integer-voxel cells it occupies in
// canonical orientation (relative to its anchor at (0,0,0)). Single-cell
// blocks have cellOffsets = [(0,0,0)]; multi-cell blocks list every cell
// they cover so the quantizer can avoid double-placing.
export interface KitBlock {
  name: string;
  geometry: THREE.BufferGeometry;
  primaryNormal: THREE.Vector3;
  cellOffsets: THREE.Vector3[];
  color: number;
}

// All geometries fit in [-0.5, 0.5]³ so they tile on integer voxel coords
// when placed at (x + 0.5, y + 0.5, z + 0.5).

function makeCube(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

// Bottom half of a cube — primary normal +y (the exposed top face).
function makeHalfBlock(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.5, 1);
  g.translate(0, -0.25, 0);
  return g;
}

// Triangular prism: floor at -y, vertical wall at -z, hypotenuse rising
// from (-z, +y) down to (+z, -y). Primary outward normal (0, +1, +1)/√2.
function makeSlope(): THREE.BufferGeometry {
  const s = 0.5;
  const verts = new Float32Array([
    -s, -s, -s, // 0
     s, -s, -s, // 1
     s, -s,  s, // 2
    -s, -s,  s, // 3
    -s,  s, -s, // 4
     s,  s, -s, // 5
  ]);
  const indices = [
    // Bottom (-y)
    0, 1, 2,  0, 2, 3,
    // Back (-z)
    0, 4, 5,  0, 5, 1,
    // Left triangle (-x)
    0, 3, 4,
    // Right triangle (+x)
    1, 5, 2,
    // Hypotenuse (+y, +z)
    4, 2, 5,  4, 3, 2,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Cube with the (+x, +y, +z) corner cut off by a plane through the three
// adjacent corners. New triangular face has outward normal (1, 1, 1)/√3.
function makeCornerOutside(): THREE.BufferGeometry {
  const s = 0.5;
  const verts = new Float32Array([
    -s, -s, -s, // 0
     s, -s, -s, // 1
     s,  s, -s, // 2
    -s,  s, -s, // 3
    -s, -s,  s, // 4
     s, -s,  s, // 5
    -s,  s,  s, // 6  (was 7 in standard cube layout; (+x,+y,+z) removed)
  ]);
  const indices = [
    // Bottom (-y): quad 0-1-5-4
    0, 1, 5,  0, 5, 4,
    // Back (-z): quad 0-3-2-1
    0, 3, 2,  0, 2, 1,
    // Left (-x): quad 0-4-6-3
    0, 4, 6,  0, 6, 3,
    // Top (+y): triangle 3-6-2 (was 3-2-6-7 quad before corner removal)
    3, 6, 2,
    // Right (+x): triangle 1-2-5 (was 1-5-6-2 quad)
    1, 2, 5,
    // Front (+z): triangle 4-5-6 (was 4-5-6-7 quad)
    4, 5, 6,
    // Cut face: triangle 2-6-5, outward (+1,+1,+1)
    2, 6, 5,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// "Inside corner" — at Phase 0 resolution this reads from context (it sits in
// concave spots), so we use a cube. A proper inset version is a Phase 1 polish.
function makeCornerInside(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

// Rounded edge: the (+x, +y) edge along z is replaced with a quarter-circle
// in the XY cross-section. Primary outward normal (+1, +1, 0)/√2.
function makeQuarterCylinder(): THREE.BufferGeometry {
  const s = 0.5;
  const segments = 8;

  const shape = new THREE.Shape();
  shape.moveTo(-s, -s);
  shape.lineTo( s, -s);
  shape.lineTo( s,  0);
  for (let i = 1; i <= segments; i++) {
    const t = (i / segments) * (Math.PI / 2);
    shape.lineTo(s * Math.cos(t), s * Math.sin(t));
  }
  shape.lineTo(-s, s);
  shape.lineTo(-s, -s);

  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  g.computeVertexNormals();
  return g;
}

// Real eighth-sphere: a cube with the (+x,+y,+z) corner replaced by a curved
// spherical cap. The sphere is centered at the removed corner (s, s, s) with
// radius 1, passing through the three adjacent cube vertices (-s,+s,+s),
// (+s,-s,+s), (+s,+s,-s). The cap is tessellated using barycentric subdivision
// of the spherical triangle whose corners are those three cube vertices.
//
// This replaces what was previously a placeholder returning makeCornerOutside().
// Use this for rounded outside corners; use corner-outside for sharp ones.
function makeEighthSphere(): THREE.BufferGeometry {
  const s = 0.5;
  const N = 4; // subdivisions per arc

  // Sphere center and radius
  const cx = s, cy = s, cz = s;
  const radius = 1;

  // Cube vertices (indices 0..6; the (+x,+y,+z) corner is removed)
  const positions: number[] = [
    -s, -s, -s,  // 0
     s, -s, -s,  // 1
     s,  s, -s,  // 2
    -s,  s, -s,  // 3
    -s, -s,  s,  // 4
     s, -s,  s,  // 5
    -s,  s,  s,  // 6  (originally vertex 7 in standard cube layout)
  ];

  // Patch corners (cube vertices 2, 6, 5) correspond to barycentric (N,0,0),
  // (0,N,0), (0,0,N). Directions from sphere center to those corners:
  const dA: [number, number, number] = [0, 0, -1];   // toward vertex 2
  const dB: [number, number, number] = [-1, 0, 0];   // toward vertex 6
  const dC: [number, number, number] = [0, -1, 0];   // toward vertex 5

  const patchIndex = new Map<string, number>();

  function vert(i: number, j: number, k: number): number {
    const key = `${i},${j},${k}`;
    const existing = patchIndex.get(key);
    if (existing !== undefined) return existing;

    // Patch corners reuse cube vertex indices
    if (i === N && j === 0 && k === 0) { patchIndex.set(key, 2); return 2; }
    if (i === 0 && j === N && k === 0) { patchIndex.set(key, 6); return 6; }
    if (i === 0 && j === 0 && k === N) { patchIndex.set(key, 5); return 5; }

    const a = i / N, b = j / N, c = k / N;
    let dx = a * dA[0] + b * dB[0] + c * dC[0];
    let dy = a * dA[1] + b * dB[1] + c * dC[1];
    let dz = a * dA[2] + b * dB[2] + c * dC[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len; dy /= len; dz /= len;

    const idx = positions.length / 3;
    positions.push(cx + radius * dx, cy + radius * dy, cz + radius * dz);
    patchIndex.set(key, idx);
    return idx;
  }

  const indices: number[] = [];

  // Intact cube faces (same as corner-outside)
  indices.push(0, 1, 5,  0, 5, 4);  // -y
  indices.push(0, 3, 2,  0, 2, 1);  // -z
  indices.push(0, 4, 6,  0, 6, 3);  // -x

  // Partial +y face: fan from vertex 3 along arc 2→6 (reversed winding so
  // outward normal stays +y, since corner-outside used (3,6,2) not (3,2,6))
  for (let t = 0; t < N; t++) {
    const v0 = vert(N - t, t, 0);
    const v1 = vert(N - t - 1, t + 1, 0);
    indices.push(3, v1, v0);
  }

  // Partial +x face: fan from vertex 1 along arc 2→5
  for (let t = 0; t < N; t++) {
    const v0 = vert(N - t, 0, t);
    const v1 = vert(N - t - 1, 0, t + 1);
    indices.push(1, v0, v1);
  }

  // Partial +z face: fan from vertex 4 along arc 5→6
  for (let t = 0; t < N; t++) {
    const v0 = vert(0, t, N - t);
    const v1 = vert(0, t + 1, N - t - 1);
    indices.push(4, v0, v1);
  }

  // Spherical patch — triangular grid in barycentric coordinates
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) {
      const k = N - i - j;
      // Upward triangle
      indices.push(
        vert(i, j, k),
        vert(i + 1, j, k - 1),
        vert(i, j + 1, k - 1),
      );
      // Downward triangle (when k is large enough)
      if (k > 1) {
        indices.push(
          vert(i + 1, j, k - 1),
          vert(i + 1, j + 1, k - 2),
          vert(i, j + 1, k - 1),
        );
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Symmetric triangular prism with apex along the +y line. Outward normals of
// the two sloping faces are (±1, +1, 0). Primary direction picked as (0,+1,0).
function makeWedge(): THREE.BufferGeometry {
  const s = 0.5;
  const verts = new Float32Array([
    -s, -s, -s, // 0
     s, -s, -s, // 1
     s, -s,  s, // 2
    -s, -s,  s, // 3
     0,  s, -s, // 4 apex back
     0,  s,  s, // 5 apex front
  ]);
  const indices = [
    // Bottom (-y)
    0, 1, 2,  0, 2, 3,
    // -z triangle
    0, 4, 1,
    // +z triangle
    3, 2, 5,
    // +x sloping face
    1, 5, 2,  1, 4, 5,
    // -x sloping face
    0, 3, 5,  0, 5, 4,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Square base with single apex at (0, +y, 0) — cap shape. Primary +y.
function makePyramid(): THREE.BufferGeometry {
  const s = 0.5;
  const verts = new Float32Array([
    -s, -s, -s, // 0
     s, -s, -s, // 1
     s, -s,  s, // 2
    -s, -s,  s, // 3
     0,  s,  0, // 4 apex
  ]);
  const indices = [
    // Base (-y)
    0, 1, 2,  0, 2, 3,
    // Four side triangles
    0, 4, 1,
    1, 4, 2,
    2, 4, 3,
    3, 4, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// 1×1×2 long slope (~26.5°). Anchor at the "tall" end; geometry extends
// to z = 1.5 so the prism covers both cellOffsets cells. Hypotenuse normal
// is (0, 2, 1)/√5 — shallower than the 45° single-cell slope.
function makeLongSlope(): THREE.BufferGeometry {
  const s = 0.5;
  const verts = new Float32Array([
    -s, -s, -s,        // 0
     s, -s, -s,        // 1
     s, -s,  s + 1,    // 2  (extended to z = 1.5)
    -s, -s,  s + 1,    // 3
    -s,  s, -s,        // 4
     s,  s, -s,        // 5
  ]);
  const indices = [
    0, 1, 2,  0, 2, 3,
    0, 4, 5,  0, 5, 1,
    0, 3, 4,
    1, 5, 2,
    4, 2, 5,  4, 3, 2,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

const inv2 = 1 / Math.sqrt(2);
const inv3 = 1 / Math.sqrt(3);
const inv5 = 1 / Math.sqrt(5);

const CELL_0: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];

export const KIT: KitBlock[] = [
  {
    name: 'cube',
    geometry: makeCube(),
    primaryNormal: new THREE.Vector3(0, 0, 0),
    cellOffsets: CELL_0,
    color: 0x6c7785,
  },
  {
    name: 'half-block',
    geometry: makeHalfBlock(),
    primaryNormal: new THREE.Vector3(0, 1, 0),
    cellOffsets: CELL_0,
    color: 0xa49481,
  },
  {
    name: 'slope',
    geometry: makeSlope(),
    primaryNormal: new THREE.Vector3(0, inv2, inv2),
    cellOffsets: CELL_0,
    color: 0x6fa3c2,
  },
  {
    name: 'corner-outside',
    geometry: makeCornerOutside(),
    primaryNormal: new THREE.Vector3(inv3, inv3, inv3),
    cellOffsets: CELL_0,
    color: 0xc97a6e,
  },
  {
    name: 'eighth-sphere',
    geometry: makeEighthSphere(),
    primaryNormal: new THREE.Vector3(inv3, inv3, inv3),
    cellOffsets: CELL_0,
    color: 0xa78ce6,
  },
  {
    name: 'corner-inside',
    geometry: makeCornerInside(),
    primaryNormal: new THREE.Vector3(-inv3, -inv3, -inv3),
    cellOffsets: CELL_0,
    color: 0x4a4d57,
  },
  {
    name: 'quarter-cylinder',
    geometry: makeQuarterCylinder(),
    primaryNormal: new THREE.Vector3(inv2, inv2, 0),
    cellOffsets: CELL_0,
    color: 0x6fb88f,
  },
  {
    name: 'wedge',
    geometry: makeWedge(),
    primaryNormal: new THREE.Vector3(0, 1, 0),
    cellOffsets: CELL_0,
    color: 0xc8995c,
  },
  {
    name: 'pyramid',
    geometry: makePyramid(),
    primaryNormal: new THREE.Vector3(0, 1, 0),
    cellOffsets: CELL_0,
    color: 0xb8b35f,
  },
  {
    name: 'long-slope',
    geometry: makeLongSlope(),
    primaryNormal: new THREE.Vector3(0, 2 * inv5, inv5),
    cellOffsets: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)],
    color: 0x4a89c2,
  },
];

