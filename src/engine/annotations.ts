// Comments & markup on top of MuPDF annotations. All coordinates are page space in points
// (origin top-left, y down, after page rotation) — the same space as search results.
import { leaderStart, lengthText, areaText, type Unit } from "./measure";
import { type Xf, imageMatrix, bounds as xfBounds, xfFromRect, corners as xfCorners } from "./xform";
import * as mupdf from "mupdf";
import { calloutGeometry } from "./callout";
export { calloutGeometry };

export type Pt = [number, number];
export type RGB = [number, number, number];

export type AnnotSpec =
  | { type: "Highlight" | "Underline" | "StrikeOut" | "Squiggly"; quads: number[][]; color?: RGB; contents?: string }
  | { type: "Text"; at: Pt; contents: string; color?: RGB; icon?: string }
  | { type: "FreeText"; rect: number[]; contents: string; fontSize?: number; color?: RGB; fill?: RGB | null; width?: number; align?: number }
  | { type: "Square" | "Circle"; rect: number[]; color?: RGB; fill?: RGB | null; width?: number; contents?: string; cloud?: boolean; opacity?: number; label?: Label }
  | { type: "Line"; a: Pt; b: Pt; arrow?: boolean; color?: RGB; width?: number; contents?: string; dimension?: boolean; caption?: string; captionSize?: number; measure?: MeasureSpec; meas?: Meas }
  | { type: "Polygon" | "PolyLine"; vertices: Pt[]; color?: RGB; fill?: RGB | null; width?: number; contents?: string; cloud?: boolean; opacity?: number; label?: Label; intent?: string; measure?: MeasureSpec; meas?: Meas }
  | { type: "Callout"; target: Pt; knee?: Pt; rect: number[]; contents: string; fontSize?: number; color?: RGB; fill?: RGB | null; width?: number; arrow?: string; align?: number }
  | { type: "ReviewStamp"; rect: number[]; title: string; name: string; date: string; company?: string; color?: RGB }
  | { type: "Ink"; strokes: Pt[][]; color?: RGB; width?: number; contents?: string }
  | { type: "Stamp"; rect: number[]; label: string; color?: RGB }
  | { type: "Redact"; quads?: number[][]; rect?: number[] };

/** Text drawn on the page as part of a markup (a measurement value, a count number). */
export interface Label { text: string; at: Pt; size?: number; color?: RGB; /** White backing behind the text (default true). */ bg?: boolean }
/** A measurement's raw value, kept so its label can be re-written at another precision. */
export interface Meas { kind: "len" | "area" | "per"; /** Points (length) or square points (area). */ value: number; /** The other one: perimeter for areas, area for perimeters. */ value2?: number; k: number; unit: string; prec?: number }
/** Scale written into a measurement markup's /Measure dictionary so other PDF apps read the same values. */
export interface MeasureSpec { ratio: string; xUnit: string; xC: number; aUnit: string }

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
  /** Key of the comment this one replies to. */
  inReplyTo?: number;
  /** Review status set by this reply (Accepted, Rejected, Cancelled, Completed, None). */
  state?: string;
  /** Unique name (/NM), used to recognise the same comment in other copies of the file. */
  name?: string;
  hidden?: boolean;
  /** Part of another markup's group (e.g. an extra leader on a text box): not a comment of its own. */
  groupOf?: number;
  /** An image stamp (signature, picture): its placement, for the move / resize / rotate handles. */
  xf?: Xf;
  /** Text boxes and callouts: the box itself (display space) and its style. */
  box?: number[];
  /** Callouts: arrow tip, knee and the point where the leader meets the box (display space). */
  callout?: Pt[];
  fontSize?: number;
  textColor?: number[];
  /** Box background, or null when see-through. */
  fill?: number[] | null;
  borderWidth?: number;
  arrow?: string;
  /** Text boxes and callouts: 0 left, 1 centre, 2 right. */
  align?: number;
  /** Measurements, dimensions and counts: the label's text size, and the measured value if it can be re-formatted. */
  label?: { size: number; meas?: Meas };
  /** Plain text boxes: rotated by this many degrees (clockwise, as seen). */
  angle?: number;
}

export const REVIEW_STATES = ["Accepted", "Rejected", "Cancelled", "Completed", "None"] as const;

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
  Polygon: [0.85, 0.1, 0.1],
  PolyLine: [0.85, 0.1, 0.1],
  Callout: [0.85, 0.1, 0.1],
  ReviewStamp: [0.1, 0.5, 0.2],
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
          xf: a.getType() === "Stamp" ? imageStampXf(a) : undefined,
          ...(a.getType() === "FreeText" ? textBoxInfo(page as mupdf.PDFPage, a) : {}),
          ...labelInfo(a),
          ...threadInfo(a),
        };
      });
  } finally {
    page.destroy();
  }
}

export function addAnnotation(doc: mupdf.PDFDocument, pageIndex: number, spec: AnnotSpec, author: string): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const kind = spec.type === "Callout" ? "FreeText" : spec.type === "ReviewStamp" ? "Stamp" : spec.type;
    const a = page.createAnnotation(kind as mupdf.PDFAnnotationType);
    const color = ("color" in spec && spec.color) || DEFAULT_COLORS[spec.type];
    // For FreeText, /C is the box background; the text colour goes in the default appearance instead.
    if (color && spec.type !== "Redact" && spec.type !== "FreeText" && spec.type !== "Callout") a.setColor(color);
    const o = a.getObject();
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
        if (spec.fill) a.setColor(spec.fill);
        if (spec.width !== undefined) a.setBorderWidth(spec.width);
        if (spec.align) a.setQuadding(spec.align);
        break;
      case "Callout": {
        a.setRect(spec.rect as mupdf.Rect);
        a.setDefaultAppearance("Helv", spec.fontSize ?? 12, color ?? [0, 0, 0]);
        setCallout(doc, page, a, calloutGeometry(spec.rect, spec.target, spec.knee));
        a.setCalloutStyle((spec.arrow ?? "OpenArrow") as mupdf.PDFAnnotationLineEndingStyle);
        a.setIntent("FreeTextCallout");
        if (spec.align) a.setQuadding(spec.align);
        a.setBorderWidth(spec.width ?? 1);
        // Border and leader colour of a FreeText come from its default appearance; /C is the box fill (white by default, so text stays readable).
        a.setColor(spec.fill === null ? [] : spec.fill ?? [1, 1, 1]);
        break;
      }
      case "Square":
      case "Circle":
        a.setRect(spec.rect as mupdf.Rect);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.fill) a.setInteriorColor(spec.fill);
        if (spec.cloud) (a.setBorderEffect("Cloudy"), a.setBorderEffectIntensity(1));
        break;
      case "Polygon":
      case "PolyLine":
        a.setVertices(spec.vertices as mupdf.Point[]);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.fill) a.setInteriorColor(spec.fill);
        if (spec.cloud) (a.setBorderEffect("Cloudy"), a.setBorderEffectIntensity(1));
        if (spec.intent) a.setIntent(spec.intent as mupdf.PDFAnnotationIntent);
        break;
      case "Line":
        a.setLine(spec.a, spec.b);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.dimension) {
          a.setLineEndingStyles("OpenArrow", "OpenArrow");
          a.setIntent("LineDimension");
          if (spec.caption) {
            const mid: Pt = [(spec.a[0] + spec.b[0]) / 2, (spec.a[1] + spec.b[1]) / 2];
            o.put("HDFLabel", toPdfArray(doc, [spec.caption, mid[0], mid[1], spec.captionSize ?? 10, ...(color ?? [0, 0, 0]), 1]));
          }
        } else if (spec.arrow) a.setLineEndingStyles("None", "ClosedArrow");
        break;
      case "Ink":
        a.setInkList(spec.strokes);
        a.setBorderWidth(spec.width ?? 2);
        break;
      case "Stamp":
        a.setRect(spec.rect as mupdf.Rect);
        a.setIcon(spec.label);
        break;
      case "ReviewStamp":
        a.setRect(spec.rect as mupdf.Rect);
        a.setIcon(spec.title);
        a.setContents(`${spec.title} — ${spec.name}, ${spec.date}`);
        o.put("HDFStamp", toPdfArray(doc, [spec.title, spec.name, spec.date, spec.company ?? "", ...(color ?? [0.1, 0.5, 0.2])]));
        o.put("HDFRect", toPdfArray(doc, spec.rect)); // mupdf reshapes stamp rects on update; this is the box the user drew
        break;
      case "Redact":
        if (spec.quads?.length) a.setQuadPoints(spec.quads as mupdf.Quad[]);
        if (spec.rect) a.setRect(spec.rect as mupdf.Rect);
        else if (spec.quads?.length) a.setRect(boundsOfQuads(spec.quads) as mupdf.Rect);
        break;
    }
    if (spec.type === "Line" && spec.caption) a.setContents(spec.caption);
    if ("contents" in spec && spec.contents) a.setContents(spec.contents);
    if ("opacity" in spec && spec.opacity !== undefined && spec.opacity < 1) a.setOpacity(spec.opacity);
    if ("label" in spec && spec.label && typeof spec.label === "object") {
      const L = spec.label as Label;
      o.put("HDFLabel", toPdfArray(doc, [L.text, L.at[0], L.at[1], L.size ?? 10, ...(L.color ?? color ?? [0, 0, 0]), L.bg === false ? 0 : 1]));
    }
    if ("measure" in spec && spec.measure) o.put("Measure", measureObj(doc, spec.measure));
    if ("meas" in spec && spec.meas) putMeas(doc, o, spec.meas);
    if (spec.type !== "Redact" && spec.type !== "Stamp") a.setAuthor(author);
    const now = new Date();
    a.setCreationDate?.(now);
    a.setModificationDate(now);
    a.update();
    decorate(doc, page, a);
    return keyOf(a);
  } finally {
    page.destroy();
  }
}

function putMeas(doc: mupdf.PDFDocument, o: mupdf.PDFObject, m: Meas) {
  o.put("HDFMeas", toPdfArray(doc, [m.kind, m.value, m.k, m.unit, m.prec ?? -1, m.value2 ?? 0]));
}

function labelInfo(a: mupdf.PDFAnnotation): Partial<AnnotInfo> {
  const o = a.getObject();
  const L = o.get("HDFLabel");
  if (!L.isArray()) return {};
  const M = o.get("HDFMeas");
  let meas: Meas | undefined;
  if (M.isArray() && M.length >= 6) {
    const prec = M.get(4).asNumber();
    meas = { kind: M.get(0).asString() as Meas["kind"], value: M.get(1).asNumber(), k: M.get(2).asNumber(), unit: M.get(3).asString(), prec: prec >= 0 ? prec : undefined, value2: M.get(5).asNumber() || undefined };
  }
  return { label: { size: L.get(3).asNumber(), meas } };
}

/** A measurement's label and comment text. */
export function measTexts(m: Meas): { label: string; contents: string } {
  const s = { k: m.k, unit: m.unit as Unit, label: "" };
  const len = (v: number) => lengthText(v, s, m.prec), area = (v: number) => areaText(v, s, m.prec);
  if (m.kind === "len") return { label: len(m.value), contents: `Length: ${len(m.value)}` };
  const A = m.kind === "area" ? m.value : m.value2 ?? 0, P = m.kind === "area" ? m.value2 ?? 0 : m.value;
  return { label: m.kind === "area" ? area(A) : len(P), contents: `Area: ${area(A)}; Perimeter: ${len(P)}` };
}

function toPdfArray(doc: mupdf.PDFDocument, items: (string | number)[]) {
  const arr = doc.newArray();
  for (const v of items) arr.push(typeof v === "number" ? doc.newReal(v) : doc.newString(v));
  return arr;
}

function measureObj(doc: mupdf.PDFDocument, m: MeasureSpec) {
  const fmt = (u: string, c: number) => {
    const d = doc.newDictionary();
    d.put("Type", doc.newName("NumberFormat"));
    d.put("U", doc.newString(u));
    d.put("C", doc.newReal(c));
    d.put("D", doc.newInteger(100));
    return d;
  };
  const md = doc.newDictionary();
  md.put("Type", doc.newName("Measure"));
  md.put("Subtype", doc.newName("RL"));
  md.put("R", doc.newString(m.ratio));
  const one = (d: mupdf.PDFObject) => {
    const a = doc.newArray();
    a.push(d);
    return a;
  };
  md.put("X", one(fmt(m.xUnit, m.xC)));
  md.put("D", one(fmt(m.xUnit, 1)));
  md.put("A", one(fmt(m.aUnit, 1)));
  return md;
}

const FRAC = 0.6;
type LabelRun = { kind: "t"; s: string; w: number } | { kind: "f"; n: string; d: string; w: number };
/** Split a label into plain text and stacked fractions ("12'-6 1/2\"" → "12'-6", ½ stacked, "\""). */
export function labelRuns(text: string, size: number): LabelRun[] {
  const out: LabelRun[] = [];
  let last = 0;
  for (const m of text.matchAll(/(\d+)\/(\d+)/g)) {
    const before = text.slice(last, m.index).replace(/ $/, "");
    if (before) out.push({ kind: "t", s: before, w: helvWidth(before, size) });
    const fs = size * FRAC;
    out.push({ kind: "f", n: m[1], d: m[2], w: Math.max(helvWidth(m[1], fs), helvWidth(m[2], fs)) + size * 0.16 });
    last = m.index! + m[0].length;
  }
  const rest = text.slice(last);
  if (rest) out.push({ kind: "t", s: rest, w: helvWidth(rest, size) });
  return out;
}

/** PDF string bytes for WinAnsi text (°, ², fractions survive; anything else becomes "?"). */
function pdfText(s: string) {
  const map: Record<string, number> = { "—": 0x97, "–": 0x96, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "·": 0xb7 };
  let out = "";
  for (const ch of s) {
    const c = map[ch] ?? ch.codePointAt(0)!;
    const b = c > 255 ? 63 : c;
    out += b === 40 || b === 41 || b === 92 ? "\\" + String.fromCharCode(b) : b < 32 || b > 126 ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b);
  }
  return `(${out})`;
}
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
/** Approximate Helvetica text width (good enough to centre and size labels). */
export function helvWidth(s: string, size: number, bold = false) {
  let w = 0;
  for (const c of s) w += /[il.,:;|!'·]/.test(c) ? 0.28 : /[mwMW]/.test(c) ? 0.86 : /[A-Z]/.test(c) ? (bold ? 0.74 : 0.68) : /[0-9]/.test(c) ? 0.556 : c === " " ? 0.278 : bold ? 0.6 : 0.53;
  return w * size;
}

function fontDict(doc: mupdf.PDFDocument, base: string) {
  const f = doc.newDictionary();
  f.put("Type", doc.newName("Font"));
  f.put("Subtype", doc.newName("Type1"));
  f.put("BaseFont", doc.newName(base));
  f.put("Encoding", doc.newName("WinAnsiEncoding"));
  return doc.addObject(f);
}

/**
 * Our additions to mupdf's own appearance: a measurement/count label, or a whole review stamp.
 * Re-run after anything that makes mupdf redraw the annotation (it would drop them).
 */
function decorate(doc: mupdf.PDFDocument, page: mupdf.PDFPage, a: mupdf.PDFAnnotation) {
  const o = a.getObject();
  if (o.get("HDFImg").isArray()) return drawImageStamp(doc, page, a);
  if (o.get("HDFTxf").isArray()) return drawRotatedText(doc, page, a);
  const stamp = o.get("HDFStamp");
  const label = o.get("HDFLabel");
  if (!stamp.isArray() && !label.isArray()) return;
  const toUser = mupdf.Matrix.invert(page.getTransform());
  const tp = (x: number, y: number): Pt => {
    const [m0, m1, m2, m3, m4, m5] = toUser;
    return [x * m0 + y * m2 + m4, x * m1 + y * m3 + m5];
  };
  const num = (arr: mupdf.PDFObject, i: number) => arr.get(i).asNumber();
  const str = (arr: mupdf.PDFObject, i: number) => arr.get(i).asString();
  const rgb = (arr: mupdf.PDFObject, i: number) => `${num(arr, i).toFixed(3)} ${num(arr, i + 1).toFixed(3)} ${num(arr, i + 2).toFixed(3)}`;
  if (stamp.isArray()) {
    const [title, name, date, company] = [0, 1, 2, 3].map((i) => str(stamp, i));
    const col = rgb(stamp, 4);
    // Lay the stamp out in display space (as the page is seen, after /Rotate) so it reads upright.
    const hr = o.get("HDFRect");
    const r = hr.isArray() && hr.length === 4 ? [0, 1, 2, 3].map((i) => hr.get(i).asNumber()) : Array.from(a.getRect());
    const dx0 = Math.min(r[0], r[2]), dy0 = Math.min(r[1], r[3]), dx1 = Math.max(r[0], r[2]), dy1 = Math.max(r[1], r[3]);
    const w = dx1 - dx0, h = dy1 - dy0;
    const lines = [name && date ? `${name}  ·  ${date}` : name || date, company].filter(Boolean);
    const titleSize = Math.min(h * (lines.length ? 0.34 : 0.5), (w - 16) / Math.max(1e-3, helvWidth(title, 1, true)));
    const small = Math.min(h * 0.19, (w - 16) / Math.max(1e-3, ...lines.map((l) => helvWidth(l, 1))));
    let cs = `q ${col} RG ${col} rg 2 w 2 2 ${w - 4} ${h - 4} re S 0.75 w 5 5 ${w - 10} ${h - 10} re S\n`;
    let y = h - 6 - titleSize;
    cs += `BT /HdfB ${titleSize.toFixed(2)} Tf ${((w - helvWidth(title, titleSize, true)) / 2).toFixed(2)} ${y.toFixed(2)} Td ${pdfText(title)} Tj ET\n`;
    for (const l of lines) {
      y -= small * 1.35;
      cs += `BT /Hdf ${small.toFixed(2)} Tf ${((w - helvWidth(l, small)) / 2).toFixed(2)} ${y.toFixed(2)} Td ${pdfText(l)} Tj ET\n`;
    }
    cs += "Q";
    const res = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put("Hdf", fontDict(doc, "Helvetica"));
    fonts.put("HdfB", fontDict(doc, "Helvetica-Bold"));
    res.put("Font", fonts);
    const sd = doc.newDictionary();
    sd.put("Type", doc.newName("XObject"));
    sd.put("Subtype", doc.newName("Form"));
    const bb = doc.newArray();
    [0, 0, w, h].forEach((v) => bb.push(doc.newReal(v)));
    sd.put("BBox", bb);
    const mx = doc.newArray();
    // Form space (y up, origin at the box's bottom-left as displayed) to display space, then to the page's user space.
    Array.from(mupdf.Matrix.concat([1, 0, 0, -1, dx0, dy1], toUser)).forEach((v) => mx.push(doc.newReal(+v.toFixed(5))));
    sd.put("Matrix", mx);
    sd.put("Resources", res);
    const ap = doc.newDictionary();
    ap.put("N", doc.addStream(latin1(cs), sd));
    o.put("AP", ap);
    // Put the rect back to the drawn box (in page space), whatever mupdf's own stamp layout did to it.
    const c = [tp(dx0, dy0), tp(dx1, dy1)];
    o.put("Rect", toPdfArray(doc, [Math.min(c[0][0], c[1][0]), Math.min(c[0][1], c[1][1]), Math.max(c[0][0], c[1][0]), Math.max(c[0][1], c[1][1])]));
    return;
  }
  // Label: append text to mupdf's appearance stream, growing its box to fit.
  const ap = o.get("AP").get("N");
  if (!ap.isStream()) return;
  const text = str(label, 0);
  const size = num(label, 3);
  const px = num(label, 1), py = num(label, 2); // display space (as the page is seen)
  const runs = labelRuns(text, size);
  const tw = runs.reduce((w, r) => w + r.w, 0);
  const m = ap.get("Matrix");
  const M = m.isArray() ? [0, 1, 2, 3, 4, 5].map((i) => m.get(i).asNumber()) : [1, 0, 0, 1, 0, 0];
  const inv = mupdf.Matrix.invert(M as mupdf.Matrix);
  // Display point -> page user space -> appearance form space.
  const fx = (x: number, y: number): Pt => {
    const [ux, uy] = tp(x, y);
    return [ux * inv[0] + uy * inv[2] + inv[4], ux * inv[1] + uy * inv[3] + inv[5]];
  };
  // Text is centred on the label point, on a white backing so it stays readable over linework.
  const c0 = fx(px - tw / 2 - 2, py - size * 0.85), c1 = fx(px + tw / 2 + 2, py + size * 0.55);
  const lx0 = Math.min(c0[0], c1[0]), ly0 = Math.min(c0[1], c1[1]), lx1 = Math.max(c0[0], c1[0]), ly1 = Math.max(c0[1], c1[1]);
  // Text runs along the page as displayed (after /Rotate), so labels read upright on rotated sheets.
  const o0 = fx(0, 0), ox = fx(1, 0), oy = fx(0, -1);
  const unit = (q: Pt): Pt => {
    const v: Pt = [q[0] - o0[0], q[1] - o0[1]];
    const n = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / n, v[1] / n];
  };
  const ex = unit(ox), ey = unit(oy);
  const dirTm = `${ex[0].toFixed(4)} ${ex[1].toFixed(4)} ${ey[0].toFixed(4)} ${ey[1].toFixed(4)}`;
  const bg = label.length < 8 || num(label, 7) !== 0;
  // Fractions (1/2", 15/16") are stacked: small numerator over a bar over the denominator, as on CAD drawings.
  const by = py + size * 0.3;
  const put = (x: number, y: number, fs: number, t: string) => {
    const [qx, qy] = fx(x, y);
    return `BT /HdfL ${fs.toFixed(2)} Tf ${dirTm} ${qx.toFixed(2)} ${qy.toFixed(2)} Tm ${pdfText(t)} Tj ET `;
  };
  let draw = "";
  let x = px - tw / 2;
  for (const r of runs) {
    if (r.kind === "t") draw += put(x, by, size, r.s);
    else {
      const fs = size * FRAC;
      draw += put(x + (r.w - helvWidth(r.n, fs)) / 2, by - size * 0.5, fs, r.n);
      draw += put(x + (r.w - helvWidth(r.d, fs)) / 2, by + size * 0.07, fs, r.d);
      const b0 = fx(x + size * 0.04, by - size * 0.42), b1 = fx(x + r.w - size * 0.04, by - size * 0.42);
      draw += `${(size * 0.06).toFixed(2)} w ${b0[0].toFixed(2)} ${b0[1].toFixed(2)} m ${b1[0].toFixed(2)} ${b1[1].toFixed(2)} l S `;
    }
    x += r.w;
  }
  const add = `\nq /HdfOpaque gs ${bg ? `1 1 1 rg ${lx0.toFixed(2)} ${ly0.toFixed(2)} ${(lx1 - lx0).toFixed(2)} ${(ly1 - ly0).toFixed(2)} re f ` : ""}${rgb(label, 4)} rg ${rgb(label, 4)} RG ${draw}Q\n`;
  const old = ap.readStream().asUint8Array();
  const next = new Uint8Array(old.length + add.length);
  next.set(old, 0);
  next.set(latin1(add), old.length);
  ap.writeStream(next);
  let res = ap.get("Resources");
  if (!res.isDictionary()) {
    res = doc.newDictionary();
    ap.put("Resources", res);
  }
  let fonts = res.get("Font");
  if (!fonts.isDictionary()) {
    fonts = doc.newDictionary();
    res.put("Font", fonts);
  }
  fonts.put("HdfL", fontDict(doc, "Helvetica"));
  // The label stays fully opaque even on a see-through shape.
  let gsd = res.get("ExtGState");
  if (!gsd.isDictionary()) {
    gsd = doc.newDictionary();
    res.put("ExtGState", gsd);
  }
  const op = doc.newDictionary();
  op.put("CA", doc.newReal(1));
  op.put("ca", doc.newReal(1));
  gsd.put("HdfOpaque", op);
  const bbox = ap.get("BBox");
  if (bbox.isArray()) {
    const b = [0, 1, 2, 3].map((i) => bbox.get(i).asNumber());
    const nb = [Math.min(b[0], lx0), Math.min(b[1], ly0), Math.max(b[2], lx1), Math.max(b[3], ly1)];
    nb.forEach((v, i) => bbox.put(i, doc.newReal(v)));
  }
  const rect = o.get("Rect");
  if (rect.isArray()) {
    const rr = [0, 1, 2, 3].map((i) => rect.get(i).asNumber());
    const u0 = tp(px - tw / 2 - 2, py - size * 0.85), u1 = tp(px + tw / 2 + 2, py + size * 0.55);
    const nr = [Math.min(rr[0], u0[0], u1[0]), Math.min(rr[1], u0[1], u1[1]), Math.max(rr[2], u0[0], u1[0]), Math.max(rr[3], u0[1], u1[1])];
    nr.forEach((v, i) => rect.put(i, doc.newReal(v)));
  }
}

function threadInfo(a: mupdf.PDFAnnotation): Pick<AnnotInfo, "inReplyTo" | "state" | "name" | "hidden" | "groupOf"> {
  const o = a.getObject();
  const irt = o.get("IRT");
  const rt = o.get("RT");
  if (irt.isIndirect() && rt.isName() && rt.asName() === "Group") {
    const nm = o.get("NM");
    return { groupOf: irt.asIndirect(), name: nm.isString() ? nm.asString() : undefined, hidden: false };
  }
  const st = o.get("State");
  const nm = o.get("NM");
  const f = o.get("F");
  return {
    inReplyTo: irt.isIndirect() ? irt.asIndirect() : undefined,
    state: st.isString() ? st.asString() : undefined,
    name: nm.isString() ? nm.asString() : undefined,
    hidden: f.isNumber() ? (f.asNumber() & 2) !== 0 : false,
  };
}

const newName = () => `hdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Reply to a comment, optionally setting its review status. Replies are hidden on the page; they show in the Comments panel. */
export function addReply(doc: mupdf.PDFDocument, pageIndex: number, parentKey: number, text: string, author: string, state?: string): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const parent = findAnnot(page, parentKey);
    const [x0, y0] = parent.getBounds();
    const a = page.createAnnotation("Text");
    a.setRect([x0, y0, x0 + 20, y0 + 20]);
    a.setContents(text);
    a.setAuthor(author);
    a.setModificationDate(new Date());
    const o = a.getObject();
    o.put("IRT", parent.getObject());
    o.put("NM", doc.newString(newName()));
    o.put("F", 2 | 4 | 8 | 16); // hidden, print, no zoom, no rotate
    if (state) {
      o.put("State", doc.newString(state));
      o.put("StateModel", doc.newString("Review"));
    }
    a.update();
    return keyOf(a);
  } finally {
    page.destroy();
  }
}

/** Give every comment a unique name so copies of the file can be merged without duplicates. */
export function ensureNames(doc: mupdf.PDFDocument) {
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const o = annots.get(k);
      if (o.get("NM").isNull() && o.get("Subtype").asName() !== "Link") o.put("NM", doc.newString(newName()));
    }
  }
}

/** Identities of a comment across copies: its /NM (if any) and type + position + text. */
function identities(o: mupdf.PDFObject): string[] {
  const nm = o.get("NM");
  const r = o.get("Rect");
  const rect = r.isArray() ? [0, 1, 2, 3].map((i) => Math.round(r.get(i).asNumber())).join(",") : "";
  const c = o.get("Contents");
  const shape = `${o.get("Subtype").asName()}|${rect}|${c.isString() ? c.asString() : ""}`;
  return nm.isString() ? ["nm:" + nm.asString(), shape] : [shape];
}

/**
 * Copy comments from another copy of the same document (e.g. returned by a reviewer) that this
 * one doesn't have yet. Replies keep their threads. Returns how many were added, by author.
 */
export function mergeAnnotations(doc: mupdf.PDFDocument, src: mupdf.PDFDocument): { added: number; authors: Record<string, number> } {
  const map = doc.newGraftMap();
  const authors: Record<string, number> = {};
  let added = 0;
  const same = new Map<number, mupdf.PDFObject>(); // reviewer's object number -> our comment
  const n = Math.min(doc.countPages(), src.countPages());
  for (let i = 0; i < n; i++) {
    const sa = (src.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!sa.isArray() || !sa.length) continue;
    const pageObj = doc.findPage(i) as mupdf.PDFObject;
    let da = pageObj.get("Annots");
    const have = new Map<string, mupdf.PDFObject>();
    if (da.isArray()) {
      for (let k = 0; k < da.length; k++) for (const x of identities(da.get(k))) if (!have.has(x)) have.set(x, da.get(k));
    } else {
      da = doc.newArray();
      pageObj.put("Annots", da);
    }
    const pending: [mupdf.PDFObject, mupdf.PDFObject][] = [];
    for (let k = 0; k < sa.length; k++) {
      const o = sa.get(k);
      const sub = o.get("Subtype").asName();
      if (sub === "Popup" || sub === "Link" || sub === "Widget") continue;
      const ids = identities(o);
      const match = ids.map((x) => have.get(x)).find(Boolean);
      if (match) {
        same.set(o.asIndirect(), match);
        continue;
      }
      // Copy key by key so /P, /Popup and /IRT don't drag the reviewer's page tree along.
      const copy = doc.newDictionary();
      o.forEach((v, key) => {
        if (key === "P" || key === "Popup" || key === "IRT" || key === "Parent") return;
        copy.put(key, map.graftObject(v));
      });
      copy.put("P", pageObj);
      const ref = doc.addObject(copy);
      da.push(ref);
      for (const x of ids) have.set(x, ref);
      same.set(o.asIndirect(), ref);
      if (o.get("IRT").isIndirect()) pending.push([ref, o.get("IRT")]);
      added++;
      const t = o.get("T");
      const who = t.isString() ? t.asString() : "Unknown";
      authors[who] = (authors[who] ?? 0) + 1;
    }
    for (const [ref, irt] of pending) {
      const parent = same.get(irt.asIndirect());
      if (parent) ref.put("IRT", parent);
    }
  }
  return { added, authors };
}

/**
 * Write a callout leader (display space). mupdf's setCalloutLine drops the page's origin offset, so on
 * drawings whose MediaBox or CropBox doesn't start at 0,0 (most CAD output) the leader landed far from the box.
 */
function setCallout(doc: mupdf.PDFDocument, page: mupdf.PDFPage, a: mupdf.PDFAnnotation, pts: Pt[]) {
  a.setCalloutLine(pts as mupdf.Point[]); // lets mupdf set up the callout bookkeeping; the points are rewritten below
  const inv = mupdf.Matrix.invert(page.getTransform());
  const cl = doc.newArray();
  for (const [x, y] of pts) (cl.push(x * inv[0] + y * inv[2] + inv[4]), cl.push(x * inv[1] + y * inv[3] + inv[5]));
  a.getObject().put("CL", cl);
}

/** A text box's own box (without the leader), callout line and style, in display space. */
function textBoxInfo(page: mupdf.PDFPage, a: mupdf.PDFAnnotation): Partial<AnnotInfo> {
  const o = a.getObject();
  const T = page.getTransform();
  const toDisp = (x: number, y: number): Pt => [x * T[0] + y * T[2] + T[4], x * T[1] + y * T[3] + T[5]];
  const r = o.get("Rect"), rd = o.get("RD");
  const R = [0, 1, 2, 3].map((i) => r.get(i).asNumber());
  const D = rd.isArray() ? [0, 1, 2, 3].map((i) => rd.get(i).asNumber()) : [0, 0, 0, 0];
  const p0 = toDisp(R[0] + D[0], R[1] + D[1]), p1 = toDisp(R[2] - D[2], R[3] - D[3]);
  const txf = o.get("HDFTxf");
  const turned = txf.isArray() ? readXf(txf) : null;
  const box = turned ? xfBox(turned) : [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
  const cl = o.get("CL");
  let callout: Pt[] | undefined;
  // mupdf writes a placeholder /CL on every text box, so only a callout's intent makes it one.
  const it = o.get("IT");
  if (cl.isArray() && cl.length >= 4 && it.isName() && it.asName() === "FreeTextCallout") {
    const v = Array.from({ length: cl.length }, (_, i) => cl.get(i).asNumber());
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < v.length; i += 2) pts.push(toDisp(v[i], v[i + 1]));
    callout = pts.length === 2 ? [pts[0], pts[0], pts[1]] : pts;
  }
  let fontSize: number | undefined, textColor: number[] | undefined;
  try {
    const da = a.getDefaultAppearance();
    fontSize = da.size;
    textColor = da.color ? Array.from(da.color as number[]) : undefined;
  } catch { /* no DA */ }
  const c = a.getColor();
  let arrow: string | undefined;
  try {
    arrow = callout ? a.getCalloutStyle?.() : undefined;
  } catch { /* none */ }
  // Plain text boxes get the same move / resize / turn handles as pictures.
  const xf = callout ? undefined : turned ?? xfFromRect(box);
  return { box, callout, fontSize, textColor, fill: c.length >= 3 ? Array.from(c) : null, borderWidth: a.hasBorder() ? a.getBorderWidth() : undefined, arrow, xf, angle: xf?.angle, align: a.getQuadding?.() ?? 0 };
}

function findAnnot(page: mupdf.PDFPage, key: number) {
  const a = page.getAnnotations().find((x) => keyOf(x) === key);
  if (!a) throw new Error("Comment not found (it may have been deleted)");
  return a;
}

export interface AnnotPatch {
  contents?: string; color?: RGB; rect?: number[]; author?: string; width?: number; opacity?: number; fontSize?: number;
  /** Text boxes: background colour, or null for see-through. */
  fill?: RGB | null;
  /** Callouts: move the text box and/or the arrow tip (display space); the leader is re-routed. */
  box?: number[];
  target?: Pt;
  arrow?: string;
  /** Measurements and dimensions: label text size, and decimal places / fraction (0–4, null = the unit's usual). */
  labelSize?: number;
  precision?: number | null;
  /** Text boxes and callouts: 0 left, 1 centre, 2 right. */
  align?: number;
}

export function updateAnnotation(doc: mupdf.PDFDocument, pageIndex: number, key: number, patch: AnnotPatch) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = findAnnot(page, key);
    if (patch.contents !== undefined) a.setContents(patch.contents);
    if (patch.author !== undefined) a.setAuthor(patch.author);
    if (patch.width !== undefined && a.hasBorder()) a.setBorderWidth(patch.width);
    if (patch.opacity !== undefined) a.setOpacity(Math.max(0.05, Math.min(1, patch.opacity)));
    const isText = a.getType() === "FreeText";
    if (isText && (patch.color || patch.fontSize)) {
      // A text box's text colour and size live in its default appearance; /C is its background.
      const da = a.getDefaultAppearance();
      a.setDefaultAppearance(da.font || "Helv", patch.fontSize ?? da.size ?? 12, (patch.color ?? da.color ?? [0, 0, 0]) as RGB);
    }
    if (patch.color && !isText) a.setColor(patch.color);
    if (isText && patch.align !== undefined) a.setQuadding(Math.max(0, Math.min(2, Math.round(patch.align))));
    if (isText && patch.fill !== undefined) a.setColor(patch.fill === null ? [] : patch.fill);
    if (isText && (patch.box || patch.target || patch.arrow)) {
      const info = textBoxInfo(page, a);
      const box = patch.box ?? info.box!;
      if (info.callout || patch.target) {
        const target = patch.target ?? info.callout![0];
        a.setRect(box as mupdf.Rect);
        setCallout(doc, page, a, calloutGeometry(box, target));
        if (patch.arrow) a.setCalloutStyle(patch.arrow as mupdf.PDFAnnotationLineEndingStyle);
      } else if (a.getObject().get("HDFTxf").isArray()) {
        const t = readXf(a.getObject().get("HDFTxf"));
        a.getObject().put("HDFTxf", toPdfArray(doc, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box[2] - box[0], box[3] - box[1], t.angle]));
      } else a.setRect(box as mupdf.Rect);
    }
    const L = a.getObject().get("HDFLabel");
    if (L.isArray() && patch.labelSize && patch.labelSize > 0) L.put(3, doc.newReal(patch.labelSize));
    const M = a.getObject().get("HDFMeas");
    if (L.isArray() && M.isArray() && patch.precision !== undefined) {
      M.put(4, doc.newReal(patch.precision === null ? -1 : Math.max(0, Math.min(4, Math.round(patch.precision)))));
      const m = labelInfo(a).label!.meas!;
      const t = measTexts(m);
      L.put(0, doc.newString(t.label));
      if (patch.contents === undefined) a.setContents(/^(Length|Area):/.test(a.getContents() ?? "") ? t.contents : t.label);
    }
    if (patch.rect) a.setRect(patch.rect as mupdf.Rect);
    if (patch.rect && a.getObject().get("HDFStamp").isArray()) a.getObject().put("HDFRect", toPdfArray(doc, patch.rect));
    if (patch.color && a.getObject().get("HDFStamp").isArray()) {
      const st = a.getObject().get("HDFStamp");
      patch.color.forEach((v, i) => st.put(4 + i, doc.newReal(v)));
    }
    a.setModificationDate(new Date());
    a.update();
    decorate(doc, page, a);
    if (patch.color) for (const m of groupMembers(page, key)) (m.setColor(patch.color), m.update());
  } finally {
    page.destroy();
  }
}

export function deleteAnnotation(doc: mupdf.PDFDocument, pageIndex: number, key: number) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    for (const m of groupMembers(page, key)) page.deleteAnnotation(m);
    page.deleteAnnotation(findAnnot(page, key));
  } finally {
    page.destroy();
  }
}

// ---------- Image stamps (signatures, pictures): move, resize, rotate ----------

/** The image XObject inside a stamp's appearance (looks one form deep). */
function stampImage(a: mupdf.PDFAnnotation): mupdf.PDFObject | null {
  const o = a.getObject();
  const own = o.get("HDFImgX");
  if (!own.isNull()) return own;
  const find = (xo: mupdf.PDFObject, depth: number): mupdf.PDFObject | null => {
    const xobjs = xo.get("Resources").get("XObject");
    if (!xobjs.isDictionary()) return null;
    let hit: mupdf.PDFObject | null = null;
    xobjs.forEach((v) => {
      if (hit) return;
      const st = v.get("Subtype");
      if (st.isName() && st.asName() === "Image") hit = v;
      else if (depth > 0 && st.isName() && st.asName() === "Form") hit = find(v, depth - 1);
    });
    return hit;
  };
  const n = o.get("AP").get("N");
  return n.isStream() || n.isDictionary() ? find(n, 1) : null;
}

/** Placement of an image stamp in display space, or undefined if the stamp holds no image. */
function imageStampXf(a: mupdf.PDFAnnotation): Xf | undefined {
  const o = a.getObject();
  const x = o.get("HDFImg");
  if (x.isArray()) {
    const [cx, cy, w, h, angle] = [0, 1, 2, 3, 4].map((i) => x.get(i).asNumber());
    return { cx, cy, w, h, angle };
  }
  if (o.get("HDFStamp").isArray()) return undefined;
  try {
    return stampImage(a) ? xfFromRect(Array.from(a.getRect())) : undefined;
  } catch {
    return undefined;
  }
}

function drawImageStamp(doc: mupdf.PDFDocument, page: mupdf.PDFPage, a: mupdf.PDFAnnotation) {
  const o = a.getObject();
  const img = o.get("HDFImgX");
  const x = o.get("HDFImg");
  if (img.isNull() || !x.isArray()) return;
  const [cx, cy, w, h, angle] = [0, 1, 2, 3, 4].map((i) => x.get(i).asNumber());
  // Draw in user space with BBox = Rect, so the form maps onto the page one-to-one.
  const toUser = mupdf.Matrix.invert(page.getTransform());
  const r = o.get("Rect");
  const ur = [0, 1, 2, 3].map((i) => r.get(i).asNumber());
  const f = (n: number) => n.toFixed(4);
  const cs = `q ${Array.from(toUser).map(f).join(" ")} cm ${imageMatrix({ cx, cy, w, h, angle }).map(f).join(" ")} cm /Im Do Q`;
  const sd = doc.newDictionary();
  sd.put("Type", doc.newName("XObject"));
  sd.put("Subtype", doc.newName("Form"));
  sd.put("BBox", toPdfArray(doc, [Math.min(ur[0], ur[2]), Math.min(ur[1], ur[3]), Math.max(ur[0], ur[2]), Math.max(ur[1], ur[3])]));
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Im", img);
  res.put("XObject", xo);
  sd.put("Resources", res);
  const ap = doc.newDictionary();
  ap.put("N", doc.addStream(latin1(cs), sd));
  o.put("AP", ap);
}

const readXf = (x: mupdf.PDFObject): Xf => {
  const [cx, cy, w, h, angle] = [0, 1, 2, 3, 4].map((i) => x.get(i).asNumber());
  return { cx, cy, w, h, angle };
};
const xfBox = (t: Xf) => [t.cx - t.w / 2, t.cy - t.h / 2, t.cx + t.w / 2, t.cy + t.h / 2];

/**
 * A text box turned to any angle: mupdf lays the text out in the unturned box, and that
 * appearance is drawn turned about the box's centre (as seen on screen, whatever the page's /Rotate).
 */
function drawRotatedText(doc: mupdf.PDFDocument, page: mupdf.PDFPage, a: mupdf.PDFAnnotation) {
  const o = a.getObject();
  const t = readXf(o.get("HDFTxf"));
  a.setRect(xfBox(t) as mupdf.Rect);
  a.update();
  if (!t.angle) return;
  const inner = o.get("AP").get("N");
  if (!inner.isStream()) return;
  const T = page.getTransform(), toUser = mupdf.Matrix.invert(T);
  const r = (t.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const R: mupdf.Matrix = [c, s, -s, c, t.cx - t.cx * c + t.cy * s, t.cy - t.cx * s - t.cy * c];
  const M = mupdf.Matrix.concat(mupdf.Matrix.concat(T, R), toUser);
  const uc = xfCorners(t).map(([x, y]) => [x * toUser[0] + y * toUser[2] + toUser[4], x * toUser[1] + y * toUser[3] + toUser[5]]);
  const xs = uc.map((p) => p[0]), ys = uc.map((p) => p[1]);
  const ub = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const sd = doc.newDictionary();
  sd.put("Type", doc.newName("XObject"));
  sd.put("Subtype", doc.newName("Form"));
  sd.put("BBox", toPdfArray(doc, ub));
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Fm", inner.isIndirect() ? inner : doc.addObject(inner));
  res.put("XObject", xo);
  sd.put("Resources", res);
  const ap = doc.newDictionary();
  ap.put("N", doc.addStream(latin1(`q ${Array.from(M).map((v) => v.toFixed(5)).join(" ")} cm /Fm Do Q`), sd));
  o.put("AP", ap);
  o.put("Rect", toPdfArray(doc, ub));
}

/** Move, resize and/or turn a plain text box (display space, angle clockwise as seen). */
export function transformTextBox(doc: mupdf.PDFDocument, pageIndex: number, key: number, t: Xf) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = findAnnot(page, key);
    if (a.getType() !== "FreeText") throw new Error("Only text boxes can be turned this way");
    a.getObject().put("HDFTxf", toPdfArray(doc, [t.cx, t.cy, Math.max(8, t.w), Math.max(8, t.h), t.angle]));
    a.setModificationDate(new Date());
    drawRotatedText(doc, page, a);
  } finally {
    page.destroy();
  }
}

/** Redraw a freshly placed image stamp upright as the page is displayed (mupdf draws it in unrotated page space). */
export function uprightImageStamp(doc: mupdf.PDFDocument, page: mupdf.PDFPage, a: mupdf.PDFAnnotation, rect: number[]) {
  const img = stampImage(a);
  if (!img) return;
  const o = a.getObject();
  o.put("HDFImgX", img);
  const t = xfFromRect(rect);
  o.put("HDFImg", toPdfArray(doc, [t.cx, t.cy, t.w, t.h, t.angle]));
  drawImageStamp(doc, page, a);
}

/** Move, resize and/or rotate an image stamp such as a signature. */
export function transformImageStamp(doc: mupdf.PDFDocument, pageIndex: number, key: number, t: Xf) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = findAnnot(page, key);
    const o = a.getObject();
    if (o.get("HDFImgX").isNull()) {
      const img = stampImage(a);
      if (!img) throw new Error("This stamp has no image to move or rotate");
      o.put("HDFImgX", img);
    }
    o.put("HDFImg", toPdfArray(doc, [t.cx, t.cy, t.w, t.h, t.angle]));
    a.setRect(xfBounds(t) as mupdf.Rect);
    a.setModificationDate(new Date());
    a.update();
    drawImageStamp(doc, page, a);
  } finally {
    page.destroy();
  }
}

/** Annotations grouped under a parent (/IRT parent, /RT /Group), such as a text box's extra leaders. */
function groupMembers(page: mupdf.PDFPage, key: number) {
  return page.getAnnotations().filter((x) => {
    const o = x.getObject();
    const rt = o.get("RT");
    return o.get("IRT").isIndirect() && o.get("IRT").asIndirect() === key && rt.isName() && rt.asName() === "Group";
  });
}

/** The text area of a text box or callout, in display space (a callout's /Rect also covers its leader; /RD gives the inset in PDF space). */
function textBoxOf(a: mupdf.PDFAnnotation): number[] {
  const r = Array.from(a.getRect()); // display space (top-left origin)
  const rd = a.getObject().get("RD");
  if (rd.isArray() && rd.length === 4) {
    const [l, b, rr, t] = [0, 1, 2, 3].map((i) => rd.get(i).asNumber());
    return [r[0] + l, r[1] + t, r[2] - rr, r[3] - b];
  }
  return r;
}

/**
 * Add a leader line from a text box (or callout) to a point, grouped with the box so it moves
 * colour and is deleted with it. Several leaders on one box make a multileader.
 * Coordinates are in display space (top-left points), like every other spec here.
 */
export function addLeader(doc: mupdf.PDFDocument, pageIndex: number, parentKey: number, target: Pt, author: string): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const parent = findAnnot(page, parentKey);
    if (parent.getType() !== "FreeText") throw new Error("Leaders can only be added to text boxes and callouts");
    // The box as seen (display space); a callout's /Rect also covers its own leader, and /RD is in page space.
    const box = textBoxInfo(page, parent).box ?? textBoxOf(parent);
    let color: RGB = [0, 0, 0];
    try {
      const da = parent.getDefaultAppearance();
      if (da.color && da.color.length === 3) color = da.color as RGB;
    } catch { /* default black */ }
    const a = page.createAnnotation("Line");
    a.setLine(leaderStart(box, target), target);
    a.setLineEndingStyles("None", "OpenArrow");
    a.setBorderWidth(1);
    a.setColor(color);
    a.setAuthor(author);
    a.setModificationDate(new Date());
    const o = a.getObject();
    o.put("IRT", parent.getObject());
    o.put("RT", doc.newName("Group"));
    o.put("NM", doc.newString(newName()));
    a.update();
    return keyOf(a);
  } finally {
    page.destroy();
  }
}

/** Topmost annotation under a point, if any. */
export function annotationAt(doc: mupdf.PDFDocument, pageIndex: number, p: Pt): AnnotInfo | null {
  const all = listAnnotations(doc, pageIndex).filter((a) => !a.hidden);
  for (let i = all.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = all[i].rect;
    if (p[0] >= x0 - 2 && p[0] <= x1 + 2 && p[1] >= y0 - 2 && p[1] <= y1 + 2) return all[i].groupOf ? all.find((x) => x.key === all[i].groupOf) ?? all[i] : all[i];
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
  const names = new Map<number, string>();
  for (let i = 0; i < doc.countPages(); i++) for (const a of listAnnotations(doc, i)) if (a.name) names.set(a.key, a.name);
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
    const byKey = new Map(page.getAnnotations().map((x) => [keyOf(x), x] as const));
    for (const a of listAnnotations(doc, i)) {
      const tag = { Text: "text", Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly", FreeText: "freetext", Square: "square", Circle: "circle", Line: "line", Ink: "ink", Stamp: "stamp" }[a.type];
      if (!tag) continue;
      const nameOf = (k: number) => names.get(k) ?? `hdfstudio-${k}`;
      let attrs = `page="${i}" rect="${rectUser(a.rect)}" color="${hex(a.color.length === 3 ? a.color : [0, 0, 0])}" title="${esc(a.author)}" name="${esc(nameOf(a.key))}"`;
      if (a.inReplyTo) attrs += ` inreplyto="${esc(nameOf(a.inReplyTo))}"`;
      if (a.groupOf) attrs += ` inreplyto="${esc(nameOf(a.groupOf))}" replyType="group"`;
      if (a.state) attrs += ` state="${esc(a.state)}" statemodel="Review"`;
      if (a.type === "Text" && a.hidden) attrs += ` flags="hidden,print,nozoom,norotate"`;
      if (a.modified) attrs += ` date="${pdfDate(a.modified)}"`;
      if (a.quads) attrs += ` coords="${a.quads.map((q) => [0, 2, 4, 6].map((k) => tp(q[k], q[k + 1]).map((v) => v.toFixed(2)).join(",")).join(",")).join(",")}"`;
      const pa = byKey.get(a.key);
      const pt = (p: number[]) => tp(p[0], p[1]).map((v) => v.toFixed(2)).join(",");
      let inner = "";
      if (pa) {
        if (pa.hasBorder() && ["Square", "Circle", "Line", "Ink"].includes(a.type)) attrs += ` width="${pa.getBorderWidth()}"`;
        if (pa.hasInteriorColor()) {
          const ic = Array.from(pa.getInteriorColor());
          if (ic.length === 3) attrs += ` interior-color="${hex(ic)}"`;
        }
        if (a.type === "Text" && pa.hasIcon()) attrs += ` icon="${esc(pa.getIcon())}"`;
        if (a.type === "Line") {
          const [p1, p2] = pa.getLine();
          attrs += ` start="${pt(Array.from(p1))}" end="${pt(Array.from(p2))}"`;
          const tail = pa.getLineEndingStyles().end;
          if (tail && tail !== "None") attrs += ` tail="${tail}"`;
        }
        if (a.type === "Ink") inner = `<inklist>${pa.getInkList().map((st) => `<gesture>${st.map((p) => pt(Array.from(p))).join(";")}</gesture>`).join("")}</inklist>`;
      }
      if (a.contents) inner = `<contents>${esc(a.contents)}</contents>` + inner;
      out.push(`  <${tag} ${attrs}>${inner}</${tag}>`);
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
  const replies = new Map<number, AnnotInfo[]>();
  for (let i = 0; i < doc.countPages(); i++) for (const a of listAnnotations(doc, i)) if (a.inReplyTo) replies.set(a.inReplyTo, [...(replies.get(a.inReplyTo) ?? []), a]);
  const thread = (key: number, depth: number): string =>
    (replies.get(key) ?? []).map((r) => `\n${"  ".repeat(depth)}↳ ${r.author || "Reviewer"}: ${r.state ? `status ${r.state}` : r.contents}` + thread(r.key, depth + 1)).join("");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const st = page.toStructuredText("");
    for (const a of listAnnotations(doc, i)) {
      if (a.inReplyTo || a.groupOf) continue;
      let quoted = "";
      if (a.quads?.length) {
        const [x0, y0, x1, y1] = boundsOfQuads(a.quads);
        quoted = st.copy([x0 + 0.5, (y0 + y1) / 2], [x1 - 0.5, (y0 + y1) / 2]).replace(/\s+/g, " ").trim();
        if (a.quads.length > 1) quoted = st.copy([a.quads[0][0] + 0.5, (a.quads[0][1] + a.quads[0][5]) / 2], [a.quads.at(-1)![2] - 0.5, (a.quads.at(-1)![3] + a.quads.at(-1)![7]) / 2]).replace(/\s+/g, " ").trim();
      }
      lines.push(`Page ${i + 1} · ${a.type}${a.author ? ` · ${a.author}` : ""}${quoted ? `\n  “${quoted}”` : ""}${a.contents ? `\n  ${a.contents}` : ""}${thread(a.key, 1)}`);
    }
    st.destroy();
    page.destroy();
  }
  return lines.join("\n\n");
}

// ---------- XFDF import ----------

const XFDF_TYPES: Record<string, string> = { text: "Text", highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly", freetext: "FreeText", square: "Square", circle: "Circle", line: "Line", ink: "Ink" };
const unesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l[0] === "#") return String.fromCodePoint(l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[l];
  });
const nums = (s: string | undefined) => (s ?? "").split(/[,;\s]+/).filter(Boolean).map(Number);
function parseColor(s: string | undefined): RGB | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(s ?? "");
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export interface XfdfAnnot {
  type: string;
  page: number;
  attrs: Record<string, string>;
  contents: string;
  gestures: number[][];
}

/** Parse the annotations of an XFDF file (no DOM needed, so it works in the worker and Node). */
export function parseXfdf(xml: string): XfdfAnnot[] {
  const out: XfdfAnnot[] = [];
  const body = /<annots[^>]*>([\s\S]*?)<\/annots>/i.exec(xml)?.[1] ?? "";
  const re = /<([a-z]+)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  for (let m; (m = re.exec(body)); ) {
    const tag = m[1].toLowerCase();
    if (!XFDF_TYPES[tag]) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = unesc(a[3] ?? a[4] ?? "");
    const inner = m[4] ?? "";
    let contents = /<contents>([\s\S]*?)<\/contents>/i.exec(inner)?.[1];
    if (contents === undefined) {
      const rich = /<contents-richtext>([\s\S]*?)<\/contents-richtext>/i.exec(inner)?.[1];
      contents = rich ? rich.replace(/<\/p>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : "";
    }
    const gestures = [...inner.matchAll(/<gesture>([\s\S]*?)<\/gesture>/gi)].map((g) => nums(g[1]));
    out.push({ type: XFDF_TYPES[tag], page: Number(attrs.page ?? 0), attrs, contents: unesc(contents), gestures });
  }
  return out;
}

/**
 * Add comments from an XFDF file. Comments whose name already exists are skipped, and
 * replies are re-linked to their parents. Returns how many were added, by author.
 */
export function importXfdf(doc: mupdf.PDFDocument, xml: string): { added: number; skipped: number; authors: Record<string, number> } {
  const items = parseXfdf(xml);
  const existing = new Map<string, mupdf.PDFObject>();
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (annots.isArray()) for (let k = 0; k < annots.length; k++) {
      const o = annots.get(k);
      const nm = o.get("NM");
      // Unnamed comments are exported as hdfstudio-<object number>; recognise them on re-import.
      existing.set(nm.isString() ? nm.asString() : `hdfstudio-${o.asIndirect()}`, o);
    }
  }
  const authors: Record<string, number> = {};
  const pendingIrt: [mupdf.PDFObject, string][] = [];
  let added = 0, skipped = 0;
  for (const x of items) {
    if (x.page < 0 || x.page >= doc.countPages() || (x.attrs.name && existing.has(x.attrs.name))) {
      skipped++;
      continue;
    }
    const page = doc.loadPage(x.page) as mupdf.PDFPage;
    try {
      const m = page.getTransform();
      const tp = (px: number, py: number): Pt => [px * m[0] + py * m[2] + m[4], px * m[1] + py * m[3] + m[5]];
      const rectOf = (v: number[]) => {
        if (v.length < 4) return [0, 0, 20, 20];
        const p = [tp(v[0], v[1]), tp(v[2], v[3])];
        return [Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])];
      };
      const rect = rectOf(nums(x.attrs.rect));
      const color = parseColor(x.attrs.color);
      const width = x.attrs.width ? Number(x.attrs.width) : undefined;
      let spec: AnnotSpec;
      switch (x.type) {
        case "Highlight": case "Underline": case "StrikeOut": case "Squiggly": {
          const c = nums(x.attrs.coords);
          const quads: number[][] = [];
          for (let i = 0; i + 8 <= c.length; i += 8) quads.push([0, 2, 4, 6].flatMap((k) => tp(c[i + k], c[i + k + 1])));
          if (!quads.length) quads.push([rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]]);
          spec = { type: x.type, quads, color, contents: x.contents };
          break;
        }
        case "Text": spec = { type: "Text", at: [rect[0], rect[1]], contents: x.contents, color, icon: x.attrs.icon }; break;
        case "FreeText": spec = { type: "FreeText", rect, contents: x.contents, color: [0, 0, 0] }; break;
        case "Square": case "Circle": spec = { type: x.type, rect, color, width, fill: parseColor(x.attrs["interior-color"]), contents: x.contents }; break;
        case "Line": {
          const s = nums(x.attrs.start), e = nums(x.attrs.end);
          spec = { type: "Line", a: tp(s[0] ?? rect[0], s[1] ?? rect[1]), b: tp(e[0] ?? rect[2], e[1] ?? rect[3]), color, width, arrow: /arrow/i.test(x.attrs.tail ?? ""), contents: x.contents };
          break;
        }
        default: {
          const strokes = x.gestures.map((g) => { const pts: Pt[] = []; for (let i = 0; i + 1 < g.length; i += 2) pts.push(tp(g[i], g[i + 1])); return pts; }).filter((s) => s.length);
          if (!strokes.length) { skipped++; continue; }
          spec = { type: "Ink", strokes, color, width, contents: x.contents };
        }
      }
      const key = addAnnotation(doc, x.page, spec, x.attrs.title ?? "");
      const o = doc.newIndirect(key);
      o.put("NM", doc.newString(x.attrs.name || newName()));
      if (x.attrs.state) {
        o.put("State", doc.newString(x.attrs.state));
        o.put("StateModel", doc.newString(x.attrs.statemodel || "Review"));
      }
      if (/hidden/.test(x.attrs.flags ?? "")) o.put("F", 2 | 4 | 8 | 16);
      if (x.attrs.subject) o.put("Subj", doc.newString(x.attrs.subject));
      if (/^D:\d{8}/.test(x.attrs.date ?? "")) o.put("M", doc.newString(x.attrs.date));
      if (x.attrs.inreplyto) pendingIrt.push([o, x.attrs.inreplyto]);
      if (/^group$/i.test(x.attrs.replyType ?? x.attrs.replytype ?? "")) o.put("RT", doc.newName("Group"));
      if (x.attrs.name) existing.set(x.attrs.name, o);
      added++;
      const who = x.attrs.title || "Unknown";
      authors[who] = (authors[who] ?? 0) + 1;
    } finally {
      page.destroy();
    }
  }
  for (const [o, parent] of pendingIrt) {
    const p = existing.get(parent);
    if (p) o.put("IRT", p);
  }
  return { added, skipped, authors };
}

// ---------- Shared review sync ----------

/** True if some comment lacks a unique name (call ensureNames inside an undoable operation). */
export function needsNames(doc: mupdf.PDFDocument): boolean {
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const o = annots.get(k);
      const sub = o.get("Subtype").asName();
      if (o.get("NM").isNull() && sub !== "Link" && sub !== "Popup" && sub !== "Widget") return true;
    }
  }
  return false;
}

export interface CommentItem { name: string; author: string; xfdf: string }

/** Every comment as its own XFDF element, keyed by its unique name. */
export function commentItems(doc: mupdf.PDFDocument): CommentItem[] {
  const xml = exportXfdf(doc, "");
  const body = /<annots>([\s\S]*)<\/annots>/.exec(xml)?.[1] ?? "";
  const out: CommentItem[] = [];
  for (const m of body.matchAll(/<([a-z]+) ([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[2])?.[1];
    if (!name) continue;
    const author = /\btitle="([^"]*)"/.exec(m[2])?.[1] ?? "";
    out.push({ name: unesc(name), author: unesc(author), xfdf: m[0] });
  }
  return out;
}

function annotsByName(doc: mupdf.PDFDocument) {
  const map = new Map<string, { page: number; obj: mupdf.PDFObject }>();
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const nm = annots.get(k).get("NM");
      if (nm.isString()) map.set(nm.asString(), { page: i, obj: annots.get(k) });
    }
  }
  return map;
}

function removeAnnotObj(doc: mupdf.PDFDocument, page: number, obj: mupdf.PDFObject) {
  const p = doc.loadPage(page) as mupdf.PDFPage;
  try {
    const a = p.getAnnotations().find((x) => x.getObject().asIndirect() === obj.asIndirect());
    if (a) p.deleteAnnotation(a);
  } finally {
    p.destroy();
  }
}

/** Apply changes from other reviewers: replace or add comments (XFDF elements) and remove deleted ones. */
export function applyCommentChanges(doc: mupdf.PDFDocument, upserts: string[], deletes: string[]): { added: number; updated: number; removed: number } {
  let byName = annotsByName(doc);
  let removed = 0, updated = 0;
  for (const n of deletes) {
    const hit = byName.get(n);
    if (hit) {
      removeAnnotObj(doc, hit.page, hit.obj);
      removed++;
    }
  }
  const names = upserts.map((x) => unesc(/\bname="([^"]*)"/.exec(x)?.[1] ?? ""));
  for (const n of names) {
    const hit = byName.get(n);
    if (hit) {
      removeAnnotObj(doc, hit.page, hit.obj);
      updated++;
    }
  }
  const r = upserts.length ? importXfdf(doc, `<xfdf><annots>${upserts.join("")}</annots></xfdf>`) : { added: 0 };
  // Replies to a comment that was just replaced still point at the old object: re-link by name.
  byName = annotsByName(doc);
  for (const { obj } of byName.values()) {
    const irt = obj.get("IRT");
    if (!irt.isDictionary()) continue;
    const nm = irt.get("NM");
    const current = nm.isString() ? byName.get(nm.asString()) : undefined;
    if (current && current.obj.asIndirect() !== irt.asIndirect()) obj.put("IRT", current.obj);
  }
  return { added: r.added - updated, updated, removed };
}
