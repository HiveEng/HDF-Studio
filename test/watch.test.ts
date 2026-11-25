import { test } from "node:test";
import assert from "node:assert/strict";
import { FolderWatcher, type WatchFs, type WatchEvent } from "../src/automation/watch";
import { runRecipe, BUILTIN_RECIPES } from "../src/engine/recipes";
import { Engine } from "../src/engine/core";
import { makeSamplePdf } from "./fixtures";

/** In-memory folders: path -> bytes + mtime. */
function memFs() {
  const files = new Map<string, { data: Uint8Array; mtime: number }>();
  const dirs = new Set<string>();
  let clock = 1;
  const fs: WatchFs & { put(p: string, d: Uint8Array): void; files: typeof files } = {
    files,
    put: (p, d) => void files.set(p, { data: d, mtime: clock++ }),
    async list(dir) {
      return [...files].filter(([p]) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map(([p, f]) => ({ name: p.slice(dir.length + 1), size: f.data.length, mtime: f.mtime }));
    },
    async read(p) { const f = files.get(p); if (!f) throw new Error("missing " + p); return f.data; },
    async write(p, d) { files.set(p, { data: d, mtime: clock++ }); },
    async mkdir(p) { dirs.add(p); },
    async move(a, b) { const f = files.get(a)!; files.delete(a); files.set(b, f); },
    join: (...p) => p.join("/"),
  };
  return fs;
}

const recipeFor = (n: string) => BUILTIN_RECIPES.find((r) => r.name === n);
const run = async (d: Uint8Array, name: string, r: Parameters<typeof runRecipe>[2]) => runRecipe(d, name, r);

test("processes a PDF once it is stable, writes output, moves the original", async () => {
  const fs = memFs();
  const events: WatchEvent[] = [];
  const w = new FolderWatcher({ id: "1", folder: "/in", recipe: "Watermark DRAFT", enabled: true }, fs, recipeFor, run, (e) => events.push(e));
  fs.put("/in/a.pdf", makeSamplePdf(2));
  fs.put("/in/notes.txt", new Uint8Array([1]));
  assert.equal(await w.tick(), 0, "first sight: wait for the file to settle");
  assert.equal(await w.tick(), 1);
  assert.ok(fs.files.has("/in/hdfstudio-out/a.pdf"));
  assert.ok(fs.files.has("/in/processed/a.pdf") && !fs.files.has("/in/a.pdf"));
  assert.ok(fs.files.has("/in/notes.txt"), "non-PDFs are ignored");
  const e = new Engine();
  assert.match(e.pageText(e.open(fs.files.get("/in/hdfstudio-out/a.pdf")!.data).id, 0), /DRAFT/);
  assert.equal(await w.tick(), 0);
  assert.equal(events.length, 1);
  assert.ok(events[0].ok);
});

test("a file still being written is not touched; failures are parked; keep-mode remembers", async () => {
  const fs = memFs();
  const events: WatchEvent[] = [];
  const w = new FolderWatcher({ id: "2", folder: "/in", recipe: "Watermark DRAFT", enabled: true, afterwards: "keep", out: "/out" }, fs, recipeFor, run, (e) => events.push(e));
  fs.put("/in/b.pdf", makeSamplePdf(1).slice(0, 100));
  await w.tick();
  fs.put("/in/b.pdf", makeSamplePdf(1)); // grew: copy still in progress
  assert.equal(await w.tick(), 0);
  assert.equal(await w.tick(), 1);
  assert.ok(fs.files.has("/out/b.pdf") && fs.files.has("/in/b.pdf"));
  assert.equal(await w.tick(), 0, "kept original is not processed again");
  assert.equal(await w.tick(), 0);

  fs.put("/in/bad.pdf", new Uint8Array([1, 2, 3]));
  await w.tick();
  await w.tick();
  assert.equal(events.filter((e) => !e.ok).length, 1);
  await w.tick();
  assert.equal(events.filter((e) => !e.ok).length, 1, "failure not retried");
  assert.ok(w.handled.size === 2);
});
