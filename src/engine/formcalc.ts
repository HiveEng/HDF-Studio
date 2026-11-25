// Form calculations, number/date formats and validation.
//
// PDF forms keep this logic as small JavaScript snippets in each field's /AA (additional
// actions): /C calculate, /F format, /K keystroke, /V validate, with /CO in the AcroForm giving
// the calculation order. MuPDF's WebAssembly build has no JavaScript engine, so we read the
// standard Acrobat helper calls (AFSimple_Calculate, AFNumber_Format, AFRange_Validate,
// "simplified field notation" formulas…) and run them here. Fields we create are written with the
// same calls, so they also calculate in Acrobat and other readers.
import * as mupdf from "mupdf";

export type NumberSep = 0 | 1 | 2 | 3; // 1,234.56 | 1234.56 | 1.234,56 | 1234,56
export type FieldFormat =
  | { kind: "none" }
  | { kind: "number"; decimals: number; sep: NumberSep; negParens?: boolean; currency?: string; prepend?: boolean }
  | { kind: "percent"; decimals: number; sep: NumberSep }
  | { kind: "date"; pattern: string };
export type CalcOp = "SUM" | "PRD" | "AVG" | "MIN" | "MAX";
export type FieldCalc = { kind: "none" } | { kind: "simple"; op: CalcOp; fields: string[] } | { kind: "formula"; expr: string } | { kind: "script"; js: string };
export type FieldValidate = { kind: "none" } | { kind: "range"; min?: number; max?: number } | { kind: "script"; js: string };
export interface FieldLogic {
  format: FieldFormat;
  calc: FieldCalc;
  validate: FieldValidate;
}
export const NO_LOGIC: FieldLogic = { format: { kind: "none" }, calc: { kind: "none" }, validate: { kind: "none" } };

// ---------- reading the scripts ----------
function jsOf(action: mupdf.PDFObject): string {
  if (!action.isDictionary()) return "";
  const js = action.get("JS");
  if (js.isString()) return js.asString();
  if (js.isStream()) return js.readStream().asString();
  return "";
}
const args = (s: string) =>
  s.split(",").map((a) => a.trim().replace(/^["']|["']$/g, ""));
const num = (s: string | undefined, d = 0) => (s === undefined || s === "" || isNaN(+s) ? d : +s);
const bool = (s: string | undefined) => s === "true" || s === "1";

export function parseFormat(js: string): FieldFormat {
  let m = /AFNumber_Format\s*\(([^)]*)\)/.exec(js);
  if (m) {
    const [dec, sep, neg, , cur, pre] = args(m[1]);
    return { kind: "number", decimals: num(dec, 2), sep: (num(sep) & 3) as NumberSep, negParens: num(neg) >= 2, currency: cur || undefined, prepend: cur ? bool(pre) : undefined };
  }
  if ((m = /AFPercent_Format\s*\(([^)]*)\)/.exec(js))) {
    const [dec, sep] = args(m[1]);
    return { kind: "percent", decimals: num(dec, 2), sep: (num(sep) & 3) as NumberSep };
  }
  if ((m = /AFDate_FormatEx\s*\(\s*["']([^"']*)["']/.exec(js))) return { kind: "date", pattern: m[1] };
  if ((m = /AFDate_Format\s*\(\s*(\d+)/.exec(js))) return { kind: "date", pattern: OLD_DATE_FORMATS[+m[1]] ?? "m/d/yy" };
  return { kind: "none" };
}
const OLD_DATE_FORMATS = ["m/d", "m/d/yy", "mm/dd/yy", "mm/yy", "d-mmm", "d-mmm-yy", "dd-mmm-yy", "yy-mm-dd", "mmm-yy", "mmmm-yy", "mmm d, yyyy", "mmmm d, yyyy", "m/d/yy h:MM tt", "m/d/yy HH:MM"];

export function parseCalc(js: string): FieldCalc {
  if (!js.trim()) return { kind: "none" };
  let m = /AFSimple_Calculate\s*\(\s*["'](\w+)["']\s*,\s*(?:new\s+Array\s*\(([^)]*)\)|\[([^\]]*)\]|["']([^"']*)["'])/.exec(js);
  if (m) {
    const op = m[1].toUpperCase() as CalcOp;
    const list = m[2] ?? m[3];
    const fields = list !== undefined ? [...list.matchAll(/["']((?:[^"'\\]|\\.)*)["']/g)].map((x) => x[1]) : m[4].split(",").map((s) => s.trim());
    if (["SUM", "PRD", "AVG", "MIN", "MAX"].includes(op)) return { kind: "simple", op, fields: fields.filter(Boolean) };
  }
  if ((m = /BVCALC([\s\S]*?)EVCALC/.exec(js))) return { kind: "formula", expr: m[1].trim() };
  return { kind: "script", js };
}

export function parseValidate(js: string): FieldValidate {
  if (!js.trim()) return { kind: "none" };
  const m = /AFRange_Validate\s*\(([^)]*)\)/.exec(js);
  if (m) {
    const [gt, min, lt, max] = args(m[1]);
    return { kind: "range", min: bool(gt) ? num(min) : undefined, max: bool(lt) ? num(max) : undefined };
  }
  return { kind: "script", js };
}

/** The dictionary that holds a field's actions: the widget, or its parent for a multi-widget field. */
function fieldDict(o: mupdf.PDFObject) {
  const p = o.get("Parent");
  return o.get("T").isNull() && p.isDictionary() ? p : o;
}
function aaOf(o: mupdf.PDFObject): mupdf.PDFObject {
  const own = o.get("AA");
  return own.isDictionary() ? own : fieldDict(o).get("AA");
}

export function readLogic(widget: mupdf.PDFObject): FieldLogic {
  const aa = aaOf(widget);
  if (!aa.isDictionary()) return NO_LOGIC;
  return { format: parseFormat(jsOf(aa.get("F"))), calc: parseCalc(jsOf(aa.get("C"))), validate: parseValidate(jsOf(aa.get("V"))) };
}

// ---------- writing the scripts ----------
const q = (s: string) => JSON.stringify(s);
export function formatScripts(f: FieldFormat): { F: string; K: string } | null {
  switch (f.kind) {
    case "number":
      return {
        F: `AFNumber_Format(${f.decimals}, ${f.sep}, ${f.negParens ? 2 : 0}, 0, ${q(f.currency ?? "")}, ${f.prepend ?? true});`,
        K: `AFNumber_Keystroke(${f.decimals}, ${f.sep}, ${f.negParens ? 2 : 0}, 0, ${q(f.currency ?? "")}, ${f.prepend ?? true});`,
      };
    case "percent":
      return { F: `AFPercent_Format(${f.decimals}, ${f.sep});`, K: `AFPercent_Keystroke(${f.decimals}, ${f.sep});` };
    case "date":
      return { F: `AFDate_FormatEx(${q(f.pattern)});`, K: `AFDate_KeystrokeEx(${q(f.pattern)});` };
    default:
      return null;
  }
}
export function calcScript(c: FieldCalc): string | null {
  switch (c.kind) {
    case "simple":
      return `AFSimple_Calculate(${q(c.op)}, new Array (${c.fields.map(q).join(", ")}));`;
    case "formula": {
      // Simplified field notation, the way Acrobat stores it, so Acrobat can show and run it too.
      const js = toJs(parseExpr(c.expr));
      return `/** BVCALC ${c.expr} EVCALC **/ event.value = ${js};`;
    }
    case "script":
      return c.js;
    default:
      return null;
  }
}
export function validateScript(v: FieldValidate): string | null {
  if (v.kind === "range") return `AFRange_Validate(${v.min !== undefined}, ${v.min ?? 0}, ${v.max !== undefined}, ${v.max ?? 0});`;
  if (v.kind === "script") return v.js;
  return null;
}

function jsAction(doc: mupdf.PDFDocument, js: string) {
  const a = doc.newDictionary();
  a.put("S", doc.newName("JavaScript"));
  a.put("JS", doc.newString(js));
  return a;
}

/** Store a field's logic as standard PDF actions, and keep the calculation order up to date. */
export function writeLogic(doc: mupdf.PDFDocument, widget: mupdf.PDFObject, logic: FieldLogic) {
  const fd = fieldDict(widget);
  let aa = fd.get("AA");
  if (!aa.isDictionary()) {
    aa = doc.newDictionary();
    fd.put("AA", aa);
  }
  const fmt = formatScripts(logic.format);
  for (const [k, js] of [["F", fmt?.F], ["K", fmt?.K], ["C", calcScript(logic.calc)], ["V", validateScript(logic.validate)]] as const) {
    if (js) aa.put(k, jsAction(doc, js));
    else aa.delete(k);
  }
  if (widget !== fd && widget.get("AA").isDictionary()) widget.delete("AA");
  const af = doc.getTrailer().get("Root").get("AcroForm");
  if (!af.isDictionary()) return;
  let co = af.get("CO");
  const ref = fd.isIndirect() ? fd : widget;
  const num = ref.asIndirect();
  if (logic.calc.kind !== "none") {
    if (!co.isArray()) {
      co = doc.newArray();
      af.put("CO", co);
    }
    let found = false;
    for (let i = 0; i < co.length; i++) if (co.get(i).asIndirect() === num) found = true;
    if (!found) co.push(ref);
  } else if (co.isArray()) {
    for (let i = co.length - 1; i >= 0; i--) if (co.get(i).asIndirect() === num) co.delete(i);
  }
}

// ---------- numbers and dates ----------
/** Read a typed number the way Acrobat's AFMakeNumber does: currency, spaces and separators allowed. */
export function makeNumber(v: string, sep: NumberSep = 0): number | null {
  let s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-|-$/.test(s.replace(/[^\d\-().,]/g, ""));
  s = s.replace(/[^\d.,]/g, "");
  if (sep >= 2) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!s || isNaN(+s)) return null;
  return neg ? -Math.abs(+s) : +s;
}

function group(intPart: string, sep: string) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
export function formatNumber(n: number, f: Extract<FieldFormat, { kind: "number" | "percent" }>): string {
  const v = f.kind === "percent" ? n * 100 : n;
  const [i, d] = Math.abs(v).toFixed(Math.max(0, Math.min(10, f.decimals))).split(".");
  const [g, dp] = [[",", "."], ["", "."], [".", ","], ["", ","]][f.sep];
  let s = group(i, g) + (d ? dp + d : "");
  if (f.kind === "percent") s += "%";
  else if (f.currency) s = f.prepend === false ? s + f.currency : f.currency + s;
  if (v < 0 && +s.replace(/[^\d]/g, "") !== 0) s = f.kind === "number" && f.negParens ? `(${s})` : `-${s}`;
  return s;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function parseDate(s: string, pattern = "mm/dd/yyyy"): Date | null {
  const t = s.trim();
  if (!t) return null;
  const nums = t.match(/\d+/g)?.map(Number) ?? [];
  const mon = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}`, "i").test(t));
  const order = pattern.replace(/[^dmy]/gi, "").replace(/(.)\1+/g, "$1").toLowerCase(); // e.g. "mdy"
  let y: number | undefined, m: number | undefined, d: number | undefined;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) [y, m, d] = nums;
  else if (mon >= 0) {
    m = mon + 1;
    [d, y] = nums.length >= 2 ? (nums[0] > 31 ? [nums[1], nums[0]] : [nums[0], nums[1]]) : [nums[0], new Date().getFullYear()];
  } else {
    const parts: Record<string, number | undefined> = {};
    [...order.replace("h", "").slice(0, 3)].forEach((k, i) => (parts[k] = nums[i]));
    ({ y, m, d } = parts);
    if (y === undefined) y = new Date().getFullYear();
    if (d === undefined) d = 1;
  }
  if (y === undefined || m === undefined || d === undefined) return null;
  if (y < 100) y += y < 50 ? 2000 : 1900;
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}
export function formatDate(date: Date, pattern: string): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return pattern.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d/g, (t) => {
    switch (t) {
      case "yyyy": return String(date.getFullYear());
      case "yy": return p2(date.getFullYear() % 100);
      case "mmmm": return MONTHS[date.getMonth()];
      case "mmm": return MONTHS[date.getMonth()].slice(0, 3);
      case "mm": return p2(date.getMonth() + 1);
      case "m": return String(date.getMonth() + 1);
      case "dddd": return date.toLocaleDateString("en-US", { weekday: "long" });
      case "ddd": return date.toLocaleDateString("en-US", { weekday: "short" });
      case "dd": return p2(date.getDate());
      default: return String(date.getDate());
    }
  });
}

/** What the field shows for a stored value. */
export function display(raw: string, f: FieldFormat): string {
  if (f.kind === "number" || f.kind === "percent") {
    const n = makeNumber(raw, f.sep);
    return n === null ? raw : formatNumber(n, f);
  }
  if (f.kind === "date") {
    const d = parseDate(raw, f.pattern);
    return d ? formatDate(d, f.pattern) : raw;
  }
  return raw;
}

/** Turn what was typed into the value to store; an error message when it can't be. */
export function normalize(typed: string, logic: FieldLogic): { value: string } | { error: string } {
  const f = logic.format;
  let value = typed.trim();
  if (value && (f.kind === "number" || f.kind === "percent")) {
    let n = makeNumber(value, f.sep);
    if (n === null) return { error: `“${typed}” isn't a number.` };
    if (f.kind === "percent" && !/%/.test(value) && Math.abs(n) > 1) n = n / 100; // "15" means 15%
    else if (f.kind === "percent" && /%/.test(value)) n = n / 100;
    value = String(+n.toFixed(10));
  } else if (value && f.kind === "date") {
    const d = parseDate(value, f.pattern);
    if (!d) return { error: `“${typed}” isn't a date like ${formatDate(new Date(2025, 11, 31), f.pattern)}.` };
    value = formatDate(d, f.pattern);
  }
  const v = logic.validate;
  if (value && v.kind === "range") {
    const n = makeNumber(value);
    const show = (x: number) => (f.kind === "number" || f.kind === "percent" ? formatNumber(x, f) : String(x));
    if (n === null) return { error: `“${typed}” isn't a number.` };
    if ((v.min !== undefined && n < v.min) || (v.max !== undefined && n > v.max)) {
      return { error: v.min !== undefined && v.max !== undefined ? `Enter a value from ${show(v.min)} to ${show(v.max)}.` : v.min !== undefined ? `Enter a value of at least ${show(v.min)}.` : `Enter a value of at most ${show(v.max!)}.` };
    }
  }
  return { value };
}

// ---------- formulas (simplified field notation) ----------
type Node = { t: "num"; v: number } | { t: "field"; name: string } | { t: "neg"; a: Node } | { t: "bin"; op: string; a: Node; b: Node };

/** Parse a formula such as `Qty * (Price - Discount)`. Field names with spaces or dots escape them with \. */
export function parseExpr(src: string): Node {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = (msg: string): never => {
    throw new Error(`Formula: ${msg} at “${src.slice(i, i + 12) || "end"}”`);
  };
  function primary(): Node {
    ws();
    const c = src[i];
    if (c === "(") {
      i++;
      const e = expr();
      ws();
      if (src[i] !== ")") fail("missing )");
      i++;
      return e;
    }
    if (c === "-" || c === "+") {
      i++;
      const a = primary();
      return c === "-" ? { t: "neg", a } : a;
    }
    const n = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (n) {
      i += n[0].length;
      return { t: "num", v: +n[0] };
    }
    let name = "";
    while (i < src.length) {
      if (src[i] === "\\" && i + 1 < src.length) {
        name += src[i + 1];
        i += 2;
      } else if (/[\p{L}\p{N}_.]/u.test(src[i])) name += src[i++];
      else break;
    }
    if (!name) fail("expected a number or a field name");
    return { t: "field", name };
  }
  function term(): Node {
    let a = primary();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "*" && op !== "/") return a;
      i++;
      a = { t: "bin", op, a, b: primary() };
    }
  }
  function expr(): Node {
    let a = term();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "+" && op !== "-") return a;
      i++;
      a = { t: "bin", op, a, b: term() };
    }
  }
  const e = expr();
  ws();
  if (i < src.length) fail("unexpected text");
  return e;
}
export function fieldsIn(n: Node): string[] {
  return n.t === "field" ? [n.name] : n.t === "neg" ? fieldsIn(n.a) : n.t === "bin" ? [...fieldsIn(n.a), ...fieldsIn(n.b)] : [];
}
function toJs(n: Node): string {
  switch (n.t) {
    case "num": return String(n.v);
    case "field": return `AFMakeNumber(getField(${q(n.name)}).value)`;
    case "neg": return `-(${toJs(n.a)})`;
    default: return `(${toJs(n.a)} ${n.op} ${toJs(n.b)})`;
  }
}
function evalExpr(n: Node, get: (name: string) => number): number {
  switch (n.t) {
    case "num": return n.v;
    case "field": return get(n.name);
    case "neg": return -evalExpr(n.a, get);
    default: {
      const a = evalExpr(n.a, get), b = evalExpr(n.b, get);
      return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : b === 0 ? 0 : a / b;
    }
  }
}

// ---------- running the calculations ----------
interface Fld {
  name: string;
  widgets: mupdf.PDFWidget[];
  logic: FieldLogic;
  ref: number;
}

function collect(doc: mupdf.PDFDocument): { fields: Map<string, Fld>; pages: mupdf.PDFPage[] } {
  const fields = new Map<string, Fld>();
  const pages: mupdf.PDFPage[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    pages.push(page);
    for (const w of page.getWidgets()) {
      const name = w.getName();
      const f = fields.get(name);
      if (f) f.widgets.push(w);
      else fields.set(name, { name, widgets: [w], logic: readLogic(w.getObject()), ref: fieldDict(w.getObject()).asIndirect() || w.getObject().asIndirect() });
    }
  }
  return { fields, pages };
}

function valueOf(f: Fld): number {
  const w = f.widgets[0];
  if (w.isCheckbox() || w.isRadioButton()) {
    // A checked box counts as its export value when that is a number, else 1.
    const on = f.widgets.map((x) => x.getValue()).find((v) => v && v !== "Off");
    return on ? (isNaN(+on) ? 1 : +on) : 0;
  }
  const sep = f.logic.format.kind === "number" || f.logic.format.kind === "percent" ? f.logic.format.sep : 0;
  return makeNumber(w.getValue() ?? "", sep) ?? 0;
}

/** Show a stored value with its format: the appearance gets the formatted text, /V keeps the value. */
export function setDisplayed(doc: mupdf.PDFDocument, w: mupdf.PDFWidget, raw: string, f: FieldFormat) {
  const shown = display(raw, f);
  w.setTextValue(shown);
  w.update();
  if (shown !== raw) fieldDict(w.getObject()).put("V", doc.newString(raw));
}

/**
 * Recalculate every calculated field, in the form's calculation order. Returns the names of
 * fields whose value changed.
 */
export function recalculate(doc: mupdf.PDFDocument): string[] {
  const { fields, pages } = collect(doc);
  try {
    const calc = [...fields.values()].filter((f) => f.logic.calc.kind === "simple" || f.logic.calc.kind === "formula");
    if (!calc.length) return [];
    // Calculation order: /CO first, then any others, then repeat until stable (handles a bad order).
    const co: number[] = [];
    const af = doc.getTrailer().get("Root").get("AcroForm");
    const arr = af.isDictionary() ? af.get("CO") : null;
    if (arr?.isArray()) for (let i = 0; i < arr.length; i++) co.push(arr.get(i).asIndirect());
    calc.sort((a, b) => (co.indexOf(a.ref) + 1 || 1e9) - (co.indexOf(b.ref) + 1 || 1e9));
    const changed = new Set<string>();
    const get = (name: string) => {
      const f = fields.get(name);
      if (!f) throw new Error(`no field “${name}”`);
      return valueOf(f);
    };
    for (let pass = 0; pass < 5; pass++) {
      let any = false;
      for (const f of calc) {
        let v: number;
        try {
          const c = f.logic.calc;
          if (c.kind === "simple") {
            const vals = c.fields.filter((n) => fields.has(n)).map(get);
            v = !vals.length ? 0 : c.op === "SUM" ? vals.reduce((s, x) => s + x, 0) : c.op === "PRD" ? vals.reduce((s, x) => s * x, 1) : c.op === "AVG" ? vals.reduce((s, x) => s + x, 0) / vals.length : c.op === "MIN" ? Math.min(...vals) : Math.max(...vals);
          } else v = evalExpr(parseExpr((c as { expr: string }).expr), get);
        } catch {
          continue;
        }
        const raw = String(+v.toFixed(10));
        const w = f.widgets[0];
        if (!w.isText()) continue;
        if ((w.getValue() ?? "") === raw) continue;
        any = true;
        changed.add(f.name);
        for (const x of f.widgets) setDisplayed(doc, x, raw, f.logic.format);
      }
      if (!any) break;
    }
    return [...changed];
  } finally {
    for (const p of pages) p.destroy();
  }
}

/** Logic for every field, by name (for the fill overlay). */
export function allLogic(doc: mupdf.PDFDocument): Record<string, FieldLogic> {
  const { fields, pages } = collect(doc);
  try {
    const out: Record<string, FieldLogic> = {};
    for (const f of fields.values()) if (f.logic !== NO_LOGIC) out[f.name] = f.logic;
    return out;
  } finally {
    for (const p of pages) p.destroy();
  }
}
