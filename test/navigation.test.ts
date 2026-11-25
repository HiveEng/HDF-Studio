import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

test("bookmarks: write a nested outline, read it back, survives save, undo", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(3));
  e.setBookmarks(id, [
    { title: "Drawings", page: 0, children: [{ title: "Floor plan", page: 1, y: 200, children: [] }, { title: "Sections", page: 2, children: [] }] },
    { title: "Hive website", page: null, url: "https://example.com/", children: [] },
  ]);
  const b = e.bookmarks(id);
  assert.deepEqual(b.map((x) => x.title), ["Drawings", "Hive website"]);
  assert.deepEqual(b[0].children.map((x) => [x.title, x.page]), [["Floor plan", 1], ["Sections", 2]]);
  assert.equal(b[1].url, "https://example.com/");
  const re = new Engine();
  const { id: id2, outline } = re.open(e.save(id));
  assert.equal(outline[0].children.length, 2);
  assert.equal(re.bookmarks(id2)[0].children[0].title, "Floor plan");
  e.undo(id);
  assert.deepEqual(e.bookmarks(id).map((x) => x.title), ["Chapter 1", "Chapter 2", "Chapter 3"]);
});

test("links: add page and web links, edit, delete", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(3));
  e.addLink(id, 0, [72, 72, 200, 90], { page: 2 });
  e.addLink(id, 0, [72, 100, 200, 120], { url: "https://example.com/spec" });
  let l = e.links(id, 0);
  assert.equal(l.length, 2);
  assert.equal(l.find((x) => x.page === 2)?.rect[0], 72);
  assert.equal(l.find((x) => x.url)?.url, "https://example.com/spec");
  e.updateLink(id, 0, l.findIndex((x) => x.page === 2), { page: 1 });
  l = e.links(id, 0);
  assert.ok(l.some((x) => x.page === 1));
  e.deleteLink(id, 0, l.findIndex((x) => x.url));
  assert.equal(e.links(id, 0).length, 1);
});

test("attachments: add, list, read back, replace, delete", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  const data = new TextEncoder().encode("a,b\n1,2\n");
  e.addAttachment(id, "calcs.csv", data, "Beam calcs");
  e.addAttachment(id, "notes.txt", new TextEncoder().encode("hi"));
  let list = e.attachments(id);
  assert.deepEqual(list.map((a) => a.name), ["calcs.csv", "notes.txt"]);
  assert.equal(list[0].description, "Beam calcs");
  assert.equal(new TextDecoder().decode(e.getAttachment(id, "calcs.csv")), "a,b\n1,2\n");
  const re = new Engine();
  const { id: id2 } = re.open(e.save(id));
  assert.equal(re.attachments(id2).length, 2);
  e.deleteAttachment(id, "notes.txt");
  list = e.attachments(id);
  assert.deepEqual(list.map((a) => a.name), ["calcs.csv"]);
});

test("layers: none in a plain file", () => {
  const e = new Engine();
  const { id } = e.open(makeSamplePdf(1));
  assert.deepEqual(e.layers(id), []);
});

test("layers: list and hide a CAD-style layer", async () => {
  const mupdf = await import("mupdf");
  const d = new mupdf.PDFDocument();
  const ocg = (name: string) => {
    const o = d.newDictionary();
    o.put("Type", d.newName("OCG"));
    o.put("Name", d.newString(name));
    return d.addObject(o);
  };
  const walls = ocg("A-WALL"), dims = ocg("A-DIMS");
  const ocgs = d.newArray(); ocgs.push(walls); ocgs.push(dims);
  const on = d.newArray(); on.push(walls); on.push(dims);
  const D = d.newDictionary(); D.put("ON", on); D.put("Order", ocgs);
  const ocp = d.newDictionary(); ocp.put("OCGs", ocgs); ocp.put("D", D);
  d.getTrailer().get("Root").put("OCProperties", ocp);
  const props = d.newDictionary(); props.put("W", walls); props.put("Dm", dims);
  const res = d.newDictionary(); res.put("Properties", props);
  d.insertPage(-1, d.addPage([0, 0, 200, 200], 0, res, "/OC /W BDC 0 0 1 rg 10 10 50 50 re f EMC /OC /Dm BDC 1 0 0 rg 100 100 50 50 re f EMC"));
  const e = new Engine();
  const { id } = e.open(d.saveToBuffer("").asUint8Array());
  assert.deepEqual(e.layers(id).map((l) => [l.name, l.visible]).sort(), [["A-DIMS", true], ["A-WALL", true]]);
  const dimsLayer = e.layers(id).find((l) => l.name === "A-DIMS")!;
  e.setLayerVisible(id, dimsLayer.index, false);
  assert.equal(e.layers(id).find((l) => l.name === "A-DIMS")!.visible, false);
  assert.equal(e.layers(id).find((l) => l.name === "A-WALL")!.visible, true);
});
