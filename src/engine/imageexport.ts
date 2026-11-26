// Pages to image files for CAD (AutoCAD IMAGEATTACH, Revit, Civil 3D) and everything else:
// PNG, JPEG, TIFF and BMP, colour / grey / black-and-white, optional transparent background,
// the resolution written into the file so images insert at paper size, optional trim of white
// margins, and a world file (.pgw/.jgw/.tfw/.bpw) at the page's drawing scale when one is set.
import * as mupdf from "mupdf";
import type { Scale } from "./measure";

export type RasterFormat = "png" | "jpg" | "tif" | "bmp";
export type RasterColour = "rgb" | "gray" | "bw";

export interface RasterOptions {
  format: RasterFormat;
  dpi: number;
  colour?: RasterColour;
  /** Leave the page background transparent (PNG and TIFF). */
  transparent?: boolean;
  /** Crop white margins (keeps a small border). */
  trim?: boolean;
  /** JPEG quality 1–100. */
  quality?: number;
  /** Black-and-white cut-off, 0–255 (darker is black). */
  threshold?: number;
}

export interface RasterPage {
  page: number;
  data: Uint8Array;
  width: number;
  height: number;
  /** Resolution actually used (lowered if the page was too big). */
  dpi: number;
  /** World file text when the page has a drawing scale. */
  world?: string;
  /** Real-world units per pixel and the unit name, when the page has a drawing scale. */
  real?: { perPixel: number; unit: string; width: number; height: number };
}

/** Largest image we render, in pixels (memory stays well under a gigabyte). */
export const MAX_PIXELS = 120e6;

export const EXT: Record<RasterFormat, string> = { png: "png", jpg: "jpg", tif: "tif", bmp: "bmp" };
/** World-file extension convention: first and last letter of the image extension, plus w. */
export const WORLD_EXT: Record<RasterFormat, string> = { png: "pgw", jpg: "jgw", tif: "tfw", bmp: "bpw" };

/** Plain image: tightly packed rows, n channels (1 gray, 2 gray+alpha, 3 RGB, 4 RGBA). */
export interface Raster { w: number; h: number; n: number; px: Uint8Array; dpi: number }

// ---------- Encoders ----------

function packBits(row: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run > 1) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < row.length && i - start < 128 && !(i + 1 < row.length && row[i] === row[i + 1])) i++;
    out.push(i - start - 1);
    for (let k = start; k < i; k++) out.push(row[k]);
  }
  return out;
}

/** Baseline TIFF, PackBits compression, one strip per row block. 1-bit when `bilevel`. */
export function encodeTiff(r: Raster, bilevel = false): Uint8Array {
  const { w, h, n } = r;
  const bps = bilevel ? 1 : 8;
  const rowBytes = bilevel ? (w + 7) >> 3 : w * n;
  const rowsPerStrip = Math.max(1, Math.floor(65536 / rowBytes));
  const strips: Uint8Array[] = [];
  for (let y0 = 0; y0 < h; y0 += rowsPerStrip) {
    const parts: number[] = [];
    for (let y = y0; y < Math.min(h, y0 + rowsPerStrip); y++) {
      let row: Uint8Array;
      if (bilevel) {
        row = new Uint8Array(rowBytes);
        // BlackIsZero would need inverted bits; WhiteIsZero (0) makes 1 = black.
        for (let x = 0; x < w; x++) if (r.px[y * w + x] < 128) row[x >> 3] |= 0x80 >> (x & 7);
      } else row = r.px.subarray(y * rowBytes, (y + 1) * rowBytes);
      for (const b of packBits(row)) parts.push(b & 0xff);
    }
    strips.push(Uint8Array.from(parts));
  }
  const photometric = bilevel ? 0 : n <= 2 ? 1 : 2;
  const tags: [number, number, number, number[]][] = []; // tag, type (3 SHORT, 4 LONG, 5 RATIONAL), count, values
  const S = 3, L = 4, R = 5;
  tags.push([256, L, 1, [w]], [257, L, 1, [h]]);
  tags.push([258, S, bilevel ? 1 : n, Array(bilevel ? 1 : n).fill(bps)]);
  tags.push([259, S, 1, [32773]], [262, S, 1, [photometric]]);
  tags.push([273, L, strips.length, []]); // offsets filled below
  tags.push([277, S, 1, [bilevel ? 1 : n]], [278, L, 1, [rowsPerStrip]]);
  tags.push([279, L, strips.length, strips.map((s) => s.length)]);
  tags.push([282, R, 1, [Math.round(r.dpi * 100), 100]], [283, R, 1, [Math.round(r.dpi * 100), 100]]);
  tags.push([284, S, 1, [1]], [296, S, 1, [2]]);
  if (!bilevel && (n === 2 || n === 4)) tags.push([338, S, 1, [2]]); // unassociated alpha
  tags.sort((a, b) => a[0] - b[0]);
  const size = (t: number) => (t === S ? 2 : t === L ? 4 : 8);
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 8 + ifdSize;
  const extraAt = new Map<number, number>();
  for (const [tag, type, count] of tags) {
    if (size(type) * count > 4 && tag !== 273) (extraAt.set(tag, extra), (extra += size(type) * count));
  }
  if (strips.length > 1) (extraAt.set(273, extra), (extra += 4 * strips.length));
  let dataAt = extra;
  const offsets = strips.map((s) => ((dataAt += s.length), dataAt - s.length));
  tags.find((t) => t[0] === 273)![3] = offsets;
  const out = new Uint8Array(dataAt);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  let p = 8;
  dv.setUint16(p, tags.length, true);
  p += 2;
  const put = (at: number, type: number, v: number[]) => {
    for (let i = 0; i < v.length; i++) {
      if (type === S) dv.setUint16(at + i * 2, v[i], true);
      else dv.setUint32(at + i * 4, v[i], true);
    }
  };
  for (const [tag, type, count, v] of tags) {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    if (extraAt.has(tag)) {
      dv.setUint32(p + 8, extraAt.get(tag)!, true);
      put(extraAt.get(tag)!, type, v);
    } else put(p + 8, type, v);
    p += 12;
  }
  dv.setUint32(p, 0, true);
  let at = extra;
  for (const s of strips) out.set(s, at), (at += s.length);
  return out;
}

/** Windows BMP: 24-bit colour, 8-bit grey palette or 1-bit black and white. No transparency. */
export function encodeBmp(r: Raster, bilevel = false): Uint8Array {
  const { w, h } = r;
  const flat = flatten(r);
  const n = flat.n;
  const bits = bilevel ? 1 : n === 1 ? 8 : 24;
  const palette = bits === 24 ? 0 : 1 << bits;
  const rowBytes = (((w * bits + 31) >> 5) << 2);
  const off = 14 + 40 + palette * 4;
  const out = new Uint8Array(off + rowBytes * h);
  const dv = new DataView(out.buffer);
  out.set([0x42, 0x4d]);
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, off, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, bits, true);
  dv.setUint32(34, rowBytes * h, true);
  const ppm = Math.round(r.dpi / 0.0254);
  dv.setInt32(38, ppm, true);
  dv.setInt32(42, ppm, true);
  dv.setUint32(46, palette, true);
  for (let i = 0; i < palette; i++) {
    const v = bits === 1 ? i * 255 : i;
    out.set([v, v, v, 0], 54 + i * 4);
  }
  for (let y = 0; y < h; y++) {
    const base = off + (h - 1 - y) * rowBytes; // bottom-up rows
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * n;
      if (bits === 24) out.set([flat.px[s + 2], flat.px[s + 1], flat.px[s]], base + x * 3);
      else if (bits === 8) out[base + x] = flat.px[s];
      else if (flat.px[s] >= 128) out[base + (x >> 3)] |= 0x80 >> (x & 7); // palette 1 = white
    }
  }
  return out;
}

/** Drop alpha onto white. */
function flatten(r: Raster): Raster {
  if (r.n !== 2 && r.n !== 4) return r;
  const c = r.n - 1;
  const px = new Uint8Array(r.w * r.h * c);
  for (let i = 0, j = 0; i < px.length; i += c, j += r.n) {
    const a = r.px[j + c] / 255;
    for (let k = 0; k < c; k++) px[i + k] = r.px[j + k] * a + 255 * (1 - a) + 0.5;
  }
  return { ...r, n: c, px };
}

function toPixmap(r: Raster): mupdf.Pixmap {
  const cs = r.n <= 2 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const alpha = r.n === 2 || r.n === 4;
  const pix = new mupdf.Pixmap(cs, [0, 0, r.w, r.h], alpha);
  const dst = pix.getPixels(), stride = pix.getStride(), row = r.w * r.n;
  for (let y = 0; y < r.h; y++) dst.set(r.px.subarray(y * row, (y + 1) * row), y * stride);
  pix.setResolution(Math.round(r.dpi), Math.round(r.dpi));
  return pix;
}

export function encode(r: Raster, o: RasterOptions): Uint8Array {
  const bilevel = o.colour === "bw" && r.n === 1;
  if (o.format === "tif") return encodeTiff(r, bilevel);
  if (o.format === "bmp") return encodeBmp(r, bilevel);
  const pix = toPixmap(o.format === "jpg" ? flatten(r) : r);
  try {
    return new Uint8Array(o.format === "jpg" ? pix.asJPEG(o.quality ?? 90) : pix.asPNG());
  } finally {
    pix.destroy();
  }
}

// ---------- Pixels ----------

/** Make black and white: below the threshold black, else white (or transparent). */
export function threshold(r: Raster, t = 160): Raster {
  const alpha = r.n === 2 || r.n === 4;
  const c = alpha ? r.n - 1 : r.n;
  const n = alpha ? 2 : 1;
  const px = new Uint8Array(r.w * r.h * n);
  for (let i = 0, j = 0; i < px.length; i += n, j += r.n) {
    const g = c === 1 ? r.px[j] : (r.px[j] * 77 + r.px[j + 1] * 150 + r.px[j + 2] * 29) >> 8;
    const a = alpha ? r.px[j + c] : 255;
    const ink = a >= 128 && g < t;
    px[i] = ink ? 0 : 255;
    if (alpha) px[i + 1] = ink ? 255 : 0;
  }
  return { ...r, n, px };
}

/** Bounding box of everything that isn't white (or transparent), or null for an empty page. */
export function contentBox(r: Raster): [number, number, number, number] | null {
  const alpha = r.n === 2 || r.n === 4;
  const c = alpha ? r.n - 1 : r.n;
  let x0 = r.w, y0 = r.h, x1 = -1, y1 = -1;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const j = (y * r.w + x) * r.n;
      let mark = alpha ? r.px[j + c] > 16 : false;
      if (!alpha) for (let k = 0; k < c; k++) if (r.px[j + k] < 240) mark = true;
      if (mark) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

export function crop(r: Raster, [x0, y0, x1, y1]: [number, number, number, number]): Raster {
  const w = x1 - x0, h = y1 - y0;
  const px = new Uint8Array(w * h * r.n);
  for (let y = 0; y < h; y++) px.set(r.px.subarray(((y0 + y) * r.w + x0) * r.n, ((y0 + y) * r.w + x1) * r.n), y * w * r.n);
  return { ...r, w, h, px };
}

// ---------- Pages ----------

const UNIT_PER_INCH: Record<string, [number, string]> = {
  "ft-in": [1 / 12, "ft"], ft: [1 / 12, "ft"], in: [1, "in"], m: [0.0254, "m"], cm: [2.54, "cm"], mm: [25.4, "mm"],
};

/** World file: pixel size and the centre of the top-left pixel, with the page's bottom-left corner at 0,0. */
export function worldFile(perPixel: number, x0px: number, y0px: number, pageHeightPx: number): string {
  const f = (v: number) => v.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return [f(perPixel), "0", "0", f(-perPixel), f((x0px + 0.5) * perPixel), f((pageHeightPx - y0px - 0.5) * perPixel)].join("\r\n") + "\r\n";
}

export function rasterPages(doc: mupdf.Document, pages: number[], o: RasterOptions, scaleOf?: (page: number) => Scale | null): RasterPage[] {
  return pages.map((i) => {
    const page = doc.loadPage(i);
    try {
      const [bx0, by0, bx1, by1] = page.getBounds();
      const wPt = bx1 - bx0, hPt = by1 - by0;
      let dpi = o.dpi;
      if ((wPt * dpi / 72) * (hPt * dpi / 72) > MAX_PIXELS) dpi = Math.floor(72 * Math.sqrt(MAX_PIXELS / (wPt * hPt)));
      const s = dpi / 72;
      const transparent = !!o.transparent && o.format !== "jpg" && o.format !== "bmp";
      const cs = o.colour === "rgb" || !o.colour ? mupdf.ColorSpace.DeviceRGB : mupdf.ColorSpace.DeviceGray;
      const pix = page.toPixmap([s, 0, 0, s, -bx0 * s, -by0 * s], cs, transparent, true);
      let r: Raster;
      try {
        const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride();
        const raw = pix.getPixels();
        const px = new Uint8Array(w * h * n);
        for (let y = 0; y < h; y++) px.set(raw.subarray(y * stride, y * stride + w * n), y * w * n);
        r = { w, h, n, px, dpi };
      } finally {
        pix.destroy();
      }
      const fullH = r.h;
      if (o.colour === "bw") r = threshold(r, o.threshold ?? 160);
      let x0 = 0, y0 = 0;
      if (o.trim) {
        const box = contentBox(r);
        if (box) {
          const pad = Math.round(dpi / 10); // a tenth of an inch
          const b: [number, number, number, number] = [Math.max(0, box[0] - pad), Math.max(0, box[1] - pad), Math.min(r.w, box[2] + pad), Math.min(r.h, box[3] + pad)];
          [x0, y0] = b;
          r = crop(r, b);
        }
      }
      const out: RasterPage = { page: i, data: encode(r, o), width: r.w, height: r.h, dpi };
      const sc = scaleOf?.(i);
      if (sc) {
        const [per, unit] = UNIT_PER_INCH[sc.unit] ?? [1, "in"];
        const perPixel = (sc.k * 72 / dpi) * per; // real inches per pixel, in the drawing's unit
        out.real = { perPixel, unit, width: r.w * perPixel, height: r.h * perPixel };
        out.world = worldFile(perPixel, x0, y0, fullH);
      }
      return out;
    } finally {
      page.destroy();
    }
  });
}

/** A part of a page (display space, points) as a PNG at `dpi`, markup included; very large areas are scaled down. */
export function renderArea(page: mupdf.Page, rect: number[], dpi = 300): Uint8Array {
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  let s = dpi / 72;
  const area = (x1 - x0) * (y1 - y0) * s * s;
  if (area > MAX_PIXELS) s *= Math.sqrt(MAX_PIXELS / area);
  const e = 1e-6;
  const bbox: mupdf.Rect = [Math.floor(x0 * s + e), Math.floor(y0 * s + e), Math.ceil(x1 * s - e), Math.ceil(y1 * s - e)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    page.run(dev, mupdf.Matrix.scale(s, s));
    dev.close();
    dev.destroy();
    const r = Math.round(s * 72);
    pix.setResolution(r, r);
    return pix.asPNG();
  } finally {
    pix.destroy();
  }
}
