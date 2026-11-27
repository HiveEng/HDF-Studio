// Full-text search over the user guide. Each topic is split into sections at its ## headings, so a
// result can open the guide right at the part that answers the question.
import { plainText, slug, type Topic } from "./markdown";

export interface Section {
  topic: string;
  topicTitle: string;
  /** Heading id inside the topic ("" for the top of the topic). */
  anchor: string;
  heading: string;
  text: string;
  keywords: string[];
}

export interface Hit {
  section: Section;
  score: number;
  /** A short extract around the first match, as HTML with <mark> around matched words. */
  snippet: string;
}

/** Words people use for the same thing. Searching any of them also finds the others. */
const SYNONYMS: string[][] = [
  ["delete", "remove", "erase"],
  ["markup", "annotation", "comment"],
  ["signature", "sign", "signing"],
  ["cloud", "revision cloud"],
  ["callout", "leader", "multileader"],
  ["measure", "measurement", "dimension", "takeoff"],
  ["scale", "calibrate"],
  ["zoom", "magnify"],
  ["pan", "scroll", "move view"],
  ["ocr", "recognize", "scan", "scanned"],
  ["redact", "redaction", "black out"],
  ["365", "onedrive", "microsoft", "cloud file", "sharepoint"],
  ["shortcut", "hotkey", "keyboard", "key"],
  ["form", "field", "fillable"],
  ["password", "encrypt", "protect", "security"],
  ["merge", "combine", "join"],
  ["split", "extract", "separate"],
  ["image", "picture", "photo"],
  ["export", "convert", "save as"],
  ["select", "selection", "pick"],
  ["rotate", "turn"],
  ["undo", "revert"],
  ["stamp", "approved"],
  ["print", "plot"],
  ["batch", "recipe", "automate"],
  ["compare", "difference", "changes", "overlay"],
  ["text box", "textbox", "free text"],
];

const STOP = new Set(["a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "is", "how", "do", "i", "can", "my", "it", "with", "what", "where", "does", "you", "your", "be", "by", "at", "from"]);

/** Lower-case, accents off, simple English stemming (signs → sign, measuring → measur). */
export function stem(w: string) {
  w = w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && /(ch|sh|x|s)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*[a-z0-9]|[a-z0-9]/g) ?? [];

/** Split topics into searchable sections. */
export function buildIndex(topics: Topic[], app = "HDS", genText?: (kind: string, arg?: string) => string): Section[] {
  const out: Section[] = [];
  for (const t of topics) {
    // Generated blocks ({{ribbon:home}}, {{shortcuts}}) are searchable by the words they will show.
    const body = genText ? t.body.replace(/^\{\{([a-z]+)(?::([\w-]+))?\}\}$/gm, (m, k, a) => (k === "app" ? m : genText(k, a))) : t.body;
    const parts = body.replace(/\{\{app\}\}/g, app).split(/^##\s+/m);
    parts.forEach((part, k) => {
      const nl = part.indexOf("\n");
      const heading = k === 0 ? t.title : (nl < 0 ? part : part.slice(0, nl)).trim();
      const body = k === 0 ? part.replace(/^#\s+.*$/m, "") : nl < 0 ? "" : part.slice(nl + 1);
      out.push({
        topic: t.id,
        topicTitle: t.title,
        anchor: k === 0 ? "" : slug(heading),
        heading,
        text: plainText(body),
        keywords: k === 0 ? [...t.keywords, t.summary] : [],
      });
    });
  }
  return out;
}

/** Each query word with the words that mean the same, all stemmed. */
function expand(q: string): string[][] {
  const lower = q.toLowerCase();
  const terms = words(lower).filter((w) => !STOP.has(w));
  return terms.map((w) => {
    const s = stem(w);
    const alts = new Set([s]);
    for (const group of SYNONYMS) if (group.some((g) => g === w || stem(g) === s)) for (const g of group) for (const x of words(g)) if (!STOP.has(x)) alts.add(stem(x));
    return [...alts];
  });
}

/** How strongly a stemmed term matches a text: whole words beat prefixes. */
function termScore(alts: string[], text: string[], first: string) {
  let best = 0;
  for (const a of alts) {
    const primary = a === first;
    for (const w of text) {
      const sw = stem(w);
      let s = 0;
      if (sw === a) s = 3;
      else if (a.length >= 3 && sw.startsWith(a)) s = 2;
      else if (a.length >= 4 && sw.includes(a)) s = 1;
      if (s && !primary) s *= 0.6;
      if (s > best) best = s;
      if (best === 3) return best;
    }
  }
  return best;
}

function countHits(alts: string[], text: string[]) {
  let n = 0;
  for (const w of text) {
    const sw = stem(w);
    if (alts.some((a) => sw === a || (a.length >= 3 && sw.startsWith(a)))) n++;
  }
  return n;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A ~160-character extract around the first match, with matches marked. */
export function snippet(text: string, terms: string[][], len = 160): string {
  const all = terms.flat();
  const re = /[A-Za-z0-9][A-Za-z0-9'+.-]*/g;
  let first = -1;
  let m: RegExpExecArray | null;
  const marks: [number, number][] = [];
  while ((m = re.exec(text))) {
    const sw = stem(m[0].replace(/[.'-]+$/, ""));
    if (all.some((a) => sw === a || (a.length >= 3 && sw.startsWith(a)))) {
      if (first < 0) first = m.index;
      marks.push([m.index, m.index + m[0].length]);
    }
  }
  let start = first < 0 ? 0 : Math.max(0, first - 50);
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp > 0 && sp < first) start = sp + 1;
  }
  let end = Math.min(text.length, start + len);
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > start + 40) end = sp;
  }
  let html = "";
  let at = start;
  for (const [a, b] of marks) {
    if (a < start || b > end) continue;
    html += escHtml(text.slice(at, a)) + "<mark>" + escHtml(text.slice(a, b)) + "</mark>";
    at = b;
  }
  html += escHtml(text.slice(at, end));
  return (start > 0 ? "…" : "") + html + (end < text.length ? "…" : "");
}

/** Best matching sections, best first. Every word must match; if nothing does, any word may. */
export function search(index: Section[], query: string, limit = 30): Hit[] {
  const terms = expand(query);
  if (!terms.length) return [];
  const firsts = words(query.toLowerCase()).filter((w) => !STOP.has(w)).map(stem);
  const phrase = query.trim().toLowerCase();
  const scoreAll = (needAll: boolean) => {
    const hits: Hit[] = [];
    for (const s of index) {
      const title = words(s.heading + " " + (s.anchor ? s.topicTitle : ""));
      const kw = words(s.keywords.join(" "));
      const body = words(s.text);
      let total = 0;
      let matched = 0;
      terms.forEach((alts, k) => {
        const t = termScore(alts, title, firsts[k]) * 6;
        const w = termScore(alts, kw, firsts[k]) * 3;
        const b = Math.min(countHits(alts, body), 6) * 0.8 + termScore(alts, body, firsts[k]);
        const sc = t + w + b;
        if (sc > 0) matched++;
        total += sc;
      });
      if (needAll ? matched < terms.length : matched === 0) continue;
      if (phrase.length > 3 && (s.heading.toLowerCase().includes(phrase))) total += 20;
      else if (phrase.length > 3 && s.text.toLowerCase().includes(phrase)) total += 6;
      if (!s.anchor) total += 1; // a topic's own page edges out its sections on ties
      hits.push({ section: s, score: total, snippet: snippet(s.text || s.keywords.join(", "), terms) });
    }
    return hits;
  };
  let hits = scoreAll(true);
  if (!hits.length && terms.length > 1) hits = scoreAll(false);
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
