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

// Fonts shared by every OCR'd page of a document: Helvetica for Latin, Greek and Cyrillic, and a
// glyphless Unicode font for every other script (Arabic, Hebrew, CJK, Indic, Thai…). The text is
// invisible, so only the character codes matter: the Unicode font's codes *are* code points, and
// its ToUnicode map says so, which makes search and copy work in any viewer.
interface OcrFonts { latin: mupdf.Font; latinRef: mupdf.PDFObject; uniRef: mupdf.PDFObject | null }
const fontRefs = new WeakMap<mupdf.PDFDocument, OcrFonts>();

function unicodeFont(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const blocks: string[] = [];
  for (let hi = 0; hi < 256; hi += 100) {
    const n = Math.min(100, 256 - hi);
    const lines = Array.from({ length: n }, (_, k) => {
      const h = (hi + k).toString(16).padStart(2, "0").toUpperCase();
      return `<${h}00> <${h}FF> <${h}00>`;
    });
    blocks.push(`${n} beginbfrange\n${lines.join("\n")}\nendbfrange`);
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /HDF-Unicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const desc = doc.newDictionary();
  desc.put("Type", doc.newName("FontDescriptor"));
  desc.put("FontName", doc.newName("HDFStudioOCRText"));
  desc.put("Flags", 4);
  desc.put("FontBBox", [0, -200, 1000, 800]);
  desc.put("ItalicAngle", 0);
  desc.put("Ascent", 800);
  desc.put("Descent", -200);
  desc.put("CapHeight", 700);
  desc.put("StemV", 80);
  const cid = doc.newDictionary();
  cid.put("Type", doc.newName("Font"));
  cid.put("Subtype", doc.newName("CIDFontType2"));
  cid.put("BaseFont", doc.newName("HDFStudioOCRText"));
  const info = doc.newDictionary();
  info.put("Registry", doc.newString("Adobe"));
  info.put("Ordering", doc.newString("Identity"));
  info.put("Supplement", 0);
  cid.put("CIDSystemInfo", info);
  cid.put("FontDescriptor", doc.addObject(desc));
  cid.put("DW", 1000);
  cid.put("CIDToGIDMap", doc.newName("Identity"));
  const font = doc.newDictionary();
  font.put("Type", doc.newName("Font"));
  font.put("Subtype", doc.newName("Type0"));
  font.put("BaseFont", doc.newName("HDFStudioOCRText"));
  font.put("Encoding", doc.newName("Identity-H"));
  font.put("DescendantFonts", [doc.addObject(cid)]);
  font.put("ToUnicode", doc.addStream(cmap, doc.newDictionary()));
  return doc.addObject(font);
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** Give these characters zero width in the Unicode OCR font (kept in its /W array). */
function zeroWidth(doc: mupdf.PDFDocument, fontRef: mupdf.PDFObject, chars: string[]) {
  const cid = fontRef.get("DescendantFonts").get(0);
  let w = cid.get("W");
  if (!w.isArray()) {
    w = doc.newArray();
    cid.put("W", w);
  }
  const have = new Set<number>();
  for (let i = 0; i + 1 < w.length; i += 2) have.add(w.get(i).asNumber());
  for (const ch of new Set(chars)) {
    const code = ch.codePointAt(0)!;
    if (have.has(code)) continue;
    w.push(code);
    w.push([0]);
    have.add(code);
  }
}

/** Add an invisible, searchable text layer to a page. Returns the number of words written. */
export function addTextLayer(doc: mupdf.PDFDocument, pageIndex: number, lines: OcrLine[]): number {
  let f = fontRefs.get(doc);
  if (!f) {
    const latin = new mupdf.Font("Helvetica");
    f = { latin, latinRef: doc.addFont(latin), uniRef: null };
    fontRefs.set(doc, f);
  }
  const fonts = f;
  const { latin } = fonts;
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
    const fontDict = ensureDict(doc, res, "Font");
    fontDict.put(tag, fonts.latinRef);
    let uniTag: string | null = null;
    const useUnicode = () => {
      if (!uniTag) {
        fonts.uniRef ??= unicodeFont(doc);
        uniTag = tag + "U";
        fontDict.put(uniTag, fonts.uniRef);
      }
      return uniTag;
    };
    const [bx0, by0] = page.getBounds();
    const m = mupdf.Matrix.concat([1, 0, 0, 1, bx0, by0], mupdf.Matrix.invert(page.getTransform()));
    const n = (v: number) => +v.toFixed(2);
    let ops = `Q q ${m.map((v) => +v.toFixed(5)).join(" ")} cm BT 3 Tr`;
    let words = 0;
    const latinSpace = latin.encodeCharacter(" ").toString(16).padStart(4, "0");
    for (const line of lines) {
      if (!line.words.length || line.size <= 0) continue;
      let current = "";
      for (const w of line.words) {
        const text = w.text.trim();
        if (!text) continue;
        const chars = [...text].filter((ch) => ch.codePointAt(0)! <= 0xffff);
        if (!chars.length) continue;
        const gids = chars.map((ch) => latin.encodeCharacter(ch));
        const isLatin = gids.every((g) => g > 0);
        let hex: string, natural: number, font: string;
        if (isLatin) {
          font = tag;
          natural = gids.reduce((s, g) => s + latin.advanceGlyph(g), 0) * line.size;
          hex = gids.map((g) => g.toString(16).padStart(4, "0")).join("") + latinSpace; // trailing space keeps words apart when copied
        } else {
          font = useUnicode();
          // Combining marks (Indic vowel signs, Arabic harakat…) take no width, so the word stays one cluster.
          const marks = chars.filter((ch) => /\p{M}/u.test(ch));
          if (marks.length) zeroWidth(doc, fonts.uniRef!, marks);
          natural = (chars.length - marks.length) * line.size;
          // Right-to-left words are written in visual order; viewers put them back in reading order.
          const ordered = RTL.test(text) ? [...chars].reverse() : chars;
          hex = ordered.map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, "0")).join("") + "0020";
        }
        if (font !== current) {
          ops += ` /${font} ${n(line.size)} Tf`;
          current = font;
        }
        // Stretch or squeeze each word to the width of the word in the image, so selections line up.
        const tz = natural > 0 ? Math.max(10, Math.min(1000, ((w.x1 - w.x0) / natural) * 100)) : 100;
        ops += ` ${n(tz)} Tz 1 0 0 -1 ${n(w.x0)} ${n(line.baseline)} Tm <${hex}> Tj`;
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
