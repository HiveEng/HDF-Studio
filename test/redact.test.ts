import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";
import { runRecipe } from "../src/engine/recipes";
import { protectionOptions } from "../src/engine/redact";
import { makeSamplePdf } from "./fixtures";

test("mark by text and regex, apply: text is really gone and survives save", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(3));
  assert.equal(e.markRedactions(id, { text: "lazy dog" }).count, 3);
  assert.equal(e.markRedactions(id, { regex: "QX-100[02]" }).count, 2);
  assert.equal(e.redactionCount(id), 5);
  assert.match(e.pageText(id, 0), /lazy dog/, "marking alone doesn't remove anything");
  const r = e.applyRedactions(id);
  assert.equal(r.pagesChanged, 3);
  assert.equal(e.redactionCount(id), 0);
  const saved = e.save(id, "garbage,compress,sanitize");
  const re = e.open(saved);
  for (let p = 0; p < 3; p++) assert.doesNotMatch(e.pageText(re.id, p), /lazy dog/);
  assert.doesNotMatch(e.pageText(re.id, 0), /QX-1000/);
  assert.match(e.pageText(re.id, 1), /QX-1001/, "non-matching text kept");
  assert.match(e.pageText(re.id, 0), /quick brown fox/, "rest of the line kept");
  // the raw bytes no longer contain the redacted words either
  const raw = new TextDecoder("latin1").decode(e.save(re.id, "decompress"));
  assert.ok(!raw.includes("lazy dog"));
});

test("undo a redaction", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  e.markRedactions(id, { text: "quick" });
  e.applyRedactions(id);
  assert.doesNotMatch(e.pageText(id, 0), /quick/);
  e.undo(id);
  e.undo(id);
  assert.match(e.pageText(id, 0), /quick/);
  assert.equal(e.redactionCount(id), 0);
});

test("sanitize removes metadata, JavaScript and attachments", () => {
  const e = new Engine();
  const doc = mupdf.Document.openDocument(makeSamplePdf(1), "pdf").asPDF()!;
  doc.setMetaData("info:Author", "Secret Person");
  const root = doc.getTrailer().get("Root");
  const names = doc.newDictionary();
  const js = doc.newDictionary();
  const arr = doc.newArray();
  arr.push(doc.newString("x"));
  const action = doc.newDictionary();
  action.put("S", doc.newName("JavaScript"));
  action.put("JS", doc.newString("app.alert(1)"));
  arr.push(action);
  js.put("Names", arr);
  names.put("JavaScript", js);
  root.put("Names", names);
  root.put("OpenAction", action);
  const buf = doc.saveToBuffer("");
  const { id } = e.open(new Uint8Array(buf.asUint8Array()));
  const rep = e.sanitize(id);
  assert.equal(rep.metadata, true);
  assert.equal(rep.javascript, 1);
  assert.equal(rep.openAction, true);
  const raw = new TextDecoder("latin1").decode(e.save(id, "garbage,decompress,sanitize"));
  assert.ok(!raw.includes("Secret Person"));
  assert.ok(!raw.includes("app.alert"));
});

test("recipe: redact emails via pattern; protection options", () => {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { Font: { F1: font } }, "BT /F1 12 Tf 72 700 Td (Contact jane.doe@example.com or 555-123-4567 today) Tj ET"));
  const input = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  const { outputs } = runRecipe(input, "c.pdf", { name: "r", steps: [{ op: "redact", pattern: "email" }, { op: "redact", pattern: "phone" }] });
  const e = new Engine();
  const t = e.pageText(e.open(outputs[0].data).id, 0);
  assert.doesNotMatch(t, /jane|example|555/);
  assert.match(t, /Contact/);
  assert.match(protectionOptions({ ownerPassword: "a,b=c", allowCopy: false }), /owner-password=abc/);
});
