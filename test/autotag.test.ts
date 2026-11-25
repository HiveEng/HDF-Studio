import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { Engine } from "../src/engine/core";

/** A two-page report: title, headings, paragraphs, a bullet list, a ruled table, an image, a link, running header and page numbers. */
export function makeReport(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const reg = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const bold = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 30], false);
  pix.clear(180);
  const img = doc.addImage(new mupdf.Image(pix));
  const t = (f: string, size: number, x: number, y: number, s: string) => `BT /${f} ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
  const header = (n: number) => [t("F1", 9, 72, 760, "Acme Corp - Annual Report"), t("F1", 9, 300, 30, String(n))].join("\n");
  const p1 = [
    header(1),
    t("F2", 24, 72, 700, "Annual Report 2026"),
    t("F2", 16, 72, 660, "Introduction"),
    "BT /F1 11 Tf 72 635 Td 14 TL (This report describes the year in review for all divisions.) Tj T* (It covers revenue, staffing and the outlook for next year.) Tj ET",
    t("F2", 16, 72, 590, "Highlights"),
    t("F1", 11, 72, 565, "\\225 Revenue grew by twelve percent"),
    t("F1", 11, 72, 549, "\\225 Two new offices opened"),
    t("F1", 11, 72, 533, "\\225 Staff survey score improved"),
    "q 200 0 0 150 72 300 cm /Im1 Do Q",
    t("F1", 11, 72, 280, "Visit our website for more details."),
    "0.5 w 0 0 1 RG 72 278 m 250 278 l S",
  ].join("\n");
  const p2 = [
    header(2),
    t("F2", 13, 72, 700, "Results by region"),
    "0.5 w 72 560 m 372 560 l S 72 590 m 372 590 l S 72 620 m 372 620 l S 72 650 m 372 650 l S",
    "72 560 m 72 650 l S 222 560 m 222 650 l S 372 560 m 372 650 l S",
    t("F2", 11, 80, 630, "Region"), t("F2", 11, 230, 630, "Revenue"),
    t("F1", 11, 80, 600, "North"), t("F1", 11, 230, 600, "4.2 million"),
    t("F1", 11, 80, 570, "South"), t("F1", 11, 230, 570, "3.9 million"),
    t("F1", 11, 72, 520, "Both regions met their targets this year."),
  ].join("\n");
  const res = { Font: { F1: reg, F2: bold }, XObject: { Im1: img } };
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, p1));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, p2));
  const page = doc.loadPage(0) as mupdf.PDFPage;
  page.createLink([72, 500, 250, 516], "https://example.com");
  page.destroy();
  return new Uint8Array(doc.saveToBuffer("").asUint8Array());
}

test("auto-tag: headings, paragraphs, list, table, figure, link; artifacts for headers and lines", () => {
  const e = new Engine();
  const { id } = e.open(makeReport(), "r.pdf");
  const textBefore = [0, 1].map((p) => e.pageText(id, p));
  const pixBefore = [0, 1].map((p) => e.render(id, p, 0.5).pixels);
  assert.equal(e.isTagged(id), false);
  const r = e.autoTag(id, { lang: "en-GB" });
  assert.equal(e.isTagged(id), true);
  assert.deepEqual([0, 1].map((p) => e.pageText(id, p)), textBefore, "text unchanged");
  assert.deepEqual([0, 1].map((p) => e.render(id, p, 0.5).pixels), pixBefore, "pages look the same");

  const roles = e.tagOutline(id).map((x) => x.role);
  assert.deepEqual(roles.slice(0, 4), ["Document", "H1", "H2", "P"], roles.join(" "));
  assert.equal(roles.filter((x) => x === "LI").length, 3);
  assert.equal(roles.filter((x) => x === "L").length, 1);
  assert.equal(roles.filter((x) => x === "Figure").length, 1);
  assert.equal(roles.filter((x) => x === "Link").length, 1);
  assert.equal(roles.filter((x) => x === "Table").length, 1);
  assert.equal(roles.filter((x) => x === "TR").length, 3);
  assert.equal(roles.filter((x) => x === "TH").length, 2);
  assert.equal(roles.filter((x) => x === "TD").length, 4);
  assert.ok(roles.includes("H3"), "smaller heading is H3: " + roles.join(" "));
  assert.ok(!roles.some((x) => x === "P" && false));
  assert.equal(r.tables, 1);
  assert.equal(r.lists, 1);
  assert.ok(r.artifacts >= 4, `artifacts ${r.artifacts}`);

  // Saved file: content streams balanced, every MCID in the parent tree, checker sees it tagged.
  const saved = e.save(id);
  const doc = mupdf.Document.openDocument(saved, "application/pdf") as mupdf.PDFDocument;
  const root = doc.getTrailer().get("Root");
  assert.equal(root.get("Lang").asString(), "en-GB");
  const nums = root.get("StructTreeRoot").get("ParentTree").get("Nums");
  for (let i = 0; i < 2; i++) {
    const pg = doc.findPage(i);
    const src = new TextDecoder("latin1").decode(pg.get("Contents").readStream().asUint8Array());
    const opens = (src.match(/\bBDC\b|\bBMC\b/g) ?? []).length, closes = (src.match(/\bEMC\b/g) ?? []).length;
    assert.equal(opens, closes, "balanced marked content");
    const mcids = [...src.matchAll(/MCID (\d+)/g)].map((m) => +m[1]);
    const arr = nums.get(2 * i + 1);
    for (const m of mcids) assert.ok(arr.get(m).isDictionary(), `MCID ${m} on page ${i} has a parent`);
    // No text outside marked content.
    let depth = 0;
    for (const tok of src.split(/\s+/)) {
      if (tok === "BDC" || tok === "BMC") depth++;
      else if (tok === "EMC") depth--;
      else if (/^(Tj|TJ)$/.test(tok)) assert.ok(depth > 0, "text is marked");
    }
  }
  const title = doc.getMetaData("info:Title");
  assert.equal(title, "Annual Report 2026");
  assert.throws(() => e.autoTag(id), /already tagged/);
  e.autoTag(id, { retag: true });
  assert.equal(e.tagOutline(id).filter((x) => x.role === "H1").length, 1, "re-tag replaces");
  e.undo(id);
  e.undo(id);
  assert.equal(e.isTagged(id), false);
});

test("auto-tag: alt text and decorative images", () => {
  const e = new Engine();
  const { id } = e.open(makeReport(), "r.pdf");
  e.autoTag(id);
  const [fig] = e.figures(id);
  assert.equal(fig.page, 0);
  assert.ok(Math.abs(fig.rect[0] - 72) < 1 && Math.abs(fig.rect[2] - 272) < 1, String(fig.rect));
  e.setFigureAlt(id, fig.key, "Bar chart of revenue by quarter");
  assert.equal(e.figures(id)[0].alt, "Bar chart of revenue by quarter");
  e.setFigureAlt(id, fig.key, null);
  assert.equal(e.figures(id).length, 0);
  const again = e.open(e.save(id), "x.pdf").id;
  assert.equal(e.figures(again).length, 0);
  assert.ok(!e.tagOutline(again).some((x) => x.role === "Figure"));
});
