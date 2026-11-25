// Minimal modal dialogs (window.prompt/confirm are unreliable in desktop webviews).
export type Field =
  | { name: string; label: string; type?: "text" | "password" | "number"; value?: string; placeholder?: string; hint?: string }
  | { name: string; label: string; type: "select"; options: [string, string][]; value?: string; hint?: string };

export function ask(title: string, fields: Field[], okLabel = "OK"): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    const form = document.createElement("form");
    form.className = "modal";
    const h = document.createElement("h2");
    h.textContent = title;
    form.append(h);
    for (const f of fields) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = f.label;
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const [v, t] of f.options) input.append(new Option(t, v, false, v === f.value));
      } else {
        input = document.createElement("input");
        input.type = f.type ?? "text";
        input.value = f.value ?? "";
        input.placeholder = f.placeholder ?? "";
      }
      input.name = f.name;
      label.append(span, input);
      if (f.hint) label.append(Object.assign(document.createElement("small"), { textContent: f.hint }));
      form.append(label);
    }
    const row = document.createElement("div");
    row.className = "modal-buttons";
    const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
    const ok = Object.assign(document.createElement("button"), { type: "submit", textContent: okLabel, className: "primary" });
    row.append(cancel, ok);
    form.append(row);
    back.append(form);
    document.body.append(back);
    (form.querySelector("input, select") as HTMLElement | null)?.focus();
    (form.querySelector("input") as HTMLInputElement | null)?.select();

    const done = (v: Record<string, string> | null) => {
      back.remove();
      resolve(v);
    };
    cancel.onclick = () => done(null);
    back.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), done(null)));
    back.addEventListener("mousedown", (e) => e.target === back && done(null));
    form.onsubmit = (e) => {
      e.preventDefault();
      done(Object.fromEntries(new FormData(form).entries()) as Record<string, string>);
    };
  });
}

export async function confirmDialog(title: string, okLabel = "OK"): Promise<boolean> {
  return (await ask(title, [], okLabel)) !== null;
}
