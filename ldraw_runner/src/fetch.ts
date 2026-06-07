/**
 * Fetches LDraw .dat files from the official library mirror, with disk cache.
 *
 * The official library is organized into directories. A part referenced as
 * `s/3001s01.dat` lives in `parts/s/3001s01.dat`; a primitive like
 * `box.dat` lives in `p/box.dat`. We don't know up front which directory
 * a given subpart lives in, so we try each candidate path and cache the
 * first one that returns 200.
 *
 * Cache location: ldraw_runner/cache/<dir>/<file>.dat
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', 'cache');

// Local complete LDraw library — `complete/ldraw/parts/`, `complete/ldraw/p/`,
// etc. If LDRAW_LOCAL is set OR the default sibling path exists, we use it as
// a zero-network source for every part. Falls back to disk cache and then
// network if a file isn't found locally.
const LOCAL_LDRAW_DIR_DEFAULT = join(__dirname, '..', '..', 'complete', 'ldraw');
const LOCAL_LDRAW_DIR = process.env.LDRAW_LOCAL || LOCAL_LDRAW_DIR_DEFAULT;

// Search both the official library and the unofficial parts tracker.
// Many recent / community-tracked parts live only under `unofficial/` —
// OMR (real LEGO set decompositions) references them constantly.
// Order matters: official wins ties, then unofficial as fallback.
const LIBRARY_BASES = [
  'https://library.ldraw.org/library/official',
  'https://library.ldraw.org/library/unofficial',
];
const SEARCH_DIRS = ['parts', 'parts/s', 'p', 'p/48'];

interface FetchResult {
  /** Directory under official/ where the file was found (e.g. "parts" or "p/48"). */
  foundIn: string;
  /** Raw file content. */
  content: string;
}

const memCache = new Map<string, FetchResult | null>();

export async function fetchDat(filename: string): Promise<FetchResult | null> {
  const norm = filename.toLowerCase().replace(/\\/g, '/');
  const cached = memCache.get(norm);
  if (cached !== undefined) return cached;

  // LDraw uses a few prefix conventions for unofficial parts. OMR commonly
  // references parts by their bare ID; the actual file may live with a
  // letter prefix. Try the bare name first, then common prefixes.
  // - `u<id>.dat`: "unofficial" — assigned-number replacements
  // - `x<id>.dat`: very rare; placeholder. Skip.
  // The norm has a directory prefix only when called recursively (e.g.
  // "s/3001s01.dat"). For those we don't apply prefixes.
  const triedNames: string[] = [norm];
  if (!norm.includes('/')) {
    triedNames.push('u' + norm);
  }

  // Local complete LDraw library — checked first.
  if (existsSync(LOCAL_LDRAW_DIR)) {
    for (const candidate of triedNames) {
      for (const dir of SEARCH_DIRS) {
        const localPath = join(LOCAL_LDRAW_DIR, dir, candidate);
        if (existsSync(localPath)) {
          const content = readFileSync(localPath, 'utf-8');
          const result = { foundIn: dir, content };
          memCache.set(norm, result);
          return result;
        }
      }
    }
  }

  // Disk cache layout (preserves existing cache from the pre-unofficial era):
  //   cache/<dir>/<file>            — official library
  //   cache/unofficial/<dir>/<file> — unofficial library
  for (const candidate of triedNames) {
    for (const base of LIBRARY_BASES) {
      const isUnofficial = base.endsWith('unofficial');
      const subdirPrefix = isUnofficial ? 'unofficial/' : '';
      for (const dir of SEARCH_DIRS) {
        const diskPath = join(CACHE_DIR, subdirPrefix + dir, candidate);
        if (existsSync(diskPath)) {
          const content = readFileSync(diskPath, 'utf-8');
          const result = { foundIn: subdirPrefix + dir, content };
          memCache.set(norm, result);
          return result;
        }
      }
    }
  }

  // Network fetch: official first, then unofficial.
  for (const candidate of triedNames) {
    for (const base of LIBRARY_BASES) {
      const isUnofficial = base.endsWith('unofficial');
      const subdirPrefix = isUnofficial ? 'unofficial/' : '';
      for (const dir of SEARCH_DIRS) {
        const url = `${base}/${dir}/${candidate}`;
        try {
          const res = await fetch(url);
          if (res.ok) {
            const content = await res.text();
            const diskPath = join(CACHE_DIR, subdirPrefix + dir, candidate);
            mkdirSync(dirname(diskPath), { recursive: true });
            writeFileSync(diskPath, content, 'utf-8');
            const result = { foundIn: subdirPrefix + dir, content };
            memCache.set(norm, result);
            return result;
          }
        } catch (e) {
          continue;
        }
      }
    }
  }

  console.warn(`[fetch] not found: ${norm}`);
  memCache.set(norm, null);
  return null;
}
