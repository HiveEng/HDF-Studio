// Form designer: draw new fields on the page, move/resize/rename them, and turn a flat form into
// a fillable one with "Detect fields". Fields show as outlined boxes while designing.
import { parseExpr, type FieldLogic, type NumberSep, type CalcOp } from "../engine/formcalc";
import type { FieldInfo } from "../engine/forms";
import type { FieldSpec, FieldProps, FieldPatch, DetectedField, NewFieldType } from "../engine/formdesign";
import { ask } from "./dialog";

export interface DesignDeps {
  engine: {
    fields(id: number): Promise<FieldInfo[]>;
    addField(id: number, page: number, spec: FieldSpec): Promise<number>;
    addFields(id: number, specs: (FieldSpec & { page: number })[]): Promise<number[]>;
    updateField(id: number, page: number, key: number, patch: FieldPatch): Promise<void>;
    deleteField(id: number, page: number, key: number): Promise<void>;
    fieldProps(id: number, page: number, key: number): Promise<FieldProps>;
    detectFields(id: number, pages?: number[]): Promise<DetectedField[]>;
    suggestFieldName(id: number, page: number, rect: number[], type: NewFieldType): Promise<{ name: string; label: string }>;
  };
  doc(): { info: { id: number; pageSizes: [number, number][] } } | null;
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
  { id: "checkbox", label: "Check box", key: "C", title: "Check box (C)" },
  { id: "radio", label: "Radio", key: "R", title: "Radio button (R): buttons placed one after another form a group" },
  { id: "combobox", label: "Dropdown", key: "D", title: "Dropdown list (D)" },
  { id: "listbox", label: "List", key: "L", title: "List box (L)" },
  { id: "signature", label: "Signature", key: "S", title: "Signature field (S)" },
];
const DEFAULT_SIZE: Record<NewFieldType, [number, number]> = { text: [160, 18], checkbox: [12, 12], radio: [12, 12], combobox: [140, 18], listbox: [120, 54], signature: [180, 40] };
const TYPE_NAME: Record<string, string> = { text: "Text field", checkbox: "Check box", radiobutton: "Radio button", combobox: "Dropdown", listbox: "List box", signature: "Signature field", button: "Button" };

export function setupFormDesign(d: DesignDeps) {
  let on = false;
  let tool: NewFieldType | null = null;
  let radioGroup: string | null = null; // consecutive radio buttons join this group
  let fields: FieldInfo[] = [];
  let selected: FieldInfo | null = null;
  let suggestions: (DetectedField & { off?: boolean })[] = [];

  // ----- bar -----
  const bar = document.createElement("div");
  bar.id = "designbar";
  bar.className = "hidden";
  bar.innerHTML = `<span class="db-title">Prepare form</span><div class="db-types"></div><span class="db-sep"></span><button data-a="detect" title="Find blanks, lines and boxes on a flat form and suggest fields for them">Detect fields</button><span class="db-hint muted"></span><button data-a="done" class="primary">Done</button>`;
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
  d.viewer.prepend(bar);

  function setTool(t: NewFieldType | null) {
    tool = t;
    if (t === "radio") radioGroup = null; // picking Radio starts a new group
    typesEl.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("active", b.dataset.type === t));
    d.viewer.classList.toggle("fd-drawing", !!t);
    updateHint();
  }
  function updateHint() {
    if (suggestions.length) {
      const n = suggestions.filter((s) => !s.off).length;
      hint.replaceChildren(
        `${n} of ${suggestions.length} suggested field${suggestions.length === 1 ? "" : "s"} selected. Click one to leave it out. `,
        Object.assign(document.createElement("button"), { className: "primary", textContent: `Add ${n}`, onclick: () => acceptSuggestions(), disabled: !n }),
        Object.assign(document.createElement("button"), { textContent: "Discard", onclick: () => ((suggestions = []), render()) }),
      );
    } else if (tool) hint.textContent = tool === "radio" && radioGroup ? `Adding buttons to “${radioGroup}”. Pick Radio again to start a new group.` : "Drag on the page to draw the field, or click for a standard size.";
    else if (selected) hint.textContent = "Drag to move, drag the corner to resize, double-click for properties, Delete to remove.";
    else hint.textContent = fields.length ? `${fields.length} field${fields.length === 1 ? "" : "s"}. Pick a field type above, or select a field to change it.` : "Pick a field type above, or let Detect fields do the work.";
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

  // ----- rendering -----
  async function render() {
    document.querySelectorAll(".fd-layer").forEach((n) => n.remove());
    const doc = d.doc();
    if (!on || !doc) return;
    fields = await d.engine.fields(doc.info.id);
    if (selected) selected = fields.find((f) => f.key === selected!.key) ?? null;
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
      box.className = `fd-box fd-${f.type}` + (selected?.key === f.key ? " selected" : "");
      box.dataset.key = String(f.key);
      box.title = `${TYPE_NAME[f.type] ?? f.type}: ${f.name}${f.onState ? ` (${f.onState})` : ""}`;
      box.innerHTML = `<span class="fd-name"></span><span class="fd-handle"></span>`;
      box.querySelector(".fd-name")!.textContent = f.type === "radiobutton" ? `${f.name}: ${f.onState ?? ""}` : f.name;
      place(box, f.page, f.rect);
      box.addEventListener("pointerdown", (e) => onBoxDown(e, f, box, l));
      box.addEventListener("dblclick", (e) => (e.stopPropagation(), properties(f)));
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
    updateHint();
  }

  // ----- interactions -----
  function onLayerDown(e: PointerEvent, page: number, layer: HTMLElement) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!tool) {
      select(null);
      return;
    }
    const start = ptIn(layer, page, e);
    const ghost = Object.assign(document.createElement("div"), { className: "fd-box fd-ghost" });
    layer.append(ghost);
    let cur = start;
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
      const t = tool!;
      if (r[2] - r[0] < 4 && r[3] - r[1] < 4) {
        const [w, h] = DEFAULT_SIZE[t];
        r = t === "checkbox" || t === "radio" ? [start[0] - w / 2, start[1] - h / 2, start[0] + w / 2, start[1] + h / 2] : [start[0], start[1] - h / 2, start[0] + w, start[1] + h / 2];
      } else if (t === "checkbox" || t === "radio") {
        const s = Math.max(r[2] - r[0], r[3] - r[1]);
        r = [r[0], r[1], r[0] + s, r[1] + s];
      }
      await create(page, r.map((v) => +v.toFixed(2)), t);
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
        const r = await ask(`Choices for “${spec.name}”`, [{ name: "o", label: "Choices", placeholder: "Red, Green, Blue", hint: "Separate with commas" }], "Add");
        if (!r) return;
        spec.options = r.o.split(",").map((s) => s.trim()).filter(Boolean);
      }
      const key = await d.engine.addField(doc.info.id, page, spec);
      d.refreshPage(page);
      d.changed(`Added ${TYPE_NAME[type === "radio" ? "radiobutton" : type].toLowerCase()} “${spec.name}”`);
      if (type !== "radio") setTool(null);
      await render();
      const f = fields.find((x) => x.key === key);
      if (f) select(f);
    } catch (err) {
      d.status((err as Error).message);
    }
  }

  function select(f: FieldInfo | null) {
    selected = f;
    document.querySelectorAll(".fd-box.selected").forEach((n) => n.classList.remove("selected"));
    if (f) document.querySelector(`.fd-box[data-key="${f.key}"]`)?.classList.add("selected");
    updateHint();
  }

  function onBoxDown(e: PointerEvent, f: FieldInfo, box: HTMLElement, layer: HTMLElement) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (tool) setTool(null);
    select(f);
    const resizing = (e.target as HTMLElement).classList.contains("fd-handle");
    const start = ptIn(layer, f.page, e);
    const [pw, ph] = sizeOf(f.page);
    let r = f.rect.slice();
    let moved = false;
    const move = (ev: PointerEvent) => {
      const p = ptIn(layer, f.page, ev);
      const dx = p[0] - start[0], dy = p[1] - start[1];
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      if (resizing) {
        const square = f.type === "checkbox" || f.type === "radiobutton";
        let w = Math.max(6, f.rect[2] - f.rect[0] + dx), h = Math.max(6, f.rect[3] - f.rect[1] + dy);
        if (square) w = h = Math.max(w, h);
        r = [f.rect[0], f.rect[1], Math.min(pw, f.rect[0] + w), Math.min(ph, f.rect[1] + h)];
      } else {
        const w = f.rect[2] - f.rect[0], h = f.rect[3] - f.rect[1];
        const x = Math.max(0, Math.min(pw - w, f.rect[0] + dx)), y = Math.max(0, Math.min(ph - h, f.rect[1] + dy));
        r = [x, y, x + w, y + h];
      }
      place(box, f.page, r);
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) await setRect(f, r.map((v) => +v.toFixed(2)), resizing ? "Resized" : "Moved");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function setRect(f: FieldInfo, rect: number[], verb: string) {
    const doc = d.doc();
    if (!doc) return;
    await d.engine.updateField(doc.info.id, f.page, f.key, { rect });
    d.refreshPage(f.page);
    d.changed(`${verb} “${f.name}”`);
    await render();
  }

  async function properties(f: FieldInfo) {
    const doc = d.doc();
    if (!doc) return;
    const p = await d.engine.fieldProps(doc.info.id, f.page, f.key);
    const yesNo: [string, string][] = [["no", "No"], ["yes", "Yes"]];
    const yn = (b: boolean) => (b ? "yes" : "no");
    const form: Parameters<typeof ask>[1] = [
      { name: "name", label: f.type === "radiobutton" ? "Group name" : "Name", value: p.name, hint: "Used when filling from a spreadsheet and when exporting data" },
      { name: "tooltip", label: "Tooltip", value: p.tooltip, placeholder: "Shown when hovering the field" },
      { name: "required", label: "Required", type: "select", value: yn(p.required), options: yesNo },
      { name: "readOnly", label: "Read only", type: "select", value: yn(p.readOnly), options: yesNo },
    ];
    if (f.type === "text" || f.type === "combobox" || f.type === "listbox") form.push({ name: "fontSize", label: "Font size", type: "number", value: String(p.fontSize), hint: "0 fits the text to the box" });
    if (f.type === "text") {
      form.push({ name: "multiline", label: "Multiple lines", type: "select", value: yn(p.multiline), options: yesNo });
      form.push({ name: "maxLen", label: "Character limit", type: "number", value: String(p.maxLen || ""), placeholder: "No limit" });
      const L = p.logic, F = L.format, C = L.calc, V = L.validate;
      const fmtVal = F.kind === "number" ? (F.currency ? "currency" : "number") : F.kind;
      form.push(
        { name: "fmt", label: "Format", type: "select", value: fmtVal, options: [["none", "None (plain text)"], ["number", "Number"], ["currency", "Currency"], ["percent", "Percent"], ["date", "Date"]] },
        { name: "decimals", label: "Decimal places", type: "number", value: String(F.kind === "number" || F.kind === "percent" ? F.decimals : 2) },
        { name: "currency", label: "Currency symbol", value: F.kind === "number" && F.currency ? F.currency : "$" },
        { name: "sep", label: "Number style", type: "select", value: String(F.kind === "number" || F.kind === "percent" ? F.sep : 0), options: [["0", "1,234.56"], ["1", "1234.56"], ["2", "1.234,56"], ["3", "1234,56"]] },
        { name: "date", label: "Date style", type: "select", value: F.kind === "date" ? F.pattern : "mm/dd/yyyy", options: [...new Set([F.kind === "date" ? F.pattern : "mm/dd/yyyy", "mm/dd/yyyy", "m/d/yy", "dd/mm/yyyy", "yyyy-mm-dd", "mmm d, yyyy", "d-mmm-yyyy", "mmmm d, yyyy"])].map((x): [string, string] => [x, x]) },
        { name: "calc", label: "Calculate", type: "select", value: C.kind === "simple" ? C.op : C.kind === "formula" ? "formula" : C.kind === "script" ? "script" : "none", options: [["none", "Not calculated"], ["SUM", "Sum (+) of fields"], ["PRD", "Product (×) of fields"], ["AVG", "Average of fields"], ["MIN", "Minimum of fields"], ["MAX", "Maximum of fields"], ["formula", "Formula"], ...(C.kind === "script" ? [["script", "Custom script (kept, not run here)"] as [string, string]] : [])] },
        { name: "calcFields", label: "Fields to calculate from", value: C.kind === "simple" ? C.fields.join(", ") : "", placeholder: "Line1, Line2, Line3", hint: "Field names, separated by commas" },
        { name: "formula", label: "Formula", value: C.kind === "formula" ? C.expr : "", placeholder: "Qty * Price", hint: "Field names with + - * / and brackets. Put \\ before a space or dot in a name." },
        { name: "min", label: "Lowest allowed value", type: "number", value: V.kind === "range" && V.min !== undefined ? String(V.min) : "", placeholder: "No limit" },
        { name: "max", label: "Highest allowed value", type: "number", value: V.kind === "range" && V.max !== undefined ? String(V.max) : "", placeholder: "No limit" },
      );
    }
    if (f.type === "combobox" || f.type === "listbox") form.push({ name: "options", label: "Choices", value: p.options.join(", "), hint: "Separate with commas" });
    const r = await ask(`${TYPE_NAME[f.type] ?? "Field"} properties`, form, "Save");
    if (!r) return;
    const patch: FieldPatch = { name: r.name, tooltip: r.tooltip, required: r.required === "yes", readOnly: r.readOnly === "yes" };
    if ("fontSize" in r) patch.fontSize = Math.max(0, Number(r.fontSize) || 0);
    if ("multiline" in r) patch.multiline = r.multiline === "yes";
    if ("maxLen" in r) patch.maxLen = Math.max(0, Math.floor(Number(r.maxLen) || 0));
    if ("options" in r) patch.options = r.options.split(",").map((s) => s.trim()).filter(Boolean);
    if ("fmt" in r) {
      const dec = Math.max(0, Math.min(6, Math.floor(Number(r.decimals) || 0)));
      const sep = (Number(r.sep) & 3) as NumberSep;
      const format: FieldLogic["format"] = r.fmt === "number" ? { kind: "number", decimals: dec, sep } : r.fmt === "currency" ? { kind: "number", decimals: dec, sep, currency: r.currency || "$", prepend: true } : r.fmt === "percent" ? { kind: "percent", decimals: dec, sep } : r.fmt === "date" ? { kind: "date", pattern: r.date } : { kind: "none" };
      let calc: FieldLogic["calc"] = { kind: "none" };
      if (r.calc === "formula") {
        try {
          parseExpr(r.formula);
        } catch (e) {
          return d.status((e as Error).message);
        }
        calc = { kind: "formula", expr: r.formula.trim() };
      } else if (r.calc === "script") calc = p.logic.calc;
      else if (r.calc !== "none") calc = { kind: "simple", op: r.calc as CalcOp, fields: r.calcFields.split(",").map((x) => x.trim()).filter(Boolean) };
      const min = r.min.trim() === "" ? undefined : Number(r.min), max = r.max.trim() === "" ? undefined : Number(r.max);
      const validate: FieldLogic["validate"] = min !== undefined || max !== undefined ? { kind: "range", min, max } : p.logic.validate.kind === "script" ? p.logic.validate : { kind: "none" };
      patch.logic = { format, calc, validate };
    }
    try {
      await d.engine.updateField(doc.info.id, f.page, f.key, patch);
      d.refreshPage(f.page);
      d.changed(`Updated “${r.name}”`);
      await render();
    } catch (err) {
      d.status((err as Error).message);
    }
  }

  async function deleteSelected() {
    const doc = d.doc();
    if (!doc || !selected) return;
    const f = selected;
    await d.engine.deleteField(doc.info.id, f.page, f.key);
    selected = null;
    d.refreshPage(f.page);
    d.changed(`Deleted “${f.name}”`);
    await render();
  }

  async function detect() {
    const doc = d.doc();
    if (!doc) return;
    setTool(null);
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await deleteSelected();
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await properties(selected);
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      if (tool) setTool(null);
      else if (suggestions.length) ((suggestions = []), render());
      else if (selected) select(null);
      else exit();
    } else if (selected && e.key.startsWith("Arrow")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const step = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
      const r = selected.rect;
      await setRect(selected, [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy], "Moved");
    } else {
      const t = TYPES.find((x) => x.key === e.key.toUpperCase());
      if (t) {
        e.preventDefault();
        e.stopImmediatePropagation();
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
    selected = null;
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
    get active() { return on; },
  };
}
