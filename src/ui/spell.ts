// Spell check for comments, text boxes and (optionally) the page text. Uses a bundled
// English Hunspell dictionary, so it works offline. Words you add are kept on this PC.
import type { TextBlock } from "../engine/edit";
import type { AnnotInfo } from "../engine/annotations";

type Speller = { correct(w: string): boolean; suggest(w: string): string[]; add(w: string): unknown };
let speller: Promise<Speller> | null = null;
const DICT_KEY = "hdfstudio.dict";

// Trade words the general dictionary lacks.
const TRADE = "drywall rebar ductwork subfloor sheathing precast formwork shotcrete stucco soffit fascia joist joists purlin purlins girt girts mullion mullions transom glazing caulk caulking flashing grout grouted anchorage embed embeds baseplate baseplates gusset gussets stiffener stiffeners weldment galvanized galvanizing waterproofing underlayment backfill subgrade subbase geotextile riser risers sprinkler sprinklers standpipe damper dampers diffuser diffusers plenum chiller chillers ahu vav luminaire luminaires switchgear panelboard panelboards conduit conduits raceway raceways busway grounding bonding millwork casework countertop countertops wainscot baseboard hardscape curb curbs bollard bollards cmu gyp typ dwg dwgs elev elevs reqd recd mfr mfrs approx dia min max dim dims ea qty incl misc spec specs submittal submittals resubmit rfi rfis".split(" ");

export function getSpeller(): Promise<Speller> {
  speller ??= (async () => {
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import("nspell"),
      import("../../node_modules/dictionary-en/index.aff?raw").then((m) => m.default as string),
      import("../../node_modules/dictionary-en/index.dic?raw").then((m) => m.default as string),
    ]);
    const sp = nspell(aff, dic) as unknown as Speller;
    for (const w of [...TRADE, ...personal()]) sp.add(w);
    return sp;
  })();
  return speller;
}
const personal = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(DICT_KEY) ?? "[]");
  } catch {
    return [];
  }
};
export async function addToDictionary(word: string) {
  localStorage.setItem(DICT_KEY, JSON.stringify([...new Set([...personal(), word])]));
  (await getSpeller()).add(word);
}

/** Words worth checking in a text, with their offsets. Skips acronyms, codes, URLs and emails. */
export function* words(text: string): Generator<{ word: string; start: number }> {
  const masked = text.replace(/\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/gi, (m) => " ".repeat(m.length));
  for (const m of masked.matchAll(/[\p{L}][\p{L}'’]*[\p{L}]|[\p{L}]/gu)) {
    const w = m[0], start = m.index!;
    const before = masked[start - 1] ?? " ", after = masked[start + w.length] ?? " ";
    if (w.length < 2) continue;
    if (/[\p{N}_/\\]/u.test(before) || /[\p{N}_/\\]/u.test(after)) continue; // part of a code like 3rd or W12x26
    if (w === w.toUpperCase()) continue; // acronyms and SHOUTED titles
    if (/\p{Lu}/u.test(w.slice(1)) && w.slice(1) !== w.slice(1).toUpperCase()) continue; // camelCase names
    yield { word: w.replace(/’/g, "'"), start };
  }
}
export function isCorrect(sp: Speller, w: string): boolean {
  if (sp.correct(w)) return true;
  const plain = w.replace(/'s$/i, "");
  return plain !== w && sp.correct(plain);
}

interface Issue {
  word: string;
  start: number;
  context: string;
  where: "comment" | "page";
  page: number;
  key?: number;
  block?: number;
  text: string;
}

export interface SpellDeps {
  engine: {
    allAnnotations(id: number): Promise<AnnotInfo[]>;
    textBlocks(id: number, page: number): Promise<TextBlock[]>;
    updateAnnotation(id: number, page: number, key: number, patch: { contents: string }): Promise<void>;
    replaceTextAll(id: number, find: string, replacement: string, o?: { matchCase?: boolean; wholeWord?: boolean }, only?: { page: number; block: number; start: number }): Promise<number>;
  };
  doc(): { info: { id: number; pageCount: number } } | null;
  el: HTMLElement;
  show(): void;
  goTo(page: number): void;
  afterChange(pages: number[], label: string, comments: boolean): void;
  status(msg: string): void;
}

export function setupSpell(d: SpellDeps) {
  const ignored = new Set<string>();
  const ignoredWords = new Set<string>();
  let includePage = localStorage.getItem("hdfstudio.spellPage") === "1";
  let issues: Issue[] = [];
  let open: Issue | null = null;
  const idOf = (i: Issue) => [i.where, i.page, i.key ?? i.block, i.word, i.context].join("|");

  async function scan() {
    const doc = d.doc();
    if (!doc) return;
    d.el.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "Checking spelling…" }));
    const sp = await getSpeller();
    const out: Issue[] = [];
    const push = (text: string, base: Omit<Issue, "word" | "start" | "context" | "text">) => {
      for (const { word, start } of words(text)) {
        if (ignoredWords.has(word.toLowerCase()) || isCorrect(sp, word)) continue;
        const s = Math.max(0, start - 25), e = Math.min(text.length, start + word.length + 25);
        const issue: Issue = { ...base, word, start, text, context: (s ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ") + (e < text.length ? "…" : "") };
        if (!ignored.has(idOf(issue))) out.push(issue);
      }
    };
    for (const a of await d.engine.allAnnotations(doc.info.id)) {
      if (!a.contents || a.groupOf || /Stamp|Redact|Link|Widget/.test(a.type)) continue;
      push(a.contents, { where: "comment", page: a.page, key: a.key });
    }
    if (includePage) {
      for (let p = 0; p < doc.info.pageCount; p++) {
        (await d.engine.textBlocks(doc.info.id, p)).forEach((b, bi) => push(b.para, { where: "page", page: p, block: bi }));
      }
    }
    issues = out.sort((x, y) => x.page - y.page);
    render();
  }

  async function fix(i: Issue, to: string) {
    const doc = d.doc();
    if (!doc) return;
    if (i.where === "comment") {
      const text = i.text.slice(0, i.start) + to + i.text.slice(i.start + i.word.length);
      await d.engine.updateAnnotation(doc.info.id, i.page, i.key!, { contents: text });
    } else {
      await d.engine.replaceTextAll(doc.info.id, i.word, to, { matchCase: true, wholeWord: true }, { page: i.page, block: i.block!, start: i.start });
    }
    d.afterChange([i.page], `Changed “${i.word}” to “${to}”`, i.where === "comment");
    open = null;
    await scan();
  }

  function render() {
    const bar = document.createElement("div");
    bar.className = "nav-bar";
    const again = Object.assign(document.createElement("button"), { type: "button", className: "nav-btn", textContent: "Check again", onclick: () => void scan() });
    const lab = document.createElement("label");
    lab.className = "spell-opt";
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: includePage });
    cb.onchange = () => {
      includePage = cb.checked;
      localStorage.setItem("hdfstudio.spellPage", includePage ? "1" : "0");
      void scan();
    };
    lab.append(cb, " Page text too");
    bar.append(again, lab);
    const list = document.createElement("div");
    list.className = "nav-list";
    if (!issues.length) list.innerHTML = `<p class="muted">No spelling problems found in the ${includePage ? "comments or page text" : "comments and text boxes"}.</p>`;
    for (const i of issues) {
      const row = document.createElement("div");
      row.className = "spell-item" + (i === open ? " open" : "");
      const head = document.createElement("button");
      head.type = "button";
      head.className = "spell-head";
      head.innerHTML = `<span class="spell-word"></span><small>Page ${i.page + 1} · ${i.where === "comment" ? "comment" : "page text"}</small><span class="spell-ctx"></span>`;
      head.querySelector(".spell-word")!.textContent = i.word;
      head.querySelector(".spell-ctx")!.textContent = i.context;
      head.onclick = () => {
        open = open === i ? null : i;
        d.goTo(i.page);
        render();
      };
      row.append(head);
      if (i === open) {
        const acts = document.createElement("div");
        acts.className = "spell-acts";
        void getSpeller().then((sp) => {
          const sugg = sp.suggest(i.word).slice(0, 5);
          const mk = (label: string, cls: string, run: () => void) => Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: label, onclick: run });
          acts.append(
            ...(sugg.length ? sugg.map((s) => mk(s, "nav-btn spell-sugg", () => void fix(i, s))) : [Object.assign(document.createElement("span"), { className: "muted", textContent: "No suggestions" })]),
            mk("Ignore", "nav-btn", () => (ignored.add(idOf(i)), (issues = issues.filter((x) => x !== i)), render())),
            mk("Ignore all", "nav-btn", () => (ignoredWords.add(i.word.toLowerCase()), (issues = issues.filter((x) => x.word.toLowerCase() !== i.word.toLowerCase())), render())),
            mk("Add to dictionary", "nav-btn", () => void addToDictionary(i.word).then(() => ((issues = issues.filter((x) => x.word !== i.word)), render(), d.status(`Added “${i.word}” to your dictionary`)))),
          );
        });
        row.append(acts);
      }
      list.append(row);
    }
    const count = Object.assign(document.createElement("p"), { className: "muted spell-count", textContent: issues.length ? `${issues.length} word${issues.length === 1 ? "" : "s"} to check` : "" });
    d.el.replaceChildren(bar, count, list);
  }

  return {
    async check() {
      if (!d.doc()) return d.status("Open a PDF first.");
      d.show();
      await scan();
    },
  };
}
