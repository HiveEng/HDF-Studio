import { createEngine } from "./engine/client";
import type { DocInfo, SearchHit } from "./engine/core";
import { pickFiles, filesFromList, saveFile, saveMany, saveText, saveBytes, baseName, isTauri, tsaRequest, openExternal, graphFetch, type OpenedFile } from "./platform";
import { TSA_SERVERS } from "./engine/tsa-servers";
import { OCR_LANGUAGES, BUNDLED_LANGS, langSource } from "./ocr/languages";
import { setupAnnotate, type Tool } from "./ui/annotate";
import { setupEngineering, ENG_TOOLS, type EngTool } from "./ui/engineering";
import { setupChest } from "./ui/chest";
import { setupFindReplace } from "./ui/findreplace";
import { setupSpell } from "./ui/spell";
import { setupSignIn } from "./ui/signin";
import { openSettings } from "./ui/settings";
import { setupNav } from "./ui/navpanels";
import { showMenu, type MenuItem } from "./ui/contextmenu";
import type { AnnotInfo } from "./engine/annotations";
import { setupRibbon, icon, taskOf } from "./ui/ribbon";
import * as I from "lucide";
import { setupForms } from "./ui/forms";
import { setupFormDesign } from "./ui/formdesign";
import { setupEdit } from "./ui/edit";
import { getSignature, clearSignature, pngSize } from "./ui/signature";
import { parseRanges, formatRanges } from "./engine/ranges";
import { ask, confirmDialog, type Field } from "./ui/dialog";
import { openBatch, type BatchDeps } from "./ui/batch";
import { showProgress } from "./ui/progress";
import { ocrBytes, ocrStep, cleanStep } from "./ocr/pipeline";
import { startWatching, openWatchPanel } from "./ui/watch";
import { showCheckReport } from "./ui/check";
import { showAltTextDialog } from "./ui/accessibility";
import { printPages } from "./ui/print";
import { checkForUpdates } from "./ui/update";
import type { WatchFs } from "./automation/watch";

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
  /** Pages without text, checked once on open (null = not checked yet); hidden once dismissed. */
  scanned?: number[] | null;
  scanNoticeDismissed?: boolean;
  /** Summary shown on a compare report tab. */
  compareNote?: string;
  /** Opened from (or saved to) OneDrive / SharePoint: Save writes back there. */
  cloud?: import("./cloud/graph").CloudRef;
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
const status = (msg: string) => {
  const el = $("#statusText");
  el.textContent = msg;
  el.title = msg; // full text on hover when it's cut short
  return msg;
};

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
/** Set once the ribbon exists: greys out document commands when nothing is open. */
let onDocState: (has: boolean) => void = () => {};
function buildView() {
  onDocState(!!active);
  pageObserver.disconnect();
  thumbObserver.disconnect();
  queue.length = 0;
  pagesEl.replaceChildren();
  thumbsEl.replaceChildren();
  outlineEl.replaceChildren();
  $("#empty").classList.toggle("hidden", !!active);
  $("#viewbar").classList.toggle("hidden", !active);
  document.body.classList.toggle("nodoc", !active);
  if (!active) renderRecent();
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
  void navUI?.refresh();
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
  showScanNotice();
  const shown = active;
  formsUI.render().then(() => {
    designUI.refresh();
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
      if (f.path) remember(f.path);
      status(`${f.name}: ${info.pageCount} page${info.pageCount === 1 ? "" : "s"}`);
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
    el.title = t.cloud ? `${t.cloud.where} › ${t.cloud.name} (OneDrive/SharePoint)` : t.path ?? t.name;
    if (t.cloud) el.classList.add("cloud");
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
  document.title = active ? `${active.name} - HDS` : "HDS";
}
async function saveBytesOf(t: Tab) {
  // Signed files must be saved incrementally, or the existing signatures would break.
  const signed = await engine.hasSignatures(t.info.id);
  return engine.save(t.info.id, signed ? "incremental" : ["garbage", "compress", ...t.saveExtra].join(","));
}

// ---------- OneDrive and SharePoint ----------
let graphClient: import("./cloud/graph").Graph | null = null;
async function graph() {
  if (!graphClient) {
    const { Graph, GRAPH_SCOPES } = await import("./cloud/graph");
    graphClient = new Graph(graphFetch, !isTauri && localStorage.getItem("hdfstudio.cloudTest") ? async () => "test" : () => signIn.auth.accessToken(GRAPH_SCOPES));
  }
  return graphClient;
}
async function openFromCloud() {
  if (!isTauri && !localStorage.getItem("hdfstudio.cloudTest")) return status("OneDrive and SharePoint work in the HDS desktop app.");
  const { browseCloud } = await import("./ui/cloud");
  const g = await graph();
  const pick = await browseCloud(g, { mode: "open" });
  if (!pick || pick.mode !== "open") return;
  await openCloudItem({ driveId: pick.item.driveId, itemId: pick.item.id, parentId: pick.item.parentId, eTag: pick.item.eTag, name: pick.item.name, webUrl: pick.item.webUrl, where: pick.where });
}
async function openCloudItem(ref: import("./cloud/graph").CloudRef) {
  const g = await graph();
  try {
    status(`Downloading ${ref.name}…`);
    // Fresh details (the eTag guards Save against overwriting someone else's changes).
    const it = await g.item(ref.driveId, ref.itemId);
    const data = await g.download(it.driveId || ref.driveId, it.id);
    const { canOpen, needsOffice } = await import("./engine/convert");
    if (needsOffice(it.name)) return createPdf([{ name: it.name, path: null, data }]);
    if (!canOpen(it.name)) return status(`${it.name}: HDS can't open this kind of file`);
    const before = tabs.length;
    await openFiles([{ name: it.name, path: null, data }]);
    const t = tabs[before];
    if (t && /\.pdf$/i.test(it.name)) {
      t.cloud = { ...ref, driveId: it.driveId || ref.driveId, itemId: it.id, parentId: it.parentId ?? ref.parentId, eTag: it.eTag, name: it.name, webUrl: it.webUrl ?? ref.webUrl };
      rememberCloud(t.cloud);
      renderTabs();
      status(`${it.name} from ${ref.where}. Ctrl+S saves it back there.`);
    }
  } catch (e) {
    status(`Could not open ${ref.name}: ${(e as Error).message}`);
  }
}
/** Save the tab to OneDrive/SharePoint: back to where it came from, or (saveAs) to a place the user picks. */
async function saveToCloud(t: Tab, saveAs: boolean): Promise<boolean> {
  const g = await graph();
  const bytes = await saveBytesOf(t);
  try {
    if (t.cloud && !saveAs) {
      status(`Saving ${t.cloud.name} to ${t.cloud.where}…`);
      let it;
      try {
        it = await g.upload({ driveId: t.cloud.driveId, itemId: t.cloud.itemId, eTag: t.cloud.eTag, data: bytes });
      } catch (e) {
        if ((e as { status?: number }).status !== 412) throw e;
        const r = await ask(`${t.cloud.name} was changed by someone else since you opened it`, [
          { name: "how", label: "What now?", type: "select", value: "copy", options: [["copy", "Save my version as a copy next to it"], ["overwrite", "Replace their changes with mine"]] },
        ], "Save");
        if (!r) return false;
        if (r.how === "overwrite") it = await g.upload({ driveId: t.cloud.driveId, itemId: t.cloud.itemId, data: bytes });
        else {
          const name = t.cloud.name.replace(/(\.pdf)?$/i, ` (${localStorage.getItem("hdfstudio.author") || "my copy"})$1`);
          it = await g.upload({ driveId: t.cloud.driveId, parentId: t.cloud.parentId, name, data: bytes });
        }
      }
      t.cloud = { ...t.cloud, itemId: it.id, eTag: it.eTag, name: it.name, parentId: it.parentId ?? t.cloud.parentId };
    } else {
      if (!isTauri && !localStorage.getItem("hdfstudio.cloudTest")) return (status("OneDrive and SharePoint work in the HDS desktop app."), false);
      const { browseCloud } = await import("./ui/cloud");
      const pick = await browseCloud(g, { mode: "save", name: t.cloud?.name ?? (/\.pdf$/i.test(t.name) ? t.name : `${t.name}.pdf`) });
      if (!pick || pick.mode !== "save") return false;
      if (pick.existing && !(await confirmDialog(`${pick.name} already exists in ${pick.where}. Replace it?`, "Replace"))) return false;
      status(`Saving ${pick.name} to ${pick.where}…`);
      const it = pick.existing
        ? await g.upload({ driveId: pick.driveId, itemId: pick.existing.id, data: bytes })
        : await g.upload({ driveId: pick.driveId, parentId: pick.parentId, name: pick.name, data: bytes });
      t.cloud = { driveId: pick.driveId, itemId: it.id, parentId: pick.parentId, eTag: it.eTag, name: it.name, webUrl: it.webUrl, where: pick.where };
      t.path = null;
    }
    t.name = t.cloud.name;
    t.dirty = false;
    rememberCloud(t.cloud);
    renderTabs();
    status(`Saved ${t.cloud.name} to ${t.cloud.where}`);
    return true;
  } catch (e) {
    status(`Save to OneDrive/SharePoint failed: ${(e as Error).message}. Your changes are still open here.`);
    return false;
  }
}

async function save(saveAs: boolean) {
  if (!active) return;
  const t = active;
  if (t.cloud && !saveAs) return void (await saveToCloud(t, false));
  const bytes = await saveBytesOf(t);
  const p = await saveFile(bytes, t.name, t.path, saveAs);
  if (p) {
    t.path = p;
    t.name = baseName(p);
    t.cloud = undefined;
    remember(p);
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
  const dropped = await filesFromList(e.dataTransfer?.files ?? null);
  const { canOpen, needsOffice } = await import("./engine/convert");
  const office = dropped.filter((f) => needsOffice(f.name));
  openFiles(dropped.filter((f) => canOpen(f.name)));
  if (office.length) createPdf(office);
});

// ---------- Sidebar ----------
const SIDE_TITLES: Record<string, string> = { thumbs: "Pages", outline: "Bookmarks", results: "Search results", comments: "Comments", attach: "Attached files", layers: "Layers", chest: "Tool chest", spell: "Spelling" };
function showSidePanel(name: string) {
  $("main").classList.remove("no-sidebar");
  $("#thumb-tools").classList.toggle("hidden", name !== "thumbs");
  $("#sideTitle").textContent = SIDE_TITLES[name] ?? "";
  document.querySelectorAll<HTMLElement>("#rail button").forEach((b) => b.classList.toggle("active", b.dataset.side === name));
  document.querySelectorAll<HTMLElement>(".side-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `side-${name}`));
}
// Clicking the open panel's icon again folds the sidebar away.
document.querySelectorAll<HTMLElement>("#rail button").forEach(
  (b) =>
    (b.onclick = () => {
      const main = $("main");
      if (b.classList.contains("active") && !main.classList.contains("no-sidebar")) return main.classList.add("no-sidebar");
      showSidePanel(b.dataset.side!);
      if (b.dataset.side === "comments") annot.refreshComments();
      if (b.dataset.side === "attach") void navUI.loadAttachments();
      if (b.dataset.side === "layers") void navUI.loadLayers();
      if (b.dataset.side === "chest") chestUI.render();
    }),
);

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
  eng.forgetScales();
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

// ---------- Compare ----------
/**
 * Compare two versions. The newer one is copied into a new tab with every change marked as a
 * comment, so the Comments panel lists the changes and clicking one jumps to it.
 */
function compareModeFields(): Field[] {
  const saved = JSON.parse(localStorage.getItem("hdfstudio.compare") ?? "{}") as Record<string, string>;
  return [
    { name: "mode", label: "Show the changes as", type: "select", value: saved.mode ?? "report", options: [["report", "Change report: changes marked on the newer version, with a list"], ["overlay", "Overlay: both versions on top of each other in two colours"], ["side", "Side by side: older and newer on one sheet, zoom and scroll together"]] },
    { name: "align", label: "Overlay alignment", type: "select", value: saved.align ?? "auto", options: [["auto", "Automatic (lines up drawings that moved)"], ["corner", "Page corners"], ["center", "Page centres"]] },
    { name: "colors", label: "Overlay colours", type: "select", value: saved.colors ?? "red-blue", options: [["red-blue", "Older red, newer blue"], ["red-green", "Older red, newer green"]] },
  ];
}

async function compareFiles() {
  type Side = { name: string; id: number; temp: boolean };
  const temps: number[] = [];
  const openTemp = async (f: OpenedFile): Promise<Side> => {
    const info = await engine.open(f.data, f.name);
    temps.push(info.id);
    if (info.needsPassword) throw new Error(`${f.name} is password protected; open it in a tab first`);
    return { name: f.name, id: info.id, temp: true };
  };
  try {
    let a: Side, b: Side, visual = true;
    let mode = "report", align = "auto", colors = "red-blue";
    if (active) {
      const others = tabs.filter((t) => t !== active);
      const r = await ask(
        `Compare ${active.name}`,
        [
          { name: "with", label: "Compare with", type: "select", value: others[0] ? "0" : "file", options: [...others.map((t, i): [string, string] => [String(i), t.name]), ["file", "Choose a file…"]] },
          { name: "role", label: `${active.name} is the`, type: "select", value: "new", options: [["new", "Newer version (changes are marked on it)"], ["old", "Older version"]] },
          ...compareModeFields(),
          { name: "visual", label: "Report: also compare images and drawings", type: "select", value: "yes", options: [["yes", "Yes, on pages whose text is unchanged"], ["no", "No, text only"]] },
        ],
        "Compare",
      );
      if (!r) return;
      visual = r.visual === "yes";
      ({ mode, align, colors } = r);
      let other: Side;
      if (r.with === "file") {
        const [f] = await pickFiles(false);
        if (!f) return;
        other = await openTemp(f);
      } else other = { name: others[+r.with].name, id: others[+r.with].info.id, temp: false };
      const me: Side = { name: active.name, id: active.info.id, temp: false };
      [a, b] = r.role === "new" ? [other, me] : [me, other];
    } else {
      const files = await pickFiles(true);
      if (files.length !== 2) return files.length && status("Choose exactly two files to compare: the older and the newer version");
      const r = await ask("Compare files", [{ name: "old", label: "Older version", type: "select", value: "0", options: files.map((f, i): [string, string] => [String(i), f.name]) }, ...compareModeFields()], "Compare");
      if (!r) return;
      ({ mode, align, colors } = r);
      const [o, n] = r.old === "0" ? files : [files[1], files[0]];
      a = await openTemp(o);
      b = await openTemp(n);
    }
    localStorage.setItem("hdfstudio.compare", JSON.stringify({ mode, align, colors }));
    const stem = (n: string) => n.replace(/\.pdf$/i, "");
    if (mode === "overlay" || mode === "side") {
      status(mode === "overlay" ? "Building overlay…" : "Building side-by-side view…");
      const o = { align: align as "corner" | "center" | "auto", colors: colors as "red-blue" | "red-green", oldName: a.name, newName: b.name };
      const data = mode === "overlay" ? (await engine.overlayCompare(a.id, b.id, o)).data : await engine.sideBySide(a.id, b.id, o);
      const info = await engine.open(data, "compare.pdf");
      const tab = addTab(info, `${mode === "overlay" ? "Overlay" : "Side by side"} - ${stem(a.name)} vs ${stem(b.name)}.pdf`, null, true);
      tab.compareNote = mode === "overlay"
        ? `Overlay of ${a.name} (red, removed) and ${b.name} (${colors === "red-green" ? "green" : "blue"}, added). Dark lines are unchanged.`
        : `${a.name} on the left, ${b.name} on the right. Zoom and scroll move both together.`;
      tab.scanNoticeDismissed = true;
      buildView();
      return status(mode === "overlay" ? "Overlay ready. Red is only in the older version, " + (colors === "red-green" ? "green" : "blue") + " only in the newer one." : "Side-by-side view ready.");
    }
    status("Comparing…");
    const started = performance.now();
    const { data, result } = await engine.compareReport(a.id, b.id, a.name, { visual });
    const s = result.summary;
    const total = result.changes.length;
    const info = await engine.open(data, "compare.pdf");
    const tab = addTab(info, `Compare - ${stem(a.name)} vs ${stem(b.name)}.pdf`, null, true);
    tab.compareNote = total
      ? `${total} change${total === 1 ? "" : "s"} from ${a.name}: ${[s.replaced && `${s.replaced} replaced`, s.inserted && `${s.inserted} inserted`, s.deleted && `${s.deleted} deleted`, s.visual && `${s.visual} graphic`].filter(Boolean).join(", ")}.${result.coarse ? " The files differ a lot, so pages were compared one by one." : ""}`
      : `No differences found between ${a.name} and ${b.name}.`;
    tab.scanNoticeDismissed = true;
    buildView();
    showSidePanel("comments");
    annot.refreshComments();
    status(`Compared in ${((performance.now() - started) / 1000).toFixed(1)} s. Click a change in the Comments panel to jump to it.`);
  } catch (e) {
    status(`Compare failed: ${(e as Error).message}`);
  } finally {
    for (const id of temps) await engine.close(id);
  }
}

// ---------- Print ----------
async function printDoc() {
  if (!active) return;
  const t = active;
  const saved = JSON.parse(localStorage.getItem("hdfstudio.print") ?? "{}") as Record<string, string>;
  const r = await ask(`Print ${t.name}`, [
    { name: "which", label: "Pages", type: "select", value: t.selected.size > 1 ? "selected" : "all", options: [["all", `All pages (${t.info.pageCount})`], ["current", `Current page (${t.page + 1})`], ...(t.selected.size > 1 ? [["selected", `Selected pages (${formatRanges(targetPages())})`] as [string, string]] : []), ["range", "Page range…"]] },
    { name: "range", label: "Or a page range", value: "", placeholder: 'e.g. "1-3, 7, 10-", "odd", "even"' },
    { name: "fit", label: "Size", type: "select", value: saved.fit ?? "actual", options: [["actual", "Actual size (keeps drawings to scale)"], ["fit", "Fit to paper"]], hint: "Actual size prints each page at its own size, so use paper that matches (e.g. 11x17 or ARCH D for drawings). Choose the printer, paper, copies and colour in the next window." },
    { name: "markups", label: "Include", type: "select", value: saved.markups ?? "yes", options: [["yes", "Document and markups"], ["no", "Document only (no comments or form fields)"]] },
    { name: "dpi", label: "Quality", type: "select", value: saved.dpi ?? "300", options: [["150", "Draft (150 dpi, faster)"], ["300", "Standard (300 dpi)"], ["600", "High (600 dpi, for fine drawing detail)"]] },
  ], "Print…");
  if (!r) return;
  localStorage.setItem("hdfstudio.print", JSON.stringify({ fit: r.fit, markups: r.markups, dpi: r.dpi }));
  let pages: number[];
  try {
    if (r.range.trim() && r.which === "all") r.which = "range";
    pages = r.which === "all" ? [...Array(t.info.pageCount).keys()] : r.which === "current" ? [t.page] : r.which === "selected" ? targetPages() : parseRanges(r.range, t.info.pageCount);
  } catch (e) {
    return status(`Print: ${(e as Error).message}`);
  }
  if (!pages.length) return status("Print: no pages in that range");
  const prog = showProgress("Preparing to print");
  try {
    const ok = await printPages({
      pages,
      sizes: t.info.pageSizes,
      dpi: +r.dpi,
      markups: r.markups === "yes",
      fit: r.fit === "fit" ? "fit" : "actual",
      render: (page, dpi, markups) => engine.printImage(t.info.id, page, dpi, markups),
      progress: prog,
    });
    status(ok ? `Sent ${pages.length} page${pages.length === 1 ? "" : "s"} to the print dialog` : "Printing cancelled");
  } catch (e) {
    status(`Print failed: ${(e as Error).message}`);
  } finally {
    prog.close();
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


// ---------- OCR: make scanned pages searchable ----------
const scanBanner = Object.assign(document.createElement("div"), { id: "scanbanner", className: "notice hidden" });
$("#sigbanner").after(scanBanner);
async function showScanNotice() {
  scanBanner.classList.add("hidden");
  const t = active;
  if (t?.compareNote) {
    scanBanner.replaceChildren(
      icon(I.GitCompare, 16),
      Object.assign(document.createElement("span"), { textContent: t.compareNote }),
      ...(t.name.startsWith("Compare -") ? [Object.assign(document.createElement("button"), { className: "primary", textContent: "Show changes", onclick: () => (showSidePanel("comments"), annot.refreshComments()) })] : []),
    );
    scanBanner.classList.remove("hidden");
    return;
  }
  // No "looks scanned" prompt on open: OCR is on the Home tab when it is wanted.
}
let recognizer: { langs: string; rec: Promise<import("./ocr/recognize").Recognizer> } | null = null;
let ocrPageProgress: (f: number) => void = () => {};
const ocrLangs = () => localStorage.getItem("hdfstudio.ocrLangs") || "eng";
function getRecognizer(langs = ocrLangs()) {
  if (recognizer?.langs !== langs) {
    recognizer?.rec.then((r) => r.terminate()).catch(() => {});
    // Worker, engine and English data ship with the app (see scripts/ocr-assets.mjs): no internet needed.
    // Other languages download once from the CDN and are cached in the app's storage.
    const base = new URL("/ocr/", location.href).href;
    const { langPath } = langSource(langs, base + "lang");
    const rec = import("./ocr/recognize").then((m) =>
      m.createRecognizer(langs, { workerPath: base + "worker.min.js", corePath: base, langPath, cacheMethod: "write", gzip: true, workerBlobURL: false }, (f) => ocrPageProgress(f)),
    );
    const entry = { langs, rec };
    recognizer = entry;
    rec.catch(() => recognizer === entry && (recognizer = null));
  }
  return recognizer.rec;
}
// ---------- Scan cleanup (before OCR) ----------
const CLEAN_OPTIONS: [string, string][] = [["all", "Straighten, remove specks and blank pages"], ["straighten", "Straighten only"], ["none", "No cleanup"]];
const cleanOpts = (c: string) => ({ straighten: c !== "none", despeckle: c === "all", removeBlank: c === "all" });
/** Clean `pages` of the active tab. Returns the surviving pages (renumbered after blank pages go). */
async function runCleanup(t: Tab, pages: number[], o: { straighten?: boolean; despeckle?: boolean; removeBlank?: boolean }): Promise<number[]> {
  status(`Cleaning up ${pages.length} page${pages.length === 1 ? "" : "s"}…`);
  const { info, report } = await engine.cleanScans(t.info.id, pages, o);
  t.info = info;
  t.dirty = true;
  t.hits = [];
  t.scanned = null;
  t.selected.clear();
  t.page = Math.min(t.page, info.pageCount - 1);
  if (t === active) buildView(), void showScanNotice();
  const parts = [
    report.straightened.length && `straightened ${report.straightened.length} page${report.straightened.length === 1 ? "" : "s"} (${report.straightened.map((s) => `page ${s.page + 1} by ${Math.abs(s.degrees).toFixed(1)}°`).join(", ")})`,
    report.despeckled.length && `removed specks on ${report.despeckled.length}`,
    report.removed.length && `removed ${report.removed.length} blank page${report.removed.length === 1 ? "" : "s"} (${report.removed.map((p) => p + 1).join(", ")})`,
    report.skipped.length && `left ${report.skipped.length} page${report.skipped.length === 1 ? "" : "s"} with real text alone`,
  ].filter(Boolean);
  status(parts.length ? `Cleanup: ${parts.join("; ")}. Ctrl+Z to undo.` : "Cleanup: the pages were already straight and clean.");
  const gone = new Set(report.removed);
  return pages.filter((p) => !gone.has(p)).map((p) => p - report.removed.filter((r) => r < p).length);
}
async function cleanScansFlow() {
  if (!active) return;
  const t = active;
  const scanned = await engine.pagesWithoutText(t.info.id);
  const saved = JSON.parse(localStorage.getItem("hdfstudio.clean") ?? "{}");
  const yesNo: [string, string][] = [["yes", "Yes"], ["no", "No"]];
  const r = await ask("Clean up scans", [
    { name: "which", label: "Pages", type: "select", value: scanned.length ? "scanned" : "current", options: [["scanned", `Scanned pages (${scanned.length})`], ["current", `Current page (${t.page + 1})`], ["range", "Page range…"]], hint: "Only pages without real text are changed. Run this before recognizing text (OCR)." },
    { name: "range", label: "Page range (if chosen above)", placeholder: "e.g. 1-3, 8", value: "" },
    { name: "straighten", label: "Straighten crooked pages", type: "select", value: saved.straighten ?? "yes", options: yesNo },
    { name: "despeckle", label: "Remove specks of dust and toner", type: "select", value: saved.despeckle ?? "yes", options: yesNo },
    { name: "removeBlank", label: "Delete blank pages", type: "select", value: saved.removeBlank ?? "yes", options: yesNo, hint: "Blank backs of double-sided scans, separator sheets." },
  ], "Clean up");
  if (!r) return;
  localStorage.setItem("hdfstudio.clean", JSON.stringify({ straighten: r.straighten, despeckle: r.despeckle, removeBlank: r.removeBlank }));
  let pages: number[];
  try {
    pages = r.which === "scanned" ? scanned : r.which === "current" ? [t.page] : parseRanges(r.range, t.info.pageCount);
  } catch (e) {
    return status((e as Error).message);
  }
  if (!pages.length) return status("No scanned pages to clean up. Pick the current page or a range to try anyway.");
  try {
    await runCleanup(t, pages, { straighten: r.straighten === "yes", despeckle: r.despeckle === "yes", removeBlank: r.removeBlank === "yes" });
  } catch (e) {
    status(`Cleanup failed: ${(e as Error).message ?? e}`);
  }
}

async function recognizeText(pagesArg?: number[]) {
  if (!active) return;
  const t = active;
  let pages = pagesArg;
  if (!pages) {
    const scanned = await engine.pagesWithoutText(t.info.id);
    const r = await ask(
      "Recognize text (OCR)",
      [
        {
          name: "which", label: "Pages", type: "select", value: scanned.length ? "scanned" : "current",
          options: [["scanned", `Pages without text (${scanned.length})`], ["all", `All pages (${t.info.pageCount})`], ["current", `Current page (${t.page + 1})`], ["range", "Page range…"]],
          hint: "Adds an invisible text layer over the scan. The page looks the same but becomes searchable and copyable.",
        },
        { name: "range", label: "Page range (if chosen above)", placeholder: "e.g. 1-3, 8", value: "" },
        { name: "lang", label: "Language", type: "select", value: ocrLangs().split("+")[0], options: OCR_LANGUAGES.map(([c, n]): [string, string] => [c, BUNDLED_LANGS.has(c) ? n : `${n} (downloads once)`]) },
        { name: "lang2", label: "Second language (optional)", type: "select", value: ocrLangs().split("+")[1] ?? "", options: [["", "None"], ...OCR_LANGUAGES.map(([c, n]): [string, string] => [c, n])], hint: "For documents that mix two languages." },
        { name: "clean", label: "Clean up first", type: "select", value: localStorage.getItem("hdfstudio.ocrClean") ?? "straighten", options: CLEAN_OPTIONS, hint: "Straight, clean pages recognize better. Only pages without text are changed." },
      ],
      "Recognize",
    );
    if (!r) return;
    localStorage.setItem("hdfstudio.ocrLangs", [...new Set([r.lang, r.lang2].filter(Boolean))].join("+"));
    try {
      pages = r.which === "scanned" ? scanned : r.which === "all" ? [...Array(t.info.pageCount).keys()] : r.which === "current" ? [t.page] : parseRanges(r.range, t.info.pageCount);
    } catch (e) {
      return status((e as Error).message);
    }
    if (!pages.length) return status("Every page already has text. Choose All pages to recognize them anyway.");
    localStorage.setItem("hdfstudio.ocrClean", r.clean);
    if (r.clean !== "none") {
      try {
        pages = await runCleanup(t, pages, cleanOpts(r.clean));
      } catch (e) {
        status(`Cleanup failed, recognizing anyway: ${(e as Error).message ?? e}`);
      }
      if (!pages.length) return;
    }
  }
  const prog = showProgress("Recognizing text");
  const done: { page: number; lines: import("./engine/ocr").OcrLine[] }[] = [];
  const started = Date.now();
  try {
    const langs = ocrLangs();
    prog.set(0, langSource(langs, "").needsDownload ? "Starting the OCR engine (the first use of a language downloads it)…" : "Starting the OCR engine…");
    const rec = await getRecognizer(langs);
    for (const [k, p] of pages.entries()) {
      if (prog.cancelled) break;
      ocrPageProgress = (f) => prog.set((k + f) / pages!.length, `Page ${p + 1} (${k + 1} of ${pages!.length})`);
      ocrPageProgress(0);
      const img = await engine.ocrImage(t.info.id, p, 300);
      done.push({ page: p, lines: await rec.recognize(img.png, img.scale) });
    }
    const words = done.length ? await engine.addTextLayer(t.info.id, done) : 0;
    if (done.length) {
      t.dirty = true;
      t.scanned = null;
      t.hits = [];
      if (t === active) buildView();
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    status(`${prog.cancelled ? "Stopped. " : ""}Recognized ${words} words on ${done.length} page${done.length === 1 ? "" : "s"} in ${secs} s. Search and copy now work. Ctrl+Z to undo.`);
  } catch (e) {
    status(`OCR failed: ${(e as Error).message ?? e}`);
  } finally {
    ocrPageProgress = () => {};
    prog.close();
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
      value: [c.signer && `Signer: ${c.signer.name}${c.signer.email ? ` <${c.signer.email}>` : ""}`, c.signer && `Issued by: ${c.signer.issuer}${c.signer.selfSigned ? " (self-signed)" : ""}`, c.signedAt && `Signed: ${c.signedAt.toLocaleString()}${c.timestamp?.tokenSignatureValid ? " (trusted timestamp)" : ""}`, c.timestamp && `Timestamp: ${c.timestamp.authority}${c.timestamp.imprintMatches && c.timestamp.tokenSignatureValid ? "" : " (could not be verified)"}`, c.reason && `Reason: ${c.reason}`].filter(Boolean).join(" · "),
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
    {
      name: "tsa", label: "Trusted timestamp", type: "select", value: localStorage.getItem("hdfstudio.tsa") ?? TSA_SERVERS[0].url,
      options: [...TSA_SERVERS.map((s): [string, string] => [s.url, `${s.name} (free)`]), ["custom", "Other server…"], ["", "None"]],
      hint: "Proves when you signed, so the signature stays valid after your certificate expires. Needs internet.",
    },
  ], "Continue");
  if (!r) return;
  if (r.tsa === "custom") {
    const c = await ask("Timestamp server", [{ name: "url", label: "Server address (RFC 3161)", value: localStorage.getItem("hdfstudio.tsaCustom") ?? "https://" }], "Use");
    if (!c?.url) return;
    localStorage.setItem("hdfstudio.tsaCustom", c.url);
    r.tsa = c.url;
  }
  localStorage.setItem("hdfstudio.tsa", TSA_SERVERS.some((s) => s.url === r.tsa) || !r.tsa ? r.tsa : "custom");
  let signer;
  try {
    signer = await engine.certificateInfo(pfx.data.slice(), r.pw);
  } catch (e) {
    return status((e as Error).message);
  }
  const image = r.image === "yes" ? (await getSignature()) ?? undefined : undefined;
  const finish = async (page?: number, rect?: number[]) => {
    try {
      let { data, info, tsq } = await engine.signDigital(t.info.id, { p12: pfx.data.slice(), password: r.pw, page, rect, reason: r.reason || undefined, location: r.location || undefined, image, timestamp: !!r.tsa });
      let stampNote = "";
      if (tsq) {
        status("Signed. Getting a trusted timestamp…");
        try {
          const resp = await tsaRequest(r.tsa, tsq);
          ({ data, info } = await engine.addTimestamp(t.info.id, data, resp));
          stampNote = " with a trusted timestamp";
        } catch (e) {
          stampNote = ` without a timestamp (${(e as Error).message})`;
        }
      }
      t.info = info;
      const suggested = t.name.replace(/\.pdf$/i, "") + " (signed).pdf";
      const p = await saveFile(data, suggested, null, true);
      if (p) (t.path = p), (t.name = baseName(p));
      t.dirty = false;
      buildView();
      status(`Signed as ${signer.name}${stampNote}${p ? ` and saved to ${p}` : " and downloaded"}. Any later change is saved as a new revision so this signature stays valid.`);
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

// ---------- Create & convert ----------
const CREATE_EXT = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "html", "htm", "txt", "epub", "xps", "cbz", "svg", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"];
async function createPdf(files?: OpenedFile[]) {
  files ??= await pickFiles(true, CREATE_EXT);
  if (!files.length) return;
  const r = await ask(`Create a PDF from ${files.length} file${files.length > 1 ? "s" : ""}`, [
    { name: "size", label: "Page size for images and text", type: "select", value: "auto", options: [["auto", "Keep original size"], ["letter", "Letter"], ["a4", "A4"], ["legal", "Legal"], ["a3", "A3"]] },
    { name: "mode", label: "Output", type: "select", value: "one", options: [["one", "One combined PDF"], ["each", "One PDF per file"]] },
  ], "Create");
  if (!r) return;
  const { needsOffice } = await import("./engine/convert");
  try {
    const inputs: OpenedFile[] = [];
    for (const f of files) {
      if (!needsOffice(f.name)) inputs.push(f);
      else if (!isTauri) throw new Error(`${f.name}: Office files are converted with LibreOffice in the desktop app`);
      else {
        status(`Converting ${f.name} with LibreOffice…`);
        const { invoke } = await import("@tauri-apps/api/core");
        const pdf = new Uint8Array(await invoke<number[]>("office_to_pdf", { name: f.name, data: Array.from(f.data) }));
        inputs.push({ name: f.name.replace(/\.[^.]+$/, ".pdf"), path: null, data: pdf });
      }
    }
    const groups = r.mode === "each" ? inputs.map((f) => [f]) : [inputs];
    for (const g of groups) {
      const pdf = await engine.toPdf(g.map((f) => ({ name: f.name, data: f.data.slice() })), { pageSize: r.size as "auto" });
      const info = await engine.open(pdf, "new.pdf");
      addTab(info, g.length === 1 ? g[0].name.replace(/\.[^.]+$/, "") + ".pdf" : "Combined.pdf", null, true);
    }
    buildView();
    status(`Created ${groups.length} PDF${groups.length > 1 ? "s" : ""}. Save with Ctrl+S.`);
  } catch (e) {
    status(`Create failed: ${(e as Error).message}`);
  }
}
async function newBlank() {
  const r = await ask("New blank PDF", [
    { name: "pages", label: "Pages", type: "number", value: "1" },
    { name: "size", label: "Size", type: "select", value: "letter", options: [["letter", "Letter"], ["a4", "A4"], ["legal", "Legal"], ["a3", "A3"], ["a5", "A5"]] },
    { name: "orient", label: "Orientation", type: "select", value: "portrait", options: [["portrait", "Portrait"], ["landscape", "Landscape"]] },
  ], "Create");
  if (!r) return;
  const info = await engine.open(await engine.blankPdf(Math.max(1, Number(r.pages) || 1), r.size as "letter", r.orient === "landscape"), "blank.pdf");
  addTab(info, "Untitled.pdf", null, true);
  buildView();
}
/** Pages to image files for AutoCAD (IMAGEATTACH) and other apps. */
async function saveAsImages() {
  if (!active) return;
  const t = active;
  const saved = JSON.parse(localStorage.getItem("hdfstudio.images") ?? "{}");
  const sc = await engine.pageScale(t.info.id, t.page).catch(() => null);
  const r = await ask("Save as images", [
    { name: "format", label: "Format", type: "select", value: saved.format ?? "png", options: [["png", "PNG: sharp lines, small files (best for AutoCAD)"], ["tif", "TIFF: for CAD and print shops"], ["jpg", "JPEG: photos and scans"], ["bmp", "BMP"]] },
    { name: "pages", label: "Pages", value: t.info.pageCount === 1 ? "1" : "all", placeholder: "all, or e.g. 1-3, 8", hint: `Current page is ${t.page + 1}.` },
    { name: "dpi", label: "Resolution", type: "select", value: saved.dpi ?? "300", options: [["96", "96 dpi (screen)"], ["150", "150 dpi"], ["200", "200 dpi"], ["300", "300 dpi (print, recommended)"], ["400", "400 dpi"], ["600", "600 dpi (fine detail, large files)"]] },
    { name: "colour", label: "Colour", type: "select", value: saved.colour ?? "rgb", options: [["rgb", "Colour"], ["gray", "Greyscale"], ["bw", "Black and white (1-bit TIFF/BMP: smallest, crisp lines)"]] },
    { name: "background", label: "Background", type: "select", value: saved.background ?? "white", options: [["white", "White"], ["transparent", "Transparent (PNG and TIFF): drawing shows through"]] },
    { name: "trim", label: "Margins", type: "select", value: saved.trim ?? "keep", options: [["keep", "Keep the whole page"], ["trim", "Trim white margins"]] },
    { name: "world", label: "World file", type: "select", value: saved.world ?? (sc ? "yes" : "no"), options: [["yes", "Also save a world file (.pgw/.tfw/.jgw) at the drawing scale"], ["no", "No"]], hint: sc ? `This page's scale is ${sc.label}. Pages without a scale get no world file.` : "Only pages with a drawing scale (Measure › Set scale) get one." },
  ], "Save");
  if (!r) return;
  localStorage.setItem("hdfstudio.images", JSON.stringify(r));
  let pages: number[];
  try {
    pages = r.pages.trim().toLowerCase() === "all" || !r.pages.trim() ? [...Array(t.info.pageCount).keys()] : parseRanges(r.pages, t.info.pageCount);
  } catch (e) {
    return status((e as Error).message);
  }
  if (!pages.length) return status("No pages chosen.");
  const { EXT, WORLD_EXT } = await import("./engine/imageexport");
  const format = r.format as "png";
  const stem = t.name.replace(/\.pdf$/i, "");
  const prog = showProgress("Saving images");
  try {
    const files: { name: string; data: Uint8Array }[] = [];
    const notes: string[] = [];
    let lowered = 0;
    for (const [k, p] of pages.entries()) {
      if (prog.cancelled) break;
      prog.set(k / pages.length, `Page ${p + 1} (${k + 1} of ${pages.length})`);
      const [img] = await engine.rasterPages(t.info.id, [p], { format, dpi: +r.dpi, colour: r.colour as "rgb", transparent: r.background === "transparent", trim: r.trim === "trim" });
      const name = pages.length === 1 ? stem : `${stem}-p${p + 1}`;
      files.push({ name: `${name}.${EXT[format]}`, data: img.data });
      if (r.world === "yes" && img.world) files.push({ name: `${name}.${WORLD_EXT[format]}`, data: new TextEncoder().encode(img.world) });
      if (img.dpi < +r.dpi) lowered = img.dpi;
      if (img.real && notes.length < 1) notes.push(`at full scale the image is ${+img.real.width.toFixed(2)} ${img.real.unit} wide (IMAGEATTACH scale ${+img.real.width.toFixed(4)} with ${img.real.unit} units)`);
      else if (!img.real && notes.length < 1) notes.push(`at paper size it is ${+(img.width / img.dpi).toFixed(2)} in wide`);
    }
    if (!files.length) return status("Stopped.");
    const dir = files.length === 1 ? await saveBytes(files[0].name, files[0].data) : await saveMany(files);
    const n = files.filter((f) => f.name.endsWith(EXT[format])).length;
    status(`Saved ${n} image${n === 1 ? "" : "s"}${dir ? ` to ${dir}` : ""}. In AutoCAD: ${notes[0]}.${lowered ? ` Large sheet: resolution lowered to ${lowered} dpi to fit in memory.` : ""}`);
  } catch (e) {
    status(`Save as images failed: ${(e as Error).message ?? e}`);
  } finally {
    prog.close();
  }
}

/** Insert pages (all or a range) from other files at the start, the end, or before/after a page. */
async function insertPagesFlow() {
  if (!active) return;
  const files = await pickFiles(true);
  if (!files.length) return;
  const t = active;
  const counts: number[] = [];
  for (const f of files) {
    const src = await engine.open(f.data.slice(), f.name);
    counts.push(src.needsPassword ? -1 : src.pageCount);
    await engine.close(src.id);
  }
  if (counts.includes(-1)) return status(`${files[counts.indexOf(-1)].name} is password protected; open it first`);
  const total = counts.reduce((a, b) => a + b, 0);
  const one = files.length === 1;
  const r = await ask(`Insert ${one ? files[0].name : `${files.length} files`}`, [
    { name: "pages", label: one ? `Pages from ${files[0].name} (${counts[0]} pages)` : `Pages (${total} in all)`, value: "all", placeholder: "all, or e.g. 1-3, 8", hint: one ? undefined : "Applies to each file." },
    { name: "where", label: "Put them", type: "select", value: "after", options: [["start", "At the beginning"], ["end", "At the end"], ["before", "Before page…"], ["after", "After page…"]] },
    { name: "page", label: `Page (1-${t.info.pageCount})`, type: "number", value: String(t.page + 1) },
  ], "Insert");
  if (!r) return;
  const n = Math.min(t.info.pageCount, Math.max(1, Math.round(+r.page || 1)));
  const at = r.where === "start" ? 0 : r.where === "end" ? t.info.pageCount : r.where === "before" ? n - 1 : n;
  const all = !r.pages.trim() || r.pages.trim().toLowerCase() === "all";
  let added = 0;
  await mutate(`Inserted pages from ${files.map((f) => f.name).join(", ")}`, async (tab) => {
    let info = tab.info;
    let pos = at;
    for (const [k, f] of files.entries()) {
      const src = await engine.open(f.data, f.name);
      try {
        const pages = all ? undefined : parseRanges(r.pages, counts[k]);
        info = await engine.insertFrom(tab.info.id, pos, src.id, pages);
        const c = pages ? pages.length : counts[k];
        pos += c;
        added += c;
      } finally {
        await engine.close(src.id);
      }
    }
    return info;
  });
  if (active === t && added) {
    t.page = at;
    status(`Inserted ${added} page${added === 1 ? "" : "s"} as pages ${at + 1}-${at + added}. Ctrl+Z to undo.`);
    buildView();
  }
}

async function exportAs() {
  if (!active) return;
  const t = active;
  const r = await ask("Export", [
    { name: "to", label: "Format", type: "select", value: localStorage.getItem("hdfstudio.exportTo") ?? "docx", options: [["docx", "Word document (.docx)"], ["xlsx", "Excel workbook (.xlsx): tables and schedules"], ["pptx", "PowerPoint (.pptx): one slide per page"], ["image", "Images (PNG, JPEG, TIFF, BMP) for AutoCAD and other apps…"], ["html", "Web page (HTML)"], ["txt", "Plain text"], ["svg", "SVG (one per page)"]] },
    { name: "sheets", label: "Excel: sheets", type: "select", value: "page", options: [["page", "One sheet per page"], ["one", "Everything on one sheet"]] },
    { name: "slides", label: "PowerPoint: text", type: "select", value: "edit", options: [["edit", "Editable text boxes over the page"], ["image", "Pictures of the pages only"]] },
  ], "Export");
  if (!r) return;
  localStorage.setItem("hdfstudio.exportTo", r.to);
  if (r.to === "image") return saveAsImages();
  const stem = t.name.replace(/\.pdf$/i, "");
  try {
    {
      status(`Exporting ${stem}.${r.to}…`);
      const outs = await engine.exportAs(t.info.id, r.to === "txt" ? "text" : (r.to as "docx"), { oneSheet: r.sheets === "one", editableText: r.slides === "edit" });
      if (outs.length === 1) await saveBytes(`${stem}.${r.to}`, outs[0]);
      else await saveMany(outs.map((o, i) => ({ name: `${stem}-p${i + 1}.${r.to}`, data: o })));
      status(`Exported ${stem}.${r.to}`);
    }
  } catch (e) {
    status(`Export failed: ${(e as Error).message}`);
  }
}

// ---------- Batch ----------
const batchDeps: BatchDeps = {
  runRecipe: async (data, name, recipe, ctx) => {
    const step = ocrStep(recipe);
    if (step) data = (await ocrBytes(engine, await getRecognizer(), data, name, step.pages ?? "scanned", ctx.password, undefined, cleanStep(recipe))).data;
    return engine.runRecipe(data, name, recipe, ctx);
  },
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
  exportList: () => void exportMarkupList(),
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
  pickReviews: () => pickFiles(true, ["pdf", "xfdf"]),
});


// ---------- Engineering markups & measurement ----------
const eng = setupEngineering({
  engine,
  doc: () => active,
  pagesEl,
  viewer,
  tool: () => annot.tool,
  selected: () => annot.selected,
  setTool: (t) => useTool(t as Tool),
  ribbonColor: () => annot.color,
  refreshPage,
  changed: (label) => {
    if (!active) return;
    active.dirty = true;
    renderTabs();
    status(`${label}. Ctrl+Z to undo.`);
  },
  refreshComments: () => annot.refreshComments(),
  status,
});

// ---------- Bookmarks, links, attachments, layers ----------
// eslint-disable-next-line prefer-const
let navUI: ReturnType<typeof setupNav>;
navUI = setupNav({
  engine,
  doc: () => active,
  setInfo: (info) => active && (active.info = info),
  pagesEl,
  viewer,
  outlineEl,
  attachEl: $("#side-attach"),
  layersEl: $("#side-layers"),
  goToPage,
  viewTop: () => {
    if (!active) return 0;
    const el = pageEl(active.page);
    return el ? (viewer.scrollTop - el.offsetTop + PAGE_GAP) / active.zoom : 0;
  },
  refreshPage,
  rebuild: () => buildView(),
  changed: (label) => {
    if (!active) return;
    active.dirty = true;
    renderTabs();
    status(`${label}. Ctrl+Z to undo.`);
  },
  status,
  tool: () => annot.tool,
  setTool: (t) => useTool(t as Tool),
  pickFiles: async () => await pickFiles(true, []),
  saveBytes: async (name, data) => void (await saveBytes(name, data)),
  openUrl: (url) => void openExternal(url),
});

// ---------- Find and replace, spelling ----------
function textChanged(pages: number[], label: string) {
  if (!active) return;
  editUI.invalidate();
  for (const p of pages) refreshPage(p);
  active.dirty = true;
  renderTabs();
  status(`${label}. Ctrl+Z to undo.`);
}
const findReplace = setupFindReplace({
  engine,
  doc: () => active,
  showMatches: (hits, index) => {
    if (!active) return;
    active.hits = hits;
    active.hitIndex = index;
    drawHighlights();
    renderResults();
    if (index >= 0) focusHit();
  },
  afterReplace: textChanged,
  status,
});
const spell = setupSpell({
  engine,
  doc: () => active,
  el: $("#side-spell"),
  show: () => showSidePanel("spell"),
  goTo: (p) => goToPage(p),
  afterChange: (pages, label, comments) => {
    textChanged(pages, label);
    if (comments) annot.refreshComments();
  },
  status,
});

// ---------- Tool chest & markup list ----------
function startEng(t: EngTool) {
  chestUI?.release();
  void eng.start(t);
}
// eslint-disable-next-line prefer-const
let chestUI: ReturnType<typeof setupChest>;
chestUI = setupChest({
  el: $("#side-chest"),
  start: (tool, stamp) => {
    if ((ENG_TOOLS as readonly string[]).includes(tool)) void eng.start(tool as EngTool, stamp);
    else {
      if (designUI.active) designUI.exit();
      annot.setTool(tool as Tool);
    }
  },
  tool: () => annot.tool,
  clearRibbonColor: () => annot.setColor(null),
  saveText: async (name, text) => void (await saveText(name, text)),
  pickText: async () => {
    const [f] = await pickFiles(false, ["json"]);
    return f ? new TextDecoder().decode(f.data) : null;
  },
  status,
});
function showChest() {
  showSidePanel("chest");
  chestUI.render();
}

async function exportMarkupList() {
  if (!active) return status("Open a PDF first.");
  const doc = active;
  const r = await ask("Export markup list", [
    { name: "fmt", label: "Format", type: "select", value: localStorage.getItem("hdfstudio.listfmt") ?? "xlsx", options: [["xlsx", "Excel workbook (.xlsx), with a Totals sheet"], ["csv", "CSV (.csv)"]], hint: "Lists every markup with its page, type, author, status, comment and measured value. Measurements are totalled by type and page." },
  ], "Export");
  if (!r) return;
  localStorage.setItem("hdfstudio.listfmt", r.fmt);
  const stem = doc.name.replace(/\.pdf$/i, "");
  const data = await engine.exportMarkups(doc.info.id, r.fmt as "csv" | "xlsx", stem);
  const saved = await saveBytes(`${stem} markups.${r.fmt}`, data);
  if (saved !== null) status("Markup list saved.");
}

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
  status("Signature placed. With the Hand tool, click it to move, resize or rotate it, or right-click for more. Flatten to lock it in.");
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
  status,
  pressButton: async (f) => {
    const a = f.action;
    if (!a || a.kind === "none" || !active) return;
    if (a.kind === "reset") {
      await engine.clearForm(active.info.id);
      active.dirty = true;
      buildView();
      status("Cleared the form. Ctrl+Z to undo.");
    } else if (a.kind === "print") printDoc();
    else if (a.kind === "url") void openExternal(a.url);
  },
});
const designUI = setupFormDesign({
  engine,
  doc: () => active,
  currentPage: () => active?.page ?? 0,
  pagesEl,
  viewer,
  pageEl,
  refreshPage,
  changed: (label) => {
    if (!active) return;
    active.dirty = true;
    renderTabs();
    status(`${label}. Ctrl+Z to undo.`);
  },
  status,
  onEnter: () => {
    annot.setTool("hand");
    ribbon.show("sign");
  },
  onExit: () => {
    formsUI.render();
    const n = formsUI.fields.length;
    status(n ? "Form ready. Click a field to fill it in." : "Closed form designer");
  },
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
const colorSlot = Object.assign(document.createElement("div"), { className: "color-slot" });
const colorInput = Object.assign(document.createElement("input"), { type: "color", value: "#d62828", title: "Markup colour for new comments" });
colorInput.oninput = () => annot.setColor(colorInput.value.match(/\w\w/g)!.map((h) => parseInt(h, 16) / 255) as [number, number, number]);
const resetColor = Object.assign(document.createElement("button"), { textContent: "Default", title: "Use each tool's default colour" });
resetColor.onclick = () => annot.setColor(null);
colorSlot.append(colorInput, resetColor);
// ---------- Right-click menu on the page ----------
const SWATCHES: [string, string][] = [["#d91a1a", "Red"], ["#c25e00", "Orange"], ["#e0b000", "Yellow"], ["#1a7f37", "Green"], ["#0b6fd6", "Blue"], ["#6b3fd6", "Purple"], ["#000000", "Black"]];
const rgbOf = (hex: string) => hex.match(/\w\w/g)!.map((h) => parseInt(h, 16) / 255) as [number, number, number];
const hexOfRgb = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
async function patchAnnot(a: AnnotInfo, patch: Parameters<typeof engine.updateAnnotation>[3], label: string) {
  if (!active) return;
  await engine.updateAnnotation(active.info.id, a.page, a.key, patch);
  refreshPage(a.page);
  active.dirty = true;
  renderTabs();
  status(`${label}. Ctrl+Z to undo.`);
  annot.refreshComments();
  const again = (await engine.allAnnotations(active.info.id)).find((x) => x.key === a.key);
  annot.selectAnnot(again ?? null);
}
/** Text box and callout style: words, colours, fill, size, border, arrow; optionally kept for new ones. */
async function textBoxProperties(a: AnnotInfo) {
  const isCallout = !!a.callout;
  const fillHex = a.fill && a.fill.length >= 3 ? hexOfRgb(a.fill) : "none";
  const fillChoice = fillHex === "none" ? "none" : fillHex === "#ffffff" ? "#ffffff" : fillHex === "#ffff99" ? "#ffff99" : "custom";
  const r = await ask(isCallout ? "Callout style" : "Text box style", [
    { name: "contents", label: "Text", value: a.contents },
    { name: "color", label: isCallout ? "Text, border and leader colour" : "Text and border colour", type: "color", value: hexOfRgb(a.textColor && a.textColor.length >= 3 ? a.textColor : [0, 0, 0]) },
    { name: "fontSize", label: "Text size (pt)", type: "number", value: String(a.fontSize ?? 12) },
    { name: "fill", label: "Fill", type: "select", value: fillChoice, options: [["none", "None (see-through)"], ["#ffffff", "White"], ["#ffff99", "Light yellow"], ["custom", "Custom colour (below)"]] },
    { name: "fillColor", label: "Custom fill colour", type: "color", value: fillChoice === "custom" ? fillHex : "#e8f7fd" },
    { name: "align", label: "Text alignment", type: "select", value: String(a.align ?? 0), options: [["0", "Left"], ["1", "Centre"], ["2", "Right"]] },
    { name: "width", label: "Border width (pt, 0 for none)", type: "number", value: String(a.borderWidth ?? 1) },
    ...(isCallout ? [{ name: "arrow", label: "Arrow head", type: "select" as const, value: a.arrow ?? "OpenArrow", options: [["OpenArrow", "Open arrow"], ["ClosedArrow", "Filled arrow"], ["Circle", "Dot"], ["Square", "Square"], ["Slash", "Slash"], ["None", "None"]] as [string, string][] }] : []),
    { name: "keep", label: "Use this style", type: "select", value: "this", options: [["this", "For this one only"], ["default", `For this one and every new ${isCallout ? "callout" : "text box"}`], ["chest", "For this one, and save it to the tool chest"]] },
  ], "Apply");
  if (!r) return;
  const fill = r.fill === "none" ? null : r.fill === "custom" ? r.fillColor : r.fill;
  const patch: Parameters<typeof engine.updateAnnotation>[3] = {
    color: rgbOf(r.color),
    fill: fill ? rgbOf(fill) : null,
  };
  if (r.contents !== a.contents) patch.contents = r.contents;
  patch.align = +r.align;
  if (+r.fontSize > 0) patch.fontSize = +r.fontSize;
  if (r.width !== "" && +r.width >= 0) patch.width = +r.width;
  if (isCallout && r.arrow && r.arrow !== a.arrow) patch.arrow = r.arrow;
  // Bigger text needs a bigger box.
  if (a.box && ((patch.fontSize && patch.fontSize !== a.fontSize) || patch.contents !== undefined)) {
    const { measureBox } = await import("./ui/textbox");
    const m = measureBox(patch.contents ?? a.contents, patch.fontSize ?? a.fontSize ?? 12);
    // Grow to fit, but never narrow a box the user widened (alignment needs the room).
    patch.box = [a.box[0], a.box[1], a.box[0] + Math.max(m.w, a.box[2] - a.box[0]), a.box[1] + Math.max(m.h, a.box[3] - a.box[1])];
  }
  await patchAnnot(a, patch, isCallout ? "Updated callout" : "Updated text box");
  const style = { color: r.color, fontSize: +r.fontSize > 0 ? +r.fontSize : undefined, width: patch.width, fill: fill ?? "none", arrow: isCallout ? r.arrow : undefined, align: +r.align };
  if (r.keep === "default" || r.keep === "chest") {
    const { setToolDefaults } = await import("./ui/prefs");
    setToolDefaults(isCallout ? "callout" : "text", Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined)));
  }
  if (r.keep === "chest") {
    const { addToChest } = await import("./ui/chest");
    const name = await ask("Save to the tool chest", [{ name: "n", label: "Name", value: `${isCallout ? "Callout" : "Text box"} ${r.fontSize}pt` }], "Save");
    if (name) addToChest({ name: name.n || (isCallout ? "Callout" : "Text box"), tool: isCallout ? "callout" : "text", ...style });
    chestUI?.render();
  }
  if (r.keep !== "this") status(r.keep === "chest" ? "Style saved to the tool chest and used for new ones." : `New ${isCallout ? "callouts" : "text boxes"} will use this style.`);
}
/** Change line width, opacity, text size and precision on every selected markup at once. */
async function multiStyle() {
  const list = annot.multi;
  if (!list.length) return;
  const hasMeas = list.some((m) => m.label?.meas);
  const r = await ask(`Style for ${list.length} markups`, [
    { name: "color", label: "Colour (leave as is to keep each one's)", type: "select", value: "", options: [["", "Keep"], ...SWATCHES.map(([c, t]) => [c, t] as [string, string])] },
    { name: "width", label: "Line width (pt)", type: "number", value: "", placeholder: "unchanged" },
    { name: "opacity", label: "Opacity (%)", type: "number", value: "", placeholder: "unchanged" },
    { name: "size", label: "Text size (pt): text boxes, callouts and measurement labels", type: "number", value: "", placeholder: "unchanged" },
    ...(hasMeas ? [{ name: "prec", label: "Measurement precision", type: "select" as const, value: "keep", options: [["keep", "Keep"], ["auto", "Usual for the unit"], ["0", "0 decimals / nearest 1\""], ["1", "0.0 / 1/2\""], ["2", "0.00 / 1/4\""], ["3", "0.000 / 1/8\""], ["4", "0.0000 / 1/16\""]] as [string, string][] }] : []),
  ], "Apply to all");
  if (!r) return;
  const patch: Parameters<typeof engine.updateAnnotation>[3] = {};
  if (r.color) patch.color = rgbOf(r.color);
  if (r.width !== "" && +r.width >= 0) patch.width = +r.width;
  if (r.opacity !== "" && +r.opacity > 0) patch.opacity = +r.opacity / 100;
  if (r.size !== "" && +r.size > 0) (patch.fontSize = +r.size), (patch.labelSize = +r.size);
  if (hasMeas && r.prec && r.prec !== "keep") patch.precision = r.prec === "auto" ? null : +r.prec;
  if (!Object.keys(patch).length) return;
  await annot.patchMulti(patch, `Restyled ${list.length} markups`);
}
/** Text size and precision of a measurement's label (this one, and optionally every new one). */
async function measureProperties(a: AnnotInfo) {
  if (!a.label) return;
  const { precisionOptions, usualPrecision } = await import("./engine/measure");
  const { setToolDefaults } = await import("./ui/prefs");
  const m = a.label.meas;
  const r = await ask(m ? "Measurement text" : "Label text", [
    { name: "size", label: "Text size (pt)", type: "number", value: String(Math.round(a.label.size * 10) / 10) },
    ...(m ? [{ name: "prec", label: m.unit === "ft-in" ? "Round to" : "Decimal places", type: "select" as const, value: m.prec === undefined ? "auto" : String(m.prec), options: [["auto", usualPrecision(m.unit)], ...precisionOptions(m.unit)] as [string, string][] }] : []),
    { name: "keep", label: "Use for", type: "select", value: "this", options: [["this", "This one only"], ["default", "This one and every new measurement"]] },
  ], "Apply");
  if (!r) return;
  const patch: Parameters<typeof engine.updateAnnotation>[3] = {};
  if (+r.size > 0) patch.labelSize = +r.size;
  if (m) patch.precision = r.prec === "auto" ? null : +r.prec;
  await patchAnnot(a, patch, "Updated measurement text");
  if (r.keep === "default") {
    setToolDefaults("measure", { ...(+r.size > 0 ? { fontSize: +r.size } : {}), ...(m ? { precision: r.prec === "auto" ? undefined : +r.prec } : {}) });
    status("New measurements will use this text size and precision.");
  }
}
async function annotProperties(a: AnnotInfo) {
  if (a.type === "FreeText" && a.box) return textBoxProperties(a);
  const isText = a.type === "FreeText";
  const hasLine = ["Square", "Circle", "Line", "Ink", "Polygon", "PolyLine"].includes(a.type);
  const r = await ask(`${a.type === "FreeText" ? "Text box" : a.type === "Stamp" ? "Stamp" : "Markup"} properties`, [
    { name: "contents", label: isText ? "Text" : "Comment", value: a.contents },
    { name: "author", label: "Author", value: a.author },
    ...(a.xf && !isText ? [] : [{ name: "color", label: isText ? "Text colour" : "Colour", type: "color" as const, value: hexOfRgb(a.color.length >= 3 ? a.color : [0.85, 0.1, 0.1]) }]),
    ...(hasLine ? [{ name: "width", label: "Line width (pt)", type: "number" as const, value: "" , placeholder: "unchanged" }] : []),
    ...(isText ? [{ name: "fontSize", label: "Text size (pt)", type: "number" as const, value: "", placeholder: "unchanged" }] : []),
    { name: "opacity", label: "Opacity (%)", type: "number", value: "", placeholder: "unchanged" },
  ], "Apply");
  if (!r) return;
  const patch: Parameters<typeof engine.updateAnnotation>[3] = {};
  if (r.contents !== a.contents) patch.contents = r.contents;
  if (r.author !== a.author) patch.author = r.author;
  if (r.color && r.color !== hexOfRgb(a.color.length >= 3 ? a.color : [0.85, 0.1, 0.1])) patch.color = rgbOf(r.color);
  if (r.width && +r.width > 0) patch.width = +r.width;
  if (r.fontSize && +r.fontSize > 0) patch.fontSize = +r.fontSize;
  if (r.opacity && +r.opacity > 0) patch.opacity = +r.opacity / 100;
  if (Object.keys(patch).length) await patchAnnot(a, patch, "Updated properties");
}
const imageMenu = (rotate: (by: number) => unknown, size: () => unknown, extra: MenuItem[]): MenuItem[] => [
  { label: "Rotate right 90°", keys: "]", run: () => void rotate(90) },
  { label: "Rotate left 90°", keys: "[", run: () => void rotate(-90) },
  { label: "Rotate 180°", run: () => void rotate(180) },
  { label: "Size and rotation…", run: () => void size() },
  ...extra,
];
pagesEl.addEventListener("contextmenu", async (e) => {
  const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
  if (!el || !active || (e.target as HTMLElement).closest("textarea, input")) return;
  e.preventDefault();
  const page = Number(el.dataset.page);
  const r = el.getBoundingClientRect();
  const [pw, ph] = active.info.pageSizes[page];
  const p: [number, number] = [((e.clientX - r.left) / r.width) * pw, ((e.clientY - r.top) / r.height) * ph];
  const x = e.clientX, y = e.clientY;
  if (annot.tool === "edit") {
    const img = await editUI.selectImageAt(page, p);
    if (img) return showMenu(x, y, imageMenu((by) => editUI.rotateSelected(by), () => editUI.sizeSelected(), [
      { sep: true },
      { label: "Replace image…", keys: "Ctrl+R", run: () => editUI.replaceSelectedImage() },
      { label: "Save image as…", run: () => editUI.saveSelectedImage() },
      { sep: true },
      { label: "Delete image", keys: "Del", danger: true, run: () => void editUI.deleteSelectedImage() },
    ]), "Image");
  }
  const a = await engine.annotationAt(active.info.id, page, p);
  // Several markups selected: one menu for all of them.
  if (annot.multi.length > 1 && (!a || annot.multi.some((m) => m.key === a.key))) {
    const n = annot.multi.length;
    return showMenu(x, y, [
      { swatches: SWATCHES.map(([c, t]) => ({ color: c, title: t, run: () => void annot.patchMulti({ color: rgbOf(c) }, `Colour set to ${t.toLowerCase()} on ${n} markups`) })) },
      { label: `Style for all ${n}…`, run: () => void multiStyle() },
      { sep: true },
      { label: `Delete ${n} markups`, keys: "Del", danger: true, run: () => void annot.deleteMulti() },
    ], `${n} markups`);
  }
  if (a) {
    if (annot.tool !== "hand") useTool("hand");
    annot.selectAnnot(a);
    const items: MenuItem[] = [];
    const isImg = !!a.xf && a.type !== "FreeText";
    if (a.xf) items.push(...imageMenu((by) => annot.rotateSelectedStamp(by), () => annot.sizeSelectedStamp(), []), { sep: true });
    if (a.type === "FreeText") items.push({ label: "Add leader…", run: () => startEng("leader") });
    if (!isImg) items.push({ swatches: SWATCHES.map(([c, t]) => ({ color: c, title: t, run: () => void patchAnnot(a, { color: rgbOf(c) }, `Colour set to ${t.toLowerCase()}`) })) });
    if (a.label) items.push({ label: a.label.meas ? "Measurement text (size, precision)…" : "Label text size…", run: () => void measureProperties(a) });
    items.push(
      { label: a.type === "FreeText" ? "Edit text…" : "Edit comment…", run: () => void annot.editSelected() },
      { label: a.type === "FreeText" ? "Style (colour, fill, size, arrow)…" : "Properties…", run: () => void annotProperties(a) },
      { label: "Show in comments", run: () => (showSidePanel("comments"), annot.selectAnnot(a)) },
      { sep: true },
      { label: "Delete", keys: "Del", danger: true, run: () => void annot.deleteSelected() },
    );
    return showMenu(x, y, items, isImg ? (a.contents?.startsWith("Signed") ? "Signature" : "Image") : a.type === "FreeText" ? "Text box" : a.label?.meas ? "Measurement" : "Markup");
  }
  annot.selectAnnot(null);
  showMenu(x, y, [
    { label: "Add sticky note", keys: "N", run: () => useTool("note") },
    { label: "Add text box", keys: "X", run: () => useTool("text") },
    { label: "Add callout", run: () => startEng("callout") },
    { label: "Add stamp…", run: () => startEng("stamp") },
    { label: "Place signature", keys: "G", run: () => useTool("sign") },
    { sep: true },
    { label: "Measure length", run: () => startEng("m-length") },
    { label: "Set drawing scale…", run: () => void eng.setScale() },
    { sep: true },
    { label: "Rotate page right", run: () => mutate("Rotated", (t) => engine.rotatePages(t.info.id, [page], 90)) },
    { label: "Print…", keys: "Ctrl+P", run: () => printDoc() },
  ], `Page ${page + 1}`);
});
// Hand tool: a click (not a drag) on a link follows it.
let downAt: [number, number] | null = null;
pagesEl.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]), true);
pagesEl.addEventListener("click", async (e) => {
  if (annot.tool !== "hand" || !active || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
  if (!el) return;
  const page = Number(el.dataset.page);
  const r = el.getBoundingClientRect();
  const [pw, ph] = active.info.pageSizes[page];
  const p = [((e.clientX - r.left) / r.width) * pw, ((e.clientY - r.top) / r.height) * ph];
  if (annot.selected) return; // clicking a markup selects it instead
  const l = (await engine.links(active.info.id, page)).find((k) => p[0] >= k.rect[0] && p[0] <= k.rect[2] && p[1] >= k.rect[1] && p[1] <= k.rect[3]);
  if (!l) return;
  if (l.url) {
    if (await confirmDialog(`Open ${l.url}?`, "Open")) void openExternal(l.url);
  } else if (l.page !== undefined) {
    linkHistory.push([page, viewer.scrollTop]);
    goToPage(l.page, l.y);
    status(`Went to page ${l.page + 1}. Alt+Left goes back.`);
  }
});
const linkHistory: [number, number][] = [];
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft" && linkHistory.length && active) {
    e.preventDefault();
    const [, top] = linkHistory.pop()!;
    viewer.scrollTop = top;
  }
});

// [ and ] turn the selected image or signature.
document.addEventListener("keydown", (e) => {
  if ((e.key !== "[" && e.key !== "]") || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest?.("input, textarea, select")) return;
  const by = e.key === "]" ? 90 : -90;
  if (annot.tool === "edit" && editUI.selectedImage) (e.preventDefault(), void editUI.rotateSelected(by));
  else if (annot.selected?.xf) (e.preventDefault(), void annot.rotateSelectedStamp(by));
}, true);

/** Select a tool and bring its ribbon task forward so its options are in view. */
function useTool(t: Tool) {
  chestUI?.release();
  if (designUI.active && t !== "hand") designUI.exit();
  if (t !== "link") navUI?.clearLinkBoxes();
  annot.setTool(t);
  if (t !== "hand" && t !== "select") ribbon.revealTool(t);
}

// ---------- Redaction & security ----------
const redactBtn = $("#redactApply");
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
    const { count: n, textless } = await engine.markRedactions(t.info.id, { ...o, pages, caseSensitive: r.case === "yes" });
    t.dirty = true;
    for (const p of pages) refreshPage(p);
    renderTabs();
    annot.refreshComments();
    updateRedactButton();
    if (n) return status(`Marked ${n} match${n === 1 ? "" : "es"} for redaction. Review them in Comments, then click "Apply".`);
    status("No matches");
    // Drawings often draw their lettering as lines (CAD SHX fonts), which can't be searched until it is recognized.
    const why = textless.length ? `${textless.length === pages.length ? "This document has" : `${textless.length} of the searched pages have`} no searchable text.` : "Some lettering on drawings is drawn as lines (CAD fonts) and can't be searched as text.";
    if (await confirmDialog(`No matches found. ${why} Recognize the text (OCR) on ${pages.length === 1 ? "this page" : `these ${pages.length} pages`} and search again?`, "Recognize and search")) {
      await recognizeText(pages);
      if (active !== t) return;
      const again = await engine.markRedactions(t.info.id, { ...o, pages, caseSensitive: r.case === "yes" });
      for (const p of pages) refreshPage(p);
      annot.refreshComments();
      updateRedactButton();
      status(again.count ? `Marked ${again.count} match${again.count === 1 ? "" : "es"} for redaction. Review them in Comments, then click "Apply".` : "Still no matches after recognizing the text.");
    }
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

// ---------- Document check (PDF/A, accessibility) ----------
async function checkDocumentFlow() {
  if (!active) return;
  const t = active;
  const r = await engine.checkDocument(t.info.id);
  const recheck = async () => {
    if (t === active) await checkDocumentFlow();
  };
  showCheckReport(
    t.name,
    r,
    async (fix) => {
      if (fix === "title" || fix === "lang" || fix === "displayTitle" || fix === "tabs") return quickFixes(t).then(recheck);
      if (fix === "ocr") {
        await recognizeText(await engine.pagesWithoutText(t.info.id));
        return recheck();
      }
      if (fix === "sanitize") return sanitizeFlow();
      if (fix === "unprotect") return unprotectFlow();
      if (fix === "pdfa") return saveAsPdfa();
      if (fix === "tag") return makeAccessible().then(recheck);
      if (fix === "alt") return describeImages().then(recheck);
    },
    () => quickFixes(t).then(recheck),
  );
}
/** Tag the document for screen readers, then ask for image descriptions. */
async function makeAccessible() {
  if (!active) return;
  const t = active;
  const tagged = await engine.isTagged(t.info.id);
  const navLang = navigator.language || "en-US";
  const r = await ask(tagged ? "Re-tag for accessibility" : "Make accessible", [
    { name: "lang", label: "Language of the text", type: "select", value: LANGS.some(([k]) => k === navLang) ? navLang : "en-US", options: LANGS },
    ...(tagged ? [{ name: "retag", label: "This document already has tags", type: "select" as const, value: "yes", options: [["yes", "Replace them with new tags"], ["no", "Keep them"]] as [string, string][] }] : []),
  ], tagged ? "Re-tag" : "Tag document");
  if (!r || r.retag === "no") return;
  const prog = showProgress("Tagging for accessibility");
  prog.set(0.3, "Finding headings, lists, tables and images…");
  try {
    const rep = await engine.autoTag(t.info.id, { lang: r.lang, retag: tagged });
    t.info = await engine.info(t.info.id);
    t.dirty = true;
    renderTabs();
    buildView();
    const parts = [
      [rep.headings, "heading"], [rep.paragraphs, "paragraph"], [rep.lists, "list"], [rep.tables, "table"], [rep.figures, "image"], [rep.links, "link"], [rep.fields, "form field"],
    ].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
    status(`Tagged ${parts.join(", ") || "the document"}. Headers, footers and decoration are marked to be skipped. Ctrl+Z to undo.`);
  } catch (e) {
    prog.close();
    return status((e as Error).message);
  }
  prog.close();
  if ((await engine.figures(t.info.id)).some((f) => !f.alt.trim())) await describeImages();
}
async function describeImages() {
  if (!active) return;
  const t = active;
  if (!(await engine.isTagged(t.info.id))) return status("Tag the document first (Protect › Make accessible); image descriptions live in the tags.");
  if (!(await engine.figures(t.info.id)).length) return status("No images to describe.");
  await showAltTextDialog({
    figures: () => engine.figures(t.info.id),
    render: (page, scale) => engine.render(t.info.id, page, scale),
    pageSize: (page) => t.info.pageSizes[page],
    save: async (changes) => {
      for (const c of changes) await engine.setFigureAlt(t.info.id, c.key, c.alt);
      t.dirty = true;
      renderTabs();
      const deco = changes.filter((c) => c.alt === null).length;
      status(`Saved ${changes.length - deco} description${changes.length - deco === 1 ? "" : "s"}${deco ? ` and marked ${deco} image${deco === 1 ? "" : "s"} decorative` : ""}. Ctrl+Z to undo.`);
    },
  });
}
const LANGS: [string, string][] = [["en-US", "English (US)"], ["en-CA", "English (Canada)"], ["en-GB", "English (UK)"], ["fr-CA", "French (Canada)"], ["fr-FR", "French (France)"], ["es-ES", "Spanish"], ["de-DE", "German"], ["pt-BR", "Portuguese (Brazil)"], ["it-IT", "Italian"], ["nl-NL", "Dutch"]];
async function quickFixes(t: Tab) {
  const navLang = navigator.language || "en-US";
  const r = await ask("Title, language and tab order", [
    { name: "title", label: "Document title", value: t.info.title ?? t.name.replace(/\.pdf$/i, ""), hint: "Shown in the window and read out by screen readers." },
    { name: "lang", label: "Language of the text", type: "select", value: LANGS.some(([k]) => k === navLang) ? navLang : "en-US", options: LANGS },
  ], "Apply");
  if (!r) return;
  t.info = await engine.applyFixes(t.info.id, { title: r.title.trim(), lang: r.lang, displayTitle: true, tabs: true });
  t.dirty = true;
  renderTabs();
  status("Title, language, title display and tab order set. Ctrl+Z to undo.");
}
async function saveAsPdfa() {
  if (!active) return;
  const t = active;
  if (!isTauri) return status("PDF/A conversion uses Ghostscript and runs in the desktop app or with: hds pdfa <file>");
  const { invoke } = await import("@tauri-apps/api/core");
  if (!(await invoke<boolean>("ghostscript_available"))) return status("PDF/A conversion needs Ghostscript. Install it from ghostscript.com (free), then try again.");
  const prog = showProgress("Converting to PDF/A");
  try {
    prog.set(0.2, "Embedding fonts and colour profile…");
    const bytes = await engine.save(t.info.id, "garbage");
    const converted = new Uint8Array(await invoke<number[]>("pdfa_convert", { data: Array.from(bytes) }));
    prog.set(0.8, "Checking the result…");
    const out = await engine.finishPdfa(converted, t.info.id);
    const info = await engine.open(out, "pdfa.pdf");
    addTab(info, t.name.replace(/\.pdf$/i, "") + " (PDF-A).pdf", null, true);
    buildView();
    prog.close();
    await checkDocumentFlow();
    status("Converted to PDF/A-2b. Save it to keep it (Ctrl+S). Note: accessibility tags aren't carried over by the conversion.");
  } catch (e) {
    prog.close();
    status(`PDF/A conversion failed: ${(e as Error).message ?? e}`);
  }
}

// ---------- Theme ----------
function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  $("#themeBtn").replaceChildren(icon(dark ? I.Sun : I.Moon, 17));
  localStorage.setItem("hdfstudio.theme", dark ? "dark" : "light");
}
setTheme((localStorage.getItem("hdfstudio.theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark");

// ---------- Commands, shortcuts, palette ----------
interface Command { id: string; title: string; keys?: string; run: () => void }
/** One-key shortcuts for the engineering and measuring tools. */
const ENG_KEYS: Partial<Record<(typeof ENG_TOOLS)[number], string>> = {
  cloud: "C", callout: "L", stamp: "S", leader: "Shift+L", dimension: "Shift+D", polyline: "Shift+Y",
  "m-length": "M", "m-area": "Shift+M", "m-perimeter": "Shift+P", "m-count": "Shift+C", "m-angle": "Shift+G", "m-polylength": "Shift+N",
};
const commands: Command[] = [
  { id: "open", title: "Open files…", keys: "Ctrl+O", run: async () => openFiles(await pickFiles()) },
  { id: "save", title: "Save", keys: "Ctrl+S", run: () => save(false) },
  { id: "print", title: "Print…", keys: "Ctrl+P", run: () => printDoc() },
  { id: "checkUpdates", title: "Check for updates", run: () => checkForUpdates(status, true) },
  { id: "settings", title: "Settings: your name, units, tool colours and defaults…", keys: "Ctrl+,", run: () => void openSettings({ theme: { dark: () => document.documentElement.classList.contains("dark"), set: setTheme }, checkUpdates: () => checkForUpdates(status, true), status }) },
  { id: "saveAs", title: "Save as…", keys: "Ctrl+Shift+S", run: () => save(true) },
  { id: "closeTab", title: "Close tab", keys: "Ctrl+W", run: () => active && closeTab(active) },
  { id: "nextTab", title: "Next tab", keys: "Ctrl+Tab", run: () => tabs.length > 1 && switchTab(tabs[(tabs.indexOf(active!) + 1) % tabs.length]) },
  { id: "prevTab", title: "Previous tab", keys: "Ctrl+Shift+Tab", run: () => tabs.length > 1 && switchTab(tabs[(tabs.indexOf(active!) - 1 + tabs.length) % tabs.length]) },
  { id: "find", title: "Find in document", keys: "Ctrl+F", run: () => (searchInput.focus(), searchInput.select()) },
  { id: "findReplace", title: "Find and replace text…", keys: "Ctrl+H", run: () => findReplace.open(searchInput.value || undefined) },
  { id: "account", title: "Account: who is signed in", run: () => status(signIn.user ? `Signed in as ${signIn.user.name} (${signIn.user.email})` : "Not signed in") },
  { id: "signOut", title: "Sign out of HDS", run: () => signIn.signOut() },
  { id: "spellCheck", title: "Check spelling (comments and page text)", keys: "F7", run: () => void spell.check() },
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
  { id: "toggleSidebar", title: "Show or hide the sidebar", keys: "F4", run: () => $("main").classList.toggle("no-sidebar") },
  { id: "showOutline", title: "Show outline", run: () => showSidePanel("outline") },
  { id: "showThumbs", title: "Show page thumbnails", run: () => showSidePanel("thumbs") },
  { id: "toggleTheme", title: "Toggle dark mode", run: () => setTheme(!document.documentElement.classList.contains("dark")) },
  { id: "undo", title: "Undo", keys: "Ctrl+Z", run: () => undoRedo("undo") },
  { id: "redo", title: "Redo", keys: "Ctrl+Y", run: () => undoRedo("redo") },
  { id: "mergeFiles", title: "Merge files into a new document…", keys: "Ctrl+Shift+M", run: () => mergeFiles() },
  { id: "insertFile", title: "Insert pages from files: choose pages and where (start, end, before or after a page)…", run: () => void insertPagesFlow() },
  { id: "openCloud", title: "Open from OneDrive or SharePoint…", keys: "Ctrl+Alt+O", run: () => void openFromCloud() },
  { id: "saveCloud", title: "Save to OneDrive or SharePoint…", keys: "Ctrl+Alt+S", run: () => active && void saveToCloud(active, true) },
  { id: "cloudWeb", title: "Show this file in OneDrive/SharePoint (browser)", run: () => active?.cloud?.webUrl ? openExternal(active.cloud.webUrl) : status("This file isn't from OneDrive or SharePoint") },
  { id: "saveAsImages", title: "Save pages as images (PNG, TIFF, JPEG, BMP) for AutoCAD…", run: () => void saveAsImages() },
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
  { id: "tool-hand", title: "Hand tool / select comments", keys: "V", run: () => useTool("hand") },
  { id: "tool-select", title: "Select text tool", keys: "T", run: () => useTool("select") },
  { id: "tool-highlight", title: "Highlight tool", keys: "H", run: () => useTool("highlight") },
  { id: "tool-underline", title: "Underline tool", keys: "U", run: () => useTool("underline") },
  { id: "tool-strike", title: "Strikeout tool", keys: "K", run: () => useTool("strike") },
  { id: "tool-note", title: "Sticky note tool", keys: "N", run: () => useTool("note") },
  { id: "tool-text", title: "Text box tool", keys: "X", run: () => useTool("text") },
  { id: "tool-rect", title: "Rectangle tool", keys: "R", run: () => useTool("rect") },
  { id: "tool-ellipse", title: "Ellipse tool", keys: "O", run: () => useTool("ellipse") },
  { id: "tool-arrow", title: "Arrow tool", keys: "A", run: () => useTool("arrow") },
  { id: "tool-ink", title: "Pen tool", keys: "P", run: () => useTool("ink") },
  { id: "autoTag", title: "Make accessible: tag headings, lists, tables and images for screen readers…", run: () => makeAccessible() },
  { id: "altText", title: "Describe images (alt text) for screen readers…", run: () => describeImages() },
  { id: "prepareForm", title: "Prepare form: add, move and edit form fields", keys: "Ctrl+Shift+F", run: () => designUI.toggle() },
  { id: "detectFields", title: "Detect form fields: make a flat form fillable automatically", run: () => designUI.detect() },
  { id: "formTabOrder", title: "Form tab order: set the order the Tab key moves through fields", run: () => designUI.tabOrder() },
  { id: "formFieldList", title: "Form field list: every field in the document", run: () => designUI.fieldList() },
  { id: "addTextField", title: "Add a text field to the form", run: () => designUI.draw("text") },
  { id: "addDateField", title: "Add a date field to the form", run: () => designUI.draw("date") },
  { id: "addCheckField", title: "Add a check box to the form", run: () => designUI.draw("checkbox") },
  { id: "addRadioField", title: "Add radio buttons to the form", run: () => designUI.draw("radio") },
  { id: "addDropdownField", title: "Add a dropdown list to the form", run: () => designUI.draw("combobox") },
  { id: "addListField", title: "Add a list box to the form", run: () => designUI.draw("listbox") },
  { id: "addSignatureField", title: "Add a signature field to the form", run: () => designUI.draw("signature") },
  { id: "addButtonField", title: "Add a button (clear form, print, open link) to the form", run: () => designUI.draw("button") },
  { id: "showComments", title: "Show comments", run: () => (showSidePanel("comments"), annot.refreshComments()) },
  { id: "mergeReviews", title: "Merge reviewers' comments (from their PDF copies or XFDF files)…", run: () => (showSidePanel("comments"), annot.mergeReviews()) },
  { id: "tool-redact", title: "Redact tool (mark text or area)", keys: "D", run: () => useTool("redact") },
  { id: "findRedact", title: "Find and redact (text, emails, phone numbers, regex)…", keys: "Ctrl+Shift+R", run: () => findAndRedact() },
  { id: "applyRedactions", title: "Apply redactions permanently…", run: () => applyRedactionsFlow() },
  { id: "sanitize", title: "Remove hidden data (metadata, scripts, attachments)…", run: () => sanitizeFlow() },
  { id: "protect", title: "Protect with password and permissions…", run: () => protectFlow() },
  { id: "unprotect", title: "Remove password protection", run: () => unprotectFlow() },
  { id: "tool-sign", title: "Sign: place your signature", keys: "G", run: () => useTool("sign") },
  { id: "newSignature", title: "Create a new signature…", run: async () => { clearSignature(); if (await getSignature(true)) annot.setTool("sign"); } },
  ...ENG_TOOLS.map((t) => ({ id: `tool-${t}`, title: `${eng.TOOL_INFO[t].label} tool`, keys: ENG_KEYS[t], run: () => startEng(t) })),
  { id: "setScale", title: "Set drawing scale…", run: () => void eng.setScale() },
  { id: "toggleSnap", title: "Snap to drawing (endpoints, intersections, midpoints): on/off", keys: "F9", run: () => eng.toggleSnap() },
  { id: "tool-link", title: "Link tool: add or edit links to pages, websites and email", run: () => navUI.startLinkTool() },
  { id: "addBookmark", title: "Bookmark the current view", keys: "Ctrl+D", run: () => (showSidePanel("outline"), navUI.addBookmarkHere()) },
  { id: "attachFile", title: "Attach files to this PDF…", run: () => (showSidePanel("attach"), void navUI.loadAttachments().then(() => ($("#side-attach .nav-btn") as HTMLElement | null)?.click())) },
  { id: "showAttachments", title: "Show attached files", run: () => (showSidePanel("attach"), void navUI.loadAttachments()) },
  { id: "showLayers", title: "Show layers", run: () => (showSidePanel("layers"), void navUI.loadLayers()) },
  { id: "showChest", title: "Tool chest: saved markup tools", run: () => showChest() },
  { id: "saveToChest", title: "Save current tool to the tool chest…", run: () => (showChest(), chestUI.saveCurrent()) },
  { id: "exportMarkups", title: "Export markup list to Excel or CSV…", run: () => void exportMarkupList() },
  { id: "tool-edit", title: "Edit tool: change page text and images", keys: "E", run: () => useTool("edit") },
  { id: "insertImage", title: "Insert image…", run: () => (annot.setTool("edit"), editUI.insertImage()) },
  { id: "replaceImage", title: "Replace selected image…", run: () => editUI.replaceSelectedImage() },
  { id: "saveImage", title: "Extract image: save a picture, or any area of the page, as PNG…", run: () => editUI.extractImageFlow() },
  { id: "textStyle", title: "Font, size and colour for new text…", run: () => editUI.setTextStyle() },
  { id: "createPdf", title: "Create PDF from files (images, Word, Excel, PowerPoint, HTML, text)…", keys: "Ctrl+N", run: () => createPdf() },
  { id: "newBlank", title: "New blank PDF…", keys: "Ctrl+Shift+N", run: () => newBlank() },
  { id: "exportAs", title: "Export to Word, images, HTML or text…", keys: "Ctrl+Shift+E", run: () => exportAs() },
  { id: "signCert", title: "Sign with a certificate (.pfx / .p12)…", run: () => signWithCertificate() },
  { id: "verifySigs", title: "Validate signatures", run: () => showSignatureDetails() },
  { id: "makeCert", title: "Create a self-signed certificate…", run: () => createCertificate() },
  { id: "fillCsv", title: "Fill form from a spreadsheet (CSV), one file per row…", run: () => fillFromCsv() },
  { id: "exportForm", title: "Export form data (CSV)", run: () => exportFormData() },
  { id: "clearForm", title: "Clear all form fields", run: async () => { if (!active) return; await engine.clearForm(active.info.id); active.dirty = true; buildView(); } },
  { id: "flatten", title: "Flatten comments and form fields…", run: async () => { if (!active) return; const r = await ask("Flatten", [{ name: "w", label: "What to flatten", type: "select", value: "both", options: [["both", "Comments and form fields"], ["fields", "Form fields only"], ["comments", "Comments only"]] }], "Flatten"); if (!r) return; active.info = await engine.flatten(active.info.id, r.w !== "fields", r.w !== "comments"); active.dirty = true; buildView(); status("Flattened. Ctrl+Z to undo."); } },
  { id: "ocr", title: "Recognize text (OCR): make scanned pages searchable…", keys: "Ctrl+Shift+O", run: () => recognizeText() },
  { id: "cleanScans", title: "Clean up scans: straighten, remove specks, delete blank pages…", run: () => void cleanScansFlow() },
  { id: "ocrPage", title: "Recognize text on this page (OCR)", run: () => active && recognizeText([active.page]) },
  { id: "compare", title: "Compare files: find what changed between two versions…", keys: "Ctrl+Shift+C", run: () => compareFiles() },
  { id: "checkDoc", title: "Check document: PDF/A, accessibility and security…", run: () => checkDocumentFlow() },
  { id: "saveAsPdfa", title: "Save as PDF/A (archiving)…", run: () => saveAsPdfa() },
  { id: "fixProps", title: "Set title, language and tab order (accessibility)…", run: () => active && quickFixes(active) },
  { id: "watchFolders", title: "Watch folders: process PDFs dropped into a folder automatically…", run: () => openWatchPanel() },
  { id: "palette", title: "Show all commands", keys: "Ctrl+K", run: () => openPalette() },
];
// Remember what people use so the command palette lists it first.
const USED_KEY = "hdfstudio.usedCommands";
let usedCommands: string[] = JSON.parse(localStorage.getItem(USED_KEY) ?? "[]");
for (const c of commands) {
  const run = c.run;
  c.run = () => {
    if (c.id !== "palette") {
      usedCommands = [c.id, ...usedCommands.filter((x) => x !== c.id)].slice(0, 12);
      localStorage.setItem(USED_KEY, JSON.stringify(usedCommands));
    }
    return run();
  };
}
const byId = Object.fromEntries(commands.map((c) => [c.id, c]));
const ribbon = setupRibbon($("#tasks"), $("#ribbon"), {
  run: (id) => byId[id]?.run(),
  describe: (id) => byId[id],
  slots: { color: colorSlot },
});
annot.setTool("hand");
document.querySelectorAll<HTMLElement>("[data-cmd]").forEach((b) => (b.onclick = () => byId[b.dataset.cmd!]?.run()));
onDocState = (has) => ribbon.setHasDocument(has);
document.querySelectorAll('[data-cmd="toggleSnap"]').forEach((b) => b.classList.toggle("active", eng.snapOn));
onDocState(!!active);

function keyString(e: KeyboardEvent) {
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  let shift = e.shiftKey;
  if (key === "+") (key = "="), (shift = false); // Ctrl++ and Ctrl+= both zoom in
  if (key === "_") (key = "-"), (shift = false);
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", shift ? "Shift" : "", e.altKey ? "Alt" : "", key].filter(Boolean).join("+");
}
document.addEventListener("keydown", (e) => {
  const tg = e.target as HTMLElement | null;
  const typing = tg instanceof HTMLInputElement || tg instanceof HTMLTextAreaElement || tg instanceof HTMLSelectElement || !!tg?.isContentEditable;
  const ks = keyString(e);
  const cmd = commands.find((c) => c.keys === ks);
  if (e.key === "Escape") (pendingPlacement = null), chestUI?.release();
  if (!cmd) {
    if (e.key === "Escape") closePalette();
    return;
  }
  // Plain navigation keys shouldn't fire while typing in a field.
  if (typing && ((!ks.includes("Ctrl") && !ks.startsWith("F")) || cmd.id === "undo" || cmd.id === "redo")) return;
  e.preventDefault();
  // Focus-moving commands run at once so the next keystrokes land in the right box;
  // the rest wait a tick so this keystroke can't leak into a dialog they open.
  if (cmd.id === "palette" || cmd.id === "find" || cmd.id === "goto") cmd.run();
  else setTimeout(() => cmd.run(), 0);
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
/** Lower is better: whole phrase at a word start, then anywhere, then all words, then loose letters. */
function matchScore(q: string, title: string) {
  q = q.trim().toLowerCase();
  const t = title.toLowerCase();
  if (!q) return 0;
  const i = t.indexOf(q);
  if (i === 0 || (i > 0 && /\W/.test(t[i - 1]))) return 1;
  if (i > 0) return 2;
  if (q.split(/\s+/).every((w) => t.includes(w))) return 3;
  return fuzzy(q.replace(/\s+/g, ""), t) ? 4 : -1;
}
function filteredCommands() {
  // Recently used commands first: at the top of an empty search, and ahead of equal matches.
  const recent = (id: string) => {
    const k = usedCommands.indexOf(id);
    return k < 0 ? 99 : k;
  };
  return commands
    .map((c, i) => ({ c, i, s: c.id === "palette" ? -1 : matchScore(paletteInput.value, c.title) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || recent(a.c.id) - recent(b.c.id) || a.i - b.i)
    .map((x) => x.c);
}
function renderPalette() {
  const list = filteredCommands();
  paletteSel = Math.min(paletteSel, Math.max(0, list.length - 1));
  paletteList.replaceChildren(
    ...list.map((c, i) => {
      const li = document.createElement("li");
      li.className = i === paletteSel ? "sel" : "";
      li.innerHTML = `<span></span><small class="task-tag"></small><kbd></kbd>`;
      li.firstElementChild!.textContent = c.title;
      li.querySelector(".task-tag")!.textContent = taskOf(c.id);
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

// ---------- Staff sign-in ----------
const signIn = setupSignIn({
  logoHtml: `<img src="/hive-logo.png" alt="Hive Engineering" />`,
  onUser: (u) => localStorage.setItem("hdfstudio.author", u.name),
  status,
});
void signIn.start();

// ---------- Startup: files passed on the command line / "Open with" ----------
(async () => {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const { listen } = await import("@tauri-apps/api/event");
  const openPaths = async (paths: string[]) =>
    paths.length && openFiles(await Promise.all(paths.map(async (p) => ({ name: baseName(p), path: p, data: await readFile(p) }))));
  await listen<string[]>("open-files", (e) => openPaths(e.payload));
  // Don't lose work: closing the window with unsaved documents asks first.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.onCloseRequested(async (e) => {
    const unsaved = tabs.filter((t) => t.dirty);
    if (!unsaved.length) return;
    e.preventDefault();
    const names = unsaved.slice(0, 3).map((t) => t.name).join(", ") + (unsaved.length > 3 ? ` and ${unsaved.length - 3} more` : "");
    if (await confirmDialog(`Unsaved changes in ${names}. Close HDS and lose them?`, "Close without saving")) await win.destroy();
  });
  await openPaths(await invoke<string[]>("startup_files"));
})().catch((e) => status(String(e)));

// ---------- Icons for the static chrome ----------
const STATIC_ICONS: Record<string, I.IconNode> = {
  search: I.Search, up: I.ChevronUp, down: I.ChevronDown, command: I.LayoutGrid, undo: I.Undo2, redo: I.Redo2,
  pages: I.LayoutGrid, outline: I.ListTree, results: I.ScanSearch, comments: I.MessagesSquare, attach: I.Paperclip, layers: I.Layers2, chest: I.Toolbox,
  rotl: I.RotateCcw, rotr: I.RotateCw, blank: I.FilePlus2, insert: I.FileInput, extract: I.FileOutput, trash: I.Trash2,
  left: I.ChevronLeft, right: I.ChevronRight, zoomin: I.ZoomIn, zoomout: I.ZoomOut, fitw: I.MoveHorizontal, fitp: I.Maximize,
  open: I.FolderOpen, create: I.FilePlus, merge: I.Merge, batch: I.Workflow, blankdoc: I.File, cert: I.FileKey, compare: I.GitCompare,
  cloud: I.CloudDownload, settings: I.Settings,
};
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
  const node = STATIC_ICONS[el.dataset.icon!];
  const big = el.closest(".card") ? 22 : el.closest("#rail") ? 20 : 16;
  if (node) el.prepend(icon(node, big));
});

// ---------- Recent files (desktop only: needs a path to reopen) ----------
const RECENT_KEY = "hdfstudio.recent";
const recentPaths = (): string[] => JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
function remember(path: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentPaths().filter((p) => p !== path)].slice(0, 10)));
}
/** OneDrive/SharePoint files go in the same list, as "cloud:" + JSON. */
function rememberCloud(ref: import("./cloud/graph").CloudRef) {
  const key = (x: string) => (x.startsWith("cloud:") ? (JSON.parse(x.slice(6)) as { itemId: string }).itemId : x);
  const entry = "cloud:" + JSON.stringify({ driveId: ref.driveId, itemId: ref.itemId, parentId: ref.parentId, name: ref.name, webUrl: ref.webUrl, where: ref.where });
  localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...recentPaths().filter((p) => key(p) !== ref.itemId)].slice(0, 10)));
}
function renderRecent() {
  const list = isTauri ? recentPaths() : [];
  $("#recent").classList.toggle("hidden", !list.length);
  $("#recentList").replaceChildren(
    ...list.map((p) => {
      const li = document.createElement("li");
      if (p.startsWith("cloud:")) {
        const ref = JSON.parse(p.slice(6)) as import("./cloud/graph").CloudRef;
        li.append(icon(I.Cloud, 16), Object.assign(document.createElement("span"), { textContent: ref.name }), Object.assign(document.createElement("small"), { textContent: ref.where }));
        li.title = `${ref.where} › ${ref.name}`;
        li.onclick = () => openCloudItem(ref);
        return li;
      }
      li.append(icon(I.FileText, 16), Object.assign(document.createElement("span"), { textContent: baseName(p) }), Object.assign(document.createElement("small"), { textContent: p }));
      li.title = p;
      li.onclick = async () => {
        try {
          const { readFile } = await import("@tauri-apps/plugin-fs");
          await openFiles([{ name: baseName(p), path: p, data: await readFile(p) }]);
        } catch {
          localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaths().filter((x) => x !== p)));
          status(`${p} is no longer available`);
          renderRecent();
        }
      };
      return li;
    }),
  );
}

// ---------- Watch folders ----------
async function tauriFs(): Promise<WatchFs> {
  const f = await import("@tauri-apps/plugin-fs");
  const sep = (p: string) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");
  return {
    async list(dir) {
      const entries = (await f.readDir(dir)).filter((e) => e.isFile);
      return Promise.all(entries.map(async (e) => {
        const st = await f.stat(dir + sep(dir) + e.name);
        return { name: e.name, size: st.size, mtime: st.mtime ? new Date(st.mtime).getTime() : 0 };
      }));
    },
    read: (p) => f.readFile(p),
    write: (p, d) => f.writeFile(p, d),
    mkdir: (p) => f.mkdir(p, { recursive: true }),
    move: (a, b) => f.rename(a, b),
    join: (...parts) => parts.join(sep(parts[0])),
  };
}
(async () => {
  const testFs = (window as unknown as { hdfStudioTestFs?: WatchFs }).hdfStudioTestFs ?? null;
  startWatching({
    run: (data, name, recipe) => batchDeps.runRecipe(data, name, recipe, {}),
    fs: testFs ?? (isTauri ? await tauriFs() : null),
    pickFolder: async (title) => {
      if (testFs) return (window as unknown as { hdfStudioTestFolder?: string }).hdfStudioTestFolder ?? null;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const d = await open({ directory: true, title });
      return typeof d === "string" ? d : null;
    },
    onStatus: (text) => {
      const pill = $("#watchPill");
      if (text.startsWith("Watching") || !text) {
        pill.textContent = text;
        pill.classList.toggle("hidden", !text);
      } else status(text);
    },
  });
})().catch((e) => status(String(e)));

// Exposed for tests and future modules.
// Look for a newer version shortly after start-up (desktop app only; quiet unless there is one).
setTimeout(() => checkForUpdates(status), 4000);

Object.assign(window, { hdfStudio: { openFiles, runSearch, goToPage, commands, get active() { return active; } } });
buildView();
