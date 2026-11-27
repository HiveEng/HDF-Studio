// PDF -> Excel (tables) and PDF -> PowerPoint (one editable slide per page).
import * as mupdf from "mupdf";
import { zipSync, strToU8 } from "fflate";
import { matchFont } from "./edit";
import { pageSegments } from "./snap";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// ---------- words ----------
interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  font: string;
  color: number[];
  base: number;
}
function pageWords(page: mupdf.Page): Word[] {
  const st = page.toStructuredText("preserve-whitespace");
  const words: Word[] = [];
  let cur: Word | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) words.push(cur);
    cur = null;
  };
  st.walk({
    onChar(c, o, f, size, q, color) {
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (/\s/.test(c)) return flush();
      if (cur && b.x0 - cur.x1 < size * 0.15 && Math.abs(b.y0 - cur.y0) < size * 0.5) {
        cur.text += c;
        cur.x1 = Math.max(cur.x1, b.x1);
        cur.y1 = Math.max(cur.y1, b.y1);
      } else {
        flush();
        cur = { text: c, ...b, size, font: f.getName(), color: Array.from(color as number[]), base: o[1] };
      }
    },
    endLine: flush,
  });
  flush();
  st.destroy();
  return words;
}

interface Phrase {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  w: Word;
}
/** Words on one line joined into phrases; a wide gap (a column break) starts a new phrase. */
function toPhrases(ln: Word[]): Phrase[] {
  ln.sort((a, b) => a.x0 - b.x0);
  const out: Phrase[] = [];
  for (const w of ln) {
    const p = out[out.length - 1];
    if (p && w.x0 - p.x1 < w.size * 0.9) (p.text += " " + w.text), (p.x1 = w.x1), (p.y0 = Math.min(p.y0, w.y0)), (p.y1 = Math.max(p.y1, w.y1));
    else out.push({ text: w.text, x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, w });
  }
  return out;
}
function groupLines(words: Word[]): Word[][] {
  const lines: Word[][] = [];
  for (const w of [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const l = lines.find((ln) => Math.abs((ln[0].y0 + ln[0].y1) / 2 - (w.y0 + w.y1) / 2) < Math.min(ln[0].size, w.size) * 0.45);
    if (l) l.push(w);
    else lines.push([w]);
  }
  return lines;
}

// ---------- tables ----------
type Cell = string | number | null;

/** Read "1,234.50", "$12", "(45)", "12%" as numbers; leave anything else as text. */
export function cellValue(s: string): Cell {
  const t = s.trim();
  if (!t) return null;
  const m = /^\(?-?[$€£]?\s?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\)?%?$/.exec(t);
  if (!m || /^0\d/.test(t.replace(/[^\d]/g, "").slice(0, 2)) && !/\./.test(t)) return t;
  let n = +t.replace(/[^\d.]/g, "");
  if (/^\(.*\)$/.test(t) || t.startsWith("-")) n = -n;
  if (t.endsWith("%")) n /= 100;
  return isNaN(n) ? t : n;
}

const cluster = (vals: number[], tol: number) => {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
};

/** Turn one page into rows of cells: ruled tables by their lines, other text by its column gaps. */
export function pageTable(page: mupdf.Page): Cell[][] {
  const words = pageWords(page);
  if (!words.length) return [];
  const seg = pageSegments(page);
  const hs: number[][] = [], vs: number[][] = [];
  for (let i = 0; i < seg.length; i += 4) {
    const [x1, y1, x2, y2] = [seg[i], seg[i + 1], seg[i + 2], seg[i + 3]];
    if (Math.abs(y1 - y2) < 0.6 && Math.abs(x2 - x1) > 15) hs.push([Math.min(x1, x2), y1, Math.max(x1, x2)]);
    else if (Math.abs(x1 - x2) < 0.6 && Math.abs(y2 - y1) > 8) vs.push([x1, Math.min(y1, y2), Math.max(y1, y2)]);
  }
  // A ruled grid: enough vertical and horizontal rules overlapping in one region.
  let grid: { xs: number[]; ys: number[]; box: number[] } | null = null;
  if (vs.length >= 3 && hs.length >= 3) {
    const box = [Math.min(...vs.map((v) => v[0])), Math.min(...hs.map((h) => h[1])), Math.max(...vs.map((v) => v[0])), Math.max(...hs.map((h) => h[1]))];
    const xs = cluster(vs.map((v) => v[0]), 2);
    const ys = cluster(hs.map((h) => h[1]), 2);
    if (xs.length >= 3 && ys.length >= 3 && box[2] - box[0] > 60 && box[3] - box[1] > 20) grid = { xs, ys, box };
  }
  const inGrid = (w: Word) => !!grid && (w.x0 + w.x1) / 2 > grid.box[0] && (w.x0 + w.x1) / 2 < grid.box[2] && (w.y0 + w.y1) / 2 > grid.box[1] && (w.y0 + w.y1) / 2 < grid.box[3];

  type Row = { y: number; cells: Map<number, string> };
  const rows: Row[] = [];
  // Ruled table: cell = (column band, row band).
  if (grid) {
    const g = grid;
    const band = (list: number[], v: number) => Math.max(0, list.findIndex((x, i) => v >= x && v < (list[i + 1] ?? Infinity)));
    const byRow = new Map<number, Map<number, string>>();
    for (const w of words.filter(inGrid).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      const r = band(g.ys, (w.y0 + w.y1) / 2), c = band(g.xs, (w.x0 + w.x1) / 2);
      const row = byRow.get(r) ?? new Map<number, string>();
      row.set(c, row.has(c) ? `${row.get(c)} ${w.text}` : w.text);
      byRow.set(r, row);
    }
    for (const [r, cells] of byRow) rows.push({ y: g.ys[r], cells });
  }
  // Everything else: lines of text split into phrases at wide gaps, columns from the gaps.
  const rest = words.filter((w) => !inGrid(w)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = groupLines(rest);
  const phrases = lines.map((ln) => ({ y: ln[0].y0, ps: toPhrases(ln) }));
  // Column bands: merge the spans of phrases from lines that have more than one phrase.
  const spans = phrases.filter((l) => l.ps.length > 1).flatMap((l) => l.ps.map((p) => [p.x0, p.x1]));
  spans.sort((a, b) => a[0] - b[0]);
  const bands: number[][] = [];
  for (const s of spans) {
    const b = bands[bands.length - 1];
    if (b && s[0] <= b[1] + 2) b[1] = Math.max(b[1], s[1]);
    else bands.push([...s]);
  }
  const bandOf = (x0: number, x1: number) => {
    if (!bands.length) return 0;
    let best = 0, ov = -Infinity;
    bands.forEach((b, i) => {
      const o = Math.min(b[1], x1) - Math.max(b[0], x0);
      if (o > ov) (ov = o), (best = i);
    });
    return best;
  };
  // Ruled tables keep their own column numbers; free text follows after them.
  for (const l of phrases) {
    const cells = new Map<number, string>();
    for (const p of l.ps) {
      const c = bandOf(p.x0, p.x1);
      cells.set(c, cells.has(c) ? `${cells.get(c)} ${p.text}` : p.text);
    }
    rows.push({ y: l.y, cells });
  }
  rows.sort((a, b) => a.y - b.y);
  return rows.map((r) => {
    const n = Math.max(...r.cells.keys()) + 1;
    return Array.from({ length: n }, (_, i) => (r.cells.has(i) ? cellValue(r.cells.get(i)!) : null));
  });
}

// ---------- xlsx ----------
const colName = (i: number) => {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
export function xlsxWorkbook(sheets: { name: string; rows: Cell[][] }[]): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((s) => {
    let n = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${s.name.slice(0, 27)} (${k})`;
    used.add(n.toLowerCase());
    return n;
  });
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((s, i) => {
    const widths: number[] = [];
    const rowsXml = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v === null || v === "") return "";
      widths[ci] = Math.max(widths[ci] ?? 8, Math.min(60, String(v).length + 2));
      const ref = colName(ci) + (ri + 1);
      return typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join("")}</row>`).join("");
    const cols = widths.length ? `<cols>${widths.map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w ?? 8}" customWidth="1"/>`).join("")}</cols>` : "";
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowsXml}</sheetData></worksheet>`);
  });
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files["xl/styles.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zipSync(files, { level: 6 });
}

export function toXlsx(doc: mupdf.Document, o: { oneSheet?: boolean } = {}): Uint8Array {
  const sheets: { name: string; rows: Cell[][] }[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      const rows = pageTable(page);
      if (o.oneSheet) {
        if (!sheets.length) sheets.push({ name: "Document", rows: [] });
        if (sheets[0].rows.length) sheets[0].rows.push([]);
        sheets[0].rows.push(...rows);
      } else sheets.push({ name: `Page ${i + 1}`, rows });
    } finally {
      page.destroy();
    }
  }
  return xlsxWorkbook(sheets.length ? sheets : [{ name: "Sheet1", rows: [] }]);
}

// ---------- pptx ----------
/** Render a page without its text (the text goes on the slide as editable boxes). */
function renderWithoutText(page: mupdf.Page, scale: number): Uint8Array {
  const b = page.getBounds();
  const m: mupdf.Matrix = [scale, 0, 0, scale, -b[0] * scale, -b[1] * scale];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.ceil((b[2] - b[0]) * scale), Math.ceil((b[3] - b[1]) * scale)], false);
  pix.clear(255);
  const draw = new mupdf.DrawDevice(m, pix);
  const fwd = new mupdf.Device({
    fillPath: (p, eo, ctm, cs, c, a) => draw.fillPath(p, eo, ctm, cs, c as mupdf.Color, a),
    strokePath: (p, s, ctm, cs, c, a) => draw.strokePath(p, s, ctm, cs, c as mupdf.Color, a),
    clipPath: (p, eo, ctm) => draw.clipPath(p, eo, ctm),
    clipStrokePath: (p, s, ctm) => draw.clipStrokePath(p, s, ctm),
    clipText: (t, ctm) => draw.clipText(t, ctm),
    clipStrokeText: (t, s, ctm) => draw.clipStrokeText(t, s, ctm),
    fillShade: (sh, ctm, a) => draw.fillShade(sh, ctm, a),
    fillImage: (im, ctm, a) => draw.fillImage(im, ctm, a),
    fillImageMask: (im, ctm, cs, c, a) => draw.fillImageMask(im, ctm, cs, c as mupdf.Color, a),
    clipImageMask: (im, ctm) => draw.clipImageMask(im, ctm),
    popClip: () => draw.popClip(),
    beginMask: (r, l, cs, c) => draw.beginMask(r, l, cs, c as mupdf.Color),
    endMask: () => draw.endMask(),
    beginGroup: (r, cs, i, k, bm, a) => draw.beginGroup(r, cs, i, k, bm, a),
    endGroup: () => draw.endGroup(),
    beginTile: (ar, v, xs, ys, ctm, id, did) => draw.beginTile(ar, v, xs, ys, ctm, id, did),
    endTile: () => draw.endTile(),
  });
  page.run(fwd, mupdf.Matrix.identity);
  fwd.close();
  draw.close();
  const png = new Uint8Array(pix.asPNG());
  pix.destroy();
  return png;
}

export function toPptx(doc: mupdf.Document, o: { editableText?: boolean } = {}): Uint8Array {
  const editable = o.editableText ?? true;
  const EMU = 12700;
  const first = doc.loadPage(0);
  const fb = first.getBounds();
  first.destroy();
  const [sw, sh] = [Math.round((fb[2] - fb[0]) * EMU), Math.round((fb[3] - fb[1]) * EMU)];
  const files: Record<string, Uint8Array> = {};
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    try {
      const b = page.getBounds();
      // Fit each page to the slide size (pages can differ in size).
      const k = Math.min(sw / ((b[2] - b[0]) * EMU), sh / ((b[3] - b[1]) * EMU));
      const ox = (sw - (b[2] - b[0]) * EMU * k) / 2, oy = (sh - (b[3] - b[1]) * EMU * k) / 2;
      const E = (v: number) => Math.round(v * EMU * k);
      let png: Uint8Array;
      let shapes = "";
      if (editable) {
        png = renderWithoutText(page, 2);
        let id = 3;
        for (const ph of groupLines(pageWords(page)).flatMap(toPhrases)) {
          const w = ph.w;
          const fn = matchFont(w.font);
          const font = fn.startsWith("Times") ? "Times New Roman" : fn.startsWith("Courier") ? "Courier New" : "Arial";
          const rgb = w.color.length === 3 ? w.color : w.color.length === 1 ? [w.color[0], w.color[0], w.color[0]] : [0, 0, 0];
          const color = rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
          const bold = /Bold/.test(fn) ? ' b="1"' : "", it = /Italic|Oblique/.test(fn) ? ' i="1"' : "";
          const sz = Math.max(100, Math.round(w.size * k * 100));
          const x = Math.round(ox + E(ph.x0 - b[0])), y = Math.round(oy + E(ph.y0 - b[1]));
          const cx = Math.max(EMU, E(ph.x1 - ph.x0) + EMU * 4), cy = Math.max(EMU, E(ph.y1 - ph.y0));
          shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id++}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${sz}"${bold}${it} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/></a:rPr><a:t>${esc(ph.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
        }
      } else {
        const pix = page.toPixmap([2, 0, 0, 2, -b[0] * 2, -b[1] * 2], mupdf.ColorSpace.DeviceRGB, false, true);
        png = new Uint8Array(pix.asPNG());
        pix.destroy();
      }
      files[`ppt/media/page${i + 1}.png`] = png;
      const pic = `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i + 1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(ox)}" y="${Math.round(oy)}"/><a:ext cx="${E(b[2] - b[0])}" cy="${E(b[3] - b[1])}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
      files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${pic}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
      files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/page${i + 1}.png"/></Relationships>`);
    } finally {
      page.destroy();
    }
  }
  const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const ids = Array.from({ length: n }, (_, i) => i);
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${ids.map((i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  files["ppt/presentation.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${ids.map((i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${sw}" cy="${sh}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  files["ppt/_rels/presentation.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${ids.map((i) => `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`);
  const tree = `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>`;
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${P}>${tree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdL"/></p:sldLayoutIdLst></p:sldMaster>`);
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${P} type="blank">${tree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  const clr = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  files["ppt/theme/theme1.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="HDS"><a:themeElements><a:clrScheme name="HDS"><a:dk1><a:srgbClr val="0D0D0D"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>${clr("dk2", "575859")}${clr("lt2", "EEEEEE")}${clr("accent1", "05C7F2")}${clr("accent2", "C5D932")}${clr("accent3", "F2CB05")}${clr("accent4", "575859")}${clr("accent5", "0D0D0D")}${clr("accent6", "999999")}${clr("hlink", "05C7F2")}${clr("folHlink", "575859")}</a:clrScheme><a:fontScheme name="HDS"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="HDS"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  return zipSync(files, { level: 6 });
}
