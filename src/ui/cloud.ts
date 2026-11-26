// OneDrive / SharePoint file browser: one window for Open and Save. Left: places (OneDrive, Recent,
// Shared with me). Right: the folder, with a breadcrumb.
import type { Graph, CloudItem, CloudPlace } from "../cloud/graph";

export type CloudPick =
  | { mode: "open"; item: CloudItem; where: string }
  | { mode: "save"; driveId: string; parentId: string; name: string; existing?: CloudItem; where: string };

const OPENABLE = /\.(pdf|xps|oxps|epub|cbz|png|jpe?g|tiff?|bmp|gif|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|html?)$/i;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LAST = "hdfstudio.cloud.last";

function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
function when(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString();
}

export function browseCloud(g: Graph, o: { mode: "open" | "save"; name?: string }): Promise<CloudPick | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    const box = document.createElement("div");
    box.className = "modal cloud";
    box.setAttribute("role", "dialog");
    box.innerHTML = `
      <header><h2>${o.mode === "open" ? "Open from OneDrive" : "Save to OneDrive"}</h2></header>
      <div class="cloud-body">
        <nav class="cloud-places" aria-label="Places"><div class="cloud-msg">Connecting to Microsoft 365…</div></nav>
        <section class="cloud-main">
          <div class="cloud-crumbs"></div>
          <div class="cloud-list" role="listbox" tabindex="0"></div>
        </section>
      </div>
      <footer>
        ${o.mode === "save" ? `<label class="cloud-name"><span>File name</span><input name="name" value="${esc(o.name ?? "Document.pdf")}" /></label>` : `<span class="cloud-status"></span>`}
        <div class="modal-buttons"><button type="button" class="cancel">Cancel</button><button type="button" class="primary ok" disabled>${o.mode === "open" ? "Open" : "Save here"}</button></div>
      </footer>`;
    back.append(box);
    document.body.append(back);
    const placesEl = box.querySelector<HTMLElement>(".cloud-places")!;
    const crumbsEl = box.querySelector<HTMLElement>(".cloud-crumbs")!;
    const listEl = box.querySelector<HTMLElement>(".cloud-list")!;
    const okBtn = box.querySelector<HTMLButtonElement>(".ok")!;
    const nameIn = box.querySelector<HTMLInputElement>('input[name="name"]');

    // Where we are: a place, then folders inside a drive.
    let place: CloudPlace | null = null;
    let trail: { id: string; name: string }[] = [];
    let items: CloudItem[] = [];
    let selected: CloudItem | null = null;
    let token = 0;

    const done = (v: CloudPick | null) => {
      back.remove();
      resolve(v);
    };
    box.querySelector<HTMLButtonElement>(".cancel")!.onclick = () => done(null);
    back.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), done(null)));
    back.addEventListener("mousedown", (e) => e.target === back && done(null));

    const whereText = () => [place?.name, ...trail.slice(1).map((t) => t.name)].filter(Boolean).join(" › ");
    const canSaveHere = () => !!place && place.kind === "drive" && !!place.driveId;
    function refreshOk() {
      if (o.mode === "open") okBtn.disabled = !selected || selected.folder;
      else okBtn.disabled = !canSaveHere() || !nameIn!.value.trim();
    }
    nameIn?.addEventListener("input", refreshOk);

    function showError(e: unknown) {
      listEl.innerHTML = `<div class="cloud-msg error">${esc(String((e as Error).message ?? e))}</div>`;
    }

    function renderList() {
      crumbsEl.innerHTML = "";
      if (place) {
        const parts = place.kind === "drive" ? trail : [{ id: "", name: place.name }];
        parts.forEach((t, i) => {
          const b = Object.assign(document.createElement("button"), { type: "button", textContent: i === 0 ? place!.name : t.name });
          b.onclick = () => openFolder(trail.slice(0, i + 1));
          if (i) crumbsEl.append(Object.assign(document.createElement("span"), { textContent: "›" }));
          crumbsEl.append(b);
        });
      }
      const shown = items.filter((i) => i.folder || o.mode === "save" || OPENABLE.test(i.name));
      shown.sort((a, b) => +b.folder - +a.folder || a.name.localeCompare(b.name, undefined, { numeric: true }));
      listEl.innerHTML = shown.length ? "" : `<div class="cloud-msg">Nothing here.</div>`;
      for (const it of shown) {
        const row = document.createElement("div");
        row.className = "cloud-row" + (it.folder ? " folder" : "") + (o.mode === "save" && !it.folder && !/\.pdf$/i.test(it.name) ? " dim" : "");
        row.setAttribute("role", "option");
        row.innerHTML = `<span class="ico">${it.folder ? "📁" : /\.pdf$/i.test(it.name) ? "📄" : "🗎"}</span><span class="nm">${esc(it.name)}</span><span class="when">${esc(when(it.modified))}${it.modifiedBy ? ` · ${esc(it.modifiedBy)}` : ""}</span><span class="sz">${it.folder ? "" : size(it.size)}</span>`;
        row.onclick = () => {
          selected = it;
          listEl.querySelectorAll(".cloud-row").forEach((r) => r.classList.toggle("sel", r === row));
          if (o.mode === "save" && !it.folder) nameIn!.value = it.name;
          refreshOk();
        };
        row.ondblclick = () => {
          if (it.folder) return enter(it);
          if (o.mode === "open") return done({ mode: "open", item: it, where: whereText() });
          okBtn.click();
        };
        listEl.append(row);
      }
      refreshOk();
    }

    async function load(fn: () => Promise<CloudItem[]>) {
      const my = ++token;
      selected = null;
      listEl.innerHTML = `<div class="cloud-msg">Loading…</div>`;
      try {
        const r = await fn();
        if (my !== token) return;
        items = r;
        renderList();
      } catch (e) {
        if (my === token) showError(e);
      }
    }

    function enter(folder: CloudItem): Promise<void> | void {
      if (place?.kind !== "drive") {
        // From Recent / Shared: jump into that item's drive.
        place = { kind: "drive", name: folder.name, driveId: folder.driveId };
        trail = [{ id: folder.id, name: folder.name }];
      } else trail = [...trail, { id: folder.id, name: folder.name }];
      remember();
      return load(() => g.children(folder.driveId || place!.driveId!, folder.id));
    }
    function openFolder(t: typeof trail) {
      trail = t;
      remember();
      return load(() => g.children(place!.driveId!, t.at(-1)!.id));
    }
    function remember() {
      if (place?.kind === "drive") localStorage.setItem(LAST, JSON.stringify({ place, trail }));
    }

    async function choosePlace(p: CloudPlace, btn?: HTMLElement) {
      placesEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      place = p;
      trail = [];
      if (p.kind === "drive") {
        trail = [{ id: "root", name: p.name }];
        remember();
        return load(() => g.children(p.driveId!, "root"));
      }
      if (p.kind === "recent") return load(() => g.recent());
      return load(() => g.sharedWithMe());
    }
    function placeButton(p: CloudPlace) {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<b>${esc(p.name)}</b>${p.hint && p.kind !== "drive" ? `<small>${esc(p.hint.replace(/^https:\/\//, ""))}</small>` : ""}`;
      b.title = p.hint ?? p.name;
      b.onclick = () => choosePlace(p, b);
      return b;
    }

    okBtn.onclick = () => {
      if (o.mode === "open") {
        if (selected && !selected.folder) done({ mode: "open", item: selected, where: whereText() });
        return;
      }
      if (!canSaveHere()) return;
      let name = nameIn!.value.trim().replace(/[\\/:*?"<>|#%]/g, "-");
      if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ".pdf";
      const existing = items.find((i) => !i.folder && i.name.toLowerCase() === name.toLowerCase());
      done({ mode: "save", driveId: place!.driveId!, parentId: trail.at(-1)?.id ?? "root", name, existing, where: whereText() });
    };

    (async () => {
      let places: CloudPlace[];
      try {
        places = await g.places();
      } catch (e) {
        placesEl.innerHTML = "";
        return showError(e);
      }
      placesEl.innerHTML = "";
      const head = (t: string) => placesEl.append(Object.assign(document.createElement("h3"), { textContent: t }));
      head("Microsoft 365");
      const buttons = new Map<CloudPlace, HTMLElement>();
      for (const p of places) {
        const b = placeButton(p);
        buttons.set(p, b);
        placesEl.append(b);
      }
      // Start where the user was last time, else OneDrive.
      try {
        const last = JSON.parse(localStorage.getItem(LAST) ?? "null") as { place: CloudPlace; trail: typeof trail } | null;
        if (last?.place?.driveId && !last.place.siteId && last.trail?.length) {
          place = last.place;
          return openFolder(last.trail);
        }
      } catch {
        /* ignore */
      }
      const first = places.find((p) => p.kind === "drive") ?? places[0];
      if (first) choosePlace(first, buttons.get(first));
    })();
    setTimeout(() => (nameIn ?? listEl).focus(), 0);
  });
}
