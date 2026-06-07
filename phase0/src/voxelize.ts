import * as THREE from 'three';

export interface VoxelGrid {
  /** X / Z axis voxel resolution (cells per stud-width direction). The
   *  "size" the user controls via the resolution slider. */
  size: number;
  /** Y axis voxel resolution. Anisotropic — typically 2.5× `size` so each
   *  Y cell is 1 plate-height (8 LDU) while X/Z cells are 1 stud-width
   *  (20 LDU). This way a cubic input mesh produces a grid that, when
   *  rendered with the 0.4× Y-squash, still appears cubic in world space
   *  but contains 2.5× more vertical Lego layers. */
  sizeY: number;
  occupied: Set<string>;            // surface voxels of the raw solid
  solid: Set<string>;               // surface + filled interior (raw, for topology queries)
  smooth: Set<string>;              // morphologically smoothed solid (close + open)
  smoothSurface: Set<string>;       // surface voxels of `smooth` (the set to iterate for placement when smoothing is on)
  normals: Map<string, THREE.Vector3>; // averaged outward normal per surface voxel (keyed in `occupied`, not `smoothSurface`)
  colors: Map<string, THREE.Color>;    // averaged texture color per surface voxel (empty if mesh has no texture)
}

/** Lego-aspect ratio: plate height (8 LDU) / stud width (20 LDU). The Y
 *  voxel resolution scales by 1/this ratio to produce anisotropic cells. */
const LEGO_Y_RATIO = 8 / 20; // 0.4

interface TexturePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Pull the mesh's base-color texture into a CPU-side pixel buffer once, so we
// can sample it per triangle-sample during voxelization. Returns null if the
// mesh has no usable texture (which is fine — voxels just stay uncolored).
function extractTexturePixels(mesh: THREE.Mesh): TexturePixels | null {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (!material) return null;
  const map = (material as THREE.MeshStandardMaterial).map;
  if (!map || !map.image) return null;
  const img = map.image as HTMLImageElement | ImageBitmap | HTMLCanvasElement;
  const width = (img as { width?: number }).width ?? 0;
  const height = (img as { height?: number }).height ?? 0;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(img as CanvasImageSource, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { data: imageData.data, width, height };
  } catch (e) {
    // Cross-origin or other draw failure — silently bail out.
    console.warn('[voxelize] texture extraction failed:', e);
    return null;
  }
}

function samplePixel(tex: TexturePixels, u: number, v: number): [number, number, number] {
  // Wrap UVs into [0, 1). glTF UV convention: V=0 at top of texture.
  const uu = ((u % 1) + 1) % 1;
  const vv = ((v % 1) + 1) % 1;
  const px = Math.min(tex.width - 1, Math.floor(uu * tex.width));
  const py = Math.min(tex.height - 1, Math.floor(vv * tex.height));
  const idx = (py * tex.width + px) * 4;
  return [
    tex.data[idx] / 255,
    tex.data[idx + 1] / 255,
    tex.data[idx + 2] / 255,
  ];
}

export function voxelKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

// Surface voxelization by triangle sampling.
//
// For each triangle of the mesh we generate sample points proportional to the
// triangle's area, snap each to a voxel cell, and accumulate the triangle's
// outward normal at that cell. After all triangles are processed we normalize
// the accumulated normals.
//
// This produces a thin shell (surface voxels only) which is exactly what the
// quantizer wants — it needs the surface orientation, not interior occupancy.
export function voxelize(mesh: THREE.Mesh, size: number): VoxelGrid {
  // sizeY will be computed once we know the bbox aspect; pre-compute a
  // reasonable upper bound (size / LEGO_Y_RATIO ≈ size × 2.5) for the
  // worst case where Y is the dominant axis.
  const grid: VoxelGrid = {
    size,
    sizeY: size,  // overwritten below
    occupied: new Set(),
    solid: new Set(),
    smooth: new Set(),
    smoothSurface: new Set(),
    normals: new Map(),
    colors: new Map(),
  };

  mesh.updateMatrixWorld(true);
  const matrix = mesh.matrixWorld;
  const geom = mesh.geometry as THREE.BufferGeometry;
  const position = geom.attributes.position as THREE.BufferAttribute;
  const uvAttr = geom.attributes.uv as THREE.BufferAttribute | undefined;
  const index = geom.index;
  const texturePixels = extractTexturePixels(mesh);
  const sampleColors = texturePixels !== null && uvAttr !== undefined;
  const colorAccum = new Map<string, { r: number; g: number; b: number; count: number }>();

  // World-space bounding box of the mesh as transformed.
  const bbox = new THREE.Box3().setFromObject(mesh);
  const bsize = bbox.getSize(new THREE.Vector3());

  // Anisotropic cell sizing: X and Z share the same cellSize (sized so the
  // larger of bsize.x / bsize.z fits exactly into `size` voxels); Y uses a
  // smaller cell (= cellSizeXZ × LEGO_Y_RATIO) so 1 voxel Y = 1 plate height
  // when 1 voxel X = 1 stud width.
  const cellSizeXZ = Math.max(bsize.x, bsize.z) / size || 1;
  const cellSizeY = cellSizeXZ * LEGO_Y_RATIO;
  const sizeY = Math.max(1, Math.ceil(bsize.y / cellSizeY));
  grid.sizeY = sizeY;

  const toVoxelX = (x: number) => Math.floor((x - bbox.min.x) / cellSizeXZ);
  const toVoxelY = (y: number) => Math.floor((y - bbox.min.y) / cellSizeY);
  const toVoxelZ = (z: number) => Math.floor((z - bbox.min.z) / cellSizeXZ);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const triNormal = new THREE.Vector3();

  const triCount = index ? index.count / 3 : position.count / 3;
  const density = 4; // samples per voxel-edge of triangle area — empirical

  for (let i = 0; i < triCount; i++) {
    const ai = index ? index.getX(i * 3 + 0) : i * 3 + 0;
    const bi = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const ci = index ? index.getX(i * 3 + 2) : i * 3 + 2;

    a.fromBufferAttribute(position, ai).applyMatrix4(matrix);
    b.fromBufferAttribute(position, bi).applyMatrix4(matrix);
    c.fromBufferAttribute(position, ci).applyMatrix4(matrix);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    triNormal.crossVectors(ab, ac);
    const area = triNormal.length() * 0.5;
    if (area === 0) continue;
    triNormal.normalize();

    // Per-cell face area is anisotropic; use the smaller (XZ × Y) for
    // conservative oversampling so anisotropic Y cells still get hit.
    const samples = Math.max(3, Math.ceil((area / (cellSizeXZ * cellSizeY)) * density));

    // Triangle UVs (only loaded if we'll actually sample texture)
    let uAx = 0, uAy = 0, uBx = 0, uBy = 0, uCx = 0, uCy = 0;
    if (sampleColors) {
      uAx = uvAttr!.getX(ai); uAy = uvAttr!.getY(ai);
      uBx = uvAttr!.getX(bi); uBy = uvAttr!.getY(bi);
      uCx = uvAttr!.getX(ci); uCy = uvAttr!.getY(ci);
    }

    for (let s = 0; s < samples; s++) {
      let u = Math.random();
      let v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }

      const px = a.x + ab.x * u + ac.x * v;
      const py = a.y + ab.y * u + ac.y * v;
      const pz = a.z + ab.z * u + ac.z * v;

      const vx = toVoxelX(px);
      const vy = toVoxelY(py);
      const vz = toVoxelZ(pz);
      if (vx < 0 || vy < 0 || vz < 0 || vx >= size || vy >= sizeY || vz >= size) continue;

      const key = voxelKey(vx, vy, vz);
      grid.occupied.add(key);

      const acc = grid.normals.get(key);
      if (acc) {
        acc.add(triNormal);
      } else {
        grid.normals.set(key, triNormal.clone());
      }

      if (sampleColors) {
        const sU = uAx + (uBx - uAx) * u + (uCx - uAx) * v;
        const sV = uAy + (uBy - uAy) * u + (uCy - uAy) * v;
        const [r, g, b] = samplePixel(texturePixels!, sU, sV);
        const cAcc = colorAccum.get(key);
        if (cAcc) {
          cAcc.r += r;
          cAcc.g += g;
          cAcc.b += b;
          cAcc.count++;
        } else {
          colorAccum.set(key, { r, g, b, count: 1 });
        }
      }
    }
  }

  for (const n of grid.normals.values()) {
    if (n.lengthSq() > 0) n.normalize();
  }

  for (const [key, acc] of colorAccum) {
    grid.colors.set(key, new THREE.Color(
      acc.r / acc.count,
      acc.g / acc.count,
      acc.b / acc.count,
    ));
  }

  grid.solid = fillInterior(grid.occupied, size, sizeY, size);
  grid.smooth = smoothSolid(grid.solid, size, sizeY, size);
  grid.smoothSurface = computeSurface(grid.smooth, size, sizeY, size);
  smoothNormals(grid.normals);
  propagateColorsToNeighbors(grid.smoothSurface, grid.colors);
  return grid;
}

// Smoothing adds voxels that fill 1-voxel concavities — these are in
// smoothSurface but were never hit by a triangle sample, so they have no
// color. Propagate from textured neighbors so they don't show as fallback
// blue against the textured surface.
function propagateColorsToNeighbors(
  smoothSurface: Set<string>,
  colors: Map<string, THREE.Color>,
): void {
  if (colors.size === 0) return;
  const deltas: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (let pass = 0; pass < 5; pass++) {
    const additions: Array<[string, THREE.Color]> = [];
    for (const key of smoothSurface) {
      if (colors.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      let r = 0, g = 0, b = 0, count = 0;
      for (const [dx, dy, dz] of deltas) {
        const neighbor = colors.get(voxelKey(x + dx, y + dy, z + dz));
        if (neighbor) {
          r += neighbor.r;
          g += neighbor.g;
          b += neighbor.b;
          count++;
        }
      }
      if (count > 0) {
        additions.push([key, new THREE.Color(r / count, g / count, b / count)]);
      }
    }
    if (additions.length === 0) break;
    for (const [k, c] of additions) colors.set(k, c);
  }
}

// One Laplacian pass over the per-voxel surface normals: average each
// voxel's normal with its surface-neighbor normals. Reduces sampling noise
// from triangle voxelization (~10–20 samples per voxel) so adjacent voxels
// on the same surface patch pick consistent rotations instead of jittering.
function smoothNormals(normals: Map<string, THREE.Vector3>): void {
  const next = new Map<string, THREE.Vector3>();
  const deltas: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (const [key, n] of normals) {
    const [x, y, z] = key.split(',').map(Number);
    const sum = n.clone();
    let count = 1;
    for (const [dx, dy, dz] of deltas) {
      const neighbor = normals.get(voxelKey(x + dx, y + dy, z + dz));
      if (neighbor) {
        sum.add(neighbor);
        count++;
      }
    }
    sum.divideScalar(count);
    if (sum.lengthSq() > 0) sum.normalize();
    next.set(key, sum);
  }
  normals.clear();
  for (const [k, v] of next) normals.set(k, v);
}

// Surface voxels of a solid set: any voxel in the set with at least one face-neighbor
// that's outside the set (or off the grid).
function computeSurface(solid: Set<string>, sizeX: number, sizeY: number, sizeZ: number): Set<string> {
  const surface = new Set<string>();
  const deltas: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (const key of solid) {
    const [x, y, z] = key.split(',').map(Number);
    for (const [dx, dy, dz] of deltas) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sizeX || ny >= sizeY || nz >= sizeZ) {
        surface.add(key);
        break;
      }
      if (!solid.has(voxelKey(nx, ny, nz))) {
        surface.add(key);
        break;
      }
    }
  }
  return surface;
}

// Morphological close (dilate→erode) on the solid set. Fills 1-voxel
// concavities (which is the main noise-reduction value for TRELLIS meshes
// with small holes/notches) while NEVER removing voxels — thin features
// like a torus tube survive intact.
//
// We deliberately skip the matching open pass (erode→dilate) — open would
// kill 1-voxel protrusions but it also destroys thin features that are
// only 1–2 voxels thick. The "remove isolated bumps" job is handled by
// the topology rules in the quantizer (n=4 → cube, n=5–6 → pyramid only
// when truly isolated).
function smoothSolid(solid: Set<string>, NX: number, NY: number, NZ: number): Set<string> {
  const idx = (x: number, y: number, z: number) => x + NX * (y + NY * z);
  let cells: Uint8Array = new Uint8Array(NX * NY * NZ);
  for (const key of solid) {
    const [x, y, z] = key.split(',').map(Number);
    cells[idx(x, y, z)] = 1;
  }
  cells = dilateArr(cells, NX, NY, NZ);
  cells = erodeArr(cells, NX, NY, NZ);   // close only

  const result = new Set<string>();
  for (let z = 0; z < NZ; z++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (cells[idx(x, y, z)] === 1) result.add(voxelKey(x, y, z));
      }
    }
  }
  return result;
}

function dilateArr(input: Uint8Array, NX: number, NY: number, NZ: number): Uint8Array {
  const output = new Uint8Array(input);
  const idx = (x: number, y: number, z: number) => x + NX * (y + NY * z);
  for (let z = 0; z < NZ; z++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (input[idx(x, y, z)]) continue;
        if ((x + 1 < NX && input[idx(x + 1, y, z)]) ||
            (x > 0      && input[idx(x - 1, y, z)]) ||
            (y + 1 < NY && input[idx(x, y + 1, z)]) ||
            (y > 0      && input[idx(x, y - 1, z)]) ||
            (z + 1 < NZ && input[idx(x, y, z + 1)]) ||
            (z > 0      && input[idx(x, y, z - 1)])) {
          output[idx(x, y, z)] = 1;
        }
      }
    }
  }
  return output;
}

function erodeArr(input: Uint8Array, NX: number, NY: number, NZ: number): Uint8Array {
  const output = new Uint8Array(input);
  const idx = (x: number, y: number, z: number) => x + NX * (y + NY * z);
  for (let z = 0; z < NZ; z++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (!input[idx(x, y, z)]) continue;
        // Boundary neighbors count as occupied — don't erode at the grid edge
        if ((x + 1 < NX && !input[idx(x + 1, y, z)]) ||
            (x > 0      && !input[idx(x - 1, y, z)]) ||
            (y + 1 < NY && !input[idx(x, y + 1, z)]) ||
            (y > 0      && !input[idx(x, y - 1, z)]) ||
            (z + 1 < NZ && !input[idx(x, y, z + 1)]) ||
            (z > 0      && !input[idx(x, y, z - 1)])) {
          output[idx(x, y, z)] = 0;
        }
      }
    }
  }
  return output;
}

// Flood-fill from outside the grid boundary; any voxel not reachable from
// outside is interior and gets added to the solid set alongside the surface
// shell. Open meshes (with holes) won't fill correctly — the fill leaks
// through the hole — but for closed-ish meshes (TRELLIS outputs, Blender
// exports) this gives the topology quantizer the correct neighbor info.
function fillInterior(surface: Set<string>, NX: number, NY: number, NZ: number): Set<string> {
  const cells = new Uint8Array(NX * NY * NZ); // 0 unknown, 1 surface, 2 outside
  const idx = (x: number, y: number, z: number) => x + NX * (y + NY * z);
  const stepY = NX;
  const stepZ = NX * NY;

  for (const key of surface) {
    const [x, y, z] = key.split(',').map(Number);
    cells[idx(x, y, z)] = 1;
  }

  const queue: number[] = [];
  const seed = (p: number) => {
    if (cells[p] === 0) {
      cells[p] = 2;
      queue.push(p);
    }
  };
  // Seed the six boundary faces.
  for (let a = 0; a < NY; a++) for (let b = 0; b < NZ; b++) {
    seed(idx(0, a, b));        seed(idx(NX - 1, a, b));
  }
  for (let a = 0; a < NX; a++) for (let b = 0; b < NZ; b++) {
    seed(idx(a, 0, b));        seed(idx(a, NY - 1, b));
  }
  for (let a = 0; a < NX; a++) for (let b = 0; b < NY; b++) {
    seed(idx(a, b, 0));        seed(idx(a, b, NZ - 1));
  }

  let head = 0;
  while (head < queue.length) {
    const p = queue[head++];
    const z = (p / stepZ) | 0;
    const rem = p - z * stepZ;
    const y = (rem / stepY) | 0;
    const x = rem - y * stepY;
    if (x + 1 < NX) { const np = p + 1;     if (cells[np] === 0) { cells[np] = 2; queue.push(np); } }
    if (x > 0)      { const np = p - 1;     if (cells[np] === 0) { cells[np] = 2; queue.push(np); } }
    if (y + 1 < NY) { const np = p + stepY; if (cells[np] === 0) { cells[np] = 2; queue.push(np); } }
    if (y > 0)      { const np = p - stepY; if (cells[np] === 0) { cells[np] = 2; queue.push(np); } }
    if (z + 1 < NZ) { const np = p + stepZ; if (cells[np] === 0) { cells[np] = 2; queue.push(np); } }
    if (z > 0)      { const np = p - stepZ; if (cells[np] === 0) { cells[np] = 2; queue.push(np); } }
  }

  const solid = new Set<string>();
  for (let z = 0; z < NZ; z++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (cells[idx(x, y, z)] !== 2) solid.add(voxelKey(x, y, z));
      }
    }
  }
  return solid;
}
