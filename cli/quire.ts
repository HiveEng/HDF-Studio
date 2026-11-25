#!/usr/bin/env node
// quire: command line companion to the Quire app. Batch-process PDFs with the same engine and recipes.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve, extname } from "node:path";
import { Engine } from "../src/engine/core";
import { runRecipe, parseStep, BUILTIN_RECIPES, STEP_LABELS, type Recipe } from "../src/engine/recipes";
import { parseRanges } from "../src/engine/ranges";

const HELP = `quire - batch PDF tools (AGPL-3.0)

Usage:
  quire info <files|folders...>                     Page count, size, title, encryption
  quire merge -o out.pdf <files|folders...>         Merge in order, one bookmark per file
  quire split <file> [--every N | --bookmarks] [-o dir]
  quire extract <file> <pages> -o out.pdf           e.g. quire extract a.pdf "1-3,7" -o part.pdf
  quire text <file> [-o out.txt]                    Extract text
  quire search <text> <files|folders...> [--csv]    Find text across many PDFs
  quire recipes                                     List built-in recipes and step types
  quire run <recipe> <files|folders...> [options]   Apply a recipe to every PDF
      <recipe> is a built-in name (quotes or a unique prefix), a .json file, or "-" to use --step only
      --step "<op> key=value ..."   add a step (repeatable), e.g.
            --step 'stamp text="Page {page} of {pages}" position=bottom-center'
            --step 'protect ownerPassword=s3cret allowCopy=false'
      -o, --out <dir>       output folder (default: <input folder>/quire-out)
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
  const bools = new Set(["recursive", "quiet", "help", "csv", "bookmarks", "dry-run", "continue-bates"]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("-") && t !== "-") {
      let k = t.replace(/^--?/, "");
      k = alias[k] ?? k;
      if (bools.has(k)) a.flags[k] = true;
      else if (k === "step") a.steps.push(argv[++i]);
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
        if (e === "quire-out") continue;
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

function findRecipe(name: string, steps: string[]): Recipe {
  if (name === "-") return { name: "inline", steps: [] };
  if (name.endsWith(".json") && existsSync(name)) return JSON.parse(readFileSync(name, "utf8")) as Recipe;
  const lower = name.toLowerCase();
  const exact = BUILTIN_RECIPES.find((r) => r.name.toLowerCase() === lower);
  if (exact) return structuredClone(exact);
  const matches = BUILTIN_RECIPES.filter((r) => r.name.toLowerCase().startsWith(lower));
  if (matches.length === 1) return structuredClone(matches[0]);
  throw new Error(matches.length ? `"${name}" matches several recipes: ${matches.map((m) => m.name).join("; ")}` : `No recipe "${name}". Run "quire recipes" to list them.${steps.length ? "" : ' Use "-" with --step for inline steps.'}`);
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function main(argv: string[]): number {
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
      const dir = (args.flags.out as string) ?? join(dirname(f), "quire-out");
      mkdirSync(dir, { recursive: true });
      for (const p of parts) writeFileSync(join(dir, `${basename(f, extname(f))} - ${p.suffix}.pdf`), p.data);
      log(`Split ${f} into ${parts.length} files in ${dir}`);
      return 0;
    }
    case "extract": {
      const [f, range] = rest;
      const out = args.flags.out as string;
      if (!f || !range || !out) throw new Error('usage: quire extract <file> "<pages>" -o out.pdf');
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
    case "recipes": {
      console.log("Built-in recipes:");
      for (const r of BUILTIN_RECIPES) console.log(`  ${r.name}`);
      console.log("\nStep types (for --step or recipe JSON):");
      for (const [k, v] of Object.entries(STEP_LABELS)) console.log(`  ${k.padEnd(10)} ${v}`);
      return 0;
    }
    case "run": {
      const [name, ...paths] = rest;
      if (!name || !paths.length) throw new Error("usage: quire run <recipe> <files|folders...>");
      const recipe = findRecipe(name, args.steps);
      recipe.steps.push(...args.steps.map(parseStep));
      if (args.flags.name) recipe.output = args.flags.name as string;
      if (!recipe.steps.length) throw new Error("Recipe has no steps");
      const files = collect(paths, recursive);
      const continueBates = args.flags["continue-bates"] !== false;
      let bates = 0, ok = 0, failed = 0;
      const started = Date.now();
      for (const f of files) {
        const dir = (args.flags.out as string) ?? join(dirname(f), "quire-out");
        try {
          if (args.flags["dry-run"]) {
            log(`would process ${f} -> ${dir}`);
            continue;
          }
          const res = runRecipe(readFileSync(f), basename(f), recipe, { batesOffset: continueBates ? bates : 0, password: args.flags.password as string | undefined });
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
      log(`${ok} done, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)} s (${recipe.name})`);
      return failed ? 1 : 0;
    }
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      return 2;
  }
}

if (process.argv[1] && /quire(\.ts|\.mjs|\.js)?$/.test(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`quire: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
