// The in-app user guide: a searchable window with a contents list, figures and screenshots.
// F1 opens it at the topic for whatever you're doing (the current ribbon tab or tool).
import { renderMarkdown, type Topic } from "../help/markdown";
import { buildIndex, search, words, stem, type Hit } from "../help/search";
import { TOPICS, SECTIONS, APP_NAME, APP_FULL_NAME, helpImage, topicForContext } from "../help/topics";
import { openExternal } from "../platform";

export interface HelpDeps {
  /** Builds a generated block ({{ribbon:home}}, {{shortcuts}}…) from the live app. */
  gen(kind: string, arg?: string): HTMLElement | null;
  /** Plain words of a generated block, for the search index. */
  genText?(kind: string, arg?: string): string;
  /** Runs an app command from a "Try it" link; the guide closes first. */
  run(cmd: string): void;
}

const LAST_KEY = "hdfstudio.helpTopic";

export function setupHelp(d: HelpDeps) {
  const index = buildIndex(TOPICS, APP_NAME, d.genText);
  const byId = new Map(TOPICS.map((t) => [t.id, t]));
  const opts = { app: APP_NAME, img: helpImage };
  const html = new Map<string, string>();
  const rendered = (t: Topic) => {
    let h = html.get(t.id);
    if (!h) html.set(t.id, (h = renderMarkdown(t.body, opts)));
    return h;
  };

  let root: HTMLElement | null = null;
  let current = "";
  const history: { id: string; anchor: string }[] = [];
  let hpos = -1;
  let hits: Hit[] = [];
  let sel = 0;

  function build() {
    const back = document.createElement("div");
    back.className = "help-back";
    back.innerHTML = `
      <div class="help-win" role="dialog" aria-modal="true" aria-label="${APP_NAME} User Guide">
        <header class="help-head">
          <div class="help-title"><span class="help-badge">?</span><b>${APP_NAME}</b> User Guide</div>
          <div class="help-nav">
            <button type="button" class="icon-btn" data-act="back" title="Back (Alt+Left)" aria-label="Back">&#8592;</button>
            <button type="button" class="icon-btn" data-act="fwd" title="Forward (Alt+Right)" aria-label="Forward">&#8594;</button>
            <button type="button" class="icon-btn" data-act="home" title="Contents" aria-label="Contents">&#8962;</button>
          </div>
          <div class="help-search">
            <input type="search" placeholder="Search the guide, e.g. callout leader, scale, redact" aria-label="Search the guide" spellcheck="false" />
          </div>
          <button type="button" data-act="print" class="help-btn" title="Print this topic (Ctrl+P)">Print</button>
          <button type="button" class="icon-btn help-close" data-act="close" title="Close (Esc)" aria-label="Close">&#10005;</button>
        </header>
        <div class="help-body">
          <nav class="help-side" aria-label="Contents"></nav>
          <article class="help-article" tabindex="0"></article>
        </div>
      </div>`;
    document.body.append(back);
    const input = back.querySelector<HTMLInputElement>(".help-search input")!;
    const side = back.querySelector<HTMLElement>(".help-side")!;
    const art = back.querySelector<HTMLElement>(".help-article")!;

    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector<HTMLElement>(".help-head")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "close") close();
      else if (act === "back") go(-1);
      else if (act === "fwd") go(1);
      else if (act === "home") show("welcome");
      else if (act === "print") print();
    });
    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => ((sel = 0), renderSide()), 90);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!hits.length) return;
        sel = (sel + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
        renderSide();
        side.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && hits[sel]) {
        e.preventDefault();
        openHit(hits[sel]);
      }
    });
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (input.value && document.activeElement === input) (input.value = ""), renderSide();
        else close();
      } else if (e.altKey && e.key === "ArrowLeft") (e.preventDefault(), go(-1));
      else if (e.altKey && e.key === "ArrowRight") (e.preventDefault(), go(1));
      else if ((e.ctrlKey && e.key.toLowerCase() === "f") || e.key === "F1") (e.preventDefault(), e.stopPropagation(), input.focus(), input.select());
      else if (e.ctrlKey && e.key.toLowerCase() === "p") (e.preventDefault(), e.stopPropagation(), print());
      e.stopPropagation(); // the app's own shortcuts stay quiet while the guide is open
    });
    art.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
      const fig = (e.target as HTMLElement).closest<HTMLElement>("figure img");
      if (fig) return zoomImage(fig as HTMLImageElement);
      if (!a) return;
      e.preventDefault();
      if (a.dataset.run) {
        close();
        d.run(a.dataset.run);
      } else if (a.dataset.topic !== undefined) {
        const [id, anchor = ""] = a.dataset.topic.split("/");
        if (!id) scrollTo(anchor);
        else show(id, anchor);
      } else if (a.dataset.external) void openExternal(a.getAttribute("href")!);
    });
    root = back;
  }

  const $ = <T extends HTMLElement>(s: string) => root!.querySelector<T>(s)!;

  function renderSide() {
    const side = $(".help-side");
    const q = $<HTMLInputElement>(".help-search input").value.trim();
    side.replaceChildren();
    if (q) {
      hits = search(index, q);
      sel = Math.min(sel, Math.max(0, hits.length - 1));
      const head = Object.assign(document.createElement("div"), { className: "help-count", textContent: hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : "No results" });
      side.append(head);
      if (!hits.length) {
        side.append(Object.assign(document.createElement("p"), { className: "help-none", textContent: "Try fewer or different words, such as “measure”, “signature” or “page numbers”. Ctrl+K in the main window also finds every command by name." }));
        return;
      }
      hits.forEach((h, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "help-hit" + (i === sel ? " sel" : "");
        const where = h.section.anchor ? `${h.section.topicTitle} › ` : "";
        b.innerHTML = `<span class="help-hit-title"></span><small class="help-hit-text">${h.snippet}</small>`;
        b.firstElementChild!.textContent = where + h.section.heading;
        b.onclick = () => ((sel = i), openHit(h));
        side.append(b);
      });
      return;
    }
    hits = [];
    for (const sec of SECTIONS) {
      const list = TOPICS.filter((t) => t.section === sec);
      if (!list.length) continue;
      side.append(Object.assign(document.createElement("div"), { className: "help-sec", textContent: sec }));
      for (const t of list) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "help-link" + (t.id === current ? " active" : "");
        b.textContent = t.title;
        b.onclick = () => show(t.id);
        side.append(b);
      }
    }
    side.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  function openHit(h: Hit) {
    const q = $<HTMLInputElement>(".help-search input").value;
    show(h.section.topic, h.section.anchor, q, false);
    root!.querySelectorAll(".help-hit").forEach((b, i) => b.classList.toggle("sel", i === sel));
  }

  function scrollTo(anchor: string) {
    const art = $(".help-article");
    const el = anchor ? art.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`) : null;
    if (el) {
      art.scrollTop = el.offsetTop - 12;
      el.classList.add("help-flash");
      setTimeout(() => el.classList.remove("help-flash"), 1200);
    } else art.scrollTop = 0;
  }

  /** Marks the searched words in the article so they're easy to spot. */
  function highlight(q: string) {
    const terms = words(q).filter((w) => w.length > 1).map(stem);
    if (!terms.length) return;
    const art = $(".help-article");
    const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const n of nodes) {
      if (n.parentElement?.closest("kbd, code, mark, figcaption")) continue;
      const text = n.data;
      const re = /[A-Za-z0-9][A-Za-z0-9'+-]*/g;
      let m: RegExpExecArray | null;
      const ranges: [number, number][] = [];
      while ((m = re.exec(text))) {
        const sw = stem(m[0]);
        if (terms.some((t) => sw === t || (t.length >= 3 && sw.startsWith(t)))) ranges.push([m.index, m.index + m[0].length]);
      }
      if (!ranges.length) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const [a, b] of ranges) {
        frag.append(text.slice(at, a), Object.assign(document.createElement("mark"), { textContent: text.slice(a, b) }));
        at = b;
      }
      frag.append(text.slice(at));
      n.replaceWith(frag);
    }
  }

  function fillGenerated(art: HTMLElement) {
    art.querySelectorAll<HTMLElement>(".help-gen").forEach((g) => {
      const el = d.gen(g.dataset.gen!, g.dataset.arg);
      if (el) g.replaceWith(el);
      else g.remove();
    });
  }

  function show(id: string, anchor = "", query = "", record = true) {
    const t = byId.get(id) ?? byId.get("welcome") ?? TOPICS[0];
    if (!t) return;
    if (!root) build();
    root!.classList.remove("hidden");
    const art = $(".help-article");
    if (t.id !== current || query) {
      art.innerHTML = rendered(t) + nextPrev(t);
      fillGenerated(art);
      art.querySelectorAll<HTMLAnchorElement>("a[href^='cmd:']").forEach((a) => {
        a.dataset.run = a.getAttribute("href")!.slice(4);
        a.classList.add("help-try");
        delete a.dataset.external;
      });
    }
    current = t.id;
    if (query) highlight(query);
    if (record) {
      history.splice(hpos + 1);
      history.push({ id: t.id, anchor });
      hpos = history.length - 1;
    }
    try { localStorage.setItem(LAST_KEY, t.id); } catch { /* private window */ }
    if (!$<HTMLInputElement>(".help-search input").value) renderSide();
    else root!.querySelectorAll<HTMLElement>(".help-link").forEach((b) => b.classList.toggle("active", b.textContent === t.title));
    requestAnimationFrame(() => {
      if (query && !anchor) {
        const mark = art.querySelector<HTMLElement>("mark");
        if (mark) return void (art.scrollTop = Math.max(0, mark.offsetTop - 120));
      }
      scrollTo(anchor);
    });
    updateNav();
  }

  function nextPrev(t: Topic) {
    const i = TOPICS.indexOf(t);
    const p = TOPICS[i - 1], n = TOPICS[i + 1];
    const link = (x: Topic | undefined, cls: string, label: string) => (x ? `<a href="#${x.id}" data-topic="${x.id}" class="${cls}"><small>${label}</small>${x.title}</a>` : "<span></span>");
    return `<nav class="help-pager">${link(p, "prev", "Previous")}${link(n, "next", "Next")}</nav>`;
  }

  function updateNav() {
    if (!root) return;
    $<HTMLButtonElement>("[data-act=back]").disabled = hpos <= 0;
    $<HTMLButtonElement>("[data-act=fwd]").disabled = hpos >= history.length - 1;
  }

  function go(step: number) {
    const k = hpos + step;
    if (k < 0 || k >= history.length) return;
    hpos = k;
    show(history[k].id, history[k].anchor, "", false);
  }

  function zoomImage(img: HTMLImageElement) {
    const z = document.createElement("div");
    z.className = "help-zoom";
    z.title = "Click or press Esc to close";
    z.append(Object.assign(document.createElement("img"), { src: img.src, alt: img.alt }));
    const shut = (e?: Event) => (e?.stopPropagation(), z.remove(), $(".help-article").focus());
    z.onclick = shut;
    z.tabIndex = 0;
    z.addEventListener("keydown", (e) => e.key === "Escape" && (e.preventDefault(), shut(e)));
    root!.append(z);
    z.focus();
  }

  function print() {
    document.body.classList.add("printing-help");
    const done = () => (document.body.classList.remove("printing-help"), window.removeEventListener("afterprint", done));
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1500);
  }

  /** Open the guide. With no topic, picks the one for the given context, else where you left off. */
  function open(topic?: string, context: string[] = [], anchor = "") {
    let id = topic;
    if (!id && context.length) id = topicForContext(context)?.id;
    if (!id) {
      try { id = localStorage.getItem(LAST_KEY) ?? undefined; } catch { /* ignore */ }
    }
    show(id ?? "welcome", anchor);
    const input = $<HTMLInputElement>(".help-search input");
    if (input.value) (input.value = ""), renderSide();
    $(".help-article").focus();
  }

  /** Open the guide with a search already typed. */
  function find(q: string) {
    if (!root) build();
    show(current || "welcome");
    const input = $<HTMLInputElement>(".help-search input");
    input.value = q;
    sel = 0;
    renderSide();
    input.focus();
  }

  function close() {
    root?.classList.add("hidden");
    document.querySelector<HTMLElement>("#viewer")?.focus();
  }

  return {
    open,
    find,
    close,
    get isOpen() { return !!root && !root.classList.contains("hidden"); },
    topics: TOPICS,
    appName: APP_NAME,
    fullName: APP_FULL_NAME,
  };
}
