import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { parseCsv } from "../src/engine/forms";
import { makeFormPdf, makeSamplePdf } from "./fixtures";

// 1x1 red PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

test("list and fill fields, read data back, clear, survive save", () => {
  const e = new Engine();
  const { id } = e.open(makeFormPdf());
  const f = e.fields(id);
  assert.deepEqual(f.map((x) => `${x.type}:${x.name}`), ["text:name", "text:email", "checkbox:agree", "combobox:country", "radiobutton:size", "radiobutton:size", "radiobutton:size"]);
  assert.deepEqual(f.filter((x) => x.type === "radiobutton").map((x) => x.onState), ["S", "M", "L"]);
  e.setField(id, 0, f[0].key, "Sean O'Brien");
  const r = e.fillForm(id, { email: "s@example.com", agree: "yes", country: "Ireland", size: "L", nope: "x" });
  assert.deepEqual(r.missing, ["nope"]);
  assert.deepEqual(e.formData(id), { name: "Sean O'Brien", email: "s@example.com", agree: "Yes", country: "Ireland", size: "L" });
  const re = e.open(e.save(id));
  assert.deepEqual(e.formData(re.id), { name: "Sean O'Brien", email: "s@example.com", agree: "Yes", country: "Ireland", size: "L" });
  assert.match(e.pageText(re.id, 0), /Name/);
  e.clearForm(re.id);
  assert.deepEqual(e.formData(re.id), { name: "", email: "", agree: "No", country: "", size: "" });
  e.undo(re.id);
  assert.equal(e.formData(re.id).size, "L");
});

test("flatten burns values into the page", () => {
  const e = new Engine();
  const { id } = e.open(makeFormPdf());
  e.fillForm(id, { name: "Flat Value" });
  e.flatten(id);
  assert.equal(e.fields(id).length, 0);
  assert.match(e.pageText(id, 0), /Flat Value/);
});

test("CSV parsing and mail merge", () => {
  const rows = parseCsv('name,email,size\n"Doe, Jane",jane@x.com,S\r\nBob,"b""ob""@x.com",M\n\n');
  assert.deepEqual(rows, [{ name: "Doe, Jane", email: "jane@x.com", size: "S" }, { name: "Bob", email: 'b"ob"@x.com', size: "M" }]);
  const e = new Engine();
  const out = e.mailMerge(makeFormPdf(), "name,size\nJane,S\nBob,M\nBob,L", { name: "Form - {name}", flatten: false });
  assert.deepEqual(out.map((o) => o.name), ["Form - Jane.pdf", "Form - Bob.pdf", "Form - Bob (2).pdf"]);
  assert.equal(e.formData(e.open(out[2].data).id).size, "L");
});

test("place a signature image", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  e.placeImage(id, 0, [300, 600, 450, 650], PNG);
  const a = e.annotations(id, 0);
  assert.equal(a[0].type, "Stamp");
  const px = e.render(id, 0, 1);
  // pixel inside the stamp is red
  const off = (620 * px.width + 375) * 4;
  assert.ok(px.pixels[off] > 200 && px.pixels[off + 1] < 60, `got ${px.pixels.slice(off, off + 3)}`);
});
