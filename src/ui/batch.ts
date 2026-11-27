// Batch panel: run a recipe over many files at once, and keep your own saved recipes.
import { BUILTIN_RECIPES, STEP_EXAMPLES, STEP_LABELS, formatStep, parseStep, type Recipe } from "../engine/recipes";
import type { OpenedFile } from "../platform";
import { ask } from "./dialog";

export interface BatchDeps {
  runRecipe: (data: Uint8Array, name: string, recipe: Recipe, ctx: { batesOffset?: number; password?: string }) => Promise<{ outputs: { name: string; data: Uint8Array }[]; pagesStamped: number }>;
  pickFiles: () => Promise<OpenedFile[]>;
  filesFromList: (l: FileList | null) => Promise<OpenedFile[]>;
  openTabsAsFiles: () => Promise<OpenedFile[]>;
  saveMany: (files: { name: string; data: Uint8Array }[]) => Promise<string | null>;
  openOutput: (name: string, data: Uint8Array) => Promise<void>;
}

const STORE = "hdfstudio.recipes";
const loadSaved = (): Recipe[] => JSON.parse(localStorage.getItem(STORE) ?? "[]");
const storeSaved = (r: Recipe[]) => localStorage.setItem(STORE, JSON.stringify(r));

/** Saved recipes first, then built-in ones (used by watch folders too). */
export const allRecipes = (): Recipe[] => [...loadSaved(), ...BUILTIN_RECIPES.filter((b) => !loadSaved().some((s) => s.name === b.name))];

let root: HTMLElement | null = null;
let files: OpenedFile[] = [];

export function openBatch(deps: BatchDeps, preset?: { files?: OpenedFile[]; recipe?: string }) {
  if (!root) root = build(deps);
  if (preset?.files) addFiles(preset.files);
  if (preset?.recipe) selectRecipe(preset.recipe);
  root.classList.remove("hidden");
  (root.querySelector("#batchSteps") as HTMLElement).focus();
}

function el<T extends HTMLElement>(sel: string) {
  return root!.querySelector(sel) as T;
}

function build(deps: BatchDeps): HTMLElement {
  const r = document.createElement("div");
  r.id = "batch";
  r.className = "modal-back hidden";
  r.innerHTML = `
  <div class="batch">
    <header><h2>Batch</h2><span class="muted">Run a recipe on many PDFs at once. Same recipes work in the <code>hds</code> command line tool.</span><button class="close" title="Close (Esc)">×</button></header>
    <section class="b-files">
      <h3>1. Files <span id="batchCount" class="muted"></span></h3>
      <div class="row"><button id="batchAdd">Add files…</button><button id="batchTabs">Add open tabs</button><button id="batchClear">Clear</button></div>
      <ul id="batchList" class="drop"><li class="muted">Drop PDFs here</li></ul>
    </section>
    <section class="b-recipe">
      <h3>2. Recipe</h3>
      <div class="row"><select id="batchRecipe"></select><button id="batchSave" title="Save these steps as a recipe">Save</button><button id="batchDelete" title="Delete saved recipe">Delete</button></div>
      <small class="muted">Steps, one per line: <code>op key=value</code></small>
      <textarea id="batchSteps" spellcheck="false" rows="8"></textarea>
      <div class="row"><select id="batchAddStep"><option value="">+ Add step…</option></select></div>
      <label>Output name <input id="batchName" value="{name}" title="{name} {part} {date}" /></label>
      <small class="muted">Stamp variables: {page} {pages} {file} {date} {bates}. Bates numbers continue across files.</small>
    </section>
    <section class="b-run">
      <h3>3. Run</h3>
      <div class="row"><button id="batchRun" class="primary">Run on all files</button><button id="batchPreview" title="Run on the first file and open the result">Preview first file</button></div>
      <pre id="batchLog"></pre>
    </section>
  </div>`;
  document.body.append(r);
  root = r;

  const close = () => r.classList.add("hidden");
  el<HTMLButtonElement>(".close").onclick = close;
  r.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), close()));
  r.addEventListener("mousedown", (e) => e.target === r && close());

  el<HTMLButtonElement>("#batchAdd").onclick = async () => addFiles(await deps.pickFiles());
  el<HTMLButtonElement>("#batchTabs").onclick = async () => addFiles(await deps.openTabsAsFiles());
  el<HTMLButtonElement>("#batchClear").onclick = () => ((files = []), renderFiles());
  const list = el<HTMLElement>("#batchList");
  list.addEventListener("dragover", (e) => (e.preventDefault(), e.stopPropagation(), list.classList.add("over")));
  list.addEventListener("dragleave", () => list.classList.remove("over"));
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    list.classList.remove("over");
    addFiles(await deps.filesFromList(e.dataTransfer?.files ?? null));
  });

  const addStep = el<HTMLSelectElement>("#batchAddStep");
  for (const [op, label] of Object.entries(STEP_LABELS)) addStep.append(new Option(label, op));
  addStep.onchange = () => {
    const ta = el<HTMLTextAreaElement>("#batchSteps");
    if (addStep.value) ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + STEP_EXAMPLES[addStep.value as keyof typeof STEP_EXAMPLES];
    addStep.value = "";
    ta.focus();
  };

  el<HTMLSelectElement>("#batchRecipe").onchange = (e) => selectRecipe((e.target as HTMLSelectElement).value);
  el<HTMLButtonElement>("#batchSave").onclick = async () => {
    const cur = el<HTMLSelectElement>("#batchRecipe").value;
    const name = ((await ask("Save recipe", [{ name: "n", label: "Name", value: cur.startsWith("saved:") ? cur.slice(6) : "" }], "Save"))?.n ?? "").trim();
    if (!name) return;
    try {
      const recipe = currentRecipe(name);
      const saved = loadSaved().filter((x) => x.name !== name);
      saved.push(recipe);
      storeSaved(saved);
      fillRecipes();
      selectRecipe(`saved:${name}`);
      log(`Saved recipe "${name}"`);
    } catch (e) {
      log(`✗ ${(e as Error).message}`);
    }
  };
  el<HTMLButtonElement>("#batchDelete").onclick = () => {
    const cur = el<HTMLSelectElement>("#batchRecipe").value;
    if (!cur.startsWith("saved:")) return log("Built-in recipes can't be deleted");
    storeSaved(loadSaved().filter((x) => x.name !== cur.slice(6)));
    fillRecipes();
    selectRecipe(`builtin:${BUILTIN_RECIPES[0].name}`);
  };

  el<HTMLButtonElement>("#batchRun").onclick = () => run(deps, false);
  el<HTMLButtonElement>("#batchPreview").onclick = () => run(deps, true);

  fillRecipes();
  selectRecipe(`builtin:${BUILTIN_RECIPES[0].name}`);
  return r;
}

function fillRecipes() {
  const sel = el<HTMLSelectElement>("#batchRecipe");
  sel.replaceChildren();
  const saved = loadSaved();
  if (saved.length) {
    const g = document.createElement("optgroup");
    g.label = "My recipes";
    for (const s of saved) g.append(new Option(s.name, `saved:${s.name}`));
    sel.append(g);
  }
  const g = document.createElement("optgroup");
  g.label = "Built-in";
  for (const b of BUILTIN_RECIPES) g.append(new Option(b.name, `builtin:${b.name}`));
  sel.append(g, new Option("(Custom steps)", "custom"));
}

function selectRecipe(key: string) {
  const sel = el<HTMLSelectElement>("#batchRecipe");
  if (!key.includes(":") && key !== "custom") {
    // Accept a plain name, matching saved recipes first.
    key = loadSaved().some((s) => s.name === key) ? `saved:${key}` : `builtin:${key}`;
  }
  sel.value = key;
  const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const recipe = (kind === "saved" ? loadSaved() : BUILTIN_RECIPES).find((x) => x.name === name);
  if (!recipe) return;
  el<HTMLTextAreaElement>("#batchSteps").value = recipe.steps.map(formatStep).join("\n");
  el<HTMLInputElement>("#batchName").value = recipe.output ?? "{name}";
}

function currentRecipe(name?: string): Recipe {
  const lines = el<HTMLTextAreaElement>("#batchSteps").value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) throw new Error("Add at least one step");
  const sel = el<HTMLSelectElement>("#batchRecipe");
  return { name: name ?? sel.selectedOptions[0]?.text ?? "custom", steps: lines.map(parseStep), output: el<HTMLInputElement>("#batchName").value || "{name}" };
}

function addFiles(more: OpenedFile[]) {
  const pdfs = more.filter((f) => /\.pdf$/i.test(f.name));
  files.push(...pdfs);
  if (pdfs.length < more.length) log(`Skipped ${more.length - pdfs.length} non-PDF file(s)`);
  renderFiles();
}

function renderFiles() {
  const list = el<HTMLElement>("#batchList");
  el<HTMLElement>("#batchCount").textContent = files.length ? `(${files.length})` : "";
  if (!files.length) {
    list.innerHTML = `<li class="muted">Drop PDFs here</li>`;
    return;
  }
  list.replaceChildren(
    ...files.map((f, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span></span><button title="Remove">×</button>`;
      li.firstElementChild!.textContent = f.name;
      (li.lastElementChild as HTMLElement).onclick = () => (files.splice(i, 1), renderFiles());
      return li;
    }),
  );
}

function log(line: string, reset = false) {
  const pre = el<HTMLElement>("#batchLog");
  pre.textContent = (reset ? "" : pre.textContent) + line + "\n";
  pre.scrollTop = pre.scrollHeight;
}

async function run(deps: BatchDeps, previewOnly: boolean) {
  let recipe: Recipe;
  try {
    recipe = currentRecipe();
  } catch (e) {
    return log(`✗ ${(e as Error).message}`, true);
  }
  if (!files.length) return log("Add some files first", true);
  const todo = previewOnly ? files.slice(0, 1) : files;
  const btn = el<HTMLButtonElement>("#batchRun");
  btn.disabled = true;
  log(`${previewOnly ? "Previewing" : "Running"} "${recipe.name}" on ${todo.length} file(s)…`, true);
  const started = performance.now();
  const outputs: { name: string; data: Uint8Array }[] = [];
  let bates = 0, failed = 0;
  for (const f of todo) {
    try {
      // copy: the worker takes ownership of the buffer we send
      const res = await deps.runRecipe(f.data.slice(), f.name, recipe, { batesOffset: bates });
      bates += res.pagesStamped;
      outputs.push(...res.outputs);
      log(`✓ ${f.name}${res.outputs.length > 1 ? ` → ${res.outputs.length} files` : ""}`);
    } catch (e) {
      failed++;
      log(`✗ ${f.name}: ${(e as Error).message}`);
    }
  }
  btn.disabled = false;
  if (previewOnly) {
    if (outputs[0]) {
      await deps.openOutput(outputs[0].name, outputs[0].data);
      root!.classList.add("hidden");
    }
    return;
  }
  if (outputs.length) {
    const dir = await deps.saveMany(dedupe(outputs));
    log(`${todo.length - failed} done, ${failed} failed in ${((performance.now() - started) / 1000).toFixed(1)} s. ${dir ? `Saved ${outputs.length} file(s) to ${dir}` : "Downloaded."}`);
  }
}

/** Avoid two outputs overwriting each other when inputs share a name. */
function dedupe(out: { name: string; data: Uint8Array }[]) {
  const seen = new Map<string, number>();
  return out.map((o) => {
    const n = seen.get(o.name) ?? 0;
    seen.set(o.name, n + 1);
    return n ? { ...o, name: o.name.replace(/\.pdf$/i, ` (${n + 1}).pdf`) } : o;
  });
}
