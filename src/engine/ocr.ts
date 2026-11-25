// OCR text layer: recognised words are written as invisible text (render mode 3) exactly over the
// scanned image, so the page looks unchanged but can be searched, selected, copied and redacted.
// Recognition itself (Tesseract) runs outside the PDF engine; this module only reads and writes PDFs.
import * as mupdf from "mupdf";
import { wrapContents, ensureDict } from "./stamp";

/** A recognised line in display coordinates (points, top-left origin, after page rotation). */
export interface OcrLine {
  /** Baseline y. */
  baseline: number;
  /** Font size that makes the text cover the line's height. */
  size: number;
  words: { text: string; x0: number; x1: number }[];
}

/** Characters of real text on a page (ignores whitespace). */
export function textChars(page: mupdf.Page): number {
  const st = page.toStructuredText("");
  try {
    return st.asText().replace(/\s+/g, "").length;
  } finally {
    st.destroy();
  }
}

/** Pages with (almost) no text: scans and photos that need OCR to be searchable. */
export function pagesWithoutText(doc: mupdf.Document, minChars = 10): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      if (textChars(page) < minChars) out.push(i);
    } finally {
      page.destroy();
    }
  }
  return out;
}

/** Render a page for recognition. Returns PNG bytes and the pixels-per-point scale used. */
export function pageImage(doc: mupdf.Document, pageIndex: number, dpi = 300): { png: Uint8Array; scale: number } {
  const page = doc.loadPage(pageIndex);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    // Keep very large pages within ~25 megapixels so recognition stays fast and memory-safe.
    const scale = Math.min(dpi / 72, Math.sqrt(25e6 / Math.max(1, (x1 - x0) * (y1 - y0))));
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
    try {
      return { png: pix.asPNG(), scale };
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

// One embedded font per document, shared by every OCR'd page.
const fontRefs = new WeakMap<mupdf.PDFDocument, { ref: mupdf.PDFObject; font: mupdf.Font }>();

/** Add an invisible, searchable text layer to a page. Returns the number of words written. */
export function addTextLayer(doc: mupdf.PDFDocument, pageIndex: number, lines: OcrLine[]): number {
  let f = fontRefs.get(doc);
  if (!f) {
    const font = new mupdf.Font("Helvetica");
    f = { font, ref: doc.addFont(font) };
    fontRefs.set(doc, f);
  }
  const { font, ref } = f;
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const obj = page.getObject();
    let res = obj.get("Resources");
    if (res.isNull()) {
      const inh = obj.getInheritable("Resources");
      res = doc.newDictionary();
      if (!inh.isNull()) inh.forEach((v, k) => res.put(k as string, v));
      obj.put("Resources", res);
    }
    const tag = `OCR${doc.countObjects()}`;
    ensureDict(doc, res, "Font").put(tag, ref);
    const [bx0, by0] = page.getBounds();
    const m = mupdf.Matrix.concat([1, 0, 0, 1, bx0, by0], mupdf.Matrix.invert(page.getTransform()));
    const n = (v: number) => +v.toFixed(2);
    let ops = `Q q ${m.map((v) => +v.toFixed(5)).join(" ")} cm BT 3 Tr`;
    let words = 0;
    for (const line of lines) {
      if (!line.words.length || line.size <= 0) continue;
      ops += ` /${tag} ${n(line.size)} Tf`;
      for (const w of line.words) {
        const text = w.text.trim();
        if (!text) continue;
        const gids = [...text].map((ch) => font.encodeCharacter(ch));
        const natural = gids.reduce((s, g) => s + font.advanceGlyph(g), 0) * line.size;
        // Stretch or squeeze each word to the width of the word in the image, so selections line up.
        const tz = natural > 0 ? Math.max(10, Math.min(1000, ((w.x1 - w.x0) / natural) * 100)) : 100;
        const hex = gids.map((g) => g.toString(16).padStart(4, "0")).join("");
        // Trailing space glyph keeps words apart in copied text.
        const space = font.encodeCharacter(" ").toString(16).padStart(4, "0");
        ops += ` ${n(tz)} Tz 1 0 0 -1 ${n(w.x0)} ${n(line.baseline)} Tm <${hex}${space}> Tj`;
        words++;
      }
    }
    ops += " ET Q";
    if (words) wrapContents(doc, obj, ops);
    return words;
  } finally {
    page.destroy();
  }
}

/** Minimal shape of Tesseract's block output that we use. */
interface TBox { x0: number; y0: number; x1: number; y1: number }
export interface TesseractBlock {
  paragraphs: { lines: { bbox: TBox; baseline: TBox; words: { text: string; bbox: TBox; confidence: number }[] }[] }[];
}

/** Convert Tesseract's pixel-space blocks into page-space lines. */
export function linesFromTesseract(blocks: TesseractBlock[] | null | undefined, scale: number, minConfidence = 30): OcrLine[] {
  const out: OcrLine[] = [];
  for (const b of blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        const words = l.words
          .filter((w) => w.text.trim() && w.confidence >= minConfidence)
          .map((w) => ({ text: w.text, x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale }));
        if (!words.length) continue;
        // Baseline from Tesseract when it is sensible, otherwise just above the line's bottom.
        const bl = l.baseline && l.baseline.y0 > l.bbox.y0 ? (l.baseline.y0 + l.baseline.y1) / 2 : l.bbox.y1 - (l.bbox.y1 - l.bbox.y0) * 0.2;
        const baseline = bl / scale;
        const top = l.bbox.y0 / scale;
        // Helvetica capitals reach about 0.72 em above the baseline.
        const size = Math.max(2, (baseline - top) / 0.72);
        out.push({ baseline, size, words });
      }
  return out;
}
