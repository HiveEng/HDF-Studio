// Alt text review: every figure found by tagging, with a preview, a description box and a
// "decorative" switch (decorative images become artifacts that screen readers skip).
import type { FigureInfo } from "../engine/autotag";

export interface AltDeps {
  figures(): Promise<FigureInfo[]>;
  /** Page image at a scale (RGBA). */
  render(page: number, scale: number): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }>;
  pageSize(page: number): [number, number];
  save(changes: { key: number; alt: string | null }[]): Promise<void>;
}

export async function showAltTextDialog(d: AltDeps): Promise<void> {
  const figs = await d.figures();
  if (!figs.length) return;
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    const form = document.createElement("form");
    form.className = "modal alt-dialog";
    form.innerHTML = `<h2>Describe images</h2><p class="muted">Screen readers read this description aloud. Say what the image shows or why it matters, in a sentence. Tick Decorative for images that add nothing (borders, flourishes, background photos).</p><div class="alt-list"></div><div class="modal-buttons"><button type="button" data-a="cancel">Later</button><button type="submit" class="primary">Save</button></div>`;
    const list = form.querySelector(".alt-list")!;
    const rows: { f: FigureInfo; input: HTMLTextAreaElement; deco: HTMLInputElement }[] = [];
    const pageCache = new Map<number, Promise<HTMLCanvasElement>>();
    const pageCanvas = (page: number) => {
      let c = pageCache.get(page);
      if (!c) {
        const [w] = d.pageSize(page);
        const scale = Math.min(2, 900 / w);
        c = d.render(page, scale).then((r) => {
          const cv = document.createElement("canvas");
          cv.width = r.width;
          cv.height = r.height;
          cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height), 0, 0);
          cv.dataset.scale = String(scale);
          return cv;
        });
        pageCache.set(page, c);
      }
      return c;
    };
    figs.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "alt-row";
      const thumb = document.createElement("canvas");
      thumb.className = "alt-thumb";
      const right = document.createElement("div");
      right.className = "alt-fields";
      const label = Object.assign(document.createElement("div"), { className: "muted", textContent: `Image ${i + 1} · page ${f.page + 1}` });
      const input = Object.assign(document.createElement("textarea"), { rows: 2, value: f.alt, placeholder: "e.g. Bar chart: revenue rose from 4 to 6 million over 2026" });
      const decoLabel = document.createElement("label");
      decoLabel.className = "alt-deco";
      const deco = Object.assign(document.createElement("input"), { type: "checkbox" });
      deco.onchange = () => (input.disabled = deco.checked);
      decoLabel.append(deco, " Decorative (skip when reading)");
      right.append(label, input, decoLabel);
      row.append(thumb, right);
      list.append(row);
      rows.push({ f, input, deco });
      pageCanvas(f.page).then((cv) => {
        const s = Number(cv.dataset.scale);
        const [x0, y0, x1, y1] = f.rect.map((v) => v * s);
        const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        const k = Math.min(1, 140 / w, 100 / h);
        thumb.width = Math.round(w * k);
        thumb.height = Math.round(h * k);
        thumb.getContext("2d")!.drawImage(cv, x0, y0, w, h, 0, 0, thumb.width, thumb.height);
      });
    });
    back.append(form);
    document.body.append(back);
    rows[0]?.input.focus();
    const done = () => {
      back.remove();
      resolve();
    };
    form.querySelector<HTMLElement>('[data-a="cancel"]')!.onclick = done;
    back.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), done()));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const changes = rows
        .map((r) => ({ key: r.f.key, alt: r.deco.checked ? null : r.input.value.trim(), before: r.f.alt }))
        .filter((c) => c.alt === null || c.alt !== c.before)
        .map(({ key, alt }) => ({ key, alt }));
      if (changes.length) await d.save(changes);
      done();
    };
  });
}
