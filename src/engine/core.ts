// Engine core: thin, UI-agnostic wrapper over MuPDF (mupdf.js, AGPL-3.0).
// Runs in a Web Worker in the app and directly in Node for the CLI and tests.
import * as mupdf from "mupdf";
import { runRecipe, type Recipe } from "./recipes";
import { safeName } from "./util";
import * as annots from "./annotations";
import type { AnnotSpec, AnnotInfo, Pt, RGB } from "./annotations";
import * as redact from "./redact";
import * as forms from "./forms";
import * as digisign from "./digisign";
export { safeName };

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
  /** Bytes as opened, for signature validation (signatures cover the file as it was signed). */
  private originals = new Map<number, Uint8Array>();
  private nextId = 1;

  open(data: Uint8Array, nameHint = "file.pdf"): DocInfo {
    const magic = nameHint.toLowerCase().split(".").pop() || "pdf";
    const doc = mupdf.Document.openDocument(data, magic);
    try {
      doc.asPDF()?.enableJournal(); // MuPDF's own undo/redo history
    } catch { /* non-PDF documents have no journal */ }
    const id = this.nextId++;
    this.docs.set(id, doc);
    this.originals.set(id, data);
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
    this.dropTextCache(id); // info() is called after every structural change
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

  // ---------- Organize & combine (mutating ops return fresh DocInfo) ----------

  /** Keep/reorder/duplicate pages: `order` lists 0-based source pages in their new order. */
  rearrange(id: number, order: number[]): DocInfo {
    return this.op(id, "Reorder pages", () => {
      if (!order.length) throw new Error("A document needs at least one page");
      this.pdf(id).rearrangePages(order);
      return this.info(id);
    });
  }

  deletePages(id: number, pages: number[]): DocInfo {
    return this.op(id, "Delete pages", () => {
      const drop = new Set(pages);
      const n = this.get(id).countPages();
      return this.rearrange(id, [...Array(n).keys()].filter((i) => !drop.has(i)));
    });
  }

  /** Move `pages` (in their current order) so they start at position `to` of the result. */
  movePages(id: number, pages: number[], to: number): DocInfo {
    return this.op(id, "Move pages", () => {
      const moving = new Set(pages);
      const n = this.get(id).countPages();
      const rest = [...Array(n).keys()].filter((i) => !moving.has(i));
      const sorted = [...moving].sort((a, b) => a - b);
      const before = [...Array(Math.min(to, n)).keys()].filter((i) => !moving.has(i)).length;
      rest.splice(before, 0, ...sorted);
      return this.rearrange(id, rest);
    });
  }

  reversePages(id: number): DocInfo {
    return this.op(id, "Reverse pages", () => {
      const n = this.get(id).countPages();
      return this.rearrange(id, [...Array(n).keys()].reverse());
    });
  }

  /** Rotate pages by a multiple of 90 degrees (clockwise). */
  rotatePages(id: number, pages: number[], degrees: number): DocInfo {
    return this.op(id, "Rotate pages", () => {
      const doc = this.pdf(id);
      for (const i of pages) {
        const obj = doc.findPage(i);
        const cur = obj.getInheritable("Rotate");
        const now = cur.isNull() ? 0 : cur.asNumber();
        obj.put("Rotate", (((now + degrees) % 360) + 360) % 360);
      }
      return this.info(id);
    });
  }

  /** Insert a blank page at `at` (0-based), sized like page `likePage` or US Letter. */
  insertBlank(id: number, at: number, likePage?: number): DocInfo {
    return this.op(id, "Insert blank page", () => {
      const doc = this.pdf(id);
      let box: [number, number, number, number] = [0, 0, 612, 792];
      if (likePage !== undefined && likePage < doc.countPages()) {
        const p = doc.loadPage(likePage);
        box = p.getBounds() as typeof box;
        p.destroy();
      }
      doc.insertPage(at, doc.addPage(box, 0, {}, ""));
      return this.info(id);
    });
  }

  /** Copy pages from another open document into this one at position `at` (-1 = end). */
  insertFrom(id: number, at: number, srcId: number, pages?: number[]): DocInfo {
    return this.op(id, "Insert pages", () => {
      const dst = this.pdf(id);
      const src = this.pdf(srcId);
      const list = pages ?? [...Array(src.countPages()).keys()];
      const map = dst.newGraftMap();
      let pos = at < 0 ? dst.countPages() : at;
      for (const p of list) map.graftPage(pos++, src, p);
      return this.info(id);
    });
  }

  /** Build a new PDF from page selections across open documents. Adds a bookmark per part. */
  combine(parts: { id: number; pages?: number[]; title?: string }[]): Uint8Array {
    const out = new mupdf.PDFDocument();
    const bookmarks: { title: string; page: number }[] = [];
    for (const part of parts) {
      const src = this.pdf(part.id);
      const list = part.pages ?? [...Array(src.countPages()).keys()];
      const map = out.newGraftMap();
      if (part.title) bookmarks.push({ title: part.title, page: out.countPages() });
      for (const p of list) map.graftPage(-1, src, p);
    }
    if (bookmarks.length > 1) {
      const it = out.outlineIterator();
      for (const b of bookmarks) {
        it.insert({ title: b.title, uri: out.formatLinkURI({ page: b.page, type: "Fit" } as never), open: true });
      }
    }
    return saveAndDestroy(out);
  }

  /** New PDF containing just the given pages. */
  extract(id: number, pages: number[]): Uint8Array {
    return this.combine([{ id, pages }]);
  }

  /**
   * Split into several PDFs. Modes: every N pages, explicit groups of ranges, or by top-level bookmarks.
   * Returns parts with a suggested name suffix.
   */
  split(id: number, mode: { every: number } | { groups: number[][] } | { bookmarks: true }): { suffix: string; data: Uint8Array }[] {
    const n = this.get(id).countPages();
    let groups: { suffix: string; pages: number[] }[] = [];
    if ("every" in mode) {
      const k = Math.max(1, Math.floor(mode.every));
      for (let a = 0; a < n; a += k) {
        const pages = [...Array(Math.min(k, n - a)).keys()].map((i) => i + a);
        groups.push({ suffix: pages.length > 1 ? `p${a + 1}-${a + pages.length}` : `p${a + 1}`, pages });
      }
    } else if ("groups" in mode) {
      groups = mode.groups.map((pages, i) => ({ suffix: `part${i + 1}`, pages }));
    } else {
      const top = this.info(id).outline.filter((o) => o.page !== null);
      if (!top.length) throw new Error("This document has no bookmarks to split by");
      top.sort((a, b) => a.page! - b.page!);
      if (top[0].page! > 0) top.unshift({ title: "Front matter", page: 0, children: [] });
      top.forEach((o, i) => {
        const end = i + 1 < top.length ? top[i + 1].page! : n;
        if (end > o.page!) groups.push({ suffix: safeName(o.title) || `part${i + 1}`, pages: [...Array(end - o.page!).keys()].map((k) => k + o.page!) });
      });
    }
    return groups.map((g) => ({ suffix: g.suffix, data: this.extract(id, g.pages) }));
  }

  /** Small rendered preview of a page, sized to fit `maxPx` on its longest side. */
  thumbnail(id: number, pageIndex: number, maxPx = 160): RenderResult {
    const [w, h] = this.info(id).pageSizes[pageIndex];
    return this.render(id, pageIndex, maxPx / Math.max(w, h));
  }

  /** Replace an open document's contents in place (used by undo/redo). */
  replace(id: number, data: Uint8Array): DocInfo {
    this.dropTextCache(id);
    this.get(id).destroy();
    const doc = mupdf.Document.openDocument(data, "pdf");
    doc.asPDF()?.enableJournal();
    this.docs.set(id, doc);
    this.originals.set(id, data);
    return this.info(id);
  }

  /** Fast full copy of the current state for undo (no garbage collection or compression). */
  snapshot(id: number): Uint8Array {
    return this.save(id, "");
  }

  /** Run a batch recipe on raw file bytes (no open document needed). */
  runRecipe(data: Uint8Array, fileName: string, recipe: Recipe, ctx?: { batesOffset?: number; password?: string }) {
    return runRecipe(data, fileName, recipe, ctx);
  }

  // ---------- Comments & markup ----------
  private stext = new Map<string, mupdf.StructuredText>();

  private pageText_(id: number, pageIndex: number): mupdf.StructuredText {
    const k = `${id}:${pageIndex}`;
    let st = this.stext.get(k);
    if (!st) {
      const page = this.get(id).loadPage(pageIndex);
      st = page.toStructuredText("preserve-whitespace");
      page.destroy();
      this.stext.set(k, st);
    }
    return st;
  }

  private dropTextCache(id: number) {
    for (const [k, st] of this.stext) if (k.startsWith(`${id}:`)) (st.destroy(), this.stext.delete(k));
  }

  /** Text selection between two points: quads to draw and the selected text. */
  selectText(id: number, pageIndex: number, a: Pt, b: Pt, mode: "chars" | "words" | "lines" = "chars"): { quads: number[][]; text: string } {
    const st = this.pageText_(id, pageIndex);
    if (mode !== "chars") {
      const q = st.snap(a, b, mode);
      a = [q[0], (q[1] + q[5]) / 2];
      b = [q[6], (q[3] + q[7]) / 2];
    }
    return { quads: st.highlight(a, b).map((q) => Array.from(q)), text: st.copy(a, b) };
  }

  annotations(id: number, pageIndex: number): AnnotInfo[] {
    return annots.listAnnotations(this.pdf(id), pageIndex);
  }

  allAnnotations(id: number): AnnotInfo[] {
    const doc = this.pdf(id);
    const out: AnnotInfo[] = [];
    for (let i = 0; i < doc.countPages(); i++) out.push(...annots.listAnnotations(doc, i));
    return out;
  }

  addAnnotation(id: number, pageIndex: number, spec: AnnotSpec, author: string): number {
    return this.op(id, "Add comment", () => {
      return annots.addAnnotation(this.pdf(id), pageIndex, spec, author);
    });
  }

  updateAnnotation(id: number, pageIndex: number, key: number, patch: { contents?: string; color?: RGB; rect?: number[] }): void {
    return this.op(id, "Edit comment", () => {
      annots.updateAnnotation(this.pdf(id), pageIndex, key, patch);
    });
  }

  deleteAnnotation(id: number, pageIndex: number, key: number): void {
    return this.op(id, "Delete comment", () => {
      annots.deleteAnnotation(this.pdf(id), pageIndex, key);
    });
  }

  annotationAt(id: number, pageIndex: number, p: Pt): AnnotInfo | null {
    return annots.annotationAt(this.pdf(id), pageIndex, p);
  }

  exportXfdf(id: number, fileName: string): string {
    return annots.exportXfdf(this.pdf(id), fileName);
  }

  commentSummary(id: number): string {
    return annots.summarizeComments(this.pdf(id));
  }

  // ---------- Redaction & security ----------

  markRedactions(id: number, o: redact.FindRedactOptions): number {
    return this.op(id, "Mark for redaction", () => redact.markMatches(this.pdf(id), o));
  }

  redactionCount(id: number): number {
    return redact.countMarks(this.pdf(id));
  }

  applyRedactions(id: number, o?: redact.ApplyOptions): DocInfo & { pagesChanged: number } {
    return this.op(id, "Apply redactions", () => {
      const pagesChanged = redact.applyRedactions(this.pdf(id), o);
      return { ...this.info(id), pagesChanged };
    });
  }

  sanitize(id: number, opts?: { removeComments?: boolean }): redact.SanitizeReport {
    return this.op(id, "Sanitize", () => redact.sanitize(this.pdf(id), opts));
  }

  /** Is the open document encrypted (so saving should keep or remove protection)? */
  isEncrypted(id: number): boolean {
    const t = this.pdf(id).getTrailer();
    return !t.get("Encrypt").isNull();
  }

  // ---------- Forms & signatures ----------

  fields(id: number): forms.FieldInfo[] {
    const doc = this.get(id).asPDF();
    return doc ? forms.listFields(doc) : [];
  }

  setField(id: number, pageIndex: number, key: number, value: string): forms.FieldInfo[] {
    return this.op(id, "Fill field", () => {
      forms.setField(this.pdf(id), pageIndex, key, value);
      return forms.listFields(this.pdf(id));
    });
  }

  fillForm(id: number, data: Record<string, string>) {
    return this.op(id, "Fill form", () => forms.fillByName(this.pdf(id), data));
  }

  formData(id: number): Record<string, string> {
    return forms.formData(this.pdf(id));
  }

  clearForm(id: number): void {
    this.op(id, "Clear form", () => forms.clearForm(this.pdf(id)));
  }

  /** Burn comments and/or form fields into the page content so they can't be changed. */
  flatten(id: number, comments = true, fields = true): DocInfo {
    return this.op(id, "Flatten", () => {
      this.pdf(id).bake(comments, fields);
      return this.info(id);
    });
  }

  mailMerge(template: Uint8Array, csv: string, o?: { name?: string; flatten?: boolean }) {
    return forms.mailMerge(template, forms.parseCsv(csv), o);
  }

  placeImage(id: number, pageIndex: number, rect: number[], png: Uint8Array, label?: string): number {
    return this.op(id, "Place signature", () => forms.placeImage(this.pdf(id), pageIndex, rect, png, label));
  }

  // ---------- Digital signatures ----------

  hasSignatures(id: number): boolean {
    const o = this.originals.get(id);
    return !!o && /\/ByteRange\s*\[/.test(new TextDecoder("latin1").decode(o));
  }

  verifySignatures(id: number): digisign.SignatureCheck[] {
    const o = this.originals.get(id);
    return o ? digisign.verifySignatures(o) : [];
  }

  /** Sign the document's current state; returns the signed file bytes (write them as-is) and reloads it. */
  signDigital(id: number, o: digisign.SignOptions): { data: Uint8Array; info: DocInfo } {
    const current = this.save(id, this.hasSignatures(id) ? "incremental" : "garbage,compress");
    const data = digisign.signPdf(current, o);
    return { data, info: this.replace(id, data) };
  }

  certificateInfo(p12: Uint8Array, password: string): digisign.Signer {
    return digisign.readP12(p12, password).signer;
  }

  makeCertificate(name: string, password: string, email?: string): Uint8Array {
    return digisign.makeSelfSignedP12(name, password, email);
  }

  close(id: number): void {
    this.dropTextCache(id);
    this.docs.get(id)?.destroy();
    this.docs.delete(id);
    this.originals.delete(id);
  }

  private depth = 0;
  /** Group changes into one undoable step (nested calls join the outer step). */
  private op<T>(id: number, name: string, fn: () => T): T {
    const doc = this.pdf(id);
    if (this.depth++ === 0) doc.beginOperation(name);
    try {
      const r = fn();
      if (this.depth === 1) doc.endOperation();
      return r;
    } catch (e) {
      if (this.depth === 1) doc.abandonOperation();
      throw e;
    } finally {
      this.depth--;
    }
  }

  undo(id: number): DocInfo | null {
    const doc = this.pdf(id);
    if (!doc.canUndo()) return null;
    doc.undo();
    return this.info(id);
  }

  redo(id: number): DocInfo | null {
    const doc = this.pdf(id);
    if (!doc.canRedo()) return null;
    doc.redo();
    return this.info(id);
  }

  history(id: number): { canUndo: boolean; canRedo: boolean; steps: string[]; position: number } {
    const doc = this.pdf(id);
    const j = doc.getJournal() as { position: number; steps: string[] };
    return { canUndo: doc.canUndo(), canRedo: doc.canRedo(), steps: j.steps, position: j.position };
  }

  private pdf(id: number): mupdf.PDFDocument {
    const doc = this.get(id).asPDF();
    if (!doc) throw new Error("This operation needs a PDF (convert the document to PDF first)");
    return doc;
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

function saveAndDestroy(doc: mupdf.PDFDocument, options = "garbage,compress"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return new Uint8Array(buf.asUint8Array());
  } finally {
    buf.destroy();
    doc.destroy();
  }
}
