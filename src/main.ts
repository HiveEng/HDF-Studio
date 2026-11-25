import { createEngine } from "./engine/client";
import type { DocInfo, OutlineNode, SearchHit } from "./engine/core";
import { pickFiles, filesFromList, saveFile, baseName, isTauri, type OpenedFile } from "./platform";

const engine = createEngine();
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------- State ----------
type FitMode = "width" | "page" | null;
interface Tab {
  info: DocInfo;
  name: string;
  path: string | null;
  dirty: boolean;
  zoom: number;
  fit: FitMode;
  page: number;
  scrollTop: number;
  query: string;
  hits: SearchHit[];
  hitIndex: number;
}
const tabs: Tab[] = [];
let active: Tab | null = null;
const dpr = () => window.devicePixelRatio || 1;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8];
const PAGE_GAP = 12;

// ---------- Elements ----------
const viewer = $("#viewer");
const pagesEl = $("#pages");
const thumbsEl = $("#side-thumbs");
const outlineEl = $("#side-outline");
const resultsEl = $("#side-results");
const pageInput = $<HTMLInputElement>("#pageInput");
const searchInput = $<HTMLInputElement>("#searchInput");
const status = (msg: string) => ($("#status").textContent = msg);

// ---------- Render queue (worker is serial; render what's visible first) ----------
type Job = { el: HTMLElement; tab: Tab; page: number; scale: number };
const queue: Job[] = [];
let busy = false;
function enqueue(job: Job) {
  const i = queue.findIndex((j) => j.el === job.el);
  if (i >= 0) queue.splice(i, 1);
  queue.unshift(job); // most recently seen first
  pump();
}
async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.el.isConnected && job.tab === active && job.el.dataset.visible === "1" && Number(job.el.dataset.scale) !== job.scale) {
      const r = await engine.render(job.tab.info.id, job.page, job.scale);
      if (job.el.isConnected && job.tab === active) {
        let canvas = job.el.querySelector("canvas");
        if (!canvas) job.el.prepend((canvas = document.createElement("canvas")));
        canvas.width = r.width;
        canvas.height = r.height;
        canvas.getContext("2d")!.putImageData(new ImageData(r.pixels as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
        job.el.dataset.scale = String(job.scale);
      }
    }
  } catch (e) {
    status(`Render error: ${(e as Error).message}`);
  } finally {
    busy = false;
    pump();
  }
}

const pageObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      el.dataset.visible = e.isIntersecting ? "1" : "0";
      if (e.isIntersecting) requestPage(el);
      else if (el.querySelector("canvas")) {
        el.querySelector("canvas")!.remove(); // free memory for far-away pages
        delete el.dataset.scale;
      }
    }
  },
  { root: viewer, rootMargin: "150% 0px" },
);
function requestPage(el: HTMLElement) {
  if (!active) return;
  enqueue({ el, tab: active, page: Number(el.dataset.page), scale: +(active.zoom * dpr()).toFixed(3) });
}

const THUMB_W = 150;
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      el.dataset.visible = e.isIntersecting ? "1" : "0";
      if (e.isIntersecting && active) {
        const p = Number(el.dataset.page);
        const scale = +((THUMB_W / active.info.pageSizes[p][0]) * dpr()).toFixed(3);
        queue.push({ el, tab: active, page: p, scale }); // thumbnails after main pages
        pump();
      }
    }
  },
  { root: thumbsEl, rootMargin: "100% 0px" },
);

// ---------- Layout ----------
function buildView() {
  pageObserver.disconnect();
  thumbObserver.disconnect();
  queue.length = 0;
  pagesEl.replaceChildren();
  thumbsEl.replaceChildren();
  outlineEl.replaceChildren();
  $("#empty").classList.toggle("hidden", !!active);
  renderTabs();
  if (!active) {
    $("#pageCount").textContent = "/ 0";
    pageInput.value = "";
    renderResults();
    return;
  }
  const t = active;
  t.info.pageSizes.forEach(([w, h], i) => {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.page = String(i);
    page.style.aspectRatio = `${w} / ${h}`;
    pagesEl.append(page);
    pageObserver.observe(page);

    const th = document.createElement("div");
    th.className = "thumb";
    th.dataset.page = String(i);
    const box = document.createElement("div");
    box.className = "page";
    box.dataset.page = String(i);
    box.style.width = `${THUMB_W}px`;
    box.style.aspectRatio = `${w} / ${h}`;
    box.style.boxShadow = "none";
    th.append(box, Object.assign(document.createElement("span"), { textContent: String(i + 1) }));
    th.onclick = () => goToPage(i);
    thumbsEl.append(th);
    thumbObserver.observe(box);
  });
  renderOutline(t.info.outline, outlineEl);
  $("#pageCount").textContent = `/ ${t.info.pageCount}`;
  searchInput.value = t.query;
  applyZoom(t.zoom, false);
  if (t.fit) fit(t.fit);
  viewer.scrollTop = t.scrollTop;
  drawHighlights();
  renderResults();
  updateCurrentPage();
}

function applyZoom(z: number, keepCenter = true) {
  if (!active) return;
  const ratio = keepCenter ? (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, viewer.scrollHeight) : 0;
  active.zoom = Math.min(8, Math.max(0.1, z));
  pagesEl.querySelectorAll<HTMLElement>(".page").forEach((el) => {
    el.style.width = `${active!.info.pageSizes[Number(el.dataset.page)][0] * active!.zoom}px`;
  });
  $("#zoomLabel").textContent = `${Math.round(active.zoom * 100)}%`;
  if (keepCenter) viewer.scrollTop = ratio * viewer.scrollHeight - viewer.clientHeight / 2;
  rerenderVisible();
}
let rerenderTimer = 0;
function rerenderVisible() {
  clearTimeout(rerenderTimer);
  rerenderTimer = window.setTimeout(() => {
    pagesEl.querySelectorAll<HTMLElement>('.page[data-visible="1"]').forEach(requestPage);
  }, 120);
}
function fit(mode: "width" | "page") {
  if (!active) return;
  const pad = 32 + 16;
  const maxW = Math.max(...active.info.pageSizes.map((s) => s[0]));
  const [, h] = active.info.pageSizes[active.page] ?? active.info.pageSizes[0];
  const zw = (viewer.clientWidth - pad) / maxW;
  const zp = Math.min(zw, (viewer.clientHeight - pad) / h);
  applyZoom(mode === "width" ? zw : zp);
  active.fit = mode;
}
function stepZoom(dir: 1 | -1) {
  if (!active) return;
  const z = active.zoom;
  const next = dir > 0 ? ZOOMS.find((v) => v > z + 0.001) : [...ZOOMS].reverse().find((v) => v < z - 0.001);
  active.fit = null;
  applyZoom(next ?? z);
}

// ---------- Navigation ----------
function pageEl(i: number) {
  return pagesEl.children[i] as HTMLElement | undefined;
}
function goToPage(i: number, yPoints?: number) {
  if (!active) return;
  i = Math.max(0, Math.min(active.info.pageCount - 1, i));
  const el = pageEl(i);
  if (!el) return;
  viewer.scrollTop = el.offsetTop - PAGE_GAP + (yPoints ? yPoints * active.zoom - viewer.clientHeight / 3 : 0);
  updateCurrentPage();
}
function updateCurrentPage() {
  if (!active) return;
  const mid = viewer.scrollTop + viewer.clientHeight * 0.4;
  let cur = 0;
  for (let i = 0; i < pagesEl.children.length; i++) {
    if ((pagesEl.children[i] as HTMLElement).offsetTop <= mid) cur = i;
    else break;
  }
  active.page = cur;
  active.scrollTop = viewer.scrollTop;
  if (document.activeElement !== pageInput) pageInput.value = String(cur + 1);
  thumbsEl.querySelector(".thumb.current")?.classList.remove("current");
  const th = thumbsEl.children[cur] as HTMLElement | undefined;
  if (th) {
    th.classList.add("current");
    const r = th.getBoundingClientRect(), pr = thumbsEl.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) th.scrollIntoView({ block: "nearest" });
  }
}
viewer.addEventListener("scroll", () => requestAnimationFrame(updateCurrentPage), { passive: true });
pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    goToPage(parseInt(pageInput.value, 10) - 1);
    viewer.focus();
  }
});
viewer.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !active) return;
    e.preventDefault();
    active.fit = null;
    applyZoom(active.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);
new ResizeObserver(() => active?.fit && fit(active.fit)).observe(viewer);

function renderOutline(nodes: OutlineNode[], parent: HTMLElement) {
  if (!nodes.length && parent === outlineEl) {
    parent.innerHTML = `<p class="muted">This document has no outline.</p>`;
    return;
  }
  for (const n of nodes) {
    const item = document.createElement("div");
    item.className = "outline-item";
    item.textContent = n.title;
    if (n.page !== null) item.onclick = () => goToPage(n.page!);
    parent.append(item);
    if (n.children.length) {
      const kids = document.createElement("div");
      kids.className = "outline-children";
      renderOutline(n.children, kids);
      parent.append(kids);
    }
  }
}

// ---------- Search ----------
async function runSearch(query: string) {
  if (!active) return;
  const t = active;
  t.query = query;
  if (!query) {
    t.hits = [];
    t.hitIndex = -1;
  } else {
    status(`Searching for “${query}”…`);
    const started = performance.now();
    t.hits = await engine.search(t.info.id, query);
    t.hitIndex = t.hits.findIndex((h) => h.page >= t.page);
    if (t.hitIndex < 0 && t.hits.length) t.hitIndex = 0;
    status(`${t.hits.length} matches in ${Math.round(performance.now() - started)} ms`);
  }
  if (t !== active) return;
  drawHighlights();
  renderResults();
  if (t.hits.length) {
    showSidePanel("results");
    focusHit();
  }
}
function drawHighlights() {
  pagesEl.querySelectorAll(".hl").forEach((n) => n.remove());
  if (!active) return;
  const t = active;
  t.hits.forEach((hit, idx) => {
    const el = pageEl(hit.page);
    if (!el) return;
    const [pw, ph] = t.info.pageSizes[hit.page];
    for (const q of hit.quads) {
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const d = document.createElement("div");
      d.className = "hl" + (idx === t.hitIndex ? " active" : "");
      // Percent units keep highlights correct at every zoom level without redrawing.
      Object.assign(d.style, { left: `${(x0 / pw) * 100}%`, top: `${(y0 / ph) * 100}%`, width: `${((x1 - x0) / pw) * 100}%`, height: `${((y1 - y0) / ph) * 100}%` });
      el.append(d);
    }
  });
  $("#hitLabel").textContent = t.hits.length ? `${t.hitIndex + 1} of ${t.hits.length}` : t.query ? "No matches" : "";
}
function renderResults() {
  resultsEl.replaceChildren();
  if (!active || !active.hits.length) {
    resultsEl.innerHTML = `<p class="muted">${active?.query ? "No matches." : "Search results appear here."}</p>`;
    return;
  }
  const frag = document.createDocumentFragment();
  active.hits.forEach((h, i) => {
    const r = document.createElement("div");
    r.className = "result" + (i === active!.hitIndex ? " active" : "");
    r.innerHTML = `<b>Page ${h.page + 1}</b> <span class="snippet"></span>`;
    r.querySelector(".snippet")!.textContent = h.snippet;
    r.onclick = () => {
      active!.hitIndex = i;
      focusHit();
    };
    frag.append(r);
  });
  resultsEl.append(frag);
}
function focusHit() {
  if (!active || active.hitIndex < 0) return;
  const h = active.hits[active.hitIndex];
  goToPage(h.page, Math.min(...h.quads.map((q) => Math.min(q[1], q[3], q[5], q[7]))));
  drawHighlights();
  resultsEl.querySelector(".result.active")?.classList.remove("active");
  const r = resultsEl.children[active.hitIndex] as HTMLElement | undefined;
  r?.classList.add("active");
  r?.scrollIntoView({ block: "nearest" });
}
function stepHit(dir: 1 | -1) {
  if (!active || !active.hits.length) return;
  active.hitIndex = (active.hitIndex + dir + active.hits.length) % active.hits.length;
  focusHit();
}
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !active) return;
  if (searchInput.value !== active.query) runSearch(searchInput.value);
  else stepHit(e.shiftKey ? -1 : 1);
});
searchInput.addEventListener("search", () => !searchInput.value && runSearch(""));

// ---------- Tabs & files ----------
async function openFiles(files: OpenedFile[]) {
  await engine.ready;
  for (const f of files) {
    try {
      status(`Opening ${f.name}…`);
      let info = await engine.open(f.data, f.name);
      while (info.needsPassword) {
        const pw = prompt(`${f.name} is password protected. Password:`);
        if (pw === null) {
          await engine.close(info.id);
          throw new Error("cancelled");
        }
        info = (await engine.unlock(info.id, pw)) ?? info;
      }
      const tab: Tab = { info, name: f.name, path: f.path, dirty: false, zoom: 1, fit: "width", page: 0, scrollTop: 0, query: "", hits: [], hitIndex: -1 };
      tabs.push(tab);
      active = tab;
      status(`${f.name}: ${info.pageCount} pages`);
    } catch (e) {
      if ((e as Error).message !== "cancelled") status(`Could not open ${f.name}: ${(e as Error).message}`);
    }
  }
  buildView();
}
function switchTab(t: Tab) {
  if (active) active.scrollTop = viewer.scrollTop;
  active = t;
  buildView();
}
async function closeTab(t: Tab) {
  if (t.dirty && !confirm(`Close ${t.name} without saving?`)) return;
  await engine.close(t.info.id);
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (active === t) active = tabs[Math.min(i, tabs.length - 1)] ?? null;
  buildView();
}
function renderTabs() {
  const nav = $("#tabs");
  nav.replaceChildren();
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t === active ? " active" : "");
    el.title = t.path ?? t.name;
    el.innerHTML = `<span class="${t.dirty ? "dirty" : ""}"></span><button class="close" title="Close (Ctrl+W)">×</button>`;
    el.firstElementChild!.textContent = t.name;
    el.onclick = () => switchTab(t);
    el.onauxclick = (e) => e.button === 1 && closeTab(t);
    (el.querySelector(".close") as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      closeTab(t);
    };
    nav.append(el);
  }
  document.title = active ? `${active.name} - Quire` : "Quire";
}
async function save(saveAs: boolean) {
  if (!active) return;
  const t = active;
  const bytes = await engine.save(t.info.id);
  const p = await saveFile(bytes, t.name, t.path, saveAs);
  if (p) {
    t.path = p;
    t.name = baseName(p);
  }
  t.dirty = false;
  renderTabs();
  status(`Saved ${t.name}`);
}

// Drag & drop
viewer.addEventListener("dragover", (e) => {
  e.preventDefault();
  viewer.classList.add("dragover");
});
viewer.addEventListener("dragleave", () => viewer.classList.remove("dragover"));
viewer.addEventListener("drop", async (e) => {
  e.preventDefault();
  viewer.classList.remove("dragover");
  openFiles(await filesFromList(e.dataTransfer?.files ?? null));
});

// ---------- Sidebar ----------
function showSidePanel(name: string) {
  document.querySelectorAll<HTMLElement>(".side-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.side === name));
  document.querySelectorAll<HTMLElement>(".side-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `side-${name}`));
}
document.querySelectorAll<HTMLElement>(".side-tabs button").forEach((b) => (b.onclick = () => showSidePanel(b.dataset.side!)));

// ---------- Theme ----------
function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("quire.theme", dark ? "dark" : "light");
}
setTheme((localStorage.getItem("quire.theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark");

// ---------- Commands, shortcuts, palette ----------
interface Command { id: string; title: string; keys?: string; run: () => void }
const commands: Command[] = [
  { id: "open", title: "Open files…", keys: "Ctrl+O", run: async () => openFiles(await pickFiles()) },
  { id: "save", title: "Save", keys: "Ctrl+S", run: () => save(false) },
  { id: "saveAs", title: "Save as…", keys: "Ctrl+Shift+S", run: () => save(true) },
  { id: "closeTab", title: "Close tab", keys: "Ctrl+W", run: () => active && closeTab(active) },
  { id: "nextTab", title: "Next tab", keys: "Ctrl+Tab", run: () => tabs.length > 1 && switchTab(tabs[(tabs.indexOf(active!) + 1) % tabs.length]) },
  { id: "prevTab", title: "Previous tab", keys: "Ctrl+Shift+Tab", run: () => tabs.length > 1 && switchTab(tabs[(tabs.indexOf(active!) - 1 + tabs.length) % tabs.length]) },
  { id: "find", title: "Find in document", keys: "Ctrl+F", run: () => (searchInput.focus(), searchInput.select()) },
  { id: "nextHit", title: "Next match", keys: "F3", run: () => stepHit(1) },
  { id: "prevHit", title: "Previous match", keys: "Shift+F3", run: () => stepHit(-1) },
  { id: "zoomIn", title: "Zoom in", keys: "Ctrl+=", run: () => stepZoom(1) },
  { id: "zoomOut", title: "Zoom out", keys: "Ctrl+-", run: () => stepZoom(-1) },
  { id: "actualSize", title: "Actual size", keys: "Ctrl+1", run: () => active && ((active.fit = null), applyZoom(1)) },
  { id: "fitWidth", title: "Fit width", keys: "Ctrl+2", run: () => fit("width") },
  { id: "fitPage", title: "Fit page", keys: "Ctrl+0", run: () => fit("page") },
  { id: "nextPage", title: "Next page", keys: "PageDown", run: () => active && goToPage(active.page + 1) },
  { id: "prevPage", title: "Previous page", keys: "PageUp", run: () => active && goToPage(active.page - 1) },
  { id: "firstPage", title: "First page", keys: "Home", run: () => goToPage(0) },
  { id: "lastPage", title: "Last page", keys: "End", run: () => active && goToPage(active.info.pageCount - 1) },
  { id: "goto", title: "Go to page…", keys: "Ctrl+G", run: () => (pageInput.focus(), pageInput.select()) },
  { id: "toggleSidebar", title: "Toggle sidebar", keys: "F4", run: () => $("main").classList.toggle("no-sidebar") },
  { id: "showOutline", title: "Show outline", run: () => showSidePanel("outline") },
  { id: "showThumbs", title: "Show page thumbnails", run: () => showSidePanel("thumbs") },
  { id: "toggleTheme", title: "Toggle dark mode", run: () => setTheme(!document.documentElement.classList.contains("dark")) },
  { id: "palette", title: "Show all commands", keys: "Ctrl+K", run: () => openPalette() },
];
const byId = Object.fromEntries(commands.map((c) => [c.id, c]));
document.querySelectorAll<HTMLElement>("[data-cmd]").forEach((b) => (b.onclick = () => byId[b.dataset.cmd!]?.run()));

function keyString(e: KeyboardEvent) {
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  let shift = e.shiftKey;
  if (key === "+") (key = "="), (shift = false); // Ctrl++ and Ctrl+= both zoom in
  if (key === "_") (key = "-"), (shift = false);
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", shift ? "Shift" : "", e.altKey ? "Alt" : "", key].filter(Boolean).join("+");
}
document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement;
  const ks = keyString(e);
  const cmd = commands.find((c) => c.keys === ks);
  if (!cmd) {
    if (e.key === "Escape") closePalette();
    return;
  }
  // Plain navigation keys shouldn't fire while typing in a field.
  if (typing && !ks.includes("Ctrl") && !ks.startsWith("F")) return;
  e.preventDefault();
  cmd.run();
});

const palette = $("#palette"), paletteInput = $<HTMLInputElement>("#paletteInput"), paletteList = $("#paletteList");
let paletteSel = 0;
function fuzzy(q: string, s: string) {
  q = q.toLowerCase();
  s = s.toLowerCase();
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}
function filteredCommands() {
  return commands.filter((c) => c.id !== "palette" && fuzzy(paletteInput.value, c.title));
}
function renderPalette() {
  const list = filteredCommands();
  paletteSel = Math.min(paletteSel, Math.max(0, list.length - 1));
  paletteList.replaceChildren(
    ...list.map((c, i) => {
      const li = document.createElement("li");
      li.className = i === paletteSel ? "sel" : "";
      li.innerHTML = `<span></span><kbd></kbd>`;
      li.firstElementChild!.textContent = c.title;
      li.lastElementChild!.textContent = c.keys ?? "";
      if (!c.keys) li.lastElementChild!.remove();
      li.onclick = () => (closePalette(), c.run());
      return li;
    }),
  );
}
function openPalette() {
  palette.classList.remove("hidden");
  paletteInput.value = "";
  paletteSel = 0;
  renderPalette();
  paletteInput.focus();
}
function closePalette() {
  palette.classList.add("hidden");
}
paletteInput.addEventListener("input", () => ((paletteSel = 0), renderPalette()));
paletteInput.addEventListener("keydown", (e) => {
  const list = filteredCommands();
  if (e.key === "ArrowDown") paletteSel = Math.min(list.length - 1, paletteSel + 1);
  else if (e.key === "ArrowUp") paletteSel = Math.max(0, paletteSel - 1);
  else if (e.key === "Enter" && list[paletteSel]) {
    closePalette();
    list[paletteSel].run();
    return;
  } else return;
  e.preventDefault();
  renderPalette();
});
paletteInput.addEventListener("blur", () => setTimeout(closePalette, 150));

// ---------- Startup: files passed on the command line / "Open with" ----------
(async () => {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const { listen } = await import("@tauri-apps/api/event");
  const openPaths = async (paths: string[]) =>
    paths.length && openFiles(await Promise.all(paths.map(async (p) => ({ name: baseName(p), path: p, data: await readFile(p) }))));
  await listen<string[]>("open-files", (e) => openPaths(e.payload));
  await openPaths(await invoke<string[]>("startup_files"));
})().catch((e) => status(String(e)));

// Exposed for tests and future modules.
Object.assign(window, { quire: { openFiles, runSearch, goToPage, commands, get active() { return active; } } });
buildView();
