import type { Arrangement } from './quantize';
import type { VoxelGrid } from './voxelize';
import type { KitBlock } from './kit';
import type { BeamPlacement, PlatePlacement } from './multipass';
import { summarizeBeams, summarizePlates } from './multipass';
import type { LDrawPlacement } from './ldraw_fitter';

export interface StateSummary {
  timestamp: string;
  source: string;
  settings: {
    resolution: number;
    resolutionY: number;
    quantizer: string;
    smoothing: boolean;
    view: string;
    coloring: string;
  };
  stats: {
    surfaceVoxels: number;
    solidVoxels: number;
    smoothVoxels: number;
    smoothSurfaceVoxels: number;
    blocksPlaced: number;
  };
  bbox: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  blockHistogram: Record<string, { count: number; percent: number }>;
  layerCounts: { y: number; count: number }[];
  topDownSilhouette: string;
  beams: {
    count: number;
    totalCellsClaimed: number;
    byLength: Record<number, number>;
    byAxis: Record<string, number>;
  };
  plates: {
    count: number;
    totalCellsClaimed: number;
    bySize: Record<string, number>;
    byAxis: Record<string, number>;
  };
  ldrawPlacements: {
    count: number;
    cellsClaimed: number;
    byPart: Record<string, number>;
  };
  description: string;
}

interface BuildArgs {
  source: string;
  grid: VoxelGrid;
  arrangement: Arrangement;
  beams: BeamPlacement[];
  plates: PlatePlacement[];
  ldrawPlacements: LDrawPlacement[];
  kit: KitBlock[];
  quantizer: string;
  smoothing: boolean;
  view: string;
  coloring: string;
}

export function buildStateSummary(args: BuildArgs): StateSummary {
  const { source, grid, arrangement, beams, plates, ldrawPlacements, kit, quantizer, smoothing, view, coloring } = args;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const inst of arrangement) {
    const { x, y, z } = inst.position;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }

  const counts: Record<string, number> = {};
  const yLayer: Map<number, number> = new Map();
  for (const inst of arrangement) {
    const name = kit[inst.blockIndex].name;
    counts[name] = (counts[name] ?? 0) + 1;
    yLayer.set(inst.position.y, (yLayer.get(inst.position.y) ?? 0) + 1);
  }

  const histogram: Record<string, { count: number; percent: number }> = {};
  const total = arrangement.length;
  for (const [name, count] of Object.entries(counts)) {
    histogram[name] = {
      count,
      percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  }

  const layerCounts = Array.from(yLayer.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([y, count]) => ({ y, count }));

  const silhouette = buildTopDownSilhouette(arrangement, grid.size, minX, minZ, maxX, maxZ);

  const sizeX = maxX - minX + 1;
  const arrExtentY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;

  const sortedBlocks = Object.entries(histogram).sort((a, b) => b[1].count - a[1].count);
  const blockList = sortedBlocks
    .map(([name, h]) => `${h.count} ${name} (${h.percent}%)`)
    .join(', ');

  const beamSummary = summarizeBeams(beams);
  const plateSummary = summarizePlates(plates);
  const beamDescr = beamSummary.count > 0
    ? ` Beams: ${beamSummary.count} placed claiming ${beamSummary.totalCellsClaimed} interior cells (by axis: x=${beamSummary.byAxis.x}, y=${beamSummary.byAxis.y}, z=${beamSummary.byAxis.z}).`
    : '';
  const plateDescr = plateSummary.count > 0
    ? ` Plates: ${plateSummary.count} placed claiming ${plateSummary.totalCellsClaimed} surface cells (by axis: x=${plateSummary.byAxis.x}, y=${plateSummary.byAxis.y}, z=${plateSummary.byAxis.z}).`
    : '';

  const ldrawByPart: Record<string, number> = {};
  let ldrawCells = 0;
  for (const p of ldrawPlacements) {
    ldrawByPart[p.partId] = (ldrawByPart[p.partId] ?? 0) + 1;
    ldrawCells += p.cells.length;
  }
  const ldrawSummary = {
    count: ldrawPlacements.length,
    cellsClaimed: ldrawCells,
    byPart: ldrawByPart,
  };
  const ldrawDescr = ldrawSummary.count > 0
    ? ` LDraw: ${ldrawSummary.count} pieces placed claiming ${ldrawSummary.cellsClaimed} cells across ${Object.keys(ldrawByPart).length} unique part type(s).`
    : '';

  const description =
    `Source: ${source}. ${grid.size}×${grid.sizeY}×${grid.size} grid (anisotropic Y ${(grid.sizeY / grid.size).toFixed(2)}×), ` +
    `${quantizer} quantizer, smoothing ${smoothing ? 'on' : 'off'}, ` +
    `view "${view}", coloring "${coloring}". ` +
    `Voxelization: ${grid.occupied.size} surface, ${grid.solid.size} solid, ${grid.smooth.size} smoothed (close-only). ` +
    `Placed ${total} blocks spanning (${minX},${minY},${minZ})→(${maxX},${maxY},${maxZ}), extent ${sizeX}×${arrExtentY}×${sizeZ}. ` +
    `Block distribution: ${blockList}.${plateDescr}${beamDescr}${ldrawDescr}`;

  return {
    timestamp: new Date().toISOString(),
    source,
    settings: { resolution: grid.size, resolutionY: grid.sizeY, quantizer, smoothing, view, coloring },
    stats: {
      surfaceVoxels: grid.occupied.size,
      solidVoxels: grid.solid.size,
      smoothVoxels: grid.smooth.size,
      smoothSurfaceVoxels: grid.smoothSurface.size,
      blocksPlaced: total,
    },
    bbox: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [sizeX, arrExtentY, sizeZ],
    },
    blockHistogram: histogram,
    layerCounts,
    topDownSilhouette: silhouette,
    beams: beamSummary,
    plates: plateSummary,
    ldrawPlacements: ldrawSummary,
    description,
  };
}

// Top-down (XZ-plane) ASCII silhouette of the arrangement, downsampled to fit
// within ~32 cols. Each char represents a column of the grid; '#' if any block
// is present in that column, '.' otherwise.
function buildTopDownSilhouette(
  arrangement: Arrangement,
  gridSize: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): string {
  if (arrangement.length === 0) return '(empty)';
  const targetCols = 32;
  const sizeX = Math.max(1, maxX - minX + 1);
  const sizeZ = Math.max(1, maxZ - minZ + 1);
  const factor = Math.max(1, Math.ceil(Math.max(sizeX, sizeZ) / targetCols));
  const cols = Math.ceil(sizeX / factor);
  const rows = Math.ceil(sizeZ / factor);

  const grid: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (const inst of arrangement) {
    const c = Math.floor((inst.position.x - minX) / factor);
    const r = Math.floor((inst.position.z - minZ) / factor);
    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      grid[r][c] = true;
    }
  }

  const lines = grid.map((row) => row.map((b) => (b ? '#' : '.')).join(''));
  return lines.join('\n');
}

export async function postState(summary: StateSummary): Promise<void> {
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary, null, 2),
    });
  } catch (e) {
    console.warn('[state] failed to post:', e);
  }
}
