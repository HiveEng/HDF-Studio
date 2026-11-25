import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

test("multileader: leaders group with their text box, recolour and delete together, export as group", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  const box = e.addAnnotation(id, 0, { type: "FreeText", rect: [200, 300, 320, 330], contents: "TYP. 3 PLACES" }, "Sean");
  const l1 = e.addLeader(id, 0, box, [100, 400], "Sean");
  e.addLeader(id, 0, box, [400, 420], "Sean");
  let all = e.allAnnotations(id);
  assert.equal(all.length, 3);
  const leader = all.find((a) => a.key === l1)!;
  assert.equal(leader.groupOf, box);
  assert.equal(leader.inReplyTo, undefined, "a leader is not a reply");
  // Leaves the left side's middle, ends at the target.
  assert.ok(leader.rect[0] <= 101 && leader.rect[2] >= 199, `${leader.rect}`);
  // Clicking a leader selects its text box.
  const hit = e.annotationAt(id, 0, [150, 357]);
  assert.equal(hit?.key, box);
  // Text colour (not background) changes, and the leaders follow.
  e.updateAnnotation(id, 0, box, { color: [0, 0, 1], fontSize: 14 });
  all = e.allAnnotations(id);
  assert.deepEqual(all.find((a) => a.key === l1)!.color.map((v) => +v.toFixed(2)), [0, 0, 1]);
  const xfdf = e.exportXfdf(id, "x.pdf");
  assert.match(xfdf, /replyType="group"/);
  e.deleteAnnotation(id, 0, box);
  assert.equal(e.allAnnotations(id).length, 0);
});

test("properties: line width, opacity and author", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  const k = e.addAnnotation(id, 0, { type: "Square", rect: [100, 100, 200, 200] }, "A");
  e.updateAnnotation(id, 0, k, { width: 5, opacity: 0.5, author: "B" });
  const a = e.allAnnotations(id)[0];
  assert.equal(a.author, "B");
});
