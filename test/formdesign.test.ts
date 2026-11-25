import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";

/** A flat (non-fillable) form like a scanned-then-retyped paper form. */
function flatForm(rotate: 0 | 90 = 0): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const t = (x: number, y: number, s: string) => `BT /F1 11 Tf ${x} ${y} Td (${s}) Tj ET`;
  const body = [
    t(72, 720, "Application form"),
    t(72, 680, "Full name: ____________________________"),
    t(72, 650, "Email"), "0.5 w 120 648 m 400 648 l S",
    "0.5 w 72 610 10 10 re S", t(90, 611, "I agree to the terms"),
    t(72, 580, "Comments"), "0.5 w 72 500 300 70 re S",
    // A table with text in its cells must not become fields.
    "0.5 w 72 400 150 20 re S 222 400 150 20 re S", t(76, 406, "Item"), t(226, 406, "Price"),
  ].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], rotate, { Font: { F1: font } }, body));
  return new Uint8Array(doc.saveToBuffer("").asUint8Array());
}

test("detect fields on a flat form: underscores, line, check box, empty box; skips tables with text", () => {
  const e = new Engine();
  const id = e.open(flatForm(), "f.pdf").id;
  const found = e.detectFields(id);
  const summary = found.map((f) => `${f.type}:${f.name}`);
  assert.deepEqual(summary, ["text:Full name", "text:Email", "checkbox:I agree to the terms", "text:Comments"], summary.join(", "));
  assert.ok(found[3].multiline);
  // Full name field sits over the underscores
  const fn = found[0];
  assert.ok(fn.rect[0] > 120 && fn.rect[3] > 105 && fn.rect[3] < 116, String(fn.rect));
});

test("accepting detections makes a working form; fill, save, reopen", () => {
  const e = new Engine();
  const id = e.open(flatForm(), "f.pdf").id;
  const keys = e.addFields(id, e.detectFields(id));
  assert.equal(keys.length, 4);
  assert.equal(e.detectFields(id).length, 0, "nothing left to detect");
  e.fillForm(id, { "Full name": "Ada Lovelace", Email: "ada@example.com", "I agree to the terms": "yes", Comments: "Line one" });
  const again = e.open(e.save(id), "g.pdf").id;
  assert.deepEqual(e.formData(again), { "Full name": "Ada Lovelace", Email: "ada@example.com", "I agree to the terms": "Yes", Comments: "Line one" });
  e.undo(id); // undo the fill
  e.undo(id); // undo adding fields
  assert.equal(e.fields(id).length, 0);
});

test("create every field type, radio groups, edit properties, delete", () => {
  const e = new Engine();
  const id = e.open(flatForm(), "f.pdf").id;
  e.addField(id, 0, { type: "text", name: "City", rect: [72, 300, 250, 318], required: true, maxLen: 20 });
  e.addField(id, 0, { type: "combobox", name: "Country", rect: [72, 330, 250, 348], options: ["Ireland", "France"] });
  e.addField(id, 0, { type: "listbox", name: "Pets", rect: [300, 300, 400, 360], options: ["Cat", "Dog"] });
  const r1 = e.addField(id, 0, { type: "radio", name: "Size", rect: [72, 370, 84, 382], exportValue: "Small" });
  e.addField(id, 0, { type: "radio", name: "Size", rect: [100, 370, 112, 382], exportValue: "Large" });
  e.addField(id, 0, { type: "signature", name: "Signature", rect: [300, 600, 500, 640] });
  const f = e.fields(id);
  assert.deepEqual(f.map((x) => x.type), ["text", "combobox", "listbox", "radiobutton", "radiobutton", "signature"]);
  assert.deepEqual(f.filter((x) => x.type === "radiobutton").map((x) => x.onState), ["Small", "Large"]);
  e.fillForm(id, { Size: "Large", Country: "France" });
  assert.equal(e.formData(id).Size, "Large");
  assert.equal(e.formData(id).Country, "France");

  const city = f[0];
  const props = e.fieldProps(id, 0, city.key);
  assert.equal(props.required, true);
  assert.equal(props.maxLen, 20);
  e.updateField(id, 0, city.key, { name: "Town", required: false, rect: [80, 300, 260, 320], fontSize: 10 });
  const p2 = e.fieldProps(id, 0, city.key);
  assert.equal(p2.name, "Town");
  assert.equal(p2.required, false);
  assert.equal(p2.fontSize, 10);
  assert.ok(Math.abs(p2.rect[0] - 80) < 0.1 && Math.abs(p2.rect[3] - 320) < 0.1);
  assert.throws(() => e.updateField(id, 0, city.key, { name: "Country" }), /already a field/);

  e.deleteField(id, 0, r1);
  assert.equal(e.fields(id).filter((x) => x.type === "radiobutton").length, 1);
  const again = e.open(e.save(id), "g.pdf").id;
  assert.equal(e.fields(again).length, 5);
});

test("fields land in the right place on rotated pages", () => {
  const e = new Engine();
  const id = e.open(flatForm(90), "f.pdf").id;
  const k = e.addField(id, 0, { type: "text", name: "X", rect: [100, 50, 300, 70] });
  const p = e.fieldProps(id, 0, k);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(p.rect[i] - [100, 50, 300, 70][i]) < 0.5, String(p.rect));
});
