import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));

test("create PDFs from images, HTML, text, blank", () => {
  const e = new Engine();
  const pdf = e.toPdf([{ name: "a.png", data: PNG }, { name: "b.html", data: new TextEncoder().encode("<h1>Title</h1><p>Hello from HTML</p>") }, { name: "c.txt", data: new TextEncoder().encode("Plain text line") }], { pageSize: "a4" });
  const d = e.open(pdf);
  assert.equal(d.pageCount, 3);
  assert.deepEqual(d.pageSizes[0].map(Math.round), [595, 842]);
  assert.match(e.pageText(d.id, 1), /Hello from HTML/);
  assert.match(e.pageText(d.id, 2), /Plain text line/);
  const auto = e.open(e.toPdf([{ name: "a.png", data: PNG }], { pageSize: "auto" }));
  assert.equal(auto.pageCount, 1);
  assert.equal(e.open(e.blankPdf(3, "letter", true)).pageSizes[0][0], 792);
  assert.throws(() => e.toPdf([{ name: "x.docx", data: new Uint8Array(4) }]), /LibreOffice/);
});

test("export to images, text, html, svg and Word", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(2));
  const imgs = e.toImages(id, [0, 1], 72, "png");
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].data[1], 0x50);
  assert.equal(e.toImages(id, [0], 72, "jpg")[0].data[0], 0xff);
  assert.match(new TextDecoder().decode(e.exportAs(id, "text")[0]), /quick brown fox/);
  assert.match(new TextDecoder().decode(e.exportAs(id, "html")[0]), /<html|<div|<p/);
  assert.equal(e.exportAs(id, "svg").length, 2);
  const docx = unzipSync(e.exportAs(id, "docx")[0]);
  const xml = strFromU8(docx["word/document.xml"]);
  assert.match(xml, /quick brown fox/);
  assert.match(xml, /Heading1/, "big title becomes a heading");
  assert.match(xml, /w:type="page"/);
});
