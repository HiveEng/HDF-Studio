import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { unzipSync, strFromU8 } from "fflate";
import { toXlsx, toPptx, pageTable, cellValue } from "../src/engine/officeexport";

function schedule(ruled: boolean) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.newDictionary();
  const fd = doc.newDictionary();
  fd.put("F1", font);
  res.put("Font", fd);
  // Door schedule: 3 columns x 4 rows at x = 72, 172, 322; rows every 20pt from y=700 (PDF space).
  const rows = [["MARK", "SIZE", "COST"], ["D1", "3'-0\" x 7'-0\"", "$1,250.00"], ["D2", "2'-8\" x 7'-0\"", "980"], ["D3", "6'-0\" x 7'-0\"", "(15)"]];
  let cs = "BT /F1 10 Tf ET ";
  rows.forEach((r, i) => r.forEach((t, j) => (cs += `BT /F1 10 Tf ${[76, 176, 326][j]} ${706 - i * 20} Td (${t.replace(/[()\\]/g, "\\$&")}) Tj ET `)));
  if (ruled) {
    for (const x of [72, 172, 322, 422]) cs += `${x} 620 m ${x} 720 l S `;
    for (let i = 0; i <= 5; i++) cs += `72 ${720 - i * 20} m 422 ${720 - i * 20} l S `;
  }
  cs += "BT /F1 12 Tf 72 760 Td (Door Schedule - Level 2) Tj ET";
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, cs));
  return doc;
}

test("excel: ruled and unruled tables come out as cells with numbers", () => {
  assert.equal(cellValue("$1,250.00"), 1250);
  assert.equal(cellValue("(15)"), -15);
  assert.equal(cellValue("12%"), 0.12);
  assert.equal(cellValue("007"), "007");
  assert.equal(cellValue("D1"), "D1");
  for (const ruled of [true, false]) {
    const doc = schedule(ruled);
    const page = doc.loadPage(0);
    const rows = pageTable(page).filter((r) => r.some((c) => c !== null));
    page.destroy();
    const flat = rows.map((r) => r.filter((c) => c !== null));
    assert.deepEqual(flat[0], ["Door Schedule - Level 2"], `ruled=${ruled}`);
    assert.deepEqual(flat.slice(1), [["MARK", "SIZE", "COST"], ["D1", "3'-0\" x 7'-0\"", 1250], ["D2", "2'-8\" x 7'-0\"", 980], ["D3", "6'-0\" x 7'-0\"", -15]], `ruled=${ruled}`);
    // Same column for every row of the table.
    const costCol = rows.slice(1).map((r) => r.findIndex((c) => c === "COST" || typeof c === "number"));
    assert.equal(new Set(costCol).size, 1, `ruled=${ruled} ${costCol}`);
  }
  const files = unzipSync(toXlsx(schedule(true)));
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /<v>1250<\/v>/);
  assert.match(strFromU8(files["xl/workbook.xml"]), /name="Page 1"/);
});

test("powerpoint: one slide per page with editable text and a background picture", () => {
  const doc = schedule(true);
  const files = unzipSync(toPptx(doc));
  const slide = strFromU8(files["ppt/slides/slide1.xml"]);
  assert.match(slide, /<a:t>Door Schedule - Level 2<\/a:t>/);
  assert.match(slide, /<a:t>MARK<\/a:t>/);
  assert.ok(files["ppt/media/page1.png"].length > 1000);
  assert.match(strFromU8(files["ppt/presentation.xml"]), /<p:sldSz cx="7772400" cy="10058400"\/>/);
  // The background picture has the lines but not the text.
  const pix = mupdf.Image ? new mupdf.Image(files["ppt/media/page1.png"]).toPixmap() : null;
  if (pix) {
    const n = pix.getNumberOfComponents(), w = pix.getWidth(), px = pix.getPixels();
    const at = (x: number, y: number) => px[(Math.round(y * 2) * w + Math.round(x * 2)) * n];
    assert.ok(at(72, 792 - 670) < 128, "rule line kept"); // vertical line at x=72
    let dark = 0;
    for (let x = 330; x < 380; x++) for (let y = 792 - 712; y < 792 - 702; y++) if (at(x, y) < 128) dark++;
    assert.equal(dark, 0, "text removed from the picture");
  }
});
