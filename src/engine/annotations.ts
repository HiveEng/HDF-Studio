// Comments & markup on top of MuPDF annotations. All coordinates are page space in points
// (origin top-left, y down, after page rotation) — the same space as search results.
import * as mupdf from "mupdf";

export type Pt = [number, number];
export type RGB = [number, number, number];

export type AnnotSpec =
  | { type: "Highlight" | "Underline" | "StrikeOut" | "Squiggly"; quads: number[][]; color?: RGB; contents?: string }
  | { type: "Text"; at: Pt; contents: string; color?: RGB; icon?: string }
  | { type: "FreeText"; rect: number[]; contents: string; fontSize?: number; color?: RGB }
  | { type: "Square" | "Circle"; rect: number[]; color?: RGB; fill?: RGB | null; width?: number; contents?: string }
  | { type: "Line"; a: Pt; b: Pt; arrow?: boolean; color?: RGB; width?: number; contents?: string }
  | { type: "Ink"; strokes: Pt[][]; color?: RGB; width?: number; contents?: string }
  | { type: "Stamp"; rect: number[]; label: string; color?: RGB }
  | { type: "Redact"; quads?: number[][]; rect?: number[] };

export interface AnnotInfo {
  /** Stable key: PDF object number of the annotation. */
  key: number;
  page: number;
  type: string;
  rect: number[];
  contents: string;
  author: string;
  modified: string | null;
  color: number[];
  quads?: number[][];
  /** Key of the comment this one replies to. */
  inReplyTo?: number;
  /** Review status set by this reply (Accepted, Rejected, Cancelled, Completed, None). */
  state?: string;
  /** Unique name (/NM), used to recognise the same comment in other copies of the file. */
  name?: string;
  hidden?: boolean;
}

export const REVIEW_STATES = ["Accepted", "Rejected", "Cancelled", "Completed", "None"] as const;

const DEFAULT_COLORS: Record<string, RGB> = {
  Highlight: [1, 0.85, 0],
  Underline: [0, 0.45, 0.9],
  StrikeOut: [0.85, 0.1, 0.1],
  Squiggly: [0.1, 0.6, 0.2],
  Text: [1, 0.8, 0],
  FreeText: [0, 0, 0],
  Square: [0.85, 0.1, 0.1],
  Circle: [0.85, 0.1, 0.1],
  Line: [0.85, 0.1, 0.1],
  Ink: [0.1, 0.3, 0.9],
  Stamp: [0.1, 0.5, 0.2],
};

const keyOf = (a: mupdf.PDFAnnotation) => a.getObject().asIndirect();

export function listAnnotations(doc: mupdf.PDFDocument, pageIndex: number): AnnotInfo[] {
  const page = doc.loadPage(pageIndex);
  try {
    return page
      .getAnnotations()
      .filter((a) => a.getType() !== "Popup" && a.getType() !== "Link")
      .map((a) => {
        let modified: string | null = null;
        try {
          const d = a.getModificationDate();
          modified = d && !isNaN(d.getTime()) ? d.toISOString() : null;
        } catch { /* no date */ }
        return {
          key: keyOf(a),
          page: pageIndex,
          type: a.getType(),
          rect: Array.from(a.getBounds()),
          contents: a.getContents() ?? "",
          author: a.hasAuthor() ? a.getAuthor() ?? "" : "",
          modified,
          color: Array.from(a.getColor()),
          quads: a.hasQuadPoints() ? a.getQuadPoints().map((q) => Array.from(q)) : undefined,
          ...threadInfo(a),
        };
      });
  } finally {
    page.destroy();
  }
}

export function addAnnotation(doc: mupdf.PDFDocument, pageIndex: number, spec: AnnotSpec, author: string): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = page.createAnnotation(spec.type);
    const color = ("color" in spec && spec.color) || DEFAULT_COLORS[spec.type];
    // For FreeText, /C is the box background; the text colour goes in the default appearance instead.
    if (color && spec.type !== "Redact" && spec.type !== "FreeText") a.setColor(color);
    switch (spec.type) {
      case "Highlight":
      case "Underline":
      case "StrikeOut":
      case "Squiggly":
        a.setQuadPoints(spec.quads as mupdf.Quad[]);
        if (spec.type === "Highlight") a.setOpacity(1);
        break;
      case "Text":
        a.setRect([spec.at[0], spec.at[1], spec.at[0] + 20, spec.at[1] + 20]);
        if (spec.icon) a.setIcon(spec.icon);
        break;
      case "FreeText":
        a.setRect(spec.rect as mupdf.Rect);
        a.setDefaultAppearance("Helv", spec.fontSize ?? 12, color ?? [0, 0, 0]);
        break;
      case "Square":
      case "Circle":
        a.setRect(spec.rect as mupdf.Rect);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.fill) a.setInteriorColor(spec.fill);
        break;
      case "Line":
        a.setLine(spec.a, spec.b);
        a.setBorderWidth(spec.width ?? 2);
        if (spec.arrow) a.setLineEndingStyles("None", "ClosedArrow");
        break;
      case "Ink":
        a.setInkList(spec.strokes);
        a.setBorderWidth(spec.width ?? 2);
        break;
      case "Stamp":
        a.setRect(spec.rect as mupdf.Rect);
        a.setIcon(spec.label);
        break;
      case "Redact":
        if (spec.quads?.length) a.setQuadPoints(spec.quads as mupdf.Quad[]);
        if (spec.rect) a.setRect(spec.rect as mupdf.Rect);
        else if (spec.quads?.length) a.setRect(boundsOfQuads(spec.quads) as mupdf.Rect);
        break;
    }
    if ("contents" in spec && spec.contents) a.setContents(spec.contents);
    if (spec.type !== "Redact" && spec.type !== "Stamp") a.setAuthor(author);
    const now = new Date();
    a.setCreationDate?.(now);
    a.setModificationDate(now);
    a.update();
    return keyOf(a);
  } finally {
    page.destroy();
  }
}

function threadInfo(a: mupdf.PDFAnnotation): Pick<AnnotInfo, "inReplyTo" | "state" | "name" | "hidden"> {
  const o = a.getObject();
  const irt = o.get("IRT");
  const st = o.get("State");
  const nm = o.get("NM");
  const f = o.get("F");
  return {
    inReplyTo: irt.isIndirect() ? irt.asIndirect() : undefined,
    state: st.isString() ? st.asString() : undefined,
    name: nm.isString() ? nm.asString() : undefined,
    hidden: f.isNumber() ? (f.asNumber() & 2) !== 0 : false,
  };
}

const newName = () => `hdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Reply to a comment, optionally setting its review status. Replies are hidden on the page; they show in the Comments panel. */
export function addReply(doc: mupdf.PDFDocument, pageIndex: number, parentKey: number, text: string, author: string, state?: string): number {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const parent = findAnnot(page, parentKey);
    const [x0, y0] = parent.getBounds();
    const a = page.createAnnotation("Text");
    a.setRect([x0, y0, x0 + 20, y0 + 20]);
    a.setContents(text);
    a.setAuthor(author);
    a.setModificationDate(new Date());
    const o = a.getObject();
    o.put("IRT", parent.getObject());
    o.put("NM", doc.newString(newName()));
    o.put("F", 2 | 4 | 8 | 16); // hidden, print, no zoom, no rotate
    if (state) {
      o.put("State", doc.newString(state));
      o.put("StateModel", doc.newString("Review"));
    }
    a.update();
    return keyOf(a);
  } finally {
    page.destroy();
  }
}

/** Give every comment a unique name so copies of the file can be merged without duplicates. */
export function ensureNames(doc: mupdf.PDFDocument) {
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const o = annots.get(k);
      if (o.get("NM").isNull() && o.get("Subtype").asName() !== "Link") o.put("NM", doc.newString(newName()));
    }
  }
}

/** Identities of a comment across copies: its /NM (if any) and type + position + text. */
function identities(o: mupdf.PDFObject): string[] {
  const nm = o.get("NM");
  const r = o.get("Rect");
  const rect = r.isArray() ? [0, 1, 2, 3].map((i) => Math.round(r.get(i).asNumber())).join(",") : "";
  const c = o.get("Contents");
  const shape = `${o.get("Subtype").asName()}|${rect}|${c.isString() ? c.asString() : ""}`;
  return nm.isString() ? ["nm:" + nm.asString(), shape] : [shape];
}

/**
 * Copy comments from another copy of the same document (e.g. returned by a reviewer) that this
 * one doesn't have yet. Replies keep their threads. Returns how many were added, by author.
 */
export function mergeAnnotations(doc: mupdf.PDFDocument, src: mupdf.PDFDocument): { added: number; authors: Record<string, number> } {
  const map = doc.newGraftMap();
  const authors: Record<string, number> = {};
  let added = 0;
  const same = new Map<number, mupdf.PDFObject>(); // reviewer's object number -> our comment
  const n = Math.min(doc.countPages(), src.countPages());
  for (let i = 0; i < n; i++) {
    const sa = (src.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!sa.isArray() || !sa.length) continue;
    const pageObj = doc.findPage(i) as mupdf.PDFObject;
    let da = pageObj.get("Annots");
    const have = new Map<string, mupdf.PDFObject>();
    if (da.isArray()) {
      for (let k = 0; k < da.length; k++) for (const x of identities(da.get(k))) if (!have.has(x)) have.set(x, da.get(k));
    } else {
      da = doc.newArray();
      pageObj.put("Annots", da);
    }
    const pending: [mupdf.PDFObject, mupdf.PDFObject][] = [];
    for (let k = 0; k < sa.length; k++) {
      const o = sa.get(k);
      const sub = o.get("Subtype").asName();
      if (sub === "Popup" || sub === "Link" || sub === "Widget") continue;
      const ids = identities(o);
      const match = ids.map((x) => have.get(x)).find(Boolean);
      if (match) {
        same.set(o.asIndirect(), match);
        continue;
      }
      // Copy key by key so /P, /Popup and /IRT don't drag the reviewer's page tree along.
      const copy = doc.newDictionary();
      o.forEach((v, key) => {
        if (key === "P" || key === "Popup" || key === "IRT" || key === "Parent") return;
        copy.put(key, map.graftObject(v));
      });
      copy.put("P", pageObj);
      const ref = doc.addObject(copy);
      da.push(ref);
      for (const x of ids) have.set(x, ref);
      same.set(o.asIndirect(), ref);
      if (o.get("IRT").isIndirect()) pending.push([ref, o.get("IRT")]);
      added++;
      const t = o.get("T");
      const who = t.isString() ? t.asString() : "Unknown";
      authors[who] = (authors[who] ?? 0) + 1;
    }
    for (const [ref, irt] of pending) {
      const parent = same.get(irt.asIndirect());
      if (parent) ref.put("IRT", parent);
    }
  }
  return { added, authors };
}

function findAnnot(page: mupdf.PDFPage, key: number) {
  const a = page.getAnnotations().find((x) => keyOf(x) === key);
  if (!a) throw new Error("Comment not found (it may have been deleted)");
  return a;
}

export function updateAnnotation(doc: mupdf.PDFDocument, pageIndex: number, key: number, patch: { contents?: string; color?: RGB; rect?: number[] }) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    const a = findAnnot(page, key);
    if (patch.contents !== undefined) a.setContents(patch.contents);
    if (patch.color) a.setColor(patch.color);
    if (patch.rect) a.setRect(patch.rect as mupdf.Rect);
    a.setModificationDate(new Date());
    a.update();
  } finally {
    page.destroy();
  }
}

export function deleteAnnotation(doc: mupdf.PDFDocument, pageIndex: number, key: number) {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
  try {
    page.deleteAnnotation(findAnnot(page, key));
  } finally {
    page.destroy();
  }
}

/** Topmost annotation under a point, if any. */
export function annotationAt(doc: mupdf.PDFDocument, pageIndex: number, p: Pt): AnnotInfo | null {
  const all = listAnnotations(doc, pageIndex).filter((a) => !a.hidden);
  for (let i = all.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = all[i].rect;
    if (p[0] >= x0 - 2 && p[0] <= x1 + 2 && p[1] >= y0 - 2 && p[1] <= y1 + 2) return all[i];
  }
  return null;
}

export function boundsOfQuads(quads: number[][]): number[] {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ---------- XFDF export/import (exchange comments with other PDF apps) ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

/** Export markup and notes to XFDF. Coordinates are converted to PDF user space as XFDF requires. */
export function exportXfdf(doc: mupdf.PDFDocument, fileName: string): string {
  const out: string[] = [];
  const names = new Map<number, string>();
  for (let i = 0; i < doc.countPages(); i++) for (const a of listAnnotations(doc, i)) if (a.name) names.set(a.key, a.name);
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    const toUser = mupdf.Matrix.invert(page.getTransform());
    const tp = (x: number, y: number) => {
      const [a, b, c, d, e, f] = toUser;
      return [x * a + y * c + e, x * b + y * d + f];
    };
    const rectUser = (r: number[]) => {
      const p = [tp(r[0], r[1]), tp(r[2], r[3])];
      return [Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])].map((v) => +v.toFixed(2)).join(",");
    };
    const byKey = new Map(page.getAnnotations().map((x) => [keyOf(x), x] as const));
    for (const a of listAnnotations(doc, i)) {
      const tag = { Text: "text", Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly", FreeText: "freetext", Square: "square", Circle: "circle", Line: "line", Ink: "ink", Stamp: "stamp" }[a.type];
      if (!tag) continue;
      const nameOf = (k: number) => names.get(k) ?? `hdfstudio-${k}`;
      let attrs = `page="${i}" rect="${rectUser(a.rect)}" color="${hex(a.color.length === 3 ? a.color : [0, 0, 0])}" title="${esc(a.author)}" name="${esc(nameOf(a.key))}"`;
      if (a.inReplyTo) attrs += ` inreplyto="${esc(nameOf(a.inReplyTo))}"`;
      if (a.state) attrs += ` state="${esc(a.state)}" statemodel="Review"`;
      if (a.type === "Text" && a.hidden) attrs += ` flags="hidden,print,nozoom,norotate"`;
      if (a.modified) attrs += ` date="${pdfDate(a.modified)}"`;
      if (a.quads) attrs += ` coords="${a.quads.map((q) => [0, 2, 4, 6].map((k) => tp(q[k], q[k + 1]).map((v) => v.toFixed(2)).join(",")).join(",")).join(",")}"`;
      const pa = byKey.get(a.key);
      const pt = (p: number[]) => tp(p[0], p[1]).map((v) => v.toFixed(2)).join(",");
      let inner = "";
      if (pa) {
        if (pa.hasBorder() && ["Square", "Circle", "Line", "Ink"].includes(a.type)) attrs += ` width="${pa.getBorderWidth()}"`;
        if (pa.hasInteriorColor()) {
          const ic = Array.from(pa.getInteriorColor());
          if (ic.length === 3) attrs += ` interior-color="${hex(ic)}"`;
        }
        if (a.type === "Text" && pa.hasIcon()) attrs += ` icon="${esc(pa.getIcon())}"`;
        if (a.type === "Line") {
          const [p1, p2] = pa.getLine();
          attrs += ` start="${pt(Array.from(p1))}" end="${pt(Array.from(p2))}"`;
          const tail = pa.getLineEndingStyles().end;
          if (tail && tail !== "None") attrs += ` tail="${tail}"`;
        }
        if (a.type === "Ink") inner = `<inklist>${pa.getInkList().map((st) => `<gesture>${st.map((p) => pt(Array.from(p))).join(";")}</gesture>`).join("")}</inklist>`;
      }
      if (a.contents) inner = `<contents>${esc(a.contents)}</contents>` + inner;
      out.push(`  <${tag} ${attrs}>${inner}</${tag}>`);
    }
    page.destroy();
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n <f href="${esc(fileName)}"/>\n <annots>\n${out.join("\n")}\n </annots>\n</xfdf>\n`;
}

function pdfDate(iso: string) {
  return "D:" + iso.replace(/[-:T]/g, "").slice(0, 14) + "Z";
}

/** Plain-text comment summary, handy for review emails. */
export function summarizeComments(doc: mupdf.PDFDocument): string {
  const lines: string[] = [];
  const replies = new Map<number, AnnotInfo[]>();
  for (let i = 0; i < doc.countPages(); i++) for (const a of listAnnotations(doc, i)) if (a.inReplyTo) replies.set(a.inReplyTo, [...(replies.get(a.inReplyTo) ?? []), a]);
  const thread = (key: number, depth: number): string =>
    (replies.get(key) ?? []).map((r) => `\n${"  ".repeat(depth)}↳ ${r.author || "Reviewer"}: ${r.state ? `status ${r.state}` : r.contents}` + thread(r.key, depth + 1)).join("");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const st = page.toStructuredText("");
    for (const a of listAnnotations(doc, i)) {
      if (a.inReplyTo) continue;
      let quoted = "";
      if (a.quads?.length) {
        const [x0, y0, x1, y1] = boundsOfQuads(a.quads);
        quoted = st.copy([x0 + 0.5, (y0 + y1) / 2], [x1 - 0.5, (y0 + y1) / 2]).replace(/\s+/g, " ").trim();
        if (a.quads.length > 1) quoted = st.copy([a.quads[0][0] + 0.5, (a.quads[0][1] + a.quads[0][5]) / 2], [a.quads.at(-1)![2] - 0.5, (a.quads.at(-1)![3] + a.quads.at(-1)![7]) / 2]).replace(/\s+/g, " ").trim();
      }
      lines.push(`Page ${i + 1} · ${a.type}${a.author ? ` · ${a.author}` : ""}${quoted ? `\n  “${quoted}”` : ""}${a.contents ? `\n  ${a.contents}` : ""}${thread(a.key, 1)}`);
    }
    st.destroy();
    page.destroy();
  }
  return lines.join("\n\n");
}

// ---------- XFDF import ----------

const XFDF_TYPES: Record<string, string> = { text: "Text", highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly", freetext: "FreeText", square: "Square", circle: "Circle", line: "Line", ink: "Ink" };
const unesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l[0] === "#") return String.fromCodePoint(l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[l];
  });
const nums = (s: string | undefined) => (s ?? "").split(/[,;\s]+/).filter(Boolean).map(Number);
function parseColor(s: string | undefined): RGB | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(s ?? "");
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export interface XfdfAnnot {
  type: string;
  page: number;
  attrs: Record<string, string>;
  contents: string;
  gestures: number[][];
}

/** Parse the annotations of an XFDF file (no DOM needed, so it works in the worker and Node). */
export function parseXfdf(xml: string): XfdfAnnot[] {
  const out: XfdfAnnot[] = [];
  const body = /<annots[^>]*>([\s\S]*?)<\/annots>/i.exec(xml)?.[1] ?? "";
  const re = /<([a-z]+)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  for (let m; (m = re.exec(body)); ) {
    const tag = m[1].toLowerCase();
    if (!XFDF_TYPES[tag]) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = unesc(a[3] ?? a[4] ?? "");
    const inner = m[4] ?? "";
    let contents = /<contents>([\s\S]*?)<\/contents>/i.exec(inner)?.[1];
    if (contents === undefined) {
      const rich = /<contents-richtext>([\s\S]*?)<\/contents-richtext>/i.exec(inner)?.[1];
      contents = rich ? rich.replace(/<\/p>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : "";
    }
    const gestures = [...inner.matchAll(/<gesture>([\s\S]*?)<\/gesture>/gi)].map((g) => nums(g[1]));
    out.push({ type: XFDF_TYPES[tag], page: Number(attrs.page ?? 0), attrs, contents: unesc(contents), gestures });
  }
  return out;
}

/**
 * Add comments from an XFDF file. Comments whose name already exists are skipped, and
 * replies are re-linked to their parents. Returns how many were added, by author.
 */
export function importXfdf(doc: mupdf.PDFDocument, xml: string): { added: number; skipped: number; authors: Record<string, number> } {
  const items = parseXfdf(xml);
  const existing = new Map<string, mupdf.PDFObject>();
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (annots.isArray()) for (let k = 0; k < annots.length; k++) {
      const o = annots.get(k);
      const nm = o.get("NM");
      // Unnamed comments are exported as hdfstudio-<object number>; recognise them on re-import.
      existing.set(nm.isString() ? nm.asString() : `hdfstudio-${o.asIndirect()}`, o);
    }
  }
  const authors: Record<string, number> = {};
  const pendingIrt: [mupdf.PDFObject, string][] = [];
  let added = 0, skipped = 0;
  for (const x of items) {
    if (x.page < 0 || x.page >= doc.countPages() || (x.attrs.name && existing.has(x.attrs.name))) {
      skipped++;
      continue;
    }
    const page = doc.loadPage(x.page) as mupdf.PDFPage;
    try {
      const m = page.getTransform();
      const tp = (px: number, py: number): Pt => [px * m[0] + py * m[2] + m[4], px * m[1] + py * m[3] + m[5]];
      const rectOf = (v: number[]) => {
        if (v.length < 4) return [0, 0, 20, 20];
        const p = [tp(v[0], v[1]), tp(v[2], v[3])];
        return [Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])];
      };
      const rect = rectOf(nums(x.attrs.rect));
      const color = parseColor(x.attrs.color);
      const width = x.attrs.width ? Number(x.attrs.width) : undefined;
      let spec: AnnotSpec;
      switch (x.type) {
        case "Highlight": case "Underline": case "StrikeOut": case "Squiggly": {
          const c = nums(x.attrs.coords);
          const quads: number[][] = [];
          for (let i = 0; i + 8 <= c.length; i += 8) quads.push([0, 2, 4, 6].flatMap((k) => tp(c[i + k], c[i + k + 1])));
          if (!quads.length) quads.push([rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]]);
          spec = { type: x.type, quads, color, contents: x.contents };
          break;
        }
        case "Text": spec = { type: "Text", at: [rect[0], rect[1]], contents: x.contents, color, icon: x.attrs.icon }; break;
        case "FreeText": spec = { type: "FreeText", rect, contents: x.contents, color: [0, 0, 0] }; break;
        case "Square": case "Circle": spec = { type: x.type, rect, color, width, fill: parseColor(x.attrs["interior-color"]), contents: x.contents }; break;
        case "Line": {
          const s = nums(x.attrs.start), e = nums(x.attrs.end);
          spec = { type: "Line", a: tp(s[0] ?? rect[0], s[1] ?? rect[1]), b: tp(e[0] ?? rect[2], e[1] ?? rect[3]), color, width, arrow: /arrow/i.test(x.attrs.tail ?? ""), contents: x.contents };
          break;
        }
        default: {
          const strokes = x.gestures.map((g) => { const pts: Pt[] = []; for (let i = 0; i + 1 < g.length; i += 2) pts.push(tp(g[i], g[i + 1])); return pts; }).filter((s) => s.length);
          if (!strokes.length) { skipped++; continue; }
          spec = { type: "Ink", strokes, color, width, contents: x.contents };
        }
      }
      const key = addAnnotation(doc, x.page, spec, x.attrs.title ?? "");
      const o = doc.newIndirect(key);
      o.put("NM", doc.newString(x.attrs.name || newName()));
      if (x.attrs.state) {
        o.put("State", doc.newString(x.attrs.state));
        o.put("StateModel", doc.newString(x.attrs.statemodel || "Review"));
      }
      if (/hidden/.test(x.attrs.flags ?? "")) o.put("F", 2 | 4 | 8 | 16);
      if (x.attrs.subject) o.put("Subj", doc.newString(x.attrs.subject));
      if (/^D:\d{8}/.test(x.attrs.date ?? "")) o.put("M", doc.newString(x.attrs.date));
      if (x.attrs.inreplyto) pendingIrt.push([o, x.attrs.inreplyto]);
      if (x.attrs.name) existing.set(x.attrs.name, o);
      added++;
      const who = x.attrs.title || "Unknown";
      authors[who] = (authors[who] ?? 0) + 1;
    } finally {
      page.destroy();
    }
  }
  for (const [o, parent] of pendingIrt) {
    const p = existing.get(parent);
    if (p) o.put("IRT", p);
  }
  return { added, skipped, authors };
}

// ---------- Shared review sync ----------

/** True if some comment lacks a unique name (call ensureNames inside an undoable operation). */
export function needsNames(doc: mupdf.PDFDocument): boolean {
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const o = annots.get(k);
      const sub = o.get("Subtype").asName();
      if (o.get("NM").isNull() && sub !== "Link" && sub !== "Popup" && sub !== "Widget") return true;
    }
  }
  return false;
}

export interface CommentItem { name: string; author: string; xfdf: string }

/** Every comment as its own XFDF element, keyed by its unique name. */
export function commentItems(doc: mupdf.PDFDocument): CommentItem[] {
  const xml = exportXfdf(doc, "");
  const body = /<annots>([\s\S]*)<\/annots>/.exec(xml)?.[1] ?? "";
  const out: CommentItem[] = [];
  for (const m of body.matchAll(/<([a-z]+) ([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[2])?.[1];
    if (!name) continue;
    const author = /\btitle="([^"]*)"/.exec(m[2])?.[1] ?? "";
    out.push({ name: unesc(name), author: unesc(author), xfdf: m[0] });
  }
  return out;
}

function annotsByName(doc: mupdf.PDFDocument) {
  const map = new Map<string, { page: number; obj: mupdf.PDFObject }>();
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = (doc.findPage(i) as mupdf.PDFObject).get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const nm = annots.get(k).get("NM");
      if (nm.isString()) map.set(nm.asString(), { page: i, obj: annots.get(k) });
    }
  }
  return map;
}

function removeAnnotObj(doc: mupdf.PDFDocument, page: number, obj: mupdf.PDFObject) {
  const p = doc.loadPage(page) as mupdf.PDFPage;
  try {
    const a = p.getAnnotations().find((x) => x.getObject().asIndirect() === obj.asIndirect());
    if (a) p.deleteAnnotation(a);
  } finally {
    p.destroy();
  }
}

/** Apply changes from other reviewers: replace or add comments (XFDF elements) and remove deleted ones. */
export function applyCommentChanges(doc: mupdf.PDFDocument, upserts: string[], deletes: string[]): { added: number; updated: number; removed: number } {
  let byName = annotsByName(doc);
  let removed = 0, updated = 0;
  for (const n of deletes) {
    const hit = byName.get(n);
    if (hit) {
      removeAnnotObj(doc, hit.page, hit.obj);
      removed++;
    }
  }
  const names = upserts.map((x) => unesc(/\bname="([^"]*)"/.exec(x)?.[1] ?? ""));
  for (const n of names) {
    const hit = byName.get(n);
    if (hit) {
      removeAnnotObj(doc, hit.page, hit.obj);
      updated++;
    }
  }
  const r = upserts.length ? importXfdf(doc, `<xfdf><annots>${upserts.join("")}</annots></xfdf>`) : { added: 0 };
  // Replies to a comment that was just replaced still point at the old object: re-link by name.
  byName = annotsByName(doc);
  for (const { obj } of byName.values()) {
    const irt = obj.get("IRT");
    if (!irt.isDictionary()) continue;
    const nm = irt.get("NM");
    const current = nm.isString() ? byName.get(nm.asString()) : undefined;
    if (current && current.obj.asIndirect() !== irt.asIndirect()) obj.put("IRT", current.obj);
  }
  return { added: r.added - updated, updated, removed };
}
