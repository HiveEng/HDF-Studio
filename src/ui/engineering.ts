// Engineering markups and measurement: revision clouds, callouts, polylines, polygons, dimension
// lines, review stamps, and calibrated length / area / perimeter / angle / count on drawings.
import { SnapIndex, type SnapHit, type SnapKind } from "../engine/snapindex";
import type { AnnotSpec, AnnotInfo, Pt, RGB } from "../engine/annotations";
import { calloutGeometry } from "../engine/callout";
import { measureBox, typeOnPage, calloutBoxAt } from "./textbox";
import type { DocInfo } from "../engine/core";
import {
  type Scale, type Unit, UNITS, PRESET_SCALES, scaleFromRatio, scaleFromCalibration, parseLength, lengthText, areaText,
  dist, leaderStart, pathLength, polygonArea, centroid, angleAt, measureDict,
} from "../engine/measure";
import { ask } from "./dialog";
import { getPrefs, hexToRgb, formatDate, REVIEW_STAMPS, type ToolGroup } from "./prefs";

export const ENG_TOOLS = ["leader", "cloud", "cloudpoly", "callout", "polyline", "polygon", "dimension", "stamp", "m-length", "m-polylength", "m-area", "m-perimeter", "m-angle", "m-count", "m-calibrate"] as const;
export type EngTool = (typeof ENG_TOOLS)[number];
export const isEngTool = (t: string): t is EngTool => (ENG_TOOLS as readonly string[]).includes(t);

const TOOL_INFO: Record<EngTool, { label: string; group: ToolGroup; how: string }> = {
  leader: { label: "Leader", group: "callout", how: "Click a text box or callout, then click each point it should point to (several clicks make a multileader)." },
  cloud: { label: "Revision cloud", group: "cloud", how: "Drag a box around the change." },
  cloudpoly: { label: "Revision cloud (shape)", group: "cloud", how: "Click each corner; double-click or Enter to finish." },
  callout: { label: "Callout", group: "callout", how: "Click the point the arrow should touch, then click where the text goes, and type." },
  polyline: { label: "Polyline", group: "lines", how: "Click each point; double-click or Enter to finish." },
  polygon: { label: "Polygon", group: "lines", how: "Click each corner; double-click or Enter to finish." },
  dimension: { label: "Dimension", group: "dimension", how: "Click (or drag) from one end to the other. Hold Shift for straight lines." },
  stamp: { label: "Stamp", group: "shapes", how: "Click where the stamp goes." },
  "m-length": { label: "Length", group: "measure", how: "Click (or drag) from one end to the other. Hold Shift for straight lines." },
  "m-polylength": { label: "Polylength", group: "measure", how: "Click each point; double-click or Enter to finish." },
  "m-area": { label: "Area", group: "measure", how: "Click each corner; double-click or Enter to finish." },
  "m-perimeter": { label: "Perimeter", group: "measure", how: "Click each corner; double-click or Enter to finish." },
  "m-angle": { label: "Angle", group: "measure", how: "Click a point on the first leg, the corner, then a point on the second leg." },
  "m-count": { label: "Count", group: "count", how: "Click each item to count it." },
  "m-calibrate": { label: "Calibrate", group: "measure", how: "Click both ends of a dimension you know, then type its real length." },
};
const TWO_POINT = new Set<EngTool>(["cloud", "callout", "dimension", "m-length", "m-calibrate"]);
const MULTI = new Set<EngTool>(["cloudpoly", "polyline", "polygon", "m-polylength", "m-area", "m-perimeter"]);
const CLOSED = new Set<EngTool>(["cloudpoly", "polygon", "m-area", "m-perimeter"]);
const NEEDS_SCALE = new Set<EngTool>(["m-length", "m-polylength", "m-area", "m-perimeter"]);
/** Tools whose points snap to the drawing's line work. */
const SNAPS = new Set<EngTool>(["m-length", "m-polylength", "m-area", "m-perimeter", "m-angle", "m-calibrate", "m-count", "dimension", "polyline", "polygon", "cloudpoly"]);
const SNAP_PX = 10;
const SNAP_LABEL: Record<SnapKind, string> = { end: "Endpoint", intersection: "Intersection", mid: "Midpoint", line: "On line" };

export interface EngDeps {
  engine: {
    addAnnotation(id: number, page: number, spec: AnnotSpec, author: string): Promise<number>;
    allAnnotations(id: number): Promise<AnnotInfo[]>;
    annotationAt(id: number, page: number, p: Pt): Promise<AnnotInfo | null>;
    addLeader(id: number, page: number, parentKey: number, target: Pt, author: string): Promise<number>;
    pageScale(id: number, page: number): Promise<Scale | null>;
    setPageScale(id: number, pages: number[], s: Scale | null): Promise<void>;
    vectorSegments(id: number, page: number): Promise<Float32Array>;
  };
  doc(): { info: DocInfo; name: string; page: number } | null;
  pagesEl: HTMLElement;
  viewer: HTMLElement;
  tool(): string;
  /** The comment selected with the Hand tool, if any. */
  selected(): AnnotInfo | null;
  setTool(t: string): void;
  /** The colour picked on the ribbon, if any (overrides the per-tool default). */
  ribbonColor(): RGB | null;
  refreshPage(page: number): void;
  changed(label: string): void;
  refreshComments(): void;
  status(msg: string): void;
}

const SVGNS = "http://www.w3.org/2000/svg";

export function setupEngineering(d: EngDeps) {
  let pts: Pt[] = [];
  let pageEl: HTMLElement | null = null;
  let pageIndex = -1;
  let hover: Pt | null = null;
  let downAt: Pt | null = null;
  let leaderOf: AnnotInfo | null = null;
  let stampChoice: { title: string; color: string } | null = null;
  // ----- snapping -----
  let snapOn = localStorage.getItem("hdfstudio.snap") !== "0";
  let snapHit: SnapHit | null = null;
  const snapIndexes = new Map<string, Promise<SnapIndex | null>>();
  const indexFor = (page: number) => {
    const doc = d.doc()!;
    const k = `${doc.info.id}:${page}`;
    if (!snapIndexes.has(k)) snapIndexes.set(k, d.engine.vectorSegments(doc.info.id, page).then((seg) => (seg.length ? new SnapIndex(seg) : null)).catch(() => null));
    return snapIndexes.get(k)!;
  };
  /** Snap a point to the drawing unless snapping is off, Alt is held or Shift is locking the angle. */
  async function snapped(el: HTMLElement, page: number, p: Pt, e: { altKey: boolean; shiftKey: boolean }): Promise<Pt> {
    snapHit = null;
    if (!snapOn || e.altKey || (e.shiftKey && pts.length) || !SNAPS.has(tool())) return p;
    const idx = await indexFor(page);
    if (!idx) return p;
    const r = SNAP_PX * (d.doc()!.info.pageSizes[page][0] / el.getBoundingClientRect().width);
    snapHit = idx.snap(p[0], p[1], r);
    return snapHit ? snapHit.pt : p;
  }
  function drawSnapMark(el: HTMLElement, page: number) {
    el.querySelectorAll(".snap-mark").forEach((n) => n.remove());
    if (!snapHit) return;
    const svg = svgOf(el, page);
    const k = d.doc()!.info.pageSizes[page][0] / el.getBoundingClientRect().width;
    const [x, y] = snapHit.pt, s = 6 * k;
    const g = document.createElementNS(SVGNS, "g");
    g.classList.add("snap-mark", "eng-preview");
    const shape = snapHit.kind === "end" ? `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}"/>`
      : snapHit.kind === "intersection" ? `<path d="M${x - s} ${y - s}L${x + s} ${y + s}M${x - s} ${y + s}L${x + s} ${y - s}"/>`
      : snapHit.kind === "mid" ? `<path d="M${x} ${y - s}L${x + s} ${y + s * 0.8}L${x - s} ${y + s * 0.8}Z"/>`
      : `<circle cx="${x}" cy="${y}" r="${s * 0.8}"/>`;
    g.innerHTML = shape;
    g.setAttribute("stroke-width", String(1.6 * k));
    const tip = document.createElementNS(SVGNS, "text");
    tip.setAttribute("x", String(x + 9 * k));
    tip.setAttribute("y", String(y + 16 * k));
    tip.setAttribute("font-size", String(10 * k));
    tip.textContent = SNAP_LABEL[snapHit.kind];
    g.append(tip);
    svg.append(g);
  }
  function toggleSnap(on = !snapOn) {
    snapOn = on;
    localStorage.setItem("hdfstudio.snap", on ? "1" : "0");
    document.querySelectorAll('[data-cmd="toggleSnap"]').forEach((b) => b.classList.toggle("active", on));
    d.status(on ? "Snap to drawing is on (hold Alt to place a point freely)." : "Snap to drawing is off.");
  }
  const scales = new Map<string, Scale | null>();
  const author = () => getPrefs().name || "Reviewer";
  const tool = () => d.tool() as EngTool;
  const active = () => isEngTool(d.tool());

  const pageOf = (e: { target: EventTarget | null }) => {
    const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    if (!el || !d.pagesEl.contains(el)) return null;
    return { el, index: Number(el.dataset.page) };
  };
  const pointIn = (el: HTMLElement, index: number, e: { clientX: number; clientY: number }): Pt => {
    const r = el.getBoundingClientRect();
    const [w, h] = d.doc()!.info.pageSizes[index];
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h];
  };
  /** Shift: lock to 0/45/90°. */
  const constrain = (from: Pt, p: Pt, shift: boolean): Pt => {
    if (!shift) return p;
    const dx = p[0] - from[0], dy = p[1] - from[1];
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const r = Math.hypot(dx, dy);
    return [from[0] + r * Math.cos(a), from[1] + r * Math.sin(a)];
  };
  const svgOf = (el: HTMLElement, index: number) => {
    let svg = el.querySelector("svg.ov") as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.classList.add("ov");
      const [w, h] = d.doc()!.info.pageSizes[index];
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("preserveAspectRatio", "none");
      el.append(svg);
    }
    return svg;
  };
  const el = (tag: string, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(SVGNS, tag);
    n.classList.add("eng-preview");
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const clearPreview = () => d.pagesEl.querySelectorAll(".eng-preview").forEach((n) => n.remove());
  /** Like el(), but survives clearPreview (used while typing a callout). */
  const el2 = (tag: string, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(SVGNS, tag);
    n.classList.add("eng-callout");
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const reset = () => {
    pts = [];
    leaderOf = null;
    pageEl = null;
    pageIndex = -1;
    hover = null;
    downAt = null;
    clearPreview();
  };

  const prefsFor = (t: EngTool) => getPrefs().tools[TOOL_INFO[t].group];
  const colorFor = (t: EngTool): RGB => d.ribbonColor() ?? hexToRgb(prefsFor(t).color);
  const hexOf = (c: RGB) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

  async function scaleFor(page: number): Promise<Scale | null> {
    const doc = d.doc()!;
    const k = `${doc.info.id}:${page}`;
    if (!scales.has(k)) scales.set(k, await d.engine.pageScale(doc.info.id, page));
    return scales.get(k) ?? null;
  }
  const forgetScales = () => (scales.clear(), snapIndexes.clear());

  // ----- preview -----
  function drawPreview() {
    if (!pageEl || pageIndex < 0) return;
    clearPreview();
    const svg = svgOf(pageEl, pageIndex);
    const t = tool();
    const c = hexOf(colorFor(t));
    const r = pageEl.getBoundingClientRect();
    const ptPerPx = d.doc()!.info.pageSizes[pageIndex][0] / r.width;
    const stroke = { stroke: c, "stroke-width": Math.max(1, prefsFor(t).width) , fill: "none", "vector-effect": "non-scaling-stroke" };
    const all = hover ? [...pts, hover] : pts;
    if (!all.length) return;
    if (t === "leader") {
      if (leaderOf && hover) {
        const s0 = leaderStart(leaderOf.rect, hover);
        svg.append(el("line", { x1: s0[0], y1: s0[1], x2: hover[0], y2: hover[1], ...stroke, "stroke-dasharray": "4 3" }));
      }
      return;
    }
    if (t === "cloud" && all.length >= 2) {
      const [a, b] = [all[0], all[all.length - 1]];
      svg.append(el("rect", { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), ...stroke, "stroke-dasharray": "6 4" }));
    } else if (t === "callout" && all.length >= 2) {
      svg.append(el("line", { x1: all[0][0], y1: all[0][1], x2: all[1][0], y2: all[1][1], ...stroke }));
      svg.append(el("rect", { x: all[1][0], y: all[1][1] - 10 * ptPerPx, width: 120 * ptPerPx, height: 24 * ptPerPx, ...stroke }));
    } else {
      const closed = CLOSED.has(t) && all.length > 2;
      svg.append(el(closed ? "polygon" : "polyline", { points: all.map((p) => p.join(",")).join(" "), ...stroke, ...(t === "m-area" ? { fill: c, "fill-opacity": 0.15 } : {}) }));
    }
    for (const p of pts) svg.append(el("circle", { cx: p[0], cy: p[1], r: 3 * ptPerPx, fill: c }));
    // Live readout next to the cursor.
    const text = readout(all);
    if (text && hover) {
      const t2 = el("text", { x: hover[0] + 12 * ptPerPx, y: hover[1] - 10 * ptPerPx, "font-size": 13 * ptPerPx, fill: c, "font-family": "system-ui, sans-serif", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 * ptPerPx });
      t2.textContent = text;
      svg.append(t2);
    }
  }
  let currentScale: Scale | null = null;
  function readout(all: Pt[]): string {
    const t = tool();
    if (t === "m-angle" && all.length === 3) return `${angleAt(all[0], all[1], all[2]).toFixed(1)}°`;
    if (!currentScale || !(NEEDS_SCALE.has(t) || t === "dimension")) return t === "m-calibrate" && all.length === 2 ? `${dist(all[0], all[1]).toFixed(1)} pt` : "";
    if (t === "m-area" && all.length > 2) return areaText(polygonArea(all), currentScale);
    if (t === "m-perimeter") return lengthText(pathLength(all, true), currentScale);
    return all.length > 1 ? lengthText(pathLength(all), currentScale) : "";
  }

  // ----- committing -----
  async function commit(spec: AnnotSpec, label: string) {
    const doc = d.doc();
    if (!doc) return;
    await d.engine.addAnnotation(doc.info.id, pageIndex, spec, author());
    d.refreshPage(pageIndex);
    d.changed(label);
    d.refreshComments();
  }
  const dedupe = (p: Pt[]) => p.filter((q, i) => i === 0 || dist(q, p[i - 1]) > 0.5);

  async function finish() {
    const t = tool();
    const doc = d.doc();
    if (!doc || pageIndex < 0) return reset();
    const p = dedupe(pts);
    const color = colorFor(t);
    const pr = prefsFor(t);
    const s = currentScale;
    const page = pageIndex;
    const measure = s ? measureDict(s) : undefined;
    clearPreview();
    try {
      switch (t) {
        case "cloud": {
          if (p.length < 2) break;
          const [a, b] = [p[0], p[p.length - 1]];
          if (Math.abs(a[0] - b[0]) < 4 || Math.abs(a[1] - b[1]) < 4) break;
          await commit({ type: "Square", rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], cloud: true, color, width: pr.width, opacity: pr.opacity }, "Added revision cloud");
          break;
        }
        case "cloudpoly":
        case "polygon":
          if (p.length < 3) break;
          await commit({ type: "Polygon", vertices: p, cloud: t === "cloudpoly", color, width: pr.width, opacity: pr.opacity }, t === "cloudpoly" ? "Added revision cloud" : "Added polygon");
          break;
        case "polyline":
          if (p.length < 2) break;
          await commit({ type: "PolyLine", vertices: p, color, width: pr.width, opacity: pr.opacity }, "Added polyline");
          break;
        case "callout": {
          if (p.length < 2 || dist(p[0], p[p.length - 1]) < 6) break;
          const [target, at] = [p[0], p[p.length - 1]];
          const el = d.pagesEl.children[page] as HTMLElement | undefined;
          if (!el) break;
          const fs = pr.fontSize;
          const fill = pr.fill && pr.fill !== "none" ? pr.fill : null;
          const ppx = d.doc()!.info.pageSizes[page][0] / el.getBoundingClientRect().width;
          const svg = svgOf(el, page);
          // Type in place: the box sits beside the second click, with the leader drawn live to it.
          const first = measureBox(" ", fs);
          let box = calloutBoxAt(target, at, Math.max(first.w, 120), first.h);
          const lead = () => {
            svg.querySelectorAll(".eng-callout").forEach((n) => n.remove());
            const [tip, knee, end] = calloutGeometry(box, target);
            const line = el2("polyline", { points: [tip, knee, end].map((q) => q.join(",")).join(" "), stroke: hexOf(color), "stroke-width": Math.max(1, pr.width), fill: "none", "vector-effect": "non-scaling-stroke" });
            svg.append(line);
          };
          lead();
          d.status("Type the callout text. Ctrl+Enter or click elsewhere to finish, Esc to cancel.");
          const text = await typeOnPage(el, { x: box[0], y: box[1], w: box[2] - box[0] }, ppx, {
            size: fs, color: hexOf(color), fill,
            onResize: (w, h) => {
              box = calloutBoxAt(target, at, w, h);
              const ta = el.querySelector<HTMLElement>(".page-typing");
              if (ta) (ta.style.left = `${box[0] / ppx}px`), (ta.style.top = `${box[1] / ppx}px`);
              lead();
            },
          });
          svg.querySelectorAll(".eng-callout").forEach((n) => n.remove());
          if (!text) {
            d.status("Callout cancelled.");
            break;
          }
          const m = measureBox(text, fs);
          box = calloutBoxAt(target, at, m.w, m.h);
          await commit({ type: "Callout", target, rect: box, contents: text, fontSize: fs, color, fill: fill ? hexToRgb(fill) : null, width: pr.width, arrow: pr.arrow }, "Added callout");
          break;
        }
        case "dimension":
        case "m-length": {
          if (p.length < 2 || dist(p[0], p[p.length - 1]) < 4) break;
          const [a, b] = [p[0], p[p.length - 1]];
          let caption = s ? lengthText(dist(a, b), s) : "";
          if (!caption) {
            const r = await ask("Dimension text", [{ name: "c", label: "Text", placeholder: "e.g. 12'-6\" (set a scale to measure automatically)" }], "Add");
            if (r === null) break;
            caption = r.c;
          }
          await commit({ type: "Line", a, b, dimension: true, caption, captionSize: pr.fontSize, color, width: pr.width, contents: t === "m-length" ? `Length: ${caption}` : caption, measure: t === "m-length" ? measure : undefined }, t === "m-length" ? `Measured ${caption}` : "Added dimension");
          if (t === "m-length") d.status(`Length: ${caption} (scale ${s!.label})`);
          break;
        }
        case "m-polylength": {
          if (p.length < 2 || !s) break;
          const total = lengthText(pathLength(p), s);
          let best = 1;
          for (let i = 1; i < p.length; i++) if (dist(p[i - 1], p[i]) > dist(p[best - 1], p[best])) best = i;
          const mid: Pt = [(p[best - 1][0] + p[best][0]) / 2, (p[best - 1][1] + p[best][1]) / 2];
          await commit({ type: "PolyLine", vertices: p, color, width: pr.width, intent: "PolyLineDimension", measure, contents: `Length: ${total}`, label: { text: total, at: mid, size: pr.fontSize } }, `Measured ${total}`);
          d.status(`Length: ${total} (scale ${s.label})`);
          break;
        }
        case "m-area":
        case "m-perimeter": {
          if (p.length < 3 || !s) break;
          const area = areaText(polygonArea(p), s), per = lengthText(pathLength(p, true), s);
          const text = t === "m-area" ? area : per;
          const tint: RGB = color.map((v) => 1 - (1 - v) * 0.18) as RGB;
          await commit({ type: "Polygon", vertices: p, color, width: pr.width, fill: t === "m-area" ? tint : null, intent: "PolygonDimension", measure, contents: `Area: ${area}; Perimeter: ${per}`, label: { text, at: centroid(p), size: pr.fontSize } }, `Measured ${text}`);
          d.status(`Area: ${area} · Perimeter: ${per} (scale ${s.label})`);
          break;
        }
        case "m-angle": {
          if (p.length < 3) break;
          const deg = `${angleAt(p[0], p[1], p[2]).toFixed(1)}°`;
          const bis: Pt = [(p[0][0] + p[2][0]) / 2 - p[1][0], (p[0][1] + p[2][1]) / 2 - p[1][1]];
          const n = Math.hypot(bis[0], bis[1]) || 1;
          const at: Pt = [p[1][0] + (bis[0] / n) * pr.fontSize * 2.2, p[1][1] + (bis[1] / n) * pr.fontSize * 2.2];
          await commit({ type: "PolyLine", vertices: p.slice(0, 3), color, width: pr.width, contents: `Angle: ${deg}`, label: { text: deg, at, size: pr.fontSize } }, `Measured ${deg}`);
          d.status(`Angle: ${deg}`);
          break;
        }
        case "m-calibrate": {
          if (p.length < 2) break;
          const len = dist(p[0], p[p.length - 1]);
          if (len < 4) break;
          await calibrate(len, page);
          break;
        }
      }
    } finally {
      reset();
    }
  }

  async function addCount(at: Pt) {
    const doc = d.doc()!;
    const all = await d.engine.allAnnotations(doc.info.id);
    const n = all.filter((a) => a.page === pageIndex && /^Count \d+$/.test(a.contents)).length + 1;
    const pr = prefsFor("m-count");
    const r = Math.max(4, pr.fontSize * 0.9);
    await commit({ type: "Circle", rect: [at[0] - r, at[1] - r, at[0] + r, at[1] + r], color: colorFor("m-count"), fill: colorFor("m-count"), width: 0.5, contents: `Count ${n}`, label: { text: String(n), at, size: pr.fontSize, color: [1, 1, 1], bg: false } }, `Count ${n}`);
    d.status(`Count: ${n} on this page`);
  }

  async function addStamp(at: Pt) {
    if (!stampChoice && !(await chooseStamp())) return;
    const pr = getPrefs();
    const st = stampChoice!;
    const date = formatDate(new Date());
    const name = pr.name || "Reviewer";
    // Size to the words, about 1.6 in tall at most.
    const titleW = st.title.length * 13;
    const w = Math.max(150, Math.min(420, titleW + 30));
    const h = pr.company ? 66 : 52;
    await commit({ type: "ReviewStamp", rect: [at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2], title: st.title, name, date, company: pr.company, color: hexToRgb(st.color) }, `Stamped ${st.title}`);
    reset();
  }

  async function chooseStamp(): Promise<boolean> {
    const last = localStorage.getItem("hdfstudio.stamp") ?? "APPROVED AS NOTED";
    const r = await ask("Choose a stamp", [
      { name: "s", label: "Stamp", type: "select", value: REVIEW_STAMPS.some((x) => x.title === last) ? last : "custom", options: [...REVIEW_STAMPS.map((x) => [x.title, x.title] as [string, string]), ["custom", "Custom text…"]] },
      { name: "custom", label: "Custom text (if chosen above)", value: REVIEW_STAMPS.some((x) => x.title === last) ? "" : last },
      { name: "color", label: "Colour for custom text", type: "select", value: "#0b5cad", options: [["#1a7f37", "Green"], ["#0b5cad", "Blue"], ["#c25e00", "Orange"], ["#c41e1e", "Red"], ["#333333", "Black"]] },
    ], "Use stamp");
    if (!r) return false;
    const title = r.s === "custom" ? r.custom.trim().toUpperCase() : r.s;
    if (!title) return false;
    localStorage.setItem("hdfstudio.stamp", title);
    stampChoice = REVIEW_STAMPS.find((x) => x.title === title) ?? { title, color: r.color };
    if (!getPrefs().name) d.status("Tip: set your name and company in Settings so stamps show them.");
    return true;
  }

  // ----- scale -----
  async function calibrate(len: number, page: number) {
    const unit = getPrefs().units;
    const r = await ask("Calibrate scale", [
      { name: "real", label: "Real length of the line you drew", placeholder: unit === "ft-in" ? "e.g. 12'-6\"" : unit === "m" ? "e.g. 3.5 m" : "e.g. 3500", hint: "Units can be typed: 12'-6\", 150\", 3.5 m, 3500 mm." },
      { name: "unit", label: "Show results in", type: "select", value: unit, options: UNITS },
      { name: "pages", label: "Use this scale on", type: "select", value: "page", options: [["page", "This page"], ["all", "All pages"]] },
    ], "Set scale");
    if (!r) return;
    const u = r.unit as Unit;
    const real = parseLength(r.real, u);
    if (!real || real <= 0) return d.status("Couldn't read that length. Try 12'-6\" or 3.5 m.");
    const s = scaleFromCalibration(len, real, u);
    await applyScale(s, r.pages === "all" ? null : [page]);
  }

  async function applyScale(s: Scale | null, pages: number[] | null) {
    const doc = d.doc();
    if (!doc) return;
    const list = pages ?? [...Array(doc.info.pageCount).keys()];
    await d.engine.setPageScale(doc.info.id, list, s);
    forgetScales();
    d.changed(s ? `Scale set to ${s.label}` : "Scale cleared");
    d.status(s ? `Scale ${s.label} on ${pages ? `page ${list.map((p) => p + 1).join(", ")}` : "all pages"}. Measure tools now report real sizes.` : "Scale cleared");
  }

  /** Set scale dialog: a common drawing scale, or calibrate from a known dimension. */
  async function setScale(): Promise<boolean> {
    const doc = d.doc();
    if (!doc) return false;
    const cur = await scaleFor(doc.page);
    const unit = cur?.unit ?? getPrefs().units;
    const r = await ask("Drawing scale", [
      { name: "preset", label: "Scale", type: "select", value: cur && PRESET_SCALES.some(([l]) => l === cur.label) ? cur.label : "calibrate", options: [["calibrate", "Calibrate from a known dimension…"], ...PRESET_SCALES.map(([l]) => [l, l] as [string, string]), ["custom", "Custom: 1 paper inch = …"], ["clear", "No scale (clear)"]], hint: cur ? `Current: ${cur.label}` : "This page has no scale yet. Check the drawing's title block, or calibrate from a dimension you know." },
      { name: "custom", label: "Custom: one paper inch equals", placeholder: "e.g. 15'" },
      { name: "unit", label: "Show results in", type: "select", value: unit, options: UNITS },
      { name: "pages", label: "Use on", type: "select", value: "all", options: [["page", `This page (${doc.page + 1})`], ["all", "All pages"]] },
    ], "OK");
    if (!r) return false;
    const pages = r.pages === "all" ? null : [doc.page];
    if (r.preset === "clear") return applyScale(null, pages).then(() => false);
    if (r.preset === "calibrate") {
      d.setTool("m-calibrate");
      d.status(TOOL_INFO["m-calibrate"].how);
      return false;
    }
    let ratio: number;
    let label = r.preset;
    if (r.preset === "custom") {
      const inches = parseLength(r.custom, "in");
      if (!inches || inches <= 0) return d.status("Couldn't read that length. Try 15' or 5 m."), false;
      ratio = inches;
      label = `1" = ${r.custom.trim()}`;
    } else ratio = PRESET_SCALES.find(([l]) => l === r.preset)![1];
    await applyScale(scaleFromRatio(ratio, r.unit as Unit, label), pages);
    return true;
  }

  // ----- events -----
  d.pagesEl.addEventListener("pointerdown", async (e) => {
    if (!active() || e.button !== 0) return;
    const hit = pageOf(e);
    if (!hit || !d.doc()) return;
    e.preventDefault();
    e.stopPropagation();
    const t = tool();
    if (t === "leader") return void (await leaderClick(hit.el, hit.index, pointIn(hit.el, hit.index, e)));
    if (pageEl && hit.el !== pageEl) reset();
    if (!pageEl) {
      pageEl = hit.el;
      pageIndex = hit.index;
      currentScale = await scaleFor(hit.index);
      if (NEEDS_SCALE.has(t) && !currentScale) {
        reset();
        d.status("Set the drawing scale first (or calibrate from a known dimension).");
        if (await setScale()) d.status(`${TOOL_INFO[t].label}: ${TOOL_INFO[t].how}`);
        return;
      }
    }
    let p = await snapped(hit.el, hit.index, pointIn(hit.el, hit.index, e), e);
    if (pts.length && !snapHit) p = constrain(pts[pts.length - 1], p, e.shiftKey);
    if (t === "m-count") return void (await addCount(p), reset());
    if (t === "stamp") return void (await addStamp(p));
    pts.push(p);
    downAt = p;
    hit.el.setPointerCapture?.(e.pointerId);
    if (TWO_POINT.has(t) && pts.length >= 2) return void finish();
    if (t === "m-angle" && pts.length >= 3) return void finish();
    drawPreview();
  }, true);

  let moveSeq = 0;
  d.pagesEl.addEventListener("pointermove", async (e) => {
    if (!active() || !d.doc()) return;
    const hit = pageEl ? { el: pageEl, index: pageIndex } : pageOf(e);
    if (!hit) return;
    const seq = ++moveSeq;
    const raw = pointIn(hit.el, hit.index, e);
    const p = await snapped(hit.el, hit.index, raw, e);
    if (seq !== moveSeq) return;
    if (pageEl) {
      hover = pts.length && !snapHit ? constrain(pts[pts.length - 1], p, e.shiftKey) : p;
      drawPreview();
    }
    drawSnapMark(hit.el, hit.index);
  }, true);

  d.pagesEl.addEventListener("pointerup", (e) => {
    if (!active() || !pageEl || !downAt) return;
    e.stopPropagation();
    const t = tool();
    // A drag (not a click) completes a two-point tool in one motion.
    if (TWO_POINT.has(t) && pts.length === 1 && hover && dist(downAt, hover) > 6 * (d.doc()!.info.pageSizes[pageIndex][0] / pageEl.getBoundingClientRect().width)) {
      pts.push(hover);
      void finish();
    }
    downAt = null;
  }, true);

  d.pagesEl.addEventListener("dblclick", (e) => {
    if (!active()) return;
    e.stopPropagation();
    if (MULTI.has(tool()) && pts.length) void finish();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!active() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (tool() === "leader" && (e.key === "Escape" || e.key === "Enter") && leaderOf) {
      e.preventDefault();
      e.stopImmediatePropagation();
      reset();
      d.setTool("hand");
      d.status("Done adding leaders");
    } else if (e.key === "Escape" && pts.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      reset();
      d.status("Cancelled");
    } else if (e.key === "Enter" && MULTI.has(tool()) && pts.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void finish();
    } else if (e.key === "Backspace" && pts.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pts.pop();
      if (!pts.length) reset();
      else drawPreview();
    }
  }, true);

  async function leaderClick(el: HTMLElement, index: number, p: Pt) {
    const doc = d.doc()!;
    if (!leaderOf || leaderOf.page !== index) {
      const a = await d.engine.annotationAt(doc.info.id, index, p);
      if (a?.type !== "FreeText") return d.status("Click a text box or callout first, then the points its leaders should point to.");
      leaderOf = a;
      pageEl = el;
      pageIndex = index;
      return d.status("Now click each point to add a leader. Esc or Enter when done.");
    }
    await d.engine.addLeader(doc.info.id, index, leaderOf.key, p, author());
    d.refreshPage(index);
    d.changed("Added leader");
    d.status("Leader added. Click to add another, or Esc / Enter when done.");
  }

  /** Called when a tool button is chosen. */
  async function start(t: EngTool, stamp?: { title: string; color: string }) {
    reset();
    if (t === "leader") {
      const sel = d.selected();
      leaderOf = sel?.type === "FreeText" ? sel : null;
      d.setTool(t);
      if (leaderOf) {
        pageIndex = leaderOf.page;
        pageEl = d.pagesEl.querySelector<HTMLElement>(`.page[data-page="${leaderOf.page}"]`);
        return d.status("Click each point the selected text box should point to. Esc or Enter when done.");
      }
      return d.status(`${TOOL_INFO[t].label}: ${TOOL_INFO[t].how} Esc when done.`);
    }
    if (t === "stamp") {
      if (stamp) stampChoice = { ...stamp };
      else if (!(await chooseStamp())) return;
    }
    d.setTool(t);
    const doc = d.doc();
    let extra = "";
    if (doc && (NEEDS_SCALE.has(t) || t === "dimension")) {
      const s = await scaleFor(doc.page);
      extra = s ? ` Scale: ${s.label}.` : NEEDS_SCALE.has(t) ? " This page has no scale yet; you'll be asked for one." : "";
    }
    d.status(`${TOOL_INFO[t].label}: ${TOOL_INFO[t].how}${extra} Esc to cancel.`);
  }

  return { start, setScale, reset, forgetScales, toggleSnap, get snapOn() { return snapOn; }, TOOL_INFO };
}
