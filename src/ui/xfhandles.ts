// On-page move / resize / rotate handles for images and signatures. Drawn in the page's SVG
// overlay (page points); the caller decides what a finished drag does.
import { type Xf, type XfHit, type Pt2, corners, rotateHandle, hitXf, dragXf, norm } from "../engine/xform";

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number>, cls = "") => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (cls) n.setAttribute("class", cls);
  return n;
};

/** Page points per screen pixel for a page element. */
export const ptPerPx = (pageEl: HTMLElement, pageWidthPt: number) => pageWidthPt / pageEl.getBoundingClientRect().width;

/** Draw the handles; returns the group so callers can remove it. */
export function drawHandles(svg: SVGSVGElement, t: Xf, ppx: number, cls = "xf-handles"): SVGGElement {
  svg.querySelectorAll(`.${cls}`).forEach((n) => n.remove());
  const g = svgEl("g", {}, `${cls} xfh`) as SVGGElement;
  const cs = corners(t);
  const stroke = { stroke: "#05C7F2", "stroke-width": 1.5 * ppx, fill: "none" };
  g.append(svgEl("polygon", { points: cs.map((p) => p.join(",")).join(" "), ...stroke }));
  const top: Pt2 = [(cs[0][0] + cs[1][0]) / 2, (cs[0][1] + cs[1][1]) / 2];
  const rh = rotateHandle(t, 18 * ppx);
  g.append(svgEl("line", { x1: top[0], y1: top[1], x2: rh[0], y2: rh[1], ...stroke }));
  g.append(svgEl("circle", { cx: rh[0], cy: rh[1], r: 5 * ppx, fill: "#fff", stroke: "#05C7F2", "stroke-width": 1.5 * ppx }));
  for (const p of cs) g.append(svgEl("rect", { x: p[0] - 4 * ppx, y: p[1] - 4 * ppx, width: 8 * ppx, height: 8 * ppx, fill: "#fff", stroke: "#05C7F2", "stroke-width": 1.5 * ppx }));
  const label = svgEl("text", { x: rh[0] + 9 * ppx, y: rh[1] + 4 * ppx, "font-size": 11 * ppx, fill: "#0D0D0D", "font-family": "system-ui, sans-serif", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 * ppx }, "xf-angle");
  label.textContent = t.angle ? `${Math.round(norm(t.angle))}°` : "";
  g.append(label);
  svg.append(g);
  return g;
}

/** What a press grabs, using screen-sized tolerances. */
export const grabAt = (t: Xf, p: Pt2, ppx: number): XfHit | null => hitXf(t, p, 7 * ppx);

export const cursorFor = (g: XfHit | null, t: Xf): string => {
  if (g === null) return "";
  if (g === "move") return "move";
  if (g === "rotate") return "grab";
  // Corner cursors follow the rotation.
  const a = (norm(t.angle) + (g === 0 || g === 2 ? 45 : 135)) % 180;
  return a < 22.5 || a >= 157.5 ? "ew-resize" : a < 67.5 ? "nwse-resize" : a < 112.5 ? "ns-resize" : "nesw-resize";
};

export interface XfDrag { t0: Xf; grab: XfHit; from: Pt2; t: Xf }
export const beginDrag = (t0: Xf, grab: XfHit, from: Pt2): XfDrag => ({ t0, grab, from, t: t0 });
export function updateDrag(d: XfDrag, to: Pt2, shift: boolean): Xf {
  d.t = dragXf(d.t0, d.grab, d.from, to, shift);
  return d.t;
}
export const changed = (a: Xf, b: Xf) => Math.abs(a.cx - b.cx) > 0.5 || Math.abs(a.cy - b.cy) > 0.5 || Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5 || Math.abs(a.angle - b.angle) > 0.05;

/** Turn by a fixed step (context menu, keyboard). */
export const turned = (t: Xf, by: number): Xf => ({ ...t, angle: norm(t.angle + by) });
