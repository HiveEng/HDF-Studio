import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Engine } from "../src/engine/core";
import { createRecognizer } from "../src/ocr/recognize";
import { ocrBytes } from "../src/ocr/pipeline";
import { makeSamplePdf } from "./fixtures";

const langPath = join(dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");

/** An image-only copy of a page: what a scanner produces. */
function scanOf(e: Engine, pdf: Uint8Array, dpi = 150) {
  const src = e.open(pdf);
  const { png } = e.ocrImage(src.id, 0, dpi);
  e.close(src.id);
  return e.toPdf([{ name: "scan.png", data: png }]);
}

test("text layer: invisible, searchable, positioned where told, one undo step", () => {
  const e = new Engine();
  const { id } = e.open(e.blankPdf(1));
  assert.deepEqual(e.pagesWithoutText(id), [0]);
  const before = e.render(id, 0, 1).pixels;
  const n = e.addTextLayer(id, [{ page: 0, lines: [{ baseline: 100, size: 20, words: [{ text: "Hello", x0: 72, x1: 140 }, { text: "wörld", x0: 150, x1: 210 }] }] }]);
  assert.equal(n, 2);
  assert.match(e.pageText(id, 0), /Hello wörld/);
  assert.deepEqual(e.pagesWithoutText(id), [], "a page with an OCR layer counts as having text");
  assert.deepEqual(e.render(id, 0, 1).pixels, before, "nothing visible was drawn");
  const [hit] = e.search(id, "wörld");
  assert.ok(Math.abs(hit.quads[0][0] - 150) < 2 && Math.abs(hit.quads[0][2] - 210) < 3, `word stretched to its box: ${hit.quads[0]}`);
  e.undo(id);
  assert.deepEqual(e.pagesWithoutText(id), [0]);
});

test("OCR a scan with Tesseract, then redaction removes the pixels too", async () => {
  const e = new Engine();
  const rec = await createRecognizer("eng", { langPath, cacheMethod: "none", gzip: true });
  try {
    const scan = scanOf(e, makeSamplePdf(1));
    const r = await ocrBytes(e, rec, scan, "scan.pdf");
    assert.equal(r.pages, 1);
    assert.ok(r.words >= 12, `words: ${r.words}`);
    const d = e.open(r.data);
    const text = e.pageText(d.id, 0);
    assert.match(text, /quick brown fox/);
    assert.match(text, /QX-1000/);
    // Already-searchable files are left alone.
    assert.equal((await ocrBytes(e, rec, r.data, "again.pdf")).pages, 0);

    const [hit] = e.search(d.id, "QX-1000");
    const q = hit.quads[0];
    const box = [q[0], q[1], q[6], q[7]];
    const dark = (id: number) => {
      const pg = e.render(id, 0, 1);
      let n = 0;
      for (let y = Math.ceil(box[1]) + 2; y < box[3] - 2; y++)
        for (let x = Math.ceil(box[0]) + 2; x < box[2] - 2; x++) {
          const i = (y * pg.width + x) * 4;
          if (pg.pixels[i] < 128) n++;
        }
      return n / ((box[2] - box[0] - 4) * (box[3] - box[1] - 4));
    };
    const inkBefore = dark(d.id);
    assert.ok(inkBefore > 0.05 && inkBefore < 0.7, `visible text under the word: ${inkBefore}`);
    e.markRedactions(d.id, { text: "QX-1000" });
    e.applyRedactions(d.id);
    assert.doesNotMatch(e.pageText(d.id, 0), /QX-1000/);
    assert.ok(dark(d.id) > 0.95, "the scanned image under the word is blacked out, not just the hidden text");
  } finally {
    await rec.terminate();
  }
});
