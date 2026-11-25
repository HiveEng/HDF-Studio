// Snapping for measurements: the line work of a drawing from the PDF's vector paths.
import * as mupdf from "mupdf";

const MAX_SEGMENTS = 400_000;

/** Every straight piece of line work on the page, in display space: [x1, y1, x2, y2, ...]. Curves keep their end points. */
export function pageSegments(page: mupdf.Page): Float32Array {
  const out: number[] = [];
  const add = (path: mupdf.Path, m: mupdf.Matrix) => {
    if (out.length >= MAX_SEGMENTS * 4) return;
    const tx = (x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    let start: [number, number] | null = null;
    let cur: [number, number] | null = null;
    const seg = (a: [number, number], b: [number, number]) => {
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.05) out.push(a[0], a[1], b[0], b[1]);
    };
    path.walk({
      moveTo(x, y) {
        cur = start = tx(x, y);
      },
      lineTo(x, y) {
        const p = tx(x, y);
        if (cur) seg(cur, p);
        cur = p;
      },
      curveTo(_a, _b, _c, _d, x, y) {
        const p = tx(x, y);
        if (cur) seg(cur, p);
        cur = p;
      },
      closePath() {
        if (cur && start) seg(cur, start);
        cur = start;
      },
    });
  };
  const dev = new mupdf.Device({
    fillPath: (path, _eo, ctm) => add(path, ctm),
    strokePath: (path, _s, ctm) => add(path, ctm),
  });
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  return new Float32Array(out);
}
