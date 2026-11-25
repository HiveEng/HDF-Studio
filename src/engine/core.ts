// Engine core: thin, UI-agnostic wrapper over MuPDF (mupdf.js, AGPL-3.0).
// Runs in a Web Worker in the app and directly in Node for the CLI and tests.
import * as mupdf from "mupdf";

export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

export interface DocInfo {
  id: number;
  pageCount: number;
  /** Page sizes in PDF points (unscaled), [width, height]. */
  pageSizes: [number, number][];
  title: string | null;
  outline: OutlineNode[];
  needsPassword: boolean;
}

export interface RenderResult {
  width: number;
  height: number;
  /** RGBA pixels. */
  pixels: Uint8ClampedArray;
}

/** A hit is a list of quads (one per line the match spans), in PDF points. */
export type SearchHit = { page: number; quads: number[][]; snippet: string };

export class Engine {
  private docs = new Map<number, mupdf.Document>();
  private nextId = 1;

  open(data: Uint8Array, nameHint = "file.pdf"): DocInfo {
    const magic = nameHint.toLowerCase().split(".").pop() || "pdf";
    const doc = mupdf.Document.openDocument(data, magic);
    const id = this.nextId++;
    this.docs.set(id, doc);
    if (doc.needsPassword()) {
      return { id, pageCount: 0, pageSizes: [], title: null, outline: [], needsPassword: true };
    }
    return this.info(id);
  }

  unlock(id: number, password: string): DocInfo | null {
    const doc = this.get(id);
    return doc.authenticatePassword(password) ? this.info(id) : null;
  }

  info(id: number): DocInfo {
    const doc = this.get(id);
    const pageCount = doc.countPages();
    const pageSizes: [number, number][] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      pageSizes.push([x1 - x0, y1 - y0]);
      page.destroy();
    }
    let outline: OutlineNode[] = [];
    try {
      outline = convertOutline(doc.loadOutline() ?? []);
    } catch {
      /* some files have broken outlines; ignore */
    }
    return {
      id,
      pageCount,
      pageSizes,
      title: doc.getMetaData("info:Title") || null,
      outline,
      needsPassword: false,
    };
  }

  render(id: number, pageIndex: number, scale: number): RenderResult {
    const page = this.get(id).loadPage(pageIndex);
    try {
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, true);
      try {
        return { width: pix.getWidth(), height: pix.getHeight(), pixels: new Uint8ClampedArray(pix.getPixels()) };
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** Full-document search. Case-insensitive (MuPDF default). */
  search(id: number, needle: string): SearchHit[] {
    if (!needle) return [];
    const doc = this.get(id);
    const hits: SearchHit[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        const found = page.search(needle, "ignore-case,ignore-diacritics");
        if (!found.length) continue;
        const snippets = snippetsFor(page, needle);
        found.forEach((hit, k) => hits.push({ page: i, quads: hit.map((q) => Array.from(q)), snippet: snippets[k] ?? "" }));
      } finally {
        page.destroy();
      }
    }
    return hits;
  }

  pageText(id: number, pageIndex: number): string {
    const page = this.get(id).loadPage(pageIndex);
    try {
      const st = page.toStructuredText("preserve-whitespace");
      try {
        return st.asText();
      } finally {
        st.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  save(id: number, options = "garbage,compress"): Uint8Array {
    const doc = this.get(id).asPDF();
    if (!doc) throw new Error("Only PDF documents can be saved");
    const buf = doc.saveToBuffer(options);
    try {
      return new Uint8Array(buf.asUint8Array());
    } finally {
      buf.destroy();
    }
  }

  close(id: number): void {
    this.docs.get(id)?.destroy();
    this.docs.delete(id);
  }

  private get(id: number): mupdf.Document {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`No open document ${id}`);
    return doc;
  }
}

type RawOutline = { title?: string; page?: number; down?: RawOutline[] };

function convertOutline(items: RawOutline[]): OutlineNode[] {
  return items.map((it) => ({
    title: it.title ?? "",
    page: typeof it.page === "number" ? it.page : null,
    children: it.down ? convertOutline(it.down) : [],
  }));
}

/** Best-effort text context for each match on a page, in reading order. */
function snippetsFor(page: mupdf.Page, needle: string, radius = 40): string[] {
  const st = page.toStructuredText("");
  const text = st.asText().replace(/\s+/g, " ");
  st.destroy();
  const hay = text.toLowerCase(), n = needle.toLowerCase().replace(/\s+/g, " ");
  const out: string[] = [];
  for (let at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + n.length)) {
    const a = Math.max(0, at - radius), b = Math.min(text.length, at + n.length + radius);
    out.push((a > 0 ? "…" : "") + text.slice(a, b).trim() + (b < text.length ? "…" : ""));
  }
  return out;
}
