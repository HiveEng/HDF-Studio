import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";
import { diff, slideApart } from "../src/engine/compare";

/** Pages of text lines, plus optional extra drawing per page (to test the visual diff). */
function makeDoc(pages: string[][], drawing: Record<number, string> = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  pages.forEach((lines, i) => {
    const body = lines.map((t, j) => `BT /F1 14 Tf 72 ${720 - j * 30} Td (${t}) Tj ET`).join("\n") + "\n" + (drawing[i] ?? "");
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { Font: { F1: font } }, body));
  });
  return new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
}

test("diff: reconstructs the new sequence and finds a minimal edit", () => {
  const rnd = (n: number, seed: number) => Array.from({ length: n }, (_, i) => "abcde"[(i * 7 + seed * 13 + ((i * seed) % 5)) % 5]);
  for (let s = 1; s < 30; s++) {
    const a = rnd(20 + s, s), b = rnd(18 + (s % 7), s + 3);
    const ops = slideApart(diff(a, b)!, a, b);
    assert.deepEqual(ops.filter((o) => o.op !== "-").map((o) => b[o.b]), b);
    assert.deepEqual(ops.filter((o) => o.op !== "+").map((o) => a[o.a]), a);
    for (const o of ops) if (o.op === "=") assert.equal(a[o.a], b[o.b]);
  }
  assert.equal(diff(["x", "y", "z"], ["x", "q", "z"])!.filter((o) => o.op !== "=").length, 2);
  assert.equal(diff(Array(3000).fill("a"), Array(3000).fill("b"), 100), null, "gives up past maxD");
});

test("compare: inserted, deleted, replaced words and a changed drawing; report has one comment per change", () => {
  const e = new Engine();
  const oldPdf = makeDoc([
    ["Payment is due within 30 days.", "The supplier will deliver weekly.", "This clause is removed entirely."],
    ["Second page text stays the same."],
  ]);
  const newPdf = makeDoc(
    [
      ["Payment is due within 45 days.", "The supplier will deliver weekly and on demand.", ""],
      ["Second page text stays the same."],
    ],
    { 1: "0 0 1 rg 400 100 80 60 re f" },
  );
  const a = e.open(oldPdf, "v1.pdf"), b = e.open(newPdf, "v2.pdf");
  const r = e.compare(a.id, b.id);
  const kinds = r.changes.map((c) => `${c.kind}:${c.oldText}|${c.newText}`);
  assert.ok(kinds.includes("replaced:30|45"), kinds.join("\n"));
  assert.ok(kinds.includes("inserted:|and on demand"), kinds.join("\n"));
  assert.ok(kinds.includes("deleted:This clause is removed entirely.|"), kinds.join("\n"));
  const vis = r.changes.filter((c) => c.kind === "visual");
  assert.equal(vis.length, 1, "the new blue box on page 2");
  assert.equal(vis[0].newPage, 1);
  const [x0, y0, x1, y1] = vis[0].rect!;
  assert.ok(x0 <= 400 && x1 >= 480 && y0 <= 792 - 160 && y1 >= 792 - 100, `box ${vis[0].rect}`);
  assert.equal(r.summary.visual, 1);

  const rep = e.compareReport(a.id, b.id, "v1.pdf");
  const d = e.open(rep.data, "report.pdf");
  const notes = e.allAnnotations(d.id);
  assert.equal(notes.length, rep.result.changes.length);
  assert.ok(notes.every((n) => n.author === "Compare"));
  assert.ok(notes.some((n) => n.type === "Text" && /Deleted.*removed entirely/.test(n.contents)));
  assert.ok(notes.some((n) => n.type === "Highlight" && /Was: "30"/.test(n.contents)));

  // Identical files: nothing to report.
  const c = e.open(oldPdf, "copy.pdf");
  assert.equal(e.compare(a.id, c.id).changes.length, 0);
});

test("compare: text that moves to the next page is not reported as changed", () => {
  const e = new Engine();
  const oldPdf = makeDoc([["Alpha beta gamma.", "Delta epsilon."], ["Zeta eta theta."]]);
  const newPdf = makeDoc([["Alpha beta gamma."], ["Delta epsilon.", "Zeta eta theta."]]);
  const r = e.compare(e.open(oldPdf).id, e.open(newPdf).id, { visual: false });
  assert.equal(r.changes.length, 0, JSON.stringify(r.changes));
});
