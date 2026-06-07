# Spec.v2 — AI-orchestrated Ship Authoring

**Status:** draft. This is a clean break from `Spec.md` (v1). v1's stance was "procedurally generate everything from typed module factories"; v2's stance is "AI drafts the design, AI generates the assets, the tool composes them into a ship and maintains a reusable module library."

The shift is from *we wrote a generator* to *we wrote a workflow*.

---

## 1. Overview

The product is still a browser-based tool for generating large spacecraft, but the generation pipeline is rebuilt around AI as an authoring partner. A ship is no longer the output of a deterministic procedural pass over a hand-authored module library; it's the output of a guided AI conversation that produces a design brief, a set of 2D concepts, a blueprint, and finally a library of 3D modules that the tool composes.

The user's role moves up a level — from "tune procedural parameters" to "direct an AI design studio." The user states intent, picks among AI-generated options, requests revisions, and approves outputs that flow into the next stage.

The tool's role is to **orchestrate the pipeline**, **persist artifacts** between stages, **provide previews and refinement controls**, and **maintain a long-lived library** of every approved module so future ships can reuse them.

Three design stances shape the whole pipeline:

**Every stage is a refinement loop, not a one-shot.** Each output (spec, concept image, blueprint, Meshy model) is something the user can revise — by re-prompting, editing the brief, or kicking the stage backward. The pipeline is directional but not linear.

**Artifacts are first-class and persistent.** Specs, prompts, images, blueprint files, and generated meshes are all named, versioned, and stored. A ship is the assembly of named artifacts; the artifacts outlive any single ship.

**The module library is the long-term value.** A single ship produces dozens of 3D modules. After enough ships, the library covers most of what users need, the Meshy-generation step gets used less, and the tool shifts toward assembly + light retouching.

---

## 2. Pipeline

Eight stages, each gated on the user approving the previous stage's output.

### Stage 1 — Design brief

An LLM-driven conversation produces a **Ship Specification** document: hull class, role, scale, narrative context, propulsion family, crew complement, cargo type, defensive armament, signature features. Driven by a structured prompt template; the user answers a small number of high-level questions ("what does this ship do? what's its size class? what's its visual heritage?"). The LLM fills in the long tail.

Output: a structured spec object (typed JSON) plus a human-readable brief.

### Stage 2 — Concept art

The Ship Specification drives **Meshy text-to-image** requests for concept art. All views are generated in **isometric projection** rather than orthographic or perspective — the same isometric angle for every view. The prompt template hard-codes the projection so cross-view consistency is dictated by the request, not negotiated by the AI.

Views generated:

- Front-port isometric (3/4 from the bow-port side)
- Front-starboard isometric (mirror angle)
- Rear-port isometric
- Top-down isometric (plan view, slight tilt)

Each view is generated multiple times so the user can pick a preferred image per angle. Inconsistency between views is still expected — they're concept art, not orthographic projections of a single 3D model — but the isometric constraint gives Stage 5's image-to-3D step a much better source than perspective-distorted concept art would.

Output: a set of approved 2D isometric images, one per angle.

### Stage 3 — Module decomposition

The LLM reads the approved concept art (via vision) plus the ship spec and **decomposes the ship into a module manifest**: a list of named modules (bow assembly, mid spine segment, port engine pod, dorsal bridge tower, etc.) with their approximate dimensions, position on the blueprint, and a per-module description that's specific enough to feed Stage 5.

Output: a `ModuleManifest` — typed list of module specs with placement hints.

### Stage 4 — External blueprint

A 2D blueprint of the ship is composed in **the same isometric projection used in Stage 2**, so the blueprint and the approved concept images sit in the same coordinate system. Module silhouettes from the manifest are laid out on the isometric canvas. The blueprint is editable: the user can drag modules to refine placement, resize them, or annotate them. The blueprint becomes the ground truth for module positions and dimensions going into Stage 5.

This is the bridge between 2D art (Stage 2) and 3D geometry (Stage 5–6). Locking everything to isometric means the user can drop module silhouettes directly on top of the approved concept image to verify placement before committing.

Output: the blueprint with finalised module rectangles + dimensions, in isometric coords.

### Stage 5 — Meshy image-to-3D

For each module in the manifest, the tool sends a **Meshy image-to-3D** request — *not* text-to-3D. The image input comes from a crop of the approved concept art (the same isometric image already approved in Stage 2) covering the module's blueprint rectangle. This gives Meshy a concrete reference rather than asking it to interpret a text description, which produces materially better results.

Inputs per request:

- The module's image crop from the approved isometric concept (Stage 2 + 4)
- A short text caption derived from the module's manifest entry (Stage 3) for disambiguation
- Dimension constraints (bounding box in world units, derived from the blueprint)

Meshy returns one or more 3D mesh candidates per module. The user previews them in a side-by-side selector and approves one (or kicks back for a re-crop + re-prompt).

Output: an approved `.glb` (or equivalent) per module, persisted to the local library.

### Stage 6 — Asset conversion

Each approved Meshy mesh is run through a deterministic post-process to become **game-ready**:

- Triangulation + decimation to a target poly budget
- LOD generation
- Material baking (Meshy's PBR texture set → game-engine-ready trim sheets or per-module texture atlases)
- Collision proxy generation
- Socket extraction (named anchor points read from mesh attributes or a sibling JSON)

Output: a `ModuleAsset` — the game-ready mesh + materials + sockets + manifest entry.

### Stage 7 — Ship assembly

The blueprint's module rectangles drive a Three.js scene where each rectangle is replaced by its corresponding `ModuleAsset`. Sockets snap modules to each other. The user previews the assembled ship in real time, can swap modules out for alternatives from the library, and can re-run Stage 5 on any module that isn't reading well.

Output: a complete `Ship` — composed scene + persistent reference to every contributing artifact.

### Stage 8 — Library deposit

Every approved `ModuleAsset` enters the persistent **Module Library**, tagged with:

- Hull class / role hints from the originating ship
- Style family (visual lineage)
- Approximate dimensions
- Socket signature

Future ships can browse the library before generating new modules. Library hits short-circuit Stages 5–6 entirely.

---

## 3. Data model

Five top-level entities:

```
ShipSpec       — Stage 1 output. Structured spec + narrative brief.
ConceptSet     — Stage 2 output. References to approved images per view.
ModuleManifest — Stage 3 output. List of ModuleSpec + placements.
Blueprint      — Stage 4 output. ModuleSpecs with locked-in 2D rects.
ModuleAsset    — Stage 5–6 output. The game-ready mesh + sockets + meta.
Ship           — Stage 7 output. Blueprint + ModuleAsset refs + composition.
```

Each entity is named, versioned, and persisted as JSON + binary blobs. Identity is by content hash for assets, by user-assigned name for specs. Every transition stores the inputs and prompt used to produce the output, so any output can be traced back through the pipeline and re-run with adjustments.

Persistence: **local filesystem only.** Artifacts live in a structured folder layout next to the project — JSON manifests + binary blobs (images, `.glb` files). No cloud storage, no shared library across machines in v2. A future revision can address sharing.

---

## 4. AI orchestration

Two AI service classes — assuming Meshy provides text-to-image alongside image-to-3D (**to verify**, see open questions):

| Service | Stages | Role |
|---|---|---|
| **LLM** (chat / vision) | 1, 3, sometimes 4 | Specification, decomposition, module description |
| **Meshy** | 2, 5 | Concept art (text-to-image), then mesh generation (image-to-3D) |

If Meshy's text-to-image isn't available, Stage 2 falls back to a separate image-gen provider — but the rest of the pipeline is unchanged. The downstream image-to-3D step still consumes whatever images Stage 2 produced.

Each call has a typed input + typed output schema; the orchestration code is in the application layer, not embedded in the AI calls. The application owns the prompt templates (including the isometric projection instruction) and the data shape; the AI owns the creative content.

**Determinism strategy.** AI is non-deterministic. The tool stores the exact prompt + model id + seed (where available) used for every output, so an output is reproducible *modulo provider drift*. Rolling back a stage doesn't lose the original output; it adds a sibling.

**Cost strategy — deferred.** Meshy and image generation cost real money. For v2's initial milestones, cost gating is not built — the user runs the pipeline knowing what it costs. A `--dry-run` mode shows the pipeline's planned calls without executing them. Per-user cost gating, prepaid credits, and budget limits are a later concern, addressed once the pipeline works end-to-end.

---

## 5. The module library

The library is the tool's compounding asset. After ~10 ships, the library covers most common spaceship modules; after ~50, the typical user assembles a new ship without invoking Meshy at all.

Library entries are queryable by:

- Hull class fit (does this module work on a freighter? a corvette?)
- Style family (industrial-utilitarian, military, civilian, alien)
- Position type (bow, spine, stern, dorsal, lateral)
- Dimensions
- Socket signature (does it mate to a given adjacent module?)

A library entry is immutable once approved — refinements produce a new entry, not an in-place edit. This keeps existing ships that reference the old entry intact.

---

## 6. Refinement loops

Three loops the user routinely uses:

**Inside a stage** — regenerate this concept image, this module spec, this Meshy candidate.

**Across one stage boundary** — go back to Stage 3 and rewrite a module description, then re-run Stage 5 for that one module without redoing the rest.

**Across many stages** — rewrite the ship spec, propagate downstream. The tool warns about which approved artifacts will be invalidated and offers to keep them as orphans in the library or discard them.

Refinement state is part of the ship's history; nothing is destructively overwritten.

---

## 7. What carries over from v1

v1's procedural module library is being retired. What survives is the **delivery side** of the tool:

- The Three.js viewport, orbit controls, lighting/FPS panel
- The Zustand-based UI shell + React component patterns
- The segmented ship output model (each module is its own Group with a stable `instanceId`)
- The export pipeline (game-ready mesh + manifest)
- The lab hull-class concept (a hull class that's just one module, used for iterating on modules in isolation)

What goes away:
- Every per-module procedural factory (spine, bow, stern, cargo, bridge, lab cube, cockpit)
- The whole `panel/` system (canvases, FBM rust, decals, end caps, etc.)
- The grammar/assembly engine
- The instanceSeed-driven RNG architecture

The build-time procedural code is replaced by a runtime AI orchestration layer plus a persistence layer for artifacts.

---

## 8. Open questions

Decisions to make before / during implementation:

1. **Does Meshy actually provide text-to-image generation?** The spec currently assumes Meshy covers both Stage 2 (text-to-image) and Stage 5 (image-to-3D). Verify against current Meshy API docs. If text-to-image isn't offered, pick a separate provider for Stage 2 (Nano Banana 2 / Imagen / DALL·E / Stable Diffusion via Replicate). The rest of the pipeline is unchanged.
2. **LLM provider** for Stages 1 + 3 (brief, decomposition). Anthropic is the natural default; the LLM also needs vision for Stage 3 to read approved concept art.
3. **Meshy API specifics.** Pricing tiers, mesh quality at each tier, how to constrain bounding-box dimensions, what file formats come back, per-request latency.
4. **Stage 4 blueprint editor — bespoke or off-the-shelf?** A bespoke 2D rect editor on top of the approved concept image is straightforward; off-the-shelf would let users freehand-sketch directly. Defer this until we get to Stage 4 in the CLI pipeline.
5. **Determinism + provider drift.** If Meshy changes model versions, do old ships re-generate when reloaded, or do we freeze the binary asset and lose the prompt link? Default position: freeze the asset, keep the prompt as provenance metadata.
6. **Stage 6 conversion pipeline.** Meshy outputs aren't game-ready. What does the conversion look like — a Node script wrapping Blender + glTF tools, or a service like Sketchfab's conversion API, or something else? This is the technical risk that needs prototyping early.

---

## 9. Migration plan

**Phase 0 — CLI pipeline first.** Before any app work, the whole pipeline is built as a command-line tool. Each stage is a script that reads + writes JSON / blobs on the local filesystem. Running the full pipeline is `npm run pipeline <ship-name>`, or each stage is invokable individually so the user can iterate on one piece. No UI, no viewer — just stage-by-stage validation that the AI orchestration actually produces usable outputs.

Stage order in the CLI build-out (inverted, because the bottom of the pipeline is the technical risk):

1. **Filesystem schema** for `ShipSpec`, `ConceptSet`, `ModuleManifest`, `Blueprint`, `ModuleAsset`, `Ship`. Hand-write sample artifacts to verify the data model.
2. **Stage 5 (Meshy image-to-3D)** — wire up the API; feed hand-picked reference images, confirm the meshes come back usable. This is the make-or-break dependency for the whole project.
3. **Stage 6 (conversion)** — prove a Meshy output can be processed into a game-ready `.glb` with sockets and a manifest entry. Probably a Blender + Node script.
4. **Stage 2 (concept art)** — Meshy text-to-image (or whichever provider, depending on the open question above). Iterate on the isometric prompt template until cross-view consistency is acceptable.
5. **Stages 1 + 3 (LLM brief + decomposition)** — wire up Anthropic. The LLM reads the prompt + (in Stage 3) the approved Stage 2 images, returns typed JSON.
6. **Stage 4 (blueprint)** — at CLI level, this is just a JSON file the user edits by hand. The visual editor comes with the app.
7. **Stage 7 (assembly)** — at CLI level, an automated layout script that places modules from a Blueprint into a single output `.glb`. Visual preview comes with the app.

**Phase 1 — App.** Once the CLI pipeline produces a working ship end-to-end, port the orchestration into the existing app shell. The browser does what the browser is good for: previews, refinement controls, drag-and-drop blueprint editing, side-by-side Meshy candidate selection. AI calls and asset conversion can stay on the CLI / Node side (called via a thin local server), since they don't belong in the browser.

**Phase 2 — Cost gating, hardening.** Once the pipeline works and people are using it, add the per-user cost controls listed in §4.

**v1 stays buildable** on the `v1.0` tag throughout. v2 lives on a separate branch (or repo) until it has feature parity for the viewport and export.
