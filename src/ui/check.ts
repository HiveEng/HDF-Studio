// Document check report: pass/fail per standard, plain-language issues and one-click fixes.
import type { CheckReport, Fix, Area } from "../engine/check";

const FIX_LABEL: Record<Fix, string> = {
  title: "Add title",
  lang: "Set language",
  displayTitle: "Fix",
  tabs: "Fix",
  ocr: "Recognize text",
  sanitize: "Remove",
  unprotect: "Remove password",
  pdfa: "Save as PDF/A",
};
const AREA_HINT: Record<Area, string> = {
  "PDF/A": "Long-term archiving (ISO 19005)",
  Accessibility: "Screen readers and assistive technology",
  Security: "Hidden content that runs or travels with the file",
};

export function showCheckReport(name: string, r: CheckReport, onFix: (f: Fix) => Promise<unknown>, onQuickFixAll: (() => Promise<unknown>) | null) {
  document.querySelector("#checkReport")?.remove();
  const back = document.createElement("div");
  back.className = "modal-back";
  back.id = "checkReport";
  const box = document.createElement("div");
  box.className = "modal check";
  const close = () => back.remove();
  box.innerHTML = `<header><h2></h2><button class="icon-btn close" title="Close (Esc)">×</button></header><div class="verdicts"></div><div class="issues"></div><div class="modal-buttons"></div>`;
  box.querySelector("h2")!.textContent = `Document check: ${name}`;
  const verdicts = box.querySelector(".verdicts")!;
  for (const area of ["PDF/A", "Accessibility", "Security"] as Area[]) {
    const ok = r.passes[area];
    const v = document.createElement("div");
    v.className = `verdict ${ok ? "pass" : "fail"}`;
    v.innerHTML = `<b></b><span></span><small></small>`;
    v.querySelector("b")!.textContent = ok ? "✓" : "✗";
    v.querySelector("span")!.textContent = area === "PDF/A" && r.pdfaClaim && ok ? `PDF/A-${r.pdfaClaim}` : area;
    v.querySelector("small")!.textContent = AREA_HINT[area];
    verdicts.append(v);
  }
  const list = box.querySelector(".issues")!;
  if (!r.issues.length) list.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No problems found." }));
  for (const area of ["PDF/A", "Accessibility", "Security"] as Area[]) {
    const items = r.issues.filter((i) => i.area === area);
    if (!items.length) continue;
    list.append(Object.assign(document.createElement("h3"), { textContent: area }));
    for (const i of items) {
      const row = document.createElement("div");
      row.className = `issue ${i.level}`;
      row.innerHTML = `<i></i><span></span>`;
      row.querySelector("i")!.textContent = i.level === "error" ? "✗" : "!";
      row.querySelector("span")!.textContent = i.text;
      if (i.fix) {
        const b = Object.assign(document.createElement("button"), { textContent: FIX_LABEL[i.fix] });
        b.onclick = async () => {
          close();
          await onFix(i.fix!);
        };
        row.append(b);
      }
      list.append(row);
    }
  }
  const buttons = box.querySelector(".modal-buttons")!;
  if (onQuickFixAll && r.issues.some((i) => i.fix && ["title", "lang", "displayTitle", "tabs"].includes(i.fix))) {
    const all = Object.assign(document.createElement("button"), { className: "primary", textContent: "Fix title, language and tab order" });
    all.onclick = async () => {
      close();
      await onQuickFixAll();
    };
    buttons.append(all);
  }
  const done = Object.assign(document.createElement("button"), { textContent: "Close" });
  done.onclick = close;
  buttons.append(done);
  box.querySelector<HTMLElement>(".close")!.onclick = close;
  back.addEventListener("click", (e) => e.target === back && close());
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.append(box);
  document.body.append(back);
  (buttons.firstElementChild as HTMLElement).focus();
}
