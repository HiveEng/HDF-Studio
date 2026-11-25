import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";
import { parseXfdf } from "../src/engine/annotations";

function blank(pages = 2): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, ""));
  return new Uint8Array(doc.saveToBuffer("").asUint8Array());
}

test("replies and review status thread under their comment and stay off the page", () => {
  const e = new Engine();
  const { id } = e.open(blank(), "a.pdf");
  const k = e.addAnnotation(id, 0, { type: "Square", rect: [100, 100, 200, 150], contents: "Fix this" }, "Ann");
  const r = e.addReply(id, 0, k, "Done", "Bob");
  const s = e.addReply(id, 0, k, "Bob Accepted", "Bob", "Accepted");
  const all = e.allAnnotations(id);
  assert.equal(all.find((a) => a.key === r)!.inReplyTo, k);
  assert.equal(all.find((a) => a.key === s)!.state, "Accepted");
  assert.ok(all.find((a) => a.key === r)!.hidden);
  assert.equal(e.annotationAt(id, 0, [102, 102])!.key, k, "hidden replies are not hit-tested");
  e.undo(id);
  assert.equal(e.allAnnotations(id).length, 2);
});

test("merge reviewers' copies: new comments come in once, replies keep their thread", () => {
  const e = new Engine();
  const base = e.open(blank(), "base.pdf").id;
  e.addAnnotation(base, 0, { type: "Text", at: [50, 50], contents: "Original note" }, "Ann");
  const shared = e.save(base);
  // Reviewer copies are made before names were assigned, from the shared file.
  const rev1 = e.open(shared.slice(), "r1.pdf").id;
  const parent = e.allAnnotations(rev1)[0].key;
  e.addReply(rev1, 0, parent, "Agree", "Bob");
  e.addAnnotation(rev1, 1, { type: "Highlight", quads: [[72, 100, 200, 100, 72, 114, 200, 114]], contents: "typo" }, "Bob");
  const rev2 = e.open(shared.slice(), "r2.pdf").id;
  e.addAnnotation(rev2, 0, { type: "Circle", rect: [300, 300, 350, 350] }, "Cy");

  const r1 = e.mergeComments(base, e.save(rev1));
  assert.equal(r1.added, 2);
  assert.deepEqual(r1.authors, { Bob: 2 });
  const r2 = e.mergeComments(base, e.save(rev2));
  assert.equal(r2.added, 1);
  assert.equal(e.mergeComments(base, e.save(rev1)).added, 0, "merging again adds nothing");

  const all = e.allAnnotations(base);
  assert.equal(all.length, 4);
  const orig = all.find((a) => a.contents === "Original note")!;
  assert.equal(all.find((a) => a.contents === "Agree")!.inReplyTo, orig.key);
  // Survives save and reopen.
  const again = e.open(e.save(base), "x.pdf").id;
  assert.equal(e.allAnnotations(again).length, 4);
});

test("XFDF round trip: export, then import into a clean copy, keeps types, threads and status", () => {
  const e = new Engine();
  const src = e.open(blank(), "a.pdf").id;
  const k = e.addAnnotation(src, 0, { type: "Highlight", quads: [[72, 100, 200, 100, 72, 114, 200, 114]], contents: "Check <this> & that" }, "Ann");
  e.addReply(src, 0, k, "Fixed", "Bob", "Completed");
  e.addAnnotation(src, 1, { type: "Ink", strokes: [[[10, 10], [40, 60], [80, 20]]] }, "Cy");
  e.addAnnotation(src, 1, { type: "Line", a: [100, 100], b: [200, 300], arrow: true }, "Cy");
  const xfdf = e.exportXfdf(src, "a.pdf");
  assert.equal(parseXfdf(xfdf).length, 4);

  const dst = e.open(blank(), "a.pdf").id;
  const r = e.importXfdf(dst, xfdf);
  assert.equal(r.added, 4);
  assert.deepEqual(r.authors, { Ann: 1, Bob: 1, Cy: 2 });
  const all = e.allAnnotations(dst);
  const hl = all.find((a) => a.type === "Highlight")!;
  assert.equal(hl.contents, "Check <this> & that");
  assert.ok(Math.abs(hl.quads![0][1] - 100) < 0.1 && Math.abs(hl.quads![0][2] - 200) < 0.1, "coordinates converted back to page space");
  const reply = all.find((a) => a.contents === "Fixed")!;
  assert.equal(reply.inReplyTo, hl.key);
  assert.equal(reply.state, "Completed");
  assert.ok(reply.hidden);
  const ink = all.find((a) => a.type === "Ink")!;
  assert.equal(ink.page, 1);
  assert.ok(ink.rect[0] < 15 && ink.rect[3] > 55);
  assert.equal(e.importXfdf(dst, xfdf).added, 0, "importing twice adds nothing");
});

test("parseXfdf reads rich text and other apps' attribute styles", () => {
  const xml = `<?xml version="1.0"?><xfdf><annots>
    <text page='0' rect='10,10,30,30' title='Dee' name='n1'><contents-richtext><body><p>Line &amp; one</p><p>two</p></body></contents-richtext></text>
    <square page="0" rect="1,2,3,4" color="#FF0000" interior-color="#00FF00" width="3"/>
    <polygon page="0" rect="0,0,1,1"/>
  </annots></xfdf>`;
  const r = parseXfdf(xml);
  assert.equal(r.length, 2);
  assert.equal(r[0].contents, "Line & one\ntwo");
  assert.equal(r[1].attrs["interior-color"], "#00FF00");
});

test("re-importing XFDF exported from the same file adds nothing", () => {
  const e = new Engine();
  const id = e.open(blank(), "a.pdf").id;
  e.addAnnotation(id, 0, { type: "Square", rect: [10, 10, 50, 50] }, "Ann");
  assert.equal(e.importXfdf(id, e.exportXfdf(id, "a.pdf")).added, 0);
});

test("comment summary lists replies under their comment", () => {
  const e = new Engine();
  const id = e.open(blank(), "a.pdf").id;
  const k = e.addAnnotation(id, 0, { type: "Text", at: [10, 10], contents: "Question" }, "Ann");
  e.addReply(id, 0, k, "Answer", "Bob");
  e.addReply(id, 0, k, "Bob set status", "Bob", "Accepted");
  const s = e.commentSummary(id);
  assert.match(s, /Question\n  ↳ Bob: Answer\n  ↳ Bob: status Accepted/);
  assert.equal(s.split("Page 1").length, 2);
});
