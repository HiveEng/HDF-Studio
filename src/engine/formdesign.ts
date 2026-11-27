// Form designer: create, edit and delete AcroForm fields, and detect where fields belong on a
// flat form (underscores, ☐ boxes, drawn lines and boxes). Rectangles are page display space
// (points, origin top-left), like everything else in the UI.
import * as mupdf from "mupdf";
import { readLogic, writeLogic, recalculate, setDisplayed, NO_LOGIC, type FieldLogic } from "./formcalc";

export type NewFieldType = "text" | "date" | "checkbox" | "radio" | "combobox" | "listbox" | "signature" | "button";

/** Standard fonts every PDF reader has: Helvetica, Helvetica Bold, Times, Courier. */
export type FontId = "Helv" | "HeBo" | "TiRo" | "Cour";
const FONT_FILE: Record<FontId, string> = { Helv: "Helvetica", HeBo: "Helvetica-Bold", TiRo: "Times-Roman", Cour: "Courier" };
export type CheckStyle = "check" | "cross" | "circle" | "square" | "diamond" | "star";
/** The ZapfDingbats character each check style draws. */
const CHECK_CHAR: Record<CheckStyle, string> = { check: "4", cross: "8", circle: "l", square: "n", diamond: "u", star: "H" };
export type ButtonAction = { kind: "none" } | { kind: "reset" } | { kind: "print" } | { kind: "url"; url: string };

/** How a field looks. Colors are RGB 0..1; null = none (transparent). */
export interface FieldLook {
  borderColor: number[] | null;
  fillColor: number[] | null;
  textColor: number[];
  font: FontId;
  /** 0 left, 1 centre, 2 right. */
  align: 0 | 1 | 2;
  borderWidth: number;
  /** Check boxes and radio buttons. */
  checkStyle: CheckStyle;
}
export const DEFAULT_LOOK: FieldLook = { borderColor: [0.35, 0.35, 0.36], fillColor: [1, 1, 1], textColor: [0, 0, 0], font: "Helv", align: 0, borderWidth: 1, checkStyle: "check" };

export interface FieldSpec {
  type: NewFieldType;
  name: string;
  rect: number[];
  /** Choices for combo/list boxes. */
  options?: string[];
  /** Radio buttons: the value this button stands for (default: Choice N). Checkboxes: on value (default Yes). */
  exportValue?: string;
  value?: string;
  required?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  maxLen?: number;
  /** 0 = auto size. */
  fontSize?: number;
  tooltip?: string;
  /** Number/date format, calculation and validation (text fields). */
  logic?: FieldLogic;
  /** Date fields: the date style (default mm/dd/yyyy). */
  datePattern?: string;
  look?: Partial<FieldLook>;
  /** Buttons: the text on the button, and what clicking it does. */
  caption?: string;
  action?: ButtonAction;
  /** Text: spread the characters evenly over Character limit boxes. */
  comb?: boolean;
  /** Dropdowns: allow typing a value that isn't in the list. */
  editable?: boolean;
  /** List boxes: allow picking more than one. */
  multiSelect?: boolean;
}

export interface FieldProps {
  key: number;
  page: number;
  type: string;
  name: string;
  rect: number[];
  options: string[];
  exportValue: string | null;
  required: boolean;
  readOnly: boolean;
  multiline: boolean;
  maxLen: number;
  fontSize: number;
  tooltip: string;
  logic: FieldLogic;
  look: FieldLook;
  caption: string;
  action: ButtonAction;
  comb: boolean;
  editable: boolean;
  multiSelect: boolean;
  /** Current value (the default for a new copy). */
  value: string;
}

export type FieldPatch = Partial<Omit<FieldSpec, "type" | "datePattern">>;

const FF_READONLY = 1, FF_REQUIRED = 2, FF_MULTILINE = 1 << 12, FF_RADIO = 1 << 15, FF_NOTOGGLEOFF = 1 << 14, FF_PUSHBUTTON = 1 << 16, FF_COMBO = 1 << 17, FF_EDIT = 1 << 18, FF_MULTISELECT = 1 << 21, FF_COMB = 1 << 24;
const safeName = (s: string) => s.replace(/[\s/()<>[\]{}%#]/g, "_");

// ---------- coordinates ----------
function toUserRect(page: mupdf.PDFPage, r: number[]): number[] {
  const inv = mupdf.Matrix.invert(page.getTransform());
  const p = (x: number, y: number) => [x * inv[0] + y * inv[2] + inv[4], x * inv[1] + y * inv[3] + inv[5]];
  const a = p(r[0], r[1]), b = p(r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((v) => +v.toFixed(2));
}

// ---------- AcroForm plumbing ----------
function acroForm(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const root = doc.getTrailer().get("Root");
  let af = root.get("AcroForm");
  if (!af.isDictionary()) {
    af = doc.addObject(doc.newDictionary());
    root.put("AcroForm", af);
  }
  if (!af.get("Fields").isArray()) af.put("Fields", doc.newArray());
  let dr = af.get("DR");
  if (!dr.isDictionary()) {
    dr = doc.newDictionary();
    af.put("DR", dr);
  }
  let fonts = dr.get("Font");
  if (!fonts.isDictionary()) {
    fonts = doc.newDictionary();
    dr.put("Font", fonts);
  }
  for (const [id, file] of Object.entries(FONT_FILE)) if (fonts.get(id).isNull()) fonts.put(id, doc.addSimpleFont(new mupdf.Font(file)));
  if (fonts.get("ZaDb").isNull()) fonts.put("ZaDb", doc.addSimpleFont(new mupdf.Font("ZapfDingbats")));
  if (af.get("DA").isNull()) af.put("DA", doc.newString("/Helv 0 Tf 0 g"));
  return af;
}

function pageAnnots(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject): mupdf.PDFObject {
  let a = pageObj.get("Annots");
  if (!a.isArray()) {
    a = doc.newArray();
    pageObj.put("Annots", a);
  }
  return a;
}

/** Every terminal field name in the document (for unique naming). */
export function fieldNames(doc: mupdf.PDFDocument): Set<string> {
  const out = new Set<string>();
  const walk = (o: mupdf.PDFObject, prefix: string, depth: number) => {
    if (depth > 20) return;
    const t = o.get("T");
    const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix;
    const kids = o.get("Kids");
    if (name) out.add(name);
    if (kids.isArray()) for (let i = 0; i < kids.length; i++) walk(kids.get(i), name, depth + 1);
  };
  const af = doc.getTrailer().get("Root").get("AcroForm");
  const fields = af.isDictionary() ? af.get("Fields") : null;
  if (fields?.isArray()) for (let i = 0; i < fields.length; i++) walk(fields.get(i), "", 0);
  return out;
}

export function uniqueName(taken: Set<string>, base: string): string {
  const clean = base.replace(/[.\s]+/g, " ").trim().slice(0, 60) || "Field";
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`)) return `${clean} ${i}`;
}

// ---------- look: colors, font, alignment, border ----------
const colorOf = (a: mupdf.PDFObject): number[] | null => {
  if (!a.isArray() || a.length === 0) return null;
  const v = Array.from({ length: a.length }, (_, i) => +a.get(i).asNumber().toFixed(3));
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 4) return [0, 1, 2].map((i) => +(1 - Math.min(1, v[i] + v[3])).toFixed(3));
  return v.slice(0, 3);
};
const fx = (n: number) => +n.toFixed(3);
const rg = (c: number[], stroke = false) => `${c.map(fx).join(" ")} ${stroke ? "RG" : "rg"}`;

function daOf(o: mupdf.PDFObject): string {
  const da = o.get("DA");
  if (da.isString()) return da.asString();
  const p = fieldDict(o).get("DA");
  return p.isString() ? p.asString() : "";
}
function parseDA(da: string): { font: FontId; size: number; color: number[] } {
  const tf = /\/(\S+)\s+([\d.]+)\s+Tf/.exec(da);
  const font = (tf && tf[1] in FONT_FILE ? tf[1] : "Helv") as FontId;
  let color = [0, 0, 0];
  const c3 = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da), c1 = /([\d.]+)\s+g(?:\s|$)/.exec(da);
  if (c3) color = [+(+c3[1]).toFixed(3), +(+c3[2]).toFixed(3), +(+c3[3]).toFixed(3)];
  else if (c1) color = [+c1[1], +c1[1], +c1[1]];
  return { font, size: tf ? +tf[2] : 0, color };
}
const makeDA = (font: FontId, size: number, color: number[]) => `/${font} ${fx(size)} Tf ${color.every((v) => v === color[0]) ? `${fx(color[0])} g` : rg(color)}`;

function readLook(o: mupdf.PDFObject): FieldLook {
  const mk = o.get("MK");
  const da = parseDA(daOf(o));
  const bs = o.get("BS");
  const q = o.get("Q").isNumber() ? o.get("Q").asNumber() : fieldDict(o).get("Q").isNumber() ? fieldDict(o).get("Q").asNumber() : 0;
  const ca = mk.isDictionary() && mk.get("CA").isString() ? mk.get("CA").asString() : "";
  const style = (Object.keys(CHECK_CHAR) as CheckStyle[]).find((k) => CHECK_CHAR[k] === ca) ?? "check";
  return {
    borderColor: mk.isDictionary() ? colorOf(mk.get("BC")) : null,
    fillColor: mk.isDictionary() ? colorOf(mk.get("BG")) : null,
    textColor: da.color,
    font: da.font,
    align: (Math.max(0, Math.min(2, q)) as 0 | 1 | 2),
    borderWidth: bs.isDictionary() && bs.get("W").isNumber() ? bs.get("W").asNumber() : 1,
    checkStyle: style,
  };
}

function writeLook(doc: mupdf.PDFDocument, o: mupdf.PDFObject, look: Partial<FieldLook>, kind: "text" | "toggle" | "button" | "sig") {
  let mk = o.get("MK");
  if (!mk.isDictionary()) {
    mk = doc.newDictionary();
    o.put("MK", mk);
  }
  if (look.borderColor !== undefined) look.borderColor ? mk.put("BC", look.borderColor.map(fx)) : mk.delete("BC");
  if (look.fillColor !== undefined) look.fillColor ? mk.put("BG", look.fillColor.map(fx)) : mk.delete("BG");
  if (look.borderWidth !== undefined) {
    let bs = o.get("BS");
    if (!bs.isDictionary()) {
      bs = doc.newDictionary();
      o.put("BS", bs);
    }
    bs.put("W", Math.max(0, Math.min(6, look.borderWidth)));
    if (bs.get("S").isNull()) bs.put("S", doc.newName("S"));
  }
  if (look.align !== undefined && kind !== "toggle") o.put("Q", look.align);
  if (look.checkStyle !== undefined && kind === "toggle") mk.put("CA", doc.newString(CHECK_CHAR[look.checkStyle]));
  if ((look.font !== undefined || look.textColor !== undefined) && kind !== "sig") {
    const cur = parseDA(daOf(o));
    o.put("DA", doc.newString(makeDA(kind === "toggle" ? "ZaDb" as FontId : look.font ?? cur.font, cur.size, look.textColor ?? cur.color)));
  }
}

// ---------- appearances for check boxes, radio buttons and push buttons ----------
function stream(doc: mupdf.PDFDocument, w: number, h: number, content: string, font?: FontId | "ZaDb"): mupdf.PDFObject {
  const res = doc.newDictionary();
  if (font) {
    const f = doc.newDictionary();
    f.put(font, doc.getTrailer().get("Root").get("AcroForm").get("DR").get("Font").get(font));
    res.put("Font", f);
  }
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Form"));
  dict.put("BBox", [0, 0, w, h]);
  dict.put("Resources", res);
  return doc.addStream(content, dict);
}

function circle(cx: number, cy: number, r: number) {
  const k = 0.5523 * r;
  return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c`;
}

/** Width and height in the widget's own (unrotated) space. */
function boxSize(o: mupdf.PDFObject): [number, number] {
  const r = o.get("Rect");
  let w = Math.abs(r.get(2).asNumber() - r.get(0).asNumber()), h = Math.abs(r.get(3).asNumber() - r.get(1).asNumber());
  const rot = o.get("MK").isDictionary() && o.get("MK").get("R").isNumber() ? o.get("MK").get("R").asNumber() : 0;
  if (rot % 180) [w, h] = [h, w];
  return [w, h];
}
/** Appearance streams are drawn upright, then turned to match a rotated page. */
function setMatrix(o: mupdf.PDFObject, ap: mupdf.PDFObject, w: number, h: number) {
  const rot = o.get("MK").isDictionary() && o.get("MK").get("R").isNumber() ? ((o.get("MK").get("R").asNumber() % 360) + 360) % 360 : 0;
  const m = rot === 90 ? [0, 1, -1, 0, h, 0] : rot === 180 ? [-1, 0, 0, -1, w, h] : rot === 270 ? [0, -1, 1, 0, 0, w] : null;
  if (m) ap.put("Matrix", m);
}

function setToggleAppearance(doc: mupdf.PDFDocument, o: mupdf.PDFObject, on: string, radio: boolean) {
  const [w, h] = boxSize(o);
  const look = readLook(o);
  const f = (n: number) => +n.toFixed(2);
  const bw = look.borderWidth;
  const bc = look.borderColor && bw > 0 ? look.borderColor : null;
  let off: string;
  if (radio) {
    const rr = Math.min(w, h) / 2;
    const path = circle(f(w / 2), f(h / 2), f(rr - bw / 2));
    off = (look.fillColor ? `${rg(look.fillColor)} ${path} f ` : "") + (bc ? `${rg(bc, true)} ${fx(bw)} w ${path} S` : "");
  } else {
    off = (look.fillColor ? `${rg(look.fillColor)} 0 0 ${f(w)} ${f(h)} re f ` : "") + (bc ? `${rg(bc, true)} ${fx(bw)} w ${f(bw / 2)} ${f(bw / 2)} ${f(w - bw)} ${f(h - bw)} re S` : "");
  }
  let onS: string;
  let zadb = false;
  if (radio && look.checkStyle === "circle") onS = `${off} ${rg(look.textColor)} ${circle(f(w / 2), f(h / 2), f((Math.min(w, h) / 2) * 0.45))} f`;
  else {
    zadb = true;
    const size = f(Math.min(w, h) * (radio ? 0.7 : 0.8));
    // Glyph widths in ZapfDingbats (per 1000) for centring.
    const gw = { check: 846, cross: 838, circle: 791, square: 761, diamond: 759, star: 816 }[look.checkStyle] / 1000;
    onS = `${off} ${rg(look.textColor)} BT /ZaDb ${size} Tf ${f((w - size * gw) / 2)} ${f((h - size * 0.7) / 2)} Td (${CHECK_CHAR[look.checkStyle]}) Tj ET`;
  }
  const n = doc.newDictionary();
  const onAp = stream(doc, w, h, onS, zadb ? "ZaDb" : undefined), offAp = stream(doc, w, h, off || " ");
  setMatrix(o, onAp, w, h);
  setMatrix(o, offAp, w, h);
  n.put(on, onAp);
  n.put("Off", offAp);
  const ap = doc.newDictionary();
  ap.put("N", n);
  o.put("AP", ap);
  let mk = o.get("MK");
  if (!mk.isDictionary()) {
    mk = doc.newDictionary();
    o.put("MK", mk);
  }
  mk.put("CA", doc.newString(CHECK_CHAR[look.checkStyle]));
}

const fontCache = new Map<string, mupdf.Font>();
function textWidth(font: FontId, size: number, s: string) {
  let f = fontCache.get(font);
  if (!f) fontCache.set(font, (f = new mupdf.Font(FONT_FILE[font])));
  let w = 0;
  for (const ch of s) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!), 0);
  return w * size;
}
const pdfStr = (s: string) => `(${s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?")})`;

/** A push button: filled, bordered, with its caption centred. */
function setButtonAppearance(doc: mupdf.PDFDocument, o: mupdf.PDFObject) {
  const [w, h] = boxSize(o);
  const look = readLook(o);
  const mk = o.get("MK");
  const caption = mk.isDictionary() && mk.get("CA").isString() ? mk.get("CA").asString() : "";
  const da = parseDA(daOf(o));
  const bw = look.borderColor ? look.borderWidth : 0;
  let size = da.size || Math.min(12, h * 0.6);
  if (!da.size) while (size > 4 && textWidth(look.font, size, caption) > w - 2 * bw - 4) size -= 0.5;
  const f = (n: number) => +n.toFixed(2);
  const tw = textWidth(look.font, size, caption);
  const x = look.align === 0 ? bw + 2 : look.align === 2 ? w - bw - 2 - tw : (w - tw) / 2;
  let c = "";
  if (look.fillColor) {
    c += `${rg(look.fillColor)} 0 0 ${f(w)} ${f(h)} re f `;
    // A light bevel so it reads as a button.
    c += `1 1 1 rg ${f(bw)} ${f(bw)} m ${f(bw)} ${f(h - bw)} l ${f(w - bw)} ${f(h - bw)} l ${f(w - bw - 1.5)} ${f(h - bw - 1.5)} l ${f(bw + 1.5)} ${f(h - bw - 1.5)} l ${f(bw + 1.5)} ${f(bw + 1.5)} l f `;
    c += `0.5 0.5 0.5 rg ${f(w - bw)} ${f(h - bw)} m ${f(w - bw)} ${f(bw)} l ${f(bw)} ${f(bw)} l ${f(bw + 1.5)} ${f(bw + 1.5)} l ${f(w - bw - 1.5)} ${f(bw + 1.5)} l ${f(w - bw - 1.5)} ${f(h - bw - 1.5)} l f `;
  }
  if (look.borderColor && bw > 0) c += `${rg(look.borderColor, true)} ${fx(bw)} w ${f(bw / 2)} ${f(bw / 2)} ${f(w - bw)} ${f(h - bw)} re S `;
  if (caption) c += `BT ${rg(look.textColor)} /${look.font} ${f(size)} Tf ${f(x)} ${f((h - size * 0.7) / 2)} Td ${pdfStr(caption)} Tj ET`;
  const ap = doc.newDictionary();
  const s = stream(doc, w, h, c || " ", look.font);
  setMatrix(o, s, w, h);
  ap.put("N", s);
  o.put("AP", ap);
}

function readAction(o: mupdf.PDFObject): ButtonAction {
  const a = o.get("A");
  if (!a.isDictionary()) return { kind: "none" };
  const s = a.get("S").isName() ? a.get("S").asName() : "";
  if (s === "ResetForm") return { kind: "reset" };
  if (s === "Named" && a.get("N").isName() && a.get("N").asName() === "Print") return { kind: "print" };
  if (s === "URI" && a.get("URI").isString()) return { kind: "url", url: a.get("URI").asString() };
  if (s === "JavaScript" && /\bprint\s*\(/.test(a.get("JS").isString() ? a.get("JS").asString() : "")) return { kind: "print" };
  return { kind: "none" };
}
function writeAction(doc: mupdf.PDFDocument, o: mupdf.PDFObject, act: ButtonAction) {
  if (act.kind === "none") return o.delete("A");
  const a = doc.newDictionary();
  a.put("Type", doc.newName("Action"));
  if (act.kind === "reset") a.put("S", doc.newName("ResetForm"));
  else if (act.kind === "print") {
    a.put("S", doc.newName("Named"));
    a.put("N", doc.newName("Print"));
  } else {
    a.put("S", doc.newName("URI"));
    a.put("URI", doc.newString(act.url));
  }
  o.put("A", a);
}

// ---------- create ----------
function newWidget(doc: mupdf.PDFDocument, page: mupdf.PDFPage, rect: number[]): mupdf.PDFObject {
  const o = doc.newDictionary();
  o.put("Type", doc.newName("Annot"));
  o.put("Subtype", doc.newName("Widget"));
  o.put("Rect", toUserRect(page, rect));
  o.put("F", 4);
  o.put("P", page.getObject());
  const mk = doc.newDictionary();
  mk.put("BC", [0.35, 0.35, 0.36]);
  mk.put("BG", [1, 1, 1]);
  const rot = page.getObject().getInheritable("Rotate");
  if (rot.isNumber() && rot.asNumber() % 360) mk.put("R", ((rot.asNumber() % 360) + 360) % 360);
  o.put("MK", mk);
  return o;
}

function applyFlags(o: mupdf.PDFObject, set: number, clear: number) {
  const ff = o.get("Ff");
  const cur = ff.isNumber() ? ff.asNumber() : 0;
  o.put("Ff", (cur | set) & ~clear);
}

/** Add a form field. Radio buttons with the same name join one group. Returns the widget's key. */
export function addField(doc: mupdf.PDFDocument, pageIndex: number, spec: FieldSpec): number {
  const af = acroForm(doc);
  const fields = af.get("Fields");
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  // A date field is a text field with a date format (and a calendar when filling in).
  const type = spec.type === "date" ? "text" : spec.type;
  const logic: FieldLogic | undefined = spec.type === "date" ? { ...(spec.logic ?? NO_LOGIC), format: { kind: "date", pattern: spec.datePattern || "mm/dd/yyyy" } } : spec.logic;
  const font: FontId = spec.look?.font ?? "Helv";
  const color = spec.look?.textColor ?? [0, 0, 0];
  try {
    const pageObj = page.getObject();
    const w = newWidget(doc, page, spec.rect);
    const fs = spec.fontSize ?? 0;
    let flags = (spec.readOnly ? FF_READONLY : 0) | (spec.required ? FF_REQUIRED : 0);
    let ref: mupdf.PDFObject;
    if (type === "radio") {
      // Find or create the group parent.
      let parent: mupdf.PDFObject | null = null;
      for (let i = 0; i < fields.length; i++) {
        const f = fields.get(i);
        const t = f.get("T");
        if (t.isString() && t.asString() === spec.name && f.get("FT").asName() === "Btn" && f.get("Kids").isArray()) parent = f;
      }
      if (!parent) {
        const p = doc.newDictionary();
        p.put("FT", doc.newName("Btn"));
        p.put("T", doc.newString(spec.name));
        p.put("Ff", flags | FF_RADIO | FF_NOTOGGLEOFF);
        p.put("V", doc.newName("Off"));
        p.put("Kids", doc.newArray());
        parent = doc.addObject(p);
        fields.push(parent);
      }
      const kids = parent.get("Kids");
      let on = safeName(spec.exportValue || `Choice ${kids.length + 1}`);
      // Each button in a group needs its own value.
      const used = new Set<string>();
      for (let i = 0; i < kids.length; i++) {
        const n = kids.get(i).get("AP").get("N");
        if (n.isDictionary()) n.forEach((_v, k) => k !== "Off" && used.add(String(k)));
      }
      for (let i = 2; used.has(on); i++) on = safeName(`${spec.exportValue || "Choice"} ${i}`);
      w.put("Parent", parent);
      w.put("AS", doc.newName("Off"));
      w.put("DA", doc.newString(makeDA("ZaDb" as FontId, 0, color)));
      ref = doc.addObject(w);
      kids.push(ref);
      writeLook(doc, ref, { checkStyle: "circle", ...spec.look }, "toggle");
      setToggleAppearance(doc, ref, on, true);
    } else {
      w.put("T", doc.newString(spec.name));
      if (spec.tooltip) w.put("TU", doc.newString(spec.tooltip));
      switch (type) {
        case "text":
          w.put("FT", doc.newName("Tx"));
          w.put("DA", doc.newString(makeDA(font, fs, color)));
          if (spec.multiline) flags |= FF_MULTILINE;
          if (spec.maxLen) w.put("MaxLen", spec.maxLen);
          if (spec.comb && spec.maxLen && !spec.multiline) flags |= FF_COMB;
          break;
        case "checkbox":
          w.put("FT", doc.newName("Btn"));
          w.put("V", doc.newName("Off"));
          w.put("AS", doc.newName("Off"));
          w.put("DA", doc.newString(makeDA("ZaDb" as FontId, 0, color)));
          break;
        case "combobox":
        case "listbox":
          w.put("FT", doc.newName("Ch"));
          w.put("DA", doc.newString(makeDA(font, fs, color)));
          if (type === "combobox") flags |= FF_COMBO | (spec.editable ? FF_EDIT : 0);
          else if (spec.multiSelect) flags |= FF_MULTISELECT;
          w.put("Opt", (spec.options ?? []).map((s) => doc.newString(s)));
          break;
        case "signature":
          w.put("FT", doc.newName("Sig"));
          break;
        case "button":
          w.put("FT", doc.newName("Btn"));
          flags |= FF_PUSHBUTTON;
          w.put("DA", doc.newString(makeDA(font, fs, color)));
          w.put("MK", w.get("MK"));
          w.get("MK").put("BG", [0.85, 0.86, 0.87]);
          w.get("MK").put("CA", doc.newString(spec.caption ?? spec.name));
          if (spec.look?.align === undefined) w.put("Q", 1);
          break;
      }
      w.put("Ff", flags);
      ref = doc.addObject(w);
      fields.push(ref);
      if (spec.look) writeLook(doc, ref, spec.look, type === "checkbox" ? "toggle" : type === "button" ? "button" : type === "signature" ? "sig" : "text");
      if (type === "checkbox") setToggleAppearance(doc, ref, safeName(spec.exportValue || "Yes"), false);
      if (type === "button") {
        writeAction(doc, ref, spec.action ?? { kind: "none" });
        setButtonAppearance(doc, ref);
      }
    }
    if (type === "radio" && spec.tooltip) ref.put("TU", doc.newString(spec.tooltip));
    pageAnnots(doc, pageObj).push(ref);
    const key = ref.asIndirect();
    if (logic && type === "text") writeLogic(doc, ref, logic);
    // Let MuPDF build the appearance for text and choice fields (and set any initial value).
    page.destroy();
    const fresh = doc.loadPage(pageIndex) as mupdf.PDFPage;
    try {
      const wid = fresh.getWidgets().find((x) => x.getObject().asIndirect() === key);
      if (wid) {
        if (type === "text") {
          if (logic && logic.format.kind !== "none") setDisplayed(doc, wid, spec.value ?? "", logic.format);
          else wid.setTextValue(spec.value ?? "");
        } else if ((type === "combobox" || type === "listbox") && spec.value) wid.setChoiceValue(spec.value);
        else if (type === "checkbox" && spec.value && /^(1|y|yes|true|on|x)$/i.test(spec.value)) wid.toggle();
        if (type !== "button") wid.update();
      }
    } finally {
      fresh.destroy();
    }
    return key;
  } finally {
    try {
      page.destroy();
    } catch {
      /* already destroyed */
    }
  }
}

// ---------- inspect / edit / delete ----------
function findWidget(page: mupdf.PDFPage, key: number) {
  const w = page.getWidgets().find((x) => x.getObject().asIndirect() === key);
  if (!w) throw new Error("Field not found (it may have been deleted)");
  return w;
}

/** The dictionary that holds the field's name and flags (the radio group parent, else the widget). */
function fieldDict(o: mupdf.PDFObject) {
  const p = o.get("Parent");
  return o.get("T").isNull() && p.isDictionary() ? p : o;
}

function onStateOf(o: mupdf.PDFObject): string | null {
  let on: string | null = null;
  const n = o.get("AP").get("N");
  if (n.isDictionary()) n.forEach((_v, k) => k !== "Off" && (on = String(k)));
  return on;
}

export function fieldProps(doc: mupdf.PDFDocument, pageIndex: number, key: number): FieldProps {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const w = findWidget(page, key);
    const o = w.getObject();
    const fd = fieldDict(o);
    const ff = w.getFieldFlags();
    const tu = fd.get("TU");
    const type = w.getFieldType();
    const mk = o.get("MK");
    return {
      key,
      page: pageIndex,
      type,
      name: w.getName(),
      rect: Array.from(w.getBounds()),
      options: w.isChoice() ? w.getOptions() : [],
      exportValue: w.isCheckbox() || w.isRadioButton() ? onStateOf(o) : null,
      required: (ff & FF_REQUIRED) !== 0,
      readOnly: (ff & FF_READONLY) !== 0,
      multiline: w.isText() && w.isMultiline(),
      maxLen: w.isText() ? w.getMaxLen() : 0,
      fontSize: parseDA(daOf(o)).size,
      tooltip: tu.isString() ? tu.asString() : "",
      logic: readLogic(o),
      look: readLook(o),
      caption: type === "button" && mk.isDictionary() && mk.get("CA").isString() ? mk.get("CA").asString() : "",
      action: type === "button" ? readAction(o) : { kind: "none" },
      comb: (ff & FF_COMB) !== 0,
      editable: type === "combobox" && (ff & FF_EDIT) !== 0,
      multiSelect: type === "listbox" && (ff & FF_MULTISELECT) !== 0,
      value: type === "signature" || type === "button" ? "" : w.getValue() ?? "",
    };
  } finally {
    page.destroy();
  }
}

export function updateField(doc: mupdf.PDFDocument, pageIndex: number, key: number, patch: FieldPatch) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const w = findWidget(page, key);
    const o = w.getObject();
    const fd = fieldDict(o);
    const type = w.getFieldType();
    const toggle = w.isCheckbox() || w.isRadioButton();
    if (patch.name !== undefined && patch.name.trim() && patch.name !== w.getName()) {
      const taken = fieldNames(doc);
      if (taken.has(patch.name.trim())) throw new Error(`There is already a field named “${patch.name.trim()}”`);
      fd.put("T", doc.newString(patch.name.trim()));
    }
    if (patch.tooltip !== undefined) patch.tooltip ? fd.put("TU", doc.newString(patch.tooltip)) : fd.delete("TU");
    const set = (on: boolean | undefined, bit: number) => on !== undefined && applyFlags(fd, on ? bit : 0, on ? 0 : bit);
    set(patch.required, FF_REQUIRED);
    set(patch.readOnly, FF_READONLY);
    if (w.isText()) {
      set(patch.multiline, FF_MULTILINE);
      if (patch.maxLen !== undefined) patch.maxLen > 0 ? o.put("MaxLen", patch.maxLen) : o.delete("MaxLen");
      set(patch.comb, FF_COMB);
      if (!o.get("MaxLen").isNumber() || (fd.get("Ff").isNumber() && fd.get("Ff").asNumber() & FF_MULTILINE)) applyFlags(fd, 0, FF_COMB);
    }
    if (type === "combobox") set(patch.editable, FF_EDIT);
    if (type === "listbox") set(patch.multiSelect, FF_MULTISELECT);
    if (patch.fontSize !== undefined && (w.isText() || w.isChoice() || type === "button")) {
      const cur = parseDA(daOf(o));
      o.put("DA", doc.newString(makeDA(cur.font, patch.fontSize, cur.color)));
    }
    if (patch.options && w.isChoice()) o.put("Opt", patch.options.map((s) => doc.newString(s)));
    if (patch.rect) o.put("Rect", toUserRect(page, patch.rect));
    if (patch.look) writeLook(doc, o, patch.look, toggle ? "toggle" : type === "button" ? "button" : type === "signature" ? "sig" : "text");
    if (type === "button") {
      if (patch.caption !== undefined) o.get("MK").put("CA", doc.newString(patch.caption));
      if (patch.action) writeAction(doc, o, patch.action);
    }
    let on = toggle ? onStateOf(o) ?? "Yes" : "";
    if (toggle && patch.exportValue !== undefined && patch.exportValue.trim() && safeName(patch.exportValue.trim()) !== on) {
      const next = safeName(patch.exportValue.trim());
      const wasOn = o.get("AS").isName() && o.get("AS").asName() === on;
      if (wasOn) {
        o.put("AS", doc.newName(next));
        fd.put("V", doc.newName(next));
      }
      on = next;
    }
    if (toggle && (patch.rect || patch.look || patch.exportValue !== undefined)) setToggleAppearance(doc, o, on, w.isRadioButton());
    if (type === "button" && (patch.rect || patch.look || patch.caption !== undefined || patch.fontSize !== undefined)) setButtonAppearance(doc, o);
    if (patch.logic && w.isText()) writeLogic(doc, o, patch.logic);
    if (w.isText()) setDisplayed(doc, w, patch.value ?? w.getValue() ?? "", readLogic(o).format);
    else if (w.isChoice()) {
      // Rebuild the appearance with the new look/choices.
      const v = w.getValue();
      if (v) w.setChoiceValue(v);
    }
    if (type !== "button" && !toggle) w.update();
  } finally {
    page.destroy();
  }
  if (patch.logic) recalculate(doc);
}

function removeFrom(arr: mupdf.PDFObject, num: number) {
  if (!arr.isArray()) return;
  for (let i = arr.length - 1; i >= 0; i--) if (arr.get(i).asIndirect() === num) arr.delete(i);
}

export function deleteField(doc: mupdf.PDFDocument, pageIndex: number, key: number) {
  const pageObj = doc.findPage(pageIndex) as mupdf.PDFObject;
  removeFrom(pageObj.get("Annots"), key);
  const o = doc.newIndirect(key);
  const parent = o.get("Parent");
  const af = doc.getTrailer().get("Root").get("AcroForm");
  const fields = af.isDictionary() ? af.get("Fields") : doc.newArray();
  if (parent.isDictionary()) {
    removeFrom(parent.get("Kids"), key);
    if (parent.get("Kids").length === 0) removeFrom(fields, parent.asIndirect());
  } else removeFrom(fields, key);
  const co = af.isDictionary() ? af.get("CO") : null;
  if (co?.isArray()) removeFrom(co, key);
}

// ---------- arranging several fields ----------
export interface FieldRef { page: number; key: number }

/** Move/resize many fields at once (align, distribute, match size). */
export function setFieldRects(doc: mupdf.PDFDocument, items: (FieldRef & { rect: number[] })[]) {
  for (const it of items) updateField(doc, it.page, it.key, { rect: it.rect });
}

/** Apply the same change to many fields (e.g. Required, font size, colors). */
export function updateFields(doc: mupdf.PDFDocument, items: FieldRef[], patch: FieldPatch) {
  if (patch.name !== undefined && items.length > 1) throw new Error("Several fields can't share one name");
  for (const it of items) updateField(doc, it.page, it.key, patch);
}

export function deleteFields(doc: mupdf.PDFDocument, items: FieldRef[]) {
  for (const it of items) deleteField(doc, it.page, it.key);
}

/** The next free name in a series: "Qty 1" → "Qty 2", "Name" → "Name 2". */
export function nextName(taken: Set<string>, name: string): string {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (m) {
    for (let i = +m[2] + 1; ; i++) {
      const n = `${m[1]}${i}`;
      if (!taken.has(n)) return n;
    }
  }
  return uniqueName(taken, name);
}

/**
 * Copy a field to new places (duplicate, paste, a grid of copies, the same spot on other pages).
 * Copies keep every property and get the next name in the series; a radio button copy joins
 * the same group as a new choice. Returns the new fields.
 */
export function cloneField(doc: mupdf.PDFDocument, src: FieldRef, targets: { page: number; rect: number[] }[]): FieldRef[] {
  const p = fieldProps(doc, src.page, src.key);
  const taken = fieldNames(doc);
  const type: NewFieldType = p.type === "radiobutton" ? "radio" : (p.type as NewFieldType);
  const out: FieldRef[] = [];
  let name = p.name;
  for (const t of targets) {
    if (type !== "radio") {
      name = nextName(taken, name);
      taken.add(name);
    }
    const spec: FieldSpec = {
      type, name, rect: t.rect, options: p.options, required: p.required, readOnly: p.readOnly, multiline: p.multiline, maxLen: p.maxLen,
      fontSize: p.fontSize, tooltip: p.tooltip, logic: p.logic, look: p.look, caption: p.caption, action: p.action, comb: p.comb,
      editable: p.editable, multiSelect: p.multiSelect, exportValue: type === "checkbox" ? p.exportValue ?? undefined : undefined,
    };
    out.push({ page: t.page, key: addField(doc, t.page, spec) });
  }
  if (p.logic.calc.kind !== "none") recalculate(doc);
  return out;
}

// ---------- tab order ----------
export type TabOrder = "rows" | "columns" | "manual" | "structure" | "unspecified";

/** The fields on a page in the order Tab moves through them, and how that order is set. */
export function tabOrder(doc: mupdf.PDFDocument, pageIndex: number): { order: TabOrder; keys: number[] } {
  const pageObj = doc.findPage(pageIndex) as mupdf.PDFObject;
  const tabs = pageObj.get("Tabs");
  const t = tabs.isName() ? tabs.asName() : "";
  const keys: number[] = [];
  const annots = pageObj.get("Annots");
  if (annots.isArray()) for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i);
    if (a.get("Subtype").isName() && a.get("Subtype").asName() === "Widget") keys.push(a.asIndirect());
  }
  return { order: t === "R" ? "rows" : t === "C" ? "columns" : t === "S" ? "structure" : t === "M" ? "manual" : "unspecified", keys };
}

/** Put the page's fields in this Tab order (fields not listed keep their place after the others). */
export function setTabOrder(doc: mupdf.PDFDocument, pageIndex: number, keys: number[], mark: "R" | "C" | null = null) {
  const pageObj = doc.findPage(pageIndex) as mupdf.PDFObject;
  const annots = pageObj.get("Annots");
  if (!annots.isArray()) return;
  const all: mupdf.PDFObject[] = [];
  for (let i = 0; i < annots.length; i++) all.push(annots.get(i));
  const isW = (a: mupdf.PDFObject) => a.get("Subtype").isName() && a.get("Subtype").asName() === "Widget";
  const widgets = all.filter(isW);
  const rank = (a: mupdf.PDFObject) => {
    const i = keys.indexOf(a.asIndirect());
    return i < 0 ? keys.length + widgets.indexOf(a) : i;
  };
  const sorted = widgets.slice().sort((a, b) => rank(a) - rank(b));
  // Widgets go back into the slots widgets had, so comments keep their places.
  let wi = 0;
  const next = all.map((a) => (isW(a) ? sorted[wi++] : a));
  const arr = doc.newArray();
  for (const a of next) arr.push(a);
  pageObj.put("Annots", arr);
  if (mark) pageObj.put("Tabs", doc.newName(mark));
  else pageObj.delete("Tabs");
}

/** Order Tab by rows (left to right, top to bottom) or by columns (top to bottom, left to right). */
export function autoTabOrder(doc: mupdf.PDFDocument, pageIndex: number, by: "rows" | "columns"): number[] {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  let items: { key: number; r: number[] }[];
  try {
    items = page.getWidgets().map((w) => ({ key: w.getObject().asIndirect(), r: Array.from(w.getBounds()) }));
  } finally {
    page.destroy();
  }
  const [a0, a1, b0, b1] = by === "rows" ? [1, 3, 0, 2] : [0, 2, 1, 3];
  items.sort((p, q) => p.r[a0] - q.r[a0] || p.r[b0] - q.r[b0]);
  // Group into rows (or columns): fields whose middles fall inside the band of the first one.
  const bands: { key: number; r: number[] }[][] = [];
  for (const it of items) {
    const mid = (it.r[a0] + it.r[a1]) / 2;
    const band = bands.find((b) => mid >= b[0].r[a0] - 1 && mid <= b[0].r[a1] + 1);
    if (band) band.push(it);
    else bands.push([it]);
  }
  bands.sort((p, q) => p[0].r[a0] - q[0].r[a0]);
  const keys = bands.flatMap((b) => b.sort((p, q) => p.r[b0] - q.r[b0] || p.r[b1] - q.r[b1]).map((x) => x.key));
  setTabOrder(doc, pageIndex, keys, by === "rows" ? "R" : "C");
  return keys;
}


// ---------- detection ----------
export interface DetectedField extends FieldSpec {
  page: number;
  /** Why it was suggested, for the review list. */
  reason: string;
}

interface Char { c: string; box: number[] }
interface Line { box: number[]; chars: Char[] }

function pageLines(page: mupdf.Page): Line[] {
  const st = page.toStructuredText("preserve-whitespace");
  const lines: Line[] = [];
  let cur: Line | null = null;
  st.walk({
    beginLine(bbox) {
      cur = { box: Array.from(bbox), chars: [] };
      lines.push(cur);
    },
    onChar(c, _o, _f, _s, q) {
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      cur?.chars.push({ c, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    },
  });
  st.destroy();
  return lines;
}

interface Vec { box: number[]; kind: "hline" | "box" }

function pageVectors(page: mupdf.Page): Vec[] {
  const out: Vec[] = [];
  const noStroke = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 });
  const add = (b: number[], filled: boolean, color: number[]) => {
    const w = b[2] - b[0], h = b[3] - b[1];
    // Light fills (white, pale backgrounds) are not lines.
    if (filled && color.length && color.reduce((s, v) => s + v, 0) / color.length > 0.85 && color.length !== 4) return;
    if (h <= 2.5 && w >= 36) out.push({ box: b, kind: "hline" });
    else if (!filled && w >= 6 && h >= 6) out.push({ box: b, kind: "box" });
  };
  const dev = new mupdf.Device({
    strokePath(path, stroke, ctm) {
      let segs = 0;
      path.walk({ moveTo: () => segs++, lineTo: () => segs++, curveTo: () => (segs += 100), closePath: () => {} });
      if (segs > 6) return; // curves, icons, logos
      add(Array.from(path.getBounds(stroke, ctm)), false, []);
    },
    fillPath(path, _eo, ctm, _cs, color) {
      add(Array.from(path.getBounds(noStroke, ctm)), true, Array.from(color));
    },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity); // page content only: not comments or existing fields
  } finally {
    dev.close();
  }
  return out;
}

const overlaps = (a: number[], b: number[], pad = 0) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;
const BOX_GLYPHS = /[☐□❏❐❑❒▢◻⬜]/;

function labelFor(lines: Line[], r: number[], rightFirst = false): string {
  const midY = (r[1] + r[3]) / 2;
  let best: { text: string; dist: number } | null = null;
  // Check boxes are usually labelled on their right.
  if (rightFirst) {
    for (const l of lines) {
      if (l.box[1] > midY + 4 || l.box[3] < midY - 4) continue;
      const right = l.chars.filter((ch) => ch.box[0] >= r[2] - 1);
      if (!right.length || right[0].box[0] - r[2] > 40) continue;
      let end = 0;
      while (end < right.length - 1 && right[end + 1].box[0] - right[end].box[2] < 12 && !BOX_GLYPHS.test(right[end + 1].c)) end++;
      const text = right.slice(0, end + 1).map((ch) => ch.c).join("").trim();
      if (text && (!best || right[0].box[0] - r[2] < best.dist)) best = { text, dist: right[0].box[0] - r[2] };
    }
    if (best) return best.text.replace(/\s+/g, " ").replace(/[:*]\s*$/, "").trim().slice(0, 40);
  }
  // Text on the same line, to the left of the field.
  for (const l of lines) {
    if (l.box[1] > midY + 4 || l.box[3] < midY - 10) continue;
    const left = l.chars.filter((ch) => ch.box[2] <= r[0] + 1 && !/^[_.…]$/.test(ch.c));
    if (!left.length) continue;
    const dist = r[0] - left.at(-1)!.box[2];
    if (dist > 220) continue;
    // Take the last phrase: break at a wide gap.
    let start = left.length - 1;
    while (start > 0 && left[start].box[0] - left[start - 1].box[2] < 12) start--;
    const text = left.slice(start).map((ch) => ch.c).join("").replace(/[_.…]+/g, " ").trim();
    if (text && (!best || dist < best.dist)) best = { text, dist };
  }
  if (!best) {
    // Text just above (a caption over a box or line).
    for (const l of lines) {
      if (l.box[3] <= r[1] + 2 && r[1] - l.box[3] < 16 && l.box[0] < r[2] && l.box[2] > r[0]) {
        const text = l.chars.map((ch) => ch.c).join("").replace(/[_.…]+/g, " ").trim();
        if (text) best = { text, dist: 0 };
      }
    }
  }
  return (best?.text ?? "").replace(/\s+/g, " ").replace(/[:*]\s*$/, "").trim().slice(0, 40);
}

/**
 * Suggest form fields for a flat form: runs of underscores and drawn lines become text fields,
 * ☐ glyphs and small squares become check boxes, larger empty boxes become text fields.
 * Fields already on the page and areas with text in them are skipped.
 */
export function detectFields(doc: mupdf.PDFDocument, pages?: number[]): DetectedField[] {
  const out: DetectedField[] = [];
  const taken = fieldNames(doc);
  for (const pi of pages ?? [...Array(doc.countPages()).keys()]) {
    const page = doc.loadPage(pi) as mupdf.PDFPage;
    try {
      const existing = page.getWidgets().map((w) => Array.from(w.getBounds()));
      const lines = pageLines(page);
      const textBoxes = lines.flatMap((l) => l.chars.filter((ch) => ch.c.trim() && !/^[_.…]$/.test(ch.c) && !BOX_GLYPHS.test(ch.c)).map((ch) => ch.box));
      const found: { rect: number[]; type: NewFieldType; reason: string }[] = [];
      const free = (r: number[]) => !existing.some((e) => overlaps(e, r, -1)) && !found.some((f) => overlaps(f.rect, r, -1));
      const empty = (r: number[]) => !textBoxes.some((t) => overlaps(t, [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1]));
      // Underscore runs and box glyphs.
      for (const l of lines) {
        let run: Char[] = [];
        const flush = () => {
          if (run.length >= 4) {
            const x0 = run[0].box[0], x1 = run.at(-1)!.box[2], base = Math.max(...run.map((c) => c.box[3]));
            const h = Math.min(18, Math.max(12, l.box[3] - l.box[1]));
            const r = [x0, base - h, x1, base];
            if (free(r)) found.push({ rect: r, type: "text", reason: "underscores" });
          }
          run = [];
        };
        for (const ch of l.chars) {
          if (ch.c === "_") run.push(ch);
          else {
            flush();
            if (BOX_GLYPHS.test(ch.c)) {
              const [x0, y0, x1, y1] = ch.box;
              const s = Math.min(x1 - x0, y1 - y0) * 0.9;
              const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
              const r = [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2];
              if (free(r)) found.push({ rect: r, type: "checkbox", reason: "☐ box" });
            }
          }
        }
        flush();
      }
      // Drawn lines and boxes.
      const vecs = pageVectors(page);
      for (const v of vecs) {
        const [x0, y0, x1, y1] = v.box;
        const w = x1 - x0, h = y1 - y0;
        if (v.kind === "box" && Math.abs(w - h) <= 3 && w <= 20) {
          if (free(v.box) && empty(v.box)) found.push({ rect: v.box, type: "checkbox", reason: "small square" });
        } else if (v.kind === "box" && w >= 50 && h >= 12 && h <= 120) {
          const r = [x0 + 1, y0 + 1, x1 - 1, y1 - 1];
          if (free(r) && empty(r)) found.push({ rect: r, type: "text", reason: "empty box" });
        } else if (v.kind === "hline" && w >= 50) {
          // Skip lines that are the edge of a box (tables, borders).
          const edgeOfBox = vecs.some((b) => b.kind === "box" && b.box[0] <= x0 + 2 && b.box[2] >= x1 - 2 && (Math.abs(b.box[1] - y0) < 3 || Math.abs(b.box[3] - y1) < 3));
          if (edgeOfBox) continue;
          const r = [x0, y0 - 16, x1, y0];
          if (free(r) && empty(r)) found.push({ rect: r, type: "text", reason: "line" });
        }
      }
      found.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
      for (const f of found) {
        const label = labelFor(lines, f.rect, f.type === "checkbox");
        const name = uniqueName(taken, label || (f.type === "checkbox" ? "Check box" : "Text field"));
        taken.add(name);
        out.push({ page: pi, type: f.type, name, rect: f.rect.map((v) => +v.toFixed(2)), reason: f.reason, multiline: f.type === "text" && f.rect[3] - f.rect[1] > 30, tooltip: label || undefined });
      }
    } finally {
      page.destroy();
    }
  }
  return out;
}

/** A name for a field the user just drew, from the text next to it (e.g. "Email:" → "Email"). */
export function suggestName(doc: mupdf.PDFDocument, pageIndex: number, rect: number[], type: NewFieldType): { name: string; label: string } {
  const page = doc.loadPage(pageIndex);
  try {
    const lines = pageLines(page);
    const toggle = type === "checkbox" || type === "radio";
    const label = labelFor(lines, rect, toggle);
    const fallback = { text: "Text field", date: "Date", checkbox: "Check box", radio: "Option", combobox: "Dropdown", listbox: "List", signature: "Signature", button: "Button" }[type];
    // Radio groups are named from the text before the buttons, each button from its own label.
    const groupLabel = type === "radio" ? labelFor(lines, rect, false) : label;
    return { name: uniqueName(fieldNames(doc), (type === "radio" ? groupLabel : label) || fallback), label };
  } finally {
    page.destroy();
  }
}
