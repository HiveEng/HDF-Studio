// Compare two PDFs: a word-level text diff across the whole document (so text that reflows onto
// another page still lines up) plus a pixel diff of pages whose text is unchanged, which catches
// changed images, drawings, signatures and stamps. The result can be written into a copy of the
// newer file as review comments, so the normal Comments panel doubles as the list of changes.
import * as mupdf from "mupdf";
import { addAnnotation } from "./annotations";

export interface Word {
  text: string;
  page: number;
  /** Quad in page space (points, top-left origin): ul, ur, ll, lr. */
  quad: number[];
}

export type ChangeKind = "inserted" | "deleted" | "replaced" | "visual";
export interface Change {
  kind: ChangeKind;
  oldText: string;
  newText: string;
  /** Where the change is in the old and new documents. */
  oldPage: number;
  newPage: number;
  oldQuads: number[][];
  newQuads: number[][];
  /** For visual changes: the area that differs, in the new document's page space. */
  rect?: number[];
  /** For deletions: the point (top-left of the next word) in the new document where the text used to be. */
  anchor?: number[];
}

export interface CompareResult {
  changes: Change[];
  oldPages: number;
  newPages: number;
  summary: Record<ChangeKind, number>;
  /** True when the documents were too different for a word-level diff and pages were compared one by one. */
  coarse?: boolean;
}

export function words(doc: mupdf.Document): Word[] {
  const out: Word[] = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    const st = page.toStructuredText("");
    let text = "";
    let quad: number[] | null = null;
    const flush = () => {
      if (text) out.push({ text, page: p, quad: quad! });
      text = "";
      quad = null;
    };
    st.walk({
      onChar(c, _origin, _font, _size, q) {
        if (/\s/.test(c)) return flush();
        const qq = Array.from(q as ArrayLike<number>);
        // Punctuation is its own token, so "weekly." vs "weekly and…" diffs on the words, not the dot.
        if (/[\p{P}\p{S}]/u.test(c) && !/[-'’@#$%&/]/.test(c)) {
          flush();
          out.push({ text: c, page: p, quad: qq });
          return;
        }
        if (!quad) quad = qq;
        else quad = [quad[0], quad[1], qq[2], qq[3], quad[4], quad[5], qq[6], qq[7]];
        text += c;
      },
      endLine: flush,
    });
    flush();
    st.destroy();
    page.destroy();
  }
  return out;
}

type Op = { op: "=" | "-" | "+"; a: number; b: number };

/** Myers' O((N+M)D) diff on token arrays. Returns null when the edit distance exceeds maxD. */
export function diff(a: string[], b: string[], maxD = 4000): Op[] | null {
  // Trim the common prefix and suffix first: typical revisions change little.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const N = A.length, M = B.length, MAX = Math.min(N + M, maxD);
  const off = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  // Keep only the diagonals each round can reach: memory grows with D², not D × (N + M).
  const trace: { lo: number; arr: Int32Array }[] = [];
  const snap = (d: number) => trace.push({ lo: Math.max(0, off - d - 1), arr: v.slice(Math.max(0, off - d - 1), off + d + 2) });
  let found = N === 0 && M === 0;
  for (let d = 0; d <= MAX && !found; d++) {
    snap(d);
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) x++, y++;
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;
  // Backtrack.
  const ops: Op[] = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const t = trace[d];
    const at = (k: number) => t.arr[off + k - t.lo];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : at(prevK), py = px - prevK;
    while (x > px && y > py) ops.push({ op: "=", a: pre + --x, b: pre + --y });
    if (d > 0) {
      if (x === px) ops.push({ op: "+", a: pre + x, b: pre + --y });
      else ops.push({ op: "-", a: pre + --x, b: pre + y });
    }
  }
  while (x > 0 && y > 0) ops.push({ op: "=", a: pre + --x, b: pre + --y });
  ops.reverse();
  const head: Op[] = Array.from({ length: pre }, (_, i) => ({ op: "=", a: i, b: i }));
  const tail: Op[] = Array.from({ length: suf }, (_, i) => ({ op: "=", a: a.length - suf + i, b: b.length - suf + i }));
  return [...head, ...ops, ...tail];
}

/**
 * Equal-cost diffs can glue an insertion and an unrelated deletion into one "replacement"
 * (e.g. "weekly[ and on demand]." next to a deleted sentence ending in "."). When a mixed run's
 * deleted (or inserted) tokens start with the same token that follows the run, slide them past it
 * so the insertion and deletion are reported separately.
 */
export function slideApart(ops: Op[], a: string[], b: string[]): Op[] {
  const out = ops.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i].op === "=") continue;
    let j = i;
    while (j < out.length && out[j].op !== "=") j++;
    const eq = out[j];
    const seg = out.slice(i, j);
    const dels = seg.filter((o) => o.op === "-"), ins = seg.filter((o) => o.op === "+");
    if (!ins.length || !dels.length) {
      // A pure insertion or deletion: slide it right while it can, so it ends on a sentence or
      // clause boundary ("4. This clause… entirely." rather than ". 4. This clause… entirely").
      const del = !ins.length;
      const tok = (o: Op) => (del ? a[o.a] : b[o.b]);
      while (j < out.length && out[j].op === "=" && tok(out[i]) === tok(out[j])) {
        const first = out[i], e = out[j];
        // The run now sits after the matched pair, so its position on the other side moves on by one.
        out[j] = del ? { op: "-", a: e.a, b: e.b + 1 } : { op: "+", a: e.a + 1, b: e.b };
        out.splice(i, 1);
        out.splice(i, 0, del ? { op: "=", a: first.a, b: e.b } : { op: "=", a: e.a, b: first.b });
        i++;
        j++;
      }
      i = j;
      continue;
    }
    if (eq && a[dels[0].a] === a[eq.a]) {
      // Match the first deleted token to the following equal one; delete one further token instead.
      const moved: Op[] = [...ins, { op: "=", a: dels[0].a, b: eq.b }, ...dels.slice(1), { op: "-", a: eq.a, b: eq.b + 1 }];
      out.splice(i, j - i + 1, ...moved);
    } else if (eq && b[ins[0].b] === b[eq.b]) {
      const moved: Op[] = [...dels, { op: "=", a: eq.a, b: ins[0].b }, ...ins.slice(1), { op: "+", a: eq.a + 1, b: eq.b }];
      out.splice(i, j - i + 1, ...moved);
    }
    i = j;
  }
  return out;
}

/** Join tokens back into readable text (no space before punctuation). */
const join = (ws: Word[]) => ws.map((w) => w.text).reduce((s, t) => (!s ? t : /^[\p{P}]$/u.test(t) && !/^[(\[{"']$/.test(t) ? s + t : s + " " + t), "");
const norm = (w: string) => w.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** Group a diff into changes; neighbouring deletes and inserts become one "replaced" change. */
function groupChanges(ow: Word[], nw: Word[], ops: Op[]): Change[] {
  const out: Change[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "=") {
      i++;
      continue;
    }
    const del: Word[] = [], ins: Word[] = [];
    const groupStart = i;
    while (i < ops.length && ops[i].op !== "=") {
      if (ops[i].op === "-") del.push(ow[ops[i].a]);
      else ins.push(nw[ops[i].b]);
      i++;
    }
    // Anchor for the side with no words: the neighbouring word, so the change can still be located.
    // Locate a deletion by its neighbours: the next unchanged word, unless that is on a later
    // page than the previous one (text deleted at the end of a page), then the previous word.
    const next = ops[i];
    const prevB = groupStart > 0 ? ops[groupStart - 1].b : -1;
    const nextW = next ? nw[next.b] : undefined, prevW = prevB >= 0 ? nw[prevB] : undefined;
    const usePrev = !!prevW && (!nextW || nextW.page !== prevW.page);
    const anchorNew = ins[0] ?? (usePrev ? prevW : nextW) ?? nw[nw.length - 1];
    const anchorOld = del[0] ?? (next ? ow[next.a] : ow[ow.length - 1]);
    out.push({
      kind: del.length && ins.length ? "replaced" : del.length ? "deleted" : "inserted",
      oldText: join(del),
      newText: join(ins),
      oldPage: anchorOld?.page ?? 0,
      newPage: anchorNew?.page ?? 0,
      oldQuads: del.map((w) => w.quad),
      newQuads: ins.map((w) => w.quad),
      anchor: ins.length || !anchorNew ? undefined : usePrev ? [anchorNew.quad[2] + 14, anchorNew.quad[3] + 18] : [anchorNew.quad[0], anchorNew.quad[1]],
    });
  }
  return out;
}

/** Regions where two renders differ, as rectangles in page space. */
export function pixelDiff(a: mupdf.Page, b: mupdf.Page, dpi = 72, cell = 6, threshold = 40): number[][] {
  const s = dpi / 72;
  const pa = a.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true);
  const pb = b.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true);
  try {
    const W = Math.min(pa.getWidth(), pb.getWidth()), H = Math.min(pa.getHeight(), pb.getHeight());
    const A = pa.getPixels(), B = pb.getPixels(), wa = pa.getWidth(), wb = pb.getWidth();
    const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
    const hot = new Uint8Array(cw * ch);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (Math.abs(A[y * wa + x] - B[y * wb + x]) > threshold) hot[((y / cell) | 0) * cw + ((x / cell) | 0)] = 1;
    // Flood-fill neighbouring hot cells (with a one-cell gap allowed) into boxes.
    const seen = new Uint8Array(cw * ch);
    const boxes: number[][] = [];
    for (let i = 0; i < hot.length; i++) {
      if (!hot[i] || seen[i]) continue;
      let x0 = cw, y0 = ch, x1 = 0, y1 = 0, n = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        const cx = j % cw, cy = (j / cw) | 0;
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); n++;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
            const k = ny * cw + nx;
            if (hot[k] && !seen[k]) (seen[k] = 1), stack.push(k);
          }
      }
      if (n >= 1) boxes.push([(x0 * cell) / s, (y0 * cell) / s, ((x1 + 1) * cell) / s, ((y1 + 1) * cell) / s]);
    }
    return boxes;
  } finally {
    pa.destroy();
    pb.destroy();
  }
}

export function compare(oldDoc: mupdf.Document, newDoc: mupdf.Document, o: { visual?: boolean } = {}): CompareResult {
  const ow = words(oldDoc), nw = words(newDoc);
  const at = ow.map((w) => norm(w.text)), bt = nw.map((w) => norm(w.text));
  let ops = diff(at, bt);
  let coarse = false;
  let changes: Change[];
  if (ops) changes = groupChanges(ow, nw, slideApart(ops, at, bt));
  else {
    // Very different documents: compare page by page so the result stays useful and fast.
    coarse = true;
    changes = [];
    const pages = Math.max(oldDoc.countPages(), newDoc.countPages());
    for (let p = 0; p < pages; p++) {
      const a = ow.filter((w) => w.page === p), b = nw.filter((w) => w.page === p);
      ops = diff(a.map((w) => norm(w.text)), b.map((w) => norm(w.text)), 2000);
      if (ops) changes.push(...groupChanges(a, b, ops));
      else if (a.length || b.length)
        changes.push({ kind: "replaced", oldText: `(page ${p + 1} rewritten)`, newText: "", oldPage: p, newPage: p, oldQuads: a.map((w) => w.quad), newQuads: b.map((w) => w.quad) });
    }
  }

  if (o.visual !== false) {
    // Pages whose text is untouched, paired in order: look for changed images and drawings.
    const changedOld = new Set(changes.map((c) => c.oldPage)), changedNew = new Set(changes.map((c) => c.newPage));
    const n = Math.min(oldDoc.countPages(), newDoc.countPages());
    for (let p = 0; p < n; p++) {
      if (changedOld.has(p) || changedNew.has(p)) continue;
      const a = oldDoc.loadPage(p), b = newDoc.loadPage(p);
      try {
        for (const rect of pixelDiff(a, b))
          changes.push({ kind: "visual", oldText: "", newText: "", oldPage: p, newPage: p, oldQuads: [], newQuads: [], rect });
      } finally {
        a.destroy();
        b.destroy();
      }
    }
  }
  const top = (c: Change) => c.newQuads[0]?.[1] ?? c.anchor?.[1] ?? c.rect?.[1] ?? 0;
  changes.sort((x, y) => x.newPage - y.newPage || top(x) - top(y));
  const summary = { inserted: 0, deleted: 0, replaced: 0, visual: 0 };
  for (const c of changes) summary[c.kind]++;
  return { changes, oldPages: oldDoc.countPages(), newPages: newDoc.countPages(), summary, coarse };
}

// Light tints of the Hive palette so highlighted text stays readable.
const COLORS = { inserted: [0.72, 0.9, 0.45], deleted: [0.9, 0.2, 0.2], replaced: [0.55, 0.88, 1], visual: [0.95, 0.6, 0.05] } as const;
const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Write the changes into the newer document as comments (author "Compare"). */
export function annotateChanges(doc: mupdf.PDFDocument, r: CompareResult, oldName: string): number {
  let n = 0;
  for (const c of r.changes) {
    const color = [...COLORS[c.kind]] as [number, number, number];
    if (c.kind === "visual") {
      addAnnotation(doc, c.newPage, { type: "Square", rect: c.rect!.map((v, i) => v + (i < 2 ? -2 : 2)), color, width: 1.5, contents: "Changed graphic or image" }, "Compare");
    } else if (c.newQuads.length) {
      const contents = c.kind === "replaced" ? `Replaced. Was: "${clip(c.oldText)}"` : `Inserted: "${clip(c.newText)}"`;
      addAnnotation(doc, c.newPage, { type: "Highlight", quads: c.newQuads, color, contents }, "Compare");
    } else {
      // Deleted text has no place in the new file: pin a note where it used to be.
      const page = doc.loadPage(c.newPage);
      const [, , pw] = page.getBounds();
      page.destroy();
      const q = c.anchor ?? c.oldQuads[0];
      // In the margin just left of the spot, between the lines, so it covers no text.
      const at: [number, number] = [Math.min(pw - 24, Math.max(0, (q?.[0] ?? 36) - 24)), Math.max(0, (q?.[1] ?? 36) - 14)];
      addAnnotation(doc, c.newPage, { type: "Text", at, color, icon: "Comment", contents: `Deleted (from ${oldName}, page ${c.oldPage + 1}): "${clip(c.oldText)}"` }, "Compare");
    }
    n++;
  }
  return n;
}
