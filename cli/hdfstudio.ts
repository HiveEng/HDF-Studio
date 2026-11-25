#!/usr/bin/env node
// hdfstudio: command line companion to the HDF Studio app. Batch-process PDFs with the same engine and recipes.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve, extname } from "node:path";
import { Engine } from "../src/engine/core";
import { runRecipe, parseStep, BUILTIN_RECIPES, STEP_LABELS, type Recipe } from "../src/engine/recipes";
import { parseRanges } from "../src/engine/ranges";
import { signPdf, verifySignatures, makeSelfSignedP12 } from "../src/engine/digisign";
import { timestampRequest, embedTimestamp, TSA_SERVERS } from "../src/engine/tsa";
import { canOpen, needsOffice } from "../src/engine/convert";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { langSource } from "../src/ocr/languages";
import { rmSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { createRecognizer, type Recognizer } from "../src/ocr/recognize";
import { ocrBytes, ocrStep } from "../src/ocr/pipeline";
import { FolderWatcher, type WatchFs } from "../src/automation/watch";
import { renameSync } from "node:fs";

const nodeFs: WatchFs = {
  list: async (dir) => readdirSync(dir).map((name) => ({ name, st: statSync(join(dir, name)) })).filter((f) => f.st.isFile()).map((f) => ({ name: f.name, size: f.st.size, mtime: f.st.mtimeMs })),
  read: async (p) => readFileSync(p),
  write: async (p, d) => writeFileSync(p, d),
  mkdir: async (p) => void mkdirSync(p, { recursive: true }),
  move: async (a, b) => renameSync(a, b),
  join: (...p) => join(...p),
};

/**
 * Tesseract with the bundled English data (no download needed). Other languages (--lang fra or
 * --lang eng+deu) download once and are cached in ~/.hdfstudio/ocr; --lang-path uses local files.
 */
function recognizerFor(lang: string, langPath?: string): Promise<Recognizer> {
  const req = createRequire(import.meta.url);
  const bundled = join(dirname(req.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
  if (langPath) return createRecognizer(lang, { langPath, cacheMethod: "none", gzip: true });
  const src = langSource(lang, bundled);
  if (!src.needsDownload) return createRecognizer(lang, { langPath: bundled, cacheMethod: "none", gzip: true });
  const cachePath = join(homedir(), ".hdfstudio", "ocr");
  mkdirSync(cachePath, { recursive: true });
  return createRecognizer(lang, { cachePath, cacheMethod: "write", gzip: true });
}

const HELP = `hdfstudio - batch PDF tools (AGPL-3.0)

Usage:
  hdfstudio info <files|folders...>                     Page count, size, title, encryption
  hdfstudio merge -o out.pdf <files|folders...>         Merge in order, one bookmark per file
  hdfstudio split <file> [--every N | --bookmarks] [-o dir]
  hdfstudio extract <file> <pages> -o out.pdf           e.g. hdfstudio extract a.pdf "1-3,7" -o part.pdf
  hdfstudio text <file> [-o out.txt]                    Extract text
  hdfstudio search <text> <files|folders...> [--csv]    Find text across many PDFs
  hdfstudio fill <form.pdf> <data.csv> [-o dir] [--name "{col} - {col}"] [--flatten]
                                                    Fill a form once per CSV row (mail merge)
  hdfstudio fields <form.pdf>                           List form fields and current values
  hdfstudio make-fillable <files|folders...> [-o dir] [--dry-run]
                                                    Detect blanks, lines and boxes on flat forms and add fields
  hdfstudio sign <files|folders...> --cert me.pfx --password pw [-o dir]
        [--reason ".."] [--location ".."] [--page N --rect "x0,y0,x1,y1"]  (points from top-left; omit for invisible)
        [--tsa [url]]   add a trusted RFC 3161 timestamp (default server: DigiCert)
                                                    Digitally sign one or many PDFs
  hdfstudio verify <files|folders...>                   Validate digital signatures
  hdfstudio make-cert "Your Name" -o me.pfx --password pw [--email you@x.com]
                                                    Create a self-signed certificate
  hdfstudio convert <files...> -o out.pdf [--size a4|letter|auto] [--each]
                                                    Images, HTML, text, EPUB, XPS (and Office files via LibreOffice) to PDF
  hdfstudio export <files|folders...> --to png|jpg|docx|html|txt|svg [--dpi 150] [--pages 1-3] [-o dir]
                                                    PDF to images, Word, HTML, text or SVG
  hdfstudio ocr <files|folders...> [-o dir] [--all] [--lang eng+fra] [--lang-path dir]
                                                    Make scanned PDFs searchable (adds an invisible text layer)
  hdfstudio compare <old.pdf> <new.pdf> [-o report.pdf] [--json] [--text-only]
                                                    List what changed (exit code 1 if they differ); -o writes the new file with every change marked
  hdfstudio watch <folder> --recipe <name|file.json> [-o dir] [--keep] [--interval 3]
                                                    Keep running: process every PDF dropped into the folder
                                                    (originals move to <folder>/processed unless --keep)
  hdfstudio comments <file.pdf> [reviews.pdf|.xfdf ...] [-o out.pdf] [--xfdf out.xfdf]
                                                    List comments with replies and status; merge reviewers' copies
  hdfstudio tag <files|folders...> [--lang en-US] [--retag] [-o dir]
                                                    Tag for accessibility (headings, lists, tables, images)
  hdfstudio check <files|folders...> [--json]           PDF/A, accessibility and security check (exit 1 on errors)
  hdfstudio pdfa <files|folders...> [-o dir]            Convert to PDF/A-2b for archiving (needs Ghostscript)
  hdfstudio recipes                                     List built-in recipes and step types
  hdfstudio run <recipe> <files|folders...> [options]   Apply a recipe to every PDF
      <recipe> is a built-in name (quotes or a unique prefix), a .json file, or "-" to use --step only
      --step "<op> key=value ..."   add a step (repeatable), e.g.
            --step 'stamp text="Page {page} of {pages}" position=bottom-center'
            --step 'protect ownerPassword=s3cret allowCopy=false'
      -o, --out <dir>       output folder (default: <input folder>/hdfstudio-out)
      --name <template>     output name, e.g. "{name}-stamped" ({name} {part} {date})
      --password <pw>       password for protected inputs
      --continue-bates      carry Bates numbers across files (on by default when a step uses {bates})
      --dry-run             show what would happen
  Common: -r/--recursive (folders), -q/--quiet
`;

type Args = { _: string[]; flags: Record<string, string | boolean>; steps: string[] };
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, steps: [] };
  const alias: Record<string, string> = { o: "out", r: "recursive", q: "quiet", h: "help" };
  const bools = new Set(["retag", "recursive", "quiet", "help", "csv", "bookmarks", "dry-run", "continue-bates", "flatten", "each", "all", "json", "text-only", "keep"]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("-") && t !== "-") {
      let k = t.replace(/^--?/, "");
      k = alias[k] ?? k;
      if (bools.has(k)) a.flags[k] = true;
      else if (k === "step") a.steps.push(argv[++i]);
      else if (k === "tsa" && !/^https?:\/\//.test(argv[i + 1] ?? "")) a.flags[k] = true; // --tsa alone: default server
      else a.flags[k] = argv[++i];
    } else a._.push(t);
  }
  return a;
}

function collect(paths: string[], recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      if (depth > 0 && !recursive) return;
      for (const e of readdirSync(p).sort()) {
        if (e === "hdfstudio-out") continue;
        const full = join(p, e);
        if (statSync(full).isDirectory()) walk(full, depth + 1);
        else if (extname(e).toLowerCase() === ".pdf") out.push(full);
      }
    } else out.push(p);
  };
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    walk(p, 0);
  }
  return out;
}

/** Files of any type (for convert), folders expanded. */
function collectAny(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) { const f = join(p, e); if (statSync(f).isFile()) out.push(f); }
    else out.push(p);
  }
  return out;
}

function officeToPdf(file: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hdfstudio-"));
  try {
    const candidates = [process.env.SOFFICE, "soffice", "C:/Program Files/LibreOffice/program/soffice.exe", "/Applications/LibreOffice.app/Contents/MacOS/soffice"].filter(Boolean) as string[];
    for (const bin of candidates) {
      try {
        execFileSync(bin, ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, file], { stdio: "ignore", timeout: 180_000 });
        return readFileSync(join(dir, basename(file, extname(file)) + ".pdf"));
      } catch { /* try next */ }
    }
    throw new Error(`${file}: converting Office files needs LibreOffice (set SOFFICE to its path if it isn't found)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Ghostscript, for PDF/A conversion (optional, like LibreOffice for Office files). */
function ghostscript(): string {
  const pf = ["C:/Program Files/gs", "C:/Program Files (x86)/gs"].flatMap((d) => (existsSync(d) ? readdirSync(d).sort().reverse().map((v) => join(d, v, "bin", "gswin64c.exe")) : []));
  for (const bin of [process.env.GS, ...pf, "gswin64c", "gswin32c", "gs"].filter(Boolean) as string[]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch { /* next */ }
  }
  throw new Error("PDF/A conversion needs Ghostscript (ghostscript.com); set GS to its path if it isn't found");
}

/** Ghostscript's PDF/A-2b conversion, before HDF Studio adds the output intent. */
export function gsPdfa(input: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "hdfstudio-"));
  try {
    writeFileSync(join(dir, "in.pdf"), input);
    execFileSync(ghostscript(), ["-q", "-dPDFA=2", "-dBATCH", "-dNOPAUSE", "-dNOOUTERSAVE", "-sColorConversionStrategy=RGB", "-sDEVICE=pdfwrite", "-dPDFACompatibilityPolicy=1", `-sOutputFile=${join(dir, "out.pdf")}`, join(dir, "in.pdf")], { stdio: "ignore", timeout: 600_000 });
    return readFileSync(join(dir, "out.pdf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function findRecipe(name: string, steps: string[]): Recipe {
  if (name === "-") return { name: "inline", steps: [] };
  if (name.endsWith(".json") && existsSync(name)) return JSON.parse(readFileSync(name, "utf8")) as Recipe;
  const lower = name.toLowerCase();
  const exact = BUILTIN_RECIPES.find((r) => r.name.toLowerCase() === lower);
  if (exact) return structuredClone(exact);
  const matches = BUILTIN_RECIPES.filter((r) => r.name.toLowerCase().startsWith(lower));
  if (matches.length === 1) return structuredClone(matches[0]);
  throw new Error(matches.length ? `"${name}" matches several recipes: ${matches.map((m) => m.name).join("; ")}` : `No recipe "${name}". Run "hdfstudio recipes" to list them.${steps.length ? "" : ' Use "-" with --step for inline steps.'}`);
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  const log = (...m: unknown[]) => !args.flags.quiet && console.log(...m);
  const recursive = !!args.flags.recursive;
  const e = new Engine();
  if (!cmd || args.flags.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "info": {
      for (const f of collect(rest, recursive)) {
        const d = e.open(readFileSync(f), basename(f));
        const size = statSync(f).size;
        if (d.needsPassword) console.log(`${f}\tencrypted\t${fmtSize(size)}`);
        else {
          const [w, h] = d.pageSizes[0] ?? [0, 0];
          console.log(`${f}\t${d.pageCount} pages\t${Math.round(w)}x${Math.round(h)} pt\t${fmtSize(size)}${d.title ? `\t"${d.title}"` : ""}`);
        }
        e.close(d.id);
      }
      return 0;
    }
    case "merge": {
      const out = args.flags.out as string;
      if (!out) throw new Error("merge needs -o out.pdf");
      const files = collect(rest, recursive);
      const parts = files.map((f) => ({ id: e.open(readFileSync(f), basename(f)).id, title: basename(f, extname(f)) }));
      writeFileSync(out, e.combine(parts));
      log(`Merged ${files.length} files into ${out}`);
      return 0;
    }
    case "split": {
      const f = rest[0];
      const d = e.open(readFileSync(f), basename(f));
      const parts = e.split(d.id, args.flags.bookmarks ? { bookmarks: true } : { every: Number(args.flags.every ?? 1) });
      const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
      mkdirSync(dir, { recursive: true });
      for (const p of parts) writeFileSync(join(dir, `${basename(f, extname(f))} - ${p.suffix}.pdf`), p.data);
      log(`Split ${f} into ${parts.length} files in ${dir}`);
      return 0;
    }
    case "extract": {
      const [f, range] = rest;
      const out = args.flags.out as string;
      if (!f || !range || !out) throw new Error('usage: hdfstudio extract <file> "<pages>" -o out.pdf');
      const d = e.open(readFileSync(f), basename(f));
      writeFileSync(out, e.extract(d.id, parseRanges(range, d.pageCount)));
      log(`Wrote ${out}`);
      return 0;
    }
    case "text": {
      const f = rest[0];
      const d = e.open(readFileSync(f), basename(f));
      const txt = [...Array(d.pageCount).keys()].map((i) => e.pageText(d.id, i)).join("\f\n");
      if (args.flags.out) writeFileSync(args.flags.out as string, txt);
      else process.stdout.write(txt);
      return 0;
    }
    case "search": {
      const [needle, ...paths] = rest;
      const csv = !!args.flags.csv;
      if (csv) console.log("file,page,snippet");
      let total = 0;
      for (const f of collect(paths, recursive)) {
        const d = e.open(readFileSync(f), basename(f));
        if (d.needsPassword) continue;
        for (const h of e.search(d.id, needle)) {
          total++;
          console.log(csv ? [f, h.page + 1, h.snippet].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",") : `${f}:${h.page + 1}: ${h.snippet}`);
        }
        e.close(d.id);
      }
      if (!csv) log(`${total} matches`);
      return 0;
    }
    case "fill": {
      const [form, csv] = rest;
      if (!form || !csv) throw new Error("usage: hdfstudio fill <form.pdf> <data.csv> [-o dir]");
      const out = e.mailMerge(readFileSync(form), readFileSync(csv, "utf8"), { name: (args.flags.name as string) ?? `${basename(form, extname(form))} - {row}`, flatten: !!args.flags.flatten });
      const dir = (args.flags.out as string) ?? join(dirname(form), "hdfstudio-out");
      mkdirSync(dir, { recursive: true });
      for (const o of out) writeFileSync(join(dir, o.name), o.data);
      const missing = new Set(out.flatMap((o) => o.missing));
      log(`Created ${out.length} filled forms in ${dir}`);
      if (missing.size) console.error(`Columns with no matching field: ${[...missing].join(", ")}`);
      return 0;
    }
    case "fields": {
      const d = e.open(readFileSync(rest[0]), basename(rest[0]));
      for (const f of e.fields(d.id)) console.log(`p${f.page + 1}\t${f.type}\t${f.name}\t${JSON.stringify(f.value)}${f.options.length ? `\t[${f.options.join(" | ")}]` : ""}${f.onState ? `\ton=${f.onState}` : ""}`);
      return 0;
    }
    case "sign": {
      const cert = args.flags.cert as string, password = (args.flags.password as string) ?? "";
      if (!cert) throw new Error("sign needs --cert file.pfx --password ...");
      const p12 = readFileSync(cert);
      const rect = args.flags.rect ? (args.flags.rect as string).split(",").map(Number) : undefined;
      if (rect && (rect.length !== 4 || rect.some(isNaN))) throw new Error('--rect must be "x0,y0,x1,y1"');
      let ok = 0, failed = 0;
      for (const f of collect(rest, recursive)) {
        try {
          const tsaUrl = args.flags.tsa === true ? TSA_SERVERS[0].url : (args.flags.tsa as string | undefined);
          let out = signPdf(readFileSync(f), { p12, password, page: args.flags.page ? Number(args.flags.page) - 1 : 0, rect, reason: args.flags.reason as string, location: args.flags.location as string, timestamp: !!tsaUrl });
          if (tsaUrl) {
            const res = await fetch(tsaUrl, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body: timestampRequest(out) as BodyInit }).catch((e) => {
              throw new Error(`could not reach the timestamp server ${tsaUrl}: ${(e as Error).message}`);
            });
            if (!res.ok) throw new Error(`timestamp server answered ${res.status}`);
            out = embedTimestamp(out, new Uint8Array(await res.arrayBuffer()));
          }
          const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
          mkdirSync(dir, { recursive: true });
          const target = join(dir, `${basename(f, extname(f))} (signed).pdf`);
          writeFileSync(target, out);
          ok++;
          log(`✓ ${f} -> ${target}`);
        } catch (err) {
          failed++;
          console.error(`✗ ${f}: ${(err as Error).message}`);
        }
      }
      log(`${ok} signed, ${failed} failed`);
      return failed ? 1 : 0;
    }
    case "verify": {
      let bad = 0;
      for (const f of collect(rest, recursive)) {
        const checks = verifySignatures(readFileSync(f));
        if (!checks.length) console.log(`${f}: no signatures`);
        for (const c of checks) {
          if (!c.intact) bad++;
          console.log(`${f}: ${c.field}: ${c.status}${c.signedAt ? ` (signed ${c.signedAt.toISOString()})` : ""}`);
        }
      }
      return bad ? 1 : 0;
    }
    case "make-cert": {
      const out = args.flags.out as string, password = args.flags.password as string;
      if (!rest[0] || !out || !password) throw new Error('usage: hdfstudio make-cert "Your Name" -o me.pfx --password pw');
      writeFileSync(out, makeSelfSignedP12(rest[0], password, args.flags.email as string | undefined));
      log(`Wrote ${out}`);
      return 0;
    }
    case "convert": {
      const inputs = collectAny(rest);
      const size = ((args.flags.size as string) ?? "auto") as "auto";
      const load = (f: string) => {
        if (needsOffice(f)) return { name: basename(f, extname(f)) + ".pdf", data: officeToPdf(f) };
        if (!canOpen(f)) throw new Error(`${f}: unsupported format`);
        return { name: basename(f), data: readFileSync(f) as Uint8Array };
      };
      if (args.flags.each) {
        const dir = (args.flags.out as string) ?? "hdfstudio-out";
        mkdirSync(dir, { recursive: true });
        for (const f of inputs) {
          writeFileSync(join(dir, basename(f, extname(f)) + ".pdf"), e.toPdf([load(f)], { pageSize: size }));
          log(`✓ ${f}`);
        }
      } else {
        const out = args.flags.out as string;
        if (!out) throw new Error("convert needs -o out.pdf (or --each -o folder)");
        writeFileSync(out, e.toPdf(inputs.map(load), { pageSize: size }));
        log(`Wrote ${out} from ${inputs.length} file(s)`);
      }
      return 0;
    }
    case "export": {
      const to = (args.flags.to as string) ?? "png";
      if (!["png", "jpg", "docx", "html", "txt", "svg"].includes(to)) throw new Error("--to must be png, jpg, docx, html, txt or svg");
      for (const f of collect(rest, recursive)) {
        const d = e.open(readFileSync(f), basename(f));
        const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
        mkdirSync(dir, { recursive: true });
        const stem = basename(f, extname(f));
        if (to === "png" || to === "jpg") {
          const pages = args.flags.pages ? parseRanges(args.flags.pages as string, d.pageCount) : [...Array(d.pageCount).keys()];
          for (const im of e.toImages(d.id, pages, Number(args.flags.dpi ?? 150), to)) writeFileSync(join(dir, `${stem}-p${im.page + 1}.${to}`), im.data);
        } else {
          const outs = e.exportAs(d.id, to === "txt" ? "text" : (to as "docx"));
          outs.forEach((o, i) => writeFileSync(join(dir, outs.length > 1 ? `${stem}-p${i + 1}.${to}` : `${stem}.${to}`), o));
        }
        e.close(d.id);
        log(`✓ ${f} -> ${dir}`);
      }
      return 0;
    }
    case "make-fillable": {
      const files = collect(rest, recursive);
      if (!files.length) throw new Error("usage: hdfstudio make-fillable <files|folders...> [-o dir]");
      let failed = 0;
      for (const f of files) {
        try {
          const d = e.open(readFileSync(f), basename(f));
          if (d.needsPassword) throw new Error("password protected");
          const found = e.detectFields(d.id);
          if (args.flags["dry-run"]) {
            log(`${f}: ${found.length} field(s)`);
            for (const x of found) log(`  p.${x.page + 1}  ${x.type.padEnd(8)} ${x.name}  (${x.reason})`);
          } else if (found.length) {
            e.addFields(d.id, found);
            const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
            mkdirSync(dir, { recursive: true });
            const target = join(dir, basename(f));
            if (resolve(target) === resolve(f)) throw new Error("output would overwrite the input; use -o");
            writeFileSync(target, e.save(d.id));
            log(`✓ ${f}: ${found.length} field(s) -> ${target}`);
          } else log(`- ${f}: no fields found`);
          e.close(d.id);
        } catch (err) {
          failed++;
          console.error(`✗ ${f}: ${(err as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "ocr": {
      const files = collect(rest, recursive);
      if (!files.length) throw new Error("usage: hdfstudio ocr <files|folders...>");
      const rec = await recognizerFor((args.flags.lang as string) ?? "eng", args.flags["lang-path"] as string | undefined);
      let failed = 0;
      try {
        for (const f of files) {
          const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
          try {
            const t0 = Date.now();
            const r = await ocrBytes(e, rec, readFileSync(f), basename(f), args.flags.all ? "all" : "scanned", args.flags.password as string | undefined);
            mkdirSync(dir, { recursive: true });
            const target = join(dir, basename(f));
            if (resolve(target) === resolve(f)) throw new Error("output would overwrite the input; use -o");
            writeFileSync(target, r.data);
            log(`✓ ${f}: ${r.pages ? `${r.words} words on ${r.pages} page(s)` : "already searchable"} in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${target}`);
          } catch (err) {
            failed++;
            console.error(`✗ ${f}: ${(err as Error).message}`);
          }
        }
      } finally {
        await rec.terminate();
      }
      return failed ? 1 : 0;
    }
    case "compare": {
      const [oldF, newF] = rest;
      if (!oldF || !newF) throw new Error("usage: hdfstudio compare <old.pdf> <new.pdf> [-o report.pdf]");
      const a = e.open(readFileSync(oldF), basename(oldF)), b = e.open(readFileSync(newF), basename(newF));
      const o = { visual: !args.flags["text-only"] };
      const { data, result } = e.compareReport(a.id, b.id, basename(oldF), o);
      if (args.flags.json) console.log(JSON.stringify({ summary: result.summary, changes: result.changes.map(({ kind, oldText, newText, oldPage, newPage }) => ({ kind, oldText, newText, oldPage: oldPage + 1, newPage: newPage + 1 })) }, null, 2));
      else {
        for (const c of result.changes) {
          const where = `p.${c.newPage + 1}`;
          if (c.kind === "replaced") log(`${where}  ~ "${c.oldText}" -> "${c.newText}"`);
          else if (c.kind === "inserted") log(`${where}  + "${c.newText}"`);
          else if (c.kind === "deleted") log(`${where}  - "${c.oldText}"`);
          else log(`${where}  * graphic changed at ${c.rect!.map((v) => Math.round(v)).join(",")}`);
        }
        const s = result.summary;
        log(`${result.changes.length} change(s): ${s.replaced} replaced, ${s.inserted} inserted, ${s.deleted} deleted, ${s.visual} graphic`);
      }
      if (args.flags.out) {
        writeFileSync(args.flags.out as string, data);
        log(`Report: ${args.flags.out}`);
      }
      return result.changes.length ? 1 : 0;
    }
    case "watch": {
      const [folder] = rest;
      if (!folder || !args.flags.recipe) throw new Error("usage: hdfstudio watch <folder> --recipe <name>");
      const recipe = findRecipe(args.flags.recipe as string, args.steps);
      recipe.steps.push(...args.steps.map(parseStep));
      const ocr = ocrStep(recipe);
      const rec = ocr ? await recognizerFor(ocr.lang ?? "eng", args.flags["lang-path"] as string | undefined) : null;
      const w = new FolderWatcher(
        { id: "cli", folder: resolve(folder), recipe: recipe.name, out: args.flags.out ? resolve(args.flags.out as string) : undefined, afterwards: args.flags.keep ? "keep" : "move", enabled: true },
        nodeFs,
        () => recipe,
        async (data, name, r) => runRecipe(rec ? (await ocrBytes(e, rec, data, name, ocr!.pages ?? "scanned")).data : data, name, r),
        (ev) => (ev.ok ? log(`${ev.at.toLocaleTimeString()} ✓ ${ev.file} ${ev.message}`) : console.error(`${ev.at.toLocaleTimeString()} ✗ ${ev.file}: ${ev.message}`)),
      );
      const every = Math.max(1, Number(args.flags.interval ?? 3)) * 1000;
      log(`Watching ${resolve(folder)} with "${recipe.name}". Press Ctrl+C to stop.`);
      for (;;) {
        try {
          await w.tick();
        } catch (err) {
          console.error(`✗ ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, every));
      }
    }
    case "comments": {
      const [file, ...reviews] = rest;
      if (!file) throw new Error("usage: hdfstudio comments <file.pdf> [reviews.pdf|.xfdf ...] [-o out.pdf] [--xfdf out.xfdf]");
      const d = e.open(readFileSync(file), basename(file));
      for (const r of reviews) {
        const data = readFileSync(r);
        const res = /\.xfdf$/i.test(r) ? e.importXfdf(d.id, data.toString("utf8")) : e.mergeComments(d.id, new Uint8Array(data));
        const who = Object.entries(res.authors).map(([k, v]) => `${k} ${v}`).join(", ");
        log(`${basename(r)}: ${res.added} new comment(s)${who ? ` (${who})` : ""}`);
      }
      if (args.flags.json) console.log(JSON.stringify(e.allAnnotations(d.id).map(({ key, page, type, author, contents, inReplyTo, state, modified }) => ({ key, page: page + 1, type, author, contents, inReplyTo, state, modified })), null, 2));
      else console.log(e.commentSummary(d.id) || "No comments.");
      if (args.flags.out) {
        writeFileSync(args.flags.out as string, e.save(d.id));
        log(`Saved: ${args.flags.out}`);
      }
      if (args.flags.xfdf) {
        writeFileSync(args.flags.xfdf as string, e.exportXfdf(d.id, basename(file)));
        log(`XFDF: ${args.flags.xfdf}`);
      }
      return 0;
    }
    case "tag": {
      const files = collect(rest, recursive);
      if (!files.length) throw new Error("usage: hdfstudio tag <files|folders...> [--lang en-US] [-o dir]");
      let failed = 0;
      for (const f of files) {
        try {
          const d = e.open(readFileSync(f), basename(f));
          if (d.needsPassword) throw new Error("password protected");
          const r = e.autoTag(d.id, { lang: args.flags.lang as string | undefined, retag: !!args.flags.retag });
          const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
          mkdirSync(dir, { recursive: true });
          const target = join(dir, basename(f));
          if (resolve(target) === resolve(f)) throw new Error("output would overwrite the input; use -o");
          writeFileSync(target, e.save(d.id));
          const noAlt = e.figures(d.id).filter((x) => !x.alt).length;
          log(`✓ ${f}: ${r.headings} headings, ${r.paragraphs} paragraphs, ${r.lists} lists, ${r.tables} tables, ${r.figures} images${noAlt ? ` (${noAlt} need a description: open in HDF Studio › Describe images)` : ""} -> ${target}`);
          e.close(d.id);
        } catch (err) {
          failed++;
          console.error(`✗ ${f}: ${(err as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "check": {
      const files = collect(rest, recursive);
      if (!files.length) throw new Error("usage: hdfstudio check <files|folders...>");
      let bad = 0;
      const all: Record<string, unknown> = {};
      for (const f of files) {
        const d = e.open(readFileSync(f), basename(f));
        if (d.needsPassword) {
          console.error(`✗ ${f}: password protected`);
          bad++;
          continue;
        }
        const r = e.checkDocument(d.id);
        e.close(d.id);
        if (args.flags.json) all[f] = r;
        else {
          const verdict = (["PDF/A", "Accessibility", "Security"] as const).map((a) => `${a} ${r.passes[a] ? "✓" : "✗"}`).join("  ");
          log(`${f}: ${verdict}${r.pdfaClaim ? `  (claims PDF/A-${r.pdfaClaim})` : ""}`);
          for (const i of r.issues) log(`   ${i.level === "error" ? "✗" : "!"} [${i.area}] ${i.text}`);
        }
        if (r.issues.some((i) => i.level === "error")) bad++;
      }
      if (args.flags.json) console.log(JSON.stringify(all, null, 2));
      return bad ? 1 : 0;
    }
    case "pdfa": {
      const files = collect(rest, recursive);
      if (!files.length) throw new Error("usage: hdfstudio pdfa <files|folders...> [-o dir]");
      let failed = 0;
      for (const f of files) {
        const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
        try {
          const src = readFileSync(f);
          const d = e.open(src, basename(f));
          const out = e.finishPdfa(gsPdfa(src), d.id);
          e.close(d.id);
          mkdirSync(dir, { recursive: true });
          const target = join(dir, basename(f));
          if (resolve(target) === resolve(f)) throw new Error("output would overwrite the input; use -o");
          writeFileSync(target, out);
          const c = e.open(out, basename(f));
          const r = e.checkDocument(c.id);
          e.close(c.id);
          log(`✓ ${f} -> ${target}  (PDF/A ${r.passes["PDF/A"] ? "check passed" : "check: " + r.issues.filter((i) => i.area === "PDF/A").map((i) => i.id).join(", ")})`);
        } catch (err) {
          failed++;
          console.error(`✗ ${f}: ${(err as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "recipes": {
      console.log("Built-in recipes:");
      for (const r of BUILTIN_RECIPES) console.log(`  ${r.name}`);
      console.log("\nStep types (for --step or recipe JSON):");
      for (const [k, v] of Object.entries(STEP_LABELS)) console.log(`  ${k.padEnd(10)} ${v}`);
      return 0;
    }
    case "run": {
      const [name, ...paths] = rest;
      if (!name || !paths.length) throw new Error("usage: hdfstudio run <recipe> <files|folders...>");
      const recipe = findRecipe(name, args.steps);
      recipe.steps.push(...args.steps.map(parseStep));
      if (args.flags.name) recipe.output = args.flags.name as string;
      if (!recipe.steps.length) throw new Error("Recipe has no steps");
      const files = collect(paths, recursive);
      const continueBates = args.flags["continue-bates"] !== false;
      const ocr = ocrStep(recipe);
      const rec = ocr && !args.flags["dry-run"] ? await recognizerFor(ocr.lang ?? "eng", args.flags["lang-path"] as string | undefined) : null;
      let bates = 0, ok = 0, failed = 0;
      const started = Date.now();
      for (const f of files) {
        const dir = (args.flags.out as string) ?? join(dirname(f), "hdfstudio-out");
        try {
          if (args.flags["dry-run"]) {
            log(`would process ${f} -> ${dir}`);
            continue;
          }
          let input: Uint8Array = readFileSync(f);
          if (rec) input = (await ocrBytes(e, rec, input, basename(f), ocr!.pages ?? "scanned", args.flags.password as string | undefined)).data;
          const res = runRecipe(input, basename(f), recipe, { batesOffset: continueBates ? bates : 0, password: args.flags.password as string | undefined });
          bates += res.pagesStamped;
          mkdirSync(dir, { recursive: true });
          for (const o of res.outputs) {
            const target = join(dir, o.name);
            if (resolve(target) === resolve(f)) throw new Error("output would overwrite the input; use -o or --name");
            writeFileSync(target, o.data);
          }
          ok++;
          log(`✓ ${f} -> ${res.outputs.length === 1 ? join(dir, res.outputs[0].name) : `${res.outputs.length} files in ${dir}`}`);
        } catch (err) {
          failed++;
          console.error(`✗ ${f}: ${(err as Error).message}`);
        }
      }
      await rec?.terminate();
      log(`${ok} done, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)} s (${recipe.name})`);
      return failed ? 1 : 0;
    }
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      return 2;
  }
}

if (process.argv[1] && /hdfstudio(\.ts|\.mjs|\.js)?$/.test(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`hdfstudio: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
