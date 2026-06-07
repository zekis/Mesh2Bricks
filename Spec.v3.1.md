# Spec.v3.1 — Multi-pass Kit Decomposition

**Status:** refinement of `Spec.v3.md`, not a clean break. The voxelization, persistence model, library framing, and overall pipeline all stay. What changes is the **quantizer**: from per-voxel greedy classification (current Phase 0) to multi-pass greedy decomposition with claimed-volume tracking — i.e. **"build the model the way a human would: largest structural pieces first, surface details last."**

---

## 1. Why this exists

Phase 0 validated that voxelization + per-voxel kit classification produces a recognizable approximation of the input, but the result reads as a "noisy mosaic of independent kit pieces" rather than an assembly. Two architectural reasons:

- **Single-cell commitment.** Every voxel commits to exactly one kit block. A 4-voxel beam becomes 4 separate cubes with no representation of "this is a single beam."
- **Local-only decisions.** Each voxel picks its block in isolation, so adjacent pieces don't coordinate orientation or shape selection.

The fix is structural, not parametric: the quantizer needs to operate on **multi-cell patterns** against the solid volume, and decisions made early (place this big beam here) must constrain later decisions (no other piece may overlap it).

---

## 2. The core insight

A human assembling a kit-built model doesn't ask "what's the best piece for each cell?" They ask **"what's the largest meaningful structural piece, and where does it go?"** — and they ask it in order:

1. **Internal beams** form the chassis / spine first.
2. **Plates** clad large flat external regions.
3. **Slopes / chamfers** soften the edges between flat regions.
4. **Single cubes** fill whatever's left of the surface.
5. **Decorative details** (pipes, rails, stud blocks) attach to existing pieces.

Each step "claims" volume. Later steps can't overlap already-claimed cells. This produces an assembly where every piece has structural reason to be where it is.

---

## 3. The algorithm

```
volume       = voxelize(obj)           // grid.smooth, grid.smoothSurface
claimed      = empty set
placements   = []

for pass in [beams, plates, slopes, chamfers, cubes, details]:
  for each kit piece in pass, sorted by footprint size descending:
    for each candidate position in volume:
      for each of 24 rotations:
        footprint = piece.cells rotated and offset to position
        if footprint ⊆ volume AND footprint ∩ claimed = ∅:
          if pass-specific constraints hold:
            place(piece, position, rotation)
            claimed ∪= footprint
            placements.append(...)

return placements
```

**Pass-specific constraints** are what make the result look intentional rather than greedy-spammed:

| Pass | Candidate cells | Extra constraint |
|---|---|---|
| beams | `grid.smooth − grid.smoothSurface` (interior) | piece is a 1×1×N run along an axis |
| plates | `grid.smoothSurface`, restricted to cells whose normal aligns with one of 6 face directions | all cells in the footprint have parallel normals; the plate sits flush on the surface plane |
| slopes | `grid.smoothSurface` cells adjacent to a height transition | the underlying solid has a 1-cell vertical drop along the slope's run direction |
| chamfers | `grid.smoothSurface` cells at corner-meeting topology | normal points in the corner direction |
| cubes | remaining `grid.smoothSurface` cells | unconditional fallback |
| details | adjacent to already-placed plates / beams | optional aesthetic — pipe runs along a beam, stud on top of a plate |

---

## 4. Kit categories

The kit expands from Phase 0's ~9 single-cell blocks to ~30–50 multi-cell parts. Each part declares:

- `geometry` — a `BufferGeometry`
- `footprint` — list of `(dx, dy, dz)` offsets the piece claims relative to its anchor
- `anchor` — which cell is the placement origin (usually the min-corner of the footprint)
- `primaryNormal` — the dominant outward direction in canonical orientation
- `category` — one of `{ beam, plate, slope, chamfer, cube, cylinder, stud, pin, rail }`
- `connectionPoints` (optional) — typed mount points for compatible neighbors

### 4.1 Structural (built first)

| Piece | Footprint | Notes |
|---|---|---|
| `beam-1x1x2` | 1×1×2 along ±X / ±Y / ±Z (24 rotations) | shortest beam |
| `beam-1x1x4` | 1×1×4 | medium |
| `beam-1x1x6` | 1×1×6 | long |
| `beam-1x1x8` | 1×1×8 | longest practical |

### 4.2 Cladding

| Piece | Footprint | Notes |
|---|---|---|
| `plate-2x2` | 2×2×1 flat | smallest plate |
| `plate-2x4` | 2×4×1 | medium |
| `plate-4x4` | 4×4×1 | large |
| `plate-2x6` / `plate-4x6` | per name | optional larger sizes |

### 4.3 Edges

| Piece | Footprint | Angle |
|---|---|---|
| `slope-1x1` | 1×1×1 | 45° (current Phase 0 slope) |
| `slope-1x2` | 1×1×2 | ~26.5° (current Phase 0 long-slope) |
| `slope-1x4` | 1×1×4 | ~14° (very shallow) |
| `chamfer-1x1` | 1×1×1 with 1 beveled edge | 45° edge cut |
| `chamfer-corner` | 1×1×1 with 3 beveled edges meeting | corner-outside, current Phase 0 |

### 4.4 Fallback

| Piece | Footprint |
|---|---|
| `cube-1x1x1` | 1 |
| `half-block` | 1 cell, half height |

### 4.5 Details (placed last, optional)

| Piece | Footprint | Notes |
|---|---|---|
| `cylinder-1x1` | 1×1×1, circular cross-section | "pin block" |
| `pipe-1x1x4` | 1×1×4 cylinder | runs alongside beams |
| `rail-1x1x4` | 1×1×4 thin profile | edge accents |
| `stud-1x1` | small cylinder on +Y of a 1×1 base | Lego-style stud |
| `vent-1x1` | 1×1×1 grilled face | decorative |

Kit growth is incremental: ship Phase 1 with just the beams + slopes + cubes, then add cladding plates, then chamfers, then details.

---

## 5. Data model

`KitBlock` (from Phase 0) extends as follows:

```ts
interface KitBlock {
  name: string;
  geometry: THREE.BufferGeometry;
  primaryNormal: THREE.Vector3;
  cellOffsets: THREE.Vector3[];          // already exists, just used for real now
  category: PieceCategory;               // new: 'beam' | 'plate' | 'slope' | ...
  anchor: THREE.Vector3;                 // new: which cell is the placement origin
  symmetry?: 'cubic' | 'axial' | 'mirror'; // new: optional optimization for rotation enumeration
  color: number;
}
```

`Placement` (the new output of the quantizer):

```ts
interface Placement {
  blockIndex: number;
  anchor: THREE.Vector3;                 // grid coords of the anchor cell
  rotationIndex: number;                 // 0..23
  claimedCells: string[];                // voxel keys this placement occupies
  sampledColor?: THREE.Color;            // optional, averaged across footprint
}
```

The renderer iterates `Placement[]` instead of single-cell `BlockInstance[]`. For multi-cell pieces, the geometry is positioned at the anchor cell with the rotation applied; its mesh extends naturally across the claimed footprint.

---

## 6. Migration plan (Phase 0 → Phase 1)

Each step is shippable and reversible.

**Step A — Greedy meshing for beams** (~250 lines). Implement only the beam pass; everything else falls back to the existing single-cell quantizer for `grid.smoothSurface − beamsClaimed`. Add a "multipass" option to the quantizer UI dropdown. *Validates the multi-pass infrastructure end-to-end with one pass.*

**Step B — Plate pass** (~150 lines). Detect flat regions whose voxels share a normal direction; tile with `plate-2x2`, `plate-2x4`, `plate-4x4`. *Replaces large half-block runs with plates.*

**Step C — Slope pass with multi-cell variants** (~200 lines). Detect 1-cell vertical transitions in the smoothed solid; place `slope-1x2`, `slope-1x4` along them. *Removes most stair-stepping from sloping surfaces.*

**Step D — Chamfer pass** (~100 lines). Replace remaining corner-outside placements with `chamfer-*` variants at edges and corners. *Softens the model's silhouette.*

**Step E — Cube/half-block fallback** (existing single-cell quantizer becomes this pass, restricted to leftover voxels).

**Step F — Detail pass** (~200 lines, optional). Place pipes alongside beams, studs on top of plates, vents on flat panels.

Total: ~900 lines of new quantizer + ~30 new kit geometries (~600 lines).

---

## 7. Open questions

1. **Rotation enumeration is expensive** if naïve. For a 1×1×8 beam at 64³ resolution, naïve enumeration is 64³ × 24 ≈ 6M position+rotation candidates. Need pruning: skip rotations that produce identical footprints (the 1×1×8 beam has only 3 distinct axis orientations, not 24); skip positions where the anchor cell isn't in the candidate set. Should drop to ~200K candidates per pass.
2. **Order of pieces within a pass.** Largest-first is the obvious choice, but it might produce visible "leftover stripes" where a 1×1×8 beam was placed but the remaining 1×1×3 gap doesn't fit any beam. A second-pass attempt with smaller beams along the same axis fixes this.
3. **Surface plates require co-planar normals**, but the normal-smoothing pass may have softened sharp normal transitions enough that plates fit *too* aggressively. May need a "normal consistency" tolerance per plate size.
4. **Stability is not a goal** for v3.1 since we're not outputting buildable instructions — the model is purely visual. We don't need to enforce that every piece is supported. If a later product version emits real Lego or kit instructions, stability becomes a constraint.
5. **Color sampling for multi-cell pieces** — sample once at the anchor cell, or average across the footprint? Average is more faithful; anchor-only is cheaper. Default: average.
6. **Connection-point enforcement** (Spec.v3 §10's deferred Test 3) gets easier with multi-cell pieces — a piece declares its connection points; the placement step can match them across pieces. Worth picking up after Step E.

---

## 8. What stays from v3

Everything not explicitly changed:

- Voxelization pipeline (triangle sampling, normal accumulation, color sampling)
- Morphological smoothing (`grid.smooth`, `grid.smoothSurface`)
- Texture sampling per voxel (`grid.colors`)
- The persistent module library framing
- TRELLIS as the upstream 3D-gen model
- The phase0 browser app, Vite middleware, state JSON sink
- The library-as-compounding-asset design

The shift is **purely in the quantizer**. v3.1 is "v3 with a smarter Stage 6."
