import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

test("select text, highlight it, add note/shapes/ink, list, update, delete, survive save", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(2));
  const hit = e.search(id, "quick brown")[0];
  const q = hit.quads[0];
  const sel = e.selectText(id, 0, [q[0] + 1, (q[1] + q[5]) / 2], [q[2] - 1, (q[3] + q[7]) / 2]);
  assert.match(sel.text, /quick brown/);
  const words = e.selectText(id, 0, [q[0] + 3, (q[1] + q[5]) / 2], [q[0] + 4, (q[1] + q[5]) / 2], "words");
  assert.equal(words.text.trim(), "quick");

  const k1 = e.addAnnotation(id, 0, { type: "Highlight", quads: sel.quads, contents: "Check this" }, "Sean");
  e.addAnnotation(id, 0, { type: "Text", at: [500, 100], contents: "Sticky note" }, "Sean");
  e.addAnnotation(id, 1, { type: "Square", rect: [100, 100, 200, 160] }, "Sean");
  e.addAnnotation(id, 1, { type: "Line", a: [100, 300], b: [250, 320], arrow: true }, "Sean");
  e.addAnnotation(id, 1, { type: "Ink", strokes: [[[100, 400], [120, 410], [140, 405]]] }, "Sean");
  e.addAnnotation(id, 1, { type: "FreeText", rect: [300, 400, 500, 440], contents: "Typed comment" }, "Sean");

  let all = e.allAnnotations(id);
  assert.deepEqual(all.map((a) => a.type), ["Highlight", "Text", "Square", "Line", "Ink", "FreeText"]);
  assert.equal(all[0].author, "Sean");
  assert.equal(all[0].contents, "Check this");

  assert.equal(e.annotationAt(id, 1, [150, 130])?.type, "Square");
  e.updateAnnotation(id, 0, k1, { contents: "Edited" });
  assert.equal(e.annotations(id, 0)[0].contents, "Edited");
  e.deleteAnnotation(id, 0, k1);
  assert.equal(e.annotations(id, 0).length, 1);

  const summary = e.commentSummary(id);
  assert.match(summary, /Page 1 · Text · Sean\n  Sticky note/);
  const xfdf = e.exportXfdf(id, "a.pdf");
  assert.match(xfdf, /<square page="1"/);
  assert.match(xfdf, /<contents>Typed comment<\/contents>/);

  const re = e.open(e.save(id));
  all = e.allAnnotations(re.id);
  assert.equal(all.length, 5);
  // Rendering still works with annotations
  assert.ok(e.render(re.id, 1, 0.5).width > 0);
});
