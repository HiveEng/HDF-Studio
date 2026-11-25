import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { parseRanges, formatRanges } from "../src/engine/ranges";
import { makeSamplePdf } from "./fixtures";

const firstLine = (e: Engine, id: number, p: number) => e.pageText(id, p).split("\n")[0].trim();
const titles = (e: Engine, id: number) => Array.from({ length: e.info(id).pageCount }, (_, i) => firstLine(e, id, i));

test("parseRanges / formatRanges", () => {
  assert.deepEqual(parseRanges("1-3, 5, 8-", 10), [0, 1, 2, 4, 7, 8, 9]);
  assert.deepEqual(parseRanges("-2,last", 5), [0, 1, 4]);
  assert.deepEqual(parseRanges("odd", 5), [0, 2, 4]);
  assert.deepEqual(parseRanges("3-1", 5), [2, 1, 0]);
  assert.deepEqual(parseRanges("", 3), [0, 1, 2]);
  assert.throws(() => parseRanges("7", 5), /out of range/);
  assert.throws(() => parseRanges("a-b", 5), /Invalid/);
  assert.equal(formatRanges([0, 1, 2, 4, 7, 8]), "1-3,5,8-9");
});

test("delete, move, reverse, rotate, insert blank", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(5, "Doc"));
  e.deletePages(id, [1, 3]);
  assert.deepEqual(titles(e, id), ["Doc page 1", "Doc page 3", "Doc page 5"]);
  e.movePages(id, [2], 0);
  assert.deepEqual(titles(e, id), ["Doc page 5", "Doc page 1", "Doc page 3"]);
  e.reversePages(id);
  assert.deepEqual(titles(e, id), ["Doc page 3", "Doc page 1", "Doc page 5"]);
  const info = e.rotatePages(id, [0], 90);
  assert.deepEqual(info.pageSizes[0], [792, 612], "rotated page reports landscape size");
  e.rotatePages(id, [0], -90);
  assert.deepEqual(e.info(id).pageSizes[0], [612, 792]);
  const after = e.insertBlank(id, 1, 0);
  assert.equal(after.pageCount, 4);
  assert.equal(firstLine(e, id, 1), "");
  // Survives save/reopen
  const re = e.open(e.save(id));
  assert.deepEqual(titles(e, re.id), ["Doc page 3", "", "Doc page 1", "Doc page 5"]);
});

test("combine with bookmarks, insertFrom, extract, split", () => {
  const e = new Engine();
  const a = e.open(makeSamplePdf(3, "A"));
  const b = e.open(makeSamplePdf(2, "B"));
  const merged = e.open(e.combine([{ id: a.id, title: "First" }, { id: b.id, pages: [1], title: "Second" }]));
  assert.deepEqual(titles(e, merged.id), ["A page 1", "A page 2", "A page 3", "B page 2"]);
  assert.deepEqual(merged.outline.map((o) => [o.title, o.page]), [["First", 0], ["Second", 3]]);

  e.insertFrom(a.id, 1, b.id);
  assert.deepEqual(titles(e, a.id), ["A page 1", "B page 1", "B page 2", "A page 2", "A page 3"]);

  const ex = e.open(e.extract(a.id, [4, 0]));
  assert.deepEqual(titles(e, ex.id), ["A page 3", "A page 1"]);

  const parts = e.split(a.id, { every: 2 });
  assert.deepEqual(parts.map((p) => p.suffix), ["p1-2", "p3-4", "p5"]);
  assert.equal(e.open(parts[2].data).pageCount, 1);

  const src = e.open(makeSamplePdf(4, "C")); // fixture has one bookmark per page
  const byBm = e.split(src.id, { bookmarks: true });
  assert.deepEqual(byBm.map((p) => p.suffix), ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"]);
});

test("undo/redo through MuPDF's journal, including nested ops", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(3, "U"));
  e.deletePages(id, [0]); // deletePages -> rearrange (nested) = one step
  e.rotatePages(id, [0], 90);
  assert.equal(e.history(id).steps.length, 2);
  e.undo(id);
  assert.deepEqual(e.info(id).pageSizes[0], [612, 792]);
  e.undo(id);
  assert.equal(e.info(id).pageCount, 3);
  assert.equal(e.undo(id), null);
  e.redo(id);
  assert.equal(e.info(id).pageCount, 2);
});
