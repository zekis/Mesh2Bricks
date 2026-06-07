# ldraw_runner

Offline pre-processor that turns LDraw `.dat` part files into a flat JSON manifest the multipass quantizer can consume.

## What it does

1. **Fetches** part `.dat` files from `library.ldraw.org/library/official` on demand, with a disk cache in `cache/`. Subsequent runs are offline.
2. **Parses** each `.dat` file into typed line records (comment / subpart-ref / triangle / quad).
3. **Resolves** the recursive subpart tree, applying cumulative 4×3 transforms and splitting quads into triangles. Handles colour-16 (inherit) and reflection-flip (BFC) correctly.
4. **Infers** bounding box (in LDraw Units) and stud footprint (studsX × studsZ × heightPlates) per part.
5. **Emits** a manifest JSON with per-part triangle geometry + metadata. Phase 0 / the multipass fitter loads this manifest as its kit.

## Run

```
cd ldraw_runner
npm install
npm run process     # processes 10 sample parts → out/manifest.json
```

Or with a specific set:

```
npx tsx src/index.ts --parts 3001,3002,3040b --out out/sample.json
```

## LDraw conventions

- 1 stud width = **20 LDU**
- 1 brick height = **24 LDU** (= 3 plate heights)
- 1 plate height = **8 LDU**
- **−Y is up** in the source coordinate system (we preserve this in the manifest — downstream is free to flip)
- Colour `16` means "inherit from the calling parent"; resolved at the point of placement
- Colour `24` is the "complement" / edge colour
- BFC = Back-Face Culling certification; controls winding consistency. The resolver tracks an effective-flip bit so the manifest output has consistent triangle orientation.

## Status

**Stage 1** of the LDraw integration (Spec.v3.1 follow-on):

- [x] `.dat` parser
- [x] Disk-cached fetcher
- [x] Recursive subpart resolver
- [x] Footprint inference (LDU → stud-units)
- [x] Manifest emitter
- [ ] Curated 500-part subset
- [ ] glTF binary export (currently inline JSON — fine up to ~1000 parts)
- [ ] Integration with `phase0/`'s multipass fitter

## Output schema (v0.1)

```jsonc
{
  "schemaVersion": "0.1",
  "generatedAt": "2026-06-01T...",
  "source": "library.ldraw.org/library/official",
  "parts": [
    {
      "id": "3001",
      "description": "Brick 2 x 4",
      "category": "Brick",
      "footprint": { "studsX": 4, "studsZ": 2, "heightPlates": 3 },
      "bbox": { "min": [-40, 0, -20], "max": [40, 24, 20], "size": [80, 24, 40] },
      "positions": [/* flat x,y,z triples, 9 per triangle */],
      "colors":    [/* one LDraw colour code per triangle */],
      "triangleCount": 156
    }
  ]
}
```
