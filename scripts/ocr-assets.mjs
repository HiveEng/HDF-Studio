// Copy Tesseract's worker, engine and English language data into public/ocr so OCR works offline.
import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const out = "public/ocr";
const files = [
  [join(dirname(require.resolve("tesseract.js/package.json")), "dist/worker.min.js"), "worker.min.js"],
  ...["", "simd-", "relaxedsimd-"].map((v) => [join(dirname(require.resolve("tesseract.js-core/package.json")), `tesseract-core-${v}lstm.wasm.js`), `tesseract-core-${v}lstm.wasm.js`]),
  [join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int/eng.traineddata.gz"), "lang/eng.traineddata.gz"],
];
for (const [from, to] of files) {
  const dest = join(out, to);
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest) || statSync(dest).size !== statSync(from).size) copyFileSync(from, dest);
}
console.log(`OCR assets ready in ${out}`);
