// Comment & markup tools: text selection, highlight/underline/strikeout, notes, text boxes,
// shapes, arrows and freehand ink, plus the Comments panel.
import type { AnnotInfo, AnnotSpec, Pt, RGB } from "../engine/annotations";
import type { DocInfo } from "../engine/core";
import { ask } from "./dialog";

export type Tool = "hand" | "select" | "highlight" | "underline" | "strike" | "squiggly" | "note" | "text" | "rect" | "ellipse" | "arrow" | "ink" | "redact" | "sign";

export interface AnnotateDeps {
  engine: {
    selectText(id: number, page: number, a: Pt, b: Pt, mode?: "chars" | "words" | "lines"): Promise<{ quads: number[][]; text: string }>;
    addAnnotation(id: number, page: number, spec: AnnotSpec, author: string): Promise<number>;
    updateAnnotation(id: number, page: number, key: number, patch: { contents?: string; color?: RGB }): Promise<void>;
    deleteAnnotation(id: number, page: number, key: number): Promise<void>;
    annotationAt(id: number, page: number, p: Pt): Promise<AnnotInfo | null>;
    allAnnotations(id: number): Promise<AnnotInfo[]>;
    exportXfdf(id: number, name: string): Promise<string>;
    commentSummary(id: number): Promise<string>;
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
}

export const TOOLS: { id: Tool; label: string; key: string; title: string }[] = [
  { id: "hand", label: "✋", key: "V", title: "Hand / select comments (V)" },
  { id: "select", label: "I", key: "T", title: "Select text (T)" },
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
  const author = () => localStorage.getItem("quire.author") || "Reviewer";

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
    if (el) {
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
  let drag: null | { el: HTMLElement; index: number; start: Pt; last: Pt; points: Pt[]; busy: boolean; pending: boolean; scroll?: [number, number, number, number] } = null;

  d.pagesEl.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0) return;
    const hit = pageOf(e);
    const doc = d.doc();
    if (!hit || !doc) return;
    const p = pointIn(hit.el, hit.index, e);
    if (tool === "hand") {
      const a = await d.engine.annotationAt(doc.info.id, hit.index, p);
      selectAnnot(a);
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
  const TYPE_LABEL: Record<string, string> = { Text: "Note", FreeText: "Text box", Square: "Rectangle", Circle: "Ellipse", Line: "Arrow", Ink: "Pen", StrikeOut: "Strikeout", Highlight: "Highlight", Underline: "Underline", Squiggly: "Squiggly", Stamp: "Stamp", Redact: "Redaction mark" };
  let refreshTimer = 0;
  function refreshComments() {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(renderComments, 50);
  }
  async function renderComments() {
    const doc = d.doc();
    const el = d.commentsEl;
    el.replaceChildren();
    if (!doc) return;
    let list: AnnotInfo[] = [];
    try {
      list = await d.engine.allAnnotations(doc.info.id);
    } catch {
      /* non-PDF */
    }
    const head = document.createElement("div");
    head.className = "comment-tools";
    head.innerHTML = `<span class="muted">${list.length} comment${list.length === 1 ? "" : "s"}</span><button data-a="summary" title="Copy a text summary of all comments">Copy summary</button><button data-a="xfdf" title="Export comments as XFDF for other PDF apps">Export XFDF</button><button data-a="author" title="Name shown on your comments">Author: ${author().replace(/[<&]/g, "")}</button>`;
    el.append(head);
    head.querySelector<HTMLElement>('[data-a="summary"]')!.onclick = async () => {
      const text = await d.engine.commentSummary(doc.info.id);
      await navigator.clipboard.writeText(text).catch(() => {});
      d.status("Comment summary copied to the clipboard");
    };
    head.querySelector<HTMLElement>('[data-a="xfdf"]')!.onclick = async () => d.saveText(doc.name.replace(/\.pdf$/i, "") + ".xfdf", await d.engine.exportXfdf(doc.info.id, doc.name));
    head.querySelector<HTMLElement>('[data-a="author"]')!.onclick = async () => {
      const r = await ask("Your name on comments", [{ name: "n", label: "Author", value: author() }], "Save");
      if (r?.n) localStorage.setItem("quire.author", r.n);
      renderComments();
    };
    if (!list.length) {
      el.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No comments yet. Pick a tool above the page (H for highlight, N for note)." }));
      return;
    }
    for (const a of list) {
      const c = document.createElement("div");
      c.className = "comment" + (selected?.key === a.key ? " active" : "");
      c.dataset.key = String(a.key);
      c.style.borderLeftColor = a.color.length === 3 ? `rgb(${a.color.map((v) => Math.round(v * 255)).join(",")})` : "var(--border)";
      c.innerHTML = `<div class="meta"><b></b><span class="muted"></span></div><div class="body"></div>`;
      c.querySelector("b")!.textContent = TYPE_LABEL[a.type] ?? a.type;
      c.querySelector(".meta span")!.textContent = `p.${a.page + 1}${a.author ? ` · ${a.author}` : ""}${a.modified ? ` · ${new Date(a.modified).toLocaleDateString()}` : ""}`;
      c.querySelector(".body")!.textContent = a.contents;
      c.onclick = () => {
        d.goToPage(a.page, a.rect[1]);
        setTimeout(() => selectAnnot(a), 50);
      };
      c.ondblclick = () => editSelected();
      el.append(c);
    }
  }

  return { onRedactions: (f: () => void) => (onRedactionsChanged = f), setTool, refreshComments, get tool() { return tool; }, setColor: (c: RGB | null) => (color = c), selectAnnot, deleteSelected, editSelected };
}
