// Form filling (AcroForm) and signature images.
import * as mupdf from "mupdf";
import { uprightImageStamp } from "./annotations";
import { readLogic, normalize, setDisplayed, recalculate, display, type FieldLogic } from "./formcalc";

export interface FieldInfo {
  key: number;
  page: number;
  name: string;
  type: string; // text | checkbox | radiobutton | combobox | listbox | signature | button
  value: string;
  options: string[];
  /** For checkboxes and radio buttons: the value this widget stands for when on. */
  onState: string | null;
  rect: number[];
  readOnly: boolean;
  multiline: boolean;
  maxLen: number;
  required: boolean;
  /** The value as the field shows it (formatted number, currency, date…). */
  shown: string;
  /** Format, calculation and validation from the field's scripts. */
  logic: FieldLogic;
}

function onStateOf(w: mupdf.PDFWidget): string | null {
  const n = w.getObject().get("AP").get("N");
  let on: string | null = null;
  if (n.isDictionary()) n.forEach((_v, k) => (k !== "Off" ? (on = String(k)) : null));
  return on;
}

const keyOf = (w: mupdf.PDFWidget) => w.getObject().asIndirect();

export function listFields(doc: mupdf.PDFDocument): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    for (const w of page.getWidgets()) {
      const type = w.getFieldType();
      const logic = readLogic(w.getObject());
      const value = type === "signature" ? (w.getObject().get("V").isNull() ? "" : "signed") : w.getValue() ?? "";
      out.push({
        key: keyOf(w),
        page: i,
        name: w.getName(),
        type,
        value,
        shown: type === "text" ? display(value, logic.format) : value,
        logic,
        required: (w.getFieldFlags() & 2) !== 0,
        options: w.isChoice() ? w.getOptions() : [],
        onState: w.isCheckbox() || w.isRadioButton() ? onStateOf(w) : null,
        rect: Array.from(w.getBounds()),
        readOnly: w.isReadOnly(),
        multiline: type === "text" && w.isMultiline(),
        maxLen: type === "text" ? w.getMaxLen() : 0,
      });
    }
    page.destroy();
  }
  return out;
}

const TRUTHY = /^(1|y|yes|true|on|x|checked|✓|✔)$/i;

function setWidget(doc: mupdf.PDFDocument, w: mupdf.PDFWidget, value: string, strict = false): boolean {
  if (w.isReadOnly()) return false;
  if (w.isText()) {
    // Formats (number, currency, date) and range checks from the field's own scripts.
    const logic = readLogic(w.getObject());
    const r = normalize(value, logic);
    if ("error" in r) {
      if (strict) throw new Error(r.error);
      w.setTextValue(value);
    } else {
      setDisplayed(doc, w, r.value, logic.format);
      return true;
    }
  } else if (w.isChoice()) w.setChoiceValue(value);
  else if (w.isCheckbox()) {
    const on = onStateOf(w);
    const want = TRUTHY.test(value) || (!!on && value === on);
    if ((w.getValue() !== "Off" && w.getValue() !== "") !== want) w.toggle();
  } else if (w.isRadioButton()) {
    const on = onStateOf(w);
    if (on !== value) return false;
    if (w.getValue() !== on) w.toggle();
  } else return false;
  w.update();
  return true;
}

export function setField(doc: mupdf.PDFDocument, pageIndex: number, key: number, value: string) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const w = page.getWidgets().find((x) => keyOf(x) === key);
    if (!w) throw new Error("Field not found");
    setWidget(doc, w, value, true);
  } finally {
    page.destroy();
  }
  recalculate(doc);
}

/** Fill fields by name (e.g. one CSV row). Returns the names that were filled and those not found. */
export function fillByName(doc: mupdf.PDFDocument, data: Record<string, string>): { filled: string[]; missing: string[] } {
  const filled = new Set<string>();
  const want = new Map(Object.entries(data).map(([k, v]) => [k.trim(), String(v ?? "")]));
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    for (const w of page.getWidgets()) {
      const name = w.getName();
      if (want.has(name) && setWidget(doc, w, want.get(name)!)) filled.add(name);
    }
    page.destroy();
  }
  recalculate(doc);
  return { filled: [...filled], missing: [...want.keys()].filter((k) => !filled.has(k)) };
}

/** Current values keyed by field name (radio groups give the selected option). */
export function formData(doc: mupdf.PDFDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listFields(doc)) {
    if (f.type === "button" || f.type === "signature") continue;
    if (f.type === "radiobutton") {
      if (!(f.name in out) || f.value !== "Off") out[f.name] = f.value === "Off" ? "" : f.value;
    } else if (f.type === "checkbox") out[f.name] = f.value !== "Off" && f.value !== "" ? "Yes" : "No";
    else out[f.name] = f.value;
  }
  return out;
}

/** Clear all fields back to empty/off. */
export function clearForm(doc: mupdf.PDFDocument) {
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    for (const w of page.getWidgets()) {
      if (w.isReadOnly()) continue;
      if (w.isText()) w.setTextValue("");
      else if (w.isChoice()) w.setChoiceValue("");
      else if ((w.isCheckbox() || w.isRadioButton()) && w.getValue() !== "Off" && w.getValue() !== "") {
        // toggle() on a radio can't switch it off; clear the state directly
        if (w.isRadioButton()) {
          w.getObject().put("AS", doc.newName("Off"));
          const parent = w.getObject().get("Parent");
          (parent.isNull() ? w.getObject() : parent).put("V", doc.newName("Off"));
        } else w.toggle();
      }
      w.update();
    }
    page.destroy();
  }
  recalculate(doc);
}

/** Place a signature (or any) image on a page as a stamp annotation. */
export function placeImage(doc: mupdf.PDFDocument, pageIndex: number, rect: number[], png: Uint8Array, label = "Signature"): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = page.createAnnotation("Stamp");
    a.setRect(rect as mupdf.Rect);
    a.setStampImage(new mupdf.Image(png));
    a.setContents(label);
    a.setModificationDate(new Date());
    a.update();
    uprightImageStamp(doc, page, a, rect);
    return a.getObject().asIndirect();
  } finally {
    page.destroy();
  }
}

/** Minimal CSV parser (RFC 4180: quotes, escaped quotes, newlines in quotes). First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/**
 * Mail merge: fill a form template once per data row. Output names come from a template such as
 * "{name} - {email}" using field values (or "{row}").
 */
export function mailMerge(template: Uint8Array, rows: Record<string, string>[], o: { name?: string; flatten?: boolean } = {}): { name: string; data: Uint8Array; missing: string[] }[] {
  const out: { name: string; data: Uint8Array; missing: string[] }[] = [];
  const used = new Map<string, number>();
  rows.forEach((row, i) => {
    const doc = mupdf.Document.openDocument(template, "pdf").asPDF();
    if (!doc) throw new Error("Template is not a PDF");
    const { missing } = fillByName(doc, row);
    if (o.flatten) doc.bake(true, true);
    const buf = doc.saveToBuffer("garbage,compress");
    let name = (o.name ?? "{row}").replace(/\{([^}]+)\}/g, (_, k: string) => (k === "row" ? String(i + 1).padStart(3, "0") : row[k] ?? ""));
    name = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim() || `row ${i + 1}`;
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    out.push({ name: `${n ? `${name} (${n + 1})` : name}.pdf`, data: new Uint8Array(buf.asUint8Array()), missing });
    buf.destroy();
    doc.destroy();
  });
  return out;
}
