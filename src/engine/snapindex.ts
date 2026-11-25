// Spatial index for snapping to line work (no MuPDF: runs in the UI thread).
export type SnapKind = "end" | "intersection" | "mid" | "line";
export interface SnapHit {
  pt: [number, number];
  kind: SnapKind;
}

/** Grid index over segments for fast "what's near the cursor" lookups. */
export class SnapIndex {
  private cells = new Map<number, number[]>();
  constructor(private seg: Float32Array, private cell = 24) {
    const n = seg.length / 4;
    for (let i = 0; i < n; i++) {
      const x1 = seg[i * 4], y1 = seg[i * 4 + 1], x2 = seg[i * 4 + 2], y2 = seg[i * 4 + 3];
      const cx0 = Math.floor(Math.min(x1, x2) / cell), cx1 = Math.floor(Math.max(x1, x2) / cell);
      const cy0 = Math.floor(Math.min(y1, y2) / cell), cy1 = Math.floor(Math.max(y1, y2) / cell);
      // Long lines touch many cells; walk only the cells the line passes near.
      for (let cx = cx0; cx <= cx1; cx++)
        for (let cy = cy0; cy <= cy1; cy++) {
          if (cx1 - cx0 > 1 && cy1 - cy0 > 1 && distToSeg((cx + 0.5) * cell, (cy + 0.5) * cell, x1, y1, x2, y2) > cell) continue;
          const k = key(cx, cy);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }
  get size() {
    return this.seg.length / 4;
  }
  private near(x: number, y: number, r: number): number[] {
    const out = new Set<number>();
    const c = this.cell;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++)
      for (let cy = Math.floor((y - r) / c); cy <= Math.floor((y + r) / c); cy++) for (const i of this.cells.get(key(cx, cy)) ?? []) out.add(i);
    return [...out];
  }
  /** The best snap within r points of (x, y): end points first, then intersections, mid points, then the nearest line. */
  snap(x: number, y: number, r: number): SnapHit | null {
    const s = this.seg;
    const cand = this.near(x, y, r).filter((i) => distToSeg(x, y, s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]) <= r);
    if (!cand.length) return null;
    let best: SnapHit | null = null, bestD = Infinity;
    const consider = (px: number, py: number, kind: SnapKind, bias: number) => {
      const d = Math.hypot(px - x, py - y);
      if (d <= r && d * bias < bestD) (bestD = d * bias), (best = { pt: [px, py], kind });
    };
    for (const i of cand) {
      consider(s[i * 4], s[i * 4 + 1], "end", 0.5);
      consider(s[i * 4 + 2], s[i * 4 + 3], "end", 0.5);
    }
    if (best) return best;
    const limited = cand.slice(0, 400);
    for (let a = 0; a < limited.length; a++)
      for (let b = a + 1; b < limited.length; b++) {
        const i = limited[a], j = limited[b];
        const p = intersect(s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3], s[j * 4], s[j * 4 + 1], s[j * 4 + 2], s[j * 4 + 3]);
        if (p) consider(p[0], p[1], "intersection", 0.6);
      }
    if (best) return best;
    for (const i of cand) consider((s[i * 4] + s[i * 4 + 2]) / 2, (s[i * 4 + 1] + s[i * 4 + 3]) / 2, "mid", 0.8);
    if (best) return best;
    for (const i of cand) {
      const p = closest(x, y, s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]);
      consider(p[0], p[1], "line", 1);
    }
    return best;
  }
}

const key = (cx: number, cy: number) => cx * 100_003 + cy;
function closest(px: number, py: number, x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l)) : 0;
  return [x1 + t * dx, y1 + t * dy];
}
function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const [cx, cy] = closest(px, py, x1, y1, x2, y2);
  return Math.hypot(px - cx, py - cy);
}
function intersect(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): [number, number] | null {
  const den = (c - a) * (h - f) - (d - b) * (g - e);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((e - a) * (h - f) - (f - b) * (g - e)) / den;
  const u = ((e - a) * (d - b) - (f - b) * (c - a)) / den;
  const eps = 1e-6;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a + t * (c - a), b + t * (d - b)];
}
