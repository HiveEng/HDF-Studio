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
  if (s) return s;
  const png = await createSignature();
  if (png) {
    let bin = "";
    png.forEach((b) => (bin += String.fromCharCode(b)));
    localStorage.setItem(KEY, btoa(bin));
  }
  return png;
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
        <input class="sig-file hidden" type="file" accept="image/png,image/jpeg" />
        <canvas width="560" height="180"></canvas>
        <small class="muted">Saved on this computer only. Click on a page to place it; drag a field's “Sign here” to sign forms.</small>
        <div class="modal-buttons"><button data-a="clear" type="button">Clear</button><button data-a="cancel" type="button">Cancel</button><button data-a="ok" class="primary" type="button">Use signature</button></div>
      </div>`;
    document.body.append(back);
    const canvas = back.querySelector("canvas")!;
    const ctx = canvas.getContext("2d")!;
    const typeBox = back.querySelector(".sig-type") as HTMLElement;
    const nameIn = typeBox.querySelector("input")!;
    const fontSel = typeBox.querySelector("select")!;
    const fileIn = back.querySelector(".sig-file") as HTMLInputElement;
    let mode = "draw";
    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drawTyped = () => {
      clear();
      ctx.fillStyle = "#0b2a6f";
      ctx.font = `64px ${fontSel.value}`;
      ctx.textBaseline = "middle";
      ctx.fillText(nameIn.value, 20, canvas.height / 2, canvas.width - 40);
    };
    back.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.m!;
        back.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("active", x === b));
        typeBox.classList.toggle("hidden", mode !== "type");
        fileIn.classList.toggle("hidden", mode !== "image");
        clear();
        if (mode === "type") nameIn.focus();
      };
    });
    nameIn.oninput = drawTyped;
    fontSel.onchange = drawTyped;
    fileIn.onchange = async () => {
      const f = fileIn.files?.[0];
      if (!f) return;
      const img = await createImageBitmap(f);
      clear();
      const s = Math.min(canvas.width / img.width, canvas.height / img.height);
      ctx.drawImage(img, (canvas.width - img.width * s) / 2, (canvas.height - img.height * s) / 2, img.width * s, img.height * s);
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
      ctx.lineWidth = 3;
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
    (back.querySelector('[data-a="clear"]') as HTMLElement).onclick = clear;
    (back.querySelector('[data-a="cancel"]') as HTMLElement).onclick = () => done(null);
    back.addEventListener("keydown", (e) => e.key === "Escape" && done(null));
    (back.querySelector('[data-a="ok"]') as HTMLElement).onclick = async () => {
      const trimmed = trim(canvas);
      if (!trimmed) return;
      const blob = await new Promise<Blob | null>((r) => trimmed.toBlob(r, "image/png"));
      done(blob ? new Uint8Array(await blob.arrayBuffer()) : null);
    };
  });
}

/** Crop to the drawn pixels plus a small margin; null if empty. */
function trim(c: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = c;
  const data = c.getContext("2d")!.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 10) {
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

/** Pixel size of a PNG (from its IHDR header). */
export function pngSize(png: Uint8Array): [number, number] {
  const v = new DataView(png.buffer, png.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
}
