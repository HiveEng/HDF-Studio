// Editing existing page content: text blocks and images.
// Text edits remove the original glyphs (text-only redaction, leaving images and drawings intact)
// and write the new text in a matching standard font, size and colour.
import * as mupdf from "mupdf";
import { type Xf, imageMatrix, xfFromMatrix, xfFromRect } from "./xform";
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
  /** Line by line, as on the page. */
  text: string;
  /** Running text: wrapped lines joined into paragraphs, so edits reflow. */
  para: string;
  /** Dominant style, used when rewriting the block. */
  style: TextStyle;
}

export type Align = "left" | "center" | "right" | "justify";

export interface TextStyle {
  font: StdFont;
  size: number;
  color: [number, number, number];
  lineHeight?: number;
  /** Baseline of the first line (display coordinates), to keep edited text exactly in place. */
  baseline?: number;
  align?: Align;
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

interface RawLine extends TextLine {
  /** One per character of text; null for a space added between merged pieces. */
  quads: (number[] | null)[];
}

/** Widely spaced words (justified text) can come out as separate pieces: join pieces on one baseline. */
function mergeLines(lines: RawLine[]): RawLine[] {
  const out: RawLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.baseline - l.baseline) < Math.max(prev.size, l.size) * 0.3 && l.bbox[0] >= prev.bbox[2] - 1) {
      const sp = /\s$/.test(prev.text) || /^\s/.test(l.text) ? "" : " ";
      prev.text += sp + l.text;
      if (sp) prev.quads.push(null);
      prev.quads.push(...l.quads);
      prev.bbox = [Math.min(prev.bbox[0], l.bbox[0]), Math.min(prev.bbox[1], l.bbox[1]), Math.max(prev.bbox[2], l.bbox[2]), Math.max(prev.bbox[3], l.bbox[3])];
    } else out.push(l);
  }
  return out;
}
interface RawBlock {
  bbox: number[];
  lines: RawLine[];
}

function rawBlocks(page: mupdf.Page): RawBlock[] {
  const st = page.toStructuredText("preserve-whitespace");
  const blocks: RawBlock[] = [];
  let block: RawBlock | null = null;
  let line: RawLine | null = null;
  st.walk({
    beginTextBlock(bbox) {
      block = { bbox: Array.from(bbox), lines: [] };
    },
    beginLine(bbox) {
      line = { bbox: Array.from(bbox), baseline: bbox[3], text: "", font: "", size: 0, color: [0, 0, 0], quads: [] };
    },
    onChar(c, origin, font, size, quad, color) {
      if (!line) return;
      if (!line.font) {
        line.baseline = origin[1];
        line.font = font.getName();
        line.size = size;
        line.color = Array.from(color as number[]);
      }
      line.text += c;
      for (let k = 0; k < c.length; k++) line.quads.push(Array.from(quad));
    },
    endLine() {
      if (block && line && line.text.trim()) block.lines.push(line);
      line = null;
    },
    endTextBlock() {
      if (block && block.lines.length) blocks.push({ ...block, lines: mergeLines(block.lines) });
      block = null;
    },
  });
  st.destroy();
  return blocks;
}

const BULLET = /^\s*([•▪◦‣\-–*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/i;

/** Join wrapped lines into paragraphs; map each character of the result back to its quad. */
function paragraphs(b: RawBlock): { para: string; quads: (number[] | null)[] } {
  const right = Math.max(...b.lines.map((l) => l.bbox[2]));
  let para = "";
  const quads: (number[] | null)[] = [];
  b.lines.forEach((l, i) => {
    const t = l.text.replace(/\s+$/, "");
    para += t;
    quads.push(...l.quads.slice(0, t.length));
    const next = b.lines[i + 1];
    if (!next) return;
    const full = right - l.bbox[2] < Math.max(l.size * 3, 0.15 * (right - b.bbox[0]));
    // A line ending in "word-" continues the word on the next line.
    const sep = full && !BULLET.test(next.text) ? (/\w-$/.test(t) ? "" : " ") : "\n";
    para += sep;
    for (let k = 0; k < sep.length; k++) quads.push(null);
  });
  return { para, quads };
}

function alignOf(b: RawBlock): Align {
  const ls = b.lines;
  if (ls.length < 2) return "left";
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const tol = Math.max(1.5, ls[0].size * 0.15);
  const lefts = spread(ls.map((l) => l.bbox[0]));
  const rights = spread(ls.map((l) => l.bbox[2]));
  const centers = spread(ls.map((l) => (l.bbox[0] + l.bbox[2]) / 2));
  if (lefts > tol * 2 && centers < tol) return "center";
  if (lefts > tol * 2 && rights < tol) return "right";
  const body = ls.slice(0, -1);
  if (ls.length >= 3 && lefts < tol && spread(body.map((l) => l.bbox[2])) < tol * 0.7) return "justify";
  return "left";
}

function toBlock(b: RawBlock): TextBlock {
  const first = b.lines[0];
  const rgb = first.color.length === 3 ? first.color : first.color.length === 1 ? [first.color[0], first.color[0], first.color[0]] : [0, 0, 0];
  // Line spacing: the typical gap between baselines.
  const gaps = b.lines.slice(1).map((l, i) => l.baseline - b.lines[i].baseline).filter((g) => g > first.size * 0.5).sort((x, y) => x - y);
  const lh = gaps.length ? gaps[Math.floor(gaps.length / 2)] : undefined;
  return {
    bbox: b.bbox,
    lines: b.lines.map(({ quads: _q, ...l }) => l),
    text: b.lines.map((l) => l.text.replace(/\s+$/, "")).join("\n"),
    para: paragraphs(b).para,
    style: { font: matchFont(first.font), size: +first.size.toFixed(2), color: rgb as [number, number, number], lineHeight: lh && lh > 0 ? +lh.toFixed(2) : undefined, baseline: +first.baseline.toFixed(2), align: alignOf(b) },
  };
}

export function textBlocks(page: mupdf.Page): TextBlock[] {
  return rawBlocks(page).map(toBlock);
}

// ---------- Find and replace ----------
export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}
export function findPattern(find: string, o: FindOptions = {}): RegExp {
  const esc = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, o.matchCase ? "gu" : "giu");
}

export interface TextMatch {
  page: number;
  block: number;
  start: number;
  end: number;
  quads: number[][];
  context: string;
}

export function findInPage(page: mupdf.Page, pageIndex: number, re: RegExp): TextMatch[] {
  const out: TextMatch[] = [];
  rawBlocks(page).forEach((b, bi) => {
    const { para, quads } = paragraphs(b);
    for (const m of para.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      if (!m[0]) continue;
      const start = m.index!, end = start + m[0].length;
      const s = Math.max(0, start - 30), e = Math.min(para.length, end + 30);
      out.push({ page: pageIndex, block: bi, start, end, quads: quads.slice(start, end).filter((q): q is number[] => !!q), context: (s > 0 ? "…" : "") + para.slice(s, e).replace(/\s+/g, " ") + (e < para.length ? "…" : "") });
    }
  });
  return out;
}

/**
 * Replace matches in a page's text, paragraph by paragraph. `only` limits it to one match
 * (block index and start offset from findInPage). Returns the number of replacements.
 */
export function replaceInPage(doc: mupdf.PDFDocument, pageIndex: number, re: RegExp, replacement: string, only?: { block: number; start: number }): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const blocks = rawBlocks(page);
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const jobs: { block: TextBlock; text: string }[] = [];
    let count = 0;
    blocks.forEach((b, bi) => {
      if (only && only.block !== bi) return;
      const { para } = paragraphs(b);
      let n = 0;
      const text = para.replace(g, (m, ...rest) => {
        const at = rest[rest.length - 2] as number;
        if (!m || (only && at !== only.start)) return m;
        n++;
        return replacement;
      });
      if (n) {
        count += n;
        jobs.push({ block: toBlock(b), text });
      }
    });
    // Erase every changed paragraph first, then write them all, so a paragraph that grows
    // isn't erased by the next one's clean-up.
    for (const j of jobs) eraseText(page, [j.block.bbox[0] - 0.5, j.block.bbox[1] - 0.5, j.block.bbox[2] + 0.5, j.block.bbox[3] + 0.5]);
    for (const j of jobs) writeBlock(doc, page, j.block.bbox, j.text, j.block.style);
    return count;
  } finally {
    page.destroy();
  }
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

interface WrappedLine {
  text: string;
  /** Last line of its paragraph (never stretched when justifying). */
  last: boolean;
}
function wrap(text: string, width: number, measure: (s: string) => number): WrappedLine[] {
  const out: WrappedLine[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push({ text: "", last: true });
      continue;
    }
    let cur = "";
    for (const word of para.split(/(\s+)/)) {
      const next = cur + word;
      if (cur && measure(next.trimEnd()) > width) {
        out.push({ text: cur.trimEnd(), last: false });
        cur = word.trimStart();
      } else cur = next;
    }
    out.push({ text: cur.trimEnd(), last: true });
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
  const lines = maxWidth ? wrap(text, maxWidth, measure) : text.split("\n").map((t) => ({ text: t, last: true }));
  const align = maxWidth ? (style.align ?? "left") : "left";
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
  const hex = (t: string) => [...t].map((ch) => font.encodeCharacter(ch).toString(16).padStart(4, "0")).join("");
  lines.forEach((ln, i) => {
    // Display space is y-down: flip each line's text matrix so glyphs stand upright.
    const base = (style.baseline ?? at[1] + style.size * 0.8) + i * lh;
    const w = measure(ln.text);
    const words = ln.text.split(/ +/);
    if (align === "justify" && !ln.last && words.length > 1 && maxWidth) {
      // Spread the words to both edges. Identity-H text ignores Tw, so place each word.
      const gap = (maxWidth - words.reduce((s, x) => s + measure(x), 0)) / (words.length - 1);
      let x = at[0];
      for (const wd of words) {
        ops += ` 1 0 0 -1 ${f(x)} ${f(base)} Tm <${hex(wd)}> Tj`;
        x += measure(wd) + gap;
      }
      return;
    }
    const x = align === "center" && maxWidth ? at[0] + (maxWidth - w) / 2 : align === "right" && maxWidth ? at[0] + maxWidth - w : at[0];
    ops += ` 1 0 0 -1 ${f(x)} ${f(base)} Tm <${hex(ln.text)}> Tj`;
  });
  ops += " ET Q";
  wrapContents(doc, obj, ops);
  const width = Math.max(0, ...lines.map((l) => measure(l.text)));
  return [at[0], at[1], at[0] + width, at[1] + (lines.length - 1) * lh + style.size * 1.1];
}

/** Write a paragraph block back in place: it keeps its column width and alignment, and reflows. */
function writeBlock(doc: mupdf.PDFDocument, page: mupdf.PDFPage, bbox: number[], newText: string, style: TextStyle) {
  if (!newText.trim()) return;
  // A paragraph keeps its column width; a single left-aligned line may grow to the page margin.
  const singleLine = bbox[3] - bbox[1] < style.size * 1.9;
  const pageRight = page.getBounds()[2] - 36;
  const grow = singleLine && (style.align ?? "left") === "left";
  const maxWidth = grow ? Math.max(pageRight - bbox[0], bbox[2] - bbox[0]) : Math.max(bbox[2] - bbox[0], 40) + (style.align === "justify" ? 0 : 1);
  writeText(doc, page, [bbox[0], bbox[1]], newText, style, maxWidth);
}

export function replaceText(doc: mupdf.PDFDocument, pageIndex: number, bbox: number[], newText: string, style: TextStyle) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    eraseText(page, [bbox[0] - 0.5, bbox[1] - 0.5, bbox[2] + 0.5, bbox[3] + 0.5]);
    writeBlock(doc, page, bbox, newText, style);
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
  /** Centre, size and rotation on the page. */
  xf: Xf;
}

function walkImages(page: mupdf.Page, fn: (bbox: mupdf.Rect, image: mupdf.Image, i: number, m: mupdf.Matrix) => void) {
  const st = page.toStructuredText("preserve-images");
  let i = 0;
  st.walk({ onImageBlock: (bbox, m, image) => fn(bbox, image, i++, m) });
  st.destroy();
}

export function imageBlocks(page: mupdf.Page): ImageBlock[] {
  const out: ImageBlock[] = [];
  walkImages(page, (bbox, image, index, m) => out.push({ index, bbox: Array.from(bbox), width: image.getWidth(), height: image.getHeight(), xf: xfFromMatrix(Array.from(m)) }));
  return out;
}

/** Remove images inside a rectangle entirely (text and drawings stay). */
function eraseImages(page: mupdf.PDFPage, rect: number[]) {
  const a = page.createAnnotation("Redact");
  a.setRect(rect as mupdf.Rect);
  a.update();
  a.applyRedaction(0, 1, 0, 1); // no box, remove images, keep line art, keep text
}

function drawImage(doc: mupdf.PDFDocument, page: mupdf.PDFPage, image: mupdf.Image, rect: number[] | Xf) {
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
  const f = (n: number) => +n.toFixed(4);
  // Image space is the unit square, y-up; place it (and turn it) in display space (y-down).
  const im = imageMatrix(Array.isArray(rect) ? xfFromRect(rect) : rect);
  wrapContents(doc, obj, `Q q ${m.map(f).join(" ")} cm ${im.map(f).join(" ")} cm /${tag} Do Q`);
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

/** Move, resize and/or rotate a page image to a new placement. */
export function transformImage(doc: mupdf.PDFDocument, pageIndex: number, index: number, to: Xf) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    let found: { bbox: number[]; image: mupdf.Image } | null = null;
    walkImages(page, (bbox, image, i) => i === index && (found = { bbox: Array.from(bbox), image }));
    if (!found) throw new Error("Image not found");
    const { bbox, image } = found as { bbox: number[]; image: mupdf.Image };
    eraseImages(page, shrink(bbox));
    drawImage(doc, page, image, to);
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
