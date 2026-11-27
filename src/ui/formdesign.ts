// Form designer: draw new fields on the page, select one or many to move, resize, align,
// distribute, match sizes, copy and paste; make copies in a grid or on other pages; set the Tab
// order; and turn a flat form into a fillable one with "Detect fields". Fields show as outlined
// boxes while designing.
import {
  AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween, MoveHorizontal, MoveVertical, Scaling, Copy, Grid3x3, Files,
  ListOrdered, List, Settings2, Trash2, type IconNode,
} from "lucide";
import type { FieldInfo } from "../engine/forms";
import type { FieldSpec, FieldProps, FieldPatch, DetectedField, NewFieldType, FieldRef } from "../engine/formdesign";
import { parseRanges } from "../engine/ranges";
import { ask } from "./dialog";
import { icon } from "./ribbon";
import { fieldProperties } from "./fieldprops";

export interface DesignDeps {
  engine: {
    fields(id: number): Promise<FieldInfo[]>;
    addField(id: number, page: number, spec: FieldSpec): Promise<number>;
    addFields(id: number, specs: (FieldSpec & { page: number })[]): Promise<number[]>;
    updateField(id: number, page: number, key: number, patch: FieldPatch): Promise<void>;
    updateFields(id: number, items: FieldRef[], patch: FieldPatch): Promise<void>;
    deleteFields(id: number, items: FieldRef[]): Promise<void>;
    setFieldRects(id: number, items: (FieldRef & { rect: number[] })[]): Promise<void>;
    cloneFields(id: number, jobs: { src: FieldRef; targets: { page: number; rect: number[] }[] }[]): Promise<FieldRef[]>;
    fieldProps(id: number, page: number, key: number): Promise<FieldProps>;
    fieldNames(id: number): Promise<string[]>;
    tabOrder(id: number, page: number): Promise<{ order: string; keys: number[] }>;
    setTabOrder(id: number, page: number, keys: number[]): Promise<void>;
    autoTabOrder(id: number, pages: number[], by: "rows" | "columns"): Promise<void>;
    detectFields(id: number, pages?: number[]): Promise<DetectedField[]>;
    suggestFieldName(id: number, page: number, rect: number[], type: NewFieldType): Promise<{ name: string; label: string }>;
  };
  doc(): { info: { id: number; pageSizes: [number, number][] } } | null;
  /** The page in view (0-based), where Paste puts fields. */
  currentPage(): number;
  pagesEl: HTMLElement;
  viewer: HTMLElement;
  pageEl(i: number): HTMLElement | undefined;
  refreshPage(i: number): void;
  changed(label: string): void;
  status(msg: string): void;
  /** Called when design mode ends so the fill-in inputs can be rebuilt. */
  onExit(): void;
  /** Called when design mode starts so other page tools can step aside. */
  onEnter(): void;
}

const TYPES: { id: NewFieldType; label: string; key: string; title: string }[] = [
  { id: "text", label: "Text", key: "T", title: "Text field (T): drag a box, or click for a standard size" },
  { id: "date", label: "Date", key: "A", title: "Date field (A): a text field that takes a date and shows a calendar when filling in" },
  { id: "checkbox", label: "Check box", key: "C", title: "Check box (C)" },
  { id: "radio", label: "Radio", key: "R", title: "Radio button (R): buttons placed one after another form a group" },
  { id: "combobox", label: "Dropdown", key: "D", title: "Dropdown list (D)" },
  { id: "listbox", label: "List", key: "L", title: "List box (L)" },
  { id: "signature", label: "Signature", key: "S", title: "Signature field (S)" },
  { id: "button", label: "Button", key: "B", title: "Button (B): clears the form, prints or opens a link when clicked" },
];
const DEFAULT_SIZE: Record<NewFieldType, [number, number]> = { text: [160, 18], date: [90, 18], checkbox: [12, 12], radio: [12, 12], combobox: [140, 18], listbox: [120, 54], signature: [180, 40], button: [90, 22] };
const TYPE_NAME: Record<string, string> = { text: "Text field", date: "Date field", checkbox: "Check box", radiobutton: "Radio button", radio: "Radio button", combobox: "Dropdown", listbox: "List box", signature: "Signature field", button: "Button" };
const square = (t: string) => t === "checkbox" || t === "radiobutton" || t === "radio";

type Arr = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "distH" | "distV" | "width" | "height" | "both";

export function setupFormDesign(d: DesignDeps) {
  let on = false;
  let tool: NewFieldType | null = null;
  let radioGroup: string | null = null; // consecutive radio buttons join this group
  let fields: FieldInfo[] = [];
  let sel: number[] = []; // selected field keys, the last one is the "anchor" for align and match size
  let suggestions: (DetectedField & { off?: boolean })[] = [];
  let clipboard: { page: number; key: number; rect: number[] }[] = [];
  let tabMode: { page: number; keys: number[]; clicked: number[] } | null = null;
  let tabOrders = new Map<number, number[]>(); // page -> keys in Tab order (for the badges)
  let listOpen = false;

  const selected = () => sel.map((k) => fields.find((f) => f.key === k)).filter((f): f is FieldInfo => !!f);
  const refs = (list: FieldInfo[]) => list.map((f) => ({ page: f.page, key: f.key }));

  // ----- bar -----
  const bar = document.createElement("div");
  bar.id = "designbar";
  bar.className = "hidden";
  bar.innerHTML = `<div class="db-row"><span class="db-title">Prepare form</span><div class="db-types"></div><span class="db-sep"></span><button data-a="detect" title="Find blanks, lines and boxes on a flat form and suggest fields for them">Detect fields</button><span class="db-hint muted"></span><button data-a="done" class="primary">Done</button></div><div class="db-row db-arrange"></div>`;
  const typesEl = bar.querySelector(".db-types")!;
  for (const t of TYPES) {
    const b = Object.assign(document.createElement("button"), { textContent: t.label, title: t.title });
    b.dataset.type = t.id;
    b.onclick = () => setTool(tool === t.id && t.id !== "radio" ? null : t.id);
    typesEl.append(b);
  }
  bar.querySelector<HTMLElement>('[data-a="detect"]')!.onclick = () => detect();
  bar.querySelector<HTMLElement>('[data-a="done"]')!.onclick = () => exit();
  const hint = bar.querySelector<HTMLElement>(".db-hint")!;

  // Arrange row: align, distribute, match size, copies, tab order, list, properties, delete.
  const arrange = bar.querySelector<HTMLElement>(".db-arrange")!;
  const arrBtns: { el: HTMLButtonElement; need: number }[] = [];
  const group = (label: string, items: [IconNode, string, () => void, number][]) => {
    const g = Object.assign(document.createElement("div"), { className: "db-group" });
    g.append(Object.assign(document.createElement("span"), { className: "db-glabel", textContent: label }));
    for (const [ic, title, run, need] of items) {
      const b = Object.assign(document.createElement("button"), { title, type: "button" });
      b.append(icon(ic, 16));
      b.onclick = () => run();
      g.append(b);
      arrBtns.push({ el: b, need });
    }
    arrange.append(g);
  };
  group("Align", [
    [AlignStartVertical, "Align left edges (to the last field picked)", () => arrangeSel("left"), 2],
    [AlignCenterVertical, "Align centres across", () => arrangeSel("hcenter"), 2],
    [AlignEndVertical, "Align right edges", () => arrangeSel("right"), 2],
    [AlignStartHorizontal, "Align top edges", () => arrangeSel("top"), 2],
    [AlignCenterHorizontal, "Align middles down", () => arrangeSel("vcenter"), 2],
    [AlignEndHorizontal, "Align bottom edges", () => arrangeSel("bottom"), 2],
  ]);
  group("Distribute", [
    [AlignHorizontalSpaceBetween, "Space evenly across (3 or more fields)", () => arrangeSel("distH"), 3],
    [AlignVerticalSpaceBetween, "Space evenly down (3 or more fields)", () => arrangeSel("distV"), 3],
  ]);
  group("Size", [
    [MoveHorizontal, "Same width as the last field picked", () => arrangeSel("width"), 2],
    [MoveVertical, "Same height", () => arrangeSel("height"), 2],
    [Scaling, "Same width and height", () => arrangeSel("both"), 2],
  ]);
  group("Copy", [
    [Copy, "Duplicate below (Ctrl+D). Ctrl+C and Ctrl+V copy and paste.", () => duplicate(), 1],
    [Grid3x3, "Make copies in rows and columns (a table of fields)", () => copiesGrid(), 1],
    [Files, "Copy to other pages (same place on each page)", () => copyToPages(), 1],
  ]);
  group("Fields", [
    [ListOrdered, "Tab order: see and set the order the Tab key moves through fields", () => toggleTabMode(), 0],
    [List, "Show a list of every field", () => toggleList(), 0],
    [Settings2, "Properties (Enter or double-click)", () => properties(), 1],
    [Trash2, "Delete (Del)", () => deleteSelected(), 1],
  ]);
  d.viewer.prepend(bar);

  // Field list panel.
  const panel = Object.assign(document.createElement("div"), { className: "fd-list hidden" });
  d.viewer.append(panel);

  function setTool(t: NewFieldType | null) {
    tool = t;
    if (t === "radio") radioGroup = null; // picking Radio starts a new group
    if (t && tabMode) endTabMode();
    typesEl.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("active", b.dataset.type === t));
    d.viewer.classList.toggle("fd-drawing", !!t);
    updateHint();
  }
  function updateHint() {
    const n = sel.length;
    for (const b of arrBtns) b.el.disabled = b.need > 0 && n < b.need;
    if (tabMode) {
      hint.replaceChildren(
        `Click fields in Tab order (page ${tabMode.page + 1}). `,
        Object.assign(document.createElement("button"), { textContent: "By rows", title: "Left to right, then down (every page)", onclick: () => autoTabs("rows") }),
        Object.assign(document.createElement("button"), { textContent: "By columns", title: "Top to bottom, then across (every page)", onclick: () => autoTabs("columns") }),
        Object.assign(document.createElement("button"), { className: "primary", textContent: "Finish", onclick: () => endTabMode() }),
      );
    } else if (suggestions.length) {
      const k = suggestions.filter((s) => !s.off).length;
      hint.replaceChildren(
        `${k} of ${suggestions.length} suggested field${suggestions.length === 1 ? "" : "s"} selected. Click one to leave it out. `,
        Object.assign(document.createElement("button"), { className: "primary", textContent: `Add ${k}`, onclick: () => acceptSuggestions(), disabled: !k }),
        Object.assign(document.createElement("button"), { textContent: "Discard", onclick: () => ((suggestions = []), render()) }),
      );
    } else if (tool) hint.textContent = tool === "radio" && radioGroup ? `Adding buttons to “${radioGroup}”. Pick Radio again to start a new group.` : "Drag on the page to draw the field, or click for a standard size.";
    else if (n > 1) hint.textContent = `${n} fields selected. Drag to move them together, use Align and Size, or Enter to change them all.`;
    else if (n === 1) hint.textContent = "Drag to move, drag the corner to resize, Shift+click to add fields, double-click for properties.";
    else hint.textContent = fields.length ? `${fields.length} field${fields.length === 1 ? "" : "s"}. Pick a field type, click a field, or drag a box around several.` : "Pick a field type above, or let Detect fields do the work.";
  }

  // ----- geometry -----
  const sizeOf = (page: number) => d.doc()!.info.pageSizes[page];
  const place = (el: HTMLElement, page: number, r: number[]) => {
    const [w, h] = sizeOf(page);
    Object.assign(el.style, { left: `${(r[0] / w) * 100}%`, top: `${(r[1] / h) * 100}%`, width: `${((r[2] - r[0]) / w) * 100}%`, height: `${((r[3] - r[1]) / h) * 100}%` });
  };
  const ptIn = (layer: HTMLElement, page: number, e: { clientX: number; clientY: number }): [number, number] => {
    const b = layer.getBoundingClientRect();
    const [w, h] = sizeOf(page);
    return [Math.max(0, Math.min(w, ((e.clientX - b.left) / b.width) * w)), Math.max(0, Math.min(h, ((e.clientY - b.top) / b.height) * h))];
  };
  const clampTo = (page: number, r: number[]) => {
    const [pw, ph] = sizeOf(page);
    const w = r[2] - r[0], h = r[3] - r[1];
    const x = Math.max(0, Math.min(pw - w, r[0])), y = Math.max(0, Math.min(ph - h, r[1]));
    return [x, y, x + w, y + h].map((v) => +v.toFixed(2));
  };

  // ----- rendering -----
  async function render() {
    document.querySelectorAll(".fd-layer").forEach((n) => n.remove());
    const doc = d.doc();
    if (!on || !doc) return;
    fields = await d.engine.fields(doc.info.id);
    sel = sel.filter((k) => fields.some((f) => f.key === k));
    if (tabMode || listOpen) {
      tabOrders = new Map();
      for (const p of new Set(fields.map((f) => f.page))) tabOrders.set(p, (await d.engine.tabOrder(doc.info.id, p)).keys);
    }
    const layers = new Map<number, HTMLElement>();
    const layer = (i: number) => {
      let l = layers.get(i);
      if (!l) {
        const pe = d.pageEl(i);
        if (!pe) return null;
        l = Object.assign(document.createElement("div"), { className: "fd-layer" });
        l.dataset.page = String(i);
        l.addEventListener("pointerdown", (e) => onLayerDown(e, i, l!));
        pe.append(l);
        layers.set(i, l);
      }
      return l;
    };
    for (let i = 0; i < doc.info.pageSizes.length; i++) layer(i);
    for (const f of fields) {
      const l = layer(f.page);
      if (!l) continue;
      const box = document.createElement("div");
      box.className = `fd-box fd-${f.type}` + (sel.includes(f.key) ? " selected" : "") + (sel.at(-1) === f.key && sel.length > 1 ? " anchor" : "");
      box.dataset.key = String(f.key);
      box.title = `${TYPE_NAME[f.type] ?? f.type}: ${f.name}${f.onState ? ` (${f.onState})` : ""}${f.logic.format.kind === "date" ? " (date)" : ""}`;
      box.innerHTML = `<span class="fd-name"></span><span class="fd-handle"></span>`;
      box.querySelector(".fd-name")!.textContent = f.type === "radiobutton" ? `${f.name}: ${f.onState ?? ""}` : f.type === "button" ? `${f.caption || f.name}` : f.name;
      if (tabMode) {
        const n = (tabOrders.get(f.page) ?? []).indexOf(f.key);
        const badge = Object.assign(document.createElement("span"), { className: "fd-tab" + (tabMode.page === f.page && tabMode.clicked.includes(f.key) ? " done" : ""), textContent: String(n + 1) });
        box.append(badge);
      }
      place(box, f.page, f.rect);
      box.addEventListener("pointerdown", (e) => onBoxDown(e, f, box, l));
      box.addEventListener("dblclick", (e) => (e.stopPropagation(), !tabMode && (select([f.key]), properties())));
      l.append(box);
    }
    suggestions.forEach((s, idx) => {
      const l = layer(s.page);
      if (!l) return;
      const box = document.createElement("div");
      box.className = `fd-box fd-suggest fd-${s.type === "radio" ? "radiobutton" : s.type}` + (s.off ? " off" : "");
      box.title = `${s.name} (found from ${s.reason}). Click to ${s.off ? "include" : "leave out"}.`;
      box.innerHTML = `<span class="fd-name"></span>`;
      box.querySelector(".fd-name")!.textContent = s.name;
      place(box, s.page, s.rect);
      box.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        suggestions[idx].off = !suggestions[idx].off;
        box.classList.toggle("off", !!suggestions[idx].off);
        updateHint();
      });
      l.append(box);
    });
    renderList();
    updateHint();
  }

  function renderList() {
    panel.classList.toggle("hidden", !listOpen);
    if (!listOpen) return;
    panel.style.top = `${Math.round(bar.getBoundingClientRect().bottom + 8)}px`;
    panel.replaceChildren();
    const head = Object.assign(document.createElement("div"), { className: "fd-list-head" });
    head.append(Object.assign(document.createElement("b"), { textContent: `Fields (${fields.length})` }), Object.assign(document.createElement("button"), { textContent: "×", title: "Close", onclick: () => toggleList() }));
    panel.append(head);
    const pages = [...new Set(fields.map((f) => f.page))].sort((a, b) => a - b);
    for (const p of pages) {
      panel.append(Object.assign(document.createElement("div"), { className: "fd-list-page", textContent: `Page ${p + 1}` }));
      const order = tabOrders.get(p) ?? [];
      const onPage = fields.filter((f) => f.page === p).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      for (const f of onPage) {
        const row = Object.assign(document.createElement("button"), { className: "fd-list-row" + (sel.includes(f.key) ? " selected" : ""), type: "button" });
        row.title = "Click to select, Shift+click to add, double-click for properties";
        row.append(
          Object.assign(document.createElement("span"), { className: "n", textContent: String(order.indexOf(f.key) + 1) }),
          Object.assign(document.createElement("span"), { className: "nm", textContent: f.type === "radiobutton" ? `${f.name}: ${f.onState ?? ""}` : f.name }),
          Object.assign(document.createElement("span"), { className: "t", textContent: f.logic.format.kind === "date" ? "Date" : (TYPE_NAME[f.type] ?? f.type).replace(/ field$/, "") }),
        );
        row.onclick = (e) => {
          select(e.shiftKey || e.ctrlKey ? (sel.includes(f.key) ? sel.filter((k) => k !== f.key) : [...sel, f.key]) : [f.key]);
          document.querySelector(`.fd-box[data-key="${f.key}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        };
        row.ondblclick = () => (select([f.key]), properties());
        panel.append(row);
      }
    }
    if (!fields.length) panel.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No fields yet." }));
  }

  // ----- interactions -----
  function onLayerDown(e: PointerEvent, page: number, layer: HTMLElement) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const start = ptIn(layer, page, e);
    const ghost = Object.assign(document.createElement("div"), { className: tool ? "fd-box fd-ghost" : "fd-marquee" });
    layer.append(ghost);
    let cur = start;
    const additive = e.shiftKey || e.ctrlKey;
    const rectOf = () => [Math.min(start[0], cur[0]), Math.min(start[1], cur[1]), Math.max(start[0], cur[0]), Math.max(start[1], cur[1])];
    const move = (ev: PointerEvent) => {
      cur = ptIn(layer, page, ev);
      place(ghost, page, rectOf());
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost.remove();
      let r = rectOf();
      const small = r[2] - r[0] < 4 && r[3] - r[1] < 4;
      if (!tool) {
        // Window select: every field the box touches.
        if (small) return additive ? undefined : select([]);
        const hit = fields.filter((f) => f.page === page && f.rect[0] < r[2] && f.rect[2] > r[0] && f.rect[1] < r[3] && f.rect[3] > r[1]).map((f) => f.key);
        return select(additive ? [...new Set([...sel, ...hit])] : hit);
      }
      const t = tool;
      if (small) {
        const [w, h] = DEFAULT_SIZE[t];
        r = square(t) ? [start[0] - w / 2, start[1] - h / 2, start[0] + w / 2, start[1] + h / 2] : [start[0], start[1] - h / 2, start[0] + w, start[1] + h / 2];
      } else if (square(t)) {
        const s = Math.max(r[2] - r[0], r[3] - r[1]);
        r = [r[0], r[1], r[0] + s, r[1] + s];
      }
      await create(page, clampTo(page, r), t);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function create(page: number, rect: number[], type: NewFieldType) {
    const doc = d.doc();
    if (!doc) return;
    try {
      const sug = await d.engine.suggestFieldName(doc.info.id, page, rect, type);
      const spec: FieldSpec = { type, name: sug.name, rect, tooltip: sug.label || undefined };
      if (type === "radio") {
        if (radioGroup) spec.name = radioGroup;
        radioGroup = spec.name;
        spec.exportValue = sug.label || undefined;
      }
      if (type === "combobox" || type === "listbox") {
        const r = await ask(`Choices for “${spec.name}”`, [{ name: "o", label: "Choices", placeholder: "Red, Green, Blue", hint: "Separate with commas. You can change them later in Properties." }], "Add");
        if (!r) return;
        spec.options = r.o.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (type === "button") {
        const r = await ask("New button", [
          { name: "caption", label: "Label", value: "Clear form" },
          { name: "action", label: "When clicked", type: "select", value: "reset", options: [["reset", "Clear the form"], ["print", "Print"], ["url", "Open a web link"], ["none", "Do nothing"]] },
          { name: "url", label: "Web address (for a link)", placeholder: "https://" },
        ], "Add");
        if (!r) return;
        spec.caption = r.caption || "Button";
        spec.name = (await d.engine.fieldNames(doc.info.id)).includes(spec.caption) ? sug.name : spec.caption;
        spec.action = r.action === "url" ? { kind: "url", url: r.url.trim() } : ({ kind: r.action } as FieldSpec["action"]);
        if (r.action === "url" && !/^(https?:|mailto:)/i.test(r.url.trim())) return d.status("Enter a web address starting with https:// for a link button");
      }
      if (type === "date" && sug.name === "Date" && sug.label) spec.name = sug.label;
      const key = await d.engine.addField(doc.info.id, page, spec);
      d.refreshPage(page);
      d.changed(`Added ${TYPE_NAME[type].toLowerCase()} “${spec.name}”`);
      if (type !== "radio") setTool(null);
      sel = [key];
      await render();
    } catch (err) {
      d.status((err as Error).message);
    }
  }

  function select(keys: number[]) {
    sel = keys;
    document.querySelectorAll(".fd-box.selected, .fd-box.anchor").forEach((n) => n.classList.remove("selected", "anchor"));
    for (const k of sel) document.querySelector(`.fd-box[data-key="${k}"]`)?.classList.add("selected");
    if (sel.length > 1) document.querySelector(`.fd-box[data-key="${sel.at(-1)}"]`)?.classList.add("anchor");
    if (listOpen) renderList();
    updateHint();
  }

  function onBoxDown(e: PointerEvent, f: FieldInfo, box: HTMLElement, layer: HTMLElement) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (tabMode) return tabClick(f);
    if (tool) setTool(null);
    if (e.shiftKey || e.ctrlKey) {
      // Toggle in the selection; no drag.
      return select(sel.includes(f.key) ? sel.filter((k) => k !== f.key) : [...sel, f.key]);
    }
    if (!sel.includes(f.key)) select([f.key]);
    else if (sel.at(-1) !== f.key) select([...sel.filter((k) => k !== f.key), f.key]); // clicked one becomes the anchor
    const resizing = (e.target as HTMLElement).classList.contains("fd-handle") && sel.length === 1;
    const start = ptIn(layer, f.page, e);
    const [pw, ph] = sizeOf(f.page);
    const group = resizing ? [f] : selected();
    const boxes = new Map(group.map((g) => [g.key, document.querySelector<HTMLElement>(`.fd-box[data-key="${g.key}"]`)!]));
    let rects = new Map(group.map((g) => [g.key, g.rect.slice()]));
    let moved = false;
    const move = (ev: PointerEvent) => {
      const p = ptIn(layer, f.page, ev);
      let dx = p[0] - start[0], dy = p[1] - start[1];
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      if (resizing) {
        let w = Math.max(6, f.rect[2] - f.rect[0] + dx), h = Math.max(6, f.rect[3] - f.rect[1] + dy);
        if (square(f.type)) w = h = Math.max(w, h);
        const r = [f.rect[0], f.rect[1], Math.min(pw, f.rect[0] + w), Math.min(ph, f.rect[1] + h)];
        rects = new Map([[f.key, r]]);
        place(box, f.page, r);
        return;
      }
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0); // Shift keeps the move straight
      rects = new Map(group.map((g) => {
        const r = clampTo(g.page, [g.rect[0] + dx, g.rect[1] + dy, g.rect[2] + dx, g.rect[3] + dy]);
        boxes.get(g.key) && place(boxes.get(g.key)!, g.page, r);
        return [g.key, r];
      }));
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) await setRects(group.map((g) => ({ page: g.page, key: g.key, rect: rects.get(g.key)!.map((v) => +v.toFixed(2)) })), resizing ? "Resized" : "Moved");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function setRects(items: (FieldRef & { rect: number[] })[], verb: string) {
    const doc = d.doc();
    if (!doc || !items.length) return;
    await d.engine.setFieldRects(doc.info.id, items);
    for (const p of new Set(items.map((i) => i.page))) d.refreshPage(p);
    const one = items.length === 1 ? fields.find((f) => f.key === items[0].key) : null;
    d.changed(one ? `${verb} “${one.name}”` : `${verb} ${items.length} fields`);
    await render();
  }

  /** Align, distribute or match sizes, relative to the last field picked (the anchor). */
  async function arrangeSel(how: Arr) {
    const list = selected();
    if (list.length < 2) return d.status("Select two or more fields first (Shift+click or drag a box around them)");
    const anchor = list.at(-1)!;
    const a = anchor.rect;
    const out = new Map(list.map((f) => [f.key, f.rect.slice()]));
    const shift = (r: number[], dx: number, dy: number) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
    if (how === "distH" || how === "distV") {
      if (list.length < 3) return d.status("Distributing needs three or more fields");
      const [i0, i1] = how === "distH" ? [0, 2] : [1, 3];
      const sorted = list.slice().sort((p, q) => p.rect[i0] - q.rect[i0]);
      const first = sorted[0].rect, last = sorted.at(-1)!.rect;
      const total = sorted.reduce((s, f) => s + f.rect[i1] - f.rect[i0], 0);
      const gap = (last[i1] - first[i0] - total) / (sorted.length - 1);
      let pos = first[i0];
      for (const f of sorted) {
        const size = f.rect[i1] - f.rect[i0];
        const d0 = pos - f.rect[i0];
        out.set(f.key, how === "distH" ? shift(f.rect, d0, 0) : shift(f.rect, 0, d0));
        pos += size + gap;
      }
    } else {
      for (const f of list) {
        if (f === anchor) continue;
        const r = f.rect, aw = a[2] - a[0], ah = a[3] - a[1];
        let n = r;
        switch (how) {
          case "left": n = shift(r, a[0] - r[0], 0); break;
          case "right": n = shift(r, a[2] - r[2], 0); break;
          case "hcenter": n = shift(r, (a[0] + a[2]) / 2 - (r[0] + r[2]) / 2, 0); break;
          case "top": n = shift(r, 0, a[1] - r[1]); break;
          case "bottom": n = shift(r, 0, a[3] - r[3]); break;
          case "vcenter": n = shift(r, 0, (a[1] + a[3]) / 2 - (r[1] + r[3]) / 2); break;
          case "width": n = square(f.type) ? [r[0], r[1], r[0] + aw, r[1] + aw] : [r[0], r[1], r[0] + aw, r[3]]; break;
          case "height": n = square(f.type) ? [r[0], r[1], r[0] + ah, r[1] + ah] : [r[0], r[1], r[2], r[1] + ah]; break;
          case "both": n = square(f.type) ? [r[0], r[1], r[0] + Math.min(aw, ah), r[1] + Math.min(aw, ah)] : [r[0], r[1], r[0] + aw, r[1] + ah]; break;
        }
        out.set(f.key, n);
      }
    }
    const verb = { left: "Aligned", right: "Aligned", hcenter: "Aligned", top: "Aligned", bottom: "Aligned", vcenter: "Aligned", distH: "Distributed", distV: "Distributed", width: "Resized", height: "Resized", both: "Resized" }[how];
    await setRects(list.filter((f) => out.get(f.key)!.some((v, i) => Math.abs(v - f.rect[i]) > 0.01)).map((f) => ({ page: f.page, key: f.key, rect: clampTo(f.page, out.get(f.key)!) })), verb);
  }

  // ----- copies -----
  async function clone(jobs: { src: FieldRef; targets: { page: number; rect: number[] }[] }[], label: string) {
    const doc = d.doc();
    if (!doc || !jobs.length) return;
    try {
      const made = await d.engine.cloneFields(doc.info.id, jobs);
      for (const p of new Set(made.map((m) => m.page))) d.refreshPage(p);
      d.changed(label.replace("{n}", String(made.length)));
      sel = made.map((m) => m.key);
      await render();
    } catch (err) {
      d.status((err as Error).message);
    }
  }

  async function duplicate() {
    const list = selected();
    if (!list.length) return;
    // Below the selection, so a column of fields grows downward.
    const top = Math.min(...list.map((f) => f.rect[1])), bottom = Math.max(...list.map((f) => f.rect[3]));
    const dy = bottom - top + 6;
    await clone(list.map((f) => ({ src: { page: f.page, key: f.key }, targets: [{ page: f.page, rect: clampTo(f.page, [f.rect[0], f.rect[1] + dy, f.rect[2], f.rect[3] + dy]) }] })), "Duplicated {n} field(s)".replace("(s)", list.length === 1 ? "" : "s"));
  }

  function copySel() {
    clipboard = selected().map((f) => ({ page: f.page, key: f.key, rect: f.rect.slice() }));
    if (clipboard.length) d.status(`Copied ${clipboard.length} field${clipboard.length === 1 ? "" : "s"}. Ctrl+V pastes on the page in view.`);
  }
  async function paste() {
    if (!clipboard.length) return;
    const page = d.currentPage();
    const live = new Set(fields.map((f) => f.key));
    const items = clipboard.filter((c) => live.has(c.key));
    if (!items.length) return d.status("The copied fields were deleted");
    const samePage = items.every((c) => c.page === page);
    const off = samePage ? 12 : 0;
    await clone(items.map((c) => ({ src: { page: c.page, key: c.key }, targets: [{ page, rect: clampTo(page, [c.rect[0] + off, c.rect[1] + off, c.rect[2] + off, c.rect[3] + off]) }] })), `Pasted ${items.length} field${items.length === 1 ? "" : "s"}`);
    // Paste again steps on, like most editors.
    if (samePage) clipboard = clipboard.map((c) => ({ ...c, rect: [c.rect[0] + off, c.rect[1] + off, c.rect[2] + off, c.rect[3] + off] }));
  }

  async function copiesGrid() {
    const list = selected();
    if (!list.length) return d.status("Select a field (or a row of fields) first");
    const box = [Math.min(...list.map((f) => f.rect[0])), Math.min(...list.map((f) => f.rect[1])), Math.max(...list.map((f) => f.rect[2])), Math.max(...list.map((f) => f.rect[3]))];
    const r = await ask(`Make copies of ${list.length === 1 ? `“${list[0].name}”` : `${list.length} fields`}`, [
      { name: "down", label: "Copies down (rows)", type: "number", value: "5", hint: "Names count on: Qty 1 → Qty 2, Qty 3…" },
      { name: "across", label: "Copies across (columns)", type: "number", value: "1" },
      { name: "dy", label: "Row spacing (points, top to top)", type: "number", value: String(+(box[3] - box[1] + 6).toFixed(1)) },
      { name: "dx", label: "Column spacing (points, left to left)", type: "number", value: String(+(box[2] - box[0] + 12).toFixed(1)) },
    ], "Make copies");
    if (!r) return;
    const down = Math.max(1, Math.min(200, Math.floor(+r.down || 1))), across = Math.max(1, Math.min(50, Math.floor(+r.across || 1)));
    const dy = +r.dy || 0, dx = +r.dx || 0;
    const [pw, ph] = sizeOf(list[0].page);
    const jobs = list.map((f) => {
      const targets: { page: number; rect: number[] }[] = [];
      // Row by row, so names run along each row and then down.
      for (let i = 0; i < down; i++) for (let j = 0; j < across; j++) {
        if (!i && !j) continue;
        const rect = [f.rect[0] + j * dx, f.rect[1] + i * dy, f.rect[2] + j * dx, f.rect[3] + i * dy];
        if (rect[2] <= pw + 0.5 && rect[3] <= ph + 0.5) targets.push({ page: f.page, rect });
      }
      return { src: { page: f.page, key: f.key }, targets };
    }).filter((j) => j.targets.length);
    const skipped = list.length * (down * across - 1) - jobs.reduce((s, j) => s + j.targets.length, 0);
    await clone(jobs, `Made {n} copies${skipped ? ` (${skipped} would have gone off the page)` : ""}`);
  }

  async function copyToPages() {
    const list = selected();
    const doc = d.doc();
    if (!list.length || !doc) return;
    const count = doc.info.pageSizes.length;
    if (count < 2) return d.status("This document has only one page");
    const r = await ask(`Copy ${list.length === 1 ? `“${list[0].name}”` : `${list.length} fields`} to other pages`, [
      { name: "pages", label: "Pages", value: "all", hint: `e.g. all, 2-5, odd, even (1-${count}). The page each field is on is skipped.` },
    ], "Copy");
    if (!r) return;
    let pages: number[];
    try {
      pages = parseRanges(r.pages, count);
    } catch (e) {
      return d.status((e as Error).message);
    }
    const jobs = list.map((f) => ({ src: { page: f.page, key: f.key }, targets: [...new Set(pages)].filter((p) => p !== f.page).map((p) => ({ page: p, rect: clampTo(p, f.rect) })) })).filter((j) => j.targets.length);
    await clone(jobs, "Copied to other pages: {n} new fields");
  }

  // ----- tab order -----
  async function toggleTabMode() {
    if (tabMode) return endTabMode();
    const doc = d.doc();
    if (!doc) return;
    setTool(null);
    suggestions = [];
    const page = sel.length ? selected()[0].page : d.currentPage();
    tabMode = { page, keys: (await d.engine.tabOrder(doc.info.id, page)).keys, clicked: [] };
    d.viewer.classList.add("fd-tabbing");
    await render();
  }
  function endTabMode() {
    tabMode = null;
    d.viewer.classList.remove("fd-tabbing");
    render();
  }
  async function tabClick(f: FieldInfo) {
    const doc = d.doc();
    if (!doc || !tabMode) return;
    if (f.page !== tabMode.page) tabMode = { page: f.page, keys: (await d.engine.tabOrder(doc.info.id, f.page)).keys, clicked: [] };
    // Radio buttons in one group move together.
    const groupKeys = f.type === "radiobutton" ? fields.filter((x) => x.page === f.page && x.type === "radiobutton" && x.name === f.name).map((x) => x.key) : [f.key];
    tabMode.clicked = [...tabMode.clicked.filter((k) => !groupKeys.includes(k)), ...groupKeys];
    const order = [...tabMode.clicked, ...tabMode.keys.filter((k) => !tabMode!.clicked.includes(k))];
    await d.engine.setTabOrder(doc.info.id, f.page, order);
    tabMode.keys = order;
    d.changed(`Tab order: “${f.name}” is number ${tabMode.clicked.indexOf(f.key) + 1}`);
    await render();
  }
  async function autoTabs(by: "rows" | "columns") {
    const doc = d.doc();
    if (!doc) return;
    const pages = [...new Set(fields.map((f) => f.page))];
    await d.engine.autoTabOrder(doc.info.id, pages, by);
    if (tabMode) tabMode = { page: tabMode.page, keys: (await d.engine.tabOrder(doc.info.id, tabMode.page)).keys, clicked: [] };
    d.changed(`Tab order set by ${by} on ${pages.length} page${pages.length === 1 ? "" : "s"}`);
    await render();
  }

  async function toggleList() {
    listOpen = !listOpen;
    await render();
  }

  // ----- properties and delete -----
  async function properties() {
    const doc = d.doc();
    const list = selected();
    if (!doc || !list.length) return;
    const props = await Promise.all(list.map((f) => d.engine.fieldProps(doc.info.id, f.page, f.key)));
    const names = await d.engine.fieldNames(doc.info.id);
    const patch = await fieldProperties(props, names);
    if (!patch || !Object.keys(patch).length) return;
    try {
      if (list.length === 1) await d.engine.updateField(doc.info.id, list[0].page, list[0].key, patch);
      else await d.engine.updateFields(doc.info.id, refs(list), patch);
      for (const p of new Set(fields.map((f) => f.page))) d.refreshPage(p); // calculations may change other pages
      d.changed(list.length === 1 ? `Updated “${patch.name ?? list[0].name}”` : `Updated ${list.length} fields`);
      await render();
    } catch (err) {
      d.status((err as Error).message);
    }
  }

  async function deleteSelected() {
    const doc = d.doc();
    const list = selected();
    if (!doc || !list.length) return;
    await d.engine.deleteFields(doc.info.id, refs(list));
    sel = [];
    for (const p of new Set(list.map((f) => f.page))) d.refreshPage(p);
    d.changed(list.length === 1 ? `Deleted “${list[0].name}”` : `Deleted ${list.length} fields`);
    await render();
  }

  async function detect() {
    const doc = d.doc();
    if (!doc) return;
    setTool(null);
    if (tabMode) endTabMode();
    d.status("Looking for blanks, lines and boxes…");
    suggestions = await d.engine.detectFields(doc.info.id);
    if (!suggestions.length) d.status("No new fields found. Draw them with the field types above.");
    else d.status(`Found ${suggestions.length} likely field${suggestions.length === 1 ? "" : "s"}. Review them on the page, then Add.`);
    await render();
    const first = suggestions[0];
    if (first) d.pageEl(first.page)?.scrollIntoView({ block: "start" });
  }

  async function acceptSuggestions() {
    const doc = d.doc();
    if (!doc) return;
    const take = suggestions.filter((s) => !s.off);
    suggestions = [];
    if (!take.length) return render();
    await d.engine.addFields(doc.info.id, take);
    for (const p of new Set(take.map((s) => s.page))) d.refreshPage(p);
    d.changed(`Added ${take.length} form field${take.length === 1 ? "" : "s"}`);
    await render();
  }

  document.addEventListener("keydown", async (e) => {
    if (!on || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || document.querySelector(".modal-back")) return;
    const stop = () => (e.preventDefault(), e.stopImmediatePropagation());
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "a" && !e.shiftKey) {
        stop();
        const page = d.currentPage();
        return select(fields.filter((f) => f.page === page).map((f) => f.key));
      }
      if (k === "c" && sel.length) return stop(), copySel();
      if (k === "x" && sel.length) return stop(), copySel(), deleteSelected();
      if (k === "v" && clipboard.length) return stop(), paste();
      if (k === "d" && sel.length) return stop(), duplicate();
      return; // Ctrl+Z, Ctrl+S and the rest go to the app
    }
    if (e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
      stop();
      await deleteSelected();
    } else if (e.key === "Enter" && sel.length) {
      stop();
      await properties();
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      if (tabMode) endTabMode();
      else if (tool) setTool(null);
      else if (suggestions.length) ((suggestions = []), render());
      else if (sel.length) select([]);
      else exit();
    } else if (sel.length && e.key.startsWith("Arrow")) {
      stop();
      const step = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
      await setRects(selected().map((f) => ({ page: f.page, key: f.key, rect: clampTo(f.page, [f.rect[0] + dx, f.rect[1] + dy, f.rect[2] + dx, f.rect[3] + dy]) })), "Moved");
    } else {
      const t = TYPES.find((x) => x.key === e.key.toUpperCase());
      if (t && !e.shiftKey) {
        stop();
        setTool(t.id);
      }
    }
  }, true);

  function enter() {
    if (!d.doc()) return d.status("Open a PDF first");
    if (on) return;
    on = true;
    d.onEnter();
    document.body.classList.add("designing");
    bar.classList.remove("hidden");
    setTool(null);
    render();
  }
  function exit() {
    if (!on) return;
    on = false;
    suggestions = [];
    sel = [];
    tabMode = null;
    listOpen = false;
    panel.classList.add("hidden");
    d.viewer.classList.remove("fd-tabbing");
    setTool(null);
    document.body.classList.remove("designing");
    bar.classList.add("hidden");
    document.querySelectorAll(".fd-layer").forEach((n) => n.remove());
    d.onExit();
  }

  return {
    enter,
    exit,
    toggle: () => (on ? exit() : enter()),
    /** Re-draw after undo/redo or a page change. */
    refresh: () => on && render(),
    detect: async () => (enter(), detect()),
    /** Start drawing a field of this type (from the ribbon). */
    draw: (t: NewFieldType) => (enter(), setTool(t)),
    tabOrder: async () => (enter(), tabMode || toggleTabMode()),
    fieldList: async () => (enter(), listOpen || toggleList()),
    get active() { return on; },
  };
}
