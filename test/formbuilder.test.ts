import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";
import { addField, fieldProps, updateField, cloneField, tabOrder, autoTabOrder, setTabOrder, nextName } from "../src/engine/formdesign";
import { listFields, setField } from "../src/engine/forms";
import { normalize, display, parseFormat, parseValidate, formatScripts, validateScript, NO_LOGIC } from "../src/engine/formcalc";

function blank(rotate: 0 | 90 = 0): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], rotate, {}, ""));
  return doc;
}
const reopen = (doc: mupdf.PDFDocument) => mupdf.Document.openDocument(doc.saveToBuffer("").asUint8Array(), "application/pdf") as mupdf.PDFDocument;

test("date field: a text field with a date format; typed dates are normalised", () => {
  const doc = blank();
  const key = addField(doc, 0, { type: "date", name: "Start", rect: [72, 72, 200, 90], datePattern: "yyyy-mm-dd" });
  const p = fieldProps(doc, 0, key);
  assert.equal(p.type, "text");
  assert.deepEqual(p.logic.format, { kind: "date", pattern: "yyyy-mm-dd" });
  setField(doc, 0, key, "3/7/2026");
  assert.equal(listFields(doc)[0].value, "2026-03-07");
  assert.throws(() => setField(doc, 0, key, "not a date"), /isn't a date/);
});

test("push button: caption, action and its own appearance survive save", () => {
  const doc = blank();
  addField(doc, 0, { type: "button", name: "Clear", caption: "Clear form", rect: [72, 300, 172, 324], action: { kind: "reset" } });
  addField(doc, 0, { type: "button", name: "Site", caption: "Visit", rect: [200, 300, 300, 324], action: { kind: "url", url: "https://example.com" } });
  addField(doc, 0, { type: "button", name: "Print", caption: "Print", rect: [320, 300, 420, 324], action: { kind: "print" } });
  const again = reopen(doc);
  const f = listFields(again).filter((x) => x.type === "button");
  assert.deepEqual(f.map((x) => [x.caption, x.action?.kind]), [["Clear form", "reset"], ["Visit", "url"], ["Print", "print"]]);
  const ap = again.loadPage(0) as mupdf.PDFPage;
  const w = ap.getWidgets()[0].getObject();
  assert.match(w.get("AP").get("N").readStream().asString(), /\(Clear form\) Tj/);
  // Renders without error and draws something.
  const pix = ap.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
  assert.ok(pix.getWidth() > 0);
});

test("look: colors, font, alignment, border width and check style round-trip", () => {
  const doc = blank();
  const t = addField(doc, 0, { type: "text", name: "Name", rect: [72, 72, 272, 92], value: "Ada", look: { fillColor: [1, 1, 0.8], borderColor: [0, 0, 1], textColor: [0.8, 0, 0], font: "Cour", align: 1, borderWidth: 2 } });
  const p = fieldProps(doc, 0, t);
  assert.deepEqual(p.look.fillColor, [1, 1, 0.8]);
  assert.deepEqual(p.look.borderColor, [0, 0, 1]);
  assert.deepEqual(p.look.textColor, [0.8, 0, 0]);
  assert.equal(p.look.font, "Cour");
  assert.equal(p.look.align, 1);
  assert.equal(p.look.borderWidth, 2);
  updateField(doc, 0, t, { look: { fillColor: null, font: "TiRo" }, fontSize: 14 });
  const q = fieldProps(doc, 0, t);
  assert.equal(q.look.fillColor, null);
  assert.equal(q.look.font, "TiRo");
  assert.equal(q.fontSize, 14);
  assert.deepEqual(q.look.textColor, [0.8, 0, 0]);
  const c = addField(doc, 0, { type: "checkbox", name: "Agree", rect: [72, 120, 84, 132], look: { checkStyle: "cross" } });
  assert.equal(fieldProps(doc, 0, c).look.checkStyle, "cross");
  updateField(doc, 0, c, { look: { checkStyle: "star" }, exportValue: "Agreed" });
  const cp = fieldProps(doc, 0, c);
  assert.equal(cp.look.checkStyle, "star");
  assert.equal(cp.exportValue, "Agreed");
});

test("copies: next name in the series, keep properties; radio copies join the group", () => {
  const doc = blank();
  assert.equal(nextName(new Set(["Qty 1"]), "Qty 1"), "Qty 2");
  assert.equal(nextName(new Set(["Total"]), "Total"), "Total 2");
  const k = addField(doc, 0, { type: "text", name: "Qty 1", rect: [72, 100, 132, 118], required: true, logic: { ...NO_LOGIC, format: { kind: "number", decimals: 0, sep: 0 } } });
  const made = cloneField(doc, { page: 0, key: k }, [1, 2, 3].map((i) => ({ page: 0, rect: [72, 100 + 20 * i, 132, 118 + 20 * i] })));
  assert.equal(made.length, 3);
  const f = listFields(doc);
  assert.deepEqual(f.map((x) => x.name), ["Qty 1", "Qty 2", "Qty 3", "Qty 4"]);
  assert.ok(f.every((x) => x.required && x.logic.format.kind === "number"));
  const r = addField(doc, 0, { type: "radio", name: "Size", rect: [300, 100, 312, 112], exportValue: "Small" });
  cloneField(doc, { page: 0, key: r }, [{ page: 0, rect: [330, 100, 342, 112] }]);
  const radios = listFields(doc).filter((x) => x.type === "radiobutton");
  assert.equal(radios.length, 2);
  assert.ok(radios.every((x) => x.name === "Size"));
  assert.notEqual(radios[0].onState, radios[1].onState);
});

test("tab order: by rows, by columns, and manual", () => {
  const doc = blank();
  // Two columns, two rows, added out of order.
  const br = addField(doc, 0, { type: "text", name: "BR", rect: [300, 200, 400, 218] });
  const tl = addField(doc, 0, { type: "text", name: "TL", rect: [72, 100, 172, 118] });
  const bl = addField(doc, 0, { type: "text", name: "BL", rect: [72, 201, 172, 219] });
  const tr = addField(doc, 0, { type: "text", name: "TR", rect: [300, 99, 400, 117] });
  assert.deepEqual(autoTabOrder(doc, 0, "rows"), [tl, tr, bl, br]);
  assert.equal(tabOrder(doc, 0).order, "rows");
  assert.deepEqual(autoTabOrder(doc, 0, "columns"), [tl, bl, tr, br]);
  setTabOrder(doc, 0, [br, bl, tr, tl]);
  const t = tabOrder(doc, 0);
  assert.deepEqual(t.keys, [br, bl, tr, tl]);
  assert.equal(t.order, "unspecified");
  // The fill-in order follows.
  assert.deepEqual(listFields(reopen(doc)).map((x) => x.name), ["BR", "BL", "TR", "TL"]);
});

test("special formats and email validation", () => {
  assert.deepEqual(parseFormat(formatScripts({ kind: "special", mask: "phone" })!.F), { kind: "special", mask: "phone" });
  assert.deepEqual(parseValidate(validateScript({ kind: "email" })!), { kind: "email" });
  const phone = { ...NO_LOGIC, format: { kind: "special", mask: "phone" } as const };
  assert.deepEqual(normalize("555.123.4567", phone), { value: "5551234567" });
  assert.equal(display("5551234567", phone.format), "(555) 123-4567");
  assert.ok("error" in normalize("12345", phone));
  assert.equal(display("123456789", { kind: "special", mask: "ssn" }), "123-45-6789");
  assert.equal(display("123456789", { kind: "special", mask: "zip4" }), "12345-6789");
  const email = { ...NO_LOGIC, validate: { kind: "email" } as const };
  assert.deepEqual(normalize("ada@example.com", email), { value: "ada@example.com" });
  assert.ok("error" in normalize("ada@", email));
});

test("engine: copy, arrange, edit and delete many fields as single undo steps", () => {
  const e = new Engine();
  const doc = blank();
  const id = e.open(new Uint8Array(doc.saveToBuffer("").asUint8Array()), "f.pdf").id;
  const a = e.addField(id, 0, { type: "text", name: "A", rect: [72, 100, 172, 118] });
  const b = e.addField(id, 0, { type: "text", name: "B", rect: [90, 150, 160, 168] });
  e.setFieldRects(id, [{ page: 0, key: b, rect: [72, 150, 172, 168] }]);
  assert.deepEqual(e.fields(id).find((x) => x.key === b)!.rect.map(Math.round), [72, 150, 172, 168]);
  e.updateFields(id, [{ page: 0, key: a }, { page: 0, key: b }], { required: true });
  assert.ok(e.fields(id).every((x) => x.required));
  e.cloneFields(id, [{ src: { page: 0, key: a }, targets: [{ page: 0, rect: [72, 200, 172, 218] }] }]);
  assert.equal(e.fields(id).length, 3);
  e.undo(id);
  assert.equal(e.fields(id).length, 2);
  e.deleteFields(id, [{ page: 0, key: a }, { page: 0, key: b }]);
  assert.equal(e.fields(id).length, 0);
});

test("fields on a rotated page get upright check box and button appearances", () => {
  const doc = blank(90);
  const k = addField(doc, 0, { type: "button", name: "Go", caption: "Go", rect: [72, 72, 172, 96] });
  const o = doc.newIndirect(k);
  assert.ok(o.get("AP").get("N").get("Matrix").isArray());
  const p = fieldProps(doc, 0, k);
  assert.deepEqual(p.rect.map(Math.round), [72, 72, 172, 96]);
});
