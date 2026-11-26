import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { addAnnotation } from "../src/engine/annotations";
import { placeImage } from "../src/engine/forms";

/** Ink bounding box of a display-space region, in pixels at 1:1. */
function inkBox(doc: mupdf.PDFDocument, region: number[]) {
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
  const w = pix.getWidth(), st = pix.getStride(), px = pix.getPixels();
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = region[1]; y < region[3]; y++) for (let x = region[0]; x < region[2]; x++) if (x < w && px[y * st + x] < 128) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return { w: x1 - x0, h: y1 - y0 };
}

for (const rot of [0, 90, 180, 270] as const) {
  test(`stamps and signatures read upright on a page rotated ${rot}°`, () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], rot, doc.newDictionary(), ""));
    // A wide review stamp at display (100,100)-(300,160).
    addAnnotation(doc, 0, { type: "ReviewStamp", rect: [100, 100, 300, 160], title: "REVIEWED", name: "Sean", date: "2026-11-26", color: [0, 0, 0] }, "Sean");
    const s = inkBox(doc, [90, 90, 310, 170]);
    assert.ok(s.w > s.h * 2, `stamp ${rot}: ${s.w}x${s.h}`);
    // A wide signature image: black bar 200x40 in a 200x40 PNG.
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 200, 40], false);
    pm.clear(0);
    placeImage(doc, 0, [100, 300, 300, 340], pm.asPNG(), "Signed by Sean");
    const g = inkBox(doc, [90, 290, 310, 350]);
    assert.ok(g.w > g.h * 3, `signature ${rot}: ${g.w}x${g.h}`);
  });
}
