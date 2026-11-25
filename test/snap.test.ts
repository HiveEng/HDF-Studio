import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { pageSegments } from "../src/engine/snap";
import { SnapIndex } from "../src/engine/snapindex";

test("snap: reads line work and snaps to ends, intersections, midpoints and lines", () => {
  const doc = new mupdf.PDFDocument();
  // A 200x100 box from (100,100) display, plus a diagonal crossing it. PDF y is up: page height 792.
  const cs = "1 w 100 592 200 100 re S 50 642 m 350 542 l S";
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), cs));
  const page = doc.loadPage(0);
  const seg = pageSegments(page);
  page.destroy();
  assert.equal(seg.length / 4, 5);
  const idx = new SnapIndex(seg);
  const near = (h: ReturnType<SnapIndex["snap"]>, x: number, y: number) => !!h && Math.abs(h.pt[0] - x) < 0.01 && Math.abs(h.pt[1] - y) < 0.01;
  // Box corner at display (100, 100).
  let h = idx.snap(103, 98, 8);
  assert.equal(h?.kind, "end");
  assert.ok(near(h, 100, 100));
  // Diagonal from (50,150) to (350,250) crosses the left edge x=100 at y=166.67.
  h = idx.snap(102, 165, 8);
  assert.equal(h?.kind, "intersection");
  assert.ok(near(h, 100, 150 + 100 / 6 * 1));
  // Midpoint of the top edge (200, 100).
  h = idx.snap(203, 103, 8);
  assert.equal(h?.kind, "mid");
  assert.ok(near(h, 200, 100));
  // On the bottom edge y=200, away from special points.
  h = idx.snap(260, 204, 8);
  assert.equal(h?.kind, "line");
  assert.ok(near(h, 260, 200));
  assert.equal(idx.snap(500, 500, 8), null);
});
