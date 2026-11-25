import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLength, formatLength, formatArea, scaleFromRatio, scaleFromCalibration, lengthText, areaText, polygonArea, angleAt, scaleFromMeasure, measureDict, pathLength } from "../src/engine/measure";

test("lengths: parse and format feet-inches and metric", () => {
  assert.equal(parseLength("12'-6\"", "ft-in"), 12.5);
  assert.equal(parseLength("12' 6 1/2\"", "ft-in"), 12 + 6.5 / 12);
  assert.equal(parseLength("150\"", "ft-in"), 12.5);
  assert.equal(parseLength("12.5", "ft-in"), 12.5);
  assert.ok(Math.abs(parseLength("3.2 m", "mm")! - 3200) < 1e-6);
  assert.equal(parseLength("abc", "m"), null);
  assert.equal(formatLength(150.5, "ft-in"), "12'-6 1/2\"");
  assert.equal(formatLength(144, "ft-in"), "12'-0\"");
  assert.equal(formatLength(39.37007874 * 3.25, "m"), "3.25 m");
  assert.equal(formatArea(144 * 100, "ft-in"), "100.00 sq ft");
});

test("scales: presets, calibration, PDF measure dictionaries", () => {
  // 1/4" = 1'-0": 1 inch of paper (72 pt) is 48 real inches. A 720 pt (10 in) line is 40 ft.
  const s = scaleFromRatio(48, "ft-in", '1/4" = 1\'-0"');
  assert.equal(lengthText(720, s), "40'-0\"");
  assert.equal(areaText(72 * 72, s), "16.00 sq ft");
  // Metric 1:100: 10 mm of paper = 1 m.
  const m = scaleFromRatio(100, "m", "1:100");
  assert.equal(lengthText(72 / 25.4 * 10, m), "1.00 m");
  // Calibrate: 360 pt really 25 ft.
  const c = scaleFromCalibration(360, 25, "ft-in");
  assert.equal(lengthText(720, c), "50'-0\"");
  // Round trip through a /Measure dictionary another app would read.
  const d = measureDict(s);
  assert.equal(d.xUnit, "ft");
  const back = scaleFromMeasure({ ratio: d.ratio, xUnit: d.xUnit, xC: d.xC })!;
  assert.ok(Math.abs(back.k - s.k) < 1e-9);
});

test("geometry: area, perimeter, angle", () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(polygonArea(sq), 100);
  assert.equal(pathLength(sq, true), 40);
  assert.equal(Math.round(angleAt([10, 0], [0, 0], [0, 10])), 90);
});
