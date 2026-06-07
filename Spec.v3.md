# Spec.v3 — Voxel-kit Generative Service

**Status:** draft. Clean break from `Spec.v2.md`. v2's stance was "AI generates each module as a unique mesh; the tool composes and cleans them up." v3's stance is "AI generates *arrangements* of hand-authored voxel-kit blocks; the tool never needs to clean anything up — and the same service generalizes to any game object, not just spaceships."

The shift is from *AI authors meshes we then make game-ready* to *AI authors block arrangements that are game-ready by construction*.

---

## 1. Overview

The product is no longer scoped to spaceships. It's a generative service for game-ready 3D objects of any kind, with spaceships as the first demonstrated use case. Given a text prompt or image, plus optional constraints (bounding-box dimensions, intended purpose, required connection points), the service produces a **voxel-block arrangement**: a 3D object composed of pre-authored kit blocks that snaps to a grid, welds correctly at every face, and is fully game-ready.

The architectural insight is that **voxelization with a hand-authored shape kit sidesteps the entire mesh-quality problem in AI 3D generation**. Every output is, by construction: manifold, welded, UV-mapped, materialed, and equipped with known mount points. The upstream AI model can be imperfect; the kit guarantees the output isn't.

This is "Meshy for game objects" — a different product from Meshy. Meshy gives you unique meshes of variable quality with no game-readiness guarantees and no composability between outputs. This gives you constrained meshes of guaranteed quality, composable through declared connection points, generalizable across object categories.

**Differentiation from existing AI-voxel services.** Existing tools (text-to-MagicaVoxel and similar) output pure cube grids — text-to-Minecraft. Silhouette quality is limited by orthogonal block shapes; curves can only be faked through color gradient across cubes. v3 uses a kit of varied shapes (slopes, corners, quarter-cylinders, wedges, rounded edges) which yields Space Engineers / Teardown silhouette quality at 32³ resolution — quality that cube-only generators need 128³+ to approximate.

Three design stances:

**The kit is the IP.** ~40 shape blocks across three style sub-families, plus ~10 paint schemes. Hand-authored once. The kit's quality bar: a human can build a great-looking object from it.

**The generator composes existing models; it doesn't train new ones.** Open-source 3D gen (TRELLIS, Microsoft Research, late 2024) serves as the imagination layer. A classical quantizer maps its output to kit blocks. Constraint passes enforce dimensions and connection points. No model training in v3.

**Game objects compose through typed connection points.** Every output declares mount points on its faces. A kettle's spout connects to a pipe; a pipe connects to a manifold; a manifold attaches to a spaceship. The same composability primitive works within and across object categories.

---

## 2. Architecture

Three layers, built in this order:

**Layer 1 — Kit + grid renderer.** Hand-authored voxel block kit, grid data structure, Three.js `InstancedMesh` renderer. ~40 shape blocks with per-face mount-point definitions. Trim-sheet UVs so paint schemes are atlas swaps, not separate meshes. One `InstancedMesh` per block type → ~40 draw calls for any object regardless of voxel count.

**Layer 2 — Manual composer.** A Space Engineers-style editor: place blocks on a grid, snap to mount points, paint with schemes, save as a named object. Not a detour — it validates the kit before any AI work, doubles as the content tool for objects the generator can't yet produce, and is the runtime renderer for generated content.

**Layer 3 — Generator service.** Wraps TRELLIS (or equivalent open-source 3D gen) with constraint-respecting passes. Single API: `generate(prompt: text | image, constraints: { dims?, connection_points?, style_family? }) → Arrangement`.

Layers 1 and 2 also are the **game-side runtime** — the same grid + renderer code that authors objects runs them in the game. Layer 3 is a separate service the game (and other consumers) call.

---

## 3. The generator pipeline

```
prompt (text or image) + constraints
     ↓
TRELLIS — generate sparse voxel volume + per-voxel features
     ↓
Dimension pass — clip/scale volume to requested bounding box
     ↓
Quantizer — for each surface voxel, pick best-matching kit shape
     (classical surface fitting: greedy normal-direction match
      against kit block normals, with neighborhood smoothing)
     ↓
Connection-point pass — enforce that requested face exposures
     have compatible block types and orientations
     (re-roll if cheap, or carve-and-repaint at constrained faces)
     ↓
Paint pass — apply paint scheme per block based on style family + context
     (hazard stripes on edges, dark plating on hulls, panels on flat regions)
     ↓
Output: Arrangement
     (grid coords, block types, paint per block, connection-point registry)
```

The pipeline is classical algorithms wrapping a single AI black box. No model training in v3. TRELLIS is the leading candidate because it natively outputs a sparse voxel representation (Structured LATents) — closer to the kit's output format than to a mesh. Fallback models if TRELLIS underperforms: Hunyuan3D, TripoSR, SF3D, Rodin. The architecture is model-agnostic; each candidate is a drop-in for the upstream stage.

**Shape vs. paint separation.** Each voxel position is the product of two independent decisions: shape (from the kit's ~40 block types) and paint (from ~10 paint schemes). The generator's quantizer picks shape; the paint pass picks paint based on style family, neighborhood context, and any user-supplied palette. Keeps the generator's search space small, the kit hand-authorable, and lets users re-skin a generated object without re-generating.

**Provenance.** Every generation stores prompt, constraints, model version, and seed. Outputs are reproducible modulo upstream model drift.

**Async.** TRELLIS runs on GPU at seconds-to-a-minute per object. The service queues requests. Clients poll or webhook for completion. Multi-second turnaround is the norm, not the exception.

---

## 4. The kit

~40 shape blocks across three style sub-families, plus ~10 paint schemes.

**Shape primitives** (counts approximate; most are shared across families):

- Cube, half-cube, quarter-cube
- Slope (full, half, quarter heights)
- Slope corner (inside/outside chirality)
- Inverted slope, inverted corner
- Rounded edge (quarter-cylinder)
- Round corner (eighth-sphere)
- Wedge / triangular prism
- Cylindrical section
- Pyramidal cap
- Style-specific specials (e.g. mechanical: flange + vent variants; organic: bulbous + tapered variants; structural: cable + cross-brace variants)

**Style sub-families:**

| Family | Visual character | Use cases |
|---|---|---|
| **Mechanical** | Flat panels, hard edges, panel lines, vents, rivets | Spaceships, manifolds, machinery |
| **Organic** | Softer slopes, curved transitions, no panel lines | Kettles, biological/alien forms, smooth pottery |
| **Structural** | Flat plates, exposed bracing, cables, beams | Bridges, scaffolding, industrial frames |

Style family is mostly a *material/decoration* distinction — the three families share ~90% of shape primitives. A "slope" exists in all three families with different surface treatments. ~10% of blocks are style-specific specials.

**Paint schemes** are global: industrial-grimy, military, civilian, alien, ceramic, weathered, pristine, etc. Each scheme is a trim-sheet atlas the renderer swaps. Paint is applied per-block per-instance; a single object can use one scheme across all blocks or mix schemes by region.

The kit is hand-authored. Estimated effort: ~4–6 weeks of focused mesh + texture work for the v1 kit.

---

## 5. Composability and connection points

Every generated object exposes a **connection-point graph**: a typed list of mount points on its faces. Connection-point types are global to the system:

- `pipe_small`, `pipe_large` (fluid/gas)
- `electrical`
- `mechanical_flange`
- `structural_beam`
- `ship_hardpoint` (small, medium, large)
- `decorative_attach`

Two objects compose when their connection points match by type, position alignment along the grid, and orientation. The game (and the manual composer) handles snapping.

For spaceships: a ship is itself a **macro-grid of generated objects**. The generator can produce ship-sized objects in one pass, or the user can compose a ship from smaller generated modules connected through their hardpoints. Both work; the second enables the library-as-compounding-asset behavior — successful module-scale generations cache and snap into future ships.

---

## 6. Strategic positioning — tool first, product later

"AI-to-voxel with Space Engineers shape vocabulary" has no direct competitor I'm aware of. Closest is text-to-MagicaVoxel tools (cube-only) and Meshy (raw mesh, not game-ready). The market position is real.

But deliver **tool first**. The spaceship game is the forcing function — a working tool with a demonstrated game built on it is a much easier product pitch than a generic service with no anchor demo. The product version earns its way once the tool produces ships the user is happy with.

Practical scope implication:

- **Phase 0–1:** scope to spaceships. Mechanical style family only. Kit ~30 blocks, 3 paint schemes.
- **Phase 2:** add organic + structural style families. Expand kit. Generalize to non-ship use cases (kettles, manifolds, bridges).
- **Phase 3:** productize. Public API, auth, billing, hosted GPU, client SDK, docs.

---

## 7. Data model

Five top-level entities:

```
KitBlock      — A single block shape × style family. Mesh, UVs, mount points.
                Versioned by content hash; immutable.
PaintScheme   — A trim-sheet atlas + per-face material params.
                Versioned by content hash; immutable.
Arrangement   — A grid of (position, block, paint, orientation) tuples
                + a connection-point registry.
                Output of the generator OR the manual composer.
Generation    — An Arrangement + full provenance:
                prompt, constraints, model version, seed, timestamp.
Composition   — A graph of Arrangements connected through matched
                connection points. A ship is a Composition.
```

Persistence: local filesystem for v3. JSON manifests + binary blobs (kit meshes, trim sheets). Cloud + multi-user sharing is Phase 3.

---

## 8. What carries over from v1 / v2

**From v1** (procedural module factories — rejected outright):

- Three.js viewport, orbit controls, lighting/FPS panel
- Zustand UI shell + React component patterns
- The "lab hull" concept — a hull class that's just one module, used here for iterating on the kit in isolation
- Export pipeline shape (block-arrangement → game-ready output)

**From v2** (AI mesh authoring — rejected):

- Artifact-first persistence model
- Refinement loops as a UX primitive (re-generate, kick back to constraint, edit prompt)
- The library-as-compounding-asset framing (here, the library is the kit + cached Generations)

**What goes away from v2 entirely:**

- The iso-projection pipeline (Stages 2 + 4)
- Per-module Meshy image-to-3D (Stage 5) — replaced by TRELLIS + quantizer
- Mesh conversion + socket extraction (Stage 6) — both dissolve under voxelization
- Meshy as a vendor
- The whole "concept art is the source of truth" framing — in v3 the prompt/image is just one input to the generator, not a binding artifact

---

## 9. Open questions

1. **TRELLIS silhouette survival at low voxel resolution.** TRELLIS runs internally at 64³ or 128³; the kit's effective resolution is 16³–32³. Aggressive quantization may destroy recognizable silhouettes. Must validate in Phase 0 before any commitment.
2. **Connection-point enforcement strategy.** Re-roll until satisfied is cheap but unbounded; carve-and-repaint is reliable but post-hoc. Likely both, with re-roll as primary and carve as fallback. Validate in Phase 0.
3. **Kit grid resolution.** 16³ (faster generation, blockier silhouettes), 32³ (slower, smoother), or adaptive per object size. Default position: 32³ for game-scale objects, 16³ for small props.
4. **Style family as kit-fork or paint-fork?** Are organic / mechanical / structural separate shape kits, or one shape kit with three paint-family treatments? Current bet: ~90% shared shapes + ~10% style-specific specials + per-family paint treatments.
5. **GPU hosting for TRELLIS.** Self-host (cheaper at scale, ops burden) or hosted inference (Replicate, Fal, Modal — per-call cost, no ops)? Start hosted; self-host once usage justifies it.
6. **Model selection beyond TRELLIS.** Hunyuan3D, TripoSR, SF3D, Rodin all candidates. Worth A/B'ing one or two in Phase 0 alongside TRELLIS.
7. **Connection-point vocabulary stability.** Adding a new type later may invalidate older Generations. Versioning the vocabulary, or freezing it after Phase 1?

---

## 10. Phase 0 — first-week kill test

Before committing to any of this: prove the architecture works at all. Three tests, in order:

**Test 1 — upstream model output at our resolution.** Pull TRELLIS. Run five prompts: `"teapot"`, `"engine manifold"`, `"small bridge"`, `"cargo hauler bow"`, `"spaceship engine"`. Downsample each output to 16³ and 32³. Eyeball: do silhouettes survive? If yes → upstream works at our resolution. If no → higher kit resolution (more authoring work, same architecture) or a different upstream model.

**Test 2 — naive quantizer.** Hand-author 10 kit blocks (cube, half-cube, slope, slope corner, inverted corner, quarter-cylinder, eighth-sphere, wedge, plus two specials). Write a ~50-line greedy normal-matching quantizer. Render outputs from Test 1 through it in Three.js `InstancedMesh`. Do they read as the input prompts?

**Test 3 — connection-point enforcement.** Take the `"engine manifold"` case. Add constraint: flanges on +X and -X faces. Implement both re-roll and carve-and-repaint. Can you reliably produce manifolds with the constraint satisfied?

If all three pass: architecture works, rest is craft. If any fail: known which layer needs more work before committing further. **Don't author the rest of the kit, don't build the composer, don't scaffold the service** until Phase 0 passes.

---

## 11. Phase plan

**Phase 0 — Validation (~1 week).** Kill test above. Decision gate.

**Phase 1 — Tool for spaceships (~3 months).** Full mechanical-family kit (~30 blocks, 3 paint schemes), Three.js renderer, manual composer, generator API wrapping TRELLIS via hosted inference, spaceship-specific connection-point types. Goal: a tool that produces ships the user is happy with.

**Phase 2 — Generalization (~3 months).** Add organic and structural style families. Expand kit to ~40 shapes × 3 families. Add cross-domain connection-point types. Goal: generate kettles, manifolds, bridges, alien objects from the same service.

**Phase 3 — Product.** Public API, auth, billing, hosted GPU (or self-host), client SDK, docs. Spaceship game as anchor demo. Goal: external users.

v1 stays buildable on its tag. v2 work (if any has happened) is shelved — its artifacts have no carry-over to v3 beyond the architectural lessons in §8.
