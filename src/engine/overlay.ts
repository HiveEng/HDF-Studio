// Drawing revision checks: overlay two versions in two colours (old red, new blue, unchanged
// black) or set them side by side on one sheet so zoom and scroll stay in step.
// Both are built as vector PDFs: each source page becomes a form XObject, so lines stay crisp
// at any zoom. The overlay colours each version with a luminosity soft mask (ink → colour)
// and combines them with Multiply, so where both versions have ink the result is dark.
import * as mupdf from "mupdf";

export type OverlayColors = "red-blue" | "red-green";
export type Align = "corner" | "center" | "auto";

export interface OverlayOptions {
  /** Pairs [old page, new page]; default: page i with page i. */
  pairs?: [number, number][];
  colors?: OverlayColors;
  align?: Align;
  oldName?: string;
  newName?: string;
}

type Pdf = mupdf.PDFDocument;
type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const arr = (doc: Pdf, v: number[]) => {
  const a = doc.newArray();
  for (const n of v) a.push(doc.newReal(+n.toFixed(5)));
  return a;
};
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

/** A source page as a form XObject in `out`, drawn in the page's display space (y down) under `place`. */
function pageForm(out: Pdf, map: mupdf.PDFGraftMap, src: Pdf, index: number, place: M): { form: mupdf.PDFObject; w: number; h: number } {
  const page = src.loadPage(index) as mupdf.PDFPage;
  try {
    const [, , w, h] = page.getBounds();
    const pobj = page.getObject();
    const mb = pobj.getInheritable("MediaBox");
    const box = [0, 1, 2, 3].map((i) => mb.get(i).asNumber());
    // Concatenate the content streams.
    const contents = pobj.get("Contents");
    const parts: string[] = [];
    const read = (s: mupdf.PDFObject) => parts.push(s.readStream().asString());
    if (contents.isArray()) for (let i = 0; i < contents.length; i++) read(contents.get(i));
    else if (contents.isStream()) read(contents);
    const d = out.newDictionary();
    d.put("Type", out.newName("XObject"));
    d.put("Subtype", out.newName("Form"));
    d.put("BBox", arr(out, box));
    d.put("Matrix", arr(out, mul(Array.from(page.getTransform()) as M, place)));
    const res = pobj.getInheritable("Resources");
    d.put("Resources", res.isNull() ? out.newDictionary() : map.graftObject(res));
    const g = out.newDictionary();
    g.put("S", out.newName("Transparency"));
    g.put("CS", out.newName("DeviceRGB"));
    d.put("Group", g);
    // Each part on its own line so a missing trailing newline can't glue two operators together.
    return { form: out.addStream(latin1("0 g 0 G\n" + parts.join("\n")), d), w, h };
  } finally {
    page.destroy();
  }
}

/** ExtGState whose soft mask is the ink of `form` (dark ink → opaque, paper → clear). */
function inkMask(out: Pdf, form: mupdf.PDFObject, multiply: boolean): mupdf.PDFObject {
  const tr = out.newDictionary();
  tr.put("FunctionType", out.newInteger(2));
  tr.put("Domain", arr(out, [0, 1]));
  tr.put("C0", arr(out, [1]));
  tr.put("C1", arr(out, [0]));
  tr.put("N", out.newReal(1));
  const sm = out.newDictionary();
  sm.put("Type", out.newName("Mask"));
  sm.put("S", out.newName("Luminosity"));
  sm.put("G", form);
  sm.put("BC", arr(out, [1, 1, 1]));
  sm.put("TR", out.addObject(tr));
  const gs = out.newDictionary();
  gs.put("Type", out.newName("ExtGState"));
  gs.put("SMask", sm);
  if (multiply) gs.put("BM", out.newName("Multiply"));
  return out.addObject(gs);
}

function helv(out: Pdf) {
  const f = out.newDictionary();
  f.put("Type", out.newName("Font"));
  f.put("Subtype", out.newName("Type1"));
  f.put("BaseFont", out.newName("Helvetica"));
  f.put("Encoding", out.newName("WinAnsiEncoding"));
  return out.addObject(f);
}
const pdfStr = (s: string) => "(" + s.replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1") + ")";

/** Best shift (display points) to move the old page onto the new one, by matching ink at low resolution. */
export function autoAlign(oldDoc: Pdf, oldIndex: number, newDoc: Pdf, newIndex: number): [number, number] {
  const ink = (doc: Pdf, i: number, scale: number) => {
    const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
    const w = pix.getWidth(), h = pix.getHeight(), px = pix.getPixels();
    const on = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) on[k] = px[k] < 160 ? 1 : 0;
    pix.destroy();
    return { w, h, on };
  };
  const search = (scale: number, R: number, cx: number, cy: number): [number, number] => {
    const a = ink(oldDoc, oldIndex, scale), b = ink(newDoc, newIndex, scale);
    // Sample old ink pixels (cap the count so big drawings stay fast).
    const pts: number[] = [];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.on[y * a.w + x]) pts.push(x, y);
    const step = Math.max(1, Math.floor(pts.length / 2 / 6000)) * 2;
    let best = -1, bx = cx, by = cy;
    for (let dy = cy - R; dy <= cy + R; dy++)
      for (let dx = cx - R; dx <= cx + R; dx++) {
        let n = 0;
        for (let k = 0; k < pts.length; k += step) {
          const x = pts[k] + dx, y = pts[k + 1] + dy;
          if (x >= 0 && y >= 0 && x < b.w && y < b.h && b.on[y * b.w + x]) n++;
        }
        // Prefer the smaller shift on ties.
        if (n > best || (n === best && Math.abs(dx) + Math.abs(dy) < Math.abs(bx) + Math.abs(by))) (best = n), (bx = dx), (by = dy);
      }
    return [bx, by];
  };
  const [w] = Array.from(oldDoc.loadPage(oldIndex).getBounds()).slice(2);
  const coarse = 150 / w; // about 150 px across
  const [cx, cy] = search(coarse, 12, 0, 0);
  const fine = 4 * coarse;
  const [fx, fy] = search(fine, 4, cx * 4, cy * 4);
  return [fx / fine, fy / fine];
}

const pairsOf = (oldDoc: Pdf, newDoc: Pdf, o: OverlayOptions): [number, number][] =>
  o.pairs ?? [...Array(Math.min(oldDoc.countPages(), newDoc.countPages())).keys()].map((i) => [i, i]);

/** Overlay: one page per pair, old in red and new in blue (or green); unchanged ink shows dark. */
export function overlayPdf(oldDoc: Pdf, newDoc: Pdf, o: OverlayOptions = {}): { data: Uint8Array; shifts: [number, number][] } {
  const out = new mupdf.PDFDocument();
  const mOld = out.newGraftMap(), mNew = out.newGraftMap();
  const [newRgb] = [o.colors === "red-green" ? "0 0.6 0" : "0 0.35 1"];
  const shifts: [number, number][] = [];
  for (const [oi, ni] of pairsOf(oldDoc, newDoc, o)) {
    const nb = Array.from(newDoc.loadPage(ni).getBounds()), ob = Array.from(oldDoc.loadPage(oi).getBounds());
    const W = nb[2] - nb[0], H = nb[3] - nb[1];
    let shift: [number, number] = [0, 0];
    if (o.align === "center") shift = [(W - (ob[2] - ob[0])) / 2, (H - (ob[3] - ob[1])) / 2];
    else if (o.align === "auto") shift = autoAlign(oldDoc, oi, newDoc, ni);
    shifts.push(shift);
    const flip: M = [1, 0, 0, -1, 0, H];
    const fOld = pageForm(out, mOld, oldDoc, oi, mul([1, 0, 0, 1, shift[0], shift[1]], flip)).form;
    const fNew = pageForm(out, mNew, newDoc, ni, flip).form;
    const res = out.newDictionary();
    const gs = out.newDictionary();
    gs.put("Old", inkMask(out, fOld, false));
    gs.put("New", inkMask(out, fNew, true));
    res.put("ExtGState", gs);
    const cs = `1 1 1 rg 0 0 ${W} ${H} re f\nq /Old gs 0.9 0 0 rg 0 0 ${W} ${H} re f Q\nq /New gs ${newRgb} rg 0 0 ${W} ${H} re f Q\n`;
    const page = out.addPage([0, 0, W, H], 0, res, cs);
    out.insertPage(-1, page);
  }
  return { data: out.saveToBuffer("compress").asUint8Array(), shifts };
}

/** Side by side: old on the left, new on the right, on one sheet, with a caption over each. */
export function sideBySidePdf(oldDoc: Pdf, newDoc: Pdf, o: OverlayOptions = {}): Uint8Array {
  const out = new mupdf.PDFDocument();
  const mOld = out.newGraftMap(), mNew = out.newGraftMap();
  const font = helv(out);
  for (const [oi, ni] of pairsOf(oldDoc, newDoc, o)) {
    const ob = Array.from(oldDoc.loadPage(oi).getBounds()), nb = Array.from(newDoc.loadPage(ni).getBounds());
    const ow = ob[2] - ob[0], oh = ob[3] - ob[1], nw = nb[2] - nb[0], nh = nb[3] - nb[1];
    const gap = Math.max(18, Math.max(ow, nw) * 0.03), cap = Math.max(14, Math.max(ow, nw) * 0.02);
    const W = ow + gap + nw, H = Math.max(oh, nh) + cap * 2;
    const fOld = pageForm(out, mOld, oldDoc, oi, [1, 0, 0, -1, 0, H - cap * 2]).form;
    const fNew = pageForm(out, mNew, newDoc, ni, [1, 0, 0, -1, ow + gap, H - cap * 2]).form;
    const res = out.newDictionary();
    const xo = out.newDictionary();
    xo.put("Old", fOld);
    xo.put("New", fNew);
    res.put("XObject", xo);
    const fonts = out.newDictionary();
    fonts.put("F", font);
    res.put("Font", fonts);
    const size = cap * 0.7;
    const label = (x: number, text: string) => `BT /F ${size.toFixed(2)} Tf ${x.toFixed(2)} ${(H - cap * 1.35).toFixed(2)} Td ${pdfStr(text)} Tj ET\n`;
    let cs = `0.94 0.94 0.94 rg 0 0 ${W} ${H} re f\n1 1 1 rg 0 ${H - cap * 2 - oh} ${ow} ${oh} re f ${ow + gap} ${H - cap * 2 - nh} ${nw} ${nh} re f\n`;
    cs += `q 0 g 0 G /Old Do Q q 0 g 0 G /New Do Q\n0.8 0.1 0.1 rg ${label(cap * 0.5, `OLD: ${o.oldName ?? "older version"}  (page ${oi + 1})`)}0.05 0.3 0.8 rg ${label(ow + gap + cap * 0.5, `NEW: ${o.newName ?? "newer version"}  (page ${ni + 1})`)}`;
    out.insertPage(-1, out.addPage([0, 0, W, H], 0, res, cs));
  }
  return out.saveToBuffer("compress").asUint8Array();
}
