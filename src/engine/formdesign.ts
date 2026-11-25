// Form designer: create, edit and delete AcroForm fields, and detect where fields belong on a
// flat form (underscores, ☐ boxes, drawn lines and boxes). Rectangles are page display space
// (points, origin top-left), like everything else in the UI.
import * as mupdf from "mupdf";

export type NewFieldType = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "signature";

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
}

export type FieldPatch = Partial<Omit<FieldSpec, "type" | "value" | "exportValue">>;

const FF_READONLY = 1, FF_REQUIRED = 2, FF_MULTILINE = 1 << 12, FF_RADIO = 1 << 15, FF_NOTOGGLEOFF = 1 << 14, FF_COMBO = 1 << 17;

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
  if (fonts.get("Helv").isNull()) fonts.put("Helv", doc.addSimpleFont(new mupdf.Font("Helvetica")));
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

// ---------- appearances for check boxes and radio buttons ----------
function stream(doc: mupdf.PDFDocument, w: number, h: number, content: string, zadb = false): mupdf.PDFObject {
  const res = doc.newDictionary();
  if (zadb) {
    const f = doc.newDictionary();
    f.put("ZaDb", doc.getTrailer().get("Root").get("AcroForm").get("DR").get("Font").get("ZaDb"));
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

function setToggleAppearance(doc: mupdf.PDFDocument, o: mupdf.PDFObject, on: string, radio: boolean) {
  const r = o.get("Rect");
  const w = Math.abs(r.get(2).asNumber() - r.get(0).asNumber()), h = Math.abs(r.get(3).asNumber() - r.get(1).asNumber());
  const f = (n: number) => +n.toFixed(2);
  let off: string, onS: string;
  if (radio) {
    const rr = Math.min(w, h) / 2;
    off = `1 g ${circle(f(w / 2), f(h / 2), f(rr - 0.5))} f 0 G 1 w ${circle(f(w / 2), f(h / 2), f(rr - 0.5))} S`;
    onS = `${off} 0 g ${circle(f(w / 2), f(h / 2), f(rr * 0.45))} f`;
  } else {
    off = `1 g 0 0 ${f(w)} ${f(h)} re f 0 G 1 w 0.5 0.5 ${f(w - 1)} ${f(h - 1)} re S`;
    const size = f(Math.min(w, h) * 0.8);
    onS = `${off} 0 g BT /ZaDb ${size} Tf ${f((w - size * 0.78) / 2)} ${f((h - size * 0.7) / 2)} Td (4) Tj ET`;
  }
  const n = doc.newDictionary();
  n.put(on, stream(doc, w, h, onS, !radio));
  n.put("Off", stream(doc, w, h, off));
  const ap = doc.newDictionary();
  ap.put("N", n);
  o.put("AP", ap);
  let mk = o.get("MK");
  if (!mk.isDictionary()) {
    mk = doc.newDictionary();
    o.put("MK", mk);
  }
  mk.put("CA", doc.newString(radio ? "l" : "4"));
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
  try {
    const pageObj = page.getObject();
    const w = newWidget(doc, page, spec.rect);
    const fs = spec.fontSize ?? 0;
    let flags = (spec.readOnly ? FF_READONLY : 0) | (spec.required ? FF_REQUIRED : 0);
    let ref: mupdf.PDFObject;
    if (spec.type === "radio") {
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
      const on = (spec.exportValue || `Choice ${kids.length + 1}`).replace(/[\s/()<>[\]{}%#]/g, "_");
      w.put("Parent", parent);
      w.put("AS", doc.newName("Off"));
      ref = doc.addObject(w);
      kids.push(ref);
      setToggleAppearance(doc, ref, on, true);
    } else {
      w.put("T", doc.newString(spec.name));
      if (spec.tooltip) w.put("TU", doc.newString(spec.tooltip));
      switch (spec.type) {
        case "text":
          w.put("FT", doc.newName("Tx"));
          w.put("DA", doc.newString(`/Helv ${fs} Tf 0 g`));
          if (spec.multiline) flags |= FF_MULTILINE;
          if (spec.maxLen) w.put("MaxLen", spec.maxLen);
          break;
        case "checkbox":
          w.put("FT", doc.newName("Btn"));
          w.put("V", doc.newName("Off"));
          w.put("AS", doc.newName("Off"));
          w.put("DA", doc.newString("/ZaDb 0 Tf 0 g"));
          break;
        case "combobox":
        case "listbox":
          w.put("FT", doc.newName("Ch"));
          w.put("DA", doc.newString(`/Helv ${fs} Tf 0 g`));
          if (spec.type === "combobox") flags |= FF_COMBO;
          w.put("Opt", (spec.options ?? []).map((s) => doc.newString(s)));
          break;
        case "signature":
          w.put("FT", doc.newName("Sig"));
          break;
      }
      w.put("Ff", flags);
      ref = doc.addObject(w);
      fields.push(ref);
      if (spec.type === "checkbox") setToggleAppearance(doc, ref, (spec.exportValue || "Yes").replace(/[\s/()<>[\]{}%#]/g, "_"), false);
    }
    if (spec.type === "radio" && spec.tooltip) ref.put("TU", doc.newString(spec.tooltip));
    pageAnnots(doc, pageObj).push(ref);
    const key = ref.asIndirect();
    // Let MuPDF build the appearance for text and choice fields (and set any initial value).
    const fresh = doc.loadPage(pageIndex) as mupdf.PDFPage;
    try {
      const wid = fresh.getWidgets().find((x) => x.getObject().asIndirect() === key);
      if (wid) {
        if (spec.type === "text") wid.setTextValue(spec.value ?? "");
        else if ((spec.type === "combobox" || spec.type === "listbox") && spec.value) wid.setChoiceValue(spec.value);
        else if (spec.type === "checkbox" && spec.value && /^(1|y|yes|true|on|x)$/i.test(spec.value)) wid.toggle();
        wid.update();
      }
    } finally {
      fresh.destroy();
    }
    return key;
  } finally {
    page.destroy();
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

export function fieldProps(doc: mupdf.PDFDocument, pageIndex: number, key: number): FieldProps {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const w = findWidget(page, key);
    const o = w.getObject();
    const fd = fieldDict(o);
    const ff = w.getFieldFlags();
    const da = o.get("DA").isString() ? o.get("DA").asString() : fd.get("DA").isString() ? fd.get("DA").asString() : "";
    const tu = fd.get("TU");
    let exportValue: string | null = null;
    if (w.isCheckbox() || w.isRadioButton()) {
      const n = o.get("AP").get("N");
      if (n.isDictionary()) n.forEach((_v, k) => k !== "Off" && (exportValue = String(k)));
    }
    return {
      key,
      page: pageIndex,
      type: w.getFieldType(),
      name: w.getName(),
      rect: Array.from(w.getBounds()),
      options: w.isChoice() ? w.getOptions() : [],
      exportValue,
      required: (ff & FF_REQUIRED) !== 0,
      readOnly: (ff & FF_READONLY) !== 0,
      multiline: w.isText() && w.isMultiline(),
      maxLen: w.isText() ? w.getMaxLen() : 0,
      fontSize: Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 0),
      tooltip: tu.isString() ? tu.asString() : "",
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
    }
    if (patch.fontSize !== undefined && (w.isText() || w.isChoice())) o.put("DA", doc.newString(`/Helv ${patch.fontSize} Tf 0 g`));
    if (patch.options && w.isChoice()) o.put("Opt", patch.options.map((s) => doc.newString(s)));
    if (patch.rect) {
      o.put("Rect", toUserRect(page, patch.rect));
      if (w.isCheckbox() || w.isRadioButton()) {
        let on = "Yes";
        const n = o.get("AP").get("N");
        if (n.isDictionary()) n.forEach((_v, k) => k !== "Off" && (on = String(k)));
        setToggleAppearance(doc, o, on, w.isRadioButton());
      }
    }
    if (w.isText()) w.setTextValue(w.getValue() ?? "");
    w.update();
  } finally {
    page.destroy();
  }
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
    const fallback = { text: "Text field", checkbox: "Check box", radio: "Option", combobox: "Dropdown", listbox: "List", signature: "Signature" }[type];
    // Radio groups are named from the text before the buttons, each button from its own label.
    const groupLabel = type === "radio" ? labelFor(lines, rect, false) : label;
    return { name: uniqueName(fieldNames(doc), (type === "radio" ? groupLabel : label) || fallback), label };
  } finally {
    page.destroy();
  }
}
