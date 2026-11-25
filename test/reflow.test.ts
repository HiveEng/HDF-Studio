import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { textBlocks, writeText, findInPage, findPattern, replaceInPage, replaceText } from "../src/engine/edit";

const TEXT = "The quick brown fox jumps over the lazy dog while the contractor reviews the revised drawings for the north stair and the mechanical room before issuing the final set.";
function mk(align: "left" | "justify" = "left") {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), ""));
  const page = doc.loadPage(0) as mupdf.PDFPage;
  writeText(doc, page, [72, 72], TEXT, { font: "Helvetica", size: 11, color: [0, 0, 0], align }, 200);
  page.destroy();
  return doc;
}
const blocks = (doc: mupdf.PDFDocument) => {
  const p = doc.loadPage(0);
  try {
    return textBlocks(p);
  } finally {
    p.destroy();
  }
};

test("reflow: wrapped lines read back as one paragraph", () => {
  const b = blocks(mk());
  assert.equal(b.length, 1);
  assert.ok(b[0].lines.length >= 4);
  assert.equal(b[0].para, TEXT);
  assert.equal(b[0].style.align, "left");
});

test("reflow: justified text is detected and kept to the column", () => {
  const doc = mk("justify");
  const [b] = blocks(doc);
  assert.equal(b.style.align, "justify");
  assert.equal(b.para.replace(/\s+/g, " "), TEXT);
  const rights = b.lines.slice(0, -1).map((l) => l.bbox[2]);
  assert.ok(Math.max(...rights) - Math.min(...rights) < 1.5, `rights ${rights}`);
});

test("reflow: editing a paragraph rewraps it within the column", () => {
  const doc = mk();
  const [b] = blocks(doc);
  replaceText(doc, 0, b.bbox, b.para.replace("lazy dog", "very lazy and extremely sleepy old dog"), b.style);
  const after = blocks(doc);
  assert.equal(after.length, 1);
  assert.ok(after[0].para.includes("extremely sleepy old dog while"));
  assert.ok(after[0].lines.length > b.lines.length);
  for (const l of after[0].lines) assert.ok(l.bbox[2] <= b.bbox[0] + 202, `line overflows: ${l.bbox}`);
});

test("find and replace: matches across a line break, replace one and all", () => {
  const doc = mk();
  const p = doc.loadPage(0);
  const all = findInPage(p, 0, findPattern("the", { wholeWord: true }));
  p.destroy();
  assert.equal(all.length, 7); // six "the" and one "The"
  assert.ok(all.every((m) => m.quads.length === 3));
  const caseOnly = findInPage(doc.loadPage(0), 0, findPattern("The", { matchCase: true, wholeWord: true }));
  assert.equal(caseOnly.length, 1);
  // replace one
  const n1 = replaceInPage(doc, 0, findPattern("drawings"), "sheets", { block: all[0].block, start: blocks(doc)[0].para.indexOf("drawings") });
  assert.equal(n1, 1);
  assert.ok(blocks(doc)[0].para.includes("revised sheets for"));
  const n = replaceInPage(doc, 0, findPattern("the", { wholeWord: true }), "a");
  assert.equal(n, 7);
  assert.ok(!/\bthe\b/i.test(blocks(doc)[0].para));
});
