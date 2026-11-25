import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { estimateSkew, rotateImage, findSpecks, inkCoverage, BLANK_COVERAGE, cleanScans } from "../src/engine/scanclean";

/** A fake page of "text": rows of dark word-like bars, at 100 dpi (850 x 1100). */
function textPage(w = 850, h = 1100, specks: [number, number][] = []) {
  const g = new Uint8Array(w * h).fill(245);
  for (let y = 120; y < h - 120; y += 30) {
    for (let x = 100; x < w - 100; ) {
      const len = 20 + ((x * 7 + y) % 60);
      for (let yy = y; yy < y + 12; yy++) for (let xx = x; xx < Math.min(x + len, w - 100); xx++) g[yy * w + xx] = 20;
      x += len + 10;
    }
  }
  for (const [x, y] of specks) for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) g[yy * w + xx] = 10;
  return g;
}

test("straighten: finds the tilt and rotating by it levels the page", () => {
  const w = 850, h = 1100;
  const flat = textPage(w, h);
  assert.equal(estimateSkew(flat, w, h), 0);
  const tilted = rotateImage(flat, w, h, 1, 2.5); // clockwise, downhill to the right
  const skew = estimateSkew(tilted, w, h);
  assert.ok(Math.abs(skew - 2.5) < 0.15, `skew ${skew}`);
  const back = rotateImage(tilted, w, h, 1, -skew);
  assert.ok(Math.abs(estimateSkew(back, w, h)) < 0.15);
  const ccw = estimateSkew(rotateImage(flat, w, h, 1, -1.2), w, h);
  assert.ok(Math.abs(ccw + 1.2) < 0.15, `ccw ${ccw}`);
});

test("despeckle: removes lone dots but keeps dots next to text", () => {
  const w = 850, h = 1100;
  // One speck in the empty margin, one right after a word (like a full stop).
  const g = textPage(w, h, [[40, 500], [0, 0]]);
  for (let yy = 128; yy < 130; yy++) for (let xx = 162; xx < 164; xx++) g[yy * w + xx] = 10; // 2px after a word
  const found = new Set(findSpecks(g, w, h, { maxArea: 20, clearance: 5 }));
  assert.ok(found.has(500 * w + 40), "margin speck found");
  assert.ok(found.has(0), "corner speck found");
  assert.ok(!found.has(128 * w + 162), "full stop kept");
  assert.equal(found.size, 8);
});

test("blank detection: blank with dust is blank, a page with one short line is not", () => {
  const w = 850, h = 1100;
  const blank = new Uint8Array(w * h).fill(235);
  for (let i = 0; i < 40; i++) blank[(200 + i * 20) * w + 100 + i * 15] = 0; // dust
  assert.ok(inkCoverage(blank, w, h, 6) < BLANK_COVERAGE);
  const line = new Uint8Array(w * h).fill(235);
  for (let x = 100; x < 400; x += 12) for (let yy = 500; yy < 510; yy++) for (let xx = x; xx < x + 6; xx++) line[yy * w + xx] = 0;
  assert.ok(inkCoverage(line, w, h, 6) > BLANK_COVERAGE);
});

test("cleanScans: straightens a tilted scan, removes the blank page, skips pages with text", () => {
  const w = 850, h = 1100;
  const tilted = rotateImage(textPage(w, h, [[60, 1000]]), w, h, 1, 2);
  const pdf = new mupdf.PDFDocument();
  const addImagePage = (gray: Uint8Array) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
    const dst = pix.getPixels();
    for (let y = 0; y < h; y++) dst.set(gray.subarray(y * w, (y + 1) * w), y * pix.getStride());
    const img = new mupdf.Image(pix);
    const res = pdf.newDictionary(), xo = pdf.newDictionary();
    xo.put("Im", pdf.addImage(img));
    res.put("XObject", xo);
    pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, "q 612 0 0 792 0 0 cm /Im Do Q"));
  };
  addImagePage(tilted);
  addImagePage(new Uint8Array(w * h).fill(240));
  const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = pdf.newDictionary(), fd = pdf.newDictionary();
  fd.put("F1", font);
  res.put("Font", fd);
  pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, "BT /F1 12 Tf 72 700 Td (A real text page, not a scan.) Tj ET"));

  const rep = cleanScans(pdf, [0, 1, 2], { straighten: true, despeckle: true, removeBlank: true });
  assert.deepEqual(rep.removed, [1]);
  assert.deepEqual(rep.skipped, [2]);
  assert.equal(rep.straightened.length, 1);
  assert.ok(Math.abs(rep.straightened[0].degrees - 2) < 0.2, `deg ${rep.straightened[0].degrees}`);
  assert.deepEqual(rep.despeckled, [0]);
  assert.equal(pdf.countPages(), 2);
  // The cleaned page renders level.
  const page = pdf.loadPage(0);
  assert.deepEqual(page.getBounds().map(Math.round), [0, 0, 612, 792]);
  const pix = page.toPixmap(mupdf.Matrix.scale(100 / 72, 100 / 72), mupdf.ColorSpace.DeviceGray, false, true);
  const pw = pix.getWidth(), ph = pix.getHeight(), stride = pix.getStride(), raw = pix.getPixels();
  const g = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) g.set(raw.subarray(y * stride, y * stride + pw), y * pw);
  assert.ok(Math.abs(estimateSkew(g, pw, ph)) < 0.2);
});
