import { test } from "node:test";
import assert from "node:assert/strict";
import { inkMask } from "../src/ui/signature";

test("signature photo: paper becomes transparent under uneven light, ink stays solid", () => {
  const w = 400, h = 200;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      // Paper lit from the left: 235 down to 120 (a shadow), with a blue pen stroke across the middle.
      const paper = 235 - (115 * x) / w + ((x * 7 + y * 13) % 9) - 4;
      const ink = Math.abs(y - (100 + 30 * Math.sin(x / 20))) < 4;
      const v = ink ? paper * 0.3 : paper;
      d[k] = v * (ink ? 0.6 : 1);
      d[k + 1] = v * (ink ? 0.7 : 0.98);
      d[k + 2] = v;
      d[k + 3] = 255;
    }
  inkMask(d, w, h);
  const alpha = (x: number, y: number) => d[(y * w + x) * 4 + 3];
  let paperOpaque = 0, inkClear = 0, paperN = 0, inkN = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ink = Math.abs(y - (100 + 30 * Math.sin(x / 20))) < 2;
      const far = Math.abs(y - (100 + 30 * Math.sin(x / 20))) > 10;
      if (ink) (inkN++, alpha(x, y) < 200 && inkClear++);
      if (far) (paperN++, alpha(x, y) > 30 && paperOpaque++);
    }
  assert.ok(paperOpaque / paperN < 0.005, `paper left visible: ${paperOpaque}/${paperN}`);
  assert.ok(inkClear / inkN < 0.02, `ink lost: ${inkClear}/${inkN}`);
});

test("signature image that is already a transparent cut-out is left alone", () => {
  const w = 50, h = 50;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = i % 3 ? 0 : 255;
  const before = d.slice();
  inkMask(d, w, h);
  assert.deepEqual(d, before);
});
