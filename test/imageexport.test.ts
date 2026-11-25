import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { rasterPages, encodeTiff, encodeBmp, worldFile } from "../src/engine/imageexport";
import { setPageScale } from "../src/engine/scale";

/** Letter page with a black box (1in square at 1in,1in from top-left) and a red line. */
function drawing() {
  const doc = new mupdf.PDFDocument();
  const cs = "0 0 0 rg 72 648 72 72 re f 1 0 0 RG 4 w 200 400 m 400 400 l S";
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), cs));
  return doc;
}

function png(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset);
  const out: Record<string, number> = { w: dv.getUint32(16), h: dv.getUint32(20), depth: data[24], type: data[25] };
  for (let p = 8; p < data.length; ) {
    const len = dv.getUint32(p), type = String.fromCharCode(...data.subarray(p + 4, p + 8));
    if (type === "pHYs") out.ppm = dv.getUint32(p + 8);
    p += 12 + len;
  }
  return out;
}

test("png: size and dpi are written so the image inserts at paper size", () => {
  const [r] = rasterPages(drawing(), [0], { format: "png", dpi: 200 });
  const info = png(r.data);
  assert.equal(info.w, 1700);
  assert.equal(info.h, 2200);
  assert.equal(Math.round(info.ppm * 0.0254), 200);
  const [j] = rasterPages(drawing(), [0], { format: "jpg", dpi: 150 });
  assert.equal(Math.round(new mupdf.Image(j.data).getXResolution()), 150);
});

test("png: transparent background keeps alpha; trim crops to the drawing", () => {
  const [r] = rasterPages(drawing(), [0], { format: "png", dpi: 100, transparent: true, trim: true });
  const info = png(r.data);
  assert.equal(info.type, 6); // RGBA
  // Content spans x 72..400pt and y 72..394pt (top-left) => about 456 x 447 px at 100 dpi, plus 10px padding.
  assert.ok(Math.abs(r.width - (456 + 20)) <= 3, `w ${r.width}`);
  assert.ok(Math.abs(r.height - (447 + 20)) <= 3, `h ${r.height}`);
  const img = new mupdf.Image(r.data);
  assert.equal(img.getWidth(), r.width);
});

test("tiff and bmp open again with the same size, in colour and black and white", () => {
  for (const colour of ["rgb", "gray", "bw"] as const) {
    for (const format of ["tif", "bmp"] as const) {
      const [r] = rasterPages(drawing(), [0], { format, dpi: 72, colour });
      const img = new mupdf.Image(r.data);
      assert.equal(img.getWidth(), 612, `${format} ${colour}`);
      assert.equal(img.getHeight(), 792);
      assert.equal(Math.round(img.getXResolution()), 72, `${format} ${colour} dpi`);
      const pix = img.toPixmap();
      // The black box's centre is black; the corner is white.
      const at = (x: number, y: number) => pix.getPixels()[y * pix.getStride() + x * pix.getNumberOfComponents()];
      assert.ok(at(108, 108) < 40, `${format} ${colour} box`);
      assert.ok(at(5, 5) > 215, `${format} ${colour} paper`);
      if (colour === "bw" && format === "bmp") assert.equal(r.data[28], 1, "bmp 1-bit");
      if (colour === "bw" && format === "tif") assert.ok(r.data.length < 4000, `tif 1-bit is small: ${r.data.length}`);
    }
  }
  // Transparent TIFF keeps an alpha channel.
  const [t] = rasterPages(drawing(), [0], { format: "tif", dpi: 72, transparent: true });
  assert.ok(new mupdf.Image(t.data).getMask() || new mupdf.Image(t.data).getNumberOfComponents() >= 3);
  assert.ok(encodeTiff({ w: 1, h: 1, n: 1, px: new Uint8Array([0]), dpi: 300 }).length > 0);
  assert.ok(encodeBmp({ w: 3, h: 1, n: 3, px: new Uint8Array(9), dpi: 300 }).length > 54);
});

test("world file places the image at the drawing scale", () => {
  const doc = drawing();
  setPageScale(doc, [0], { k: 96 / 72, unit: "ft-in", label: '1/8" = 1\'-0"' }); // 1/8" = 1'-0": 96 real inches per paper inch
  const [r] = rasterPages(doc, [0], { format: "png", dpi: 96 }, (i) => ({ k: 96 / 72, unit: "ft-in", label: "" }));
  // One pixel = 1/96 in on paper = 1 real inch = 1/12 ft.
  assert.ok(r.real && Math.abs(r.real.perPixel - 1 / 12) < 1e-9);
  assert.equal(r.real!.unit, "ft");
  assert.ok(Math.abs(r.real!.width - 8.5 * 8) < 1e-6); // 8.5in sheet at 1/8" scale = 68 ft
  const lines = r.world!.trim().split(/\r\n/).map(Number);
  assert.equal(lines.length, 6);
  assert.ok(Math.abs(lines[0] - 1 / 12) < 1e-9 && Math.abs(lines[3] + 1 / 12) < 1e-9);
  assert.ok(Math.abs(lines[5] - (1056 - 0.5) / 12) < 1e-6); // top edge at 88 ft
  assert.equal(worldFile(2, 0, 0, 10).split("\r\n")[4], "1");
});
