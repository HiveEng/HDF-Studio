// A small modal progress card for long jobs (OCR, compare, batch), with a Cancel button.
export interface Progress {
  set(fraction: number, text?: string): void;
  readonly cancelled: boolean;
  close(): void;
}

export function showProgress(title: string): Progress {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal progress";
  box.setAttribute("role", "progressbar");
  const h = Object.assign(document.createElement("h2"), { textContent: title });
  const bar = Object.assign(document.createElement("div"), { className: "bar" });
  const fill = document.createElement("i");
  bar.append(fill);
  const label = Object.assign(document.createElement("div"), { className: "muted" });
  const row = Object.assign(document.createElement("div"), { className: "modal-buttons" });
  const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
  row.append(cancel);
  box.append(h, bar, label, row);
  back.append(box);
  document.body.append(back);
  let cancelled = false;
  cancel.onclick = () => {
    cancelled = true;
    cancel.disabled = true;
    label.textContent = "Stopping after this page…";
  };
  return {
    set(f, text) {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
      box.setAttribute("aria-valuenow", String(Math.round(f * 100)));
      if (text && !cancelled) label.textContent = text;
    },
    get cancelled() {
      return cancelled;
    },
    close: () => back.remove(),
  };
}
