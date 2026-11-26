// Comment & markup tools: text selection, highlight/underline/strikeout, notes, text boxes,
// shapes, arrows and freehand ink, plus the Comments panel.
import type { AnnotInfo, AnnotSpec, AnnotPatch, Pt, RGB } from "../engine/annotations";
import { drawTextHandles, grabText, dragText, typeOnPage, measureBox, type TextGrab } from "./textbox";
import type { DocInfo } from "../engine/core";
import { ask } from "./dialog";
import { getPrefs, hexToRgb } from "./prefs";
import type { Xf } from "../engine/xform";
import { drawHandles, grabAt, cursorFor, beginDrag, updateDrag, changed as xfChanged, turned, ptPerPx, type XfDrag } from "./xfhandles";
import { sizeDialog } from "./xfdialog";
import { isEngTool, type EngTool } from "./engineering";

export type Tool = "hand" | "select" | "highlight" | "underline" | "strike" | "squiggly" | "note" | "text" | "rect" | "ellipse" | "arrow" | "ink" | "redact" | "sign" | "edit" | "link" | EngTool;

export interface AnnotateDeps {
  engine: {
    selectText(id: number, page: number, a: Pt, b: Pt, mode?: "chars" | "words" | "lines"): Promise<{ quads: number[][]; text: string }>;
    addAnnotation(id: number, page: number, spec: AnnotSpec, author: string): Promise<number>;
    transformImageStamp(id: number, page: number, key: number, to: Xf): Promise<void>;
    transformTextBox(id: number, page: number, key: number, to: Xf): Promise<void>;
    updateAnnotation(id: number, page: number, key: number, patch: AnnotPatch): Promise<void>;
    deleteAnnotation(id: number, page: number, key: number): Promise<void>;
    deleteAnnotations(id: number, page: number, keys: number[]): Promise<number>;
    updateAnnotations(id: number, page: number, keys: number[], patch: AnnotPatch): Promise<void>;
    annotationAt(id: number, page: number, p: Pt): Promise<AnnotInfo | null>;
    allAnnotations(id: number): Promise<AnnotInfo[]>;
    exportXfdf(id: number, name: string): Promise<string>;
    commentSummary(id: number): Promise<string>;
    addReply(id: number, page: number, parentKey: number, text: string, author: string, state?: string): Promise<number>;
    mergeComments(id: number, data: Uint8Array): Promise<{ added: number; authors: Record<string, number> }>;
    importXfdf(id: number, xml: string): Promise<{ added: number; skipped: number; authors: Record<string, number> }>;
  };
  doc(): { info: DocInfo; name: string } | null;
  pagesEl: HTMLElement;
  viewer: HTMLElement;
  commentsEl: HTMLElement;
  refreshPage(page: number): void;
  changed(label: string): void;
  goToPage(page: number, y?: number): void;
  status(msg: string): void;
  saveText(name: string, text: string): Promise<void>;
  sign(page: number, at: Pt): Promise<void>;
  /** Let the user choose reviewers' PDFs or XFDF files. */
  pickReviews(): Promise<{ name: string; data: Uint8Array }[]>;
  /** Shared review status bar for a document, if it's in one. */
  reviewBar?(id: number): HTMLElement | null;
  exportList?(): void;
}

export const TOOLS: { id: Tool; label: string; key: string; title: string }[] = [
  { id: "hand", label: "✋", key: "V", title: "Hand / select comments (V)" },
  { id: "select", label: "I", key: "T", title: "Select text (T)" },
  { id: "edit", label: "Edit", key: "E", title: "Edit page text and images (E): click text to change it, click empty space to add text, drag images to move them" },
  { id: "highlight", label: "Highlight", key: "H", title: "Highlight text (H)" },
  { id: "underline", label: "U̲", key: "U", title: "Underline text (U)" },
  { id: "strike", label: "S̶", key: "K", title: "Strike out text (K)" },
  { id: "note", label: "Note", key: "N", title: "Sticky note (N)" },
  { id: "text", label: "Text", key: "X", title: "Text box (X)" },
  { id: "rect", label: "▭", key: "R", title: "Rectangle (R)" },
  { id: "ellipse", label: "◯", key: "O", title: "Ellipse (O)" },
  { id: "arrow", label: "↗", key: "A", title: "Arrow (A)" },
  { id: "ink", label: "Pen", key: "P", title: "Freehand pen (P)" },
  { id: "sign", label: "Sign", key: "G", title: "Place your signature (G). Click on the page where it should go." },
  { id: "redact", label: "Redact", key: "D", title: "Mark text or an area for redaction (D). Nothing is removed until you apply." },
];

const MARKUP: Partial<Record<Tool, "Highlight" | "Underline" | "StrikeOut" | "Squiggly">> = { highlight: "Highlight", underline: "Underline", strike: "StrikeOut", squiggly: "Squiggly" };
const SVGNS = "http://www.w3.org/2000/svg";

export function setupAnnotate(d: AnnotateDeps) {
  let tool: Tool = "hand";
  let color: RGB | null = null; // null = per-tool default
  let selection: { page: number; text: string } | null = null;
  let selected: AnnotInfo | null = null;
  const author = () => localStorage.getItem("hdfstudio.author") || "Reviewer";

  // ----- helpers -----
  const pageOf = (e: PointerEvent | MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    if (!el || !d.pagesEl.contains(el)) return null;
    return { el, index: Number(el.dataset.page) };
  };
  const pointIn = (el: HTMLElement, index: number, e: { clientX: number; clientY: number }): Pt => {
    const r = el.getBoundingClientRect();
    const [w, h] = d.doc()!.info.pageSizes[index];
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h];
  };
  const overlay = (el: HTMLElement, index: number) => {
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
  const clearOverlays = (cls?: string) => d.pagesEl.querySelectorAll(cls ? `svg.ov .${cls}` : "svg.ov > *").forEach((n) => n.remove());
  const svgEl = (tag: string, attrs: Record<string, string | number>, cls = "preview") => {
    const n = document.createElementNS(SVGNS, tag);
    n.classList.add(...cls.split(" "));
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const drawQuads = (svg: SVGSVGElement, quads: number[][], cls = "preview") => {
    svg.querySelectorAll(`.${cls.split(" ")[0]}`).forEach((n) => n.remove());
    for (const q of quads) svg.append(svgEl("polygon", { points: `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}` }, cls));
  };
  const colorHex = (c: RGB | null) => (c ? "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : "#d62828");

  let onRedactionsChanged: () => void = () => {};
  async function commit(page: number, spec: AnnotSpec, label: string) {
    const doc = d.doc();
    if (!doc) return;
    const group = spec.type === "Ink" ? "ink" : spec.type === "FreeText" ? "text" : spec.type === "Square" || spec.type === "Circle" || spec.type === "Line" ? "shapes" : null;
    if (group) {
      const tp = getPrefs().tools[group];
      const sp = spec as { color?: RGB; width?: number; opacity?: number; fontSize?: number };
      if (!sp.color || group !== "text") sp.color = hexToRgb(tp.color);
      if (spec.type === "FreeText") sp.fontSize ??= tp.fontSize;
      else sp.width ??= tp.width;
      if ((spec.type === "Square" || spec.type === "Circle") && tp.opacity < 1) sp.opacity = tp.opacity;
    }
    if (color && spec.type !== "Redact") (spec as { color?: RGB }).color = color;
    await d.engine.addAnnotation(doc.info.id, page, spec, author());
    d.refreshPage(page);
    d.changed(label);
    refreshComments();
    if (spec.type === "Redact") onRedactionsChanged();
  }

  function setTool(t: Tool) {
    tool = t;
    d.viewer.dataset.tool = t;
    document.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    if (t !== "select") {
      selection = null;
      clearOverlays("preview");
    }
    selectAnnot(null);
  }

  /** Several markups selected together (window selection, Shift+click). */
  let multi: AnnotInfo[] = [];
  function selectAnnot(a: AnnotInfo | null) {
    multi = [];
    selected = a;
    clearOverlays("sel");
    d.commentsEl.querySelectorAll(".comment.active").forEach((n) => n.classList.remove("active"));
    if (!a) return;
    const el = d.pagesEl.children[a.page] as HTMLElement | undefined;
    if (el && a.xf) drawHandles(overlay(el, a.page), a.xf, ppxOf(el, a.page), "sel", a.type === "FreeText");
    else if (el && a.type === "FreeText" && a.box) drawTextHandles(overlay(el, a.page), a.box, a.callout?.[0], ppxOf(el, a.page));
    else if (el) {
      const [x0, y0, x1, y1] = a.rect;
      overlay(el, a.page).append(svgEl("rect", { x: x0 - 2, y: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4 }, "sel"));
    }
    d.commentsEl.querySelector(`.comment[data-key="${a.key}"]`)?.classList.add("active");
  }

  async function editSelected() {
    const doc = d.doc();
    if (!doc || !selected) return;
    if (selected.type === "FreeText" && selected.box && (await editTextInPlace(selected))) return;
    const r = await ask(`Edit ${selected.type === "Text" ? "note" : "comment"}`, [{ name: "c", label: "Comment", value: selected.contents }], "Save");
    if (!r) return;
    await d.engine.updateAnnotation(doc.info.id, selected.page, selected.key, { contents: r.c });
    d.refreshPage(selected.page);
    d.changed("Edited comment");
    refreshComments();
  }

  async function deleteSelected() {
    const doc = d.doc();
    if (!doc || !selected) return false;
    const a = selected;
    await d.engine.deleteAnnotation(doc.info.id, a.page, a.key);
    selectAnnot(null);
    d.refreshPage(a.page);
    d.changed("Deleted comment");
    refreshComments();
    if (a.type === "Redact") onRedactionsChanged();
    return true;
  }

  // ----- pointer interaction -----
  let xdrag: null | { el: HTMLElement; index: number; a: AnnotInfo; x: XfDrag } = null;
  /** Dragging a text box / callout: its box, its arrow tip, or its corner. */
  let tdrag: null | { el: HTMLElement; index: number; a: AnnotInfo; g: TextGrab; from: Pt; box: number[]; tip?: Pt } = null;
  const ppxOf = (el: HTMLElement, index: number) => ptPerPx(el, d.doc()!.info.pageSizes[index][0]);
  let drag: null | { el: HTMLElement; index: number; start: Pt; last: Pt; points: Pt[]; busy: boolean; pending: boolean; scroll?: [number, number, number, number] } = null;

  // ----- several markups at once: window / crossing selection, Shift or Ctrl+click -----
  let wdrag: null | { el: HTMLElement; index: number; start: Pt; last: Pt } = null;
  let spaceDown = false;
  document.addEventListener("keydown", (e) => { if (e.code === "Space" && !(e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) spaceDown = true; });
  document.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });
  function showMulti() {
    clearOverlays("sel");
    for (const a of multi) {
      const el = d.pagesEl.children[a.page] as HTMLElement | undefined;
      if (!el) continue;
      const [x0, y0, x1, y1] = a.rect;
      overlay(el, a.page).append(svgEl("rect", { x: x0 - 2, y: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4 }, "sel"));
    }
  }
  function setMulti(list: AnnotInfo[]) {
    const seen = new Set<number>();
    multi = list.filter((a) => !seen.has(a.key) && (seen.add(a.key), true));
    if (multi.length === 1) {
      const one = multi[0];
      multi = [];
      return selectAnnot(one);
    }
    selected = null;
    showMulti();
    if (multi.length) d.status(`${multi.length} markups selected. Delete removes them; right-click to change them all. Shift+click adds or removes one.`);
  }
  async function markupsOn(page: number) {
    const doc = d.doc()!;
    return (await d.engine.allAnnotations(doc.info.id)).filter((a) => a.page === page && !a.hidden && a.type !== "Popup" && a.type !== "Link" && a.type !== "Widget" && a.inReplyTo === undefined);
  }
  async function deleteMulti() {
    const doc = d.doc();
    if (!doc || !multi.length) return false;
    const byPage = new Map<number, number[]>();
    for (const a of multi) byPage.set(a.page, [...(byPage.get(a.page) ?? []), a.key]);
    let n = 0;
    for (const [page, keys] of byPage) {
      n += await d.engine.deleteAnnotations(doc.info.id, page, keys);
      d.refreshPage(page);
    }
    const redact = multi.some((a) => a.type === "Redact");
    multi = [];
    clearOverlays("sel");
    d.changed(`Deleted ${n} markups`);
    refreshComments();
    if (redact) onRedactionsChanged();
    return true;
  }
  async function patchMulti(patch: AnnotPatch, label: string) {
    const doc = d.doc();
    if (!doc || !multi.length) return;
    const pages = [...new Set(multi.map((a) => a.page))];
    for (const page of pages) {
      await d.engine.updateAnnotations(doc.info.id, page, multi.filter((a) => a.page === page).map((a) => a.key), patch);
      d.refreshPage(page);
    }
    d.changed(label);
    refreshComments();
    const all = await d.engine.allAnnotations(doc.info.id);
    multi = multi.map((a) => all.find((x) => x.key === a.key) ?? a);
    showMulti();
  }
  /** Every markup on the page, for Ctrl+A with the Hand tool. */
  async function selectAllOnPage(page: number) {
    setMulti(await markupsOn(page));
  }

  d.pagesEl.addEventListener("pointerdown", async (e) => {
    // Middle button, or Space held, pans with the Hand tool.
    if (tool === "hand" && (e.button === 1 || (e.button === 0 && spaceDown))) {
      e.preventDefault();
      drag = { el: d.pagesEl, index: 0, start: [0, 0], last: [0, 0], points: [], busy: false, pending: false, scroll: [e.clientX, e.clientY, d.viewer.scrollLeft, d.viewer.scrollTop] };
      d.viewer.classList.add("panning");
      return;
    }
    if (e.button !== 0 || tool === "edit" || tool === "link" || isEngTool(tool)) return; // the Edit tool has its own handlers
    const hit = pageOf(e);
    const doc = d.doc();
    if (!hit || !doc) return;
    const p = pointIn(hit.el, hit.index, e);
    if (tool === "hand") {
      // Handles of a selected signature or picture: move, resize, rotate.
      if (selected?.xf && selected.page === hit.index) {
        const isText = selected.type === "FreeText";
        const g = grabAt(selected.xf, p, ppxOf(hit.el, hit.index), isText);
        if (g !== null) {
          e.preventDefault();
          hit.el.setPointerCapture(e.pointerId);
          xdrag = { el: hit.el, index: hit.index, a: selected, x: beginDrag(selected.xf, g, p, isText) };
          return;
        }
      }
      // Handles of a selected text box or callout: move the box, drag the arrow tip, resize.
      if (selected?.type === "FreeText" && selected.callout && selected.box && selected.page === hit.index) {
        const g = grabText(selected.box, selected.callout?.[0], p, ppxOf(hit.el, hit.index));
        if (g) {
          e.preventDefault();
          hit.el.setPointerCapture(e.pointerId);
          tdrag = { el: hit.el, index: hit.index, a: selected, g, from: p, box: selected.box, tip: selected.callout?.[0] };
          return;
        }
      }
      const a = await d.engine.annotationAt(doc.info.id, hit.index, p);
      // Shift or Ctrl+click adds a markup to (or takes it out of) the selection.
      if (a && (e.shiftKey || e.ctrlKey)) {
        const cur = multi.length ? multi : selected ? [selected] : [];
        setMulti(cur.some((x) => x.key === a.key) ? cur.filter((x) => x.key !== a.key) : [...cur, a]);
        return;
      }
      if (multi.length) (multi = [], clearOverlays("sel"));
      selectAnnot(a);
      if (a?.type === "FreeText" && a.callout && a.box) {
        const g = grabText(a.box, a.callout?.[0], p, ppxOf(hit.el, hit.index)) ?? "move";
        e.preventDefault();
        hit.el.setPointerCapture(e.pointerId);
        tdrag = { el: hit.el, index: hit.index, a, g, from: p, box: a.box, tip: a.callout?.[0] };
        d.status(a.callout ? "Drag the box to move it, the round knob to move the arrow tip, the corner to resize. Double-click to edit the text, right-click for style." : "Drag to move, drag the corner to resize. Double-click to edit the text, right-click for style.");
        return;
      }
      if (a?.xf) {
        e.preventDefault();
        hit.el.setPointerCapture(e.pointerId);
        const isText = a.type === "FreeText";
        xdrag = { el: hit.el, index: hit.index, a, x: beginDrag(a.xf, "move", p, isText) };
        d.status(isText
          ? "Drag to move. Drag a corner or side grip to resize (the text re-wraps), the round knob to turn it (Shift: 15° steps). Double-click to edit the text, right-click for style."
          : "Drag to move, drag a corner to resize (Shift: free), drag the round knob to rotate. Right-click for more.");
        return;
      }
      if (!a) {
        // Drag on empty space: left to right selects markups fully inside the window, right to left anything it crosses.
        e.preventDefault();
        hit.el.setPointerCapture(e.pointerId);
        wdrag = { el: hit.el, index: hit.index, start: p, last: p };
      }
      return;
    }
    e.preventDefault();
    hit.el.setPointerCapture(e.pointerId);
    drag = { el: hit.el, index: hit.index, start: p, last: p, points: [p], busy: false, pending: false };
  });

  d.pagesEl.addEventListener("pointermove", (e) => {
    if (wdrag) {
      wdrag.last = pointIn(wdrag.el, wdrag.index, e);
      const [a, b] = [wdrag.start, wdrag.last];
      const svg = overlay(wdrag.el, wdrag.index);
      svg.querySelectorAll(".window").forEach((n) => n.remove());
      const crossing = b[0] < a[0];
      const ppx = ppxOf(wdrag.el, wdrag.index);
      svg.append(svgEl("rect", { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), fill: crossing ? "rgba(26, 160, 60, .12)" : "rgba(5, 120, 242, .12)", stroke: crossing ? "#1aa03c" : "#0578f2", "stroke-width": 1.2 * ppx, ...(crossing ? { "stroke-dasharray": `${5 * ppx} ${3 * ppx}` } : {}) }, "window"));
      return;
    }
    if (tdrag) {
      const r = dragText(tdrag.g, tdrag.a.box!, tdrag.a.callout?.[0], tdrag.from, pointIn(tdrag.el, tdrag.index, e));
      tdrag.box = r.box;
      tdrag.tip = r.tip;
      const svg = overlay(tdrag.el, tdrag.index);
      drawTextHandles(svg, r.box, r.tip, ppxOf(tdrag.el, tdrag.index));
      if (r.tip) {
        // Show where the leader will go.
        const [bx0, by0, bx1, by1] = r.box;
        const end: Pt = r.tip[0] < bx0 ? [bx0, (by0 + by1) / 2] : r.tip[0] > bx1 ? [bx1, (by0 + by1) / 2] : [(bx0 + bx1) / 2, r.tip[1] < by0 ? by0 : by1];
        svg.querySelector(".sel")?.append(svgEl("line", { x1: r.tip[0], y1: r.tip[1], x2: end[0], y2: end[1], stroke: "#05C7F2", "stroke-width": 1.5 * ppxOf(tdrag.el, tdrag.index), "stroke-dasharray": "3 3" }));
      }
      return;
    }
    if (xdrag) {
      const t = updateDrag(xdrag.x, pointIn(xdrag.el, xdrag.index, e), e.shiftKey);
      drawHandles(overlay(xdrag.el, xdrag.index), t, ppxOf(xdrag.el, xdrag.index), "sel", xdrag.a.type === "FreeText");
      return;
    }
    if (tool === "hand" && selected?.xf) {
      const hit = pageOf(e);
      if (hit && hit.index === selected.page) hit.el.style.cursor = cursorFor(grabAt(selected.xf, pointIn(hit.el, hit.index, e), ppxOf(hit.el, hit.index), selected.type === "FreeText"), selected.xf);
    }
    if (!drag) return;
    if (drag.scroll) {
      const [x, y, sl, st] = drag.scroll;
      d.viewer.scrollLeft = sl - (e.clientX - x);
      d.viewer.scrollTop = st - (e.clientY - y);
      return;
    }
    const p = pointIn(drag.el, drag.index, e);
    drag.last = p;
    const svg = overlay(drag.el, drag.index);
    const [a, b] = [drag.start, p];
    const box = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
    const stroke = { stroke: colorHex(color), "stroke-width": 2, fill: "none" };
    svg.querySelectorAll(".preview").forEach((n) => tool !== "select" && !MARKUP[tool] && n.remove());
    switch (tool) {
      case "rect":
      case "text":
        svg.append(svgEl("rect", { ...box, ...stroke }));
        break;
      case "redact":
        svg.append(svgEl("rect", { ...box, stroke: "#d62828", "stroke-width": 1.5, fill: "rgba(0,0,0,.15)" }));
        break;
      case "ellipse":
        svg.append(svgEl("ellipse", { cx: box.x + box.width / 2, cy: box.y + box.height / 2, rx: box.width / 2, ry: box.height / 2, ...stroke }));
        break;
      case "arrow":
        svg.append(svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...stroke }));
        break;
      case "ink":
        drag.points.push(p);
        svg.append(svgEl("polyline", { points: drag.points.map((q) => q.join(",")).join(" "), ...stroke }));
        break;
      default:
        updateTextSelection();
    }
  });

  // Text selection queries the worker; keep at most one request in flight.
  async function updateTextSelection(mode: "chars" | "words" = "chars") {
    if (!drag) return;
    if (drag.busy) return void (drag.pending = true);
    drag.busy = true;
    const cur = drag;
    const doc = d.doc()!;
    const r = await d.engine.selectText(doc.info.id, cur.index, cur.start, cur.last, mode);
    drawQuads(overlay(cur.el, cur.index), r.quads, MARKUP[tool] ? "preview markup" : "preview");
    selection = { page: cur.index, text: r.text };
    cur.busy = false;
    (cur as typeof cur & { result?: typeof r }).result = r;
    if (cur.pending && drag === cur) {
      cur.pending = false;
      updateTextSelection(mode);
    }
  }

  d.pagesEl.addEventListener("pointerup", async (e) => {
    const wd = wdrag;
    wdrag = null;
    if (wd) {
      overlay(wd.el, wd.index).querySelectorAll(".window").forEach((n) => n.remove());
      const [a, b] = [wd.start, wd.last];
      const ppx = ppxOf(wd.el, wd.index);
      if (Math.abs(a[0] - b[0]) < 4 * ppx && Math.abs(a[1] - b[1]) < 4 * ppx) {
        if (!e.shiftKey && !e.ctrlKey) setMulti([]), selectAnnot(null);
        return;
      }
      const w = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const crossing = b[0] < a[0];
      const hits = (await markupsOn(wd.index)).filter((m) => {
        const [x0, y0, x1, y1] = m.rect;
        return crossing ? x0 <= w[2] && x1 >= w[0] && y0 <= w[3] && y1 >= w[1] : x0 >= w[0] && x1 <= w[2] && y0 >= w[1] && y1 <= w[3];
      });
      const keep = e.shiftKey || e.ctrlKey ? (multi.length ? multi : selected ? [selected] : []) : [];
      setMulti([...keep, ...hits]);
      if (!hits.length && !keep.length) d.status(crossing ? "Nothing crossed. Drag right to left to pick anything the box touches." : "Nothing fully inside. Drag left to right to pick markups inside the box, right to left for anything it touches.");
      return;
    }
    const td = tdrag;
    tdrag = null;
    if (td) {
      const moved = td.box.some((v, i) => Math.abs(v - td.a.box![i]) > 0.5) || (td.tip && td.a.callout && Math.hypot(td.tip[0] - td.a.callout[0][0], td.tip[1] - td.a.callout[0][1]) > 0.5);
      if (!moved) return selectAnnot(td.a);
      await patchSelected(td.a, { box: td.box, ...(td.tip && td.g === "tip" ? { target: td.tip } : {}) }, td.g === "tip" ? "Moved arrow" : td.g === "resize" ? "Resized text box" : "Moved text box");
      return;
    }
    const xd = xdrag;
    xdrag = null;
    if (!xd) return;
    if (!xfChanged(xd.x.t0, xd.x.t)) return selectAnnot(xd.a);
    const label = xd.x.grab === "move" ? "Moved" : xd.x.grab === "rotate" ? "Rotated" : "Resized";
    await transformStamp(xd.a, xd.x.t, label);
  });

  async function patchSelected(a: AnnotInfo, patch: AnnotPatch, label: string) {
    const doc = d.doc();
    if (!doc) return;
    await d.engine.updateAnnotation(doc.info.id, a.page, a.key, patch);
    d.refreshPage(a.page);
    d.changed(label);
    refreshComments();
    const again = (await d.engine.allAnnotations(doc.info.id)).find((x) => x.key === a.key);
    selectAnnot(again ?? null);
  }
  /** Edit a text box's words right on the page; the box grows or shrinks to fit. */
  async function editTextInPlace(a: AnnotInfo) {
    const el = d.pagesEl.children[a.page] as HTMLElement | undefined;
    if (!el || !a.box) return false;
    const size = a.fontSize ?? 12;
    const hex = (c?: number[] | null) => (c && c.length >= 3 ? "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : null);
    clearOverlays("sel");
    const text = await typeOnPage(el, { x: a.box[0], y: a.box[1], w: a.box[2] - a.box[0] }, ppxOf(el, a.page), { size, color: hex(a.textColor) ?? "#000", fill: hex(a.fill), initial: a.contents });
    if (text === null || text === a.contents) return void selectAnnot(a), true;
    const m = measureBox(text, size);
    const box = [a.box[0], a.box[1], a.box[0] + Math.max(m.w, a.box[2] - a.box[0]), a.box[1] + Math.max(m.h, a.box[3] - a.box[1])];
    await patchSelected(a, { contents: text, box }, "Edited text");
    return true;
  }

  async function transformStamp(a: AnnotInfo, t: Xf, label: string) {
    const doc = d.doc();
    if (!doc) return;
    if (a.type === "FreeText") await d.engine.transformTextBox(doc.info.id, a.page, a.key, t);
    else await d.engine.transformImageStamp(doc.info.id, a.page, a.key, t);
    d.refreshPage(a.page);
    d.changed(`${label} ${a.type === "FreeText" ? "text box" : a.contents?.startsWith("Signed") ? "signature" : "image"}`);
    const again = (await d.engine.allAnnotations(doc.info.id)).find((x) => x.key === a.key);
    selectAnnot(again ?? null);
  }
  async function rotateSelectedStamp(by: number) {
    if (selected?.xf) await transformStamp(selected, turned(selected.xf, by), "Rotated");
  }
  async function sizeSelectedStamp() {
    if (!selected?.xf) return;
    const t = await sizeDialog(selected.xf);
    if (t) await transformStamp(selected, t, "Resized");
  }

  d.pagesEl.addEventListener("pointerup", async (e) => {
    const cur = drag;
    drag = null;
    d.viewer.classList.remove("panning");
    if (!cur || cur.scroll) return;
    const doc = d.doc();
    if (!doc) return;
    const [a, b] = [cur.start, cur.last];
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const small = rect[2] - rect[0] < 4 && rect[3] - rect[1] < 4;
    const clear = () => overlay(cur.el, cur.index).querySelectorAll(".preview").forEach((n) => n.remove());
    if (tool === "redact") {
      while (cur.busy) await new Promise((r) => setTimeout(r, 10));
      // Whole words only, so a partial drag never leaves fragments of sensitive text behind.
      const r = small ? { quads: [] as number[][] } : await d.engine.selectText(doc.info.id, cur.index, a, b, "words");
      clear();
      // Text under the drag → mark those words; otherwise mark the dragged area (images, drawings).
      const textMode = !(e as PointerEvent).altKey && r.quads.length > 0;
      if (textMode) await commit(cur.index, { type: "Redact", quads: r.quads }, "Marked for redaction");
      else if (!small) await commit(cur.index, { type: "Redact", rect }, "Marked area for redaction");
      return;
    }
    if (tool === "select" || MARKUP[tool]) {
      // wait for the last selection query to land
      while (cur.busy) await new Promise((r) => setTimeout(r, 10));
      const r = await d.engine.selectText(doc.info.id, cur.index, a, b, small ? "words" : "chars");
      if (tool === "select") {
        drawQuads(overlay(cur.el, cur.index), r.quads);
        selection = { page: cur.index, text: r.text };
        if (r.text.trim()) d.status(`Selected ${r.text.trim().length} characters. Ctrl+C to copy, or press H/U/K to mark up.`);
        return;
      }
      clear();
      if (r.quads.length) await commit(cur.index, { type: MARKUP[tool]!, quads: r.quads }, `Added ${tool}`);
      return;
    }
    clear();
    switch (tool) {
      case "sign":
        await d.sign(cur.index, b);
        refreshComments();
        break;
      case "note": {
        // Dialogs open on pointer-up so the click that placed the note can't dismiss them.
        const r = await ask("Add a note", [{ name: "c", label: "Note", placeholder: "Type your comment" }], "Add note");
        if (r) await commit(cur.index, { type: "Text", at: [b[0] - 10, b[1] - 10], contents: r.c }, "Added note");
        break;
      }
      case "rect":
      case "ellipse":
        if (!small) await commit(cur.index, { type: tool === "rect" ? "Square" : "Circle", rect }, `Added ${tool === "rect" ? "rectangle" : "ellipse"}`);
        break;
      case "arrow":
        if (!small) await commit(cur.index, { type: "Line", a, b, arrow: true }, "Added arrow");
        break;
      case "ink":
        if (cur.points.length > 1) await commit(cur.index, { type: "Ink", strokes: [cur.points] }, "Added ink");
        break;
      case "text": {
        // Type right where you clicked (or inside the box you dragged).
        const tp = getPrefs().tools.text;
        const size = tp.fontSize;
        const fill = tp.fill && tp.fill !== "none" ? tp.fill : null;
        const colour: RGB = color ?? hexToRgb(tp.color);
        const hexc = "#" + colour.map((v: number) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
        d.status("Type the text. Ctrl+Enter or click elsewhere to finish, Esc to cancel.");
        const text = await typeOnPage(cur.el, { x: a[0], y: a[1], w: small ? 160 : rect[2] - rect[0] }, ppxOf(cur.el, cur.index), { size, color: hexc, fill });
        if (text) {
          const m = measureBox(text, size, small ? 240 : Math.max(60, rect[2] - rect[0]));
          const box = small ? [a[0], a[1], a[0] + m.w, a[1] + m.h] : [rect[0], rect[1], rect[2], Math.max(rect[3], rect[1] + m.h)];
          await commit(cur.index, { type: "FreeText", rect: box, contents: text, fontSize: size, fill: fill ? hexToRgb(fill) : null, width: tp.width, align: tp.align }, "Added text box");
        }
        break;
      }
    }
  });

  d.pagesEl.addEventListener("dblclick", async (e) => {
    if (tool === "edit") return;
    if (tool === "hand" && selected) return editSelected();
    if (tool !== "select") return;
    const hit = pageOf(e);
    const doc = d.doc();
    if (!hit || !doc) return;
    const p = pointIn(hit.el, hit.index, e);
    const r = await d.engine.selectText(doc.info.id, hit.index, p, p, "words");
    drawQuads(overlay(hit.el, hit.index), r.quads);
    selection = { page: hit.index, text: r.text };
  });

  document.addEventListener("copy", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (!selection?.text) return;
    e.clipboardData?.setData("text/plain", selection.text);
    e.preventDefault();
    d.status("Copied");
  });

  document.addEventListener("keydown", async (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if ((e.key === "Delete" || e.key === "Backspace") && multi.length && !(e.target as HTMLElement).closest("#side-thumbs")) {
      e.preventDefault();
      await deleteMulti();
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey) && tool === "hand" && d.doc() && !(e.target as HTMLElement).closest("#side-thumbs")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // The page in the middle of the view.
      const mid = d.viewer.getBoundingClientRect().top + d.viewer.clientHeight / 2;
      const els = [...d.pagesEl.children] as HTMLElement[];
      const i = Math.max(0, els.findIndex((el) => el.getBoundingClientRect().bottom >= mid));
      await selectAllOnPage(Number(els[i]?.dataset.page ?? 0));
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !(e.target as HTMLElement).closest("#side-thumbs")) {
      e.preventDefault();
      await deleteSelected();
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      await editSelected();
    } else if (e.key === "Escape") (multi.length && setMulti([])), setTool("hand");
  });

  // ----- Comments panel -----
  const TYPE_LABEL: Record<string, string> = { Text: "Note", FreeText: "Text box", Square: "Rectangle", Circle: "Ellipse", Line: "Arrow", Ink: "Pen", StrikeOut: "Strikeout", Highlight: "Highlight", Underline: "Underline", Squiggly: "Squiggly", Stamp: "Stamp", Redact: "Redaction mark", Polygon: "Polygon", PolyLine: "Polyline" };
  let refreshTimer = 0;
  function refreshComments() {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(renderComments, 50);
  }
  // Filters survive re-renders; reset when the document changes.
  let filterFor = -1;
  let fStatus = "all";
  let fAuthor = "all";
  // Same values as REVIEW_STATES in the engine (kept here so the UI bundle doesn't pull in mupdf).
  const REVIEW = ["Accepted", "Rejected", "Cancelled", "Completed", "None"];
  const STATUS_LABEL: Record<string, string> = { Accepted: "Accepted", Rejected: "Rejected", Cancelled: "Cancelled", Completed: "Completed", None: "Open" };

  async function reply(a: AnnotInfo, state?: string) {
    const doc = d.doc();
    if (!doc) return;
    let text = "";
    if (!state) {
      const r = await ask(`Reply to ${a.author || "comment"}`, [{ name: "t", label: "Reply", placeholder: "Write a reply" }], "Reply");
      if (!r?.t?.trim()) return;
      text = r.t.trim();
    } else text = `${author()} set status to ${STATUS_LABEL[state] ?? state}`;
    await d.engine.addReply(doc.info.id, a.page, a.key, text, author(), state);
    d.changed(state ? `Status set to ${STATUS_LABEL[state]}` : "Reply added");
    renderComments();
  }

  async function setStatus(a: AnnotInfo) {
    const r = await ask("Set review status", [{ name: "s", label: "Status", type: "select", value: "Accepted", options: REVIEW.map((v) => [v, STATUS_LABEL[v]]) }], "Set status");
    if (r?.s) await reply(a, r.s);
  }

  /** Bring in comments from reviewers' copies (PDF) or comment files (XFDF). */
  async function mergeReviews() {
    const doc = d.doc();
    if (!doc) return d.status("Open the PDF you sent for review first");
    const files = await d.pickReviews();
    if (!files.length) return;
    let added = 0;
    const authors: Record<string, number> = {};
    const failed: string[] = [];
    for (const f of files) {
      try {
        const isXml = /\.xfdf$/i.test(f.name) || new TextDecoder().decode(f.data.slice(0, 200)).includes("<xfdf");
        const r = isXml ? await d.engine.importXfdf(doc.info.id, new TextDecoder().decode(f.data)) : await d.engine.mergeComments(doc.info.id, f.data);
        added += r.added;
        for (const [k, v] of Object.entries(r.authors)) authors[k] = (authors[k] ?? 0) + v;
      } catch (e) {
        failed.push(`${f.name} (${(e as Error).message})`);
      }
    }
    for (let i = 0; i < doc.info.pageSizes.length; i++) d.refreshPage(i);
    const who = Object.entries(authors).map(([k, v]) => `${k} ${v}`).join(", ");
    if (added) d.changed(`Merged ${added} comment${added === 1 ? "" : "s"}${who ? ` (${who})` : ""}`);
    d.status(
      (added ? `Merged ${added} new comment${added === 1 ? "" : "s"}${who ? ` from ${who}` : ""}.` : "No new comments found; everything is already here.") +
        (failed.length ? ` Couldn't read: ${failed.join("; ")}` : "") + (added ? " Ctrl+Z to undo." : ""),
    );
    renderComments();
  }

  async function renderComments() {
    const doc = d.doc();
    const el = d.commentsEl;
    el.replaceChildren();
    if (!doc) return;
    if (filterFor !== doc.info.id) {
      filterFor = doc.info.id;
      fStatus = fAuthor = "all";
    }
    let list: AnnotInfo[] = [];
    try {
      list = (await d.engine.allAnnotations(doc.info.id)).filter((a) => !a.groupOf);
    } catch {
      /* non-PDF */
    }
    // Build threads: top-level comments, their replies, and the latest review status.
    const byKey = new Map(list.map((a) => [a.key, a]));
    const rootOf = (a: AnnotInfo) => {
      let r = a;
      for (let i = 0; i < 50 && r.inReplyTo && byKey.has(r.inReplyTo); i++) r = byKey.get(r.inReplyTo)!;
      return r;
    };
    const tops = list.filter((a) => !a.inReplyTo || !byKey.has(a.inReplyTo));
    const replies = new Map<number, AnnotInfo[]>();
    for (const a of list) if (a.inReplyTo && byKey.has(a.inReplyTo)) {
      const r = rootOf(a).key;
      replies.set(r, [...(replies.get(r) ?? []), a]);
    }
    const when = (a: AnnotInfo) => (a.modified ? Date.parse(a.modified) : 0);
    for (const v of replies.values()) v.sort((x, y) => when(x) - when(y) || x.key - y.key);
    const statusOf = (a: AnnotInfo) => {
      const s = (replies.get(a.key) ?? []).filter((r) => r.state).at(-1)?.state;
      return s && s !== "None" ? s : "Open";
    };
    const people = [...new Set(list.map((a) => a.author).filter(Boolean))].sort();

    const rb = d.reviewBar?.(doc.info.id);
    if (rb) el.append(rb);
    const head = document.createElement("div");
    head.className = "comment-tools";
    head.innerHTML = `<button data-a="merge" class="primary" title="Bring in comments from reviewers' copies of this PDF, or from XFDF comment files. Comments already here are skipped.">Merge reviews…</button><button data-a="summary" title="Copy a text summary of all comments">Copy summary</button><button data-a="list" title="Save every markup with its measurement, status and totals to Excel or CSV">Export list…</button><button data-a="xfdf" title="Export comments as XFDF for other PDF apps">Export XFDF</button><button data-a="author" title="Name shown on your comments">Author: ${author().replace(/[<&]/g, "")}</button>`;
    el.append(head);
    head.querySelector<HTMLElement>('[data-a="merge"]')!.onclick = () => mergeReviews();
    head.querySelector<HTMLElement>('[data-a="summary"]')!.onclick = async () => {
      const text = await d.engine.commentSummary(doc.info.id);
      await navigator.clipboard.writeText(text).catch(() => {});
      d.status("Comment summary copied to the clipboard");
    };
    head.querySelector<HTMLElement>('[data-a="list"]')!.onclick = () => d.exportList?.();
    head.querySelector<HTMLElement>('[data-a="xfdf"]')!.onclick = async () => d.saveText(doc.name.replace(/\.pdf$/i, "") + ".xfdf", await d.engine.exportXfdf(doc.info.id, doc.name));
    head.querySelector<HTMLElement>('[data-a="author"]')!.onclick = async () => {
      const r = await ask("Your name on comments", [{ name: "n", label: "Author", value: author() }], "Save");
      if (r?.n) localStorage.setItem("hdfstudio.author", r.n);
      renderComments();
    };
    if (!tops.length) {
      el.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No comments yet. Pick a tool above the page (H for highlight, N for note), or merge reviewers' copies." }));
      return;
    }

    // Filters
    const filters = document.createElement("div");
    filters.className = "comment-filters";
    const mkSelect = (label: string, value: string, opts: [string, string][], set: (v: string) => void) => {
      const s = document.createElement("select");
      s.title = label;
      s.setAttribute("aria-label", label);
      for (const [v, t] of opts) s.append(new Option(t, v, false, v === value));
      s.onchange = () => (set(s.value), renderComments());
      return s;
    };
    const counts: Record<string, number> = {};
    for (const t of tops) counts[statusOf(t)] = (counts[statusOf(t)] ?? 0) + 1;
    filters.append(
      mkSelect("Filter by status", fStatus, [["all", `All statuses (${tops.length})`], ...["Open", ...REVIEW.filter((r) => r !== "None")].filter((s) => counts[s]).map((s): [string, string] => [s, `${STATUS_LABEL[s] ?? s} (${counts[s]})`])], (v) => (fStatus = v)),
      mkSelect("Filter by author", fAuthor, [["all", "All reviewers"], ...people.map((p): [string, string] => [p, p])], (v) => (fAuthor = v)),
    );
    el.append(filters);

    const shown = tops.filter((t) => (fStatus === "all" || statusOf(t) === fStatus) && (fAuthor === "all" || t.author === fAuthor || (replies.get(t.key) ?? []).some((r) => r.author === fAuthor)));
    const count = Object.assign(document.createElement("div"), { className: "muted comment-count", textContent: shown.length === tops.length ? `${tops.length} comment${tops.length === 1 ? "" : "s"}` : `${shown.length} of ${tops.length} comments` });
    el.append(count);

    for (const a of shown) {
      const c = document.createElement("div");
      const st = statusOf(a);
      c.className = "comment" + (selected?.key === a.key ? " active" : "");
      c.dataset.key = String(a.key);
      c.style.borderLeftColor = a.color.length === 3 ? `rgb(${a.color.map((v) => Math.round(v * 255)).join(",")})` : "var(--border)";
      c.innerHTML = `<div class="meta"><b></b><span class="muted when"></span></div><div class="body"></div>`;
      c.querySelector("b")!.textContent = TYPE_LABEL[a.type] ?? a.type;
      if (st !== "Open") {
        const badge = Object.assign(document.createElement("span"), { className: `status-badge s-${st.toLowerCase()}`, textContent: STATUS_LABEL[st] ?? st });
        c.querySelector("b")!.after(badge);
      }
      c.querySelector(".meta .when")!.textContent = `p.${a.page + 1}${a.author ? ` · ${a.author}` : ""}${a.modified ? ` · ${new Date(a.modified).toLocaleDateString()}` : ""}`;
      c.querySelector(".body")!.textContent = a.contents;
      const rs = replies.get(a.key) ?? [];
      if (rs.length) {
        const box = document.createElement("div");
        box.className = "replies";
        for (const r of rs) {
          const row = document.createElement("div");
          row.className = "reply" + (r.state ? " state" : "");
          row.innerHTML = `<span class="who"></span> <span class="text"></span>`;
          row.querySelector(".who")!.textContent = r.author || "Reviewer";
          row.querySelector(".text")!.textContent = r.state ? `set status to ${STATUS_LABEL[r.state] ?? r.state}` : r.contents;
          row.title = r.modified ? new Date(r.modified).toLocaleString() : "";
          box.append(row);
        }
        c.append(box);
      }
      const actions = document.createElement("div");
      actions.className = "comment-actions";
      actions.innerHTML = `<button data-a="reply">Reply</button><button data-a="status">Status…</button>`;
      actions.querySelector<HTMLElement>('[data-a="reply"]')!.onclick = (e) => (e.stopPropagation(), reply(a));
      actions.querySelector<HTMLElement>('[data-a="status"]')!.onclick = (e) => (e.stopPropagation(), setStatus(a));
      c.append(actions);
      c.onclick = () => {
        d.goToPage(a.page, a.rect[1]);
        setTimeout(() => selectAnnot(a), 50);
      };
      c.ondblclick = () => editSelected();
      el.append(c);
    }
  }

  return { onRedactions: (f: () => void) => (onRedactionsChanged = f), setTool, refreshComments, mergeReviews, get tool() { return tool; }, get selected() { return selected; }, rotateSelectedStamp, sizeSelectedStamp, refreshSelection: () => selectAnnot(selected), get color() { return color; }, setColor: (c: RGB | null) => (color = c), selectAnnot, deleteSelected, editSelected, get multi() { return multi; }, setMulti, deleteMulti, patchMulti };
}
