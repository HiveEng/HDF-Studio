// Bookmarks editor, attachments and layers panels, and the Link tool.
import type { Bookmark, PageLink, LinkTarget, Attachment, Layer } from "../engine/navigation";
import type { DocInfo } from "../engine/core";
import { ask, confirmDialog } from "./dialog";
import { showMenu, type MenuItem } from "./contextmenu";

export interface NavDeps {
  engine: {
    bookmarks(id: number): Promise<Bookmark[]>;
    setBookmarks(id: number, list: Bookmark[]): Promise<DocInfo>;
    links(id: number, page: number): Promise<PageLink[]>;
    addLink(id: number, page: number, rect: number[], target: LinkTarget): Promise<void>;
    updateLink(id: number, page: number, index: number, target: LinkTarget): Promise<void>;
    deleteLink(id: number, page: number, index: number): Promise<void>;
    attachments(id: number): Promise<Attachment[]>;
    addAttachment(id: number, name: string, data: Uint8Array, description?: string): Promise<void>;
    getAttachment(id: number, name: string): Promise<Uint8Array>;
    deleteAttachment(id: number, name: string): Promise<void>;
    layers(id: number): Promise<Layer[]>;
    setLayerVisible(id: number, index: number, visible: boolean): Promise<void>;
  };
  doc(): { info: DocInfo; page: number; name: string } | null;
  setInfo(info: DocInfo): void;
  pagesEl: HTMLElement;
  viewer: HTMLElement;
  outlineEl: HTMLElement;
  attachEl: HTMLElement;
  layersEl: HTMLElement;
  goToPage(page: number, y?: number): void;
  /** Visible top of the current page, in page points (for "bookmark this view"). */
  viewTop(): number;
  refreshPage(page: number): void;
  rebuild(): void;
  changed(label: string): void;
  status(msg: string): void;
  tool(): string;
  setTool(t: string): void;
  pickFiles(): Promise<{ name: string; data: Uint8Array }[]>;
  saveBytes(name: string, data: Uint8Array): Promise<void>;
  openUrl(url: string): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const btn = (label: string, title: string, run: () => void) => Object.assign(h("button", "nav-btn", label), { type: "button", title, onclick: run });
const kb = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function setupNav(d: NavDeps) {
  // ---------- Bookmarks ----------
  let tree: Bookmark[] = [];
  /** Path of indices to the selected bookmark. */
  let sel: number[] | null = null;

  const at = (path: number[]) => {
    let list = tree, node: Bookmark | undefined;
    for (const i of path) {
      node = list[i];
      list = node?.children ?? [];
    }
    return node ?? null;
  };
  const parentList = (path: number[]) => (path.length === 1 ? tree : at(path.slice(0, -1))!.children);

  async function loadBookmarks() {
    const doc = d.doc();
    tree = doc ? await d.engine.bookmarks(doc.info.id) : [];
    sel = null;
    renderBookmarks();
  }

  async function commit(label: string, keep: number[] | null) {
    const doc = d.doc();
    if (!doc) return;
    d.setInfo(await d.engine.setBookmarks(doc.info.id, tree));
    d.changed(label);
    tree = await d.engine.bookmarks(doc.info.id);
    sel = keep && at(keep) ? keep : null;
    renderBookmarks();
  }

  function renderBookmarks() {
    const doc = d.doc();
    const bar = h("div", "nav-bar");
    bar.append(
      btn("+ Add", "Bookmark the page you're looking at (Ctrl+D)", () => void addBookmark(false)),
      btn("+ Sub", "Add a bookmark inside the selected one", () => void addBookmark(true)),
      btn("Rename", "Rename the selected bookmark (F2)", () => void renameSel()),
      btn("↑", "Move up", () => void moveSel(-1)),
      btn("↓", "Move down", () => void moveSel(1)),
      btn("→", "Indent: make it part of the bookmark above", () => void indentSel(1)),
      btn("←", "Outdent", () => void indentSel(-1)),
      btn("✕", "Delete the selected bookmark (Delete)", () => void deleteSel()),
    );
    bar.querySelectorAll("button").forEach((b, i) => i > 1 && (b.disabled = !sel));
    const list = h("div", "nav-tree");
    const draw = (nodes: Bookmark[], path: number[], into: HTMLElement) => {
      nodes.forEach((n, i) => {
        const p = [...path, i];
        const row = h("div", "outline-item bm-item", n.title || "Untitled");
        row.tabIndex = 0;
        row.style.paddingLeft = `${8 + path.length * 14}px`;
        if (sel && sel.join(".") === p.join(".")) row.classList.add("active");
        row.title = n.url ?? (n.page !== null ? `Page ${n.page + 1}` : "No target");
        row.onclick = () => {
          sel = p;
          renderBookmarks();
          if (n.url) d.status(`Links to ${n.url}. Double-click to open it.`);
          else if (n.page !== null) d.goToPage(n.page, n.y);
        };
        row.ondblclick = () => (n.url ? d.openUrl(n.url) : void renameSel());
        row.oncontextmenu = (e) => {
          e.preventDefault();
          sel = p;
          renderBookmarks();
          showMenu(e.clientX, e.clientY, [
            { label: "Go to", run: () => { if (n.url) d.openUrl(n.url); else if (n.page !== null) d.goToPage(n.page, n.y); } },
            { label: "Rename…", keys: "F2", run: () => void renameSel() },
            { label: "Set to the current view", run: () => void retarget() },
            { label: "Link to a web address…", run: () => void retargetUrl() },
            { sep: true },
            { label: "Add bookmark after", run: () => void addBookmark(false) },
            { label: "Add sub-bookmark", run: () => void addBookmark(true) },
            { label: "Indent", run: () => void indentSel(1) },
            { label: "Outdent", run: () => void indentSel(-1) },
            { sep: true },
            { label: "Delete", keys: "Del", danger: true, run: () => void deleteSel() },
          ], "Bookmark");
        };
        into.append(row);
        if (n.children.length) draw(n.children, p, into);
      });
    };
    draw(tree, [], list);
    if (!tree.length) list.append(h("p", "muted", doc ? "No bookmarks yet. Go to a page and click + Add." : "Open a document to see its bookmarks."));
    d.outlineEl.replaceChildren(bar, list);
  }

  async function addBookmark(child: boolean) {
    const doc = d.doc();
    if (!doc) return;
    const r = await ask(child ? "Add sub-bookmark" : "Add bookmark", [
      { name: "title", label: "Title", value: `Page ${doc.page + 1}` },
      { name: "where", label: "Goes to", type: "select", value: "view", options: [["view", `Page ${doc.page + 1}, where you're looking now`], ["page", `Top of page ${doc.page + 1}`]] },
    ], "Add");
    if (!r) return;
    const b: Bookmark = { title: r.title.trim() || `Page ${doc.page + 1}`, page: doc.page, children: [], open: true };
    if (r.where === "view") b.y = Math.max(0, d.viewTop());
    let path: number[];
    if (child && sel) {
      const parent = at(sel)!;
      parent.children.push(b);
      parent.open = true;
      path = [...sel, parent.children.length - 1];
    } else if (sel) {
      const list = parentList(sel);
      list.splice(sel[sel.length - 1] + 1, 0, b);
      path = [...sel.slice(0, -1), sel[sel.length - 1] + 1];
    } else {
      tree.push(b);
      path = [tree.length - 1];
    }
    await commit("Added bookmark", path);
  }
  async function renameSel() {
    const n = sel && at(sel);
    if (!n) return;
    const r = await ask("Rename bookmark", [{ name: "title", label: "Title", value: n.title }], "Rename");
    if (!r || !r.title.trim()) return;
    n.title = r.title.trim();
    await commit("Renamed bookmark", sel);
  }
  async function retarget() {
    const doc = d.doc();
    const n = sel && at(sel);
    if (!doc || !n) return;
    Object.assign(n, { page: doc.page, y: Math.max(0, d.viewTop()), url: undefined });
    await commit("Bookmark now goes to this view", sel);
  }
  async function retargetUrl() {
    const n = sel && at(sel);
    if (!n) return;
    const r = await ask("Link bookmark to a web address", [{ name: "url", label: "Address", value: n.url ?? "https://" }], "Set");
    if (!r || !/^(https?:|mailto:)/i.test(r.url.trim())) return;
    Object.assign(n, { page: null, y: undefined, url: r.url.trim() });
    await commit("Bookmark now opens a web address", sel);
  }
  async function deleteSel() {
    if (!sel) return;
    const n = at(sel)!;
    if (n.children.length && !(await confirmDialog(`Delete "${n.title}" and the ${n.children.length} bookmark${n.children.length === 1 ? "" : "s"} inside it?`, "Delete"))) return;
    parentList(sel).splice(sel[sel.length - 1], 1);
    await commit("Deleted bookmark", null);
  }
  async function moveSel(by: number) {
    if (!sel) return;
    const list = parentList(sel), i = sel[sel.length - 1], j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await commit("Moved bookmark", [...sel.slice(0, -1), j]);
  }
  async function indentSel(dir: number) {
    if (!sel) return;
    const list = parentList(sel), i = sel[sel.length - 1];
    const [n] = list.splice(i, 1);
    let path: number[];
    if (dir > 0) {
      if (i === 0) return void list.splice(i, 0, n);
      list[i - 1].children.push(n);
      path = [...sel.slice(0, -1), i - 1, list[i - 1].children.length - 1];
    } else {
      if (sel.length === 1) return void list.splice(i, 0, n);
      const grand = parentList(sel.slice(0, -1));
      const pi = sel[sel.length - 2];
      grand.splice(pi + 1, 0, n);
      path = [...sel.slice(0, -2), pi + 1];
    }
    await commit(dir > 0 ? "Indented bookmark" : "Outdented bookmark", path);
  }
  d.outlineEl.addEventListener("keydown", (e) => {
    if (!sel || (e.target as HTMLElement).closest("input")) return;
    if (e.key === "Delete") (e.preventDefault(), void deleteSel());
    else if (e.key === "F2") (e.preventDefault(), void renameSel());
    else if (e.key === "ArrowUp" && e.altKey) (e.preventDefault(), void moveSel(-1));
    else if (e.key === "ArrowDown" && e.altKey) (e.preventDefault(), void moveSel(1));
  });

  // ---------- Attachments ----------
  async function loadAttachments() {
    const doc = d.doc();
    const list = doc ? await d.engine.attachments(doc.info.id).catch(() => []) : [];
    const bar = h("div", "nav-bar");
    bar.append(btn("+ Attach files…", "Attach files (calcs, specs, CAD, photos) inside this PDF", () => void attach()));
    const body = h("div", "nav-list");
    for (const a of list) {
      const row = h("div", "att-item");
      row.tabIndex = 0;
      const name = h("div", "att-name", a.name);
      const meta = h("div", "att-meta", [kb(a.size), a.modified, a.description].filter(Boolean).join(" · "));
      row.append(name, meta);
      row.ondblclick = () => void saveAtt(a.name);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Save a copy…", run: () => void saveAtt(a.name) },
          { label: "Replace with another file…", run: () => void attach(a.name) },
          { sep: true },
          { label: "Remove from PDF", danger: true, run: () => void removeAtt(a.name) },
        ], a.name);
      };
      const actions = h("div", "att-actions");
      actions.append(btn("Save", "Save a copy", () => void saveAtt(a.name)), btn("✕", "Remove from PDF", () => void removeAtt(a.name)));
      row.append(actions);
      body.append(row);
    }
    if (!list.length) body.append(h("p", "muted", doc ? "No attached files. Attach calcs, specs or photos so they travel with the PDF." : "Open a document to see its attachments."));
    d.attachEl.replaceChildren(bar, body);
  }
  async function attach(replace?: string) {
    const doc = d.doc();
    if (!doc) return;
    const files = await d.pickFiles();
    if (!files.length) return;
    for (const [i, f] of files.entries()) await d.engine.addAttachment(doc.info.id, replace && i === 0 ? replace : f.name, f.data);
    d.changed(files.length === 1 ? `Attached ${files[0].name}` : `Attached ${files.length} files`);
    await loadAttachments();
  }
  async function saveAtt(name: string) {
    const doc = d.doc();
    if (doc) await d.saveBytes(name, await d.engine.getAttachment(doc.info.id, name));
  }
  async function removeAtt(name: string) {
    const doc = d.doc();
    if (!doc || !(await confirmDialog(`Remove ${name} from this PDF?`, "Remove"))) return;
    await d.engine.deleteAttachment(doc.info.id, name);
    d.changed(`Removed ${name}`);
    await loadAttachments();
  }

  // ---------- Layers ----------
  async function loadLayers() {
    const doc = d.doc();
    const list = doc ? await d.engine.layers(doc.info.id).catch(() => []) : [];
    const body = h("div", "nav-list");
    if (list.length) {
      const bar = h("div", "nav-bar");
      bar.append(btn("Show all", "Turn every layer on", () => void setAll(list, true)), btn("Hide all", "Turn every layer off", () => void setAll(list, false)));
      d.layersEl.replaceChildren(bar, body);
    } else d.layersEl.replaceChildren(body);
    for (const l of list) {
      const row = h("label", "layer-item");
      const cb = Object.assign(h("input"), { type: "checkbox", checked: l.visible });
      cb.onchange = async () => {
        await d.engine.setLayerVisible(doc!.info.id, l.index, cb.checked);
        d.rebuild();
        d.status(`${l.name} ${cb.checked ? "shown" : "hidden"}. Layer visibility is saved with the file.`);
      };
      row.append(cb, h("span", "", l.name));
      body.append(row);
    }
    if (!list.length) body.append(h("p", "muted", doc ? "This document has no layers. CAD exports (AutoCAD, Revit, MicroStation) often include them." : "Open a document to see its layers."));
  }
  async function setAll(list: Layer[], v: boolean) {
    const doc = d.doc();
    if (!doc) return;
    for (const l of list) await d.engine.setLayerVisible(doc.info.id, l.index, v);
    d.rebuild();
    await loadLayers();
  }

  // ---------- Link tool ----------
  const linkActive = () => d.tool() === "link";
  let drag: { el: HTMLElement; page: number; a: [number, number]; b: [number, number] } | null = null;
  const pageOf = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    return el && d.pagesEl.contains(el) ? { el, page: Number(el.dataset.page) } : null;
  };
  const pt = (el: HTMLElement, page: number, e: MouseEvent): [number, number] => {
    const r = el.getBoundingClientRect();
    const [w, hh] = d.doc()!.info.pageSizes[page];
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * hh];
  };
  const SVGNS = "http://www.w3.org/2000/svg";
  const svgOf = (el: HTMLElement, page: number) => {
    let svg = el.querySelector("svg.link-ov") as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.classList.add("ov", "link-ov");
      const [w, hh] = d.doc()!.info.pageSizes[page];
      svg.setAttribute("viewBox", `0 0 ${w} ${hh}`);
      svg.setAttribute("preserveAspectRatio", "none");
      el.append(svg);
    }
    return svg;
  };
  const rectEl = (r: number[], cls: string) => {
    const n = document.createElementNS(SVGNS, "rect");
    n.setAttribute("class", cls);
    n.setAttribute("x", String(Math.min(r[0], r[2])));
    n.setAttribute("y", String(Math.min(r[1], r[3])));
    n.setAttribute("width", String(Math.abs(r[2] - r[0])));
    n.setAttribute("height", String(Math.abs(r[3] - r[1])));
    return n;
  };
  const linkCache = new Map<number, PageLink[]>();
  async function showLinks(page: number) {
    const doc = d.doc();
    const el = d.pagesEl.querySelector<HTMLElement>(`.page[data-page="${page}"]`);
    if (!doc || !el) return [];
    const links = await d.engine.links(doc.info.id, page);
    linkCache.set(page, links);
    const svg = svgOf(el, page);
    svg.querySelectorAll(".link-box").forEach((n) => n.remove());
    for (const l of links) svg.append(rectEl(l.rect, "link-box"));
    return links;
  }
  function clearLinkBoxes() {
    d.pagesEl.querySelectorAll(".link-ov").forEach((n) => n.remove());
    linkCache.clear();
  }
  const linkAt = (page: number, p: [number, number]) => (linkCache.get(page) ?? []).find((l) => p[0] >= l.rect[0] && p[0] <= l.rect[2] && p[1] >= l.rect[1] && p[1] <= l.rect[3]);

  async function askTarget(title: string, cur?: PageLink): Promise<LinkTarget | null> {
    const doc = d.doc()!;
    const r = await ask(title, [
      { name: "kind", label: "Link to", type: "select", value: cur?.url ? (cur.url.startsWith("mailto:") ? "mail" : "url") : "page", options: [["page", "A page in this document"], ["url", "A web address"], ["mail", "An email address"]] },
      { name: "page", label: `Page number (1–${doc.info.pageCount})`, type: "number", value: String((cur?.page ?? doc.page) + 1) },
      { name: "url", label: "Web or email address", value: cur?.url?.replace(/^mailto:/, "") ?? "", placeholder: "https://… or name@company.com" },
    ], "OK");
    if (!r) return null;
    if (r.kind === "page") {
      const p = Math.round(+r.page) - 1;
      if (!(p >= 0 && p < doc.info.pageCount)) return d.status("That page number isn't in this document."), null;
      return { page: p };
    }
    let u = r.url.trim();
    if (!u) return null;
    if (r.kind === "mail") u = "mailto:" + u.replace(/^mailto:/, "");
    else if (!/^[a-z]+:/i.test(u)) u = "https://" + u;
    return { url: u };
  }
  async function editLink(page: number, l: PageLink) {
    const t = await askTarget("Edit link", l);
    if (!t) return;
    await d.engine.updateLink(d.doc()!.info.id, page, l.index, t);
    d.changed("Edited link");
    await showLinks(page);
  }
  async function removeLink(page: number, l: PageLink) {
    await d.engine.deleteLink(d.doc()!.info.id, page, l.index);
    d.refreshPage(page);
    d.changed("Deleted link");
    await showLinks(page);
  }

  d.pagesEl.addEventListener("pointerdown", async (e) => {
    if (!linkActive() || e.button !== 0) return;
    const hit = pageOf(e);
    if (!hit || !d.doc()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!linkCache.has(hit.page)) await showLinks(hit.page);
    const p = pt(hit.el, hit.page, e);
    const l = linkAt(hit.page, p);
    if (l) return void editLink(hit.page, l);
    hit.el.setPointerCapture(e.pointerId);
    drag = { el: hit.el, page: hit.page, a: p, b: p };
  }, true);
  d.pagesEl.addEventListener("pointermove", (e) => {
    if (!linkActive()) return;
    const hit = pageOf(e);
    if (hit && !drag && !linkCache.has(hit.page)) void showLinks(hit.page);
    if (!drag) return;
    drag.b = pt(drag.el, drag.page, e);
    const svg = svgOf(drag.el, drag.page);
    svg.querySelectorAll(".link-new").forEach((n) => n.remove());
    svg.append(rectEl([...drag.a, ...drag.b], "link-box link-new"));
  }, true);
  d.pagesEl.addEventListener("pointerup", async (e) => {
    if (!linkActive() || !drag) return;
    e.stopPropagation();
    const cur = drag;
    drag = null;
    const r = [Math.min(cur.a[0], cur.b[0]), Math.min(cur.a[1], cur.b[1]), Math.max(cur.a[0], cur.b[0]), Math.max(cur.a[1], cur.b[1])];
    if (r[2] - r[0] < 4 || r[3] - r[1] < 4) return void svgOf(cur.el, cur.page).querySelectorAll(".link-new").forEach((n) => n.remove());
    const t = await askTarget("New link");
    svgOf(cur.el, cur.page).querySelectorAll(".link-new").forEach((n) => n.remove());
    if (!t) return;
    await d.engine.addLink(d.doc()!.info.id, cur.page, r, t);
    d.changed("Added link");
    await showLinks(cur.page);
  }, true);
  d.pagesEl.addEventListener("contextmenu", (e) => {
    if (!linkActive()) return;
    const hit = pageOf(e);
    if (!hit) return;
    const l = linkAt(hit.page, pt(hit.el, hit.page, e));
    if (!l) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const items: MenuItem[] = [
      { label: l.url ? `Open ${l.url.slice(0, 40)}` : `Go to page ${(l.page ?? 0) + 1}`, run: () => (l.url ? d.openUrl(l.url) : d.goToPage(l.page ?? 0, l.y)) },
      { label: "Edit link…", run: () => void editLink(hit.page, l) },
      { sep: true },
      { label: "Delete link", danger: true, run: () => void removeLink(hit.page, l) },
    ];
    showMenu(e.clientX, e.clientY, items, "Link");
  }, true);

  function startLinkTool() {
    d.setTool("link");
    linkCache.clear();
    const doc = d.doc();
    if (doc) void showLinks(doc.page);
    d.status("Link tool: drag a box to make a link, click a link to edit it, right-click to delete. Esc when done.");
  }

  return {
    loadBookmarks, loadAttachments, loadLayers, startLinkTool, clearLinkBoxes,
    addBookmarkHere: () => void addBookmark(false),
    refresh: () => (loadBookmarks(), loadAttachments(), loadLayers()),
  };
}
