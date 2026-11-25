// Comment & markup tools: text selection, highlight/underline/strikeout, notes, text boxes,
// shapes, arrows and freehand ink, plus the Comments panel.
import type { AnnotInfo, AnnotSpec, Pt, RGB } from "../engine/annotations";
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
    updateAnnotation(id: number, page: number, key: number, patch: { contents?: string; color?: RGB }): Promise<void>;
    deleteAnnotation(id: number, page: number, key: number): Promise<void>;
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

  function selectAnnot(a: AnnotInfo | null) {
    selected = a;
    clearOverlays("sel");
    d.commentsEl.querySelectorAll(".comment.active").forEach((n) => n.classList.remove("active"));
    if (!a) return;
    const el = d.pagesEl.children[a.page] as HTMLElement | undefined;
    if (el && a.xf) drawHandles(overlay(el, a.page), a.xf, ppxOf(el, a.page), "sel");
    else if (el) {
      const [x0, y0, x1, y1] = a.rect;
      overlay(el, a.page).append(svgEl("rect", { x: x0 - 2, y: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4 }, "sel"));
    }
    d.commentsEl.querySelector(`.comment[data-key="${a.key}"]`)?.classList.add("active");
  }

  async function editSelected() {
    const doc = d.doc();
    if (!doc || !selected) return;
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
  const ppxOf = (el: HTMLElement, index: number) => ptPerPx(el, d.doc()!.info.pageSizes[index][0]);
  let drag: null | { el: HTMLElement; index: number; start: Pt; last: Pt; points: Pt[]; busy: boolean; pending: boolean; scroll?: [number, number, number, number] } = null;

  d.pagesEl.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0 || tool === "edit" || tool === "link" || isEngTool(tool)) return; // the Edit tool has its own handlers
    const hit = pageOf(e);
    const doc = d.doc();
    if (!hit || !doc) return;
    const p = pointIn(hit.el, hit.index, e);
    if (tool === "hand") {
      // Handles of a selected signature or picture: move, resize, rotate.
      if (selected?.xf && selected.page === hit.index) {
        const g = grabAt(selected.xf, p, ppxOf(hit.el, hit.index));
        if (g !== null) {
          e.preventDefault();
          hit.el.setPointerCapture(e.pointerId);
          xdrag = { el: hit.el, index: hit.index, a: selected, x: beginDrag(selected.xf, g, p) };
          return;
        }
      }
      const a = await d.engine.annotationAt(doc.info.id, hit.index, p);
      selectAnnot(a);
      if (a?.xf) {
        e.preventDefault();
        hit.el.setPointerCapture(e.pointerId);
        xdrag = { el: hit.el, index: hit.index, a, x: beginDrag(a.xf, "move", p) };
        d.status("Drag to move, drag a corner to resize (Shift: free), drag the round knob to rotate. Right-click for more.");
        return;
      }
      if (!a) {
        drag = { el: hit.el, index: hit.index, start: p, last: p, points: [], busy: false, pending: false, scroll: [e.clientX, e.clientY, d.viewer.scrollLeft, d.viewer.scrollTop] };
        d.viewer.classList.add("panning");
      }
      return;
    }
    e.preventDefault();
    hit.el.setPointerCapture(e.pointerId);
    drag = { el: hit.el, index: hit.index, start: p, last: p, points: [p], busy: false, pending: false };
  });

  d.pagesEl.addEventListener("pointermove", (e) => {
    if (xdrag) {
      const t = updateDrag(xdrag.x, pointIn(xdrag.el, xdrag.index, e), e.shiftKey);
      drawHandles(overlay(xdrag.el, xdrag.index), t, ppxOf(xdrag.el, xdrag.index), "sel");
      return;
    }
    if (tool === "hand" && selected?.xf) {
      const hit = pageOf(e);
      if (hit && hit.index === selected.page) hit.el.style.cursor = cursorFor(grabAt(selected.xf, pointIn(hit.el, hit.index, e), ppxOf(hit.el, hit.index)), selected.xf);
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

  d.pagesEl.addEventListener("pointerup", async () => {
    const xd = xdrag;
    xdrag = null;
    if (!xd) return;
    if (!xfChanged(xd.x.t0, xd.x.t)) return selectAnnot(xd.a);
    const label = xd.x.grab === "move" ? "Moved" : xd.x.grab === "rotate" ? "Rotated" : "Resized";
    await transformStamp(xd.a, xd.x.t, label);
  });

  async function transformStamp(a: AnnotInfo, t: Xf, label: string) {
    const doc = d.doc();
    if (!doc) return;
    await d.engine.transformImageStamp(doc.info.id, a.page, a.key, t);
    d.refreshPage(a.page);
    d.changed(`${label} ${a.contents?.startsWith("Signed") ? "signature" : "image"}`);
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
        const r = await ask("Add a text box", [{ name: "c", label: "Text" }], "Add");
        if (r?.c) {
          const box = small ? [a[0], a[1], a[0] + Math.max(120, r.c.length * 7), a[1] + 24] : rect;
          await commit(cur.index, { type: "FreeText", rect: box, contents: r.c }, "Added text box");
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
    if ((e.key === "Delete" || e.key === "Backspace") && selected && !(e.target as HTMLElement).closest("#side-thumbs")) {
      e.preventDefault();
      await deleteSelected();
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      await editSelected();
    } else if (e.key === "Escape") setTool("hand");
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

  return { onRedactions: (f: () => void) => (onRedactionsChanged = f), setTool, refreshComments, mergeReviews, get tool() { return tool; }, get selected() { return selected; }, rotateSelectedStamp, sizeSelectedStamp, refreshSelection: () => selectAnnot(selected), get color() { return color; }, setColor: (c: RGB | null) => (color = c), selectAnnot, deleteSelected, editSelected };
}
