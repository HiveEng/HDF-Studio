import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";
import { gsPdfa } from "../cli/hdfstudio";

const hasGs = (() => {
  try {
    execFileSync(process.env.GS ?? "gs", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("check: finds missing title, language, fonts, PDF/A marking; quick fixes clear them", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(2));
  const r = e.checkDocument(id);
  const ids = r.issues.map((i) => i.id);
  for (const k of ["pdfa-claim", "pdfa-intent", "pdfa-fonts", "ua-tags", "ua-title", "ua-lang", "ua-display-title"]) assert.ok(ids.includes(k), `${k} in ${ids}`);
  assert.equal(r.passes["PDF/A"], false);
  assert.equal(r.passes.Security, true);
  e.applyFixes(id, { title: "Quarterly report", lang: "en-CA", displayTitle: true, tabs: true });
  const after = e.checkDocument(id).issues.map((i) => i.id);
  for (const k of ["ua-title", "ua-lang", "ua-display-title"]) assert.ok(!after.includes(k), `${k} fixed`);
  const saved = e.open(e.save(id));
  assert.ok(!e.checkDocument(saved.id).issues.some((i) => i.id === "ua-lang"), "survives saving");
  e.undo(id);
  assert.ok(e.checkDocument(id).issues.some((i) => i.id === "ua-title"), "one undo step");
});

test("PDF/A conversion: Ghostscript + output intent passes the PDF/A checks and keeps title and language", { skip: !hasGs && "Ghostscript not installed" }, () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(2));
  e.applyFixes(id, { title: "Archive me", lang: "fr-CA", displayTitle: true });
  const out = e.finishPdfa(gsPdfa(e.save(id)), id);
  const d = e.open(out);
  const r = e.checkDocument(d.id);
  assert.equal(r.pdfaClaim, "2B");
  assert.ok(r.passes["PDF/A"], JSON.stringify(r.issues.filter((i) => i.area === "PDF/A")));
  assert.ok(!r.issues.some((i) => i.id === "ua-lang" || i.id === "ua-title" || i.id === "ua-display-title"), JSON.stringify(r.issues.map((i) => i.id)));
  assert.match(e.pageText(d.id, 0), /lazy dog/);
});
