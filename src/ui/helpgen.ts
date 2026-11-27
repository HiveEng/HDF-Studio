// Blocks of the user guide built from the live app, so they never fall out of date:
// each ribbon tab's buttons (with their icons, tooltips and shortcuts) and the full list of
// keyboard shortcuts.
import { TASKS, icon } from "./ribbon";

export interface GenCommand { id: string; title: string; keys?: string }

const keyCaps = (k: string) => {
  const span = document.createElement("span");
  span.className = "keys";
  k.split(/\+(?!$)/).forEach((p, i) => {
    if (i) span.append(Object.assign(document.createElement("span"), { textContent: "+" }));
    span.append(Object.assign(document.createElement("kbd"), { textContent: p.replace(/^Page(Up|Down)$/, "Page $1") }));
  });
  return span;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

/** Plain-language description: the button's hint, else its command title without the trailing "…". */
const what = (title: string | undefined, hint: string | undefined) => {
  const t = (hint ?? title ?? "").replace(/\s*\((?:Ctrl|Shift|Alt|F\d)[^)]*\)\s*$/, "").replace(/…$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

export function ribbonTable(taskId: string, describe: (cmd: string) => GenCommand | undefined): HTMLElement | null {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) return null;
  const wrap = el("div", { className: "table-wrap help-ribbon" });
  const table = el("table");
  table.append(el("thead", {}, el("tr", {}, el("th", { textContent: "Group" }), el("th", { textContent: "Button" }), el("th", { textContent: "What it does" }), el("th", { textContent: "Shortcut" }))));
  const body = el("tbody");
  for (const g of task.groups) {
    const btns = g.items.filter((i) => "cmd" in i) as { cmd: string; label: string; icon: Parameters<typeof icon>[0]; hint?: string }[];
    if (!btns.length) {
      if (g.items.some((i) => "el" in i && i.el === "color")) body.append(el("tr", {}, el("td", { className: "grp", textContent: g.label }), el("td", { textContent: "Colour" }), el("td", { textContent: "Colour for new markups. Pick Default to use each tool's own colour from Settings." }), el("td")));
      continue;
    }
    btns.forEach((b, k) => {
      const c = describe(b.cmd);
      const name = el("td", { className: "btn" }, icon(b.icon, 16), el("span", { textContent: b.label }));
      body.append(el("tr", {},
        el("td", { className: "grp", textContent: k === 0 ? g.label : "" }),
        name,
        el("td", { textContent: what(c?.title, b.hint) }),
        el("td", {}, ...(c?.keys ? [keyCaps(c.keys)] : [])),
      ));
    });
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

const GROUPS: [string, (id: string) => boolean][] = [
  ["Files and tabs", (id) => ["open", "save", "saveAs", "print", "closeTab", "nextTab", "prevTab", "createPdf", "newBlank", "mergeFiles", "openCloud", "saveCloud", "exportAs", "batch", "settings"].includes(id)],
  ["View and navigation", (id) => /zoom|fit|actualSize|Page|goto|toggleSidebar|find|Hit/.test(id) && id !== "findReplace" && id !== "findRedact"],
  ["Selecting and markup tools", (id) => id.startsWith("tool-") && !id.startsWith("tool-m-") && !["tool-dimension"].includes(id)],
  ["Measuring", (id) => id.startsWith("tool-m-") || id === "tool-dimension" || id === "toggleSnap"],
  ["Editing and review", (id) => ["undo", "redo", "findReplace", "spellCheck", "addBookmark", "rotateLeft", "rotateRight"].includes(id)],
  ["Documents", () => true],
];

export function shortcutTable(commands: GenCommand[]): HTMLElement {
  const keyed = commands.filter((c) => c.keys && c.id !== "help");
  const wrap = el("div", { className: "help-shortcuts" });
  const used = new Set<string>();
  for (const [name, test] of GROUPS) {
    const list = keyed.filter((c) => !used.has(c.id) && test(c.id));
    if (!list.length) continue;
    list.forEach((c) => used.add(c.id));
    const table = el("table");
    table.append(el("thead", {}, el("tr", {}, el("th", { textContent: name }), el("th", { textContent: "Keys" }))));
    const body = el("tbody");
    for (const c of list) body.append(el("tr", {}, el("td", { textContent: what(c.title, undefined) }), el("td", {}, keyCaps(c.keys!))));
    table.append(body);
    wrap.append(el("div", { className: "table-wrap" }, table));
  }
  return wrap;
}

/** The words a generated block shows, for searching. */
export function genText(kind: string, arg: string | undefined, describe: (cmd: string) => GenCommand | undefined, commands: GenCommand[]): string {
  if (kind === "ribbon") {
    const task = TASKS.find((t) => t.id === arg);
    if (!task) return "";
    return task.groups.map((g) => g.label + ": " + g.items.map((i) => ("cmd" in i ? `${i.label} (${what(describe(i.cmd)?.title, i.hint)})` : "")).join(", ")).join(". ");
  }
  if (kind === "shortcuts") return commands.filter((c) => c.keys).map((c) => `${what(c.title, undefined)} ${c.keys}`).join(". ");
  return "";
}
