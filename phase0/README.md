# Phase 0 — Voxel-kit Kill Test

The architecture in `../Spec.v3.md` rests on three load-bearing claims:

1. An upstream 3D-gen model (TRELLIS or equivalent) produces silhouettes that survive aggressive voxel downsampling.
2. A small kit of shape primitives plus a naive normal-matching quantizer renders the downsampled voxels as a recognizable approximation of the input.
3. Connection-point constraints can be enforced by re-rolling or carving the output.

This project runs **tests 1 and 2 end-to-end**. Test 3 is deferred — implement it only after 1 and 2 pass.

**Don't commit to Spec.v3 until all three pass.**

---

## Run

```
cd phase0
npm install
npm run dev
```

The app opens with a procedural torus knot as the default mesh so the pipeline runs immediately. Drop in any `.glb` or `.gltf` via the file picker.

---

## What the views show

| Mode | What you see | What it tests |
|---|---|---|
| **Original mesh** | The input rendered as-is, centered + scaled to the grid. | Sanity check the file loaded correctly. |
| **Voxel cubes** | The mesh voxelized at the current resolution, one cube per surface voxel. | **Test 1.** Does the silhouette survive downsampling? |
| **Quantized kit blocks** | Each surface voxel replaced by the kit block whose primary normal best matches its averaged surface normal, oriented through one of 24 cubic rotations. Block types are color-coded. | **Test 2.** Does the kit+quantizer recover a smoother silhouette than raw cubes? |

The resolution slider runs 8³ to 64³. Default 32³.

---

## Getting TRELLIS outputs

You don't need TRELLIS integrated yet — any `.glb` works. To get TRELLIS outputs specifically:

- **Replicate** — `firtoz/trellis` or `cjwbw/trellis` accept text or image prompts and return a `.glb`.
- **Fal** — hosts TRELLIS via API.
- **Self-host** — clone https://github.com/microsoft/TRELLIS; requires CUDA + PyTorch.

Run TRELLIS on the five test prompts in Spec.v3 §10 (`"teapot"`, `"engine manifold"`, `"small bridge"`, `"cargo hauler bow"`, `"spaceship engine"`), save the `.glb`s, drop them in here.

If the GLB has multiple meshes, only the first is voxelized. Merge in Blender first if that matters for your test object.

---

## What "passes" looks like

- **Test 1 passes:** At 32³ in voxel-cubes view, you can recognize the input. A teapot reads as a teapot; an engine manifold has identifiable flange shapes.
- **Test 2 passes:** The quantized view's silhouette is smoother than Test 1 — slopes and curved corners replace stair-stepping. Recognizable as the input prompt.
- **Test 3 (not implemented):** Skip for now. Wire up after 1 and 2 pass.

If **Test 1 fails at 32³**, try 64³. If it still fails, you need a different upstream model or a higher kit resolution — the architecture is fine; the kit grid needs to be smaller.

If **Test 2 fails despite Test 1 passing**, the quantizer or kit needs improvement. The kit here is intentionally minimal (8 blocks). Spec.v3's full kit is ~40 blocks across 3 style families.

---

## Architecture notes

| File | Role |
|---|---|
| `src/kit.ts` | The 8 block geometries (cube, half-block, slope, outside/inside corner, quarter-cylinder, wedge, pyramid) with their primary outward normals and debug colors. |
| `src/rotations.ts` | All 24 right-angle rotational symmetries of a cube as quaternions. |
| `src/voxelize.ts` | Mesh → surface voxel grid. Per-triangle area-weighted sampling; accumulates outward normals per cell. |
| `src/quantize.ts` | Greedy per-voxel `(block, rotation)` selection by dot-product against accumulated surface normal. Cube as fallback. |
| `src/render.ts` | One `InstancedMesh` per block type — the rendering pattern Spec.v3 §2 relies on. |
| `src/main.ts` | Scene setup, GLTF loading, UI wire-up, pipeline invocation. |

Everything runs in the browser. No server, no model hosting, no dependencies beyond Three.js. Total source is ~600 lines.

---

## Known Phase 0 simplifications

- **`corner-inside` is a cube placeholder.** At 32³ a proper inset corner reads similarly; the visual difference matters more at the higher kit resolution Spec.v3 targets.
- **`eighth-sphere` is folded into `corner-outside`.** Same reasoning.
- **Two quantizers, toggleable in the UI.** `normal-match` is the original normal-only heuristic — biased toward corner-outside on detailed meshes because corner's `(1,1,1)/√3` covers all 8 octants. `topology` picks block type from face-neighbor occupancy (geometric corners only become corner blocks) and uses normals only for rotation. Use `topology` for detailed meshes; `normal-match` is kept for comparison.
- **No connection-point enforcement.** Test 3 only.
- **Multi-mesh GLBs use the first mesh only.** Pre-merge in Blender if needed.

These are intentional — the test is whether the *architecture* works, not whether the kit is complete.
