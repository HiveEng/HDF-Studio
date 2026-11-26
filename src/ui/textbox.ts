// Text boxes and callouts on the page: type in place, size the box to the text, and move / resize /
// re-point them with handles. Coordinates are page points (display space); the page element is
// position: relative and its SVG overlay uses the same points.
import type { Pt } from "../engine/annotations";

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number>, cls = "") => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (cls) n.setAttribute("class", cls);
  return n;
};

let ctx: CanvasRenderingContext2D | null = null;
/** Width of text in Helvetica (what the PDF uses), in points. */
export function textWidth(s: string, size: number): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return s.length * size * 0.55;
  ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  return ctx.measureText(s).width;
}

/** Box (w × h, points) that holds the text, wrapping at `maxWidth`. Padding matches mupdf's text box. */
export function measureBox(text: string, size: number, maxWidth = 240): { w: number; h: number } {
  const pad = 6;
  let widest = 0, lines = 0;
  for (const para of text.split("\n")) {
    let line = "";
    const words = para.split(/(\s+)/);
    for (const w of words) {
      const next = line + w;
      if (line && textWidth(next.trimEnd(), size) > maxWidth - pad) {
        widest = Math.max(widest, textWidth(line.trimEnd(), size));
        lines++;
        line = w.trimStart();
      } else line = next;
    }
    widest = Math.max(widest, textWidth(line.trimEnd(), size));
    lines++;
  }
  return { w: Math.max(40, Math.min(maxWidth, widest + pad + 4)), h: lines * size * 1.17 + pad + 2 };
}

/**
 * Type straight onto the page. Resolves with the text (null if cancelled or left empty).
 * Ctrl+Enter or clicking elsewhere finishes; Esc cancels; Enter makes a new line.
 */
export function typeOnPage(pageEl: HTMLElement, at: { x: number; y: number; w: number }, ppx: number, o: { size: number; color: string; fill: string | null; initial?: string; onResize?(w: number, h: number): void }): Promise<string | null> {
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.className = "page-typing";
    ta.value = o.initial ?? "";
    const scale = 1 / ppx;
    Object.assign(ta.style, {
      left: `${at.x * scale}px`,
      top: `${at.y * scale}px`,
      width: `${Math.max(at.w, 60) * scale}px`,
      font: `${o.size * scale}px Helvetica, Arial, sans-serif`,
      color: o.color,
      background: o.fill ?? "rgba(255,255,255,.6)",
      borderColor: o.color,
    });
    const fit = () => {
      const b = measureBox(ta.value || " ", o.size);
      ta.style.width = `${Math.max(b.w, 60) * scale}px`;
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
      o.onResize?.(b.w, b.h);
    };
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      ta.remove();
      document.removeEventListener("pointerdown", outside, true);
      resolve(v && v.trim() ? v.replace(/\s+$/, "") : null);
    };
    const outside = (e: PointerEvent) => {
      if (e.target !== ta) finish(ta.value);
    };
    ta.addEventListener("input", fit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") (e.preventDefault(), finish(null));
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), finish(ta.value));
    });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    pageEl.append(ta);
    fit();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // Let the click that opened the box finish before listening for clicks elsewhere.
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  });
}

/** Where to put a callout's box: beside the second click, on the side away from the arrow tip, centred vertically. */
export function calloutBoxAt(target: Pt, at: Pt, w: number, h: number): number[] {
  const left = at[0] < target[0] ? at[0] - w : at[0];
  return [left, at[1] - h / 2, left + w, at[1] + h / 2];
}

// ---------- Handles for a selected text box or callout ----------

export type TextGrab = "move" | "tip" | "resize";

export function drawTextHandles(svg: SVGSVGElement, box: number[], tip: Pt | undefined, ppx: number, cls = "sel") {
  svg.querySelectorAll(`.${cls}`).forEach((n) => n.remove());
  const g = svgEl("g", {}, cls);
  const stroke = { stroke: "#05C7F2", "stroke-width": 1.5 * ppx, fill: "none" };
  g.append(svgEl("rect", { x: box[0] - 2 * ppx, y: box[1] - 2 * ppx, width: box[2] - box[0] + 4 * ppx, height: box[3] - box[1] + 4 * ppx, ...stroke, "stroke-dasharray": `${4 * ppx} ${3 * ppx}` }));
  g.append(svgEl("rect", { x: box[2] - 4 * ppx, y: box[3] - 4 * ppx, width: 8 * ppx, height: 8 * ppx, fill: "#fff", stroke: "#05C7F2", "stroke-width": 1.5 * ppx }));
  if (tip) g.append(svgEl("circle", { cx: tip[0], cy: tip[1], r: 5 * ppx, fill: "#fff", stroke: "#05C7F2", "stroke-width": 1.5 * ppx }));
  svg.append(g);
}

export function grabText(box: number[], tip: Pt | undefined, p: Pt, ppx: number): TextGrab | null {
  const tol = 7 * ppx;
  if (tip && Math.hypot(p[0] - tip[0], p[1] - tip[1]) <= tol) return "tip";
  if (Math.abs(p[0] - box[2]) <= tol && Math.abs(p[1] - box[3]) <= tol) return "resize";
  if (p[0] >= box[0] - tol && p[0] <= box[2] + tol && p[1] >= box[1] - tol && p[1] <= box[3] + tol) return "move";
  return null;
}

export function dragText(g: TextGrab, box: number[], tip: Pt | undefined, from: Pt, to: Pt): { box: number[]; tip?: Pt } {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (g === "tip") return { box, tip: tip && [tip[0] + dx, tip[1] + dy] };
  if (g === "resize") return { box: [box[0], box[1], Math.max(box[0] + 30, box[2] + dx), Math.max(box[1] + 14, box[3] + dy)], tip };
  return { box: [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy], tip };
}
