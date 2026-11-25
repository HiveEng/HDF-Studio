import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";
import { imageMatrix, xfFromMatrix, dragXf, hitXf, bounds, type Xf } from "../src/engine/xform";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
const near = (a: number[], b: number[], tol = 0.5) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), `${a} vs ${b}`);

test("placement geometry: matrix round trip, rotate, corner resize keeps aspect", () => {
  const t: Xf = { cx: 200, cy: 300, w: 100, h: 40, angle: 30 };
  const back = xfFromMatrix(imageMatrix(t));
  near([back.cx, back.cy, back.w, back.h, back.angle], [200, 300, 100, 40, 30], 1e-6);
  near(imageMatrix({ cx: 50, cy: 20, w: 100, h: 40, angle: 0 }), [100, 0, 0, -40, 0, 40], 1e-9);
  // 90° turns a 100x40 box into a 40x100 footprint
  near(bounds({ ...t, angle: 90 }), [180, 250, 220, 350], 1e-6);
  const r = dragXf({ ...t, angle: 0 }, "rotate", [0, 0], [300, 300]); // pointer to the right of centre
  assert.equal(r.angle, 90);
  // drag bottom-right corner outwards: opposite corner (150,280) stays, aspect kept
  const z = dragXf({ ...t, angle: 0 }, 2, [250, 320], [350, 330]);
  near([z.cx - z.w / 2, z.cy - z.h / 2, z.w / z.h], [150, 280, 2.5], 1e-6);
  assert.equal(hitXf({ ...t, angle: 0 }, [200, 300], 5), "move");
  assert.equal(hitXf({ ...t, angle: 0 }, [250, 320], 5), 2);
});

test("page image: rotate and resize keeps one image, footprint follows", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  e.insertImage(id, 0, [100, 400, 300, 480], PNG);
  const imgs = e.imageBlocks(id, 0);
  assert.equal(imgs.length, 1);
  near([imgs[0].xf.cx, imgs[0].xf.cy, imgs[0].xf.w, imgs[0].xf.h, imgs[0].xf.angle], [200, 440, 200, 80, 0]);
  e.transformImage(id, 0, 0, { ...imgs[0].xf, angle: 90 });
  const after = e.imageBlocks(id, 0);
  assert.equal(after.length, 1);
  near(after[0].bbox, [160, 340, 240, 540]);
  near([after[0].xf.angle], [90]);
});

test("signature stamp: rotate, resize, survives save and reload", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  const key = e.placeImage(id, 0, [300, 600, 450, 650], PNG);
  const a = e.allAnnotations(id).find((x) => x.key === key)!;
  assert.ok(a.xf);
  near([a.xf!.w, a.xf!.h], [150, 50]);
  e.transformImageStamp(id, 0, key, { ...a.xf!, w: 300, h: 100, angle: 90 });
  const b = e.allAnnotations(id).find((x) => x.key === key)!;
  near(b.rect, [325, 475, 425, 775]);
  near([b.xf!.angle, b.xf!.w], [90, 300]);
  const re = new Engine();
  const { id: id2 } = re.open(e.save(id));
  const c = re.allAnnotations(id2).find((x) => x.type === "Stamp")!;
  near(c.rect, [325, 475, 425, 775]);
});
