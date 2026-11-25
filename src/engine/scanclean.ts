// Scan cleanup before OCR: straighten crooked pages, remove specks of dust and toner, drop blank pages.
// The pixel work is plain TypeScript on 8-bit buffers (testable without the PDF engine); the last part
// renders scanned pages with mupdf and writes the cleaned image back as the page's only content.
import * as mupdf from "mupdf";
import { textChars } from "./ocr";

// ---------- Pixel helpers (gray = 1 byte per pixel, 0 black … 255 white) ----------

/** Otsu's threshold: the gray level that best separates ink from paper. */
export function otsu(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) (best = between), (thr = t);
  }
  return thr;
}

/** Ink threshold: Otsu, but never so light that paper texture or show-through counts as ink. */
export function inkThreshold(gray: Uint8Array): number {
  return Math.min(otsu(gray), 160);
}

/** Halfway between the ink threshold and the paper (the most common light gray). */
export function speckThreshold(gray: Uint8Array): number {
  const t = inkThreshold(gray);
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let paper = 255;
  for (let v = t + 1, most = -1; v < 256; v++) if (hist[v] > most) (most = hist[v]), (paper = v);
  return Math.round((t + paper) / 2);
}

/** Connected ink blobs (8-connected). Calls `each` with the pixel indices of every blob. */
function blobs(ink: Uint8Array, w: number, h: number, each: (px: Int32Array, n: number, box: [number, number, number, number]) => void) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    let top = 0, n = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[top++] = start;
    seen[start] = 1;
    const list: number[] = [];
    while (top) {
      const p = stack[--top];
      list.push(p);
      n++;
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (ink[q] && !seen[q]) (seen[q] = 1), (stack[top++] = q);
        }
      }
    }
    each(Int32Array.from(list), n, [x0, y0, x1, y1]);
  }
}

/**
 * Specks: small blobs with no other ink nearby. Full stops and the dots on i and j sit right next to
 * letters, so they survive; dust and toner spots in white space don't.
 * Returns the pixel indices to whiten.
 */
export function findSpecks(gray: Uint8Array, w: number, h: number, o: { maxArea: number; clearance: number; threshold?: number }): number[] {
  // Specks are often fainter than text, so look for them halfway between ink and paper.
  const thr = o.threshold ?? speckThreshold(gray);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] <= thr ? 1 : 0;
  // Integral image of ink so "any other ink near this blob?" is O(1).
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += ink[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const count = (x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, x0), y0 = Math.max(0, y0), x1 = Math.min(w - 1, x1), y1 = Math.min(h - 1, y1);
    return sat[(y1 + 1) * (w + 1) + x1 + 1] - sat[y0 * (w + 1) + x1 + 1] - sat[(y1 + 1) * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
  };
  const out: number[] = [];
  const c = o.clearance;
  blobs(ink, w, h, (px, n, [x0, y0, x1, y1]) => {
    if (n > o.maxArea) return;
    // The blob's own pixels are all inside its box, so anything more than n is other ink.
    if (count(x0 - c, y0 - c, x1 + c, y1 + c) > n) return;
    for (let k = 0; k < n; k++) out.push(px[k]);
  });
  return out;
}

/**
 * Skew in degrees (positive = text runs downhill to the right, clockwise on screen) from the
 * projection profile: rows of text line up best when the page is straight.
 * Returns 0 when there isn't enough text to tell.
 */
export function estimateSkew(gray: Uint8Array, w: number, h: number, maxDeg = 7): number {
  const thr = inkThreshold(gray);
  const xs: number[] = [], ys: number[] = [];
  // Ignore a margin so dark scanner edges don't dominate.
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.03);
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) if (gray[y * w + x] <= thr) xs.push(x), ys.push(y);
  if (xs.length < 200) return 0;
  const cx = w / 2;
  const bins = new Float64Array(h * 2 + 4);
  const score = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] - (xs[i] - cx) * t) + h]++;
    let s = 0;
    for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
    return s;
  };
  let best = 0, bestScore = score(0);
  const zero = bestScore;
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += 0.25) {
    const s = score(d);
    if (s > bestScore) (bestScore = s), (best = d);
  }
  const coarse = best;
  for (let d = coarse - 0.25; d <= coarse + 0.25 + 1e-9; d += 0.02) {
    const s = score(d);
    if (s > bestScore) (bestScore = s), (best = d);
  }
  // Pictures and blank pages give flat profiles: only trust a clear improvement.
  if (bestScore < zero * 1.05) return 0;
  return Math.round(best * 100) / 100;
}

/** Rotate an image about its centre (same size, white fill), bilinear. `deg` positive = clockwise. */
export function rotateImage(src: Uint8Array, w: number, h: number, n: number, deg: number): Uint8Array {
  const out = new Uint8Array(src.length).fill(255);
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse map: where in the source does this output pixel come from?
      const dx = x - cx, dy = y - cy;
      const sx = cos * dx + sin * dy + cx, sy = -sin * dx + cos * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * n, i10 = i00 + n, i01 = i00 + w * n, i11 = i01 + n;
      const o = (y * w + x) * n;
      for (let c = 0; c < n; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy + 0.5;
      }
    }
  }
  return out;
}

/** Share of the page (inside a 5% margin) covered by ink that isn't specks. */
export function inkCoverage(gray: Uint8Array, w: number, h: number, maxSpeck: number): number {
  const mx = Math.round(w * 0.05), my = Math.round(h * 0.05);
  const iw = w - 2 * mx, ih = h - 2 * my;
  if (iw <= 0 || ih <= 0) return 0;
  const inner = new Uint8Array(iw * ih);
  for (let y = 0; y < ih; y++) inner.set(gray.subarray((y + my) * w + mx, (y + my) * w + mx + iw), y * iw);
  // A fixed threshold: on a blank page Otsu would split paper texture into "ink".
  const ink = new Uint8Array(inner.length);
  for (let i = 0; i < ink.length; i++) ink[i] = inner[i] < 128 ? 1 : 0;
  let total = 0;
  blobs(ink, iw, ih, (_px, n) => {
    if (n > maxSpeck) total += n;
  });
  return total / inner.length;
}

/** Below this share of ink a page counts as blank (a single short line of text is about 0.05%). */
export const BLANK_COVERAGE = 0.0002;

/** 1-bit PBM (P4) so bilevel pages stay small and crisp in the PDF. */
export function toPbm(gray: Uint8Array, w: number, h: number, thr = 128): Uint8Array {
  const head = new TextEncoder().encode(`P4\n${w} ${h}\n`);
  const rowBytes = (w + 7) >> 3;
  const out = new Uint8Array(head.length + rowBytes * h);
  out.set(head);
  for (let y = 0; y < h; y++) {
    const base = head.length + y * rowBytes;
    for (let x = 0; x < w; x++) if (gray[y * w + x] < thr) out[base + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

// ---------- Pages ----------

export interface CleanOptions {
  straighten?: boolean;
  despeckle?: boolean;
  removeBlank?: boolean;
  /** Resolution used for the cleaned image. */
  dpi?: number;
}

export interface CleanReport {
  straightened: { page: number; degrees: number }[];
  despeckled: number[];
  /** Blank pages that were removed (indices before removal). */
  removed: number[];
  /** Pages left alone because they have real text (not scans). */
  skipped: number[];
}

function render(page: mupdf.Page, scale: number, cs: mupdf.ColorSpace) {
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), cs, false, true);
  try {
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride();
    const raw = pix.getPixels();
    const data = new Uint8Array(w * h * n);
    for (let y = 0; y < h; y++) data.set(raw.subarray(y * stride, y * stride + w * n), y * w * n);
    return { data, w, h, n };
  } finally {
    pix.destroy();
  }
}

function toGray(data: Uint8Array, n: number): Uint8Array {
  if (n === 1) return data;
  const g = new Uint8Array(data.length / n);
  for (let i = 0, j = 0; i < g.length; i++, j += n) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}

/** Colour if a noticeable share of pixels is clearly not grey. */
function isColour(rgb: Uint8Array): boolean {
  let coloured = 0;
  const px = rgb.length / 3;
  for (let j = 0; j < rgb.length; j += 3) {
    const r = rgb[j], g = rgb[j + 1], b = rgb[j + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) coloured++;
  }
  return coloured > px * 0.005;
}

/** Nearly every pixel is black or white: a black-and-white scan. */
function isBilevel(gray: Uint8Array): boolean {
  let mid = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] > 48 && gray[i] < 208) mid++;
  return mid < gray.length * 0.02;
}

/** Make the page show only `image`, filling a w×h point page. */
function replacePage(doc: mupdf.PDFDocument, pageIndex: number, image: mupdf.Image, w: number, h: number) {
  const obj = doc.findPage(pageIndex);
  const f = (v: number) => +v.toFixed(3);
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Scan", doc.addImage(image));
  res.put("XObject", xo);
  obj.put("Resources", res);
  obj.put("Contents", doc.addStream(`q ${f(w)} 0 0 ${f(h)} 0 0 cm /Scan Do Q`, {}));
  obj.put("MediaBox", [0, 0, f(w), f(h)]);
  for (const k of ["CropBox", "TrimBox", "BleedBox", "ArtBox", "Rotate"]) obj.delete(k);
}

/** Clean scanned pages. Pages with real text are skipped: they aren't scans and would lose their text. */
export function cleanScans(doc: mupdf.PDFDocument, pages: number[], o: CleanOptions = {}): CleanReport {
  const rep: CleanReport = { straightened: [], despeckled: [], removed: [], skipped: [] };
  const dpi = o.dpi ?? 300;
  for (const i of pages) {
    const page = doc.loadPage(i);
    try {
      if (textChars(page) >= 10) {
        rep.skipped.push(i);
        continue;
      }
      const [x0, y0, x1, y1] = page.getBounds();
      const pw = x1 - x0, ph = y1 - y0;
      // A quick look at 100 dpi decides what the page needs.
      const look = render(page, 100 / 72, mupdf.ColorSpace.DeviceRGB);
      const lookGray = toGray(look.data, 3);
      if (o.removeBlank && inkCoverage(lookGray, look.w, look.h, 6) < BLANK_COVERAGE) {
        rep.removed.push(i);
        continue;
      }
      const skew = o.straighten ? estimateSkew(lookGray, look.w, look.h) : 0;
      const turn = Math.abs(skew) >= 0.15 ? skew : 0;
      if (!turn && !o.despeckle) continue;

      const colour = isColour(look.data);
      const scale = Math.min(dpi / 72, Math.sqrt(25e6 / Math.max(1, pw * ph)));
      const full = render(page, scale, colour ? mupdf.ColorSpace.DeviceRGB : mupdf.ColorSpace.DeviceGray);
      let data: Uint8Array = full.data;
      const { w, h, n } = full;
      const bilevel = !colour && isBilevel(data);
      if (turn) data = rotateImage(data, w, h, n, -turn);
      let specks = 0;
      if (o.despeckle) {
        const px = scale * 72; // pixels per inch of the cleaned image
        const gray = n === 1 ? data : toGray(data, n);
        // Specks up to about 0.7 mm across, at least 1.6 mm from any other ink (so punctuation next to letters stays).
        const found = findSpecks(gray, w, h, { maxArea: Math.max(4, Math.round((px / 300) ** 2 * 60)), clearance: Math.max(3, Math.round(px / 16)) });
        for (const p of found) for (let c = 0; c < n; c++) data[p * n + c] = 255;
        specks = found.length;
      }
      if (!turn && !specks) continue;

      let image: mupdf.Image;
      if (bilevel) {
        image = new mupdf.Image(toPbm(data, w, h));
      } else {
        const pix = new mupdf.Pixmap(n === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
        const dst = pix.getPixels();
        const stride = pix.getStride();
        for (let y = 0; y < h; y++) dst.set(data.subarray(y * w * n, (y + 1) * w * n), y * stride);
        const jpg = pix.asJPEG(85);
        pix.destroy();
        image = new mupdf.Image(jpg);
      }
      page.destroy();
      replacePage(doc, i, image, pw, ph);
      if (turn) rep.straightened.push({ page: i, degrees: turn });
      if (specks) rep.despeckled.push(i);
      continue;
    } finally {
      try { page.destroy(); } catch { /* already released */ }
    }
  }
  // Never remove every page.
  if (rep.removed.length >= doc.countPages()) rep.removed = rep.removed.slice(1);
  for (const i of [...rep.removed].sort((a, b) => b - a)) doc.deletePage(i);
  return rep;
}
