// Recipes: reusable lists of steps applied to each file in a batch.
// The same runner powers the batch panel in the app and the `hds` command line tool.
import { autoTag, isTagged } from "./autotag";
import * as mupdf from "mupdf";
import { parseRanges } from "./ranges";
import { cleanScans } from "./scanclean";
import { stampText, type Position } from "./stamp";
import { safeName } from "./util";
import { markMatches, applyRedactions, sanitize, protectionOptions, REDACT_PATTERNS } from "./redact";

export type Step =
  | { op: "rotate"; pages?: string; degrees: 90 | 180 | 270 | -90 }
  | { op: "delete"; pages: string }
  | { op: "keep"; pages: string }
  | { op: "reverse" }
  | { op: "stamp"; text: string; position: Position; pages?: string; fontSize?: number; opacity?: number; color?: string; batesStart?: number; batesDigits?: number; batesPrefix?: string }
  | { op: "metadata"; title?: string; author?: string; subject?: string; keywords?: string; scrub?: boolean }
  | { op: "protect"; userPassword?: string; ownerPassword: string; allowPrint?: boolean; allowCopy?: boolean; allowEdit?: boolean }
  | { op: "unprotect"; password?: string }
  | { op: "flatten" }
  | { op: "compress"; level?: "fast" | "max" }
  | { op: "split"; every?: number; bookmarks?: boolean }
  | { op: "redact"; text?: string; regex?: string; pattern?: string; caseSensitive?: boolean; images?: "pixels" | "remove" | "none" }
  | { op: "sanitize"; removeComments?: boolean }
  /** Recognize text in scans. Always runs first, before the other steps, so later steps (redact) see the text. */
  | { op: "ocr"; pages?: "scanned" | "all"; lang?: string }
  /** Clean up scanned pages (straighten, remove specks, drop blank pages). Runs before OCR. */
  | { op: "clean"; straighten?: boolean; despeckle?: boolean; removeBlank?: boolean }
  /** Tag for accessibility (headings, lists, tables, figures); lang like en-US. */
  | { op: "tag"; lang?: string; retag?: boolean };

export interface Recipe {
  name: string;
  steps: Step[];
  /** Output file name template. Variables: {name} (input name without extension), {part}, {date}. */
  output?: string;
}

export interface RecipeOutput {
  name: string;
  data: Uint8Array;
}

export const STEP_LABELS: Record<Step["op"], string> = {
  rotate: "Rotate pages",
  delete: "Delete pages",
  keep: "Keep only pages",
  reverse: "Reverse page order",
  stamp: "Stamp text (header, footer, page numbers, Bates, watermark)",
  metadata: "Set or scrub metadata",
  protect: "Password-protect (AES-256)",
  unprotect: "Remove password protection",
  flatten: "Flatten annotations and form fields",
  compress: "Compress",
  split: "Split into several files",
  redact: "Find and permanently redact (text, regex or pattern: email, phone, ssn, card, date, money)",
  sanitize: "Remove hidden data (metadata, JavaScript, attachments)",
  ocr: "Recognize text in scans (OCR), runs before the other steps",
  clean: "Clean up scans: straighten, remove specks, drop blank pages (runs before OCR)",
  tag: "Tag for accessibility (screen readers)",
};

/** Ready-made recipes; users can save their own alongside these. */
export const BUILTIN_RECIPES: Recipe[] = [
  { name: "Add page numbers (Page X of Y)", steps: [{ op: "stamp", text: "Page {page} of {pages}", position: "bottom-center" }] },
  { name: "Bates number (bottom right)", steps: [{ op: "stamp", text: "{bates}", position: "bottom-right", batesPrefix: "ABC", batesDigits: 6, batesStart: 1 }] },
  { name: "Watermark DRAFT", steps: [{ op: "stamp", text: "DRAFT", position: "diagonal" }] },
  { name: "Watermark CONFIDENTIAL", steps: [{ op: "stamp", text: "CONFIDENTIAL", position: "diagonal", fontSize: 54 }] },
  { name: "Compress (max)", steps: [{ op: "compress", level: "max" }] },
  { name: "Scrub metadata", steps: [{ op: "metadata", scrub: true }] },
  { name: "Flatten forms and comments", steps: [{ op: "flatten" }] },
  { name: "Remove first page", steps: [{ op: "delete", pages: "1" }] },
  { name: "Split into single pages", steps: [{ op: "split", every: 1 }], output: "{name} - {part}" },
  { name: "Rotate all pages 90°", steps: [{ op: "rotate", degrees: 90 }] },
  { name: "Redact emails and phone numbers", steps: [{ op: "redact", pattern: "email" }, { op: "redact", pattern: "phone" }, { op: "sanitize" }] },
  { name: "Remove hidden data", steps: [{ op: "sanitize" }] },
  { name: "Make scans searchable (OCR)", steps: [{ op: "ocr", pages: "scanned" }] },
  { name: "Make accessible (tag for screen readers)", steps: [{ op: "tag", lang: "en-US" }] },
  { name: "Clean up scans, then OCR", steps: [{ op: "clean", straighten: true, despeckle: true, removeBlank: true }, { op: "ocr", pages: "scanned" }] },
  { name: "OCR scans, then tag for accessibility", steps: [{ op: "ocr", pages: "scanned" }, { op: "tag", lang: "en-US" }] },
  { name: "OCR scans, then redact emails and phone numbers", steps: [{ op: "ocr", pages: "scanned" }, { op: "redact", pattern: "email" }, { op: "redact", pattern: "phone" }, { op: "sanitize" }] },
];

function hexColor(c?: string): [number, number, number] | undefined {
  const m = c?.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) as [number, number, number] : undefined;
}


/**
 * Run a recipe on one input file. `batesOffset` lets Bates numbers continue across files in a batch:
 * the runner returns how many pages were numbered so the caller can carry the counter forward.
 */
export function runRecipe(input: Uint8Array, fileName: string, recipe: Recipe, ctx: { batesOffset?: number; password?: string } = {}): { outputs: RecipeOutput[]; pagesStamped: number } {
  let doc = mupdf.Document.openDocument(input, "pdf").asPDF();
  if (!doc) throw new Error("Not a PDF");
  if (doc.needsPassword()) {
    const unprotect = recipe.steps.find((s) => s.op === "unprotect") as { password?: string } | undefined;
    const pw = unprotect?.password ?? ctx.password;
    if (!pw || !doc.authenticatePassword(pw)) throw new Error("Password protected (add an 'unprotect' step with the password)");
  }
  const stem = fileName.replace(/\.[^.]+$/, "");
  let saveOpts = ["garbage", "compress"];
  let splitStep: Extract<Step, { op: "split" }> | null = null;
  let pagesStamped = 0;
  const count = () => doc!.countPages();
  const all = () => [...Array(count()).keys()];

  for (const step of recipe.steps) {
    switch (step.op) {
      case "rotate":
        for (const i of step.pages ? parseRanges(step.pages, count()) : all()) {
          const o = doc.findPage(i);
          const cur = o.getInheritable("Rotate");
          o.put("Rotate", ((((cur.isNull() ? 0 : cur.asNumber()) + step.degrees) % 360) + 360) % 360);
        }
        break;
      case "delete": {
        const drop = new Set(parseRanges(step.pages, count()));
        const keep = all().filter((i) => !drop.has(i));
        if (!keep.length) throw new Error("Deleting these pages would leave an empty document");
        doc.rearrangePages(keep);
        break;
      }
      case "keep":
        doc.rearrangePages(parseRanges(step.pages, count()));
        break;
      case "reverse":
        doc.rearrangePages(all().reverse());
        break;
      case "stamp": {
        const pages = step.pages ? parseRanges(step.pages, count()) : undefined;
        const n = stampText(doc, {
          ...step, pages, color: hexColor(step.color), fileName: stem,
          batesStart: (step.batesStart ?? 1) + (ctx.batesOffset ?? 0),
        });
        if (step.text.includes("{bates}")) pagesStamped += n;
        break;
      }
      case "metadata":
        if (step.scrub) {
          for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) doc.setMetaData(`info:${k}`, "");
          doc.getTrailer().get("Root").delete("Metadata");
        }
        for (const k of ["title", "author", "subject", "keywords"] as const) {
          if (step[k] !== undefined) doc.setMetaData(`info:${k[0].toUpperCase()}${k.slice(1)}`, step[k]!);
        }
        break;
      case "protect":
        saveOpts = saveOpts.filter((o) => o !== "decrypt");
        saveOpts.push(protectionOptions(step));
        break;
      case "unprotect":
        saveOpts.push("decrypt");
        break;
      case "flatten":
        doc.bake(true, true);
        break;
      case "compress":
        saveOpts.push(step.level === "max" ? "garbage=deduplicate" : "garbage=compact", "compress-fonts", "compress-images", "clean");
        saveOpts = saveOpts.filter((o) => o !== "garbage");
        break;
      case "split":
        splitStep = step;
        break;
      case "redact": {
        if (step.pattern && !(step.pattern in REDACT_PATTERNS)) throw new Error(`Unknown pattern "${step.pattern}" (use ${Object.keys(REDACT_PATTERNS).join(", ")})`);
        markMatches(doc, { text: step.text, regex: step.regex, pattern: step.pattern as never, caseSensitive: step.caseSensitive });
        applyRedactions(doc, { images: step.images });
        if (!saveOpts.includes("sanitize")) saveOpts.push("sanitize");
        break;
      }
      case "tag":
        if (!isTagged(doc) || step.retag) autoTag(doc, { lang: step.lang, retag: step.retag });
        break;
      case "clean":
        cleanScans(doc, [...Array(doc.countPages()).keys()], { straighten: step.straighten ?? true, despeckle: step.despeckle ?? true, removeBlank: step.removeBlank ?? true });
        break;
      case "ocr":
        break; // done by the caller beforehand (recognition runs outside the PDF engine)
      case "sanitize":
        sanitize(doc, { removeComments: step.removeComments });
        if (!saveOpts.includes("sanitize")) saveOpts.push("sanitize");
        break;
    }
  }

  const save = (d: mupdf.PDFDocument) => {
    const buf = d.saveToBuffer(saveOpts.join(","));
    const out = new Uint8Array(buf.asUint8Array());
    buf.destroy();
    return out;
  };
  const tmpl = recipe.output ?? (splitStep ? "{name} - {part}" : "{name}");
  const date = new Date().toISOString().slice(0, 10);
  const name = (part: string) => safeName(tmpl.replace(/\{name\}/g, stem).replace(/\{part\}/g, part).replace(/\{date\}/g, date)) + ".pdf";

  const outputs: RecipeOutput[] = [];
  if (!splitStep) {
    outputs.push({ name: name(""), data: save(doc) });
  } else {
    // Save first so the split parts get all edits, then split the saved document.
    const edited = mupdf.Document.openDocument(save(doc), "pdf").asPDF()!;
    if (saveOpts.some((o) => o.startsWith("user-password"))) {
      const pw = saveOpts.find((o) => o.startsWith("user-password="))!.split("=")[1];
      edited.authenticatePassword(pw);
    }
    const n = edited.countPages();
    let groups: { part: string; pages: number[] }[] = [];
    if (splitStep.bookmarks) {
      const top = (edited.loadOutline() ?? []).filter((o) => typeof o.page === "number").sort((a, b) => a.page! - b.page!);
      if (!top.length || top[0].page! > 0) top.unshift({ title: "Front matter", page: 0 } as never);
      top.forEach((o, i) => {
        const end = i + 1 < top.length ? top[i + 1].page! : n;
        if (end > o.page!) groups.push({ part: o.title ?? `part${i + 1}`, pages: [...Array(end - o.page!).keys()].map((k) => k + o.page!) });
      });
    } else {
      const k = Math.max(1, splitStep.every ?? 1);
      for (let a = 0; a < n; a += k) {
        const pages = [...Array(Math.min(k, n - a)).keys()].map((i) => i + a);
        groups.push({ part: pages.length > 1 ? `p${a + 1}-${a + pages.length}` : `p${a + 1}`, pages });
      }
    }
    for (const g of groups) {
      const part = new mupdf.PDFDocument();
      const map = part.newGraftMap();
      for (const p of g.pages) map.graftPage(-1, edited, p);
      outputs.push({ name: name(g.part), data: save(part) });
      part.destroy();
    }
    edited.destroy();
  }
  doc.destroy();
  doc = null;
  return { outputs, pagesStamped };
}

/** Parse `op key=value key="quoted value"` into a Step. Numbers and true/false are converted. */
export function parseStep(s: string): Step {
  const tokens = [...s.matchAll(/(\w+)=("([^"]*)"|'([^']*)'|\S+)|(\S+)/g)];
  const op = tokens[0]?.[5];
  if (!op || !(op in STEP_LABELS)) throw new Error(`Unknown step "${op}". Steps: ${Object.keys(STEP_LABELS).join(", ")}`);
  const step: Record<string, unknown> = { op };
  for (const m of tokens.slice(1)) {
    if (!m[1]) throw new Error(`Expected key=value in step "${s}", got "${m[0]}"`);
    const raw = m[3] ?? m[4] ?? m[2];
    step[m[1]] = raw === "true" ? true : raw === "false" ? false : m[3] === undefined && m[4] === undefined && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return step as Step;
}

/** Inverse of parseStep: one editable line per step. */
export function formatStep(step: Step): string {
  const parts = Object.entries(step).filter(([k]) => k !== "op").map(([k, v]) => {
    const s = String(v);
    return `${k}=${/^[^\s"']+$/.test(s) ? s : `"${s.replace(/"/g, "'")}"`}`;
  });
  return [step.op, ...parts].join(" ");
}

/** Example line for each step type, used by the "Add step" menu. */
export const STEP_EXAMPLES: Record<Step["op"], string> = {
  rotate: "rotate degrees=90 pages=all",
  delete: "delete pages=1",
  keep: 'keep pages="1-3,5"',
  reverse: "reverse",
  stamp: 'stamp text="Page {page} of {pages}" position=bottom-center fontSize=10',
  metadata: 'metadata title="My title" author="Me"',
  protect: "protect ownerPassword=change-me userPassword= allowPrint=true allowCopy=false",
  unprotect: "unprotect password=",
  flatten: "flatten",
  compress: "compress level=max",
  split: "split every=1",
  redact: "redact pattern=email",
  sanitize: "sanitize removeComments=false",
  ocr: "ocr pages=scanned",
  clean: "clean straighten=true despeckle=true removeBlank=true",
  tag: "tag lang=en-US",
};
