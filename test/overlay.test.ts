import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { overlayPdf, sideBySidePdf } from "../src/engine/overlay";

const mk = (extra: string, shift = 0) => {
  const d = new mupdf.PDFDocument();
  const cs = `q 1 0 0 1 ${shift} ${-shift} cm 4 w 72 600 m 500 600 l S ${extra} Q`;
  d.insertPage(-1, d.addPage([0, 0, 612, 792], 0, d.newDictionary(), cs));
  return d;
};
const pixel = (data: Uint8Array, x: number, y: number) => {
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const n = pix.getNumberOfComponents(), w = pix.getWidth();
  const px = pix.getPixels();
  return Array.from(px.slice((y * w + x) * n, (y * w + x) * n + 3));
};

test("overlay: removed ink red, added ink blue, unchanged dark; auto-align finds the shift", () => {
  const old = mk("4 w 400 300 m 500 300 l S");
  const nu = mk("4 w 100 200 m 200 200 l S");
  const { data } = overlayPdf(old, nu, { align: "corner" });
  const [r1, g1, b1] = pixel(data, 450, 792 - 300); // only in old
  assert.ok(r1 > 180 && g1 < 80 && b1 < 80, `red ${[r1, g1, b1]}`);
  const [r2, , b2] = pixel(data, 150, 792 - 200); // only in new
  assert.ok(b2 > 180 && r2 < 80, `blue ${[r2, b2]}`);
  const [r3, g3, b3] = pixel(data, 300, 792 - 600); // in both
  assert.ok(r3 < 90 && g3 < 90 && b3 < 90, `dark ${[r3, g3, b3]}`);
  const shifted = overlayPdf(mk(""), mk("", 9), { align: "auto" });
  assert.ok(Math.abs(shifted.shifts[0][0] - 9) < 1.5 && Math.abs(shifted.shifts[0][1] - 9) < 1.5, `${shifted.shifts[0]}`);
});

test("side by side: one wide sheet per page pair", () => {
  const data = sideBySidePdf(mk(""), mk(""), { oldName: "a.pdf", newName: "b.pdf" });
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  assert.equal(doc.countPages(), 1);
  const [, , w, h] = doc.loadPage(0).getBounds();
  assert.ok(w > 1224 && h > 792);
  assert.match(doc.loadPage(0).toStructuredText("").asText(), /OLD: a\.pdf[\s\S]*NEW: b\.pdf/);
});
