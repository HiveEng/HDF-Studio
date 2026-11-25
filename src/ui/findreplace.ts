// Find and replace in the page text (paragraph by paragraph, so the text reflows) and in comments.
import type { TextMatch, FindOptions } from "../engine/edit";

export interface FindReplaceDeps {
  engine: {
    findText(id: number, find: string, o?: FindOptions, pages?: number[]): Promise<TextMatch[]>;
    replaceTextAll(id: number, find: string, replacement: string, o?: FindOptions, only?: { page: number; block: number; start: number }): Promise<number>;
    replaceInComments(id: number, find: string, replacement: string, o?: FindOptions): Promise<number>;
  };
  doc(): { info: { id: number }; page: number } | null;
  /** Show matches with the normal search highlights (index = current). */
  showMatches(hits: { page: number; quads: number[][]; snippet: string }[], index: number): void;
  afterReplace(pages: number[], label: string): void;
  status(msg: string): void;
}

export function setupFindReplace(d: FindReplaceDeps) {
  const box = document.createElement("div");
  box.id = "findReplace";
  box.className = "find-replace hidden";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Find and replace");
  box.innerHTML = `
    <div class="fr-head"><b>Find and replace</b><button type="button" class="icon-btn fr-close" title="Close (Esc)">✕</button></div>
    <label>Find<input name="find" type="text" spellcheck="false" /></label>
    <label>Replace with<input name="repl" type="text" /></label>
    <div class="fr-opts">
      <label><input type="checkbox" name="case" /> Match case</label>
      <label><input type="checkbox" name="word" /> Whole words</label>
      <label title="Replace all also changes comments, text boxes and callouts"><input type="checkbox" name="comments" checked /> Comments too</label>
    </div>
    <div class="fr-count muted"></div>
    <div class="fr-btns">
      <button type="button" data-a="prev" title="Previous (Shift+Enter)">Previous</button>
      <button type="button" data-a="next" title="Next (Enter)">Find next</button>
      <button type="button" data-a="one">Replace</button>
      <button type="button" data-a="all" class="primary">Replace all</button>
    </div>
    <p class="fr-note muted">Changed paragraphs are rewritten in the nearest standard font and reflow within their column. Ctrl+Z undoes.</p>`;
  document.body.append(box);
  const $ = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
  const findIn = $<HTMLInputElement>('[name="find"]'), replIn = $<HTMLInputElement>('[name="repl"]');
  const caseIn = $<HTMLInputElement>('[name="case"]'), wordIn = $<HTMLInputElement>('[name="word"]'), comIn = $<HTMLInputElement>('[name="comments"]');
  const countEl = $(".fr-count");
  let matches: TextMatch[] = [];
  let index = -1;
  let key = "";
  const opts = (): FindOptions => ({ matchCase: caseIn.checked, wholeWord: wordIn.checked });
  const keyNow = () => JSON.stringify([d.doc()?.info.id, findIn.value, opts()]);

  function show() {
    d.showMatches(matches.map((m) => ({ page: m.page, quads: m.quads, snippet: m.context })), index);
    countEl.textContent = !findIn.value ? "" : matches.length ? `${index + 1} of ${matches.length} in the page text` : "Not found in the page text";
  }
  async function search(keepAt?: { page: number; block: number; start: number }) {
    const doc = d.doc();
    if (!doc) return;
    key = keyNow();
    matches = findIn.value ? await d.engine.findText(doc.info.id, findIn.value, opts()) : [];
    if (keepAt) {
      // After a replace, carry on from the same place.
      index = matches.findIndex((m) => m.page > keepAt.page || (m.page === keepAt.page && (m.block > keepAt.block || (m.block === keepAt.block && m.start >= keepAt.start))));
    } else index = matches.findIndex((m) => m.page >= doc.page);
    if (index < 0) index = matches.length ? 0 : -1;
    show();
  }
  async function step(dir: 1 | -1) {
    if (key !== keyNow()) return search();
    if (!matches.length) return show();
    index = (index + dir + matches.length) % matches.length;
    show();
  }
  async function replaceOne() {
    const doc = d.doc();
    if (!doc) return;
    if (key !== keyNow() || index < 0) return search();
    const m = matches[index];
    await d.engine.replaceTextAll(doc.info.id, findIn.value, replIn.value, opts(), { page: m.page, block: m.block, start: m.start });
    d.afterReplace([m.page], "Replaced 1");
    await search({ page: m.page, block: m.block, start: m.start + replIn.value.length });
  }
  async function replaceAll() {
    const doc = d.doc();
    if (!doc || !findIn.value) return;
    const pages = [...new Set((await d.engine.findText(doc.info.id, findIn.value, opts())).map((m) => m.page))];
    const n = await d.engine.replaceTextAll(doc.info.id, findIn.value, replIn.value, opts());
    const c = comIn.checked ? await d.engine.replaceInComments(doc.info.id, findIn.value, replIn.value, opts()) : 0;
    if (n + c) d.afterReplace(pages, `Replaced ${n + c} (${n} in the page text${comIn.checked ? `, ${c} in comments` : ""})`);
    else d.status(`“${findIn.value}” wasn't found.`);
    await search();
  }

  box.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "Enter") (e.preventDefault(), e.target === replIn && !e.shiftKey ? void replaceOne() : void step(e.shiftKey ? -1 : 1));
  });
  box.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a === "next") void step(1);
    else if (a === "prev") void step(-1);
    else if (a === "one") void replaceOne();
    else if (a === "all") void replaceAll();
  });
  [caseIn, wordIn].forEach((c) => (c.onchange = () => void search()));
  $(".fr-close").onclick = () => close();

  function open(initial?: string) {
    box.classList.remove("hidden");
    if (initial) findIn.value = initial;
    findIn.focus();
    findIn.select();
    if (findIn.value) void search();
  }
  function close() {
    box.classList.add("hidden");
    matches = [];
    index = -1;
    key = "";
    d.showMatches([], -1);
  }
  return { open, close, get isOpen() { return !box.classList.contains("hidden"); } };
}
