// Text stamping: headers/footers, page numbers, Bates numbers, and diagonal watermarks.
// Text is written into the page content (not an annotation), so it prints and survives flattening.
import * as mupdf from "mupdf";

export type Position = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right" | "center" | "diagonal";

export interface StampOptions {
  /** Template. Variables: {page} {pages} {file} {date} {bates} (Bates uses batesStart/batesDigits/batesPrefix). */
  text: string;
  position: Position;
  pages?: number[];
  fontSize?: number;
  /** 0..1 */
  opacity?: number;
  /** RGB 0..1 */
  color?: [number, number, number];
  margin?: number;
  font?: "Helvetica" | "Helvetica-Bold" | "Times-Roman" | "Courier";
  fileName?: string;
  batesStart?: number;
  batesDigits?: number;
  batesPrefix?: string;
}

export function expandTemplate(t: string, v: { page: number; pages: number; file: string; bates: string; date: string }): string {
  return t.replace(/\{(page|pages|file|date|bates)\}/g, (_, k: keyof typeof v) => String(v[k]));
}

/** Escape a string for a PDF literal, keeping only WinAnsi-representable characters. */
function pdfString(s: string): string {
  return "(" + s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?") + ")";
}

export function stampText(doc: mupdf.PDFDocument, o: StampOptions): number {
  const fontName = o.font ?? "Helvetica";
  const font = new mupdf.Font(fontName);
  const fontRef = doc.addSimpleFont(font);
  const size = o.fontSize ?? (o.position === "diagonal" ? 60 : 10);
  const opacity = o.opacity ?? (o.position === "diagonal" ? 0.25 : 1);
  const [r, g, b] = o.color ?? (o.position === "diagonal" ? [0.8, 0.1, 0.1] : [0, 0, 0]);
  const margin = o.margin ?? 28;
  const n = doc.countPages();
  const pages = o.pages ?? [...Array(n).keys()];
  const date = new Date().toISOString().slice(0, 10);
  // Unique resource names so several stamps on one page don't overwrite each other's font/opacity.
  const tag = `Q${doc.countObjects()}`;
  const gs = doc.addObject(doc.newDictionary());
  gs.put("Type", doc.newName("ExtGState"));
  gs.put("ca", opacity);
  gs.put("CA", opacity);

  const width = (s: string) => [...s].reduce((w, ch) => w + font.advanceGlyph(font.encodeCharacter(ch)), 0) * size;

  pages.forEach((pi, k) => {
    const page = doc.loadPage(pi);
    const [x0, y0, x1, y1] = page.getBounds();
    const W = x1 - x0, H = y1 - y0;
    // Map "display" coordinates (origin bottom-left of the page as shown, after /Rotate and CropBox)
    // into the page's user space.
    const ctm = page.getTransform();
    const toUser = mupdf.Matrix.concat([1, 0, 0, -1, -x0, H + y0], mupdf.Matrix.invert(ctm));
    const bates = (o.batesPrefix ?? "") + String((o.batesStart ?? 1) + k).padStart(o.batesDigits ?? 6, "0");
    const text = expandTemplate(o.text, { page: pi + 1, pages: n, file: o.fileName ?? "", bates, date });
    const tw = width(text);
    let tm: mupdf.Matrix;
    if (o.position === "diagonal") {
      const ang = Math.atan2(H, W);
      const c = Math.cos(ang), s = Math.sin(ang);
      // centre the text's baseline midpoint on the page centre
      tm = [c, s, -s, c, W / 2 - (c * tw) / 2 + (s * size) / 3, H / 2 - (s * tw) / 2 - (c * size) / 3];
    } else {
      const [v, h] = o.position === "center" ? ["middle", "center"] : o.position.split("-");
      const x = h === "left" ? margin : h === "right" ? W - margin - tw : (W - tw) / 2;
      const y = v === "top" ? H - margin - size * 0.8 : v === "bottom" ? margin : H / 2 - size / 3;
      tm = [1, 0, 0, 1, x, y];
    }
    const obj = page.getObject();
    let res = obj.get("Resources");
    if (res.isNull()) {
      // Resources inherited from the page tree: give this page its own shallow copy.
      const inherited = obj.getInheritable("Resources");
      res = doc.newDictionary();
      if (!inherited.isNull()) inherited.forEach((v, key) => res.put(key as string, v));
      obj.put("Resources", res);
    }
    const fonts = ensureDict(doc, res, "Font");
    const states = ensureDict(doc, res, "ExtGState");
    fonts.put(`F${tag}`, fontRef);
    states.put(`GS${tag}`, gs);
    const f = (m: number[]) => m.map((x) => +x.toFixed(4)).join(" ");
    const content = `Q q ${f(toUser)} cm /GS${tag} gs ${r} ${g} ${b} rg BT /F${tag} ${size} Tf ${f(tm)} Tm ${pdfString(text)} Tj ET Q`;
    wrapContents(doc, obj, content);
    page.destroy();
  });
  return pages.length;
}

function ensureDict(doc: mupdf.PDFDocument, parent: mupdf.PDFObject, key: string): mupdf.PDFObject {
  let d = parent.get(key);
  if (d.isNull()) {
    d = doc.newDictionary();
    parent.put(key, d);
  }
  return d;
}

/** Wrap existing page content in q…Q and append our drawing so it can't be affected by leftover state. */
function wrapContents(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject, append: string) {
  const old = pageObj.get("Contents");
  const arr = doc.newArray();
  arr.push(doc.addStream("q\n", {}));
  if (old.isArray()) old.forEach((v) => arr.push(v));
  else if (!old.isNull()) arr.push(old);
  arr.push(doc.addStream("\n" + append + "\n", {}));
  pageObj.put("Contents", arr);
}
