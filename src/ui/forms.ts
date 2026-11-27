// Interactive form filling: live HTML inputs laid over the PDF's form fields.
import type { FieldInfo } from "../engine/forms";

export interface FormDeps {
  fields(id: number): Promise<FieldInfo[]>;
  setField(id: number, page: number, key: number, value: string): Promise<FieldInfo[]>;
  doc(): { info: { id: number; pageSizes: [number, number][] } } | null;
  pageEl(i: number): HTMLElement | undefined;
  refreshPage(i: number): void;
  changed(label: string): void;
  signField(f: FieldInfo): void;
  status?(msg: string): void;
  /** A push button was clicked: clear the form, print or open its link. */
  pressButton?(f: FieldInfo): void;
}

export function setupForms(d: FormDeps) {
  let current: FieldInfo[] = [];

  async function render() {
    const doc = d.doc();
    const next = doc ? await d.fields(doc.info.id) : [];
    if (d.doc() !== doc) return;
    // Keep the cursor where it was (tabbing on to the next field re-renders the form).
    const focusKey = (document.activeElement as HTMLElement | null)?.closest?.(".field")?.getAttribute("data-key");
    document.querySelectorAll(".page .field").forEach((n) => n.remove());
    current = next;
    if (!doc) return;
    for (const f of current) place(doc.info.id, doc.info.pageSizes, f);
    if (focusKey) document.querySelector<HTMLElement>(`.page .field[data-key="${focusKey}"]`)?.focus();
    return current.length;
  }

  function place(docId: number, sizes: [number, number][], f: FieldInfo) {
    const pageEl = d.pageEl(f.page);
    if (!pageEl || (f.type === "button" && (!f.action || f.action.kind === "none")) || (f.type === "signature" && f.value)) return; // signed: show its own appearance
    const [pw, ph] = sizes[f.page];
    const [x0, y0, x1, y1] = f.rect;
    let el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
    let extra: HTMLElement | null = null; // drawn above the field (the date picker button)
    switch (f.type) {
      case "text": {
        const t = f.multiline ? document.createElement("textarea") : Object.assign(document.createElement("input"), { type: "text" });
        // Formatted while you look at it ($1,234.50), the plain value while you type.
        t.value = f.shown;
        t.addEventListener("focus", () => !t.readOnly && t.value !== f.value && f.shown === t.value && (t.value = f.value));
        t.addEventListener("blur", () => t.value === f.value && (t.value = f.shown));
        if (f.maxLen > 0) (t as HTMLInputElement).maxLength = f.maxLen;
        const fk = f.logic.format.kind;
        if (fk === "number" || fk === "percent") t.inputMode = "decimal";
        if (fk === "special") t.inputMode = "tel";
        if (fk === "date" && !f.multiline && f.logic.calc.kind === "none") {
          // A calendar button beside the date: picks a day and fills it in the field's style.
          const pick = Object.assign(document.createElement("input"), { type: "date", className: "field-datepick", tabIndex: -1, title: "Pick a date" });
          const [, py0, px1, py1] = f.rect;
          const h = py1 - py0;
          Object.assign(pick.style, { left: `${((px1 - Math.min(h, 16)) / pw) * 100}%`, top: `${(py0 / ph) * 100}%`, width: `${(Math.min(h, 16) / pw) * 100}%`, height: `${(h / ph) * 100}%` });
          const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
          pick.addEventListener("pointerdown", (e) => e.stopPropagation());
          pick.addEventListener("click", () => {
            const d0 = new Date(f.shown || f.value);
            if (!isNaN(+d0)) pick.value = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;
            (pick as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
          });
          pick.addEventListener("change", () => {
            if (!iso.test(pick.value)) return;
            t.value = pick.value; // the engine turns yyyy-mm-dd into the field's own date style
            t.dispatchEvent(new Event("change"));
          });
          pick.classList.add("field");
          pick.dataset.key = `${f.key}-cal`;
          if (!f.readOnly) extra = pick;
        }
        if (f.logic.calc.kind !== "none") {
          t.readOnly = true;
          t.tabIndex = -1;
          t.classList.add("field-calc");
          t.title = `${f.name}: calculated`;
        }
        if (f.required) t.classList.add("field-required");
        el = t;
        break;
      }
      case "checkbox":
        el = Object.assign(document.createElement("input"), { type: "checkbox", checked: f.value !== "Off" && f.value !== "" });
        break;
      case "radiobutton":
        el = Object.assign(document.createElement("input"), { type: "radio", name: `radio-${docId}-${f.name}`, checked: f.value === f.onState });
        break;
      case "combobox":
      case "listbox": {
        const s = document.createElement("select");
        s.append(new Option("", ""));
        for (const o of f.options) s.append(new Option(o, o, false, o === f.value));
        if (f.type === "listbox") s.size = Math.max(2, Math.min(f.options.length, 6));
        el = s;
        break;
      }
      case "signature":
        el = Object.assign(document.createElement("button"), { textContent: f.value ? "Signed" : "Sign here", type: "button" });
        el.onclick = () => d.signField(f);
        break;
      case "button":
        // Transparent over the button's own drawing; clicking runs its action.
        el = Object.assign(document.createElement("button"), { type: "button", title: f.action?.kind === "url" ? `Open ${f.action.url}` : f.action?.kind === "print" ? "Print" : "Clear the form" });
        el.setAttribute("aria-label", f.caption || f.name);
        el.onclick = () => d.pressButton?.(f);
        break;
      default:
        return;
    }
    el.classList.add("field", `field-${f.type}`);
    el.title ||= f.name + (f.required ? " (required)" : "");
    el.dataset.key = String(f.key);
    Object.assign(el.style, { left: `${(x0 / pw) * 100}%`, top: `${(y0 / ph) * 100}%`, width: `${((x1 - x0) / pw) * 100}%`, height: `${((y1 - y0) / ph) * 100}%` });
    if (f.readOnly) (el as HTMLInputElement).disabled = true;
    // keep page tools (pan, select) from grabbing clicks meant for the field
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    if (f.type !== "signature" && f.type !== "button") {
      const commit = async () => {
        const v = el instanceof HTMLInputElement && el.type === "checkbox" ? (el.checked ? "Yes" : "Off") : el instanceof HTMLInputElement && el.type === "radio" ? f.onState ?? "" : (el as HTMLInputElement).value;
        const doc = d.doc();
        if (!doc) return;
        try {
          current = await d.setField(doc.info.id, f.page, f.key, v);
        } catch (e) {
          // Not a valid value for this field (number, date or range): put the old one back.
          d.status?.(String((e as Error).message ?? e).replace(/^Error:\s*/, ""));
          (el as HTMLInputElement).value = f.shown;
          el.classList.add("field-invalid");
          setTimeout(() => el.classList.remove("field-invalid"), 1500);
          return;
        }
        d.changed(`Filled “${f.name}”`);
        // Calculated fields elsewhere may have changed: redraw the pages with fields.
        for (const p of new Set(current.map((x) => x.page))) d.refreshPage(p);
        await render();
      };
      el.addEventListener("change", commit);
    }
    pageEl.append(el);
    if (extra) pageEl.append(extra);
  }

  return { render, get fields() { return current; } };
}
