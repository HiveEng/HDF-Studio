// Editing existing page content: text blocks and images.
// Text edits remove the original glyphs (text-only redaction, leaving images and drawings intact)
// and write the new text in a matching standard font, size and colour.
import * as mupdf from "mupdf";
import { wrapContents, ensureDict } from "./stamp";

export interface TextLine {
  bbox: number[];
  baseline: number;
  text: string;
  font: string;
  size: number;
  color: number[];
}

export interface TextBlock {
  bbox: number[];
  lines: TextLine[];
  text: string;
  /** Dominant style, used when rewriting the block. */
  style: TextStyle;
}

export interface TextStyle {
  font: StdFont;
  size: number;
  color: [number, number, number];
  lineHeight?: number;
  /** Baseline of the first line (display coordinates), to keep edited text exactly in place. */
  baseline?: number;
}

export type StdFont =
  | "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique"
  | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic"
  | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique";

/** Closest standard font for an embedded font name. */
export function matchFont(name: string): StdFont {
  const n = name.toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  if (/courier|mono|consol|code/.test(n)) return (["Courier", "Courier-Oblique", "Courier-Bold", "Courier-BoldOblique"] as const)[+italic + 2 * +bold];
  if (/times|serif(?!.*sans)|georgia|garamond|cambria|minion|book|roman|palatino/.test(n) && !/sans/.test(n)) return (["Times-Roman", "Times-Italic", "Times-Bold", "Times-BoldItalic"] as const)[+italic + 2 * +bold];
  return (["Helvetica", "Helvetica-Oblique", "Helvetica-Bold", "Helvetica-BoldOblique"] as const)[+italic + 2 * +bold];
}

export function textBlocks(page: mupdf.Page): TextBlock[] {
  const st = page.toStructuredText("preserve-whitespace");
  const blocks: TextBlock[] = [];
  let block: TextBlock | null = null;
  let line: TextLine | null = null;
  st.walk({
    beginTextBlock(bbox) {
      block = { bbox: Array.from(bbox), lines: [], text: "", style: { font: "Helvetica", size: 12, color: [0, 0, 0] } };
    },
    beginLine(bbox) {
      line = { bbox: Array.from(bbox), baseline: bbox[3], text: "", font: "", size: 0, color: [0, 0, 0] };
    },
    onChar(c, origin, font, size, _quad, color) {
      if (!line) return;
      if (!line.font) {
        line.baseline = origin[1];
        line.font = font.getName();
        line.size = size;
        line.color = Array.from(color as number[]);
      }
      line.text += c;
    },
    endLine() {
      if (block && line && line.text.trim()) block.lines.push(line);
      line = null;
    },
    endTextBlock() {
      if (block && block.lines.length) {
        block.text = block.lines.map((l) => l.text.replace(/\s+$/, "")).join("\n");
        const first = block.lines[0];
        const rgb = first.color.length === 3 ? first.color : first.color.length === 1 ? [first.color[0], first.color[0], first.color[0]] : [0, 0, 0];
        const lh = block.lines.length > 1 ? (block.lines[block.lines.length - 1].bbox[1] - first.bbox[1]) / (block.lines.length - 1) : undefined;
        block.style = { font: matchFont(first.font), size: +first.size.toFixed(2), color: rgb as [number, number, number], lineHeight: lh && lh > 0 ? +lh.toFixed(2) : undefined, baseline: +first.baseline.toFixed(2) };
        blocks.push(block);
      }
      block = null;
    },
  });
  st.destroy();
  return blocks;
}

/** Remove only the text inside a rectangle (images and drawings stay). */
function eraseText(page: mupdf.PDFPage, rect: number[]) {
  const a = page.createAnnotation("Redact");
  a.setRect(rect as mupdf.Rect);
  a.update();
  a.applyRedaction(0, 0, 0, 0); // no black box, keep images, keep line art, remove text
}

/** Map display coordinates (top-left origin, after rotation) into the page's user space. */
function displayToUser(page: mupdf.PDFPage): mupdf.Matrix {
  const [x0, y0] = page.getBounds();
  return mupdf.Matrix.concat([1, 0, 0, 1, x0, y0], mupdf.Matrix.invert(page.getTransform()));
}

function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const word of para.split(/(\s+)/)) {
      const next = cur + word;
      if (cur && measure(next.trimEnd()) > width) {
        out.push(cur.trimEnd());
        cur = word.trimStart();
      } else cur = next;
    }
    out.push(cur.trimEnd());
  }
  return out;
}

/**
 * Write text at a top-left point (display coordinates). Uses an embedded Unicode (Identity-H) font so
 * accented and non-Latin characters covered by the font work and stay searchable.
 */
export function writeText(doc: mupdf.PDFDocument, page: mupdf.PDFPage, at: [number, number], text: string, style: TextStyle, maxWidth?: number): number[] {
  const font = new mupdf.Font(style.font);
  const fontRef = doc.addFont(font);
  const measure = (s: string) => [...s].reduce((w, ch) => w + font.advanceGlyph(font.encodeCharacter(ch)), 0) * style.size;
  const lines = maxWidth ? wrap(text, maxWidth, measure) : text.split("\n");
  const lh = style.lineHeight ?? style.size * 1.2;
  const obj = page.getObject();
  let res = obj.get("Resources");
  if (res.isNull()) {
    const inh = obj.getInheritable("Resources");
    res = doc.newDictionary();
    if (!inh.isNull()) inh.forEach((v, k) => res.put(k as string, v));
    obj.put("Resources", res);
  }
  const tag = `E${doc.countObjects()}`;
  ensureDict(doc, res, "Font").put(tag, fontRef);
  const m = displayToUser(page);
  const f = (n: number) => +n.toFixed(3);
  const [r, g, b] = style.color;
  let ops = `Q q ${m.map(f).join(" ")} cm ${f(r)} ${f(g)} ${f(b)} rg BT /${tag} ${f(style.size)} Tf`;
  lines.forEach((ln, i) => {
    const hex = [...ln].map((ch) => font.encodeCharacter(ch).toString(16).padStart(4, "0")).join("");
    // Display space is y-down: flip each line's text matrix so glyphs stand upright.
    const base = (style.baseline ?? at[1] + style.size * 0.8) + i * lh;
    ops += ` 1 0 0 -1 ${f(at[0])} ${f(base)} Tm <${hex}> Tj`;
  });
  ops += " ET Q";
  wrapContents(doc, obj, ops);
  const width = Math.max(0, ...lines.map(measure));
  return [at[0], at[1], at[0] + width, at[1] + (lines.length - 1) * lh + style.size * 1.1];
}

export function replaceText(doc: mupdf.PDFDocument, pageIndex: number, bbox: number[], newText: string, style: TextStyle) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    eraseText(page, [bbox[0] - 0.5, bbox[1] - 0.5, bbox[2] + 0.5, bbox[3] + 0.5]);
    // A paragraph keeps its column width; a single line may grow to the page margin.
    const singleLine = bbox[3] - bbox[1] < style.size * 1.9;
    const pageRight = page.getBounds()[2] - 36;
    const maxWidth = singleLine ? Math.max(pageRight - bbox[0], bbox[2] - bbox[0]) : Math.max(bbox[2] - bbox[0], 40) + 1;
    if (newText.trim()) writeText(doc, page, [bbox[0], bbox[1]], newText, style, maxWidth);
  } finally {
    page.destroy();
  }
}

export function addText(doc: mupdf.PDFDocument, pageIndex: number, at: [number, number], text: string, style: TextStyle): number[] {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    return writeText(doc, page, at, text, style);
  } finally {
    page.destroy();
  }
}

// ---------- Images ----------

export interface ImageBlock {
  index: number;
  bbox: number[];
  width: number;
  height: number;
}

function walkImages(page: mupdf.Page, fn: (bbox: mupdf.Rect, image: mupdf.Image, i: number) => void) {
  const st = page.toStructuredText("preserve-images");
  let i = 0;
  st.walk({ onImageBlock: (bbox, _m, image) => fn(bbox, image, i++) });
  st.destroy();
}

export function imageBlocks(page: mupdf.Page): ImageBlock[] {
  const out: ImageBlock[] = [];
  walkImages(page, (bbox, image, index) => out.push({ index, bbox: Array.from(bbox), width: image.getWidth(), height: image.getHeight() }));
  return out;
}

/** Remove images inside a rectangle entirely (text and drawings stay). */
function eraseImages(page: mupdf.PDFPage, rect: number[]) {
  const a = page.createAnnotation("Redact");
  a.setRect(rect as mupdf.Rect);
  a.update();
  a.applyRedaction(0, 1, 0, 1); // no box, remove images, keep line art, keep text
}

function drawImage(doc: mupdf.PDFDocument, page: mupdf.PDFPage, image: mupdf.Image, rect: number[]) {
  const obj = page.getObject();
  let res = obj.get("Resources");
  if (res.isNull()) {
    const inh = obj.getInheritable("Resources");
    res = doc.newDictionary();
    if (!inh.isNull()) inh.forEach((v, k) => res.put(k as string, v));
    obj.put("Resources", res);
  }
  const tag = `I${doc.countObjects()}`;
  ensureDict(doc, res, "XObject").put(tag, doc.addImage(image));
  const m = displayToUser(page);
  const [x0, y0, x1, y1] = rect;
  const f = (n: number) => +n.toFixed(3);
  // Image space is the unit square, y-up; place it in the display rect (y-down).
  wrapContents(doc, obj, `Q q ${m.map(f).join(" ")} cm ${f(x1 - x0)} 0 0 ${f(-(y1 - y0))} ${f(x0)} ${f(y1)} cm /${tag} Do Q`);
}

export function insertImage(doc: mupdf.PDFDocument, pageIndex: number, rect: number[], data: Uint8Array) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    drawImage(doc, page, new mupdf.Image(data), rect);
  } finally {
    page.destroy();
  }
}

export function deleteImage(doc: mupdf.PDFDocument, pageIndex: number, bbox: number[]) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    eraseImages(page, shrink(bbox));
  } finally {
    page.destroy();
  }
}

/** Move/resize an image, or replace it with new image data. */
export function moveImage(doc: mupdf.PDFDocument, pageIndex: number, index: number, to: number[], replacement?: Uint8Array) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    let found: { bbox: number[]; image: mupdf.Image } | null = null;
    walkImages(page, (bbox, image, i) => i === index && (found = { bbox: Array.from(bbox), image }));
    if (!found) throw new Error("Image not found");
    const { bbox, image } = found as { bbox: number[]; image: mupdf.Image };
    eraseImages(page, shrink(bbox));
    drawImage(doc, page, replacement ? new mupdf.Image(replacement) : image, to);
  } finally {
    page.destroy();
  }
}

/** Export an image's pixels as PNG. */
export function extractImage(page: mupdf.Page, index: number): Uint8Array {
  let png: Uint8Array | null = null;
  walkImages(page, (_b, image, i) => {
    if (i === index) png = new Uint8Array(image.toPixmap().asPNG());
  });
  if (!png) throw new Error("Image not found");
  return png;
}

// Shrink slightly so neighbouring images that merely touch the box aren't caught.
const shrink = (r: number[]) => [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1];
