// Permanent redaction and document sanitizing.
// Redaction is two-step, as in professional tools: mark areas (Redact annotations, reviewable and undoable),
// then apply, which removes the underlying text, image pixels and vector art for good.
import * as mupdf from "mupdf";

export const REDACT_PATTERNS: Record<string, { label: string; regex: string }> = {
  email: { label: "Email addresses", regex: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}" },
  phone: { label: "Phone numbers", regex: "(\\+?\\d{1,2}[ .-]?)?\\(?\\d{3}\\)?[ .-]?\\d{3}[ .-]?\\d{4}" },
  ssn: { label: "US Social Security numbers", regex: "\\d{3}-\\d{2}-\\d{4}" },
  card: { label: "Credit card numbers", regex: "\\d{4}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{1,4}" },
  date: { label: "Dates (numeric)", regex: "\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}" },
  money: { label: "Money amounts", regex: "[$€£]\\s?\\d[\\d,]*(\\.\\d{2})?" },
};

export interface FindRedactOptions {
  text?: string;
  /** Raw regular expression (MuPDF syntax), or a key of REDACT_PATTERNS. */
  regex?: string;
  pattern?: keyof typeof REDACT_PATTERNS;
  caseSensitive?: boolean;
  pages?: number[];
}

/**
 * AutoCAD draws SHX-font text as line work and, so it stays searchable, adds an invisible comment over
 * each text object holding the words ("AutoCAD SHX Text"). Those comments are searched and redacted too.
 */
export function isShxComment(a: mupdf.PDFAnnotation): boolean {
  const o = a.getObject();
  const s = (k: string) => { const v = o.get(k); return v.isString() ? v.asString() : ""; };
  return /SHX/i.test(s("T") + " " + s("Subj"));
}

/** Mark every match with a Redact annotation. Returns the number of marks added. */
export function markMatches(doc: mupdf.PDFDocument, o: FindRedactOptions): number {
  return findAndMark(doc, o).count;
}

/** Like markMatches, and also reports how many searched pages have no real text (drawn-as-lines text needs OCR). */
export function findAndMark(doc: mupdf.PDFDocument, o: FindRedactOptions): { count: number; textless: number[] } {
  const needle = o.pattern ? REDACT_PATTERNS[o.pattern].regex : o.regex ?? o.text;
  if (!needle) throw new Error("Nothing to search for");
  const opts = [o.pattern || o.regex ? "regexp" : "", o.caseSensitive ? "" : "ignore-case"].filter(Boolean).join(",");
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp | null = null;
  try {
    re = new RegExp(o.pattern || o.regex ? needle : esc(needle), o.caseSensitive ? "g" : "gi");
  } catch { /* MuPDF-only syntax: page text is still searched */ }
  let count = 0;
  const textless: number[] = [];
  const pages = o.pages ?? [...Array(doc.countPages()).keys()];
  for (const i of pages) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    try {
      const st = page.toStructuredText("");
      if (st.asText().replace(/\s+/g, "").length < 10) textless.push(i);
      st.destroy();
      for (const hit of page.search(needle, opts)) {
        const a = page.createAnnotation("Redact");
        a.setQuadPoints(hit);
        a.update();
        count++;
      }
      // CAD text kept as comments: mark the matched part of the comment's box (characters spread evenly).
      for (const c of page.getAnnotations()) {
        if (!re || c.getType() === "Redact" || !isShxComment(c)) continue;
        const text = c.getContents() ?? "";
        if (!text) continue;
        const [x0, y0, x1, y1] = c.getRect();
        const wide = x1 - x0 >= y1 - y0 || text.length < 2;
        for (const m of text.matchAll(re)) {
          if (!m[0]) continue;
          const f0 = m.index! / text.length, f1 = (m.index! + m[0].length) / text.length;
          const r = wide ? [x0 + (x1 - x0) * f0, y0, x0 + (x1 - x0) * f1, y1] : [x0, y0 + (y1 - y0) * f0, x1, y0 + (y1 - y0) * f1];
          const a = page.createAnnotation("Redact");
          a.setRect(r as mupdf.Rect);
          a.update();
          count++;
        }
      }
    } finally {
      page.destroy();
    }
  }
  return { count, textless };
}

export function countMarks(doc: mupdf.PDFDocument): number {
  let n = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    n += page.getAnnotations().filter((a) => a.getType() === "Redact").length;
    page.destroy();
  }
  return n;
}

export interface ApplyOptions {
  /** Draw black boxes where content was removed (default true). */
  blackBoxes?: boolean;
  /** "pixels": blank only the covered pixels (default); "remove": drop any touched image entirely; "none": keep images. */
  images?: "pixels" | "remove" | "none";
  /** Remove vector drawings covered by marks (default true). */
  lineArt?: boolean;
}

/** Permanently apply all Redact marks. Returns the number of pages changed. */
export function applyRedactions(doc: mupdf.PDFDocument, o: ApplyOptions = {}): number {
  const image = { none: 0, remove: 1, pixels: 2 }[o.images ?? "pixels"];
  const lineArt = o.lineArt === false ? 0 : 1;
  let pages = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const marks = annots.filter((a) => a.getType() === "Redact").map((a) => Array.from(a.getBounds()));
    if (marks.length) {
      // CAD text comments under a mark would still give the words away.
      const hits = (r: number[]) => marks.some((m) => m[0] < r[2] && m[2] > r[0] && m[1] < r[3] && m[3] > r[1]);
      for (const a of annots) if (isShxComment(a) && hits(Array.from(a.getBounds()))) page.deleteAnnotation(a);
      page.applyRedactions(o.blackBoxes !== false, image, lineArt, 0);
      pages++;
    }
    page.destroy();
  }
  return pages;
}

export interface SanitizeReport {
  metadata: boolean;
  javascript: number;
  attachments: number;
  openAction: boolean;
  comments: number;
  hiddenText: boolean;
}

/**
 * Remove hidden information: document metadata (Info + XMP), JavaScript, embedded files,
 * automatic actions, and optionally comments. Pair with saving using "garbage,sanitize" so
 * unreferenced old objects are dropped from the file.
 */
export function sanitize(doc: mupdf.PDFDocument, opts: { removeComments?: boolean } = {}): SanitizeReport {
  const report: SanitizeReport = { metadata: false, javascript: 0, attachments: 0, openAction: false, comments: 0, hiddenText: false };
  for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
    if (doc.getMetaData(`info:${k}`)) report.metadata = true;
    doc.setMetaData(`info:${k}`, "");
  }
  const root = doc.getTrailer().get("Root");
  if (!root.get("Metadata").isNull()) {
    root.delete("Metadata");
    report.metadata = true;
  }
  if (!root.get("OpenAction").isNull()) {
    root.delete("OpenAction");
    report.openAction = true;
  }
  if (!root.get("AA").isNull()) root.delete("AA");
  const names = root.get("Names");
  if (!names.isNull()) {
    const js = names.get("JavaScript");
    if (!js.isNull()) {
      report.javascript = countNameTree(js);
      names.delete("JavaScript");
    }
    const ef = names.get("EmbeddedFiles");
    if (!ef.isNull()) {
      report.attachments = countNameTree(ef);
      names.delete("EmbeddedFiles");
    }
  }
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    const obj = page.getObject();
    if (!obj.get("AA").isNull()) obj.delete("AA");
    for (const a of page.getAnnotations()) {
      const t = a.getType();
      if (t === "FileAttachment") {
        page.deleteAnnotation(a);
        report.attachments++;
      } else if (opts.removeComments && t !== "Link" && t !== "Widget") {
        page.deleteAnnotation(a);
        report.comments++;
      }
    }
    page.destroy();
  }
  return report;
}

function countNameTree(node: mupdf.PDFObject): number {
  let n = 0;
  const names = node.get("Names");
  if (names.isArray()) n += names.length / 2;
  const kids = node.get("Kids");
  if (kids.isArray()) kids.forEach((k) => (n += countNameTree(k)));
  return n;
}

export interface Protection {
  userPassword?: string;
  ownerPassword: string;
  allowPrint?: boolean;
  allowCopy?: boolean;
  allowEdit?: boolean;
  allowComments?: boolean;
  allowForms?: boolean;
}

/** Save options string for AES-256 encryption with the given permissions. */
export function protectionOptions(p: Protection): string {
  const PERM = { print: 4, edit: 8, copy: 16, annotate: 32, fill: 256, extract: 512, assemble: 1024, printHigh: 2048 };
  let bits = PERM.extract; // accessibility extraction is always allowed
  if (p.allowPrint !== false) bits |= PERM.print | PERM.printHigh;
  if (p.allowCopy !== false) bits |= PERM.copy;
  if (p.allowEdit) bits |= PERM.edit | PERM.assemble;
  if (p.allowComments !== false) bits |= PERM.annotate;
  if (p.allowForms !== false) bits |= PERM.fill;
  const q = (s: string) => s.replace(/[,=]/g, ""); // option-string delimiters can't appear in passwords
  return ["encrypt=aes-256", `owner-password=${q(p.ownerPassword)}`, p.userPassword ? `user-password=${q(p.userPassword)}` : "", `permissions=${bits | ~0xffff}`].filter(Boolean).join(",");
}
