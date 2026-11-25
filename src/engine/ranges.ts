/**
 * Parse a 1-based page range string into 0-based indices, in the order given.
 * Supports "1-3, 5, 8-", "-4" (first four), "last", "odd", "even", and reversed ranges "9-7".
 */
export function parseRanges(spec: string, pageCount: number): number[] {
  const out: number[] = [];
  const s = spec.trim().toLowerCase();
  if (!s || s === "all") return range(0, pageCount - 1);
  for (const raw of s.split(/[,;\s]+/).filter(Boolean)) {
    if (raw === "odd" || raw === "even") {
      for (let i = raw === "odd" ? 0 : 1; i < pageCount; i += 2) out.push(i);
      continue;
    }
    const m = raw.match(/^(\d+|last)?(?:(-)(\d+|last)?)?$/);
    if (!m || (!m[1] && !m[2])) throw new Error(`Invalid page range "${raw}"`);
    const num = (t: string | undefined, dflt: number) => (t === undefined ? dflt : t === "last" ? pageCount : parseInt(t, 10));
    const a = num(m[1], 1);
    const b = m[2] ? num(m[3], pageCount) : a;
    for (const p of [a, b]) if (p < 1 || p > pageCount) throw new Error(`Page ${p} is out of range (1-${pageCount})`);
    out.push(...range(a - 1, b - 1));
  }
  return out;
}

function range(a: number, b: number): number[] {
  const r: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) r.push(i);
  else for (let i = a; i >= b; i--) r.push(i);
  return r;
}

/** Format 0-based indices as a compact 1-based range string, e.g. [0,1,2,4] -> "1-3,5". */
export function formatRanges(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}-${pages[j] + 1}`);
    i = j + 1;
  }
  return parts.join(",");
}
