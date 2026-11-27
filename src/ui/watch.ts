// Watch folders panel (desktop app): pick a folder and a recipe; every PDF that lands in the folder
// is processed while HDS is open. The `hds watch` command does the same without the app.
import { FolderWatcher, OUT_DIR, DONE_DIR, type WatchFs, type WatchRule, type WatchEvent, type RunRecipe } from "../automation/watch";
import { allRecipes } from "./batch";

const RULES = "hdfstudio.watch";
const HANDLED = (id: string) => `hdfstudio.watch.handled.${id}`;
const POLL_MS = 4000;

export interface WatchDeps {
  run: RunRecipe;
  /** File system access, or null when not available (browser). */
  fs: WatchFs | null;
  pickFolder(title: string): Promise<string | null>;
  onStatus(text: string): void;
}

const loadRules = (): WatchRule[] => JSON.parse(localStorage.getItem(RULES) ?? "[]");
const saveRules = (r: WatchRule[]) => localStorage.setItem(RULES, JSON.stringify(r));

let deps: WatchDeps;
let watchers: FolderWatcher[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
const events: WatchEvent[] = [];
let root: HTMLElement | null = null;

/** Start the watchers saved from last time. */
export function startWatching(d: WatchDeps) {
  deps = d;
  rebuild();
}

function rebuild() {
  if (!deps.fs) return;
  watchers = loadRules().map(
    (r) =>
      new FolderWatcher(r, deps.fs!, (n) => allRecipes().find((x) => x.name === n), deps.run, onEvent, new Set(JSON.parse(localStorage.getItem(HANDLED(r.id)) ?? "[]"))),
  );
  const on = watchers.filter((w) => w.rule.enabled).length;
  if (on && !timer) timer = setInterval(poll, POLL_MS);
  if (!on && timer) (clearInterval(timer), (timer = null));
  deps.onStatus(on ? `Watching ${on} folder${on === 1 ? "" : "s"}` : "");
  render();
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    for (const w of watchers) {
      try {
        if (await w.tick()) localStorage.setItem(HANDLED(w.rule.id), JSON.stringify([...w.handled].slice(-2000)));
      } catch (e) {
        onEvent({ rule: w.rule, file: "", ok: false, message: (e as Error).message ?? String(e), at: new Date() });
      }
    }
  } finally {
    busy = false;
  }
}

function onEvent(e: WatchEvent) {
  events.unshift(e);
  events.length = Math.min(events.length, 100);
  if (e.file) deps.onStatus(`${e.ok ? "✓" : "✗"} ${e.file} ${e.ok ? "processed" : "failed"} (watch folder)`);
  render();
}

export function openWatchPanel() {
  if (!root) root = build();
  root.classList.remove("hidden");
  render();
}

function build() {
  const r = document.createElement("div");
  r.className = "modal-back hidden";
  r.id = "watch";
  r.innerHTML = `
  <div class="watch modal">
    <header><h2>Watch folders</h2><button class="close icon-btn" title="Close (Esc)">×</button></header>
    <p class="muted">Every PDF dropped into a watched folder is run through a recipe while HDS is open. Results go to <code>${OUT_DIR}</code> inside the folder and originals move to <code>${DONE_DIR}</code>. Scanners and shared drives work too.</p>
    <div id="watchRules"></div>
    <div class="row"><button id="watchAdd" class="primary">Add watch folder…</button></div>
    <h3>Activity</h3>
    <ul id="watchLog"></ul>
  </div>`;
  r.querySelector<HTMLElement>(".close")!.onclick = () => r.classList.add("hidden");
  r.addEventListener("keydown", (e) => e.key === "Escape" && r.classList.add("hidden"));
  r.addEventListener("click", (e) => e.target === r && r.classList.add("hidden"));
  r.querySelector<HTMLElement>("#watchAdd")!.onclick = addRule;
  document.body.append(r);
  return r;
}

async function addRule() {
  if (!deps.fs) return;
  const folder = await deps.pickFolder("Choose the folder to watch");
  if (!folder) return;
  const recipes = allRecipes();
  const { ask } = await import("./dialog");
  const v = await ask(
    "Watch folder",
    [
      { name: "recipe", label: "Recipe to run", type: "select", value: recipes[0]?.name, options: recipes.map((x): [string, string] => [x.name, x.name]), hint: "Make your own in Batch (Ctrl+B) and save it; it appears here." },
      { name: "afterwards", label: "Afterwards", type: "select", value: "move", options: [["move", `Move originals to "${DONE_DIR}"`], ["keep", "Leave originals where they are"]] },
      { name: "out", label: "Output folder", type: "select", value: "inside", options: [["inside", `"${OUT_DIR}" inside the watched folder`], ["choose", "Choose another folder…"]] },
    ],
    "Start watching",
  );
  if (!v) return;
  let out: string | undefined;
  if (v.out === "choose") {
    out = (await deps.pickFolder("Choose where processed files go")) ?? undefined;
    if (!out) return;
  }
  const rules = loadRules();
  rules.push({ id: Date.now().toString(36), folder, recipe: v.recipe, out, afterwards: v.afterwards as "move" | "keep", enabled: true });
  saveRules(rules);
  rebuild();
  poll();
}

function render() {
  if (!root) return;
  const list = root.querySelector("#watchRules")!;
  const rules = loadRules();
  list.replaceChildren(
    ...(rules.length
      ? rules.map((r) => {
          const row = document.createElement("div");
          row.className = "watch-rule" + (r.enabled ? "" : " off");
          row.innerHTML = `<label class="switch"><input type="checkbox" ${r.enabled ? "checked" : ""}/><span></span></label><div><b></b><small></small></div><button class="remove">Remove</button>`;
          row.querySelector("b")!.textContent = r.folder;
          row.querySelector("small")!.textContent = `${r.recipe} → ${r.out ?? OUT_DIR}${r.afterwards === "keep" ? " · originals stay" : ""}`;
          row.querySelector<HTMLInputElement>("input")!.onchange = (e) => {
            const all = loadRules();
            all.find((x) => x.id === r.id)!.enabled = (e.target as HTMLInputElement).checked;
            saveRules(all);
            rebuild();
          };
          row.querySelector<HTMLElement>(".remove")!.onclick = () => {
            saveRules(loadRules().filter((x) => x.id !== r.id));
            localStorage.removeItem(HANDLED(r.id));
            rebuild();
          };
          return row;
        })
      : [Object.assign(document.createElement("p"), { className: "muted", textContent: deps.fs ? "No folders yet." : "Watch folders need the desktop app. From a terminal: hds watch <folder> --recipe <name>." })]),
  );
  (root.querySelector("#watchAdd") as HTMLButtonElement).disabled = !deps.fs;
  root.querySelector("#watchLog")!.replaceChildren(
    ...events.slice(0, 30).map((e) => {
      const li = document.createElement("li");
      li.className = e.ok ? "ok" : "bad";
      li.textContent = `${e.at.toLocaleTimeString()}  ${e.ok ? "✓" : "✗"} ${e.file ? e.file + " " : ""}${e.message}`;
      return li;
    }),
  );
}
