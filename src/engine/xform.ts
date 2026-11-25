// Placement of an image on a page: centre, size and clockwise rotation, in display space
// (points, origin top-left, y down). Shared by page images (Edit tool) and image stamps
// such as signatures, so both get the same move / resize / rotate handles.
export interface Xf { cx: number; cy: number; w: number; h: number; angle: number }
export type Pt2 = [number, number];
export type Mat = [number, number, number, number, number, number];

const rad = (d: number) => (d * Math.PI) / 180;

/** Image-space matrix (unit square, y up) → display space, as a PDF `cm` operand. */
export function imageMatrix(t: Xf): Mat {
  const c = Math.cos(rad(t.angle)), s = Math.sin(rad(t.angle));
  const a = t.w * c, b = t.w * s, cc = t.h * s, d = -t.h * c;
  return [a, b, cc, d, t.cx - (a + cc) / 2, t.cy - (b + d) / 2];
}

/** Read a placement back from an image matrix (as reported by MuPDF for page images). */
export function xfFromMatrix(m: number[]): Xf {
  const [a, b, c, d, e, f] = m;
  const w = Math.hypot(a, b), h = Math.hypot(c, d);
  return { cx: e + (a + c) / 2, cy: f + (b + d) / 2, w, h, angle: norm((Math.atan2(b, a) * 180) / Math.PI) };
}

export const xfFromRect = (r: number[]): Xf => ({ cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w: r[2] - r[0], h: r[3] - r[1], angle: 0 });

/** Angle in [0, 360), rounded away from floating-point noise. */
export const norm = (a: number) => {
  const v = ((Math.round(a * 1000) / 1000) % 360 + 360) % 360;
  return v === 360 ? 0 : v;
};

/** The four corners, clockwise from top-left (before rotation). */
export function corners(t: Xf): Pt2[] {
  const c = Math.cos(rad(t.angle)), s = Math.sin(rad(t.angle));
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const x = (sx * t.w) / 2, y = (sy * t.h) / 2;
    return [t.cx + x * c - y * s, t.cy + x * s + y * c] as Pt2;
  });
}

export function bounds(t: Xf): number[] {
  const p = corners(t);
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Where the rotate handle sits: above the top edge's middle. */
export function rotateHandle(t: Xf, gap: number): Pt2 {
  const c = Math.cos(rad(t.angle)), s = Math.sin(rad(t.angle));
  const y = -t.h / 2 - gap;
  return [t.cx - y * s, t.cy + y * c];
}

/** A point in the image's own frame (centre origin, unrotated). */
function toLocal(t: Xf, p: Pt2): Pt2 {
  const c = Math.cos(rad(-t.angle)), s = Math.sin(rad(-t.angle));
  const x = p[0] - t.cx, y = p[1] - t.cy;
  return [x * c - y * s, x * s + y * c];
}

export type XfHit = "move" | "rotate" | 0 | 1 | 2 | 3;

/** What a press at `p` grabs: a corner, the rotate handle, the body, or nothing. `tol` in points. */
export function hitXf(t: Xf, p: Pt2, tol: number): XfHit | null {
  const r = rotateHandle(t, tol * 3);
  if (Math.hypot(p[0] - r[0], p[1] - r[1]) <= tol * 1.3) return "rotate";
  const cs = corners(t);
  for (let i = 0; i < 4; i++) if (Math.hypot(p[0] - cs[i][0], p[1] - cs[i][1]) <= tol) return i as 0 | 1 | 2 | 3;
  const [x, y] = toLocal(t, p);
  return Math.abs(x) <= t.w / 2 && Math.abs(y) <= t.h / 2 ? "move" : null;
}

/**
 * New placement while dragging. Corners keep the aspect ratio unless `free` (Shift); rotation
 * snaps to 15° steps with `free`, and otherwise to the nearest right angle within 4°.
 */
export function dragXf(t0: Xf, grab: XfHit, from: Pt2, to: Pt2, free = false): Xf {
  if (grab === "move") return { ...t0, cx: t0.cx + to[0] - from[0], cy: t0.cy + to[1] - from[1] };
  if (grab === "rotate") {
    let a = (Math.atan2(to[1] - t0.cy, to[0] - t0.cx) * 180) / Math.PI + 90;
    if (free) a = Math.round(a / 15) * 15;
    else {
      const q = Math.round(a / 90) * 90;
      if (Math.abs(a - q) < 4) a = q;
    }
    return { ...t0, angle: norm(a) };
  }
  // Corner: the opposite corner stays put.
  const sign: Pt2[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const [sx, sy] = sign[grab];
  const fixed: Pt2 = [(-sx * t0.w) / 2, (-sy * t0.h) / 2];
  const p = toLocal(t0, to);
  let w = Math.max(4, (p[0] - fixed[0]) * sx);
  let h = Math.max(4, (p[1] - fixed[1]) * sy);
  if (!free) {
    const k = Math.max(w / t0.w, h / t0.h);
    w = t0.w * k;
    h = t0.h * k;
  }
  const lc: Pt2 = [fixed[0] + (sx * w) / 2, fixed[1] + (sy * h) / 2];
  const c = Math.cos(rad(t0.angle)), s = Math.sin(rad(t0.angle));
  return { cx: t0.cx + lc[0] * c - lc[1] * s, cy: t0.cy + lc[0] * s + lc[1] * c, w, h, angle: t0.angle };
}
