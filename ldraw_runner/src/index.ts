/**
 * Stage 1 entry point. Processes a list of LDraw part IDs end-to-end:
 *   fetch + parse + recursively resolve → compute bbox + footprint → emit manifest JSON.
 *
 * Usage:
 *   npx tsx src/index.ts --parts 3001,3002,3040b --out out/manifest.json
 *   npx tsx src/index.ts --parts-file path/to/top_parts.txt --out out/manifest.json
 *
 * Network fetches are cached on disk in ldraw_runner/cache/ so subsequent
 * runs are offline-fast.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePart, type ResolvedPart } from './resolve.js';
import { computeBoundingBox, inferFootprint, type BoundingBox, type Footprint } from './footprint.js';
import type { ConnectionPoint } from './resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PartManifestEntry {
  id: string;
  description: string;
  category: string | null;
  footprint: Footprint;
  bbox: BoundingBox;
  /** Triangle vertices flattened: [x1, y1, z1, x2, y2, z2, x3, y3, z3, ...]. */
  positions: number[];
  /** One colour code per triangle. */
  colors: number[];
  triangleCount: number;
  /** Connection points detected from LDraw primitive references during
   *  recursive resolve. Includes studs, anti-studs, pin-holes, axle-holes,
   *  etc. Each is in the part's local LDU frame. */
  connections: ConnectionPoint[];
}

interface Manifest {
  schemaVersion: '0.1';
  generatedAt: string;
  source: 'library.ldraw.org/library/official';
  parts: PartManifestEntry[];
}

function parseArgs(argv: string[]): { parts: string[]; out: string } {
  let parts: string[] = [];
  let out = 'out/manifest.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--parts' && argv[i + 1]) {
      parts.push(...argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
      i++;
    } else if (argv[i] === '--parts-file' && argv[i + 1]) {
      const fileParts = readFileSync(argv[i + 1], 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.split('#')[0].trim())
        .filter(Boolean);
      parts.push(...fileParts);
      i++;
    } else if (argv[i] === '--out' && argv[i + 1]) {
      out = argv[i + 1];
      i++;
    }
  }
  // Dedupe while preserving order (first occurrence wins).
  parts = [...new Set(parts)];
  if (parts.length === 0) {
    // Default smoke-test set: 5 bricks + 3 plates + 2 slopes
    parts = ['3001', '3002', '3003', '3004', '3005', '3024', '3023', '3022', '3040b', '3039'];
  }
  return { parts, out };
}

function flattenTriangles(part: ResolvedPart): { positions: number[]; colors: number[] } {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const t of part.triangles) {
    // Apply BFC flip by reversing winding for marked triangles.
    if (t.flip) {
      positions.push(t.v1[0], t.v1[1], t.v1[2], t.v3[0], t.v3[1], t.v3[2], t.v2[0], t.v2[1], t.v2[2]);
    } else {
      positions.push(t.v1[0], t.v1[1], t.v1[2], t.v2[0], t.v2[1], t.v2[2], t.v3[0], t.v3[1], t.v3[2]);
    }
    colors.push(t.color);
  }
  return { positions, colors };
}

async function main(): Promise<void> {
  const { parts: partIds, out } = parseArgs(process.argv.slice(2));
  console.log(`[ldraw] processing ${partIds.length} part(s)`);
  const verbose = partIds.length <= 50;
  const progressEvery = Math.max(1, Math.floor(partIds.length / 20));

  const entries: PartManifestEntry[] = [];
  const failed: string[] = [];
  const tStart = Date.now();
  for (let i = 0; i < partIds.length; i++) {
    const id = partIds[i];
    const t0 = Date.now();
    const resolved = await resolvePart(id);
    if (!resolved) {
      failed.push(id);
      if (verbose) console.warn(`[ldraw] FAILED to resolve: ${id}`);
      continue;
    }
    const bbox = computeBoundingBox(resolved.triangles);
    const footprint = inferFootprint(bbox);
    const { positions, colors } = flattenTriangles(resolved);

    entries.push({
      id: resolved.id,
      description: resolved.description,
      category: resolved.category,
      footprint,
      bbox,
      positions,
      colors,
      triangleCount: resolved.triangles.length,
      connections: resolved.connections,
    });

    const dt = Date.now() - t0;
    if (verbose) {
      const connCounts: Record<string, number> = {};
      for (const c of resolved.connections) connCounts[c.type] = (connCounts[c.type] ?? 0) + 1;
      const connSummary = Object.entries(connCounts).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
      console.log(
        `[ldraw] ${id.padEnd(8)} "${resolved.description.padEnd(28)}" ` +
        `tri=${String(resolved.triangles.length).padStart(5)} ` +
        `footprint=${footprint.studsX}x${footprint.studsZ}x${footprint.heightPlates}p ` +
        `conn=[${connSummary}] (${dt} ms)`,
      );
    } else if ((i + 1) % progressEvery === 0 || i === partIds.length - 1) {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      console.log(`[ldraw] ${i + 1}/${partIds.length} processed (${entries.length} ok, ${failed.length} failed, ${elapsed}s elapsed)`);
    }
  }
  if (failed.length > 0 && !verbose) {
    console.warn(`[ldraw] ${failed.length} failed to resolve: ${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ' ...' : ''}`);
  }

  const manifest: Manifest = {
    schemaVersion: '0.1',
    generatedAt: new Date().toISOString(),
    source: 'library.ldraw.org/library/official',
    parts: entries,
  };

  // Honor absolute paths verbatim; relative paths are resolved against
  // the ldraw_runner/ root (parent of src/) so behaviour matches the docs.
  const outPath = isAbsolute(out) ? resolvePath(out) : join(__dirname, '..', out);
  mkdirSync(dirname(outPath), { recursive: true });
  // Compact JSON for bulk manifests (no whitespace). Pretty-print roughly
  // doubles size for our triangle-heavy parts; not worth it past ~50 parts.
  const json = entries.length > 50 ? JSON.stringify(manifest) : JSON.stringify(manifest, null, 2);
  writeFileSync(outPath, json, 'utf-8');

  const totalBytes = JSON.stringify(manifest).length;
  console.log(`\n[ldraw] wrote ${entries.length} parts → ${outPath} (${(totalBytes / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error('[ldraw] fatal:', err);
  process.exit(1);
});
