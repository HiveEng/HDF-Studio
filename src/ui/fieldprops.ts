// Field properties: a tabbed dialog (General, Appearance, Options, Format, Calculate, Validate,
// Action) like the ones in desktop PDF editors. With several fields selected it shows only what
// they have in common and changes just the settings you touch.
import { parseExpr, SPECIAL_LABEL, type FieldLogic, type NumberSep, type CalcOp, type SpecialMask } from "../engine/formcalc";
import type { FieldProps, FieldPatch, FieldLook, ButtonAction } from "../engine/formdesign";

type Opt = [string, string];
type Ctl =
  | { k: string; label: string; kind: "text" | "number" | "textarea"; value: string; placeholder?: string; hint?: string; show?: () => boolean }
  | { k: string; label: string; kind: "select"; value: string; options: Opt[]; hint?: string; show?: () => boolean }
  | { k: string; label: string; kind: "check"; value: boolean; hint?: string; show?: () => boolean }
  | { k: string; label: string; kind: "color"; value: number[] | null; allowNone?: boolean; show?: () => boolean };

const hex = (c: number[] | null) => (c ? "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("") : "#ffffff");
const unhex = (h: string) => [1, 3, 5].map((i) => +(parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3));
const TYPE_NAME: Record<string, string> = { text: "Text field", checkbox: "Check box", radiobutton: "Radio button", combobox: "Dropdown", listbox: "List box", signature: "Signature field", button: "Button" };
const DATE_STYLES = ["mm/dd/yyyy", "m/d/yy", "dd/mm/yyyy", "yyyy-mm-dd", "mmm d, yyyy", "d-mmm-yyyy", "mmmm d, yyyy"];

/**
 * Show the properties of one or more fields. Resolves to the change to make (only what the user
 * changed when several fields are selected), or null on Cancel.
 */
export function fieldProperties(list: FieldProps[], names: string[]): Promise<FieldPatch | null> {
  const p = list[0];
  const many = list.length > 1;
  const types = new Set(list.map((x) => x.type));
  const only = (...t: string[]) => [...types].every((x) => t.includes(x));
  const isText = only("text"), isChoice = only("combobox", "listbox"), isToggle = only("checkbox", "radiobutton"), isButton = only("button");
  const hasText = only("text", "combobox", "listbox", "button");
  const L = p.logic, F = L.format, C = L.calc, V = L.validate;

  const tabs: { id: string; label: string; ctls: Ctl[] }[] = [];
  const general: Ctl[] = [];
  if (!many) {
    general.push({ k: "name", label: p.type === "radiobutton" ? "Group name" : "Name", kind: "text", value: p.name, hint: "Used when filling from a spreadsheet and when exporting data" });
    general.push({ k: "tooltip", label: "Tooltip", kind: "text", value: p.tooltip, placeholder: "Shown when hovering the field" });
  }
  if (!isButton) {
    general.push({ k: "required", label: "Required", kind: "check", value: list.every((x) => x.required) });
  }
  general.push({ k: "readOnly", label: "Read only", kind: "check", value: list.every((x) => x.readOnly) });
  tabs.push({ id: "general", label: "General", ctls: general });

  const look: Ctl[] = [
    { k: "borderColor", label: "Border color", kind: "color", value: p.look.borderColor, allowNone: true },
    { k: "borderWidth", label: "Border width", kind: "select", value: String(p.look.borderWidth), options: [["0", "None"], ["1", "Thin"], ["2", "Medium"], ["3", "Thick"]] },
    { k: "fillColor", label: "Fill color", kind: "color", value: p.look.fillColor, allowNone: true },
  ];
  if (hasText) {
    look.push(
      { k: "font", label: "Font", kind: "select", value: p.look.font, options: [["Helv", "Helvetica"], ["HeBo", "Helvetica Bold"], ["TiRo", "Times"], ["Cour", "Courier"]] },
      { k: "fontSize", label: "Font size", kind: "select", value: String(p.fontSize), options: [["0", "Auto (fit the box)"], ...[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24].map((n): Opt => [String(n), String(n)]), ...(![0, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24].includes(p.fontSize) ? [[String(p.fontSize), String(p.fontSize)] as Opt] : [])] },
      { k: "align", label: "Text alignment", kind: "select", value: String(p.look.align), options: [["0", "Left"], ["1", "Center"], ["2", "Right"]] },
    );
  }
  look.push({ k: "textColor", label: isToggle ? "Check color" : "Text color", kind: "color", value: p.look.textColor });
  if (isToggle) look.push({ k: "checkStyle", label: "Check style", kind: "select", value: p.look.checkStyle, options: [["check", "✓ Check"], ["cross", "✗ Cross"], ["circle", "● Circle"], ["square", "■ Square"], ["diamond", "◆ Diamond"], ["star", "★ Star"]] });
  tabs.push({ id: "look", label: "Appearance", ctls: look });

  const opts: Ctl[] = [];
  if (!many && isText) {
    opts.push(
      { k: "value", label: "Default value", kind: "text", value: p.value, hint: "What the field holds before anyone types (also kept by copies)" },
      { k: "multiline", label: "Multiple lines", kind: "check", value: p.multiline },
      { k: "maxLen", label: "Character limit", kind: "number", value: p.maxLen ? String(p.maxLen) : "", placeholder: "No limit" },
      { k: "comb", label: "Comb of characters (one per box, needs a limit)", kind: "check", value: p.comb },
    );
  } else if (isText) opts.push({ k: "multiline", label: "Multiple lines", kind: "check", value: list.every((x) => x.multiline) });
  if (!many && isChoice) {
    opts.push({ k: "options", label: "Choices", kind: "textarea", value: p.options.join("\n"), hint: "One per line" });
    if (p.type === "combobox") opts.push({ k: "editable", label: "Allow typing other text", kind: "check", value: p.editable });
    if (p.type === "listbox") opts.push({ k: "multiSelect", label: "Allow more than one choice", kind: "check", value: p.multiSelect });
  }
  if (!many && isToggle) opts.push({ k: "exportValue", label: p.type === "radiobutton" ? "Value of this choice" : "Value when checked", kind: "text", value: p.exportValue ?? "Yes", hint: p.type === "radiobutton" ? "What the group holds when this button is picked" : "Exported when the box is checked" });
  if (!many && isButton) opts.push({ k: "caption", label: "Label", kind: "text", value: p.caption });
  if (opts.length) tabs.push({ id: "options", label: "Options", ctls: opts });

  let get: (k: string) => string = () => "";
  if (isText && !many) {
    const fmtVal = F.kind === "number" ? (F.currency ? "currency" : "number") : F.kind === "special" ? F.mask : F.kind;
    const fmt = () => get("fmt");
    tabs.push({ id: "format", label: "Format", ctls: [
      { k: "fmt", label: "Format", kind: "select", value: fmtVal, options: [["none", "None (plain text)"], ["number", "Number"], ["currency", "Currency"], ["percent", "Percent"], ["date", "Date"], ...(Object.keys(SPECIAL_LABEL) as SpecialMask[]).map((m): Opt => [m, SPECIAL_LABEL[m]])] },
      { k: "decimals", label: "Decimal places", kind: "select", value: String(F.kind === "number" || F.kind === "percent" ? F.decimals : 2), options: ["0", "1", "2", "3", "4"].map((x): Opt => [x, x]), show: () => ["number", "currency", "percent"].includes(fmt()) },
      { k: "currency", label: "Currency symbol", kind: "text", value: F.kind === "number" && F.currency ? F.currency : "$", show: () => fmt() === "currency" },
      { k: "sep", label: "Number style", kind: "select", value: String(F.kind === "number" || F.kind === "percent" ? F.sep : 0), options: [["0", "1,234.56"], ["1", "1234.56"], ["2", "1.234,56"], ["3", "1234,56"]], show: () => ["number", "currency", "percent"].includes(fmt()) },
      { k: "negParens", label: "Show negatives in brackets", kind: "check", value: F.kind === "number" && !!F.negParens, show: () => ["number", "currency"].includes(fmt()) },
      { k: "date", label: "Date style", kind: "select", value: F.kind === "date" ? F.pattern : "mm/dd/yyyy", options: [...new Set([F.kind === "date" ? F.pattern : "mm/dd/yyyy", ...DATE_STYLES])].map((x): Opt => [x, x]), show: () => fmt() === "date", hint: "A calendar opens when filling in" },
    ] });
    const calc = () => get("calc");
    tabs.push({ id: "calc", label: "Calculate", ctls: [
      { k: "calc", label: "Value is", kind: "select", value: C.kind === "simple" ? C.op : C.kind, options: [["none", "Typed in (not calculated)"], ["SUM", "Sum (+) of fields"], ["PRD", "Product (×) of fields"], ["AVG", "Average of fields"], ["MIN", "Minimum of fields"], ["MAX", "Maximum of fields"], ["formula", "Formula"], ...(C.kind === "script" ? [["script", "Custom script (kept, not run here)"] as Opt] : [])] },
      { k: "calcFields", label: "Fields to calculate from", kind: "textarea", value: C.kind === "simple" ? C.fields.join("\n") : "", hint: `One name per line. Fields in this form: ${names.filter((n) => n !== p.name).slice(0, 30).join(", ")}${names.length > 31 ? "…" : ""}`, show: () => ["SUM", "PRD", "AVG", "MIN", "MAX"].includes(calc()) },
      { k: "formula", label: "Formula", kind: "text", value: C.kind === "formula" ? C.expr : "", placeholder: "Qty * Price", hint: "Field names with + - * / and brackets. Put \\ before a space or dot in a name.", show: () => calc() === "formula" },
    ] });
    const val = () => get("val");
    tabs.push({ id: "validate", label: "Validate", ctls: [
      { k: "val", label: "Check the value", kind: "select", value: V.kind, options: [["none", "Anything allowed"], ["range", "Number in a range"], ["email", "Email address"], ...(V.kind === "script" ? [["script", "Custom script (kept, not run here)"] as Opt] : [])] },
      { k: "min", label: "Lowest allowed value", kind: "number", value: V.kind === "range" && V.min !== undefined ? String(V.min) : "", placeholder: "No limit", show: () => val() === "range" },
      { k: "max", label: "Highest allowed value", kind: "number", value: V.kind === "range" && V.max !== undefined ? String(V.max) : "", placeholder: "No limit", show: () => val() === "range" },
    ] });
  }
  if (isButton && !many) {
    const act = () => get("action");
    tabs.push({ id: "action", label: "Action", ctls: [
      { k: "action", label: "When clicked", kind: "select", value: p.action.kind, options: [["none", "Do nothing"], ["reset", "Clear the form"], ["print", "Print"], ["url", "Open a web link"]] },
      { k: "url", label: "Web address", kind: "text", value: p.action.kind === "url" ? p.action.url : "", placeholder: "https://", show: () => act() === "url" },
    ] });
  }

  return new Promise((resolve) => {
    const back = Object.assign(document.createElement("div"), { className: "modal-back" });
    const form = Object.assign(document.createElement("form"), { className: "modal fprops" });
    const title = many ? `${list.length} fields` : `${TYPE_NAME[p.type] ?? "Field"}: ${p.name}`;
    form.append(Object.assign(document.createElement("h2"), { textContent: `${title} properties` }));
    const tabBar = Object.assign(document.createElement("div"), { className: "fp-tabs", role: "tablist" });
    const panes = Object.assign(document.createElement("div"), { className: "fp-panes" });
    form.append(tabBar, panes);
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const touched = new Set<string>();
    const rows: { row: HTMLElement; show?: () => boolean }[] = [];
    get = (k) => {
      const el = inputs.get(k);
      return !el ? "" : el instanceof HTMLInputElement && el.type === "checkbox" ? (el.checked ? "1" : "") : el.value;
    };
    const refresh = () => rows.forEach((r) => r.row.classList.toggle("hidden", !!r.show && !r.show()));
    for (const t of tabs) {
      const tb = Object.assign(document.createElement("button"), { type: "button", textContent: t.label, role: "tab" });
      const pane = Object.assign(document.createElement("div"), { className: "fp-pane hidden" });
      tb.onclick = () => {
        tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === tb));
        panes.querySelectorAll(".fp-pane").forEach((x) => x.classList.toggle("hidden", x !== pane));
      };
      tabBar.append(tb);
      panes.append(pane);
      for (const c of t.ctls) {
        const row = document.createElement("label");
        row.className = `fp-row fp-${c.kind}`;
        const span = Object.assign(document.createElement("span"), { textContent: c.label });
        let el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (c.kind === "select") {
          el = document.createElement("select");
          for (const [v, txt] of c.options) el.append(new Option(txt, v, false, v === c.value));
          row.append(span, el);
        } else if (c.kind === "check") {
          el = Object.assign(document.createElement("input"), { type: "checkbox", checked: c.value });
          row.append(el, span);
        } else if (c.kind === "textarea") {
          el = Object.assign(document.createElement("textarea"), { value: c.value, rows: 4 });
          row.append(span, el);
        } else if (c.kind === "color") {
          el = Object.assign(document.createElement("input"), { type: "color", value: hex(c.value) });
          const wrap = Object.assign(document.createElement("span"), { className: "fp-swatch" });
          wrap.append(el);
          if (c.allowNone) {
            const none = Object.assign(document.createElement("input"), { type: "checkbox", checked: !c.value });
            const nl = Object.assign(document.createElement("label"), { className: "fp-none" });
            nl.append(none, " None");
            none.onchange = () => {
              touched.add(c.k);
              el.disabled = none.checked;
            };
            el.disabled = !c.value;
            inputs.set(`${c.k}:none`, none);
            wrap.append(nl);
          }
          row.append(span, wrap);
        } else {
          el = Object.assign(document.createElement("input"), { type: c.kind, value: c.value, placeholder: c.placeholder ?? "" });
          if (c.kind === "number") (el as HTMLInputElement).step = "any";
          row.append(span, el);
        }
        if ("hint" in c && c.hint) row.append(Object.assign(document.createElement("small"), { textContent: c.hint }));
        el.name = c.k;
        el.addEventListener("input", () => (touched.add(c.k), refresh()));
        el.addEventListener("change", () => (touched.add(c.k), refresh()));
        inputs.set(c.k, el);
        rows.push({ row, show: c.show });
        pane.append(row);
      }
    }
    (tabBar.firstElementChild as HTMLElement | null)?.click();
    refresh();
    const err = Object.assign(document.createElement("div"), { className: "fp-error" });
    const btns = Object.assign(document.createElement("div"), { className: "modal-buttons" });
    const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
    const ok = Object.assign(document.createElement("button"), { type: "submit", textContent: "Save", className: "primary" });
    btns.append(cancel, ok);
    form.append(err, btns);
    back.append(form);
    document.body.append(back);
    (form.querySelector(".fp-pane:not(.hidden) input, .fp-pane:not(.hidden) select") as HTMLElement | null)?.focus();

    const done = (v: FieldPatch | null) => (back.remove(), resolve(v));
    cancel.onclick = () => done(null);
    back.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), done(null)));
    back.addEventListener("mousedown", (e) => e.target === back && done(null));
    form.onsubmit = (e) => {
      e.preventDefault();
      try {
        done(buildPatch());
      } catch (x) {
        err.textContent = (x as Error).message;
      }
    };

    // Only what changed (so several fields keep their own other settings).
    const ch = (k: string) => touched.has(k);
    const bool = (k: string) => get(k) === "1";
    const color = (k: string): number[] | null => ((inputs.get(`${k}:none`) as HTMLInputElement | undefined)?.checked ? null : unhex(get(k)));
    function buildPatch(): FieldPatch {
      const patch: FieldPatch = {};
      if (ch("name")) patch.name = get("name");
      if (ch("tooltip")) patch.tooltip = get("tooltip");
      if (ch("required")) patch.required = bool("required");
      if (ch("readOnly")) patch.readOnly = bool("readOnly");
      const lk: Partial<FieldLook> = {};
      if (ch("borderColor")) lk.borderColor = color("borderColor");
      if (ch("fillColor")) lk.fillColor = color("fillColor");
      if (ch("textColor")) lk.textColor = color("textColor") ?? [0, 0, 0];
      if (ch("borderWidth")) lk.borderWidth = +get("borderWidth");
      if (ch("font")) lk.font = get("font") as FieldLook["font"];
      if (ch("align")) lk.align = +get("align") as 0 | 1 | 2;
      if (ch("checkStyle")) lk.checkStyle = get("checkStyle") as FieldLook["checkStyle"];
      if (Object.keys(lk).length) patch.look = lk;
      if (ch("fontSize")) patch.fontSize = Math.max(0, +get("fontSize") || 0);
      if (ch("multiline")) patch.multiline = bool("multiline");
      if (ch("maxLen")) patch.maxLen = Math.max(0, Math.floor(+get("maxLen") || 0));
      if (ch("comb")) patch.comb = bool("comb");
      if (ch("options")) patch.options = get("options").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
      if (ch("editable")) patch.editable = bool("editable");
      if (ch("multiSelect")) patch.multiSelect = bool("multiSelect");
      if (ch("exportValue")) patch.exportValue = get("exportValue");
      if (ch("caption")) patch.caption = get("caption");
      if (ch("action") || ch("url")) {
        const k = get("action");
        const url = get("url").trim();
        if (k === "url" && !/^(https?:|mailto:)/i.test(url)) throw new Error("Enter a web address starting with https:// (or mailto:)");
        patch.action = (k === "url" ? { kind: "url", url } : { kind: k }) as ButtonAction;
      }
      if (ch("value")) patch.value = get("value");
      if (isText && !many && ["fmt", "decimals", "currency", "sep", "negParens", "date", "calc", "calcFields", "formula", "val", "min", "max"].some(ch)) {
        const dec = Math.max(0, Math.min(6, Math.floor(+get("decimals") || 0)));
        const sep = (+get("sep") & 3) as NumberSep;
        const f = get("fmt");
        const format: FieldLogic["format"] =
          f === "number" ? { kind: "number", decimals: dec, sep, negParens: bool("negParens") }
          : f === "currency" ? { kind: "number", decimals: dec, sep, negParens: bool("negParens"), currency: get("currency") || "$", prepend: true }
          : f === "percent" ? { kind: "percent", decimals: dec, sep }
          : f === "date" ? { kind: "date", pattern: get("date") }
          : f in SPECIAL_LABEL ? { kind: "special", mask: f as SpecialMask }
          : { kind: "none" };
        let calc: FieldLogic["calc"] = { kind: "none" };
        const c = get("calc");
        if (c === "formula") {
          parseExpr(get("formula")); // throws with a readable message
          calc = { kind: "formula", expr: get("formula").trim() };
        } else if (c === "script") calc = L.calc;
        else if (c !== "none") {
          const fields = get("calcFields").split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
          const unknown = fields.filter((n) => !names.includes(n));
          if (unknown.length) throw new Error(`No field named ${unknown.map((n) => `“${n}”`).join(", ")}`);
          calc = { kind: "simple", op: c as CalcOp, fields };
        }
        const v = get("val");
        const min = get("min").trim() === "" ? undefined : +get("min"), max = get("max").trim() === "" ? undefined : +get("max");
        const validate: FieldLogic["validate"] = v === "range" ? (min !== undefined || max !== undefined ? { kind: "range", min, max } : { kind: "none" }) : v === "email" ? { kind: "email" } : v === "script" ? L.validate : { kind: "none" };
        patch.logic = { format, calc, validate };
      }
      return patch;
    }
  });
}
