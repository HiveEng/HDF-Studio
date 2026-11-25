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
}

export function setupForms(d: FormDeps) {
  let current: FieldInfo[] = [];

  async function render() {
    document.querySelectorAll(".page .field").forEach((n) => n.remove());
    const doc = d.doc();
    current = doc ? await d.fields(doc.info.id) : [];
    if (!doc || d.doc() !== doc) return;
    for (const f of current) place(doc.info.id, doc.info.pageSizes, f);
    return current.length;
  }

  function place(docId: number, sizes: [number, number][], f: FieldInfo) {
    const pageEl = d.pageEl(f.page);
    if (!pageEl || f.type === "button") return;
    const [pw, ph] = sizes[f.page];
    const [x0, y0, x1, y1] = f.rect;
    let el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
    switch (f.type) {
      case "text":
        el = f.multiline ? document.createElement("textarea") : Object.assign(document.createElement("input"), { type: "text" });
        el.value = f.value;
        if (f.maxLen > 0) (el as HTMLInputElement).maxLength = f.maxLen;
        break;
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
      default:
        return;
    }
    el.classList.add("field", `field-${f.type}`);
    el.title = f.name;
    el.dataset.key = String(f.key);
    Object.assign(el.style, { left: `${(x0 / pw) * 100}%`, top: `${(y0 / ph) * 100}%`, width: `${((x1 - x0) / pw) * 100}%`, height: `${((y1 - y0) / ph) * 100}%` });
    if (f.readOnly) (el as HTMLInputElement).disabled = true;
    // keep page tools (pan, select) from grabbing clicks meant for the field
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    if (f.type !== "signature") {
      const commit = async () => {
        const v = el instanceof HTMLInputElement && el.type === "checkbox" ? (el.checked ? "Yes" : "Off") : el instanceof HTMLInputElement && el.type === "radio" ? f.onState ?? "" : (el as HTMLInputElement).value;
        const doc = d.doc();
        if (!doc) return;
        current = await d.setField(doc.info.id, f.page, f.key, v);
        d.refreshPage(f.page);
        d.changed(`Filled “${f.name}”`);
      };
      el.addEventListener("change", commit);
    }
    pageEl.append(el);
  }

  return { render, get fields() { return current; } };
}
