// Callout leader geometry. No PDF engine here, so the UI can use it too.
type Pt = [number, number];

/** Leader for a callout: from the arrow tip, through a short knee, to the middle of the box's nearest side. */
export function calloutGeometry(rect: number[], target: Pt, knee?: Pt): Pt[] {
  const [x0, y0, x1, y1] = rect;
  const side = target[0] < x0 || target[0] > x1;
  const end: Pt = target[0] < x0 ? [x0, (y0 + y1) / 2] : target[0] > x1 ? [x1, (y0 + y1) / 2] : [(x0 + x1) / 2, target[1] < y0 ? y0 : y1];
  const k: Pt = knee ?? (side ? [end[0] + (target[0] < x0 ? -18 : 18), end[1]] : [end[0], end[1] + (target[1] < y0 ? -18 : 18)]);
  return [target, k, end];
}
