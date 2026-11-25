import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

test("open, render, search, outline, save round-trip", () => {
  const e = new Engine();
  const info = e.open(makeSamplePdf(3));
  assert.equal(info.pageCount, 3);
  assert.deepEqual(info.pageSizes[0], [612, 792]);
  assert.equal(info.outline.length, 3);
  assert.equal(info.outline[1].page, 1);

  const r = e.render(info.id, 0, 0.5);
  assert.equal(r.width, 306);
  assert.equal(r.pixels.length, r.width * r.height * 4);

  const hits = e.search(info.id, "quick brown");
  assert.equal(hits.length, 3);
  assert.match(hits[0].snippet, /quick brown fox/);
  assert.deepEqual(hits.map((h) => h.page), [0, 1, 2]);
  assert.equal(e.search(info.id, "qx-1001")[0].page, 1, "search is case-insensitive");

  assert.match(e.pageText(info.id, 2), /Sample page 3/);
  const saved = e.save(info.id);
  const again = e.open(saved);
  assert.equal(again.pageCount, 3);
});
