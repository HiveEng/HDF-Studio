// Recaptures the user guide's screenshots from the running app, so the guide can be refreshed in
// one step whenever the interface changes:
//
//   npx tsx scripts/help/screenshots.ts            all shots
//   npx tsx scripts/help/screenshots.ts callout    only shots whose name contains "callout"
//
// It starts the app's browser preview (Vite), opens a sample engineering sheet, drives the real
// interface with Playwright and writes PNGs to public/help/. Playwright must be installed
// (npm i -D playwright, then npx playwright install chromium).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { makeSampleDrawing } from "./sample-drawing";
import { makeFormPdf } from "../../test/fixtures";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as typeof import("playwright");
type Page = import("playwright").Page;

const OUT = resolve("public/help");
const only = process.argv[2] ?? "";
const W = 1440, H = 900;
const PW = 1224, PH = 792; // sample sheet size in points

const drawing = makeSampleDrawing();
/** The same sheet with a moved partition and an extra door, for Compare. */
const revised = makeSampleDrawing({ revised: true });

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({ server: { port: 1430, strictPort: false, hmr: false, watch: null }, logLevel: "error" });
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  const browser = await chromium.launch();
  let failures = 0;
  try {
    for (const [name, shot] of Object.entries(SHOTS)) {
      if (only && !name.includes(only)) continue;
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
      await page.addInitScript("window.__name = (f) => f");
      page.on("pageerror", (e) => console.warn(`  [${name}] page error: ${e.message}`));
      try {
        await page.goto(url);
        await page.evaluate(() => {
          localStorage.clear();
          localStorage.setItem("hdfstudio.author", "Alex Morgan");
          localStorage.setItem("hdfstudio.prefs", JSON.stringify({ company: "Hive Engineering", units: "ft-in", dateFormat: "iso" }));
        });
        await page.reload();
        await page.waitForFunction(() => !!(window as any).hdfStudio);
        await Promise.race([shot(page), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 45 s")), 45000))]);
        console.log(`✓ ${name}`);
      } catch (e) {
        failures++;
        console.error(`✗ ${name}: ${(e as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (failures) process.exitCode = 1;
}

// ---------- helpers ----------
const save = (p: Page, file: string, clip?: { x: number; y: number; width: number; height: number }) =>
  p.screenshot({ path: `${OUT}/${file}`, clip, animations: "disabled" });

async function open(p: Page, data = drawing, name = "A-101 Floor Plan.pdf") {
  await p.evaluate(async ([d, n]) => { await (window as any).hdfStudio.openFiles([{ name: n, data: new Uint8Array(d as number[]) }]); }, [[...data], name] as const);
  await p.waitForSelector("#pages .page", { timeout: 15000 });
  await p.waitForTimeout(1500);
}

async function run(p: Page, id: string) {
  // Don't wait for the command to finish: many open a dialog and wait for it.
  await p.evaluate((id) => void (window as any).hdfStudio.commands.find((c: any) => c.id === id).run(), id);
  await p.waitForTimeout(350);
}

/** Screen position of a point on the sheet, in drawing coordinates (points, y up). */
async function at(p: Page, x: number, y: number, pageNo = 0) {
  const r = await p.locator(`#pages .page[data-page="${pageNo}"]`).boundingBox();
  if (!r) throw new Error("page not shown");
  return { x: r.x + (x / PW) * r.width, y: r.y + ((PH - y) / PH) * r.height };
}
async function click(p: Page, x: number, y: number, o: { button?: "left" | "right"; shift?: boolean } = {}) {
  const q = await at(p, x, y);
  if (o.shift) await p.keyboard.down("Shift");
  await p.mouse.click(q.x, q.y, { button: o.button ?? "left" });
  if (o.shift) await p.keyboard.up("Shift");
  await p.waitForTimeout(250);
}
async function drag(p: Page, x1: number, y1: number, x2: number, y2: number, release = true) {
  const a = await at(p, x1, y1), b = await at(p, x2, y2);
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  if (release) await p.mouse.up();
  await p.waitForTimeout(300);
}
async function tab(p: Page, id: string) {
  await p.click(`#tasks .task[data-task="${id}"]`);
  await p.waitForTimeout(200);
}
/** Fill an open dialog: select/inputs by name. */
async function fill(p: Page, values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) {
    const el = p.locator(`.modal [name="${k}"]`).first();
    const tag = await el.evaluate((e) => e.tagName);
    if (tag === "SELECT") await el.selectOption(v);
    else await el.fill(v);
  }
}
const submit = async (p: Page) => (await p.click(".modal button[type=submit]"), await p.waitForTimeout(700));
const ribbonClip = { x: 0, y: 0, width: W, height: 152 };
/** Region around the dialog that's open, with a margin. */
async function dialogClip(p: Page, sel = ".modal", m = 24) {
  const r = (await p.locator(sel).first().boundingBox())!;
  return { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m), width: Math.min(W, r.width + 2 * m), height: Math.min(H, r.height + 2 * m) };
}
async function zoomTo(p: Page, pct: number) {
  await p.evaluate((z) => {
    const a = (window as any).hdfStudio.active;
    if (a) a.fit = null;
  }, pct);
  // Fit page, then step: simple and uses the app's own zoom.
  await run(p, "fitPage");
}

/** Puts the sample markups on the sheet: a cloud, a callout, a text box and a stamp. */
async function markups(p: Page) {
  await run(p, "tool-cloud");
  for (const [x, y] of [[380, 520], [520, 520], [520, 430], [380, 430]] as const) await click(p, x, y);
  await click(p, 380, 430, { button: "right" });
  await run(p, "tool-callout");
  await click(p, 515, 480);
  await click(p, 640, 610);
  await p.keyboard.type("Confirm door swing\nwith owner");
  await p.keyboard.press("Control+Enter");
  await p.waitForTimeout(500);
  await run(p, "tool-hand");
}

async function setScale(p: Page) {
  await run(p, "setScale");
  await fill(p, { preset: '3/16" = 1\'-0"', pages: "all" });
  await submit(p);
}

// ---------- the shots ----------
const SHOTS: Record<string, (p: Page) => Promise<void>> = {
  async start(p) {
    await save(p, "start.png");
  },
  async window(p) {
    await open(p);
    await save(p, "window.png");
  },
  async tour(p) {
    await open(p);
    // Numbered badges over the parts of the window, matching the table in "A tour of the window".
    await p.evaluate(() => {
      const spots: [string, number, number][] = [
        ["#tasks", 0.5, 0.5], [".quick", 0.6, 0.5], ["#appbar .search", 0.15, 0.5], [".cmd-pill", 0.5, 0.5], ["#helpBtn", 0.5, 0.5], ["#settingsBtn", 0.5, 0.5],
        ["#ribbon", 0.62, 0.55], ["#tabs", 0.18, 0.5], ["#rail", 0.5, 0.35], ["#sidebar", 0.5, 0.75], ["#viewer", 0.55, 0.5], ["#statusText", 0.6, 0.5], ["#viewbar", 0.5, 0.5],
      ];
      spots.forEach(([sel, fx, fy], i) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        const b = document.createElement("div");
        b.textContent = String(i + 1);
        Object.assign(b.style, { position: "fixed", zIndex: "99", left: `${r.left + r.width * fx - 13}px`, top: `${r.top + r.height * fy - 13 + ([3, 4, 5, 6, 13].includes(i + 1) ? 22 : 0)}px`, width: "26px", height: "26px", borderRadius: "50%", background: "#05C7F2", color: "#0D0D0D", font: "700 14px Segoe UI, sans-serif", display: "grid", placeItems: "center", boxShadow: "0 0 0 3px #fff, 0 2px 8px rgba(0,0,0,.4)" });
        document.body.append(b);
      });
    });
    await save(p, "window-tour.png");
  },
  async ribbons(p) {
    await open(p);
    for (const id of ["home", "comment", "measure", "edit", "organize", "sign", "protect", "convert", "automate"]) {
      await tab(p, id);
      await p.mouse.move(W - 5, H - 5);
      await save(p, `ribbon-${id}.png`, ribbonClip);
    }
  },
  async viewbar(p) {
    await open(p);
    const r = (await p.locator("#viewbar").boundingBox())!;
    await save(p, "viewbar.png", { x: r.x - 16, y: r.y - 8, width: r.width + 32, height: r.height + 16 });
  },
  async palette(p) {
    await open(p);
    await p.keyboard.press("Control+K");
    await p.keyboard.type("cloud");
    await p.waitForTimeout(300);
    await save(p, "palette.png", { x: W / 2 - 340, y: 60, width: 680, height: 380 });
  },
  async search(p) {
    await open(p);
    await p.fill("#searchInput", "office");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(1200);
    await save(p, "search.png");
  },
  async markups(p) {
    await open(p);
    await markups(p);
    await run(p, "tool-stamp");
    await p.waitForSelector(".modal");
    await fill(p, { s: "APPROVED AS NOTED" });
    await submit(p);
    await click(p, 830, 75);
    await run(p, "tool-hand");
    await p.mouse.click(5, H - 5);
    await save(p, "markups.png");
  },
  async callout(p) {
    await open(p);
    await markups(p);
    await click(p, 650, 600);
    await p.waitForTimeout(300);
    const a = await at(p, 330, 680), b = await at(p, 760, 400);
    await save(p, "callout-handles.png", { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y });
    await click(p, 650, 600, { button: "right" });
    await p.waitForTimeout(300);
    const m = (await p.locator(".ctx-menu").boundingBox())!;
    const c = await at(p, 520, 640);
    await save(p, "context-menu.png", { x: c.x - 40, y: Math.min(m.y, c.y) - 30, width: m.x + m.width - c.x + 80, height: m.height + 70 });
    await p.click(".ctx-menu .ctx-item:has-text('Style')");
    await p.waitForSelector(".modal");
    await save(p, "callout-style.png", await dialogClip(p));
  },
  async textbox(p) {
    await open(p);
    await run(p, "tool-text");
    await click(p, 598, 312);
    await p.keyboard.type("VERIFY HEADER SIZE\nAT GRID B/3");
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(500);
    await run(p, "tool-hand");
    await click(p, 640, 300);
    await p.waitForTimeout(300);
    const a = await at(p, 480, 380), b = await at(p, 840, 210);
    await save(p, "textbox-grips.png", { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y });
  },
  async windowselect(p) {
    await open(p);
    await markups(p);
    await run(p, "tool-text");
    await click(p, 250, 300);
    await p.keyboard.type("NEW PARTITION");
    await p.keyboard.press("Control+Enter");
    await run(p, "tool-hand");
    await drag(p, 330, 560, 740, 380, false);
    await save(p, "window-select.png");
    await p.mouse.up();
    await p.waitForTimeout(400);
    await save(p, "window-selected.png");
    await p.mouse.click(5, H - 5);
    await p.keyboard.press("Escape");
    await drag(p, 600, 560, 420, 470, false);
    await save(p, "window-crossing.png");
    await p.mouse.up();
  },
  async measure(p) {
    await open(p);
    await setScale(p);
    await run(p, "tool-m-length");
    await click(p, 130, 100);
    await click(p, 373, 100);
    await run(p, "tool-m-area");
    for (const [x, y] of [[581, 139], [850, 139], [850, 332.5], [581, 332.5]] as const) await click(p, x, y);
    await click(p, 581, 332.5, { button: "right" });
    await run(p, "tool-m-count");
    for (const [x, y] of [[230, 180], [330, 180], [430, 180], [530, 180]] as const) await click(p, x, y);
    await run(p, "tool-hand");
    await tab(p, "measure");
    await p.mouse.click(5, H - 5);
    await save(p, "measure.png");
  },
  async scaledialog(p) {
    await open(p);
    await run(p, "setScale");
    await p.waitForSelector(".modal");
    await fill(p, { preset: '3/16" = 1\'-0"' });
    await save(p, "scale-dialog.png", await dialogClip(p));
  },
  async settings(p) {
    await run(p, "settings");
    await p.waitForSelector(".modal.settings");
    await save(p, "settings.png", await dialogClip(p, ".modal.settings"));
  },
  async redact(p) {
    await open(p);
    await run(p, "findRedact");
    await p.waitForSelector(".modal");
    await fill(p, { kind: "text", q: "OFFICE" });
    await save(p, "find-redact.png", await dialogClip(p));
    await submit(p);
    await p.waitForTimeout(1200);
    await save(p, "redact-marked.png");
  },
  async ocr(p) {
    await open(p);
    await run(p, "ocr");
    await p.waitForSelector(".modal");
    await save(p, "ocr-dialog.png", await dialogClip(p));
  },
  async saveimages(p) {
    await open(p);
    await run(p, "saveAsImages");
    await p.waitForSelector(".modal");
    await save(p, "save-images.png", await dialogClip(p));
  },
  async compare(p) {
    await open(p, drawing, "A-101 Floor Plan rev 1.pdf");
    await open(p, revised, "A-101 Floor Plan rev 2.pdf");
    await run(p, "compare");
    await p.waitForSelector(".modal");
    await save(p, "compare-dialog.png", await dialogClip(p));
    await fill(p, { mode: "overlay" });
    await submit(p);
    await p.waitForTimeout(3000);
    await save(p, "compare-overlay.png");
  },
  async comparereport(p) {
    await open(p, drawing, "A-101 Floor Plan rev 1.pdf");
    await open(p, revised, "A-101 Floor Plan rev 2.pdf");
    await run(p, "compare");
    await p.waitForSelector(".modal");
    await fill(p, { mode: "report" });
    await submit(p);
    await p.waitForTimeout(3500);
    await save(p, "compare-report.png");
  },
  async signature(p) {
    await open(p);
    await run(p, "newSignature");
    await p.waitForSelector(".modal");
    await p.waitForTimeout(300);
    await save(p, "signature.png", await dialogClip(p));
  },
  async batch(p) {
    await run(p, "batch");
    await p.waitForTimeout(500);
    await save(p, "batch.png");
  },
  async exportlist(p) {
    await open(p);
    await run(p, "exportMarkups");
    await p.waitForSelector(".modal");
    await save(p, "export-list.png", await dialogClip(p));
  },
  async forms(p) {
    await open(p, makeFormPdf(), "Site Inspection Form.pdf");
    await run(p, "prepareForm");
    await p.waitForTimeout(800);
    await save(p, "form-designer.png");
  },
  async chest(p) {
    await open(p);
    await run(p, "showChest");
    await p.waitForTimeout(500);
    await save(p, "tool-chest.png", { x: 0, y: 150, width: 720, height: 600 });
  },
  async comments(p) {
    await open(p);
    await markups(p);
    await run(p, "showComments");
    await p.waitForTimeout(600);
    await save(p, "comments.png");
  },
  async print(p) {
    await open(p);
    await run(p, "print");
    await p.waitForTimeout(500);
    const sel = (await p.locator(".modal").count()) ? ".modal" : ".print-dialog";
    await save(p, "print.png", await dialogClip(p, sel));
  },
  async m365(p) {
    await p.evaluate(async () => {
      const { browseCloud } = await import("/src/ui/cloud.ts" as string);
      const now = Date.now();
      const iso = (d: number) => new Date(now - d * 86400000).toISOString();
      const f = (name: string, folder: boolean, d: number, size = 0, by = "Alex Morgan") => ({ id: name, driveId: "d1", name, folder, size, modified: iso(d), modifiedBy: by });
      const g = {
        places: async () => [{ kind: "drive", name: "OneDrive", driveId: "d1", hint: "My files" }, { kind: "recent", name: "Recent", hint: "Files you used lately" }, { kind: "shared", name: "Shared with me" }],
        children: async () => [f("26-114 Maple Street Office", true, 2), f("26-097 Riverside Clinic", true, 6), f("Templates", true, 30), f("A-101 Floor Plan.pdf", false, 0.1, 412000), f("A-301 Sections.pdf", false, 1, 388000), f("S-201 Framing Plan.pdf", false, 3, 1250000, "Jamie Morgan"), f("Site Inspection Form.pdf", false, 9, 96000)],
        recent: async () => [],
        sharedWithMe: async () => [],
      };
      void browseCloud(g as never, { mode: "open" });
    });
    await p.waitForTimeout(900);
    const sel = (await p.locator(".cloud-win").count()) ? ".cloud-win" : ".modal";
    await save(p, "m365-open.png", await dialogClip(p, sel));
  },
  async help(p) {
    await open(p);
    await p.keyboard.press("F1");
    await p.waitForSelector(".help-win");
    await p.fill(".help-search input", "callout leader");
    await p.waitForTimeout(400);
    await p.keyboard.press("Enter");
    await p.waitForTimeout(500);
    await save(p, "help.png");
  },
};

void main();
