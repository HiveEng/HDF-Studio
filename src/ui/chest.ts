// Tool chest: saved markup tools (a red revision cloud, a blue length, "Approved as Noted"…)
// that apply with one click. Export the chest to a file and import it on other PCs so the
// whole team marks up the same way.
import { getPrefs, setToolOverride, type ToolGroup, type ToolPrefs, REVIEW_STAMPS } from "./prefs";
import { ask, confirmDialog } from "./dialog";
import { showMenu } from "./contextmenu";

export interface Preset {
  id: string;
  name: string;
  /** Tool id: rect, ellipse, arrow, ink, text, or an engineering tool (cloud, callout, m-length…). */
  tool: string;
  color?: string;
  width?: number;
  opacity?: number;
  fontSize?: number;
  /** Text boxes and callouts: fill colour or "none"; callouts: arrow head. */
  fill?: string;
  arrow?: string;
  /** Text boxes and callouts: 0 left, 1 centre, 2 right. */
  align?: number;
  /** For stamps. */
  stamp?: { title: string; color: string };
}

const KEY = "hdfstudio.chest";

export const TOOL_GROUP: Record<string, ToolGroup> = {
  rect: "shapes", ellipse: "shapes", arrow: "shapes", ink: "ink", text: "text",
  cloud: "cloud", cloudpoly: "cloud", callout: "callout", leader: "callout", polyline: "lines", polygon: "lines", dimension: "dimension",
  stamp: "shapes", "m-length": "measure", "m-polylength": "measure", "m-area": "measure", "m-perimeter": "measure", "m-angle": "measure", "m-count": "count",
};
export const TOOL_NAMES: Record<string, string> = {
  rect: "Rectangle", ellipse: "Ellipse", arrow: "Arrow", ink: "Pen", text: "Text box", cloud: "Revision cloud", cloudpoly: "Cloud shape",
  callout: "Callout", polyline: "Polyline", polygon: "Polygon", dimension: "Dimension", stamp: "Stamp", "m-length": "Length", "m-polylength": "Polylength",
  "m-area": "Area", "m-perimeter": "Perimeter", "m-angle": "Angle", "m-count": "Count",
};

const uid = () => Math.random().toString(36).slice(2, 10);
const STARTER: Preset[] = [
  { id: "s1", name: "Revision cloud (red)", tool: "cloud", color: "#d91a1a", width: 1.5 },
  { id: "s2", name: "Callout (red)", tool: "callout", color: "#d91a1a", fontSize: 10 },
  { id: "s3", name: "Highlight box (yellow, see-through)", tool: "rect", color: "#e0b000", width: 2, opacity: 0.6 },
  { id: "s4", name: "Approved as Noted", tool: "stamp", stamp: { title: "APPROVED AS NOTED", color: "#1a7f37" } },
  { id: "s5", name: "Revise and Resubmit", tool: "stamp", stamp: { title: "REVISE AND RESUBMIT", color: "#c25e00" } },
  { id: "s6", name: "Length (blue)", tool: "m-length", color: "#0b6fd6", width: 1.5, fontSize: 10 },
  { id: "s7", name: "Area (green)", tool: "m-area", color: "#1a7f37", width: 1.5, fontSize: 10 },
  { id: "s8", name: "Count (red dots)", tool: "m-count", color: "#d91a1a", fontSize: 9 },
];

export function getChest(): Preset[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(v)) return v;
  } catch { /* starter set */ }
  return STARTER.map((p) => ({ ...p }));
}
const saveChest = (list: Preset[]) => localStorage.setItem(KEY, JSON.stringify(list));
/** Add a tool to the chest (from a markup's style). */
export function addToChest(p: Omit<Preset, "id">) {
  saveChest([...getChest(), { ...p, id: uid() }]);
}

export function validPreset(x: unknown): x is Preset {
  const p = x as Preset;
  return !!p && typeof p.name === "string" && typeof p.tool === "string" && p.tool in TOOL_GROUP;
}

export interface ChestDeps {
  el: HTMLElement;
  /** Start a tool (with a stamp choice for stamps). */
  start(tool: string, stamp?: { title: string; color: string }): void;
  tool(): string;
  clearRibbonColor(): void;
  saveText(name: string, text: string): Promise<void>;
  pickText(): Promise<string | null>;
  status(msg: string): void;
}

export function setupChest(d: ChestDeps) {
  let activeId: string | null = null;

  function use(p: Preset) {
    const group = TOOL_GROUP[p.tool];
    const o: Partial<ToolPrefs> = {};
    if (p.color) o.color = p.color;
    if (p.width) o.width = p.width;
    if (p.opacity) o.opacity = p.opacity;
    if (p.fontSize) o.fontSize = p.fontSize;
    if (p.fill) o.fill = p.fill;
    if (p.arrow) o.arrow = p.arrow;
    if (p.align !== undefined) o.align = p.align;
    d.clearRibbonColor();
    d.start(p.tool, p.stamp);
    // start() may reset the override (a plain tool pick does); set it after.
    setToolOverride({ group, p: o });
    activeId = p.id;
    render();
    d.status(`${p.name}: ready. Pick another tool or press Esc to go back to your normal settings.`);
  }
  /** Called when the user picks a tool the normal way. */
  function release() {
    if (!activeId) return;
    activeId = null;
    setToolOverride(null);
    render();
  }

  async function edit(p?: Preset) {
    const cur = d.tool();
    const tool = p?.tool ?? (cur in TOOL_GROUP ? cur : "cloud");
    const base = getPrefs().tools[TOOL_GROUP[tool]];
    const r = await ask(p ? "Edit tool" : "Save a tool to the chest", [
      { name: "name", label: "Name", value: p?.name ?? `${TOOL_NAMES[tool]} (${base.color})` },
      { name: "tool", label: "Tool", type: "select", value: tool, options: Object.entries(TOOL_NAMES) },
      { name: "color", label: "Colour", type: "color", value: p?.color ?? base.color },
      { name: "width", label: "Line width (pt)", type: "number", value: String(p?.width ?? base.width) },
      { name: "opacity", label: "Opacity (%)", type: "number", value: String(Math.round((p?.opacity ?? base.opacity) * 100)) },
      { name: "fontSize", label: "Text size (pt)", type: "number", value: String(p?.fontSize ?? base.fontSize) },
      { name: "fill", label: "Fill (text boxes and callouts)", type: "select", value: p?.fill ?? base.fill ?? "none", options: [["none", "None"], ["#ffffff", "White"], ["#ffff99", "Light yellow"], ["#e8f7fd", "Light blue"]] },
      { name: "stamp", label: "Stamp (for the Stamp tool)", type: "select", value: p?.stamp?.title ?? "APPROVED AS NOTED", options: REVIEW_STAMPS.map((s) => [s.title, s.title]) },
    ], p ? "Save" : "Add to chest");
    if (!r) return;
    const st = REVIEW_STAMPS.find((s) => s.title === r.stamp);
    const next: Preset = {
      id: p?.id ?? uid(), name: r.name.trim() || TOOL_NAMES[r.tool], tool: r.tool, color: r.color,
      width: +r.width > 0 ? +r.width : undefined, opacity: +r.opacity > 0 ? Math.min(1, +r.opacity / 100) : undefined,
      fontSize: +r.fontSize > 0 ? +r.fontSize : undefined, fill: r.tool === "text" || r.tool === "callout" ? r.fill : undefined, arrow: p?.arrow, stamp: r.tool === "stamp" && st ? { ...st } : undefined,
    };
    const list = getChest();
    const i = list.findIndex((x) => x.id === next.id);
    if (i >= 0) list[i] = next;
    else list.push(next);
    saveChest(list);
    render();
  }

  async function remove(p: Preset) {
    if (!(await confirmDialog(`Remove "${p.name}" from the tool chest?`, "Remove"))) return;
    saveChest(getChest().filter((x) => x.id !== p.id));
    render();
  }
  function move(p: Preset, by: number) {
    const list = getChest();
    const i = list.findIndex((x) => x.id === p.id), j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveChest(list);
    render();
  }
  async function exportChest() {
    await d.saveText("HDF Studio tool chest.json", JSON.stringify({ app: "HDF Studio", kind: "tool-chest", version: 1, tools: getChest() }, null, 2));
  }
  async function importChest() {
    const text = await d.pickText();
    if (!text) return;
    let tools: unknown[] = [];
    try {
      const v = JSON.parse(text);
      tools = Array.isArray(v) ? v : Array.isArray(v?.tools) ? v.tools : [];
    } catch {
      return d.status("That file isn't a tool chest.");
    }
    const good = tools.filter(validPreset).map((p) => ({ ...p, id: uid() }));
    if (!good.length) return d.status("No tools found in that file.");
    const r = await ask(`Import ${good.length} tool${good.length === 1 ? "" : "s"}`, [{ name: "how", label: "How", type: "select", value: "add", options: [["add", "Add to my chest"], ["replace", "Replace my chest"]] }], "Import");
    if (!r) return;
    const list = r.how === "replace" ? good : [...getChest(), ...good.filter((g) => !getChest().some((x) => x.name === g.name && x.tool === g.tool))];
    saveChest(list);
    render();
    d.status(`Imported ${good.length} tool${good.length === 1 ? "" : "s"}.`);
  }

  function render() {
    const bar = document.createElement("div");
    bar.className = "nav-bar";
    const mk = (label: string, title: string, run: () => void) => Object.assign(document.createElement("button"), { type: "button", className: "nav-btn", textContent: label, title, onclick: run });
    bar.append(mk("+ Save tool", "Save a tool with its colour, line and text size", () => void edit()), mk("Import…", "Add tools from a chest file a colleague shared", () => void importChest()), mk("Export…", "Save your chest to a file to share with the team", () => void exportChest()));
    const list = document.createElement("div");
    list.className = "nav-list";
    for (const p of getChest()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chest-item" + (p.id === activeId ? " active" : "");
      const sw = document.createElement("span");
      sw.className = "chest-swatch";
      sw.style.background = p.stamp?.color ?? p.color ?? "#999";
      if (p.opacity && p.opacity < 1) sw.style.opacity = String(p.opacity);
      const txt = document.createElement("span");
      txt.className = "chest-name";
      txt.textContent = p.name;
      const kind = document.createElement("small");
      kind.textContent = TOOL_NAMES[p.tool] ?? p.tool;
      row.append(sw, txt, kind);
      row.onclick = () => use(p);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Use", run: () => use(p) },
          { label: "Edit…", run: () => void edit(p) },
          { label: "Move up", run: () => move(p, -1) },
          { label: "Move down", run: () => move(p, 1) },
          { sep: true },
          { label: "Remove", danger: true, run: () => void remove(p) },
        ], p.name);
      };
      list.append(row);
    }
    d.el.replaceChildren(bar, list);
  }

  return { render, release, use, saveCurrent: () => void edit() };
}
