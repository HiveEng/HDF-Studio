import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { addAnnotation, listAnnotations, updateAnnotation, calloutGeometry } from "../src/engine/annotations";

const close = (a: number[], b: number[], tol = 1.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

for (const rot of [0, 90] as const) {
  test(`callout on a ${rot}° page: box, leader and style read back and can be edited`, () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], rot, doc.newDictionary(), ""));
    const key = addAnnotation(doc, 0, { type: "Callout", target: [100, 100], rect: [250, 200, 400, 240], contents: "Check weld", fontSize: 12, color: [1, 0, 0], fill: [1, 1, 0.6], width: 2 }, "S");
    let a = listAnnotations(doc, 0).find((x) => x.key === key)!;
    assert.ok(close(a.box!, [250, 200, 400, 240]), `box ${a.box}`);
    assert.ok(close(a.callout![0], [100, 100]), `tip ${a.callout![0]}`);
    assert.ok(close(a.callout![2], [250, 220]), `end ${a.callout![2]}`);
    assert.equal(a.fontSize, 12);
    assert.ok(close(a.fill!, [1, 1, 0.6], 0.01));
    assert.equal(a.borderWidth, 2);
    // Move the box to the left of the tip and drag the tip; the leader re-routes to the box's right side.
    updateAnnotation(doc, 0, key, { box: [20, 300, 120, 330], target: [200, 320] });
    a = listAnnotations(doc, 0).find((x) => x.key === key)!;
    assert.ok(close(a.box!, [20, 300, 120, 330]), `moved box ${a.box}`);
    assert.ok(close(a.callout![0], [200, 320]) && close(a.callout![2], [120, 315]), `rerouted ${JSON.stringify(a.callout)}`);
    // Restyle: see-through, bigger text, blue.
    updateAnnotation(doc, 0, key, { fill: null, fontSize: 16, color: [0, 0, 1] });
    a = listAnnotations(doc, 0).find((x) => x.key === key)!;
    assert.equal(a.fill, null);
    assert.equal(a.fontSize, 16);
    assert.ok(close(a.textColor!, [0, 0, 1], 0.01));
    assert.ok(close(a.box!, [20, 300, 120, 330]), `box kept ${a.box}`);
    // The leader is drawn: blue pixels near the tip.
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    const st = pix.getStride(), px = pix.getPixels();
    let blue = false;
    for (let y = 312; y < 328; y++) for (let x = 185; x < 200; x++) { const i = y * st + x * 3; if (px[i + 2] > 150 && px[i] < 100) blue = true; }
    assert.ok(blue, "leader drawn near the tip");
  });
}

test("callout geometry meets the nearest side", () => {
  assert.deepEqual(calloutGeometry([100, 100, 200, 140], [300, 120])[2], [200, 120]);
  assert.deepEqual(calloutGeometry([100, 100, 200, 140], [150, 20])[2], [150, 100]);
});
