import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";
import { runRecipe, BUILTIN_RECIPES } from "../src/engine/recipes";
import { makeSamplePdf } from "./fixtures";

const e = new Engine();
const text = (data: Uint8Array, p: number) => { const d = e.open(data); const t = e.pageText(d.id, p); e.close(d.id); return t; };

test("stamp page numbers lands at the bottom centre, on rotated pages too", () => {
  const { outputs } = runRecipe(makeSamplePdf(3), "a.pdf", { name: "t", steps: [{ op: "rotate", pages: "2", degrees: 90 }, { op: "stamp", text: "Page {page} of {pages}", position: "bottom-center" }] });
  const d = e.open(outputs[0].data);
  for (const p of [0, 1]) {
    const hit = e.search(d.id, `Page ${p + 1} of 3`)[0];
    assert.ok(hit, `stamp found on page ${p + 1}`);
    const [w, h] = d.pageSizes[p];
    const xs = hit.quads[0].filter((_, i) => i % 2 === 0), ys = hit.quads[0].filter((_, i) => i % 2 === 1);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    assert.ok(Math.abs(cx - w / 2) < 3, `centred horizontally (page ${p + 1}: ${cx} vs ${w / 2})`);
    assert.ok(Math.max(...ys) > h - 45 && Math.max(...ys) <= h, `near the bottom edge (page ${p + 1})`);
  }
});

test("Bates numbers continue across files", () => {
  const r = { name: "b", steps: [{ op: "stamp" as const, text: "{bates}", position: "bottom-right" as const, batesPrefix: "ABC", batesDigits: 5 }] };
  const one = runRecipe(makeSamplePdf(2), "1.pdf", r);
  const two = runRecipe(makeSamplePdf(2), "2.pdf", r, { batesOffset: one.pagesStamped });
  assert.match(text(one.outputs[0].data, 1), /ABC00002/);
  assert.match(text(two.outputs[0].data, 0), /ABC00003/);
});

test("delete, keep, reverse, metadata, split naming", () => {
  const { outputs } = runRecipe(makeSamplePdf(6), "Report.pdf", { name: "x", steps: [{ op: "delete", pages: "1" }, { op: "keep", pages: "1-4" }, { op: "reverse" }, { op: "metadata", title: "Hello" }, { op: "split", every: 2 }] });
  assert.deepEqual(outputs.map((o) => o.name), ["Report - p1-2.pdf", "Report - p3-4.pdf"]);
  assert.match(text(outputs[0].data, 0), /Sample page 5/);
  const d = mupdf.Document.openDocument(outputs[0].data, "pdf");
  assert.equal(d.countPages(), 2);
});

test("protect with passwords, then unprotect", () => {
  const { outputs } = runRecipe(makeSamplePdf(1), "s.pdf", { name: "p", steps: [{ op: "protect", userPassword: "open", ownerPassword: "owner" }] });
  const d = mupdf.Document.openDocument(outputs[0].data, "pdf");
  assert.equal(d.needsPassword(), true);
  assert.ok(d.authenticatePassword("open"));
  assert.throws(() => runRecipe(outputs[0].data, "s.pdf", { name: "n", steps: [{ op: "reverse" }] }), /Password protected/);
  const open = runRecipe(outputs[0].data, "s.pdf", { name: "u", steps: [{ op: "unprotect", password: "owner" }] });
  assert.equal(mupdf.Document.openDocument(open.outputs[0].data, "pdf").needsPassword(), false);
});

test("every built-in recipe runs", () => {
  for (const r of BUILTIN_RECIPES) {
    const { outputs } = runRecipe(makeSamplePdf(3), "f.pdf", r);
    assert.ok(outputs.length >= 1, r.name);
    for (const o of outputs) assert.ok(mupdf.Document.openDocument(o.data, "pdf").countPages() >= 1, r.name);
  }
});

test("two stamps on a page keep their own opacity", () => {
  const { outputs } = runRecipe(makeSamplePdf(1), "a.pdf", { name: "t", steps: [{ op: "stamp", text: "FOOTER", position: "bottom-center" }, { op: "stamp", text: "WM", position: "diagonal", opacity: 0.2 }] });
  const d = mupdf.Document.openDocument(outputs[0].data, "pdf").asPDF()!;
  const gs = d.findPage(0).get("Resources").get("ExtGState");
  const vals: number[] = [];
  gs.forEach((v) => vals.push(+v.get("ca").asNumber().toFixed(3)));
  assert.deepEqual(vals.sort(), [0.2, 1]);
});
