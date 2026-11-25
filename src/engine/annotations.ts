// Comments & markup on top of MuPDF annotations. All coordinates are page space in points
// (origin top-left, y down, after page rotation) — the same space as search results.
import * as mupdf from "mupdf";

export type Pt = [number, number];
export type RGB = [number, number, number];

export type AnnotSpec =
  | { type: "Highlight" | "Underline" | "StrikeOut" | "Squiggly"; quads: number[][]; color?: RGB; contents?: string }
  | { type: "Text"; at: Pt; contents: string; color?: RGB; icon?: string }
  | { type: "FreeText"; rect: number[]; contents: string; fontSize?: number; color?: RGB }
  | { type: "Square" | "Circle"; rect: number[]; color?: RGB; fill?: RGB | null; width?: number; contents?: string }
  | { type: "Line"; a: Pt; b: Pt; arrow?: boolean; color?: RGB; width?: number; contents?: string }
  | { type: "Ink"; strokes: Pt[][]; color?: RGB; width?: number; contents?: string }
  | { type: "Stamp"; rect: number[]; label: string; color?: RGB }
  | { type: "Redact"; quads?: number[][]; rect?: number[] };

export interface AnnotInfo {
  /** Stable key: PDF object number of the annotation. */
  key: number;
  page: number;
  type: string;
  rect: number[];
  contents: string;
  author: string;
  modified: string | null;
  color: number[];
  quads?: number[][];
}

const DEFAULT_COLORS: Record<string, RGB> = {
  Highlight: [1, 0.85, 0],
  Underline: [0, 0.45, 0.9],
  StrikeOut: [0.85, 0.1, 0.1],
  Squiggly: [0.1, 0.6, 0.2],
  Text: [1, 0.8, 0],
  FreeText: [0, 0, 0],
  Square: [0.85, 0.1, 0.1],
  Circle: [0.85, 0.1, 0.1],
  Line: [0.85, 0.1, 0.1],
  Ink: [0.1, 0.3, 0.9],
  Stamp: [0.1, 0.5, 0.2],
};

const keyOf = (a: mupdf.PDFAnnotation) => a.getObject().asIndirect();

export function listAnnotations(doc: mupdf.PDFDocument, pageIndex: number): AnnotInfo[] {
  const page = doc.loadPage(pageIndex);
  try {
    return page
      .getAnnotations()
      .filter((a) => a.getType() !== "Popup" && a.getType() !== "Link")
      .map((a) => {
        let modified: string | null = null;
        try {
          const d = a.getModificationDate();
          modified = d && !isNaN(d.getTime()) ? d.toISOString() : null;
        } catch { /* no date */ }
        return {
          key: keyOf(a),
          page: pageIndex,
          type: a.getType(),
          rect: Array.from(a.getBounds()),
          contents: a.getContents() ?? "",
          author: a.hasAuthor() ? a.getAuthor() ?? "" : "",
          modified,
          color: Array.from(a.getColor()),
          quads: a.hasQuadPoints() ? a.getQuadPoints().map((q) => Array.from(q)) : undefined,
        };
      });
  } finally {
    page.destroy();
  }
}

export function addAnnotation(doc: mupdf.PDFDocument, pageIndex: number, spec: AnnotSpec, author: string): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = page.createAnnotation(spec.type);
    const color = ("color" in spec && spec.color) || DEFAULT_COLORS[spec.type];
    // For FreeText, /C is the box background; the text colour goes in the default appearance instead.
    if (color && spec.type !== "Redact" && spec.type !== "FreeText") a.setColor(color);
    switch (spec.type) {
      case "Highlight":
      case "Underline":
      case "StrikeOut":
      case "Squiggly":
        a.setQuadPoints(spec.quads as mupdf.Quad[]);
        if (spec.type === "Highlight") a.setOpacity(1);
        break;
      case "Text":
        a.setRect([spec.at[0], spec.at[1], spec.at[0] + 20, spec.at[1] + 20]);
        if (spec.icon) a.setIcon(spec.icon);
        break;
      case "FreeText":
        a.setRect(spec.rect as mupdf.Rect);
        a.setDefaultAppearance("Helv", spec.fontSize ?? 12, color ?? [0, 0, 0]);
        break;
      case "Square":
      case "Circle":
        a.setRect(spec.rect as mupdf.Rect);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.fill) a.setInteriorColor(spec.fill);
        break;
      case "Line":
        a.setLine(spec.a, spec.b);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.arrow) a.setLineEndingStyles("None", "ClosedArrow");
        break;
      case "Ink":
        a.setInkList(spec.strokes);
        a.setBorderWidth(spec.width ?? 2);
        break;
      case "Stamp":
        a.setRect(spec.rect as mupdf.Rect);
        a.setIcon(spec.label);
        break;
      case "Redact":
        if (spec.quads?.length) a.setQuadPoints(spec.quads as mupdf.Quad[]);
        if (spec.rect) a.setRect(spec.rect as mupdf.Rect);
        else if (spec.quads?.length) a.setRect(boundsOfQuads(spec.quads) as mupdf.Rect);
        break;
    }
    if ("contents" in spec && spec.contents) a.setContents(spec.contents);
    if (spec.type !== "Redact" && spec.type !== "Stamp") a.setAuthor(author);
    const now = new Date();
    a.setCreationDate?.(now);
    a.setModificationDate(now);
    a.update();
    return keyOf(a);
  } finally {
    page.destroy();
  }
}

function findAnnot(page: mupdf.PDFPage, key: number) {
  const a = page.getAnnotations().find((x) => keyOf(x) === key);
  if (!a) throw new Error("Comment not found (it may have been deleted)");
  return a;
}

export function updateAnnotation(doc: mupdf.PDFDocument, pageIndex: number, key: number, patch: { contents?: string; color?: RGB; rect?: number[] }) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = findAnnot(page, key);
    if (patch.contents !== undefined) a.setContents(patch.contents);
    if (patch.color) a.setColor(patch.color);
    if (patch.rect) a.setRect(patch.rect as mupdf.Rect);
    a.setModificationDate(new Date());
    a.update();
  } finally {
    page.destroy();
  }
}

export function deleteAnnotation(doc: mupdf.PDFDocument, pageIndex: number, key: number) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    page.deleteAnnotation(findAnnot(page, key));
  } finally {
    page.destroy();
  }
}

/** Topmost annotation under a point, if any. */
export function annotationAt(doc: mupdf.PDFDocument, pageIndex: number, p: Pt): AnnotInfo | null {
  const all = listAnnotations(doc, pageIndex);
  for (let i = all.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = all[i].rect;
    if (p[0] >= x0 - 2 && p[0] <= x1 + 2 && p[1] >= y0 - 2 && p[1] <= y1 + 2) return all[i];
  }
  return null;
}

export function boundsOfQuads(quads: number[][]): number[] {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ---------- XFDF export/import (exchange comments with other PDF apps) ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

/** Export markup and notes to XFDF. Coordinates are converted to PDF user space as XFDF requires. */
export function exportXfdf(doc: mupdf.PDFDocument, fileName: string): string {
  const out: string[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    const toUser = mupdf.Matrix.invert(page.getTransform());
    const tp = (x: number, y: number) => {
      const [a, b, c, d, e, f] = toUser;
      return [x * a + y * c + e, x * b + y * d + f];
    };
    const rectUser = (r: number[]) => {
      const p = [tp(r[0], r[1]), tp(r[2], r[3])];
      return [Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])].map((v) => +v.toFixed(2)).join(",");
    };
    for (const a of listAnnotations(doc, i)) {
      const tag = { Text: "text", Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly", FreeText: "freetext", Square: "square", Circle: "circle", Line: "line", Ink: "ink", Stamp: "stamp" }[a.type];
      if (!tag) continue;
      let attrs = `page="${i}" rect="${rectUser(a.rect)}" color="${hex(a.color.length === 3 ? a.color : [0, 0, 0])}" title="${esc(a.author)}" name="quire-${a.key}"`;
      if (a.modified) attrs += ` date="${pdfDate(a.modified)}"`;
      if (a.quads) attrs += ` coords="${a.quads.map((q) => [0, 2, 4, 6].map((k) => tp(q[k], q[k + 1]).map((v) => v.toFixed(2)).join(",")).join(",")).join(",")}"`;
      out.push(`  <${tag} ${attrs}>${a.contents ? `<contents>${esc(a.contents)}</contents>` : ""}</${tag}>`);
    }
    page.destroy();
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n <f href="${esc(fileName)}"/>\n <annots>\n${out.join("\n")}\n </annots>\n</xfdf>\n`;
}

function pdfDate(iso: string) {
  return "D:" + iso.replace(/[-:T]/g, "").slice(0, 14) + "Z";
}

/** Plain-text comment summary, handy for review emails. */
export function summarizeComments(doc: mupdf.PDFDocument): string {
  const lines: string[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const st = page.toStructuredText("");
    for (const a of listAnnotations(doc, i)) {
      let quoted = "";
      if (a.quads?.length) {
        const [x0, y0, x1, y1] = boundsOfQuads(a.quads);
        quoted = st.copy([x0 + 0.5, (y0 + y1) / 2], [x1 - 0.5, (y0 + y1) / 2]).replace(/\s+/g, " ").trim();
        if (a.quads.length > 1) quoted = st.copy([a.quads[0][0] + 0.5, (a.quads[0][1] + a.quads[0][5]) / 2], [a.quads.at(-1)![2] - 0.5, (a.quads.at(-1)![3] + a.quads.at(-1)![7]) / 2]).replace(/\s+/g, " ").trim();
      }
      lines.push(`Page ${i + 1} · ${a.type}${a.author ? ` · ${a.author}` : ""}${quoted ? `\n  “${quoted}”` : ""}${a.contents ? `\n  ${a.contents}` : ""}`);
    }
    st.destroy();
    page.destroy();
  }
  return lines.join("\n\n");
}
