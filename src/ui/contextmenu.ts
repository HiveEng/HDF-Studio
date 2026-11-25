// A small right-click menu. Items run palette-style actions; Esc, a click elsewhere or scrolling closes it.
export type MenuItem =
  | { label: string; run: () => void | Promise<void>; keys?: string; disabled?: boolean; danger?: boolean }
  | { sep: true }
  | { swatches: { color: string; title: string; run: () => void }[] };

let open: HTMLElement | null = null;

export function closeMenu() {
  open?.remove();
  open = null;
}

export function showMenu(x: number, y: number, items: MenuItem[], title?: string) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.setAttribute("role", "menu");
  if (title) m.append(Object.assign(document.createElement("div"), { className: "ctx-title", textContent: title }));
  for (const it of items) {
    if ("sep" in it) {
      m.append(Object.assign(document.createElement("div"), { className: "ctx-sep" }));
    } else if ("swatches" in it) {
      const row = document.createElement("div");
      row.className = "ctx-swatches";
      for (const s of it.swatches) {
        const b = Object.assign(document.createElement("button"), { type: "button", title: s.title, className: "ctx-swatch" });
        b.style.background = s.color;
        b.onclick = () => (closeMenu(), s.run());
        row.append(b);
      }
      m.append(row);
    } else {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "ctx-item" + (it.danger ? " danger" : ""), disabled: !!it.disabled });
      b.setAttribute("role", "menuitem");
      b.append(Object.assign(document.createElement("span"), { textContent: it.label }));
      if (it.keys) b.append(Object.assign(document.createElement("kbd"), { textContent: it.keys }));
      b.onclick = () => {
        closeMenu();
        void it.run();
      };
      m.append(b);
    }
  }
  document.body.append(m);
  // Keep it on screen.
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  open = m;
  (m.querySelector("button:not([disabled])") as HTMLElement | null)?.focus();
  m.addEventListener("keydown", (e) => {
    const btns = [...m.querySelectorAll<HTMLButtonElement>("button.ctx-item:not([disabled])")];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") (e.preventDefault(), btns[(i + 1) % btns.length]?.focus());
    else if (e.key === "ArrowUp") (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length]?.focus());
  });
}

window.addEventListener("pointerdown", (e) => open && !open.contains(e.target as Node) && closeMenu(), true);
window.addEventListener("keydown", (e: KeyboardEvent) => e.key === "Escape" && open && (e.stopPropagation(), closeMenu()), true);
window.addEventListener("wheel", () => closeMenu(), { passive: true });
window.addEventListener("blur", () => closeMenu());
