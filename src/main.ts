import { createEngine } from "./engine/client";
import type { DocInfo, OutlineNode, SearchHit } from "./engine/core";
import { pickFiles, filesFromList, saveFile, saveMany, saveText, saveBytes, baseName, isTauri, type OpenedFile } from "./platform";
import { setupAnnotate, TOOLS } from "./ui/annotate";
import { setupForms } from "./ui/forms";
import { setupEdit } from "./ui/edit";
import { getSignature, clearSignature, pngSize } from "./ui/signature";
import { parseRanges, formatRanges } from "./engine/ranges";
import { ask, confirmDialog } from "./ui/dialog";
import { openBatch, type BatchDeps } from "./ui/batch";

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
  selected: Set<number>;
  anchor: number;
  /** Extra save options: encryption, decrypt, sanitize. */
  saveExtra: string[];
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
    th.draggable = true;
    if (t.selected.has(i)) th.classList.add("selected");
    th.onclick = (e) => selectThumb(i, e);
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
  annot.refreshComments();
  updateRedactButton();
  editUI.invalidate();
  showSignatureStatus();
  const shown = active;
  formsUI.render().then(() => {
    const n = formsUI.fields.filter((f) => f.type !== "signature" && f.type !== "button").length;
    if (n && shown && !(shown as Tab & { announced?: boolean }).announced) {
      (shown as Tab & { announced?: boolean }).announced = true;
      status(`This document has ${n} form field${n === 1 ? "" : "s"}. Tab moves between them.`);
    }
  });
}

function applyZoom(z: number, keepCenter = true) {
  if (!active) return;
  const ratio = keepCenter ? (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, viewer.scrollHeight) : 0;
  active.zoom = Math.min(8, Math.max(0.1, z));
  pagesEl.querySelectorAll<HTMLElement>(".page").forEach((el) => {
    el.style.width = `${active!.info.pageSizes[Number(el.dataset.page)][0] * active!.zoom}px`;
  });
  $("#zoomLabel").textContent = `${Math.round(active.zoom * 100)}%`;
  pagesEl.style.setProperty("--z", String(active.zoom));
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
        const pw = (await ask(`${f.name} is password protected`, [{ name: "pw", label: "Password", type: "password" }], "Unlock"))?.pw ?? null;
        if (pw === null) {
          await engine.close(info.id);
          throw new Error("cancelled");
        }
        info = (await engine.unlock(info.id, pw)) ?? info;
      }
            addTab(info, f.name, f.path);
      status(`${f.name}: ${info.pageCount} pages`);
    } catch (e) {
      if ((e as Error).message !== "cancelled") status(`Could not open ${f.name}: ${(e as Error).message}`);
    }
  }
  buildView();
}
function addTab(info: DocInfo, name: string, path: string | null, dirty = false) {
  const tab: Tab = { info, name, path, dirty, zoom: 1, fit: "width", page: 0, scrollTop: 0, query: "", hits: [], hitIndex: -1, selected: new Set(), anchor: 0, saveExtra: [] };
  tabs.push(tab);
  active = tab;
  return tab;
}
function switchTab(t: Tab) {
  if (active) active.scrollTop = viewer.scrollTop;
  active = t;
  buildView();
}
async function closeTab(t: Tab) {
  if (t.dirty && !(await confirmDialog(`Close ${t.name} without saving?`, "Close without saving"))) return;
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
  document.title = active ? `${active.name} - HDF Studio` : "HDF Studio";
}
async function save(saveAs: boolean) {
  if (!active) return;
  const t = active;
  // Signed files must be saved incrementally, or the existing signatures would break.
  const signed = await engine.hasSignatures(t.info.id);
  const bytes = await engine.save(t.info.id, signed ? "incremental" : ["garbage", "compress", ...t.saveExtra].join(","));
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
  $("#thumb-tools").classList.toggle("hidden", name !== "thumbs");
  document.querySelectorAll<HTMLElement>(".side-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.side === name));
  document.querySelectorAll<HTMLElement>(".side-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `side-${name}`));
}
document.querySelectorAll<HTMLElement>(".side-tabs button").forEach((b) => (b.onclick = () => showSidePanel(b.dataset.side!)));

// ---------- Organize pages ----------
/** Run a document-changing operation with undo support, then refresh the view. */
async function mutate(label: string, op: (t: Tab) => Promise<DocInfo>) {
  if (!active) return;
  const t = active;
  try {
    const info = await op(t);
    t.info = info;
    t.dirty = true;
    t.hits = [];
    t.hitIndex = -1;
    t.selected = new Set([...t.selected].filter((p) => p < info.pageCount));
    t.page = Math.min(t.page, info.pageCount - 1);
    if (t === active) buildView();
    status(`${label}. Ctrl+Z to undo.`);
  } catch (e) {
    status(`${label} failed: ${(e as Error).message}`);
  }
}
async function undoRedo(dir: "undo" | "redo") {
  if (!active) return;
  const t = active;
  const info = await (dir === "undo" ? engine.undo(t.info.id) : engine.redo(t.info.id));
  if (!info) return status(`Nothing to ${dir}`);
  t.info = info;
  t.dirty = true;
  t.selected.clear();
  t.page = Math.min(t.page, info.pageCount - 1);
  buildView();
  status(dir === "undo" ? "Undone" : "Redone");
}

/** Pages to act on: the thumbnail selection, or the current page. */
function targetPages(): number[] {
  if (!active) return [];
  return active.selected.size ? [...active.selected].sort((a, b) => a - b) : [active.page];
}
function selectThumb(i: number, e: MouseEvent | KeyboardEvent) {
  if (!active) return;
  const t = active;
  if (e.shiftKey) {
    const [a, b] = [Math.min(t.anchor, i), Math.max(t.anchor, i)];
    if (!e.ctrlKey) t.selected.clear();
    for (let k = a; k <= b; k++) t.selected.add(k);
  } else if (e.ctrlKey || e.metaKey) {
    t.selected.has(i) ? t.selected.delete(i) : t.selected.add(i);
    t.anchor = i;
  } else {
    t.selected = new Set([i]);
    t.anchor = i;
  }
  [...thumbsEl.children].forEach((el, k) => el.classList.toggle("selected", t.selected.has(k)));
  goToPage(i);
  status(t.selected.size > 1 ? `${t.selected.size} pages selected (${formatRanges([...t.selected].sort((a, b) => a - b))})` : "");
}

// Drag thumbnails to reorder; drop PDF files onto thumbnails to insert them there.
let dragFrom: number[] | null = null;
function dropIndex(e: DragEvent): number | null {
  const th = (e.target as HTMLElement).closest(".thumb") as HTMLElement | null;
  if (!th) return active ? active.info.pageCount : null;
  const i = Number(th.dataset.page);
  const r = th.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? i + 1 : i;
}
thumbsEl.addEventListener("dragstart", (e) => {
  const th = (e.target as HTMLElement).closest(".thumb") as HTMLElement | null;
  if (!th || !active) return;
  const i = Number(th.dataset.page);
  if (!active.selected.has(i)) selectThumb(i, e);
  dragFrom = targetPages();
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.setData("text/plain", formatRanges(dragFrom));
});
thumbsEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  thumbsEl.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  const at = dropIndex(e);
  if (at === null) return;
  const before = thumbsEl.children[at] as HTMLElement | undefined;
  if (before) before.classList.add("drop-before");
  else (thumbsEl.lastElementChild as HTMLElement | null)?.classList.add("drop-after");
});
thumbsEl.addEventListener("dragleave", () => thumbsEl.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after")));
thumbsEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  thumbsEl.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  const at = dropIndex(e);
  if (at === null || !active) return;
  if (dragFrom) {
    const pages = dragFrom;
    dragFrom = null;
    const count = pages.length;
    const newStart = at - pages.filter((p) => p < at).length;
    await mutate(`Moved ${count} page${count > 1 ? "s" : ""}`, (t) => engine.movePages(t.info.id, pages, at));
    if (active) {
      active.selected = new Set(pages.map((_, k) => newStart + k));
      [...thumbsEl.children].forEach((el, k) => el.classList.toggle("selected", active!.selected.has(k)));
    }
  } else if (e.dataTransfer?.files.length) {
    await insertFiles(await filesFromList(e.dataTransfer.files), at);
  }
});
thumbsEl.addEventListener("dragend", () => (dragFrom = null));
thumbsEl.addEventListener("keydown", (e) => {
  if (!active) return;
  if (e.key === "Delete") (e.preventDefault(), byId.deleteSelected.run());
  else if (e.key === "a" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), byId.selectAll.run());
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    selectThumb(Math.max(0, Math.min(active.info.pageCount - 1, active.page + (e.key === "ArrowDown" ? 1 : -1))), e);
  }
});

async function insertFiles(files: OpenedFile[], at: number) {
  if (!active || !files.length) return;
  await mutate(`Inserted ${files.map((f) => f.name).join(", ")}`, async (t) => {
    let info = t.info;
    let pos = at;
    for (const f of files) {
      const src = await engine.open(f.data, f.name);
      try {
        if (src.needsPassword) throw new Error(`${f.name} is password protected; open it first`);
        info = await engine.insertFrom(t.info.id, pos, src.id);
        pos += src.pageCount;
      } finally {
        await engine.close(src.id);
      }
    }
    return info;
  });
}

async function mergeFiles() {
  const files = await pickFiles(true);
  if (!files.length) return;
  const ids: { id: number; title: string }[] = [];
  try {
    for (const f of files) {
      const info = await engine.open(f.data, f.name);
      if (info.needsPassword) throw new Error(`${f.name} is password protected; open it first`);
      ids.push({ id: info.id, title: f.name.replace(/\.[^.]+$/, "") });
    }
    const merged = await engine.combine(ids);
    const info = await engine.open(merged, "merged.pdf");
    addTab(info, "Merged.pdf", null, true);
    buildView();
    status(`Merged ${files.length} files into ${info.pageCount} pages, with a bookmark per file`);
  } catch (e) {
    status(`Merge failed: ${(e as Error).message}`);
  } finally {
    for (const { id } of ids) await engine.close(id);
  }
}

async function extractPages(pages?: number[]) {
  if (!active) return;
  const t = active;
  if (!pages) {
    const r = await ask("Extract pages to a new document", [{ name: "range", label: "Pages", value: formatRanges(targetPages()), hint: 'e.g. "1-3, 7, 10-", "odd", "even"' }], "Extract");
    if (!r) return;
    pages = parseRanges(r.range, t.info.pageCount);
  }
  const data = await engine.extract(t.info.id, pages);
  const info = await engine.open(data, "extract.pdf");
  const rs = formatRanges(pages);
  addTab(info, `${t.name.replace(/\.pdf$/i, "")} (${rs.length <= 20 ? `pages ${rs}` : "extract"}).pdf`, null, true);
  buildView();
}

async function splitDocument() {
  if (!active) return;
  const t = active;
  const r = await ask("Split document", [
    { name: "mode", label: "Split", type: "select", value: "every", options: [["every", "Every N pages"], ["ranges", "By page ranges"], ["bookmarks", "By top-level bookmarks"]] },
    { name: "n", label: "N (for every N pages)", type: "number", value: "1" },
    { name: "ranges", label: "Ranges (for page ranges), one file per group", placeholder: "1-3 | 4-8 | 9-", hint: "Separate output files with |" },
  ], "Split");
  if (!r) return;
  try {
    const mode = r.mode === "every" ? { every: Math.max(1, parseInt(r.n, 10) || 1) } : r.mode === "bookmarks" ? { bookmarks: true as const } : { groups: r.ranges.split("|").map((g) => parseRanges(g, t.info.pageCount)) };
    const parts = await engine.split(t.info.id, mode);
    const stem = t.name.replace(/\.pdf$/i, "");
    const dir = await saveMany(parts.map((p) => ({ name: `${stem} - ${p.suffix}.pdf`, data: p.data })));
    status(`Split into ${parts.length} files${dir ? ` in ${dir}` : ""}`);
  } catch (e) {
    status(`Split failed: ${(e as Error).message}`);
  }
}

async function rangeOp(title: string, okLabel: string, run: (pages: number[]) => Promise<void>) {
  if (!active) return;
  const r = await ask(title, [{ name: "range", label: "Pages", value: formatRanges(targetPages()), hint: 'e.g. "1-3, 7, 10-", "odd", "even", "all"' }], okLabel);
  if (!r) return;
  try {
    await run(parseRanges(r.range, active.info.pageCount));
  } catch (e) {
    status((e as Error).message);
  }
}


// ---------- Digital (certificate) signatures ----------
const sigBanner = $("#sigbanner");
async function showSignatureStatus() {
  sigBanner.classList.add("hidden");
  if (!active || !(await engine.hasSignatures(active.info.id))) return;
  const checks = await engine.verifySignatures(active.info.id);
  if (!checks.length) return;
  const bad = checks.filter((c) => !c.intact);
  sigBanner.className = bad.length ? "bad" : "good";
  sigBanner.textContent = bad.length
    ? `⚠ ${bad.length} of ${checks.length} signature${checks.length > 1 ? "s are" : " is"} invalid. The document may have been altered. Click for details.`
    : `✓ Signed by ${[...new Set(checks.map((c) => c.signer?.name))].join(", ")}. ${checks.length} signature${checks.length > 1 ? "s" : ""} valid. Click for details.`;
  sigBanner.onclick = () => showSignatureDetails(checks);
}
async function showSignatureDetails(checks?: Awaited<ReturnType<typeof engine.verifySignatures>>) {
  if (!active) return;
  checks ??= await engine.verifySignatures(active.info.id);
  if (!checks.length) return status("This document has no digital signatures");
  await ask(
    "Signatures",
    checks.map((c, i) => ({
      name: `s${i}`,
      label: `${i + 1}. ${c.status}`,
      value: [c.signer && `Signer: ${c.signer.name}${c.signer.email ? ` <${c.signer.email}>` : ""}`, c.signer && `Issued by: ${c.signer.issuer}${c.signer.selfSigned ? " (self-signed)" : ""}`, c.signedAt && `Signed: ${c.signedAt.toLocaleString()}`, c.reason && `Reason: ${c.reason}`].filter(Boolean).join(" · "),
    })),
    "Close",
  );
}
async function signWithCertificate() {
  if (!active) return;
  const t = active;
  const [pfx] = await pickFiles(false, ["pfx", "p12"]);
  if (!pfx) return;
  const r = await ask("Sign with certificate", [
    { name: "pw", label: `Password for ${pfx.name}`, type: "password" },
    { name: "reason", label: "Reason (optional)", placeholder: "e.g. Approved" },
    { name: "location", label: "Location (optional)" },
    { name: "visible", label: "Signature box", type: "select", value: "visible", options: [["visible", "Visible: click on the page to place it"], ["invisible", "Invisible (signature panel only)"]] },
    { name: "image", label: "Include my handwritten signature", type: "select", value: "no", options: [["no", "No"], ["yes", "Yes"]] },
  ], "Continue");
  if (!r) return;
  let signer;
  try {
    signer = await engine.certificateInfo(pfx.data.slice(), r.pw);
  } catch (e) {
    return status((e as Error).message);
  }
  const image = r.image === "yes" ? (await getSignature()) ?? undefined : undefined;
  const finish = async (page?: number, rect?: number[]) => {
    try {
      const { data, info } = await engine.signDigital(t.info.id, { p12: pfx.data.slice(), password: r.pw, page, rect, reason: r.reason || undefined, location: r.location || undefined, image });
      t.info = info;
      const suggested = t.name.replace(/\.pdf$/i, "") + " (signed).pdf";
      const p = await saveFile(data, suggested, null, true);
      if (p) (t.path = p), (t.name = baseName(p));
      t.dirty = false;
      buildView();
      status(`Signed as ${signer.name}${p ? ` and saved to ${p}` : " and downloaded"}. Any later change is saved as a new revision so this signature stays valid.`);
    } catch (e) {
      status(`Signing failed: ${(e as Error).message}`);
    }
  };
  if (r.visible === "invisible") return finish();
  annot.setTool("sign");
  status("Click on the page where the signature box should go (Esc to cancel).");
  pendingPlacement = async (page, at) => {
    pendingPlacement = null;
    annot.setTool("hand");
    await finish(page, [at[0] - 110, at[1] - 30, at[0] + 110, at[1] + 30]);
  };
}
async function createCertificate() {
  const r = await ask("Create a self-signed certificate", [
    { name: "name", label: "Your name", value: localStorage.getItem("hdfstudio.author") ?? "" },
    { name: "email", label: "Email (optional)" },
    { name: "pw", label: "Password to protect the certificate file", type: "password" },
  ], "Create");
  if (!r?.name || !r.pw) return;
  status("Creating a 2048-bit key…");
  const pfx = await engine.makeCertificate(r.name, r.pw, r.email || undefined);
  await saveBytes(`${r.name}.pfx`, pfx);
  status("Certificate created. Self-signed certificates prove the file wasn't changed, but not who you are; use one from your organization or a certificate authority for that.");
}

// ---------- Batch ----------
const batchDeps: BatchDeps = {
  runRecipe: (data, name, recipe, ctx) => engine.runRecipe(data, name, recipe, ctx),
  pickFiles: () => pickFiles(true),
  filesFromList,
  openTabsAsFiles: () => Promise.all(tabs.map(async (t) => ({ name: t.name, path: t.path, data: await engine.save(t.info.id) }))),
  saveMany,
  openOutput: async (name, data) => {
    const info = await engine.open(data, name);
    addTab(info, name, null, true);
    buildView();
  },
};

// ---------- Comments & markup ----------
function refreshPage(i: number) {
  for (const el of [pageEl(i), thumbsEl.children[i]?.querySelector(".page") as HTMLElement | undefined]) {
    if (!el) continue;
    delete el.dataset.scale;
    if (el.dataset.visible === "1" && active) {
      const thumb = el.parentElement?.classList.contains("thumb");
      const scale = thumb ? +((THUMB_W / active.info.pageSizes[i][0]) * dpr()).toFixed(3) : +(active.zoom * dpr()).toFixed(3);
      enqueue({ el, tab: active, page: i, scale });
    }
  }
}
const annot = setupAnnotate({
  engine,
  doc: () => active,
  pagesEl,
  viewer,
  commentsEl: $("#side-comments"),
  refreshPage,
  changed: (label) => {
    if (!active) return;
    active.dirty = true;
    renderTabs();
    status(`${label}. Ctrl+Z to undo.`);
  },
  goToPage,
  status,
  saveText: async (name, text) => void (await saveText(name, text)),
  sign: (page, at) => (pendingPlacement ? pendingPlacement(page, at) : placeSignature(page, at)),
});

// ---------- Edit text & images ----------
const editUI = setupEdit({
  engine,
  doc: () => active,
  pagesEl,
  viewer,
  refreshPage,
  changed: (label) => {
    if (!active) return;
    active.dirty = true;
    renderTabs();
    status(`${label}. Ctrl+Z to undo.`);
  },
  status,
  pickImage: async () => (await pickFiles(false, ["png", "jpg", "jpeg"]))[0]?.data ?? null,
  saveBytes: async (name, data) => void (await saveBytes(name, data)),
});

// ---------- Forms & signatures ----------
let pendingPlacement: ((page: number, at: [number, number]) => Promise<void>) | null = null;
async function placeSignature(page: number, at: [number, number], rect?: number[]) {
  if (!active) return;
  const t = active;
  const png = await getSignature();
  if (!png) return;
  const [pw, ph] = pngSize(png);
  if (!rect) {
    const w = 150, h = (w * ph) / pw;
    rect = [at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2];
  } else {
    // fit inside the field, keeping the aspect ratio
    const [x0, y0, x1, y1] = rect;
    const s = Math.min((x1 - x0) / pw, (y1 - y0) / ph);
    const w = pw * s, h = ph * s;
    rect = [x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0 - h) / 2, x0 + (x1 - x0 + w) / 2, y0 + (y1 - y0 + h) / 2];
  }
  await engine.placeImage(t.info.id, page, rect, png, `Signed by ${localStorage.getItem("hdfstudio.author") || "Reviewer"} on ${new Date().toLocaleDateString()}`);
  t.dirty = true;
  renderTabs();
  refreshPage(page);
  annot.refreshComments();
  status("Signature placed. Drag isn't supported yet: Ctrl+Z to undo and click again to move it. Flatten to lock it in.");
}
const formsUI = setupForms({
  fields: (id) => engine.fields(id),
  setField: (id, page, key, value) => engine.setField(id, page, key, value),
  doc: () => active,
  pageEl,
  refreshPage,
  changed: (label) => {
    if (!active) return;
    active.dirty = true;
    renderTabs();
    status(`${label}. Ctrl+Z to undo.`);
  },
  signField: (f) => placeSignature(f.page, [0, 0], f.rect),
});
async function fillFromCsv() {
  if (!active) return;
  const t = active;
  const [csv] = await pickFiles(false, ["csv", "txt"]);
  if (!csv) return;
  const r = await ask("Fill this form from a spreadsheet", [
    { name: "name", label: "Output file names", value: "{row}", hint: "Use column names in braces, e.g. {Last name} - {Invoice}" },
    { name: "flatten", label: "Flatten (lock the filled values)", type: "select", value: "no", options: [["no", "No"], ["yes", "Yes"]] },
  ], "Create files");
  if (!r) return;
  try {
    const template = await engine.save(t.info.id);
    const out = await engine.mailMerge(template, new TextDecoder().decode(csv.data), { name: r.name, flatten: r.flatten === "yes" });
    const missing = new Set(out.flatMap((o) => o.missing));
    const dir = await saveMany(out);
    status(`Created ${out.length} filled form${out.length === 1 ? "" : "s"}${dir ? ` in ${dir}` : ""}.${missing.size ? ` Columns with no matching field: ${[...missing].join(", ")}` : ""}`);
  } catch (e) {
    status(`Fill from spreadsheet failed: ${(e as Error).message}`);
  }
}
async function exportFormData() {
  if (!active) return;
  const data = await engine.formData(active.info.id);
  const keys = Object.keys(data);
  if (!keys.length) return status("This document has no form fields");
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  await saveText(active.name.replace(/\.pdf$/i, "") + " - data.csv", keys.map(q).join(",") + "\n" + keys.map((k) => q(data[k])).join(",") + "\n");
}
const toolsEl = $("#tools");
for (const t of TOOLS) {
  const b = document.createElement("button");
  b.dataset.tool = t.id;
  b.textContent = t.label;
  b.title = t.title;
  b.onclick = () => annot.setTool(t.id);
  toolsEl.append(b);
}
const colorInput = Object.assign(document.createElement("input"), { type: "color", value: "#d62828", title: "Markup colour (leave as is for each tool's default)" });
colorInput.oninput = () => annot.setColor(colorInput.value.match(/\w\w/g)!.map((h) => parseInt(h, 16) / 255) as [number, number, number]);
const resetColor = Object.assign(document.createElement("button"), { textContent: "Default colours", title: "Use each tool's default colour" });
resetColor.onclick = () => annot.setColor(null);
toolsEl.append(Object.assign(document.createElement("span"), { className: "sep" }), colorInput, resetColor);
annot.setTool("hand");

// ---------- Redaction & security ----------
const redactBtn = Object.assign(document.createElement("button"), { className: "primary hidden", title: "Permanently remove everything marked for redaction" });
redactBtn.onclick = () => applyRedactionsFlow();
async function updateRedactButton() {
  if (!active) return redactBtn.classList.add("hidden");
  let n = 0;
  try {
    n = await engine.redactionCount(active.info.id);
  } catch { /* not a PDF */ }
  redactBtn.textContent = `Apply ${n} redaction${n === 1 ? "" : "s"}`;
  redactBtn.classList.toggle("hidden", n === 0);
}
async function findAndRedact() {
  if (!active) return;
  const t = active;
  const r = await ask("Find and mark for redaction", [
    { name: "kind", label: "Find", type: "select", value: "text", options: [["text", "Text"], ["email", "Email addresses"], ["phone", "Phone numbers"], ["ssn", "US Social Security numbers"], ["card", "Credit card numbers"], ["date", "Dates (numeric)"], ["money", "Money amounts"], ["regex", "Regular expression"]] },
    { name: "q", label: "Text or expression", placeholder: "e.g. Jane Doe   or   ACME-\\d{6}", hint: "Leave empty for the built-in patterns. Marks are reviewable; nothing is removed until you apply." },
    { name: "pages", label: "Pages", value: "all" },
    { name: "case", label: "Match case", type: "select", value: "no", options: [["no", "No"], ["yes", "Yes"]] },
  ], "Mark matches");
  if (!r) return;
  try {
    const pages = parseRanges(r.pages, t.info.pageCount);
    const o = r.kind === "text" ? { text: r.q } : r.kind === "regex" ? { regex: r.q } : { pattern: r.kind as "email" };
    if (("text" in o && !o.text) || ("regex" in o && !o.regex)) return status("Type something to find");
    const n = await engine.markRedactions(t.info.id, { ...o, pages, caseSensitive: r.case === "yes" });
    t.dirty = true;
    for (const p of pages) refreshPage(p);
    renderTabs();
    annot.refreshComments();
    updateRedactButton();
    status(n ? `Marked ${n} match${n === 1 ? "" : "es"} for redaction. Review them in Comments, then click "Apply".` : "No matches");
  } catch (e) {
    status((e as Error).message);
  }
}
async function applyRedactionsFlow() {
  if (!active) return;
  const t = active;
  const n = await engine.redactionCount(t.info.id);
  if (!n) return status("Nothing is marked for redaction. Use the Redact tool (D) or Find and redact.");
  const r = await ask(`Permanently redact ${n} marked area${n === 1 ? "" : "s"}?`, [
    { name: "images", label: "Images under marks", type: "select", value: "pixels", options: [["pixels", "Blank out only the covered pixels"], ["remove", "Remove the whole image"], ["none", "Keep images"]] },
    { name: "boxes", label: "Fill removed areas", type: "select", value: "black", options: [["black", "Black boxes"], ["none", "Leave blank (white)"]] },
    { name: "clean", label: "Also remove hidden data (metadata, scripts, attachments)", type: "select", value: "yes", options: [["yes", "Yes"], ["no", "No"]] },
  ], "Redact permanently");
  if (!r) return;
  const info = await engine.applyRedactions(t.info.id, { images: r.images as "pixels", blackBoxes: r.boxes === "black" });
  if (r.clean === "yes") await engine.sanitize(t.info.id);
  if (!t.saveExtra.includes("sanitize")) t.saveExtra.push("sanitize");
  t.info = info;
  t.dirty = true;
  buildView();
  updateRedactButton();
  status(`Redacted ${n} area${n === 1 ? "" : "s"} on ${info.pagesChanged} page${info.pagesChanged === 1 ? "" : "s"}. The content is removed for good when you save (Ctrl+Z still works until then).`);
}
async function sanitizeFlow() {
  if (!active) return;
  const r = await ask("Remove hidden data", [{ name: "comments", label: "Also remove all comments and markup", type: "select", value: "no", options: [["no", "No, keep comments"], ["yes", "Yes, remove them"]] }], "Remove");
  if (!r) return;
  const rep = await engine.sanitize(active.info.id, { removeComments: r.comments === "yes" });
  if (!active.saveExtra.includes("sanitize")) active.saveExtra.push("sanitize");
  active.dirty = true;
  renderTabs();
  if (rep.comments) buildView();
  status(`Removed: ${[rep.metadata && "metadata", rep.javascript && `${rep.javascript} script(s)`, rep.attachments && `${rep.attachments} attachment(s)`, rep.openAction && "auto-run action", rep.comments && `${rep.comments} comment(s)`].filter(Boolean).join(", ") || "nothing found (metadata cleared)"}. Save to write the clean file.`);
}
async function protectFlow() {
  if (!active) return;
  const r = await ask("Protect with a password (AES-256)", [
    { name: "user", label: "Password to open (optional)", type: "password" },
    { name: "owner", label: "Permissions password (required)", type: "password", hint: "Needed to change the restrictions below." },
    { name: "print", label: "Printing", type: "select", value: "yes", options: [["yes", "Allowed"], ["no", "Not allowed"]] },
    { name: "copy", label: "Copying text and images", type: "select", value: "no", options: [["yes", "Allowed"], ["no", "Not allowed"]] },
    { name: "edit", label: "Editing and page changes", type: "select", value: "no", options: [["yes", "Allowed"], ["no", "Not allowed"]] },
    { name: "comments", label: "Comments and form filling", type: "select", value: "yes", options: [["yes", "Allowed"], ["no", "Not allowed"]] },
  ], "Protect");
  if (!r) return;
  if (!r.owner) return status("A permissions password is required");
  if (/[,=]/.test(r.owner + r.user)) return status("Passwords can't contain commas or equals signs");
  const { protectionOptions } = await import("./engine/redact");
  active.saveExtra = active.saveExtra.filter((o) => o !== "decrypt" && !/^(encrypt|owner-password|user-password|permissions)/.test(o));
  active.saveExtra.push(protectionOptions({ userPassword: r.user || undefined, ownerPassword: r.owner, allowPrint: r.print === "yes", allowCopy: r.copy === "yes", allowEdit: r.edit === "yes", allowComments: r.comments === "yes", allowForms: r.comments === "yes" }));
  active.dirty = true;
  renderTabs();
  status("Protection will be applied when you save (Ctrl+S or Ctrl+Shift+S).");
}
async function unprotectFlow() {
  if (!active) return;
  active.saveExtra = active.saveExtra.filter((o) => !/^(encrypt|owner-password|user-password|permissions)/.test(o));
  active.saveExtra.push("decrypt");
  active.dirty = true;
  renderTabs();
  status((await engine.isEncrypted(active.info.id)) ? "Password protection will be removed when you save." : "This document isn't password protected.");
}
annot.onRedactions(updateRedactButton);
toolsEl.append(redactBtn);

// ---------- Theme ----------
function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("hdfstudio.theme", dark ? "dark" : "light");
}
setTheme((localStorage.getItem("hdfstudio.theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark");

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
  { id: "undo", title: "Undo", keys: "Ctrl+Z", run: () => undoRedo("undo") },
  { id: "redo", title: "Redo", keys: "Ctrl+Y", run: () => undoRedo("redo") },
  { id: "mergeFiles", title: "Merge files into a new document…", keys: "Ctrl+Shift+M", run: () => mergeFiles() },
  { id: "insertFile", title: "Insert pages from files after current page…", run: async () => active && insertFiles(await pickFiles(true), active.page + 1) },
  { id: "insertBlank", title: "Insert blank page after current", run: () => mutate("Inserted blank page", (t) => engine.insertBlank(t.info.id, t.page + 1, t.page)) },
  { id: "splitDoc", title: "Split document…", run: () => splitDocument() },
  { id: "extractPages", title: "Extract pages…", run: () => extractPages() },
  { id: "extractSelected", title: "Extract selected pages to a new tab", run: () => extractPages(targetPages()) },
  { id: "deleteSelected", title: "Delete selected pages", run: () => { const p = targetPages(); if (active && p.length >= active.info.pageCount) return status("Can't delete every page"); return mutate(`Deleted ${p.length} page(s)`, (t) => engine.deletePages(t.info.id, p)).then(() => active?.selected.clear()); } },
  { id: "deletePages", title: "Delete pages…", run: () => rangeOp("Delete pages", "Delete", (p) => mutate(`Deleted ${p.length} page(s)`, (t) => engine.deletePages(t.info.id, p))) },
  { id: "rotateRight", title: "Rotate selected pages right", keys: "Ctrl+]", run: () => { const p = targetPages(); return mutate("Rotated", (t) => engine.rotatePages(t.info.id, p, 90)); } },
  { id: "rotateLeft", title: "Rotate selected pages left", keys: "Ctrl+[", run: () => { const p = targetPages(); return mutate("Rotated", (t) => engine.rotatePages(t.info.id, p, -90)); } },
  { id: "rotatePages", title: "Rotate pages…", run: () => rangeOp("Rotate pages 90° clockwise", "Rotate", (p) => mutate("Rotated", (t) => engine.rotatePages(t.info.id, p, 90))) },
  { id: "reversePages", title: "Reverse page order", run: () => mutate("Reversed page order", (t) => engine.reversePages(t.info.id)) },
  { id: "duplicateSelected", title: "Duplicate selected pages", run: () => { const p = targetPages(); return mutate("Duplicated", (t) => { const n = t.info.pageCount; const order = [...Array(n).keys()]; order.splice(p[p.length - 1] + 1, 0, ...p); return engine.rearrange(t.info.id, order); }); } },
  { id: "selectAll", title: "Select all pages", run: () => { if (!active) return; active.selected = new Set(active.info.pageSizes.keys()); [...thumbsEl.children].forEach((el) => el.classList.add("selected")); showSidePanel("thumbs"); } },
  { id: "batch", title: "Batch: run a recipe on many files…", keys: "Ctrl+B", run: () => openBatch(batchDeps) },
  { id: "recipeCurrent", title: "Apply a recipe to this document (stamp, Bates, watermark, protect…)", run: async () => active && openBatch(batchDeps, { files: [{ name: active.name, path: active.path, data: await engine.save(active.info.id) }] }) },
  { id: "tool-hand", title: "Hand tool / select comments", keys: "V", run: () => annot.setTool("hand") },
  { id: "tool-select", title: "Select text tool", keys: "T", run: () => annot.setTool("select") },
  { id: "tool-highlight", title: "Highlight tool", keys: "H", run: () => annot.setTool("highlight") },
  { id: "tool-underline", title: "Underline tool", keys: "U", run: () => annot.setTool("underline") },
  { id: "tool-strike", title: "Strikeout tool", keys: "K", run: () => annot.setTool("strike") },
  { id: "tool-note", title: "Sticky note tool", keys: "N", run: () => annot.setTool("note") },
  { id: "tool-text", title: "Text box tool", keys: "X", run: () => annot.setTool("text") },
  { id: "tool-rect", title: "Rectangle tool", keys: "R", run: () => annot.setTool("rect") },
  { id: "tool-ellipse", title: "Ellipse tool", keys: "O", run: () => annot.setTool("ellipse") },
  { id: "tool-arrow", title: "Arrow tool", keys: "A", run: () => annot.setTool("arrow") },
  { id: "tool-ink", title: "Pen tool", keys: "P", run: () => annot.setTool("ink") },
  { id: "showComments", title: "Show comments", run: () => (showSidePanel("comments"), annot.refreshComments()) },
  { id: "tool-redact", title: "Redact tool (mark text or area)", keys: "D", run: () => annot.setTool("redact") },
  { id: "findRedact", title: "Find and redact (text, emails, phone numbers, regex)…", keys: "Ctrl+Shift+R", run: () => findAndRedact() },
  { id: "applyRedactions", title: "Apply redactions permanently…", run: () => applyRedactionsFlow() },
  { id: "sanitize", title: "Remove hidden data (metadata, scripts, attachments)…", run: () => sanitizeFlow() },
  { id: "protect", title: "Protect with password and permissions…", run: () => protectFlow() },
  { id: "unprotect", title: "Remove password protection", run: () => unprotectFlow() },
  { id: "tool-sign", title: "Sign: place your signature", keys: "G", run: () => annot.setTool("sign") },
  { id: "newSignature", title: "Create a new signature…", run: async () => { clearSignature(); if (await getSignature(true)) annot.setTool("sign"); } },
  { id: "tool-edit", title: "Edit tool: change page text and images", keys: "E", run: () => annot.setTool("edit") },
  { id: "insertImage", title: "Insert image…", run: () => (annot.setTool("edit"), editUI.insertImage()) },
  { id: "replaceImage", title: "Replace selected image…", run: () => editUI.replaceSelectedImage() },
  { id: "saveImage", title: "Save selected image as PNG…", run: () => editUI.saveSelectedImage() },
  { id: "textStyle", title: "Font, size and colour for new text…", run: () => editUI.setTextStyle() },
  { id: "signCert", title: "Sign with a certificate (.pfx / .p12)…", run: () => signWithCertificate() },
  { id: "verifySigs", title: "Validate signatures", run: () => showSignatureDetails() },
  { id: "makeCert", title: "Create a self-signed certificate…", run: () => createCertificate() },
  { id: "fillCsv", title: "Fill form from a spreadsheet (CSV), one file per row…", run: () => fillFromCsv() },
  { id: "exportForm", title: "Export form data (CSV)", run: () => exportFormData() },
  { id: "clearForm", title: "Clear all form fields", run: async () => { if (!active) return; await engine.clearForm(active.info.id); active.dirty = true; buildView(); } },
  { id: "flatten", title: "Flatten comments and form fields…", run: async () => { if (!active) return; const r = await ask("Flatten", [{ name: "w", label: "What to flatten", type: "select", value: "both", options: [["both", "Comments and form fields"], ["fields", "Form fields only"], ["comments", "Comments only"]] }], "Flatten"); if (!r) return; active.info = await engine.flatten(active.info.id, r.w !== "fields", r.w !== "comments"); active.dirty = true; buildView(); status("Flattened. Ctrl+Z to undo."); } },
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
  if (e.key === "Escape") pendingPlacement = null;
  if (!cmd) {
    if (e.key === "Escape") closePalette();
    return;
  }
  // Plain navigation keys shouldn't fire while typing in a field.
  if (typing && ((!ks.includes("Ctrl") && !ks.startsWith("F")) || cmd.id === "undo" || cmd.id === "redo")) return;
  e.preventDefault();
  setTimeout(() => cmd.run(), 0);
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
    e.preventDefault();
    closePalette();
    const cmd = list[paletteSel];
    setTimeout(() => cmd.run(), 0); // let this keystroke finish before a dialog takes focus
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
Object.assign(window, { hdfStudio: { openFiles, runSearch, goToPage, commands, get active() { return active; } } });
buildView();
