// Automatic tagging for accessibility (screen readers, PDF/UA-style structure).
//
// 1. Analyse: MuPDF's text extraction gives blocks and lines with font size and weight; vector
//    lines give table grids. From these we classify headings (by size rank), paragraphs, list
//    items, table cells, and running headers/footers (artifacts).
// 2. Rewrite each page's content stream: every text-showing operator is wrapped in marked
//    content (BDC/EMC with an MCID) for the line it starts in; images become Figures; paths,
//    shadings and headers/footers become Artifacts. Original bytes are copied unchanged between
//    the inserted operators.
// 3. Build the structure tree (Document > H1…/P/L/Table/Figure/Link/Form), the parent tree,
//    MarkInfo, language, tab order and title.
import * as mupdf from "mupdf";

export interface TagOptions {
  /** BCP 47 language, e.g. "en-US". Kept if the document already has one and this is omitted. */
  lang?: string;
  /** Replace existing tags. Without this, an already tagged document is left alone. */
  retag?: boolean;
}

export interface TagReport {
  pages: number;
  headings: number;
  paragraphs: number;
  lists: number;
  tables: number;
  figures: number;
  links: number;
  fields: number;
  artifacts: number;
}

export interface FigureInfo {
  /** Object number of the Figure structure element. */
  key: number;
  page: number;
  rect: number[];
  alt: string;
}

// ---------------------------------------------------------------------------------------------
// Analysis

interface Line {
  bbox: number[];
  text: string;
  size: number;
  bold: boolean;
  block: number;
}
interface Block {
  bbox: number[];
  lines: number[]; // indexes into page lines
}
interface Cell { rect: number[]; row: number; col: number }
interface Table { rect: number[]; rows: number; cols: number; cells: Cell[] }

interface PageInfo {
  lines: Line[];
  blocks: Block[];
  tables: Table[];
  height: number;
  width: number;
}

const BULLET = /^\s*([•◦▪▫‣⁃●○■□–—\-*·]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,4}[.)])\s+\S/;

function readPage(page: mupdf.Page): PageInfo {
  const [x0, y0, x1, y1] = page.getBounds();
  const st = page.toStructuredText("preserve-whitespace");
  const lines: Line[] = [];
  const blocks: Block[] = [];
  let cur: Line | null = null;
  let sizeSum = 0, count = 0, boldCount = 0;
  st.walk({
    beginTextBlock(bbox) {
      blocks.push({ bbox: Array.from(bbox), lines: [] });
    },
    beginLine(bbox) {
      cur = { bbox: Array.from(bbox), text: "", size: 0, bold: false, block: blocks.length - 1 };
      sizeSum = count = boldCount = 0;
    },
    onChar(c, _o, font, size) {
      if (!cur) return;
      cur.text += c;
      if (c.trim()) {
        sizeSum += size;
        count++;
        if (font.isBold() || /bold|black|heavy|semibold/i.test(font.getName())) boldCount++;
      }
    },
    endLine() {
      if (cur && cur.text.trim()) {
        cur.size = count ? sizeSum / count : 0;
        cur.bold = count > 0 && boldCount / count > 0.8;
        blocks[cur.block].lines.push(lines.length);
        lines.push(cur);
      }
      cur = null;
    },
  });
  st.destroy();
  // Pieces of one visual line (a bullet and its text, words in different fonts) can come out as
  // separate lines: join pieces of a block that sit side by side on the same baseline.
  const merged: Line[] = [];
  for (const b of blocks) {
    const ls = b.lines.map((i) => lines[i]);
    const out: Line[] = [];
    for (const l of ls) {
      const h = l.bbox[3] - l.bbox[1];
      const same = out.find((o) => {
        const ov = Math.min(o.bbox[3], l.bbox[3]) - Math.max(o.bbox[1], l.bbox[1]);
        const gap = l.bbox[0] >= o.bbox[0] ? l.bbox[0] - o.bbox[2] : o.bbox[0] - l.bbox[2];
        return ov > 0.5 * Math.min(h, o.bbox[3] - o.bbox[1]) && gap < 3 * Math.max(l.size, o.size, 6);
      });
      if (same) {
        const first = l.bbox[0] < same.bbox[0];
        const w1 = same.text.trim().length, w2 = l.text.trim().length;
        same.text = first ? `${l.text.trimEnd()} ${same.text.trimStart()}` : `${same.text.trimEnd()} ${l.text.trimStart()}`;
        same.size = (same.size * w1 + l.size * w2) / Math.max(1, w1 + w2);
        same.bold = same.bold && l.bold;
        same.bbox = [Math.min(same.bbox[0], l.bbox[0]), Math.min(same.bbox[1], l.bbox[1]), Math.max(same.bbox[2], l.bbox[2]), Math.max(same.bbox[3], l.bbox[3])];
      } else out.push({ ...l, bbox: [...l.bbox] });
    }
    b.lines = out.map((l) => {
      merged.push(l);
      return merged.length - 1;
    });
  }
  return { lines: merged, blocks: blocks.filter((b) => b.lines.length), tables: findTables(page), width: x1 - x0, height: y1 - y0 };
}

/** Ruled tables: connected grids of horizontal and vertical lines with at least 2×2 cells. */
function findTables(page: mupdf.Page): Table[] {
  const h: number[][] = [], v: number[][] = [];
  const noStroke = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 });
  const addRect = (b: number[], box: boolean) => {
    const w = b[2] - b[0], ht = b[3] - b[1];
    if (ht <= 3 && w > 8) h.push([b[0], (b[1] + b[3]) / 2, b[2]]);
    else if (w <= 3 && ht > 8) v.push([(b[0] + b[2]) / 2, b[1], b[3]]);
    else if (box && w > 8 && ht > 8) {
      h.push([b[0], b[1], b[2]], [b[0], b[3], b[2]]);
      v.push([b[0], b[1], b[3]], [b[2], b[1], b[3]]);
    }
  };
  const dev = new mupdf.Device({
    strokePath(path, _stroke, ctm) {
      // Split into straight segments so a grid drawn as one path still counts.
      let start: number[] | null = null, last: number[] | null = null, curves = false;
      const segs: number[][] = [];
      path.walk({
        moveTo: (x, y) => ((start = last = [x, y])),
        lineTo: (x, y) => {
          if (last) segs.push([...last, x, y]);
          last = [x, y];
        },
        curveTo: () => (curves = true),
        closePath: () => {
          if (start && last) segs.push([...last, ...start]);
          last = start;
        },
      });
      if (curves) return;
      for (const s of segs) {
        const p = tp(ctm, s[0], s[1]);
        const q = tp(ctm, s[2], s[3]);
        addRect([Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])], false);
      }
    },
    fillPath(path, _eo, ctm, _cs, color) {
      const b = Array.from(path.getBounds(noStroke, ctm));
      // Thin dark fills are rules; light fills are cell shading, not lines.
      const dark = color.length ? color.reduce((s, x) => s + x, 0) / color.length < 0.7 || color.length === 4 : true;
      if (dark) addRect(b, false);
    },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
  } finally {
    dev.close();
  }
  // Group lines that touch into grids.
  const all = [...h.map((l) => ({ h: true, l })), ...v.map((l) => ({ h: false, l }))];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tol = 2.5;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.h === b.h) continue;
      const [hh, vv] = a.h ? [a.l, b.l] : [b.l, a.l];
      if (vv[0] >= hh[0] - tol && vv[0] <= hh[2] + tol && hh[1] >= vv[1] - tol && hh[1] <= vv[2] + tol) parent[find(i)] = find(j);
    }
  const groups = new Map<number, typeof all>();
  all.forEach((x, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), x]));
  const tables: Table[] = [];
  const uniq = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of s) if (!out.length || x - out[out.length - 1] > 3) out.push(x);
    return out;
  };
  for (const g of groups.values()) {
    const ys = uniq(g.filter((x) => x.h).map((x) => x.l[1]));
    const xs = uniq(g.filter((x) => !x.h).map((x) => x.l[0]));
    if (ys.length < 3 || xs.length < 3) continue;
    const cells: Cell[] = [];
    for (let r = 0; r + 1 < ys.length; r++) for (let c = 0; c + 1 < xs.length; c++) cells.push({ rect: [xs[c], ys[r], xs[c + 1], ys[r + 1]], row: r, col: c });
    tables.push({ rect: [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]], rows: ys.length - 1, cols: xs.length - 1, cells });
  }
  return tables;
}

function tp(m: number[] | mupdf.Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

type Role = "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "P" | "LI" | "TD" | "TH" | "Artifact";

/** A unit that becomes one structure element: a run of lines with one role. */
interface Segment {
  role: Role;
  lines: number[];
  /** For list items: which list (consecutive items share it). */
  list?: number;
  /** For table cells. */
  table?: number;
  row?: number;
  col?: number;
  order: number;
  top: number;
}

const inside = (p: number[], r: number[], pad = 1) => p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad;
const center = (r: number[]) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

function classify(pages: PageInfo[]): Segment[][] {
  // Body text size: the size most characters are set in.
  const hist = new Map<number, number>();
  for (const p of pages) for (const l of p.lines) hist.set(Math.round(l.size * 2) / 2, (hist.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.trim().length);
  const body = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  // Running headers and footers: short lines in the top/bottom margin that repeat (digits ignored) or are page numbers.
  const marginKey = (p: PageInfo, l: Line) => (l.bbox[3] < p.height * 0.08 || l.bbox[1] > p.height * 0.92 ? l.text.trim().replace(/\d+/g, "#").toLowerCase() : null);
  const keyCount = new Map<string, number>();
  for (const p of pages) for (const k of new Set(p.lines.map((l) => marginKey(p, l)).filter((k): k is string => !!k))) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  const isRunning = (p: PageInfo, l: Line) => {
    const k = marginKey(p, l);
    return !!k && ((pages.length > 1 && (keyCount.get(k) ?? 0) >= 2) || /^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–]\s*#\s*[-–]$/.test(k));
  };

  // Heading levels by size rank.
  const blockSize = (p: PageInfo, b: Block) => Math.max(...b.lines.map((i) => p.lines[i].size));
  const headingSizes = new Set<number>();
  const isHeadingBlock = (p: PageInfo, b: Block) => {
    const text = b.lines.map((i) => p.lines[i].text).join(" ").trim();
    if (text.length > 200 || b.lines.length > 3 || !/\p{L}/u.test(text)) return null;
    const size = blockSize(p, b);
    if (size >= body * 1.2) return { size: Math.round(size) };
    if (b.lines.every((i) => p.lines[i].bold) && size >= body * 0.95 && b.lines.length === 1 && text.length < 90 && !/[.,;:]$/.test(text) && !BULLET.test(text)) return { size: 0 };
    return null;
  };
  for (const p of pages) for (const b of p.blocks) {
    const h = isHeadingBlock(p, b);
    if (h && h.size) headingSizes.add(h.size);
  }
  const ranked = [...headingSizes].sort((a, b) => b - a);
  const levelOf = (size: number): Role => (`H${Math.min(6, size ? ranked.indexOf(size) + 1 : ranked.length + 1)}`) as Role;

  let listId = 0;
  return pages.map((p) => {
    const segs: Segment[] = [];
    let order = 0;
    const lineTable = new Map<number, { t: number; cell: Cell }>();
    p.lines.forEach((l, i) => {
      const c = center(l.bbox);
      p.tables.forEach((t, ti) => {
        if (!inside(c, t.rect)) return;
        const cell = t.cells.find((x) => inside(c, x.rect, 0.5));
        if (cell) lineTable.set(i, { t: ti, cell });
      });
    });
    const tablesSeen = new Set<number>();
    let lastWasList = false;
    for (const b of p.blocks) {
      const free = b.lines.filter((i) => !lineTable.has(i));
      // Table cells: one segment per cell, in row order, at the table's place in the reading order.
      for (const i of b.lines) {
        const tc = lineTable.get(i);
        if (!tc || tablesSeen.has(tc.t)) continue;
        tablesSeen.add(tc.t);
        for (const cell of p.tables[tc.t].cells) segs.push({ role: cell.row === 0 ? "TH" : "TD", lines: [], table: tc.t, row: cell.row, col: cell.col, order: order++, top: cell.rect[1] });
      }
      if (!free.length) continue;
      const running = free.filter((i) => isRunning(p, p.lines[i]));
      if (running.length) segs.push({ role: "Artifact", lines: running, order: order++, top: p.lines[running[0]].bbox[1] });
      const rest = free.filter((i) => !running.includes(i));
      if (!rest.length) continue;
      const sub: Block = { bbox: b.bbox, lines: rest };
      const h = isHeadingBlock(p, sub);
      if (h) {
        segs.push({ role: levelOf(h.size), lines: rest, order: order++, top: p.lines[rest[0]].bbox[1] });
        lastWasList = false;
        continue;
      }
      if (BULLET.test(p.lines[rest[0]].text)) {
        if (!lastWasList) listId++;
        let item: Segment | null = null;
        for (const i of rest) {
          if (!item || BULLET.test(p.lines[i].text)) {
            item = { role: "LI", lines: [], list: listId, order: order++, top: p.lines[i].bbox[1] };
            segs.push(item);
          }
          item.lines.push(i);
        }
        lastWasList = true;
        continue;
      }
      lastWasList = false;
      segs.push({ role: "P", lines: rest, order: order++, top: p.lines[rest[0]].bbox[1] });
    }
    return segs;
  });
}

// ---------------------------------------------------------------------------------------------
// Content stream lexer

interface Tok { s: number; e: number; kind: "num" | "name" | "str" | "hex" | "arr" | "dict" | "kw" }
interface Op { op: string; args: Tok[]; s: number; e: number }

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

function lex(src: string): Op[] {
  const ops: Op[] = [];
  let args: Tok[] = [];
  let i = 0;
  const n = src.length;
  const skipString = (k: number) => {
    let depth = 0;
    for (; k < n; k++) {
      const c = src[k];
      if (c === "\\") k++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return k + 1;
    }
    return n;
  };
  // Skip a balanced [...] or <<...>> including nested strings.
  const skipNested = (k: number, open: string, close: string) => {
    let depth = 0;
    while (k < n) {
      if (src.startsWith(open, k)) {
        depth++;
        k += open.length;
      } else if (src.startsWith(close, k)) {
        depth--;
        k += close.length;
        if (depth === 0) return k;
      } else if (src[k] === "(") k = skipString(k);
      else if (src[k] === "%") while (k < n && src[k] !== "\n" && src[k] !== "\r") k++;
      else k++;
    }
    return n;
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (WS.has(c)) {
      i++;
      continue;
    }
    const ch = src[i];
    if (ch === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (ch === "(") {
      const e = skipString(i);
      args.push({ s: i, e, kind: "str" });
      i = e;
    } else if (ch === "<" && src[i + 1] === "<") {
      const e = skipNested(i, "<<", ">>");
      args.push({ s: i, e, kind: "dict" });
      i = e;
    } else if (ch === "<") {
      const e = src.indexOf(">", i) + 1 || n;
      args.push({ s: i, e, kind: "hex" });
      i = e;
    } else if (ch === "[") {
      const e = skipNested(i, "[", "]");
      args.push({ s: i, e, kind: "arr" });
      i = e;
    } else if (ch === "/") {
      let e = i + 1;
      while (e < n && !WS.has(src.charCodeAt(e)) && !DELIM.has(src.charCodeAt(e))) e++;
      args.push({ s: i, e, kind: "name" });
      i = e;
    } else if (ch === "]" || ch === ">" || ch === ")" || ch === "{" || ch === "}") {
      i++; // stray delimiter: ignore
    } else {
      let e = i;
      while (e < n && !WS.has(src.charCodeAt(e)) && !DELIM.has(src.charCodeAt(e))) e++;
      const word = src.slice(i, e);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) args.push({ s: i, e, kind: "num" });
      else if (word === "true" || word === "false" || word === "null") args.push({ s: i, e, kind: "kw" });
      else if (word === "BI") {
        // Inline image: BI <dict> ID <binary> EI
        const id = src.indexOf("ID", e);
        let k = id + 3;
        let end = n;
        while (k < n) {
          const ei = src.indexOf("EI", k);
          if (ei < 0) break;
          if (WS.has(src.charCodeAt(ei - 1)) && (ei + 2 >= n || WS.has(src.charCodeAt(ei + 2)))) {
            end = ei + 2;
            break;
          }
          k = ei + 2;
        }
        ops.push({ op: "BI", args: [], s: args[0]?.s ?? i, e: end });
        args = [];
        i = end;
        continue;
      } else {
        ops.push({ op: word, args, s: args[0]?.s ?? i, e });
        args = [];
      }
      i = e;
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Tagging

type Mat = [number, number, number, number, number, number];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID: Mat = [1, 0, 0, 1, 0, 0];
const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const SHOW_OPS = new Set(["Tj", "TJ", "'", '"']);

interface Elem { role: string; mcids: number[]; page: number; seg?: Segment; rect?: number[]; obj?: mupdf.PDFObject; annot?: mupdf.PDFObject; top: number; order: number }

function stripStructure(doc: mupdf.PDFDocument) {
  const root = doc.getTrailer().get("Root");
  root.delete("StructTreeRoot");
  for (let i = 0; i < doc.countPages(); i++) {
    const p = doc.findPage(i) as mupdf.PDFObject;
    p.delete("StructParents");
    const annots = p.get("Annots");
    if (annots.isArray()) for (let k = 0; k < annots.length; k++) annots.get(k).delete("StructParent");
  }
}

function contentOf(pageObj: mupdf.PDFObject): string {
  const c = pageObj.get("Contents");
  const parts: mupdf.PDFObject[] = c.isArray() ? Array.from({ length: c.length }, (_, k) => c.get(k)) : c.isNull() ? [] : [c];
  return parts
    .filter((x) => x.isStream())
    .map((x) => new TextDecoder("latin1").decode(x.readStream().asUint8Array()))
    .join("\n");
}

const latin1 = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
const num = (src: string, t: Tok | undefined) => (t && t.kind === "num" ? parseFloat(src.slice(t.s, t.e)) : 0);

export function isTagged(doc: mupdf.PDFDocument): boolean {
  const root = doc.getTrailer().get("Root");
  const mi = root.get("MarkInfo");
  return root.get("StructTreeRoot").isDictionary() && mi.isDictionary() && mi.get("Marked").isBoolean() && mi.get("Marked").asBoolean();
}

/** Tag the document. Returns what was found. */
export function autoTag(doc: mupdf.PDFDocument, o: TagOptions = {}): TagReport {
  const root = doc.getTrailer().get("Root");
  if (isTagged(doc) && !o.retag) throw new Error("This document is already tagged. Choose Re-tag to replace its tags.");
  stripStructure(doc);

  const count = doc.countPages();
  const infos: PageInfo[] = [];
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    try {
      infos.push(readPage(page));
    } finally {
      page.destroy();
    }
  }
  const segsByPage = classify(infos);
  const report: TagReport = { pages: count, headings: 0, paragraphs: 0, lists: 0, tables: 0, figures: 0, links: 0, fields: 0, artifacts: 0 };
  const pageElems: Elem[][] = [];

  for (let pi = 0; pi < count; pi++) {
    const page = doc.loadPage(pi) as mupdf.PDFPage;
    const pageObj = page.getObject();
    const toDisplay = page.getTransform() as unknown as Mat;
    const info = infos[pi];
    const segs = segsByPage[pi];
    const segOfLine = new Map<number, Segment>();
    for (const s of segs) for (const l of s.lines) segOfLine.set(l, s);
    const elems: Elem[] = [];
    const elemOfSeg = new Map<Segment, Elem>();
    const elemFor = (s: Segment) => {
      let e = elemOfSeg.get(s);
      if (!e) {
        e = { role: s.role, mcids: [], page: pi, seg: s, top: s.top, order: s.order };
        elemOfSeg.set(s, e);
        elems.push(e);
      }
      return e;
    };
    const cellSegs = segs.filter((x) => x.table !== undefined);
    const cellAt = (pt: number[]): Segment | null => {
      for (const c of cellSegs) {
        const cell = info.tables[c.table!].cells.find((x) => x.row === c.row && x.col === c.col)!;
        if (inside(pt, cell.rect, 0.5)) return c;
      }
      return null;
    };
    const lineAt = (pt: number[]): number => {
      let best = -1, bestD = 1e9;
      info.lines.forEach((l, i) => {
        if (inside(pt, l.bbox, 1.5)) {
          const d = Math.abs(pt[1] - l.bbox[3]);
          if (d < bestD) (bestD = d), (best = i);
        }
      });
      if (best >= 0) return best;
      info.lines.forEach((l, i) => {
        const d = Math.hypot(Math.max(l.bbox[0] - pt[0], 0, pt[0] - l.bbox[2]), Math.max(l.bbox[1] - pt[1], 0, pt[1] - l.bbox[3]));
        if (d < bestD) (bestD = d), (best = i);
      });
      return bestD < 24 ? best : -1;
    };

    const resources = pageObj.getInheritable("Resources");
    const xobjects = resources.isDictionary() ? resources.get("XObject") : null;

    const src = contentOf(pageObj);
    const ops = lex(src);
    const out: string[] = [];
    let pos = 0;
    let mcid = 0;
    // Currently open marked content we inserted.
    let open: null | { kind: "seg"; seg: Segment | null } | { kind: "artifact" } | { kind: "figure" } = null;
    const emit = (at: number, text: string) => {
      out.push(src.slice(pos, at), text);
      pos = at;
    };
    const close = (at: number) => {
      if (open) {
        emit(at, "\nEMC\n");
        open = null;
      }
    };
    const openArtifact = (at: number) => {
      if (open?.kind === "artifact") return;
      close(at);
      emit(at, "\n/Artifact BMC\n");
      open = { kind: "artifact" };
      report.artifacts++;
    };
    const openSeg = (at: number, s: Segment | null) => {
      if (open?.kind === "seg" && open.seg === s) return;
      close(at);
      if (!s || s.role === "Artifact") {
        emit(at, "\n/Artifact BMC\n");
        open = { kind: "artifact" };
        return;
      }
      const e = elemFor(s);
      e.mcids.push(mcid);
      emit(at, `\n/${s.role === "LI" ? "LBody" : s.role} <</MCID ${mcid}>> BDC\n`);
      mcid++;
      open = { kind: "seg", seg: s };
    };

    // Graphics and text state.
    let ctm: Mat = ID;
    const stack: Mat[] = [];
    let tm: Mat = ID, tlm: Mat = ID, leading = 0, rise = 0;
    let inText = false;
    let lastSeg: Segment | null = null;
    let positioned = true;
    const keptMc: boolean[] = []; // for original BDC/BMC: true = kept (optional content), false = dropped

    const textStart = () => {
      const user = tp(mul(tm, ctm), 0, rise);
      return tp(toDisplay, user[0], user[1]);
    };
    const unitRect = (m: Mat) => {
      const pts = [tp(m, 0, 0), tp(m, 1, 0), tp(m, 0, 1), tp(m, 1, 1)].map((p) => tp(toDisplay, p[0], p[1]));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const figure = (op: Op, rect: number[]) => {
      close(op.s);
      if (rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4 || (rect[2] - rect[0]) * (rect[3] - rect[1]) > info.width * info.height * 0.95) {
        // Tiny images (bullets, rules) and full-page backgrounds are decoration.
        emit(op.s, "\n/Artifact BMC\n");
        out.push(src.slice(pos, op.e), "\nEMC\n");
        pos = op.e;
        report.artifacts++;
        return;
      }
      const e: Elem = { role: "Figure", mcids: [mcid], page: pi, rect, top: rect[1], order: -1 };
      elems.push(e);
      emit(op.s, `\n/Figure <</MCID ${mcid}>> BDC\n`);
      out.push(src.slice(pos, op.e), "\nEMC\n");
      pos = op.e;
      mcid++;
      report.figures++;
    };

    for (const op of ops) {
      const a = op.args;
      switch (op.op) {
        case "q":
          close(op.s);
          stack.push(ctm);
          break;
        case "Q":
          close(op.s);
          ctm = stack.pop() ?? ID;
          break;
        case "cm":
          ctm = mul([0, 1, 2, 3, 4, 5].map((k) => num(src, a[k])) as Mat, ctm);
          break;
        case "BT":
          close(op.s);
          inText = true;
          tm = tlm = ID;
          positioned = true;
          lastSeg = null;
          break;
        case "ET":
          close(op.s);
          inText = false;
          break;
        case "BDC":
        case "BMC": {
          const tag = a[0] ? src.slice(a[0].s, a[0].e) : "";
          const keep = tag === "/OC";
          keptMc.push(keep);
          if (keep) close(op.s);
          else {
            // Drop the old marker (we write our own).
            emit(op.s, "");
            pos = op.e;
          }
          break;
        }
        case "EMC": {
          const keep = keptMc.pop() ?? false;
          if (keep) close(op.s);
          else {
            emit(op.s, "");
            pos = op.e;
          }
          break;
        }
        case "Tf":
          break;
        case "TL":
          leading = num(src, a[0]);
          break;
        case "Ts":
          rise = num(src, a[0]);
          break;
        case "Td":
          tlm = mul([1, 0, 0, 1, num(src, a[0]), num(src, a[1])], tlm);
          tm = tlm;
          positioned = true;
          break;
        case "TD":
          leading = -num(src, a[1]);
          tlm = mul([1, 0, 0, 1, num(src, a[0]), num(src, a[1])], tlm);
          tm = tlm;
          positioned = true;
          break;
        case "Tm":
          tlm = tm = [0, 1, 2, 3, 4, 5].map((k) => num(src, a[k])) as Mat;
          positioned = true;
          break;
        case "T*":
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
          positioned = true;
          break;
        case "Tj":
        case "TJ":
        case "'":
        case '"': {
          if (op.op === "'" || op.op === '"') {
            tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
            tm = tlm;
            positioned = true;
          }
          let seg: Segment | null = lastSeg;
          if (positioned || !seg) {
            const at = textStart();
            const cell = cellAt(at);
            const li = cell ? -1 : lineAt(at);
            seg = cell ?? (li >= 0 ? segOfLine.get(li) ?? null : null);
            // Invisible OCR text and stray glyphs with no matching line: keep with the previous run.
            if (!seg && lastSeg) seg = lastSeg;
          }
          openSeg(op.s, seg);
          lastSeg = seg;
          positioned = false;
          break;
        }
        case "Do": {
          const name = a[0] ? src.slice(a[0].s + 1, a[0].e) : "";
          const xo = xobjects?.isDictionary() ? xobjects.get(name) : null;
          const subtype = xo?.isDictionary() || xo?.isStream() ? xo.get("Subtype").asName() : "";
          if (subtype === "Image") figure(op, unitRect(ctm));
          else {
            // Form XObject: belongs to the text it overlaps, else decoration.
            let rect = unitRect(ctm);
            const bb = xo?.get("BBox");
            if (bb?.isArray()) {
              const mm = xo!.get("Matrix");
              const fm: Mat = mm.isArray() ? ([0, 1, 2, 3, 4, 5].map((k) => mm.get(k).asNumber()) as Mat) : ID;
              const full = mul(fm, ctm);
              const b = [0, 1, 2, 3].map((k) => bb.get(k).asNumber());
              const pts = [tp(full, b[0], b[1]), tp(full, b[2], b[1]), tp(full, b[0], b[3]), tp(full, b[2], b[3])].map((p) => tp(toDisplay, p[0], p[1]));
              rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
            }
            const li = info.lines.findIndex((l) => inside(center(l.bbox), rect));
            const seg = li >= 0 ? segOfLine.get(li) ?? null : null;
            if (seg) {
              close(op.s);
              openSeg(op.s, seg);
              close(op.e);
            } else {
              close(op.s);
              openArtifact(op.s);
              close(op.e);
            }
          }
          break;
        }
        case "BI":
          figure(op, unitRect(ctm));
          break;
        case "sh":
          if (!inText) {
            openArtifact(op.s);
            close(op.e);
          }
          break;
        default:
          if (PATH_OPS.has(op.op) && !inText) openArtifact(op.s);
          else if (PAINT_OPS.has(op.op) && !inText) close(op.e);
      }
    }
    close(src.length);
    out.push(src.slice(pos));
    const newContent = out.join("");
    const stream = doc.addStream(latin1(newContent), doc.newDictionary());
    pageObj.put("Contents", stream);
    page.destroy();

    // Links and form fields on the page.
    const annots = pageObj.get("Annots");
    if (annots.isArray()) {
      const pg = doc.loadPage(pi) as mupdf.PDFPage;
      const tf = pg.getTransform() as unknown as Mat;
      pg.destroy();
      for (let k = 0; k < annots.length; k++) {
        const an = annots.get(k);
        const sub = an.get("Subtype").asName();
        if (sub !== "Link" && sub !== "Widget") continue;
        const r = an.get("Rect");
        const rr = r.isArray() ? [0, 1, 2, 3].map((x) => r.get(x).asNumber()) : [0, 0, 0, 0];
        const p1 = tp(tf, rr[0], rr[1]), p2 = tp(tf, rr[2], rr[3]);
        const top = Math.min(p1[1], p2[1]);
        elems.push({ role: sub === "Link" ? "Link" : "Form", mcids: [], page: pi, annot: an, top, order: -1 });
        if (sub === "Link") report.links++;
        else report.fields++;
      }
      pageObj.put("Tabs", doc.newName("S"));
    }
    pageElems.push(elems);
  }

  // ----- structure tree -----
  const treeRoot = doc.addObject(doc.newDictionary());
  treeRoot.put("Type", doc.newName("StructTreeRoot"));
  const docElem = doc.addObject(doc.newDictionary());
  docElem.put("Type", doc.newName("StructElem"));
  docElem.put("S", doc.newName("Document"));
  docElem.put("P", treeRoot);
  const docKids = doc.newArray();
  docElem.put("K", docKids);
  treeRoot.put("K", docElem);
  const nums = doc.newArray();
  let nextKey = count;
  const annotEntries: [number, mupdf.PDFObject][] = [];
  let firstHeading = "";

  const mkElem = (role: string, parent: mupdf.PDFObject, pageRef: mupdf.PDFObject | null) => {
    const e = doc.addObject(doc.newDictionary());
    e.put("Type", doc.newName("StructElem"));
    e.put("S", doc.newName(role));
    e.put("P", parent);
    if (pageRef) e.put("Pg", pageRef);
    return e;
  };

  for (let pi = 0; pi < count; pi++) {
    const pageRef = doc.findPage(pi) as mupdf.PDFObject;
    pageRef.put("StructParents", pi);
    const elems = pageElems[pi];
    // Every table cell gets an element, even empty ones, so rows line up for screen readers.
    const haveSeg = new Set(elems.map((e) => e.seg));
    for (const sg of segsByPage[pi]) if (sg.table !== undefined && !haveSeg.has(sg)) elems.push({ role: sg.role, mcids: [], page: pi, seg: sg, top: sg.top, order: sg.order });
    // Reading order: text in extraction order; figures and annotations slotted in by position.
    const text = elems.filter((e) => e.order >= 0).sort((a, b) => a.order - b.order);
    const others = elems.filter((e) => e.order < 0).sort((a, b) => a.top - b.top);
    const ordered: Elem[] = [];
    let oi = 0;
    for (const t of text) {
      while (oi < others.length && others[oi].top < t.top - 2) ordered.push(others[oi++]);
      ordered.push(t);
    }
    while (oi < others.length) ordered.push(others[oi++]);

    const parentArr: (mupdf.PDFObject | null)[] = [];
    let currentList: { id: number; obj: mupdf.PDFObject } | null = null;
    const tableObjs = new Map<number, { table: mupdf.PDFObject; rows: Map<number, mupdf.PDFObject> }>();
    const info = infos[pi];
    for (const e of ordered) {
      if (!e.mcids.length && !e.annot && !(e.seg && e.seg.table !== undefined)) continue;
      let parent = docElem;
      let role = e.role;
      if (e.seg?.role === "LI") {
        if (!currentList || currentList.id !== e.seg.list) {
          const l = mkElem("L", docElem, null);
          l.put("K", doc.newArray());
          docKids.push(l);
          currentList = { id: e.seg.list!, obj: l };
          report.lists++;
        }
        const li = mkElem("LI", currentList.obj, null);
        li.put("K", doc.newArray());
        currentList.obj.get("K").push(li);
        parent = li;
        role = "LBody";
      } else currentList = null;
      if (e.seg && (e.seg.role === "TD" || e.seg.role === "TH")) {
        let t = tableObjs.get(e.seg.table!);
        if (!t) {
          const tb = mkElem("Table", docElem, null);
          tb.put("K", doc.newArray());
          docKids.push(tb);
          t = { table: tb, rows: new Map() };
          tableObjs.set(e.seg.table!, t);
          report.tables++;
        }
        let row = t.rows.get(e.seg.row!);
        if (!row) {
          row = mkElem("TR", t.table, null);
          row.put("K", doc.newArray());
          t.table.get("K").push(row);
          t.rows.set(e.seg.row!, row);
        }
        parent = row;
      }
      const obj = mkElem(role, parent, pageRef);
      if (role === "TH") {
        const a = doc.newDictionary();
        a.put("O", doc.newName("Table"));
        a.put("Scope", doc.newName("Column"));
        obj.put("A", a);
      }
      if (e.role === "Figure") {
        obj.put("Alt", doc.newString(""));
        const a = doc.newDictionary();
        a.put("O", doc.newName("Layout"));
        a.put("BBox", toUserRect(doc, pi, e.rect!));
        a.put("Placement", doc.newName("Block"));
        obj.put("A", a);
      }
      if (e.annot) {
        const objr = doc.newDictionary();
        objr.put("Type", doc.newName("OBJR"));
        objr.put("Obj", e.annot);
        objr.put("Pg", pageRef);
        obj.put("K", objr);
        e.annot.put("StructParent", nextKey);
        annotEntries.push([nextKey++, obj]);
        if (e.role === "Link") {
          const c = e.annot.get("Contents");
          if (!c.isString() || !c.asString()) e.annot.put("Contents", doc.newString(linkText(info, e.annot, pi, doc) || "Link"));
        }
      } else {
        const k = doc.newArray();
        for (const m of e.mcids) {
          k.push(m);
          parentArr[m] = obj;
        }
        obj.put("K", e.mcids.length === 1 ? e.mcids[0] : k);
      }
      if (parent === docElem) docKids.push(obj);
      else parent.get("K").push(obj);
      if (/^H\d$/.test(role)) {
        report.headings++;
        if (!firstHeading && e.seg) firstHeading = e.seg.lines.map((i) => info.lines[i].text.trim()).join(" ");
      } else if (role === "P") report.paragraphs++;
    }
    nums.push(pi);
    const arr = doc.newArray();
    for (let m = 0; m < parentArr.length; m++) arr.push(parentArr[m] ?? doc.newNull());
    nums.push(arr);
  }
  for (const [k, obj] of annotEntries) {
    nums.push(k);
    nums.push(obj);
  }
  const pt = doc.newDictionary();
  pt.put("Nums", nums);
  treeRoot.put("ParentTree", doc.addObject(pt));
  treeRoot.put("ParentTreeNextKey", nextKey);
  root.put("StructTreeRoot", treeRoot);

  const mi = doc.newDictionary();
  mi.put("Marked", true);
  root.put("MarkInfo", mi);
  if (o.lang) root.put("Lang", doc.newString(o.lang));
  else if (!root.get("Lang").isString()) root.put("Lang", doc.newString("en-US"));
  let vp = root.get("ViewerPreferences");
  if (!vp.isDictionary()) {
    vp = doc.newDictionary();
    root.put("ViewerPreferences", vp);
  }
  vp.put("DisplayDocTitle", true);
  const infoDict = doc.getTrailer().get("Info");
  const title = infoDict.isDictionary() ? infoDict.get("Title") : null;
  if ((!title || !title.isString() || !title.asString().trim()) && firstHeading) doc.setMetaData("info:Title", firstHeading.slice(0, 200));
  return report;
}

function toUserRect(doc: mupdf.PDFDocument, pi: number, r: number[]): number[] {
  const page = doc.loadPage(pi) as mupdf.PDFPage;
  try {
    const inv = mupdf.Matrix.invert(page.getTransform()) as unknown as Mat;
    const a = tp(inv, r[0], r[1]), b = tp(inv, r[2], r[3]);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((v) => +v.toFixed(2));
  } finally {
    page.destroy();
  }
}

/** Text under a link, used as its description when it has none. */
function linkText(info: PageInfo, annot: mupdf.PDFObject, pi: number, doc: mupdf.PDFDocument): string {
  const r = annot.get("Rect");
  if (!r.isArray()) return "";
  const page = doc.loadPage(pi) as mupdf.PDFPage;
  const tf = page.getTransform() as unknown as Mat;
  page.destroy();
  const a = tp(tf, r.get(0).asNumber(), r.get(1).asNumber()), b = tp(tf, r.get(2).asNumber(), r.get(3).asNumber());
  const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  return info.lines.filter((l) => inside(center(l.bbox), rect, 2)).map((l) => l.text.trim()).join(" ").slice(0, 200);
}

// ---------------------------------------------------------------------------------------------
// Figures and alt text

function walkElems(doc: mupdf.PDFDocument, fn: (e: mupdf.PDFObject) => void) {
  const tr = doc.getTrailer().get("Root").get("StructTreeRoot");
  if (!tr.isDictionary()) return;
  const seen = new Set<number>();
  const visit = (k: mupdf.PDFObject, depth: number) => {
    if (depth > 64 || !k || k.isNull()) return;
    if (k.isArray()) {
      for (let i = 0; i < k.length; i++) visit(k.get(i), depth + 1);
      return;
    }
    if (!k.isDictionary()) return;
    if (k.isIndirect()) {
      if (seen.has(k.asIndirect())) return;
      seen.add(k.asIndirect());
    }
    if (k.get("S").isName()) fn(k);
    visit(k.get("K"), depth + 1);
  };
  visit(tr.get("K"), 0);
}

export function listFigures(doc: mupdf.PDFDocument): FigureInfo[] {
  const pageNums = new Map<number, number>();
  for (let i = 0; i < doc.countPages(); i++) pageNums.set((doc.findPage(i) as mupdf.PDFObject).asIndirect(), i);
  const out: FigureInfo[] = [];
  walkElems(doc, (e) => {
    if (e.get("S").asName() !== "Figure" || !e.isIndirect()) return;
    const pg = e.get("Pg");
    const page = pg.isIndirect() ? pageNums.get(pg.asIndirect()) ?? 0 : 0;
    const bb = e.get("A").isDictionary() ? e.get("A").get("BBox") : null;
    let rect = [0, 0, 0, 0];
    if (bb?.isArray()) {
      const p = doc.loadPage(page) as mupdf.PDFPage;
      const tf = p.getTransform() as unknown as Mat;
      p.destroy();
      const a = tp(tf, bb.get(0).asNumber(), bb.get(1).asNumber()), b = tp(tf, bb.get(2).asNumber(), bb.get(3).asNumber());
      rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    }
    const alt = e.get("Alt");
    out.push({ key: e.asIndirect(), page, rect, alt: alt.isString() ? alt.asString() : "" });
  });
  return out;
}

/**
 * Describe a figure, or mark it decorative (alt === null): then it becomes an artifact that
 * screen readers skip, and leaves the structure tree.
 */
export function setFigureAlt(doc: mupdf.PDFDocument, key: number, alt: string | null) {
  const e = doc.newIndirect(key);
  if (e.get("S").asName() !== "Figure") throw new Error("Not a figure");
  if (alt !== null) {
    e.put("Alt", doc.newString(alt));
    return;
  }
  // Decorative: rewrite its marked content as an artifact.
  const mcid = e.get("K").isNumber() ? e.get("K").asNumber() : -1;
  const pg = e.get("Pg");
  if (mcid >= 0 && pg.isDictionary()) {
    const c = pg.get("Contents");
    if (c.isStream()) {
      const src = new TextDecoder("latin1").decode(c.readStream().asUint8Array());
      const marker = `/Figure <</MCID ${mcid}>> BDC`;
      if (src.includes(marker)) c.writeStream(latin1(src.replace(marker, "/Artifact BMC")));
    }
    const sp = pg.get("StructParents");
    const tree = doc.getTrailer().get("Root").get("StructTreeRoot").get("ParentTree").get("Nums");
    if (sp.isNumber() && tree.isArray()) {
      for (let i = 0; i + 1 < tree.length; i += 2) {
        if (tree.get(i).asNumber() === sp.asNumber()) {
          const arr = tree.get(i + 1);
          if (arr.isArray() && mcid < arr.length) arr.put(mcid, doc.newNull());
        }
      }
    }
  }
  // Unlink from parent.
  const parent = e.get("P");
  const k = parent.get("K");
  if (k.isArray()) {
    for (let i = k.length - 1; i >= 0; i--) if (k.get(i).isIndirect() && k.get(i).asIndirect() === key) k.delete(i);
  } else if (k.isIndirect() && k.asIndirect() === key) parent.delete("K");
}

/** Outline of the tags, for the review panel and tests: role and text, depth-first. */
export function tagOutline(doc: mupdf.PDFDocument): { role: string; depth: number }[] {
  const out: { role: string; depth: number }[] = [];
  const tr = doc.getTrailer().get("Root").get("StructTreeRoot");
  if (!tr.isDictionary()) return out;
  const visit = (k: mupdf.PDFObject, depth: number) => {
    if (depth > 64 || k.isNull()) return;
    if (k.isArray()) return void Array.from({ length: k.length }, (_, i) => visit(k.get(i), depth));
    if (!k.isDictionary() || !k.get("S").isName()) return;
    out.push({ role: k.get("S").asName(), depth });
    visit(k.get("K"), depth + 1);
  };
  visit(tr.get("K"), 0);
  return out;
}
