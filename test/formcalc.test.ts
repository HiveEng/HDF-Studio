import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { addField, updateField } from "../src/engine/formdesign";
import { listFields, setField, formData } from "../src/engine/forms";
import { parseCalc, parseFormat, parseValidate, formatNumber, makeNumber, normalize, NO_LOGIC, display, calcScript, parseExpr } from "../src/engine/formcalc";

test("formcalc: reads Acrobat scripts", () => {
  assert.deepEqual(parseCalc('AFSimple_Calculate("SUM", new Array ("Line1", "Line2"));'), { kind: "simple", op: "SUM", fields: ["Line1", "Line2"] });
  assert.deepEqual(parseCalc("/** BVCALC Qty * Price EVCALC **/ event.value = 1"), { kind: "formula", expr: "Qty * Price" });
  assert.deepEqual(parseFormat('AFNumber_Format(2, 0, 0, 0, "$", true);'), { kind: "number", decimals: 2, sep: 0, negParens: false, currency: "$", prepend: true });
  assert.deepEqual(parseValidate("AFRange_Validate(true, 0, true, 100);"), { kind: "range", min: 0, max: 100 });
  assert.equal(parseCalc("event.value = 3").kind, "script");
});

test("formcalc: number formats and parsing", () => {
  assert.equal(formatNumber(1234.5, { kind: "number", decimals: 2, sep: 0, currency: "$", prepend: true }), "$1,234.50");
  assert.equal(formatNumber(-1234.5, { kind: "number", decimals: 2, sep: 2, negParens: true, currency: " €", prepend: false }), "(1.234,50 €)");
  assert.equal(formatNumber(0.155, { kind: "percent", decimals: 1, sep: 0 }), "15.5%");
  assert.equal(makeNumber("$1,234.50"), 1234.5);
  assert.equal(makeNumber("(12)"), -12);
  assert.equal(makeNumber("1.234,5", 2), 1234.5);
  assert.deepEqual(normalize("15", { ...NO_LOGIC, format: { kind: "percent", decimals: 0, sep: 0 } }), { value: "0.15" });
  assert.deepEqual(normalize("abc", { ...NO_LOGIC, format: { kind: "number", decimals: 2, sep: 0 } }), { error: "“abc” isn't a number." });
  assert.ok("error" in normalize("120", { ...NO_LOGIC, validate: { kind: "range", min: 0, max: 100 } }));
  assert.equal(display("2025-03-07", { kind: "date", pattern: "mmm d, yyyy" }), "Mar 7, 2025");
  assert.deepEqual(normalize("3/7/25", { ...NO_LOGIC, format: { kind: "date", pattern: "mm/dd/yyyy" } }), { value: "03/07/2025" });
  assert.throws(() => parseExpr("Qty * (Price"), /missing \)/);
  assert.match(calcScript({ kind: "formula", expr: "Qty * Price" })!, /AFMakeNumber\(getField\("Qty"\)\.value\) \* AFMakeNumber\(getField\("Price"\)\.value\)/);
});

test("formcalc: invoice totals recalculate as fields are filled", () => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), ""));
  const money = { kind: "number", decimals: 2, sep: 0, currency: "$", prepend: true } as const;
  const k = (name: string, y: number, logic?: Parameters<typeof addField>[2]["logic"]) => addField(doc, 0, { type: "text", name, rect: [72, y, 200, y + 20], logic });
  k("Qty", 72, { ...NO_LOGIC, format: { kind: "number", decimals: 0, sep: 0 }, validate: { kind: "range", min: 0 } });
  k("Price", 100, { ...NO_LOGIC, format: money });
  k("Line", 130, { ...NO_LOGIC, format: money, calc: { kind: "formula", expr: "Qty * Price" } });
  k("Shipping", 160, { ...NO_LOGIC, format: money });
  const total = k("Total", 190, { ...NO_LOGIC, format: money, calc: { kind: "simple", op: "SUM", fields: ["Line", "Shipping"] } });
  const key = (n: string) => listFields(doc).find((f) => f.name === n)!.key;
  setField(doc, 0, key("Qty"), "3");
  setField(doc, 0, key("Price"), "$1,250.5");
  setField(doc, 0, key("Shipping"), "20");
  const f = Object.fromEntries(listFields(doc).map((x) => [x.name, x]));
  assert.equal(f.Line.value, "3751.5");
  assert.equal(f.Line.shown, "$3,751.50");
  assert.equal(f.Total.value, "3771.5");
  assert.equal(f.Total.shown, "$3,771.50");
  assert.equal(formData(doc).Total, "3771.5");
  assert.throws(() => setField(doc, 0, key("Qty"), "-1"), /at least 0/);
  assert.throws(() => setField(doc, 0, key("Price"), "lots"), /isn't a number/);
  // Calculation order is stored for other readers.
  const co = doc.getTrailer().get("Root").get("AcroForm").get("CO");
  assert.equal(co.length, 2);
  // The appearance shows the formatted value.
  const page = doc.loadPage(0) as mupdf.PDFPage;
  const w = page.getWidgets().find((x) => x.getObject().asIndirect() === total)!;
  assert.match(w.getObject().get("AP").get("N").readStream().asString(), /\$3,771\.50/);
  page.destroy();
  // Changing the formula through the designer recalculates.
  updateField(doc, 0, key("Line"), { logic: { ...NO_LOGIC, format: money, calc: { kind: "formula", expr: "Qty * Price * 2" } } });
  assert.equal(Object.fromEntries(listFields(doc).map((x) => [x.name, x.value])).Total, "7523");
});
