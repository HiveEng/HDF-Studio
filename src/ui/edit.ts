// Edit tool: change existing text in place, add new text, and move/resize/replace/delete images.
import type { TextBlock, ImageBlock, TextStyle } from "../engine/edit";
import { ask } from "./dialog";

export interface EditDeps {
  engine: {
    textBlocks(id: number, page: number): Promise<TextBlock[]>;
    imageBlocks(id: number, page: number): Promise<ImageBlock[]>;
    replaceText(id: number, page: number, bbox: number[], text: string, style: TextStyle): Promise<void>;
    addText(id: number, page: number, at: [number, number], text: string, style: TextStyle): Promise<number[]>;
    moveImage(id: number, page: number, index: number, to: number[], replacement?: Uint8Array): Promise<void>;
    deleteImage(id: number, page: number, bbox: number[]): Promise<void>;
    insertImage(id: number, page: number, rect: number[], data: Uint8Array): Promise<void>;
    extractImage(id: number, page: number, index: number): Promise<Uint8Array>;
  };
  doc(): { info: { id: number; pageSizes: [number, number][] }; zoom: number } | null;
  pagesEl: HTMLElement;
  viewer: HTMLElement;
  refreshPage(i: number): void;
  changed(label: string): void;
  status(msg: string): void;
  pickImage(): Promise<Uint8Array | null>;
  saveBytes(name: string, data: Uint8Array): Promise<void>;
}

const CSS_FONT: Record<string, string> = { Helvetica: "Helvetica, Arial, sans-serif", Times: "'Times New Roman', Times, serif", Courier: "'Courier New', Courier, monospace" };
const SVGNS = "http://www.w3.org/2000/svg";

export function setupEdit(d: EditDeps) {
  const cache = new Map<number, { text: TextBlock[]; images: ImageBlock[] }>();
  let lastStyle: TextStyle = { font: "Helvetica", size: 12, color: [0, 0, 0] };
  let selectedImage: { page: number; img: ImageBlock } | null = null;
  let editor: HTMLTextAreaElement | null = null;
  const active = () => d.viewer.dataset.tool === "edit";

  async function blocks(page: number) {
    const doc = d.doc()!;
    let c = cache.get(page);
    if (!c) {
      const [text, images] = await Promise.all([d.engine.textBlocks(doc.info.id, page), d.engine.imageBlocks(doc.info.id, page)]);
      c = { text, images };
      cache.set(page, c);
    }
    return c;
  }
  function invalidate(page?: number) {
    if (page === undefined) cache.clear();
    else cache.delete(page);
  }

  const pageOf = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    return el && d.pagesEl.contains(el) ? { el, index: Number(el.dataset.page) } : null;
  };
  const pt = (el: HTMLElement, index: number, e: MouseEvent): [number, number] => {
    const r = el.getBoundingClientRect();
    const [w, h] = d.doc()!.info.pageSizes[index];
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h];
  };
  const inside = (p: number[], r: number[], pad = 0) => p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad;
  const overlay = (el: HTMLElement, index: number) => {
    let svg = el.querySelector("svg.edit-ov") as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.classList.add("ov", "edit-ov");
      const [w, h] = d.doc()!.info.pageSizes[index];
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("preserveAspectRatio", "none");
      el.append(svg);
    }
    return svg;
  };
  const rectEl = (r: number[], cls: string) => {
    const n = document.createElementNS(SVGNS, "rect");
    n.classList.add(cls);
    n.setAttribute("x", String(r[0]));
    n.setAttribute("y", String(r[1]));
    n.setAttribute("width", String(r[2] - r[0]));
    n.setAttribute("height", String(r[3] - r[1]));
    return n;
  };

  // Hover outlines show what can be edited.
  d.pagesEl.addEventListener("pointermove", async (e) => {
    if (!active() || editor || drag) return;
    const hit = pageOf(e);
    if (!hit || !d.doc()) return;
    const p = pt(hit.el, hit.index, e);
    const c = await blocks(hit.index);
    const svg = overlay(hit.el, hit.index);
    svg.querySelectorAll(".hover").forEach((n) => n.remove());
    const img = [...c.images].reverse().find((i) => inside(p, i.bbox));
    const tb = c.text.find((b) => inside(p, b.bbox, 2));
    if (img) svg.append(rectEl(img.bbox, "hover"));
    else if (tb) svg.append(rectEl(tb.bbox, "hover"));
    hit.el.style.cursor = img ? (nearCorner(p, img.bbox) ? "nwse-resize" : "move") : tb ? "text" : "copy";
  });

  const nearCorner = (p: number[], r: number[]) => Math.hypot(p[0] - r[2], p[1] - r[3]) < 10;

  let drag: null | { page: number; el: HTMLElement; img: ImageBlock; start: [number, number]; mode: "move" | "resize"; rect: number[] } = null;

  d.pagesEl.addEventListener("pointerdown", async (e) => {
    if (!active() || e.button !== 0) return;
    if (editor) return commitEditor();
    const hit = pageOf(e);
    const doc = d.doc();
    if (!hit || !doc) return;
    e.preventDefault();
    const p = pt(hit.el, hit.index, e);
    const c = await blocks(hit.index);
    const img = [...c.images].reverse().find((i) => inside(p, i.bbox));
    clearSelection();
    if (img) {
      selectedImage = { page: hit.index, img };
      overlay(hit.el, hit.index).append(rectEl(img.bbox, "selimg"));
      hit.el.setPointerCapture(e.pointerId);
      drag = { page: hit.index, el: hit.el, img, start: p, mode: nearCorner(p, img.bbox) ? "resize" : "move", rect: img.bbox.slice() };
      d.status("Image selected: drag to move, drag the corner to resize, Delete to remove, Ctrl+R to replace, Ctrl+Shift+S to save it.");
      return;
    }
    const tb = c.text.find((b) => inside(p, b.bbox, 2));
    openEditor(hit.el, hit.index, tb ?? null, tb ? null : p);
  });

  d.pagesEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = pt(drag.el, drag.page, e);
    const [x0, y0, x1, y1] = drag.img.bbox;
    if (drag.mode === "move") {
      const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
      drag.rect = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
    } else {
      // keep aspect ratio unless Shift is held
      let w = Math.max(10, p[0] - x0), h = Math.max(10, p[1] - y0);
      if (!e.shiftKey) {
        const ar = (x1 - x0) / (y1 - y0);
        if (w / h > ar) h = w / ar;
        else w = h * ar;
      }
      drag.rect = [x0, y0, x0 + w, y0 + h];
    }
    const svg = overlay(drag.el, drag.page);
    svg.querySelectorAll(".selimg").forEach((n) => n.remove());
    svg.append(rectEl(drag.rect, "selimg"));
  });

  d.pagesEl.addEventListener("pointerup", async () => {
    const cur = drag;
    drag = null;
    if (!cur) return;
    const moved = cur.rect.some((v, i) => Math.abs(v - cur.img.bbox[i]) > 1);
    if (!moved) return;
    const doc = d.doc()!;
    await d.engine.moveImage(doc.info.id, cur.page, cur.img.index, cur.rect);
    after(cur.page, cur.mode === "move" ? "Moved image" : "Resized image");
    const c = await blocks(cur.page);
    const img = c.images.find((i) => Math.abs(i.bbox[0] - cur.rect[0]) < 2 && Math.abs(i.bbox[1] - cur.rect[1]) < 2);
    if (img) {
      selectedImage = { page: cur.page, img };
      overlay(cur.el, cur.page).append(rectEl(img.bbox, "selimg"));
    }
  });

  function clearSelection() {
    selectedImage = null;
    d.pagesEl.querySelectorAll(".edit-ov .selimg").forEach((n) => n.remove());
  }

  function after(page: number, label: string) {
    invalidate(page);
    d.pagesEl.querySelectorAll(".edit-ov .hover").forEach((n) => n.remove());
    d.refreshPage(page);
    d.changed(label);
  }

  function openEditor(el: HTMLElement, page: number, block: TextBlock | null, at: [number, number] | null) {
    const doc = d.doc()!;
    const [pw, ph] = doc.info.pageSizes[page];
    const style = block ? block.style : lastStyle;
    const bbox = block ? block.bbox : [at![0], at![1] - style.size * 0.8, Math.min(pw - 36, at![0] + 240), at![1] + style.size * 1.4];
    const ta = document.createElement("textarea");
    ta.className = "text-editor";
    ta.value = block?.text ?? "";
    const family = style.font.split("-")[0];
    Object.assign(ta.style, {
      left: `${(bbox[0] / pw) * 100}%`,
      top: `${(bbox[1] / ph) * 100}%`,
      minWidth: `${((bbox[2] - bbox[0]) / pw) * 100}%`,
      width: `${((Math.max(bbox[2] - bbox[0], 60) + 8) / pw) * 100}%`,
      height: `${((bbox[3] - bbox[1] + 4) / ph) * 100}%`,
      fontFamily: CSS_FONT[family] ?? CSS_FONT.Helvetica,
      fontWeight: /Bold/.test(style.font) ? "bold" : "normal",
      fontStyle: /Italic|Oblique/.test(style.font) ? "italic" : "normal",
      fontSize: `calc(var(--z, 1) * ${style.size}px)`,
      lineHeight: style.lineHeight ? `calc(var(--z, 1) * ${style.lineHeight}px)` : "1.2",
      color: `rgb(${style.color.map((v) => Math.round(v * 255)).join(",")})`,
    });
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight + 2}px`;
    };
    ta.addEventListener("input", grow);
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closeEditor();
      else if (e.key === "Enter" && (e.ctrlKey || !block)) (e.preventDefault(), commitEditor());
    });
    ta.addEventListener("blur", () => setTimeout(() => editor === ta && commitEditor(), 100));
    (ta as HTMLTextAreaElement & { meta: unknown }).meta = { page, block, at, style };
    el.append(ta);
    editor = ta;
    ta.focus();
    grow();
    d.status(block ? "Editing text: Ctrl+Enter or click away to apply, Esc to cancel. Font is matched to the nearest standard font." : "Type new text: Enter to add, Esc to cancel.");
  }

  function closeEditor() {
    editor?.remove();
    editor = null;
  }

  async function commitEditor() {
    const ta = editor;
    if (!ta) return;
    editor = null;
    const { page, block, at, style } = (ta as HTMLTextAreaElement & { meta: { page: number; block: TextBlock | null; at: [number, number] | null; style: TextStyle } }).meta;
    const text = ta.value;
    ta.remove();
    const doc = d.doc();
    if (!doc) return;
    if (block) {
      if (text === block.text) return;
      await d.engine.replaceText(doc.info.id, page, block.bbox, text, style);
      after(page, "Edited text");
    } else if (text.trim()) {
      await d.engine.addText(doc.info.id, page, [at![0], at![1] - style.size * 0.8], text, style);
      after(page, "Added text");
    }
  }

  async function deleteSelectedImage() {
    if (!selectedImage) return false;
    const doc = d.doc()!;
    const { page, img } = selectedImage;
    clearSelection();
    await d.engine.deleteImage(doc.info.id, page, img.bbox);
    after(page, "Deleted image");
    return true;
  }

  async function replaceSelectedImage() {
    if (!selectedImage) return d.status("Select an image with the Edit tool first");
    const data = await d.pickImage();
    if (!data) return;
    const doc = d.doc()!;
    const { page, img } = selectedImage;
    clearSelection();
    await d.engine.moveImage(doc.info.id, page, img.index, img.bbox, data);
    after(page, "Replaced image");
  }

  async function saveSelectedImage() {
    if (!selectedImage) return d.status("Select an image with the Edit tool first");
    const doc = d.doc()!;
    await d.saveBytes(`image-p${selectedImage.page + 1}-${selectedImage.img.index + 1}.png`, await d.engine.extractImage(doc.info.id, selectedImage.page, selectedImage.img.index));
  }

  async function setTextStyle() {
    const r = await ask("Style for new text", [
      { name: "font", label: "Font", type: "select", value: lastStyle.font, options: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Times-Roman", "Times-Bold", "Times-Italic", "Courier", "Courier-Bold"].map((f) => [f, f]) },
      { name: "size", label: "Size (pt)", type: "number", value: String(lastStyle.size) },
      { name: "color", label: "Colour (hex)", value: "#" + lastStyle.color.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") },
    ], "Use");
    if (!r) return;
    const m = r.color.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    lastStyle = { font: r.font as TextStyle["font"], size: Math.max(4, Number(r.size) || 12), color: m ? ([1, 2, 3].map((i) => parseInt(m[i], 16) / 255) as [number, number, number]) : lastStyle.color };
  }

  document.addEventListener("keydown", async (e) => {
    if (!active() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selectedImage) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await deleteSelectedImage();
    }
  }, true);

  /** Insert an image: next click on a page places it. */
  let pendingImage: Uint8Array | null = null;
  async function insertImage() {
    pendingImage = await d.pickImage();
    if (pendingImage) d.status("Click on the page where the image should go.");
  }
  d.pagesEl.addEventListener("click", async (e) => {
    if (!pendingImage) return;
    const hit = pageOf(e);
    const doc = d.doc();
    if (!hit || !doc) return;
    const data = pendingImage;
    pendingImage = null;
    const p = pt(hit.el, hit.index, e);
    const v = new DataView(data.buffer, data.byteOffset);
    const isPng = data[0] === 0x89 && data[1] === 0x50;
    const [iw, ih] = isPng ? [v.getUint32(16), v.getUint32(20)] : await jpegSize(data);
    const w = Math.min(200, doc.info.pageSizes[hit.index][0] - 72), h = (w * ih) / iw;
    await d.engine.insertImage(doc.info.id, hit.index, [p[0], p[1], p[0] + w, p[1] + h], data);
    after(hit.index, "Inserted image");
  }, true);

  return { invalidate, deleteSelectedImage, replaceSelectedImage, saveSelectedImage, insertImage, setTextStyle, closeEditor };
}

async function jpegSize(data: Uint8Array): Promise<[number, number]> {
  const bmp = await createImageBitmap(new Blob([data as BlobPart]));
  return [bmp.width, bmp.height];
}
