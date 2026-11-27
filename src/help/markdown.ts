// A small Markdown dialect for the user guide. Pure functions, so the guide can be rendered and
// searched in tests without a browser.
//
//   ---                         front matter: title, section, order, keywords, context
//   # / ## / ###                headings (## and ### get ids; ## starts a searchable section)
//   **bold**  *italic*  `code`  [link](#topic) or [link](#topic/heading) or [link](https://…)
//   [[Ctrl+Shift+S]]            keys, drawn as key caps
//   - item / 1. item            lists (one level)
//   | a | b |                   tables (first row is the header)
//   ![Caption](file.png)        a figure with a caption, on a line of its own
//   > **Tip:** …                a call-out box (Tip, Note, Important, Try it)
//   {{ribbon:home}}             generated blocks, filled in by the viewer from the live app
//   {{app}}                     the application's name

export interface TopicMeta {
  id: string;
  title: string;
  section: string;
  order: number;
  keywords: string[];
  /** Ribbon tabs and tools that open this topic with F1. */
  context: string[];
  summary: string;
}

export interface Topic extends TopicMeta {
  /** Markdown body, without the front matter. */
  body: string;
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function parseTopic(id: string, src: string): Topic {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const k = line.indexOf(":");
    if (k > 0) meta[line.slice(0, k).trim()] = line.slice(k + 1).trim();
  }
  const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
  return {
    id,
    title: meta.title ?? id,
    section: meta.section ?? "Guide",
    order: Number(meta.order ?? 100),
    keywords: list(meta.keywords),
    context: list(meta.context),
    summary: meta.summary ?? "",
    body: m ? src.slice(m[0].length) : src,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface RenderOptions {
  app: string;
  /** Turns an image file name into a URL. */
  img(file: string): string;
}

/** Key caps for "Ctrl+Shift+S", "Space", "F1", "Ctrl+=". */
export function keysHtml(k: string) {
  const parts = k === "+" ? ["+"] : k.split(/\+(?!$)/);
  return `<span class="keys">${parts.map((p) => `<kbd>${esc(p)}</kbd>`).join("<span>+</span>")}</span>`;
}

export function inline(s: string, o: RenderOptions): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  t = esc(t.replace(/\{\{app\}\}/g, o.app));
  t = t
    .replace(/\[\[((?:[^\]]|\](?=\]\]))+)\]\]/g, (_, k) => keysHtml(k.replace(/&amp;/g, "&")))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      if (href.startsWith("#")) return `<a href="${href}" data-topic="${href.slice(1)}">${text}</a>`;
      return `<a href="${href}" data-external="1">${text}</a>`;
    });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const CALLOUTS: Record<string, string> = { tip: "tip", note: "note", important: "warn", warning: "warn", "try it": "try" };

/** Markdown body → HTML. */
export function renderMarkdown(body: string, o: RenderOptions): string {
  const lines = body.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), o)}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    let m: RegExpExecArray | null;
    if (!trimmed) { flush(); i++; continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(trimmed))) {
      flush();
      const n = m[1].length;
      const text = m[2].replace(/\{\{app\}\}/g, o.app);
      out.push(n === 1 ? `<h1>${inline(text, o)}</h1>` : `<h${n} id="${slug(text)}">${inline(text, o)}</h${n}>`);
      i++;
      continue;
    }
    if ((m = /^\{\{([a-z]+)(?::([\w-]+))?\}\}$/.exec(trimmed)) && m[1] !== "app") {
      flush();
      out.push(`<div class="help-gen" data-gen="${m[1]}"${m[2] ? ` data-arg="${m[2]}"` : ""}></div>`);
      i++;
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"(wide|small|plain)")?\)$/.exec(trimmed))) {
      flush();
      const cls = m[3] ? ` class="${m[3]}"` : "";
      out.push(`<figure${cls}><img src="${esc(o.img(m[2]))}" alt="${esc(m[1])}" loading="lazy" />${m[1] ? `<figcaption>${inline(m[1], o)}</figcaption>` : ""}</figure>`);
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      const block: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) block.push(lines[i++].trim().replace(/^>\s?/, ""));
      const text = block.join(" ");
      const head = /^\*\*([A-Za-z ]+):\*\*\s*/.exec(text);
      const kind = head ? CALLOUTS[head[1].toLowerCase()] ?? "note" : "note";
      out.push(`<aside class="callout ${kind}">${inline(text, o)}</aside>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flush();
      const ordered = /^\d+\./.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trim();
        if (ordered ? /^\d+\.\s+/.test(t) : /^[-*]\s+/.test(t)) items.push(t.replace(/^([-*]|\d+\.)\s+/, ""));
        else if (t && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += " " + t; // continuation
        else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x, o)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (trimmed.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...rest] = rows;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, o)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c, o)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flush();
  return out.join("\n");
}

/** Plain text of a Markdown fragment, for the search index. */
export function plainText(md: string): string {
  return md
    .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/\{\{[^}]+\}\}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[((?:[^\]]|\](?=\]\]))+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`>#|]/g, " ")
    .replace(/^\s*[-]+\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}
