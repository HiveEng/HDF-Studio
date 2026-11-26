// Fixes from testing 0.1.25 on a CAD drawing.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { addAnnotation, listAnnotations, updateAnnotation, transformTextBox } from "../src/engine/annotations";
import { findAndMark, applyRedactions } from "../src/engine/redact";
import { formatLength, formatArea } from "../src/engine/measure";
import { dragXf, hitXf } from "../src/engine/xform";
import { renderArea } from "../src/engine/imageexport";

const close = (a: number[], b: number[], tol = 1.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
function page(mb: number[], rot: number) {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage(mb as mupdf.Rect, rot as 0, doc.newDictionary(), ""));
  return doc;
}
/** Is there red ink near a display-space point? */
function redNear(doc: mupdf.PDFDocument, p: number[], r = 6) {
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const st = pix.getStride(), px = pix.getPixels();
  for (let y = Math.max(0, p[1] - r); y < p[1] + r; y++) for (let x = Math.max(0, p[0] - r); x < p[0] + r; x++) {
    const i = y * st + x * 3;
    if (px[i] > 150 && px[i + 1] < 100 && px[i + 2] < 100) return true;
  }
  return false;
}

for (const [mb, rot] of [[[0, 0, 612, 792], 0], [[100, 200, 712, 992], 90], [[-300, -400, 312, 392], 270], [[36, 36, 1260, 828], 0]] as const) {
  test(`callout leader meets the arrow tip on a page with MediaBox ${mb} rotated ${rot}°`, () => {
    const doc = page([...mb], rot);
    const key = addAnnotation(doc, 0, { type: "Callout", target: [100, 100], rect: [250, 200, 400, 240], contents: "WHO IS THIS", fontSize: 12, color: [1, 0, 0] }, "S");
    const a = listAnnotations(doc, 0).find((x) => x.key === key)!;
    assert.ok(close(a.callout![0], [100, 100]), `tip ${a.callout![0]}`);
    assert.ok(redNear(doc, [103, 103]), "leader drawn at the tip");
    assert.ok(redNear(doc, [160, 155]), "leader drawn between tip and box");
  });
}

test("a plain text box isn't mistaken for a callout, and can be resized and turned", () => {
  const doc = page([50, 60, 450, 460], 90);
  const key = addAnnotation(doc, 0, { type: "FreeText", rect: [100, 100, 260, 130], contents: "Misty Cove Lane", fontSize: 12, color: [1, 0, 0], width: 1 }, "S");
  let a = listAnnotations(doc, 0)[0];
  assert.equal(a.callout, undefined);
  assert.ok(a.xf && a.xf.angle === 0);
  transformTextBox(doc, 0, key, { cx: 200, cy: 200, w: 120, h: 40, angle: 30 });
  a = listAnnotations(doc, 0)[0];
  assert.deepEqual(a.xf, { cx: 200, cy: 200, w: 120, h: 40, angle: 30 });
  assert.ok(a.rect[3] - a.rect[1] > 60, `turned bounds ${a.rect}`);
  // Restyling keeps the turn; moving the box keeps it too.
  updateAnnotation(doc, 0, key, { fontSize: 14 });
  updateAnnotation(doc, 0, key, { box: [150, 150, 270, 190] });
  a = listAnnotations(doc, 0)[0];
  assert.equal(a.xf!.angle, 30);
  assert.ok(close([a.xf!.cx, a.xf!.cy], [210, 170]));
  assert.ok(redNear(doc, [210, 170], 25), "text drawn");
});

test("grips: side handles change one dimension; corners can resize freely", () => {
  const t = { cx: 100, cy: 100, w: 80, h: 20, angle: 0 };
  assert.equal(hitXf(t, [140, 100], 5, true), 5);
  assert.equal(hitXf(t, [140, 100], 5), "move");
  const r = dragXf(t, 5, [140, 100], [180, 130]);
  assert.deepEqual([r.w, r.h, r.cx, r.cy], [120, 20, 120, 100]);
  const c = dragXf(t, 2, [140, 110], [160, 150], true);
  assert.deepEqual([c.w, c.h], [100, 60]);
});

test("measurement precision and label size can be changed after placing", () => {
  assert.equal(formatLength(150.37, "ft-in", 0), "12'-6\"");
  assert.equal(formatLength(150.5, "ft-in", 2), "12'-6 1/2\"");
  assert.equal(formatLength(39.37007874 * 12.3456, "m", 3), "12.346 m");
  assert.equal(formatArea(144 * 10.5, "ft", 0), "11 sq ft"); // 10.5 rounds to even-ish per toFixed
  const doc = page([0, 0, 612, 792], 0);
  const meas = { kind: "len" as const, value: 100, k: 39.37007874 / 72, unit: "m" }; // 1 pt = 1/72 m
  const key = addAnnotation(doc, 0, { type: "Line", a: [100, 100], b: [200, 100], dimension: true, caption: "1.39 m", captionSize: 10, color: [1, 0, 0], contents: "Length: 1.39 m", meas }, "S");
  let a = listAnnotations(doc, 0)[0];
  assert.equal(a.label!.size, 10);
  updateAnnotation(doc, 0, key, { labelSize: 16, precision: 4 });
  a = listAnnotations(doc, 0)[0];
  assert.equal(a.label!.size, 16);
  assert.equal(a.label!.meas!.prec, 4);
  assert.equal(a.contents, "Length: 1.3889 m");
  updateAnnotation(doc, 0, key, { precision: null });
  assert.equal(listAnnotations(doc, 0)[0].contents, "Length: 1.39 m");
});

test("find and redact also finds AutoCAD SHX text kept as comments, and removes those comments", () => {
  const doc = page([0, 0, 612, 792], 0);
  const pg = doc.loadPage(0) as mupdf.PDFPage;
  const c = pg.createAnnotation("Square");
  c.setRect([300, 700, 400, 720]);
  c.setContents("Tentative Subdivision Plan");
  c.getObject().put("T", doc.newString("AutoCAD SHX Text"));
  c.update();
  const r = findAndMark(doc, { text: "PLAN" });
  assert.equal(r.count, 1);
  assert.deepEqual(r.textless, [0]);
  const mark = listAnnotations(doc, 0).find((x) => x.type === "Redact")!;
  assert.ok(mark.rect[0] > 370 && mark.rect[2] <= 401, `mark over the end of the words ${mark.rect}`);
  applyRedactions(doc);
  assert.equal(listAnnotations(doc, 0).filter((x) => x.contents.includes("Plan")).length, 0);
});

test("an area of a page saves as a PNG at 300 dpi", () => {
  const doc = page([0, 0, 612, 792], 0);
  addAnnotation(doc, 0, { type: "Square", rect: [100, 100, 200, 200], color: [1, 0, 0] }, "S");
  const png = renderArea(doc.loadPage(0), [90, 90, 210, 150], 300);
  const img = new mupdf.Image(png);
  assert.equal(img.getWidth(), 500);
  assert.equal(img.getHeight(), 250);
});

test("a leader added to a callout on a CAD sheet starts at the callout's box", async () => {
  const { addLeader } = await import("../src/engine/annotations");
  const doc = page([100, 200, 712, 992], 90);
  const key = addAnnotation(doc, 0, { type: "Callout", target: [100, 100], rect: [400, 300, 500, 330], contents: "yuppers", fontSize: 12, color: [1, 0, 0] }, "S");
  const lk = addLeader(doc, 0, key, [300, 500], "S");
  const ln = doc.loadPage(0).getAnnotations().find((a) => a.getObject().asIndirect() === lk)!;
  const [a] = ln.getLine();
  assert.ok(close(a, [400, 315], 2), `leader starts at the box edge facing the tip, got ${a}`);
});

test("text alignment on text boxes and callouts", () => {
  const doc = page([0, 0, 612, 792], 0);
  const k = addAnnotation(doc, 0, { type: "FreeText", rect: [100, 100, 300, 130], contents: "Centred", align: 1 }, "S");
  assert.equal(listAnnotations(doc, 0)[0].align, 1);
  updateAnnotation(doc, 0, k, { align: 2 });
  assert.equal(listAnnotations(doc, 0)[0].align, 2);
});

test("imperial fractions in labels are stacked", async () => {
  const { labelRuns } = await import("../src/engine/annotations");
  const r = labelRuns(`9'-7 15/16"`, 10);
  assert.deepEqual(r.map((x) => (x.kind === "t" ? x.s : `${x.n}|${x.d}`)), ["9'-7", "15|16", '"']);
  assert.deepEqual(labelRuns("12.35 m", 10).map((x) => x.kind), ["t"]);
});
