import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { matchFont } from "../src/engine/edit";
import { makeSamplePdf } from "./fixtures";

// 2x2 PNG: red, green / blue, white
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));

test("font matching", () => {
  assert.equal(matchFont("ABCDEF+TimesNewRomanPS-BoldMT"), "Times-Bold");
  assert.equal(matchFont("Arial-ItalicMT"), "Helvetica-Oblique");
  assert.equal(matchFont("Consolas"), "Courier");
  assert.equal(matchFont("OpenSans-Regular"), "Helvetica");
});

test("read text blocks with style, replace a block, rest untouched, searchable, undo", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  const blocks = e.textBlocks(id, 0);
  assert.deepEqual(blocks.map((b) => b.text), ["Sample page 1", "The quick brown fox jumps over the lazy dog.", "Invoice number QX-1000"]);
  assert.equal(blocks[0].style.size, 24);
  assert.equal(blocks[0].style.font, "Helvetica");

  e.replaceText(id, 0, blocks[2].bbox, "Invoice number QX-2024 (révisé)", blocks[2].style);
  const t = e.pageText(id, 0);
  assert.doesNotMatch(t, /QX-1000/);
  assert.match(t, /Invoice number QX-2024 \(révisé\)/);
  assert.match(t, /quick brown fox/);
  assert.equal(e.search(id, "QX-2024").length, 1);
  const after = e.textBlocks(id, 0).find((b) => b.text.includes("QX-2024"))!;
  assert.ok(Math.abs(after.bbox[0] - blocks[2].bbox[0]) < 1 && Math.abs(after.bbox[1] - blocks[2].bbox[1]) < 3, `kept position: ${after.bbox} vs ${blocks[2].bbox}`);
  assert.equal(after.style.size, 14);

  e.addText(id, 0, [72, 300], "Added line one\nAdded line two", { font: "Times-Bold", size: 12, color: [0, 0, 1] });
  assert.match(e.pageText(id, 0), /Added line one\s+Added line two/);

  e.undo(id);
  e.undo(id);
  assert.match(e.pageText(id, 0), /QX-1000/);
  e.redo(id);
  const re = e.open(e.save(id));
  assert.match(e.pageText(re.id, 0), /QX-2024/);
});

test("wraps long replacement text at the page margin", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  const b = e.textBlocks(id, 0)[1];
  e.replaceText(id, 0, b.bbox, "This sentence is deliberately much longer than the original line so that it must wrap onto more lines.", b.style);
  const nb = e.textBlocks(id, 0).filter((x) => /deliberately|wrap/.test(x.text));
  const right = Math.max(...nb.flatMap((x) => x.lines.map((l) => l.bbox[2])));
  assert.ok(right <= 612 - 36 + 2, `stays within the page margin, got ${right}`);
  assert.ok(nb.flatMap((x) => x.lines).length >= 2, "wrapped onto several lines");
});

test("insert, find, move, replace, extract and delete images", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  e.insertImage(id, 0, [100, 400, 200, 500], PNG);
  let imgs = e.imageBlocks(id, 0);
  assert.equal(imgs.length, 1);
  assert.deepEqual(imgs[0].bbox.map(Math.round), [100, 400, 200, 500]);
  let px = e.render(id, 0, 1);
  const at = (x: number, y: number) => Array.from(px.pixels.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));
  assert.ok(at(125, 425)[0] > 200 && at(125, 425)[1] < 80, "top-left quadrant is red (image upright)");
  assert.ok(at(125, 475)[2] > 200, "bottom-left is blue");

  e.moveImage(id, 0, 0, [300, 600, 350, 650]);
  imgs = e.imageBlocks(id, 0);
  assert.equal(imgs.length, 1);
  assert.deepEqual(imgs[0].bbox.map(Math.round), [300, 600, 350, 650]);
  px = e.render(id, 0, 1);
  const old = Array.from(px.pixels.slice((425 * px.width + 125) * 4, (425 * px.width + 125) * 4 + 4));
  assert.ok(old[3] === 0 || old.slice(0, 3).every((v) => v === 255), `old spot is blank, got ${old}`);

  assert.ok(e.extractImage(id, 0, 0).length > 50);
  e.deleteImage(id, 0, imgs[0].bbox);
  assert.equal(e.imageBlocks(id, 0).length, 0);
  assert.match(e.pageText(id, 0), /quick brown fox/, "text untouched");
});
