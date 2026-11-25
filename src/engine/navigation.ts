// Document navigation and extras: editable bookmarks, page links, attached files and layers.
import * as mupdf from "mupdf";

// ---------- Bookmarks ----------

export interface Bookmark {
  title: string;
  /** Target page (0-based), or null for a web link / no target. */
  page: number | null;
  /** Vertical position on the page (display points from the top), when known. */
  y?: number;
  /** External link (web address) instead of a page. */
  url?: string;
  open?: boolean;
  children: Bookmark[];
}

type RawItem = { title?: string; uri?: string; page?: number; open?: boolean; down?: RawItem[] };

export function getBookmarks(doc: mupdf.PDFDocument): Bookmark[] {
  let raw: RawItem[] = [];
  try {
    raw = (doc.loadOutline() ?? []) as RawItem[];
  } catch {
    return [];
  }
  const conv = (items: RawItem[]): Bookmark[] =>
    items.map((it) => {
      const b: Bookmark = { title: it.title ?? "", page: typeof it.page === "number" && it.page >= 0 ? it.page : null, open: !!it.open, children: it.down ? conv(it.down) : [] };
      if (it.uri && /^[a-z][a-z0-9+.-]*:/i.test(it.uri) && !it.uri.startsWith("#")) b.url = it.uri;
      else if (it.uri && b.page !== null) {
        try {
          const d = doc.resolveLinkDestination(it.uri);
          if (d && Number.isFinite(d.y) && (d.type === "XYZ" || d.type === "FitH" || d.type === "FitBH")) b.y = d.y;
        } catch { /* page only */ }
      }
      return b;
    });
  return conv(raw);
}

/** Replace the whole outline. */
export function setBookmarks(doc: mupdf.PDFDocument, list: Bookmark[]) {
  const it = doc.outlineIterator();
  // Clear: delete moves on to the next sibling, so keep deleting at the top level.
  for (let guard = 0; it.item() && guard < 100000; guard++) it.delete();
  const uriOf = (b: Bookmark) =>
    b.url ? b.url
    : b.page === null ? ""
    : doc.formatLinkURI(b.y !== undefined ? ({ type: "XYZ", page: b.page, x: 0, y: b.y, zoom: 0 } as never) : ({ type: "Fit", page: b.page } as never));
  const insertAll = (items: Bookmark[]) => {
    for (const b of items) {
      it.insert({ title: b.title || "Untitled", uri: uriOf(b), open: b.open ?? true });
      if (b.children.length) {
        // insert leaves the iterator after the new item: step back onto it and into its (empty) children.
        it.prev();
        it.down();
        insertAll(b.children);
        it.up();
        it.next();
      }
    }
  };
  insertAll(list);
}

// ---------- Links ----------

export interface PageLink {
  index: number;
  rect: number[];
  /** Internal target page, if it points inside the document. */
  page?: number;
  y?: number;
  url?: string;
}

export function getLinks(doc: mupdf.PDFDocument, pageIndex: number): PageLink[] {
  const page = doc.loadPage(pageIndex);
  try {
    return page.getLinks().map((l, index) => {
      const uri = l.getURI();
      const out: PageLink = { index, rect: Array.from(l.getBounds()) };
      if (l.isExternal()) out.url = uri;
      else {
        try {
          out.page = doc.resolveLink(uri);
          const d = doc.resolveLinkDestination(uri);
          if (Number.isFinite(d.y) && d.type === "XYZ") out.y = d.y;
        } catch { /* unresolved */ }
      }
      return out;
    });
  } finally {
    page.destroy();
  }
}

export type LinkTarget = { page: number; y?: number } | { url: string };
const targetUri = (doc: mupdf.PDFDocument, t: LinkTarget) =>
  "url" in t ? t.url : doc.formatLinkURI(t.y !== undefined ? ({ type: "XYZ", page: t.page, x: 0, y: t.y, zoom: 0 } as never) : ({ type: "Fit", page: t.page } as never));

export function addLink(doc: mupdf.PDFDocument, pageIndex: number, rect: number[], target: LinkTarget) {
  const page = doc.loadPage(pageIndex);
  try {
    page.createLink(rect as mupdf.Rect, targetUri(doc, target));
  } finally {
    page.destroy();
  }
}

export function updateLink(doc: mupdf.PDFDocument, pageIndex: number, index: number, target: LinkTarget) {
  const page = doc.loadPage(pageIndex);
  try {
    const l = page.getLinks()[index];
    if (!l) throw new Error("Link not found");
    l.setURI(targetUri(doc, target));
  } finally {
    page.destroy();
  }
}

export function deleteLink(doc: mupdf.PDFDocument, pageIndex: number, index: number) {
  const page = doc.loadPage(pageIndex);
  try {
    const l = page.getLinks()[index];
    if (!l) throw new Error("Link not found");
    page.deleteLink(l);
  } finally {
    page.destroy();
  }
}

// ---------- Attachments ----------

export interface Attachment { name: string; size: number | null; modified: string | null; description: string }

export function listAttachments(doc: mupdf.PDFDocument): Attachment[] {
  const files = doc.getEmbeddedFiles();
  return Object.entries(files).map(([name, spec]) => {
    const ef = spec.get("EF").get("F");
    const params = ef.get("Params");
    const size = params.get("Size");
    const mod = params.get("ModDate");
    const desc = spec.get("Desc");
    let modified: string | null = null;
    if (mod.isString()) {
      const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(mod.asString());
      if (m) modified = `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5] ?? "00"}` : ""}`;
    }
    let bytes: number | null = size.isNumber() ? size.asNumber() : null;
    if (bytes === null && ef.isStream()) {
      const len = ef.get("DL");
      if (len.isNumber()) bytes = len.asNumber();
    }
    return { name, size: bytes, modified, description: desc.isString() ? desc.asString() : "" };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const MIME: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", dwg: "image/vnd.dwg", dxf: "image/vnd.dxf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", zip: "application/zip", xml: "application/xml", json: "application/json" };

export function addAttachment(doc: mupdf.PDFDocument, name: string, data: Uint8Array, description = "") {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const now = new Date();
  // Same name replaces the old copy.
  if (name in doc.getEmbeddedFiles()) doc.deleteEmbeddedFile(name);
  // Built by hand: mupdf's addEmbeddedFile leaves an operation open, which breaks undo.
  const pdfDate = (d: Date) => `D:${d.getUTCFullYear()}${[d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("")}Z`;
  const params = doc.newDictionary();
  params.put("Size", doc.newInteger(data.length));
  params.put("CreationDate", doc.newString(pdfDate(now)));
  params.put("ModDate", doc.newString(pdfDate(now)));
  const sd = doc.newDictionary();
  sd.put("Type", doc.newName("EmbeddedFile"));
  sd.put("Subtype", doc.newName(MIME[ext] ?? "application/octet-stream"));
  sd.put("Params", params);
  const stream = doc.addStream(data, sd);
  const ef = doc.newDictionary();
  ef.put("F", stream);
  ef.put("UF", stream);
  const spec = doc.newDictionary();
  spec.put("Type", doc.newName("Filespec"));
  spec.put("F", doc.newString(name));
  spec.put("UF", doc.newString(name));
  spec.put("EF", ef);
  if (description) spec.put("Desc", doc.newString(description));
  doc.insertEmbeddedFile(name, doc.addObject(spec));
}

export function getAttachment(doc: mupdf.PDFDocument, name: string): Uint8Array {
  const spec = doc.getEmbeddedFiles()[name];
  if (!spec) throw new Error(`No attachment named ${name}`);
  const buf = doc.getEmbeddedFileContents(spec);
  if (!buf) throw new Error(`${name} has no contents`);
  return buf.asUint8Array().slice();
}

export function deleteAttachment(doc: mupdf.PDFDocument, name: string) {
  doc.deleteEmbeddedFile(name);
}

// ---------- Layers (optional content) ----------

export interface Layer { index: number; name: string; visible: boolean }

export function listLayers(doc: mupdf.PDFDocument): Layer[] {
  const n = doc.countLayers();
  return [...Array(n).keys()].map((index) => ({ index, name: doc.getLayerName(index) || `Layer ${index + 1}`, visible: doc.isLayerVisible(index) }));
}

export function setLayerVisible(doc: mupdf.PDFDocument, index: number, visible: boolean) {
  doc.setLayerVisible(index, visible);
}
