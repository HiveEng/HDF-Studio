// Create, store and reuse a handwritten-style signature: draw it, type it, or import an image.
const KEY = "hdfstudio.signature";

export function savedSignature(): Uint8Array | null {
  const b64 = localStorage.getItem(KEY);
  return b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null;
}

export function clearSignature() {
  localStorage.removeItem(KEY);
}

/** Returns PNG bytes of the user's signature, asking them to create one if needed. */
export async function getSignature(forceNew = false): Promise<Uint8Array | null> {
  const s = !forceNew && savedSignature();
  if (s && !(await hasOpaqueCorners(s))) return s;
  // An opaque saved signature is a photo saved before backgrounds were removed: make a new one.
  const png = await createSignature();
  if (png) {
    let bin = "";
    png.forEach((b) => (bin += String.fromCharCode(b)));
    localStorage.setItem(KEY, btoa(bin));
  }
  return png;
}

async function hasOpaqueCorners(png: Uint8Array): Promise<boolean> {
  try {
    const img = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const a = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3];
    return [a(0, 0), a(img.width - 1, 0), a(0, img.height - 1), a(img.width - 1, img.height - 1)].every((v) => v > 250);
  } catch {
    return false;
  }
}

function createSignature(): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal sig">
        <h2>Your signature</h2>
        <div class="side-tabs"><button data-m="draw" class="active">Draw</button><button data-m="type">Type</button><button data-m="image">Image</button></div>
        <div class="sig-type hidden"><input placeholder="Type your name" /><select>
          <option value="'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive">Script</option>
          <option value="'Ink Free', 'Segoe Print', 'Comic Sans MS', cursive">Handwritten</option>
          <option value="Georgia, 'Times New Roman', serif">Formal</option></select></div>
        <div class="sig-image hidden"><input class="sig-file" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" />
          <label><input class="sig-bg" type="checkbox" checked /> Remove background (for photos and scans)</label>
          <small class="muted">Or paste an image (Ctrl+V), or drop one on the box below.</small></div>
        <div class="sig-error hidden"></div>
        <canvas width="1120" height="360"></canvas>
        <small class="muted">Saved on this computer only. Click on a page to place it; drag a field's “Sign here” to sign forms.</small>
        <div class="modal-buttons"><button data-a="clear" type="button">Clear</button><button data-a="cancel" type="button">Cancel</button><button data-a="ok" class="primary" type="button">Use signature</button></div>
      </div>`;
    document.body.append(back);
    const canvas = back.querySelector("canvas")!;
    const ctx = canvas.getContext("2d")!;
    const typeBox = back.querySelector(".sig-type") as HTMLElement;
    const nameIn = typeBox.querySelector("input")!;
    const fontSel = typeBox.querySelector("select")!;
    const imageBox = back.querySelector(".sig-image") as HTMLElement;
    const fileIn = back.querySelector(".sig-file") as HTMLInputElement;
    const bgIn = back.querySelector(".sig-bg") as HTMLInputElement;
    const errEl = back.querySelector(".sig-error") as HTMLElement;
    const showError = (msg: string | null) => {
      errEl.textContent = msg ?? "";
      errEl.classList.toggle("hidden", !msg);
    };
    /** Full-resolution result in image mode (the visible canvas only shows a preview). */
    let picture: ImageBitmap | null = null;
    let pictureOut: HTMLCanvasElement | null = null;
    let mode = "draw";
    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drawTyped = () => {
      clear();
      ctx.fillStyle = "#0b2a6f";
      ctx.font = `128px ${fontSel.value}`;
      ctx.textBaseline = "middle";
      ctx.fillText(nameIn.value, 40, canvas.height / 2, canvas.width - 80);
    };
    back.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.m!;
        back.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("active", x === b));
        typeBox.classList.toggle("hidden", mode !== "type");
        imageBox.classList.toggle("hidden", mode !== "image");
        showError(null);
        clear();
        if (mode === "image" && picture) renderPicture();
        if (mode === "type") nameIn.focus();
      };
    });
    nameIn.oninput = drawTyped;
    fontSel.onchange = drawTyped;
    const renderPicture = () => {
      if (!picture) return;
      pictureOut = bgIn.checked ? extractInk(picture) : toCanvas(picture);
      clear();
      const s = 0.9 * Math.min(canvas.width / pictureOut.width, canvas.height / pictureOut.height);
      const w = pictureOut.width * s, h = pictureOut.height * s;
      ctx.drawImage(pictureOut, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    };
    const loadPicture = async (f: Blob | null | undefined) => {
      if (!f) return;
      showError(null);
      try {
        picture = await createImageBitmap(f);
      } catch {
        picture = null;
        clear();
        showError(/heic|heif/i.test((f as File).name ?? f.type) ? "iPhone HEIC photos can't be read. Email the photo to yourself as a JPG, or take a screenshot of it, and use that." : "That image couldn't be read. Use a PNG or JPG.");
        return;
      }
      renderPicture();
    };
    fileIn.onchange = () => loadPicture(fileIn.files?.[0]);
    bgIn.onchange = renderPicture;
    const useImage = () => {
      if (mode !== "image") back.querySelector<HTMLButtonElement>('[data-m="image"]')!.click();
    };
    back.addEventListener("paste", (e) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      useImage();
      loadPicture(item.getAsFile());
    });
    canvas.ondragover = (e) => e.preventDefault();
    canvas.ondrop = (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith("image/") || /\.(heic|heif)$/i.test(x.name));
      if (!f) return;
      useImage();
      loadPicture(f);
    };
    // Drawing with pointer, smoothed with quadratic curves.
    let last: [number, number] | null = null;
    const pos = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
    };
    canvas.onpointerdown = (e) => {
      if (mode !== "draw") return;
      canvas.setPointerCapture(e.pointerId);
      last = pos(e);
    };
    canvas.onpointermove = (e) => {
      if (!last) return;
      const p = pos(e);
      ctx.strokeStyle = "#0b2a6f";
      ctx.lineWidth = 6;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(...last);
      ctx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2);
      ctx.lineTo(...p);
      ctx.stroke();
      last = p;
    };
    canvas.onpointerup = () => (last = null);

    const done = (v: Uint8Array | null) => (back.remove(), resolve(v));
    (back.querySelector('[data-a="clear"]') as HTMLElement).onclick = () => {
      clear();
      picture = pictureOut = null;
      fileIn.value = "";
    };
    (back.querySelector('[data-a="cancel"]') as HTMLElement).onclick = () => done(null);
    back.addEventListener("keydown", (e) => e.key === "Escape" && done(null));
    (back.querySelector('[data-a="ok"]') as HTMLElement).onclick = async () => {
      const trimmed = mode === "image" ? (pictureOut ? trim(pictureOut, 40) : null) : trim(canvas);
      if (!trimmed) return showError(mode === "image" ? (picture ? "No signature found in that image. Try turning off Remove background." : "Choose an image of your signature first.") : "Draw or type your signature first.");
      const blob = await new Promise<Blob | null>((r) => trimmed.toBlob(r, "image/png"));
      done(blob ? new Uint8Array(await blob.arrayBuffer()) : null);
    };
  });
}

/** Crop to the drawn pixels plus a small margin; null if empty. */
function trim(c: HTMLCanvasElement, minAlpha = 10): HTMLCanvasElement | null {
  const { width: w, height: h } = c;
  const data = c.getContext("2d")!.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > minAlpha) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m), y0 = Math.max(0, y0 - m), x1 = Math.min(w - 1, x1 + m), y1 = Math.min(h - 1, y1 + m);
  const out = Object.assign(document.createElement("canvas"), { width: x1 - x0 + 1, height: y1 - y0 + 1 });
  out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

const MAX_SIDE = 1800;
function toCanvas(img: ImageBitmap): HTMLCanvasElement {
  const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(img.width * s)), height: Math.max(1, Math.round(img.height * s)) });
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/**
 * Lift the ink off a photo or scan of a signature: paper becomes transparent, ink keeps its colour.
 * Handles uneven lighting by comparing each pixel with the local paper brightness.
 */
export function extractInk(img: ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  const c = img instanceof HTMLCanvasElement ? img : toCanvas(img);
  const ctx = c.getContext("2d")!;
  const im = ctx.getImageData(0, 0, c.width, c.height);
  inkMask(im.data, c.width, c.height);
  ctx.putImageData(im, 0, 0);
  return c;
}

/** In place on RGBA pixels. Exported for tests. */
export function inkMask(d: Uint8ClampedArray, w: number, h: number) {
  // Already transparent (a PNG cut-out)? Leave it alone.
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) clear++;
  if (clear > (w * h) / 20) return;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Local paper brightness: a high percentile per block, then smoothed between blocks.
  const B = Math.max(16, Math.round(Math.max(w, h) / 24));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const paper = new Float32Array(bw * bh);
  const vals: number[] = [];
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      vals.length = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) vals.push(lum[y * w + x]);
      vals.sort((a, b) => a - b);
      paper[by * bw + bx] = Math.max(1, vals[Math.floor(vals.length * 0.9)] ?? 255);
    }
  const paperAt = (x: number, y: number) => {
    const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5)), fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const top = paper[y0 * bw + x0] * (1 - tx) + paper[y0 * bw + x1] * tx;
    const bot = paper[y1 * bw + x0] * (1 - tx) + paper[y1 * bw + x1] * tx;
    return top * (1 - ty) + bot * ty;
  };
  // Darkness relative to the paper: 0 = paper, 1 = black.
  const dark = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = Math.max(0, Math.min(1, 1 - lum[i] / paperAt(x, y)));
      dark[i] = v;
      hist[Math.round(v * 255)]++;
    }
  // Otsu's threshold on darkness, kept in a sensible range for pen on paper.
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 64;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) (best = between), (t = i);
  }
  const thr = Math.min(0.45, Math.max(0.12, t / 255));
  const lo = thr * 0.6, hi = thr * 1.4;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, Math.min(1, (dark[i] - lo) / (hi - lo)));
    const k = i * 4;
    // Deepen the ink a little so a faint photo still prints crisply.
    d[k] = Math.round(d[k] * 0.55);
    d[k + 1] = Math.round(d[k + 1] * 0.55);
    d[k + 2] = Math.round(d[k + 2] * 0.55);
    d[k + 3] = Math.round(a * 255);
  }
}

/** Pixel size of a PNG (from its IHDR header). */
export function pngSize(png: Uint8Array): [number, number] {
  const v = new DataView(png.buffer, png.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
}
