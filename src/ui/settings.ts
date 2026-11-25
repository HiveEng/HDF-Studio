// Settings window: who you are (for comments and stamps), units and dates, and the default
// colour / line width / opacity / text size for each markup tool. Kept on this computer.
import { getPrefs, savePrefs, TOOL_GROUPS, type Prefs, type ToolGroup } from "./prefs";
import { UNITS, type Unit } from "../engine/measure";

export interface SettingsDeps {
  theme: { dark(): boolean; set(dark: boolean): void };
  checkUpdates(): void;
  status(msg: string): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  n.append(...kids);
  return n;
};

const OCR_LANGS: [string, string][] = [["eng", "English"], ["fra", "French"], ["spa", "Spanish"], ["deu", "German"], ["eng+fra", "English + French"]];

export async function openSettings(d: SettingsDeps) {
  const p = getPrefs();
  let version = "";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    version = await getVersion();
  } catch {
    version = "browser preview";
  }
  const print = JSON.parse(localStorage.getItem("hdfstudio.print") ?? "{}") as Record<string, string>;

  const back = el("div", { className: "modal-back" });
  const form = el("form", { className: "modal settings" });
  const field = (label: string, input: HTMLElement, hint?: string) => el("label", {}, el("span", { textContent: label }), input, ...(hint ? [el("small", { textContent: hint })] : []));
  const select = (name: string, opts: [string, string][], value: string) => {
    const s = el("select", { name });
    for (const [v, t] of opts) s.append(new Option(t, v, false, v === value));
    return s;
  };
  const text = (name: string, value: string, placeholder = "") => el("input", { name, value, placeholder });

  // ----- General -----
  const general = el("section", { className: "set-sec" },
    el("h3", { textContent: "You" }),
    el("div", { className: "set-grid" },
      field("Your name", text("name", p.name, "Shown on comments and stamps")),
      field("Company", text("company", p.company, "Shown on review stamps")),
    ),
    el("h3", { textContent: "Drawings and dates" }),
    el("div", { className: "set-grid" },
      field("Measurement units", select("units", UNITS, p.units), "Used when you set a scale"),
      field("Date format", select("dateFormat", [["iso", "2026-11-25"], ["us", "11/25/2026"], ["long", "November 25, 2026"]], p.dateFormat), "Used on stamps"),
    ),
    el("h3", { textContent: "App" }),
    el("div", { className: "set-grid" },
      field("Theme", select("theme", [["light", "Light"], ["dark", "Dark"]], d.theme.dark() ? "dark" : "light")),
      field("OCR language", select("ocr", OCR_LANGS, localStorage.getItem("hdfstudio.ocrLangs") || "eng")),
      field("Print size", select("printFit", [["actual", "Actual size"], ["fit", "Fit to paper"]], print.fit ?? "actual")),
      field("Print quality", select("printDpi", [["150", "Draft (150 dpi)"], ["300", "Standard (300 dpi)"], ["600", "High (600 dpi)"]], print.dpi ?? "300")),
    ),
  );

  // ----- Tools -----
  const table = el("table", { className: "set-tools" });
  table.append(el("tr", {}, ...["Tool", "Colour", "Line", "Opacity", "Text size"].map((h) => el("th", { textContent: h }))));
  for (const [g, label] of TOOL_GROUPS) {
    const t = p.tools[g];
    const num = (k: string, v: number, min: number, max: number, step: number) => el("input", { type: "number", name: `${g}.${k}`, value: String(v), min: String(min), max: String(max), step: String(step) });
    table.append(el("tr", {},
      el("td", { textContent: label }),
      el("td", {}, el("input", { type: "color", name: `${g}.color`, value: t.color })),
      el("td", {}, num("width", t.width, 0.25, 12, 0.25)),
      el("td", {}, num("opacity", Math.round(t.opacity * 100), 10, 100, 5), "%"),
      el("td", {}, num("fontSize", t.fontSize, 6, 48, 1)),
    ));
  }
  const tools = el("section", { className: "set-sec hidden" }, el("p", { className: "set-note", textContent: "Defaults for new markups. The colour picker on the Comment tab still overrides these for the moment." }), table);

  // ----- About -----
  const updateBtn = el("button", { type: "button", textContent: "Check for updates" });
  updateBtn.onclick = () => d.checkUpdates();
  const about = el("section", { className: "set-sec hidden" },
    el("h3", { textContent: "HDF Studio" }),
    el("p", { textContent: `Version ${version}` }),
    el("p", { className: "set-note", textContent: "Updates are checked automatically when the app starts." }),
    el("div", {}, updateBtn),
  );

  const tabs = el("div", { className: "set-tabs" });
  const secs: [string, HTMLElement][] = [["General", general], ["Tools", tools], ["About", about]];
  for (const [name, sec] of secs) {
    const b = el("button", { type: "button", textContent: name, className: sec === general ? "active" : "" });
    b.onclick = () => {
      secs.forEach(([, s]) => s.classList.toggle("hidden", s !== sec));
      tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    };
    tabs.append(b);
  }

  const reset = el("button", { type: "button", textContent: "Reset tool defaults" });
  const cancel = el("button", { type: "button", textContent: "Cancel" });
  const ok = el("button", { type: "submit", textContent: "Save", className: "primary" });
  form.append(el("h2", { textContent: "Settings" }), tabs, general, tools, about, el("div", { className: "modal-buttons" }, reset, el("span", { className: "grow" }), cancel, ok));
  back.append(form);
  document.body.append(back);
  form.querySelector<HTMLInputElement>("input")?.focus();

  const close = () => back.remove();
  cancel.onclick = close;
  back.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), close()));
  back.addEventListener("mousedown", (e) => e.target === back && close());
  reset.onclick = () => {
    localStorage.setItem("hdfstudio.prefs", JSON.stringify({ company: p.company, units: p.units, dateFormat: p.dateFormat }));
    const fresh = getPrefs();
    for (const [g] of TOOL_GROUPS) {
      const t = fresh.tools[g];
      for (const [k, v] of Object.entries({ color: t.color, width: t.width, opacity: Math.round(t.opacity * 100), fontSize: t.fontSize }))
        (form.elements.namedItem(`${g}.${k}`) as HTMLInputElement).value = String(v);
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement).value;
    const clamp = (x: number, lo: number, hi: number, dflt: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt);
    const next: Prefs = { name: v("name").trim(), company: v("company").trim(), units: v("units") as Unit, dateFormat: v("dateFormat") as Prefs["dateFormat"], tools: { ...p.tools } };
    for (const [g] of TOOL_GROUPS as [ToolGroup, string][]) {
      const old = p.tools[g];
      next.tools[g] = {
        color: v(`${g}.color`) || old.color,
        width: clamp(parseFloat(v(`${g}.width`)), 0.25, 12, old.width),
        opacity: clamp(parseFloat(v(`${g}.opacity`)), 10, 100, old.opacity * 100) / 100,
        fontSize: clamp(parseFloat(v(`${g}.fontSize`)), 6, 48, old.fontSize),
      };
    }
    savePrefs(next);
    localStorage.setItem("hdfstudio.ocrLangs", v("ocr"));
    localStorage.setItem("hdfstudio.print", JSON.stringify({ ...print, fit: v("printFit"), dpi: v("printDpi") }));
    const dark = v("theme") === "dark";
    if (dark !== d.theme.dark()) d.theme.set(dark);
    close();
    d.status("Settings saved");
  };
}
