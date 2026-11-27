// Watch folders: every PDF that lands in a folder is run through a recipe automatically.
// Shared by the desktop app (Tauri file system) and the `hds watch` command (Node).
import type { Recipe } from "../engine/recipes";

export interface WatchFs {
  /** Files (not folders) directly inside dir. */
  list(dir: string): Promise<{ name: string; size: number; mtime: number }[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  join(...parts: string[]): string;
}

export interface WatchRule {
  id: string;
  folder: string;
  /** Name of a built-in or saved recipe. */
  recipe: string;
  /** Output folder; default: <folder>/hdfstudio-out. */
  out?: string;
  /** After processing, move the original into <folder>/processed (default) or leave it. */
  afterwards?: "move" | "keep";
  enabled: boolean;
}

export type RunRecipe = (data: Uint8Array, name: string, recipe: Recipe) => Promise<{ outputs: { name: string; data: Uint8Array }[] }>;
export interface WatchEvent { rule: WatchRule; file: string; ok: boolean; message: string; at: Date }

export const OUT_DIR = "hdfstudio-out";
export const DONE_DIR = "processed";
export const FAILED_DIR = "failed";

/**
 * Polls one folder. A file is processed once its size and modified time are unchanged between two
 * polls, so files still being copied or scanned in are left alone until they are complete.
 */
export class FolderWatcher {
  private pending = new Map<string, string>();
  constructor(
    public rule: WatchRule,
    private fs: WatchFs,
    private recipeFor: (name: string) => Recipe | undefined,
    private run: RunRecipe,
    private onEvent: (e: WatchEvent) => void,
    /** Files already handled (name|size|mtime), for rules that keep originals in place. */
    public handled = new Set<string>(),
  ) {}

  /** One poll. Returns how many files were processed. */
  async tick(): Promise<number> {
    const { rule, fs } = this;
    if (!rule.enabled) return 0;
    const recipe = this.recipeFor(rule.recipe);
    if (!recipe) throw new Error(`Recipe "${rule.recipe}" not found`);
    const files = (await fs.list(rule.folder)).filter((f) => /\.pdf$/i.test(f.name) && !f.name.startsWith("~$"));
    const present = new Set(files.map((f) => f.name));
    for (const k of this.pending.keys()) if (!present.has(k)) this.pending.delete(k);
    let n = 0;
    for (const f of files) {
      const sig = `${f.name}|${f.size}|${f.mtime}`;
      if (this.handled.has(sig)) continue;
      if (this.pending.get(f.name) !== sig) {
        this.pending.set(f.name, sig);
        continue; // not stable yet
      }
      this.pending.delete(f.name);
      await this.process(f.name, recipe);
      if (rule.afterwards === "keep") this.handled.add(sig);
      n++;
    }
    return n;
  }

  private async process(name: string, recipe: Recipe) {
    const { rule, fs } = this;
    const src = fs.join(rule.folder, name);
    const out = rule.out || fs.join(rule.folder, OUT_DIR);
    try {
      const res = await this.run(await fs.read(src), name, recipe);
      await fs.mkdir(out);
      for (const o of res.outputs) await fs.write(fs.join(out, o.name), o.data);
      if (rule.afterwards !== "keep") {
        await fs.mkdir(fs.join(rule.folder, DONE_DIR));
        await fs.move(src, fs.join(rule.folder, DONE_DIR, name));
      }
      this.onEvent({ rule, file: name, ok: true, message: res.outputs.length === 1 ? `→ ${fs.join(out, res.outputs[0].name)}` : `→ ${res.outputs.length} files in ${out}`, at: new Date() });
    } catch (e) {
      // Park failures so they aren't retried forever; keep-in-place rules just remember them.
      if (rule.afterwards !== "keep") {
        try {
          await fs.mkdir(fs.join(rule.folder, FAILED_DIR));
          await fs.move(src, fs.join(rule.folder, FAILED_DIR, name));
        } catch { /* leave it */ }
      }
      this.onEvent({ rule, file: name, ok: false, message: (e as Error).message ?? String(e), at: new Date() });
    }
  }
}
