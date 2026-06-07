/**
 * LDraw .dat file parser.
 *
 * Format reference: https://www.ldraw.org/article/218.html
 *
 * Line types we care about:
 *   0  comment / metadata / BFC directives
 *   1  subpart reference (recursive composition)
 *   3  triangle
 *   4  quad (we split into 2 triangles at resolution time)
 *
 * Line types we ignore: 2 (edges), 5 (optional/conditional lines).
 * They're for wireframe / decorative rendering, not the solid geometry we
 * want for kit fitting.
 */

export interface DatComment {
  type: 0;
  raw: string;
}

export interface DatSubpart {
  type: 1;
  /** LDraw colour code. 16 = inherit from parent. 24 = edge colour. */
  color: number;
  /** Translation (LDU). */
  position: [number, number, number];
  /** 3×3 rotation matrix, row-major: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
  rotation: [number, number, number, number, number, number, number, number, number];
  /** Subpart filename. Forward-slashed, lowercase. */
  file: string;
}

export interface DatTriangle {
  type: 3;
  color: number;
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
}

export interface DatQuad {
  type: 4;
  color: number;
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
  v4: [number, number, number];
}

export type DatLine = DatComment | DatSubpart | DatTriangle | DatQuad;

export interface ParsedDat {
  /** Description from the first `0 ...` comment (e.g. "Brick 2 x 4"). */
  description: string;
  /** Filename from `0 Name: X.dat`. */
  name: string;
  author?: string;
  /** Optional `!CATEGORY` directive value. */
  category?: string;
  /** BFC certification — back-face culling winding. */
  bfc?: 'ccw' | 'cw' | 'nocertify';
  lines: DatLine[];
}

function parseFloats(tokens: string[], start: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(parseFloat(tokens[start + i]));
  return out;
}

export function parseDat(content: string): ParsedDat {
  const parsed: ParsedDat = {
    description: '',
    name: '',
    lines: [],
  };

  let firstComment = true;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const tokens = trimmed.split(/\s+/);
    const type = parseInt(tokens[0], 10);
    if (!Number.isFinite(type)) continue;

    switch (type) {
      case 0: {
        const rest = trimmed.replace(/^0\s*/, '');
        if (firstComment && rest && !rest.startsWith('!') && !/^[A-Z]+:\s/.test(rest) && !/^BFC\s/i.test(rest)) {
          parsed.description = rest;
          firstComment = false;
        }
        const nameMatch = rest.match(/^Name:\s*(.+\.dat)\s*$/i);
        if (nameMatch) parsed.name = nameMatch[1].trim();
        const authorMatch = rest.match(/^Author:\s*(.+)$/i);
        if (authorMatch) parsed.author = authorMatch[1].trim();
        const categoryMatch = rest.match(/^!CATEGORY\s+(.+)$/i);
        if (categoryMatch) parsed.category = categoryMatch[1].trim();
        if (/^BFC\s+CERTIFY\s+CCW/i.test(rest)) parsed.bfc = 'ccw';
        else if (/^BFC\s+CERTIFY\s+CW/i.test(rest)) parsed.bfc = 'cw';
        else if (/^BFC\s+NOCERTIFY/i.test(rest)) parsed.bfc = 'nocertify';
        parsed.lines.push({ type: 0, raw: trimmed });
        break;
      }
      case 1: {
        if (tokens.length < 15) continue;
        const color = parseInt(tokens[1], 10);
        const [px, py, pz] = parseFloats(tokens, 2, 3);
        const m = parseFloats(tokens, 5, 9);
        const file = tokens.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
        parsed.lines.push({
          type: 1,
          color,
          position: [px, py, pz],
          rotation: [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]],
          file,
        });
        break;
      }
      case 3: {
        if (tokens.length < 11) continue;
        const color = parseInt(tokens[1], 10);
        const c = parseFloats(tokens, 2, 9);
        parsed.lines.push({
          type: 3,
          color,
          v1: [c[0], c[1], c[2]],
          v2: [c[3], c[4], c[5]],
          v3: [c[6], c[7], c[8]],
        });
        break;
      }
      case 4: {
        if (tokens.length < 14) continue;
        const color = parseInt(tokens[1], 10);
        const c = parseFloats(tokens, 2, 12);
        parsed.lines.push({
          type: 4,
          color,
          v1: [c[0],  c[1],  c[2]],
          v2: [c[3],  c[4],  c[5]],
          v3: [c[6],  c[7],  c[8]],
          v4: [c[9], c[10], c[11]],
        });
        break;
      }
      // Types 2 (edge line) and 5 (optional line) are ignored.
    }
  }

  return parsed;
}
