// Markup list: every comment and markup as a row (page, kind, text, author, date, status,
// measurement), plus totals per kind, exported to CSV or Excel (.xlsx).
import * as mupdf from "mupdf";
import { zipSync, strToU8 } from "fflate";
import { getPageScale } from "./scale";
import { type Scale, type Pt, dist, pathLength, polygonArea, angleAt, formatLength, formatArea } from "./measure";

export interface MarkupRow {
  page: number;
  kind: string;
  contents: string;
  author: string;
  date: string;
  status: string;
  replies: number;
  color: string;
  /** Measured length or perimeter, in `unit`. */
  length: number | null;
  /** Measured area, in `unit`². */
  area: number | null;
  angle: number | null;
  count: number | null;
  unit: string;
  measurement: string;
  scale: string;
}

const UNIT_LABEL: Record<string, string> = { "ft-in": "ft", ft: "ft", in: "in", m: "m", mm: "mm", cm: "cm" };
const PER_INCH: Record<string, number> = { ft: 1 / 12, in: 1, m: 0.0254, mm: 25.4, cm: 2.54 };
const hex = (c: number[]) => (c.length >= 3 ? "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : "");
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function nameOf(o: mupdf.PDFObject, key: string): string {
  const v = o.get(key);
  return v.isName() ? v.asName() : "";
}

/** One row per top-level markup (replies, popups, links and grouped leaders are folded in). */
export function markupRows(doc: mupdf.PDFDocument): MarkupRow[] {
  const rows: MarkupRow[] = [];
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const page = doc.loadPage(pi) as mupdf.PDFPage;
    const scale: Scale | null = getPageScale(doc, pi);
    const unit = scale ? UNIT_LABEL[scale.unit] ?? "in" : "";
    const toUnit = (pts: number) => (scale ? round(pts * scale.k * PER_INCH[unit]) : null);
    const toArea = (sq: number) => (scale ? round(sq * scale.k * scale.k * PER_INCH[unit] ** 2) : null);
    try {
      const annots = page.getAnnotations();
      const keyOf = (a: mupdf.PDFAnnotation) => a.getObject().asIndirect();
      // Replies (and their review states) by parent.
      const replies = new Map<number, { state: string; date: number }[]>();
      for (const a of annots) {
        const o = a.getObject();
        const irt = o.get("IRT");
        if (!irt.isIndirect() || nameOf(o, "RT") === "Group") continue;
        const st = o.get("State");
        let t = 0;
        try {
          t = a.getModificationDate()?.getTime() ?? 0;
        } catch { /* no date */ }
        const list = replies.get(irt.asIndirect()) ?? [];
        list.push({ state: st.isString() ? st.asString() : "", date: t });
        replies.set(irt.asIndirect(), list);
      }
      for (const a of annots) {
        const type = a.getType();
        const o = a.getObject();
        if (type === "Popup" || type === "Link" || type === "Widget" || o.get("IRT").isIndirect()) continue;
        const contents = a.getContents() ?? "";
        const intent = nameOf(o, "IT");
        const cloudy = (() => {
          const be = o.get("BE");
          return be.isDictionary() && nameOf(be, "S") === "C";
        })();
        let kind: string = type;
        let length: number | null = null, area: number | null = null, angle: number | null = null, count: number | null = null;
        let measurement = "";
        const verts = (): Pt[] => (a.hasVertices() ? a.getVertices().map((p) => [p[0], p[1]] as Pt) : []);
        switch (type) {
          case "Line": {
            const [p1, p2] = a.getLine();
            const len = dist([p1[0], p1[1]], [p2[0], p2[1]]);
            if (intent === "LineDimension" || /^Length:/.test(contents)) {
              kind = /^Length:/.test(contents) ? "Length" : "Dimension";
              length = toUnit(len);
              if (scale) measurement = formatLength(len * scale.k, scale.unit);
            } else kind = (a.getLineEndingStyles().end ?? "None") !== "None" ? "Arrow" : "Line";
            break;
          }
          case "PolyLine": {
            const v = verts();
            if (/^Angle:/.test(contents) && v.length >= 3) {
              kind = "Angle";
              angle = round(angleAt(v[0], v[1], v[2]), 1);
              measurement = `${angle}°`;
            } else if (intent === "PolyLineDimension") {
              kind = "Polylength";
              length = toUnit(pathLength(v));
              if (scale) measurement = formatLength(pathLength(v) * scale.k, scale.unit);
            } else kind = "Polyline";
            break;
          }
          case "Polygon": {
            const v = verts();
            if (intent === "PolygonDimension") {
              kind = a.hasInteriorColor() && a.getInteriorColor().length ? "Area" : "Perimeter";
              length = toUnit(pathLength(v, true));
              area = toArea(polygonArea(v));
              if (scale) measurement = kind === "Area" ? `${formatArea(polygonArea(v) * scale.k * scale.k, scale.unit)}; perimeter ${formatLength(pathLength(v, true) * scale.k, scale.unit)}` : formatLength(pathLength(v, true) * scale.k, scale.unit);
            } else kind = cloudy ? "Revision cloud" : "Polygon";
            break;
          }
          case "Square":
            kind = cloudy ? "Revision cloud" : "Rectangle";
            break;
          case "Circle":
            if (/^Count \d+$/.test(contents)) {
              kind = "Count";
              count = 1;
            } else kind = "Ellipse";
            break;
          case "FreeText":
            kind = o.get("CL").isArray() ? "Callout" : "Text box";
            break;
          case "Stamp": {
            const st = o.get("HDFStamp");
            kind = st.isArray() ? `Stamp: ${st.get(0).asString()}` : o.get("HDFImg").isArray() || /^Signed/.test(contents) ? "Signature / image" : "Stamp";
            break;
          }
          case "Text":
            kind = "Note";
            break;
          case "Ink":
            kind = "Pen";
            break;
          case "StrikeOut":
            kind = "Strikeout";
            break;
        }
        const rs = replies.get(keyOf(a)) ?? [];
        const status = rs.filter((r) => r.state).sort((x, y) => x.date - y.date).pop()?.state ?? "";
        let date = "";
        try {
          const dd = a.getModificationDate();
          if (dd && !isNaN(dd.getTime())) date = dd.toISOString().slice(0, 16).replace("T", " ");
        } catch { /* none */ }
        rows.push({
          page: pi + 1, kind, contents, author: a.hasAuthor() ? a.getAuthor() ?? "" : "", date, status, replies: rs.length,
          color: hex(Array.from(a.getColor())), length, area, angle, count, unit: length !== null || area !== null ? unit : "", measurement, scale: scale?.label ?? "",
        });
      }
    } finally {
      page.destroy();
    }
  }
  return rows;
}

export interface SummaryRow { kind: string; page: string; items: number; length: number | null; area: number | null; unit: string }

/** Totals per kind (all pages), then per kind and page where there's more than one page. */
export function summarize(rows: MarkupRow[]): SummaryRow[] {
  const groups = new Map<string, SummaryRow>();
  const add = (key: string, kind: string, page: string, r: MarkupRow) => {
    const g = groups.get(key) ?? { kind, page, items: 0, length: null, area: null, unit: r.unit };
    g.items++;
    if (r.length !== null) g.length = round((g.length ?? 0) + r.length);
    if (r.area !== null) g.area = round((g.area ?? 0) + r.area);
    if (r.unit && g.unit && r.unit !== g.unit) g.unit = "mixed";
    else if (r.unit) g.unit = r.unit;
    groups.set(key, g);
  };
  const pages = new Set(rows.map((r) => r.page));
  for (const r of rows) {
    add(`all|${r.kind}`, r.kind, "All", r);
    if (pages.size > 1) add(`p${String(r.page).padStart(5, "0")}|${r.kind}`, r.kind, String(r.page), r);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
}

const HEAD = ["Page", "Kind", "Comment / text", "Author", "Date", "Status", "Replies", "Colour", "Length / perimeter", "Area", "Angle (°)", "Count", "Unit", "Measurement", "Scale"];
const rowCells = (r: MarkupRow): (string | number | null)[] => [r.page, r.kind, r.contents, r.author, r.date, r.status, r.replies, r.color, r.length, r.area, r.angle, r.count, r.unit, r.measurement, r.scale];
const SUM_HEAD = ["Kind", "Page", "Items", "Total length / perimeter", "Total area", "Unit"];
const sumCells = (s: SummaryRow): (string | number | null)[] => [s.kind, s.page, s.items, s.length, s.area, s.unit === "mixed" ? "mixed units" : s.area !== null ? `${s.unit} / sq ${s.unit}` : s.unit];

export function toCsv(rows: MarkupRow[]): string {
  const q = (v: string | number | null) => {
    if (v === null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Leading BOM so Excel reads UTF-8 (names with accents, ° signs) correctly.
  return "﻿" + [HEAD, ...rows.map(rowCells)].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const col = (i: number) => {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
function sheetXml(head: string[], body: (string | number | null)[][], widths: number[]): string {
  const cell = (v: string | number | null, r: number, c: number, bold: boolean) => {
    const ref = `${col(c)}${r}`;
    if (v === null || v === "") return "";
    if (typeof v === "number") return `<c r="${ref}"${bold ? ' s="1"' : ""}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const rows = [head, ...body].map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, i + 1, c, i === 0)).join("")}</row>`).join("");
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const last = `${col(head.length - 1)}${body.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

/** A real .xlsx workbook: "Markups" (one row each, filterable) and "Totals". */
export function toXlsx(rows: MarkupRow[], title = "Markups"): Uint8Array {
  const sum = summarize(rows);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(title)}</dc:title><dc:creator>HDF Studio</dc:creator></cp:coreProperties>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Markups" sheetId="1" r:id="rId1"/><sheet name="Totals" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Markups!$A$1:$${col(HEAD.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(HEAD, rows.map(rowCells), [6, 18, 40, 16, 16, 12, 8, 9, 12, 10, 9, 7, 6, 26, 16])),
    "xl/worksheets/sheet2.xml": strToU8(sheetXml(SUM_HEAD, sum.map(sumCells), [20, 8, 8, 22, 14, 14])),
  };
  return zipSync(files, { level: 6 });
}
